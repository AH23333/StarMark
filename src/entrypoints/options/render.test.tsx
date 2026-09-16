import { describe, expect, it, vi } from 'vitest'
import { renderToString } from 'react-dom/server'
import React from 'react'
import App from './App'

const { store } = vi.hoisted(() => ({ store: new Map<string, unknown>() }))
vi.mock('wxt/browser', () => ({
  browser: {
    storage: {
      local: {
        get: vi.fn(async () => ({})),
        set: vi.fn(async () => {}),
      },
      onChanged: { addListener: vi.fn(), removeListener: vi.fn() },
    },
    runtime: { sendMessage: vi.fn(async () => ({ ok: true })), openOptionsPage: vi.fn() },
    bookmarks: {},
    i18n: { getUILanguage: () => 'zh-CN' },
    commands: { getAll: vi.fn(async () => []) },
    tabs: { create: vi.fn() },
  },
}))

describe('options App 渲染冒烟', () => {
  it('renderToString 不抛错', async () => {
    const html = renderToString(React.createElement(App))
    expect(html.length).toBeGreaterThan(100)
  })
})
