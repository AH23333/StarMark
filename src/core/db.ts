import Dexie, { type EntityTable } from 'dexie'
import { browser } from 'wxt/browser'
import { normalizeUrl } from './normalize'
import type { ActivityEntry, ItemEditPatch, SearchIndexRecord, Source, StarItem, SyncStateRow, TagSuggestion } from './types'

export class StarMarkDB extends Dexie {
  items!: EntityTable<StarItem, 'id'>
  searchIndex!: EntityTable<SearchIndexRecord, 'id'>
  syncState!: EntityTable<SyncStateRow, 'key'>
  activity!: EntityTable<ActivityEntry, 'id'>
  meta!: EntityTable<{ key: string; value: unknown }, 'key'>
  suggestions!: EntityTable<TagSuggestion, 'id'>

  constructor() {
    super('starmark')
    this.version(1).stores({
      items: 'id, &url, starredAt, bookmarkedAt, updatedAt',
      searchIndex: 'id, version, builtAt',
      syncState: 'key',
    })
    this.version(2).stores({
      items: 'id, &url, starredAt, bookmarkedAt, updatedAt, hidden',
      searchIndex: 'id, version, builtAt',
      syncState: 'key',
      activity: '++id, at',
    })
    this.version(3).stores({
      items: 'id, &url, starredAt, bookmarkedAt, updatedAt, hidden',
      searchIndex: 'id, version, builtAt',
      syncState: 'key',
      activity: '++id, at',
      meta: 'key',
    })
    // v4（阶段 B）：AI 建议桶 —— AI 产出的标签先暂存，用户批准后才并入 items.tags
    this.version(4).stores({
      items: 'id, &url, starredAt, bookmarkedAt, updatedAt, hidden',
      searchIndex: 'id, version, builtAt',
      syncState: 'key',
      activity: '++id, at',
      meta: 'key',
      suggestions: 'id, itemId, status, tag',
    })
  }
}

export const db = new StarMarkDB()

/* ---------- meta：条目计数 / 标签直方图（避免每次打开面板全表扫描） ---------- */

export interface AppMeta {
  total: number
  stars: number
  bookmarks: number
  hidden: number
  tagged: number
  /** tag → 引用条数 */
  tags: Record<string, number>
}

const META_KEY = 'app'

function metaRow(m: AppMeta) {
  return { key: META_KEY, value: m }
}

export async function getAppMeta(): Promise<AppMeta> {
  const row = await db.meta.get(META_KEY)
  const base: AppMeta = { total: 0, stars: 0, bookmarks: 0, hidden: 0, tagged: 0, tags: {} }
  if (!row?.value) return base
  return { ...base, ...(row.value as Partial<AppMeta>) }
}

async function saveAppMeta(m: AppMeta): Promise<void> {
  await db.meta.put(metaRow(m))
}

function dec(m: Record<string, number>, k: string): void {
  const v = (m[k] ?? 0) - 1
  if (v <= 0) delete m[k]
  else m[k] = v
}

/** 单条数据由 old → next 的计数增量。old/next 均 undefined 时无操作。 */
function applyItemDelta(m: AppMeta, old: StarItem | undefined, next: StarItem | undefined): void {
  if (!old && !next) return
  if (!old) {
    m.total++
    if (next!.sources.includes('star')) m.stars++
    if (next!.sources.includes('bookmark')) m.bookmarks++
    if (next!.hidden) m.hidden++
    if ((next!.tags?.length ?? 0) > 0) m.tagged++
    for (const t of next!.tags ?? []) m.tags[t] = (m.tags[t] ?? 0) + 1
    return
  }
  if (!next) {
    m.total--
    if (old.sources.includes('star')) m.stars--
    if (old.sources.includes('bookmark')) m.bookmarks--
    if (old.hidden) m.hidden--
    if ((old.tags?.length ?? 0) > 0) m.tagged--
    for (const t of old.tags ?? []) dec(m.tags, t)
    return
  }
  const hStar = old.sources.includes('star')
  const nStar = next.sources.includes('star')
  if (hStar !== nStar) m.stars += nStar ? 1 : -1
  const hBm = old.sources.includes('bookmark')
  const nBm = next.sources.includes('bookmark')
  if (hBm !== nBm) m.bookmarks += nBm ? 1 : -1
  if (Boolean(old.hidden) !== Boolean(next.hidden)) m.hidden += next.hidden ? 1 : -1
  const hTagged = (old.tags?.length ?? 0) > 0
  const nTagged = (next.tags?.length ?? 0) > 0
  if (hTagged !== nTagged) m.tagged += nTagged ? 1 : -1
  for (const t of old.tags ?? []) dec(m.tags, t)
  for (const t of next.tags ?? []) m.tags[t] = (m.tags[t] ?? 0) + 1
}

