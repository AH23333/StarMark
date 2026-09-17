import 'fake-indexeddb/auto'
import { describe, expect, it, beforeEach, vi } from 'vitest'
import { buildClassifyPrompt, groupsFromAssignments, parseClassifyResponse, seedCategories, runClassify, pauseClassify, getClassifyState } from './classify'
import { db, upsertItems } from '../db'
import type { StarItem } from '../types'

// runClassify/pauseClassify 依赖 chrome.storage.local；内存 Map 顶替
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

function mk(id: string, tags?: string[]): StarItem {
  return { id, url: 'https://x/' + id, title: id, description: '', sources: ['star'], createdAt: 1, updatedAt: 1, tags }
}

beforeEach(async () => {
  store.clear()
  await db.delete()
  await db.open()
})

describe('buildClassifyPrompt', () => {
  it('包含编号条目、参考类别与 JSON 格式约束', () => {
    const p = buildClassifyPrompt(
      [ { index: 1, id: 'a', title: 'next.js', desc: 'framework' }, { index: 2, id: 'b', title: 'obsidian', desc: '' } ],
      ['前端', '阅读'],
    )
    expect(p).toContain('1. next.js｜framework')
    expect(p).toContain('2. obsidian')
    expect(p).toContain('【参考类别】前端、阅读')
    expect(p).toContain('"items"')
  })
})

describe('parseClassifyResponse（三种形态兼容）', () => {
  const idByIndex = new Map([[1, 'a'], [2, 'b']])

  it('items 形态', () => {
    const m = parseClassifyResponse('{"items":[{"i":1,"tags":["前端"]},{"i":2,"tags":["阅读","工具"]}]}', idByIndex)
    expect(m.get('a')).toEqual(['前端'])
    expect(m.get('b')).toEqual(['阅读', '工具'])
  })

  it('categories 形态', () => {
    const m = parseClassifyResponse('{"categories":[{"tag":"AI","ids":["a"]},{"tag":"工具","ids":["b","a"]}]}', idByIndex)
    expect(m.get('a')).toEqual(['AI', '工具'])
    expect(m.get('b')).toEqual(['工具'])
  })

  it('裸数组与围栏/前后缀容错', () => {
    const m1 = parseClassifyResponse('[{"i":1,"tags":["x"]}]', idByIndex)
    expect(m1.get('a')).toEqual(['x'])
    const m2 = parseClassifyResponse('好的：{"items":[{"i":2,"tags":["y"]}]} 完毕', idByIndex)
    expect(m2.get('b')).toEqual(['y'])
    expect(parseClassifyResponse('完全不是 JSON', idByIndex).size).toBe(0)
  })
})

describe('seedCategories / groupsFromAssignments', () => {
  it('种子按频次取前 N', () => {
    const items = [mk('a', ['x', 'y']), mk('b', ['x']), mk('c', ['x', 'z'])]
    expect(seedCategories(items, 2)).toEqual(['x', 'y'])
  })

  it('assignments 反推分组并按条目数降序', () => {
    const groups = groupsFromAssignments({ a: ['x'], b: ['x', 'z'], c: ['x'] })
    expect(groups[0]).toEqual({ tag: 'x', itemIds: ['a', 'b', 'c'] })
    expect(groups[1]!.tag).toBe('z')
  })
})

describe('批量分类暂停与断点（UI 合并后单一入口的回归）', () => {
  it('暂停：cancelRequested 在批边界优雅停止并标记 paused，续跑从断点恢复', async () => {
    // 51 条 → 2 批（50/批）
    const items = Array.from({ length: 51 }, (_, i) => mk(`i${i}`))
    await upsertItems(items)
    const { saveAiSettings } = await import('./provider')
    await saveAiSettings({ enabled: true, provider: 'openai', apiKey: 'k', model: 'm' })

    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    let call = 0
    vi.stubGlobal('fetch', vi.fn(async () => {
      call++
      if (call === 1) await gate // 第一批挂起，模拟推理中
      return { ok: true, status: 200, json: async () => '{"items":[]}' }
    }))

    await runClassify()
    for (let i = 0; i < 100 && call < 1; i++) await new Promise((r) => setTimeout(r, 20))
    // 第一批推理中请求暂停（写 cancelRequested）
    const paused1 = await pauseClassify()
    expect(paused1.running).toBe(true) // 循环存活 → 仅标记，批边界生效
    release()
    // 等循环在批边界停止
    let final = await getClassifyState()
    for (let i = 0; i < 500 && final.running; i++) {
      await new Promise((r) => setTimeout(r, 20))
      final = await getClassifyState()
    }
    expect(final.running).toBe(false)
    expect(final.paused).toBe(true)
    expect(final.batch).toBe(1) // 第一批完成、第二批未跑
    expect(call).toBe(1)

    // 续跑：从 batch=1 断点继续，处理剩余 1 批
    const { getAiSettings } = await import('./provider')
    const again = await runClassify()
    expect(again.running).toBe(true)
    expect(again.batch).toBe(1)
    let final2 = await getClassifyState()
    for (let i = 0; i < 500 && final2.running; i++) {
      await new Promise((r) => setTimeout(r, 20))
      final2 = await getClassifyState()
    }
    expect(final2.running).toBe(false)
    expect(final2.batch).toBe(2)
    expect(call).toBe(2)
  })

  it('僵尸解除：循环已死但状态仍 running 时，pause 直接落盘暂停态', async () => {
    // 模拟 SW 被杀遗留的僵尸状态
    const { setClassifyState } = await import('./classify')
    await setClassifyState({ running: true, batch: 3, totalBatches: 10, classified: 150 })
    const stopped = await pauseClassify()
    expect(stopped.running).toBe(false)
    expect(stopped.paused).toBe(true)
  })
})
