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
 * bump 串行化（审查 P1-3）：`getIndexVersion()+1 → set` 是读改写，两个相邻 bump
 * （如 runGitHubSync 结束的 bump 与 finish 里 applyRulesToAll 的 bump）并发时会读到
 * 同一旧版本号、各写各的 idxPatch，后写覆盖前写 → 前一批变更 id 的索引补丁永久丢失。
 * SW 内是单线程事件循环，用模块级 Promise 链把"读-改-写"收敛为串行即可保证原子性。
 *
 * 递增索引版本并记录本次失效预案。
 * @param patches 变更条目的 id 列表；传 `null`（缺省）表示全量重建；传 `[]` 表示仅版本号变化、索引无需改动。
 */
let bumpChain: Promise<unknown> = Promise.resolve()

export function bumpIndexVersion(patches?: string[] | null): Promise<number> {
  const run = async (): Promise<number> => {
    const next = (await getIndexVersion()) + 1
    await browser.storage.local.set({
      indexVersion: next,
      idxPatch: patches === undefined ? null : { seq: next, ids: patches ?? null },
    })
    return next
  }
  const p = bumpChain.then(run, run)
  bumpChain = p.then(
    () => undefined,
    () => undefined,
  )
  return p
}
