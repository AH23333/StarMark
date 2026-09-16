import { browser } from 'wxt/browser'

/**
 * LLM Provider 抽象（开发技术文档 §17）：用户自带 Key（BYOK），默认关闭。
 * 统一 chat 接口，输出纯 JSON 数组字符串由调用方解析。
 */

export type ProviderKind = 'openai' | 'anthropic'

export interface AiSettings {
  enabled: boolean
  provider: ProviderKind
  apiKey: string
  /** OpenAI 兼容端点（可指向代理/本地网关） */
  baseUrl?: string
  model: string
}

export const DEFAULT_AI_SETTINGS: AiSettings = {
  enabled: false,
  provider: 'openai',
  apiKey: '',
  baseUrl: '',
  model: 'gpt-4o-mini',
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
  if (!settings.enabled || !settings.apiKey) throw new AiDisabledError()
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

async function chat(settings: AiSettings, prompt: string): Promise<string> {
  if (settings.provider === 'anthropic') return chatAnthropic(settings, prompt)
  return chatOpenAiCompatible(settings, prompt)
}

async function chatOpenAiCompatible(settings: AiSettings, prompt: string): Promise<string> {
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
      max_tokens: 200,
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
