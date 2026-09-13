import { browser } from 'wxt/browser'
import { faviconFor, hashId, normalizeUrl } from '../normalize'
import { getByUrl, getSyncState, setSyncState, stripSourceForUrls, upsertItems } from '../db'
import { bumpIndexVersion } from '../version'
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
  const existing = await getByUrl(item.url)
  if (existing) {
    const sources: Source[] = existing.sources.includes('bookmark')
      ? existing.sources
      : [...existing.sources, 'bookmark']
    await upsertItems([
      {
        ...existing,
        title: item.title || existing.title,
        sources,
        bookmarkedAt: item.bookmarkedAt ?? existing.bookmarkedAt,
        bookmarkMeta: item.bookmarkMeta,
        updatedAt: Date.now(),
      },
    ])
  } else {
    await upsertItems([item])
  }
}

/**
 * 全量遍历书签树（分块 BFS），不依赖硬编码根节点 ID。
 * 返回处理的 URL 书签数量。
 */
export async function walkAllBookmarks(): Promise<number> {
  const tree = (await browser.bookmarks.getTree()) as unknown as BookmarkTreeNode[]
  const roots = tree[0]?.children ?? []

  let count = 0
  const queue: { id: string; paths: string[]; ids: string[] }[] = []
  for (const root of roots) {
    queue.push({ id: root.id, paths: [root.title ?? ''], ids: [root.id] })
  }

  await setSyncState(BM_SYNC_STATE_KEY, { lastFullWalkAt: Date.now() as number })

  while (queue.length > 0) {
    const cursor = queue.shift()!
    const children = (await browser.bookmarks.getChildren(cursor.id)) as unknown as BookmarkTreeNode[]

    for (const child of children) {
      if (child.url) {
        await upsertBookmark(bookmarkToItem(child, cursor.paths, cursor.ids))
        count++
      } else {
        queue.push({ id: child.id, paths: [...cursor.paths, child.title ?? ''], ids: [...cursor.ids, child.id] })
      }
    }
    await new Promise((r) => setTimeout(r, 0)) // 让出事件循环
  }

  await bumpIndexVersion()
  return count
}

/* ---------- 增量事件队列（1s 节流） ---------- */

type BmOp =
  | { kind: 'created'; node: BookmarkTreeNode }
  | { kind: 'removed'; url?: string }
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

async function applyOps(ops: BmOp[]): Promise<void> {
  let updated = 0
  for (const op of ops) {
    if (op.kind === 'created' && op.node.url) {
      await upsertBookmark(bookmarkToItem(op.node, [''], [op.node.parentId ?? '']))
      updated++
    } else if (op.kind === 'removed') {
      if (op.url) {
        // 移除来源而非整行删除（可能该 URL 也是 Star）
        await stripSourceForUrls([op.url], 'bookmark')
        updated++
      }
    } else if (op.kind === 'changedOrMoved') {
      try {
        const node = (await browser.bookmarks.get(op.id)) as unknown as BookmarkTreeNode | undefined
        if (node?.url) {
          await upsertBookmark(bookmarkToItem(node, [''], [node.parentId ?? '']))
          updated++
        }
      } catch {
        // onRemoved 竞态下 get 失败则忽略
      }
    }
  }
  if (updated > 0) {
    await bumpIndexVersion()
  }
}

export function registerBookmarkListeners(): void {
  browser.bookmarks.onCreated.addListener((_id: string, node: BookmarkTreeNode) => {
    pendingOps.push({ kind: 'created', node })
    scheduleFlush()
  })
  browser.bookmarks.onRemoved.addListener((_id, removeInfo: { node: BookmarkTreeNode }) => {
    pendingOps.push({ kind: 'removed', url: removeInfo.node.url })
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