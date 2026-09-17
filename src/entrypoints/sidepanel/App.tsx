import { browser } from 'wxt/browser'
import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react'
import SearchWorker from './search-worker?worker'
import { sendToBackground } from '~/core/msg'
import { initTheme } from '~/core/theme'
import { useT } from '~/core/i18n'
import { type ActivityEntry, type ItemEditPatch, type UIPrefs } from '~/core/types'
import { tagColor } from '~/core/tagcolor'
import type { BatchAction } from '~/core/db'
import type { ExportFormat } from '~/core/export'
import type { FolderNode, SearchHit, WorkerResponse } from '~/core/search/protocol'
import { collectDupIds, collectLanguages, groupHits, type ResultSection } from '~/core/search/selectors'
import { fetchTrendingCached, type TrendingPeriod, type TrendingRepo, type TrendingResult } from '~/core/trending'
import { getIndexVersion } from '~/core/version'
import type { BgState } from '~/core/msg'
import { BatchBar } from './components/BatchBar'
import { BrowseNode } from './components/BrowseNode'
import { ContextMenu } from './components/ContextMenu'
import { ActivityRow } from './components/ActivityRow'
import { HiddenCard } from './components/HiddenCard'
import { ResultCard } from './components/ResultCard'
import { TrendingView } from './components/TrendingView'

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

  /*
   * index 失效合并器（二轮性能优化）：相邻多次 bump（如 batch 后 applyRulesToAll、
   * 书签批量事件）各自触发 onChanged，旧实现每次都新设 500ms 定时器且不清理旧的，
   * 导致重复/乱序 invalidate。现合并为一次：ids 取并集、遇全量（null/缺失）优先全量。
   */
  const pendingInvalidateRef = useRef<{
    full: boolean
    ids: Set<string>
    version: number
    timer: ReturnType<typeof setTimeout> | null
  }>({ full: false, ids: new Set(), version: -1, timer: null })

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
        const p = pendingInvalidateRef.current
        if (plan?.ids === null || !plan || !('ids' in plan)) {
          p.full = true // 全量重建 / 补丁计划缺失 → 按全量处理
        } else if (Array.isArray(plan.ids)) {
          for (const id of plan.ids as string[]) p.ids.add(id)
        } else {
          p.full = true
        }
        p.version = newVersion
        if (p.timer) clearTimeout(p.timer)
        p.timer = setTimeout(() => {
          p.timer = null
          const ids: string[] | null = p.full ? null : [...p.ids]
          p.full = false
          p.ids = new Set()
          worker.postMessage({ type: 'invalidate', ids, version: p.version })
          // 树重建必须携带当前标签限定，否则删除标签后浏览视图会短暂/错误地回落到全部条目
          const tf = tagFiltersRef.current
          worker.postMessage({ type: 'tree', tags: tf.length ? [...tf] : undefined })
          worker.postMessage({ type: 'tags' })
        }, 500)
      }
    }
    browser.storage.onChanged.addListener(onStorage)
    return () => {
      disposeTheme()
      browser.storage.onChanged.removeListener(onStorage)
      if (pendingInvalidateRef.current.timer) clearTimeout(pendingInvalidateRef.current.timer)
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
