import { t } from './i18n'

/*
 * UI 纯工具函数（审查 R1）：此前全部内联在 sidepanel/App.tsx（1581 行），
 * 拆分组件后统一收口到 core，worker 与测试亦可复用。
 */

/** 相对时间文案（动态行/卡片元信息）。 */
export function relativeTime(ts: number): string {
  const diff = Date.now() - ts
  const m = Math.floor(diff / 60000)
  if (m < 1) return t('time.justNow')
  if (m < 60) return t('time.minutesAgo', { m })
  const h = Math.floor(m / 60)
  if (h < 24) return t('time.hoursAgo', { h })
  const d = Math.floor(h / 24)
  if (d < 30) return t('time.daysAgo', { d })
  return new Date(ts).toLocaleDateString()
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/**
 * 标题关键词高亮为 <mark> HTML。仅转义 & < > 且只注入元素内容（非属性值），
 * 与 dangerouslySetInnerHTML 的使用方式配套；若未来放入属性值需补引号转义。
 */
export function highlight(text: string, query: string): string {
  const q = query.trim()
  if (!q) return escapeHtml(text)
  const idx = text.toLowerCase().indexOf(q.toLowerCase())
  if (idx < 0) return escapeHtml(text)
  return `${escapeHtml(text.slice(0, idx))}<mark>${escapeHtml(text.slice(idx, idx + q.length))}</mark>${escapeHtml(text.slice(idx + q.length))}`
}

/** URL → hostname，解析失败返回空串。 */
export function safeHost(url: string): string {
  try {
    return new URL(url).hostname
  } catch {
    return ''
  }
}

/** URL → hostname，解析失败返回原串（展示兜底）。 */
export function hostOnly(url: string): string {
  try {
    return new URL(url).hostname
  } catch {
    return url
  }
}
