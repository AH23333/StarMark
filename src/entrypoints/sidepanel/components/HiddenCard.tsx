import { browser } from 'wxt/browser'
import { t } from '~/core/i18n'
import type { SearchHit } from '~/core/search/protocol'
import { Favicon } from './ResultCard'

/** 隐藏条目卡片：仅展示标题/URL 与「恢复」操作。 */
export function HiddenCard({
  hit,
  onRestore,
  showAvatar,
}: {
  hit: SearchHit
  onRestore: () => void
  showAvatar?: boolean
}) {
  const open = () => void browser.tabs.create({ url: hit.url, active: false })
  return (
    <div className="card dim">
      <div className="card-head" onClick={open}>
        {showAvatar !== false && <Favicon hit={hit} />}
        <span className="card-title-text">{hit.title}</span>
      </div>
      <div className="card-url">{hit.url}</div>
      <div className="card-actions">
        <button className="btn" onClick={onRestore}>
          {t('hidden.restore')}
        </button>
      </div>
    </div>
  )
}
