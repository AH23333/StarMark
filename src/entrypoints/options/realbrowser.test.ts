// @vitest-environment node
import { describe, it } from 'vitest'
import puppeteer from 'puppeteer-core'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

describe('真机冒烟', () => {
  it('输出 pageerror 详情', async () => {
    const extPath = 'D:/Visual Studio Code/Something/StarMark/.output/chrome-mv3'
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'starmark-'))
    const browser = await puppeteer.launch({
      executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
      headless: 'new' as never,
      args: [
        `--disable-extensions-except=${extPath}`,
        `--load-extension=${extPath}`,
        `--user-data-dir=${profile}`,
        '--no-first-run',
      ],
    })
    try {
      // 轮询等待扩展 SW target 出现
      let extId = ''
      for (let i = 0; i < 30 && !extId; i++) {
        await new Promise((r) => setTimeout(r, 500))
        for (const t of browser.targets()) {
          const u = t.url()
          if (u.startsWith('chrome-extension://') && u.includes('background.js')) {
            extId = u.split('/')[2]
            break
          }
        }
      }
      console.log('EXT_ID:', extId)
      if (!extId) throw new Error('extension SW target never appeared')
      const page = await browser.newPage()
      const errors: string[] = []
      page.on('pageerror', (e: unknown) => { const err = e as Error; errors.push('[pageerror] ' + err.message + '\n' + (err.stack || '').split('\n').slice(0, 4).join('\n')) })
      page.on('console', (m) => {
        if (m.type() === 'error') errors.push('[console.error] ' + m.text().slice(0, 500))
      })
      await page.goto(`chrome-extension://${extId}/options.html`, { waitUntil: 'domcontentloaded' })
      await new Promise((r) => setTimeout(r, 2500))
      const rootLen = await page.evaluate(() => document.getElementById('root')?.innerHTML.length ?? -1)
      console.log('=== ROOT LEN:', rootLen)
      for (const e of errors) console.log(e)
      if (errors.length === 0) console.log('(no page errors)')
    } finally {
      await browser.close()
      fs.rmSync(profile, { recursive: true, force: true })
    }
  }, 60000)
})
