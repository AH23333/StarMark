import { browser } from 'wxt/browser'

/**
 * LLM Provider 抽象（开发技术文档 §17）：用户自带 Key（BYOK），默认关闭。
 * 统一 chat 接口，输出纯 JSON 数组字符串由调用方解析。
 */

export type ProviderKind = 'openai' | 'anthropic' | 'ollama'

export interface AiSettings {
  enabled: boolean
  provider: ProviderKind
  apiKey: string
  /** OpenAI 兼容端点（可指向代理/本地网关） */
  baseUrl?: string
  model: string
  /** Ollama 本地服务地址（默认本机 11434） */
  ollamaBaseUrl?: string
}

export const DEFAULT_AI_SETTINGS: AiSettings = {
  enabled: false,
  provider: 'openai',
  apiKey: '',
  baseUrl: '',
  model: 'gpt-4o-mini',
  ollamaBaseUrl: '',
}

// 注意：storage key 必须是稳定且互不冲突的真实字面量。
// 曾经四个模块的 key 全部被写成占位符 '***' —— AI 设置 / 建议流水线 / 分类结果 /
// 分类状态互相覆盖（第一批分类跑完就冲掉 AI 设置 → "AI 未启用"），此处修复并留档。
export const AI_KEY = 'ai.settings'

export async function getAiSettings(): Promise<AiSettings> {
  const s = await browser.storage.local.get(AI_KEY)
  const raw = s[AI_KEY] as Partial<AiSettings> | undefined
  return raw ? { ...DEFAULT_AI_SETTINGS, ...raw } : { ...DEFAULT_AI_SETTINGS }
}

export async function saveAiSettings(settings: AiSettings): Promise<void> {
  await browser.storage.local.set({ [AI_KEY]: settings })
}

export class AiDisabledError extends Error {
  constructor() {
    super('AI 功能未启用')
    this.name = 'AiDisabledError'
  }
}

/**
 * 统一的"AI 已配置可用"判断（二轮修复）：Ollama 是本地服务、不需要 API Key，
 * 此前 pipeline 入口漏掉该豁免导致选 Ollama 后直接报"AI 未启用或未配置 Key"，
 * 模型调用根本不会发起。所有入口检查必须走这里，禁止再手写 apiKey 判断。
 */
export function isAiConfigured(settings: AiSettings): boolean {
  if (!settings.enabled) return false
  if (settings.provider === 'ollama') return true
  return settings.apiKey.trim().length > 0
}

/** 给定条目文本，返回建议标签（纯 JSON 数组）。 */
export async function suggestTagsViaAi(settings: AiSettings, prompt: string): Promise<string[]> {
  if (!isAiConfigured(settings)) throw new AiDisabledError()
  const content = await chat(settings, prompt)
  return parseTagsJson(content)
}

/**
 * 长请求保活（修复"生成中卡住"）：MV3 SW 的 idle 计时器（约 30s）只被**扩展 API 调用**
 * 重置，fetch 挂起不算活动 —— 本地模型推理一批可达数十秒甚至数分钟，期间无任何扩展
 * API 调用，SW 会被浏览器回收，任务死在中途而状态停留在 running=true（UI 永远"生成中"）。
 * 在请求等待期间每 20s 做一次无害的 storage 读取，持续重置 idle 计时器。
 */
export async function keepAliveDuring<T>(p: Promise<T>): Promise<T> {
  let done = false
  let wake: () => void = () => undefined
  const sleeper = (): Promise<void> =>
    new Promise<void>((resolve) => {
      const t = setTimeout(resolve, 20_000)
      wake = () => {
        clearTimeout(t)
        resolve()
      }
    })
  const beat = (async () => {
    while (!done) {
      try {
        await browser.storage.local.get('_keepalive')
      } catch {
        return // storage 不可用（测试 mock 精简环境）时放弃保活，不干扰主请求
      }
      if (done) return
      await sleeper()
    }
  })()
  try {
    return await p
  } finally {
    done = true
    wake() // 主请求结束后立即唤醒心跳（否则要等满 20s 才退出）
    await beat
  }
}

