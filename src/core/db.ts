import Dexie, { type EntityTable } from 'dexie'
import type { SearchIndexRecord, StarItem, SyncStateRow } from './types'

export class StarMarkDB extends Dexie {
  items!: EntityTable<StarItem, 'id'>
  searchIndex!: EntityTable<SearchIndexRecord, 'id'>
  syncState!: EntityTable<SyncStateRow, 'key'>

  constructor() {
    super('starmark')
    this.version(1).stores({
      items: 'id, &url, starredAt, bookmarkedAt, updatedAt',
      searchIndex: 'id, version, builtAt',
      syncState: 'key',
    })
  }
}

export const db = new StarMarkDB()

/* ---------- items ---------- */

export async function upsertItems(items: StarItem[]): Promise<void> {
  const CHUNK = 500
  for (let i = 0; i < items.length; i += CHUNK) {
    await db.items.bulkPut(items.slice(i, i + CHUNK))
  }
}

export async function getByUrl(url: string): Promise<StarItem | undefined> {
  return db.items.where('url').equals(url).first()
}

export async function allItems(): Promise<StarItem[]> {
  return db.items.toArray()
}

/** 从某条记录中移除某个来源；若来源清空则删除整行。 */
export async function stripSourceForUrls(urls: string[], source: 'star' | 'bookmark'): Promise<void> {
  for (const url of urls) {
    const item = await db.items.where('url').equals(url).first()
    if (!item) continue
    const sources = item.sources.filter((s) => s !== source)
    if (sources.length === 0) {
      await db.items.delete(item.id)
    } else {
      await db.items.put({ ...item, sources, updatedAt: Date.now() })
    }
  }
}

export async function countSources(): Promise<{ stars: number; bookmarks: number }> {
  const items = await db.items.toArray()
  let stars = 0
  let bookmarks = 0
  for (const item of items) {
    if (item.sources.includes('star')) stars++
    if (item.sources.includes('bookmark')) bookmarks++
  }
  return { stars, bookmarks }
}

/* ---------- searchIndex ---------- */

export async function getSearchIndex(): Promise<SearchIndexRecord | undefined> {
  return db.searchIndex.get('main')
}

export async function saveSearchIndex(rec: SearchIndexRecord): Promise<void> {
  await db.searchIndex.put({ ...rec, id: 'main' })
}

/* ---------- syncState（key-value 检查点） ---------- */

export async function getSyncState<T>(key: string): Promise<T | undefined> {
  const row = await db.syncState.get(key)
  return row?.value as T | undefined
}

export async function setSyncState(key: string, value: unknown): Promise<void> {
  await db.syncState.put({ key, value })
}

export async function clearAll(): Promise<void> {
  await db.delete()
  await db.open()
  await browser.storage.local.clear()
}