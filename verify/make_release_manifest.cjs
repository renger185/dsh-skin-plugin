/**
 * 生成「自动更新用的发布清单」（2026-10-22）
 *
 * boss：「做成**下载好放在旁边，由您点一下确认才替换**」——
 *   所以需要两样东西：
 *     ① 一份**清单**：这次发布有哪些文件、每个多大、SHA-256 是多少
 *     ② 清单里指向的**文件本身**（发布包里就有，路径是 `plugin/...`）
 *
 * ## 为什么清单是独立的文件、而不是直接扫远端目录
 *   ① **哈希必须跟"实际要替换的文件"一一对应** ——
 *      清单说 17 个文件，替换时就得正好是这 17 个，多一个少一个都不行；
 *   ② 远端目录树里还有 README、截图、verify 脚本 —— 那些**不是插件的一部分**，
 *      装了也没用（还占地方）。清单只收「插件真正要装的那些」。
 *
 * ## 清单放在哪
 *   `publish/release-manifest.json` —— 跟发布包一起进仓库。
 *   别人装的插件从这个地址读清单：
 *   `https://cdn.jsdelivr.net/gh/<owner>/<repo>@<branch>/publish/release-manifest.json`
 *
 * ## 铁律
 *   - 清单里**只有哈希，没有签名**（boss 10-22 明说「只要哈希，不要签名」）。
 *     它挡的是"下载损坏/被截断"，**不挡**"仓库被人改了"（那要 Ed25519 签名，
 *     需要另外配一把签发私钥 —— 那是另一件事）。
 *   - 清单里的路径**必须和仓库里真实路径一致**（相对仓库根）。
 *
 * 跑法：node verify/make_release_manifest.cjs
 */
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

const ROOT = path.resolve(__dirname, '..')
const PUBLISH = path.join(ROOT, 'publish')

/**
 * 插件真正要装的文件（相对**仓库根**）。
 * ⚠️ 必须和 `make_publish.cjs` 的 FILES 里那批 `plugin/...` 完全一致 ——
 *    少一个 = 装上去缺东西；多一个 = 装了没用的文件。
 *    唯一该多的是 `plugin/package.json`（版本号要从这儿读）。
 */
const PLUGIN_FILES = [
  'plugin/index.js',
  'plugin/client.js',
  'plugin/package.json',
  'plugin/cordis.patch.yml',
  'plugin/icon.svg',
  'plugin/LICENSE',
  'plugin/locale/zh.json',
  'plugin/locale/en.json',
  'plugin/docs/README.md',
  'plugin/docs/操作指引.md',
  'plugin/docs/使用说明.md',
  'plugin/docs/版本记录.md',
  'plugin/docs/踩坑与设计决策.md',
  'plugin/docs/清单.json',
  'plugin/assets/sounds/ding.mp3',
  'plugin/assets/sounds/dong.mp3',
  'plugin/assets/sounds/coin.mp3',
  'plugin/assets/sounds/sword-draw.mp3',
]

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex')

/** 列出 publish/plugin 下所有文件（相对仓库根），用于查"清单漏了谁" */
function walk(dir, base = '') {
  const out = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = path.join(base, entry.name)
    if (entry.isDirectory()) out.push(...walk(path.join(dir, entry.name), rel))
    else out.push(rel.replace(/\\/g, '/'))
  }
  return out
}

if (!fs.existsSync(PUBLISH)) {
  console.error('✗ 没有 publish/ —— 先跑 node verify/make_publish.cjs')
  process.exit(1)
}

const files = []
const missing = []
for (const rel of PLUGIN_FILES) {
  const abs = path.join(PUBLISH, rel)
  if (!fs.existsSync(abs)) {
    missing.push(rel)
    continue
  }
  const buf = fs.readFileSync(abs)
  files.push({ path: rel, bytes: buf.length, sha256: sha256(buf) })
}
if (missing.length) {
  console.error('✗ 发布包里缺这些文件（先跑 make_publish.cjs）：')
  for (const rel of missing) console.error('   ' + rel)
  process.exit(1)
}

// 版本号：以发布包里的 package.json 为准（不是工作区那份）
const pkg = JSON.parse(fs.readFileSync(path.join(PUBLISH, 'plugin', 'package.json'), 'utf8'))
const version = String(pkg.version || '')

// 反查：发布包里还有哪些 plugin/ 文件没进清单（漏了就装不上）
const onDisk = walk(path.join(PUBLISH, 'plugin')).map((rel) => 'plugin/' + rel.replace(/\\/g, '/'))
const listed = new Set(files.map((f) => f.path))
const notListed = onDisk.filter((rel) => !listed.has(rel))

const manifest = {
  schema: 'dsh-skin/release-manifest/v1',
  version,
  publishedAt: new Date().toISOString(),
  // 说明这一版更新了什么（界面上可以显示一行）
  notes: '',
  files,
}

const outPath = path.join(PUBLISH, 'release-manifest.json')
fs.writeFileSync(outPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8')

/**
 * 【10-22 22:1x boss 定「先修再推」】**清单要出两份**。
 *
 * 【为什么必须两份 —— 这是个路径对不上的真 bug】
 *   插件代码去读的是：`cdn.jsdelivr.net/gh/<repo>@<branch>/publish/release-manifest.json`
 *   而**本地 `publish/` 目录就是仓库的根**（打包出来直接 push），
 *   ⇒ 仓库根的 `release-manifest.json` 对应的**远端路径是 `release-manifest.json`**，
 *   **不是** `publish/release-manifest.json` ⇒ 插件读的那个地址 **404**（22:0x 实测过）。
 *   两个仓库（换肤 / 手机远程）**历史上都从来没有过 `publish/` 子目录**。
 *
 * 【怎么修最省事】不动已经验过的插件代码（改 `plugin/index.js` 两处 + 文档两处，
 *   等于把 v1.8.9 写好的更新功能重新验一遍）。**改成出两份**：
 *   ① `publish/release-manifest.json`      → 远端路径 `release-manifest.json`（仓库根，给人看 / 手工下载用）
 *   ② `publish/publish/release-manifest.json` → 远端路径 `publish/release-manifest.json`（**插件读的就是这个**）
 *   两份内容完全一样，脚本写完自己核对哈希。
 */
const mirrorDir = path.join(PUBLISH, 'publish')
fs.mkdirSync(mirrorDir, { recursive: true })
const mirrorPath = path.join(mirrorDir, 'release-manifest.json')
fs.writeFileSync(mirrorPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8')

const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex')
const mirrorOk = sha(outPath) === sha(mirrorPath)

console.log('发布清单已写：' + path.relative(ROOT, outPath))
console.log('  版本：' + version)
console.log('  文件：' + files.length + ' 个，合计 ' + (files.reduce((s, f) => s + f.bytes, 0) / 1024).toFixed(0) + ' KB')
console.log('  镜像份（插件读的 publish/release-manifest.json）：' + path.relative(ROOT, mirrorPath) + (mirrorOk ? ' ✓ 内容一致' : ' ✗ 两份不一致'))
if (!mirrorOk) {
  console.error('✗ 两份清单内容不一致 —— 不许推')
  process.exit(1)
}
if (notListed.length) {
  console.log('  ⚠ 发布包里还有这些文件没进清单（装了不会更新它们）：')
  for (const rel of notListed) console.log('     ' + rel)
} else {
  console.log('  ✓ 发布包里的文件与清单一一对应')
}
console.log('')
console.log('  别人装好后，插件从这里读清单：')
console.log('  https://cdn.jsdelivr.net/gh/<owner>/<repo>@<branch>/publish/release-manifest.json')
