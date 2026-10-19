/* 在 app.asar 里找某个 token 名出现的位置，打印前后上下文（latin1 读，避免乱码崩溃）。
   用法：node verify/ctx_tokens.cjs <token名> [前后字符数=260] [最多几处=6] */
const fs = require('fs')
const path = (process.env.LOCALAPPDATA || 'C:/Users/You/AppData/Local') + '/Programs/DeepSeek Harness/resources/app.asar'
const needle = process.argv[2]
const span = Number(process.argv[3] || 260)
const max = Number(process.argv[4] || 6)
if (!needle) {
  console.log('用法: node verify/ctx_tokens.cjs <token名> [跨度] [最多条数]')
  process.exit(1)
}
const text = fs.readFileSync(path).toString('latin1')
let from = 0
let n = 0
while (n < max) {
  const i = text.indexOf(needle, from)
  if (i < 0) break
  n++
  const s = Math.max(0, i - span)
  const e = Math.min(text.length, i + needle.length + span)
  console.log('=== hit#' + n + ' @' + i + ' ===')
  console.log(text.slice(s, e).replace(/[^\x20-\x7e]/g, '.'))
  console.log('')
  from = i + needle.length
}
console.log('总命中(前 ' + max + ' 条):', n)
