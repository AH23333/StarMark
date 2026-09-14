/**
 * 文本 deflate 压缩/解压（Chrome 80+ 的 CompressionStream，SW/Worker/页面均可用）。
 * 用于压缩 MiniSearch 序列化索引快照，降低 storage 与读取内存。
 */

export const hasDeflate = typeof CompressionStream === 'function' && typeof DecompressionStream === 'function'

export async function compressText(text: string): Promise<Blob> {
  const cs = new CompressionStream('deflate')
  const writer = cs.writable.getWriter()
  void writer.write(new TextEncoder().encode(text))
  void writer.close()
  const ab = await new Response(cs.readable).arrayBuffer()
  return new Blob([ab])
}

export async function decompressToText(blob: Blob): Promise<string> {
  const ds = new DecompressionStream('deflate')
  const stream = blob.stream().pipeThrough(ds)
  const ab = await new Response(stream).arrayBuffer()
  return new TextDecoder().decode(ab)
}