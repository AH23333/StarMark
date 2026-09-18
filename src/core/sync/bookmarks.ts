import { browser } from 'wxt/browser'
import { faviconFor, hashId, normalizeUrl } from '../normalize'
import { getByUrls, getSyncState, setSyncState, stripSourceForUrls, upsertItems } from '../db'
import { DB_BULK_CHUNK } from '../constants'
import { bumpIndexVersion } from '../version'
import { logActivity } from '../activity'
import { applyRulesForUrls } from '../rules'
import type { BookmarkMeta, BookmarkSyncState, Source, StarItem } from '../types'

export const BM_SYNC_STATE_KEY = 'bm.sync'

interface BookmarkTreeNode {
  id: string
  title?: string
  url?: string
  dateAdded?: number
  parentId?: string
  children?: BookmarkTreeNode[]
}

function bookmarkToItem(node: BookmarkTreeNode, folderPaths: string[], folderIds: string[]): StarItem {
  const url = normalizeUrl(node.url ?? '')
  const now = Date.now()
  return {
    id: hashId(url),
    url,
    title: node.title || url,
    description: '',
    sources: ['bookmark'],
    bookmarkedAt: node.dateAdded,
    bookmarkMeta: { folderPaths, folderIds } satisfies BookmarkMeta,
    faviconUrl: faviconFor(url),
    createdAt: now,
    updatedAt: now,
  }
}

/** 并入已存在的行（比如该 URL 同时是 Star），否则新增。 */
async function upsertBookmark(item: StarItem): Promise<void> {
  const existing = await getByUrls([item.url])
  const row = existing.find((r) => r.url === item.url)
  if (row) {
    const sources: Source[] = row.sources.includes('bookmark')
      ? row.sources
      : [...row.sources, 'bookmark']
    await upsertItems([
      {
        ...row,
        title: item.title || row.title,
        sources,
        bookmarkedAt: item.bookmarkedAt ?? row.bookmarkedAt,
        bookmarkMeta: item.bookmarkMeta,
        updatedAt: Date.now(),
      },
    ])
  } else {
    await upsertItems([item])
  }
}

/**
 * 批量并入书签来源（审查 P2-1）：同 URL 多节点合并后，按分块 bulkGet 预取已有行
 * （把 'bookmark' 并入 sources，保住同 URL Star 行），再一次性交给 upsertItems
 * 的分块事务模式 —— 取代旧实现"每条一次 getByUrl + 一次独立 upsertItems 事务"的
 * N+1 写法（1000 书签 ≈ 数千次 IndexedDB 事务）。
 */
async function upsertBookmarksBatch(entries: { node: BookmarkTreeNode; paths: string[]; ids: string[] }[]): Promise<void> {
  if (entries.length === 0) return
  // 同 URL 多书签：与旧逐条语义一致，取最后出现的节点（后写覆盖前写）
  const byUrl = new Map<string, { node: BookmarkTreeNode; paths: string[]; ids: string[] }>()
  for (const e of entries) {
    const url = normalizeUrl(e.node.url ?? '')
    if (url) byUrl.set(url, e)
  }
  const incoming = [...byUrl.values()].map((e) => bookmarkToItem(e.node, e.paths, e.ids))

  const CHUNK = DB_BULK_CHUNK
  const merged: StarItem[] = []
  for (let i = 0; i < incoming.length; i += CHUNK) {
    const slice = incoming.slice(i, i + CHUNK)
    const rows = await getByUrls(slice.map((x) => x.url))
    const rowByUrl = new Map(rows.map((r) => [r.url, r]))
    for (const item of slice) {
      const existing = rowByUrl.get(item.url)
      if (!existing) {
        merged.push(item)
        continue
      }
      // 行身份（id/createdAt/用户字段）以已有行为准：不 spread item，避免把同 URL 行
      // 换成新 id 触发 &url 唯一索引冲突（bulkPut 静默失败）。
      merged.push({
        ...existing,
        title: item.title || existing.title,
        sources: existing.sources.includes('bookmark') ? existing.sources : [...existing.sources, 'bookmark'],
        bookmarkedAt: item.bookmarkedAt ?? existing.bookmarkedAt,
        bookmarkMeta: item.bookmarkMeta,
      })
    }
  }
  await upsertItems(merged)
}

