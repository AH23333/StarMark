import { browser } from 'wxt/browser'
import { useCallback, useEffect, useRef, useState } from 'react'
import { clearAll, allItems } from '~/core/db'
import { buildBackup, parseBackup, restoreBackup } from '~/core/backup'
import { buildExport, exportFilename, type ExportFormat } from '~/core/export'
import { getRules, saveRules, newRuleId, type RuleMatchType, type TagRule } from '~/core/rules'
import { tagColor } from '~/core/tagcolor'
import { DEFAULT_AI_SETTINGS, getAiSettings, saveAiSettings, listOllamaModels, type AiSettings, type ProviderKind } from '~/core/ai/provider'
import type { ClassifyResult, ClassifyState } from '~/core/ai/classify'
import type { TagSuggestion } from '~/core/types'
import { buildHealthReport, type HealthReport } from '~/core/insights'
import { sendToBackground } from '~/core/msg'
import { LANGS, getCurrentLangSetting, setLang, useT, type Lang } from '~/core/i18n'
import { type ThemePreference, getThemePreference, initTheme } from '~/core/theme'
import { CTX_MENU_ACTIONS, type CtxMenuConfig, type UIPrefs } from '~/core/types'
import type { BgState } from '~/core/msg'

const DEFAULT_CTX: Required<CtxMenuConfig> = { open: true, copyUrl: true, copyTitle: true, tags: true, note: true, hide: true }

