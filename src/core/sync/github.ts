import { browser } from 'wxt/browser'
import { GitHubApiError, getToken, listStarred, validateToken, type StarredPage } from '../api/github'
import { repoToItem } from '../api/mappers'
import { allItems, getSyncState, setSyncState, stripSourceForUrls, upsertItems } from '../db'
import { bumpIndexVersion } from '../version'
import { logActivity } from '../activity'
import { applyRulesToAll } from '../rules'
import type { GitHubSyncState, StarItem } from '../types'

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
  const sessionChangedIds = new Set<string>()
  let totalFetched = 0
  // FETCH_PAGES 里加载的全量条目：RECONCILE 对账复用，避免一次运行内两次全表扫描（性能优化）
  let knownItems: StarItem[] | null = null

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
      // 增量指纹只认第 1 页的表示（审查 P1-2）：ETag/Last-Modified 是"每页表示"的指纹，
      // 旧实现循环内滚动保存最后一页的 etag、下一轮把它用在 page=1 上必然 200 →
      // 每个 6h 周期任务都退化为全量爬取。新 Star 只会出现在第一页（sort=created desc），
      // 因此仅在 page=1 携带 If-None-Match/If-Modified-Since，命中 304 直接结束；后续页不带条件头。
      let firstPageEtag = checkpoint.etag
      let firstPageLastModified = checkpoint.lastModified
      // 已有 Star 集合：识别本轮新增并记入动态（全量条目同时供 RECONCILE 复用）
      knownItems = await allItems()
      const existingStarUrls = new Set(
        knownItems.filter((i) => i.sources.includes('star')).map((i) => i.url),
      )

      while (nextPage !== null) {
        const cond = page === 1 ? { etag: firstPageEtag, lastModified: firstPageLastModified } : {}
        let res: StarredPage
        try {
          res = await listStarred(page, cond)
        } catch (e) {
          // 403/429 且带 Retry-After 时退避重试一次（审查 P2-5）；再失败按原样抛出
          if (e instanceof GitHubApiError && (e.status === 403 || e.status === 429)) {
            const wait = Math.min(e.retryAfterMs ?? 60_000, 300_000)
            console.warn(`[starmark] rate limited, retry after ${Math.round(wait / 1000)}s`)
            await sleep(wait)
            res = await listStarred(page, cond)
          } else {
            throw e
          }
        }
        if (res.notModified) {
          await finish(checkpoint)
          return { status: 'NOT_MODIFIED' }
        }
        if (page === 1) {
          firstPageEtag = res.etag ?? firstPageEtag
          firstPageLastModified = res.lastModified ?? firstPageLastModified
        }
        for (const repo of res.repos) {
          const item = repoToItem(repo)
          if (!existingStarUrls.has(item.url)) {
            void logActivity('star_add', item.title, item.url)
            existingStarUrls.add(item.url)
          }
          seenUrls.add(item.url)
          totalFetched++
        }
        if (seenUrls.size > 0) {
          const newItems = res.repos.map(repoToItem)
          for (const item of newItems) sessionChangedIds.add(item.id)
          await upsertItems(newItems)
        }
        if (page >= MAX_PAGES) break
        nextPage = res.nextPage
        page = nextPage ?? page

        checkpoint.page = page
        checkpoint.etag = firstPageEtag
        checkpoint.lastModified = firstPageLastModified
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
      const removed = await reconcileStars(seenUrls, knownItems ?? undefined)
      for (const o of removed) sessionChangedIds.add(o.id)
      checkpoint.phase = 'TAG_INDEX'
      await setSyncState(GH_SYNC_STATE_KEY, checkpoint)
      await bumpIndexVersion([...sessionChangedIds])
      await finish(checkpoint)
      return { status: 'OK', fetched: totalFetched, removed: removed.length }
    }

    if (checkpoint.phase === 'TAG_INDEX') {
      // 仅恢复进度，无实际数据变更 → 版本号递增但无需重建索引
      await bumpIndexVersion([])
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
  // 同步成功后自动应用规则标签（追加式、幂等；失败不影响同步结果）
  void applyRulesToAll().catch(() => undefined)
}

/**
 * 对账：移除 items 中 sources 含 'star'、但本次同步集合之外的记录来源，并记入动态。
 * 满足安全：幂等、可重复执行、不影响同 URL 的书签来源。
 * @param knownItems 调用方已加载的全量条目（同步运行内复用，免二次全表扫描）
 */
export async function reconcileStars(seenUrls: Set<string>, knownItems?: StarItem[]): Promise<StarItem[]> {
  const all = knownItems ?? (await allItems())
  const orphans = all.filter((item) => item.sources.includes('star') && !seenUrls.has(item.url))
  await stripSourceForUrls(orphans.map((i) => i.url), 'star')
  for (const o of orphans) {
    void logActivity('star_remove', o.title, o.url)
  }
  return orphans
}