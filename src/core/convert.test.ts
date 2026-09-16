import { describe, expect, it } from 'vitest'
import { parseRepoFromUrl } from './convert'

describe('parseRepoFromUrl', () => {
  it('解析 owner/repo，深链收窄', () => {
    expect(parseRepoFromUrl('https://github.com/vercel/next.js')).toEqual({
      owner: 'vercel',
      repo: 'next.js',
      full: 'vercel/next.js',
    })
    expect(parseRepoFromUrl('https://github.com/vercel/next.js/tree/canary/packages/core')).toEqual({
      owner: 'vercel',
      repo: 'next.js',
      full: 'vercel/next.js',
    })
    expect(parseRepoFromUrl('https://github.com/vercel/next.js.git')).toEqual({
      owner: 'vercel',
      repo: 'next.js',
      full: 'vercel/next.js',
    })
    expect(parseRepoFromUrl('https://github.com/vercel/next.js/issues/123')).toEqual({
      owner: 'vercel',
      repo: 'next.js',
      full: 'vercel/next.js',
    })
  })

  it('非仓库链接返回 null', () => {
    expect(parseRepoFromUrl('https://example.com/a/b')).toBeNull()
    expect(parseRepoFromUrl('https://github.com/only-owner')).toBeNull()
    expect(parseRepoFromUrl('https://github.com/')).toBeNull()
    expect(parseRepoFromUrl('not a url')).toBeNull()
  })
})
