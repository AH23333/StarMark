import { browser } from 'wxt/browser'
import { allItems, getSyncState, setSyncState, updateItem } from '../db'
import { bumpIndexVersion } from '../version'
import { getAiSettings, isAiConfigured, type AiSettings } from './provider'
import type { StarItem } from '../types'

/**
 * AI 批量分类（阶段 B 重构）：把全部可见条目分批送模型，一次产出"标签 → 条目"分组。
 * - 颗粒度锚定：用现有标签频次 + 通用种子做【参考类别】，模型优先复用，避免过细/过粗
 * - 检查点：每批落盘，SW 被杀后从 batch 续跑（幂等，重跑同批覆盖同批结果）
 * - 结果存 storage.local（可导出/导入），应用走 updateItem（追加式并入标签）
 */

export interface ClassifyGroup {
  tag: string
  itemIds: string[]
}

export interface ClassifyResult {
  createdAt: number
  model: string
  totalItems: number
  /** 标签 -> 条目 id（分组展示用） */
  groups: ClassifyGroup[]
  /** 条目 id -> 标签（应用/导出用） */
  assignments: Record<string, string[]>
  /** 模型未覆盖的条目数 */
  unmatched: number
}

export interface ClassifyState {
  running: boolean
  batch: number
  totalBatches: number
  classified: number
  error?: string
  startedAt?: number
  doneAt?: number
}

const RESULT_KEY = '***'
const STATE_KEY = '***'

export const CLASSIFY_BATCH_SIZE = 50
export const CLASSIFY_MAX_BATCHES = 40
export const CLASSIFY_MAX_TAGS_PER_ITEM = 3

export async function getClassifyResult(): Promise<ClassifyResult | undefined> {
  const s = await browser.storage.local.get(RESULT_KEY)
  const raw = s[RESULT_KEY] as Partial<ClassifyResult> | undefined
  if (!raw) return undefined
  // 防御性规范化：旧缓存/导入数据可能缺 assignments/groups 字段（渲染期 Object.keys(undefined) 会崩）
  return {
    createdAt: raw.createdAt ?? 0,
    model: raw.model ?? '',
    totalItems: raw.totalItems ?? 0,
    assignments: raw.assignments ?? {},
    groups: Array.isArray(raw.groups) ? raw.groups : [],
    unmatched: raw.unmatched ?? 0,
  }
}

export async function saveClassifyResult(r: ClassifyResult): Promise<void> {
  await browser.storage.local.set({ [RESULT_KEY]: r })
}

export async function getClassifyState(): Promise<ClassifyState> {
  const s = await getSyncState<ClassifyState>(STATE_KEY)
  return s ?? { running: false, batch: 0, totalBatches: 0, classified: 0 }
}

async function setClassifyState(st: ClassifyState): Promise<void> {
  await setSyncState(STATE_KEY, st)
}

/** 分类种子：现有标签按频次取前 N（锚定适中颗粒度，让模型优先复用） */
export function seedCategories(items: StarItem[], max = 8): string[] {
  const freq = new Map<string, number>()
  for (const it of items) for (const t of it.tags ?? []) freq.set(t, (freq.get(t) ?? 0) + 1)
  return [...freq.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, max)
    .map(([t]) => t)
}

export interface ClassifyBatchInput {
  index: number
  id: string
  title: string
  desc: string
}

export function buildClassifyPrompt(batch: ClassifyBatchInput[], seeds: string[]): string {
  const lines = [
    '你是书签整理助手。下面是编号的收藏条目（标题与描述）。为每一条分配 1-' + CLASSIFY_MAX_TAGS_PER_ITEM + ' 个分类标签：',
    '- 分类颗粒度适中：用「开发工具」「前端」「AI / 机器学习」「设计」「阅读」「效率」「娱乐」这类通用类别；',
    '  不要过细（版本号、具体人名），也不要把所有条目塞进同一个大杂烩类别',
    '- 优先复用【参考类别】里的词；确实不合适才新建，新类别同样要通用、简短（中文不超过 6 个字）',
    '- 只输出 JSON，不要任何解释或代码围栏，格式：',
    '  {"items":[{"i":1,"tags":["前端","框架"]},{"i":2,"tags":["阅读"]}]}',
    '',
    '【参考类别】' + (seeds.length ? seeds.join('、') : '（暂无，按通用类别新建）'),
    '【条目】',
  ]
  for (const it of batch) {
    lines.push(`${it.index}. ${it.title}${it.desc ? '｜' + it.desc.slice(0, 80) : ''}`)
  }
  return lines.join('\n')
}

