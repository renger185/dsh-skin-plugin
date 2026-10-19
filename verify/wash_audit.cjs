/**
 * 底色审计：从 app.asar 里把浅色/深色两套 token 表抠出来，解析 var() 链，
 * 找出「不透明 + 偏亮」的**实色底** token —— 这些就是插件没洗时、
 * 白字压上去会看不见的元凶。
 *
 * 用法：node verify/wash_audit.cjs [--all]
 *   --all  连 label/border 等前景色一起打（默认只看底色类）
 *
 * 判据不手抄：底色清单从 plugin/client.js 里抠（SURFACE_LAYERS 的 name: 字段）。
 */
const fs = require('fs')
const path = require('path')
const ASAR = (process.env.LOCALAPPDATA || 'C:/Users/You/AppData/Local') + '/Programs/DeepSeek Harness/resources/app.asar'
const CLIENT = path.join(__dirname, '..', 'plugin', 'client.js')

// ── 1. 插件现在洗了哪些 ──
const clientSrc = fs.readFileSync(CLIENT, 'utf8')
const washed = new Set()
{
  const block = clientSrc.slice(clientSrc.indexOf('const SURFACE_LAYERS'), clientSrc.indexOf('const CONTRAST_MIN'))
  const re = /name:\s*'([^']+)'/g
  let m
  while ((m = re.exec(block))) washed.add(m[1])
}
// 动态补洗的名单（如果有）
const extraWashed = new Set()
{
  const m = clientSrc.match(/DYNAMIC_WASH[\s\S]{0,4000}?\n\s*\}\n/)
  if (m) {
    const re = /'(--dsw-[a-z0-9-]+)'/g
    let mm
    while ((mm = re.exec(m[0]))) extraWashed.add(mm[1])
  }
}

// ── 2. 从 app.asar 抠 token 表 ──
const text = fs.readFileSync(ASAR).toString('latin1')
function tableAround(index) {
  const open = text.lastIndexOf('{', index)
  const close = text.indexOf('}', index)
  return text.slice(open + 1, close)
}
function tableAtAnchor(anchor, nth) {
  let from = 0
  for (let i = 0; ; i++) {
    const at = text.indexOf(anchor, from)
    if (at < 0) throw new Error('anchor not found: ' + anchor)
    if (i === nth) return tableAround(at)
    from = at + anchor.length
  }
}
const anchored = '--dsw-alias-bg-base:'
// 静态色板自己那一块（:root{--dsw-static-...}），不能拿它旁边的 alias 块顶替
const staticAnchor = text.indexOf('--dsw-static-neutral-50:')
const staticOpen = text.lastIndexOf('{', text.lastIndexOf('--dsw-', staticAnchor - 1))
const staticTable = text.slice(staticOpen + 1, text.indexOf('}', staticAnchor))
const lightTable = tableAround(text.indexOf('--dsw-alias-markdown-inline-code:'))
const darkAt = text.indexOf('body[data-ds-dark-theme]', lightTable.length + text.indexOf(anchored))
const darkTable = tableAround(darkAt + 40 + 'body[data-ds-dark-theme]'.length ? text.indexOf('{', darkAt) : darkAt)

function parseTable(src) {
  const map = new Map()
  const re = /(--[a-z0-9-]+)\s*:\s*([^;}]+)/g
  let m
  while ((m = re.exec(src))) map.set(m[1], m[2].trim())
  return map
}
const STATIC = parseTable(staticTable)
const LIGHT = parseTable(lightTable)
const DARK = parseTable(darkTable)

