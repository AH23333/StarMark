import type { ActivityEntry, UIPrefs } from '../types'

/** SearchWorker 与 Side Panel 之间的消息协议 */
export type WorkerRequest =
  | { type: 'init'; version?: number }
  | {
    type: 'invalidate'
    /** null/缺省 = 全量重建；[] = 无索引变更；string[] = 仅这些条目的增量替换 */
    ids?: string[] | null
    /** 触发方已知的新索引版本，用于增量应用后落库快照的版本号（避免 reopen 误判失效） */
    version?: number
  }
  | {
    type: 'search'
    q: string
    max?: number
    source?: 'all' | 'star' | 'bookmark'
    includeHidden?: boolean
    sort?: UIPrefs['sort']
    /** 限定只在这些标签下搜索/浏览（多选 = 同时满足） */
    tags?: string[]
  }
  | { type: 'tree'; tags?: string[] }
  | { type: 'tags' }
  | { type: 'activity' }
  | { type: 'hidden' }

export interface SearchHit {
  id: string
  url: string
  title: string
  sources: string[]
  description?: string
  notes?: string
  tags?: string[]
  language?: string | null
  stars?: number
  starredAt?: number
  bookmarkedAt?: number
  createdAt?: number
  hidden?: boolean
  favicon?: string
}

/** 收藏夹树节点（未搜索时的菜单视图） */
export interface FolderNode {
  id: string
  name: string
  path: string
  count: number
  folders: FolderNode[]
  items: SearchHit[]
  kind?: 'stars'
}

/** 标签统计：名称 + 使用条数 */
export interface TagCount {
  name: string
  count: number
}

export type WorkerResponse =
  | { type: 'ready'; indexVersion: number; docCount: number; rebuilt: boolean }
  | { type: 'results'; q: string; items: SearchHit[]; total?: number }
  | { type: 'tree-result'; root: FolderNode[] }
  | { type: 'tags-result'; tags: TagCount[] }
  | { type: 'activity-result'; items: ActivityEntry[] }
  | { type: 'hidden-result'; items: SearchHit[] }