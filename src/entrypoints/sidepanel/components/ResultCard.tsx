import { browser } from 'wxt/browser'
import { useState } from 'react'
import { t } from '~/core/i18n'
import { tagColor } from '~/core/tagcolor'
import { hostOnly, highlight } from '~/core/ui-utils'
import { parseRepoFromUrl } from '~/core/convert'
import type { ItemEditPatch } from '~/core/types'
import type { SearchHit } from '~/core/search/protocol'
import type { MouseEvent as ReactMouseEvent } from 'react'

/** favicon 槽位：字母占位常驻，真实图标懒加载叠于上层，失败则隐藏保留字母。 */
export function Favicon({ hit }: { hit: SearchHit }) {
  const host = safeHost(hit.url) || '?'
  const letter = host[0]?.toUpperCase() ?? '?'
  return (
    <span className="favicon fav-slot" style={{ background: tagColor(hit.url) }} title={host}>
      <span className="fav-letter">{letter}</span>
      {hit.favicon && (
        <img
          className="favicon-img"
          src={hit.favicon}
          alt=""
          loading="lazy"
          decoding="async"
          onError={(e) => ((e.target as HTMLImageElement).style.display = 'none')}
        />
      )}
    </span>
  )
}

function safeHost(url: string): string {
  try {
    return new URL(url).hostname
  } catch {
    return ''
  }
}

