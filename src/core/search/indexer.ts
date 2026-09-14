import MiniSearch, { type Options as MiniSearchOptions } from 'minisearch'
import type { SearchDoc, StarItem } from '../types'

// 索引字段含 notes：用户写的备注/收藏理由也可被搜索。
// storeFields 不含 description/notes：由 worker 按 id 从 DB 补取，避免索引里双份大文本。
const FIELDS = ['title', 'url', 'description', 'owner', 'topics', 'tags', 'notes'] as const
const STORE_FIELDS = ['id', 'url', 'title', 'sources', 'tags', 'language', 'stars', 'starredAt', 'bookmarkedAt', 'createdAt', 'hidden', 'favicon'] as const

/** 构造与重建/反序列化共用的同一组索引选项 */
export function searchOptions(): MiniSearchOptions<SearchDoc> {
  return {
    fields: [...FIELDS],
    storeFields: [...STORE_FIELDS],
    tokenize: cjkAwareTokenize,
    searchOptions: {
      boost: { title: 2, owner: 1.5, url: 1.2, topics: 1, tags: 1.2, notes: 1.1 },
    },
  }
}

const CJK_PUNCT_RE = /[\s\-–—_—、。《》〈〉「」『』【】（）()！？!?：:；;，,．.·・"'"‘’`@#$%^&*+=|/\\<>~{}\[\]]+/u
const CJK_RE = /[\u3400-\u9fff\uF900-\uFAFF]/u

/**
 * 分词器：拉丁/数字保持整词（兼容 MiniSearch v7 默认的拆词规则），
 * 连续 CJK 文本额外输出整串 + 相邻二元组，使前缀/包含检索都能命中中文标题。
 */
export function cjkAwareTokenize(text: string): string[] {
  const tokens: string[] = []
  for (const segment of text.split(CJK_PUNCT_RE)) {
    if (!segment) continue
    if (CJK_RE.test(segment)) {
      if (segment.length > 1) tokens.push(segment)
      const chars = Array.from(segment)
      for (let i = 0; i < chars.length; i++) {
        tokens.push(chars[i] ?? '')
        if (i + 1 < chars.length) tokens.push(chars[i]! + chars[i + 1]!)
      }
    } else {
      tokens.push(segment)
    }
  }
  return tokens
}

export function createMiniSearch(): MiniSearch<SearchDoc> {
  return new MiniSearch<SearchDoc>(searchOptions())
}

export function docFromItem(item: StarItem): SearchDoc {
  return {
    id: item.id,
    title: item.title,
    url: item.url,
    description: item.description,
    owner: item.starMeta?.owner ?? '',
    topics: (item.starMeta?.topics ?? []).join(' '),
    sources: item.sources.join(','),
    language: item.starMeta?.language ?? '',
    tags: (item.tags ?? []).join(' '),
    stars: item.starMeta?.stars ?? 0,
    starredAt: item.starredAt ?? 0,
    bookmarkedAt: item.bookmarkedAt ?? 0,
    createdAt: item.createdAt ?? 0,
    hidden: Boolean(item.hidden),
    favicon: item.faviconUrl ?? '',
    notes: item.notes ?? '',
  }
}