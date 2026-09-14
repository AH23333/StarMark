import 'fake-indexeddb/auto'
import { describe, expect, it } from 'vitest'
import { buildBackup, parseBackup } from './backup'
import type { StarItem } from './types'

function mk(id: string): StarItem {
  const url = `https://example.com/${id}`
  return {
    id,
    url,
    title: `Title ${id}`,
    description: '',
    sources: ['star'],
    starredAt: 1_700_000_000_000,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    tags: ['t1'],
  }
}

describe('buildBackup / parseBackup', () => {
  it('明文往返一致', async () => {
    const { content, encrypted } = await buildBackup()
    expect(encrypted).toBe(false)
    const payload = await parseBackup(content)
    expect(payload.app).toBe('starmark')
    expect(Array.isArray(payload.items)).toBe(true)
    expect(payload.exportedAt).toBeGreaterThan(0)
  })

  it('口令加密往返一致', async () => {
    const { content, encrypted } = await buildBackup('secret')
    expect(encrypted).toBe(true)
    expect(content.startsWith('{"enc":"aes-256-gcm"')).toBe(true)
    const payload = await parseBackup(content, 'secret')
    expect(payload.items.length).toBeGreaterThanOrEqual(0)
  })

  it('错误口令抛错', async () => {
    const { content } = await buildBackup('secret')
    await expect(parseBackup(content, 'wrong')).rejects.toThrow()
    await expect(parseBackup(content)).rejects.toThrow(/口令/)
  })

  it('非有效备份抛错', async () => {
    await expect(parseBackup('{"foo":1}')).rejects.toThrow()
    await expect(parseBackup('not json')).rejects.toThrow()
  })
})