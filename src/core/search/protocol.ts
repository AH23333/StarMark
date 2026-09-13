/** SearchWorker 与 Side Panel 之间的消息协议 */
export type WorkerRequest =
  | { type: 'init' }
  | { type: 'search'; q: string; max?: number }
  | { type: 'rebuild' }
  | { type: 'tree' }

export interface SearchHit {
  id: string
  url: string
  title: string
  sources: string[]
}

/** 书签收藏夹树节点（未搜索时的默认视图） */
export interface FolderNode {
  id: string
  name: string
  path: string
  count: number
  folders: FolderNode[]
  items: { id: string; title: string; url: string }[]
  kind?: 'stars'
}

export type WorkerResponse =
  | { type: 'ready'; indexVersion: number; docCount: number; rebuilt: boolean }
  | { type: 'results'; q: string; items: SearchHit[] }
  | { type: 'tree-result'; root: FolderNode[] }