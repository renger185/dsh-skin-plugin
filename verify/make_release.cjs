/**
 * 换肤插件 · 打包发版
 *
 * 把当前 plugin/ 里「真正会装进桌面端的那几个文件」拷进
 *   releases/v<版本号>_<日期>/plugin/
 * 并写一份 `文件清单.md`（含每个文件的 SHA256）—— 以后想确认
 * 「作者桌面上跑的是哪一版」或者想回滚，拿这份清单对哈希就行。
 *
 * 版本号的事实源只有一个：`plugin/package.json` 的 version 字段。
 *
 * 用法：
 *   node verify/make_release.cjs            # 打包当前版本
 *   node verify/make_release.cjs --force    # 同名目录已存在时覆盖重打
 */
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

const ROOT = path.join(__dirname, '..')
const PLUGIN = path.join(ROOT, 'plugin')
const pkg = JSON.parse(fs.readFileSync(path.join(PLUGIN, 'package.json'), 'utf8'))
const version = pkg.version
const now = new Date()
const pad = (n) => String(n).padStart(2, '0')
const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`
const human = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`

const releaseDir = path.join(ROOT, 'releases', `v${version}_${stamp}`)
if (fs.existsSync(releaseDir) && !process.argv.includes('--force')) {
  console.log('已经打过这一版:', path.relative(ROOT, releaseDir))
  console.log('要重打就加 --force（会覆盖该目录里的 plugin/，不动文档）')
  process.exit(0)
}

// package.json 的 files 字段就是「装进桌面端的清单」
const wanted = []
for (const entry of pkg.files || []) {
  if (entry.includes('*')) {
    const dir = path.dirname(entry)
    const ext = path.extname(entry)
    const base = path.join(PLUGIN, dir)
    for (const f of fs.readdirSync(base)) if (f.endsWith(ext)) wanted.push(path.join(dir, f))
  } else {
    wanted.push(entry)
  }
}

const outPlugin = path.join(releaseDir, 'plugin')
fs.mkdirSync(outPlugin, { recursive: true })
const rows = []
for (const rel of wanted) {
  const src = path.join(PLUGIN, rel)
  const dst = path.join(outPlugin, rel)
  fs.mkdirSync(path.dirname(dst), { recursive: true })
  fs.copyFileSync(src, dst)
  const buf = fs.readFileSync(src)
  rows.push({
    file: rel.replace(/\\/g, '/'),
    bytes: buf.length,
    sha256: crypto.createHash('sha256').update(buf).digest('hex'),
  })
}

// package.json 本身也存一份（版本号在那儿）
fs.copyFileSync(path.join(PLUGIN, 'package.json'), path.join(outPlugin, 'package.json'))
const pkgBuf = fs.readFileSync(path.join(PLUGIN, 'package.json'))
rows.push({ file: 'package.json', bytes: pkgBuf.length, sha256: crypto.createHash('sha256').update(pkgBuf).digest('hex') })

const pad2 = (s, n) => { s = String(s); const w = [...s].reduce((a, c) => a + (c.charCodeAt(0) > 127 ? 2 : 1), 0); return s + ' '.repeat(Math.max(0, n - w)) }
const lines = []
lines.push(`# 换肤插件 v${version} · 文件清单`)
lines.push('')
lines.push(`打包时间：${human}`)
lines.push(`打包目录：\`releases/v${version}_${stamp}/\``)
lines.push('')
lines.push('这份清单里每个文件的哈希都对得上，就说明「作者桌面上装的那一版」就是这一版。')
lines.push('')
lines.push('| 文件 | 字节 | SHA256 |')
lines.push('|---|---|---|')
for (const r of rows) lines.push(`| \`${r.file}\` | ${r.bytes} | \`${r.sha256}\` |`)
lines.push('')
lines.push('安装位（软链接，指向工作区 `plugin/`）：`%USERPROFILE%\\.dsh\\profiles\\desktop\\node_modules\\@local\\dsh-skin`')
lines.push('')
lines.push('核对办法：`node verify/version_check.cjs`')
fs.writeFileSync(path.join(releaseDir, '文件清单.md'), lines.join('\n'), 'utf8')

console.log(`已打包 v${version} → ${path.relative(ROOT, releaseDir)}`)
console.log('  文件 ' + rows.length + ' 个：')
for (const r of rows) console.log('   ' + pad2(r.file, 34) + String(r.bytes).padStart(8) + '  ' + r.sha256.slice(0, 12))
console.log('')
console.log('  文件清单.md 已写好（含完整哈希）')
