/**
 * 实色底检查（10-19 09:5x 新增，专治boss报的「白底 + 看不见」）
 *
 * 干两件事：
 *  ① **漂移检查**：client.js 里 SOLID_FILLS 那 19 枚浅/深两套色，
 *     跟 app.asar 主题表里的值逐枚对 —— 应用升级换了配色，这里会红。
 *  ② **可读性检查**：每一枚底 × 对应档位的字色，算真实对比度；
 *     白字档配深底、黑字档配浅底，主文字要 ≥4.5:1，次要 ≥3.5:1，三级 ≥3:1。
 *
 * 判据不手抄：底色表、字色表全部从 client.js 源码里抠。
 * 用法：node verify/solid_fill_check.cjs   （用包一层的方式跑）
 */
const fs = require('fs')
const path = require('path')
const ASAR = (process.env.LOCALAPPDATA || 'C:/Users/You/AppData/Local') + '/Programs/DeepSeek Harness/resources/app.asar'
const SRC = fs.readFileSync(path.join(__dirname, '..', 'plugin', 'client.js'), 'utf8')

const problems = []

// ── ① 从 client.js 抠出实色底表 ──
const fills = [...SRC.matchAll(/\{ name: '(--dsw-[^']+)', light: '(#[0-9a-fA-F]{6})', dark: '(#[0-9a-fA-F]{6})' \}/g)]
  .map((m) => ({ name: m[1], light: m[2].toLowerCase(), dark: m[3].toLowerCase() }))
if (!fills.length) problems.push('没从 client.js 里抠到 SOLID_FILLS，正则可能过期了')

// ── 从 client.js 抠字色表（黑/白两档）──
function paletteOf(name) {
  const m = SRC.match(new RegExp('const ' + name + ' = \\{([\\s\\S]*?)\\}'))
  if (!m) return null
  const out = {}
  for (const kv of m[1].matchAll(/(\w+):\s*'([^']+)'/g)) out[kv[1]] = kv[2]
  return out
}
const WHITE_INK = paletteOf('LIGHT_INK')
const BLACK_INK = paletteOf('DARK_INK')
if (!WHITE_INK || !BLACK_INK) problems.push('没抠到 LIGHT_INK / DARK_INK 字色表')

// ── 从 app.asar 抠主题表（漂移检查的基准）──
const text = fs.readFileSync(ASAR).toString('latin1')
const tableAround = (i) => text.slice(text.lastIndexOf('{', i) + 1, text.indexOf('}', i))
const staticAnchor = text.indexOf('--dsw-static-neutral-50:')
const staticOpen = text.lastIndexOf('{', text.lastIndexOf('--dsw-', staticAnchor - 1))
const STATIC = parseTable(text.slice(staticOpen + 1, text.indexOf('}', staticAnchor)))
const LIGHT = parseTable(tableAround(text.indexOf('--dsw-alias-markdown-inline-code:')))
const darkAt = text.indexOf('body[data-ds-dark-theme]', text.indexOf('--dsw-alias-markdown-inline-code:'))
const DARK = parseTable(tableAround(text.indexOf('{', darkAt)))
function parseTable(src) {
  const map = new Map()
  for (const m of src.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;}]+)/g)) map.set(m[1], m[2].trim())
  return map
}
function resolveIn(table, name, depth = 0) {
  if (depth > 8) return null
  const raw = table.get(name)
  if (raw === undefined) return null
  const v = raw.match(/^var\((--[a-z0-9-]+)\)$/)
  if (!v) return raw
  if (table.has(v[1])) return resolveIn(table, v[1], depth + 1)
  const s = STATIC.get(v[1])
  return s ? resolveIn(STATIC, v[1], depth + 1) : null
}
function toHex(raw) {
  if (!raw) return null
  let s = String(raw).trim()
  if (s.startsWith('#')) {
    let h = s.slice(1)
    if (h.length === 3 || h.length === 4) h = h.split('').map((c) => c + c).join('')
    if (h.length >= 6) return '#' + h.slice(0, 6).toLowerCase()
    return null
  }
  const m = s.match(/rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/i)
  if (!m) return null
  return '#' + [m[1], m[2], m[3]].map((v) => Number(v).toString(16).padStart(2, '0')).join('')
}
const lumOf = (hex) => {
  const h = toHex(hex)
  if (!h) return null
  const rgb = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16))
  const f = (c) => { const v = c / 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4) }
  return 0.2126 * f(rgb[0]) + 0.7152 * f(rgb[1]) + 0.0722 * f(rgb[2])
}
const contrast = (a, b) => {
  const la = lumOf(a), lb = lumOf(b)
  if (la === null || lb === null) return null
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)
}

const pad = (s, n) => { s = String(s); const w = [...s].reduce((a, c) => a + (c.charCodeAt(0) > 127 ? 2 : 1), 0); return s + ' '.repeat(Math.max(0, n - w)) }
console.log(pad('token', 50) + pad('浅色(黑字档)', 15) + pad('深色(白字档)', 15) + pad('主字对比', 10) + pad('二级', 8) + '三级')
console.log('-'.repeat(112))

