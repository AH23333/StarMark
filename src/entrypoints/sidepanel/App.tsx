import { browser } from 'wxt/browser'
import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react'
import SearchWorker from './search-worker?worker'
import { sendToBackground } from '~/core/msg'
import { initTheme } from '~/core/theme'
import { t, useT } from '~/core/i18n'
import { CTX_MENU_ACTIONS, type ActivityEntry, type CtxMenuConfig, type ItemEditPatch, type UIPrefs } from '~/core/types'
import { tagColor } from '~/core/tagcolor'
import type { BatchAction } from '~/core/db'
import type { ExportFormat } from '~/core/export'
import type { FolderNode, SearchHit, WorkerResponse } from '~/core/search/protocol'
import { collectDupIds, collectLanguages, groupHits, type ResultSection } from '~/core/search/selectors'
import { fetchTrendingCached, type TrendingPeriod, type TrendingRepo, type TrendingResult } from '~/core/trending'
import { parseRepoFromUrl } from '~/core/convert'
import { getIndexVersion } from '~/core/version'
import type { BgState } from '~/core/msg'

type PanelTab = 'tree' | 'tags' | 'activity' | 'trending' | 'hidden'

const DEFAULT_PREFS: UIPrefs = {
  sort: 'relevance',
  source: 'all',
  groupByDomain: false,
  sourceAware: false,
  showHidden: false,
  letterAvatar: false,
  ctxMenu: { open: true, copyUrl: true, copyTitle: true, tags: true, note: true, hide: true },
}

const SORT_LABELS: Record<UIPrefs['sort'], string> = {
  relevance: 'sort.relevance',
  recent: 'sort.recent',
  starred: 'sort.starred',
  bookmarked: 'sort.bookmarked',
  stars: 'sort.stars',
  name: 'sort.name',
}

