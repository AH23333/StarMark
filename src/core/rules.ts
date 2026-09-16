import { browser } from 'wxt/browser'
import { allItems, dedupeTags, getByUrl, transformItems, updateItem } from './db'
import { bumpIndexVersion } from './version'
import type { StarItem } from './types'

/**
 * 规则自动标签（阶段 B）：按 域名 / URL / 标题 / 语言 规则给条目追加标签。
 * 规则是用户配置（chrome.storage.local），不是条目数据；命中即"追加式"合并，
 * 不移除已有标签。同步成功与新增书签时自动应用，设置页可手动增删与全量应用。
 */

export type RuleMatchType = 'domain' | 'url' | 'title' | 'language'

export interface TagRule {
  id: string
  enabled: boolean
  match: RuleMatchType
  value: string
  tags: string[]
  createdAt: number
}

const RULES_KEY = 'tagRules'

export async function getRules(): Promise<TagRule[]> {
  const s = await browser.storage.local.get(RULES_KEY)
  const rules = s[RULES_KEY]
  return Array.isArray(rules) ? (rules as TagRule[]) : []
}

export async function saveRules(rules: TagRule[]): Promise<void> {
  await browser.storage.local.set({ [RULES_KEY]: rules })
}

export function newRuleId(): string {
  return `r_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase()
  } catch {
    return ''
  }
}

/** 单条规则匹配判断；空值/禁用一律不命中 */
export function ruleMatches(rule: TagRule, item: StarItem): boolean {
  if (!rule.enabled) return false
  const value = (rule.value ?? '').trim().toLowerCase()
  if (!value) return false
  switch (rule.match) {
    case 'domain': {
      const host = hostOf(item.url)
      return host === value || host.endsWith(`.${value}`)
    }
    case 'url':
      return item.url.toLowerCase().includes(value)
    case 'title':
      return item.title.toLowerCase().includes(value)
    case 'language':
      return (item.starMeta?.language ?? '').toLowerCase() === value
    default:
      return false
  }
}

/** 对单条应用全部启用的规则；无变化返回 null */
export function applyRulesToItem(item: StarItem, rules: TagRule[]): StarItem | null {
  const add = new Set<string>()
  for (const rule of rules) {
    if (!ruleMatches(rule, item)) continue
    for (const t of rule.tags ?? []) {
      const v = t.trim()
      if (v) add.add(v)
    }
  }
  if (add.size === 0) return null
  const merged = dedupeTags([...(item.tags ?? []), ...add])
  if (merged.length === (item.tags?.length ?? 0)) return null
  return { ...item, tags: merged, updatedAt: Date.now() }
}

export interface ApplyRulesResult {
  changed: number
  scanned: number
}

/** 对全部本地条目应用规则（跳过已隐藏），并触发索引增量刷新。 */
export async function applyRulesToAll(): Promise<ApplyRulesResult> {
  const rules = (await getRules()).filter((r) => r.enabled && (r.tags ?? []).length > 0)
  if (rules.length === 0) return { changed: 0, scanned: 0 }
  const scanned = (await allItems()).length
  const changedIds = await transformItems((item) => applyRulesToItem(item, rules), { skipHidden: true })
  if (changedIds.length > 0) await bumpIndexVersion(changedIds)
  return { changed: changedIds.length, scanned }
}

/**
 * 对指定 URL 的条目应用规则（书签新增事件用）；返回变更的条目 id。
 * 默认自行 bumpIndexVersion；传入 bump:false 由调用方合并到自己的失效批次里。
 */
export async function applyRulesForUrls(urls: string[], opts?: { bump?: boolean }): Promise<string[]> {
  const rules = (await getRules()).filter((r) => r.enabled && (r.tags ?? []).length > 0)
  if (rules.length === 0) return []
  const changedIds: string[] = []
  for (const url of urls) {
    const item = await getByUrl(url)
    if (!item) continue
    const next = applyRulesToItem(item, rules)
    if (!next) continue
    // 单条更新走 updateItem 复用计数维护；规则追加只影响 tags
    await updateItem(next.id, { tags: next.tags })
    changedIds.push(next.id)
  }
  if (changedIds.length > 0 && opts?.bump !== false) await bumpIndexVersion(changedIds)
  return changedIds
}
