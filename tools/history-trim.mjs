/**
 * 一次性回收：把 .history 里超限的历史裁回上限内。
 *
 *   node tools/history-trim.mjs <DSH_HOME>
 *
 * 只动 `.history/` —— 不写、不改、不删任何 `.uiblock`，也不碰 `ui-captures/`。
 * 每个超限块的基线换成磁盘上的现行正文、日志清空；上限内的历史原样不动。
 * 打印清理前后 `.history` 的总字节。
 */
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const home = process.argv[2]
if (home === undefined || home === '') {
  console.error('usage: node tools/history-trim.mjs <DSH_HOME>')
  process.exit(2)
}
process.env.DSH_HOME = home

const here = dirname(fileURLToPath(import.meta.url))
const { timeline } = await import(pathToFileURL(join(here, '..', 'index.js')).href)

const result = await timeline.trimHistory()
const mb = (n) => (n / 1024 / 1024).toFixed(1) + ' MB'
console.log('DSH_HOME: ' + home)
console.log('before: ' + String(result.before) + ' bytes (' + mb(result.before) + ')')
console.log('after:  ' + String(result.after) + ' bytes (' + mb(result.after) + ')')
console.log('blocks touched: ' + String(result.blocks.length))
for (const block of result.blocks) {
  console.log('  - ' + block.name + ': base ' + String(block.baseBytes) + ' B, log ' + String(block.logBytes) + ' B -> ' + block.action)
}
