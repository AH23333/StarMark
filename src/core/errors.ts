/**
 * 带分类码的错误基类（代码洞察 C4）：message 保留现有可读文案（行为不变），
 * code 供 UI 程序化识别（如按 getLang() 渲染不同语言指引、按 name 静默中止）。
 * 渐进迁移：AI 域高频抛错点已接入，其余模块随迭代跟进。
 */

export class AppError extends Error {
  /** 错误分类码（如 'ai.ollamaOrigin'），UI 可据此走特定词典/处理分支 */
  readonly code: string
  readonly vars?: Record<string, string | number>

  constructor(code: string, message: string, vars?: Record<string, string | number>) {
    super(message)
    this.name = 'AppError'
    this.code = code
    this.vars = vars
  }
}

/** AI 未启用或配置不完整（缺 Key） */
export class AiConfigError extends AppError {
  constructor(message = 'AI 未启用或未配置 Key') {
    super('ai.config', message)
    this.name = 'AiConfigError'
  }
}

/** AI 请求被限流 */
export class AiRateLimitError extends AppError {
  constructor(detail?: string) {
    super('ai.rateLimit', 'GitHub 速率限制，请稍后重试' + (detail ? `（${detail}）` : ''))
    this.name = 'AiRateLimitError'
  }
}

/** Ollama 来源白名单拒绝（403），message 含 OLLAMA_ORIGINS 修复指引 */
export class OllamaOriginError extends AppError {
  constructor(hint: string) {
    super('ai.ollamaOrigin', hint)
    this.name = 'OllamaOriginError'
  }
}

/** 无法连接本地 Ollama（连接拒绝 / 地址错误） */
export class OllamaConnectError extends AppError {
  constructor(base: string, cause: string) {
    super('ai.ollamaConnect', `无法连接本地 Ollama（${base}）：${cause}。请确认已运行 ollama serve，且地址/端口正确`, { base })
    this.name = 'OllamaConnectError'
  }
}

/** 用户主动中止（暂停）——UI 通常静默处理 */
export class AbortedError extends AppError {
  constructor() {
    super('aborted', 'aborted')
    this.name = 'AbortedError'
  }
}
