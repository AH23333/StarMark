import 'fake-indexeddb/auto'
import { describe, expect, it, beforeEach, vi } from 'vitest'
import { parseTagsJson, buildTagPrompt, saveAiSettings } from './provider'
import {
  approveSuggestions,
  getAiPipelineState,
  pendingSuggestions,
  rejectSuggestions,
  runAiSuggestPipeline,
} from './pipeline'
import { db, upsertItems } from '../db'
import { getAppMeta } from '../db'
import type { AiPipelineState } from './pipeline'
import type { StarItem } from '../types'

/**
 * runAiSuggestPipeline 现在是"状态落盘后立即返回、循环后台跑"的语义；
 * 测试里轮询等待后台循环完成，拿到最终状态。
 */
async function runAndWait(maxItems?: number): Promise<AiPipelineState> {
  const started = await runAiSuggestPipeline(maxItems)
  if (!started.running) return started
  for (let i = 0; i < 1000; i++) {
    await new Promise((r) => setTimeout(r, 20))
    const s = await getAiPipelineState()
    if (!s.running) return s
  }
  throw new Error('pipeline did not finish in time')
}

// provider/pipeline/version 都依赖 chrome.storage.local；内存 Map 顶替
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

function item(id: string, urlPath: string, extra: Partial<StarItem> = {}): StarItem {
  const url = `https://github.com/${urlPath}`
  return { id, url, title: urlPath, description: '', sources: ['star'], createdAt: 1000, updatedAt: 1000, ...extra }
}

beforeEach(async () => {
  store.clear()
  await db.delete()
  await db.open()
})

describe('parseTagsJson（模型输出容错）', () => {
  it('解析纯数组、代码围栏、带前后缀文本', () => {
    expect(parseTagsJson('["frontend","react"]')).toEqual(['frontend', 'react'])
    expect(parseTagsJson('```json\n["a","b"]\n```')).toEqual(['a', 'b'])
    expect(parseTagsJson('好的，建议如下：["x", "y"] 以上。')).toEqual(['x', 'y'])
  })

  it('非法输出返回空数组并截断到 8 个', () => {
    expect(parseTagsJson('不是 JSON')).toEqual([])
    expect(parseTagsJson('{"a":1}')).toEqual([])
    const many = JSON.stringify(Array.from({ length: 20 }, (_, i) => `t${i}`))
    expect(parseTagsJson(many).length).toBe(8)
  })
})

describe('buildTagPrompt', () => {
  it('包含标题与已有标签提示', () => {
    const p = buildTagPrompt({ title: 'next.js', description: 'framework', notes: '常用', existingTags: ['js'] })
    expect(p).toContain('next.js')
    expect(p).toContain('framework')
    expect(p).toContain('常用')
    expect(p).toContain('js')
  })
})

