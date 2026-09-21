import MiniSearch from 'minisearch'
import { DB_BULK_CHUNK, SNAPSHOT_DEBOUNCE_MS } from '~/core/constants'
import { getSearchIndex, allItems, hiddenItems, getAppMeta, saveSearchIndex, db } from '~/core/db'
import { createMiniSearch, docFromItem, searchOptions } from '~/core/search/indexer'
import { recentActivity } from '~/core/activity'
import { compressText, decompressToText, hasDeflate } from '~/core/compress'
import { sortHitsByPref } from '~/core/search/selectors'
import { makeSourceFilter, makeTagFilter } from '~/core/search/filters'
import { browseItems, literalFallback, enrichHits, buildFolderNodeTree } from '~/core/search/query'
import type { SearchDoc, StarItem, UIPrefs } from '~/core/types'
import type { FolderNode, WorkerRequest, WorkerResponse, SearchHit } from '~/core/search/protocol'

let index: MiniSearch<SearchDoc> | null = null
let ready = false
let cachedVersion = -1
let docCount = 0

/*
 * 全量条目缓存（审查 P2-2 / R6）：MiniSearch 命中不足时的字面兜底、空查询浏览、
 * buildFolderTree 都要 allItems() 全表加载，旧实现每次按键（120ms 防抖后）都重读
 * IndexedDB。worker 内维护带 indexVersion 校验的缓存，增量补丁同步维护，全表只在
 * 版本落后时重新加载一次。
 */
let itemsCache: StarItem[] | null = null
let itemsCacheVersion = -1

async function getItemsCached(): Promise<StarItem[]> {
  if (itemsCache && itemsCacheVersion === cachedVersion) return itemsCache
  itemsCache = await allItems()
  itemsCacheVersion = cachedVersion
  return itemsCache
}

/** 指数更新与搜索串行化队列，保证读写顺序且不出竞争 */
let chain: Promise<unknown> = Promise.resolve()
function enqueue<T>(fn: () => Promise<T>): Promise<T> {
  const p = chain.then(fn, fn)
  chain = p.then(() => undefined, () => undefined)
  return p
}

/** 延迟序列化+压缩写盘；对连续多次增量更新仅触发一次持久化 */
let persistTimer: ReturnType<typeof setTimeout> | null = null
function schedulePersist(): void {
  if (persistTimer != null) clearTimeout(persistTimer)
  persistTimer = setTimeout(() => {
    persistTimer = null
    void persistSnapshot()
  }, SNAPSHOT_DEBOUNCE_MS)
}
async function persistSnapshot(): Promise<void> {
  if (!index || !ready) return
  try {
    const json = JSON.stringify(index.toJSON())
    const data = hasDeflate ? ((await compressText(json)) as Blob) : json
    await saveSearchIndex({ id: 'main', version: cachedVersion, builtAt: Date.now(), data, docCount })
  } catch {
    // 写盘失败不阻塞搜索；下次 ensureIndex 仍可通过 DB 完整重建
  }
}

async function applyPatch(ids: string[]): Promise<void> {
  if (!index || ids.length === 0) return
  // id 数量过多时直接全量重建（discard+add 本身带词法分析，性价比不如全量）
  if (ids.length >= (index.documentCount >>> 1)) {
    await ensureIndex(true, cachedVersion)
    return
  }
  const items = await db.items.bulkGet(ids)
  for (let i = 0; i < ids.length; i++) {
    const item = items[i]
    // discard 对不在索引中的 id 会抛错（批量删除后索引里可能已无此文档），必须容错
    try {
      index.discard(ids[i]!)
    } catch {
      // 文档不存在则跳过
    }
    if (item) index.add(docFromItem(item))
  }
  docCount = index.documentCount
  // 同步维护全量缓存：存在则替换/加入，已删除（bulkGet 取不到）则移除
  if (itemsCache && itemsCacheVersion === cachedVersion) {
    const byId = new Map(itemsCache.map((x) => [x.id, x]))
    for (let i = 0; i < ids.length; i++) {
      const item = items[i]
      if (item) byId.set(item.id, item)
      else byId.delete(ids[i]!)
    }
    itemsCache = [...byId.values()]
  }
  schedulePersist()
}

