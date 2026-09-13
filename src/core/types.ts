export type Source = 'star' | 'bookmark'

/** GitHub 仓库的 Star 元信息 */
export interface StarMeta {
  fullName: string
  owner: string
  repo: string
  language: string | null
  stars: number
  topics: string[]
  archived: boolean
  homepage: string | null
  url: string
}

/** 书签来源元信息（保留文件夹路径供展示） */
export interface BookmarkMeta {
  folderPaths: string[]
  folderIds: string[]
}

/** 统一的本地条目。id = hash(normalizeUrl(url))，同 URL 的 Star/书签合并为一行。 */
export interface StarItem {
  id: string
  url: string
  title: string
  description: string
  sources: Source[]
  starredAt?: number
  bookmarkedAt?: number
  starMeta?: StarMeta
  bookmarkMeta?: BookmarkMeta
  faviconUrl?: string
  createdAt: number
  updatedAt: number
  /** AI 扩展预留（Phase 2/3） */
  notes?: string
  summary?: string
  tags?: string[]
  embedded?: Float32Array | null
}

export type GitHubSyncPhase = 'VALIDATE' | 'FETCH_PAGES' | 'RECONCILE' | 'TAG_INDEX' | 'DONE'

export interface GitHubSyncState {
  phase: GitHubSyncPhase
  page: number
  etag?: string
  lastModified?: string
  startedAt?: number
  doneAt?: number
  error?: string
}

export interface BookmarkSyncState {
  lastFullWalkAt?: number
}

/** searchIndex 表：序列化 MiniSearch 索引快照 */
export interface SearchIndexRecord {
  id: string
  version: number
  builtAt: number
  data?: string
  docCount?: number
}

export interface SyncStateRow {
  key: string
  value: GitHubSyncState | BookmarkSyncState | unknown
}

/** 搜索索引文档形态（MiniSearch 需要扁平字段） */
export interface SearchDoc {
  id: string
  title: string
  url: string
  description: string
  owner: string
  topics: string
  sources: string
}

export interface SuggestEntry {
  id: string
  title: string
  url: string
  sources: Source[]
}