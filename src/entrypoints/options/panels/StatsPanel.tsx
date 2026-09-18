import { useT } from '~/core/i18n'
import { sendToBackground } from '~/core/msg'
import type { BgState } from '~/core/msg'
import type { HealthReport } from '~/core/insights'

type Notify = (kind: 'ok' | 'err', text: string) => void

/**
 * 统计与健康度面板：Stars/书签计数、健康评分与因子、语言分布、收录趋势、重复组，
 * 以及「立即同步 / 重建索引 / 刷新统计」操作（同步为启动即返回 + 轮询，见 AccountPanel 同款模式）。
 */
export default function StatsPanel({
  state,
  setState,
  health,
  notify,
  refresh,
}: {
  state: BgState | null
  setState: (s: BgState) => void
  health: HealthReport | null
  notify: Notify
  refresh: () => void
}) {
  const t = useT()

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

  const score = health?.score ?? (state ? 0 : null)
  const scoreColor = score === null ? 'var(--muted)' : score >= 80 ? 'var(--ok)' : score >= 50 ? 'var(--busy)' : 'var(--err)'

  return (
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
              <li>{t('opt.statsExtra', { d: health.uniqueDomains, u: health.untagged, h: health.hiddenCount })}</li>
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
  )
}
