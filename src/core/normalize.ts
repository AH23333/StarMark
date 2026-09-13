const TRACKING_PARAMS = new Set([
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_term',
  'utm_content',
  'fbclid',
  'gclid',
  'mc_cid',
  'mc_eid',
  'ref_source',
])

/**
 * URL 规范化：统一协议/端口/大小写、去尾斜杠与锚点、剥离追踪参数，
 * GitHub 仓库页归一为 https://github.com/{owner}/{repo}。
 * 用于 Star 与书签的跨源去重。
 */
export function normalizeUrl(input: string): string {
  if (typeof input !== 'string' || input === '') return ''
  let url: URL
  try {
    url = new URL(input)
  } catch {
    try {
      url = new URL(input.startsWith('//') ? 'https:' + input : 'https://' + input)
    } catch {
      return input.trim().toLowerCase()
    }
  }

  url.hash = ''
  if (url.protocol === 'http:' && url.port === '80') url.port = ''
  if (url.protocol === 'https:' && url.port === '443') url.port = ''
  url.hostname = url.hostname.toLowerCase()

  for (const key of TRACKING_PARAMS) url.searchParams.delete(key)

  const host = url.hostname
  if (host === 'github.com' || host.endsWith('.github.com')) {
    const parts = url.pathname.split('/').filter(Boolean)
    if (parts.length >= 2) {
      // owner/repo[/tree|/commits|...]，统一收窄到仓库首页
      url.pathname = '/' + parts[0] + '/' + parts[1]
      if (url.search.includes('tab=')) url.search = ''
    }
  }

  let s = url.toString()
  if (s.endsWith('/')) s = s.slice(0, -1)
  return s
}

/** FNV-1a 32-bit → 8 位十六进制，作为条目主键（去重/合并依据） */
export function hashId(url: string): string {
  const s = url.toLowerCase()
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(16).padStart(8, '0')
}

export function faviconFor(url: string): string {
  try {
    const host = new URL(url).hostname
    return `https://www.google.com/s2/favicons?domain=${host}&sz=64`
  } catch {
    return ''
  }
}

export function sortByStars(a: { stars?: number }, b: { stars?: number }): number {
  return (b.stars ?? 0) - (a.stars ?? 0)
}