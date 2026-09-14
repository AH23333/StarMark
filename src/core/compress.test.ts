import { describe, expect, it } from 'vitest'
import { compressText, decompressToText, hasDeflate } from './compress'

describe('deflate 压缩/解压', () => {
  it.skipIf(!hasDeflate)('压解往返一致', async () => {
    const text = 'hello world 测试索引压缩 ' + 'x'.repeat(1000)
    const blob = await compressText(text)
    expect(await decompressToText(blob)).toBe(text)
  })
})