/** 解析模型输出：兼容 {"items":[{i,tags}]}、{"categories":[{tag,ids}]}、裸数组三种形态。 */
export function parseClassifyResponse(
  raw: string,
  idByIndex: Map<number, string>,
): Map<string, string[]> {
  const out = new Map<string, string[]>()
  const put = (idxOrId: number | string, tags: unknown) => {
    const id = typeof idxOrId === 'number' ? idByIndex.get(idxOrId) : (idxOrId as string)
    if (!id || !Array.isArray(tags)) return
    const clean = tags.filter((t): t is string => typeof t === 'string' && t.trim().length > 0).map((t) => t.trim())
    if (clean.length > 0) out.set(id, clean.slice(0, CLASSIFY_MAX_TAGS_PER_ITEM))
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    // 容错：截取第一个 { 到最后一个 } 再试
    const a = raw.indexOf('{')
    const b = raw.lastIndexOf('}')
    if (a < 0 || b <= a) return out
    try {
      parsed = JSON.parse(raw.slice(a, b + 1))
    } catch {
      return out
    }
  }
  const obj = parsed as Record<string, unknown>
  if (Array.isArray(obj.items)) {
    for (const it of obj.items as { i?: number; id?: string; tags?: unknown }[]) {
      const key = it.i ?? it.id
      if (key != null) put(key as number | string, it.tags)
    }
  } else if (Array.isArray(obj.categories)) {
    for (const c of obj.categories as { tag?: unknown; ids?: unknown; items?: unknown }[]) {
      const tag = typeof c.tag === 'string' ? c.tag.trim() : ''
      const ids = (c.ids ?? c.items) as unknown
      if (!tag || !Array.isArray(ids)) continue
      for (const id of ids) {
        const cur = out.get(String(id)) ?? []
        if (!cur.includes(tag)) cur.push(tag)
        out.set(String(id), cur)
      }
    }
    // categories 形态里 ids 可能是条目 id 字符串
    for (const [k, v] of [...out.entries()]) {
      if (!idByIndex.has(Number(k)) && !v) out.delete(k)
    }
  } else if (Array.isArray(parsed)) {
    for (const it of parsed as { i?: number; id?: string; tags?: unknown }[]) {
      const key = it.i ?? it.id
      if (key != null) put(key as number | string, it.tags)
    }
  }
  return out
}

/** 由 assignments 反推分组（按组内条目数降序）。 */
export function groupsFromAssignments(assignments: Record<string, string[]>): ClassifyGroup[] {
  const m = new Map<string, string[]>()
  for (const [itemId, tags] of Object.entries(assignments)) {
    for (const t of tags) {
      const list = m.get(t) ?? []
      list.push(itemId)
      m.set(t, list)
    }
  }
  return [...m.entries()]
    .map(([tag, itemIds]) => ({ tag, itemIds }))
    .sort((a, b) => b.itemIds.length - a.itemIds.length || a.tag.localeCompare(b.tag, 'zh'))
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size))
  return out
}

async function chatJson(settings: AiSettings, prompt: string): Promise<string> {
  // 动态引 provider，避免打包循环依赖
  const mod = await import('./provider')
  return mod.chatJson(settings, prompt)
}

/** 消息入口改为"启动即返回"后防止重复触发并发跑两个循环（SW 会话内存态） */
let classifyActive = false

/**
 * 启动/续跑批量分类：**同步建立 running 状态并落盘后立即返回**，批处理循环在后台
 * promise 中继续（消息通道不挂起；每批的 storage 写入持续保活 SW）。
 * 进度经 ai-classify-state 轮询。旧实现同步等待全部批次完成 —— 本地 Ollama 下
 * 消息通道随 SW 生命周期终止而失效，报 "message channel closed"。
 */
export async function runClassify(): Promise<ClassifyState> {
  if (classifyActive) return getClassifyState()
  const settings = await getAiSettings()
  let state = await getClassifyState()
  if (!isAiConfigured(settings)) {
    state = { ...state, running: false, error: 'AI 未启用或未配置 Key' }
    await setClassifyState(state)
    return state
  }
  if (!state.running) {
    state = { running: true, batch: 0, totalBatches: 0, classified: 0, startedAt: Date.now() }
    await setClassifyState(state)
  }
  classifyActive = true
  void runClassifyLoop(settings, state)
    .catch((e) => console.warn('[starmark] ai classify crashed', e))
    .finally(() => {
      classifyActive = false
    })
  return state
}

