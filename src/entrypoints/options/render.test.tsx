// @vitest-environment jsdom
// App 的 refresh effect 会 allItems() 走 Dexie/IndexedDB，jsdom 需要内存实现兜底
import 'fake-indexeddb/auto'
import { describe, expect, it, vi, beforeAll } from 'vitest'
import React from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react'
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

describe('options App effect 阶段冒烟（抓未处理错误）', () => {
  it('挂载后跑完所有异步 effect', async () => {
    if (!window.matchMedia) {
      ;(window as any).matchMedia = (q: string) => ({
        matches: false, media: q, onchange: null,
        addListener: () => {}, removeListener: () => {},
        addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
      })
    }
    const errors: string[] = []
    const orig = window.onerror
    window.addEventListener('error', (e) => {
      errors.push((e.error && (e.error.stack || e.error.message)) || e.message)
    })
    const div = document.createElement('div')
    document.body.appendChild(div)
    await act(async () => {
      createRoot(div).render(React.createElement(App))
    })
    await act(async () => {
      await new Promise((r) => setTimeout(r, 80))
    })
    console.log('CAPTURED_ERRORS:', JSON.stringify(errors, null, 1))
    window.removeEventListener('error', () => {})
    void orig
    expect(errors).toEqual([])
  })
})
