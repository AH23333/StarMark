import { describe, expect, it, beforeEach, vi } from 'vitest'

// version 依赖 chrome.storage.local 存 indexVersion / idxPatch；测试里用内存 Map 顶替
const { store, setSpy } = vi.hoisted(() => ({
  store: new Map<string, unknown>(),
  setSpy: vi.fn(async (objs: Record<string, unknown>) => {
    for (const [k, v] of Object.entries(objs)) store.set(k, v)
  }),
}))
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
        set: setSpy,
      },
    },
  },
}))

import { bumpIndexVersion, getIndexVersion } from './version'

describe('bumpIndexVersion（审查 P1-3 回归）', () => {
  beforeEach(() => {
    store.clear()
    setSpy.mockClear()
  })

  it('并发 bump 版本号严格递增不重复，每次 set 独立携带自己的补丁', async () => {
    await Promise.all([
      bumpIndexVersion(['a1', 'a2']),
      bumpIndexVersion(['b1']),
      bumpIndexVersion(null),
      bumpIndexVersion([]),
    ])

    // 读改写竞态修复后：4 次写入的版本号必须互不相同（否则后一个 idxPatch 覆盖前一个 → 补丁丢失）
    const versions = setSpy.mock.calls.map((c) => (c[0] as { indexVersion: number }).indexVersion).sort((x, y) => x - y)
    expect(versions).toEqual([1, 2, 3, 4])
    expect(await getIndexVersion()).toBe(4)

    // 最后一次 set 落盘的是它自己的补丁（后续 onChanged 事件总能读到成对的 version+plan）
    const last = setSpy.mock.calls.at(-1)![0] as { indexVersion: number; idxPatch: { seq: number; ids: string[] | null } }
    expect(last.idxPatch.seq).toBe(last.indexVersion)
    expect(last.idxPatch.ids).toEqual([])
  })

  it('缺省 patches 落盘 null 计划（面板读到 plan 缺失 → 发 ids=undefined → worker 全量重建）', async () => {
    await bumpIndexVersion()
    expect(store.get('idxPatch')).toBeNull()
    expect(await getIndexVersion()).toBe(1)
  })

  it('显式 null patches 落盘全量重建计划（ids=null）', async () => {
    await bumpIndexVersion(null)
    const saved = store.get('idxPatch') as { seq: number; ids: string[] | null }
    expect(saved.ids).toBeNull()
    expect(saved.seq).toBe(await getIndexVersion())
  })
})
