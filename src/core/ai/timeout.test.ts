import 'fake-indexeddb/auto'
import { describe, expect, it, beforeEach, vi } from 'vitest'
import { AI_REQUEST_TIMEOUT_MS } from '../constants'
import { chatJson, suggestTagsViaAi } from './provider'
import { AiTimeoutError } from '../errors'

const { store } = vi.hoisted(() => ({ store: new Map<string, unknown>() }))
vi.mock('wxt/browser', () => ({
  browser: { storage: { local: {
    get: vi.fn(async (keys?: any) => {
      const out: Record<string, unknown> = {}
      if (keys == null) { for (const [k, v] of store) out[k] = v; return out }
      const list = typeof keys === 'string' ? [keys] : keys
      for (const k of list) if (store.has(k)) out[k] = store.get(k)
      return out
    }),
    set: vi.fn(async (objs: Record<string, unknown>) => { for (const [k, v] of Object.entries(objs)) store.set(k, v) }),
  }}},
}))

/** 挂起直到 signal 中止的 fetch 替身：真实 fetch 会因 abort 而 reject，替身必须同形，否则超时路径永远测不到 */
const hangUntilAborted = (_url: unknown, init?: RequestInit): Promise<Response> =>
  new Promise<Response>((_, reject) => {
    const s = init?.signal
    if (!s) throw new Error('test: fetch stub expects a signal')
    s.addEventListener('abort', () => reject(s.reason))
  })

beforeEach(() => { vi.unstubAllGlobals(); store.clear() })

describe('AI 请求超时（P-121：fetch 挂起不再无限等）', () => {
  it('openai 兼容端点超时抛 AiTimeoutError 而非挂死', async () => {
    vi.stubGlobal('fetch', vi.fn(hangUntilAborted))
    await expect(
      suggestTagsViaAi({ enabled: true, provider: 'openai', apiKey: 'sk-x', model: 'm' }, 'p', 25),
    ).rejects.toThrow(AiTimeoutError)
  })

  it('anthropic 超时同样抛 AiTimeoutError', async () => {
    vi.stubGlobal('fetch', vi.fn(hangUntilAborted))
    await expect(
      chatJson({ enabled: true, provider: 'anthropic', apiKey: 'sk-x', model: 'claude-3-5-haiku-latest' }, 'p', undefined, 25),
    ).rejects.toThrow(AiTimeoutError)
  })

  it('ollama 超时既不是「连接失败」（OllamaConnectError）也不是「暂停」透传：抛 AiTimeoutError', async () => {
    vi.stubGlobal('fetch', vi.fn(hangUntilAborted))
    await expect(
      chatJson({ enabled: true, provider: 'ollama', apiKey: '', model: 'llama3.2' }, 'p', undefined, 25),
    ).rejects.toThrow(AiTimeoutError)
  })

  it('用户「暂停」中止原样透传 AbortError，不被超时路径吞成 AiTimeoutError', async () => {
    vi.stubGlobal('fetch', vi.fn(hangUntilAborted))
    const ctrl = new AbortController()
    setTimeout(() => ctrl.abort(), 10)
    await expect(
      chatJson({ enabled: true, provider: 'openai', apiKey: 'sk-x', model: 'm' }, 'p', ctrl.signal, 5_000),
    ).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('正常返回不受超时机制影响；默认超时时限与桌面侧 180 s/批 的稳定性取向对齐', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true, status: 200,
      json: async () => ({ choices: [{ message: { content: '["a","b"]' } }] }),
    })))
    const tags = await suggestTagsViaAi({ enabled: true, provider: 'openai', apiKey: 'sk-x', model: 'm' }, 'p', 5_000)
    expect(tags).toEqual(['a', 'b'])
    expect(AI_REQUEST_TIMEOUT_MS).toBe(180_000)
  })
})
