import { describe, expect, it } from 'vitest'
import { buildClassifyPrompt, groupsFromAssignments, parseClassifyResponse, seedCategories } from './classify'
import type { StarItem } from '../types'

function mk(id: string, tags?: string[]): StarItem {
  return { id, url: 'https://x/' + id, title: id, description: '', sources: ['star'], createdAt: 1, updatedAt: 1, tags }
}

describe('buildClassifyPrompt', () => {
  it('包含编号条目、参考类别与 JSON 格式约束', () => {
    const p = buildClassifyPrompt(
      [ { index: 1, id: 'a', title: 'next.js', desc: 'framework' }, { index: 2, id: 'b', title: 'obsidian', desc: '' } ],
      ['前端', '阅读'],
    )
    expect(p).toContain('1. next.js｜framework')
    expect(p).toContain('2. obsidian')
    expect(p).toContain('【参考类别】前端、阅读')
    expect(p).toContain('"items"')
  })
})

describe('parseClassifyResponse（三种形态兼容）', () => {
  const idByIndex = new Map([[1, 'a'], [2, 'b']])

  it('items 形态', () => {
    const m = parseClassifyResponse('{"items":[{"i":1,"tags":["前端"]},{"i":2,"tags":["阅读","工具"]}]}', idByIndex)
    expect(m.get('a')).toEqual(['前端'])
    expect(m.get('b')).toEqual(['阅读', '工具'])
  })

  it('categories 形态', () => {
    const m = parseClassifyResponse('{"categories":[{"tag":"AI","ids":["a"]},{"tag":"工具","ids":["b","a"]}]}', idByIndex)
    expect(m.get('a')).toEqual(['AI', '工具'])
    expect(m.get('b')).toEqual(['工具'])
  })

  it('裸数组与围栏/前后缀容错', () => {
    const m1 = parseClassifyResponse('[{"i":1,"tags":["x"]}]', idByIndex)
    expect(m1.get('a')).toEqual(['x'])
    const m2 = parseClassifyResponse('好的：{"items":[{"i":2,"tags":["y"]}]} 完毕', idByIndex)
    expect(m2.get('b')).toEqual(['y'])
    expect(parseClassifyResponse('完全不是 JSON', idByIndex).size).toBe(0)
  })
})

describe('seedCategories / groupsFromAssignments', () => {
  it('种子按频次取前 N', () => {
    const items = [mk('a', ['x', 'y']), mk('b', ['x']), mk('c', ['x', 'z'])]
    expect(seedCategories(items, 2)).toEqual(['x', 'y'])
  })

  it('assignments 反推分组并按条目数降序', () => {
    const groups = groupsFromAssignments({ a: ['x'], b: ['x', 'z'], c: ['x'] })
    expect(groups[0]).toEqual({ tag: 'x', itemIds: ['a', 'b', 'c'] })
    expect(groups[1]!.tag).toBe('z')
  })
})
