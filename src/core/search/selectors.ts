import { normalizedTitle } from '../insights'
import type { UIPrefs } from '../types'
import type { SearchHit } from './protocol'

export interface ResultSection {
  label: string
  items: SearchHit[]
}

/** 按归一化标题找出疑似重复条目（相同标题的 id 集合） */
export function collectDupIds(hits: SearchHit[]): Set<string> {
  const byTitle = new Map<string, string[]>()
  for (const h of hits) {
    const key = normalizedTitle(h.title)
    if (!key) continue
    const arr = byTitle.get(key) ?? []
    arr.push(h.id)
    byTitle.set(key, arr)
  }
  const ids = new Set<string>()
  for (const [, arr] of byTitle) if (arr.length > 1) arr.forEach((id) => ids.add(id))
  return ids
}

/** 结果中出现的语言（去重排序） */
export function collectLanguages(hits: SearchHit[]): string[] {
  const s = new Set<string>()
  for (const h of hits) if (h.language) s.add(h.language)
  return [...s].sort()
}

/** 可排序条目的最小字段面（SearchHit 天然满足；StarItem 侧把 starMeta.stars 映射为 stars 即可） */
export interface SortableItem {
  title: string
  createdAt?: number
  starredAt?: number
  bookmarkedAt?: number
  stars?: number
}

/**
 * 排序比较器（审查 R2）：worker 的浏览/兜底排序、UI 的 BrowseNode 排序、groupHits
 * 的单组排序此前是三处重复实现，统一到这里一处维护。
 * `relevance`/`recent` = 按 createdAt 降序；搜索结果的 relevance 保持搜索排序，不经此函数。
 */
export function sortByPref(a: SortableItem, b: SortableItem, sort: UIPrefs['sort']): number {
  switch (sort) {
    case 'starred':
      return (b.starredAt ?? 0) - (a.starredAt ?? 0)
    case 'bookmarked':
      return (b.bookmarkedAt ?? 0) - (a.bookmarkedAt ?? 0)
    case 'stars':
      return (b.stars ?? 0) - (a.stars ?? 0)
    case 'name':
      return a.title.localeCompare(b.title, 'zh')
    case 'recent':
    case 'relevance':
    default:
      return (b.createdAt ?? 0) - (a.createdAt ?? 0)
  }
}

/** 按偏好排序的纯拷贝版本（不改原数组顺序） */
export function sortHitsByPref<T extends SortableItem>(list: T[], sort: UIPrefs['sort']): T[] {
  return [...list].sort((x, y) => sortByPref(x, y, sort))
}

/**
 * 将当前结果分为若干分组：
 * - groupByDomain：按域名分组（数量降序）
 * - 排序非 relevance：单组排序
 * - 否则：区分「精确匹配」（标题前缀 / URL 命中 / 书签源内标题包含）与「相关结果」
 */
export function groupHits(
  hits: SearchHit[],
  query: string,
  prefs: UIPrefs,
  languageFilter: string,
  t: (key: string, vars?: Record<string, string | number>) => string,
): ResultSection[] {
  let list = hits.filter((h) => !languageFilter || h.language === languageFilter)
  if (list.length === 0) return []

  if (prefs.groupByDomain) {
    const map = new Map<string, SearchHit[]>()
    for (const h of list) {
      let host = ''
      try {
        host = new URL(h.url).hostname
      } catch {
        host = h.url
      }
      const arr = map.get(host) ?? []
      arr.push(h)
      map.set(host, arr)
    }
    return [...map.entries()]
      .sort((a, b) => b[1].length - a[1].length)
      .map(([host, items]) => ({ label: host, items }))
  }

  if (prefs.sort !== 'relevance') {
    const sorted = sortHitsByPref(list, prefs.sort)
    return [{ label: t('results.all', { n: sorted.length }), items: sorted }]
  }

  const needle = query.trim().toLowerCase()
  const strong: SearchHit[] = []
  const fuzzy: SearchHit[] = []
  for (const h of list) {
    const t = h.title.toLowerCase()
    const startsWithTitle = t.startsWith(needle)
    const urlHit = h.url.toLowerCase().includes(needle)
    const isStrong = startsWithTitle || urlHit
    if (!isStrong && prefs.sourceAware && h.sources.includes('bookmark') && t.includes(needle)) {
      strong.push(h)
    } else {
      ;(isStrong ? strong : fuzzy).push(h)
    }
  }
  const out: ResultSection[] = []
  if (strong.length) out.push({ label: t('results.exact'), items: strong })
  if (fuzzy.length) out.push({ label: t('results.related'), items: fuzzy })
  return out
}