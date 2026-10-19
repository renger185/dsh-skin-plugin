/**
 * 「打开面板自动回到当前背景图那张」的三处修复 —— 静态核验。
 * 背景:10-18 22:05 作者报「现在并不是」。查下来是两个独立的洞叠在一起。
 */
const fs = require('fs')
const path = require('path')

const SRC = fs.readFileSync(path.join(__dirname, '..', 'plugin', 'client.js'), 'utf8')
let fails = 0
const ok = (label, cond, detail) => {
  if (!cond) fails += 1
  console.log(`${cond ? 'OK  ' : 'FAIL'} ${label}${detail ? '  ' + detail : ''}`)
}

/** 抓一段源码(从 from 到 to 之间) */
function between(from, to) {
  const a = SRC.indexOf(from)
  if (a < 0) return ''
  const b = SRC.indexOf(to, a)
  return SRC.slice(a, b < 0 ? undefined : b)
}

console.log('══ 「打开面板定位当前图」核验 ══')
console.log('')

// ── 洞 1:分页只画前 60 张,当前图排在几百名开外就压根没被画出来 ──
const pageBlock = between('const page = useMemo(', 'const more =')
ok('图库页用的是 useMemo(会跟着 activeId 重算)', !!pageBlock)
ok('当前图不在已加载页里时会补进这批', /at\s*>=\s*slice\.length[\s\S]{0,120}slice\.push/.test(pageBlock), pageBlock ? '' : '没找到 page 那段')
ok('补进去的顺序跟图库一致(下标才对得上)', /library\.slice\(slice\.length,\s*at\s*\+\s*1\)/.test(pageBlock))

// ── 洞 2:offsetTop 的参照系 ──
const scrollerStyle = between("gridTemplateColumns: 'repeat(4, 1fr)'", 'items.map(')
ok('滚动框自己是定位祖先(offsetTop 基准才对)',
  /position:\s*'relative'/.test(scrollerStyle))

// ── 洞 3:刚打开那一帧还没排完版 ──
const effect = between('const jump = () => {', '}, [activeId, items.length])')
ok('定位函数跑两遍(打开后 60ms 再定一次)', /setTimeout\(jump,\s*60\)/.test(effect))

// ── 选中态要够显眼 ──
const cell = between("'data-index': index", 'shouldLoad')
ok('当前那张描边加粗并换成主色', /border:\s*`2px solid \$\{isActive \? T\.accent/.test(cell))
ok('当前那张右上角有勾', /isActive\s*\?\s*h\('div'/.test(SRC.split('GalleryStrip')[1] || ''))

console.log('')
console.log(fails === 0 ? '全部通过' : `有 ${fails} 项没过`)
process.exitCode = fails === 0 ? 0 : 1
