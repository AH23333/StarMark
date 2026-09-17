import { browser } from 'wxt/browser'
import type { BookmarkSyncState, GitHubSyncState, ItemEditPatch, TagSuggestion } from './types'
import type { BatchAction, BatchResult } from './db'
import type { ApplyRulesResult } from './rules'
import type { AiPipelineState } from './ai/pipeline'
import type { ClassifyResult, ClassifyState } from './ai/classify'

/** 前端上下文 ↔ Background SW 消息协议 */
export type BgRequest =
  | { type: 'run-sync'; force?: boolean }
  | { type: 'walk-bookmarks' }
  | { type: 'get-state' }
  | { type: 'rebuild-index' }
  | { type: 'update-item'; id: string; patch: ItemEditPatch }
  | { type: 'batch'; action: BatchAction; deleteBookmarks?: boolean }
  | { type: 'apply-rules' }
  | { type: 'ai-run' }
  | { type: 'ai-review' }
  | { type: 'ai-approve'; ids: string[] }
  | { type: 'ai-reject'; ids: string[] }
  | { type: 'ai-classify-run' }
  | { type: 'ai-pause' }
  | { type: 'ai-classify-state' }
  | { type: 'ai-classify-apply'; groupTags?: string[] | null }
  | { type: 'ai-classify-export' }
  | { type: 'ai-classify-import'; json: string }

export interface BgState {
  ghLogin?: string
  hasToken: boolean
  lastSyncAt?: number
  status: string
  /** GitHub 同步是否正在进行（run-sync 已改为启动即返回，UI 轮询此字段判断结束） */
  syncing?: boolean
  stars: number
  bookmarks: number
  hidden: number
  total: number
  indexVersion: number
  ghSync?: GitHubSyncState
  bmSync?: BookmarkSyncState
}

export interface BgResponse {
  ok: boolean
  error?: string
  state?: BgState
  batch?: BatchResult
  rules?: ApplyRulesResult
  ai?: AiPipelineState
  pending?: TagSuggestion[]
  classifyState?: ClassifyState
  classifyResult?: ClassifyResult
  classifyApply?: { items: number; tags: number }
  classifyExport?: string
}

export async function sendToBackground(req: BgRequest): Promise<BgResponse> {
  try {
    const res = (await browser.runtime.sendMessage(req)) as BgResponse | undefined
    return res ?? { ok: false, error: '无响应' }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
}