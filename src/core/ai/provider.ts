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

const AI_KEY = '***'

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

/** 给定条目文本，返回建议标签（纯 JSON 数组）。 */
export async function suggestTagsViaAi(settings: AiSettings, prompt: string): Promise<string[]> {
  if (!settings.enabled) throw new AiDisabledError()
  if (settings.provider !== 'ollama' && !settings.apiKey) throw new AiDisabledError()
  const content = await chat(settings, prompt)
  return parseTagsJson(content)
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

async function chat(settings: AiSettings, prompt: string, jsonMode = false): Promise<string> {
  if (settings.provider === 'anthropic') return chatAnthropic(settings, prompt)
  if (settings.provider === 'ollama') return chatOllama(settings, prompt, jsonMode)
  return chatOpenAiCompatible(settings, prompt, jsonMode)
}

/** 强制 JSON 输出的对话（批量分类用；Ollama 走 format:json，OpenAI 走 response_format）。 */
export async function chatJson(settings: AiSettings, prompt: string): Promise<string> {
  return chat(settings, prompt, true)
}

async function chatOpenAiCompatible(settings: AiSettings, prompt: string, jsonMode = false): Promise<string> {
  const base = (settings.baseUrl?.trim() || 'https://api.openai.com/v1').replace(/\/$/, '')
  const res = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${settings.apiKey}`,
    },
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

async function chatAnthropic(settings: AiSettings, prompt: string): Promise<string> {
  const base = (settings.baseUrl?.trim() || 'https://api.anthropic.com').replace(/\/$/, '')
  const res = await fetch(`${base}/v1/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': settings.apiKey,
      'anthropic-version': '2023-06-01',
    },
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

/** 建议标签的提示词：只输出 JSON 数组。 */
export function buildTagPrompt(input: { title: string; description?: string; notes?: string; existingTags?: string[] }): string {
  const lines = [
    '为下面的收藏条目建议 2-4 个简短标签（小写、单词或短词组，不要重复已有标签）。',
    '只输出一个 JSON 字符串数组，不要任何解释。',
    '',
    `标题：${input.title}`,
  ]
  if (input.description) lines.push(`描述：${input.description}`)
  if (input.notes) lines.push(`备注：${input.notes}`)
  if (input.existingTags?.length) lines.push(`已有标签：${input.existingTags.join(', ')}`)
  return lines.join('\n')
}

/** Ollama 地址规范化：trim、补协议头、校验端口范围；非法输入抛可读错误。 */
export function normalizeOllamaBase(input: string | undefined): string {
  const raw = (input ?? '').trim()
  const withProto = /^https?:\/\//i.test(raw) ? raw : (raw ? 'http://' + raw : 'http://localhost:11434')
  let url: URL
  try {
    url = new URL(withProto)
  } catch {
    throw new Error("Ollama 地址格式不正确：" + raw + "（示例：http://localhost:11434）")
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

async function chatOllama(settings: AiSettings, prompt: string, jsonMode = false): Promise<string> {
  const base = await ollamaBaseUrlOf(settings)
  const res = await fetch(`${base}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: settings.model || 'llama3.2',
      messages: [{ role: 'user', content: prompt }],
      stream: false,
      format: jsonMode ? 'json' : undefined,
      options: { temperature: 0.2, num_ctx: 8192 },
    }),
  })
  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    if (res.status === 404) throw new Error('Ollama 端点不存在（已尝试 ' + base + '/api/chat）：请确认服务已启动（ollama serve）且地址正确')
    throw new Error(`Ollama 请求失败 (${base}/api/chat -> ${res.status}) ${detail.slice(0, 160)}`)
  }
  const data = (await res.json()) as { message?: { content?: string } }
  return data.message?.content ?? ''
}

/** 连接测试：列出本地可用模型，用于设置页"测试连接"。返回模型名列表。 */
export async function listOllamaModels(settings: AiSettings): Promise<string[]> {
  const base = await ollamaBaseUrlOf(settings)
  const res = await fetch(`${base}/api/tags`)
  if (!res.ok) throw new Error(`Ollama 连接失败 (${base}/api/tags -> ${res.status})`)
  const data = (await res.json()) as { models?: { name: string }[] }
  return (data.models ?? []).map((m) => m.name)
}