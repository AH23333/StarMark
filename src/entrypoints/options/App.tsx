import { useCallback, useEffect, useRef, useState } from 'react'
import { useT, getLang } from '~/core/i18n'
import { allItems } from '~/core/db'
import { buildHealthReport, type HealthReport } from '~/core/insights'
import { UI_POLL_MS, ZOMBIE_AFTER_MS } from '~/core/constants'
import { sendToBackground } from '~/core/msg'
import type { BgState } from '~/core/msg'
import AiPanel from './panels/AiPanel'
import AppearancePanel from './panels/AppearancePanel'
import AccountPanel from './panels/AccountPanel'
import DataPanel from './panels/DataPanel'
import DiagPanel from './panels/DiagPanel'
import RulesPanel from './panels/RulesPanel'
import StatsPanel from './panels/StatsPanel'

type Msg = { kind: 'ok' | 'err'; text: string } | null

/**
 * 设置页组装层（P1 拆分后）：只保留全局状态（BgState / 健康报告 / 提示条）与面板编排，
 * 各面板自治管理自己的领域状态（见 panels/ 目录）。
 */
export default function App() {
  const t = useT()
  const [state, setState] = useState<BgState | null>(null)
  const [health, setHealth] = useState<HealthReport | null>(null)
  const [msg, setMsg] = useState<Msg>(null)

  const notify = useCallback((kind: 'ok' | 'err', text: string) => setMsg({ kind, text }), [])

  /* 锚点导航：设置页过长，顶部按钮一键跳转到对应面板（洞察 F1：过长且序号混乱 → 导航 + 分区） */
  const panels = [
    { id: 'panel-account', key: 'nav.account' },
    { id: 'panel-stats', key: 'nav.stats' },
    { id: 'panel-ai', key: 'nav.ai' },
    { id: 'panel-rules', key: 'nav.rules' },
    { id: 'panel-data', key: 'nav.data' },
    { id: 'panel-appearance', key: 'nav.appearance' },
    { id: 'panel-diag', key: 'nav.diag' },
  ] as const

  const jumpTo = (id: string) =>
    document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' })

  // 健康报告按 indexVersion + 语言缓存：数据未变且语言未切时不重建 O(n) 报告
  const healthCacheRef = useRef<{ key: string; report: HealthReport } | null>(null)

  // 全局数据刷新：BgState（经后台）+ 健康报告（页面直读 Dexie，低频报表路径）
  const refresh = useCallback(() => {
    void (async () => {
      const st = await sendToBackground({ type: 'get-state' })
      if (st.state) setState(st.state)
      const version = st.state?.indexVersion
      const key = `${version ?? '?'}:${getLang()}`
      if (healthCacheRef.current?.key === key) {
        setHealth(healthCacheRef.current.report)
        return
      }
      const report = buildHealthReport(await allItems(), 14, t)
      healthCacheRef.current = { key, report }
      setHealth(report)
    })()
    // t 变化（语言切换）时健康报告文案需重建
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [t])

  useEffect(() => {
    void refresh()
  }, [refresh])

  return (
    <div className="page">
      <h1>{t('opt.title')}</h1>

      <nav className="panel-nav" aria-label={t('nav.aria')}>
        {panels.map((p) => (
          <button key={p.id} className="panel-nav-btn" onClick={() => jumpTo(p.id)}>
            {t(p.key)}
          </button>
        ))}
      </nav>

      <div id="panel-account">
        <AccountPanel state={state} setState={setState} notify={notify} refresh={refresh} />
      </div>
      <div id="panel-stats">
        <StatsPanel state={state} setState={setState} health={health} notify={notify} refresh={refresh} />
      </div>
      <div id="panel-ai">
        <AiPanel notify={notify} refresh={refresh} />
      </div>
      <div id="panel-rules">
        <RulesPanel notify={notify} refresh={refresh} />
      </div>
      <div id="panel-data">
        <DataPanel notify={notify} refresh={refresh} />
      </div>
      <div id="panel-appearance">
        <AppearancePanel notify={notify} />
      </div>
      <div id="panel-diag">
        <DiagPanel state={state} refresh={refresh} />
      </div>

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
