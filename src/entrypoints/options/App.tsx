import { useCallback, useEffect, useState } from 'react'
import { useT } from '~/core/i18n'
import { allItems } from '~/core/db'
import { buildHealthReport, type HealthReport } from '~/core/insights'
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

  // 全局数据刷新：BgState（经后台）+ 健康报告（页面直读 Dexie，低频报表路径）
  const refresh = useCallback(() => {
    void sendToBackground({ type: 'get-state' }).then((res) => {
      if (res.state) setState(res.state)
    })
    void allItems().then((items) => setHealth(buildHealthReport(items, 14, t)))
    // t 变化（语言切换）时健康报告文案需重建
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [t])

  useEffect(() => {
    void refresh()
  }, [refresh])

  return (
    <div className="page">
      <h1>{t('opt.title')}</h1>

      <AppearancePanel notify={notify} />
      <AccountPanel state={state} setState={setState} notify={notify} refresh={refresh} />
      <StatsPanel state={state} setState={setState} health={health} notify={notify} refresh={refresh} />
      <AiPanel notify={notify} refresh={refresh} />
      <RulesPanel notify={notify} refresh={refresh} />
      <DataPanel notify={notify} refresh={refresh} />
      <DiagPanel state={state} refresh={refresh} />

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
