/**
 * 三个模式的「遮罩档」到底还生不生效？（10-19 18:5x boss打回后补的）
 *
 * boss原话:「你把图片背景的明度、透明度给删掉了…要不然我们『休闲』『专注』
 * 和『正常』这三个模式都用不了了。」
 *
 * 这个脚本把 client.js 里的 effectiveWash **原样抠出来真跑**（不是查关键字），
 * 喂不同的模式/手调值/底线，看三个档是不是真的不一样、底线是不是真的托得住。
 *
 * 判据的数一律从 client.js 读，不手抄。
 * 用法：node verify/mode_wash_check.cjs
 */
const fs = require('fs')
const path = require('path')

const SRC = fs.readFileSync(path.join(__dirname, '..', 'plugin', 'client.js'), 'utf8')
const num = (name) => Number((SRC.match(new RegExp('const ' + name + ' = (\\d+)')) || [])[1])
const MAX_WASH = num('MAX_WASH')
const FOCUS_MASK = num('FOCUS_MASK')
const LEISURE_MASK = num('LEISURE_MASK')

const problems = []
const ok = (label, cond, detail) => {
  if (!cond) problems.push(label)
  console.log(`${cond ? 'OK  ' : 'FAIL'} ${label}${detail ? '  ' + detail : ''}`)
}

const src = SRC.match(/function effectiveWash\(entry\) \{[\s\S]*?\n    \}/)
if (!src) {
  console.log('FAIL 抠不出 effectiveWash')
  process.exit(1)
}
// 把外面那几个依赖补上（都照 client.js 里的定义）
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n))
const activeScheme = () => 'light'
// 桩里的 state 就用 client.js 里那个名字（effectiveWash 读的是闭包外的 state）
const state = { mode: 'normal', wash: null }
let FLOOR = 0
const autoFloorPct = () => FLOOR
const effectiveWash = eval('(' + src[0] + ')')
const run = (mode, wash, floor, autoMask) => {
  state.mode = mode
  state.wash = wash
  FLOOR = floor
  return effectiveWash({ autoMask })
}

const withFloor0 = {
  focus: run('focus', null, 0, 12),
  leisure: run('leisure', null, 0, 12),
  normal: run('normal', null, 0, 12),
}
console.log('底线 0 时，同一张暗图(autoMask=12)三个档：')
console.log(`  专注 ${withFloor0.focus}%   休闲 ${withFloor0.leisure}%   正常 ${withFloor0.normal}%`)
ok('三个档真的不一样（不再是一潭死水）', withFloor0.focus !== withFloor0.normal && withFloor0.leisure !== withFloor0.normal)
ok('专注最实', withFloor0.focus > withFloor0.normal && withFloor0.normal > withFloor0.leisure, `${withFloor0.focus} > ${withFloor0.normal} > ${withFloor0.leisure}`)
ok('专注用的是 FOCUS_MASK', withFloor0.focus === FOCUS_MASK, `${FOCUS_MASK}%`)
ok('休闲用的是 LEISURE_MASK', withFloor0.leisure === LEISURE_MASK, `${LEISURE_MASK}%`)
ok('正常档没手调过 → 走每张图自己的基准', withFloor0.normal === 12, 'autoMask=12 → 12%')

console.log('')
console.log('正常档手调：')
ok('手调 0 就是 0', run('normal', 0, 0, 12) === 0)
ok('手调 10 就是 10', run('normal', 10, 0, 12) === 10)
ok('手调值超过滑杆上限会被夹住', run('normal', 999, 0, 12) === MAX_WASH, `夹到 ${MAX_WASH}%`)

console.log('')
console.log('「自动底线」只当建议，不再改数值（boss 10-19 20:2x：「为什么是从 9 开始的」）：')
ok('底线 9 时，休闲仍是 5（不被抬到 9）', run('leisure', null, 9, 12) === LEISURE_MASK, `5 → ${run('leisure', null, 9, 12)}`)
ok('底线 9 时，正常手调 0 仍是 0（图原样透出来）', run('normal', 0, 9, 12) === 0)
ok('底线 9 时，专注仍是 35', run('focus', null, 9, 12) === FOCUS_MASK)
ok('底线再高也不动数值（20 也一样）', run('normal', 0, 20, 12) === 0 && run('leisure', null, 20, 12) === LEISURE_MASK)
ok('建议值仍然算得出来（只是显示用）', /const floor = autoFloorPct\(entry, activeScheme\(\)\)/.test(SRC) || /autoFloorPct\(entry, activeScheme\(\)\)/.test(SRC))
/**
 * 专注档的盖要比它自己高 —— 否则滑杆上限会把它悄悄削掉，
 * 界面写着 35%、实际 25%（「说的和做的不一样」）。
 */
ok(
  '专注档不被滑杆上限削掉',
  withFloor0.focus === FOCUS_MASK && (FOCUS_MASK <= MAX_WASH || /Math\.max\(MAX_WASH, FOCUS_MASK\)/.test(SRC)),
  `专注 ${FOCUS_MASK}% vs 滑杆上限 ${MAX_WASH}%`,
)

console.log('')
console.log('面板上那根滑杆：')
ok('滑杆左端就是 0（不是这张图的底线）', /min: 0,\s*\n\s*max: MAX_WASH,/.test(SRC) && !/min: floorPct,/.test(SRC))
ok('滑杆上限=MAX_WASH（boss要的 0~40）', /max: MAX_WASH,/.test(SRC) && MAX_WASH === 40)
ok('专注/休闲时滑杆锁上（disabled）', /disabled: locked,/.test(SRC))

console.log('')
if (problems.length) {
  console.log('══ 结论:发现异常 ══')
  problems.forEach((p) => console.log('   ' + p))
  process.exitCode = 1
} else {
  console.log('══ 结论:三个模式的档都生效了，底线也托得住（专注 ' + FOCUS_MASK + '% / 正常按图 / 休闲 ' + LEISURE_MASK + '%）══')
}