/* ---------- 浏览器书签删除辅助（批量 delete 用） ---------- */

interface BmNode {
  id: string
  title?: string
  url?: string
  children?: BmNode[]
}

/** 在书签树里查找与规范化 URL 匹配的节点 id（可能多个）。 */
function collectBookmarkIdsByUrls(tree: BmNode[], urlSet: Set<string>): { id: string; url: string }[] {
  const found: { id: string; url: string }[] = []
  const walk = (nodes: BmNode[]): void => {
    for (const n of nodes) {
      if (n.url && urlSet.has(normalizeUrl(n.url))) found.push({ id: n.id, url: n.url })
      if (n.children) walk(n.children)
    }
  }
  walk(tree)
  return found
}

/* ---------- items ---------- */

/** 同步/导入来的新行是否改动了"内容性"字段（决定 updatedAt 是否刷新）。 */
function contentChanged(old: StarItem, next: StarItem): boolean {
  if (old.title !== next.title) return true
  if (old.url !== next.url) return true
  if (old.description !== next.description) return true
  if (old.starredAt !== next.starredAt) return true
  if (old.bookmarkedAt !== next.bookmarkedAt) return true
  if (old.sources.join(',') !== next.sources.join(',')) return true
  if ((old.starMeta?.stars ?? 0) !== (next.starMeta?.stars ?? 0)) return true
  if ((old.starMeta?.language ?? '') !== (next.starMeta?.language ?? '')) return true
  if ((old.starMeta?.topics ?? []).join('|') !== (next.starMeta?.topics ?? []).join('|')) return true
  if ((old.bookmarkMeta?.folderPaths ?? []).join('|') !== (next.bookmarkMeta?.folderPaths ?? []).join('|')) return true
  return false
}

/**
 * 合并同 id 旧行：保留用户维护字段（tags/notes/summary/hidden/embedded）与 createdAt，
 * 仅在内容字段发生变化时刷新 updatedAt。修复"再次同步会清掉标签/笔记/隐藏标记"的数据丢失。
 */
function mergePreserving(old: StarItem | undefined, incoming: StarItem): StarItem {
  if (!old) return incoming
  const dirty = contentChanged(old, incoming)
  return {
    ...incoming,
    tags: old.tags,
    notes: old.notes,
    summary: old.summary,
    hidden: old.hidden,
    embedded: old.embedded,
    reviewedAt: old.reviewedAt,
    reviewCount: old.reviewCount,
    reviewSkip: old.reviewSkip,
    createdAt: old.createdAt,
    updatedAt: dirty ? incoming.updatedAt : old.updatedAt,
  }
}

export async function upsertItems(items: StarItem[]): Promise<void> {
  const CHUNK = 500
  await db.transaction('rw', db.items, db.meta, async () => {
    const meta = await getAppMeta()
    for (let i = 0; i < items.length; i += CHUNK) {
      const slice = items.slice(i, i + CHUNK)
      const olds = await db.items.bulkGet(slice.map((it) => it.id))
      const next: StarItem[] = []
      for (let j = 0; j < slice.length; j++) {
        const merged = mergePreserving(olds[j], slice[j]!)
        applyItemDelta(meta, olds[j], merged)
        next.push(merged)
      }
      await db.items.bulkPut(next)
    }
    await saveAppMeta(meta)
  })
}

