import { describe, expect, it } from 'vitest'
import 'fake-indexeddb/auto'
import { beforeEach, vi } from 'vitest'
import { parseTrendingHtml, fetchTrendingCached, isSameLocalDay, readTrendingCache } from './trending'

// 按真实 github.com/trending 页面结构取样（col-9 描述段 + Star 按钮区干扰元素）
const html = `
<html><body>
<article class="Box-row">
  <h2><a href="/vercel/next.js" data-hydro-click>vercel/next.js</a></h2>
  <p class="col-9">The React Framework.</p>
  <span itemprop="programmingLanguage">TypeScript</span>
  <a href="/vercel/next.js/stargazers" class="d-inline-block float-right"><svg/>123,456</a>
  <span class="d-inline-block float-sm-right">4,321 stars today</span>
</article>
<article class="Box-row">
  <h2><a href="/ollama/ollama">ollama/ollama</a></h2>
  <p class="col-9">Get up and running with large language models.</p>
  <span itemprop="programmingLanguage">Go</span>
  <a href="/ollama/ollama/stargazers">98,765</a>
  <span>1,200 stars this week</span>
</article>
<article class="Box-row">
  <h2><a href="/foo/bar">foo/bar</a></h2>
  <p>Star</p>
  <span>1,000 stars today</span>
</article>
</body></html>
`

describe('parseTrendingHtml', () => {
  it('解析仓库名/描述(col-9)/语言/星数/今日新增', () => {
    const list = parseTrendingHtml(html)
    expect(list.length).toBe(3)
    expect(list[0]).toMatchObject({
      fullName: 'vercel/next.js',
      url: 'https://github.com/vercel/next.js',
      description: 'The React Framework.',
      language: 'TypeScript',
      stars: 123456,
      starsToday: 4321,
    })
    expect(list[1]).toMatchObject({
      fullName: 'ollama/ollama',
      language: 'Go',
      stars: 98765,
      starsToday: 1200,
    })
  })

  it('无 col-9 时退化为普通段落并清理 Star 污染', () => {
    const list = parseTrendingHtml(html)
    expect(list[2]!.description).toBe('')
  })

  it('空页面返回空数组', () => {
    expect(parseTrendingHtml('<html><body>nothing</body></html>')).toEqual([])
  })

  it('辅助链接（stargazers/forks）出现在主链接前也不误捕获（爬取不全/信息错误的回归）', () => {
    const tricky = `
    <article class="Box-row">
      <a href="/features">Features</a>
      <h2><a href="/foo/bar" data-view-component>foo/bar</a></h2>
      <p class="col-9">Build &amp; ship &#39;stuff&#39;.</p>
      <span itemprop="programmingLanguage">Rust</span>
      <a href="/foo/bar/stargazers" class="Link--muted"><svg class="octicon"/>7,777</a>
      <span>77 stars today</span>
    </article>`
    const list = parseTrendingHtml(tricky)
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({
      fullName: 'foo/bar', // 不被 stargazers 链接污染成多段路径
      url: 'https://github.com/foo/bar',
      description: "Build & ship 'stuff'.",
      language: 'Rust',
      stars: 7777,
      starsToday: 77,
    })
  })
})


// 缓存层依赖 chrome.storage.local；内存 Map 顶替
const { store } = vi.hoisted(() => ({ store: new Map<string, unknown>() }))
vi.mock('wxt/browser', () => ({
  browser: { storage: { local: {
    get: vi.fn(async (keys?: any) => {
      const out: Record<string, unknown> = {}
      if (keys == null) { for (const [k, v] of store) out[k] = v; return out }
      const list = typeof keys === 'string' ? [keys] : keys
      for (const k of list) if (store.has(k)) out[k] = store.get(k)
      return out
    }),
    set: vi.fn(async (objs: Record<string, unknown>) => { for (const [k, v] of Object.entries(objs)) store.set(k, v) }),
  }}},
}))

