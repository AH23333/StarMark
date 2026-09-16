import { browser } from 'wxt/browser'
import { GitHubApiError, getRepo, starRepo } from './api/github'
import { repoToItem } from './api/mappers'
import { db, getByUrl, upsertItems } from './db'
import { hashId, normalizeUrl } from './normalize'
import { bumpIndexVersion } from './version'
import type { StarItem, StarMeta } from './types'

export const COLLECT_FOLDER_TITLE = 'StarMark 收藏'

interface BmTreeNode {
  id: string
  title?: string
  url?: string
  children?: BmTreeNode[]
}

/** 定位（或创建）收藏专用文件夹，返回其 id。 */
export async function ensureCollectFolder(): Promise<string> {
  const tree = (await browser.bookmarks.getTree()) as unknown as BmTreeNode[]
  const bar = tree[0]?.children?.[0]
  if (!bar) throw new Error('书签栏不可用')
  const existing = bar.children?.find((n) => !n.url && n.title === COLLECT_FOLDER_TITLE)
  if (existing?.id) return existing.id
  const created = (await browser.bookmarks.create({ parentId: bar.id, title: COLLECT_FOLDER_TITLE })) as { id: string }
  return created.id
}

/** Star → 书签：创建后由 onCreated 事件链自动合并来源并刷新索引。 */
export async function bookmarkAStarItem(item: { title: string; url: string }): Promise<void> {
  const folderId = await ensureCollectFolder()
  await browser.bookmarks.create({
    parentId: folderId,
    title: item.title || item.url,
    url: item.url,
  })
}

export interface RepoRef {
  owner: string
  repo: string
  full: string
}

/** 从 URL 解析 GitHub 仓库（深链归一到 owner/repo）；非仓库链接返回 null。 */
export function parseRepoFromUrl(url: string): RepoRef | null {
  try {
    const u = new URL(url)
    if (u.hostname.toLowerCase() !== 'github.com') return null
    const parts = u.pathname.split('/').filter(Boolean)
    if (parts.length < 2) return null
    const owner = parts[0]!
    const repo = parts[1]!.replace(/\.git$/, '')
    if (!owner || !repo) return null
    return { owner, repo, full: `${owner}/${repo}` }
  } catch {
    return null
  }
}

/**
 * 书签 → Star：按 id 读全行，调 GitHub API 后乐观合并本地行
 * （sources 加 'star'；无 starMeta 时给最小 stub，下次同步用真实数据覆盖）。
 */
export async function starARepoItem(id: string): Promise<void> {
  const item = await db.items.get(id)
  if (!item) throw new Error('条目不存在')
  const parsed = parseRepoFromUrl(item.url)
  if (!parsed) throw new GitHubApiError(400, '不是 GitHub 仓库链接')
  await starRepo(parsed.owner, parsed.repo)
  if (item.sources.includes('star')) return
  const meta: StarMeta =
    item.starMeta ?? {
      fullName: parsed.full,
      owner: parsed.owner,
      repo: parsed.repo,
      language: null,
      stars: 0,
      topics: [],
      archived: false,
      homepage: null,
      url: item.url,
    }
  await upsertItems([
    {
      ...item,
      sources: [...item.sources, 'star'],
      starredAt: item.starredAt ?? Date.now(),
      starMeta: meta,
      updatedAt: Date.now(),
    },
  ])
  await bumpIndexVersion([item.id])
}

/**
 * 热榜推荐 → Star：加 Star 后拉取仓库详情入库（已有行只合并来源，不覆盖用户字段）。
 * 详情拉取失败不影响 Star 本身成功。
 */
export async function starTrendingRepo(fullName: string): Promise<void> {
  const parts = fullName.split('/')
  const owner = parts[0]
  const repo = parts[1]
  if (!owner || !repo) throw new GitHubApiError(400, '非法仓库名')
  await starRepo(owner, repo)
  try {
    const ghRepo = await getRepo(owner, repo)
    const fresh = repoToItem(ghRepo)
    const existing = await getByUrl(fresh.url)
    const sources = existing
      ? (Array.from(new Set([...existing.sources, 'star' as const])) as StarItem['sources'])
      : (['star'] as StarItem['sources'])
    await upsertItems([{ ...fresh, sources }])
    await bumpIndexVersion([existing?.id ?? fresh.id])
  } catch {
    // 详情入库失败不影响 Star
  }
}
