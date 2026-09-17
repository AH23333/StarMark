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

/*
 * ---- 条目主键哈希（审查 P1-1）----
 * 旧实现为 FNV-1a 32-bit（8 位 hex），约 7.7 万条时生日碰撞概率过半、1 万条约 2.3%，
 * 碰撞时 bulkPut 会静默覆盖导致数据丢失。现升级为 128-bit：MurmurHash3 x86 32-bit
 * 取 4 个独立 seed 拼接（32 位 hex），纯同步实现 —— crypto.subtle.digest 是异步的，
 * 而 hashId 被 repoToItem / bookmarkToItem 等同步路径调用，无法 await。
 * MurmurHash3 非加密哈希但雪崩充分，4 路组合碰撞需 128-bit 生日界，实际条目量级下可忽略。
 */

function rotl32(x: number, r: number): number {
  return ((x << r) | (x >>> (32 - r))) >>> 0
}

/** MurmurHash3 x86 32-bit（公开领域算法），输入为字节流 */
function murmur3_32(bytes: Uint8Array, seed: number): number {
  const C1 = 0xcc9e2d51
  const C2 = 0x1b873593
  const len = bytes.length
  const blocks = len - (len % 4)
  let h = seed >>> 0
  for (let i = 0; i < blocks; i += 4) {
    let k = (bytes[i]! | (bytes[i + 1]! << 8) | (bytes[i + 2]! << 16) | (bytes[i + 3]! << 24)) >>> 0
    k = Math.imul(k, C1) >>> 0
    k = rotl32(k, 15)
    k = Math.imul(k, C2) >>> 0
    h = (h ^ k) >>> 0
    h = rotl32(h, 13)
    h = (Math.imul(h, 5) + 0xe6546b64) >>> 0
  }
  let k = 0
  if (len % 4 >= 3) k = (k ^ (bytes[blocks + 2]! << 16)) >>> 0
  if (len % 4 >= 2) k = (k ^ (bytes[blocks + 1]! << 8)) >>> 0
  if (len % 4 >= 1) {
    k = (k ^ bytes[blocks]!) >>> 0
    k = Math.imul(k, C1) >>> 0
    k = rotl32(k, 15)
    k = Math.imul(k, C2) >>> 0
    h = (h ^ k) >>> 0
  }
  h = (h ^ len) >>> 0
  h ^= h >>> 16
  h = Math.imul(h, 0x85ebca6b) >>> 0
  h ^= h >>> 13
  h = Math.imul(h, 0xc2b2ae35) >>> 0
  h ^= h >>> 16
  return h >>> 0
}

const HASH_SEEDS = [0x811c9dc5, 0x9747b28c, 0x85ebca6b, 0xc2b2ae35]

/** URL → 128-bit 主键（32 位 hex；去重/合并依据）。同 URL 恒定，异 URL 碰撞概率可忽略。 */
export function hashId(url: string): string {
  const s = url.toLowerCase()
  // UTF-16 code unit 拆低/高字节作为字节流：确定性等价于对 UTF-8 编码做哈希（同输入同输出）
  const bytes = new Uint8Array(s.length * 2)
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    bytes[i * 2] = c & 0xff
    bytes[i * 2 + 1] = (c >>> 8) & 0xff
  }
  let hex = ''
  for (const seed of HASH_SEEDS) hex += murmur3_32(bytes, seed).toString(16).padStart(8, '0')
  return hex
}

export function faviconFor(url: string): string {
  try {
    const host = new URL(url).hostname
    return `https://www.google.com/s2/favicons?domain=${host}&sz=64`
  } catch {
    return ''
  }
}