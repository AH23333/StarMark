import { allItems, restoreAllItems } from './db'
import { bumpIndexVersion } from './version'
import type { StarItem } from './types'

export interface BackupPayload {
  app: 'starmark'
  version: 2
  exportedAt: number
  items: StarItem[]
}

const PBKDF2_ITERATIONS = 100_000

/** 8KB 分块转 Base64（审查 P2-6）：避免 MB 级密文逐字节拼接产生大量中间串。 */
function b64FromBytes(bytes: Uint8Array<ArrayBuffer>): string {
  const CHUNK = 0x8000
  let bin = ''
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + CHUNK)) as unknown as number[])
  }
  return btoa(bin)
}

function bytesFromB64(b64: string): Uint8Array<ArrayBuffer> {
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

async function deriveKey(passphrase: string, salt: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(passphrase), 'PBKDF2', false, ['deriveKey'])
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  )
}

/** 构造备份：可选口令加密（AES-256-GCM + PBKDF2）。返回可写文件的内容字符串。 */
export async function buildBackup(passphrase?: string): Promise<{ content: string; encrypted: boolean }> {
  const items = await allItems()
  const payload: BackupPayload = { app: 'starmark', version: 2, exportedAt: Date.now(), items }
  const json = JSON.stringify(payload)
  if (!passphrase) return { content: json, encrypted: false }

  // salt 与 iv 必须每次随机生成：
  // 恒为零会导致同一口令下每次导出派生出相同密钥、且 IV 重复，
  // 直接破坏 AES-GCM 的 IV 唯一性前提（同一密钥 + 重复 IV 可用于恢复明文异或）。
  const salt: Uint8Array<ArrayBuffer> = crypto.getRandomValues(new Uint8Array(16))
  const iv: Uint8Array<ArrayBuffer> = crypto.getRandomValues(new Uint8Array(12))
  const key = await deriveKey(passphrase, salt)
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(json)))
  const envelope = JSON.stringify({
    enc: 'aes-256-gcm',
    kv: 1,
    salt: b64FromBytes(salt),
    iv: b64FromBytes(iv),
    data: b64FromBytes(ciphertext),
  })
  return { content: envelope, encrypted: true }
}

/** 解析备份（加密则需口令），校验结构。 */
export async function parseBackup(content: string, passphrase?: string): Promise<BackupPayload> {
  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(content) as Record<string, unknown>
  } catch {
    throw new Error('备份文件不是有效的 JSON')
  }

  let json = content
  if (parsed.enc) {
    if (!passphrase) throw new Error('该备份已加密，请输入口令后重试')
    try {
      const env = parsed as { salt: string; iv: string; data: string }
      const key = await deriveKey(passphrase, bytesFromB64(env.salt))
      const plain = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: bytesFromB64(env.iv) },
        key,
        bytesFromB64(env.data),
      )
      json = new TextDecoder().decode(plain)
      parsed = JSON.parse(json) as Record<string, unknown>
    } catch {
      throw new Error('口令错误或备份已损坏')
    }
  }

  if (parsed.app !== 'starmark' || !Array.isArray(parsed.items)) {
    throw new Error('不是 StarMark 备份文件')
  }
  return parsed as unknown as BackupPayload
}

/**
 * 导入备份（审查 P0-1）：通过 restoreAllItems 在同一事务内清空条目/AI 建议/动态、
 * 由导入条目全量重算 meta 基线后写入（保留 Token 与设置），
 * 最后 bump 索引版本触发 worker 全量重建。
 */
export async function restoreBackup(items: StarItem[]): Promise<void> {
  await restoreAllItems(items)
  await bumpIndexVersion()
}