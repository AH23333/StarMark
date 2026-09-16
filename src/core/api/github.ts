import { browser } from 'wxt/browser'
import type { GitHubRepo } from './mappers'

const API_BASE = 'https://api.github.com'

export class GitHubApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public retryAfterMs?: number,
  ) {
    super(message)
    this.name = 'GitHubApiError'
  }
}

export async function getToken(): Promise<string> {
  const s = await browser.storage.local.get('pat')
  return (s.pat as string | undefined) ?? ''
}

export interface GitHubUser {
  login: string
  avatar_url?: string
}

async function githubFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = await getToken()
  if (!token) throw new GitHubApiError(401, '未配置 Token')

  const headers = new Headers(init.headers)
  headers.set('Accept', 'application/vnd.github+json')
  headers.set('Authorization', `Bearer ${token}`)
  headers.set('X-GitHub-Api-Version', '2022-11-28')

  const res = await fetch(`${API_BASE}${path}`, { ...init, headers })

  if (res.status === 401) throw new GitHubApiError(401, 'Token 无效，请重新配置')
  if (res.status === 403) {
    const retryAfter = res.headers.get('Retry-After')
    throw new GitHubApiError(403, '权限不足或已限流', retryAfter ? Number(retryAfter) * 1000 : undefined)
  }
  if (res.status === 429) {
    throw new GitHubApiError(429, 'GitHub 速率限制，请稍后重试')
  }
  if (res.status === 404) throw new GitHubApiError(404, '资源不存在')
  if (!res.ok) throw new GitHubApiError(res.status, `GitHub API 错误 (${res.status})`)
  return (await res.json()) as T
}

export interface StarredPage {
  repos: GitHubRepo[]
  nextPage: number | null
  etag?: string
  lastModified?: string
  notModified: boolean
}

/**
 * 拉取一页 starred。携带 If-None-Match 时可能返回 notModified(304)。
 * 分页不依赖 Link 头（跨域下可能读不到），改用"满页即可能还有更多"的长度启发式，
 * 下一页为空数组时自然停止，兼容总数为整百的场景。
 */
export async function listStarred(
  page = 1,
  opts: { etag?: string; lastModified?: string; perPage?: number } = {},
): Promise<StarredPage> {
  const perPage = opts.perPage ?? 100
  const query = new URLSearchParams({ per_page: String(perPage), page: String(page), sort: 'created', direction: 'desc' })

  const headers = new Headers()
  headers.set('Accept', 'application/vnd.github.star+json')
  if (opts.etag) headers.set('If-None-Match', opts.etag)
  if (opts.lastModified) headers.set('If-Modified-Since', opts.lastModified)

  const token = await getToken()
  if (token) headers.set('Authorization', `Bearer ${token}`)

  const res = await fetch(`${API_BASE}/user/starred?${query.toString()}`, { headers })

  if (res.status === 304) {
    return { repos: [], nextPage: null, notModified: true }
  }
  if (res.status === 401) throw new GitHubApiError(401, 'Token 无效，请重新配置')
  if (res.status === 403) {
    const retryAfter = res.headers.get('Retry-After')
    throw new GitHubApiError(403, '权限不足或已限流', retryAfter ? Number(retryAfter) * 1000 : undefined)
  }
  if (res.status === 429) throw new GitHubApiError(429, 'GitHub 速率限制，请稍后重试')
  if (!res.ok) throw new GitHubApiError(res.status, `GitHub API 错误 (${res.status})`)

  const entries = (await res.json()) as Array<{ starred_at?: string; repo: GitHubRepo }>
  // Accept: star+json 返回 `{starred_at, repo}` 包装结构，解包为扁平仓库并补回 starred_at
  const repos = entries.map((e) => ({ ...e.repo, starred_at: e.starred_at ?? e.repo.starred_at }))

  const isFull = repos.length >= perPage
  const nextPage = isFull ? page + 1 : null

  return {
    repos,
    nextPage,
    etag: res.headers.get('ETag') ?? undefined,
    lastModified: res.headers.get('Last-Modified') ?? undefined,
    notModified: false,
  }
}

export async function validateToken(): Promise<GitHubUser> {
  return githubFetch<GitHubUser>('/user')
}

/**
 * 给仓库加 Star（PUT /user/starred/{owner}/{repo}）。
 * 需要 Token 具备 Starring: Write 权限；成功返回 204（无 body，不能用通用 githubFetch 的 json 解析）。
 */
export async function starRepo(owner: string, repo: string): Promise<void> {
  const token = await getToken()
  if (!token) throw new GitHubApiError(401, '未配置 Token')

  const headers = new Headers()
  headers.set('Accept', 'application/vnd.github+json')
  headers.set('Authorization', `Bearer ${token}`)
  headers.set('X-GitHub-Api-Version', '2022-11-28')

  const res = await fetch(`${API_BASE}/user/starred/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`, {
    method: 'PUT',
    headers,
  })
  if (res.status === 204) return
  if (res.status === 401) throw new GitHubApiError(401, 'Token 无效，请重新配置')
  if (res.status === 403) throw new GitHubApiError(403, '需要 Starring: Write 权限（或已限流）')
  if (res.status === 404) throw new GitHubApiError(404, '仓库不存在')
  if (!res.ok) throw new GitHubApiError(res.status, `GitHub API 错误 (${res.status})`)
}