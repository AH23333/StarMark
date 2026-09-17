import { useEffect, useState } from 'react'
import { browser } from 'wxt/browser'
import zhCN from './locales/zh-CN.json'
import ja from './locales/ja.json'
import en from './locales/en.json'

/*
 * 轻量国际化：三语词典外置到 core/locales/*.json（审查 R5），本文件只保留逻辑。
 * 语言偏好持久化到 storage.local.lang（'auto' 或缺省 = 跟随浏览器 UI 语言）。
 * 核心模块不依赖 React（useT 单独放在本文件最下方，仅 UI 入口导入）。
 */

export type Lang = 'zh-CN' | 'ja' | 'en'

export interface LangOption {
  code: Lang | 'auto'
  native: string
}

export const LANGS: LangOption[] = [
  { code: 'zh-CN', native: '简体中文' },
  { code: 'ja', native: '日本語' },
  { code: 'en', native: 'English' },
]

export const DEFAULT_LANG: Lang = 'zh-CN'

type Dict = Record<string, string>

const dicts: Record<Lang, Dict> = {
  'zh-CN': zhCN as Dict,
  ja: ja as Dict,
  en: en as Dict,
}

function detect(): Lang {
  try {
    const ui = (browser.i18n?.getUILanguage?.() ?? '').toLowerCase()
    if (ui.startsWith('zh')) return 'zh-CN'
    if (ui.startsWith('ja')) return 'ja'
  } catch {
    // 非浏览器环境（测试）忽略
  }
  return DEFAULT_LANG
}

const isLang = (v: unknown): v is Lang => v === 'zh-CN' || v === 'ja' || v === 'en'

let lang: Lang = detect()

const subs = new Set<() => void>()
export function getLang(): Lang {
  return lang
}

function applyLang(next: Lang): void {
  if (next === lang) return
  lang = next
  subs.forEach((f) => f())
}

/** 从浏览器探测或已存偏好解析语言，随后 frames 可能异步落地偏好 */
export async function initI18n(): Promise<void> {
  let stored: string | undefined
  try {
    const s = await browser.storage.local.get('lang')
    stored = s.lang as string | undefined
  } catch {
    stored = undefined
  }
  if (stored === 'auto' || stored === undefined) applyLang(detect())
  else if (isLang(stored)) applyLang(stored)
}

/** 切换语言；'auto' 清除偏好并回退浏览器语言 */
export async function setLang(code: Lang | 'auto'): Promise<void> {
  if (code === 'auto') {
    applyLang(detect())
    try {
      await browser.storage.local.remove('lang')
    } catch {
      // ignore
    }
    return
  }
  applyLang(code)
  try {
    await browser.storage.local.set({ lang: code })
  } catch {
    // ignore
  }
}

export function onLangChange(fn: () => void): () => void {
  subs.add(fn)
  return () => subs.delete(fn)
}

// 单遍占位符替换（性能优化：旧实现每个变量构造一次 new RegExp）
const PLACEHOLDER_RE = /\{(\w+)\}/g

export function t(key: string, vars?: Record<string, string | number>): string {
  let s = dicts[lang]?.[key] ?? dicts[DEFAULT_LANG][key] ?? key
  if (vars) {
    s = s.replace(PLACEHOLDER_RE, (match, k: string) => (vars[k] !== undefined ? String(vars[k]) : match))
  }
  return s
}

/** React hook：语言变化时强制重渲染，返回绑定了当前语言的翻译函数 */
export function useT(): (key: string, vars?: Record<string, string | number>) => string {
  const [, force] = useState(0)
  useEffect(() => onLangChange(() => force((x) => x + 1)), [])
  return t
}

/** 设置页语言项的唯一来源：'auto' 或具体语言 */
export async function getCurrentLangSetting(): Promise<Lang | 'auto'> {
  try {
    const s = await browser.storage.local.get('lang')
    const v = s.lang as Lang | 'auto' | undefined
    return isLang(v) || v === 'auto' ? v : 'auto'
  } catch {
    return 'auto'
  }
}
