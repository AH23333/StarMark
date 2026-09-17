import { db, updateItem, getAppMeta } from '../db'
import { bumpIndexVersion } from '../version'
import { getSyncState, setSyncState } from '../db'
import { buildTagPrompt, getAiSettings, isAiConfigured, suggestTagsViaAi } from './provider'
import type { TagSuggestion } from '../types'

/**
 * AI 建议流水线（检查点状态机，复用同步作业模式）：
 *   IDLE → SCANNING → DONE
 * 每处理 1 条即落检查点；SW 被杀后从 cursor 续跑，幂等（同一建议去重）。
 * 产物只进「建议桶」（suggestions 表，status=pending），用户批准后才并入 items.tags。
 */

const PIPELINE_KEY = '***'

export interface AiPipelineState {
  running: boolean
  cursor: number
  scanned: number
  suggested: number
  startedAt?: number
  doneAt?: number
  error?: string
}

export async function getAiPipelineState(): Promise<AiPipelineState> {
  const s = await getSyncState<AiPipelineState>(PIPELINE_KEY)
  return s ?? { running: false, cursor: 0, scanned: 0, suggested: 0 }
}

async function setPipeline(state: AiPipelineState): Promise<void> {
  await setSyncState(PIPELINE_KEY, state)
}

const PAGE_SIZE = 10

/** 运行标志：运行中重复触发立即返回当前状态，不并发跑两个循环（SW 会话内存态） */
let pipelineActive = false

/**
 * 启动/续跑建议流水线：**同步建立 running 状态并落盘后立即返回**，处理循环在后台
 * promise 中继续 —— 消息通道只挂起毫秒级的状态建立，杜绝 "message channel closed"。
 * 默认处理全部候选条目（旧实现每次调用限 30 条，用户需反复手动点击才能跑完全库）；
 * 每条落检查点，SW 被杀后再次触发即从 cursor 续跑。
 */
export async function runAiSuggestPipeline(maxItems = Number.POSITIVE_INFINITY): Promise<AiPipelineState> {
  if (pipelineActive) return getAiPipelineState()
  const settings = await getAiSettings()
  let state = await getAiPipelineState()
  // 入口检查统一走 isAiConfigured：Ollama 是本地服务免 API Key（旧实现漏掉该豁免导致无法调用）
  if (!isAiConfigured(settings)) {
    state = { ...state, running: false, error: settings.enabled ? 'AI 未配置完整（云端服务商需填写 API Key）' : 'AI 未启用' }
    await setPipeline(state)
    return state
  }
  if (!state.running) {
    state = { running: true, cursor: 0, scanned: 0, suggested: 0, startedAt: Date.now() }
  } else {
    state = { ...state, error: undefined }
  }
  await setPipeline(state)
  pipelineActive = true
  void runPipelineLoop(settings, state, maxItems)
    .catch((e) => console.warn('[starmark] ai pipeline crashed', e))
    .finally(() => {
      pipelineActive = false
    })
  return state
}

