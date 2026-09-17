import { useState } from 'react'
import { t } from '~/core/i18n'
import { tagColor } from '~/core/tagcolor'
import type { ExportFormat } from '~/core/export'

/** 批量操作条：多选后的统一动作入口（加标签 / 隐藏 / 删除 / 导出所选）。 */
export function BatchBar({
  count,
  onAddTags,
  onHide,
  onUnhide,
  onDelete,
  onExport,
  onExit,
  allTags,
}: {
  count: number
  onAddTags: (tags: string[]) => void
  onHide: () => void
  onUnhide: () => void
  onDelete: () => void
  onExport: (fmt: ExportFormat) => void
  onExit: () => void
  allTags: string[]
}) {
  const [tagDraft, setTagDraft] = useState('')
  const [editingTags, setEditingTags] = useState(false)

  const submitTags = () => {
    const tags = tagDraft
      .split(/[,，\s]+/)
      .map((t) => t.trim())
      .filter(Boolean)
    if (tags.length > 0) onAddTags(tags)
    setTagDraft('')
    setEditingTags(false)
  }

  return (
    <div className="batch-bar">
      <div className="batch-row">
        <span className="batch-count">{t('batch.selected', { n: count })}</span>
        <button className="btn mini" onClick={() => setEditingTags((v) => !v)} title={t('batch.addTagsTitle')}>
          🏷 {t('batch.addTags')}
        </button>
        <button className="btn mini" onClick={onHide} title={t('batch.hideTitle')}>
          👁 {t('batch.hide')}
        </button>
        <button className="btn mini" onClick={onUnhide} title={t('batch.unhideTitle')}>
          🙈 {t('batch.unhide')}
        </button>
        <button className="btn mini danger" onClick={onDelete} title={t('batch.deleteTitle')}>
          🗑 {t('batch.delete')}
        </button>
        <details className="export-dd">
          <summary className="btn mini" title={t('export.selectedTitle')}>
            ⇩ {t('export.selected')}
          </summary>
          <div className="export-menu">
            <button onClick={(e) => { e.currentTarget.closest('details')?.removeAttribute('open'); onExport('markdown') }}>{t('export.markdown')}</button>
            <button onClick={(e) => { e.currentTarget.closest('details')?.removeAttribute('open'); onExport('html') }}>{t('export.html')}</button>
            <button onClick={(e) => { e.currentTarget.closest('details')?.removeAttribute('open'); onExport('csv') }}>{t('export.csv')}</button>
          </div>
        </details>
        <button className="btn mini" onClick={onExit} title={t('batch.exitTitle')}>
          ✕
        </button>
      </div>
      {editingTags && (
        <div className="batch-row">
          <input
            className="batch-input"
            autoFocus
            value={tagDraft}
            placeholder={t('batch.tagsPlaceholder')}
            onChange={(e) => setTagDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') submitTags()
              if (e.key === 'Escape') setEditingTags(false)
            }}
          />
          <button className="btn mini primary" onClick={submitTags}>
            {t('common.save')}
          </button>
          {allTags.length > 0 && (
            <div className="batch-suggest">
              {allTags.slice(0, 16).map((tg) => (
                <button
                  key={tg}
                  className="tag"
                  style={{ color: tagColor(tg) }}
                  onClick={() => setTagDraft(tagDraft.trim() ? `${tagDraft.trim()}, ${tg}` : tg)}
                >
                  +{tg}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
