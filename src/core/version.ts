import { browser } from 'wxt/browser'

/** 索引失效预案：随 indexVersion 一起落盘，供面板读取并转发给 worker。ids=null 表示全量重建。 */
export interface IndexPatchPlan {
  seq: number
  ids: string[] | null
}

export async function getIndexVersion(): Promise<number> {
  const s = await browser.storage.local.get('indexVersion')
  return (s.indexVersion as number | undefined) ?? 0
}

/**
 * 递增索引版本并记录本次失效预案。
 * @param patches 变更条目的 id 列表；传 `null`（缺省）表示全量重建；传 `[]` 表示仅版本号变化、索引无需改动。
 */
export async function bumpIndexVersion(patches?: string[] | null): Promise<number> {
  const next = (await getIndexVersion()) + 1
  await browser.storage.local.set({
    indexVersion: next,
    idxPatch: patches === undefined ? null : { seq: next, ids: patches ?? null },
  })
  return next
}