export async function getByUrl(url: string): Promise<StarItem | undefined> {
  return db.items.where('url').equals(url).first()
}

export async function allItems(): Promise<StarItem[]> {
  return db.items.toArray()
}

/** 仅保留 hidden 的条目。 */
export async function hiddenItems(): Promise<StarItem[]> {
  return (await db.items.toArray()).filter((i) => i.hidden)
}

/**
 * 从若干条记录中移除某个来源；若来源清空则删除整行。批量读写，并同步维护 meta 计数。
 */
export async function stripSourceForUrls(urls: string[], source: Source): Promise<void> {
  if (urls.length === 0) return
  await db.transaction('rw', db.items, db.meta, async () => {
    const meta = await getAppMeta()
    const rows = await db.items.where('url').anyOf(urls).toArray()
    const byUrl = new Map(rows.map((r) => [r.url, r]))
    const toPut: StarItem[] = []
    const toDelete: string[] = []
    for (const url of urls) {
      const item = byUrl.get(url)
      if (!item) continue
      const sources = item.sources.filter((s) => s !== source)
      const next = sources.length === 0 ? undefined : { ...item, sources, updatedAt: Date.now() }
      applyItemDelta(meta, item, next)
      if (next) toPut.push(next)
      else toDelete.push(item.id)
    }
    await db.items.bulkPut(toPut)
    await db.items.bulkDelete(toDelete)
    await saveAppMeta(meta)
  })
}

export async function countSources(): Promise<{ stars: number; bookmarks: number }> {
  const m = await getAppMeta()
  return { stars: m.stars, bookmarks: m.bookmarks }
}

/** 局部更新单条（tags/notes/hidden 等），维护 updatedAt 与 meta 计数。 */
export async function updateItem(id: string, patch: ItemEditPatch): Promise<void> {
  await db.transaction('rw', db.items, db.meta, async () => {
    const item = await db.items.get(id)
    if (!item) throw new Error('条目不存在')
    const next = {
      ...item,
      ...patch,
      tags: patch.tags !== undefined ? dedupeTags(patch.tags) : item.tags,
      updatedAt: Date.now(),
    }
    const meta = await getAppMeta()
    applyItemDelta(meta, item, next)
    await db.items.put(next)
    await saveAppMeta(meta)
  })
}

export function dedupeTags(tags: string[]): string[] {
  const out: string[] = []
  for (const t of tags) {
    const v = t.trim()
    if (v && !out.includes(v)) out.push(v)
  }
  return out
}

/* ---------- 批量操作（阶段 B：批量加标签 / 隐藏 / 删除） ---------- */

export type BatchAction =
  | { kind: 'addTags'; ids: string[]; tags: string[] }
  | { kind: 'removeTags'; ids: string[]; tags: string[] }
  | { kind: 'setHidden'; ids: string[]; hidden: boolean }
  | { kind: 'delete'; ids: string[] }

export interface BatchResult {
  affected: number
  /** 被整行删除的条目（供 UI 提示“其中 n 条书签已从浏览器删除”） */
  deletedRows: number
  /** 其中同步删除了浏览器书签的条数 */
  removedBookmarks: number
}

/**
 * 批量应用编辑动作。全部在同一事务内完成，meta 计数随行变更同步增减。
 * delete 会同时调用浏览器书签 API 删除真实书签（失败不影响本地行删除）。
 */
