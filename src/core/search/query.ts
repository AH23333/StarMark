import { sortHitsByPref } from './selectors'
import { makeHiddenFilter, makeSourceFilter, makeTagFilter, type SearchFilterParams } from './filters'
import type { SearchHit, FolderNode } from './protocol'
import type { StarItem, UIPrefs } from '../types'

/**
 * 搜索查询纯函数（代码洞察 D1）：doSearch 的过滤 / 排序 / 兜底编排从 worker 抽出，
 * 便于 core 层单测直接覆盖结果正确性；worker 只保留 MiniSearch 调用与消息分发。
 */

/** StarItem → SearchHit 投影（worker 与树构建共用） */
export function itemToHit(item: StarItem): SearchHit {
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

export interface BrowseResult {
  hits: SearchHit[]
  total: number
}

/** 浏览模式（空查询）：全量过滤（来源/隐藏/标签）+ 排序（relevance=recent 语义）+ 截断 */
export function browseItems(
  items: StarItem[],
  params: { source?: SearchFilterParams['source']; includeHidden?: boolean; tags?: string[]; sort?: UIPrefs['sort']; max: number },
): BrowseResult {
  const keepSource = makeSourceFilter(params.source)
  const keepHidden = makeHiddenFilter(params.includeHidden)
  const keepTags = makeTagFilter(params.tags)
  const hits = sortHitsByPref(
    items
      .filter((i) => keepHidden(Boolean(i.hidden)))
      .filter((i) => keepSource(i.sources))
      .filter((i) => keepTags(i.tags))
      .map(itemToHit),
    params.sort ?? 'recent',
  )
  return { hits: hits.slice(0, params.max), total: hits.length }
}

/** 字面兜底：title/url 包含 needle 的补充条目（排除已收集 id），受来源/隐藏/标签过滤约束 */
export function literalFallback(
  items: StarItem[],
  needle: string,
  params: { source?: SearchFilterParams['source']; includeHidden?: boolean; tags?: string[]; max: number },
  seenIds: Set<string>,
  out: SearchHit[],
): void {
  if (out.length >= params.max) return
  const keepSource = makeSourceFilter(params.source)
  const keepHidden = makeHiddenFilter(params.includeHidden)
  const keepTags = makeTagFilter(params.tags)
  for (const item of items) {
    if (out.length >= params.max) return
    if (seenIds.has(item.id)) continue
    if (item.hidden && !params.includeHidden) continue
    if (!keepSource(item.sources)) continue
    if (!keepTags(item.tags)) continue
    if (item.title.toLowerCase().includes(needle) || item.url.toLowerCase().includes(needle)) {
      seenIds.add(item.id)
      out.push(itemToHit(item))
    }
  }
}

/**
 * 命中补全：MiniSearch 的 storeFields 不含 description/notes（省内存），
 * 从完整条目按 id 回填（fullItems 为空 Map 时静默跳过）。
 */
export function enrichHits(hits: SearchHit[], fullById: Map<string, StarItem>): void {
  if (fullById.size === 0) return
  for (const h of hits) {
    const row = fullById.get(h.id)
    if (!row) continue
    if (row.description) h.description = row.description
    if (row.notes) h.notes = row.notes
  }
}

/** 简单包含匹配（兜底判定的共享定义） */
export function matchesLiteral(item: Pick<StarItem, 'title' | 'url'>, needle: string): boolean {
  return item.title.toLowerCase().includes(needle) || item.url.toLowerCase().includes(needle)
}

/**
 * 由全部条目的 folderPaths 构建收藏夹树（未搜索时的默认视图，审查洞察 D1）。
 * 与浏览模式同一标签语义（AND 限定）：先按隐藏 + 标签过滤，再建树——
 * 修复前遍历未过滤的全量 items，导致标签过滤在「文件夹」视图不生效（0.2.0 为过滤后建树）。
 */
export function buildFolderNodeTree(items: StarItem[], tags?: string[]): FolderNode[] {
  const keepTags = makeTagFilter(tags)
  const visible = items.filter((i) => !i.hidden && keepTags(i.tags))
  const root: FolderNode = { id: '__root__', name: '', path: '', count: 0, folders: [], items: [] }
  const nodeByPath = new Map<string, FolderNode>()
  nodeByPath.set('', root)

  const starItems: FolderNode['items'] = []
  for (const item of visible) {
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
    nodes.push({ id: '$stars', name: 'all-stars', path: '$stars', count: starItems.length, folders: [], items: starItems, kind: 'stars' })
  }
  return nodes.concat(root.folders)
}
