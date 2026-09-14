import { browser } from 'wxt/browser'
import type { BookmarkSyncState, GitHubSyncState, ItemEditPatch } from './types'

/** 前端上下文 ↔ Background SW 消息协议 */
export type BgRequest =
  | { type: 'run-sync'; force?: boolean }
  | { type: 'walk-bookmarks' }
  | { type: 'get-state' }
  | { type: 'rebuild-index' }
  | { type: 'update-item'; id: string; patch: ItemEditPatch }

export interface BgState {
  ghLogin?: string
  hasToken: boolean
  lastSyncAt?: number
  status: string
  stars: number
  bookmarks: number
  hidden: number
  total: number
  indexVersion: number
  ghSync?: GitHubSyncState
  bmSync?: BookmarkSyncState
}

export type BgResponse = { ok: boolean; error?: string; state?: BgState }

export async function sendToBackground(req: BgRequest): Promise<BgResponse> {
  try {
    const res = (await browser.runtime.sendMessage(req)) as BgResponse | undefined
    return res ?? { ok: false, error: '无响应' }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
}