/**
 * 全量遍历书签树（不依赖硬编码根节点 ID）。审查 P2-1 重写 + 二轮性能优化：
 * 1) 直接遍历 getTree 返回的完整树（节点自带 children）—— 旧实现每个文件夹一次
 *    getChildren IPC，几百目录 = 几百次跨进程调用；现在仅 1 次 API 调用 + 纯内存遍历；
 * 2) 走 upsertBookmarksBatch 批量写入；
 * 3) lastFullWalkAt 检查点移到遍历**成功后**写入 —— SW 中途被杀不会留下
 *    "半截数据 + 新鲜时间戳"。
 * 返回处理的 URL 书签数量。
 */
export async function walkAllBookmarks(): Promise<number> {
  const tree = (await browser.bookmarks.getTree()) as unknown as BookmarkTreeNode[]
  const roots = tree[0]?.children ?? []

  const collected: { node: BookmarkTreeNode; paths: string[]; ids: string[] }[] = []
  const stack: { nodes: BookmarkTreeNode[]; paths: string[]; ids: string[] }[] = [
    { nodes: roots, paths: [], ids: [] },
  ]
  while (stack.length > 0) {
    const { nodes, paths, ids } = stack.pop()!
    for (const child of nodes) {
      if (child.url) {
        collected.push({ node: child, paths, ids })
      } else {
        stack.push({ nodes: child.children ?? [], paths: [...paths, child.title ?? ''], ids: [...ids, child.id] })
      }
    }
  }

  await upsertBookmarksBatch(collected)
  await setSyncState(BM_SYNC_STATE_KEY, { lastFullWalkAt: Date.now() as number })
  await bumpIndexVersion()
  return collected.length
}

/* ---------- 增量事件队列（1s 节流） ---------- */

type BmOp =
  | { kind: 'created'; node: BookmarkTreeNode }
  | { kind: 'removed'; url?: string; title?: string }
  | { kind: 'changedOrMoved'; id: string }

let pendingOps: BmOp[] = []
let flushTimer: ReturnType<typeof setTimeout> | null = null

function scheduleFlush(): void {
  if (flushTimer) return
  flushTimer = setTimeout(() => {
    flushTimer = null
    const ops = pendingOps
    pendingOps = []
    void applyOps(ops)
  }, 1000)
}

/**
 * 共享树上下文（二轮性能优化）：批内多个增量事件只 getTree 一次，
 * 路径回溯全部在内存中沿 parentId 链完成，不再逐级 bookmarks.get。
 */
interface TreeCtx {
  byId: Map<string, BookmarkTreeNode>
  rootId: string
}

async function loadTreeCtx(): Promise<TreeCtx> {
  const tree = (await browser.bookmarks.getTree()) as unknown as BookmarkTreeNode[]
  const byId = new Map<string, BookmarkTreeNode>()
  const walk = (nodes: BookmarkTreeNode[]): void => {
    for (const n of nodes) {
      byId.set(n.id, n)
      if (n.children) walk(n.children)
    }
  }
  for (const root of tree) walk(root.children ?? [])
  return { byId, rootId: tree[0]?.id ?? '' }
}

/** 从共享树上下文回溯 parentId 的真实目录路径（created/moved 事件即时路径，不等全量遍历）。 */
function folderPathFromCtx(ctx: TreeCtx, parentId: string): { paths: string[]; ids: string[] } {
  const paths: string[] = []
  const ids: string[] = []
  let cur = ctx.byId.get(parentId)
  let guard = 0
  while (cur && cur.id !== ctx.rootId && guard++ < 20) {
    if (cur.url) break
    paths.unshift(cur.title ?? '')
    ids.unshift(cur.id)
    cur = cur.parentId ? ctx.byId.get(cur.parentId) : undefined
  }
  if (paths.length === 0) paths.push('')
  if (ids.length === 0) ids.push(parentId)
  return { paths, ids }
}

