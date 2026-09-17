import { browser } from 'wxt/browser'
import { relativeTime } from '~/core/ui-utils'
import type { ActivityEntry } from '~/core/types'

const ACT_ICON: Record<string, string> = {
  star_add: '⭐＋',
  star_remove: '⭐－',
  bookmark_add: '🔖＋',
  bookmark_remove: '🔖－',
}

/** 动态时间线单行（Star/书签的新增与移除）。 */
export function ActivityRow({ entry }: { entry: ActivityEntry }) {
  return (
    <li className="act-row" onClick={() => void browser.tabs.create({ url: entry.url, active: false })}>
      <span className="act-icon">{ACT_ICON[entry.kind] ?? entry.kind}</span>
      <div className="act-body">
        <div className="act-title">{entry.title || entry.url}</div>
        <div className="act-meta">{relativeTime(entry.at)}</div>
      </div>
      <span className="act-fav" />
    </li>
  )
}
