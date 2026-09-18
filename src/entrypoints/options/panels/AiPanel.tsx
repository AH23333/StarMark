import { useCallback, useEffect, useRef, useState } from 'react'
import { useT } from '~/core/i18n'
import { DEFAULT_AI_SETTINGS, getAiSettings, saveAiSettings, listOllamaModels, type AiSettings, type ProviderKind } from '~/core/ai/provider'
import type { ClassifyResult, ClassifyState } from '~/core/ai/classify'
import type { TagSuggestion } from '~/core/types'
import { sendToBackground } from '~/core/msg'
import { tagColor } from '~/core/tagcolor'
import { allItems } from '~/core/db'

type Notify = (kind: 'ok' | 'err', text: string) => void

/**
 * AI 整理标签面板（自治）：Provider 配置、批量分类运行/暂停/继续、
 * 分组预览与按组应用、结果导入导出、历史待审清理。
 * 长任务交互遵循 §10：ai-classify-run 启动即返回，每 2s 轮询状态直到结束。
 */
export default function AiPanel({ notify, refresh }: { notify: Notify; refresh: () => void }) {
  const t = useT()
  const [ai, setAi] = useState<AiSettings>({ ...DEFAULT_AI_SETTINGS })
  const [aiPending, setAiPending] = useState<TagSuggestion[]>([])
  const [aiBusy, setAiBusy] = useState(false)
  const [classifyState, setClassifyState] = useState<ClassifyState | null>(null)
  const [classifyResult, setClassifyResult] = useState<ClassifyResult | null>(null)
  const [classifyBusy, setClassifyBusy] = useState(false)
  const fileRef2 = useRef<HTMLInputElement | null>(null)
  const [classifyTitles, setClassifyTitles] = useState<Record<string, string>>({})

  const loadAi = useCallback(async () => {
    setAi(await getAiSettings())
    // 仅取历史待审数量（旧版逐条建议的存量，用于清理入口）；流水线状态经 classify-state 获取
    const res = await sendToBackground({ type: 'ai-review' })
    if (res.ok) setAiPending(res.pending ?? [])
    const cs = await sendToBackground({ type: 'ai-classify-state' })
    if (cs.ok) {
      setClassifyState(cs.classifyState ?? null)
      setClassifyResult(cs.classifyResult ?? null)
    }
  }, [])

  const saveAi = async (next: AiSettings) => {
    setAi(next)
    await saveAiSettings(next)
    notify('ok', t('opt.ai.saved'))
  }

  const testOllama = async () => {
    setAiBusy(true)
    try {
      const models = await listOllamaModels(ai)
      notify('ok', t('opt.ai.ollamaOk', { models: models.slice(0, 5).join(', ') || t('opt.ai.ollamaNone') }))
    } catch (e) {
      notify('err', t('opt.ai.ollamaFail', { err: (e as Error).message }))
    } finally {
      setAiBusy(false)
    }
  }

  // 批量分类是后台长任务：ai-classify-run 启动即返回（running=true），每 2s 轮询直到
  // running=false（完成 / 出错 / 用户暂停）。僵尸检测：running 但 lastBeatAt 超过
  // 3 分钟无更新 → SW 已被浏览器回收，提示用户点击继续从断点恢复。
  useEffect(() => {
    if (!classifyBusy) return
    const timer = setInterval(async () => {
      const res = await sendToBackground({ type: 'ai-classify-state' })
      if (!res.ok) return
      setClassifyState(res.classifyState ?? null)
      setClassifyResult(res.classifyResult ?? null)
      if (res.classifyState && !res.classifyState.running) {
        setClassifyBusy(false)
        if (res.classifyState.paused) notify('ok', t('opt.ai.clsPaused'))
        else if (res.classifyState.error) notify('err', t('opt.ai.clsRunFailed', { err: res.classifyState.error }))
        else notify('ok', t('opt.ai.clsDone', { batches: res.classifyState.batch ?? 0 }))
        return
      }
      const beat = res.classifyState?.lastBeatAt ?? 0
      if (Date.now() - beat > 180_000) {
        setClassifyBusy(false)
        // 心跳超时但状态仍是 running → SW 已被回收，落盘暂停态解除僵尸
        await sendToBackground({ type: 'ai-pause' })
        notify('err', t('opt.ai.clsStalled'))
      }
    }, 2000)
    return () => clearInterval(timer)
  }, [classifyBusy, t, notify])

  const runClassifyNow = async () => {
    setClassifyBusy(true)
    const res = await sendToBackground({ type: 'ai-classify-run' })
    if (!res.ok) {
      setClassifyBusy(false)
      notify('err', t('opt.ai.clsRunFailed', { err: res.error ?? '' }))
      return
    }
    setClassifyState(res.classifyState ?? null)
    if (!res.classifyState?.running) {
      setClassifyBusy(false)
      if (res.classifyState?.error) notify('err', t('opt.ai.clsRunFailed', { err: res.classifyState.error }))
      else notify('ok', t('opt.ai.clsDone', { batches: res.classifyState?.batch ?? 0 }))
    } else {
      notify('ok', res.classifyState.paused ? t('opt.ai.clsResuming') : t('opt.ai.clsRunning'))
    }
  }

  // 暂停：后台循环在下一批边界优雅停止并保留断点；循环已死（SW 回收）则直接落盘暂停态
  const pauseClassifyNow = async () => {
    const res = await sendToBackground({ type: 'ai-pause' })
    if (res.ok) {
      setClassifyState(res.classifyState ?? null)
      if (!res.classifyState?.running) {
        setClassifyBusy(false)
        notify('ok', t('opt.ai.clsPaused'))
      } else {
        notify('ok', t('opt.ai.clsPausing'))
      }
    }
  }

  // 清空历史待审核建议（旧版逐条建议功能已并入批量分类，存量数据一次性清理）
  const clearPending = async () => {
    if (aiPending.length === 0) return
    const res = await sendToBackground({ type: 'ai-reject', ids: aiPending.map((p) => p.id) })
    if (res.ok) setAiPending(res.pending ?? [])
  }

  const applyGroups = async (tags: string[] | null) => {
    setClassifyBusy(true)
    const res = await sendToBackground({ type: 'ai-classify-apply', groupTags: tags })
    setClassifyBusy(false)
    if (!res.ok) {
      notify('err', t('opt.ai.clsApplyFailed', { err: res.error ?? '' }))
      return
    }
    notify('ok', t('opt.ai.clsApplied', { items: res.classifyApply?.items ?? 0, tags: res.classifyApply?.tags ?? 0 }))
    refresh()
  }

  const exportClassify = async () => {
    const res = await sendToBackground({ type: 'ai-classify-export' })
    if (!res.ok || !res.classifyExport) {
      notify('err', t('opt.ai.clsExportFailed', { err: res.error ?? '' }))
      return
    }
    const blob = new Blob([res.classifyExport], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'starmark-ai-classification.json'
    a.click()
    setTimeout(() => URL.revokeObjectURL(url), 5000)
    notify('ok', t('opt.ai.clsExportOk'))
  }

  const importClassify = async (file: File) => {
    try {
      const json = await file.text()
      const res = await sendToBackground({ type: 'ai-classify-import', json })
      if (!res.ok) {
        notify('err', t('opt.ai.clsImportFailed', { err: res.error ?? '' }))
        return
      }
      setClassifyResult(res.classifyResult ?? null)
      notify('ok', t('opt.ai.clsImportOk'))
    } catch (e) {
      notify('err', t('opt.ai.clsImportFailed', { err: (e as Error).message }))
    }
  }

  // 分类分组展示用的条目标题（批量补齐一次）
  useEffect(() => {
    const clsIds = classifyResult && classifyResult.assignments ? Object.keys(classifyResult.assignments) : []
    if (clsIds.length === 0) return
    void allItems().then((items) => {
      const map: Record<string, string> = {}
      for (const it of items) map[it.id] = it.title || it.url
      setClassifyTitles(map)
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [classifyResult])

  useEffect(() => {
    void loadAi()
  }, [loadAi])

  return (
    <section className="panel">
      <h2>{t('opt.ai.heading')}</h2>
      <p className="desc">{t('opt.ai.desc')}</p>
      <p className="desc warn-text">{t('opt.ai.privacy')}</p>

      <div className="rule-form">
        <label className="chk">
          <input type="checkbox" checked={ai.enabled} onChange={(e) => void saveAi({ ...ai, enabled: e.target.checked })} />
          {t('opt.ai.enabled')}
        </label>
        <select value={ai.provider} onChange={(e) => void saveAi({ ...ai, provider: e.target.value as ProviderKind })}>
          <option value="openai">OpenAI 兼容</option>
          <option value="anthropic">Anthropic</option>
          <option value="ollama">Ollama（本地模型）</option>
        </select>
        {ai.provider !== 'ollama' && (
          <input
            className="rule-input"
            type="password"
            placeholder={t('opt.ai.keyPh')}
            value={ai.apiKey}
            onChange={(e) => setAi((s) => ({ ...s, apiKey: e.target.value }))}
            onBlur={() => void saveAi(ai)}
          />
        )}
        <input
          className="rule-input"
          placeholder={ai.provider === 'ollama' ? t('opt.ai.modelOllamaPh') : t('opt.ai.modelPh')}
          value={ai.model}
          onChange={(e) => setAi((s) => ({ ...s, model: e.target.value }))}
          onBlur={() => void saveAi(ai)}
        />
        {ai.provider === 'ollama' && (
          <input
            className="rule-input"
            placeholder={t('opt.ai.ollamaUrlPh')}
            value={ai.ollamaBaseUrl ?? ''}
            onChange={(e) => setAi((s) => ({ ...s, ollamaBaseUrl: e.target.value }))}
            onBlur={() => void saveAi(ai)}
          />
        )}
        {ai.provider === 'ollama' && <p className="desc warn-text">{t('opt.ai.ollamaHint')}</p>}
        {ai.provider === 'openai' && (
          <input
            className="rule-input"
            placeholder={t('opt.ai.baseUrlPh')}
            value={ai.baseUrl ?? ''}
            onChange={(e) => setAi((s) => ({ ...s, baseUrl: e.target.value }))}
            onBlur={() => void saveAi(ai)}
          />
        )}
        <div className="row">
          <button
            className="btn primary"
            disabled={!ai.enabled || classifyBusy || (ai.provider !== 'ollama' && !ai.apiKey)}
            onClick={() => void runClassifyNow()}
          >
            {classifyBusy ? t('opt.ai.clsRunning') : classifyState?.paused ? t('opt.ai.clsResume') : t('opt.ai.clsRun')}
          </button>
          {classifyBusy && (
            <button className="btn danger-btn" onClick={() => void pauseClassifyNow()}>
              {t('opt.ai.clsPause')}
            </button>
          )}
          {ai.provider === 'ollama' && (
            <button className="btn" disabled={classifyBusy} onClick={() => void testOllama()}>
              {t('opt.ai.testConn')}
            </button>
          )}
          {classifyState && (
            <span className="ai-state">
              {classifyState.running
                ? t('opt.ai.clsProgress', { batch: classifyState.batch, total: classifyState.totalBatches })
                : t('opt.ai.clsState', { batch: classifyState.batch, total: classifyState.totalBatches })}
              {classifyState.paused ? ` · ${t('opt.ai.clsPausedShort')}` : ''}
              {classifyState.error ? ` · ${classifyState.error}` : ''}
            </span>
          )}
        </div>
      </div>

      {classifyResult && Array.isArray(classifyResult.groups) && classifyResult.groups.length > 0 && (
        <>
          <h3 className="sub-title">{t('opt.ai.clsGroupsHeading', { groups: classifyResult.groups.length, items: classifyResult.totalItems })}</h3>
          <div className="row">
            <button className="btn primary" disabled={classifyBusy} onClick={() => void applyGroups(null)}>
              {t('opt.ai.clsApplyAll')}
            </button>
            <button className="btn" disabled={classifyBusy} onClick={() => void exportClassify()}>
              {t('opt.ai.clsExport')}
            </button>
            <button className="btn" disabled={classifyBusy} onClick={() => fileRef2.current?.click()}>
              {t('opt.ai.clsImport')}
            </button>
            <input
              ref={fileRef2}
              type="file"
              accept=".json,application/json"
              hidden
              onChange={(e) => {
                const file = e.target.files?.[0]
                e.target.value = ''
                if (file) void importClassify(file)
              }}
            />
          </div>
          <ul className="cls-groups">
            {classifyResult.groups.map((g) => (
              <li key={g.tag} className="cls-group">
                <div className="cls-group-head">
                  <span className="cls-tag" style={{ color: tagColor(g.tag) }}>
                    #{g.tag}
                  </span>
                  <span className="cls-count">{t('opt.ai.clsItemCount', { n: g.itemIds.length })}</span>
                  <span className="spacer" />
                  <button className="btn mini" disabled={classifyBusy} onClick={() => void applyGroups([g.tag])}>
                    {t('opt.ai.clsApplyGroup')}
                  </button>
                </div>
                <div className="cls-items">
                  {g.itemIds.slice(0, 12).map((id) => (
                    <span key={id} className="cls-item" title={id}>
                      {classifyTitles[id] ?? id.slice(0, 8)}
                    </span>
                  ))}
                  {g.itemIds.length > 12 && <span className="cls-item more">+{g.itemIds.length - 12}</span>}
                </div>
              </li>
            ))}
          </ul>
        </>
      )}

      {aiPending.length > 0 && (
        <div className="row">
          <span className="ai-state">{t('opt.ai.pendingCleanup', { n: aiPending.length })}</span>
          <button className="btn mini" onClick={() => void clearPending()}>
            {t('opt.ai.pendingClear')}
          </button>
        </div>
      )}
    </section>
  )
}