/** 解析模型输出：容忍代码围栏/前后缀文本，只取第一个 JSON 数组。 */
export function parseTagsJson(raw: string): string[] {
  const text = raw.replace(/```(?:json)?/gi, '')
  const start = text.indexOf('[')
  const end = text.lastIndexOf(']')
  if (start < 0 || end <= start) return []
  try {
    const arr = JSON.parse(text.slice(start, end + 1)) as unknown
    if (!Array.isArray(arr)) return []
    return arr
      .map((x) => (typeof x === 'string' ? x.trim() : ''))
      .filter((v): v is string => Boolean(v))
      .slice(0, 8)
  } catch {
    return []
  }
}

/**
 * 统一 chat 入口（全 Provider 挂心跳 + 可选中止信号）。
 * signal 用于"暂停/停止"：abort 后 fetch 立即断开，本地 Ollama 检测到客户端断开
 * 会停止当前推理（不再把整批算完）。
 */
async function chat(settings: AiSettings, prompt: string, jsonMode = false, signal?: AbortSignal): Promise<string> {
  if (settings.provider === 'anthropic') return keepAliveDuring(chatAnthropic(settings, prompt, signal))
  if (settings.provider === 'ollama') return keepAliveDuring(chatOllama(settings, prompt, jsonMode, signal))
  return keepAliveDuring(chatOpenAiCompatible(settings, prompt, jsonMode, signal))
}

/** 强制 JSON 输出的对话（批量分类用；Ollama 走 format:json，OpenAI 走 response_format）。 */
export async function chatJson(settings: AiSettings, prompt: string, signal?: AbortSignal): Promise<string> {
  return chat(settings, prompt, true, signal)
}

async function chatOpenAiCompatible(settings: AiSettings, prompt: string, jsonMode = false, signal?: AbortSignal): Promise<string> {
  const base = (settings.baseUrl?.trim() || 'https://api.openai.com/v1').replace(/\/$/, '')
  const res = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${settings.apiKey}`,
    },
    signal,
    body: JSON.stringify({
      model: settings.model,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.2,
      max_tokens: 4000,
      ...(jsonMode ? { response_format: { type: 'json_object' } } : {}),
    }),
  })
  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new Error(`AI 请求失败 (${res.status}) ${detail.slice(0, 160)}`)
  }
  const data = (await res.json()) as { choices?: { message?: { content?: string } }[] }
  return data.choices?.[0]?.message?.content ?? ''
}

