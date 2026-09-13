import { describe, expect, it } from 'vitest'
import { mergedWithBookmark, repoToItem, type GitHubRepo } from './mappers'
import type { StarItem } from '../types'

const repo: GitHubRepo = {
  id: 1,
  full_name: 'lucaong/minisearch',
  html_url: 'https://github.com/lucaong/minisearch',
  description: 'Tiny fulltext search engine.',
  language: 'TypeScript',
  stargazers_count: 6125,
  topics: ['search', 'full-text-search'],
  archived: false,
  homepage: null,
  fork: false,
  starred_at: '2026-01-02T03:04:05Z',
}

describe('repoToItem', () => {
  it('映射为统一的本地条目', () => {
    const item = repoToItem(repo)
    expect(item.id).toMatch(/^[0-9a-f]{8}$/)
    expect(item.url).toBe('https://github.com/lucaong/minisearch')
    expect(item.title).toBe('lucaong/minisearch')
    expect(item.sources).toEqual(['star'])
    expect(item.starredAt).toBe(Date.parse('2026-01-02T03:04:05Z'))
    expect(item.starMeta?.owner).toBe('lucaong')
    expect(item.starMeta?.repo).toBe('minisearch')
    expect(item.starMeta?.topics).toContain('search')
  })
})

describe('mergedWithBookmark', () => {
  it('同一 URL 的书签并入 Star 行', () => {
    const star = repoToItem(repo)
    const bookmark: Pick<StarItem, 'title' | 'bookmarkMeta' | 'bookmarkedAt'> = {
      title: 'MiniSearch（书签）',
      bookmarkMeta: { folderPaths: ['开发', '搜索'], folderIds: ['2'] },
      bookmarkedAt: 1700000000000,
    }
    const merged = mergedWithBookmark(star, bookmark)
    expect(merged.sources).toContain('bookmark')
    expect(merged.sources).toContain('star')
    expect(merged.bookmarkMeta?.folderPaths[1]).toBe('搜索')
  })

  it('已含书签来源时不重复追加', () => {
    const star = repoToItem(repo)
    const withBm = mergedWithBookmark(star, {
      title: 'x',
      bookmarkMeta: { folderPaths: ['f'], folderIds: ['1'] },
      bookmarkedAt: 1,
    })
    const again = mergedWithBookmark(withBm, {
      title: 'x',
      bookmarkMeta: { folderPaths: ['f'], folderIds: ['1'] },
      bookmarkedAt: 1,
    })
    expect(again.sources.filter((s) => s === 'bookmark')).toHaveLength(1)
  })
})