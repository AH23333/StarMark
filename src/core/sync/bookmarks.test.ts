import 'fake-indexeddb/auto'
import { describe, expect, it, beforeEach, vi } from 'vitest'
import { walkAllBookmarks, registerBookmarkListeners } from './bookmarks'
import { allItems, db, getAppMeta, getSyncState } from '../db'
import { normalizeUrl } from '../normalize'
import type { BookmarkSyncState, StarItem } from '../types'

/*
 * 书签同步测试（审查 P1-7 / P2-1 回归）：
 * - 全量遍历按真实目录路径入库、检查点在成功后写入；
 * - changedOrMoved（onChanged/onMoved）事件即时回溯 parentId 的真实路径，不再用 [''] 占位。
 * 注意：Chrome 的 bookmarks.get 返回数组 —— mock 必须按真实语义返回数组。
 */

const { store } = vi.hoisted(() => ({ store: new Map<string, unknown>() }))

interface Node {
  id: string
  title?: string
  url?: string
  parentId?: string
  children?: Node[]
}

// 可变测试树
let tree: Node[] = []
let byId = new Map<string, Node>()
let failGetTree = false

function rebuildIndex(): void {
  byId = new Map()
  const walk = (nodes: Node[], parent?: string): void => {
    for (const n of nodes) {
      n.parentId = parent
      byId.set(n.id, n)
      if (n.children) walk(n.children, n.id)
    }
  }
  walk(tree)
}

vi.mock('wxt/browser', () => ({
  browser: {
    storage: {
      local: {
        get: vi.fn(async (keys?: string | string[] | null) => {
          const out: Record<string, unknown> = {}
          if (keys == null) {
            for (const [k, v] of store) out[k] = v
            return out
          }
          const list = typeof keys === 'string' ? [keys] : keys
          for (const k of list) if (store.has(k)) out[k] = store.get(k)
          return out
        }),
        set: vi.fn(async (objs: Record<string, unknown>) => {
          for (const [k, v] of Object.entries(objs)) store.set(k, v)
        }),
      },
    },
    bookmarks: {
      getTree: vi.fn(async () => {
        if (failGetTree) throw new Error('boom')
        return [tree[0]]
      }),
      getChildren: vi.fn(async (id: string) => byId.get(id)?.children ?? []),
      get: vi.fn(async (id: string) => {
        const n = byId.get(id)
        if (!n) throw new Error('not found')
        return [n] // Chrome 语义：返回数组
      }),
      onCreated: { addListener: vi.fn() },
      onRemoved: { addListener: vi.fn() },
      onChanged: { addListener: vi.fn() },
      onMoved: { addListener: vi.fn() },
    },
  },
}))

const bmListeners: Record<string, ((...args: never[]) => void)[]> = {}