/** 搜索结果卡：标题高亮、行内编辑备注/标签、隐藏、跨源互转（Star ⇄ 书签）。 */
export function ResultCard({
  hit,
  query,
  isDup,
  onUpdate,
  onTagClick,
  onContextMenu,
  showAvatar,
  allTags,
  selectable,
  selected,
  onSelect,
  onConvert,
}: {
  hit: SearchHit
  query: string
  isDup: boolean
  onUpdate: (id: string, patch: ItemEditPatch) => void
  onTagClick: (tag: string) => void
  onContextMenu?: (e: ReactMouseEvent<HTMLDivElement>) => void
  showAvatar?: boolean
  allTags?: string[]
  selectable?: boolean
  selected?: boolean
  onSelect?: (on: boolean) => void
  onConvert?: (hit: SearchHit, kind: 'toBookmark' | 'toStar') => void
}) {
  const open = () => void browser.tabs.create({ url: hit.url, active: false })
  const [editing, setEditing] = useState<'note' | 'tags' | null>(null)
  const [draft, setDraft] = useState('')
  const canToBookmark = Boolean(onConvert) && !hit.sources.includes('bookmark')
  const canToStar = Boolean(onConvert) && !hit.sources.includes('star') && parseRepoFromUrl(hit.url) != null

  const startEdit = (kind: 'note' | 'tags') => {
    setEditing(kind)
    setDraft(kind === 'note' ? (hit.notes ?? '') : (hit.tags ?? []).join(', '))
  }
  const save = () => {
    if (editing === 'note') {
      void onUpdate(hit.id, { notes: draft.trim() })
    } else if (editing === 'tags') {
      void onUpdate(hit.id, {
        tags: draft
          .split(/[,，\s]+/)
          .map((t) => t.trim())
          .filter(Boolean),
      })
    }
    setEditing(null)
  }

  return (
    <div className={hit.hidden ? 'card dim' : 'card'} onContextMenu={onContextMenu}>
      <div className="card-head" onClick={selectable ? () => onSelect?.(!selected) : open}>
        {selectable && (
          <input
            type="checkbox"
            className="card-check"
            checked={Boolean(selected)}
            onChange={(e) => onSelect?.(e.target.checked)}
            onClick={(e) => e.stopPropagation()}
          />
        )}
        {showAvatar !== false && <Favicon hit={hit} />}
        <span
          className="card-title"
          dangerouslySetInnerHTML={{ __html: highlight(hit.title, query) }}
        />
      </div>
      <div className="card-sub" onClick={open}>
        {hit.language && (
          <span className="card-line">
            {hit.language}
            {typeof hit.stars === 'number' && hit.stars > 0 && ` · ★ ${hit.stars.toLocaleString()}`}
          </span>
        )}
        <span className="card-url">{hostOnly(hit.url)}</span>
      </div>
      <div className="card-sub" onClick={open}>
        {hit.description && hit.description.length > 0 ? (
          <span className="card-line desc-line">{hit.description}</span>
        ) : null}
        {hit.notes ? <span className="card-line note-line">📝 {hit.notes}</span> : null}
      </div>

      {editing === 'note' && (
        <div className="inline-edit">
          <textarea
            rows={2}
            value={draft}
            autoFocus
            placeholder={t('note.placeholder')}
            onChange={(e) => setDraft(e.target.value)}
          />
          <div className="row-btns">
            <button className="btn primary" onClick={save}>
              {t('common.save')}
            </button>
            <button className="btn" onClick={() => setEditing(null)}>
              {t('common.cancel')}
            </button>
          </div>
        </div>
      )}

      {editing === 'tags' && (
        <div className="inline-edit">
          {(() => {
            const draftTags = draft
              .split(/[,，\s]+/)
              .map((t) => t.trim())
              .filter(Boolean)
            return draftTags.length > 0 ? (
              <div className="tag-chip-row">
                {draftTags.map((tg, i) => (
                  <button
                    key={`${tg}-${i}`}
                    className="chip"
                    style={{ color: tagColor(tg) }}
                    onClick={() =>
                      setDraft(
                        draftTags
                          .filter((x) => x !== tg)
                          .join(', '),
                      )
                    }
                    title={t('ctx.deleteTagTitle')}
                  >
                    #{tg} <span className="chip-x">✕</span>
                  </button>
                ))}
              </div>
            ) : null
          })()}
          <input value={draft} autoFocus placeholder={t('ctx.editorTagsPlaceholder')} onChange={(e) => setDraft(e.target.value)} />
          {allTags && allTags.length > 0 && (
            <div className="suggest-row">
              <span className="suggest-label">{t('ctx.suggestLabel')}</span>
              {allTags
                .filter((t) => !(hit.tags ?? []).includes(t) && !draft.split(/[,，\s]+/).map((x) => x.trim()).includes(t))
                .slice(0, 24)
                .map((t) => (
                  <button
                    key={t}
                    className="tag suggest"
                    style={{ color: tagColor(t) }}
                    onClick={() => setDraft(draft.trim() ? `${draft.trim()}, ${t}` : t)}
                  >
                    +{t}
                  </button>
                ))}
            </div>
          )}
          <div className="row-btns">
            <button className="btn primary" onClick={save}>
              {t('common.save')}
            </button>
            <button className="btn" onClick={() => setEditing(null)}>
              {t('common.cancel')}
            </button>
          </div>
        </div>
      )}

      <div className="card-meta">
        {hit.sources.includes('star') && <span className="badge star">{t('badge.star')}</span>}
        {hit.sources.includes('bookmark') && <span className="badge bm">{t('badge.bookmark')}</span>}
        {isDup && <span className="badge dup" title={t('badge.dupTitle')}>{t('badge.dup')}</span>}
        {hit.tags && hit.tags.length > 0 && (
          <div className="tag-row">
            {hit.tags.map((tg) => (
              <button key={tg} className="tag" style={{ color: tagColor(tg) }} onClick={() => onTagClick(tg)} title={t('tag.search', { tag: tg })}>
                #{tg}
              </button>
            ))}
          </div>
        )}
        <div className="spacer" />
        <button className="btn mini" title={t('edit.noteTitle')} onClick={() => (editing === 'note' ? save() : startEdit('note'))}>
          ✏️
        </button>
        <button className="btn mini" title={t('edit.tagsTitle')} onClick={() => (editing === 'tags' ? save() : startEdit('tags'))}>
          🏷
        </button>
        <button
          className="btn mini"
          title={hit.hidden ? t('hidden.restore') : t('hide.hide')}
          onClick={() => void onUpdate(hit.id, { hidden: !hit.hidden })}
        >
          {hit.hidden ? '🙈' : '👁'}
        </button>
        {canToBookmark && (
          <button className="btn mini" title={t('convert.toBookmark.title')} onClick={() => onConvert?.(hit, 'toBookmark')}>
            🔖+
          </button>
        )}
        {canToStar && (
          <button className="btn mini" title={t('convert.toStar.title')} onClick={() => onConvert?.(hit, 'toStar')}>
            ⭐+
          </button>
        )}
      </div>
    </div>
  )
}
