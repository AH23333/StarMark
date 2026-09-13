import { browser } from 'wxt/browser'

export type ThemePreference = 'auto' | 'light' | 'dark'

const STORAGE_KEY = 'theme'

export async function getThemePreference(): Promise<ThemePreference> {
  const s = await browser.storage.local.get(STORAGE_KEY)
  const v = s[STORAGE_KEY] as ThemePreference | undefined
  return v === 'light' || v === 'dark' || v === 'auto' ? v : 'auto'
}

export function resolveTheme(pref: ThemePreference): 'light' | 'dark' {
  if (pref !== 'auto') return pref
  return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'
}

function applyTheme(pref: ThemePreference): void {
  document.documentElement.dataset.theme = resolveTheme(pref)
}

/** 在页面（sidepanel/options）初始化主题：跟随系统 if auto，并监听切换。返回清理函数。 */
export async function initTheme(): Promise<() => void> {
  const mq = window.matchMedia('(prefers-color-scheme: light)')
  const pref = await getThemePreference()
  applyTheme(pref)

  const onSystemChange = () => applyTheme(pref)
  mq.addEventListener('change', onSystemChange)

  const onStorage = (changes: Record<string, unknown>, area: string) => {
    const c = (changes as Record<string, { newValue?: unknown }>)[STORAGE_KEY]
    if (area === 'local' && c) applyTheme((c.newValue as ThemePreference) ?? 'auto')
  }
  browser.storage.onChanged.addListener(onStorage)

  return () => {
    mq.removeEventListener('change', onSystemChange)
    browser.storage.onChanged.removeListener(onStorage)
  }
}