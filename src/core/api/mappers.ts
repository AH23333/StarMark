import { faviconFor, hashId, normalizeUrl } from '../normalize'
import type { StarItem, StarMeta } from '../types'

/** GET /user/starred 的单条响应（Accept: application/vnd.github.star+json） */
export interface GitHubRepo {
  id: number
  full_name: string
  html_url: string
  description: string | null
  language: string | null
  stargazers_count: number
  topics?: string[]
  archived?: boolean
  homepage: string | null
  fork?: boolean
  starred_at?: string
}

/** 仓库响应 → 本地条目（纯函数，Star 来源） */
export function repoToItem(repo: GitHubRepo): StarItem {
  const url = normalizeUrl(repo.html_url)
  const id = hashId(url)
  const fullNameParts = repo.full_name.split('/')
  const starMeta: StarMeta = {
    fullName: repo.full_name,
    owner: fullNameParts[0] ?? '',
    repo: fullNameParts[1] ?? '',
    language: repo.language,
    stars: repo.stargazers_count,
    topics: repo.topics ?? [],
    archived: repo.archived ?? false,
    homepage: repo.homepage,
    url: repo.html_url,
  }
  return {
    id,
    url,
    title: repo.full_name,
    description: repo.description ?? '',
    sources: ['star'],
    starredAt: repo.starred_at ? Date.parse(repo.starred_at) : undefined,
    starMeta,
    faviconUrl: faviconFor(url),
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }
}