async function runPipelineLoop(settings: import('./provider').AiSettings, state: AiPipelineState, maxItems: number): Promise<void> {
  try {
    // 全局高频标签 top20 进入提示词：让模型优先复用现有标签，缓解"一个标签一个条目"的标签爆炸
    const meta = await getAppMeta()
    const globalTags = Object.entries(meta.tags)
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'zh'))
      .slice(0, 20)
      .map(([t]) => t)

    // 候选：未隐藏、且当前无 pending 建议的条目（按 updatedAt 排序由 cursor 翻页近似；
    // 流水线只写 suggestions 不改 items.updatedAt，排序在全量处理期间稳定）
    let processed = 0
    while (processed < maxItems) {
      const all = await db.items.orderBy('updatedAt').reverse().offset(state.cursor).limit(PAGE_SIZE).toArray()
      if (all.length === 0) break
      for (const item of all) {
        state.cursor++
        if (item.hidden) continue
        const pending = await db.suggestions.where('itemId').equals(item.id).count()
        if (pending > 0) continue
        state.scanned++
        processed++
        try {
          const tags = await suggestTagsViaAi(
            settings,
            buildTagPrompt({ title: item.title, description: item.description, notes: item.notes, existingTags: item.tags, globalTags }),
          )
          const fresh = await dedupeAgainstExisting(item.id, item.tags, tags)
          if (fresh.length > 0) {
            const now = Date.now()
            await db.suggestions.bulkPut(
              fresh.map(
                (tag): TagSuggestion => ({ id: `${item.id}|${tag}`, itemId: item.id, tag, status: 'pending', createdAt: now }),
              ),
            )
            state.suggested += fresh.length
          }
        } catch (e) {
          // 单条失败不中断流水线（限流/网络），记录后继续
          state.error = (e as Error).message
        }
        // 每条落检查点（可恢复；扩展 API 调用同时保活 SW）
        await setPipeline(state)
      }
    }
    state.running = false
    state.doneAt = Date.now()
    await setPipeline(state)
  } catch (e) {
    state.running = false
    state.error = (e as Error).message
    state.doneAt = Date.now()
    await setPipeline(state)
  }
}

/** 过滤：与条目已有标签、以及同条目已有建议重复的去掉。 */
async function dedupeAgainstExisting(itemId: string, existing: string[] | undefined, tags: string[]): Promise<string[]> {
  const seen = new Set((existing ?? []).map((t) => t.toLowerCase()))
  const out: string[] = []
  for (const tag of tags) {
    const v = tag.trim().toLowerCase()
    if (!v || seen.has(v)) continue
    seen.add(v)
    out.push(tag.trim())
  }
  // 与桶内已 rejected 的去重：rejected 过的不再重提
  const past = await db.suggestions.where('itemId').equals(itemId).toArray()
  const rejected = new Set(past.filter((p) => p.status === 'rejected').map((p) => p.tag.toLowerCase()))
  return out.filter((t) => !rejected.has(t.toLowerCase()))
}

/* ---------- 建议桶 DAO ---------- */

export async function pendingSuggestions(limit = 100): Promise<TagSuggestion[]> {
  return db.suggestions.where('status').equals('pending').limit(limit).toArray()
}

/** 批准：并入 items.tags（走 updateItem 维护计数），建议状态置 approved。 */
export async function approveSuggestions(ids: string[]): Promise<void> {
  if (ids.length === 0) return
  const rows = await db.suggestions.bulkGet(ids)
  const byItem = new Map<string, string[]>()
  const approved: TagSuggestion[] = []
  for (const row of rows) {
    if (!row || row.status !== 'pending') continue
    const list = byItem.get(row.itemId) ?? []
    list.push(row.tag)
    byItem.set(row.itemId, list)
    approved.push({ ...row, status: 'approved' })
  }
  for (const [itemId, tags] of byItem) {
    // 用 updateItem 追加（内部维护 meta 计数与 updatedAt）；
    // 不能走 upsertItems —— 其 mergePreserving 会用旧行 tags 覆盖传入值，导致追加丢失
    const item = await db.items.get(itemId)
    if (!item) continue
    const merged = [...(item.tags ?? [])]
    for (const t of tags) if (!merged.includes(t)) merged.push(t)
    await updateItem(itemId, { tags: merged })
  }
  await db.suggestions.bulkPut(approved)
  await bumpIndexVersion([...byItem.keys()])
}

/** 拒绝：置 rejected（同一标签不再重提）。 */
export async function rejectSuggestions(ids: string[]): Promise<void> {
  if (ids.length === 0) return
  const rows = await db.suggestions.bulkGet(ids)
  const rejected = rows.filter((r): r is TagSuggestion => Boolean(r && r.status === 'pending')).map((r) => ({ ...r, status: 'rejected' as const }))
  await db.suggestions.bulkPut(rejected)
}
