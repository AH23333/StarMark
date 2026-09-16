import { describe, expect, it } from 'vitest'
import { exportBookmarkHtml, exportCsv, exportMarkdown, buildExport, exportFilename, CSV_HEADERS } from './export'
import type { StarItem } from './types'

function item(overrides: Partial<StarItem> = {}): StarItem {
  return {
    id: 'a1',
    url: 'https://github.com/o/a',
    title: 'repo-a',
    description: 'desc',
    sources: ['star'],
    starredAt: Date.UTC(2026, 0, 2),
    starMeta: {
      fullName: 'o/a',
      owner: 'o',
      repo: 'a',
      language: 'TypeScript',
      stars: 42,
      topics: [],
      archived: false,
      homepage: null,
      url: 'https://github.com/o/a',
    },
    createdAt: 1000,
    updatedAt: 1000,
    ...overrides,
  }
}

describe('exportMarkdown', () => {
  it('包含标题、YAML块、链接与备注', () => {
    const md = exportMarkdown([
      item({ tags: ['x', 'y'], notes: '重要：常用工具' }),
    ])
    expect(md).toContain('# StarMark Export')
    expect(md).toContain('## 1. repo-a')
    expect(md).toContain('url: https://github.com/o/a')
    expect(md).toContain('tags: [x, y]')
    expect(md).toContain('> 重要：常用工具')
    expect(md).toContain('- [repo-a](https://github.com/o/a)')
  })

  it('标题中的方括号会转义，避免破坏链接语法', () => {
    const md = exportMarkdown([item({ title: '[Brackets] repo' })])
    expect(md).toContain('\\[Brackets\\] repo')
  })
})

describe('exportBookmarkHtml', () => {
  it('输出 NETSCAPE 格式且 URL/标题被转义', () => {
    const html = exportBookmarkHtml([
      item({ title: 'A & B <script>', tags: ['news'] }),
    ])
    expect(html).toContain('<!DOCTYPE NETSCAPE-Bookmark-file-1>')
    expect(html).toContain('A &amp; B &lt;script&gt;')
    expect(html).toContain('TAGS="news"')
    expect(html).toContain('HREF="https://github.com/o/a"')
  })
})

describe('exportCsv', () => {
  it('表头正确、特殊字符被引号包裹', () => {
    const csv = exportCsv([
      item({ title: 'has, comma', notes: 'line1\nline2 "quoted"' }),
    ])
    const header = csv.split('\r\n')[0]
    expect(header).toBe(CSV_HEADERS.join(','))
    expect(csv).toContain('"has, comma"')
    expect(csv).toContain('"line1\nline2 ""quoted"""')
  })
})

describe('buildExport / exportFilename', () => {
  it('按格式返回 mime 与扩展名', () => {
    const items = [item()]
    expect(buildExport('markdown', items).mime).toBe('text/markdown')
    expect(buildExport('html', items).mime).toBe('text/html')
    expect(buildExport('csv', items).mime).toBe('text/csv')
    expect(exportFilename('markdown')).toMatch(/^starmark-export-\d{8}\.md$/)
    expect(exportFilename('csv', 'selection')).toMatch(/^starmark-export-selection-\d{8}\.csv$/)
  })
})