export default function App() {
  const t = useT()
  const workerRef = useRef<Worker | null>(null)
  const reqIdRef = useRef(0)

  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<SearchHit[]>([])
  const [indexReady, setIndexReady] = useState(false)
  const [indexVersion, setIndexVersion] = useState(-1)
  const [state, setState] = useState<BgState | null>(null)
  const [syncing, setSyncing] = useState(false)
  const [notify, setNotify] = useState('')
  const [activity, setActivity] = useState<ActivityEntry[]>([])
  const [hiddenItems, setHiddenItems] = useState<SearchHit[]>([])
  const [tags, setTags] = useState<{ name: string; count: number }[]>([])
  const [tree, setTree] = useState<FolderNode[] | null>(null)
  const [tab, setTab] = useState<PanelTab>('tree')
  const [trendingList, setTrendingList] = useState<TrendingRepo[]>([])
  const [trendingPeriod, setTrendingPeriod] = useState<TrendingPeriod>('weekly')
  const [trendingLoading, setTrendingLoading] = useState(false)
  const [trendingError, setTrendingError] = useState('')
  const [starredRepos, setStarredRepos] = useState<Set<string>>(new Set())
  const [trendingMeta, setTrendingMeta] = useState<{ fromCache: boolean; fetchedAt?: number; stale: boolean }>({ fromCache: false, stale: false })
  const [prefs, setPrefs] = useState<UIPrefs>(DEFAULT_PREFS)
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; hit: SearchHit } | null>(null)
  const lastParamsRef = useRef<{
    q: string
    max: number
    source: UIPrefs['source']
    includeHidden: boolean
    sort: UIPrefs['sort']
    tags?: string[]
  }>({ q: '', max: 500, source: 'all', includeHidden: false, sort: 'recent' })

  const [tagFilters, setTagFilters] = useState<string[]>([])
  // 挂载期 effect 里的 onStorage 无法读取最新的 tagFilters，用 ref 跟随当前值
  const tagFiltersRef = useRef<string[]>([])
  tagFiltersRef.current = tagFilters

  const showNotif = (t: string) => setNotify(t)

  // 初始化 worker + 状态 + 偏好
  useEffect(() => {
    let disposeTheme = () => {}
    void initTheme().then((d) => {
      disposeTheme = d
    })
    const worker = new SearchWorker()
    workerRef.current = worker
    // worker 上下文没有 chrome/browser 全局，索引版本等由面板侧读取后传入
    void getIndexVersion().then((version) => worker.postMessage({ type: 'init', version }))
    worker.postMessage({ type: 'tree' })
    worker.postMessage({ type: 'tags' })
    worker.postMessage({ type: 'activity' })
    worker.postMessage({ type: 'hidden' })
    worker.onmessage = (e: MessageEvent<WorkerResponse>) => {
      if (e.data.type === 'ready') {
        setIndexReady(true)
        setIndexVersion(e.data.indexVersion)
        // 重建完成 → 用最新索引重跑当前查询（标签/备注/隐藏等编辑后能立即看到变化）
        const p = lastParamsRef.current
        worker.postMessage({ type: 'search', q: p.q, max: p.max, source: p.source, includeHidden: p.includeHidden, sort: p.sort, tags: p.tags })
        worker.postMessage({ type: 'tree', tags: p.tags })
        worker.postMessage({ type: 'tags' })
      } else if (e.data.type === 'results') {
        setHits(e.data.items)
      } else if (e.data.type === 'tree-result') {
        setTree(e.data.root)
      } else if (e.data.type === 'tags-result') {
        setTags(e.data.tags)
      } else if (e.data.type === 'activity-result') {
        setActivity(e.data.items)
      } else if (e.data.type === 'hidden-result') {
        setHiddenItems(e.data.items)
      }
    }

    void browser.storage.local.get('ui').then((s) => {
      if (s.ui && typeof s.ui === 'object') setPrefs({ ...DEFAULT_PREFS, ...(s.ui as Partial<UIPrefs>) })
    })

    const loadState = () => void sendToBackground({ type: 'get-state' }).then((res) => res.state && setState(res.state))
    void loadState()

    // index 失效（数据变更）→ 触发 worker 重建、刷新树与计数（无论同步从哪个入口发起）
    const onStorage = (changes: Record<string, { oldValue?: unknown; newValue?: unknown }>, area: string) => {
      if (area === 'local' && changes.indexVersion) {
        const newVersion = changes.indexVersion.newValue as number
        setIndexVersion(newVersion)
        void loadState()
        const plan = changes.idxPatch?.newValue as { ids?: unknown } | undefined
        const timer = setTimeout(() => {
          // 增量更新：有 ids 则只替换这些条目；ids=null 全量重建；ids=[] 仅刷新状态
          worker.postMessage({
            type: 'invalidate',
            ids: Array.isArray(plan?.ids) ? (plan!.ids as string[]) : plan?.ids === null ? null : undefined,
            version: newVersion,
          })
          // 树重建必须携带当前标签限定，否则删除标签后浏览视图会短暂/错误地回落到全部条目
          const tf = tagFiltersRef.current
          worker.postMessage({ type: 'tree', tags: tf.length ? [...tf] : undefined })
          worker.postMessage({ type: 'tags' })
        }, 500)
        return () => clearTimeout(timer)
      }
    }
    browser.storage.onChanged.addListener(onStorage)
    return () => {
      disposeTheme()
      browser.storage.onChanged.removeListener(onStorage)
      worker.terminate()
    }
  }, [])

  // 持久化偏好
  useEffect(() => {
    void browser.storage.local.set({ ui: prefs })
  }, [prefs])

  // 动态 / 隐藏 / 回顾视图数据
  useEffect(() => {
    const w = workerRef.current
    if (!w) return
    if (tab === 'activity') w.postMessage({ type: 'activity' })
    if (tab === 'hidden') w.postMessage({ type: 'hidden' })
  }, [tab, indexVersion])

  useEffect(() => {
    if (tab !== 'trending' || !indexReady) return
    void import('~/core/db').then(({ allItems }) =>
      allItems().then((items) => {
        const names = new Set(
          items.filter((i) => i.sources.includes('star')).map((i) => i.starMeta?.fullName ?? ''),
        )
        names.delete('')
        setStarredRepos(names)
      }),
    )
  }, [tab, indexReady, indexVersion])

  // 搜索 / 浏览（120ms 防抖；空查询 = 浏览全部，带排序与过滤）
  useEffect(() => {
    const q = query.trim()
    const searching = q.length > 0
    const params = {
      q,
      max: searching ? 60 : 500,
      source: prefs.source,
      includeHidden: prefs.showHidden,
      sort: prefs.sort,
      tags: tagFilters.length ? [...tagFilters] : undefined,
    }
    lastParamsRef.current = params
    reqIdRef.current++
    const reqId = reqIdRef.current
    const w = workerRef.current
    if (!w) return
    const timer = setTimeout(() => {
      if (reqIdRef.current !== reqId) return
      w.postMessage({ type: 'search', ...params })
    }, 120)
    return () => clearTimeout(timer)
  }, [query, indexReady, indexVersion, prefs.source, prefs.showHidden, prefs.sort, tagFilters])

  // 标签限定变化 → 重建收藏夹树
  useEffect(() => {
    const w = workerRef.current
    if (!w || !indexReady) return
    w.postMessage({ type: 'tree', tags: tagFilters.length ? [...tagFilters] : undefined })
  }, [indexReady, tagFilters])

  const dupIds = useMemo(() => collectDupIds(hits), [hits])

  const languages = useMemo(() => collectLanguages(hits), [hits])

  const tagNames = useMemo(() => tags.map((t) => t.name), [tags])

  const [languageFilter, setLanguageFilter] = useState('')
  const [browseLanguageFilter, setBrowseLanguageFilter] = useState('')

  const groups = useMemo<ResultSection[]>(
    () => groupHits(hits, query, prefs, languageFilter, t),
    [hits, query, prefs, languageFilter, t],
  )

  const doSync = async () => {
    setSyncing(true)
    const res = await sendToBackground({ type: 'run-sync', force: true })
    setNotify(res.ok ? t('sync.ok') : t('sync.failed', { err: res.error ?? t('sync.unknownError') }))
    setSyncing(false)
    const st = await sendToBackground({ type: 'get-state' })
    if (st.state) setState(st.state)
    workerRef.current?.postMessage({ type: 'activity' })
  }

  /* ---------- 批量模式（阶段 B）：多选 → 加标签 / 隐藏 / 删除 / 导出所选 ---------- */

  const [batchMode, setBatchMode] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())

  const toggleSelect = useCallback((id: string, on: boolean) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (on) next.add(id)
      else next.delete(id)
      return next
    })
  }, [])

  const exitBatchMode = useCallback(() => {
    setBatchMode(false)
    setSelected(new Set())
  }, [])

  const runBatch = useCallback(
    async (action: { kind: 'addTags'; tags: string[] } | { kind: 'setHidden'; hidden: boolean } | { kind: 'delete' }) => {
      if (selected.size === 0) return
      if (action.kind === 'delete') {
        const okDelete = window.confirm(t('batch.delete.confirm', { n: selected.size }))
        if (!okDelete) return
      }
      const res = await sendToBackground({
        type: 'batch',
        action: { ...action, ids: [...selected] } as BatchAction,
        deleteBookmarks: true,
      })
      if (!res.ok) {
        showNotif(t('save.failed', { err: res.error ?? '' }))
        return
      }
      if (action.kind === 'delete') {
        showNotif(
          t('batch.done.delete', {
            n: res.batch?.affected ?? selected.size,
            bm: res.batch?.removedBookmarks ?? 0,
          }),
        )
        exitBatchMode()
      } else if (action.kind === 'addTags') {
        showNotif(t('batch.done.tags', { n: res.batch?.affected ?? 0, tags: action.tags.join(', ') }))
      } else {
        showNotif(t('batch.done.hidden', { n: res.batch?.affected ?? 0 }))
      }
      const st = await sendToBackground({ type: 'get-state' })
      if (st.state) setState(st.state)
    },
    [selected, exitBatchMode],
  )

  const exportCurrent = useCallback(
    async (format: ExportFormat) => {
      try {
        const ids = batchMode && selected.size > 0 ? [...selected] : null
        const { buildExport, exportFilename } = await import('~/core/export')
        const { db } = await import('~/core/db')
        const items =
          ids != null
            ? (await db.items.bulkGet(ids)).filter((x): x is NonNullable<typeof x> => x != null)
            : await db.items.toArray()
        const { content, mime } = buildExport(format, items)
        const blob = new Blob([content], { type: mime })
        const url = URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = url
        a.download = exportFilename(format, ids ? 'selection' : undefined)
        a.click()
        setTimeout(() => URL.revokeObjectURL(url), 5000)
        showNotif(t('export.done', { n: items.length, format }))
      } catch (e) {
        showNotif(t('export.failed', { err: (e as Error).message }))
      }
    },
    [batchMode, selected],
  )


  const openOptions = () => void browser.runtime.openOptionsPage()

  const updateItem = useCallback(
    async (id: string, patch: ItemEditPatch) => {
      const res = await sendToBackground({ type: 'update-item', id, patch })
      if (!res.ok) showNotif(t('save.failed', { err: res.error ?? '' }))
    },
    [],
  )

  const searching = query.trim().length > 0

  const loadTrending = useCallback(
    (force: boolean) => {
      setTrendingLoading(true)
      setTrendingError('')
      void fetchTrendingCached(trendingPeriod, undefined, { force })
        .then((res: TrendingResult) => {
          setTrendingList(res.list)
          setTrendingMeta({ fromCache: res.fromCache, fetchedAt: res.fetchedAt, stale: res.stale })
          if (res.stale) showNotif(t('trending.staleNotice'))
        })
        .catch((e) => setTrendingError((e as Error).message))
        .finally(() => setTrendingLoading(false))
    },
    [trendingPeriod],
  )
  useEffect(() => {
    if (tab !== 'trending') return
    loadTrending(false)
  }, [tab, trendingPeriod, loadTrending])

  const starTrending = useCallback(
    async (repo: TrendingRepo) => {
      try {
        const { starTrendingRepo } = await import('~/core/convert')
        await starTrendingRepo(repo.fullName)
        setStarredRepos((prev) => new Set(prev).add(repo.fullName))
        showNotif(t('trending.starred', { repo: repo.fullName }))
      } catch (e) {
        showNotif(t('save.failed', { err: (e as Error).message }))
      }
    },
    [],
  )

  const bookmarkTrending = useCallback(
    async (repo: TrendingRepo) => {
      try {
        const { bookmarkAStarItem } = await import('~/core/convert')
        await bookmarkAStarItem({ title: repo.fullName, url: repo.url })
        showNotif(t('convert.toBookmark.ok'))
      } catch (e) {
        showNotif(t('save.failed', { err: (e as Error).message }))
      }
    },
    [],
  )

  /** 一键互转：Star → 书签（本地创建，事件链自动合并）；书签 → Star（需 Starring: Write） */
  const convertItem = useCallback(
    async (hit: SearchHit, kind: 'toBookmark' | 'toStar') => {
      try {
        if (kind === 'toBookmark') {
          const { bookmarkAStarItem } = await import('~/core/convert')
          await bookmarkAStarItem({ title: hit.title, url: hit.url })
          showNotif(t('convert.toBookmark.ok'))
        } else {
          const { starARepoItem } = await import('~/core/convert')
          await starARepoItem(hit.id)
          showNotif(t('convert.toStar.ok'))
        }
      } catch (e) {
        showNotif(t('convert.failed', { err: (e as Error).message }))
      }
    },
    [],
  )

  const openCtx = (e: ReactMouseEvent<HTMLDivElement>, hit: SearchHit) => {
    e.preventDefault()
    setCtxMenu({ x: e.clientX, y: e.clientY, hit })
  }

  /** 点选导出格式后收起 <details> 下拉 */
  const closeDetails = (e: ReactMouseEvent<HTMLElement>) => {
    const d = (e.currentTarget as HTMLElement).closest('details')
    d?.removeAttribute('open')
  }

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="logo">★</span>
          <span className="title">StarMark</span>
        </div>
        <div className="status">
          <span className={indexReady ? 'dot ok' : 'dot busy'} />
          <span className="status-text">
            {state
              ? t('status.starsBookmarks', { stars: state.stars, bookmarks: state.bookmarks })
              : indexReady
                ? t('status.indexReady')
                : t('status.indexBuilding')}
          </span>
          <button className="btn" onClick={doSync} disabled={syncing}>
            {syncing ? t('sync.inProgress') : t('sync.sync')}
          </button>
          <button className="btn icon-btn" title={t('toolbar.settings')} onClick={openOptions}>
            ⚙
          </button>
        </div>
      </header>

      {notify && (
        <div className="notify" onClick={() => setNotify('')}>
          {notify}
        </div>
      )}

      <div className="searchbox">
        <input
          autoFocus
          type="search"
          placeholder={t('search.placeholder')}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>

      {state?.hasToken && indexReady && (
        <div className="toolbar">
          <select
            value={prefs.sort}
            onChange={(e) => setPrefs((p) => ({ ...p, sort: e.target.value as UIPrefs['sort'] }))}
            title={searching ? t('sort.title') : t('sort.titleBrowse')}
          >
            {(Object.keys(SORT_LABELS) as UIPrefs['sort'][]).map((k) => (
              <option key={k} value={k}>
                {k === 'relevance' && !searching ? t('sort.relevanceBrowse') : t(SORT_LABELS[k])}
              </option>
            ))}
          </select>
          <div className="seg">
            {(['all', 'star', 'bookmark'] as const).map((s) => (
              <button
                key={s}
                className={prefs.source === s ? 'on' : ''}
                onClick={() => {
                  setPrefs((p) => ({ ...p, source: s }))
                  // 书签无语言概念，切换后清掉可能残留的语言过滤，避免结果被莫名筛空
                  if (s === 'bookmark') {
                    setLanguageFilter('')
                    setBrowseLanguageFilter('')
                  }
                }}
                title={
                  s === 'all' ? t('source.all') : s === 'star' ? t('source.star') : t('source.bookmark')
                }
              >
                {s === 'all' ? t('source.allShort') : s === 'star' ? '⭐' : '🔖'}
              </button>
            ))}
          </div>
          {prefs.source !== 'bookmark' && languages.length > 0 && (
            <select
              value={searching ? languageFilter : browseLanguageFilter}
              onChange={(e) =>
                searching ? setLanguageFilter(e.target.value) : setBrowseLanguageFilter(e.target.value)
              }
              title={t('lang.label')}
            >
              <option value="">{t('lang.all')}</option>
              {languages.map((l) => (
                <option key={l} value={l}>
                  {l}
                </option>
              ))}
            </select>
          )}
          {searching && (
            <label className="chk">
              <input type="checkbox" checked={prefs.groupByDomain} onChange={(e) => setPrefs((p) => ({ ...p, groupByDomain: e.target.checked }))} />
              {t('toolbar.groupByDomain')}
            </label>
          )}
          {searching && (
            <label className="chk">
              <input type="checkbox" checked={prefs.sourceAware} onChange={(e) => setPrefs((p) => ({ ...p, sourceAware: e.target.checked }))} />
              {t('toolbar.sourceAware')}
            </label>
          )}
          <label className="chk">
            <input type="checkbox" checked={prefs.showHidden} onChange={(e) => setPrefs((p) => ({ ...p, showHidden: e.target.checked }))} />
            {t('toolbar.showHidden')}
          </label>
          <div className="spacer" />
          <button
            className={`btn mini${batchMode ? ' on' : ''}`}
            title={t(batchMode ? 'batch.exitTitle' : 'batch.enterTitle')}
            onClick={() => (batchMode ? exitBatchMode() : setBatchMode(true))}
          >
            ☑ {t('batch.enter')}
          </button>
          <details className="export-dd">
            <summary className="btn mini" title={t('export.title')}>
              ⇩ {t('export.button')}
            </summary>
            <div className="export-menu">
              <button onClick={(e) => { closeDetails(e); void exportCurrent('markdown') }}>{t('export.markdown')}</button>
              <button onClick={(e) => { closeDetails(e); void exportCurrent('html') }}>{t('export.html')}</button>
              <button onClick={(e) => { closeDetails(e); void exportCurrent('csv') }}>{t('export.csv')}</button>
            </div>
          </details>
        </div>
      )}

      <main className="content">
        {batchMode && (
          <BatchBar
            count={selected.size}
            onAddTags={(tags) => void runBatch({ kind: 'addTags', tags })}
            onHide={() => void runBatch({ kind: 'setHidden', hidden: true })}
            onUnhide={() => void runBatch({ kind: 'setHidden', hidden: false })}
            onDelete={() => void runBatch({ kind: 'delete' })}
            onExport={(fmt) => void exportCurrent(fmt)}
            onExit={exitBatchMode}
            allTags={tagNames}
          />
        )}

        {!state?.hasToken && (
          <div className="empty">
            <div className="empty-title">{t('empty.connectTitle')}</div>
            <p>{t('empty.connectDesc')}</p>
            <button className="btn primary" onClick={openOptions}>
              {t('empty.goSettings')}
            </button>
          </div>
        )}

        {state?.hasToken && !indexReady && !searching && (
          <div className="empty">
            <div className="empty-title">{t('empty.buildingTitle')}</div>
            <p>{t('empty.buildingDesc')}</p>
          </div>
        )}

        {tagFilters.length > 0 && (
          <div className="tag-banner">
            <span className="suggest-label">{t('tagBanner.label')}</span>
            {tagFilters.map((tag) => (
              <button
                key={tag}
                className="tag count-tag"
                style={{ color: tagColor(tag) }}
                onClick={() => setTagFilters((prev) => prev.filter((x) => x !== tag))}
                title={t('tagBanner.remove', { tag })}
              >
                #{tag} ✕
              </button>
            ))}
            <span className="tag-banner-hint">{t('tagBanner.hint')}</span>
            <button className="btn mini" onClick={() => setTagFilters([])} title={t('tagBanner.clearTitle')}>
              {t('tagBanner.clear')}
            </button>
          </div>
        )}

        {!searching && indexReady && (
          <div className="tabs">
            {(
              [
                ['tree', t('tab.folder')],
                ['tags', `${t('tab.tags')}${tags.length ? `(${tags.length})` : ''}`],
                ['trending', t('tab.trending')],
                ['activity', t('tab.activity')],
                ['hidden', `${t('tab.hidden')}${hiddenItems.length ? `(${hiddenItems.length})` : ''}`],
              ] as [PanelTab, string][]
            ).map(([k, label]) => (
              <button key={k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>
                {label}
              </button>
            ))}
          </div>
        )}

        {!searching && indexReady && tab === 'tags' && (
          <>
            {tags.length === 0 ? (
              <div className="empty">
                {t('tags.empty')}
              </div>
            ) : (
              <>
                <div className="tree-hint">{t('tags.hint')}</div>
                <div className="tag-cloud">
                  {tags.map((tg) => {
                    const on = tagFilters.includes(tg.name)
                    return (
                      <button
                        key={tg.name}
                        className={`tag count-tag${on ? ' on' : ''}`}
                        style={{ color: tagColor(tg.name) }}
                        onClick={() => {
                          setTagFilters((prev) => (on ? prev.filter((x) => x !== tg.name) : [...prev, tg.name]))
                          if (!on && tab !== 'tags') setTab('tree')
                        }}
                        title={on ? t('tags.removeFilter', { tag: tg.name }) : t('tags.addFilter', { tag: tg.name })}
                      >
                        #{tg.name}
                        <span className="tag-count">{tg.count}</span>
                      </button>
                    )
                  })}
                </div>
              </>
            )}
          </>
        )}

        {!searching && indexReady && tab === 'tree' && (
          <>
            {tree === null ? (
              <div className="empty">{t('tree.loading')}</div>
            ) : tree.length === 0 ? (
              <div className="empty">
                {state?.hasToken ? t('tree.emptyWithToken') : t('tree.emptyNoToken')}
              </div>
            ) : (
              <>
                <div className="tree-hint">
                  {t('tree.hint', { count: tree.reduce((s, n) => s + n.count, 0) })}
                </div>
                {tree
                  .filter((n) => (prefs.source === 'star' ? n.kind === 'stars' : prefs.source === 'bookmark' ? n.kind !== 'stars' : true))
                  .map((n) => (
                    <BrowseNode
                      key={`${n.path}|${n.id}`}
                      node={n}
                      prefs={prefs}
                      languageFilter={browseLanguageFilter}
                      query={query}
                      dupIds={dupIds}
                      onUpdate={updateItem}
                      onTagClick={(t) => setQuery(t)}
                      onCtx={openCtx}
                      allTags={tagNames}
                      batchMode={batchMode}
                      selected={selected}
                      onSelect={toggleSelect}
                    />
                  ))}
              </>
            )}
          </>
        )}

        {!searching && indexReady && tab === 'activity' && (
          <>
            {activity.length === 0 ? (
              <div className="empty">{t('activity.empty')}</div>
            ) : (
              <ul className="act-list">
                {activity.map((a) => (
                  <ActivityRow key={a.id ?? `${a.at}-${a.title}`} entry={a} />
                ))}
              </ul>
            )}
          </>
        )}


        {!searching && indexReady && tab === 'hidden' && (
          <>
            {hiddenItems.length === 0 ? (
              <div className="empty">{t('hidden.empty')}</div>
            ) : (
              hiddenItems.map((h) => (
                <HiddenCard
                  key={h.id}
                  hit={h}
                  showAvatar={prefs.letterAvatar !== false}
                  onRestore={() => void updateItem(h.id, { hidden: false })}
                />
              ))
            )}
          </>
        )}

        {searching &&
          (hits.length === 0 ? (
            <div className="empty">{t('search.noResults', { q: query.trim() })}</div>
          ) : (
            groups.map((g) => (
              <section key={g.label}>
                <h3 className="group-label">
                  {g.label}
                  {dupIds.size > 0 && <span className="dup-hint">{t('dup.hint', { count: dupIds.size })}</span>}
                </h3>
                {g.items.map((h) => (
                  <ResultCard
                    key={h.id}
                    hit={h}
                    query={query}
                    isDup={dupIds.has(h.id)}
                    onUpdate={updateItem}
                    onTagClick={(t) => setQuery(t)}
                    onContextMenu={(e) => openCtx(e, h)}
                    showAvatar={prefs.letterAvatar !== false}
                    allTags={tagNames}
                    selectable={batchMode}
                    selected={selected.has(h.id)}
                    onSelect={(on) => toggleSelect(h.id, on)}
                    onConvert={convertItem}
                  />
                ))}
              </section>
            ))
          ))}

        {!searching && indexReady && tab === 'trending' && (
          <TrendingView
            list={trendingList}
            loading={trendingLoading}
            error={trendingError}
            period={trendingPeriod}
            starred={starredRepos}
            meta={trendingMeta}
            onPeriod={(p) => setTrendingPeriod(p)}
            onStar={(r) => void starTrending(r)}
            onBookmark={(r) => void bookmarkTrending(r)}
            onRefresh={() => loadTrending(true)}
          />
        )}

        {ctxMenu && (
          <ContextMenu
            menu={ctxMenu}
            prefs={prefs}
            onClose={() => setCtxMenu(null)}
            onUpdate={updateItem}
            notify={showNotif}
            suggestTags={tagNames}
          />
        )}
      </main>
    </div>
  )
}

