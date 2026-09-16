import { db, updateItem } from './db'
import { bumpIndexVersion } from './version'
import type { StarItem } from './types'

/**
 * 回顾模式（阶段 B）：轻量间隔重复。
 * 到期队列 = 按 收藏时间 生成"该复习的条目"：
 *  - 间隔随连续"记住了"次数翻倍（1d → 3d → 7d → 14d → 30d → 60d，封顶 180d）
 *  - "忘了"回到 1d；"不再提醒"永久退出队列（reviewSkip）
 *  - 从未回顾过的条目，按 收藏后 7 天 计入首次到期
 * 全部本地计算，无新权限。
 */

/** 连续答对 n 次后的下一次回顾间隔（天） */
export function reviewIntervalDays(streak: number): number {
  const table = [1, 3, 7, 14, 30, 60]
  return table[Math.min(streak, table.length - 1)]!
}

const FIRST_REVIEW_DELAY_MS = 7 * 24 * 3600 * 1000
const MAX_INTERVAL_DAYS = 180

/** 条目下一次应复习的时间戳；永不再复习（reviewSkip）返回 null。 */
export function nextDueAt(item: StarItem, now = Date.now()): number | null {
  if (item.reviewSkip) return null
  const addedAt = item.starredAt ?? item.bookmarkedAt ?? item.createdAt
  if (!item.reviewedAt) return addedAt + FIRST_REVIEW_DELAY_MS
  const interval = Math.min(
    reviewIntervalDays(item.reviewCount ?? 0),
    MAX_INTERVAL_DAYS,
  ) * 24 * 3600 * 1000
  return item.reviewedAt + interval
}

export interface ReviewCandidate {
  id: string
  url: string
  title: string
  description: string
  notes?: string
  tags?: string[]
  sources: string[]
  language?: string | null
  stars?: number
  favicon?: string
  /** 收藏时间（用于"收藏于 xx 天前"） */
  addedAt: number
  /** 距上次回顾的天数（从未回顾为 0） */
  sinceLastReviewDays: number
  reviewCount: number
}

/** 到期待复习队列（最久未回顾优先，数量受限）。 */
export async function dueReviewItems(limit = 20, now = Date.now()): Promise<ReviewCandidate[]> {
  const items = await db.items.toArray()
  const due: { item: StarItem; dueAt: number }[] = []
  for (const item of items) {
    if (item.hidden) continue
    const dueAt = nextDueAt(item, now)
    if (dueAt == null || dueAt > now) continue
    due.push({ item, dueAt })
  }
  due.sort((a, b) => a.dueAt - b.dueAt)
  return due.slice(0, limit).map(({ item }) => ({
    id: item.id,
    url: item.url,
    title: item.title,
    description: item.description,
    notes: item.notes,
    tags: item.tags,
    sources: item.sources,
    language: item.starMeta?.language,
    stars: item.starMeta?.stars,
    favicon: item.faviconUrl,
    addedAt: item.starredAt ?? item.bookmarkedAt ?? item.createdAt,
    sinceLastReviewDays: item.reviewedAt ? Math.floor((now - item.reviewedAt) / 86400000) : 0,
    reviewCount: item.reviewCount ?? 0,
  }))
}

export type ReviewVerdict = 'remembered' | 'forgot' | 'never'

/** 回顾判定写回；返回变更的条目 id（供索引增量失效）。 */
export async function recordReview(id: string, verdict: ReviewVerdict, now = Date.now()): Promise<string | null> {
  const item = await dbGet(id)
  if (!item) return null
  const patch: Partial<Pick<StarItem, 'reviewedAt' | 'reviewCount' | 'reviewSkip'>> = { reviewedAt: now }
  if (verdict === 'remembered') {
    patch.reviewCount = (item.reviewCount ?? 0) + 1
  } else if (verdict === 'forgot') {
    patch.reviewCount = 0
  } else {
    patch.reviewSkip = true
  }
  await updateItem(id, patch)
  await bumpIndexVersion([id])
  return id
}

async function dbGet(id: string): Promise<StarItem | undefined> {
  return db.items.get(id)
}
