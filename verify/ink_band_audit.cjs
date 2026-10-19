/**
 * 字色档 + 垫底分布审计（10-19 09:5x 新增，替代旧的 blue_band_audit.py）
 *
 * 【为什么新写一个】旧的 blue_band_audit.py 里写死了一句「wash 锁 0」，
 * 于是它永远算不出蓝字 —— 可实际上 effectiveWash = 自动底线（0~20%），
 * 亮图能垫到 9% 以上，蓝字档的条件就成立了。**判据手抄常量 = 报告骗人**，
 * 这个脚本改成全部从 client.js 里抠常量，一个数都不手抄。
 *
 * 输出：全库 1387 张里 黑字/白字/蓝字各多少、垫底分布、封顶占比。
 * 用法：node verify/ink_band_audit.cjs
 */
const fs = require('fs')
const path = require('path')
const SRC = fs.readFileSync(path.join(__dirname, '..', 'plugin', 'client.js'), 'utf8')
/**
 * 【10-19 21:5x】图库索引不在就当「还没建图库」直接跳过 —— 仓库里没有 library.json
 * （那是私人数据），外面的人跑这个脚本不该看到一个红色报错。
 */
const LIB_FILE = path.join(__dirname, '..', 'library.json')
if (!fs.existsSync(LIB_FILE)) {
  console.log('没有 library.json（图库还没建）—— 这个脚本是拿你本机图库做字色档审计的，先导入几张图再跑。')
  process.exit(0)
}
const LIB = JSON.parse(fs.readFileSync(LIB_FILE, 'utf8'))

function num(name) {
  const m = SRC.match(new RegExp('const ' + name + ' = (-?[\\d.]+)'))
  if (!m) throw new Error('抠不到常量 ' + name)
  return Number(m[1])
}
const INK_WHITE_MAX = num('INK_WHITE_MAX')
const INK_BLACK_MIN = num('INK_BLACK_MIN')
const CELL_DARK_MAX = num('CELL_DARK_MAX')
const CELL_LIGHT_MIN = num('CELL_LIGHT_MIN')
const CELL_SHARE_EDGE = num('CELL_SHARE_EDGE')
const AUTO_FLOOR_TARGET = num('AUTO_FLOOR_TARGET')
const AUTO_FLOOR_CAP = num('AUTO_FLOOR_CAP')
const MAX_WASH = num('MAX_WASH')

const clamp01 = (v) => Math.max(0, Math.min(1, v))
const wcagOfSrgb = (v) => { const x = Math.max(0, Math.min(255, v)) / 255; return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4) }

// 与 client.js 的 inkToneFor 同口径
function inkToneFor(entry) {
  const darkShare = Number(entry?.darkShare)
  const lightShare = Number(entry?.lightShare)
  if (Number.isFinite(darkShare) && Number.isFinite(lightShare)) {
    const diff = darkShare - lightShare
    if (diff > CELL_SHARE_EDGE) return 'white'
    if (diff < -CELL_SHARE_EDGE) return 'black'
    const midLum = Number(entry.midLum)
    if (!Number.isFinite(midLum)) return 'black'
    return midLum > (CELL_DARK_MAX + CELL_LIGHT_MIN) / 2 ? 'black' : 'white'
  }
  const tone = wcagOfSrgb(Number(entry?.avgLum) || 0)
  if (tone < INK_WHITE_MAX) return 'white'
  if (tone > INK_BLACK_MIN) return 'black'
  return 'black'
}
// 与 client.js 的 autoFloorPct 同口径
function autoFloorPct(entry) {
  const p5 = Number(entry.chatP5)
  const p95 = Number(entry.chatP95)
  if (!Number.isFinite(p5) || !Number.isFinite(p95)) return 0
  const ink = inkToneFor(entry)
  const inkLum = ink === 'white' ? wcagOfSrgb(244) : wcagOfSrgb(11)
  const up = ink !== 'white'
  const worst = up ? p5 : p95
  const target = up ? (inkLum + 0.05) * AUTO_FLOOR_TARGET - 0.05 : (inkLum + 0.05) / AUTO_FLOOR_TARGET - 0.05
  if (up) {
    if (worst >= target) return 0
    if (target >= 1) return AUTO_FLOOR_CAP
    return Math.max(0, Math.min(AUTO_FLOOR_CAP, Math.ceil(((target - worst) / (1 - worst)) * 100)))
  }
  if (worst <= target) return 0
  if (target <= 0) return AUTO_FLOOR_CAP
  return Math.max(0, Math.min(AUTO_FLOOR_CAP, Math.ceil(((worst - target) / (worst || 1)) * 100)))
}
const effectiveWash = (entry) => Math.max(0, Math.min(MAX_WASH, autoFloorPct(entry)))

const blue = 0 // 10-19 16:2x 起蓝字档撤掉，恒为 0（留着是为了让报告明确写出来）
let black = 0, white = 0
let cap = 0, zero = 0
const washHist = new Map()
const blueExamples = []
for (const e of LIB) {
  const ink = inkToneFor(e)
  const wash = effectiveWash(e)
  washHist.set(wash, (washHist.get(wash) || 0) + 1)
  if (wash === 0) zero++
  if (wash >= AUTO_FLOOR_CAP) cap++
  /**
   * 【10-19 16:2x 口径改了】蓝字档整个撤掉（作者报「文字通篇蓝色」）。
   * 以前这里还替蓝字判一遍（壁纸亮 + wash>8%），现在字色只有 inkToneFor 一条路：
   * 黑块多 → 白字；亮块多 → 黑字。所以 blue 永远是 0 —— 留着这个计数是为了
   * 让报告明确写出「蓝字 0 张」，而不是让人再去猜。
   */
  if (ink === 'white') white++
  else black++
}
const n = LIB.length
const pct = (v) => ((v / n) * 100).toFixed(1) + '%'
console.log('全库 ' + n + ' 张（口径：effectiveWash = 自动底线 0~' + AUTO_FLOOR_CAP + '%）')
console.log('  白字 ' + String(white).padStart(5) + '  ' + pct(white) + '   ← 壁纸偏暗那批（作者报的「白底白字」就发生在这一档）')
console.log('  黑字 ' + String(black).padStart(5) + '  ' + pct(black))
console.log('  蓝字 ' + String(blue).padStart(5) + '  ' + pct(blue) + '   ← 10-19 16:2x 起这一档撤掉，永远是 0（作者：「文字通篇蓝色」是 bug）')
console.log('')
console.log('垫底（wash）分布：0% 的 ' + zero + ' 张（' + pct(zero) + '），垫到封顶 ' + AUTO_FLOOR_CAP + '% 的 ' + cap + ' 张（' + pct(cap) + '）')
const top = [...washHist.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8)
console.log('  最常见的几档：' + top.map(([w, c]) => w + '%×' + c).join('  '))
void blueExamples
