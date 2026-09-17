import { describe, expect, it } from 'vitest'
import { repoToItem, type GitHubRepo } from './mappers'

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
    expect(item.id).toMatch(/^[0-9a-f]{32}$/)
    expect(item.url).toBe('https://github.com/lucaong/minisearch')
    expect(item.title).toBe('lucaong/minisearch')
    expect(item.sources).toEqual(['star'])
    expect(item.starredAt).toBe(Date.parse('2026-01-02T03:04:05Z'))
    expect(item.starMeta?.owner).toBe('lucaong')
    expect(item.starMeta?.repo).toBe('minisearch')
    expect(item.starMeta?.topics).toContain('search')
  })
})
