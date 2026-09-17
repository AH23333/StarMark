import type { SuggestEntry, Source } from './types'

/*
 * omnibox 建议工具（从 background.ts 提出为纯函数，便于单测 —— 审查 P1-5）。
 * Chrome 的建议描述字段按 XML 解析：& < > 未转义会导致含 `vector<int>`、
 * `C & C++` 类标题/URL 的建议渲染失败或内容缺失。
 */

function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

export function formatOmniboxEntry(e: SuggestEntry): string {
  const badges = e.sources.map((s) => (s === 'star' ? '⭐' : '🔖')).join(' ')
  return `<url>${escapeXml(e.title)}</url> ${badges} <dim>${escapeXml(e.url)}</dim>`
}

/** 地址栏轻量建议：标题/URL 前缀加权、书签来源小幅加权（与 worker 搜索语义无关，纯 SW 内存计算） */
export function suggestEntries(q: string | undefined, entries: SuggestEntry[], max = 8): SuggestEntry[] {
  const needle = (q ?? '').trim().toLowerCase()
  if (!needle) return entries.slice(0, max)
  const scored = entries
    .map((e) => {
      const title = e.title.toLowerCase()
      const url = e.url.toLowerCase()
      let score = 0
      if (title.startsWith(needle)) score += 100
      else if (title.includes(needle)) score += 60
      if (url.startsWith(`https://${needle}`) || url.includes(needle)) score += 30
      if ((e.sources as Source[]).includes('bookmark')) score += 5
      return { e, score }
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
  return scored.slice(0, max).map((x) => x.e)
}
