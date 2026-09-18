import { sortHitsByPref } from './selectors'
import { makeHiddenFilter, makeSourceFilter, makeTagFilter, type SearchFilterParams } from './filters'
import type { SearchHit } from './protocol'
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
