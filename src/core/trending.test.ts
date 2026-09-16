import { describe, expect, it } from 'vitest'
import { parseTrendingHtml } from './trending'

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
  <p>Get up and running with large language models.</p>
  <span itemprop="programmingLanguage">Go</span>
  <a href="/ollama/ollama/stargazers">98,765</a>
  <span>1,200 stars this week</span>
</article>
</body></html>
`

describe('parseTrendingHtml', () => {
  it('解析仓库名/描述/语言/星数/今日新增', () => {
    const list = parseTrendingHtml(html)
    expect(list.length).toBe(2)
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

  it('空页面返回空数组', () => {
    expect(parseTrendingHtml('<html><body>nothing</body></html>')).toEqual([])
  })
})
