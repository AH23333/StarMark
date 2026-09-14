import MiniSearch from 'minisearch'
import { getIndexVersion } from '~/core/version'
import { getSearchIndex, allItems, saveSearchIndex } from '~/core/db'
import { createMiniSearch, docFromItem, searchOptions } from '~/core/search/indexer'
import { recentActivity } from '~/core/activity'
import type { SearchDoc, StarItem, UIPrefs } from '~/core/types'
import type { FolderNode, WorkerRequest, WorkerResponse, SearchHit } from '~/core/search/protocol'

let index: MiniSearch<SearchDoc> | null = null
let ready = false
let cachedVersion = -1
let docCount = 0

async function ensureIndex(force = false): Promise<void> {
  if (ready && !force) return
  const indexVersion = await getIndexVersion()

  if (!force) {
    const saved = await getSearchIndex()
    if (saved && saved.data && saved.version === indexVersion) {
      try {
        index = MiniSearch.loadJSON(saved.data, searchOptions())
        docCount = saved.docCount ?? 0
        cachedVersion = indexVersion
        ready = true
        return
      } catch {
        index = null
      }
    }
  }

  const items = await allItems()
  const ms = createMiniSearch()
  const docs = items.map(docFromItem)
  const CHUNK = 500
  for (let i = 0; i < docs.length; i += CHUNK) {
    ms.addAll(docs.slice(i, i + CHUNK))
  }
  index = ms
  docCount = docs.length
  cachedVersion = indexVersion
  ready = true

  await saveSearchIndex({
    id: 'main',
    version: indexVersion,
    builtAt: Date.now(),
    data: JSON.stringify(index.toJSON()),
    docCount,
  })
}

function itemToHit(item: StarItem): SearchHit {
  return {
    id: item.id,
    url: item.url,
    title: item.title,
    sources: item.sources,
    description: item.description,
    notes: item.notes,
    tags: item.tags,
    language: item.starMeta?.language,
    stars: item.starMeta?.stars,
    starredAt: item.starredAt,
    bookmarkedAt: item.bookmarkedAt,
    createdAt: item.createdAt,
    hidden: Boolean(item.hidden),
    favicon: item.faviconUrl,
  }
}

function sortItems(items: StarItem[], sort: UIPrefs['sort'] | undefined): StarItem[] {
  const cmp = (a: StarItem, b: StarItem): number => {
    switch (sort) {
      case 'starred':
        return (b.starredAt ?? 0) - (a.starredAt ?? 0)
      case 'bookmarked':
        return (b.bookmarkedAt ?? 0) - (a.bookmarkedAt ?? 0)
      case 'stars':
        return (b.starMeta?.stars ?? 0) - (a.starMeta?.stars ?? 0)
      case 'name':
        return a.title.localeCompare(b.title, 'zh')
      case 'recent':
      case 'relevance':
      default:
        return (b.createdAt ?? 0) - (a.createdAt ?? 0)
    }
  }
  return [...items].sort(cmp)
}

async function doSearch(
  q: string,
  max: number,
  opts: { source?: 'all' | 'star' | 'bookmark'; includeHidden?: boolean; sort?: UIPrefs['sort']; tags?: string[] } = {},
): Promise<{ items: SearchHit[]; total: number }> {
  const needle = (q ?? '').trim().toLowerCase()
  const out: SearchHit[] = []
  const keep = (sources: string[]): boolean => {
    if (opts.source === 'star') return sources.includes('star')
    if (opts.source === 'bookmark') return sources.includes('bookmark')
    return true
  }
  const hasTags = (tags: string[] | undefined | null): boolean => !opts.tags || opts.tags.every((t) => (tags ?? []).includes(t))

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
    if (!keep(h.sources)) return
    if (!hasTags(h.tags)) return
    if (!out.some((x) => x.id === h.id)) out.push(h)
  }

  // 空查询 = 浏览模式：列出全部 Star / 书签（应用来源与隐藏过滤 + 标签限定 + 排序）
  if (!needle) {
    const items = sortItems(
      (await allItems())
        .filter((i) => !i.hidden || opts.includeHidden)
        .filter((i) => keep(i.sources))
        .filter((i) => hasTags(i.tags)),
      opts.sort,
    )
    return { items: items.slice(0, max).map(itemToHit), total: items.length }
  }

  // 1) MiniSearch 模糊/前缀命中
  if (index) {
    const raw = index.search(needle, { prefix: true, fuzzy: 0.2 })
    for (const r of raw) {
      push(toHit(r as unknown as SearchDoc))
      if (out.length >= max) break
    }
  }

  // 2) 字面兜底：对当前全部条目做 title·url 包含匹配（保证 Star/书签都能命中）
  if (out.length < max) {
    const items = await allItems()
    for (const item of items) {
      if (out.length >= max) break
      if (out.some((h) => h.id === item.id)) continue
      if (!hasTags(item.tags)) continue
      if (item.title.toLowerCase().includes(needle) || item.url.toLowerCase().includes(needle)) {
        push(itemToHit(item))
      }
    }
  }
  return { items: out, total: out.length }
}

