import type { StarItem } from './types'

/**
 * 导出模块：把本地条目导出为 Markdown / HTML（浏览器书签格式）/ CSV。
 * 纯函数、无副作用，便于单测；调用方负责触发下载。
 */

export type ExportFormat = 'markdown' | 'html' | 'csv'

export interface ExportOptions {
  /** 导出范围；null/undefined = 全部 */
  ids?: string[] | null
  /** 附加到文件名末尾的后缀（如 'star'） */
  scopeLabel?: string
}

/* ---------- 工具 ---------- */

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/** Markdown 文本转义：只处理会破坏标题/链接语法的字符，避免过度转义（如 repo-a 变 repo\-a） */
function escapeMdText(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/([\[\]<`])/g, '\\$1').replace(/\r?\n/g, ' ')
}

/** RFC 4180 CSV 字段转义：含逗号/引号/换行时用双引号包裹，内部引号翻倍 */
function csvCell(s: string): string {
  const v = (s ?? '').toString()
  if (/[",\r\n]/.test(v)) return `"${v.replace(/"/g, '""')}"`
  return v
}

function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

function ymd(ts: number | undefined): string {
  if (!ts) return ''
  const d = new Date(ts)
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname
  } catch {
    return ''
  }
}

/** 按 starredAt/bookmarkedAt/createdAt 取最近时间，降序 */
function byLatestDesc(a: StarItem, b: StarItem): number {
  const ta = Math.max(a.starredAt ?? 0, a.bookmarkedAt ?? 0, a.createdAt ?? 0)
  const tb = Math.max(b.starredAt ?? 0, b.bookmarkedAt ?? 0, b.createdAt ?? 0)
  return tb - ta
}

/* ---------- Markdown（Obsidian frontmatter 风格） ---------- */

function itemToMdLink(item: StarItem): string {
  // 中括号会破坏 []() 链接语法，成对转义
  const title = (item.title || item.url).replace(/\[/g, '\\[').replace(/\]/g, '\\]')
  return `- [${title}](${item.url})`
}

function itemToMdSection(item: StarItem, idx: number): string {
  const lines: string[] = []
  const title = item.title || item.url
  lines.push(`## ${idx + 1}. ${escapeMdText(title)}`)
  lines.push('')
  lines.push('```yaml')
  lines.push(`url: ${item.url}`)
  if (item.starredAt) lines.push(`starred_at: ${ymd(item.starredAt)}`)
  if (item.bookmarkedAt) lines.push(`bookmarked_at: ${ymd(item.bookmarkedAt)}`)
  if (item.tags?.length) lines.push(`tags: [${item.tags.join(', ')}]`)
  const folders = item.bookmarkMeta?.folderPaths ?? []
  if (folders.length) lines.push(`folders: [${folders.join(' / ')}]`)
  lines.push('```')
  lines.push('')
  if (item.description) {
    lines.push(item.description)
    lines.push('')
  }
  if (item.notes) {
    lines.push(`> ${escapeMdText(item.notes).replace(/\n/g, '\n> ')}`)
    lines.push('')
  }
  lines.push(itemToMdLink(item))
  lines.push('')
  return lines.join('\n')
}

export function exportMarkdown(items: StarItem[], now = Date.now()): string {
  const sorted = [...items].sort(byLatestDesc)
  const parts: string[] = []
  parts.push('# StarMark Export')
  parts.push('')
  parts.push(`> Exported: ${new Date(now).toISOString()}`)
  parts.push(`> Items: ${sorted.length}`)
  parts.push('')
  // 速览清单（可折叠）
  parts.push('## Index')
  parts.push('')
  parts.push('<details>')
  parts.push('')
  for (const it of sorted) parts.push(itemToMdLink(it))
  parts.push('')
  parts.push('</details>')
  parts.push('')
  for (let i = 0; i < sorted.length; i++) parts.push(itemToMdSection(sorted[i]!, i))
  return parts.join('\n')
}

/* ---------- HTML（Netscape Bookmark File，可直接导入浏览器） ---------- */

const ADD_DATE_FALLBACK = 0

export function exportBookmarkHtml(items: StarItem[], now = Date.now()): string {
  const sorted = [...items].sort(byLatestDesc)
  const out: string[] = []
  out.push('<!DOCTYPE NETSCAPE-Bookmark-file-1>')
  out.push('<!-- This is an automatically generated file. It will be read and overwritten. DO NOT EDIT! -->')
  out.push('<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">')
  out.push('<TITLE>Bookmarks</TITLE>')
  out.push('<H1>Bookmarks</H1>')
  out.push('<DL><p>')
  out.push(`    <DT><H3 ADD_DATE="${Math.floor(now / 1000)}" LAST_MODIFIED="${Math.floor(now / 1000)}">StarMark Export</H3>`)
  out.push('    <DL><p>')

  for (const item of sorted) {
    const addDate = Math.floor(
      Math.max(item.starredAt ?? 0, item.bookmarkedAt ?? 0, item.createdAt ?? 0, ADD_DATE_FALLBACK) / 1000,
    )
    const title = escapeHtml(item.title || item.url)
    const tagAttr = item.tags?.length ? ` TAGS="${escapeHtml(item.tags.join(','))}"` : ''
    out.push(`        <DT><A HREF="${escapeHtml(item.url)}" ADD_DATE="${addDate}"${tagAttr}>${title}</A>`)
    if (item.notes) out.push(`        <DD>${escapeHtml(item.notes)}`)
  }

  out.push('    </DL><p>')
  out.push('</DL><p>')
  return out.join('\n')
}

/* ---------- CSV ---------- */

export const CSV_HEADERS = [
  'title',
  'url',
  'sources',
  'stars',
  'language',
  'tags',
  'folders',
  'starred_at',
  'bookmarked_at',
  'created_at',
  'notes',
] as const

export function exportCsv(items: StarItem[], now = Date.now()): string {
  void now
  const sorted = [...items].sort(byLatestDesc)
  const rows: string[] = [CSV_HEADERS.join(',')]
  for (const item of sorted) {
    rows.push(
      [
        item.title || item.url,
        item.url,
        item.sources.join('|'),
        String(item.starMeta?.stars ?? ''),
        item.starMeta?.language ?? '',
        (item.tags ?? []).join(' '),
        (item.bookmarkMeta?.folderPaths ?? []).join(' / '),
        ymd(item.starredAt),
        ymd(item.bookmarkedAt),
        ymd(item.createdAt),
        item.notes ?? '',
      ]
        .map(csvCell)
        .join(','),
    )
  }
  // CRLF 提高各表格软件兼容性
  return rows.join('\r\n') + '\r\n'
}

/* ---------- 统一入口 ---------- */

export function buildExport(format: ExportFormat, items: StarItem[], now = Date.now()): { content: string; mime: string; ext: string } {
  switch (format) {
    case 'markdown':
      return { content: exportMarkdown(items, now), mime: 'text/markdown', ext: 'md' }
    case 'html':
      return { content: exportBookmarkHtml(items, now), mime: 'text/html', ext: 'html' }
    case 'csv':
      return { content: exportCsv(items, now), mime: 'text/csv', ext: 'csv' }
  }
}

export function exportFilename(format: ExportFormat, scopeLabel?: string): string {
  const stamp = new Date()
  const y = stamp.getFullYear()
  const m = pad2(stamp.getMonth() + 1)
  const d = pad2(stamp.getDate())
  const scope = scopeLabel ? `-${scopeLabel}` : ''
  const ext = format === 'markdown' ? 'md' : format
  return `starmark-export${scope}-${y}${m}${d}.${ext}`
}
