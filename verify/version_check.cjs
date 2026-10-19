/**
 * 换肤插件 · 版本对账
 *
 * 回答一个问题：**作者桌面上装的，是不是工作区现在这一版？**
 *
 * 三件事一起对：
 *   ① `plugin/package.json` 的版本号，跟 releases 下 `v<版本号>_<日期>` 快照目录对得上；
 *   ② 快照里每个文件的 SHA256，跟工作区 `plugin/` 里的现文件一模一样（有出入 = 打完包又改过代码，得重打）；
 *   ③ 界面那一行标题里写的版本号（locale/zh.json、en.json），跟 package.json 一致（防手改了版本号忘了改标题）。
 *
 * 用法：node verify/version_check.cjs
 * 退出码：0 = 全对得上；1 = 有对不上的
 */
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

const ROOT = path.join(__dirname, '..')
const PLUGIN = path.join(ROOT, 'plugin')
const RELEASES = path.join(ROOT, 'releases')

const problems = []
const pkg = JSON.parse(fs.readFileSync(path.join(PLUGIN, 'package.json'), 'utf8'))
const version = pkg.version
console.log('工作区版本号(package.json): v' + version)

// ① 快照目录
const dirs = fs.existsSync(RELEASES)
  ? fs.readdirSync(RELEASES).filter((d) => d.startsWith(`v${version}_`) && fs.statSync(path.join(RELEASES, d)).isDirectory())
  : []
if (!dirs.length) {
  problems.push(`没有 v${version} 的快照目录（应该跑 node verify/make_release.cjs 打一包）`)
  console.log('快照目录                 : ✗ 没找到 releases/v' + version + '_*')
} else {
  console.log('快照目录                 : ' + dirs.join(', '))
}
const snapshot = dirs.length ? path.join(RELEASES, dirs[0], 'plugin') : null

// ② 逐文件对哈希
const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex')
const rels = []
const walk = (base, rel = '') => {
  for (const e of fs.readdirSync(path.join(base, rel), { withFileTypes: true })) {
    const r = path.join(rel, e.name)
    if (e.isDirectory()) walk(base, r)
    else rels.push(r)
  }
}
if (snapshot) {
  walk(snapshot)
  rels.sort()
  let same = 0
  const diff = []
  for (const rel of rels) {
    const live = path.join(PLUGIN, rel)
    if (!fs.existsSync(live)) { diff.push(rel + '（工作区里没有这个文件）'); continue }
    if (sha(live) === sha(path.join(snapshot, rel))) same++
    else diff.push(rel)
  }
  console.log('快照文件数               : ' + rels.length + '，跟工作区一致 ' + same + ' 个' + (diff.length ? ' ✗ 不一致：' + diff.join('、') : ' ✓'))
  if (diff.length) problems.push('打完包之后又改过代码，重打一次：' + diff.join('、'))
}

// ③ 界面标题里的版本号
for (const f of ['locale/zh.json', 'locale/en.json']) {
  const rel = f.replace('/', path.sep)
  const text = fs.readFileSync(path.join(PLUGIN, rel), 'utf8')
  const title = (text.match(/"title"\s*:\s*"([^"]+)"/) || [])[1] || ''
  const ok = title.includes('v' + version)
  console.log(('标题 ' + f).padEnd(25) + ': ' + title + (ok ? '  ✓' : '  ✗ 版本号对不上'))
  if (!ok) problems.push(`${f} 的标题里没有 v${version}`)
}

console.log('')
if (problems.length) {
  console.log('══ 结论:对不上 ══')
  problems.forEach((p) => console.log('   ' + p))
  process.exitCode = 1
} else {
  console.log('══ 结论:版本号、快照哈希、界面标题三处全对得上 —— 桌面端装的就是 v' + version + ' ══')
}
