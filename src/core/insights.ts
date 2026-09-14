import type { StarItem } from './types'

export type TFunc = (key: string, vars?: Record<string, string | number>) => string

/** 无词典环境（测试）下的兜底：直接返回 key。 */
const keyOnly: TFunc = (k) => k

export interface DuplicateGroup {
  title: string
  count: number
  urls: string[]
  ids: string[]
}

export interface LanguageCount {
  language: string
  count: number
}

export interface DayCount {
  day: string
  added: number
}

export interface HealthFactor {
  label: string
  value: string
  ok: boolean
}

export interface HealthReport {
  score: number
  factors: HealthFactor[]
  duplicates: DuplicateGroup[]
  untagged: number
  hiddenCount: number
  uniqueDomains: number
  languages: LanguageCount[]
  tags: [string, number][]
  trend: DayCount[]
}

/** 归一标题：小写、折叠空白、剥离 github owner 前缀只留签名段比对。 */
export function normalizedTitle(title: string): string {
  return title.trim().toLowerCase().replace(/\s+/g, ' ')
}

/** 标题级近似去重（同一标题命中多条 URL）。 */
export function findDuplicates(items: StarItem[]): DuplicateGroup[] {
  const byTitle = new Map<string, StarItem[]>()
  for (const item of items) {
    const key = normalizedTitle(item.title)
    if (!key) continue
    const arr = byTitle.get(key)
    if (arr) arr.push(item)
    else byTitle.set(key, [item])
  }
  const groups: DuplicateGroup[] = []
  for (const [, arr] of byTitle) {
    if (arr.length < 2) continue
    groups.push({
      title: arr[0]!.title,
      count: arr.length,
      urls: arr.map((i) => i.url),
      ids: arr.map((i) => i.id),
    })
  }
  return groups
}

export function languageDistribution(items: StarItem[]): LanguageCount[] {
  const map = new Map<string, number>()
  for (const item of items) {
    if (!item.sources.includes('star')) continue
    const lang = item.starMeta?.language
    if (!lang) continue
    map.set(lang, (map.get(lang) ?? 0) + 1)
  }
  return [...map.entries()]
    .map(([language, count]) => ({ language, count }))
    .sort((a, b) => b.count - a.count)
}

export function uniqueDomainCount(items: StarItem[]): number {
  const domains = new Set<string>()
  for (const item of items) {
    try {
      domains.add(new URL(item.url).hostname)
    } catch {
      /* ignore */
    }
  }
  return domains.size
}

export function tagHistogram(items: StarItem[]): [string, number][] {
  const map = new Map<string, number>()
  for (const item of items) {
    for (const tag of item.tags ?? []) {
      map.set(tag, (map.get(tag) ?? 0) + 1)
    }
  }
  return [...map.entries()].sort((a, b) => b[1] - a[1])
}

function dayKey(ts: number): string {
  const d = new Date(ts)
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${m}-${day}`
}

/** 近 days 天每天新增条数（Star 按 starredAt，书签按 createdAt，取较合理的时间戳）。 */
export function trendSeries(items: StarItem[], days = 14): DayCount[] {
  const now = Date.now()
  const out: DayCount[] = []
  for (let i = days - 1; i >= 0; i--) {
    out.push({ day: dayKey(now - i * 86400_000), added: 0 })
  }
  const index = new Map(out.map((d, i) => [d.day, i] as const))
  for (const item of items) {
    const ts = item.starredAt ?? item.createdAt
    const i = index.get(dayKey(ts))
    if (i !== undefined) out[i]!.added++
  }
  return out
}

/** 综合健康度评分与建议（纯本地统计，不写数据）。 */
export function buildHealthReport(items: StarItem[], days = 14, t: TFunc = keyOnly): HealthReport {
  const duplicates = findDuplicates(items)
  const languages = languageDistribution(items)
  const tags = tagHistogram(items)
  const hiddenCount = items.filter((i) => i.hidden).length
  const total = items.length
  const untagged = items.filter((i) => (i.tags?.length ?? 0) === 0).length

  const factors: HealthFactor[] = []
  let score = 100

  if (total === 0) {
    factors.push({ label: t('health.emptyLabel'), value: t('health.emptyValue'), ok: false })
    return { score: 0, factors, duplicates, untagged, hiddenCount, uniqueDomains: 0, languages, tags, trend: [] }
  }

  const duplicatePenalty = Math.min(40, duplicates.length * 10)
  if (duplicates.length > 0) {
    score -= duplicatePenalty
    factors.push({
      label: t('health.dup'),
      value: t('health.dupValue', { n: duplicates.length, p: duplicatePenalty }),
      ok: false,
    })
  } else {
    factors.push({ label: t('health.dup'), value: t('health.dupNone'), ok: true })
  }

  const untaggedRatio = untagged / total
  const untaggedPenalty = Math.min(25, Math.floor(untaggedRatio * 50))
  if (untaggedRatio > 0.2) {
    score -= untaggedPenalty
    factors.push({
      label: t('health.untagged'),
      value: t('health.untaggedValue', { n: untagged, pct: Math.round(untaggedRatio * 100), p: untaggedPenalty }),
      ok: false,
    })
  } else {
    factors.push({ label: t('health.untagged'), value: t('health.untaggedOk', { n: untagged }), ok: true })
  }

  const stale = items.filter((i) => Date.now() - (i.updatedAt || 0) > 180 * 86400_000).length
  const staleRatio = stale / total
  const stalePenalty = Math.min(15, Math.floor(staleRatio * 30))
  if (staleRatio > 0.4) {
    score -= stalePenalty
    factors.push({
      label: t('health.stale'),
      value: t('health.staleValue', { n: stale, p: stalePenalty }),
      ok: false,
    })
  } else {
    factors.push({ label: t('health.stale'), value: t('health.staleOk', { n: stale }), ok: true })
  }

  const domains = uniqueDomainCount(items)
  if (domains > 1) {
    factors.push({ label: t('health.domains'), value: t('health.domainsValue', { n: domains }), ok: true })
  }

  const collectedTags = tags.slice(0, 5).map(([tag, c]) => t('health.tagsValue', { t: tag, c })).join('、')
  factors.push({
    label: t('health.tags'),
    value: collectedTags || t('health.tagsNone'),
    ok: tags.length > 0,
  })

  return {
    score: Math.max(0, Math.min(100, score)),
    factors,
    duplicates,
    untagged,
    hiddenCount,
    uniqueDomains: domains,
    languages,
    tags,
    trend: trendSeries(items, days),
  }
}