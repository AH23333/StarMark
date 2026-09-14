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

/** 排序比较器（与 worker 的 sortItems 保持一致语义） */
export function sortByPref(a: SearchHit, b: SearchHit, sort: UIPrefs['sort']): number {
  switch (sort) {
    case 'recent':
      return (b.createdAt ?? 0) - (a.createdAt ?? 0)
    case 'starred':
      return (b.starredAt ?? 0) - (a.starredAt ?? 0)
    case 'bookmarked':
      return (b.bookmarkedAt ?? 0) - (a.bookmarkedAt ?? 0)
    case 'stars':
      return (b.stars ?? 0) - (a.stars ?? 0)
    case 'name':
      return a.title.localeCompare(b.title, 'zh')
    default:
      return 0
  }
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
    const sorted = [...list].sort((a, b) => sortByPref(a, b, prefs.sort))
    return [{ label: `${sorted.length} 条结果`, items: sorted }]
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
  if (strong.length) out.push({ label: '精确匹配', items: strong })
  if (fuzzy.length) out.push({ label: '相关结果', items: fuzzy })
  return out
}