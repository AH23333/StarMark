import 'fake-indexeddb/auto'
import { describe, expect, it, beforeEach, vi } from 'vitest'
import { isAiConfigured, parseTagsJson, saveAiSettings, getAiSettings, listOllamaModels, normalizeOllamaBase } from './provider'

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

beforeEach(async () => { store.clear() })

describe('parseTagsJson（模型输出容错）', () => {
  it('解析纯数组、代码围栏、带前后缀文本', () => {
    expect(parseTagsJson('["frontend","react"]')).toEqual(['frontend', 'react'])
    expect(parseTagsJson('```json\n["a","b"]\n```')).toEqual(['a', 'b'])
    expect(parseTagsJson('好的，建议如下：["x", "y"] 以上。')).toEqual(['x', 'y'])
  })
  it('非法输出返回空数组并截断到 8 个', () => {
    expect(parseTagsJson('不是 JSON')).toEqual([])
    const many = JSON.stringify(Array.from({ length: 20 }, (_, i) => `t${i}`))
    expect(parseTagsJson(many).length).toBe(8)
  })
})

describe('AI 设置的 ollama 字段', () => {
  it('默认配置含本机 Ollama 端点；保存读取往返一致', async () => {
    const d = await getAiSettings()
    expect(d.ollamaBaseUrl).toBe('')
    await saveAiSettings({ ...d, enabled: true, provider: 'ollama', ollamaBaseUrl: 'http://127.0.0.1:11434' })
    const s = await getAiSettings()
    expect(s.provider).toBe('ollama')
    expect(s.ollamaBaseUrl).toBe('http://127.0.0.1:11434')
  })
})

describe('isAiConfigured（Ollama 免 Key 豁免 —— AI 无法调用的根因回归）', () => {
  it('ollama 无 Key 也算已配置；云端服务商必须有 Key；总开关优先', () => {
    expect(isAiConfigured({ enabled: true, provider: 'ollama', apiKey: '', model: 'llama3.2' })).toBe(true)
    expect(isAiConfigured({ enabled: true, provider: 'openai', apiKey: 'sk-x', model: 'm' })).toBe(true)
    expect(isAiConfigured({ enabled: true, provider: 'openai', apiKey: '', model: 'm' })).toBe(false)
    expect(isAiConfigured({ enabled: false, provider: 'ollama', apiKey: '', model: 'm' })).toBe(false)
  })
})

describe('Ollama 连接', () => {
  it('listOllamaModels 解析 /api/tags', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true, status: 200,
      json: async () => ({ models: [{ name: 'llama3.2:latest' }, { name: 'qwen2.5:7b' }] }),
    })))
    const models = await listOllamaModels({ enabled: true, provider: 'ollama', apiKey: '', model: 'llama3.2' })
    expect(models).toEqual(['llama3.2:latest', 'qwen2.5:7b'])
  })

  it('ollama 404 给出启动服务提示', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 404, text: async () => '' })))
    await expect(listOllamaModels({ enabled: true, provider: 'ollama', apiKey: '', model: '' })).rejects.toThrow(/Ollama/)
  })

  it('ollama 403 给出 OLLAMA_ORIGINS 来源白名单指引（≥0.1.47 拒绝扩展 Origin）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 403, text: async () => '' })))
    await expect(listOllamaModels({ enabled: true, provider: 'ollama', apiKey: '', model: '' })).rejects.toThrow(/OLLAMA_ORIGINS/)
  })

  it('连接失败（fetch 抛错）给可操作提示而非裸 TypeError', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new TypeError('Failed to fetch')
    }))
    const { suggestTagsViaAi } = await import('./provider')
    await expect(
      suggestTagsViaAi({ enabled: true, provider: 'ollama', apiKey: '', model: 'llama3.2' }, 'p'),
    ).rejects.toThrow(/无法连接本地 Ollama/)
  })
})


describe('normalizeOllamaBase（地址规范化与校验）', () => {
  it('空值回退默认本机端点（127.0.0.1，避免 localhost 的 IPv6 歧义）；无协议自动补 http://', () => {
    expect(normalizeOllamaBase('')).toBe('http://127.0.0.1:11434')
    expect(normalizeOllamaBase(undefined)).toBe('http://127.0.0.1:11434')
    expect(normalizeOllamaBase('localhost:11434')).toBe('http://localhost:11434')
    expect(normalizeOllamaBase('  http://192.168.1.5:11434/  ')).toBe('http://192.168.1.5:11434')
  })

  it('端口越界（如 114134）抛出可读错误', () => {
    expect(() => normalizeOllamaBase('http://localhost:114134')).toThrow(/114134/)
    expect(() => normalizeOllamaBase('http://localhost:0')).toThrow(/端口/)
    expect(() => normalizeOllamaBase('http://localhost:99999')).toThrow(/11434/)
  })

  it('格式错误抛出示例提示', () => {
    expect(() => normalizeOllamaBase('http://')).toThrow(/示例/)
  })
})
