import { describe, expect, it } from 'vitest'
import { formatOmniboxEntry, suggestEntries } from './omnibox'
import type { SuggestEntry } from './types'

describe('formatOmniboxEntry（审查 P1-5 回归）', () => {
  it('对 title/url 做 XML 转义（& < >）', () => {
    const e: SuggestEntry = {
      id: '1',
      title: 'vector<int> & C++',
      url: 'https://a.dev/x?a=1&b=2',
      sources: ['star'],
    }
    const out = formatOmniboxEntry(e)
    expect(out).toContain('vector&lt;int&gt; &amp; C++')
    expect(out).toContain('a=1&amp;b=2')
    expect(out).toMatch(/^<url>/)
    expect(out).toContain('<dim>')
  })

  it('无特殊字符保持原样，来源徽标保留', () => {
    const e: SuggestEntry = { id: '1', title: 'React', url: 'https://react.dev', sources: ['star', 'bookmark'] }
    expect(formatOmniboxEntry(e)).toBe('<url>React</url> ⭐ 🔖 <dim>https://react.dev</dim>')
  })
})

describe('suggestEntries', () => {
  const entries: SuggestEntry[] = [
    { id: '1', title: 'React Query', url: 'https://tanstack.com/query', sources: ['star'] },
    { id: '2', title: 'React Router', url: 'https://reactrouter.com', sources: ['bookmark'] },
    { id: '3', title: 'Vue', url: 'https://vuejs.org', sources: ['star'] },
  ]

  it('空查询返回前 max 条', () => {
    expect(suggestEntries('', entries)).toHaveLength(3)
    expect(suggestEntries(undefined, entries, 2)).toHaveLength(2)
  })

  it('标题前缀命中优先于包含命中', () => {
    const out = suggestEntries('react q', entries)
    expect(out[0]?.id).toBe('1')
  })

  it('不相关的条目被过滤', () => {
    const out = suggestEntries('react', entries)
    expect(out.map((e) => e.id)).toEqual(expect.arrayContaining(['1', '2']))
    expect(out).toHaveLength(2)
  })
})
