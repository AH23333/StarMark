// 临时：对比新旧 worker 的 tags 链路差异，跑完即删
import fs from 'node:fs'

function dump(p, label) {
  console.log(`===== ${label} =====`)
  const s = fs.readFileSync(p, 'utf8').split('\n')
  s.forEach((l, i) => {
    const t = l.trim()
    if ((t.includes('tags') && !t.startsWith('//')) || t.includes("case '") || t.includes('case "'))
      console.log(`${i + 1}: ${t.slice(0, 95)}`)
  })
}

dump('src/entrypoints/sidepanel/search-worker.ts', 'NEW')
dump('../StarMark-0.2.0/src/entrypoints/sidepanel/search-worker.ts', 'OLD 0.2.0')
