export type Source = 'star' | 'bookmark'

/** 用户可编辑的条目字段（右键菜单/编辑器），贯穿 msg.ts、db、worker、UI 的唯一事实源 */
export type ItemEditPatch = Partial<Pick<StarItem, 'notes' | 'tags' | 'hidden'>>

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
  /** 敏感条目隐藏（默认从搜索/树中排除，可在「隐藏」页恢复） */
  hidden?: boolean
  /** AI 扩展预留（Phase 2/3），同时被基础版标签/笔记/收藏理由使用 */
  notes?: string
  summary?: string
  tags?: string[]
  embedded?: Float32Array | null
}

/** 动态时间线条目：Star/书签的新增与移除 */
export type ActivityKind = 'star_add' | 'star_remove' | 'bookmark_add' | 'bookmark_remove'

export interface ActivityEntry {
  id?: number
  at: number
  kind: ActivityKind
  title: string
  url: string
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

/** searchIndex 表：序列化+压缩的 MiniSearch 索引快照 */
export interface SearchIndexRecord {
  id: string
  version: number
  builtAt: number
  /** 明文 JSON 字符串（旧格式）或 deflate 压缩后的 Blob（新格式） */
  data?: string | Blob
  docCount?: number
}

export interface SyncStateRow {
  key: string
  value: GitHubSyncState | BookmarkSyncState | unknown
}

/** 搜索索引文档形态（MiniSearch 需要扁平字段；store 字段用于结果卡直接展示） */
export interface SearchDoc {
  id: string
  title: string
  url: string
  description: string
  owner: string
  topics: string
  sources: string
  language: string
  tags: string
  stars: number
  starredAt: number
  bookmarkedAt: number
  createdAt: number
  hidden: boolean
  favicon: string
  notes: string
}

export interface SuggestEntry {
  id: string
  title: string
  url: string
  sources: Source[]
}

/** 侧边栏右键菜单：可开启/关闭的条目（默认全部开启） */
export interface CtxMenuConfig {
  open?: boolean
  copyUrl?: boolean
  copyTitle?: boolean
  tags?: boolean
  note?: boolean
  hide?: boolean
}

/** 右键菜单配置项的定义（设置页展示用） */
export const CTX_MENU_ACTIONS: { key: keyof CtxMenuConfig; label: string }[] = [
  { key: 'open', label: '打开链接' },
  { key: 'copyUrl', label: '复制链接' },
  { key: 'copyTitle', label: '复制标题' },
  { key: 'tags', label: '编辑标签' },
  { key: 'note', label: '编辑备注' },
  { key: 'hide', label: '隐藏 / 恢复' },
]

/** 搜索偏好（侧边栏工具栏，持久化到 storage.local） */
export interface UIPrefs {
  sort: 'relevance' | 'recent' | 'starred' | 'bookmarked' | 'stars' | 'name'
  source: 'all' | 'star' | 'bookmark'
  groupByDomain: boolean
  sourceAware: boolean
  showHidden: boolean
  /** 是否显示彩色字母标识（favicon 区域）。关闭后标题前不留任何图标位，列表更干净 */
  letterAvatar?: boolean
  /** 右键菜单开关（缺省项视为开启） */
  ctxMenu?: CtxMenuConfig
}