describe('建议桶流水线（fetch mock）', () => {
  it('产出 pending 建议；批准并入标签并维护计数；拒绝后不重提', async () => {
    // updatedAt 不同 → orderBy(reverse) 顺序确定：b(2000) 先处理，a(1000) 后处理
    await upsertItems([
      item('a', 'o/a', { tags: ['existing'], updatedAt: 1000 }),
      item('b', 'o/b', { updatedAt: 2000 }),
    ])
    await saveAiSettings({ enabled: true, provider: 'openai', apiKey: 'k', model: 'm' })

    const responses = [
      { choices: [{ message: { content: '["react","Existing","new1"]' } }] }, // b：无已有标签 → 3 条全进桶
      { choices: [{ message: { content: '["react","dev"]' } }] }, // a：已有 existing → react 保留，dev 新增
    ]
    let call = 0
    const fetchMock = vi.fn(async (): Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }> => {
      const data = responses[Math.min(call++, responses.length - 1)]!
      return { ok: true, status: 200, json: async () => data }
    })
    vi.stubGlobal('fetch', fetchMock)

    const state = await runAndWait()
    expect(state.running).toBe(false)
    expect(state.scanned).toBe(2)
    expect(state.suggested).toBe(5) // b: 3 + a: 2（react 与已有标签无冲突保留；dev 新增）

    const pending = await pendingSuggestions()
    expect(pending.length).toBe(5)
    expect(pending.every((p) => p.status === 'pending')).toBe(true)

    // b 收到的 "Existing" 与其标签无冲突 → 保留；a 的 dev/react 均入桶
    const bTags = pending.filter((p) => p.itemId === 'b').map((p) => p.tag)
    expect(bTags).toEqual(expect.arrayContaining(['react', 'Existing', 'new1']))
    const aTags = pending.filter((p) => p.itemId === 'a').map((p) => p.tag)
    expect(aTags).toEqual(expect.arrayContaining(['react', 'dev']))

    // 批准 b 的全部建议 → 并入标签、维护计数、桶清空对应行
    const bIds = pending.filter((p) => p.itemId === 'b').map((p) => p.id)
    await approveSuggestions(bIds)
    const rowB = await db.items.get('b')
    expect(rowB?.tags).toEqual(expect.arrayContaining(['react', 'Existing', 'new1']))
    expect((await getAppMeta()).tags['react']).toBe(1) // 只统计已批准并入的（b）；a 的 react 仍在桶里待审
    expect((await pendingSuggestions()).length).toBe(2) // 只剩 a 的两条

    // 拒绝 a 的两条 → 再跑一遍流水线：b 的三条已是标签（去重）、a 的两条已拒绝不重提
    const restIds = (await pendingSuggestions()).map((p) => p.id)
    await rejectSuggestions(restIds)
    call = 0
    const again = await runAndWait()
    expect(again.suggested).toBe(0)
    expect((await pendingSuggestions()).length).toBe(0)
  })

  it('可恢复：中断后按检查点续跑，不重复产建议', async () => {
    await upsertItems([
      item('a', 'o/a', { updatedAt: 3000 }),
      item('b', 'o/b', { updatedAt: 2000 }),
      item('c', 'o/c', { updatedAt: 1000 }),
    ])
    await saveAiSettings({ enabled: true, provider: 'openai', apiKey: 'k', model: 'm' })

    const responses = [
      { choices: [{ message: { content: '["x1"]' } }] },
      { choices: [{ message: { content: '["x2"]' } }] },
      { choices: [{ message: { content: '["x3"]' } }] },
    ]
    let call = 0
    vi.stubGlobal('fetch', vi.fn(async () => {
      const data = responses[Math.min(call++, responses.length - 1)]!
      return { ok: true, status: 200, json: async () => data }
    }))

    const state = await getAiPipelineState()
    expect(state.running).toBe(false)
    await runAndWait()
    const ids1 = (await db.suggestions.toArray()).map((s) => s.id)
    expect(ids1.length).toBe(3)

    // 续跑：所有条目都已有 pending 建议 → 不再新增
    const again = await runAndWait()
    expect(again.suggested).toBe(0)
    expect((await db.suggestions.toArray()).length).toBe(3)
  })

  it('AI 未启用时流水线直接返回错误状态，不产建议', async () => {
    await saveAiSettings({ enabled: false, provider: 'openai', apiKey: '', model: 'm' })
    await upsertItems([item('a', 'o/a')])
    const state = await runAiSuggestPipeline()
    expect(state.running).toBe(false)
    expect(state.error).toBeTruthy()
    expect((await pendingSuggestions()).length).toBe(0)
  })

  it('Ollama 免 API Key：enabled + ollama 即可跑通流水线（AI 无法调用的根因回归）', async () => {
    await upsertItems([item('a', 'o/a', { updatedAt: 1000 })])
    await saveAiSettings({ enabled: true, provider: 'ollama', apiKey: '', model: 'llama3.2' })

    let chatPrompt = ''
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: { body?: string }) => {
      const body = JSON.parse(init?.body ?? '{}') as { messages: { content: string }[]; model: string; stream: boolean }
      chatPrompt = body.messages[0]?.content ?? ''
      expect(body.model).toBe('llama3.2')
      expect(body.stream).toBe(false)
      // 断言请求发往 Ollama 而非 OpenAI 端点（旧实现入口拦截后根本不会发请求）
      return {
        ok: true,
        status: 200,
        json: async () => ({ message: { content: '["local","ollama"]' } }),
      }
    }))

    const state = await runAndWait()
    expect(state.running).toBe(false)
    expect(state.error).toBeUndefined()
    expect(state.scanned).toBe(1)
    expect(state.suggested).toBe(2)
    expect(chatPrompt).toContain('o/a')

    const pending = await pendingSuggestions()
    expect(pending.map((p) => p.tag).sort()).toEqual(['local', 'ollama'])
  })

  it('云端服务商缺 Key 时错误信息可区分（不再是笼统的未配置 Key）', async () => {
    await saveAiSettings({ enabled: true, provider: 'openai', apiKey: '', model: 'm' })
    await upsertItems([item('a', 'o/a')])
    const state = await runAiSuggestPipeline()
    expect(state.error).toContain('API Key')
    expect(state.running).toBe(false)
  })

  it('防重入：运行中重复触发立即返回当前状态，不并发跑两个循环（消息改启动即返回的回归）', async () => {
    await upsertItems([
      item('a', 'o/a', { updatedAt: 3000 }),
      item('b', 'o/b', { updatedAt: 2000 }),
    ])
    await saveAiSettings({ enabled: true, provider: 'openai', apiKey: 'k', model: 'm' })

    // 模拟慢推理：第一条请求挂起直到放行
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    let call = 0
    vi.stubGlobal('fetch', vi.fn(async () => {
      call++
      await gate
      return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '["t1"]' } }] }) }
    }))

    const started = await runAiSuggestPipeline() // 状态落盘后立即返回，循环后台卡在第一条
    expect(started.running).toBe(true)
    const second = await runAiSuggestPipeline() // 防重入：立即返回当前状态，不并发跑循环
    expect(second.running).toBe(true)

    release()
    // 等后台循环完成
    for (let i = 0; i < 1000; i++) {
      await new Promise((r) => setTimeout(r, 20))
      const s = await getAiPipelineState()
      if (!s.running) break
    }
    // 若无防护，第二次触发会并发处理同样的条目 → fetch 次数翻倍
    expect(call).toBe(2)
    expect((await getAiPipelineState()).suggested).toBe(2)
    expect((await getAiPipelineState()).running).toBe(false)
  })

  it('默认跑完全部候选条目（不再每次只处理 30 条）', async () => {
    // 造 35 条，超过旧的 30 条上限
    const items = Array.from({ length: 35 }, (_, i) => item(`x${i}`, `o/x${i}`, { updatedAt: 5000 - i }))
    await upsertItems(items)
    await saveAiSettings({ enabled: true, provider: 'openai', apiKey: 'k', model: 'm' })
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true, status: 200,
      json: async () => ({ choices: [{ message: { content: '["tag1"]' } }] }),
    })))
    const state = await runAndWait()
    expect(state.running).toBe(false)
    expect(state.scanned).toBe(35)
    expect((await db.suggestions.toArray()).filter((s) => s.status === 'pending').length).toBe(35)
  })
})
