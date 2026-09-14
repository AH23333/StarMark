import { describe, expect, it } from 'vitest'
import { setLang, t, getLang, LANGS } from './i18n'

describe('i18n', () => {
  it('覆盖三种语言并回退键名', () => {
    expect(LANGS.length).toBeGreaterThanOrEqual(3)
    expect(t('nope.missing')).toBe('nope.missing')
  })

  it('变量插值', () => {
    void setLang('zh-CN')
    expect(t('sync.failed', { err: 'boom' })).toContain('boom')
    void setLang('en')
    expect(t('sync.failed', { err: 'boom' })).toBe('Sync failed: boom')
    void setLang('ja')
    expect(t('results.all', { n: 3 })).toBe('3 件の結果')
  })

  it('语言切换后 getLang 反映当前值', async () => {
    await setLang('en')
    expect(getLang()).toBe('en')
    await setLang('zh-CN')
    expect(getLang()).toBe('zh-CN')
  })

  it('三种语言各自的最近收录标签不同', () => {
    void setLang('zh-CN')
    const zh = t('sort.recent')
    void setLang('ja')
    const ja = t('sort.recent')
    void setLang('en')
    const en = t('sort.recent')
    expect(new Set([zh, ja, en]).size).toBe(3)
  })
})