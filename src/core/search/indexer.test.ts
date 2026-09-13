import { describe, expect, it } from 'vitest'
import { createMiniSearch, docFromItem } from './indexer'
import type { StarItem } from '../types'

function item(over: Partial<StarItem> & { id: string; url: string; title: string }): StarItem {
  return {
    description: '',
    sources: ['star'],
    createdAt: 0,
    updatedAt: 0,
    ...over,
  }
}

describe('createMiniSearch + docFromItem', () => {
  it('支持字段加权匹配与多字段检索', () => {
    const ms = createMiniSearch()
    ms.addAll([
      docFromItem(
        item({
          id: 'a',
          url: 'https://github.com/lucaong/minisearch',
          title: 'lucaong/minisearch',
          description: 'fulltext search engine',
          starMeta: { owner: 'lucaong', repo: 'minisearch', language: 'TypeScript', stars: 6, topics: ['search'], fullName: 'lucaong/minisearch', archived: false, homepage: null, url: 'https://github.com/lucaong/minisearch' },
        }),
      ),
      docFromItem(
        item({
          id: 'b',
          url: 'https://example.com/notes',
          title: '我的搜索笔记',
          description: 'note',
        }),
      ),
    ])

    const hits = ms.search('minisearch', { prefix: true, fuzzy: 0.2 })
    expect(hits.map((h) => h.id)).toContain('a')

    // 中文标题也能命中（按前缀/包含在 title 字段）
    const cn = ms.search('搜索笔记', { prefix: true, fuzzy: 0.2 })
    expect(cn.map((h) => h.id)).toContain('b')
  })

  it('title 权重高于 description', () => {
    const ms = createMiniSearch()
    ms.addAll([
      docFromItem(item({ id: 'game', url: 'https://x.dev/game', title: 'Awesome Game', description: 'the game tons' })),
      docFromItem(item({ id: 'other', url: 'https://y.dev/other', title: 'Other', description: 'game' })),
    ])
    // 两篇都含 game；标题命中者应排更前
    const hits = ms.search('game', { prefix: true, fuzzy: 0.2 })
    expect(hits[0]?.id).toBe('game')
  })
})