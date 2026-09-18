import { browser } from 'wxt/browser'
import { t } from '~/core/i18n'
import type { TrendingPeriod, TrendingRepo } from '~/core/trending'

/** 热榜推荐视图：抓取 github.com/trending，一键 Star / 存书签。 */
export function TrendingView({
  list,
  loading,
  error,
  period,
  starred,
  meta,
  onPeriod,
  onStar,
  onBookmark,
  onRefresh,
}: {
  list: TrendingRepo[]
  loading: boolean
  error: string
  period: TrendingPeriod
  starred: Set<string>
  meta: { fromCache: boolean; fetchedAt?: number; stale: boolean; via?: 'trending-html' | 'search-api' }
  onPeriod: (p: TrendingPeriod) => void
  onStar: (r: TrendingRepo) => void
  onBookmark: (r: TrendingRepo) => void
  onRefresh: () => void
}) {
  return (
    <div className="trending-wrap">
      <div className="trending-toolbar">
        {(
          [
            ['daily', t('trending.daily')],
            ['weekly', t('trending.weekly')],
            ['monthly', t('trending.monthly')],
          ] as [TrendingPeriod, string][]
        ).map(([k, label]) => (
          <button key={k} className={'seg-btn' + (period === k ? ' on' : '')} onClick={() => onPeriod(k)}>
            {label}
          </button>
        ))}
        <span className="spacer" />
        <button className="btn mini" onClick={onRefresh} title={t('trending.refreshTitle')}>
          ↻ {t('trending.refresh')}
        </button>
      </div>
      {meta.via === 'search-api' && <div className={'trending-cache stale'}>{t('trending.searchApiFallback')}</div>}
      {meta.fetchedAt != null && (
        <div className={'trending-cache' + (meta.stale ? ' stale' : '')}>
          {meta.fromCache
            ? t('trending.cachedAt', { time: new Date(meta.fetchedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) })
            : t('trending.freshAt', { time: new Date(meta.fetchedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) })}
        </div>
      )}

      {loading && <div className="empty">{t('trending.loading')}</div>}
      {!loading && error && <div className="empty">{t('trending.error', { err: error })}</div>}
      {!loading && !error && list.length === 0 && <div className="empty">{t('trending.empty')}</div>}

      {!loading &&
        !error &&
        list.map((r, idx) => {
          const isStarred = starred.has(r.fullName)
          return (
            <div key={r.fullName} className="trending-card">
              <div className="trending-rank">{idx + 1}</div>
              <div className="trending-body">
                <div className="trending-title" onClick={() => void browser.tabs.create({ url: r.url, active: false })}>
                  {r.fullName}
                </div>
                {r.description && <div className="trending-desc">{r.description}</div>}
                <div className="trending-meta">
                  {r.language && <span className="trending-lang">{r.language}</span>}
                  <span>★ {r.stars.toLocaleString()}</span>
                  {typeof r.starsToday === 'number' && (
                    <span className="trending-today">＋{r.starsToday.toLocaleString()} {t('trending.starsToday')}</span>
                  )}
                </div>
              </div>
              <div className="trending-actions">
                <button
                  className={'btn mini' + (isStarred ? ' on' : '')}
                  disabled={isStarred}
                  title={isStarred ? t('trending.alreadyStarred') : t('trending.star')}
                  onClick={() => onStar(r)}
                >
                  {isStarred ? '★' : '☆'} {isStarred ? t('trending.starred') : t('trending.star')}
                </button>
                <button className="btn mini" title={t('trending.saveBookmark')} onClick={() => onBookmark(r)}>
                  🔖+
                </button>
              </div>
            </div>
          )
        })}
    </div>
  )
}
