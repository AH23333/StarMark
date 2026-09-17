import { useMemo, useState } from 'react'
import { t } from '~/core/i18n'
import { sortHitsByPref } from '~/core/search/selectors'
import type { ItemEditPatch, UIPrefs } from '~/core/types'
import type { FolderNode, SearchHit } from '~/core/search/protocol'
import { ResultCard } from './ResultCard'
import type { MouseEvent as ReactMouseEvent } from 'react'

/** 收藏夹树节点：默认折叠，点击展开；条目渲染为全功能结果卡。 */
export function BrowseNode({
  node,
  prefs,
  languageFilter,
  query,
  dupIds,
  onUpdate,
  onTagClick,
  onCtx,
  allTags,
  batchMode,
  selected,
  onSelect,
  onConvert,
}: {
  node: FolderNode
  prefs: UIPrefs
  languageFilter: string
  query: string
  dupIds: Set<string>
  onUpdate: (id: string, patch: ItemEditPatch) => void
  onTagClick: (tag: string) => void
  onCtx: (e: ReactMouseEvent<HTMLDivElement>, hit: SearchHit) => void
  allTags?: string[]
  batchMode?: boolean
  selected?: Set<string>
  onSelect?: (id: string, on: boolean) => void
  onConvert?: (hit: SearchHit, kind: 'toBookmark' | 'toStar') => void
}) {
  const [open, setOpen] = useState(false)
  const [shown, setShown] = useState(100)

  const visible = useMemo(() => {
    let list = node.items.filter((it) => prefs.showHidden || !it.hidden)
    if (languageFilter) list = list.filter((it) => it.language === languageFilter)
    return sortHitsByPref(list, prefs.sort)
  }, [node.items, prefs.showHidden, prefs.sort, languageFilter])

  const total = node.kind === 'stars' ? node.items.length : node.count

  return (
    <div className="t-node">
      <button className="tree-row" onClick={() => setOpen((o) => !o)} title={node.path || node.name}>
        <span className="tree-arrow">{open ? '▾' : '▸'}</span>
        <span className="tree-name">
          {node.kind === 'stars' ? '⭐' : '📁'} {node.kind === 'stars' ? t('tree.allStars') : node.name}
        </span>
        <span className="tree-count">{total}</span>
      </button>
      {open && (
        <div className="tree-children">
          {visible.slice(0, shown).map((h) => (
            <ResultCard
              key={h.id}
              hit={h}
              query={query}
              isDup={dupIds.has(h.id)}
              onUpdate={onUpdate}
              onTagClick={onTagClick}
              onContextMenu={(e) => onCtx(e, h)}
              showAvatar={prefs.letterAvatar !== false}
              allTags={allTags}
              selectable={batchMode}
              selected={selected?.has(h.id)}
              onSelect={(on) => onSelect?.(h.id, on)}
              onConvert={onConvert}
            />
          ))}
          {shown < visible.length && (
            <button className="load-more" onClick={() => setShown((s) => s + 100)}>
              {t('loadMore', { n: visible.length - shown })}
            </button>
          )}
          {node.folders.map((f) => (
            <BrowseNode
              key={`${f.path}|${f.id}`}
              node={f}
              prefs={prefs}
              languageFilter={languageFilter}
              query={query}
              dupIds={dupIds}
              onUpdate={onUpdate}
              onTagClick={onTagClick}
              onCtx={onCtx}
              allTags={allTags}
              batchMode={batchMode}
              selected={selected}
              onSelect={onSelect}
            />
          ))}
        </div>
      )}
    </div>
  )
}
