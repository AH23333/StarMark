import { db } from './db'
import type { ActivityEntry, ActivityKind } from './types'

/** 动态保留窗口：30 天（时间线本就只展示最近几十条，窗口足够） */
const ACTIVITY_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000
/** 修剪节流：60s 内不重复执行范围删除（每次写入都探测一次索引下界纯属浪费） */
const TRIM_INTERVAL_MS = 60_000

let lastTrimAt = 0

/**
 * 记录一条动态事件（Star/书签的新增或移除）。
 * 修剪策略（审查 P2-3）：旧实现 `count()` 后按差值删最旧 N 条，并发写入时会互相踩踏
 * 导致略超上限；改为按时间下界删除，允许瞬时略超窗口（无实际危害，仅体积）。
 * 注意：同步循环内多处 `void logActivity(...)` fire-and-forget，SW 被杀会丢个别动态
 * —— 属可接受的最终一致行为，不做可靠性补偿。
 */
export async function logActivity(kind: ActivityKind, title: string, url: string): Promise<void> {
  await db.activity.add({ at: Date.now(), kind, title, url })
  const now = Date.now()
  if (now - lastTrimAt < TRIM_INTERVAL_MS) return
  lastTrimAt = now
  await db.activity.where('at').below(now - ACTIVITY_MAX_AGE_MS).delete()
}

/** 最近的动态事件（倒序）。 */
export async function recentActivity(limit = 40): Promise<ActivityEntry[]> {
  return db.activity.orderBy('at').reverse().limit(limit).toArray()
}
