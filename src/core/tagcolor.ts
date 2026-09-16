/** 根据标签名生成稳定颜色（侧边栏与设置页共用） */
export function tagColor(tag: string): string {
  let h = 0
  for (let i = 0; i < tag.length; i++) h = (h * 31 + tag.charCodeAt(i)) >>> 0
  const hue = h % 360
  return `hsl(${hue}, 70%, 60%)`
}
