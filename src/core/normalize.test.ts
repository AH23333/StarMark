import { describe, expect, it } from 'vitest'
import { faviconFor, hashId, normalizeUrl } from './normalize'

describe('normalizeUrl', () => {
  it('统一协议与去除尾斜杠', () => {
    expect(normalizeUrl('HTTP://Example.com/')).toBe('http://example.com')
  })

  it('去除锚点与默认端口', () => {
    expect(normalizeUrl('https://example.com:443/path#frag')).toBe('https://example.com/path')
  })

  it('剥离追踪参数', () => {
    expect(normalizeUrl('https://example.com/?utm_source=x&fbclid=y&id=1')).toBe('https://example.com/?id=1')
  })

  it('GitHub 仓库页归一为 owner/repo', () => {
    expect(normalizeUrl('https://github.com/owner/repo/tree/main')).toBe('https://github.com/owner/repo')
    expect(normalizeUrl('https://github.com/owner/repo/issues')).toBe('https://github.com/owner/repo')
  })

  it('同名不同形态 URL 归一到同一结果（跨源去重依据）', () => {
    const a = normalizeUrl('https://github.com/vercel/next.js/tree/main')
    const b = normalizeUrl('github.com/vercel/next.js')
    expect(a).toBe(b)
  })

  it('非字符串输入不抛错（防御 star+json 等异常结构）', () => {
    expect(normalizeUrl(undefined as unknown as string)).toBe('')
    expect(normalizeUrl('' as string)).toBe('')
  })
})

describe('hashId', () => {
  it('稳定且为 128-bit 定长（审查 P1-1：32 位 hex）', () => {
    const h1 = hashId('https://github.com/owner/repo')
    const h2 = hashId('https://github.com/owner/repo')
    expect(h1).toBe(h2)
    expect(h1).toMatch(/^[0-9a-f]{32}$/)
  })

  it('不同 URL 大概率不同', () => {
    expect(hashId('https://a.dev/x')).not.toBe(hashId('https://a.dev/y'))
  })

  it('大小写不敏感（与 normalizeUrl 协同去重）', () => {
    expect(hashId('https://A.dev/x')).toBe(hashId('https://a.dev/x'))
  })
})

describe('faviconFor', () => {
  it('按域名生成 favicon URL', () => {
    expect(faviconFor('https://github.com/owner/repo')).toContain('github.com')
  })
})