import { browser } from 'wxt/browser'
import { useEffect, useMemo, useRef, useState } from 'react'
import SearchWorker from './search-worker?worker'
import { sendToBackground } from '~/core/msg'
import { initTheme } from '~/core/theme'
import type { FolderNode, SearchHit, WorkerResponse } from '~/core/search/protocol'
import type { BgState } from '~/core/msg'

interface ResultSection {
  label: string
  items: SearchHit[]
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
  const [tree, setTree] = useState<FolderNode[] | null>(null)

  // 初始化 worker + 状态
  useEffect(() => {
    let disposeTheme = () => {}
    void initTheme().then((d) => {
      disposeTheme = d
    })
    const worker = new SearchWorker()
    workerRef.current = worker
    worker.postMessage({ type: 'init' })
    worker.postMessage({ type: 'tree' })
    worker.onmessage = (e: MessageEvent<WorkerResponse>) => {
      if (e.data.type === 'ready') {
        setIndexReady(true)
        setIndexVersion(e.data.indexVersion)
      } else if (e.data.type === 'results') {
        setHits(e.data.items)
      } else if (e.data.type === 'tree-result') {
        setTree(e.data.root)
      }
    }

    const loadState = () => void sendToBackground({ type: 'get-state' }).then((res) => res.state && setState(res.state))
    void loadState()

    // index 失效（数据变更）→ 触发 worker 重建、刷新收藏夹树、刷新计数（无论同步从哪个入口发起）
    const onStorage = (changes: Record<string, { oldValue?: unknown; newValue?: unknown }>, area: string) => {
      if (area === 'local' && changes.indexVersion) {
        setIndexVersion(changes.indexVersion.newValue as number)
        void loadState()
        const timer = setTimeout(() => {
          worker.postMessage({ type: 'rebuild' })
          worker.postMessage({ type: 'tree' })
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

  // 搜索（120ms 防抖）
  useEffect(() => {
    const q = query.trim()
    reqIdRef.current++
    const reqId = reqIdRef.current
    if (!q) {
      setHits([])
      return
    }
    const timer = setTimeout(() => {
      workerRef.current?.postMessage({ type: 'search', q, max: 30 })
    }, 120)
    return () => clearTimeout(timer)
  }, [query, indexReady])

  const groups = useMemo<ResultSection[]>(() => {
    if (hits.length === 0) return []
    const needle = query.trim().toLowerCase()
    const strong: SearchHit[] = []
    const fuzzy: SearchHit[] = []
    for (const h of hits) {
      const t = h.title.toLowerCase()
      const hitsStrong = t.startsWith(needle) || h.url.toLowerCase().includes(needle)
      ;(hitsStrong ? strong : fuzzy).push(h)
    }
    const out: ResultSection[] = []
    if (strong.length) out.push({ label: '精确匹配', items: strong })
    if (fuzzy.length) out.push({ label: '相关结果', items: fuzzy })
    return out
  }, [hits, query])

  const doSync = async () => {
    setSyncing(true)
    const res = await sendToBackground({ type: 'run-sync', force: true })
    setNotify(res.ok ? '同步完成' : `同步失败：${res.error ?? '未知错误'}`)
    setSyncing(false)
    const st = await sendToBackground({ type: 'get-state' })
    if (st.state) setState(st.state)
  }

  const openOptions = () => void browser.runtime.openOptionsPage()

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

        {!query && (
          <section className="tree-view">
            <h3 className="group-label">我的收藏夹</h3>
            {tree === null && <div className="empty">正在读取收藏夹…</div>}
            {tree !== null && tree.length > 0 && (
              <FolderTree folders={tree} depth={0} />
            )}
            {tree !== null && tree.length === 0 && (
              <div className="empty">暂无书签收藏，搜索历史 Star 吧</div>
            )}
          </section>
        )}

        {state?.hasToken && !indexReady && !query && (
          <div className="empty">
            <div className="empty-title">正在构建本地搜索索引…</div>
            <p>首次使用需要几秒，之后都在后台增量维护。</p>
          </div>
        )}

        {state?.hasToken && query && hits.length === 0 && (
          <div className="empty">没有匹配「{query}」的结果</div>
        )}

        {groups.map((g) => (
          <section key={g.label}>
            <h3 className="group-label">{g.label}</h3>
            {g.items.map((h) => (
              <ResultCard key={h.id} hit={h} query={query} />
            ))}
          </section>
        ))}
      </main>
    </div>
  )
}

function FolderTree({ folders, depth }: { folders: FolderNode[]; depth: number }) {
  const [open, setOpen] = useState<Record<string, boolean>>({})
  const toggle = (path: string) => setOpen((o) => ({ ...o, [path]: !o[path] }))
  return (
    <ul className="tree" style={{ marginLeft: depth * 14 }}>
      {folders.map((f) => {
        const expanded = !!open[f.path]
        const hasKids = f.folders.length > 0
        const hasItems = f.items.length > 0
        return (
          <li key={f.id} className="tree-item">
            <button className="tree-row" onClick={() => toggle(f.path)} title={f.path}>
              <span className="tree-arrow">{hasKids || hasItems ? (expanded ? '▾' : '▸') : '·'}</span>
              <span className="tree-name">{f.kind === 'stars' ? '⭐' : '📁'} {f.name}</span>
              <span className="tree-count">{f.count}</span>
            </button>
            {expanded && (
              <div className="tree-children">
                {hasItems && (
                  <ul className="tree-items">
                    {f.items.map((it) => (
                      <li key={it.id} className="tree-leaf" onClick={() => void browser.tabs.create({ url: it.url, active: false })}>
                        <span className="tree-fav" />
                        <span className="tree-leaf-title">{it.title}</span>
                      </li>
                    ))}
                  </ul>
                )}
                {hasKids && <FolderTree folders={f.folders} depth={depth + 1} />}
              </div>
            )}
          </li>
        )
      })}
    </ul>
  )
}

function ResultCard({ hit, query }: { hit: SearchHit; query: string }) {
  const open = () => void browser.tabs.create({ url: hit.url, active: false })
  return (
    <div className="card" onClick={open}>
      <div className="card-title">
        <span
          dangerouslySetInnerHTML={{
            __html: highlight(hit.title, query),
          }}
        />
      </div>
      <div className="card-url">{hit.url}</div>
      <div className="card-meta">
        {hit.sources.includes('star') && <span className="badge star">⭐ GitHub Star</span>}
        {hit.sources.includes('bookmark') && <span className="badge bm">🔖 书签</span>}
      </div>
    </div>
  )
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