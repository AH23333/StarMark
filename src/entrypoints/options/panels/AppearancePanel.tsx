import { useEffect, useState } from 'react'
import { browser } from 'wxt/browser'
import { useT, getCurrentLangSetting, setLang, LANGS, type Lang } from '~/core/i18n'
import { type ThemePreference, getThemePreference, initTheme } from '~/core/theme'
import { CTX_MENU_ACTIONS, type CtxMenuConfig, type UIPrefs } from '~/core/types'

type Notify = (kind: 'ok' | 'err', text: string) => void

/** 与侧边栏共享的 ui 偏好形状（storage.local.ui 的读写双面） */
type UIPrefsLike = { ctxMenu?: CtxMenuConfig; letterAvatar?: boolean; sort?: string; source?: string; showHidden?: boolean }

const DEFAULT_CTX: Required<CtxMenuConfig> = { open: true, copyUrl: true, copyTitle: true, tags: true, note: true, hide: true }

/**
 * 外观与偏好面板（自治）：主题 / 字母头像 / 界面语言 / 右键菜单开关 / 快捷键。
 * 变更落 storage.local（theme / ui / lang），侧边栏经 storage.onChanged 实时同步。
 */
export default function AppearancePanel({ notify }: { notify: Notify }) {
  const t = useT()
  const [langSetting, setLangSetting] = useState<Lang | 'auto'>('auto')
  const [theme, setTheme] = useState<ThemePreference>('auto')
  const [letterAvatar, setLetterAvatar] = useState(false)
  const [ctxMenu, setCtxMenu] = useState<Required<CtxMenuConfig>>(DEFAULT_CTX)
  const [shortcuts, setShortcuts] = useState<{ name?: string; description?: string; shortcut?: string }[]>([])

  const updateLetterAvatar = async (v: boolean) => {
    setLetterAvatar(v)
    const s = await browser.storage.local.get('ui')
    const ui = (s.ui ?? {}) as Partial<UIPrefsLike>
    await browser.storage.local.set({ ui: { ...ui, letterAvatar: v } })
  }

  const updateCtx = async (key: keyof CtxMenuConfig, v: boolean) => {
    const next = { ...ctxMenu, [key]: v }
    setCtxMenu(next)
    const s = await browser.storage.local.get('ui')
    const ui = (s.ui ?? {}) as Partial<UIPrefsLike>
    await browser.storage.local.set({ ui: { ...ui, ctxMenu: next } })
  }

  const changeTheme = async (value: ThemePreference) => {
    setTheme(value)
    await browser.storage.local.set({ theme: value })
    const name = value === 'auto' ? t('opt.theme.auto') : t(`opt.theme.${value}`)
    notify('ok', value === 'auto' ? t('msg.ok.themeFollow') : t('msg.ok.themeUsed', { name }))
  }

  const saveLang = (v: Lang | 'auto') => {
    setLangSetting(v)
    void setLang(v)
  }

  // Chrome 的 commands API 不支持程序化修改快捷键（update/reset 仅 Firefox），
  // 只能引导用户打开 chrome://extensions/shortcuts 手动配置。
  const openShortcutManager = () => {
    void browser.tabs
      .create({ url: 'chrome://extensions/shortcuts' })
      .catch(() => notify('err', t('opt.shortcuts.heading')))
  }

  useEffect(() => {
    let disposeTheme = () => {}
    void initTheme().then((d) => {
      disposeTheme = d
    })
    void browser.storage.local.get('ui').then((s) => {
      const ui = (s.ui ?? {}) as Partial<UIPrefsLike>
      setCtxMenu({ ...DEFAULT_CTX, ...(ui.ctxMenu ?? {}) })
      setLetterAvatar(ui.letterAvatar ?? false)
    })
    void getThemePreference().then(setTheme)
    void getCurrentLangSetting().then(setLangSetting)
    void browser.commands
      .getAll()
      .then((list) => setShortcuts(list as { name?: string; description?: string; shortcut?: string }[]))
      .catch(() => setShortcuts([]))
    return () => disposeTheme()
  }, [])

  return (
    <>
      <section className="panel">
        <h2>{t('opt.lang.heading')}</h2>
        <div className="row">
          <select value={langSetting} onChange={(e) => saveLang(e.target.value as Lang | 'auto')}>
            <option value="auto">{t('lang.auto')}</option>
            {LANGS.map((l) => (
              <option key={l.code} value={l.code}>
                {l.native}
              </option>
            ))}
          </select>
        </div>
      </section>

      <section className="panel">
        <h2>{t('opt.theme.heading')}</h2>
        <div className="row">
          <select value={theme} onChange={(e) => void changeTheme(e.target.value as ThemePreference)}>
            <option value="auto">{t('opt.theme.auto')}</option>
            <option value="light">{t('opt.theme.light')}</option>
            <option value="dark">{t('opt.theme.dark')}</option>
          </select>
        </div>
        <div className="row">
          <label className="chk">
            <input type="checkbox" checked={letterAvatar} onChange={(e) => void updateLetterAvatar(e.target.checked)} />
            {t('opt.letterAvatar')}
          </label>
        </div>
      </section>

      <section className="panel">
        <h2>{t('opt.ctxMenu.heading')}</h2>
        <p className="desc">{t('opt.ctxMenu.desc')}</p>
        <div className="ctx-opts">
          {CTX_MENU_ACTIONS.map((a) => (
            <label className="chk" key={a.key}>
              <input type="checkbox" checked={ctxMenu[a.key]} onChange={(e) => void updateCtx(a.key, e.target.checked)} />
              {t(`ctx.${a.key}`)}
            </label>
          ))}
        </div>
      </section>

      <section className="panel">
        <h2>{t('opt.shortcuts.heading')}</h2>
        <p className="desc">{t('opt.shortcuts.desc')}</p>
        <ul className="shortcut-list">
          {shortcuts.map((c) => {
            const name = c.name ?? ''
            return (
              <li key={name}>
                <span className="shortcut-name">{c.description || name}</span>
                <span className="shortcut-key">{c.shortcut || t('opt.shortcuts.unset')}</span>
              </li>
            )
          })}
        </ul>
        <div className="row">
          <button className="btn" onClick={openShortcutManager}>
            {t('opt.shortcuts.openManager')}
          </button>
        </div>
      </section>
    </>
  )
}