async function ensureIndex(force = false, version = 0): Promise<void> {
  if (ready && !force) return
  const indexVersion = version

  if (!force) {
    const saved = await getSearchIndex()
    if (saved && saved.data && saved.version === indexVersion) {
      try {
        const json = typeof saved.data === 'string' ? saved.data : await decompressToText(saved.data)
        index = MiniSearch.loadJSON(json, searchOptions())
        docCount = saved.docCount ?? 0
        cachedVersion = indexVersion
        ready = true
        // 快照反序列化路径：条目缓存惰性加载（首次 getItemsCached 时读一次全表）
        itemsCache = null
        itemsCacheVersion = cachedVersion
        return
      } catch {
        index = null
      }
    }
  }

  const items = await allItems()
  const ms = createMiniSearch()
  const docs = items.map(docFromItem)
  const CHUNK = DB_BULK_CHUNK
  for (let i = 0; i < docs.length; i += CHUNK) {
    ms.addAll(docs.slice(i, i + CHUNK))
  }
  index = ms
  docCount = docs.length
  cachedVersion = indexVersion
  ready = true
  // 全量重建路径：条目缓存直接复用本次全表数据
  itemsCache = items
  itemsCacheVersion = cachedVersion

  try {
    const json = JSON.stringify(index.toJSON())
    const data = hasDeflate ? ((await compressText(json)) as Blob) : json
    await saveSearchIndex({
      id: 'main',
      version: indexVersion,
      builtAt: Date.now(),
      data,
      docCount,
    })
  } catch {
    // 压缩/落库失败不阻塞后续搜索
  }
}

async function doSearch(
  q: string,
  max: number,
  opts: { source?: 'all' | 'star' | 'bookmark'; includeHidden?: boolean; sort?: UIPrefs['sort']; tags?: string[] } = {},
): Promise<{ items: SearchHit[]; total: number }> {
  const needle = (q ?? '').trim().toLowerCase()
  const out: SearchHit[] = []
  const seenIds = new Set<string>() // 查重 O(1)（原实现对 out 做 O(n) some 扫描）
  const keepSource = makeSourceFilter(opts.source)
  const hasTags = makeTagFilter(opts.tags)

  const toHit = (doc: SearchDoc): SearchHit => ({
    id: doc.id,
    url: doc.url,
    title: doc.title,
    sources: String(doc.sources ?? '').split(',').filter(Boolean),
    description: doc.description,
    notes: doc.notes,
    tags: String(doc.tags ?? '').split(/\s+/).filter(Boolean),
    language: doc.language || null,
    stars: doc.stars,
    starredAt: doc.starredAt || undefined,
    bookmarkedAt: doc.bookmarkedAt || undefined,
    createdAt: doc.createdAt || undefined,
    hidden: Boolean(doc.hidden),
    favicon: doc.favicon,
  })

  const push = (h: SearchHit): void => {
    if (h.hidden && !opts.includeHidden) return
    if (!keepSource(h.sources)) return
    if (!hasTags(h.tags)) return
    if (!seenIds.has(h.id)) {
      seenIds.add(h.id)
      out.push(h)
    }
  }

  // 空查询 = 浏览模式：列出全部 Star / 书签（应用来源与隐藏过滤 + 标签限定 + 排序）。
  // 编排逻辑已抽到 core/search/query.ts（审查洞察 D1，本 worker 只剩 MiniSearch 调用与分发）。
  if (!needle) {
    const r = browseItems(await getItemsCached(), { ...opts, max })
    return { items: r.hits, total: r.total }
  }

  // 1) MiniSearch 模糊/前缀命中
  if (index) {
    const raw = index.search(needle, { prefix: true, fuzzy: 0.2 })
    for (const r of raw) {
      push(toHit(r as unknown as SearchDoc))
      if (out.length >= max) break
    }
  }

  // 2) 字面兜底：对当前全部条目做 title·url 包含匹配（保证 Star/书签都能命中）；
  //    走版本化缓存（审查 P2-2），不再每次按键全表读 IndexedDB
  if (out.length < max) {
    literalFallback(await getItemsCached(), needle, { ...opts, max }, seenIds, out)
  }

  // MiniSearch 的 storeFields 不含 description/notes（省内存），命中结果按 id 补取。
  // 条目缓存命中时直接从内存取（省一次 IndexedDB 批量读）；仅缓存不可用时回退 bulkGet
  if (needle && out.length > 0) {
    if (itemsCache && itemsCacheVersion === cachedVersion) {
      enrichHits(out, new Map(itemsCache.map((x) => [x.id, x])))
    } else {
      const full = await db.items.bulkGet(out.map((h) => h.id))
      enrichHits(
        out,
        new Map((full.filter((x): x is StarItem => Boolean(x))).map((x) => [x.id, x])),
      )
    }
  }

  return { items: out, total: out.length }
}

