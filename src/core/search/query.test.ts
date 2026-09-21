import { describe, expect, it } from 'vitest'
import { browseItems, literalFallback, enrichHits, itemToHit, buildFolderNodeTree } from './query'
import type { SearchHit } from './protocol'
import type { StarItem } from '../types'

function item(over: Partial<StarItem> & { id: string; url: string }): StarItem {
  return {
    title: over.id,
    description: '',
    sources: ['star'],
    createdAt: 1000,
    updatedAt: 1000,
    ...over,
  }
}

const items: StarItem[] = [
  item({ id: 'a', url: 'https://github.com/foo/bar', title: 'Foo Bar', tags: ['dev'], starMeta: { language: 'TypeScript', stars: 100 } as StarItem['starMeta'] }),
  item({ id: 'b', url: 'https://example.com/docs', title: 'Docs', sources: ['bookmark'], tags: ['read'], bookmarkMeta: { folderPaths: ['书签栏'], folderIds: ['f1'] } }),
  item({ id: 'c', url: 'https://hidden.dev/x', title: 'Hidden', hidden: true }),
  item({ id: 'd', url: 'https://github.com/two/words', title: 'Two Words', tags: ['dev', 'read'] }),
]

describe('browseItems（浏览模式纯函数）', () => {
  it('默认列出全部非隐藏条目并按 createdAt 降序（稳定排序保持同分原序）', () => {
    const r = browseItems(items, { max: 10 })
    expect(r.total).toBe(3)
    expect(r.hits.map((h) => h.id)).toEqual(['a', 'b', 'd'])
  })

  it('来源过滤：star 只留 Star，bookmark 只留书签', () => {
    expect(browseItems(items, { max: 10, source: 'star' }).total).toBe(2)
    expect(browseItems(items, { max: 10, source: 'bookmark' }).hits.map((h) => h.id)).toEqual(['b'])
  })

  it('隐藏条目默认不出，includeHidden 放行', () => {
    expect(browseItems(items, { max: 10 }).total).toBe(3)
    expect(browseItems(items, { max: 10, includeHidden: true }).total).toBe(4)
  })

  it('标签 AND 限定与截断', () => {
    expect(browseItems(items, { max: 10, tags: ['dev'] }).hits.map((h) => h.id)).toEqual(['a', 'd'])
    expect(browseItems(items, { max: 10, tags: ['dev', 'read'] }).hits.map((h) => h.id)).toEqual(['d'])
    const r = browseItems(items, { max: 2 })
    expect(r.total).toBe(3)
    expect(r.hits).toHaveLength(2)
  })
})

describe('literalFallback（字面兜底）', () => {
  it('seen 中的条目被跳过（MiniSearch 已命中的不重复收集）', () => {
    const out: SearchHit[] = []
    const seen = new Set(['a'])
    literalFallback(items, 'bar', { max: 10 }, seen, out)
    expect(out.map((h) => h.id)).toEqual([]) // 'a' 的 url 含 bar 但已在 seen
  })

  it('needle 匹配 title 或 url，隐藏与来源过滤生效', () => {
    const out: SearchHit[] = []
    literalFallback(items, 'docs', { max: 10 }, new Set(), out)
    expect(out.map((h) => h.id)).toEqual(['b'])

    const out2: SearchHit[] = []
    literalFallback(items, 'hidden', { max: 10 }, new Set(), out2)
    expect(out2).toEqual([])

    const out3: SearchHit[] = []
    literalFallback(items, 'hidden', { max: 10, includeHidden: true }, new Set(), out3)
    expect(out3.map((h) => h.id)).toEqual(['c'])
  })
})

describe('needle + tags 叠加（"过滤结果内二次搜索"设计语义）', () => {
  // 用户设计：标签区选标签 → 浏览视图看过滤结果 → 搜索框继续输入 → 在过滤结果内二次搜索。
  // worker 的 doSearch 同传 needle + tags，两者叠加（query.ts 的谓词链）——本组测试锚定该语义。
  it('浏览模式叠加：tags 过滤 + 文本搜索栏独立输入时仍按标签过滤（空查询）', () => {
    const r = browseItems(items, { max: 10, tags: ['dev'] })
    expect(r.hits.map((h) => h.id)).toEqual(['a', 'd'])
  })

  it('搜索叠加：needle 命中且满足标签过滤的条目才返回', () => {
    const out: SearchHit[] = []
    const seen = new Set<string>()
    literalFallback(items, 'foo', { max: 10, tags: ['dev'] }, seen, out)
    // 'a'：url 含 foo 且带 dev ✓；'d'：url 不含 foo ✗
    expect(out.map((h) => h.id)).toEqual(['a'])

    const out2: SearchHit[] = []
    literalFallback(items, 'words', { max: 10, tags: ['dev'] }, seen, out2)
    expect(out2.map((h) => h.id)).toEqual(['d'])
  })

  it('needle 命中但不满足标签过滤 → 不返回（叠加是 AND 语义）', () => {
    const out: SearchHit[] = []
    literalFallback(items, 'docs', { max: 10, tags: ['dev'] }, new Set(), out)
    expect(out).toEqual([]) // 'b' 命中 docs 但只有 read 标签
  })
})

describe('enrichHits / itemToHit', () => {
  it('从完整条目回填 description/notes', () => {
    const hit = itemToHit(items[0]!)
    const full = new Map([['a', item({ id: 'a', url: 'https://github.com/foo/bar', title: 'Foo Bar', description: 'desc here', notes: 'note here' })]])
    enrichHits([hit], full)
    expect(hit.description).toBe('desc here')
    expect(hit.notes).toBe('note here')
  })

  it('空 Map 静默跳过', () => {
    const hit = itemToHit(items[0]!)
    enrichHits([hit], new Map())
    expect(hit.description).toBe('')
  })
})

describe('buildFolderNodeTree（收藏夹树构建，标签限定与浏览模式同语义）', () => {
  it('无标签：Star 与书签全部非隐藏条目入树（隐藏条目排除）', () => {
    const tree = buildFolderNodeTree(items)
    const stars = tree.find((n) => n.kind === 'stars')
    expect(stars?.items.map((h) => h.id).sort()).toEqual(['a', 'd'])
    const bm = tree.find((n) => n.name === '书签栏')
    expect(bm?.count).toBe(1)
    expect(bm?.items.map((h) => h.id)).toEqual(['b'])
    const all = tree.flatMap((n) => n.items.map((h) => h.id))
    expect(all).not.toContain('c') // 隐藏条目不出现在树中
  })

  it('标签 AND 限定：树只保留匹配条目（Star 与书签文件夹同受约束）', () => {
    const tree = buildFolderNodeTree(items, ['dev'])
    const stars = tree.find((n) => n.kind === 'stars')
    expect(stars?.items.map((h) => h.id).sort()).toEqual(['a', 'd'])
    expect(tree.find((n) => n.name === '书签栏')).toBeUndefined() // 'b' 仅带 read，被过滤
  })

  it('多标签叠加过滤 + 全部标签移除后回落全量', () => {
    const tree = buildFolderNodeTree(items, ['dev', 'read'])
    expect(tree.find((n) => n.kind === 'stars')?.items.map((h) => h.id)).toEqual(['d'])
    expect(buildFolderNodeTree(items, []).flatMap((n) => n.items.map((h) => h.id)).sort()).toEqual(['a', 'b', 'd'])
  })
})
