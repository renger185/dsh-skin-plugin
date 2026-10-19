/**
 * 「静态色板当底」审计（10-19 13:1x）
 *
 * 为什么查这个：作者红框圈出来的是**交付文件卡片**（消息里那个白底卡片）。
 * 它的底不是 alias token，而是组件自己的一枚局部变量：
 *   .flL80G_root{--deliverable-fill:var(--dsw-static-neutral-50);...}
 *   .flL80G_file{background:var(--deliverable-fill)}
 * 组件只在 `body[data-ds-dark-theme]` 时才把它换成深色 —— 插件既没挂那个属性、
 * 也没洗 `--dsw-static-*`，于是深色壁纸下它一直是白的、字却是白的。
 *
 * 本脚本把「用静态色板当底」的地方全找出来，看还有哪些一样的坑。
 * 用法：node verify/static_surface_audit.cjs
 */
const fs = require('fs')
const ASAR = (process.env.LOCALAPPDATA || 'C:/Users/You/AppData/Local') + '/Programs/DeepSeek Harness/resources/app.asar'
const text = fs.readFileSync(ASAR).toString('latin1')

const staticDefs = new Map()
for (const m of text.matchAll(/(--dsw-static-[a-z0-9-]+)\s*:\s*(#[0-9a-fA-F]{3,8}|rgba?\([^)]{0,40}\))/g)) {
  if (!staticDefs.has(m[1])) staticDefs.set(m[1], new Set())
  staticDefs.get(m[1]).add(m[2])
}
const lum = (hex) => {
  let h = hex.replace('#', '')
  if (h.length === 3) h = h.split('').map((c) => c + c).join('')
  if (h.length < 6) return null
  const rgb = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16))
  const f = (c) => { const v = c / 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4) }
  return 0.2126 * f(rgb[0]) + 0.7152 * f(rgb[1]) + 0.0722 * f(rgb[2])
}

// ① 组件局部变量 = 静态色板
const localVars = new Map()
for (const m of text.matchAll(/(--[a-zA-Z][a-zA-Z0-9-]*)\s*:\s*var\((--dsw-static-[a-z0-9-]+)\)(?=[;}])/g)) {
  if (m[1].startsWith('--dsw-')) continue
  if (!localVars.has(m[1])) localVars.set(m[1], m[2])
}
// ② 直接拿静态色板当 background
const directBg = new Map()
for (const m of text.matchAll(/background(?:-color)?\s*:\s*var\((--dsw-static-[a-z0-9-]+)\)/g)) {
  directBg.set(m[1], (directBg.get(m[1]) || 0) + 1)
}
// ③ color-mix 拿静态色板当半透底
const mixBg = new Map()
for (const m of text.matchAll(/background(?:-color)?\s*:\s*color-mix\(in srgb,\s*var\((--dsw-static-[a-z0-9-]+)\)\s*([\d.]+)%/g)) {
  const key = m[1] + ' ' + m[2] + '%'
  mixBg.set(key, (mixBg.get(key) || 0) + 1)
}

console.log('══ ① 组件自己的局部变量（外面看不到，只有组件在 body[data-ds-dark-theme] 时才换）══')
const byVar = [...localVars.entries()].sort()
for (const [local, st] of byVar) {
  const vals = [...(staticDefs.get(st) || [])].join(' / ')
  const hasDarkRule = new RegExp('body\\[data-ds-dark-theme\\][^{]{0,80}' + local.replace(/-/g, '\\-') + '\\s*:').test(text)
  console.log('   ' + local.padEnd(28) + '← ' + st.padEnd(34) + (vals || '').padEnd(22) + (hasDarkRule ? '（应用自己有深色档）' : ''))
}
console.log('   共 ' + byVar.length + ' 枚')

console.log('')
console.log('══ ② 直接 background: var(--dsw-static-*) 的（这些也不走 alias 洗）══')
for (const [st, n] of [...directBg.entries()].sort((a, b) => b[1] - a[1])) {
  const vals = [...(staticDefs.get(st) || [])]
  const lights = vals.filter((v) => v.startsWith('#') && (lum(v) ?? 0) > 0.5)
  console.log('   ' + st.padEnd(36) + String(n).padStart(4) + ' 处   ' + vals.join(' / ') + (lights.length ? '   ← 浅色实底' : ''))
}

console.log('')
console.log('══ ③ background: color-mix(... var(--dsw-static-*) N% ...) 的半透底 ══')
for (const [k, n] of [...mixBg.entries()].sort((a, b) => b[1] - a[1])) console.log('   ' + k.padEnd(44) + String(n).padStart(4) + ' 处')
