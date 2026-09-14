import { browser } from 'wxt/browser'
import { useCallback, useEffect, useRef, useState } from 'react'
import { clearAll, allItems } from '~/core/db'
import { buildBackup, parseBackup, restoreBackup } from '~/core/backup'
import { buildHealthReport, type HealthReport } from '~/core/insights'
import { sendToBackground } from '~/core/msg'
import { LANGS, getCurrentLangSetting, setLang, useT, type Lang } from '~/core/i18n'
import { type ThemePreference, getThemePreference, initTheme } from '~/core/theme'
import { CTX_MENU_ACTIONS, type CtxMenuConfig, type UIPrefs } from '~/core/types'
import type { BgState } from '~/core/msg'

const DEFAULT_CTX: Required<CtxMenuConfig> = { open: true, copyUrl: true, copyTitle: true, tags: true, note: true, hide: true }

function download(content: string, filename: string): void {
  const blob = new Blob([content], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 5000)
}

export default function App() {
  const t = useT()
  const [langSetting, setLangSetting] = useState<Lang | 'auto'>('auto')
  const [token, setToken] = useState('')
  const [state, setState] = useState<BgState | null>(null)
  const [health, setHealth] = useState<HealthReport | null>(null)
  const [intervalHours, setIntervalHours] = useState(6)
  const [theme, setTheme] = useState<ThemePreference>('auto')
  const [letterAvatar, setLetterAvatar] = useState(false)
  const [ctxMenu, setCtxMenu] = useState<Required<CtxMenuConfig>>(DEFAULT_CTX)
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null)
  const fileRef = useRef<HTMLInputElement | null>(null)

  const refresh = useCallback(() => {
    void sendToBackground({ type: 'get-state' }).then((res) => {
      if (res.state) setState(res.state)
    })
    void allItems().then((items) => setHealth(buildHealthReport(items, 14, t)))
  }, [])

  useEffect(() => {
    let disposeTheme = () => {}
    void initTheme().then((d) => {
      disposeTheme = d
    })
    void browser.storage.local.get(['pat', 'syncIntervalHours', 'ui']).then((s) => {
      if (typeof s.pat === 'string' && s.pat) setToken(s.pat)
      if (typeof s.syncIntervalHours === 'number') setIntervalHours(s.syncIntervalHours)
      const ui = (s.ui ?? {}) as Partial<UIPrefs>
      setCtxMenu({ ...DEFAULT_CTX, ...(ui.ctxMenu ?? {}) })
      setLetterAvatar(ui.letterAvatar ?? false)
    })
    void getThemePreference().then(setTheme)
    void getCurrentLangSetting().then(setLangSetting)
    void refresh()
    return () => disposeTheme()
  }, [refresh])

  const saveToken = async () => {
    const pat = token.trim()
    if (!pat) {
      setMsg({ kind: 'err', text: t('msg.err.tokenRequired') })
      return
    }
    await browser.storage.local.set({ pat })
    setMsg({ kind: 'ok', text: t('msg.ok.tokenSaved') })
    const st = setTimeout(refresh, 2500)
    return () => clearTimeout(st)
  }

  const saveInterval = async () => {
    await browser.storage.local.set({ syncIntervalHours: intervalHours })
    setMsg({ kind: 'ok', text: t('msg.ok.intervalSet', { h: intervalHours }) })
  }

  const changeTheme = async (value: ThemePreference) => {
    setTheme(value)
    await browser.storage.local.set({ theme: value })
    const name = value === 'auto' ? t('opt.theme.auto') : t(`opt.theme.${value}`)
    setMsg({ kind: 'ok', text: value === 'auto' ? t('msg.ok.themeFollow') : t('msg.ok.themeUsed', { name }) })
  }

  const updateCtx = async (key: keyof CtxMenuConfig, checked: boolean) => {
    const next = { ...ctxMenu, [key]: checked }
    setCtxMenu(next)
    const s = await browser.storage.local.get('ui')
    await browser.storage.local.set({ ui: { ...(s.ui ?? {}), ctxMenu: next } })
    setMsg({ kind: 'ok', text: t('msg.ok.ctxSaved') })
  }

  const updateLetterAvatar = async (v: boolean) => {
    setLetterAvatar(v)
    const s = await browser.storage.local.get('ui')
    await browser.storage.local.set({ ui: { ...(s.ui ?? {}), letterAvatar: v } })
    setMsg({ kind: 'ok', text: t('msg.ok.displaySaved') })
  }

  const doSync = async () => {
    setMsg({ kind: 'ok', text: t('msg.sync.progress') })
    const res = await sendToBackground({ type: 'run-sync', force: true })
    setMsg({ kind: res.ok ? 'ok' : 'err', text: res.ok ? t('sync.ok') : t('sync.failed', { err: res.error ?? t('sync.unknownError') }) })
    refresh()
  }

  const doRebuild = async () => {
    const res = await sendToBackground({ type: 'rebuild-index' })
    setMsg({ kind: res.ok ? 'ok' : 'err', text: res.ok ? t('msg.ok.rebuildIndex') : t('msg.err.rebuildFailed', { err: res.error ?? '' }) })
  }

  const doExport = async () => {
    const pass = window.prompt(t('msg.export.prompt'))
    if (pass === null) return
    try {
      const { content, encrypted } = await buildBackup(pass || undefined)
      download(content, `starmark-backup-${Date.now()}.json`)
      setMsg({ kind: 'ok', text: encrypted ? t('msg.export.okEncrypted') : t('msg.export.okPlain') })
    } catch (e) {
      setMsg({ kind: 'err', text: t('msg.export.failed', { err: (e as Error).message }) })
    }
  }

  const onImportFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    const pass = window.prompt(t('msg.import.promptPass'))
    if (pass === null) return
    try {
      const text = await file.text()
      const payload = await parseBackup(text, pass || undefined)
      if (!window.confirm(t('msg.import.confirm', { n: payload.items.length }))) return
      await restoreBackup(payload.items)
      setMsg({ kind: 'ok', text: t('msg.import.ok', { n: payload.items.length }) })
      refresh()
    } catch (err) {
      setMsg({ kind: 'err', text: t('msg.import.failed', { err: (err as Error).message }) })
    }
  }

  const doClear = async () => {
    if (!confirm(t('msg.clear.confirm'))) return
    await clearAll()
    setToken('')
    setHealth(null)
    setMsg({ kind: 'ok', text: t('msg.clear.ok') })
    refresh()
  }

  const score = health?.score ?? (state ? 0 : null)
  const scoreColor = score === null ? 'var(--muted)' : score >= 80 ? 'var(--ok)' : score >= 50 ? 'var(--busy)' : 'var(--err)'

  return (
    <div className="page">
      <h1>{t('opt.title')}</h1>

      <section className="panel">
        <h2>{t('opt.lang.heading')}</h2>
        <div className="row">
          <select
            value={langSetting}
            onChange={(e) => {
              const v = e.target.value as Lang | 'auto'
              setLangSetting(v)
              void setLang(v)
            }}
          >
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
        <h2>{t('opt.gh.heading')}</h2>
        <p className="desc">
          {t('opt.gh.descPre')}
          <code> Starring: Read </code> {t('opt.gh.descPost')}
        </p>
        <input type="password" placeholder="github_pat_…" value={token} onChange={(e) => setToken(e.target.value)} />
        <div className="row">
          <button className="btn primary" onClick={saveToken}>
            {t('opt.gh.saveSync')}
          </button>
          {state?.ghLogin && <span className="login">{t('opt.gh.connected', { login: state.ghLogin })}</span>}
        </div>
      </section>

      <section className="panel">
        <h2>{t('opt.stats.heading')}</h2>
        {state ? (
          <ul className="stats">
            <li>
              {t('opt.stats.summary', {
                stars: state.stars,
                bookmarks: state.bookmarks,
                ver: state.indexVersion,
              })}
            </li>
            <li>
              {t('opt.lastSync', {
                time: state.lastSyncAt ? new Date(state.lastSyncAt).toLocaleString() : t('opt.never'),
              })}
            </li>
          </ul>
        ) : (
          <p className="desc">{t('opt.loading')}</p>
        )}

        {score !== null && (
          <>
            <div className="metrorow">
              <div className="score" style={{ color: scoreColor }}>
                {score}
                <span className="score-label">{t('opt.scoreLabel')}</span>
              </div>
              <ul className="factor-list">
                {(health?.factors ?? []).map((f) => (
                  <li key={f.label} className={f.ok ? 'ok' : 'warn'}>
                    {f.ok ? '✓' : '⚠'} {f.label}：{f.value}
                  </li>
                ))}
              </ul>
            </div>

            {health && health.languages.length > 0 && (
              <>
                <h3 className="sub-title">{t('opt.langsHeading')}</h3>
                <div className="bars">
                  {health.languages.slice(0, 8).map((l) => {
                    const max = health.languages[0]!.count
                    return (
                      <div className="bar-row" key={l.language}>
                        <span className="bar-label">{l.language}</span>
                        <div className="bar-track">
                          <div className="bar-fill" style={{ width: `${Math.round((l.count / max) * 100)}%` }} />
                        </div>
                        <span className="bar-num">{l.count}</span>
                      </div>
                    )
                  })}
                </div>
              </>
            )}

            {health && health.trend.length > 0 && (
              <>
                <h3 className="sub-title">{t('opt.trendHeading', { n: health.trend.length })}</h3>
                <div className="trend">
                  {health.trend.map((d) => {
                    const max = Math.max(1, ...health.trend.map((x) => x.added))
                    return (
                      <div className="trend-col" key={d.day} title={t('opt.trendTitle', { day: d.day, n: d.added })}>
                        <div className="trend-bar" style={{ height: `${Math.max(3, Math.round((d.added / max) * 60))}px` }} />
                        <span className="trend-day">{d.day.slice(5)}</span>
                      </div>
                    )
                  })}
                </div>
              </>
            )}

            {health && health.duplicates.length > 0 && (
              <>
                <h3 className="sub-title">{t('opt.dupHeading', { n: health.duplicates.length })}</h3>
                <ul className="dup-list">
                  {health.duplicates.slice(0, 10).map((g) => (
                    <li key={g.title}>
                      {t('opt.dupEntry', { title: g.title, n: g.count })}
                      <span className="dup-urls">{g.urls.join(' / ')}</span>
                    </li>
                  ))}
                </ul>
              </>
            )}

            {health && (
              <ul className="stats extra">
                <li>
                  {t('opt.statsExtra', {
                    d: health.uniqueDomains,
                    u: health.untagged,
                    h: health.hiddenCount,
                  })}
                </li>
              </ul>
            )}
          </>
        )}

        <div className="row">
          <button className="btn" onClick={doSync}>
            {t('opt.syncNow')}
          </button>
          <button className="btn" onClick={doRebuild}>
            {t('opt.rebuildIndex')}
          </button>
          <button className="btn" onClick={refresh}>
            {t('opt.refreshStats')}
          </button>
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
            <input
              type="checkbox"
              checked={letterAvatar}
              onChange={(e) => void updateLetterAvatar(e.target.checked)}
            />
            {t('opt.letterAvatar')}
          </label>
        </div>
      </section>

      <section className="panel">
        <h2>{t('opt.interval.heading')}</h2>
        <div className="row">
          <select value={intervalHours} onChange={(e) => setIntervalHours(Number(e.target.value))}>
            <option value={1}>{t('opt.interval.h', { h: 1 })}</option>
            <option value={6}>{t('opt.interval.h', { h: 6 })}</option>
            <option value={12}>{t('opt.interval.h', { h: 12 })}</option>
            <option value={24}>{t('opt.interval.h', { h: 24 })}</option>
          </select>
          <button className="btn" onClick={saveInterval}>
            {t('opt.save')}
          </button>
        </div>
      </section>

      <section className="panel">
        <h2>{t('opt.ctxMenu.heading')}</h2>
        <p className="desc">{t('opt.ctxMenu.desc')}</p>
        <div className="ctx-opts">
          {CTX_MENU_ACTIONS.map((a) => (
            <label className="chk" key={a.key}>
              <input
                type="checkbox"
                checked={ctxMenu[a.key]}
                onChange={(e) => void updateCtx(a.key, e.target.checked)}
              />
              {t(`ctx.${a.key}`)}
            </label>
          ))}
        </div>
      </section>

      <section className="panel">
        <h2>{t('opt.backup.heading')}</h2>
        <p className="desc">{t('opt.backup.desc')}</p>
        <div className="row">
          <button className="btn" onClick={doExport}>
            {t('opt.backup.export')}
          </button>
          <button className="btn" onClick={() => fileRef.current?.click()}>
            {t('opt.backup.import')}
          </button>
          <input ref={fileRef} type="file" accept=".json,application/json" hidden onChange={onImportFile} />
        </div>
      </section>

      <section className="panel">
        <h2>{t('opt.diag.heading')}</h2>
        <div className="row">
          <button className="btn" onClick={refresh}>
            {t('opt.diag.run')}
          </button>
        </div>
        <ul className="stats diag">
          <li>{t('opt.diag.phase', { v: state?.status ?? '—' })}</li>
          <li>{t('opt.diag.page', { v: state?.ghSync?.page ?? 0 })}</li>
          <li>{t('opt.diag.etag', { v: state?.ghSync?.etag ? t('opt.diag.etagOn') : t('opt.diag.etagOff') })}</li>
          <li>{t('opt.diag.lastDone', { v: state?.lastSyncAt ? new Date(state.lastSyncAt).toLocaleString() : t('opt.never') })}</li>
          <li>
            {t('opt.diag.lastError')}
            {state?.ghSync?.error ? <span className="err-text">{state.ghSync.error}</span> : t('opt.diag.noError')}
          </li>
          <li>
            {t('opt.diag.bmWalk', {
              v: state?.bmSync?.lastFullWalkAt ? new Date(state.bmSync.lastFullWalkAt).toLocaleString() : t('opt.diag.bmWalkNever'),
            })}
          </li>
          <li>{t('opt.diag.indexVersion', { v: state?.indexVersion ?? 0 })}</li>
        </ul>
      </section>

      <section className="panel danger">
        <h2>{t('opt.data.heading')}</h2>
        <button className="btn danger-btn" onClick={doClear}>
          {t('opt.data.clearAll')}
        </button>
      </section>

      {msg && (
        <div className={msg.kind === 'ok' ? 'msg ok' : 'msg err'}>
          {msg.text}
          <button className="close" onClick={() => setMsg(null)}>
            ✕
          </button>
        </div>
      )}

      <footer className="foot">{t('opt.foot', { v: import.meta.env.VITE_ENV || 'v0.1' })}</footer>
    </div>
  )
}