import MiniSearch from 'minisearch'
import { getIndexVersion } from '~/core/version'
import { getSearchIndex, allItems, saveSearchIndex } from '~/core/db'
import { createMiniSearch, docFromItem, searchOptions } from '~/core/search/indexer'
import type { SearchDoc } from '~/core/types'
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

async function doSearch(q: string, max: number): Promise<SearchHit[]> {
  const needle = (q ?? '').trim().toLowerCase()
  if (!needle) return []
  const out: SearchHit[] = []

  // 1) MiniSearch 模糊/前缀命中
  if (index) {
    const raw = index.search(needle, { prefix: true, fuzzy: 0.2 })
    for (const r of raw) {
      out.push({
        id: r.id,
        url: r.url,
        title: r.title,
        sources: String(r.sources ?? '').split(',').filter(Boolean),
      })
      if (out.length >= max) break
    }
  }

  // 2) 字面兜底：对当前全部条目做 title·url 包含匹配（保证 Star/书签都能命中）
  if (out.length < max) {
    const seen = new Set(out.map((h) => h.id))
    const items = await allItems()
    for (const item of items) {
      if (out.length >= max) break
      if (seen.has(item.id)) continue
      if (item.title.toLowerCase().includes(needle) || item.url.toLowerCase().includes(needle)) {
        seen.add(item.id)
        out.push({ id: item.id, url: item.url, title: item.title, sources: item.sources })
      }
    }
  }
  return out
}

/** 由全部书签条目的 folderPaths 构建收藏夹树（未搜索时的默认视图）。 */
async function buildFolderTree(): Promise<FolderNode[]> {
  const items = await allItems()
  const root: FolderNode = { id: '__root__', name: '', path: '', count: 0, folders: [], items: [] }
  const nodeByPath = new Map<string, FolderNode>()
  nodeByPath.set('', root)

  const starItems: FolderNode['items'] = []
  for (const item of items) {
    if (item.sources.includes('star')) {
      starItems.push({ id: item.id, title: item.title, url: item.url })
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
    cur.items.push({ id: item.id, title: item.title, url: item.url })
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
    void doSearch(req.q, req.max ?? 30).then((items) =>
      self.postMessage({ type: 'results', q: req.q, items } satisfies WorkerResponse),
    )
    return
  }
  if (req.type === 'tree') {
    void buildFolderTree()
      .then((root) => self.postMessage({ type: 'tree-result', root } satisfies WorkerResponse))
      .catch((e) => self.postMessage({ type: 'tree-result', root: [] } satisfies WorkerResponse))
    return
  }
}