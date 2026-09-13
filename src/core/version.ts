import { browser } from 'wxt/browser'

export async function getIndexVersion(): Promise<number> {
  const s = await browser.storage.local.get('indexVersion')
  return (s.indexVersion as number | undefined) ?? 0
}

export async function bumpIndexVersion(): Promise<number> {
  const next = (await getIndexVersion()) + 1
  await browser.storage.local.set({ indexVersion: next })
  return next
}