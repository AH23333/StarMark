import 'fake-indexeddb/auto'
import { describe, expect, it } from 'vitest'
import Dexie from 'dexie'
import { hashId, normalizeUrl } from './normalize'
import { db, allItems } from './db'

/**
 * 审查 P1-1 迁移回归：先用旧 v4 schema 写入 8-bit FNV id 的存量数据，
 * 再用完整 v5 声明打开 → 触发 upgrade：按 url 重算 id、重映射 suggestions、作废 searchIndex。
 */
describe('P1-1 主键 128-bit 迁移（v4 → v5）', () => {
  it('旧 8-bit id 行按 url 重算为 128-bit id，suggestions 同步重映射，searchIndex 作废', async () => {
    const urlA = normalizeUrl('https://github.com/o/a')
    const urlB = normalizeUrl('https://github.com/o/b')

    // 1) 造一个只声明到 v4 的旧库，写入旧格式数据（8 位 hex id）
    const legacy = new Dexie('starmark')
    legacy.version(4).stores({
      items: 'id, &url, starredAt, bookmarkedAt, updatedAt, hidden',
      searchIndex: 'id, version, builtAt',
      syncState: 'key',
      activity: '++id, at',
      meta: 'key',
      suggestions: 'id, itemId, status, tag',
    })
    await legacy.open()
    const oldIdA = 'aaaa0000'
    const oldIdB = 'bbbb1111'
    await legacy.table('items').bulkPut([
      { id: oldIdA, url: urlA, title: 'A', description: '', sources: ['star'], createdAt: 1, updatedAt: 1, tags: ['x'] },
      { id: oldIdB, url: urlB, title: 'B', description: '', sources: ['bookmark'], createdAt: 2, updatedAt: 2 },
    ])
    await legacy.table('suggestions').put({ id: `${oldIdA}|tag1`, itemId: oldIdA, tag: 'tag1', status: 'pending', createdAt: 1 })
    await legacy.table('searchIndex').put({ id: 'main', version: 7, builtAt: 1 })
    legacy.close()

    // 2) 用完整 v5 声明的单例打开 → Dexie 检测到版本落后，执行 upgrade
    await db.open()

    const rows = await allItems()
    expect(rows.map((r) => r.id).sort()).toEqual([hashId(urlA), hashId(urlB)].sort())
    expect(rows.map((r) => r.id).every((id) => /^[0-9a-f]{32}$/.test(id))).toBe(true)
    // 行内容保留
    expect(rows.find((r) => r.url === urlA)?.tags).toEqual(['x'])

    // suggestions.itemId 重映射到新 id
    const sugg = await db.suggestions.toArray()
    expect(sugg).toHaveLength(1)
    expect(sugg[0]?.itemId).toBe(hashId(urlA))
    expect(sugg[0]?.id).toBe(`${hashId(urlA)}|tag1`)

    // searchIndex 快照引用旧 id → 必须作废（打开面板后按新版本全量重建）
    expect(await db.searchIndex.get('main')).toBeUndefined()
  })

  it('hashId 对同 URL 恒定（新旧 id 映射稳定的前提）', () => {
    const u = 'https://github.com/O/A'
    expect(hashId(u)).toBe(hashId(normalizeUrl(u)))
    expect(hashId(u)).toBe(hashId(u.toLowerCase()))
  })
})