function relativeTime(ts: number): string {
  const diff = Date.now() - ts
  const m = Math.floor(diff / 60000)
  if (m < 1) return t('time.justNow')
  if (m < 60) return t('time.minutesAgo', { m })
  const h = Math.floor(m / 60)
  if (h < 24) return t('time.hoursAgo', { h })
  const d = Math.floor(h / 24)
  if (d < 30) return t('time.daysAgo', { d })
  return new Date(ts).toLocaleDateString()
}

/** 热榜推荐视图：抓取 github.com/trending，一键 Star / 存书签 */
function TrendingView({
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
  meta: { fromCache: boolean; fetchedAt?: number; stale: boolean }
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

/** 批量操作条：多选后的统一动作入口（加标签 / 隐藏 / 删除 / 导出所选） */
function BatchBar({
  count,
  onAddTags,
  onHide,
  onUnhide,
  onDelete,
  onExport,
  onExit,
  allTags,
}: {
  count: number
  onAddTags: (tags: string[]) => void
  onHide: () => void
  onUnhide: () => void
  onDelete: () => void
  onExport: (fmt: ExportFormat) => void
  onExit: () => void
  allTags: string[]
}) {
  const [tagDraft, setTagDraft] = useState('')
  const [editingTags, setEditingTags] = useState(false)

  const submitTags = () => {
    const tags = tagDraft
      .split(/[,，\s]+/)
      .map((t) => t.trim())
      .filter(Boolean)
    if (tags.length > 0) onAddTags(tags)
    setTagDraft('')
    setEditingTags(false)
  }

  return (
    <div className="batch-bar">
      <div className="batch-row">
        <span className="batch-count">{t('batch.selected', { n: count })}</span>
        <button className="btn mini" onClick={() => setEditingTags((v) => !v)} title={t('batch.addTagsTitle')}>
          🏷 {t('batch.addTags')}
        </button>
        <button className="btn mini" onClick={onHide} title={t('batch.hideTitle')}>
          👁 {t('batch.hide')}
        </button>
        <button className="btn mini" onClick={onUnhide} title={t('batch.unhideTitle')}>
          🙈 {t('batch.unhide')}
        </button>
        <button className="btn mini danger" onClick={onDelete} title={t('batch.deleteTitle')}>
          🗑 {t('batch.delete')}
        </button>
        <details className="export-dd">
          <summary className="btn mini" title={t('export.selectedTitle')}>
            ⇩ {t('export.selected')}
          </summary>
          <div className="export-menu">
            <button onClick={(e) => { e.currentTarget.closest('details')?.removeAttribute('open'); onExport('markdown') }}>{t('export.markdown')}</button>
            <button onClick={(e) => { e.currentTarget.closest('details')?.removeAttribute('open'); onExport('html') }}>{t('export.html')}</button>
            <button onClick={(e) => { e.currentTarget.closest('details')?.removeAttribute('open'); onExport('csv') }}>{t('export.csv')}</button>
          </div>
        </details>
        <button className="btn mini" onClick={onExit} title={t('batch.exitTitle')}>
          ✕
        </button>
      </div>
      {editingTags && (
        <div className="batch-row">
          <input
            className="batch-input"
            autoFocus
            value={tagDraft}
            placeholder={t('batch.tagsPlaceholder')}
            onChange={(e) => setTagDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') submitTags()
              if (e.key === 'Escape') setEditingTags(false)
            }}
          />
          <button className="btn mini primary" onClick={submitTags}>
            {t('common.save')}
          </button>
          {allTags.length > 0 && (
            <div className="batch-suggest">
              {allTags.slice(0, 16).map((tg) => (
                <button
                  key={tg}
                  className="tag"
                  style={{ color: tagColor(tg) }}
                  onClick={() => setTagDraft(tagDraft.trim() ? `${tagDraft.trim()}, ${tg}` : tg)}
                >
                  +{tg}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

const ACT_ICON: Record<string, string> = {
  star_add: '⭐＋',
  star_remove: '⭐－',
  bookmark_add: '🔖＋',
  bookmark_remove: '🔖－',
}

function ActivityRow({ entry }: { entry: ActivityEntry }) {
  return (
    <li className="act-row" onClick={() => void browser.tabs.create({ url: entry.url, active: false })}>
      <span className="act-icon">{ACT_ICON[entry.kind] ?? entry.kind}</span>
      <div className="act-body">
        <div className="act-title">{entry.title || entry.url}</div>
        <div className="act-meta">{relativeTime(entry.at)}</div>
      </div>
      <span className="act-fav" />
    </li>
  )
}

function HiddenCard({
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

function sortHits(list: SearchHit[], sort: UIPrefs['sort']): SearchHit[] {
  const cmp = (a: SearchHit, b: SearchHit): number => {
    switch (sort) {
      case 'starred':
        return (b.starredAt ?? 0) - (a.starredAt ?? 0)
      case 'bookmarked':
        return (b.bookmarkedAt ?? 0) - (a.bookmarkedAt ?? 0)
      case 'stars':
        return (b.stars ?? 0) - (a.stars ?? 0)
      case 'name':
        return a.title.localeCompare(b.title, 'zh')
      case 'recent':
      case 'relevance':
      default:
        return (b.createdAt ?? 0) - (a.createdAt ?? 0)
    }
  }
  return [...list].sort(cmp)
}

/** 收藏夹树节点：默认折叠，点击展开；条目渲染为全功能结果卡 */
function BrowseNode({
  node,
  prefs,
  languageFilter,
  query,
  dupIds,
  onUpdate,
  onTagClick,
  onCtx,
  allTags,
  batchMode,
  selected,
  onSelect,
  onConvert,
}: {
  node: FolderNode
  prefs: UIPrefs
  languageFilter: string
  query: string
  dupIds: Set<string>
  onUpdate: (id: string, patch: ItemEditPatch) => void
  onTagClick: (tag: string) => void
  onCtx: (e: ReactMouseEvent<HTMLDivElement>, hit: SearchHit) => void
  allTags?: string[]
  batchMode?: boolean
  selected?: Set<string>
  onSelect?: (id: string, on: boolean) => void
  onConvert?: (hit: SearchHit, kind: 'toBookmark' | 'toStar') => void
}) {
  const [open, setOpen] = useState(false)
  const [shown, setShown] = useState(100)

  const visible = useMemo(() => {
    let list = node.items.filter((it) => prefs.showHidden || !it.hidden)
    if (languageFilter) list = list.filter((it) => it.language === languageFilter)
    return sortHits(list, prefs.sort)
  }, [node.items, prefs.showHidden, prefs.sort, languageFilter])

  const total = node.kind === 'stars' ? node.items.length : node.count

  return (
    <div className="t-node">
      <button className="tree-row" onClick={() => setOpen((o) => !o)} title={node.path || node.name}>
        <span className="tree-arrow">{open ? '▾' : '▸'}</span>
        <span className="tree-name">
          {node.kind === 'stars' ? '⭐' : '📁'} {node.kind === 'stars' ? t('tree.allStars') : node.name}
        </span>
        <span className="tree-count">{total}</span>
      </button>
      {open && (
        <div className="tree-children">
          {visible.slice(0, shown).map((h) => (
            <ResultCard
              key={h.id}
              hit={h}
              query={query}
              isDup={dupIds.has(h.id)}
              onUpdate={onUpdate}
              onTagClick={onTagClick}
              onContextMenu={(e) => onCtx(e, h)}
              showAvatar={prefs.letterAvatar !== false}
              allTags={allTags}
              selectable={batchMode}
              selected={selected?.has(h.id)}
              onSelect={(on) => onSelect?.(h.id, on)}
              onConvert={onConvert}
            />
          ))}
          {shown < visible.length && (
            <button className="load-more" onClick={() => setShown((s) => s + 100)}>
              {t('loadMore', { n: visible.length - shown })}
            </button>
          )}
          {node.folders.map((f) => (
            <BrowseNode
              key={`${f.path}|${f.id}`}
              node={f}
              prefs={prefs}
              languageFilter={languageFilter}
              query={query}
              dupIds={dupIds}
              onUpdate={onUpdate}
              onTagClick={onTagClick}
              onCtx={onCtx}
              allTags={allTags}
              batchMode={batchMode}
              selected={selected}
              onSelect={onSelect}
            />
          ))}
        </div>
      )}
    </div>
  )
}

/** 侧边栏自有右键菜单：随偏好开关渲染条目，支持内联编辑标签/备注 */
function ContextMenu({
  menu,
  prefs,
  onClose,
  onUpdate,
  notify,
  suggestTags,
}: {
  menu: { x: number; y: number; hit: SearchHit }
  prefs: UIPrefs
  onClose: () => void
  onUpdate: (id: string, patch: ItemEditPatch) => void
  notify: (t: string) => void
  suggestTags?: string[]
}) {
  const [editing, setEditing] = useState<'tags' | 'note' | null>(null)
  const [draft, setDraft] = useState('')
  const ref = useRef<HTMLDivElement | null>(null)
  const hit = menu.hit

  useEffect(() => {
    const close = () => onClose()
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close()
    }
    const onPointer = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) close()
    }
    // 面板滚动时收起菜单；但正在编辑（输入框有焦点 / 菜单内部滚动）时绝不因滚动而退出
    const onScroll = (e: Event) => {
      const t = e.target as Node
      if (ref.current?.contains(t)) return
      if (ref.current?.contains(document.activeElement)) return
      if (editing) return
      close()
    }
    document.addEventListener('pointerdown', onPointer, true)
    document.addEventListener('keydown', onKey)
    window.addEventListener('resize', close)
    window.addEventListener('scroll', onScroll, true)
    return () => {
      document.removeEventListener('pointerdown', onPointer, true)
      document.removeEventListener('keydown', onKey)
      window.removeEventListener('resize', close)
      window.removeEventListener('scroll', onScroll, true)
    }
  }, [onClose, editing])

  const cfg = prefs.ctxMenu ?? {}
  const enabled = (k: keyof CtxMenuConfig): boolean => cfg[k] !== false
  const actions = CTX_MENU_ACTIONS.filter((a) => enabled(a.key))

  const startEdit = (kind: 'tags' | 'note') => {
    setEditing(kind)
    setDraft(kind === 'note' ? (hit.notes ?? '') : (hit.tags ?? []).join(', '))
  }
  const save = () => {
    if (editing === 'note') void onUpdate(hit.id, { notes: draft.trim() })
    if (editing === 'tags') {
      void onUpdate(hit.id, {
        tags: draft
          .split(/[,，\s]+/)
          .map((t) => t.trim())
          .filter(Boolean),
      })
    }
    onClose()
  }
  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text)
      notify(t('ctx.copied'))
    } catch {
      notify(t('ctx.copyFailed'))
    }
    onClose()
  }

  const left = Math.min(menu.x, Math.max(0, window.innerWidth - 220))
  const top = Math.min(menu.y, Math.max(0, window.innerHeight - 300))

  const run = (key: string): void => {
    if (key === 'open') {
      void browser.tabs.create({ url: hit.url, active: false })
      onClose()
    } else if (key === 'copyUrl') {
      void copy(hit.url)
    } else if (key === 'copyTitle') {
      void copy(hit.title)
    } else if (key === 'hide') {
      void onUpdate(hit.id, { hidden: !hit.hidden })
      onClose()
    }
  }

  const icon = (key: string): string => {
    if (key === 'open') return '↗ '
    if (key === 'copyUrl') return '⧉ '
    if (key === 'copyTitle') return '✂ '
    if (key === 'tags') return '🏷 '
    if (key === 'note') return '📝 '
    return hit.hidden ? '🙈 ' : '👁 '
  }

  return (
    <div className="ctx-menu" ref={ref} style={{ left, top }}>
      {actions.map((a) => {
        if (a.key !== 'tags' && a.key !== 'note') {
          return (
            <button key={a.key} className="ctx-item" onClick={() => run(a.key)}>
              {icon(a.key)}
              {a.key === 'hide' ? (hit.hidden ? t('hidden.restore') : t(`ctx.${a.key}`)) : t(`ctx.${a.key}`)}
            </button>
          )
        }
        return (
          <button key={a.key} className="ctx-item" onClick={() => startEdit(a.key as 'tags' | 'note')}>
            {icon(a.key)}
            {t(`ctx.${a.key}`)}
          </button>
        )
      })}

      {editing && (
        <div className="ctx-editor">
          {editing === 'note' ? (
            <textarea rows={3} value={draft} autoFocus placeholder={t('ctx.editorNotePlaceholder')} onChange={(e) => setDraft(e.target.value)} />
          ) : (
            <>
              {(() => {
                const draftTags = draft
                  .split(/[,，\s]+/)
                  .map((t) => t.trim())
                  .filter(Boolean)
                return draftTags.length > 0 ? (
<div className="tag-chip-row">
                    {draftTags.map((tg, i) => (
                      <button
                        key={`${tg}-${i}`}
                        className="chip"
                        style={{ color: tagColor(tg) }}
                        onClick={() =>
                          setDraft(
                            draftTags
                              .filter((x) => x !== tg)
                              .join(', '),
                          )
                        }
                        title={t('ctx.deleteTagTitle')}
                      >
                        #{tg} <span className="chip-x">✕</span>
                      </button>
                    ))}
                  </div>
                ) : null
              })()}
              <input value={draft} autoFocus placeholder={t('ctx.editorTagsPlaceholder')} onChange={(e) => setDraft(e.target.value)} />
              {suggestTags && suggestTags.length > 0 && (
                <div className="suggest-row">
                  <span className="suggest-label">{t('ctx.suggestLabel')}</span>
                  {suggestTags
                    .filter((t) => !(hit.tags ?? []).includes(t) && !draft.split(/[,，\s]+/).map((x) => x.trim()).includes(t))
                    .slice(0, 24)
                    .map((t) => (
                      <button
                        key={t}
                        className="tag suggest"
                        style={{ color: tagColor(t) }}
                        onClick={() => setDraft(draft.trim() ? `${draft.trim()}, ${t}` : t)}
                      >
                        +{t}
                      </button>
                    ))}
                </div>
              )}
            </>
          )}
          <div className="row-btns">
            <button className="btn primary" onClick={save}>
              {t('common.save')}
            </button>
            <button className="btn" onClick={() => setEditing(null)}>
              {t('common.cancel')}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

function Favicon({ hit }: { hit: SearchHit }) {
  const host = safeHost(hit.url) || '?'
  const letter = host[0]?.toUpperCase() ?? '?'
  // 槽位始终被字母占位填满（无空白缩进）；友好的 <img> 加载完成后叠在上层，
  // 加载失败（如 s2 404）则隐藏图片、保留字母。懒加载避免大量并发请求。
  return (
    <span className="favicon fav-slot" style={{ background: tagColor(hit.url) }} title={host}>
      <span className="fav-letter">{letter}</span>
      {hit.favicon && (
        <img
          className="favicon-img"
          src={hit.favicon}
          alt=""
          loading="lazy"
          decoding="async"
          onError={(e) => ((e.target as HTMLImageElement).style.display = 'none')}
        />
      )}
    </span>
  )
}

function safeHost(url: string): string {
  try {
    return new URL(url).hostname
  } catch {
    return ''
  }
}

function ResultCard({
  hit,
  query,
  isDup,
  onUpdate,
  onTagClick,
  onContextMenu,
  showAvatar,
  allTags,
  selectable,
  selected,
  onSelect,
  onConvert,
}: {
  hit: SearchHit
  query: string
  isDup: boolean
  onUpdate: (id: string, patch: ItemEditPatch) => void
  onTagClick: (tag: string) => void
  onContextMenu?: (e: ReactMouseEvent<HTMLDivElement>) => void
  showAvatar?: boolean
  allTags?: string[]
  selectable?: boolean
  selected?: boolean
  onSelect?: (on: boolean) => void
  onConvert?: (hit: SearchHit, kind: 'toBookmark' | 'toStar') => void
}) {
  const open = () => void browser.tabs.create({ url: hit.url, active: false })
  const [editing, setEditing] = useState<'note' | 'tags' | null>(null)
  const [draft, setDraft] = useState('')
  const canToBookmark = Boolean(onConvert) && !hit.sources.includes('bookmark')
  const canToStar = Boolean(onConvert) && !hit.sources.includes('star') && parseRepoFromUrl(hit.url) != null

  const startEdit = (kind: 'note' | 'tags') => {
    setEditing(kind)
    setDraft(kind === 'note' ? (hit.notes ?? '') : (hit.tags ?? []).join(', '))
  }
  const save = () => {
    if (editing === 'note') {
      void onUpdate(hit.id, { notes: draft.trim() })
    } else if (editing === 'tags') {
      void onUpdate(hit.id, {
        tags: draft
          .split(/[,，\s]+/)
          .map((t) => t.trim())
          .filter(Boolean),
      })
    }
    setEditing(null)
  }

  return (
    <div className={hit.hidden ? 'card dim' : 'card'} onContextMenu={onContextMenu}>
      <div className="card-head" onClick={selectable ? () => onSelect?.(!selected) : open}>
        {selectable && (
          <input
            type="checkbox"
            className="card-check"
            checked={Boolean(selected)}
            onChange={(e) => onSelect?.(e.target.checked)}
            onClick={(e) => e.stopPropagation()}
          />
        )}
        {showAvatar !== false && <Favicon hit={hit} />}
        <span
          className="card-title"
          dangerouslySetInnerHTML={{ __html: highlight(hit.title, query) }}
        />
      </div>
      <div className="card-sub" onClick={open}>
        {hit.language && (
          <span className="card-line">
            {hit.language}
            {typeof hit.stars === 'number' && hit.stars > 0 && ` · ★ ${hit.stars.toLocaleString()}`}
          </span>
        )}
        <span className="card-url">{hostOnly(hit.url)}</span>
      </div>
      <div className="card-sub" onClick={open}>
        {hit.description && hit.description.length > 0 ? (
          <span className="card-line desc-line">{hit.description}</span>
        ) : null}
        {hit.notes ? <span className="card-line note-line">📝 {hit.notes}</span> : null}
      </div>

      {editing === 'note' && (
        <div className="inline-edit">
          <textarea
            rows={2}
            value={draft}
            autoFocus
            placeholder={t('note.placeholder')}
            onChange={(e) => setDraft(e.target.value)}
          />
          <div className="row-btns">
            <button className="btn primary" onClick={save}>
              {t('common.save')}
            </button>
            <button className="btn" onClick={() => setEditing(null)}>
              {t('common.cancel')}
            </button>
          </div>
        </div>
      )}

      {editing === 'tags' && (
        <div className="inline-edit">
          {(() => {
            const draftTags = draft
              .split(/[,，\s]+/)
              .map((t) => t.trim())
              .filter(Boolean)
            return draftTags.length > 0 ? (
              <div className="tag-chip-row">
                {draftTags.map((tg, i) => (
                  <button
                    key={`${tg}-${i}`}
                    className="chip"
                    style={{ color: tagColor(tg) }}
                    onClick={() =>
                      setDraft(
                        draftTags
                          .filter((x) => x !== tg)
                          .join(', '),
                      )
                    }
                    title={t('ctx.deleteTagTitle')}
                  >
                    #{tg} <span className="chip-x">✕</span>
                  </button>
                ))}
              </div>
            ) : null
          })()}
          <input value={draft} autoFocus placeholder={t('ctx.editorTagsPlaceholder')} onChange={(e) => setDraft(e.target.value)} />
          {allTags && allTags.length > 0 && (
            <div className="suggest-row">
              <span className="suggest-label">{t('ctx.suggestLabel')}</span>
              {allTags
                .filter((t) => !(hit.tags ?? []).includes(t) && !draft.split(/[,，\s]+/).map((x) => x.trim()).includes(t))
                .slice(0, 24)
                .map((t) => (
                  <button
                    key={t}
                    className="tag suggest"
                    style={{ color: tagColor(t) }}
                    onClick={() => setDraft(draft.trim() ? `${draft.trim()}, ${t}` : t)}
                  >
                    +{t}
                  </button>
                ))}
            </div>
          )}
          <div className="row-btns">
            <button className="btn primary" onClick={save}>
              {t('common.save')}
            </button>
            <button className="btn" onClick={() => setEditing(null)}>
              {t('common.cancel')}
            </button>
          </div>
        </div>
      )}

      <div className="card-meta">
        {hit.sources.includes('star') && <span className="badge star">{t('badge.star')}</span>}
        {hit.sources.includes('bookmark') && <span className="badge bm">{t('badge.bookmark')}</span>}
        {isDup && <span className="badge dup" title={t('badge.dupTitle')}>{t('badge.dup')}</span>}
        {hit.tags && hit.tags.length > 0 && (
          <div className="tag-row">
            {hit.tags.map((tg) => (
              <button key={tg} className="tag" style={{ color: tagColor(tg) }} onClick={() => onTagClick(tg)} title={t('tag.search', { tag: tg })}>
                #{tg}
              </button>
            ))}
          </div>
        )}
        <div className="spacer" />
        <button className="btn mini" title={t('edit.noteTitle')} onClick={() => (editing === 'note' ? save() : startEdit('note'))}>
          ✏️
        </button>
        <button className="btn mini" title={t('edit.tagsTitle')} onClick={() => (editing === 'tags' ? save() : startEdit('tags'))}>
          🏷
        </button>
        <button
          className="btn mini"
          title={hit.hidden ? t('hidden.restore') : t('hide.hide')}
          onClick={() => void onUpdate(hit.id, { hidden: !hit.hidden })}
        >
          {hit.hidden ? '🙈' : '👁'}
        </button>
        {canToBookmark && (
          <button className="btn mini" title={t('convert.toBookmark.title')} onClick={() => onConvert?.(hit, 'toBookmark')}>
            🔖+
          </button>
        )}
        {canToStar && (
          <button className="btn mini" title={t('convert.toStar.title')} onClick={() => onConvert?.(hit, 'toStar')}>
            ⭐+
          </button>
        )}
      </div>
    </div>
  )
}

function hostOnly(url: string): string {
  try {
    return new URL(url).hostname
  } catch {
    return url
  }
}

function highlight(text: string, query: string): string {
  const q = query.trim()
  if (!q) return escapeHtml(text)
  const idx = text.toLowerCase().indexOf(q.toLowerCase())
  if (idx < 0) return escapeHtml(text)
  return `${escapeHtml(text.slice(0, idx))}<mark>${escapeHtml(text.slice(idx, idx + q.length))}</mark>${escapeHtml(text.slice(idx + q.length))}`
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}