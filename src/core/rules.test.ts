import 'fake-indexeddb/auto'
import { describe, expect, it, beforeEach, vi } from 'vitest'
import { applyRulesForUrls, applyRulesToAll, applyRulesToItem, ruleMatches, saveRules, type TagRule } from './rules'
import { db, getAppMeta, getByUrl, upsertItems } from './db'
import { hashId, normalizeUrl } from './normalize'
import type { StarItem } from './types'

// rules 依赖 chrome.storage.local 存规则与索引版本；测试里用内存 Map 顶替
const { store } = vi.hoisted(() => ({ store: new Map<string, unknown>() }))
vi.mock('wxt/browser', () => ({
  browser: {
    storage: {
      local: {
        get: vi.fn(async (keys?: string | string[] | null) => {
          const out: Record<string, unknown> = {}
          if (keys == null) {
            for (const [k, v] of store) out[k] = v
            return out
          }
          const list = typeof keys === 'string' ? [keys] : keys
          for (const k of list) if (store.has(k)) out[k] = store.get(k)
          return out
        }),
        set: vi.fn(async (objs: Record<string, unknown>) => {
          for (const [k, v] of Object.entries(objs)) store.set(k, v)
        }),
      },
    },
  },
}))

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

function rule(overrides: Partial<TagRule> = {}): TagRule {
  return {
    id: 'r1',
    enabled: true,
    match: 'domain',
    value: 'github.com',
    tags: ['auto'],
    createdAt: 1,
    ...overrides,
  }
}

beforeEach(async () => {
  store.clear()
  await db.delete()
  await db.open()
})

describe('ruleMatches', () => {
  const base = item('a', 'o/a', ['star'], { starMeta: { language: 'TypeScript' } as StarItem['starMeta'] })

  it('domain 精确匹配与子域名匹配，其他 URL 不匹配', () => {
    expect(ruleMatches(rule({ match: 'domain', value: 'github.com' }), base)).toBe(true)
    expect(ruleMatches(rule({ match: 'domain', value: 'github.com' }), item('b', 'o/b', ['star'], {
      url: 'https://gist.github.com/x',
    }))).toBe(true)
    expect(ruleMatches(rule({ match: 'domain', value: 'github.com' }), item('c', 'o/c', ['star'], {
      url: 'https://example.com/a',
    }))).toBe(false)
  })

  it('url/title 子串与 language 精等', () => {
    expect(ruleMatches(rule({ match: 'url', value: 'o/a' }), base)).toBe(true)
    expect(ruleMatches(rule({ match: 'title', value: 'O/A' }), base)).toBe(true)
    expect(ruleMatches(rule({ match: 'language', value: 'typescript' }), base)).toBe(true)
    expect(ruleMatches(rule({ match: 'language', value: 'rust' }), base)).toBe(false)
  })

  it('禁用规则与空匹配值不命中', () => {
    expect(ruleMatches(rule({ enabled: false }), base)).toBe(false)
    expect(ruleMatches(rule({ value: '  ' }), base)).toBe(false)
  })
})

describe('applyRulesToItem', () => {
  it('命中规则追加标签并去重，未命中返回 null', () => {
    const rules = [rule({ tags: ['auto', 'dev'] }), rule({ match: 'title', value: '不存在', tags: ['x'] })]
    const next = applyRulesToItem(item('a', 'o/a', ['star'], { tags: ['dev'] }), rules)
    expect(next?.tags).toEqual(['dev', 'auto'])

    expect(applyRulesToItem(item('a', 'o/a', ['star']), [rule({ match: 'title', value: '不存在' })])).toBeNull()
  })
})

describe('applyRulesToAll', () => {
  it('全量应用：只改命中的行，跳过隐藏，返回计数并维护 meta', async () => {
    await upsertItems([
      item('a', 'o/a', ['star']),
      item('b', 'o/b', ['star'], { hidden: true }),
      item('c', 'o/c', ['bookmark'], { url: normalizeUrl('https://example.com/x'), tags: ['keep'] }),
    ])
    await saveRules([rule({ tags: ['auto'] })])

    const res = await applyRulesToAll()
    expect(res.scanned).toBe(3)
    expect(res.changed).toBe(1) // b 隐藏跳过；c 域名不匹配
    expect((await getByUrl(normalizeUrl('https://github.com/o/a')))?.tags).toEqual(['auto'])
    expect((await getByUrl(normalizeUrl('https://example.com/x')))?.tags).toEqual(['keep'])

    const m = await getAppMeta()
    expect(m.tagged).toBe(2)
    expect(m.tags).toEqual({ auto: 1, keep: 1 })
  })

  it('幂等：重复应用不再产生变更', async () => {
    await upsertItems([item('a', 'o/a', ['star'])])
    await saveRules([rule()])
    await applyRulesToAll()
    const second = await applyRulesToAll()
    expect(second.changed).toBe(0)
  })
})

describe('applyRulesForUrls', () => {
  it('只处理给定 URL 且合并索引版本预案', async () => {
    await upsertItems([item('a', 'o/a', ['star'])])
    await saveRules([rule({ tags: ['news'] })])
    const ids = await applyRulesForUrls([normalizeUrl('https://github.com/o/a'), normalizeUrl('https://github.com/o/none')])
    expect(ids).toEqual(['a'])
    expect((await getByUrl(normalizeUrl('https://github.com/o/a')))?.tags).toEqual(['news'])
  })
})