function download(content: string, filename: string, mime = 'application/json'): void {
  const blob = new Blob([content], { type: mime })
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
  const [shortcuts, setShortcuts] = useState<{ name?: string; description?: string; shortcut?: string }[]>([])
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null)
  const fileRef = useRef<HTMLInputElement | null>(null)

  /* ---------- 规则自动标签 ---------- */
  const [rules, setRules] = useState<TagRule[]>([])
  const [ruleMatch, setRuleMatch] = useState<RuleMatchType>('domain')
  const [ruleValue, setRuleValue] = useState('')
  const [ruleTags, setRuleTags] = useState('')
  const [applyingRules, setApplyingRules] = useState(false)

  /* ---------- AI 整理标签（批量分类，单一入口） ---------- */
  const [ai, setAi] = useState<AiSettings>({ ...DEFAULT_AI_SETTINGS })
  const [aiPending, setAiPending] = useState<TagSuggestion[]>([])
  const [aiBusy, setAiBusy] = useState(false)
  const [classifyState, setClassifyState] = useState<ClassifyState | null>(null)
  const [classifyResult, setClassifyResult] = useState<ClassifyResult | null>(null)
  const [classifyBusy, setClassifyBusy] = useState(false)
  const fileRef2 = useRef<HTMLInputElement | null>(null)
  const [classifyTitles, setClassifyTitles] = useState<Record<string, string>>({})

  const loadAi = useCallback(async () => {
    setAi(await getAiSettings())
    // 仅取历史待审数量（旧版逐条建议的存量，用于清理入口）；流水线状态经 classify-state 获取
    const res = await sendToBackground({ type: 'ai-review' })
    if (res.ok) setAiPending(res.pending ?? [])
    const cs = await sendToBackground({ type: 'ai-classify-state' })
    if (cs.ok) {
      setClassifyState(cs.classifyState ?? null)
      setClassifyResult(cs.classifyResult ?? null)
    }
  }, [])

  const saveAi = async (next: AiSettings) => {
    setAi(next)
    await saveAiSettings(next)
    setMsg({ kind: 'ok', text: t('opt.ai.saved') })
  }

  const testOllama = async () => {
    setAiBusy(true)
    try {
      const models = await listOllamaModels(ai)
      setMsg({ kind: 'ok', text: t('opt.ai.ollamaOk', { models: models.slice(0, 5).join(', ') || t('opt.ai.ollamaNone') }) })
    } catch (e) {
      setMsg({ kind: 'err', text: t('opt.ai.ollamaFail', { err: (e as Error).message }) })
    } finally {
      setAiBusy(false)
    }
  }

  // 批量分类是后台长任务：ai-classify-run 启动即返回（running=true），每 2s 轮询直到
  // running=false（完成 / 出错 / 用户暂停）。僵尸检测：running 但 lastBeatAt 超过
  // 3 分钟无更新 → SW 已被浏览器回收，提示用户点击继续从断点恢复。
  useEffect(() => {
    if (!classifyBusy) return
    const timer = setInterval(async () => {
      const res = await sendToBackground({ type: 'ai-classify-state' })
      if (!res.ok) return
      setClassifyState(res.classifyState ?? null)
      setClassifyResult(res.classifyResult ?? null)
      if (res.classifyState && !res.classifyState.running) {
        setClassifyBusy(false)
        if (res.classifyState.paused) setMsg({ kind: 'ok', text: t('opt.ai.clsPaused') })
        else if (res.classifyState.error) setMsg({ kind: 'err', text: t('opt.ai.clsRunFailed', { err: res.classifyState.error }) })
        else setMsg({ kind: 'ok', text: t('opt.ai.clsDone', { batches: res.classifyState.batch ?? 0 }) })
        return
      }
      const beat = res.classifyState?.lastBeatAt ?? 0
      if (Date.now() - beat > 180_000) {
        setClassifyBusy(false)
        // 心跳超时但状态仍是 running → SW 已被回收，落盘暂停态解除僵尸
        await sendToBackground({ type: 'ai-pause' })
        setMsg({ kind: 'err', text: t('opt.ai.clsStalled') })
      }
    }, 2000)
    return () => clearInterval(timer)
  }, [classifyBusy, t])

  const runClassifyNow = async () => {
    setClassifyBusy(true)
    const res = await sendToBackground({ type: 'ai-classify-run' })
    if (!res.ok) {
      setClassifyBusy(false)
      setMsg({ kind: 'err', text: t('opt.ai.clsRunFailed', { err: res.error ?? '' }) })
      return
    }
    setClassifyState(res.classifyState ?? null)
    if (!res.classifyState?.running) {
      setClassifyBusy(false)
      if (res.classifyState?.error) setMsg({ kind: 'err', text: t('opt.ai.clsRunFailed', { err: res.classifyState.error }) })
      else setMsg({ kind: 'ok', text: t('opt.ai.clsDone', { batches: res.classifyState?.batch ?? 0 }) })
    } else {
      setMsg({ kind: 'ok', text: res.classifyState.paused ? t('opt.ai.clsResuming') : t('opt.ai.clsRunning') })
    }
  }

  // 暂停：后台循环在下一批边界优雅停止并保留断点；循环已死（SW 回收）则直接落盘暂停态
  const pauseClassifyNow = async () => {
    const res = await sendToBackground({ type: 'ai-pause' })
    if (res.ok) {
      setClassifyState(res.classifyState ?? null)
      if (!res.classifyState?.running) {
        setClassifyBusy(false)
        setMsg({ kind: 'ok', text: t('opt.ai.clsPaused') })
      } else {
        setMsg({ kind: 'ok', text: t('opt.ai.clsPausing') })
      }
    }
  }

  // 清空历史待审核建议（旧版逐条建议功能已并入批量分类，存量数据一次性清理）
  const clearPending = async () => {
    if (aiPending.length === 0) return
    const res = await sendToBackground({ type: 'ai-reject', ids: aiPending.map((p) => p.id) })
    if (res.ok) setAiPending(res.pending ?? [])
  }

  const applyGroups = async (tags: string[] | null) => {
    setClassifyBusy(true)
    const res = await sendToBackground({ type: 'ai-classify-apply', groupTags: tags })
    setClassifyBusy(false)
    if (!res.ok) {
      setMsg({ kind: 'err', text: t('opt.ai.clsApplyFailed', { err: res.error ?? '' }) })
      return
    }
    setMsg({ kind: 'ok', text: t('opt.ai.clsApplied', { items: res.classifyApply?.items ?? 0, tags: res.classifyApply?.tags ?? 0 }) })
    refresh()
  }

  const exportClassify = async () => {
    const res = await sendToBackground({ type: 'ai-classify-export' })
    if (!res.ok || !res.classifyExport) {
      setMsg({ kind: 'err', text: t('opt.ai.clsExportFailed', { err: res.error ?? '' }) })
      return
    }
    const blob = new Blob([res.classifyExport], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'starmark-ai-classification.json'
    a.click()
    setTimeout(() => URL.revokeObjectURL(url), 5000)
    setMsg({ kind: 'ok', text: t('opt.ai.clsExportOk') })
  }

  const importClassify = async (file: File) => {
    try {
      const json = await file.text()
      const res = await sendToBackground({ type: 'ai-classify-import', json })
      if (!res.ok) {
        setMsg({ kind: 'err', text: t('opt.ai.clsImportFailed', { err: res.error ?? '' }) })
        return
      }
      setClassifyResult(res.classifyResult ?? null)
      setMsg({ kind: 'ok', text: t('opt.ai.clsImportOk') })
    } catch (e) {
      setMsg({ kind: 'err', text: t('opt.ai.clsImportFailed', { err: (e as Error).message }) })
    }
  }

  const loadRules = useCallback(() => {
    void getRules().then(setRules)
  }, [])

  const persistRules = useCallback(async (next: TagRule[]) => {
    setRules(next)
    await saveRules(next)
    setMsg({ kind: 'ok', text: t('opt.rules.saved') })
  }, [])

  const addRule = async () => {
    const value = ruleValue.trim()
    const tags = ruleTags
      .split(/[,，\s]+/)
      .map((t) => t.trim())
      .filter(Boolean)
    if (!value || tags.length === 0) {
      setMsg({ kind: 'err', text: t('opt.rules.invalid') })
      return
    }
    const rule: TagRule = {
      id: newRuleId(),
      enabled: true,
      match: ruleMatch,
      value,
      tags,
      createdAt: Date.now(),
    }
    await persistRules([...rules, rule])
    setRuleValue('')
    setRuleTags('')
  }

  const applyRulesNow = async () => {
    setApplyingRules(true)
    const res = await sendToBackground({ type: 'apply-rules' })
    setApplyingRules(false)
    if (!res.ok) {
      setMsg({ kind: 'err', text: t('opt.rules.applyFailed', { err: res.error ?? '' }) })
      return
    }
    setMsg({ kind: 'ok', text: t('opt.rules.applied', { changed: res.rules?.changed ?? 0, scanned: res.rules?.scanned ?? 0 }) })
    refresh()
  }

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
    loadRules()
    void loadAi()
    return () => disposeTheme()
  }, [refresh, loadRules, loadAi])

  // 分类分组展示用的条目标题（批量补齐一次）
  useEffect(() => {
    const clsIds = classifyResult && classifyResult.assignments ? Object.keys(classifyResult.assignments) : []
    if (clsIds.length === 0) return
    void allItems().then((items) => {
      const map: Record<string, string> = {}
      for (const it of items) map[it.id] = it.title || it.url
      setClassifyTitles(map)
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [classifyResult])

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

  const loadShortcuts = useCallback(() => {
    void browser.commands
      .getAll()
      .then((list) => setShortcuts(list as { name?: string; description?: string; shortcut?: string }[]))
      .catch(() => setShortcuts([]))
  }, [])

  // Chrome 的 commands API 不支持程序化修改快捷键（update/reset 仅 Firefox），
  // 只能引导用户打开 chrome://extensions/shortcuts 手动配置。
  const openShortcutManager = () => {
    void browser.tabs
      .create({ url: 'chrome://extensions/shortcuts' })
      .catch(() => setMsg({ kind: 'err', text: t('opt.shortcuts.heading') }))
  }

  useEffect(() => {
    loadShortcuts()
  }, [loadShortcuts])

  // run-sync 已改为启动即返回（长同步不再挂消息通道）：轮询 get-state 直到
  // syncing=false，再按最后的检查点错误与否提示结果。
  const doSync = async () => {
    setMsg({ kind: 'ok', text: t('msg.sync.progress') })
    const res = await sendToBackground({ type: 'run-sync', force: true })
    if (!res.ok) {
      setMsg({ kind: 'err', text: t('sync.failed', { err: res.error ?? t('sync.unknownError') }) })
      return
    }
    let lastState: BgState | null = null
    for (let i = 0; i < 600; i++) {
      await new Promise((r) => setTimeout(r, 2000))
      const st = await sendToBackground({ type: 'get-state' })
      if (st.state) {
        setState(st.state)
        lastState = st.state
        if (!st.state.syncing) break
      }
    }
    const err = lastState?.ghSync?.error
    setMsg(err ? { kind: 'err', text: t('sync.failed', { err }) } : { kind: 'ok', text: t('sync.ok') })
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

  const doExportFormat = async (format: ExportFormat) => {
    try {
      const items = await allItems()
      if (items.length === 0) {
        setMsg({ kind: 'err', text: t('opt.export.failed', { err: t('opt.never') }) })
        return
      }
      const { content, mime } = buildExport(format, items)
      download(content, exportFilename(format), mime)
      setMsg({ kind: 'ok', text: t('opt.export.ok', { n: items.length, format }) })
    } catch (e) {
      setMsg({ kind: 'err', text: t('opt.export.failed', { err: (e as Error).message }) })
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
        <h2>{t('opt.export.heading')}</h2>
        <p className="desc">{t('opt.export.desc')}</p>
        <div className="row">
          <button className="btn" onClick={() => void doExportFormat('markdown')}>
            {t('opt.export.markdown')}
          </button>
          <button className="btn" onClick={() => void doExportFormat('html')}>
            {t('opt.export.html')}
          </button>
          <button className="btn" onClick={() => void doExportFormat('csv')}>
            {t('opt.export.csv')}
          </button>
        </div>
      </section>

      <section className="panel">
        <h2>{t('opt.rules.heading')}</h2>
        <p className="desc">{t('opt.rules.desc')}</p>
        <p className="desc warn-text">{t('opt.rules.autoHint')}</p>

        {rules.length === 0 ? (
          <p className="desc">{t('opt.rules.empty')}</p>
        ) : (
          <ul className="rule-list">
            {rules.map((r) => (
              <li key={r.id} className={r.enabled ? 'rule-row' : 'rule-row off'}>
                <label className="chk">
                  <input
                    type="checkbox"
                    checked={r.enabled}
                    onChange={() =>
                      void persistRules(rules.map((x) => (x.id === r.id ? { ...x, enabled: !x.enabled } : x)))
                    }
                  />
                </label>
                <span className="rule-badge">{t(`opt.rules.match.${r.match}`)}</span>
                <code className="rule-value">{r.value}</code>
                <span className="rule-arrow">→</span>
                <span className="rule-tags">
                  {r.tags.map((tg) => (
                    <button
                      key={tg}
                      className="tag"
                      style={{ color: tagColor(tg) }}
                      onClick={() => setRuleTags(tg)}
                      title={t('opt.rules.tagTitle')}
                    >
                      #{tg}
                    </button>
                  ))}
                </span>
                <button
                  className="btn mini danger-btn"
                  title={t('opt.rules.deleteTitle')}
                  onClick={() => void persistRules(rules.filter((x) => x.id !== r.id))}
                >
                  ✕
                </button>
              </li>
            ))}
          </ul>
        )}

        <div className="rule-form">
          <select value={ruleMatch} onChange={(e) => setRuleMatch(e.target.value as RuleMatchType)}>
            <option value="domain">{t('opt.rules.match.domain')}</option>
            <option value="url">{t('opt.rules.match.url')}</option>
            <option value="title">{t('opt.rules.match.title')}</option>
            <option value="language">{t('opt.rules.match.language')}</option>
          </select>
          <input
            className="rule-input"
            placeholder={t('opt.rules.valuePh')}
            value={ruleValue}
            onChange={(e) => setRuleValue(e.target.value)}
          />
          <input
            className="rule-input"
            placeholder={t('opt.rules.tagsPh')}
            value={ruleTags}
            onChange={(e) => setRuleTags(e.target.value)}
          />
          <div className="row">
            <button className="btn" onClick={() => void addRule()}>
              {t('opt.rules.add')}
            </button>
            <button className="btn primary" disabled={applyingRules} onClick={() => void applyRulesNow()}>
              {applyingRules ? t('opt.rules.applying') : t('opt.rules.applyNow')}
            </button>
          </div>
        </div>
      </section>

      <section className="panel">
        <h2>{t('opt.ai.heading')}</h2>
        <p className="desc">{t('opt.ai.desc')}</p>
        <p className="desc warn-text">{t('opt.ai.privacy')}</p>

        <div className="rule-form">
          <label className="chk">
            <input
              type="checkbox"
              checked={ai.enabled}
              onChange={(e) => void saveAi({ ...ai, enabled: e.target.checked })}
            />
            {t('opt.ai.enabled')}
          </label>
          <select value={ai.provider} onChange={(e) => void saveAi({ ...ai, provider: e.target.value as ProviderKind })}>
            <option value="openai">OpenAI 兼容</option>
            <option value="anthropic">Anthropic</option>
            <option value="ollama">Ollama（本地模型）</option>
          </select>
          {ai.provider !== 'ollama' && (
            <input
              className="rule-input"
              type="password"
              placeholder={t('opt.ai.keyPh')}
              value={ai.apiKey}
              onChange={(e) => setAi((s) => ({ ...s, apiKey: e.target.value }))}
              onBlur={() => void saveAi(ai)}
            />
          )}
          <input
            className="rule-input"
            placeholder={ai.provider === 'ollama' ? t('opt.ai.modelOllamaPh') : t('opt.ai.modelPh')}
            value={ai.model}
            onChange={(e) => setAi((s) => ({ ...s, model: e.target.value }))}
            onBlur={() => void saveAi(ai)}
          />
          {ai.provider === 'ollama' && (
            <input
              className="rule-input"
              placeholder={t('opt.ai.ollamaUrlPh')}
              value={ai.ollamaBaseUrl ?? ''}
              onChange={(e) => setAi((s) => ({ ...s, ollamaBaseUrl: e.target.value }))}
              onBlur={() => void saveAi(ai)}
            />
          )}
          {ai.provider === 'ollama' && <p className="desc warn-text">{t('opt.ai.ollamaHint')}</p>}
          {ai.provider === 'openai' && (
            <input
              className="rule-input"
              placeholder={t('opt.ai.baseUrlPh')}
              value={ai.baseUrl ?? ''}
              onChange={(e) => setAi((s) => ({ ...s, baseUrl: e.target.value }))}
              onBlur={() => void saveAi(ai)}
            />
          )}
          <div className="row">
            <button
              className="btn primary"
              disabled={!ai.enabled || classifyBusy || (ai.provider !== 'ollama' && !ai.apiKey)}
              onClick={() => void runClassifyNow()}
            >
              {classifyBusy ? t('opt.ai.clsRunning') : classifyState?.paused ? t('opt.ai.clsResume') : t('opt.ai.clsRun')}
            </button>
            {classifyBusy && (
              <button className="btn danger-btn" onClick={() => void pauseClassifyNow()}>
                {t('opt.ai.clsPause')}
              </button>
            )}
            {ai.provider === 'ollama' && (
              <button className="btn" disabled={classifyBusy} onClick={() => void testOllama()}>
                {t('opt.ai.testConn')}
              </button>
            )}
            {classifyState && (
              <span className="ai-state">
                {classifyState.running
                  ? t('opt.ai.clsProgress', { batch: classifyState.batch, total: classifyState.totalBatches })
                  : t('opt.ai.clsState', { batch: classifyState.batch, total: classifyState.totalBatches })}
                {classifyState.paused ? ` · ${t('opt.ai.clsPausedShort')}` : ''}
                {classifyState.error ? ` · ${classifyState.error}` : ''}
              </span>
            )}
          </div>
        </div>

        {classifyResult && Array.isArray(classifyResult.groups) && classifyResult.groups.length > 0 && (
          <>
            <h3 className="sub-title">{t('opt.ai.clsGroupsHeading', { groups: classifyResult.groups.length, items: classifyResult.totalItems })}</h3>
            <div className="row">
              <button className="btn primary" disabled={classifyBusy} onClick={() => void applyGroups(null)}>
                {t('opt.ai.clsApplyAll')}
              </button>
              <button className="btn" disabled={classifyBusy} onClick={() => void exportClassify()}>
                {t('opt.ai.clsExport')}
              </button>
              <button className="btn" disabled={classifyBusy} onClick={() => fileRef2.current?.click()}>
                {t('opt.ai.clsImport')}
              </button>
              <input
                ref={fileRef2}
                type="file"
                accept=".json,application/json"
                hidden
                onChange={(e) => {
                  const file = e.target.files?.[0]
                  e.target.value = ''
                  if (file) void importClassify(file)
                }}
              />
            </div>
            <ul className="cls-groups">
              {classifyResult.groups.map((g) => (
                <li key={g.tag} className="cls-group">
                  <div className="cls-group-head">
                    <span className="cls-tag" style={{ color: tagColor(g.tag) }}>#{g.tag}</span>
                    <span className="cls-count">{t('opt.ai.clsItemCount', { n: g.itemIds.length })}</span>
                    <span className="spacer" />
                    <button className="btn mini" disabled={classifyBusy} onClick={() => void applyGroups([g.tag])}>
                      {t('opt.ai.clsApplyGroup')}
                    </button>
                  </div>
                  <div className="cls-items">
                    {g.itemIds.slice(0, 12).map((id) => (
                      <span key={id} className="cls-item" title={id}>
                        {classifyTitles[id] ?? id.slice(0, 8)}
                      </span>
                    ))}
                    {g.itemIds.length > 12 && <span className="cls-item more">+{g.itemIds.length - 12}</span>}
                  </div>
                </li>
              ))}
            </ul>
          </>
        )}

        {aiPending.length > 0 && (
          <div className="row">
            <span className="ai-state">{t('opt.ai.pendingCleanup', { n: aiPending.length })}</span>
            <button className="btn mini" onClick={() => void clearPending()}>
              {t('opt.ai.pendingClear')}
            </button>
          </div>
        )}
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