beforeEach(async () => { store.clear() })

describe('fetchTrendingCached（每日缓存语义）', () => {
  it('isSameLocalDay：同日 true，跨日 false', () => {
    const t0 = new Date(2026, 8, 17, 8, 0).getTime()
    expect(isSameLocalDay(t0, t0 + 3600_000)).toBe(true)
    expect(isSameLocalDay(t0, t0 + 86400_000)).toBe(false)
  })

  it('同一天内：首次真抓，之后读缓存不再发请求', async () => {
    const now = Date.now()
    let fetchCount = 0
    vi.stubGlobal('fetch', vi.fn(async () => {
      fetchCount++
      return {
        ok: true,
        status: 200,
        text: async () => '<article><h2><a href="/a/b">a/b</a></h2><p class="col-9">D</p></article>',
        json: async () => ({}),
      }
    }))
    const r1 = await fetchTrendingCached('weekly', undefined, { now })
    expect(r1.fromCache).toBe(false)
    expect(fetchCount).toBe(1)
    const r2 = await fetchTrendingCached('weekly', undefined, { now: now + 3600_000 })
    expect(r2.fromCache).toBe(true)
    expect(fetchCount).toBe(1) // 没有新的网络请求
    expect(r2.list.length).toBe(1)
  })

  it('force=true 跳过缓存强制重抓；跨日重抓', async () => {
    const now = Date.now()
    let fetchCount = 0
    vi.stubGlobal('fetch', vi.fn(async () => {
      fetchCount++
      return { ok: true, status: 200, text: async () => '<article><h2><a href="/a/b">a/b</a></h2></article>', json: async () => ({}) }
    }))
    await fetchTrendingCached('daily', undefined, { now })
    expect(fetchCount).toBe(1)
    await fetchTrendingCached('daily', undefined, { now: now + 3600_000, force: true })
    expect(fetchCount).toBe(2)
    await fetchTrendingCached('daily', undefined, { now: now + 2 * 86400_000 })
    expect(fetchCount).toBe(3) // 跨日自动重抓
  })

  it('抓取失败回退过期缓存（stale=true），无缓存才抛错', async () => {
    const now = Date.now()
    await fetchTrendingCached('monthly', undefined, {
      now,
      // 先成功写入缓存：借真实 fetch
    })
    // 上面那次调用会失败（无 mock 会真发请求？不——这里没有 mock，会抛错且无缓存）
    // 单独重做：先 mock 成功一次
    store.clear()
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true, status: 200,
      text: async () => '<article><h2><a href="/x/y">x/y</a></h2><p class="col-9">ok</p></article>',
      json: async () => ({}),
    })))
    await fetchTrendingCached('monthly', undefined, { now })
    // 切换为失败网络
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network down') }))
    const stale = await fetchTrendingCached('monthly', undefined, { now: now + 86400_000 * 2, force: true })
    expect(stale.stale).toBe(true)
    expect(stale.list.length).toBe(1)
    // 无任何缓存时抛错
    await expect(fetchTrendingCached('weekly', undefined, { now, force: true })).rejects.toThrow()
  })

  it('不同周期缓存相互独立', async () => {
    const now = Date.now()
    let n = 0
    vi.stubGlobal('fetch', vi.fn(async () => {
      n++
      return { ok: true, status: 200, text: async () => '<article><h2><a href="/p/' + n + '">p/' + n + '</a></h2></article>', json: async () => ({}) }
    }))
    const d = await fetchTrendingCached('daily', undefined, { now })
    const w = await fetchTrendingCached('weekly', undefined, { now })
    expect(d.list[0]!.fullName).toBe('p/1')
    expect(w.list[0]!.fullName).toBe('p/2')
    const d2 = await fetchTrendingCached('daily', undefined, { now: now + 3600_000 })
    expect(d2.list[0]!.fullName).toBe('p/1')
  })
})
