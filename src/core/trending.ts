import { browser } from 'wxt/browser'
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
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(Number.parseInt(n, 16)))
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
}

/**
 * 从 trending 页 HTML 解析仓库列表（正则，无 DOM 依赖，SW/页面均可跑）。
 * 2026-09 修复：主链接改从 <h2> 内严格匹配 owner/repo 两段（旧正则取 article 内
 * 第一个 <a>，会被 stargazers/forks 等辅助链接命中 → 整条被过滤造成"爬取不全"，
 * 或误捕获多段路径造成 fullName/url 错误）；星数提取先剥标签（数字前常有 svg）；
 * 描述只认 col-9 段（不再回退到任意 <p>，Star 按钮文本不再混入描述）。
 */
export function parseTrendingHtml(html: string): TrendingRepo[] {
  const out: TrendingRepo[] = []
  const parts = html.split(/<article\b/)
  for (const part of parts.slice(1)) {
    const end = part.indexOf('</article>')
    if (end < 0) continue
    const chunk = part.slice(0, end)
    // 仓库主链接在 <h2> 内，严格 owner/repo 两段（排除 /owner/repo/stargazers 等多段路径）
    const repoM = chunk.match(/<h2[^>]*>\s*<a\s[^>]*href="\/([\w.-]+\/[\w.-]+)"[^>]*>/)
    if (!repoM) continue
    const fullName = repoM[1]!.replace(/\/$/, '')
    // 描述固定在 col-9 段；其他 <p>（内置 Star 按钮区等）不回退，避免按钮文本混入
    const descM = chunk.match(/<p[^>]*col-9[^>]*>([\s\S]*?)<\/p>/)
    const langM = chunk.match(/itemprop="programmingLanguage">\s*([^<]+?)\s*</)
    // 星数在 stargazers 链接内，数字前常夹 svg 图标 → 先剥标签再取数字
    const starChunk = chunk.match(/href="[^"]*stargazers"[^>]*>([\s\S]*?)<\/a>/)
    const starText = starChunk ? stripTags(starChunk[1]!).replace(/[^\d,]/g, '') : ''
    const periodM = chunk.match(/([\d,]+)\s+stars?\s+(?:today|this week|this month)/)
    const description = descM ? decodeEntities(stripTags(descM[1]!)).replace(/\s+/g, ' ').trim() : ''
    out.push({
      fullName,
      url: "https://github.com/" + fullName,
      description,
      language: langM ? langM[1]!.trim() : null,
      stars: starText ? Number(starText.replace(/,/g, "")) : 0,
      starsToday: periodM ? Number(periodM[1]!.replace(/,/g, "")) : undefined,
    })
  }
  return out
}

const PERIOD_DAYS: Record<TrendingPeriod, number> = { daily: 2, weekly: 7, monthly: 30 }

/** 抓取热榜；页面抓取失败自动回退 Search API。返回数据来源供 UI 标注（解析坏了用户可感知）。 */
export async function fetchTrending(
  period: TrendingPeriod = 'weekly',
  language?: string,
): Promise<{ list: TrendingRepo[]; via: 'trending-html' | 'search-api' }> {
  try {
    const langPath = language ? '/' + encodeURIComponent(language.toLowerCase()) : ''
    const url = 'https://github.com/trending' + langPath + '?since=' + period
    const res = await fetch(url, { headers: { Accept: 'text/html' } })
    if (!res.ok) throw new Error('HTTP ' + res.status)
    const parsed = parseTrendingHtml(await res.text())
    if (parsed.length > 0) return { list: parsed, via: 'trending-html' }
    throw new Error('trending 页解析为空')
  } catch {
    return { list: await searchFallback(period, language), via: 'search-api' }
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
/* ---------- 每日缓存：每个周期每天首次打开抓取一次，之后读本地缓存 ---------- */

export interface TrendingCacheEntry {
  data: TrendingRepo[]
  fetchedAt: number
}

const CACHE_KEY = 'trendingCache'

function cacheKeyOf(period: TrendingPeriod, language?: string): string {
  return [period, (language ?? '').toLowerCase()].join('|')
}

/** 是否同一个本地日历日（"每天首次打开"的判定） */
export function isSameLocalDay(ts: number, now = Date.now()): boolean {
  return new Date(ts).toDateString() === new Date(now).toDateString()
}

export async function readTrendingCache(period: TrendingPeriod, language?: string): Promise<TrendingCacheEntry | undefined> {
  const s = await browser.storage.local.get(CACHE_KEY)
  const cache = (s[CACHE_KEY] ?? {}) as Record<string, TrendingCacheEntry>
  return cache[cacheKeyOf(period, language)]
}

export async function writeTrendingCache(period: TrendingPeriod, language: string | undefined, data: TrendingRepo[]): Promise<void> {
  const s = await browser.storage.local.get(CACHE_KEY)
  const cache = (s[CACHE_KEY] ?? {}) as Record<string, TrendingCacheEntry>
  cache[cacheKeyOf(period, language)] = { data, fetchedAt: Date.now() }
  await browser.storage.local.set({ [CACHE_KEY]: cache })
}

export interface TrendingResult {
  list: TrendingRepo[]
  fromCache: boolean
  fetchedAt?: number
  /** 回退到过期缓存（本次抓取失败） */
  stale: boolean
  /** 数据来源：trending 页解析（默认）或 Search API 兜底（解析失败时），UI 据此标注 */
  via?: 'trending-html' | 'search-api'
}

export async function fetchTrendingCached(
  period: TrendingPeriod = 'weekly',
  language?: string,
  opts: { force?: boolean; now?: number } = {},
): Promise<TrendingResult> {
  const now = opts.now ?? Date.now()
  const cached = await readTrendingCache(period, language)
  if (!opts.force && cached && isSameLocalDay(cached.fetchedAt, now)) {
    return { list: cached.data, fromCache: true, fetchedAt: cached.fetchedAt, stale: false }
  }
  try {
    const { list, via } = await fetchTrending(period, language)
    await writeTrendingCache(period, language, list)
    return { list, fromCache: false, fetchedAt: now, stale: false, via }
  } catch (e) {
    // 抓取失败：有任何旧缓存就先展示（标注过期），完全没缓存才抛错
    if (cached) return { list: cached.data, fromCache: true, fetchedAt: cached.fetchedAt, stale: true }
    throw e
  }
}