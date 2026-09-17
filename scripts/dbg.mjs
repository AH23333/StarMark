// 临时调试补丁 v2：轮询过程打印 + 记录 put 快照，跑完即还原
import fs from 'node:fs'

let s = fs.readFileSync('src/core/ai/classify.ts', 'utf8')
if (!s.includes('[dbg-put]')) {
  s = s.replace(
    'async function setClassifyState(st: ClassifyState): Promise<void> {\n  await setSyncState(STATE_KEY, st)\n}',
    'async function setClassifyState(st: ClassifyState): Promise<void> {\n  console.log(\'[dbg-put]\', JSON.stringify({ running: st.running, paused: st.paused, batch: st.batch, cancel: st.cancelRequested, err: st.error }))\n  await setSyncState(STATE_KEY, st)\n}',
  )
  fs.writeFileSync('src/core/ai/classify.ts', s, 'utf8')
  console.log('patched classify.ts')
}

let t = fs.readFileSync('src/core/ai/classify.test.ts', 'utf8')
if (!t.includes('[dbg-poll]')) {
  t = t.replace(
    '      final = await getClassifyState()\n    }\n    console.log(',
    '      final = await getClassifyState()\n      if (i < 5 || !final.running) console.log(\'[dbg-poll]\', i, JSON.stringify({ running: final.running, paused: final.paused, batch: final.batch }))\n    }\n    console.log(',
  )
  fs.writeFileSync('src/core/ai/classify.test.ts', t, 'utf8')
  console.log('patched test')
}
