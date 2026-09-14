import 'fake-indexeddb/auto'
import { describe, expect, it, beforeEach } from 'vitest'
import { db, getAppMeta, getByUrl, stripSourceForUrls, updateItem, upsertItems, allItems } from './db'
import { hashId, normalizeUrl } from './normalize'
import type { StarItem } from './types'

function item(id: string, urlPath: string, sources: StarItem['sources'], extra: Partial<StarItem> = {}): StarItem {
  const url = normalizeUrl(`https://github.com/${urlPath}`)
  return {
    id: id || hashId(url),
    url,
    title: urlPath,
    description: '',
    sources,
    createdAt: 1000,
    updatedAt: 1000,
    ...extra,
  }
}

beforeEach(async () => {
  await db.delete()
  await db.open()
})

describe('meta 计数一致性', () => {
  it('upsert 新增行后更新 counts / 标签直方图', async () => {
    await upsertItems([
      item('a', 'o/a', ['star'], { tags: ['x', 'y'] }),
      item('b', 'o/b', ['star'], { tags: ['x'] }),
      item('c', 'o/c', ['bookmark']),
    ])
    const m = await getAppMeta()
    expect(m.total).toBe(3)
    expect(m.stars).toBe(2)
    expect(m.bookmarks).toBe(1)
    expect(m.tagged).toBe(2)
    expect(m.tags).toEqual({ x: 2, y: 1 })
  })

  it('upsert 合并旧行：保留用户字段与 createdAt，且只按内容变更刷新 updatedAt', async () => {
    await upsertItems([item('a', 'o/a', ['star'], { tags: ['keep'], notes: 'note', hidden: true, createdAt: 42 })])
    // 第二次同步：Star 数变化但无 tags/notes 字段 → 不应清除用户数据
    await upsertItems([{ ...item('a', 'o/a', ['star'], { updatedAt: 2000 }), starMeta: { stars: 99 } as StarItem['starMeta'] }])
    const row = await getByUrl(normalizeUrl('https://github.com/o/a'))
    expect(row?.tags).toEqual(['keep'])
    expect(row?.notes).toBe('note')
    expect(row?.hidden).toBe(true)
    expect(row?.createdAt).toBe(42)
    expect(row?.starMeta?.stars).toBe(99)
    expect(row?.updatedAt).toBe(2000)

    const m = await getAppMeta()
    expect(m.total).toBe(1)
    expect(m.stars).toBe(1)
    expect(m.tagged).toBe(1)
    expect(m.hidden).toBe(1)
    expect(m.tags).toEqual({ keep: 1 })
  })

  it('upsert 不改内容时保留原 updatedAt', async () => {
    await upsertItems([item('a', 'o/a', ['star'], { updatedAt: 5000 })])
    await upsertItems([item('a', 'o/a', ['star'])])
    const row = await getByUrl(normalizeUrl('https://github.com/o/a'))
    expect(row?.updatedAt).toBe(5000)
  })

  it('updateItem 局部修改标签/隐藏并同步直方图', async () => {
    await upsertItems([item('a', 'o/a', ['star'], { tags: ['x', 'y'] }), item('b', 'o/b', ['star'], { tags: ['x'] })])
    await updateItem('a', { tags: ['z'] })
    const m = await getAppMeta()
    expect(m.tags).toEqual({ z: 1, x: 1 })
    expect(m.tagged).toBe(2)

    await updateItem('a', { tags: [] })
    const m2 = await getAppMeta()
    expect(m2.tags).toEqual({ x: 1 })
    expect(m2.tagged).toBe(1)

    await updateItem('a', { hidden: true })
    expect((await getAppMeta()).hidden).toBe(1)
    await updateItem('a', { hidden: false })
    expect((await getAppMeta()).hidden).toBe(0)
  })

  it('stripSource 移除来源并递减计数，清空来源则删除行', async () => {
    await upsertItems([
      item('a', 'o/a', ['star', 'bookmark']),
      item('b', 'o/b', ['bookmark']),
    ])
    await stripSourceForUrls([normalizeUrl('https://github.com/o/a'), normalizeUrl('https://github.com/o/b')], 'bookmark')
    const m = await getAppMeta()
    expect(m.total).toBe(1) // b 整行删除
    expect(m.stars).toBe(1)
    expect(m.bookmarks).toBe(0)
    await expect(getByUrl(normalizeUrl('https://github.com/o/b'))).resolves.toBeUndefined()
    expect((await getByUrl(normalizeUrl('https://github.com/o/a')))?.sources).toEqual(['star'])
    expect((await allItems()).length).toBe(1)
  })
})