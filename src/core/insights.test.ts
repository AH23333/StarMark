import { describe, expect, it } from 'vitest'
import { buildHealthReport, findDuplicates, languageDistribution, trendSeries, type TFunc } from './insights'
import type { StarItem } from './types'

const tx: TFunc = (k, vars) => {
  const zh: Record<string, string> = {
    'health.dup': '疑似重复',
    'health.dupValue': '{n} 组（扣{p}分）',
    'health.dupNone': '无',
    'health.untagged': '未打标签',
    'health.untaggedValue': '{n} 条（{pct}%，扣{p}分）',
    'health.untaggedOk': '{n} 条',
    'health.stale': '长期未整理',
    'health.staleOk': '{n} 条',
    'health.staleValue': '{n} 条（扣{p}分）',
    'health.domains': '覆盖域名',
    'health.domainsValue': '{n} 个',
    'health.tags': '标签使用',
    'health.tagsNone': '未使用',
    'health.tagsValue': '{t}×{c}',
  }
  let s = zh[k] ?? k
  if (vars) for (const [kk, v] of Object.entries(vars)) s = s.replace(`{${kk}}`, String(v))
  return s
}

function mk(id: string, over: Partial<StarItem> & { language?: string } = {}): StarItem {
  const url = over.url ?? `https://example.com/${id}`
  return {
    id,
    url,
    title: over.title ?? `Title ${id}`,
    description: '',
    sources: over.sources ?? ['star'],
    starMeta: over.language
      ? { fullName: `a/${id}`, owner: 'a', repo: id, language: over.language, stars: 5, topics: [], archived: false, homepage: null, url }
      : undefined,
    starredAt: over.starredAt,
    createdAt: over.createdAt ?? 1_700_000_000_000,
    updatedAt: Date.now(),
    tags: over.tags,
    hidden: over.hidden,
  }
}

describe('findDuplicates（按 URL 归一化判重）', () => {
  it('同 URL 变体（http/https、www）组成重复组', () => {
    const items = [
      mk('1', { title: 'React', url: 'https://github.com/foo/bar' }),
      mk('2', { title: 'react', url: 'http://www.github.com/foo/bar' }),
      mk('3', { title: 'Vue', url: 'https://github.com/vuejs/vue' }),
    ]
    const groups = findDuplicates(items)
    expect(groups).toHaveLength(1)
    expect(groups[0]!.count).toBe(2)
    expect(groups[0]!.urls).toHaveLength(2)
  })

  it('同标题不同 URL 不算重复（旧版按标题误报的回归）', () => {
    expect(
      findDuplicates([
        mk('1', { title: 'React', url: 'https://github.com/foo/bar' }),
        mk('2', { title: 'React', url: 'https://example.com/react' }),
      ]),
    ).toHaveLength(0)
  })

  it('无重复则返回空', () => {
    expect(findDuplicates([mk('1', { title: 'A', url: 'https://a.dev/' }), mk('2', { title: 'B', url: 'https://b.dev/' })])).toHaveLength(0)
  })
})

describe('languageDistribution', () => {
  it('按语言统计', () => {
    const items = [mk('1', { language: 'TypeScript' }), mk('2', { language: 'TypeScript' }), mk('3', { language: 'Go' }), mk('4', { language: 'Rust' })]
    const dist = languageDistribution(items)
    expect(dist[0]).toEqual({ language: 'TypeScript', count: 2 })
    expect(dist).toHaveLength(3)
  })

  it('无 Star 元信息的条目不计入', () => {
    expect(languageDistribution([mk('1')])).toHaveLength(0)
  })
})

describe('trendSeries', () => {
  it('按天聚合新增', () => {
    const base = Date.now()
    const sameDay = [mk('1', { starredAt: base }), mk('2', { starredAt: base - 1000 }), mk('3', { starredAt: base - 90 * 86400_000 })]
    const series = trendSeries(sameDay, 14)
    expect(series).toHaveLength(14)
    expect(series[13]!.added).toBe(2) // 今日 + 前一秒
    const total = series.reduce((s, d) => s + d.added, 0)
    expect(total).toBe(2) // 90 天前超出窗口不计
  })
})

describe('buildHealthReport', () => {
  it('空数据得 0 分', () => {
    const r = buildHealthReport([], 14, tx)
    expect(r.score).toBe(0)
  })

  it('识别重复并扣分', () => {
    const items = [
      mk('1', { title: 'Dup', tags: ['x'], createdAt: Date.now(), url: 'https://github.com/foo/bar' }),
      mk('2', { title: 'dup', tags: ['y'], createdAt: Date.now() - 1000, url: 'http://www.github.com/foo/bar' }),
    ]
    const r = buildHealthReport(items, 14, tx)
    expect(r.duplicates).toHaveLength(1)
    expect(r.score).toBeLessThan(100)
    expect(r.factors.some((f) => f.label === '疑似重复' && !f.ok)).toBe(true)
  })

  it('统计隐藏与未打标签', () => {
    const r = buildHealthReport([mk('1', { hidden: true }), mk('2')], 14, tx)
    expect(r.hiddenCount).toBe(1)
    expect(r.untagged).toBe(2)
  })
})