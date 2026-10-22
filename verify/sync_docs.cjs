/**
 * 把工作区的文档同步进插件文件夹（boss 10-19 21:4x：「把相关的文档全部放在插件的文件夹里面」）
 *
 * 为什么要脚本、为什么带哈希清单：
 *   文档的真源在工作区根目录（改完就地留档），插件里那份是**给用户的副本**。
 *   两个地方各存一份就会漂 —— 所以由这个脚本单向复制，并把每份的 SHA256 写进
 *   `plugin/docs/清单.json`；`--check` 用来对账（`verify/panel_order_check.cjs` 会调它）。
 *
 * 用法：
 *   node verify/sync_docs.cjs           # 同步（把工作区文档拷进 plugin/docs/）
 *   node verify/sync_docs.cjs --check   # 只对账，不一样就报错退出 1
 */
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

const ROOT = path.join(__dirname, '..')
const OUT = path.join(ROOT, 'plugin', 'docs')

// 源文件 → 插件里叫什么（名字用中文，用户翻得到）
const DOCS = [
  { from: '操作指引_20261019_2115.md', to: '操作指引.md' },
  { from: '使用说明_20261019_1415.md', to: '使用说明.md' },
  { from: 'README_踩坑与设计决策_20261019_0735.md', to: '踩坑与设计决策.md' },
  { from: path.join('releases', 'CHANGELOG.md'), to: '版本记录.md' },
]

const checkOnly = process.argv.includes('--check')
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex')
const problems = []

const manifestPath = path.join(OUT, '清单.json')
const prev = fs.existsSync(manifestPath) ? JSON.parse(fs.readFileSync(manifestPath, 'utf8')) : { files: {} }
const rows = []

for (const doc of DOCS) {
  const src = path.join(ROOT, doc.from)
  if (!fs.existsSync(src)) {
    /**
     * 【10-19 21:5x】仓库里那份只有 `plugin/docs/`（真源带日期的那些是工作区才有的）。
     * 所以「源文件不在」不当失败：说明这是**仓库副本**，以 plugin/docs/ 里的为准。
     * 工作区里真源一定在，所以这条不会削弱平时的对账。
     */
    console.log('  （跳过）' + doc.from + ' 不在 —— 当这是仓库副本，以 plugin/docs/' + doc.to + ' 为准')
    continue
  }
  const buf = fs.readFileSync(src)
  const hash = sha(buf)
  const dst = path.join(OUT, doc.to)
  const same = fs.existsSync(dst) && sha(fs.readFileSync(dst)) === hash
  rows.push({ 插件里: doc.to, 来源: doc.from.replace(/\\/g, '/'), 字节: buf.length, sha256: hash, 一致: same })
  if (checkOnly) {
    if (!same) problems.push(`${doc.to} 跟 ${doc.from} 不一致（跑 node verify/sync_docs.cjs 同步）`)
    continue
  }
  if (same) continue
  fs.mkdirSync(OUT, { recursive: true })
  fs.writeFileSync(dst, buf)
}

if (!checkOnly) {
  // 文档目录的入口页（给用户看从哪读起）
  const readme = `# 文档目录

插件自带这几份文档（中英双语的界面在插件面板最顶上，一键切换）：

| 文件 | 给谁看 | 内容 |
|---|---|---|
| \`操作指引.md\` | **第一次装它的人** | 三十秒上手、安装、悬浮球用法、面板逐项、常见问题、English quick start |
| \`使用说明.md\` | 使用者 | 完整的产品说明（功能、设置、快捷键） |
| \`版本记录.md\` | 使用者 / 维护者 | 每个版本改了什么、为什么改 |
| \`踩坑与设计决策.md\` | **改代码的人** | 所有翻过车的地方、每个设计决策的来源、验证脚本怎么用 |

> 这几份是从工作区真源同步过来的副本，哈希记在 \`清单.json\`；改动请改真源再跑
> \`node verify/sync_docs.cjs\`，不要直接改这里的文件（会被覆盖）。
`
  const readmePath = path.join(OUT, 'README.md')
  const buf = Buffer.from(readme, 'utf8')
  rows.push({ 插件里: 'README.md', 来源: '(脚本生成)', 字节: buf.length, sha256: sha(buf), 一致: true })
  fs.writeFileSync(readmePath, buf)
  fs.writeFileSync(
    manifestPath,
    JSON.stringify({ 说明: 'plugin/docs 下这几份是工作区文档的副本，改真源后跑 verify/sync_docs.cjs', files: Object.fromEntries(rows.map((r) => [r.插件里, r.sha256])) }, null, 2) + '\n',
    'utf8',
  )
}

const pad = (s, n) => { s = String(s); const w = [...s].reduce((a, c) => a + (c.charCodeAt(0) > 127 ? 2 : 1), 0); return s + ' '.repeat(Math.max(0, n - w)) }
console.log(checkOnly ? '文档对账：' : '文档同步：')
for (const r of rows) console.log('  ' + pad(r.插件里, 22) + pad(r.字节 + 'B', 10) + (checkOnly ? (r.一致 ? '一致 ✓' : '不一致 ✗') : '') + '  ← ' + r.来源)
console.log('')
if (problems.length) {
  console.log('══ 结论:有问题 ══')
  problems.forEach((p) => console.log('   ' + p))
  process.exitCode = 1
} else {
  console.log(checkOnly ? '══ 结论:插件里的文档跟工作区真源一致 ══' : `══ 结论:已同步 ${rows.length} 份文档到 plugin/docs/ ══`)
}