function lookup(name, depth = 0) {
  if (depth > 8) return null
  for (const table of [LIGHT, DARK, STATIC]) {
    const v = table.get(name)
    if (v) return { raw: v, table }
  }
  return null
}
function resolve(name, tableName, depth = 0) {
  if (depth > 8) return null
  const table = tableName === 'dark' ? DARK : LIGHT
  const raw = table.get(name)
  if (!raw) return null
  const varMatch = raw.match(/^var\((--[a-z0-9-]+)\)$/)
  if (varMatch) {
    const ref = varMatch[1]
    if (table.has(ref)) return resolve(ref, tableName, depth + 1)
    const sv = STATIC.get(ref)
    if (sv) return resolveRaw(sv, tableName, depth + 1)
    return null
  }
  return resolveRaw(raw, tableName, depth + 1)
}
function resolveRaw(raw, tableName, depth = 0) {
  const varMatch = String(raw).match(/var\((--[a-z0-9-]+)\)/)
  if (varMatch && depth < 8) {
    const sv = STATIC.get(varMatch[1])
    if (sv) return resolveRaw(sv, tableName, depth + 1)
    return null
  }
  return raw
}
function parseColor(raw) {
  if (!raw) return null
  let s = String(raw).trim()
  const mix = s.match(/color-mix\(in srgb,\s*([^,]+?)\s+([\d.]+)%\s*,\s*transparent\)/i)
  if (mix) {
    const inner = parseColor(mix[1])
    if (!inner) return null
    return { rgb: inner.rgb, a: inner.a * (parseFloat(mix[2]) / 100) }
  }
  if (s.startsWith('#')) {
    let hex = s.slice(1)
    if (hex.length === 3 || hex.length === 4) hex = hex.split('').map((c) => c + c).join('')
    if (hex.length !== 6 && hex.length !== 8) return null
    const rgb = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16))
    const a = hex.length === 8 ? parseInt(hex.slice(6, 8), 16) / 255 : 1
    return { rgb, a }
  }
  const m = s.match(/rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.]+%?))?\s*\)/i)
  if (m) {
    let a = 1
    if (m[4]) a = m[4].endsWith('%') ? parseFloat(m[4]) / 100 : parseFloat(m[4])
    return { rgb: [Number(m[1]), Number(m[2]), Number(m[3])], a }
  }
  return null
}
const lum = (rgb) => {
  const f = (c) => { const v = c / 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4) }
  return 0.2126 * f(rgb[0]) + 0.7152 * f(rgb[1]) + 0.0722 * f(rgb[2])
}
// 屏幕上实际看到的色 = 底色 * a + 壁纸 * (1-a)。审计按「最坏情况」:壁纸取纯黑/纯白都算一遍
function shown(color, backdrop) {
  return color.rgb.map((c, i) => c * color.a + backdrop[i] * (1 - color.a))
}

const FOREGROUND = /(label|icon|text|border|stroke|shadow|focus|scrollbar|state-|brand|link|gradient|mask|scrollbar|font|radius|elevation|blur|filter|corner|tint)/
const names = [...new Set([...LIGHT.keys(), ...DARK.keys()])].sort()
const showAll = process.argv.includes('--all')
const rows = []
for (const name of names) {
  if (!showAll && FOREGROUND.test(name)) continue
  const l = parseColor(resolve(name, 'light'))
  if (!l) continue
  const solid = l.a >= 0.95
  const lightSolid = solid && lum(l.rgb) > 0.5
  if (!lightSolid) continue
  const d = parseColor(resolve(name, 'dark'))
  rows.push({
    name,
    插件洗过: washed.has(name) ? '是' : (extraWashed.has(name) ? '补' : '★否'),
    light: resolve(name, 'light'),
    dark: resolve(name, 'dark'),
    白字对比: (() => {
      // 文字是白的(rgba(255,255,255,.92) 压在「白底 + 壁纸」上)
      const bg = shown(l, [0, 0, 0]) // 最有利:壁纸纯黑也压不住白底
      const ink = [255, 255, 255]
      const hi = Math.max(lum(bg), lum(ink))
      const lo = Math.min(lum(bg), lum(ink))
      return ((hi + 0.05) / (lo + 0.05)).toFixed(2)
    })(),
  })
}

const pad = (s, n) => { s = String(s); const w = [...s].reduce((a, c) => a + (c.charCodeAt(0) > 127 ? 2 : 1), 0); return s + ' '.repeat(Math.max(0, n - w)) }
console.log(pad('token', 52) + pad('插件洗过', 10) + pad('浅色值', 44) + pad('深色值', 44) + '白字对比(最坏)')
console.log('-'.repeat(170))
for (const r of rows) console.log(pad(r.name, 52) + pad(r.插件洗过, 10) + pad(r.light, 44) + pad(r.dark, 44) + r.白字对比 + ':1')
console.log('')
console.log('不透明浅底 token 共', rows.length, '枚；其中插件还没洗的', rows.filter((r) => r.插件洗过 === '★否').length, '枚')
console.log('插件 SURFACE_LAYERS 已洗', washed.size, '枚:', [...washed].join(' '))
if (extraWashed.size) console.log('动态补洗', extraWashed.size, '枚:', [...extraWashed].join(' '))
