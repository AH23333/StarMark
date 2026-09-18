import { useT } from '~/core/i18n'
import type { BgState } from '~/core/msg'

/** 诊断面板：同步状态机阶段、检查点、ETag、书签遍历时间与索引版本一览。 */
export default function DiagPanel({ state, refresh }: { state: BgState | null; refresh: () => void }) {
  const t = useT()
  return (
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
  )
}
