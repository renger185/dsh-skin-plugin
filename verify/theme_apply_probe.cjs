/* 查静态色板的取值 + ThemePresenter 到底把 token 写在哪。
   用法：node verify/theme_apply_probe.cjs */
const fs = require('fs')
const ASAR = (process.env.LOCALAPPDATA || 'C:/Users/You/AppData/Local') + '/Programs/DeepSeek Harness/resources/app.asar'
const text = fs.readFileSync(ASAR).toString('latin1')

// ── 1. 静态色板取值（取「浅色主题那一块」的原始定义）──
const staticAnchor = text.indexOf('--dsw-static-neutral-50:')
const staticOpen = text.lastIndexOf('{', text.lastIndexOf('--dsw-', staticAnchor - 1))
const staticBlock = text.slice(staticOpen + 1, text.indexOf('}', staticAnchor))
const table = new Map()
for (const m of staticBlock.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;}]+)/g)) table.set(m[1], m[2].trim())
console.log('══ 静态色板（中性那几枚）══')
for (const k of ['--dsw-static-neutral-00', '--dsw-static-neutral-50', '--dsw-static-neutral-75', '--dsw-static-neutral-100', '--dsw-static-neutral-150', '--dsw-static-neutral-200', '--dsw-static-neutral-800', '--dsw-static-neutral-850', '--dsw-static-neutral-900']) {
  console.log('   ' + k.padEnd(32) + (table.get(k) || '(这块里没有)'))
}

// ── 2. 深色主题那一块里的中性值（看静态色板是不是也分主题）──
const darkAnchor = text.indexOf('body[data-ds-dark-theme]', staticAnchor)
const darkOpen = text.indexOf('{', darkAnchor)
const darkBlock = text.slice(darkOpen + 1, text.indexOf('}', darkOpen))
const darkTable = new Map()
for (const m of darkBlock.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;}]+)/g)) darkTable.set(m[1], m[2].trim())
console.log('')
console.log('══ 深色主题块里有没有重定义静态中性色 ══')
for (const k of ['--dsw-static-neutral-50', '--dsw-static-neutral-100', '--dsw-static-neutral-800', '--dsw-static-neutral-850']) {
  console.log('   ' + k.padEnd(32) + (darkTable.get(k) || '(深色块里没定义 → 两套共用同一个值)'))
}

// ── 3. ThemePresenter.apply 怎么写 token ──
const at = text.indexOf('var ThemePresenter = class')
const body = text.slice(at, at + 4200)
console.log('')
console.log('══ ThemePresenter.apply 片段 ══')
console.log(body.replace(/[^\x20-\x7e]/g, '').replace(/\.{2,}/g, ' ').slice(0, 3000))
