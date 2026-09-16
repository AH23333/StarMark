import { getToken } from './api/github'

/**
 * GitHub 热榜推荐（阶段 B 改造）：抓取 github.com/trending 页面解析，
 * 失败时回退 GitHub Search API（created:>N days sort=stars）。
 * 需要宿主权限 https://github.com/*（Search API 兜底走 api.github.com 的 CORS）。
 */

export interface TrendingRepo {
  fullName: string
  url: string
  description: string
  language: string | null
  stars: number
  /** 本期新增星数（页面上的 "N stars today/this week"） */
  starsToday?: number
}

export type TrendingPeriod = 'daily' | 'weekly' | 'monthly'

function stripTags(s: string): string {
  return s.replace(/<[^>]+>/g, "")
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
}

/** 从 trending 页 HTML 解析仓库列表（正则，无 DOM 依赖，SW/页面均可跑）。 */
export function parseTrendingHtml(html: string): TrendingRepo[] {
  const out: TrendingRepo[] = []
  const parts = html.split(/<article\b/)
  for (const part of parts.slice(1)) {
    const end = part.indexOf('</article>')
    if (end < 0) continue
    const chunk = part.slice(0, end)
    const link = chunk.match(/<a\s[^>]*href="\/([^"#?]+\/[^"#?]+?)"/)
    if (!link) continue
    const fullName = link[1]!.replace(/\/$/, '')
    if (/(stargazers|forks|watchers)$/.test(fullName)) continue
    const descM = chunk.match(/<p[^>]*>([\s\S]*?)<\/p>/)
    const langM = chunk.match(/itemprop="programmingLanguage">\s*([^<]+?)\s*</)
    const starM = chunk.match(/stargazers"[\s\S]*?([\d,]+)\s*<\/a>/)
    const periodM = chunk.match(/([\d,]+)\s+stars?\s+(?:today|this week|this month)/)
    out.push({
      fullName,
      url: "https://github.com/" + fullName,
      description: descM ? decodeEntities(stripTags(descM[1]!)).trim() : "",
      language: langM ? langM[1]!.trim() : null,
      stars: starM ? Number(starM[1]!.replace(/,/g, "")) : 0,
      starsToday: periodM ? Number(periodM[1]!.replace(/,/g, "")) : undefined,
    })
  }
  return out
}

const PERIOD_DAYS: Record<TrendingPeriod, number> = { daily: 2, weekly: 7, monthly: 30 }

/** 抓取热榜；页面抓取失败自动回退 Search API。 */
export async function fetchTrending(period: TrendingPeriod = 'weekly', language?: string): Promise<TrendingRepo[]> {
  try {
    const langPath = language ? '/' + encodeURIComponent(language.toLowerCase()) : ''
    const url = 'https://github.com/trending' + langPath + '?since=' + period
    const res = await fetch(url, { headers: { Accept: 'text/html' } })
    if (!res.ok) throw new Error('HTTP ' + res.status)
    const parsed = parseTrendingHtml(await res.text())
    if (parsed.length > 0) return parsed
    throw new Error('trending 页解析为空')
  } catch {
    return searchFallback(period, language)
  }
}

async function searchFallback(period: TrendingPeriod, language?: string): Promise<TrendingRepo[]> {
  const since = new Date(Date.now() - PERIOD_DAYS[period] * 86400000).toISOString().slice(0, 10)
  const q = new URLSearchParams({
    q: 'created:>' + since + (language ? ' language:' + language : '') + ' stars:>50',
    sort: 'stars',
    order: 'desc',
    per_page: '25',
  })
  const token = await getToken()
  const headers: Record<string, string> = { Accept: 'application/vnd.github+json' }
  if (token) headers.Authorization = "Bearer " + token
  const res = await fetch('https://api.github.com/search/repositories?' + q.toString(), { headers })
  if (!res.ok) throw new Error('GitHub Search API ' + res.status)
  const data = (await res.json()) as {
    items?: { full_name: string; html_url: string; description: string | null; language: string | null; stargazers_count: number }[]
  }
  return (data.items ?? []).map((r) => ({
    fullName: r.full_name,
    url: r.html_url,
    description: r.description ?? "",
    language: r.language ?? null,
    stars: r.stargazers_count ?? 0,
  }))
}