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
import { formatOmniboxEntry, suggestEntries } from '~/core/omnibox'
import type { BookmarkSyncState, GitHubSyncState, SuggestEntry } from '~/core/types'
import type { BgRequest, BgResponse, BgState } from '~/core/msg'

export default defineBackground(() => {
  // 用户显式语言偏好要在 SW 启动时立即生效（右键菜单标题等），不能等 changes.lang 事件（审查 P1-6）
  void initI18n()

  const ALARM_NAME = 'gh-sync'
  /** 同步防重入（SW 会话内存态，仅本生命周期有效） */
  let syncRunning = false

  /**
   * 统一的同步入口（二轮复查修复）：alarm / onStartup / onInstalled 此前直接调
   * runGitHubSync，绕过 syncRunning 互斥 —— 手动同步进行中时定时器触发会产生
   * 两个并发同步实例，竞态写同一份检查点。所有触发路径都收敛到这里。
   */
  async function guardedSync(force = false): Promise<void> {
    if (syncRunning) return
    syncRunning = true
    try {
      await runGitHubSync(force)
    } catch (e) {
      console.warn('[starmark] background sync failed', e)
    } finally {
      syncRunning = false
    }
  }

  async function setupAlarm(): Promise<void> {
    const s = await browser.storage.local.get('syncIntervalHours')
    const hours = (s.syncIntervalHours as number | undefined) ?? 6
    await browser.alarms.create(ALARM_NAME, { periodInMinutes: Math.max(30, hours * 60) })
  }

  /*
   * 本地 Ollama 零配置放行（AI 修复）：Ollama ≥0.1.47 按来源白名单校验请求，
   * 扩展的 Origin（chrome-extension://<id>）不在默认白名单 → 一律 403。
   * 用 DNR 把"扩展自身发往本机回环地址"的请求移除 Origin 头 —— Ollama 对无
   * Origin 请求不做校验。initiatorDomains 限定 runtime.id，只影响扩展自己的
   * 请求，不碰浏览器里其他网站对 localhost 的正常请求。
   */
  const OLLAMA_ORIGIN_RULE_ID = 20260917

  async function setupLocalOriginRule(): Promise<void> {
    try {
      const dnr = (browser as unknown as {
        declarativeNetRequest?: {
          updateDynamicRules: (o: {
            removeRuleIds: number[]
            addRules: {
              id: number
              priority: number
              action: { type: string; requestHeaders: { header: string; operation: string }[] }
              condition: { initiatorDomains: string[]; requestDomains: string[]; resourceTypes: string[] }
            }[]
          }) => Promise<void>
        }
      }).declarativeNetRequest
      if (!dnr) return
      await dnr.updateDynamicRules({
        removeRuleIds: [OLLAMA_ORIGIN_RULE_ID],
        addRules: [
          {
            id: OLLAMA_ORIGIN_RULE_ID,
            priority: 1,
            action: {
              type: 'modifyHeaders',
              requestHeaders: [{ header: 'Origin', operation: 'remove' }],
            },
            condition: {
              initiatorDomains: [browser.runtime.id],
              requestDomains: ['localhost', '127.0.0.1'],
              resourceTypes: ['xmlhttprequest'],
            },
          },
        ],
      })
    } catch (e) {
      console.warn('[starmark] DNR origin rule setup failed（如仍 403 请设置 OLLAMA_ORIGINS）', e)
    }
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
    if (alarm.name === ALARM_NAME) void guardedSync(false)
  })

  /* ---------- 安装 / 启动 ---------- */
  browser.runtime.onInstalled.addListener((details) => {
    void setupAlarm()
    void setupLocalOriginRule()
    // 点击工具栏图标直接打开侧边栏（Chrome 118+）
    void (browser as unknown as { sidePanel?: { setPanelBehavior: (o: { openPanelOnActionClick: boolean }) => Promise<void> } })
      .sidePanel?.setPanelBehavior({ openPanelOnActionClick: true })
      .catch(() => undefined)
    void ensureBookmarkWalk()
    if (details.reason === 'install') {
      void guardedSync(false)
    }
  })

  browser.runtime.onStartup.addListener(() => {
    void setupAlarm()
    void setupLocalOriginRule()
    void maybeRestoreBookmarks()
    void ensureBookmarkWalk()
    void guardedSync(false)
  })

  /* ---------- omnibox：地址栏 "st 关键字" 轻量建议 ---------- */
  // 缓存由 storage.onChanged(indexVersion) 事件失效（二轮性能优化）：
  // 旧实现每次按键都 getIndexVersion() 走一次 storage IPC 做版本校验。
  let suggestCache: SuggestEntry[] | null = null

  async function ensureSuggestCache(): Promise<void> {
    if (suggestCache) return
    const { allItems } = await import('~/core/db')
    const items = await allItems()
    suggestCache = items.map((i) => ({ id: i.id, title: i.title, url: i.url, sources: i.sources }))
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
        // onInstalled 在扩展更新时也会触发，而 Chrome 会保留旧菜单项；
        // 重复 create 同 id 会 reject 且原代码未接 catch → 未处理 rejection（审查 P1-4）。
        // 先 removeAll 再 create，整段 try/catch 兜底。
        void (async () => {
          try {
            await browser.contextMenus.removeAll()
            browser.contextMenus?.create({
              id: 'starmark-collect',
              title: t('bg.ctx.collect'),
              contexts: ['page', 'link'],
            })
          } catch (e) {
            console.warn('[starmark] context menu setup failed', e)
          }
        })()
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

  /* ---------- PAT 变更时校验并同步；语言变更时同步右键菜单标题；索引失效时清 omnibox 缓存 ---------- */
  browser.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return
    if (changes.indexVersion) {
      suggestCache = null
    }
    if (changes.pat) {
      if (changes.pat.newValue) {
        void validateToken()
          .then((u) => browser.storage.local.set({ ghLogin: u.login }))
          .catch(() => browser.storage.local.remove('ghLogin'))
        if (!syncRunning) void guardedSync(false)
      }
    }
    if (changes.lang) {
      void initI18n().then(() => {
        browser.contextMenus.update('starmark-collect', { title: t('bg.ctx.collect') })
      })
    }
  })

  /* ---------- 消息处理（Side Panel / Options → SW）—— 路由表化（审查 R3） ----------
   * 每个 handler 收到按 type 收窄后的消息、返回 BgResponse；统一由分发器做异步包装与
   * 错误兜底，杜绝"忘写 return true 导致 sendResponse 失效"这类新增消息时的隐患。
   */
  type HandlerFor<K extends BgRequest['type']> = (msg: Extract<BgRequest, { type: K }>) => Promise<BgResponse> | BgResponse
  type AnyHandler = (msg: BgRequest) => Promise<BgResponse> | BgResponse

  const handlers: { [K in BgRequest['type']]: HandlerFor<K> } = {
    'run-sync': async (msg) => {
      // 与 ai-run 同理：全量同步（数千 Star × 分页拉取）可能持续数分钟，不能挂在
      // sendMessage 通道上等完成。启动即返回，进度/结束经 get-state 轮询（syncing 字段）；
      // guardedSync 保证防重入，检查点状态机保证 SW 被杀后幂等续跑。
      if (syncRunning) return { ok: false, error: t('bg.err.syncRunning') }
      syncRunning = true
      void runGitHubSync(msg.force ?? false)
        .catch((e) => console.warn('[starmark] sync failed', e))
        .finally(() => {
          syncRunning = false
        })
      return { ok: true, state: await getBgState() }
    },
    'walk-bookmarks': async () => {
      // 全量遍历可能持续数十秒：启动即返回，lastFullWalkAt 落盘即完成信号
      void walkAllBookmarks().catch((e) => console.warn('[starmark] bookmark walk failed', e))
      return { ok: true }
    },
    'rebuild-index': async () => {
      await bumpIndexVersion()
      return { ok: true }
    },
    'apply-rules': async () => ({ ok: true, rules: await applyRulesToAll() }),
    // runAiSuggestPipeline / runClassify 已重构为"同步建立 running 状态并落盘后立即返回，
    // 处理循环在后台 promise 中继续"——handler 只挂起毫秒级，无通道超时风险，且无启动竞态
    'ai-run': async () => ({ ok: true, ai: await runAiSuggestPipeline() }),
    'ai-review': async () => ({ ok: true, ai: await getAiPipelineState(), pending: await pendingSuggestions() }),
    'ai-approve': async (msg) => {
      await approveSuggestions(msg.ids)
      return { ok: true, pending: await pendingSuggestions() }
    },
    'ai-reject': async (msg) => {
      await rejectSuggestions(msg.ids)
      return { ok: true, pending: await pendingSuggestions() }
    },
    'ai-classify-run': async () => ({ ok: true, classifyState: await runClassify() }),
    'ai-classify-state': async () => ({
      ok: true,
      classifyState: await getClassifyState(),
      classifyResult: await getClassifyResult(),
    }),
    'ai-classify-apply': async (msg) => ({ ok: true, classifyApply: await applyClassifications(msg.groupTags ?? null) }),
    'ai-classify-export': async () => ({ ok: true, classifyExport: await exportClassifications() }),
    'ai-classify-import': async (msg) => ({ ok: true, classifyResult: await importClassifications(msg.json) }),
    'get-state': async () => {
      void ensureBookmarkWalk()
      return { ok: true, state: await getBgState() }
    },
    'update-item': async (msg) => {
      await updateItem(msg.id, msg.patch)
      await bumpIndexVersion([msg.id])
      return { ok: true }
    },
    'batch': async (msg) => {
      const result = await applyBatch(msg.action, { deleteBookmarks: msg.deleteBookmarks })
      // 全量清空索引不必要：worker 的增量补丁已容错处理"索引中不存在的 id"（含删除场景）
      await bumpIndexVersion([...new Set(msg.action.ids)])
      return { ok: true, batch: result }
    },
  }

  browser.runtime.onMessage.addListener((msg: BgRequest, _sender, sendResponse: (res: BgResponse) => void) => {
    const handler = (handlers as Record<string, AnyHandler | undefined>)[msg.type]
    if (!handler) return false
    void (async () => handler(msg))()
      .then(sendResponse)
      .catch((e) => sendResponse({ ok: false, error: (e as Error).message }))
    return true
  })

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
      syncing: syncRunning,
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