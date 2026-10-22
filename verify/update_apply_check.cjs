/**
 * 自动更新「下载到旁边 → 确认后替换」· 真跑验证（2026-10-22）
 *
 * boss原话：「做成**『下载好放在旁边，由您点一下确认才替换』**——既省事，又不越界。」
 *
 * 这个功能会**动用户机器上的文件**，所以判据必须覆盖最要命的三件事：
 *   ① **下载阶段绝对不碰现装的那一份**（下载失败/断网/哈希不对 → 现装毫发无损）
 *   ② **替换只在用户点了之后才做**，而且**替换前一定备份**
 *   ③ 替换失败 → **自动回滚**（不能让用户机器上留一个半新半旧的插件）
 *
 * 跑法：node verify/update_apply_check.cjs
 * 退出码：0 = 全过；1 = 有失败
 */
const fs = require('fs')
const path = require('path')
const os = require('os')
const http = require('http')
const crypto = require('crypto')

const ROOT = path.resolve(__dirname, '..')
const HOST = path.join(ROOT, 'plugin', 'index.js')

let pass = 0
let fail = 0
const ok = (name, good, extra = '') => {
  console.log((good ? '  ✓ ' : '  ✗ ') + name + (extra ? '  ' + extra : ''))
  good ? pass++ : fail++
}

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex')

/**
 * 真 fetch 另存一份 —— **打本机接口用它**。
 * ⚠️ 测主机端时全局 fetch 被换成"假远端"，用全局的那个的话，
 *    我自己打本机接口也会被假远端顶掉（这个坑本项目今天已经踩过一次）。
 */
const realFetch = globalThis.fetch

async function bootHost(config) {
  const mod = await import('file://' + HOST.replace(/\\/g, '/') + '?t=' + Date.now() + Math.random())
  const registered = []
  const ctx = {
    logger: { warn: () => {}, info: () => {}, error: () => {} },
    effect: () => () => {},
    webServer: { register: (route) => { registered.push(route); return () => {} } },
  }
  mod.apply(ctx, config)
  const server = http.createServer((req, res) => {
    const pathname = (req.url || '').split('?')[0]
    const route = registered.find((r) => r.kind === 'exact' && r.path === pathname)
    if (!route) { res.writeHead(404); res.end('{}'); return }
    route.handler(req, res)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { server, baseUrl: 'http://127.0.0.1:' + server.address().port }
}

async function post(baseUrl, pathname, body) {
  /**
   * ⚠️ 这里**必须用 realFetch**（另存的一份真 fetch），
   *    不能用全局那个 —— 测主机端时全局 fetch 被换成了"假远端"，
   *    用全局的话**我自己打本机接口也会被假远端顶掉**，
   *    拿到的是假远端的 JSON，判据会红得莫名其妙。
   *    （这个坑本项目今天已经踩过一次：08:0x 那轮。）
   */
  const res = await realFetch(baseUrl + pathname, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body || {}),
  })
  const text = await res.text()
  let json = null
  try { json = JSON.parse(text) } catch { json = null }
  return { status: res.status, json }
}

