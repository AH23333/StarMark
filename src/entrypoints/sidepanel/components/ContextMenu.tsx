import { useEffect, useRef, useState } from 'react'
import { browser } from 'wxt/browser'
import { t } from '~/core/i18n'
import { tagColor } from '~/core/tagcolor'
import { CTX_MENU_ACTIONS, type CtxMenuConfig, type ItemEditPatch, type UIPrefs } from '~/core/types'
import type { SearchHit } from '~/core/search/protocol'

/** 侧边栏自有右键菜单：随偏好开关渲染条目，支持内联编辑标签/备注。 */
export function ContextMenu({
  menu,
  prefs,
  onClose,
  onUpdate,
  notify,
  suggestTags,
}: {
  menu: { x: number; y: number; hit: SearchHit }
  prefs: UIPrefs
  onClose: () => void
  onUpdate: (id: string, patch: ItemEditPatch) => void
  notify: (t: string) => void
  suggestTags?: string[]
}) {
  const [editing, setEditing] = useState<'tags' | 'note' | null>(null)
  const [draft, setDraft] = useState('')
  const ref = useRef<HTMLDivElement | null>(null)
  const hit = menu.hit

  useEffect(() => {
    const close = () => onClose()
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close()
    }
    const onPointer = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) close()
    }
    // 面板滚动时收起菜单；但正在编辑（输入框有焦点 / 菜单内部滚动）时绝不因滚动而退出
    const onScroll = (e: Event) => {
      const t = e.target as Node
      if (ref.current?.contains(t)) return
      if (ref.current?.contains(document.activeElement)) return
      if (editing) return
      close()
    }
    document.addEventListener('pointerdown', onPointer, true)
    document.addEventListener('keydown', onKey)
    window.addEventListener('resize', close)
    window.addEventListener('scroll', onScroll, true)
    return () => {
      document.removeEventListener('pointerdown', onPointer, true)
      document.removeEventListener('keydown', onKey)
      window.removeEventListener('resize', close)
      window.removeEventListener('scroll', onScroll, true)
    }
  }, [onClose, editing])

  const cfg = prefs.ctxMenu ?? {}
  const enabled = (k: keyof CtxMenuConfig): boolean => cfg[k] !== false
  const actions = CTX_MENU_ACTIONS.filter((a) => enabled(a.key))

  const startEdit = (kind: 'tags' | 'note') => {
    setEditing(kind)
    setDraft(kind === 'note' ? (hit.notes ?? '') : (hit.tags ?? []).join(', '))
  }
  const save = () => {
    if (editing === 'note') void onUpdate(hit.id, { notes: draft.trim() })
    if (editing === 'tags') {
      void onUpdate(hit.id, {
        tags: draft
          .split(/[,，\s]+/)
          .map((t) => t.trim())
          .filter(Boolean),
      })
    }
    onClose()
  }
  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text)
      notify(t('ctx.copied'))
    } catch {
      notify(t('ctx.copyFailed'))
    }
    onClose()
  }

  const left = Math.min(menu.x, Math.max(0, window.innerWidth - 220))
  const top = Math.min(menu.y, Math.max(0, window.innerHeight - 300))

  const run = (key: string): void => {
    if (key === 'open') {
      void browser.tabs.create({ url: hit.url, active: false })
      onClose()
    } else if (key === 'copyUrl') {
      void copy(hit.url)
    } else if (key === 'copyTitle') {
      void copy(hit.title)
    } else if (key === 'hide') {
      void onUpdate(hit.id, { hidden: !hit.hidden })
      onClose()
    }
  }

  const icon = (key: string): string => {
    if (key === 'open') return '↗ '
    if (key === 'copyUrl') return '⧉ '
    if (key === 'copyTitle') return '✂ '
    if (key === 'tags') return '🏷 '
    if (key === 'note') return '📝 '
    return hit.hidden ? '🙈 ' : '👁 '
  }

  return (
    <div className="ctx-menu" ref={ref} style={{ left, top }}>
      {actions.map((a) => {
        if (a.key !== 'tags' && a.key !== 'note') {
          return (
            <button key={a.key} className="ctx-item" onClick={() => run(a.key)}>
              {icon(a.key)}
              {a.key === 'hide' ? (hit.hidden ? t('hidden.restore') : t(`ctx.${a.key}`)) : t(`ctx.${a.key}`)}
            </button>
          )
        }
        return (
          <button key={a.key} className="ctx-item" onClick={() => startEdit(a.key as 'tags' | 'note')}>
            {icon(a.key)}
            {t(`ctx.${a.key}`)}
          </button>
        )
      })}

      {editing && (
        <div className="ctx-editor">
          {editing === 'note' ? (
            <textarea rows={3} value={draft} autoFocus placeholder={t('ctx.editorNotePlaceholder')} onChange={(e) => setDraft(e.target.value)} />
          ) : (
            <>
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
              {suggestTags && suggestTags.length > 0 && (
                <div className="suggest-row">
                  <span className="suggest-label">{t('ctx.suggestLabel')}</span>
                  {suggestTags
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
            </>
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
    </div>
  )
}