async function applyOps(ops: BmOp[]): Promise<void> {
  let updated = 0
  let needFullWalk = false
  const ids: string[] = []
  // 批内共享树：首个需要路径回溯的事件时加载一次
  let ctx: TreeCtx | null = null
  const ensureCtx = async (): Promise<TreeCtx> => (ctx ??= await loadTreeCtx())

  for (const op of ops) {
    if (op.kind === 'created' && op.node.url) {
      // 用真实目录路径建行（此前用 [''] 占位会导致条目暂不出现在收藏夹树，需等下一次全量遍历才修复）
      const { paths, ids: pathIds } = folderPathFromCtx(await ensureCtx(), op.node.parentId ?? '')
      await upsertBookmark(bookmarkToItem(op.node, paths, pathIds))
      ids.push(hashId(normalizeUrl(op.node.url)))
      void logActivity('bookmark_add', op.node.title || op.node.url, op.node.url)
      // 规则自动标签：新增书签立即命中规则（bump:false，合并到本批失效里）
      try {
        const ruleIds = await applyRulesForUrls([normalizeUrl(op.node.url)], { bump: false })
        ids.push(...ruleIds)
      } catch {
        // 规则应用失败不阻塞书签同步
      }
      updated++
    } else if (op.kind === 'removed') {
      if (op.url) {
        // 移除来源而非整行删除（可能该 URL 也是 Star）
        await stripSourceForUrls([op.url], 'bookmark')
        ids.push(hashId(normalizeUrl(op.url)))
        void logActivity('bookmark_remove', op.title || op.url, op.url)
        updated++
      }
    } else if (op.kind === 'changedOrMoved') {
      try {
        // bookmarks.get 返回数组，解包第一个元素
        const res = (await browser.bookmarks.get(op.id)) as unknown as BookmarkTreeNode[] | BookmarkTreeNode | undefined
        const node = Array.isArray(res) ? res[0] : res
        if (!node) continue
        if (node.url) {
          // 复用路径回溯得到真实目录路径（审查 P1-7）：
          // 旧实现写入 [''] 占位会让移动/改名后的条目错位到根，最长等 1 小时的全量遍历才纠正
          const { paths, ids: pathIds } = folderPathFromCtx(await ensureCtx(), node.parentId ?? '')
          await upsertBookmark(bookmarkToItem(node, paths, pathIds))
          ids.push(hashId(normalizeUrl(node.url)))
          // 规则自动标签：对齐 created 分支，改名/移动后 title/URL 命中的规则即时生效
          try {
            const ruleIds = await applyRulesForUrls([normalizeUrl(node.url)], { bump: false })
            ids.push(...ruleIds)
          } catch {
            // 规则应用失败不阻塞书签同步
          }
          updated++
        } else {
          // 目录改名/移动（onChanged 对文件夹触发）：子树内所有书签的 folderPaths 过期。
          // 低频操作，安排一次全量重走纠正（同批去重；批量遍历已优化，代价可接受）。
          needFullWalk = true
        }
      } catch {
        // onRemoved 竞态下 get 失败则忽略
      }
    }
  }
  if (updated > 0) {
    await bumpIndexVersion([...new Set(ids)])
  }
  if (needFullWalk) {
    try {
      await walkAllBookmarks()
    } catch (e) {
      console.warn('[starmark] folder rename follow-up walk failed', e)
    }
  }
}

export function registerBookmarkListeners(): void {
  browser.bookmarks.onCreated.addListener((_id: string, node: BookmarkTreeNode) => {
    pendingOps.push({ kind: 'created', node })
    scheduleFlush()
  })
  browser.bookmarks.onRemoved.addListener((_id, removeInfo: { node: BookmarkTreeNode }) => {
    pendingOps.push({ kind: 'removed', url: removeInfo.node.url, title: removeInfo.node.title })
    scheduleFlush()
  })
  browser.bookmarks.onChanged.addListener((id: string) => {
    pendingOps.push({ kind: 'changedOrMoved', id })
    scheduleFlush()
  })
  browser.bookmarks.onMoved.addListener((id: string) => {
    pendingOps.push({ kind: 'changedOrMoved', id })
    scheduleFlush()
  })
}

/** SW 重启后丢失事件的兜底：距上次全量对账超过 1h 则补齐一次。 */
export async function maybeRestoreBookmarks(): Promise<void> {
  const state = await getSyncState<BookmarkSyncState>(BM_SYNC_STATE_KEY)
  if (!state?.lastFullWalkAt || Date.now() - state.lastFullWalkAt > 3600_000) {
    await walkAllBookmarks()
  }
}