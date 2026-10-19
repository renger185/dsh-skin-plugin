/**
 * 作者 10-18 20:45 点头的四条(A 换一张 / B 球位置记住 / C 自动换肤绿点 / D 模糊过渡可调)自检。
 *
 * 能真跑的就真跑:
 *   - D:把插件里 portraitCssFor 原样抠出来 eval,分别喂 64 和 0,看垫底层在不在
 *   - B:把主机端那段归一化原样抠出来 eval,喂正常值 / 字符串 / NaN / 超大值
 *   - A / C:界面上的东西没法离线跑,只查代码在不在,并在报告里写明"未实跑"
 */
const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const SRC = fs.readFileSync(path.join(ROOT, 'plugin', 'client.js'), 'utf8')
const HOST = fs.readFileSync(path.join(ROOT, 'plugin', 'index.js'), 'utf8')

let pass = 0, fail = 0
const ok = (name, good, extra = '') => {
  console.log((good ? '  ✓ ' : '  ✗ ') + name + (extra ? '  ' + extra : ''))
  good ? pass++ : fail++
}

/* ── D:竖图模糊过渡可调 ─────────────────────────────────── */
console.log('D 两侧模糊过渡可调')
const fnSrc = SRC.match(/function portraitCssFor\([\s\S]*?\n    \}/)
if (!fnSrc) {
  ok('抠出 portraitCssFor', false)
} else {
  const clamp = (n, a, b) => Math.min(b, Math.max(a, n))
  const cssEscape = (s) => s
  const fn = eval('(' + fnSrc[0] + ')')
  const at64 = fn('front.webp', 'bleed.webp', 'center', 64)
  const at0 = fn('front.webp', 'bleed.webp', 'center', 0)
  const at28 = fn('front.webp', 'bleed.webp', 'center', 28)
  ok('拉到 64 有垫底层', at64.includes('blur(64px)'))
  ok('拉到 28 跟着变', at28.includes('blur(28px)'))
  ok('拉到 0 垫底层整个没了', !at0.includes('dsh-skin-bleed'), '(两侧露干净底色)')
  ok('主图层任何档都不受影响', at64.includes('dsh-skin-front') && at0.includes('dsh-skin-front'))
}

/* ── B:悬浮球位置记住(主机端那一段归一化)──────────────── */
console.log('')
console.log('B 悬浮球位置记住')
const block = HOST.match(/for \(const key of \['ballX', 'ballY'\]\) \{[\s\S]*?\n    \}/)
if (!block) {
  ok('抠出主机端位置归一化', false)
} else {
  // 原样抠出来当函数体用:外面包一层(参数就叫 next,跟主机端里一样),让它把处理过的对象还回来
  const normalize = eval('(function run(next) {' + block[0] + 'return next })')
  const probe = (v) => normalize({ ballX: v, ballY: v }).ballX
  ok('正常数字原样留着', probe(1234.6) === 1235, '(存进去 1234.6 → 1235)')
  ok('数字字符串也认', probe('800') === 800)
  ok('NaN 归成 null(球回右下角,不会飞到天上去)', probe(NaN) === null)
  ok('Infinity 也归成 null', probe(Infinity) === null)
}
ok('客户端把 ballX/ballY 存进设置文件', /saveState\(\{ ballX: at\.x, ballY: at\.y \}\)/.test(SRC))
ok('启动时读回来', /state\.ballX === null \|\| state\.ballY === null\) return/.test(SRC))
ok('读取时按窗口大小夹一下(小屏不会找不到球)', /window\.innerWidth - 56/.test(SRC))

/* ── A:手动换一张 ──────────────────────────────────────── */
console.log('')
console.log('A 面板上手动换一张')
ok('按钮挂在图库上方', SRC.includes("dict.pickRandom"))
ok('点了会抽一张不是当前的这张', /const next = pickRandomImageId\(\)\s*\n\s*if \(next\) void selectImage\(next\)/.test(SRC))
ok('抽签本身排除当前图', /library\.filter\(\(item\) => item\.id !== state\.activeId\)/.test(SRC))
ok('图库不足两张时不显示这个按钮', /library\.length > 1[\s\S]{0,400}dict\.pickRandom/.test(SRC))

/* ── C:自动换肤开着时球上带绿点 ────────────────────────── */
console.log('')
console.log('C 自动换肤绿点')
// 绿点那一处要的是"判断在前面、绿点在后面",中间隔着整段样式
ok('按 rotateMinutes 决定显不显示', /state\.rotateMinutes > 0[\s\S]{0,400}#00e676/.test(SRC))
ok('用的是和转圈同一个绿', SRC.includes("'#00e676'"))
ok('绿点不吃鼠标事件,不挡拖动', /pointerEvents: 'none'/.test(SRC))

/* ── E:面板里「恢复默认界面」排在最上面(作者 10-19 18:29)──────── */
console.log('')
console.log('E 悬浮窗里「恢复默认界面」放最上面')
{
  // 判据用「源码里的先后顺序」：按钮必须排在第一个 section(模式)之前，
  // 而且整份源码里只能有这一处 restoreDefaults() 的 onClick（防"搬了没删旧的那份"）。
  const atRestore = SRC.indexOf('onClick: () => restoreDefaults()')
  const atMode = SRC.indexOf('dict.modeNormal')
  const atStatus = SRC.indexOf('// 这张图的读数')
  const hits = (SRC.match(/onClick: \(\) => restoreDefaults\(\)/g) || []).length
  ok('恢复默认按钮只有一处(搬走没留旧的)', hits === 1, `实际 ${hits} 处`)
  ok('它排在「模式」之前(也就是面板第一个)', atRestore > 0 && atMode > 0 && atRestore < atMode)
  ok('也不在读数段那段尾巴里', atStatus > 0 && atRestore < atStatus)
  ok('按钮下面还带着说明那句话(不是光秃秃一个按钮)', /dict\.restore,[\s\S]{0,200}dict\.restoreHint/.test(SRC))
  ok('注释里记着作者原话', /恢复默认放在最上面/.test(SRC))
}

console.log('')
console.log(fail === 0 ? `★ ${pass} 项全过(A / C / E 的界面效果未实跑,要作者重启后看)` : `✗ ${fail} 项没过`)
process.exitCode = fail === 0 ? 0 : 1
