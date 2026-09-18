import { useCallback, useEffect, useState } from 'react'
import { useT } from '~/core/i18n'
import { getRules, saveRules, newRuleId, type RuleMatchType, type TagRule } from '~/core/rules'
import { tagColor } from '~/core/tagcolor'
import { sendToBackground } from '~/core/msg'

type Notify = (kind: 'ok' | 'err', text: string) => void

/** 规则自动标签面板（自治）：规则增删/启停/立即应用。 */
export default function RulesPanel({ notify, refresh }: { notify: Notify; refresh: () => void }) {
  const t = useT()
  const [rules, setRules] = useState<TagRule[]>([])
  const [ruleMatch, setRuleMatch] = useState<RuleMatchType>('domain')
  const [ruleValue, setRuleValue] = useState('')
  const [ruleTags, setRuleTags] = useState('')
  const [applyingRules, setApplyingRules] = useState(false)

  const loadRules = useCallback(() => {
    void getRules().then(setRules)
  }, [])

  const persistRules = useCallback(
    async (next: TagRule[]) => {
      setRules(next)
      await saveRules(next)
      notify('ok', t('opt.rules.saved'))
    },
    [notify, t],
  )

  const addRule = async () => {
    const value = ruleValue.trim()
    const tags = ruleTags
      .split(/[,，\s]+/)
      .map((t) => t.trim())
      .filter(Boolean)
    if (!value || tags.length === 0) {
      notify('err', t('opt.rules.invalid'))
      return
    }
    const rule: TagRule = {
      id: newRuleId(),
      enabled: true,
      match: ruleMatch,
      value,
      tags,
      createdAt: Date.now(),
    }
    await persistRules([...rules, rule])
    setRuleValue('')
    setRuleTags('')
  }

  const applyRulesNow = async () => {
    setApplyingRules(true)
    const res = await sendToBackground({ type: 'apply-rules' })
    setApplyingRules(false)
    if (!res.ok) {
      notify('err', t('opt.rules.applyFailed', { err: res.error ?? '' }))
      return
    }
    notify('ok', t('opt.rules.applied', { changed: res.rules?.changed ?? 0, scanned: res.rules?.scanned ?? 0 }))
    refresh()
  }

  useEffect(() => {
    loadRules()
  }, [loadRules])

  return (
    <section className="panel">
      <h2>{t('opt.rules.heading')}</h2>
      <p className="desc">{t('opt.rules.desc')}</p>
      <p className="desc warn-text">{t('opt.rules.autoHint')}</p>

      {rules.length === 0 ? (
        <p className="desc">{t('opt.rules.empty')}</p>
      ) : (
        <ul className="rule-list">
          {rules.map((r) => (
            <li key={r.id} className={r.enabled ? 'rule-row' : 'rule-row off'}>
              <label className="chk">
                <input
                  type="checkbox"
                  checked={r.enabled}
                  onChange={() => void persistRules(rules.map((x) => (x.id === r.id ? { ...x, enabled: !x.enabled } : x)))}
                />
              </label>
              <span className="rule-badge">{t(`opt.rules.match.${r.match}`)}</span>
              <code className="rule-value">{r.value}</code>
              <span className="rule-arrow">→</span>
              <span className="rule-tags">
                {r.tags.map((tg) => (
                  <button
                    key={tg}
                    className="tag"
                    style={{ color: tagColor(tg) }}
                    onClick={() => setRuleTags(tg)}
                    title={t('opt.rules.tagTitle')}
                  >
                    #{tg}
                  </button>
                ))}
              </span>
              <button
                className="btn mini danger-btn"
                title={t('opt.rules.deleteTitle')}
                onClick={() => void persistRules(rules.filter((x) => x.id !== r.id))}
              >
                ✕
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="rule-form">
        <select value={ruleMatch} onChange={(e) => setRuleMatch(e.target.value as RuleMatchType)}>
          <option value="domain">{t('opt.rules.match.domain')}</option>
          <option value="url">{t('opt.rules.match.url')}</option>
          <option value="title">{t('opt.rules.match.title')}</option>
          <option value="language">{t('opt.rules.match.language')}</option>
        </select>
        <input className="rule-input" placeholder={t('opt.rules.valuePh')} value={ruleValue} onChange={(e) => setRuleValue(e.target.value)} />
        <input className="rule-input" placeholder={t('opt.rules.tagsPh')} value={ruleTags} onChange={(e) => setRuleTags(e.target.value)} />
        <div className="row">
          <button className="btn" onClick={() => void addRule()}>
            {t('opt.rules.add')}
          </button>
          <button className="btn primary" disabled={applyingRules} onClick={() => void applyRulesNow()}>
            {applyingRules ? t('opt.rules.applying') : t('opt.rules.applyNow')}
          </button>
        </div>
      </div>
    </section>
  )
}
