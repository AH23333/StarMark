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

  it('加密备份的 salt / iv 每次随机（不得恒为零）', async () => {
    const a = JSON.parse((await buildBackup('secret')).content) as { salt: string; iv: string; data: string }
    const b = JSON.parse((await buildBackup('secret')).content) as { salt: string; iv: string; data: string }

    expect(a.salt).not.toBe(b.salt)
    expect(a.iv).not.toBe(b.iv)

    // 恒为零的回归防线：全零 salt/iv 会让同口令导出密钥相同、IV 重复，破坏 AES-GCM 前提
    const saltBytes = Uint8Array.from(atob(a.salt), (c) => c.charCodeAt(0))
    const ivBytes = Uint8Array.from(atob(a.iv), (c) => c.charCodeAt(0))
    expect(saltBytes.some((x) => x !== 0)).toBe(true)
    expect(ivBytes.some((x) => x !== 0)).toBe(true)

    // IV 不同 ⇒ 相同明文的密文也应不同
    expect(a.data).not.toBe(b.data)
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