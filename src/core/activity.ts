import { db } from './db'
import type { ActivityEntry, ActivityKind } from './types'

/** 记录一条动态事件（Star/书签的新增或移除）。 */
export async function logActivity(kind: ActivityKind, title: string, url: string): Promise<void> {
  await db.activity.add({ at: Date.now(), kind, title, url })
  // 限制活动表体积，超过 500 条丢弃最旧的
  const count = await db.activity.count()
  if (count > 500) {
    const oldest = await db.activity.orderBy('at').limit(count - 500).toArray()
    await db.activity.bulkDelete(oldest.map((e) => e.id!))
  }
}

/** 最近的动态事件（倒序）。 */
export async function recentActivity(limit = 40): Promise<ActivityEntry[]> {
  return db.activity.orderBy('at').reverse().limit(limit).toArray()
}