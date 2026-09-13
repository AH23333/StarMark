import { browser } from 'wxt/browser'
import { useEffect, useState } from 'react'
import { clearAll } from '~/core/db'
import { sendToBackground } from '~/core/msg'
import { type ThemePreference, getThemePreference, initTheme } from '~/core/theme'
import type { BgState } from '~/core/msg'

export default function App() {
  const [token, setToken] = useState('')
  const [state, setState] = useState<BgState | null>(null)
  const [intervalHours, setIntervalHours] = useState(6)
  const [theme, setTheme] = useState<ThemePreference>('auto')
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null)

  const refresh = () =>
    void sendToBackground({ type: 'get-state' }).then((res) => {
      if (res.state) setState(res.state)
    })

  useEffect(() => {
    let disposeTheme = () => {}
    void initTheme().then((d) => {
      disposeTheme = d
    })
    void browser.storage.local.get(['pat', 'syncIntervalHours']).then((s) => {
      if (typeof s.pat === 'string' && s.pat) setToken(s.pat)
      if (typeof s.syncIntervalHours === 'number') setIntervalHours(s.syncIntervalHours)
    })
    void getThemePreference().then(setTheme)
    void refresh()
    return () => disposeTheme()
  }, [])

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

  const doClear = async () => {
    if (!confirm('将删除所有本地缓存的 Stars / 书签数据、Token 与设置，确认？')) return
    await clearAll()
    setToken('')
    setMsg({ kind: 'ok', text: '已清除全部本地数据' })
    refresh()
  }

  return (
    <div className="page">
      <h1>StarMark 设置</h1>

      <section className="panel">
        <h2>1. GitHub 连接（本地 Token）</h2>
        <p className="desc">
          创建一个 Fine-grained PAT（GitHub → Settings → Developer settings → Fine-grained tokens），只需勾选
          <code> Starring: Read </code> 用户权限，即可读取你的 Stars。数据与 Token 仅存在本机。
        </p>
        <input
          type="password"
          placeholder="github_pat_…"
          value={token}
          onChange={(e) => setToken(e.target.value)}
        />
        <div className="row">
          <button className="btn primary" onClick={saveToken}>
            保存并同步
          </button>
          {state?.ghLogin && <span className="login">已连接：{state.ghLogin}</span>}
        </div>
      </section>

      <section className="panel">
        <h2>2. 数据概览</h2>
        {state ? (
          <ul className="stats">
            <li>Stars：{state.stars}</li>
            <li>书签：{state.bookmarks}</li>
            <li>索引版本：{state.indexVersion}（状态 {state.status}）</li>
            <li>上次同步：{state.lastSyncAt ? new Date(state.lastSyncAt).toLocaleString() : '从未'}</li>
          </ul>
        ) : (
          <p className="desc">加载中…</p>
        )}
        <div className="row">
          <button className="btn" onClick={doSync}>
            立即同步
          </button>
          <button className="btn" onClick={doRebuild}>
            重建搜索索引
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

      <section className="panel danger">
        <h2>5. 数据管理</h2>
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