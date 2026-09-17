import 'fake-indexeddb/auto'
import { describe, expect, it, beforeEach, vi } from 'vitest'
import { buildBackup, parseBackup, restoreBackup } from './backup'
import { allItems, db, getAppMeta, upsertItems } from './db'
import type { StarItem } from './types'

// restoreBackup → bumpIndexVersion 依赖 storage.local；测试里用内存 Map 顶替
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

function mk(id: string): StarItem {
  const url = `https://example.com/${id}`
  return {
    id,
    url,
    title: `Title ${id}`,
    description: '',
    sources: ['star'],
    starredAt: 1_700_000_000_000,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    tags: ['t1'],
  }
}

describe('buildBackup / parseBackup', () => {
  it('明文往返一致', async () => {
    const { content, encrypted } = await buildBackup()
    expect(encrypted).toBe(false)
    const payload = await parseBackup(content)
    expect(payload.app).toBe('starmark')
    expect(Array.isArray(payload.items)).toBe(true)
    expect(payload.exportedAt).toBeGreaterThan(0)
  })

  it('口令加密往返一致', async () => {
    const { content, encrypted } = await buildBackup('secret')
    expect(encrypted).toBe(true)
    expect(content.startsWith('{"enc":"aes-256-gcm"')).toBe(true)
    const payload = await parseBackup(content, 'secret')
    expect(payload.items.length).toBeGreaterThanOrEqual(0)
  })

  it('加密备份的 salt / iv 每次随机（不得恒为零）', async () => {
    const a = JSON.parse((await buildBackup('secret')).content) as { salt: string; iv: string; data: string }
    const b = JSON.parse((await buildBackup('secret')).content) as { salt: string; iv: string; data: string }

    expect(a.salt).not.toBe(b.salt)
    expect(a.iv).not.toBe(b.iv)

    // 恒为零的回归防线：全零 salt/iv 会让同口令导出密钥相同、IV 重复，破坏 AES-GCM 前提
    const saltBytes = Uint8Array.from(atob(a.salt), (c) => c.charCodeAt(0))
    const ivBytes = Uint8Array.from(atob(a.iv), (c) => c.charCodeAt(0))
    expect(saltBytes.some((x) => x !== 0)).toBe(true)
    expect(ivBytes.some((x) => x !== 0)).toBe(true)

    // IV 不同 ⇒ 相同明文的密文也应不同
    expect(a.data).not.toBe(b.data)
  })

  it('错误口令抛错', async () => {
    const { content } = await buildBackup('secret')
    await expect(parseBackup(content, 'wrong')).rejects.toThrow()
    await expect(parseBackup(content)).rejects.toThrow(/口令/)
  })

  it('非有效备份抛错', async () => {
    await expect(parseBackup('{"foo":1}')).rejects.toThrow()
    await expect(parseBackup('not json')).rejects.toThrow()
  })
})

describe('restoreBackup（审查 P0-1 回归）', () => {
  beforeEach(async () => {
    store.clear()
    await db.delete()
    await db.open()
  })

  it('恢复后 meta 与条目实际计数一致，AI 建议与动态不再残留', async () => {
    // 预置旧数据 + 错误的旧 meta 基线 + 残留的 AI 建议与动态
    await upsertItems([mk('old1'), mk('old2')])
    await db.meta.put({ key: 'app', value: { total: 999, stars: 999, bookmarks: 999, hidden: 0, tagged: 999, tags: { stale: 999 } } })
    await db.suggestions.put({ id: 'old1|tag', itemId: 'old1', tag: 'tag', status: 'pending', createdAt: 1 })
    await db.activity.add({ at: 1, kind: 'star_add', title: 't', url: 'u' })

    const incoming: StarItem[] = [mk('r1'), mk('r2'), mk('r3')]
    await restoreBackup(incoming)

    const meta = await getAppMeta()
    expect(meta.total).toBe(3) // 不是 999 + 3
    expect(meta.stars).toBe(3)
    expect(meta.tagged).toBe(3)
    expect(meta.tags).toEqual({ t1: 3 })
    expect(await allItems()).toHaveLength(3)
    // 悬空建议与旧动态必须被清空
    expect(await db.suggestions.toArray()).toEqual([])
    expect(await db.activity.toArray()).toEqual([])
    // 索引版本被 bump（触发 worker 全量重建）
    expect(store.get('indexVersion')).toBe(1)
  })

  it('恢复空列表后计数归零', async () => {
    await upsertItems([mk('old1')])
    await restoreBackup([])
    const meta = await getAppMeta()
    expect(meta.total).toBe(0)
    expect(await allItems()).toHaveLength(0)
  })
})