/** 由全部书签条目的 folderPaths 构建收藏夹树（未搜索时的默认视图）。 */
async function buildFolderTree(tags?: string[]): Promise<FolderNode[]> {
  const items = (await allItems()).filter((i) => !i.hidden && (!tags || tags.every((t) => (i.tags ?? []).includes(t))))
  const root: FolderNode = { id: '__root__', name: '', path: '', count: 0, folders: [], items: [] }
  const nodeByPath = new Map<string, FolderNode>()
  nodeByPath.set('', root)

  const starItems: FolderNode['items'] = []
  for (const item of items) {
    if (item.hidden) continue
    if (item.sources.includes('star')) {
      starItems.push(itemToHit(item))
    }
    if (!item.sources.includes('bookmark')) continue
    const paths = item.bookmarkMeta?.folderPaths ?? []
    let cur = root
    let joined = ''
    for (const [i, folderName] of paths.entries()) {
      joined = joined ? `${joined} / ${folderName}` : folderName
      let node = nodeByPath.get(joined)
      if (!node) {
        node = { id: item.bookmarkMeta?.folderIds?.[i] ?? `p:${joined}`, name: folderName, path: joined, count: 0, folders: [], items: [] }
        nodeByPath.set(joined, node)
        cur.folders.push(node)
      }
      cur = node
      cur.count++
    }
    cur.items.push(itemToHit(item))
  }

  const nodes: FolderNode[] = []
  if (starItems.length > 0) {
    nodes.push({ id: '$stars', name: '全部 Star 项目', path: '$stars', count: starItems.length, folders: [], items: starItems, kind: 'stars' })
  }
  return nodes.concat(root.folders)
}

function readyResponse(rebuilding: boolean): WorkerResponse {
  return { type: 'ready', indexVersion: cachedVersion, docCount, rebuilt: rebuilding }
}

self.onmessage = (e: MessageEvent<WorkerRequest>) => {
  const req = e.data
  if (req.type === 'init') {
    void ensureIndex().finally(() => self.postMessage(readyResponse(true)))
    return
  }
  if (req.type === 'rebuild') {
    index = null
    ready = false
    void ensureIndex(true).then(() => self.postMessage(readyResponse(false)))
    return
  }
  if (req.type === 'search') {
    void doSearch(req.q, req.max ?? (req.q.trim() ? 60 : 500), {
      source: req.source,
      includeHidden: req.includeHidden,
      sort: req.sort,
      tags: req.tags,
    }).then(({ items, total }) =>
      self.postMessage({ type: 'results', q: req.q, items, total } satisfies WorkerResponse),
    )
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
    void allItems()
      .then((items) => {
        const map = new Map<string, number>()
        for (const item of items) {
          if (item.hidden) continue
          for (const t of item.tags ?? []) {
            const v = t.trim()
            if (!v) continue
            map.set(v, (map.get(v) ?? 0) + 1)
          }
        }
        const tags = [...map.entries()]
          .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'zh'))
          .map(([name, count]) => ({ name, count }))
        self.postMessage({ type: 'tags-result', tags } satisfies WorkerResponse)
      })
      .catch(() => self.postMessage({ type: 'tags-result', tags: [] } satisfies WorkerResponse))
    return
  }
  if (req.type === 'hidden') {
    void allItems()
      .then((items) =>
        self.postMessage({
          type: 'hidden-result',
          items: items.filter((i) => i.hidden).map((i) => ({
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