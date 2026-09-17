import 'fake-indexeddb/auto'
import { describe, expect, it, beforeEach } from 'vitest'
import { applyBatch, db, getAppMeta, getByUrl, stripSourceForUrls, updateItem, upsertItems, allItems } from './db'
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

  it('upsert 同步合并保留回顾模式字段（审查 P0-2 回归）', async () => {
    await upsertItems([
      item('a', 'o/a', ['star'], { tags: ['keep'], summary: 's', reviewedAt: 12345, reviewCount: 3, reviewSkip: true }),
    ])
    // 第二次同步产物不含 review 字段（repoToItem / bookmarkToItem 均不带）→ 不应清零回顾进度
    await upsertItems([{ ...item('a', 'o/a', ['star'], { updatedAt: 2000 }), starMeta: { stars: 99 } as StarItem['starMeta'] }])
    const row = await getByUrl(normalizeUrl('https://github.com/o/a'))
    expect(row?.reviewedAt).toBe(12345)
    expect(row?.reviewCount).toBe(3)
    expect(row?.reviewSkip).toBe(true)
    expect(row?.summary).toBe('s')
    expect(row?.tags).toEqual(['keep'])
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

describe('applyBatch 批量操作', () => {
  it('addTags 合并去重、只更新实际变化的行并同步直方图', async () => {
    await upsertItems([
      item('a', 'o/a', ['star'], { tags: ['x'] }),
      item('b', 'o/b', ['star']),
      item('c', 'o/c', ['star'], { tags: ['x', 'y'] }),
    ])
    const res = await applyBatch({ kind: 'addTags', ids: ['a', 'b', 'c'], tags: ['x', 'z'] })
    expect(res.affected).toBe(3)
    expect((await getByUrl(normalizeUrl('https://github.com/o/a')))?.tags).toEqual(['x', 'z'])
    expect((await getByUrl(normalizeUrl('https://github.com/o/b')))?.tags).toEqual(['x', 'z'])
    expect((await getByUrl(normalizeUrl('https://github.com/o/c')))?.tags).toEqual(['x', 'y', 'z'])
    const m = await getAppMeta()
    expect(m.tags).toEqual({ x: 3, z: 3, y: 1 })
    expect(m.tagged).toBe(3)
  })

  it('removeTags 移除后空标签数组被清掉', async () => {
    await upsertItems([
      item('a', 'o/a', ['star'], { tags: ['x', 'y'] }),
      item('b', 'o/b', ['star'], { tags: ['y'] }),
    ])
    await applyBatch({ kind: 'removeTags', ids: ['a', 'b'], tags: ['x'] })
    expect((await getByUrl(normalizeUrl('https://github.com/o/a')))?.tags).toEqual(['y'])
    expect((await getByUrl(normalizeUrl('https://github.com/o/b')))?.tags).toEqual(['y'])
    const m = await getAppMeta()
    expect(m.tags).toEqual({ y: 2 })
    expect(m.tagged).toBe(2)
  })

  it('setHidden 批量隐藏 / 恢复并维护计数', async () => {
    await upsertItems([item('a', 'o/a', ['star']), item('b', 'o/b', ['star'])])
    await applyBatch({ kind: 'setHidden', ids: ['a', 'b'], hidden: true })
    expect((await getAppMeta()).hidden).toBe(2)
    await applyBatch({ kind: 'setHidden', ids: ['a'], hidden: false })
    expect((await getAppMeta()).hidden).toBe(1)
  })

  it('delete 移除本地行（deleteBookmarks=false 时不碰浏览器）', async () => {
    await upsertItems([
      item('a', 'o/a', ['star']),
      item('b', 'o/b', ['bookmark']),
      item('c', 'o/c', ['star', 'bookmark']),
    ])
    const res = await applyBatch({ kind: 'delete', ids: ['a', 'b'] }, { deleteBookmarks: false })
    expect(res.affected).toBe(2)
    expect(res.deletedRows).toBe(2)
    expect(res.removedBookmarks).toBe(0)
    const m = await getAppMeta()
    expect(m.total).toBe(1)
    expect(m.stars).toBe(1) // c 仍在（star+bookmark）
    expect(m.bookmarks).toBe(1)
    expect((await allItems()).length).toBe(1)
  })
})