describe('书签同步（审查 P1-7 / P2-1 回归）', () => {
  beforeEach(async () => {
    store.clear()
    failGetTree = false
    bmListeners.onChanged = []
    bmListeners.onMoved = []
    tree = [
      {
        id: 'root',
        title: '',
        children: [
          {
            id: 'bar',
            title: '书签栏',
            children: [
              { id: 'f1', title: '开发', children: [{ id: 'b1', title: 'MiniSearch', url: 'https://github.com/lucaong/minisearch' }] },
              { id: 'b2', title: '示例', url: 'https://example.com/' },
            ],
          },
        ],
      },
    ]
    rebuildIndex()
    await db.delete()
    await db.open()
  })

  it('全量遍历按真实目录路径入库并统计计数（P2-1）', async () => {
    const count = await walkAllBookmarks()
    expect(count).toBe(2)
    const items = await allItems()
    expect(items).toHaveLength(2)

    const bm1 = items.find((i) => i.url === normalizeUrl('https://github.com/lucaong/minisearch'))
    expect(bm1?.bookmarkMeta?.folderPaths).toEqual(['书签栏', '开发'])
    expect(bm1?.bookmarkMeta?.folderIds).toEqual(['bar', 'f1'])

    const meta = await getAppMeta()
    expect(meta.total).toBe(2)
    expect(meta.bookmarks).toBe(2)

    // 检查点在成功后写入
    const state = await getSyncState<BookmarkSyncState>('bm.sync')
    expect(state?.lastFullWalkAt).toBeGreaterThan(0)
  })

  it('同 URL 的 Star 行被并入 bookmark 来源而非覆盖（P2-1 批量语义）', async () => {
    await db.items.put({
      id: 'star1',
      url: normalizeUrl('https://example.com/'),
      title: '示例',
      description: '',
      sources: ['star'],
      createdAt: 1,
      updatedAt: 1,
      tags: ['keep'],
    })
    await walkAllBookmarks()
    const row = (await allItems()).find((i) => i.url === normalizeUrl('https://example.com/'))
    expect(row?.sources).toEqual(expect.arrayContaining(['star', 'bookmark']))
    expect(row?.tags).toEqual(['keep'])
  })

  it('全量遍历中途失败时不写 lastFullWalkAt（P2-1 检查点后置）', async () => {
    failGetTree = true
    await expect(walkAllBookmarks()).rejects.toThrow('boom')
    const state = await getSyncState<BookmarkSyncState>('bm.sync')
    expect(state?.lastFullWalkAt).toBeUndefined()
  })

  it('onMoved / onChanged 即时回溯新路径，不再错位到根（P1-7）', async () => {
    await walkAllBookmarks()

    registerBookmarkListeners()
    // 触发注册的 onChanged / onMoved 监听器
    const changedHandlers = vi.mocked((await import('wxt/browser')).browser.bookmarks.onChanged.addListener).mock.calls
    const movedHandlers = vi.mocked((await import('wxt/browser')).browser.bookmarks.onMoved.addListener).mock.calls
    expect(changedHandlers.length).toBeGreaterThan(0)
    expect(movedHandlers.length).toBeGreaterThan(0)

    // 场景：书签被移动到新文件夹 f2（旧实现写入 [''] 占位 → 错位到根直到全量遍历）
    tree[0]!.children![0]!.children!.push({ id: 'f2', title: '设计', children: [] })
    rebuildIndex()
    const b1 = byId.get('b1')!
    byId.get('f1')!.children = byId.get('f1')!.children!.filter((c) => c.id !== 'b1')
    byId.get('f2')!.children!.push(b1)
    b1.parentId = 'f2'

    const onChanged = changedHandlers[0]![0] as (id: string) => void
    onChanged('b1')
    // 轮询等待节流 flush（1s）+ IndexedDB 写入完成，避免固定 sleep 在高负载下抖动
    let row: StarItem | undefined
    for (let i = 0; i < 250; i++) {
      await new Promise((r) => setTimeout(r, 20))
      row = (await allItems()).find((x) => x.url === normalizeUrl('https://github.com/lucaong/minisearch'))
      if (row?.bookmarkMeta?.folderPaths.join('|') === '书签栏|设计') break
    }
    expect(row?.bookmarkMeta?.folderPaths).toEqual(['书签栏', '设计'])
    expect(row?.bookmarkMeta?.folderPaths[0]).not.toBe('')
  }, 15_000)

  it('目录改名（onChanged 对文件夹）触发全量重走，子树内书签路径被纠正（二轮复查）', async () => {
    await walkAllBookmarks()
    registerBookmarkListeners()
    const changedHandlers = vi.mocked((await import('wxt/browser')).browser.bookmarks.onChanged.addListener).mock.calls

    // 文件夹 f1 改名 '开发' → '研发'：无 url 节点
    byId.get('f1')!.title = '研发'
    const onChanged = changedHandlers[0]![0] as (id: string) => void
    onChanged('f1')
    // flush(1s) + 全量重走：轮询等待路径被纠正
    for (let i = 0; i < 250; i++) {
      await new Promise((r) => setTimeout(r, 20))
      const rows = await allItems()
      const row = rows.find((x) => x.url === normalizeUrl('https://github.com/lucaong/minisearch'))
      if (row?.bookmarkMeta?.folderPaths.join('|') === '书签栏|研发') break
    }

    const row = (await allItems()).find((i) => i.url === normalizeUrl('https://github.com/lucaong/minisearch'))
    expect(row?.bookmarkMeta?.folderPaths).toEqual(['书签栏', '研发'])
  }, 15_000)
})