async function chatAnthropic(settings: AiSettings, prompt: string, signal?: AbortSignal): Promise<string> {
  const base = (settings.baseUrl?.trim() || 'https://api.anthropic.com').replace(/\/$/, '')
  const res = await fetch(`${base}/v1/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': settings.apiKey,
      'anthropic-version': '2023-06-01',
    },
    signal,
    body: JSON.stringify({
      model: settings.model || 'claude-3-5-haiku-latest',
      max_tokens: 200,
      messages: [{ role: 'user', content: prompt }],
    }),
  })
  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new Error(`AI 请求失败 (${res.status}) ${detail.slice(0, 160)}`)
  }
  const data = (await res.json()) as { content?: { text?: string }[] }
  return data.content?.map((c) => c.text ?? '').join('') ?? ''
}

/**
 * 建议标签的提示词：只输出 JSON 数组。
 * @param globalTags 全库高频标签（流水线启动时取 top20）：让模型优先复用现有标签，
 * 而不是为每个条目自创新词 —— 缓解"一个标签只有一个条目"的标签碎片化。
 */
export function buildTagPrompt(input: {
  title: string
  description?: string
  notes?: string
  existingTags?: string[]
  globalTags?: string[]
}): string {
  const lines = [
    '为下面的收藏条目建议 2-4 个简短标签（小写、单词或短词组，不要重复该条目已有的标签）。',
    input.globalTags?.length
      ? '优先从【全局常用标签】中选择最贴切的；仅当都不合适时才新建通用、简短的新标签，避免制造只有一条目使用的孤立标签。'
      : '标签要通用、简短，便于跨条目聚合。',
    '只输出一个 JSON 字符串数组，不要任何解释。',
    '',
    `标题：${input.title}`,
  ]
  if (input.globalTags?.length) lines.push(`【全局常用标签】${input.globalTags.join(', ')}`)
  if (input.description) lines.push(`描述：${input.description}`)
  if (input.notes) lines.push(`备注：${input.notes}`)
  if (input.existingTags?.length) lines.push(`该条目已有标签：${input.existingTags.join(', ')}`)
  return lines.join('\n')
}

/**
 * Ollama 地址规范化：trim、补协议头、校验端口范围；非法输入抛可读错误。
 * 默认 127.0.0.1（修复）：`localhost` 在部分环境解析为 IPv6 ::1，而 Ollama 默认
 * 只监听 IPv4 的 127.0.0.1，会造成"连接被拒"；显式 127.0.0.1 消除歧义。
 */
export const DEFAULT_OLLAMA_BASE = 'http://127.0.0.1:11434'

export function normalizeOllamaBase(input: string | undefined): string {
  const raw = (input ?? '').trim()
  const withProto = /^https?:\/\//i.test(raw) ? raw : (raw ? 'http://' + raw : DEFAULT_OLLAMA_BASE)
  let url: URL
  try {
    url = new URL(withProto)
  } catch {
    throw new Error("Ollama 地址格式不正确：" + raw + "（示例：http://127.0.0.1:11434）")
  }
  const port = url.port === '' ? '80' : url.port
  const portNum = Number(port)
  if (!Number.isInteger(portNum) || portNum < 1 || portNum > 65535) {
    throw new Error("Ollama 端口不合法：" + url.port + "（应在 1-65535 之间；Ollama 默认 11434，注意别多打或少打数字）")
  }
  return withProto.replace(/\/$/, '')
}

export async function ollamaBaseUrlOf(settings: AiSettings): Promise<string> {
  return normalizeOllamaBase(settings.ollamaBaseUrl)
}

/**
 * Ollama 对带 Origin 的请求做来源白名单校验（≥0.1.47）：扩展发出的请求 Origin 是
 * chrome-extension://<id>，不在默认白名单 → 一律 403。扩展后台会用 declarativeNetRequest
 * 自动移除发往本机回环地址请求的 Origin 头来放行；若规则未生效，按报错指引设置
 * OLLAMA_ORIGINS 即可。
 */
function ollamaOriginHint(): string {
  const extId = (() => {
    try {
      return browser.runtime.id ?? '<extension-id>'
    } catch {
      return '<extension-id>'
    }
  })()
  return [
    'Ollama 拒绝了扩展的请求（403，来源白名单）。',
    '修复方式二选一：',
    `1) 重启 Ollama 前设置环境变量 OLLAMA_ORIGINS="chrome-extension://${extId}"（或设为 * ）`,
    '2) Windows PowerShell 示例: $env:OLLAMA_ORIGINS="*"; ollama serve',
  ].join('\n')
}

async function chatOllama(settings: AiSettings, prompt: string, jsonMode = false, signal?: AbortSignal): Promise<string> {
  const base = await ollamaBaseUrlOf(settings)
  let res: Response
  try {
    res = await fetch(`${base}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal,
      body: JSON.stringify({
        model: settings.model || 'llama3.2',
        messages: [{ role: 'user', content: prompt }],
        stream: false,
        format: jsonMode ? 'json' : undefined,
        options: { temperature: 0.2, num_ctx: 8192 },
      }),
    })
  } catch (e) {
    // 用户主动中止（暂停）：原样透传 AbortError，让上层按"优雅停止"处理
    if ((e as Error).name === 'AbortError') throw e
    // fetch 层失败（连接拒绝 / IPv6 歧义 / 浏览器策略拦截）：给可操作的上下文
    throw new Error(`无法连接本地 Ollama（${base}）：${(e as Error).message}。请确认已运行 ollama serve，且地址/端口正确`)
  }
  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    if (res.status === 404) throw new Error('Ollama 端点不存在（已尝试 ' + base + '/api/chat）：请确认服务已启动（ollama serve）且地址正确')
    if (res.status === 403) throw new Error(ollamaOriginHint())
    throw new Error(`Ollama 请求失败 (${base}/api/chat -> ${res.status}) ${detail.slice(0, 160)}`)
  }
  const data = (await res.json()) as { message?: { content?: string } }
  return data.message?.content ?? ''
}

/** 连接测试：列出本地可用模型，用于设置页"测试连接"。返回模型名列表。 */
export async function listOllamaModels(settings: AiSettings): Promise<string[]> {
  const base = await ollamaBaseUrlOf(settings)
  const res = await fetch(`${base}/api/tags`)
  if (!res.ok) {
    if (res.status === 403) throw new Error(ollamaOriginHint())
    throw new Error(`Ollama 连接失败 (${base}/api/tags -> ${res.status})`)
  }
  const data = (await res.json()) as { models?: { name: string }[] }
  return (data.models ?? []).map((m) => m.name)
}