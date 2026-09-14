import { browser } from 'wxt/browser'
import { useCallback, useEffect, useRef, useState } from 'react'
import { clearAll, allItems } from '~/core/db'
import { buildBackup, parseBackup, restoreBackup } from '~/core/backup'
import { buildHealthReport, type HealthReport } from '~/core/insights'
import { sendToBackground } from '~/core/msg'
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
    void allItems().then((items) => setHealth(buildHealthReport(items)))
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
    void refresh()
    return () => disposeTheme()
  }, [refresh])

  const saveToken = async () => {
    const pat = token.trim()
    if (!pat) {
      setMsg({ kind: 'err', text: '请输入 Token' })
      return
    }
    await browser.storage.local.set({ pat })
    setMsg({ kind: 'ok', text: 'Token 已保存，正在同步 Stars…' })
    const st = setTimeout(refresh, 2500)
    return () => clearTimeout(st)
  }

  const saveInterval = async () => {
    await browser.storage.local.set({ syncIntervalHours: intervalHours })
    setMsg({ kind: 'ok', text: `已设置每 ${intervalHours} 小时自动同步` })
  }

  const changeTheme = async (value: ThemePreference) => {
    setTheme(value)
    await browser.storage.local.set({ theme: value })
    setMsg({ kind: 'ok', text: value === 'auto' ? '已跟随浏览器主题' : `已使用${value === 'light' ? '浅色' : '深色'}主题` })
  }

  const updateCtx = async (key: keyof CtxMenuConfig, checked: boolean) => {
    const next = { ...ctxMenu, [key]: checked }
    setCtxMenu(next)
    const s = await browser.storage.local.get('ui')
    await browser.storage.local.set({ ui: { ...(s.ui ?? {}), ctxMenu: next } })
    setMsg({ kind: 'ok', text: '右键菜单设置已保存（重开侧边栏生效）' })
  }

  const updateLetterAvatar = async (v: boolean) => {
    setLetterAvatar(v)
    const s = await browser.storage.local.get('ui')
    await browser.storage.local.set({ ui: { ...(s.ui ?? {}), letterAvatar: v } })
    setMsg({ kind: 'ok', text: '显示设置已保存' })
  }

  const doSync = async () => {
    setMsg({ kind: 'ok', text: '正在同步…' })
    const res = await sendToBackground({ type: 'run-sync', force: true })
    setMsg({ kind: res.ok ? 'ok' : 'err', text: res.ok ? '同步完成' : `同步失败：${res.error ?? '未知错误'}` })
    refresh()
  }

  const doRebuild = async () => {
    const res = await sendToBackground({ type: 'rebuild-index' })
    setMsg({ kind: res.ok ? 'ok' : 'err', text: res.ok ? '已触发索引重建' : `重建失败：${res.error}` })
  }

  const doExport = async () => {
    const pass = window.prompt('可选：输入备份口令（留空则导出未加密 JSON）')
    if (pass === null) return
    try {
      const { content, encrypted } = await buildBackup(pass || undefined)
      download(content, `starmark-backup-${Date.now()}.json`)
      setMsg({ kind: 'ok', text: encrypted ? '已加密导出备份' : '已导出备份（未加密）' })
    } catch (e) {
      setMsg({ kind: 'err', text: `导出失败：${(e as Error).message}` })
    }
  }

  const onImportFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    const pass = window.prompt('如果备份已加密，请输入口令（否则留空）')
    if (pass === null) return
    try {
      const text = await file.text()
      const payload = await parseBackup(text, pass || undefined)
      if (!window.confirm(`导入将覆盖当前 ${payload.items.length} 条本地条目（保留 Token 与设置），确认继续？`)) return
      await restoreBackup(payload.items)
      setMsg({ kind: 'ok', text: `已导入 ${payload.items.length} 条数据` })
      refresh()
    } catch (err) {
      setMsg({ kind: 'err', text: `导入失败：${(err as Error).message}` })
    }
  }

  const doClear = async () => {
    if (!confirm('将删除所有本地缓存的 Stars / 书签数据、Token 与设置，确认？')) return
    await clearAll()
    setToken('')
    setHealth(null)
    setMsg({ kind: 'ok', text: '已清除全部本地数据' })
    refresh()
  }

  const score = health?.score ?? (state ? 0 : null)
  const scoreColor = score === null ? 'var(--muted)' : score >= 80 ? 'var(--ok)' : score >= 50 ? 'var(--busy)' : 'var(--err)'

  return (
    <div className="page">
      <h1>StarMark 设置</h1>

      <section className="panel">
        <h2>1. GitHub 连接（本地 Token）</h2>
        <p className="desc">
          创建一个 Fine-grained PAT（GitHub → Settings → Developer settings → Fine-grained tokens），只需勾选
          <code> Starring: Read </code> 用户权限，即可读取你的 Stars。数据与 Token 仅存在本机。
        </p>
        <input type="password" placeholder="github_pat_…" value={token} onChange={(e) => setToken(e.target.value)} />
        <div className="row">
          <button className="btn primary" onClick={saveToken}>
            保存并同步
          </button>
          {state?.ghLogin && <span className="login">已连接：{state.ghLogin}</span>}
        </div>
      </section>

      <section className="panel">
        <h2>2. 数据概览与健康度</h2>
        {state ? (
          <ul className="stats">
            <li>Stars：{state.stars} · 书签：{state.bookmarks} · 索引版本：{state.indexVersion}</li>
            <li>上次同步：{state.lastSyncAt ? new Date(state.lastSyncAt).toLocaleString() : '从未'}</li>
          </ul>
        ) : (
          <p className="desc">加载中…</p>
        )}

        {score !== null && (
          <>
            <div className="metrorow">
              <div className="score" style={{ color: scoreColor }}>
                {score}
                <span className="score-label">健康分</span>
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
                <h3 className="sub-title">语言分布</h3>
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
                <h3 className="sub-title">近 {health.trend.length} 天新增</h3>
                <div className="trend">
                  {health.trend.map((d) => {
                    const max = Math.max(1, ...health.trend.map((x) => x.added))
                    return (
                      <div className="trend-col" key={d.day} title={`${d.day}：${d.added} 条`}>
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
                <h3 className="sub-title">疑似重复（{health.duplicates.length} 组）</h3>
                <ul className="dup-list">
                  {health.duplicates.slice(0, 10).map((g) => (
                    <li key={g.title}>
                      {g.title}（{g.count} 条）
                      <span className="dup-urls">{g.urls.join(' / ')}</span>
                    </li>
                  ))}
                </ul>
              </>
            )}

            {health && (
              <ul className="stats extra">
                <li>唯一域名：{health.uniqueDomains} · 未打标签：{health.untagged} · 已隐藏：{health.hiddenCount}</li>
              </ul>
            )}
          </>
        )}

        <div className="row">
          <button className="btn" onClick={doSync}>
            立即同步
          </button>
          <button className="btn" onClick={doRebuild}>
            重建搜索索引
          </button>
          <button className="btn" onClick={refresh}>
            刷新统计
          </button>
        </div>
      </section>

      <section className="panel">
        <h2>3. 外观主题</h2>
        <div className="row">
          <select value={theme} onChange={(e) => void changeTheme(e.target.value as ThemePreference)}>
            <option value="auto">跟随浏览器</option>
            <option value="light">浅色</option>
            <option value="dark">深色</option>
          </select>
        </div>
        <div className="row">
          <label className="chk">
            <input
              type="checkbox"
              checked={letterAvatar}
              onChange={(e) => void updateLetterAvatar(e.target.checked)}
            />
            显示彩色字母标识（条目前的 favicon 区域）
          </label>
        </div>
      </section>

      <section className="panel">
        <h2>4. 自动同步频率</h2>
        <div className="row">
          <select value={intervalHours} onChange={(e) => setIntervalHours(Number(e.target.value))}>
            <option value={1}>每 1 小时</option>
            <option value={6}>每 6 小时</option>
            <option value={12}>每 12 小时</option>
            <option value={24}>每 24 小时</option>
          </select>
          <button className="btn" onClick={saveInterval}>
            保存
          </button>
        </div>
      </section>

      <section className="panel">
        <h2>5. 侧边栏右键菜单</h2>
        <p className="desc">在侧边栏条目上右键会弹出 StarMark 自有菜单（替代浏览器默认菜单）。按需选择要开启的功能。</p>
        <div className="ctx-opts">
          {CTX_MENU_ACTIONS.map((a) => (
            <label className="chk" key={a.key}>
              <input
                type="checkbox"
                checked={ctxMenu[a.key]}
                onChange={(e) => void updateCtx(a.key, e.target.checked)}
              />
              {a.label}
            </label>
          ))}
        </div>
      </section>

      <section className="panel">
        <h2>6. 备份与恢复</h2>
        <p className="desc">导出全部本地条目（可选口令加密，AES-256-GCM）；导入会覆盖当前数据但保留 Token 与设置。</p>
        <div className="row">
          <button className="btn" onClick={doExport}>
            导出备份
          </button>
          <button className="btn" onClick={() => fileRef.current?.click()}>
            导入备份
          </button>
          <input ref={fileRef} type="file" accept=".json,application/json" hidden onChange={onImportFile} />
        </div>
      </section>

      <section className="panel">
        <h2>7. 同步诊断</h2>
        <div className="row">
          <button className="btn" onClick={refresh}>
            运行自检
          </button>
        </div>
        <ul className="stats diag">
          <li>状态机阶段：{state?.status ?? '—'}</li>
          <li>页检查点：{state?.ghSync?.page ?? 0}</li>
          <li>条件请求：{state?.ghSync?.etag ? '已启用（ETag）' : '未启用'}</li>
          <li>上次完成：{state?.lastSyncAt ? new Date(state.lastSyncAt).toLocaleString() : '从未'}</li>
          <li>最近错误：{state?.ghSync?.error ? <span className="err-text">{state.ghSync.error}</span> : '无'}</li>
          <li>书签全量遍历：{state?.bmSync?.lastFullWalkAt ? new Date(state.bmSync.lastFullWalkAt).toLocaleString() : '尚未执行'}</li>
          <li>索引版本：{state?.indexVersion ?? 0}</li>
        </ul>
      </section>

      <section className="panel danger">
        <h2>8. 数据管理</h2>
        <button className="btn danger-btn" onClick={doClear}>
          清除全部本地数据
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

      <footer className="foot">StarMark MVP · 数据 100% 本地 · {import.meta.env.VITE_ENV || 'v0.1'}</footer>
    </div>
  )
}