/** 由全部条目的 folderPaths 构建收藏夹树（未搜索时的默认视图）；纯逻辑在 core/search/query.ts（审查洞察 D1）。 */
async function buildFolderTree(tags?: string[]): Promise<FolderNode[]> {
  return buildFolderNodeTree(await getItemsCached(), tags)
}

function readyResponse(rebuilding: boolean): WorkerResponse {
  return { type: 'ready', indexVersion: cachedVersion, docCount, rebuilt: rebuilding }
}

self.onmessage = (e: MessageEvent<WorkerRequest>) => {
  const req = e.data
  if (req.type === 'init') {
    void enqueue(() => ensureIndex(false, req.version ?? 0).finally(() => self.postMessage(readyResponse(true))))
    return
  }
  if (req.type === 'invalidate') {
    const ids = req.ids ?? null
    if (typeof req.version === 'number' && req.version > cachedVersion) cachedVersion = req.version
    void enqueue(async () => {
      try {
        if (ids === null) await ensureIndex(true, cachedVersion)
        else if (ids.length > 0) await applyPatch(ids)
        else schedulePersist() // 空补丁（仅版本号变化）：把快照 version 对齐到最新，避免下次 init 误判失效而全量重建
      } finally {
        self.postMessage({ type: 'ready', indexVersion: cachedVersion, docCount, rebuilt: false } satisfies WorkerResponse)
      }
    })
    return
  }
  if (req.type === 'search') {
    void enqueue(async () => {
      const { items, total } = await doSearch(req.q, req.max ?? (req.q.trim() ? 60 : 500), {
        source: req.source,
        includeHidden: req.includeHidden,
        sort: req.sort,
        tags: req.tags,
      })
      self.postMessage({ type: 'results', q: req.q, items, total } satisfies WorkerResponse)
    })
    return
  }
  if (req.type === 'tree') {
    void buildFolderTree(req.tags)
      .then((root) => self.postMessage({ type: 'tree-result', root } satisfies WorkerResponse))
      .catch((e) => self.postMessage({ type: 'tree-result', root: [] } satisfies WorkerResponse))
    return
  }
  if (req.type === 'activity') {
    void recentActivity(50)
      .then((items) => self.postMessage({ type: 'activity-result', items } satisfies WorkerResponse))
      .catch(() => self.postMessage({ type: 'activity-result', items: [] } satisfies WorkerResponse))
    return
  }
  if (req.type === 'tags') {
    // 标签频次从条目实时统计（不再读 meta 直方图）：彻底消除 meta 与条目 tags 脱同步——
    // 旧实现里 meta.tags 与条目实际标签不一致时，标签云可点但过滤永远为空（用户实测踩坑）。
    // 走条目缓存（版本化），成本可忽略。
    void (async () => {
      const items = await getItemsCached()
      const freq = new Map<string, number>()
      for (const it of items) {
        for (const t of it.tags ?? []) {
          if (!t) continue
          freq.set(t, (freq.get(t) ?? 0) + 1)
        }
      }
      const tags = [...freq.entries()]
        .map(([name, count]) => ({ name, count }))
        .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'zh'))
      self.postMessage({ type: 'tags-result', tags } satisfies WorkerResponse)
    })().catch(() => self.postMessage({ type: 'tags-result', tags: [] } satisfies WorkerResponse))
    return
  }
  if (req.type === 'hidden') {
    void hiddenItems()
      .then((items) =>
        self.postMessage({
          type: 'hidden-result',
          items: items.map((i) => ({
            id: i.id, url: i.url, title: i.title, sources: i.sources, tags: i.tags,
            starredAt: i.starredAt, bookmarkedAt: i.bookmarkedAt, createdAt: i.createdAt,
            hidden: true, favicon: i.faviconUrl,
          })),
        } satisfies WorkerResponse),
      )
      .catch(() => self.postMessage({ type: 'hidden-result', items: [] } satisfies WorkerResponse))
    return
  }
}