async function runClassifyLoop(settings: AiSettings, state: ClassifyState): Promise<void> {
  try {
    const items = (await allItems()).filter((i) => !i.hidden)
    const batches = chunk(items, CLASSIFY_BATCH_SIZE).slice(0, CLASSIFY_MAX_BATCHES)
    state.totalBatches = batches.length
    await setClassifyState(state)

    const seeds = seedCategories(items)
    let result = (await getClassifyResult()) ?? {
      createdAt: Date.now(),
      model: settings.model,
      totalItems: items.length,
      groups: [],
      assignments: {},
      unmatched: 0,
    }
    result.model = settings.model
    result.totalItems = items.length

    for (let bi = state.batch; bi < batches.length; bi++) {
      const batchItems = batches[bi]!
      const idByIndex = new Map<number, string>()
      const inputs: ClassifyBatchInput[] = batchItems.map((it, i) => {
        idByIndex.set(i + 1, it.id)
        return { index: i + 1, id: it.id, title: it.title || it.url, desc: it.description }
      })
      let tagsById: Map<string, string[]> | undefined
      try {
        const raw = await chatJson(settings, buildClassifyPrompt(inputs, seeds))
        tagsById = parseClassifyResponse(raw, idByIndex)
      } catch (e) {
        state.running = false
        state.error = (e as Error).message
        state.doneAt = Date.now()
        await setClassifyState(state)
        return
      }
      if (tagsById) {
        for (const [id, tags] of tagsById) result.assignments[id] = tags
        result.createdAt = Date.now()
        await saveClassifyResult(result)
      }
      state.batch = bi + 1
      state.classified += batchItems.length
      await setClassifyState(state)
    }

    result.groups = groupsFromAssignments(result.assignments)
    result.unmatched = items.length - Object.keys(result.assignments).length
    await saveClassifyResult(result)

    state.running = false
    state.doneAt = Date.now()
    state.error = undefined
    await setClassifyState(state)
  } catch (e) {
    state.running = false
    state.error = (e as Error).message
    state.doneAt = Date.now()
    await setClassifyState(state)
  }
}

/** 应用分类：把选中分组（null=全部）的标签追加进条目。返回影响面。 */
export async function applyClassifications(groupTags?: string[] | null): Promise<{ items: number; tags: number }> {
  const result = await getClassifyResult()
  if (!result) throw new Error('尚无分类结果')
  const selected = groupTags == null ? result.groups.map((g) => g.tag) : groupTags
  const selectedSet = new Set(selected)
  // 条目 -> 追加标签（多组合并，去重）
  const perItem = new Map<string, Set<string>>()
  let tagCount = 0
  for (const g of result.groups) {
    if (!selectedSet.has(g.tag)) continue
    for (const id of g.itemIds) {
      const set = perItem.get(id) ?? new Set<string>()
      set.add(g.tag)
      perItem.set(id, set)
      tagCount++
    }
  }
  let items = 0
  const changedIds: string[] = []
  for (const [id, tags] of perItem) {
    const item = await dbGet(id)
    if (!item) continue
    const merged = [...(item.tags ?? [])]
    for (const t of tags) if (!merged.includes(t)) merged.push(t)
    if (merged.length === (item.tags?.length ?? 0)) continue
    await updateItem(id, { tags: merged })
    items++
    changedIds.push(id)
  }
  if (changedIds.length > 0) await bumpIndexVersion(changedIds)
  return { items, tags: tagCount }
}

async function dbGet(id: string) {
  const { db } = await import('../db')
  return db.items.get(id)
}

/* ---------- 导出 / 导入 ---------- */

export interface ClassifyExport {
  app: 'starmark'
  kind: 'ai-classification'
  version: 1
  exportedAt: number
  model: string
  groups: ClassifyGroup[]
  assignments: Record<string, string[]>
  /** 条目清单（跨设备可读性） */
  items: { id: string; url: string; title: string }[]
}

export async function exportClassifications(): Promise<string> {
  const result = await getClassifyResult()
  if (!result) throw new Error('尚无分类结果')
  const items = await allItems()
  const byId = new Map(items.map((i) => [i.id, i]))
  const manifest = [...new Set([...Object.keys(result.assignments)])]
    .map((id) => {
      const it = byId.get(id)
      return it ? { id, url: it.url, title: it.title } : { id, url: '', title: '（本地不存在）' }
    })
  const payload: ClassifyExport = {
    app: 'starmark',
    kind: 'ai-classification',
    version: 1,
    exportedAt: Date.now(),
    model: result.model,
    groups: result.groups,
    assignments: result.assignments,
    items: manifest,
  }
  return JSON.stringify(payload, null, 2)
}

export async function importClassifications(json: string): Promise<ClassifyResult> {
  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(json) as Record<string, unknown>
  } catch {
    throw new Error('不是有效的 JSON 文件')
  }
  if (parsed.app !== 'starmark' || parsed.kind !== 'ai-classification' || typeof parsed.assignments !== 'object' || parsed.assignments === null) {
    throw new Error('不是 StarMark AI 分类导出文件')
  }
  const raw = parsed as unknown as ClassifyExport
  const result: ClassifyResult = {
    createdAt: Date.now(),
    model: raw.model ?? 'imported',
    totalItems: raw.items?.length ?? Object.keys(raw.assignments).length,
    groups: Array.isArray(raw.groups) ? raw.groups : groupsFromAssignments(raw.assignments),
    assignments: raw.assignments,
    unmatched: 0,
  }
  await saveClassifyResult(result)
  return result
}
