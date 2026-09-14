import { browser } from 'wxt/browser'
import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react'
import SearchWorker from './search-worker?worker'
import { sendToBackground } from '~/core/msg'
import { initTheme } from '~/core/theme'
import { normalizedTitle } from '~/core/insights'
import { CTX_MENU_ACTIONS, type ActivityEntry, type CtxMenuConfig, type UIPrefs } from '~/core/types'
import type { FolderNode, SearchHit, WorkerResponse } from '~/core/search/protocol'
import type { BgState } from '~/core/msg'

interface ResultSection {
  label: string
  items: SearchHit[]
}

type PanelTab = 'tree' | 'tags' | 'activity' | 'hidden'

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
  relevance: '相关度',
  recent: '最近收录',
  starred: '最近 Star',
  bookmarked: '最近收藏',
  stars: 'Star 数',
  name: '名称',
}

export default function App() {
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
    worker.postMessage({ type: 'init' })
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
        setIndexVersion(changes.indexVersion.newValue as number)
        void loadState()
        const timer = setTimeout(() => {
          worker.postMessage({ type: 'rebuild' })
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

  // 动态 / 隐藏视图数据
  useEffect(() => {
    const w = workerRef.current
    if (!w) return
    if (tab === 'activity') w.postMessage({ type: 'activity' })
    if (tab === 'hidden') w.postMessage({ type: 'hidden' })
  }, [tab, indexVersion])

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

  const dupIds = useMemo(() => {
    const byTitle = new Map<string, string[]>()
    for (const h of hits) {
      const key = normalizedTitle(h.title)
      if (!key) continue
      const arr = byTitle.get(key) ?? []
      arr.push(h.id)
      byTitle.set(key, arr)
    }
    const ids = new Set<string>()
    for (const [, arr] of byTitle) if (arr.length > 1) arr.forEach((id) => ids.add(id))
    return ids
  }, [hits])

  const languages = useMemo(() => {
    const s = new Set<string>()
    for (const h of hits) if (h.language) s.add(h.language)
    return [...s].sort()
  }, [hits])

  const tagNames = useMemo(() => tags.map((t) => t.name), [tags])

  const [languageFilter, setLanguageFilter] = useState('')
  const [browseLanguageFilter, setBrowseLanguageFilter] = useState('')

  const groups = useMemo<ResultSection[]>(() => {
    let list = hits.filter((h) => !languageFilter || h.language === languageFilter)
    if (list.length === 0) return []

    if (prefs.groupByDomain) {
      const map = new Map<string, SearchHit[]>()
      for (const h of list) {
        let host = ''
        try {
          host = new URL(h.url).hostname
        } catch {
          host = h.url
        }
        const arr = map.get(host) ?? []
        arr.push(h)
        map.set(host, arr)
      }
      return [...map.entries()]
        .sort((a, b) => b[1].length - a[1].length)
        .map(([host, items]) => ({ label: host, items }))
    }

    if (prefs.sort !== 'relevance') {
      const sorted = [...list]
      const cmp = (a: SearchHit, b: SearchHit): number => {
        switch (prefs.sort) {
          case 'recent':
            return (b.createdAt ?? 0) - (a.createdAt ?? 0)
          case 'starred':
            return (b.starredAt ?? 0) - (a.starredAt ?? 0)
          case 'bookmarked':
            return (b.bookmarkedAt ?? 0) - (a.bookmarkedAt ?? 0)
          case 'stars':
            return (b.stars ?? 0) - (a.stars ?? 0)
          case 'name':
            return a.title.localeCompare(b.title, 'zh')
          default:
            return 0
        }
      }
      sorted.sort(cmp)
      return [{ label: `${sorted.length} 条结果`, items: sorted }]
    }

    const needle = query.trim().toLowerCase()
    const strong: SearchHit[] = []
    const fuzzy: SearchHit[] = []
    for (const h of list) {
      const t = h.title.toLowerCase()
      const startsWithTitle = t.startsWith(needle)
      const urlHit = h.url.toLowerCase().includes(needle)
      const isStrong = startsWithTitle || urlHit
      if (!isStrong && prefs.sourceAware && h.sources.includes('bookmark') && t.includes(needle)) {
        strong.push(h)
      } else {
        ;(isStrong ? strong : fuzzy).push(h)
      }
    }
    const out: ResultSection[] = []
    if (strong.length) out.push({ label: '精确匹配', items: strong })
    if (fuzzy.length) out.push({ label: '相关结果', items: fuzzy })
    return out
  }, [hits, query, prefs, languageFilter])

  const doSync = async () => {
    setSyncing(true)
    const res = await sendToBackground({ type: 'run-sync', force: true })
    setNotify(res.ok ? '同步完成' : `同步失败：${res.error ?? '未知错误'}`)
    setSyncing(false)
    const st = await sendToBackground({ type: 'get-state' })
    if (st.state) setState(st.state)
    workerRef.current?.postMessage({ type: 'activity' })
  }

  const openOptions = () => void browser.runtime.openOptionsPage()

  const updateItem = useCallback(
    async (id: string, patch: { notes?: string; tags?: string[]; hidden?: boolean }) => {
      const res = await sendToBackground({ type: 'update-item', id, patch })
      if (!res.ok) showNotif(`保存失败：${res.error ?? ''}`)
    },
    [],
  )

  const searching = query.trim().length > 0

  const openCtx = (e: ReactMouseEvent<HTMLDivElement>, hit: SearchHit) => {
    e.preventDefault()
    setCtxMenu({ x: e.clientX, y: e.clientY, hit })
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
              ? `Star ${state.stars} · 书签 ${state.bookmarks}`
              : indexReady
                ? '索引就绪'
                : '索引构建中…'}
          </span>
          <button className="btn" onClick={doSync} disabled={syncing}>
            {syncing ? '同步中' : '同步'}
          </button>
          <button className="btn icon-btn" title="设置" onClick={openOptions}>
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
          placeholder="搜索 Star 与书签…（地址栏输入 st 空格 + 关键词可免开本面板）"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>

      {state?.hasToken && indexReady && (
        <div className="toolbar">
          <select
            value={prefs.sort}
            onChange={(e) => setPrefs((p) => ({ ...p, sort: e.target.value as UIPrefs['sort'] }))}
            title={searching ? '排序' : '排序（未搜索时按此顺序浏览全部）'}
          >
            {(Object.keys(SORT_LABELS) as UIPrefs['sort'][]).map((k) => (
              <option key={k} value={k}>
                {k === 'relevance' && !searching ? '最近收录' : SORT_LABELS[k]}
              </option>
            ))}
          </select>
          <div className="seg">
            {(['all', 'star', 'bookmark'] as const).map((s) => (
              <button
                key={s}
                className={prefs.source === s ? 'on' : ''}
                onClick={() => setPrefs((p) => ({ ...p, source: s }))}
                title={s === 'all' ? '全部来源' : s === 'star' ? '仅 Star' : '仅书签'}
              >
                {s === 'all' ? '全部' : s === 'star' ? '⭐' : '🔖'}
              </button>
            ))}
          </div>
          {languages.length > 0 && (
            <select
              value={searching ? languageFilter : browseLanguageFilter}
              onChange={(e) =>
                searching ? setLanguageFilter(e.target.value) : setBrowseLanguageFilter(e.target.value)
              }
              title="语言"
            >
              <option value="">全部语言</option>
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
              域名分组
            </label>
          )}
          {searching && (
            <label className="chk">
              <input type="checkbox" checked={prefs.sourceAware} onChange={(e) => setPrefs((p) => ({ ...p, sourceAware: e.target.checked }))} />
              来源感知
            </label>
          )}
          <label className="chk">
            <input type="checkbox" checked={prefs.showHidden} onChange={(e) => setPrefs((p) => ({ ...p, showHidden: e.target.checked }))} />
            显示隐藏
          </label>
        </div>
      )}

      <main className="content">
        {!state?.hasToken && (
          <div className="empty">
            <div className="empty-title">连接你的 GitHub</div>
            <p>配置一次 Token，StarMark 即可拉取你的 Stars 并与书签合并搜索。数据仅保存在本地。</p>
            <button className="btn primary" onClick={openOptions}>
              前往设置
            </button>
          </div>
        )}

        {state?.hasToken && !indexReady && !searching && (
          <div className="empty">
            <div className="empty-title">正在构建本地搜索索引…</div>
            <p>首次使用需要几秒，之后都在后台增量维护。</p>
          </div>
        )}

        {tagFilters.length > 0 && (
          <div className="tag-banner">
            <span className="suggest-label">标签区域：</span>
            {tagFilters.map((t) => (
              <button
                key={t}
                className="tag count-tag"
                style={{ color: tagColor(t) }}
                onClick={() => setTagFilters((prev) => prev.filter((x) => x !== t))}
                title={`移除「${t}」`}
              >
                #{t} ✕
              </button>
            ))}
            <span className="tag-banner-hint">同时满足所选标签 · 上方搜索框可继续输入关键词</span>
            <button className="btn mini" onClick={() => setTagFilters([])} title="清除全部标签限定">
              清除
            </button>
          </div>
        )}

        {!searching && indexReady && (
          <div className="tabs">
            {(
              [
                ['tree', '📁 收藏夹'],
                ['tags', `🏷 标签${tags.length ? `(${tags.length})` : ''}`],
                ['activity', '🕒 动态'],
                ['hidden', `🙈 隐藏${hiddenItems.length ? `(${hiddenItems.length})` : ''}`],
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
                还没有标签 —— 在条目的 🏷 按钮或右键菜单里添加；新增标签会自动出现在这里，点击后进入该标签的区域浏览与搜索
              </div>
            ) : (
              <>
                <div className="tree-hint">点击标签加入过滤（可多选，同时满足），再次点击取消；选好后在收藏夹/搜索中查看</div>
                <div className="tag-cloud">
                  {tags.map((t) => {
                    const on = tagFilters.includes(t.name)
                    return (
                      <button
                        key={t.name}
                        className={`tag count-tag${on ? ' on' : ''}`}
                        style={{ color: tagColor(t.name) }}
                        onClick={() => {
                          setTagFilters((prev) => (on ? prev.filter((x) => x !== t.name) : [...prev, t.name]))
                          if (!on && tab !== 'tags') setTab('tree')
                        }}
                        title={on ? `移除「${t.name}」过滤` : `加入「${t.name}」过滤`}
                      >
                        #{t.name}
                        <span className="tag-count">{t.count}</span>
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
              <div className="empty">正在读取收藏夹…</div>
            ) : tree.length === 0 ? (
              <div className="empty">
                {state?.hasToken
                  ? '暂无数据 —— 点右上角「同步」拉取你的 Stars，或在浏览器里添加书签后回来'
                  : '配置 GitHub Token 后即可浏览你的 Star 项目'}
              </div>
            ) : (
              <>
                <div className="tree-hint">
                  点击节点展开查看内容；右键条目可快速编辑 · {tree.reduce((s, n) => s + n.count, 0)} 条
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
                    />
                  ))}
              </>
            )}
          </>
        )}

        {!searching && indexReady && tab === 'activity' && (
          <>
            {activity.length === 0 ? (
              <div className="empty">暂无动态——同步 Stars 或添加书签后，这里会展示最近的新增与移除</div>
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
              <div className="empty">没有隐藏的条目</div>
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
            <div className="empty">没有匹配「{query.trim()}」的结果</div>
          ) : (
            groups.map((g) => (
              <section key={g.label}>
                <h3 className="group-label">
                  {g.label}
                  {dupIds.size > 0 && <span className="dup-hint"> ⚠ {dupIds.size} 条疑似重复</span>}
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
                  />
                ))}
              </section>
            ))
          ))}

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
  if (m < 1) return '刚刚'
  if (m < 60) return `${m} 分钟前`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h} 小时前`
  const d = Math.floor(h / 24)
  if (d < 30) return `${d} 天前`
  return new Date(ts).toLocaleDateString()
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
          恢复显示
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
}: {
  node: FolderNode
  prefs: UIPrefs
  languageFilter: string
  query: string
  dupIds: Set<string>
  onUpdate: (id: string, patch: { notes?: string; tags?: string[]; hidden?: boolean }) => void
  onTagClick: (tag: string) => void
  onCtx: (e: ReactMouseEvent<HTMLDivElement>, hit: SearchHit) => void
  allTags?: string[]
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
          {node.kind === 'stars' ? '⭐' : '📁'} {node.name}
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
            />
          ))}
          {shown < visible.length && (
            <button className="load-more" onClick={() => setShown((s) => s + 100)}>
              展开更多（剩余 {visible.length - shown} 条）
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
  onUpdate: (id: string, patch: { notes?: string; tags?: string[]; hidden?: boolean }) => void
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
      notify('已复制')
    } catch {
      notify('复制失败')
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
              {a.key === 'hide' ? (hit.hidden ? '恢复显示' : a.label) : a.label}
            </button>
          )
        }
        return (
          <button key={a.key} className="ctx-item" onClick={() => startEdit(a.key as 'tags' | 'note')}>
            {icon(a.key)}
            {a.label}
          </button>
        )
      })}

      {editing && (
        <div className="ctx-editor">
          {editing === 'note' ? (
            <textarea rows={3} value={draft} autoFocus placeholder="收藏理由 / 备注" onChange={(e) => setDraft(e.target.value)} />
          ) : (
            <>
              {(() => {
                const draftTags = draft
                  .split(/[,，\s]+/)
                  .map((t) => t.trim())
                  .filter(Boolean)
                return draftTags.length > 0 ? (
                  <div className="tag-chip-row">
                    {draftTags.map((t, i) => (
                      <button
                        key={`${t}-${i}`}
                        className="chip"
                        style={{ color: tagColor(t) }}
                        onClick={() =>
                          setDraft(
                            draftTags
                              .filter((x) => x !== t)
                              .join(', '),
                          )
                        }
                        title="点击删除该标签"
                      >
                        #{t} <span className="chip-x">✕</span>
                      </button>
                    ))}
                  </div>
                ) : null
              })()}
              <input value={draft} autoFocus placeholder="标签，用逗号或空格分隔" onChange={(e) => setDraft(e.target.value)} />
              {suggestTags && suggestTags.length > 0 && (
                <div className="suggest-row">
                  <span className="suggest-label">快捷添加：</span>
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
              保存
            </button>
            <button className="btn" onClick={() => setEditing(null)}>
              取消
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
}: {
  hit: SearchHit
  query: string
  isDup: boolean
  onUpdate: (id: string, patch: { notes?: string; tags?: string[]; hidden?: boolean }) => void
  onTagClick: (tag: string) => void
  onContextMenu?: (e: ReactMouseEvent<HTMLDivElement>) => void
  showAvatar?: boolean
  allTags?: string[]
}) {
  const open = () => void browser.tabs.create({ url: hit.url, active: false })
  const [editing, setEditing] = useState<'note' | 'tags' | null>(null)
  const [draft, setDraft] = useState('')

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
      <div className="card-head" onClick={open}>
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
            placeholder="写下一句话的收藏理由（可选）"
            onChange={(e) => setDraft(e.target.value)}
          />
          <div className="row-btns">
            <button className="btn primary" onClick={save}>
              保存
            </button>
            <button className="btn" onClick={() => setEditing(null)}>
              取消
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
                {draftTags.map((t, i) => (
                  <button
                    key={`${t}-${i}`}
                    className="chip"
                    style={{ color: tagColor(t) }}
                    onClick={() =>
                      setDraft(
                        draftTags
                          .filter((x) => x !== t)
                          .join(', '),
                      )
                    }
                    title="点击删除该标签"
                  >
                    #{t} <span className="chip-x">✕</span>
                  </button>
                ))}
              </div>
            ) : null
          })()}
          <input value={draft} autoFocus placeholder="标签，用逗号或空格分隔" onChange={(e) => setDraft(e.target.value)} />
          {allTags && allTags.length > 0 && (
            <div className="suggest-row">
              <span className="suggest-label">快捷添加：</span>
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
              保存
            </button>
            <button className="btn" onClick={() => setEditing(null)}>
              取消
            </button>
          </div>
        </div>
      )}

      <div className="card-meta">
        {hit.sources.includes('star') && <span className="badge star">⭐ GitHub Star</span>}
        {hit.sources.includes('bookmark') && <span className="badge bm">🔖 书签</span>}
        {isDup && <span className="badge dup" title="同标题有多条记录，可在设置页查看去重报告">⚠ 疑似重复</span>}
        {hit.tags && hit.tags.length > 0 && (
          <div className="tag-row">
            {hit.tags.map((t) => (
              <button key={t} className="tag" style={{ color: tagColor(t) }} onClick={() => onTagClick(t)} title={`搜索标签「${t}」`}>
                #{t}
              </button>
            ))}
          </div>
        )}
        <div className="spacer" />
        <button className="btn mini" title="收藏理由/备注" onClick={() => (editing === 'note' ? save() : startEdit('note'))}>
          ✏️
        </button>
        <button className="btn mini" title="标签" onClick={() => (editing === 'tags' ? save() : startEdit('tags'))}>
          🏷
        </button>
        <button
          className="btn mini"
          title={hit.hidden ? '恢复显示' : '隐藏（不计入搜索与收藏夹）'}
          onClick={() => void onUpdate(hit.id, { hidden: !hit.hidden })}
        >
          {hit.hidden ? '🙈' : '👁'}
        </button>
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

/** 根据标签名生成稳定颜色 */
function tagColor(tag: string): string {
  let h = 0
  for (let i = 0; i < tag.length; i++) h = (h * 31 + tag.charCodeAt(i)) >>> 0
  const hue = h % 360
  return `hsl(${hue}, 70%, 60%)`
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