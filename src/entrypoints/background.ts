import { browser } from 'wxt/browser'
import { defineBackground } from 'wxt/utils/define-background'
import { runGitHubSync } from '~/core/sync/github'
import { initI18n, t } from '~/core/i18n'
import { BM_SYNC_STATE_KEY, maybeRestoreBookmarks, registerBookmarkListeners, walkAllBookmarks } from '~/core/sync/bookmarks'
import { getAppMeta, getSyncState, updateItem, applyBatch } from '~/core/db'
import { applyRulesToAll } from '~/core/rules'
import { runAiSuggestPipeline, getAiPipelineState, pendingSuggestions, approveSuggestions, rejectSuggestions } from '~/core/ai/pipeline'
import {
  runClassify,
  getClassifyState,
  getClassifyResult,
  applyClassifications,
  exportClassifications,
  importClassifications,
} from '~/core/ai/classify'
import { bumpIndexVersion, getIndexVersion } from '~/core/version'
import { GH_SYNC_STATE_KEY } from '~/core/sync/github'
import { getToken, validateToken } from '~/core/api/github'
import type { BookmarkSyncState, GitHubSyncState, SuggestEntry } from '~/core/types'
import type { BgRequest, BgResponse, BgState } from '~/core/msg'

export default defineBackground(() => {
  const ALARM_NAME = 'gh-sync'
  /** 同步防重入（SW 会话内存态，仅本生命周期有效） */
  let syncRunning = false

  async function setupAlarm(): Promise<void> {
    const s = await browser.storage.local.get('syncIntervalHours')
    const hours = (s.syncIntervalHours as number | undefined) ?? 6
    await browser.alarms.create(ALARM_NAME, { periodInMinutes: Math.max(30, hours * 60) })
  }

  /** 书签全量索引：无需 Token，节流（10 分钟内不重复全量遍历）。 */
  async function ensureBookmarkWalk(): Promise<void> {
    const state = await getSyncState<BookmarkSyncState>(BM_SYNC_STATE_KEY)
    if (state?.lastFullWalkAt && Date.now() - state.lastFullWalkAt < 10 * 60 * 1000) return
    try {
      await walkAllBookmarks()
    } catch (e) {
      console.warn('[starmark] bookmark walk failed', e)
    }
  }

  browser.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === ALARM_NAME) void runGitHubSync(false)
  })

  /* ---------- 安装 / 启动 ---------- */
  browser.runtime.onInstalled.addListener((details) => {
    void setupAlarm()
    // 点击工具栏图标直接打开侧边栏（Chrome 118+）
    void (browser as unknown as { sidePanel?: { setPanelBehavior: (o: { openPanelOnActionClick: boolean }) => Promise<void> } })
      .sidePanel?.setPanelBehavior({ openPanelOnActionClick: true })
      .catch(() => undefined)
    void ensureBookmarkWalk()
    if (details.reason === 'install') {
      void runGitHubSync(false)
    }
  })

  browser.runtime.onStartup.addListener(() => {
    void setupAlarm()
    void maybeRestoreBookmarks()
    void ensureBookmarkWalk()
    void runGitHubSync(false)
  })

  /* ---------- omnibox：地址栏 "st 关键字" 轻量建议 ---------- */
  let suggestCache: SuggestEntry[] | null = null
  let suggestVersion = -1

  async function ensureSuggestCache(): Promise<void> {
    const indexVersion = await getIndexVersion()
    if (suggestCache && suggestVersion === indexVersion) return
    const { allItems } = await import('~/core/db')
    const items = await allItems()
    suggestCache = items.map((i) => ({ id: i.id, title: i.title, url: i.url, sources: i.sources }))
    suggestVersion = indexVersion
  }

  function suggestEntries(q: string | undefined, entries: SuggestEntry[], max = 8): SuggestEntry[] {
    const needle = (q ?? '').trim().toLowerCase()
    if (!needle) return entries.slice(0, max)
    const scored = entries
      .map((e) => {
        const title = e.title.toLowerCase()
        const url = e.url.toLowerCase()
        let score = 0
        if (title.startsWith(needle)) score += 100
        else if (title.includes(needle)) score += 60
        if (url.startsWith(`https://${needle}`) || url.includes(needle)) score += 30
        if (e.sources.includes('bookmark')) score += 5
        return { e, score }
      })
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
    return scored.slice(0, max).map((x) => x.e)
  }

  function formatOmniboxEntry(e: SuggestEntry): string {
    const badges = e.sources.map((s) => (s === 'star' ? '⭐' : '🔖')).join(' ')
    return `<url>${e.title}</url> ${badges} <dim>${e.url}</dim>`
  }

  /*
   * bookmarks 与 omnibox 事件在 wxt prepare（node 模块运行器 + fake-browser）下
   * addListener 会抛 "not implemented"（defineBackground 主函数通常不在构建期执行，
   * 此处再用 ServiceWorkerGlobalScope 双保险）。
   */
  const isRealServiceWorker =
    typeof (globalThis as { ServiceWorkerGlobalScope?: unknown }).ServiceWorkerGlobalScope !== 'undefined'

  if (isRealServiceWorker) {
    registerBookmarkListeners()

    if (browser.contextMenus) {
      browser.runtime.onInstalled.addListener(() => {
        browser.contextMenus?.create({
          id: 'starmark-collect',
          title: t('bg.ctx.collect'),
          contexts: ['page', 'link'],
        })
      })

      // 右键「收藏到 StarMark」：放进专用文件夹（bookmarks.onCreated 会自动入库并记入动态）
      browser.contextMenus.onClicked.addListener((info) => {
        const targetUrl = (info.linkUrl ?? info.pageUrl) as string | undefined
        if (info.menuItemId !== 'starmark-collect' || !targetUrl) return
        void (async () => {
          try {
            const tree = (await browser.bookmarks.getTree()) as unknown as {
              children?: { id: string; title?: string; url?: string; children?: { id: string; title?: string; url?: string }[] }[]
            }[]
            const bar = tree[0]?.children?.[0]
            let folder = bar?.children?.find((n) => n.title === 'StarMark 收藏' && !n.url)
            if (!folder) {
              folder = (await browser.bookmarks.create({ parentId: bar?.id, title: 'StarMark 收藏' })) as {
                id: string
              }
            }
            await browser.bookmarks.create({
              parentId: folder.id,
              title: info.selectionText?.slice(0, 80) || targetUrl,
              url: targetUrl,
            })
          } catch (e) {
            console.warn('[starmark] quick collect failed', e)
          }
        })()
      })
    }

    const sidePanel = (browser as unknown as {
      sidePanel?: {
        open: (o: { windowId?: number; tabId?: number }) => Promise<void>
        close?: (o: { windowId?: number; tabId?: number }) => Promise<void>
        setPanelBehavior: (o: { openPanelOnActionClick: boolean }) => Promise<void>
        onOpened?: { addListener: (c: (info: { windowId: number }) => void) => void }
        onClosed?: { addListener: (c: (info: { windowId: number }) => void) => void }
      }
    }).sidePanel

    // 各窗口侧边栏开关状态：以 onOpened/onClosed 事件校准（覆盖图标点击、快捷键、手动关闭等一切途径），
    // 并写入 storage.session 以便 SW 重启后恢复（浏览器重启时面板本就全部关闭，session 也同时清空）。
    const SP_OPEN_WINDOWS_KEY = 'sidePanelOpenWindows'
    let openWindows = new Set<number>()

    function persistOpenWindows(): void {
      void browser.storage.session.set({ [SP_OPEN_WINDOWS_KEY]: [...openWindows] }).catch(() => undefined)
    }

    async function loadOpenWindows(): Promise<void> {
      try {
        const s = await browser.storage.session.get(SP_OPEN_WINDOWS_KEY)
        const arr = (s[SP_OPEN_WINDOWS_KEY] as number[] | undefined) ?? []
        openWindows = new Set(arr)
      } catch {
        openWindows = new Set()
      }
    }

    sidePanel?.onOpened?.addListener((info) => {
      openWindows.add(info.windowId)
      persistOpenWindows()
    })
    sidePanel?.onClosed?.addListener((info) => {
      openWindows.delete(info.windowId)
      persistOpenWindows()
    })

    // 切换侧边栏开关：open/close 必须在手势同一事件循环内同步调用，
    // 因此在同步路径上只读内存状态并直接发起调用；Chrome<141 无 close 时退化为仅打开。
    const toggleSidePanel = async (windowId?: number): Promise<void> => {
      try {
        if (windowId != null && typeof sidePanel?.close === 'function' && openWindows.has(windowId)) {
          await sidePanel.close({ windowId })
          openWindows.delete(windowId)
          persistOpenWindows()
        } else if (typeof sidePanel?.open === 'function') {
          const targetWindowId = windowId ?? (await browser.windows.getLastFocused()).id
          if (targetWindowId == null) return
          await sidePanel.open({ windowId: targetWindowId })
          openWindows.add(targetWindowId)
          persistOpenWindows()
        } else {
          await sidePanel?.setPanelBehavior({ openPanelOnActionClick: true })
        }
      } catch (e) {
        console.warn('[starmark] toggle side panel failed', e)
      }
    }

    void loadOpenWindows()

    // 点击工具栏图标：行为已设为 openPanelOnActionClick 由浏览器原生开合；此处兜底旧版浏览器
    browser.action?.onClicked?.addListener((tab) => {
      void toggleSidePanel(tab.windowId)
    })

    // 绑定的浏览器快捷键（Alt+S 等，设置页可改）：按一次打开、再按一次关闭
    browser.commands?.onCommand?.addListener((command, tab) => {
      if (command !== 'open-sidepanel') return
      if (typeof tab?.windowId === 'number') {
        void toggleSidePanel(tab.windowId)
        return
      }
      // 极少数无活动 tab 的情况（如焦点在浏览器 UI）：兜底取最近聚焦窗口，失败在 toggleSidePanel 内捕获
      void browser.windows.getLastFocused().then((w) => toggleSidePanel(w.id)).catch(() => {
        void toggleSidePanel()
      })
    })

    if (browser.omnibox) {
      browser.omnibox.onInputStarted.addListener(() => {
        void ensureSuggestCache()
      })

      browser.omnibox.onInputChanged.addListener((text, suggest) => {
        void (async () => {
          await ensureSuggestCache()
          const entries = suggestEntries(text, suggestCache ?? [])
          suggest(
            entries.map((e) => ({
              content: e.url,
              description: formatOmniboxEntry(e),
            })),
          )
        })()
      })

      browser.omnibox.onInputEntered.addListener((content, disposition) => {
        void browser.tabs.create({ url: content, active: disposition === 'currentTab' || disposition === 'newForegroundTab' })
      })
    }
  }

  /* ---------- PAT 变更时校验并同步；语言变更时同步右键菜单标题 ---------- */
  browser.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return
    if (changes.pat) {
      if (changes.pat.newValue) {
        void validateToken()
          .then((u) => browser.storage.local.set({ ghLogin: u.login }))
          .catch(() => browser.storage.local.remove('ghLogin'))
        if (!syncRunning) void runGitHubSync(false)
      }
    }
    if (changes.lang) {
      void initI18n().then(() => {
        browser.contextMenus.update('starmark-collect', { title: t('bg.ctx.collect') })
      })
    }
  })

  /* ---------- 消息处理（Side Panel / Options → SW） ---------- */
  browser.runtime.onMessage.addListener(
    (msg: BgRequest, _sender, sendResponse: (res: BgResponse) => void) => {
      const safe = (fn: () => void): boolean => {
        try {
          fn()
          return true
        } catch (e) {
          sendResponse({ ok: false, error: (e as Error).message })
          return true
        }
      }
      if (msg.type === 'run-sync') {
        if (syncRunning) {
          sendResponse({ ok: false, error: t('bg.err.syncRunning') })
          return false
        }
        syncRunning = true
        void runGitHubSync(msg.force ?? false)
          .then((r) => sendResponse({ ok: r.status === 'OK' || r.status === 'NOT_MODIFIED', error: r.error }))
          .catch((e) => sendResponse({ ok: false, error: (e as Error).message }))
          .finally(() => {
            syncRunning = false
          })
        return true
      }
      if (msg.type === 'walk-bookmarks') {
        void walkAllBookmarks()
          .then(() => sendResponse({ ok: true }))
          .catch((e) => sendResponse({ ok: false, error: (e as Error).message }))
        return true
      }
      if (msg.type === 'rebuild-index') {
        void bumpIndexVersion()
          .then(() => sendResponse({ ok: true }))
          .catch((e) => sendResponse({ ok: false, error: (e as Error).message }))
        return true
      }
      if (msg.type === 'apply-rules') {
        void applyRulesToAll()
          .then((r) => sendResponse({ ok: true, rules: r }))
          .catch((e) => sendResponse({ ok: false, error: (e as Error).message }))
        return true
      }
      if (msg.type === 'ai-run') {
        void runAiSuggestPipeline()
          .then((ai) => sendResponse({ ok: true, ai }))
          .catch((e) => sendResponse({ ok: false, error: (e as Error).message }))
        return true
      }
      if (msg.type === 'ai-review') {
        void (async () => {
          const ai = await getAiPipelineState()
          const pending = await pendingSuggestions()
          sendResponse({ ok: true, ai, pending })
        })().catch((e) => sendResponse({ ok: false, error: (e as Error).message }))
        return true
      }
      if (msg.type === 'ai-approve' || msg.type === 'ai-reject') {
        void (async () => {
          if (msg.type === 'ai-approve') await approveSuggestions(msg.ids)
          else await rejectSuggestions(msg.ids)
          const pending = await pendingSuggestions()
          sendResponse({ ok: true, pending })
        })().catch((e) => sendResponse({ ok: false, error: (e as Error).message }))
        return true
      }
      if (msg.type === 'ai-classify-run') {
        void runClassify()
          .then((st) => sendResponse({ ok: true, classifyState: st }))
          .catch((e) => sendResponse({ ok: false, error: (e as Error).message }))
        return true
      }
      if (msg.type === 'ai-classify-state') {
        void (async () => {
          const state = await getClassifyState()
          const result = await getClassifyResult()
          sendResponse({ ok: true, classifyState: state, classifyResult: result })
        })().catch((e) => sendResponse({ ok: false, error: (e as Error).message }))
        return true
      }
      if (msg.type === 'ai-classify-apply') {
        void applyClassifications(msg.groupTags ?? null)
          .then((r) => sendResponse({ ok: true, classifyApply: r }))
          .catch((e) => sendResponse({ ok: false, error: (e as Error).message }))
        return true
      }
      if (msg.type === 'ai-classify-export') {
        void exportClassifications()
          .then((content) => sendResponse({ ok: true, classifyExport: content }))
          .catch((e) => sendResponse({ ok: false, error: (e as Error).message }))
        return true
      }
      if (msg.type === 'ai-classify-import') {
        void importClassifications(msg.json)
          .then((r) => sendResponse({ ok: true, classifyResult: r }))
          .catch((e) => sendResponse({ ok: false, error: (e as Error).message }))
        return true
      }
      if (msg.type === 'get-state') {
        void ensureBookmarkWalk()
        void getBgState()
          .then((state) => sendResponse({ ok: true, state }))
          .catch((e) => sendResponse({ ok: false, error: (e as Error).message }))
        return true
      }
      if (msg.type === 'update-item') {
        void (async () => {
          try {
            await updateItem(msg.id, msg.patch)
            await bumpIndexVersion([msg.id])
            sendResponse({ ok: true })
          } catch (e) {
            sendResponse({ ok: false, error: (e as Error).message })
          }
        })()
        return true
      }
      if (msg.type === 'batch') {
        void (async () => {
          try {
            const result = await applyBatch(msg.action, { deleteBookmarks: msg.deleteBookmarks })
            // 全量清空索引不必要：worker 的增量补丁已容错处理“索引中不存在的 id”（含删除场景）
            await bumpIndexVersion([...new Set(msg.action.ids)])
            sendResponse({ ok: true, batch: result })
          } catch (e) {
            sendResponse({ ok: false, error: (e as Error).message })
          }
        })()
        return true
      }
      return false
    },
  )

  async function getBgState(): Promise<BgState> {
    const [token, login, ghSync, bmSync, meta, indexVersion] = await Promise.all([
      getToken(),
      browser.storage.local.get('ghLogin'),
      getSyncState<GitHubSyncState>(GH_SYNC_STATE_KEY),
      getSyncState<BookmarkSyncState>(BM_SYNC_STATE_KEY),
      getAppMeta(),
      getIndexVersion(),
    ])
    return {
      hasToken: token.length > 0,
      ghLogin: (login.ghLogin as string | undefined) ?? undefined,
      lastSyncAt: ghSync?.doneAt,
      status: ghSync?.phase ?? 'IDLE',
      stars: meta.stars,
      bookmarks: meta.bookmarks,
      hidden: meta.hidden,
      total: meta.total,
      indexVersion,
      ghSync,
      bmSync,
    }
  }
})