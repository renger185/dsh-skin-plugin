/* 查面板里各段的顺序（语言开关必须在最顶上）+ 语言相关的实现是否齐全。
   用法：node verify/panel_order_check.cjs */
const fs = require('fs')
const path = require('path')
const SRC = fs.readFileSync(path.join(__dirname, '..', 'plugin', 'client.js'), 'utf8')
const HOST = fs.readFileSync(path.join(__dirname, '..', 'plugin', 'index.js'), 'utf8')

let fails = 0
const ok = (label, cond, detail) => {
  if (!cond) fails += 1
  console.log(`${cond ? 'OK  ' : 'FAIL'} ${label}${detail ? '  ' + detail : ''}`)
}

const body = SRC.slice(SRC.indexOf('function SkinControls'), SRC.indexOf('function Launcher'))
const marks = [
  ['语言开关', 'LANG_TEXT.label'],
  ['恢复默认', 'restoreDefaults()'],
  ['模式', 'dict.modeNormal'],
  ['背景明度滑杆', "type: 'range'"],
  ['图库', 'dict.gallery'],
  ['竖图铺法', 'dict.portraitFill'],
  ['提示音', 'dict.soundLabel'],
  ['读数', 'dict.statusKind'],
]
const order = marks
  .map(([n, k]) => [n, body.indexOf(k)])
  .filter((r) => r[1] >= 0)
  .sort((a, b) => a[1] - b[1])

console.log('面板从上到下：')
order.forEach((r, i) => console.log('  ' + (i + 1) + '. ' + r[0]))
console.log('')

ok('语言开关在整列最顶上（第一段）', order.length > 0 && order[0][0] === '语言开关')
ok('两个语言按钮都写着中英两种字', /LANG_TEXT = \{ label: '语言 \/ Language', zh: '中文 \/ Chinese', en: 'English \/ 英文' \}/.test(SRC))
ok('语言开关不进 DICTS（不然切换时自己会被翻掉）', !/langLabel:/.test(SRC))
ok('默认中文', /lang: 'zh'/.test(SRC) && /src\.lang === 'en' \? 'en' : 'zh'/.test(SRC))
ok('一键切换（setLang 立刻重画 + 落盘）', /async function setLang\(next\)/.test(SRC) && /await saveState\(\{ lang \}\)/.test(SRC))
ok('dictFor 认面板选的语言', /const chosen = state\.lang === 'en' \? 'en' : 'zh'/.test(SRC))
ok('恢复默认不会把语言重置（语言不算界面配色）', /soundId: state\.soundId, lang: state\.lang \}/.test(SRC))
ok('主机端也归一化 lang（只认 zh/en）', /next\.lang = next\.lang === 'en' \? 'en' : 'zh'/.test(HOST))

/**
 * 中英两套文案必须**一把钥匙都不缺** —— 缺了英文那套，切到 English 就会看到 undefined。
 * 直接从源码里把两个 dict 抠出来比 key 集合（不手抄任何一串键名）。
 */
{
  const grab = (name) => {
    const start = SRC.indexOf('      ' + name + ': {')
    if (start < 0) return null
    const end = SRC.indexOf('\n      },', start)
    return SRC.slice(start, end < 0 ? SRC.length : end)
  }
  const zh = grab('zh')
  const en = grab('en')
  const keys = (block) => new Set([...block.matchAll(/^\s{8}([a-zA-Z][\w]*):/gm)].map((m) => m[1]))
  if (!zh || !en) {
    ok('能抠出中英两套文案', false)
  } else {
    const kz = keys(zh)
    const ke = keys(en)
    const missingEn = [...kz].filter((k) => !ke.has(k))
    const missingZh = [...ke].filter((k) => !kz.has(k))
    ok('英文文案不缺键（否则切到 English 会见到 undefined）', missingEn.length === 0, missingEn.length ? '缺：' + missingEn.join('、') : `中 ${kz.size} / 英 ${ke.size} 键`)
    ok('中文文案也不缺键', missingZh.length === 0, missingZh.length ? '缺：' + missingZh.join('、') : '')
  }
}

console.log('')
console.log(fails === 0 ? '全部通过' : `有 ${fails} 项没过`)
process.exitCode = fails === 0 ? 0 : 1