export async function applyBatch(action: BatchAction, opts?: { deleteBookmarks?: boolean }): Promise<BatchResult> {
  const ids = [...new Set(action.ids)].filter(Boolean)
  if (ids.length === 0) return { affected: 0, deletedRows: 0, removedBookmarks: 0 }
  const deleteBookmarks = opts?.deleteBookmarks ?? true

  const touched: string[] = []
  let deletedRows = 0
  let removedBookmarks = 0

  if (action.kind === 'delete') {
    // 先删浏览器书签（仅 bookmark 来源行；批量操作会触发 onRemoved 增量同步自动回写）。
    // 仅本地行删除放在事务里。
    if (deleteBookmarks) {
      const rows = await db.items.bulkGet(ids)
      const withBm = rows.filter((r) => r?.sources.includes('bookmark'))
      if (withBm.length > 0) {
        try {
          const tree = (await browser.bookmarks.getTree()) as unknown as BmNode[]
          const urlSet = new Set(withBm.map((r) => r!.url))
          for (const target of collectBookmarkIdsByUrls(tree, urlSet)) {
            try {
              await browser.bookmarks.remove(target.id)
              removedBookmarks++
            } catch {
              // 单个节点删除失败不阻塞其余
            }
          }
        } catch {
          // getTree 失败（权限等）不阻塞本地清理
        }
      }
    }
    await db.transaction('rw', db.items, db.meta, async () => {
      const meta = await getAppMeta()
      const rows = await db.items.bulkGet(ids)
      for (const row of rows) {
        if (!row) continue
        applyItemDelta(meta, row, undefined)
        deletedRows++
      }
      await db.items.bulkDelete(ids)
      await saveAppMeta(meta)
    })
    return { affected: ids.length, deletedRows, removedBookmarks }
  }

  await db.transaction('rw', db.items, db.meta, async () => {
    const meta = await getAppMeta()
    const rows = await db.items.bulkGet(ids)
    const toPut: StarItem[] = []
    for (const row of rows) {
      if (!row) continue
      let next: StarItem | undefined
      if (action.kind === 'addTags') {
        const merged = dedupeTags([...(row.tags ?? []), ...action.tags])
        if (merged.length !== (row.tags?.length ?? 0)) {
          next = { ...row, tags: merged, updatedAt: Date.now() }
        }
      } else if (action.kind === 'removeTags') {
        const rest = (row.tags ?? []).filter((t) => !action.tags.includes(t))
        if (rest.length !== (row.tags ?? []).length) {
          next = { ...row, tags: rest.length ? rest : undefined, updatedAt: Date.now() }
        }
      } else if (action.kind === 'setHidden') {
        if (Boolean(row.hidden) !== action.hidden) {
          next = { ...row, hidden: action.hidden || undefined, updatedAt: Date.now() }
        }
      }
      if (next) {
        applyItemDelta(meta, row, next)
        toPut.push(next)
        touched.push(next.id)
      }
    }
    await db.items.bulkPut(toPut)
    await saveAppMeta(meta)
  })
  return { affected: touched.length, deletedRows: 0, removedBookmarks: 0 }
}

/**
 * 通用条目变换：对全部（或排除隐藏）条目应用 fn，返回变更 id。
 * fn 返回 null/undefined 表示该条无变化。索引失效由调用方 bumpIndexVersion。
 */
export async function transformItems(
  fn: (item: StarItem) => StarItem | null | undefined,
  opts?: { skipHidden?: boolean },
): Promise<string[]> {
  const items = await db.items.toArray()
  const changedIds: string[] = []
  await db.transaction('rw', db.items, db.meta, async () => {
    const meta = await getAppMeta()
    const toPut: StarItem[] = []
    for (const item of items) {
      if (opts?.skipHidden && item.hidden) continue
      const next = fn(item)
      if (!next) continue
      applyItemDelta(meta, item, next)
      toPut.push(next)
      changedIds.push(next.id)
    }
    await db.items.bulkPut(toPut)
    await saveAppMeta(meta)
  })
  return changedIds
}

/* ---------- searchIndex ---------- */

export async function getSearchIndex(): Promise<SearchIndexRecord | undefined> {
  return db.searchIndex.get('main')
}

export async function saveSearchIndex(rec: SearchIndexRecord): Promise<void> {
  await db.searchIndex.put({ ...rec, id: 'main' })
}

/* ---------- syncState（key-value 检查点） ---------- */

export async function getSyncState<T>(key: string): Promise<T | undefined> {
  const row = await db.syncState.get(key)
  return row?.value as T | undefined
}

export async function setSyncState(key: string, value: unknown): Promise<void> {
  await db.syncState.put({ key, value })
}

export async function clearAll(): Promise<void> {
  await db.delete()
  await db.open()
  await browser.storage.local.clear()
}