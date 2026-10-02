import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { repoToItem, type GitHubRepo } from '../api/mappers'
import { db } from '../db'
import { GH_SYNC_STATE_KEY, runGitHubSync, starReconcileDecision } from './github'

/*
 * Star 同步对账的完整性闸门（审查 P-121 回归）。
 *
 * 为什么值得单独测：reconcile 的方向是**删**。seenUrls 只要不是全量，没被看见的那批 star 就会
 * 被 stripSourceForUrls 摘掉来源，而它在 sources 清空时直接删条目（db.ts:347）——
 * "从第 N 页续跑"与"服务端回个空数组"这两条路都能一次摘掉大半本 starred 列表，
 * 而整个过程不报错、下一轮还回不来（用户没有"重新关联"的按钮）。
 *
 * 于是这里两头都要有证人：
 * ① 完整一轮确实会删（正对照——否则"跳过"永远绿，什么也没测到）；
 * ② 续跑那一轮确实不删，并把检查点退回第 1 页（修复本体）。
 */

const { pages, repoA, repoB } = vi.hoisted(() => {
  const repo = (n: string): GitHubRepo => ({
    id: n.charCodeAt(0),
    full_name: `owner/${n}`,
    html_url: `https://github.com/owner/${n}`,
    description: '',
    language: 'TypeScript',
    stargazers_count: 10,
    homepage: null,
  })
  return { pages: new Map<number, { repos: GitHubRepo[]; nextPage: number | null }>(), repoA: repo('alpha'), repoB: repo('beta') }
})

const { store } = vi.hoisted(() => ({ store: new Map<string, unknown>() }))

vi.mock('wxt/browser', () => ({
  browser: {
    storage: {
      local: {
        get: vi.fn(async (keys?: string | string[] | null) => {
          const out: Record<string, unknown> = {}
          if (keys == null) {
            for (const [k, v] of store) out[k] = v
            return out
          }
          const list = typeof keys === 'string' ? [keys] : keys
          for (const k of list) if (store.has(k)) out[k] = store.get(k)
          return out
        }),
        set: vi.fn(async (objs: Record<string, unknown>) => {
          for (const [k, v] of Object.entries(objs)) store.set(k, v)
        }),
        remove: vi.fn(async (keys: string | string[]) => {
          for (const k of typeof keys === 'string' ? [keys] : keys) store.delete(k)
        }),
        clear: vi.fn(async () => store.clear()),
      },
    },
  },
}))

vi.mock('../api/github', () => ({
  GitHubApiError: class GitHubApiError extends Error {},
  getToken: vi.fn(async () => 'tok'),
  validateToken: vi.fn(async () => ({ login: 'me' })),
  listStarred: vi.fn(async (page: number) => {
    const p = pages.get(page)
    return { repos: p?.repos ?? [], nextPage: p?.nextPage ?? null, notModified: false }
  }),
}))

vi.mock('../rules', () => ({ applyRulesToAll: vi.fn(async () => undefined) }))
vi.mock('../activity', () => ({ logActivity: vi.fn() }))

function seedPage(page: number, repos: GitHubRepo[], nextPage: number | null): void {
  pages.set(page, { repos, nextPage })
}

describe('starReconcileDecision：什么时候才许拿 seen 去对账', () => {
  it('从第 1 页起、翻到没有下一页、且见过东西 ⇒ 对账', () => {
    expect(starReconcileDecision({ startedFromFirstPage: true, crawledToExhaustion: true, seenCount: 12 }))
      .toBe('RECONCILE')
  })

  it('从第 N 页续跑 ⇒ 跳过并要求重爬（seen 缺前 N-1 页）', () => {
    expect(starReconcileDecision({ startedFromFirstPage: false, crawledToExhaustion: true, seenCount: 12 }))
      .toBe('SKIP_REFETCH')
  })

  it('被 MAX_PAGES 截断 ⇒ 跳过（重爬也会在同一页停下）', () => {
    expect(starReconcileDecision({ startedFromFirstPage: true, crawledToExhaustion: false, seenCount: 20_000 }))
      .toBe('SKIP_KEEP')
  })

  it('0 条的一轮 ⇒ 跳过：空响应与"全取消了"当场不可区分，而后者付不起误删', () => {
    expect(starReconcileDecision({ startedFromFirstPage: true, crawledToExhaustion: true, seenCount: 0 }))
      .toBe('SKIP_KEEP')
  })

  it('续跑那一轮即使 0 条也仍要求重爬（先补齐全量，再谈对账）', () => {
    expect(starReconcileDecision({ startedFromFirstPage: false, crawledToExhaustion: true, seenCount: 0 }))
      .toBe('SKIP_REFETCH')
  })
})

describe('runGitHubSync 真的按那道判据动手', () => {
  beforeEach(async () => {
    pages.clear()
    store.clear()
    await db.delete()
    await db.open()
    await db.items.bulkPut([repoToItem(repoA), repoToItem(repoB)])
  })

  it('完整一轮（第 1 页起、翻完、有货）才会摘掉没见过的 star —— 正对照', async () => {
    seedPage(1, [repoA], null)
    const res = await runGitHubSync()
    expect(res).toEqual({ status: 'OK', fetched: 1, removed: 1 })
    expect(await db.items.get(repoToItem(repoB).id)).toBeUndefined()
  })

  it('从第 2 页续跑的那一轮不摘任何 star，并把检查点退回第 1 页（P-121）', async () => {
    await db.syncState.put({ key: GH_SYNC_STATE_KEY, value: { phase: 'FETCH_PAGES', page: 2, etag: 'W/old' } })
    seedPage(2, [repoA], null)

    const res = await runGitHubSync()

    expect(res.status).toBe('OK')
    expect(res.removed).toBe(0)
    // 修复前这两条都会是"已删除"：B 根本没出现在第 2 页的响应里
    expect(await db.items.get(repoToItem(repoB).id)).toBeDefined()
    const next = await db.syncState.get(GH_SYNC_STATE_KEY)
    expect(next?.value).toMatchObject({ phase: 'FETCH_PAGES', page: 1 })
    // etag 必须一起清掉：留着的话下一轮开头命中 304 直接结束，这次跳过的对账永远补不回来
    expect((next?.value as { etag?: string } | undefined)?.etag).toBeUndefined()
    // 跳过对账 ≠ 跳过索引：这一轮 upsert 过的条目照样要推版本号，否则新 star 搜不到
    expect(typeof store.get('indexVersion')).toBe('number')
  })

  it('整轮只回 0 条时不摘任何 star（服务端抽风与"全取消了"分不开，宁可不删）', async () => {
    seedPage(1, [], null)
    const res = await runGitHubSync()
    expect(res.status).toBe('OK')
    expect(res.removed).toBe(0)
    expect((await db.items.toArray()).map((i) => i.id).sort()).toEqual([repoToItem(repoA).id, repoToItem(repoB).id].sort())
  })
})
