import { describe, expect, it } from 'vitest'
import { collectDupIds, groupHits, sortByPref } from './selectors'
import type { SearchHit } from './protocol'
import type { UIPrefs } from '../types'

const hit = (p: Partial<SearchHit> & { id: string; title: string; url: string }): SearchHit => ({
  sources: ['star'],
  ...p,
})

const prefs: UIPrefs = {
  sort: 'relevance',
  source: 'all',
  groupByDomain: false,
  sourceAware: false,
  showHidden: false,
  letterAvatar: false,
  ctxMenu: {},
}

describe('selectors', () => {
  it('按归一化标题找出重复 id（忽略大小写/空格）', () => {
    const ids = collectDupIds([
      hit({ id: 'a', title: 'Foo Bar', url: 'https://a' }),
      hit({ id: 'b', title: 'foo bar', url: 'https://b' }),
      hit({ id: 'c', title: 'Unique', url: 'https://c' }),
    ])
    expect([...ids].sort()).toEqual(['a', 'b'])
  })

  it('groupByDomain 按域名聚合并按数量降序', () => {
    const g = groupHits(
      [
        hit({ id: 'a', title: 'A', url: 'https://github.com/a' }),
        hit({ id: 'b', title: 'B', url: 'https://github.com/b' }),
        hit({ id: 'c', title: 'C', url: 'https://example.org/c' }),
      ],
      '',
      { ...prefs, groupByDomain: true },
      '',
    )
    expect(g).toHaveLength(2)
    expect(g[0]!.label).toBe('github.com')
    expect(g[0]!.items).toHaveLength(2)
    expect(g[1]!.label).toBe('example.org')
  })

  it('非 relevance 排序走单组排序', () => {
    const g = groupHits(
      [
        hit({ id: 'a', title: 'A', url: 'https://a', createdAt: 100 }),
        hit({ id: 'b', title: 'B', url: 'https://b', createdAt: 200 }),
      ],
      '',
      { ...prefs, sort: 'recent' },
      '',
    )
    expect(g).toHaveLength(1)
    expect(g[0]!.items.map((h) => h.id)).toEqual(['b', 'a'])
  })

  it('relevance 把标题前缀命中归为「精确匹配」', () => {
    const g = groupHits(
      [
        hit({ id: 'a', title: 'React Query', url: 'https://github.com/x/react-query' }),
        hit({ id: 'b', title: 'Something Else', url: 'https://github.com/y/else' }),
      ],
      'react',
      prefs,
      '',
    )
    expect(g[0]!.label).toBe('精确匹配')
    expect(g[0]!.items.map((h) => h.id)).toEqual(['a'])
    expect(g[1]!.label).toBe('相关结果')
  })

  it('sortByPref 语义与 worker 对齐', () => {
    expect(sortByPref({ id: 'a', title: 'A', url: 'u', sources: [] }, { id: 'b', title: 'B', url: 'u', sources: [], stars: 5 }, 'stars')).toBeGreaterThan(0)
  })
})