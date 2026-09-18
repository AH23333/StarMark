import { useEffect, useState } from 'react'
import { browser } from 'wxt/browser'
import { useT } from '~/core/i18n'
import { sendToBackground } from '~/core/msg'
import type { BgState } from '~/core/msg'

type Notify = (kind: 'ok' | 'err', text: string) => void

/**
 * 账号与同步面板：PAT 保存、同步频率、立即同步（启动即返回 + 轮询 syncing）、重建索引。
 * state/setState 由 App 持有（诊断与统计面板共用同一份 BgState）。
 */
export default function AccountPanel({
  state,
  setState,
  notify,
  refresh,
}: {
  state: BgState | null
  setState: (s: BgState) => void
  notify: Notify
  refresh: () => void
}) {
  const t = useT()
  const [token, setToken] = useState('')
  const [intervalHours, setIntervalHours] = useState(6)

  useEffect(() => {
    void browser.storage.local.get(['pat', 'syncIntervalHours']).then((s) => {
      if (typeof s.pat === 'string' && s.pat) setToken(s.pat)
      if (typeof s.syncIntervalHours === 'number') setIntervalHours(s.syncIntervalHours)
    })
  }, [])

  const saveToken = async () => {
    const pat = token.trim()
    if (!pat) {
      notify('err', t('msg.err.tokenRequired'))
      return
    }
    await browser.storage.local.set({ pat })
    notify('ok', t('msg.ok.tokenSaved'))
    setTimeout(refresh, 2500)
  }

  const saveInterval = async () => {
    await browser.storage.local.set({ syncIntervalHours: intervalHours })
    notify('ok', t('msg.ok.intervalSet', { h: intervalHours }))
  }

  // run-sync 已改为启动即返回（长同步不再挂消息通道）：轮询 get-state 直到
  // syncing=false，再按最后的检查点错误与否提示结果。
  const doSync = async () => {
    notify('ok', t('msg.sync.progress'))
    const res = await sendToBackground({ type: 'run-sync', force: true })
    if (!res.ok) {
      notify('err', t('sync.failed', { err: res.error ?? t('sync.unknownError') }))
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
    notify(err ? 'err' : 'ok', err ? t('sync.failed', { err }) : t('sync.ok'))
    refresh()
  }

  const doRebuild = async () => {
    const res = await sendToBackground({ type: 'rebuild-index' })
    notify(res.ok ? 'ok' : 'err', res.ok ? t('msg.ok.rebuildIndex') : t('msg.err.rebuildFailed', { err: res.error ?? '' }))
  }

  return (
    <>
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
    </>
  )
}