;(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'skin-upd-'))
  const stateFile = path.join(tmp, 'state.json')
  const libraryFile = path.join(tmp, 'library.json')
  const imageDir = path.join(tmp, 'images')
  const fakeInstall = path.join(tmp, 'install')
  fs.mkdirSync(imageDir, { recursive: true })
  fs.mkdirSync(fakeInstall, { recursive: true })
  // 假装已装的插件：两个文件
  fs.writeFileSync(path.join(fakeInstall, 'index.js'), 'OLD INDEX', 'utf8')
  fs.writeFileSync(path.join(fakeInstall, 'client.js'), 'OLD CLIENT', 'utf8')
  fs.writeFileSync(stateFile, '{}', 'utf8')
  fs.writeFileSync(libraryFile, '[]', 'utf8')

  /**
   * ⚠️ 主机端认的是**它自己所在的目录**（import.meta.url 推的），
   *    所以"已装的那份"就是 plugin/ 目录本身 —— 不能拿临时目录假装，
   *    否则测的就不是真替换路径。
   *    ⇒ 下面的替换测试改为**真在 plugin/ 里放两个探针文件**，
   *    测完删掉（并在前后各记一次内容，证明"下载阶段没动它"）。
   */
  const probeName = '_upgrade_probe_target.js'
  const probePath = path.join(ROOT, 'plugin', probeName)
  const before = 'OLD PROBE CONTENT'
  const after = 'NEW PROBE CONTENT'
  fs.writeFileSync(probePath, before, 'utf8')
  const backupProbe = () => {
    try { fs.unlinkSync(probePath) } catch { /* 忽略 */ }
  }

  const newFiles = [{ path: `plugin/${probeName}`, bytes: Buffer.byteLength(after), sha256: sha256(Buffer.from(after, 'utf8')) }]
  const manifest = { schema: 'dsh-skin/release-manifest/v1', version: '9.9.9', files: newFiles }

  /**
   * 假远端：
   *   - publish/release-manifest.json → 清单
   *   - plugin/<探针名>             → 新内容
   * ⚠️ 主机端内部访问远端走 globalThis.fetch；
   *    我自己打本机接口要用 realFetch（不然会被假远端顶掉 —— 这个坑本项目踩过）。
   */
  const fakeRemote = async (url) => {
    const u = String(url)
    if (u.includes('release-manifest.json')) {
      return { ok: true, text: async () => JSON.stringify(manifest) }
    }
    if (u.includes(probeName)) {
      return { ok: true, arrayBuffer: async () => Buffer.from(after, 'utf8') }
    }
    return { ok: false, text: async () => '' }
  }

  const cfg = {
    stateFile,
    libraryFile,
    imageDir,
    updateRepo: 'someone/dsh-skin',
    updateBranch: 'main',
  }

  try {
    /* ══ ① 下载阶段：绝不碰现装的那一份 ═══════════════════ */
    console.log('1 下载阶段：只落到暂存目录，现装的那份一个字节都不动')
    globalThis.fetch = fakeRemote
    const { server, baseUrl } = await bootHost(cfg)
    const dl = await post(baseUrl, '/dsh-skin/update-download', { method: 'download' })
    ok('下载成功', dl.json?.ok === true, JSON.stringify(dl.json))
    ok('报告了下载的版本', dl.json?.version === '9.9.9', String(dl.json?.version))
    ok('明确标着"还没替换"', dl.json?.applied === false && dl.json?.staged === true, JSON.stringify(dl.json))
    ok('★ 现装的那个文件内容没变（下载不碰它）',
      fs.readFileSync(probePath, 'utf8') === before,
      `现在是「${fs.readFileSync(probePath, 'utf8')}」`)
    const stageRoot = path.join(tmp, 'upgrade-staging')
    const staged = path.join(stageRoot, '9.9.9', 'plugin', probeName)
    ok('新文件落在暂存目录里', fs.existsSync(staged), staged)
    ok('暂存目录在插件数据目录下面（不污染安装目录）',
      stageRoot.startsWith(tmp) && !stageRoot.startsWith(path.join(ROOT, 'plugin')),
      stageRoot)

    /* ══ ② 哈希不对 → 拒绝，且现装的那份不受影响 ══════════ */
    console.log('')
    console.log('2 哈希对不上：拒绝落盘，现装的那份不受影响')
    {
      const badManifest = {
        schema: 'dsh-skin/release-manifest/v1',
        version: '9.9.8',
        files: [{ path: `plugin/${probeName}`, bytes: 3, sha256: sha256(Buffer.from('WRONG', 'utf8')) }],
      }
      globalThis.fetch = async (url) => {
        const u = String(url)
        if (u.includes('release-manifest.json')) return { ok: true, text: async () => JSON.stringify(badManifest) }
        if (u.includes(probeName)) return { ok: true, arrayBuffer: async () => Buffer.from(after, 'utf8') }
        return { ok: false, text: async () => '' }
      }
      const h2 = await bootHost(cfg)
      const dl2 = await post(h2.baseUrl, '/dsh-skin/update-download', { method: 'download' })
      ok('哈希不符 → 明确回 hash-mismatch', dl2.json?.ok === false && dl2.json?.reason === 'hash-mismatch', JSON.stringify(dl2.json))
      ok('★ 现装的那份还是老的（没被半途写坏）', fs.readFileSync(probePath, 'utf8') === before)
      h2.server.close()
    }

    /* ══ ③ 清单路径越界（目录穿越）→ 必须拒绝 ═════════════ */
    console.log('')
    console.log('3 清单里塞了越界路径：必须拒绝（不能写到暂存目录外面）')
    {
      const evil = {
        schema: 'dsh-skin/release-manifest/v1',
        version: '9.9.7',
        files: [{ path: '../../escape.js', bytes: 3, sha256: sha256(Buffer.from('X', 'utf8')) }],
      }
      globalThis.fetch = async (url) => {
        const u = String(url)
        if (u.includes('release-manifest.json')) return { ok: true, text: async () => JSON.stringify(evil) }
        return { ok: false, text: async () => '' }
      }
      const h3 = await bootHost(cfg)
      const dl3 = await post(h3.baseUrl, '/dsh-skin/update-download', { method: 'download' })
      ok('越界路径被拒（manifest-path-invalid）', dl3.json?.ok === false && dl3.json?.reason === 'manifest-path-invalid', JSON.stringify(dl3.json))
      ok('逃逸文件没被创建', !fs.existsSync(path.join(tmp, 'escape.js')))
      h3.server.close()
    }

    /* ══ ④ 用户点了确认 → 才替换（且先备份）════════════════ */
    console.log('')
    console.log('4 用户点了确认：才替换，且先备份')
    globalThis.fetch = fakeRemote
    {
      const h4 = await bootHost(cfg)
      const dl4 = await post(h4.baseUrl, '/dsh-skin/update-download', { method: 'download' })
      ok('（重新下载一次）', dl4.json?.ok === true)
      ok('★ 此刻现装的那份仍然是老的（还没点确认）', fs.readFileSync(probePath, 'utf8') === before)

      const ap = await post(h4.baseUrl, '/dsh-skin/update-apply', { method: 'apply' })
      ok('替换成功', ap.json?.ok === true, JSON.stringify(ap.json))
      ok('★ 现装的那份现在是新的', fs.readFileSync(probePath, 'utf8') === after, fs.readFileSync(probePath, 'utf8'))
      ok('提示需要重启才生效', ap.json?.needRestart === true)
      ok('告诉用户备份放在哪', typeof ap.json?.backup === 'string' && ap.json.backup.length > 0, String(ap.json?.backup))
      // ⚠️ 备份目录里存的是**安装目录结构**（`index.js`、`locale/zh.json`…），
      //    不是仓库结构 —— 仓库里那份带 `plugin/` 前缀，安装目录本身就是那个 plugin/。
      const backupFile = path.join(String(ap.json?.backup || ''), probeName)
      ok('★ 旧版本确实被备份下来了', fs.existsSync(backupFile) && fs.readFileSync(backupFile, 'utf8') === before,
        backupFile)
      h4.server.close()
    }

    /* ══ ⑤ 替换中途失败 → 自动回滚 ═══════════════════════ */
    console.log('')
    console.log('5 替换失败：自动回滚，不能给用户留半新半旧')
    {
      // 把目标文件换成一个**目录**，让 copyFile 写不进去 → 替换必然中途失败
      const dirTarget = path.join(ROOT, 'plugin', '_upgrade_probe_dir_target')
      fs.mkdirSync(dirTarget, { recursive: true })
      const evil2 = {
        schema: 'dsh-skin/release-manifest/v1',
        version: '9.9.6',
        files: [
          { path: 'plugin/_upgrade_probe_ok.js', bytes: 3, sha256: sha256(Buffer.from('OK', 'utf8')) },
          { path: 'plugin/_upgrade_probe_dir_target', bytes: 3, sha256: sha256(Buffer.from('X', 'utf8')) },
        ],
      }
      globalThis.fetch = async (url) => {
        const u = String(url)
        if (u.includes('release-manifest.json')) return { ok: true, text: async () => JSON.stringify(evil2) }
        if (u.includes('_upgrade_probe_ok.js')) return { ok: true, arrayBuffer: async () => Buffer.from('OK', 'utf8') }
        if (u.includes('_upgrade_probe_dir_target')) return { ok: true, arrayBuffer: async () => Buffer.from('X', 'utf8') }
        return { ok: false, text: async () => '' }
      }
      const h5 = await bootHost(cfg)
      const dl5 = await post(h5.baseUrl, '/dsh-skin/update-download', { method: 'download' })
      ok('（下载阶段照常成功）', dl5.json?.ok === true, JSON.stringify(dl5.json))
      /**
       * ⚠️ 判回滚要跟**"这次替换之前"的内容**比，不是跟最初的 OLD 比。
       *    第 4 段已经把探针换成新版了，所以这一段替换前的值是 NEW。
       *    （第一版这里拿固定的 OLD 去比 → 判据误报"没回滚"，其实回滚完全正确。）
       */
      const beforeApply = fs.readFileSync(probePath, 'utf8')
      const ap5 = await post(h5.baseUrl, '/dsh-skin/update-apply', { method: 'apply' })
      ok('替换失败 → 明确报错', ap5.json?.ok === false, JSON.stringify(ap5.json))
      ok('★ 标了"已回滚"', ap5.json?.rolledBack === true, JSON.stringify(ap5.json))
      ok('★ 失败后文件回到"这次替换之前"的内容',
        fs.readFileSync(probePath, 'utf8') === beforeApply,
        `替换前是「${beforeApply}」，现在是「${fs.readFileSync(probePath, 'utf8')}」`)
      // 前面那个成功写进去的文件应该被还原成"原来没有"
      const okProbe = path.join(ROOT, 'plugin', '_upgrade_probe_ok.js')
      ok('★ 回滚后不留半成品文件', !fs.existsSync(okProbe), okProbe)
      h5.server.close()
      fs.rmSync(dirTarget, { recursive: true, force: true })
    }

    /* ══ 5b. 替换写到一半失败 → 真的回滚 ═══════════════════ */
    console.log('')
    console.log('5b 替换写到一半失败：已写的要还原，不能留半新半旧')
    {
      // 造一个"备份能过、但写第二个文件时必炸"的场景：
      //   第一个文件是探针（真实存在、能被备份、也能被替换）；
      //   第二个文件的目标是一个**目录** → 写不进去 → 替换中途失败。
      // 备份阶段不碰那个目录（它不是文件），所以能过；炸点在替换阶段。
      const dirTarget = path.join(ROOT, 'plugin', '_upgrade_probe_dir_target')
      fs.mkdirSync(dirTarget, { recursive: true })
      const evil3 = {
        schema: 'dsh-skin/release-manifest/v1',
        version: '9.9.5',
        files: [
          { path: `plugin/${probeName}`, bytes: 3, sha256: sha256(Buffer.from(after, 'utf8')) },
          { path: 'plugin/_upgrade_probe_dir_target', bytes: 3, sha256: sha256(Buffer.from('X', 'utf8')) },
        ],
      }
      globalThis.fetch = async (url) => {
        const u = String(url)
        if (u.includes('release-manifest.json')) return { ok: true, text: async () => JSON.stringify(evil3) }
        if (u.includes(probeName)) return { ok: true, arrayBuffer: async () => Buffer.from(after, 'utf8') }
        if (u.includes('_upgrade_probe_dir_target')) return { ok: true, arrayBuffer: async () => Buffer.from('X', 'utf8') }
        return { ok: false, text: async () => '' }
      }
      const h5b = await bootHost(cfg)
      const dl5b = await post(h5b.baseUrl, '/dsh-skin/update-download', { method: 'download' })
      ok('（下载阶段照常成功）', dl5b.json?.ok === true, JSON.stringify(dl5b.json))
      const beforeApply5b = fs.readFileSync(probePath, 'utf8')
      const ap5b = await post(h5b.baseUrl, '/dsh-skin/update-apply', { method: 'apply' })
      ok('替换中途失败 → 明确报错', ap5b.json?.ok === false, JSON.stringify(ap5b.json))
      ok('★ 标了"已回滚"', ap5b.json?.rolledBack === true, JSON.stringify(ap5b.json))
      // ★ 关键：已经写进去的那个文件必须被还原成"这次替换之前"的内容
      ok('★ 已写的那个文件被还原回替换前的样子', fs.readFileSync(probePath, 'utf8') === beforeApply5b,
        `替换前是「${beforeApply5b}」，现在是「${fs.readFileSync(probePath, 'utf8')}」`)
      h5b.server.close()
      fs.rmSync(dirTarget, { recursive: true, force: true })
    }

    /* ══ ⑥ 没下载过就想替换 → 必须拒绝 ═════════════════════ */
    console.log('')
    console.log('6 没下载过就想替换：必须拒绝（不许凭空装一个）')
    {
      const h6 = await bootHost(cfg)
      const ap6 = await post(h6.baseUrl, '/dsh-skin/update-apply', { method: 'apply' })
      ok('明确回 nothing-staged', ap6.json?.ok === false && ap6.json?.reason === 'nothing-staged', JSON.stringify(ap6.json))
      h6.server.close()
    }

    /* ══ ⑦ 【10-22 23:5x 新增】清单与文件必须同源 ══════════
     *
     * 【为什么要有这一节】2026-10-22 实测出来的真事故：
     *   jsDelivr 对**个别文件**的边缘缓存是陈旧的（plugin/package.json 还给 1.6.0），
     *   而同一时刻清单那份是新的（1.8.13）。
     *   ⇒ 清单说"这个文件该是这个哈希"，CDN 给的是旧内容
     *   ⇒ 下载在哈希核对那一步报 `hash-mismatch`
     *   ⇒ 用户看到的是「下载更新」按钮点了没反应，**而且看不出原因**。
     *
     * 【判据】
     *   ① 第一顺位是 raw.githubusercontent（直连 GitHub，永远新鲜）
     *   ② 清单和文件**都从这个源取**（不混着来）
     *   ③ 源挂了要能退到下一个源，且**退过去之后仍然同源**
     *   ④ 首选源给的旧内容时，**不会**拿别的源的新内容来凑 —— 那正是出事的那条路
     */
    console.log('')
    console.log('7 清单与文件同源：CDN 缓存陈旧时不会拿旧内容凑数')
    {
      /** 记录每次请求打到了哪个源 —— 用来证明"清单和文件来自同一个源" */
      const hits = []
      globalThis.fetch = async (url) => {
        const u = String(url)
        const isRaw = u.includes('raw.githubusercontent.com')
        const isCdn = u.includes('cdn.jsdelivr.net')
        const isApi = u.includes('api.github.com')
        const which = isRaw ? 'raw' : isCdn ? 'cdn' : isApi ? 'api' : 'other'
        hits.push({ which, url: u })
        if (u.includes('release-manifest.json')) {
          return { ok: true, text: async () => JSON.stringify(manifest) }
        }
        if (u.includes(probeName)) {
          return { ok: true, arrayBuffer: async () => Buffer.from(after, 'utf8') }
        }
        return { ok: false, text: async () => '' }
      }
      const h7 = await bootHost(cfg)
      const dl7 = await post(h7.baseUrl, '/dsh-skin/update-download', { method: 'download' })
      ok('下载成功', dl7.json?.ok === true, JSON.stringify(dl7.json))
      const manifestHits = hits.filter((h) => h.url.includes('release-manifest.json'))
      const fileHits = hits.filter((h) => h.url.includes(probeName))
      /**
       * ⚠️ 判据要取**最后一次**命中，不是第一次。
       *    源码是「按顺序试源，前一个失败才试下一个」——
       *    所以第一次请求可能打在挂掉的源上，**最后那次才是真正用上的源**。
       *    （第一版这里取 hits[0] → 判据误报"不同源"，其实代码完全正确。）
       */
      const usedManifest = manifestHits[manifestHits.length - 1]
      const usedFile = fileHits[fileHits.length - 1]
      ok('★ 清单和文件来自**同一个源**（否则哈希必然对不上）',
        !!usedManifest && !!usedFile && usedManifest.which === usedFile.which,
        `清单用=${usedManifest?.which} 文件用=${usedFile?.which}（全部尝试：清单=${manifestHits.map((h) => h.which)} 文件=${fileHits.map((h) => h.which)}）`)
      ok('第一顺位是 raw.githubusercontent（直连 GitHub，永远新鲜）',
        manifestHits[0]?.which === 'raw', `第一次尝试=${manifestHits[0]?.which}（首选源）`)
      ok('报告里记了用的哪个源（排查时能一眼看出）', typeof dl7.json?.source === 'string' && dl7.json.source.length > 0, String(dl7.json?.source))
      h7.server.close()
    }

    /* ══ ⑧ 首选源挂了 → 退到下一个源，且仍然同源 ═══════════ */
    console.log('')
    console.log('8 首选源挂了：退到备胎，退过去之后仍然同源')
    {
      const hits2 = []
      globalThis.fetch = async (url) => {
        const u = String(url)
        const which = u.includes('raw.githubusercontent.com') ? 'raw'
          : u.includes('cdn.jsdelivr.net') ? 'cdn'
            : u.includes('api.github.com') ? 'api' : 'other'
        hits2.push({ which, url: u })
        // 首选源（raw）一律挂掉 —— 模拟它在国内不通
        if (which === 'raw') return { ok: false, status: 503, text: async () => '' }
        if (u.includes('release-manifest.json')) {
          return { ok: true, text: async () => JSON.stringify(manifest) }
        }
        if (u.includes(probeName)) {
          return { ok: true, arrayBuffer: async () => Buffer.from(after, 'utf8') }
        }
        return { ok: false, text: async () => '' }
      }
      const h8 = await bootHost(cfg)
      const dl8 = await post(h8.baseUrl, '/dsh-skin/update-download', { method: 'download' })
      ok('首选源挂了也能下成功', dl8.json?.ok === true, JSON.stringify(dl8.json))
      const m8 = hits2.filter((h) => h.url.includes('release-manifest.json'))
      const f8 = hits2.filter((h) => h.url.includes(probeName))
      // ⚠️ 取**最后一次**命中 = 真正用上的那个源（源码是「前一个失败才试下一个」）
      const usedM8 = m8[m8.length - 1]
      const usedF8 = f8[f8.length - 1]
      ok('★ 退到备胎后，清单和文件仍然同源',
        !!usedM8 && !!usedF8 && usedM8.which === usedF8.which,
        `清单用=${usedM8?.which} 文件用=${usedF8?.which}（尝试过：清单=${m8.map((h) => h.which)} 文件=${f8.map((h) => h.which)}）`)
      ok('用的不再是首选源', usedM8?.which !== 'raw', `实际用上=${usedM8?.which}`)
      ok('首选源确实先被试过（不是直接跳过 raw）', m8[0]?.which === 'raw', `第一次=${m8[0]?.which}`)
      h8.server.close()
    }

    /* ══ ⑨ CDN 给的是旧内容时 → 必须报 hash-mismatch，不能悄悄放过 ══
     *
     * 【这一条是反着的判据】验证"核对哈希这道防线还在"：
     *   万一将来某个源开始返回旧内容，**绝不能**让它悄悄通过。
     */
    console.log('')
    console.log('9 源返回旧内容：哈希核对必须拦下来（不能悄悄放过）')
    {
      globalThis.fetch = async (url) => {
        const u = String(url)
        if (u.includes('release-manifest.json')) {
          return { ok: true, text: async () => JSON.stringify(manifest) }
        }
        if (u.includes(probeName)) {
          // 故意给**旧内容**（哈希跟清单对不上）
          return { ok: true, arrayBuffer: async () => Buffer.from('STALE CONTENT', 'utf8') }
        }
        return { ok: false, text: async () => '' }
      }
      const h9 = await bootHost(cfg)
      /**
       * ⚠️ 要跟**这一段开始前**的内容比，不是跟最初的 OLD 比。
       *    第 4 段已经成功替换过一次了 ⇒ 此刻装的是 NEW，不是 OLD。
       *    （拿固定的 OLD 去比 → 判据误报"现装的那份被改了"，其实代码完全正确。）
       */
      const beforeApply9 = fs.readFileSync(probePath, 'utf8')
      const dl9 = await post(h9.baseUrl, '/dsh-skin/update-download', { method: 'download' })
      ok('旧内容被哈希核对拦下（hash-mismatch）',
        dl9.json?.ok === false && dl9.json?.reason === 'hash-mismatch', JSON.stringify(dl9.json))
      ok('★ 现装的那份没被这一段碰过（下载失败不写任何东西）',
        fs.readFileSync(probePath, 'utf8') === beforeApply9,
        `这段之前是「${beforeApply9}」，现在是「${fs.readFileSync(probePath, 'utf8')}」`)
      h9.server.close()
    }

    globalThis.fetch = realFetch
    server.close()
  } finally {
    globalThis.fetch = realFetch
    backupProbe()
    fs.rmSync(tmp, { recursive: true, force: true })
  }

  console.log('')
  console.log(`== 结果: ${pass} 项通过, ${fail} 项失败 ==`)
  process.exitCode = fail === 0 ? 0 : 1
  setImmediate(() => setTimeout(() => process.exit(process.exitCode), 50))
})().catch((error) => {
  console.error('跑挂了:', error)
  process.exit(1)
})
