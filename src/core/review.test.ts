import 'fake-indexeddb/auto'
import { describe, expect, it, beforeEach, vi } from 'vitest'
import { dueReviewItems, nextDueAt, recordReview, reviewIntervalDays } from './review'
import { db, updateItem, upsertItems } from './db'
import { normalizeUrl } from './normalize'
import type { StarItem } from './types'

// bumpIndexVersion 走 chrome.storage.local；测试用内存 Map 顶替
const { store } = vi.hoisted(() => ({ store: new Map<string, unknown>() }))
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
  },
}))

function item(id: string, urlPath: string, sources: StarItem['sources'], extra: Partial<StarItem> = {}): StarItem {
  const url = normalizeUrl(`https://github.com/${urlPath}`)
  return {
    id,
    url,
    title: urlPath,
    description: '',
    sources,
    createdAt: 1000,
    updatedAt: 1000,
    ...extra,
  }
}

beforeEach(async () => {
  store.clear()
  await db.delete()
  await db.open()
})

describe('间隔计算', () => {
  it('连续答对次数按 1/3/7/14/30/60 天翻倍并封顶', () => {
    expect(reviewIntervalDays(0)).toBe(1)
    expect(reviewIntervalDays(1)).toBe(3)
    expect(reviewIntervalDays(2)).toBe(7)
    expect(reviewIntervalDays(3)).toBe(14)
    expect(reviewIntervalDays(4)).toBe(30)
    expect(reviewIntervalDays(5)).toBe(60)
    expect(reviewIntervalDays(99)).toBe(60)
  })

  it('nextDueAt：未回顾 = 收藏后 7 天；已回顾 = 上次 + 间隔；skip = null', () => {
    const added = Date.UTC(2026, 8, 1)
    const base = item('a', 'o/a', ['star'], { starredAt: added })
    expect(nextDueAt(base)).toBe(added + 7 * 86400000)
    expect(nextDueAt({ ...base, reviewSkip: true })).toBeNull()

    const reviewedAt = added + 8 * 86400000
    const once = { ...base, reviewedAt, reviewCount: 1 }
    expect(nextDueAt(once)).toBe(reviewedAt + 3 * 86400000)
  })
})

describe('到期队列', () => {
  it('只包含到期条目，最久未回顾优先，隐藏条目被跳过', async () => {
    const now = Date.now()
    await upsertItems([
      // 到期（收藏 10 天前，未回顾）
      item('due', 'o/due', ['star'], { starredAt: now - 10 * 86400000 }),
      // 未到期（收藏 1 天前）
      item('fresh', 'o/fresh', ['star'], { starredAt: now - 1 * 86400000 }),
      // 已到期但 skip
      item('skip', 'o/skip', ['star'], { starredAt: now - 30 * 86400000, reviewSkip: true }),
      // 到期但隐藏
      item('hid', 'o/hid', ['star'], { starredAt: now - 30 * 86400000, hidden: true }),
      // 更久之前到期 → 排最前
      item('old', 'o/old', ['star'], { starredAt: now - 60 * 86400000 }),
    ])
    const due = await dueReviewItems(10, now)
    expect(due.map((d) => d.id)).toEqual(['old', 'due'])
    expect(due[0]!.sinceLastReviewDays).toBe(0)
  })
})

describe('recordReview', () => {
  it('remembered 累加 streak，forgot 归零，never 置 skip', async () => {
    const now = Date.now()
    await upsertItems([item('a', 'o/a', ['star'], { starredAt: now - 10 * 86400000 })])

    await recordReview('a', 'remembered', now)
    let row = (await db.items.get('a'))!
    expect(row.reviewCount).toBe(1)
    expect(row.reviewedAt).toBe(now)

    await recordReview('a', 'forgot', now + 1000)
    row = (await db.items.get('a'))!
    expect(row.reviewCount).toBe(0)
    expect(row.reviewedAt).toBe(now + 1000)

    await recordReview('a', 'never', now + 2000)
    row = (await db.items.get('a'))!
    expect(row.reviewSkip).toBe(true)
    expect(await dueReviewItems(10, now + 3000)).toEqual([])
  })

  it('不存在的条目返回 null', async () => {
    expect(await recordReview('ghost', 'remembered')).toBeNull()
  })
})

describe('与 updateItem 的字段保留', () => {
  it('回顾字段不会被同步合并清掉（mergePreserving 白名单）', async () => {
    const now = Date.now()
    await upsertItems([item('a', 'o/a', ['star'], { starredAt: now - 10 * 86400000 })])
    await recordReview('a', 'remembered', now)
    // 再次同步：新行不含回顾字段，不应清掉（同 URL 必须同 id，&url 唯一）
    await upsertItems([item('a', 'o/a', ['star'], { starMeta: { stars: 99 } as StarItem['starMeta'] })])
    const row = await db.items.get('a')
    expect(row?.reviewCount).toBe(1)
    expect(row?.reviewedAt).toBe(now)
    await updateItem('a', { notes: 'x' })
    expect((await db.items.get('a'))?.reviewCount).toBe(1)
  })
})
