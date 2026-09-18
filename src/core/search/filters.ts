/**
 * 搜索过滤谓词（代码洞察 D2）：worker 的 doSearch 与 UI 的 BrowseNode 共用，
 * 来源 / 隐藏 / 标签三类过滤判定收敛到这一处。
 */

export type SearchSource = 'all' | 'star' | 'bookmark'

export interface SearchFilterParams {
  source?: SearchSource
  includeHidden?: boolean
  tags?: string[]
}

/** 来源谓词：star 只留含 star 来源；bookmark 只留含 bookmark 来源；all 放行 */
export function makeSourceFilter(source?: SearchSource): (sources: string[]) => boolean {
  if (source === 'star') return (sources) => sources.includes('star')
  if (source === 'bookmark') return (sources) => sources.includes('bookmark')
  return () => true
}

/** 标签谓词：要求指定标签全部命中（AND），未指定则放行 */
export function makeTagFilter(tags?: string[]): (itemTags: string[] | undefined | null) => boolean {
  return (itemTags) => !tags || tags.every((t) => (itemTags ?? []).includes(t))
}

/** 隐藏谓词：includeHidden 放行隐藏条目 */
export function makeHiddenFilter(includeHidden?: boolean): (hidden: boolean) => boolean {
  return (hidden) => !hidden || Boolean(includeHidden)
}
