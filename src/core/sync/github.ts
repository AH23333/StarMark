import { browser } from 'wxt/browser'
import { GitHubApiError, getToken, listStarred, validateToken } from '../api/github'
import { repoToItem } from '../api/mappers'
import { allItems, getSyncState, setSyncState, stripSourceForUrls, upsertItems } from '../db'
import { bumpIndexVersion } from '../version'
import type { GitHubSyncState } from '../types'

export const GH_SYNC_STATE_KEY = 'gh.sync'

const MAX_PAGES = 200 // 上限保护：200 页 = 20,000 个 Star

export interface SyncResult {
  status: 'OK' | 'NO_TOKEN' | 'AUTH_ERROR' | 'RATE_LIMITED' | 'ERROR' | 'NOT_MODIFIED'
  fetched?: number
  removed?: number
  error?: string
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/**
 * GitHub Stars 可恢复同步作业。
 * 每次运行从 syncState 检查点继续；SW 被杀后重启动仍从该 phase 续跑（幂等）。
 * FETCH_PAGES 阶段在内存收集"已见 URL 集合"，供 RECONCILE 精确删除已取消的 Star。
 */
export async function runGitHubSync(force = false): Promise<SyncResult> {
  const token = await getToken()
  if (!token) return { status: 'NO_TOKEN' }

  let checkpoint = await getSyncState<GitHubSyncState>(GH_SYNC_STATE_KEY)
  if (!checkpoint) checkpoint = { phase: 'VALIDATE', page: 0 }

  // 已完成过一轮：转为"增量轮询"——带 etag 从第 1 页重取，命中 304 即结束
  if (checkpoint.phase === 'DONE' || checkpoint.phase === 'TAG_INDEX') {
    checkpoint = { phase: 'FETCH_PAGES', page: 1, etag: checkpoint.etag, lastModified: checkpoint.lastModified }
  }
  if (force) {
    // 强制同步：保留 etag 仍有机会命中 304，仅重跑完整流程
    checkpoint = { phase: 'VALIDATE', page: 0, etag: checkpoint.etag, lastModified: checkpoint.lastModified }
  }
  checkpoint.startedAt = Date.now()
  checkpoint.error = undefined
  await setSyncState(GH_SYNC_STATE_KEY, checkpoint)

  // 该同步运行期内写入的必要信息（不落检查点，SW 被杀后整轮重跑 RECONCILE 亦可安全对齐）
  const seenUrls = new Set<string>()
  let totalFetched = 0

  try {
    // VALIDATE
    if (checkpoint.phase === 'VALIDATE') {
      try {
        const user = await validateToken()
        await browser.storage.local.set({ ghLogin: user.login })
      } catch (e) {
        if (e instanceof GitHubApiError) return { status: 'AUTH_ERROR', error: e.message }
        throw e
      }
      checkpoint.phase = 'FETCH_PAGES'
      await setSyncState(GH_SYNC_STATE_KEY, checkpoint)
    }

    // FETCH_PAGES
    if (checkpoint.phase === 'FETCH_PAGES' || (checkpoint.phase === 'RECONCILE' && seenUrls.size === 0)) {
      let page = checkpoint.page || 1
      let nextPage: number | null = page
      let etag = checkpoint.etag
      let lastModified = checkpoint.lastModified

      while (nextPage !== null) {
        const res = await listStarred(page, { etag, lastModified })
        if (res.notModified) {
          await finish(checkpoint)
          return { status: 'NOT_MODIFIED' }
        }
        for (const repo of res.repos) {
          const item = repoToItem(repo)
          seenUrls.add(item.url)
          totalFetched++
        }
        if (seenUrls.size > 0) {
          await upsertItems(res.repos.map(repoToItem))
        }
        etag = res.etag ?? etag
        lastModified = res.lastModified ?? lastModified
        if (page >= MAX_PAGES) break
        nextPage = res.nextPage
        page = nextPage ?? page

        checkpoint.page = page
        checkpoint.etag = etag
        checkpoint.lastModified = lastModified
        checkpoint.phase = 'FETCH_PAGES'
        await setSyncState(GH_SYNC_STATE_KEY, checkpoint)
        await sleep(0) // 让出 SW 事件循环，避免长循环超过单次事件长期占用
      }
      checkpoint.phase = 'RECONCILE'
      checkpoint.page = 0
      await setSyncState(GH_SYNC_STATE_KEY, checkpoint)
    }

    // RECONCILE：删除已被取消 Star 的记录来源
    if (checkpoint.phase === 'RECONCILE') {
      const removed = await reconcileStars(seenUrls)
      checkpoint.phase = 'TAG_INDEX'
      await setSyncState(GH_SYNC_STATE_KEY, checkpoint)
      await bumpIndexVersion()
      await finish(checkpoint)
      return { status: 'OK', fetched: totalFetched, removed }
    }

    if (checkpoint.phase === 'TAG_INDEX') {
      await bumpIndexVersion()
      await finish(checkpoint)
      return { status: 'OK', fetched: totalFetched }
    }

    await finish(checkpoint)
    return { status: 'OK', fetched: totalFetched }
  } catch (e) {
    const err = e as Error
    // 内存集合丢失时下一轮会从 FETCH_PAGES 重新全量拉取（幂等）
    checkpoint = { ...(await getSyncState<GitHubSyncState>(GH_SYNC_STATE_KEY) ?? { phase: 'FETCH_PAGES', page: 0 }), error: err.message }
    await setSyncState(GH_SYNC_STATE_KEY, checkpoint)
    if (e instanceof GitHubApiError) {
      if (e.status === 401) return { status: 'AUTH_ERROR', error: err.message }
      if (e.status === 403 || e.status === 429) return { status: 'RATE_LIMITED', error: err.message }
    }
    return { status: 'ERROR', error: err.message }
  }
}

async function finish(checkpoint: GitHubSyncState): Promise<void> {
  checkpoint.phase = 'DONE'
  checkpoint.doneAt = Date.now()
  checkpoint.error = undefined
  await setSyncState(GH_SYNC_STATE_KEY, checkpoint)
}

/**
 * 对账：移除 items 中 sources 含 'star'、但本次同步集合之外的记录来源。
 * 满足安全：幂等、可重复执行、不影响同 URL 的书签来源。
 */
export async function reconcileStars(seenUrls: Set<string>): Promise<number> {
  const all = await allItems()
  const orphanUrls: string[] = []
  for (const item of all) {
    if (item.sources.includes('star') && !seenUrls.has(item.url)) {
      orphanUrls.push(item.url)
    }
  }
  await stripSourceForUrls(orphanUrls, 'star')
  return orphanUrls.length
}