let drift = 0
let worstPrimary = 99
let worstName = ''
for (const f of fills) {
  const lip = resolveIn(LIGHT, f.name)
  const dip = resolveIn(DARK, f.name)
  const lh = toHex(lip)
  const dh = toHex(dip)
  if (lh !== f.light) { drift++; console.log('  ⚠ 漂移 ' + f.name + ' 浅色: 表里写 ' + f.light + '，应用里是 ' + lh) }
  if (dh !== f.dark) { drift++; console.log('  ⚠ 漂移 ' + f.name + ' 深色: 表里写 ' + f.dark + '，应用里是 ' + dh) }
  const cp = contrast(BLACK_INK.primary, f.light)
  const cs = contrast(BLACK_INK.secondary, f.light)
  const ct = contrast(BLACK_INK.tertiary, f.light)
  const wp = contrast(WHITE_INK.primary, f.dark)
  const ws = contrast(WHITE_INK.secondary, f.dark)
  const wt = contrast(WHITE_INK.tertiary, f.dark)
  const worstPair = Math.min(cp, wp)
  if (worstPair < worstPrimary) { worstPrimary = worstPair; worstName = f.name }
  console.log(
    pad(f.name, 50) + pad(f.light, 15) + pad(f.dark, 15) +
    pad(cp.toFixed(2) + '/' + wp.toFixed(2), 10) +
    pad(cs.toFixed(2) + '/' + ws.toFixed(2), 8) +
    ct.toFixed(2) + '/' + wt.toFixed(2)
  )
  if (cp < 4.5 || wp < 4.5) problems.push(`${f.name} 主文字对比度不够（黑字 ${cp.toFixed(2)} / 白字 ${wp.toFixed(2)}，门槛 4.5）`)
  if (cs < 3.5 || ws < 3.5) problems.push(`${f.name} 二级文字对比度不够（黑字 ${cs.toFixed(2)} / 白字 ${ws.toFixed(2)}，门槛 3.5）`)
  if (ct < 3 || wt < 3) problems.push(`${f.name} 三级文字对比度不够（黑字 ${ct.toFixed(2)} / 白字 ${wt.toFixed(2)}，门槛 3）`)
}

console.log('')
console.log('实色底 ' + fills.length + ' 枚；两档最差的主文字对比度 ' + worstPrimary.toFixed(2) + ':1（' + worstName + '）')
console.log('与应用主题表的漂移 ' + (drift === 0 ? '0 处 ✓' : drift + ' 处 ✗'))

/**
 * ═══ 【10-19 13:2x 新增】组件局部变量吃的那几枚静态色板 ═══
 * boss红框那张**交付文件卡片**的底 = `--deliverable-fill` = `--dsw-static-neutral-50`。
 * 这里两件事：① 写死的值必须是应用自己的那两枚（浅侧 ↔ 深侧一一对应）；
 * ② 卡片上的字（主/次/三级）在两档下都要够看。
 */
console.log('')
console.log('══ 静态色板（卡片底 / 卡片 hover 底）══')
const flips = [...SRC.matchAll(/\{ name: '(--dsw-static-neutral-(50|100|800|850))', onLight: '(#[0-9a-fA-F]{6})', onDark: '(#[0-9a-fA-F]{6})' \}/g)]
  .map((m) => ({ name: m[1], num: m[2], onLight: m[3].toLowerCase(), onDark: m[4].toLowerCase() }))
const appVal = (name) => toHex(STATIC.get(name))
const surfacePairs = { '50': '--dsw-static-neutral-50', '850': '--dsw-static-neutral-850', '100': '--dsw-static-neutral-100', '800': '--dsw-static-neutral-800' }
const surfaceLike = ['--dsw-static-neutral-50', '--dsw-static-neutral-850']
if (!flips.length) problems.push('没抠到 STATIC_SURFACE_FLIP 表，正则可能过期了')
for (const f of flips) {
  const isSurface = surfaceLike.some((x) => x.endsWith('-' + f.num)) || f.num === '50' || f.num === '850'
  const lightSrc = isSurface ? '--dsw-static-neutral-50' : '--dsw-static-neutral-100'
  const darkSrc = isSurface ? '--dsw-static-neutral-850' : '--dsw-static-neutral-800'
  const wantLight = appVal(lightSrc)
  const wantDark = appVal(darkSrc)
  const cp = contrast(BLACK_INK.primary, f.onLight)
  const wp = contrast(WHITE_INK.primary, f.onDark)
  const okVal = f.onLight === wantLight && f.onDark === wantDark
  if (!okVal) problems.push(`${f.name} 的值跟应用静态色板不一致（应 ${wantLight}/${wantDark}，写的是 ${f.onLight}/${f.onDark}）`)
  if (cp < 4.5 || wp < 4.5) problems.push(`${f.name} 卡片文字对比度不够（黑字 ${cp.toFixed(2)} / 白字 ${wp.toFixed(2)}）`)
  console.log('   ' + pad(f.name, 32) + pad(f.onLight, 11) + pad(f.onDark, 11) + pad((okVal ? '值对 ✓' : '值不对 ✗'), 12) + '主字对比 ' + cp.toFixed(2) + '/' + wp.toFixed(2))
}
console.log('   这四枚治住四张同款卡：card / changes / deliverable / plan-card（含各自 hover）')
void surfacePairs

if (problems.length) {
  console.log('══ 结论:发现异常 ══')
  ;[...new Set(problems)].slice(0, 12).forEach((p) => console.log('   ' + p))
  process.exitCode = 1
} else {
  console.log('══ 结论:' + fills.length + ' 枚实色底 + ' + flips.length + ' 枚静态色板，两档对比度全部达标、与应用自带配色一致 ══')
}
