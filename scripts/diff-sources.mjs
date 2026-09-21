// 临时：0.2.0 与当前 src 的结构化对比（修正 rel 计算），跑完即删
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

const OLD = '../StarMark-0.2.0/src'
const NEW = 'src'

function collect(dir) {
  const map = new Map()
  function walk(d) {
    for (const f of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, f.name)
      if (f.isDirectory()) { walk(p); continue }
      if (!/\.(ts|tsx|css|html)$/.test(f.name)) continue
      const rel = path.relative(dir, p).replace(/\\/g, '/')
      const content = fs.readFileSync(p, 'utf8')
      const hash = crypto.createHash('md5').update(content).digest('hex').slice(0, 8)
      map.set(rel, { hash, lines: content.split('\n').length })
    }
  }
  walk(dir)
  return map
}

const oldMap = collect(OLD)
const newMap = collect(NEW)

const same = []
const changed = []
const onlyOld = []
const onlyNew = []
for (const [rel, info] of newMap) {
  if (!oldMap.has(rel)) { onlyNew.push({ rel, lines: info.lines }); continue }
  if (oldMap.get(rel).hash === info.hash) same.push(rel)
  else changed.push({ rel, oldLines: oldMap.get(rel).lines, newLines: info.lines })
}
for (const rel of oldMap.keys()) if (!newMap.has(rel)) onlyOld.push(rel)

console.log('=== 相同文件:', same.length, '===')
console.log('=== 内容有差异:', changed.length, '===')
for (const c of changed) console.log(`  ${c.rel}  (${c.oldLines} -> ${c.newLines})`)
console.log('=== 仅旧版有:', onlyOld.length, '===')
for (const f of onlyOld) console.log('  ' + f)
console.log('=== 仅新版有:', onlyNew.length, '===')
for (const f of onlyNew) console.log(`  ${f}  (${newMap.get(f).lines} 行)`)
