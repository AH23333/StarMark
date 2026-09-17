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

const tx = (key: string, vars?: Record<string, string | number>): string =>
  vars ? `${key}:${Object.values(vars).join(',')}` : key

describe('selectors', () => {
  it('按归一化 URL 找出重复 id（同内容不同 URL 变体；同标题不同 URL 不算）', () => {
    const ids = collectDupIds([
      hit({ id: 'a', title: 'Foo Bar', url: 'https://github.com/foo/bar' }),
      hit({ id: 'b', title: 'foo bar', url: 'http://www.github.com/foo/bar' }), // 同内容变体
      hit({ id: 'c', title: 'Unique', url: 'https://github.com/unique/repo' }),
    ])
    expect([...ids].sort()).toEqual(['a', 'b'])
  })

  it('同标题不同 URL 不误报（旧版按标题判重的回归）', () => {
    const ids = collectDupIds([
      hit({ id: 'a', title: 'React', url: 'https://github.com/foo/bar' }),
      hit({ id: 'b', title: 'React', url: 'https://example.com/react' }),
    ])
    expect([...ids]).toEqual([])
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
      tx,
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
      tx,
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
      tx,
    )
    expect(g[0]!.label).toBe('results.exact')
    expect(g[0]!.items.map((h) => h.id)).toEqual(['a'])
    expect(g[1]!.label).toBe('results.related')
  })

  it('sortByPref 语义与 worker 对齐', () => {
    expect(sortByPref({ title: 'A' }, { title: 'B', stars: 5 }, 'stars')).toBeGreaterThan(0)
    expect(sortByPref({ title: 'A', createdAt: 100 }, { title: 'B', createdAt: 200 }, 'recent')).toBeGreaterThan(0)
  })
})