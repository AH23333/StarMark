import { db, updateItem } from '../db'
import { bumpIndexVersion } from '../version'
import { getSyncState, setSyncState } from '../db'
import { buildTagPrompt, getAiSettings, suggestTagsViaAi } from './provider'
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

/** 启动/续跑流水线；最多处理 maxItems 条后让出（避免占满 SW 生命周期），无未完成则重开。 */
export async function runAiSuggestPipeline(maxItems = 30): Promise<AiPipelineState> {
  const settings = await getAiSettings()
  let state = await getAiPipelineState()
  if (!settings.enabled || !settings.apiKey) {
    state = { ...state, running: false, error: 'AI 未启用或未配置 Key' }
    await setPipeline(state)
    return state
  }
  if (!state.running) {
    state = { running: true, cursor: 0, scanned: 0, suggested: 0, startedAt: Date.now() }
  } else {
    state = { ...state, error: undefined }
  }
  await setPipeline(state)

  try {
    // 候选：未隐藏、且当前无 pending 建议的条目（按 updatedAt 排序由 cursor 翻页近似）
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
            buildTagPrompt({ title: item.title, description: item.description, notes: item.notes, existingTags: item.tags }),
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
        // 每条落检查点（可恢复）
        await setPipeline(state)
      }
    }
    state.running = false
    state.doneAt = Date.now()
    await setPipeline(state)
    return state
  } catch (e) {
    state.running = false
    state.error = (e as Error).message
    state.doneAt = Date.now()
    await setPipeline(state)
    return state
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
