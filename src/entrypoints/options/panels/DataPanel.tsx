import { useRef } from 'react'
import { useT } from '~/core/i18n'
import { clearAll, allItems } from '~/core/db'
import { buildBackup, parseBackup, restoreBackup } from '~/core/backup'
import { buildExport, exportFilename, type ExportFormat } from '~/core/export'

type Notify = (kind: 'ok' | 'err', text: string) => void

function download(content: string, filename: string, mime = 'application/json'): void {
  const blob = new Blob([content], { type: mime })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 5000)
}

/** 数据面板（自治）：加密备份导出导入 / 通用格式导出 / 清除全部。 */
export default function DataPanel({ notify, refresh }: { notify: Notify; refresh: () => void }) {
  const t = useT()
  const fileRef = useRef<HTMLInputElement | null>(null)

  const doExport = async () => {
    const pass = window.prompt(t('msg.export.prompt'))
    if (pass === null) return
    try {
      const { content, encrypted } = await buildBackup(pass || undefined)
      download(content, `starmark-backup-${Date.now()}.json`)
      notify('ok', encrypted ? t('msg.export.okEncrypted') : t('msg.export.okPlain'))
    } catch (e) {
      notify('err', t('msg.export.failed', { err: (e as Error).message }))
    }
  }

  const doExportFormat = async (format: ExportFormat) => {
    try {
      const items = await allItems()
      if (items.length === 0) {
        notify('err', t('opt.export.failed', { err: t('opt.never') }))
        return
      }
      const { content, mime } = buildExport(format, items)
      download(content, exportFilename(format), mime)
      notify('ok', t('opt.export.ok', { n: items.length, format }))
    } catch (e) {
      notify('err', t('opt.export.failed', { err: (e as Error).message }))
    }
  }

  const onImportFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    const pass = window.prompt(t('msg.import.promptPass'))
    if (pass === null) return
    try {
      const text = await file.text()
      const payload = await parseBackup(text, pass || undefined)
      if (!window.confirm(t('msg.import.confirm', { n: payload.items.length }))) return
      await restoreBackup(payload.items)
      notify('ok', t('msg.import.ok', { n: payload.items.length }))
      refresh()
    } catch (err) {
      notify('err', t('msg.import.failed', { err: (err as Error).message }))
    }
  }

  const doClear = async () => {
    if (!confirm(t('msg.clear.confirm'))) return
    await clearAll()
    notify('ok', t('msg.clear.ok'))
    refresh()
  }

  return (
    <>
      <section className="panel">
        <h2>{t('opt.backup.heading')}</h2>
        <p className="desc">{t('opt.backup.desc')}</p>
        <div className="row">
          <button className="btn" onClick={doExport}>
            {t('opt.backup.export')}
          </button>
          <button className="btn" onClick={() => fileRef.current?.click()}>
            {t('opt.backup.import')}
          </button>
          <input ref={fileRef} type="file" accept=".json,application/json" hidden onChange={(e) => void onImportFile(e)} />
        </div>
      </section>

      <section className="panel">
        <h2>{t('opt.export.heading')}</h2>
        <p className="desc">{t('opt.export.desc')}</p>
        <div className="row">
          <button className="btn" onClick={() => void doExportFormat('markdown')}>
            {t('opt.export.markdown')}
          </button>
          <button className="btn" onClick={() => void doExportFormat('html')}>
            {t('opt.export.html')}
          </button>
          <button className="btn" onClick={() => void doExportFormat('csv')}>
            {t('opt.export.csv')}
          </button>
        </div>
      </section>

      <section className="panel danger">
        <h2>{t('opt.data.heading')}</h2>
        <button className="btn danger-btn" onClick={doClear}>
          {t('opt.data.clearAll')}
        </button>
      </section>
    </>
  )
}
