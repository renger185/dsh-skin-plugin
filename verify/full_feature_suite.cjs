/**
 * 换肤插件 · 全功能回归（2026-10-22）
 *
 * boss原话：「**这个做完之后，你对换肤插件的所有功能做一个测试，看是否还存在 bug**」
 *
 * 为什么还要再写一份（已经有一堆自检了）：
 *   现有自检大多在验「某个功能当初为什么那么改」，彼此之间**留了几块没人管的空地**：
 *     · 主机端接口的**边界与坏输入**（越权 id、坏 JSON、坏存档文件）
 *     · 图库**增删闭环**（真写文件 → 真读回来 → 真删掉，文件是不是也清了）
 *     · 设置**存了之后读回来还全不全**（字段被谁悄悄吞掉）
 *     · 自动换肤的**定时逻辑**（0 分钟该不该排期、图库只有 1 张该不该转）
 *     · 拖动球之后**不该误弹面板**
 *   这些恰好是最容易"平时看着没事、特定情况才炸"的地方。
 *
 * 跑法：node verify/full_feature_suite.cjs
 * 退出码：0 = 全过；1 = 有失败
 */
const fs = require('fs')
const path = require('path')
const os = require('os')
const http = require('http')

const ROOT = path.resolve(__dirname, '..')
const HOST = path.join(ROOT, 'plugin', 'index.js')
const SRC = fs.readFileSync(path.join(ROOT, 'plugin', 'index.js'), 'utf8')
const CLIENT = fs.readFileSync(path.join(ROOT, 'plugin', 'client.js'), 'utf8')

let pass = 0
let fail = 0
const ok = (name, good, extra = '') => {
  console.log((good ? '  ✓ ' : '  ✗ ') + name + (extra ? '  ' + extra : ''))
  good ? pass++ : fail++
}

/** 起真主机端（模拟 webServer 注入），返回可打的 baseUrl */
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

async function req(baseUrl, pathname, { method = 'GET', body = null, raw = null } = {}) {
  const init = { method }
  if (body !== null) { init.body = JSON.stringify(body); init.headers = { 'content-type': 'application/json' } }
  if (raw !== null) { init.body = raw; init.headers = { 'content-type': 'application/json' } }
  const res = await fetch(baseUrl + pathname, init)
  const text = await res.text()
  let json = null
  try { json = JSON.parse(text) } catch { json = null }
  return { status: res.status, json, text, headers: res.headers }
}

/** 任意 bytes 包成 data URL —— 主机端只做 base64 解码，不校验图片格式 */
const dataUrl = (text) => 'data:image/webp;base64,' + Buffer.from(text, 'utf8').toString('base64')

;(async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skin-full-'))
  const stateFile = path.join(tmpDir, 'state.json')
  const libraryFile = path.join(tmpDir, 'library.json')
  const imageDir = path.join(tmpDir, 'images')
  fs.mkdirSync(imageDir, { recursive: true })
  const cfg = { stateFile, libraryFile, imageDir }

  /* ══ 1. 图库增删闭环（真文件）══════════════════════════════ */
  console.log('1 图库：导入 → 读回 → 删除，文件也要跟着走')
  {
    const { server, baseUrl } = await bootHost(cfg)
    const added = await req(baseUrl, '/dsh-skin/library', {
      method: 'POST',
      // 真客户端发的是 `entry`（竖图属性装在 entry 里），不是顶层 portrait —— 测试照真接口口径来
      body: { method: 'add', id: 'pic-one', entry: { portrait: true, fillMode: 'native', name: 'one' }, image: dataUrl('fake-webp-bytes'), thumb: dataUrl('fake-thumb') },
    })
    ok('导入一张：接口 200', added.status === 200, `(${added.status})`)
    const list1 = (added.json?.list || []).map((x) => x.id)
    ok('导入后清单里出现它', list1.includes('pic-one'), JSON.stringify(list1))
    ok('原图文件真的落盘', fs.existsSync(path.join(imageDir, 'pic-one.webp')))
    ok('缩略图也落盘', fs.existsSync(path.join(imageDir, 'pic-one-thumb.webp')))
    ok('导入的竖图属性被记住', added.json?.list?.find((x) => x.id === 'pic-one')?.portrait === true)

    const served = await req(baseUrl, '/dsh-skin/image?id=pic-one')
    ok('按 id 能把原图取回来', served.status === 200 && served.text === 'fake-webp-bytes', `(${served.status})`)
    const servedThumb = await req(baseUrl, '/dsh-skin/image?id=pic-one&thumb=1')
    ok('缩略图也能取回来', servedThumb.status === 200 && servedThumb.text === 'fake-thumb')

    const removed = await req(baseUrl, '/dsh-skin/library', { method: 'POST', body: { method: 'remove', id: 'pic-one' } })
    ok('删除：接口 200', removed.status === 200)
    ok('删除后清单里没了', !(removed.json?.list || []).some((x) => x.id === 'pic-one'))
    ok('删除后原图文件也清了', !fs.existsSync(path.join(imageDir, 'pic-one.webp')))
    ok('删除后缩略图也清了', !fs.existsSync(path.join(imageDir, 'pic-one-thumb.webp')))
    const gone = await req(baseUrl, '/dsh-skin/image?id=pic-one')
    ok('删完再按 id 取 → 404（不是给个空文件）', gone.status === 404, `(${gone.status})`)
    server.close()
  }

  /* ══ 2. 主机端接口边界与坏输入 ═════════════════════════════ */
  console.log('')
  console.log('2 接口边界：越权 id / 未知名 / 坏 JSON / 坏存档，都不许崩')
  {
    const { server, baseUrl } = await bootHost(cfg)
    const traversal = await req(baseUrl, '/dsh-skin/image?id=' + encodeURIComponent('../../../etc/passwd'))
    ok('路径穿越 id 被挡（400）', traversal.status === 400, `(${traversal.status})`)
    const dotdot = await req(baseUrl, '/dsh-skin/image?id=..%2F..%2Fsecret')
    ok('编码过的穿越也被挡', dotdot.status === 400 || dotdot.status === 404, `(${dotdot.status})`)
    const unknown = await req(baseUrl, '/dsh-skin/no-such-endpoint')
    ok('没注册的接口 → 404（不是 500）', unknown.status === 404, `(${unknown.status})`)

    const badJson = await req(baseUrl, '/dsh-skin/state', { method: 'POST', raw: '{ this is not json' })
    ok('坏 JSON 请求体不崩（有明确状态码）', badJson.status >= 200 && badJson.status < 500, `(${badJson.status})`)
    const after = await req(baseUrl, '/dsh-skin/state')
    ok('坏请求之后接口还能用', after.status === 200 && typeof after.json === 'object')

    const badAdd = await req(baseUrl, '/dsh-skin/library', { method: 'POST', body: { method: 'add', id: '../evil', image: dataUrl('x') } })
    ok('非法图片 id 被拒（400）', badAdd.status === 400, `(${badAdd.status})`)
    ok('非法 id 没有在图片目录里造出文件', fs.readdirSync(imageDir).length === 0, fs.readdirSync(imageDir).join(','))
    server.close()
  }

  /* ══ 3. 设置存了之后读回来还全不全 ══════════════════════════ */
  console.log('')
  console.log('3 设置读写：存进去 → 读回来，字段一个都不许丢、坏值要归一')
  {
    const { server, baseUrl } = await bootHost(cfg)
    await req(baseUrl, '/dsh-skin/state', {
      method: 'POST',
      body: {
        method: 'set',
        patch: {
          activeId: 'pic-one',
          lastWallId: 'pic-two',
          wash: 999,            // 超上限 → 应夹到 40
          mode: '乱写',          // 非法 → normal
          text: 'zzz',           // 非法 → follow
          rotateMinutes: 999999, // 超上限 → 14400
          ballX: 123.7,
          ballY: -5,
          bleed: 999,            // 超上限 → 64
          soundOn: 'yes',        // 非 true → false
          soundVolume: 9,        // 超范围 → 1
          lang: 'fr',            // 只认 zh/en → zh
        },
      },
    })
    const got = (await req(baseUrl, '/dsh-skin/state')).json || {}
    ok('activeId 存住了', got.activeId === 'pic-one', got.activeId)
    ok('lastWallId 存住了（双击右键跨重启要用）', got.lastWallId === 'pic-two', got.lastWallId)
    ok('遮罩超上限被夹到 40', got.wash === 40, String(got.wash))
    ok('非法模式退回 normal', got.mode === 'normal', got.mode)
    ok('非法文字颜色退回 follow', got.text === 'follow', got.text)
    ok('轮换间隔被夹到上限 14400', got.rotateMinutes === 14400, String(got.rotateMinutes))
    ok('球位置取整', got.ballX === 124 && got.ballY === -5, `${got.ballX},${got.ballY}`)
    ok('模糊过渡夹到 64', got.bleed === 64, String(got.bleed))
    ok('提示音开关只认 true', got.soundOn === false, String(got.soundOn))
    ok('音量夹到 1', got.soundVolume === 1, String(got.soundVolume))
    ok('语言只认 zh/en', got.lang === 'zh', got.lang)
    ok('老存档没有的字段也补齐了（lastWallId 有默认空串）',
      typeof (await req(baseUrl, '/dsh-skin/state')).json?.lastWallId === 'string')
    server.close()
  }

  /* ══ 4. 存档坏了不能把插件带崩 ═════════════════════════════ */
  console.log('')
  console.log('4 坏存档：state.json / library.json 写坏，也要能起来')
  {
    const badDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skin-bad-'))
    const badState = path.join(badDir, 'state.json')
    const badLib = path.join(badDir, 'library.json')
    const badImg = path.join(badDir, 'images')
    fs.mkdirSync(badImg, { recursive: true })
    fs.writeFileSync(badState, '{ broken json', 'utf8')
    fs.writeFileSync(badLib, 'not-a-list', 'utf8')
    const { server, baseUrl } = await bootHost({ stateFile: badState, libraryFile: badLib, imageDir: badImg })
    const s = await req(baseUrl, '/dsh-skin/state')
    ok('坏 state.json 也能返回 200', s.status === 200, `(${s.status})`)
    ok('坏 state.json 退回默认值（不是 undefined）', s.json?.mode === 'normal' && s.json?.wash === null, JSON.stringify(s.json))
    const lib = await req(baseUrl, '/dsh-skin/library')
    ok('坏 library.json 也能返回 200', lib.status === 200)
    ok('坏 library.json 退回空清单', Array.isArray(lib.json?.list) && lib.json.list.length === 0)
    server.close()
    fs.rmSync(badDir, { recursive: true, force: true })
  }

  /* ══ 5. 自动换肤的定时逻辑（真跑纯函数）═══════════════════ */
  console.log('')
  console.log('5 自动换肤：抽图规则 + 该不该排期')
  {
    const fnSrc = (name) => {
      const at = CLIENT.indexOf('function ' + name)
      if (at < 0) return ''
      const braceAt = CLIENT.indexOf('{', at)
      let depth = 0
      for (let i = braceAt; i < CLIENT.length; i += 1) {
        if (CLIENT[i] === '{') depth += 1
        else if (CLIENT[i] === '}') {
          depth -= 1
          if (depth === 0) return CLIENT.slice(at, i + 1)
        }
      }
      return ''
    }
    const pickSrc = fnSrc('pickRandomImageId')
    ok('抠出抽图函数', !!pickSrc)
    if (pickSrc) {
      const runPick = (state, library) => {
        const fn = new Function('state', 'library', pickSrc + '\nreturn pickRandomImageId()')
        return fn(state, library)
      }
      ok('图库不足 2 张 → 不换（返回 null）', runPick({ activeId: '' }, [{ id: 'a' }]) === null)
      ok('图库空 → 不换', runPick({ activeId: '' }, []) === null)
      const only = runPick({ activeId: 'a' }, [{ id: 'a' }, { id: 'b' }])
      ok('有两张时只抽「不是当前这张」的那张', only === 'b', String(only))
      const cyc = runPick({ activeId: '' }, [{ id: 'a' }, { id: 'b' }])
      ok('当前没图时两张都可能被抽到', cyc === 'a' || cyc === 'b', String(cyc))
    }
    // 轮换间隔归一化：0 / 负数 / 测试残留(<1分钟) → 0；超上限 → 14400
    const normSrc = fnSrc('normalizeRotate')
    ok('抠出轮换间隔归一化', !!normSrc)
    if (normSrc) {
      const norm = new Function('ROTATE_MIN', 'ROTATE_MAX', normSrc + '\nreturn normalizeRotate')
      const f = norm(1, 14400)
      ok('0 分钟 = 关（返回 0）', f(0) === 0, String(f(0)))
      ok('负数归 0', f(-5) === 0)
      ok('测试残留的 0.02 分钟归 0（否则会不停换图）', f(0.02) === 0, String(f(0.02)))
      ok('正常值原样保留', f(5) === 5)
      ok('超上限夹到 14400', f(99999) === 14400)
    }
  }

  /* ══ 6. 拖动之后不许误弹面板 ═══════════════════════════════ */
  console.log('')
  console.log('6 悬浮球：拖完松手那一下不许当成点击（否则面板乱弹）')
  {
    const at = CLIENT.indexOf('const onBallClick = () => {')
    let clickSrc = ''
    {
      const braceAt = CLIENT.indexOf('{', at)
      let depth = 0
      for (let i = braceAt; i < CLIENT.length; i += 1) {
        if (CLIENT[i] === '{') depth += 1
        else if (CLIENT[i] === '}') {
          depth -= 1
          if (depth === 0) { clickSrc = CLIENT.slice(at, i + 1); break }
        }
      }
    }
    ok('抠出点击处理', !!clickSrc)
    if (clickSrc) {
      const build = (moved) => {
        const deps = {
          movedRef: { current: moved },
          clickCount: { current: 0 },
          clickTimer: { current: null },
          toggle: () => { deps._toggle = (deps._toggle || 0) + 1 },
          toggleAutoRotate: () => Promise.resolve(null),
          say: () => {},
          setStickerOpen: () => { deps._sticker = (deps._sticker || 0) + 1 },
          setTimeout: (fn) => { deps._pending = fn; return 1 },
          clearTimeout: () => {},
        }
        /**
         * ⚠️ `setTimeout` / `clearTimeout` 必须**当参数传进去**：
         *    `new Function` 的作用域里拿不到外面那份桩，不传就会用到 Node 的全局 setTimeout
         *    → 测到的是"真定时器"，我的 `_pending` 永远是 undefined
         *    → 第一版因此误判成「单击没挂起」（其实代码是对的）。
         */
        const fn = new Function(
          'movedRef', 'clickCount', 'clickTimer', 'toggle', 'toggleAutoRotate', 'say', 'setStickerOpen', 'setTimeout', 'clearTimeout',
          clickSrc + '\nreturn onBallClick',
        )(deps.movedRef, deps.clickCount, deps.clickTimer, deps.toggle, deps.toggleAutoRotate, deps.say, deps.setStickerOpen, deps.setTimeout, deps.clearTimeout)
        return { deps, fn }
      }
      const moved = build(true)
      moved.fn()
      ok('刚拖过球 → 这一下不算点击（不挂计时器）', moved.deps._pending === undefined && moved.deps.clickCount.current === 0)
      const normal = build(false)
      normal.fn()
      ok('没拖过球 → 单击照常挂起', normal.deps.clickCount.current === 1 && typeof normal.deps._pending === 'function')
    }
  }

  /* ══ 6b. 本轮全功能自检抓出来的两个真 bug（写成判据防退化）═══ */
  console.log('')
  console.log('6b 两个真 bug 的防退化判据')
  {
    /**
     * 真 bug ①：窗口变窄后球跑出屏幕。
     *   夹紧逻辑收到纯函数 `clampBallXY(x, y, vw, vh)` 里，这里真跑它。
     */
    const at = CLIENT.indexOf('function clampBallXY(x, y, vw, vh)')
    let clampSrc = ''
    if (at >= 0) {
      const braceAt = CLIENT.indexOf('{', at)
      let depth = 0
      for (let i = braceAt; i < CLIENT.length; i += 1) {
        if (CLIENT[i] === '{') depth += 1
        else if (CLIENT[i] === '}') {
          depth -= 1
          if (depth === 0) { clampSrc = CLIENT.slice(at, i + 1); break }
        }
      }
    }
    ok('抠出球位置夹紧函数', !!clampSrc)
    if (clampSrc) {
      const f = new Function(clampSrc + '\nreturn clampBallXY')()
      const c1 = f(1500, 500, 800, 600)
      ok('窗口变窄 → 横向夹回屏幕内', c1.x === 800 - 56, `实际 x=${c1.x}（应 ${800 - 56}）`)
      ok('纵向没越界就原样', c1.y === 500, `实际 y=${c1.y}`)
      const c2 = f(-30, -30, 800, 600)
      ok('负数被夹到 0（不许贴到屏幕外）', c2.x === 0 && c2.y === 0, `${c2.x},${c2.y}`)
      const c3 = f(NaN, undefined, 800, 600)
      ok('坏值（NaN/undefined）不会变成 NaN', c3.x === 0 && c3.y === 0, `${c3.x},${c3.y}`)
      const c4 = f(100, 100, 40, 40)
      ok('窗口比球还窄时也不出负数（回到 0）', c4.x === 0 && c4.y === 0, `${c4.x},${c4.y}`)
    }
    /**
     * ⚠️ 方向别写死：夹紧调用在监听器**上面**（先算再挂监听），
     *    第一版只往后找 200 字符，误判成"没接上"。
     */
    ok('窗口 resize 时会重新夹球的位置',
      /clampBallXY\([^\n]*\)[\s\S]{0,400}addEventListener\('resize', onResize\)/.test(CLIENT))
    ok('启动读档和 resize 用的是同一个函数（不各写一套）',
      (CLIENT.match(/clampBallXY\(/g) || []).length >= 2, `调用 ${(CLIENT.match(/clampBallXY\(/g) || []).length} 处`)

    /**
     * 真 bug ②：恢复默认时落盘漏了 lastWallId → 重启后"切回上次那张"切错。
     */
    const restoreAt = CLIENT.indexOf('async function restoreDefaults()')
    const saveAt = CLIENT.indexOf('await saveState(', restoreAt)
    const saveLine = saveAt >= 0 ? CLIENT.slice(saveAt, CLIENT.indexOf('\n', saveAt)) : ''
    ok('恢复默认的落盘里带着 lastWallId', /lastWallId/.test(saveLine), saveLine.trim())
  }

  /* ══ 7b. 更新检查（boss 10-22 08:0x 选 B）═════════════════ */
  console.log('')
  console.log('7b 更新检查：没配置 / 没网 / 同版本 / 有新版本 四种情况都要对')
  {
    // ① 没配置 updateRepo → 明确回 not-configured，页面什么都不显示
    const { server: s1, baseUrl: b1 } = await bootHost(cfg)
    const noCfg = await req(b1, '/dsh-skin/update-check')
    ok('没配置仓库 → 回 200 且标 not-configured',
      noCfg.status === 200 && noCfg.json?.ok === false && noCfg.json?.reason === 'not-configured',
      JSON.stringify(noCfg.json))
    s1.close()

    // 版本比较是纯函数，直接抠出来真跑
    const at = SRC.indexOf('function isNewerVersion(latest, current)')
    let newerSrc = ''
    if (at >= 0) {
      const braceAt = SRC.indexOf('{', at)
      let depth = 0
      for (let i = braceAt; i < SRC.length; i += 1) {
        if (SRC[i] === '{') depth += 1
        else if (SRC[i] === '}') {
          depth -= 1
          if (depth === 0) { newerSrc = SRC.slice(at, i + 1); break }
        }
      }
    }
    ok('抠出版本比较函数', !!newerSrc)
    if (newerSrc) {
      const isNewer = new Function(newerSrc + '\nreturn isNewerVersion')()
      ok('远端 1.9.0 > 本地 1.8.6 → 有新版本', isNewer('1.9.0', '1.8.6') === true)
      ok('远端 1.8.7 > 本地 1.8.6 → 有新版本', isNewer('1.8.7', '1.8.6') === true)
      ok('同版本 → 不算新', isNewer('1.8.6', '1.8.6') === false)
      ok('远端更旧 → 不算新', isNewer('1.6.0', '1.8.6') === false)
      ok('段数不同也不误判（1.10.0 > 1.9.9）', isNewer('1.10.0', '1.9.9') === true)
      ok('带 v 前缀 / 预发布后缀都能比', isNewer('v2.0.0-rc.1', '1.8.6') === true)
      ok('空值不炸', isNewer('', '1.8.6') === false && isNewer('1.8.6', '') === true)
    }

    /**
     * ② 配了仓库 + 假远端：用 stub 顶掉全局 fetch。
     *   ⚠️ 必须换 `globalThis.fetch` —— 主机端是**运行时**调全局 fetch 的，
     *      传参进不去（这个坑本轮又踩了一次）。
     */
    const realFetch = globalThis.fetch
    const cfgWithRepo = { ...cfg, updateRepo: 'someone/dsh-skin', updateBranch: 'main' }
    /**
     * ⚠️ 这里有个必须踩一次才记得的坑：把 `globalThis.fetch` 换成假远端之后，
     *    **我自己打本机接口的那次请求也会被假掉**（拿到的是假远端的 JSON），
     *    判据就会红得莫名其妙。所以：**打接口用真 fetch（realFetch），
     *    插件内部访问远端才走假 fetch。**
     */
    const runWith = async (stub) => {
      globalThis.fetch = stub
      const { server, baseUrl } = await bootHost(cfgWithRepo)
      try {
        const res = await realFetch(baseUrl + '/dsh-skin/update-check')
        const text = await res.text()
        let json = null
        try { json = JSON.parse(text) } catch { json = null }
        return { status: res.status, json, text }
      } finally {
        globalThis.fetch = realFetch
        server.close()
      }
    }

    let calls = 0
    const newer = await runWith(async () => {
      calls += 1
      return { ok: true, text: async () => JSON.stringify({ version: '9.9.9' }) }
    })
    ok('远端更新 → outdated=true', newer.json?.ok === true && newer.json?.outdated === true, JSON.stringify(newer.json))
    ok('报出最新版本号', newer.json?.latest === '9.9.9', String(newer.json?.latest))
    ok('带上仓库页地址（点击去更新）', /github\.com\/someone\/dsh-skin/.test(newer.json?.pageUrl || ''), newer.json?.pageUrl)
    ok('第一次会去请求远端', calls >= 1, `请求 ${calls} 次`)

    const same = await runWith(async () => ({ ok: true, text: async () => JSON.stringify({ version: '1.8.6' }) }))
    ok('远端同版本 → outdated=false（不提示）', same.json?.ok === true && same.json?.outdated === false, JSON.stringify(same.json))

    let failedCalls = 0
    const broken = await runWith(async () => {
      failedCalls += 1
      throw new Error('没网')
    })
    ok('两个源都失败 → ok:false 且不崩', broken.status === 200 && broken.json?.ok === false, JSON.stringify(broken.json))
    ok('失败时两个源都试过（不是试一个就放弃）', failedCalls >= 2, `试了 ${failedCalls} 次`)

    // ③ 页面这一侧：只有"确实有新版本"才显示，查不到不许挂红字
    ok('面板里有更新提示组件', /function UpdateNotice\(\)/.test(CLIENT))
    ok('提示挂在面板（恢复默认上面），不是等在别处', /h\(UpdateNotice\)/.test(CLIENT))
    ok('只有 outdated 才显示', /info\.outdated !== true \|\| !info\.latest\) return null/.test(CLIENT))
    ok('没配/没网时不显示（ok 必须为 true）', /info\.ok !== true/.test(CLIENT))
    ok('点提示会打开仓库页', /window\.open\(url, '_blank'\)/.test(CLIENT))
    ok('中英文案都在', /updateAvailable: '有新版本'/.test(CLIENT) && /updateAvailable: 'Update available'/.test(CLIENT))
    ok('6 小时内不重复去问（防限流）', /6 \* 60 \* 60 \* 1000/.test(CLIENT) && /UPDATE_CACHE_MS/.test(SRC))

    // ④ 新窗口：一页两段 + 关闭方式三个 + 数字纪律
    ok('有新窗口组件', /function UpdateWindow\(/.test(CLIENT))
    ok('新窗口是独立浮层（不是浏览器新标签页）', /position: 'fixed'[\s\S]{0,200}translate\(-50%, -50%\)/.test(CLIENT))
    ok('新窗口底色跟着换肤模式走（用 T.surface）', /background: T\.surface/.test(CLIENT))
    ok('一段是「插件升级」、一段是「我的项目」',
      /dict\.updateSection/.test(CLIENT) && /dict\.projectsSection/.test(CLIENT))
    ok('两段之间有分隔线（不能糊成一坨）', /borderTop: `1px solid \$\{T\.border\}`/.test(CLIENT))
    ok('关闭方式三个：×、Esc、点外面',
      /onClick: onClose/.test(CLIENT) && /event\.key === 'Escape'/.test(CLIENT) && /node\.contains\(event\.target\)/.test(CLIENT))
    ok('点「检查更新」不直接更新，只查版本（没有下载动作）', !/package\.tarball|\.download|installUpdate/.test(CLIENT))
    ok('「去仓库页」是打开网页（装不装由人决定）', /window\.open\(String\(info\.pageUrl\)/.test(CLIENT))
    // 数字纪律：Star / Fork / 最近提交，取不到就不显示
    ok('Star 取不到就不显示', /typeof item\.stars === 'number' \?/.test(CLIENT))
    ok('Fork 取不到就不显示', /typeof item\.forks === 'number' \?/.test(CLIENT))
    ok('最近提交取不到就不显示', /item\.pushedAt \?/.test(CLIENT))
    ok('没有占位数字（不许用 0 假装有）', !/★ 0|Fork 0/.test(CLIENT))
    ok('时间是人话不是原始时间戳', /function formatWhen\(ms\)/.test(CLIENT) && /小时前/.test(CLIENT))

    // ⑤ 主机端 projects 接口：读不到 GitHub 时不该崩，也不该编数字
    ok('有 projects 接口', /kind: 'exact', path: PROJECTS_PATH/.test(SRC))
    ok('pushed_at 是字符串，要转时间戳（第一版直接 Number() → 永远是 0）',
      /toMs = \(value\)|function toMs\(value\)/.test(SRC) && /Date\.parse/.test(SRC))
    ok('项目清单走配置，不写死品牌名', /config\?\.updateProjects/.test(SRC))

    /**
     * ⑥ 界面文案不许带 Markdown 记号。
     * ⚠️ 2026-10-22：写更新提示时顺手在文案里打了 `**加粗**`，
     *    结果**插件不渲染 Markdown** → 界面上原样显示两个星号。
     *    （这是真机上才看得出来的，静态判据原来一条都没查。）
     *
     * ⚠️ 查法踩过两次坑：
     *   ① 「从 const DICTS 往后 14 万字符」再找带 `**` 的引号串 → 会把**注释和代码**
     *      一起扫进来（注释里满是 `**` 和中文引号），匹配出一堆无关的；
     *   ② 只看「整行就是一个字符串字面量」→ **抓不到**，因为真代码长这样：
     *      `updateFailed: '没成功 **试试**',`（前面还有键名）。
     *    正确做法：**先把注释整段剔掉，再找字符串字面量里的 `**`**。
     */
    const codeOnly = CLIENT
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/\/\/.*$/gm, ' ')
    const mdOffenders = codeOnly.match(/'[^'\n]*\*\*[^'\n]*'/g) || []
    ok('界面文案里没有 Markdown 星号（会原样显示出来）', mdOffenders.length === 0, mdOffenders.slice(0, 3).join(' '))

    /**
     * ⑦ 面板美化（2026-10-22 16:4x boss要求）
     *   「对悬浮窗展开的选项做一个相关的界面美化，并且自检通过。**要求不伤现在的核心功能。**」
     *
     * 「不伤功能」这件事由**全量回归**证明；这里管的是「美化别被改回去」：
     *   ① 共用样式层在（面板长什么样由一处决定，不是一堆手写内联样式）
     *   ② 各段用了统一的标题/分隔线/说明样式
     *   ③ ⚠️ **美化的代码不许碰功能代码** ——
     *      下面这几条判据专门盯「onClick 还在不在」「控件还在不在」。
     */
    ok('有共用的样式层 PANEL_UI', /const PANEL_UI = \{/.test(CLIENT))
    ok('段标题是统一的助手（panelTitle）', /function panelTitle\(text\)/.test(CLIENT))
    ok('说明小字是统一的助手（panelHint）', /function panelHint\(text\)/.test(CLIENT))
    ok('各段都用了统一的分隔样式', (CLIENT.match(/PANEL_UI\.sectionGap/g) || []).length >= 6,
      `用了 ${(CLIENT.match(/PANEL_UI\.sectionGap/g) || []).length} 处`)
    ok('分段控件是胶囊样式（带底槽）', /PANEL_UI\.segmentTrack/.test(CLIENT) && /PANEL_UI\.segmentItemOn/.test(CLIENT))
    // ⚠️ 核心功能一件都不能少
    ok('恢复默认按钮还在', /onClick: \(\) => restoreDefaults\(\)/.test(CLIENT))
    ok('检查更新按钮还在', /onClick: onOpenUpdate/.test(CLIENT))
    ok('三个模式还在（正常/专注/休闲）',
      /segment\(dict\.modeNormal/.test(CLIENT) && /segment\(dict\.modeFocus/.test(CLIENT) && /segment\(dict\.modeLeisure/.test(CLIENT))
    ok('明度滑杆还在（还带 onChange）',
      /type: 'range'[\s\S]{0,300}max: MAX_WASH/.test(CLIENT) && /onChange: \(event\) => void setWash/.test(CLIENT))
    /**
     * ⚠️ 这条原来是「换一张按钮还在」+ 盯 `pickRandomImageId`。
     *    10-22 20:1x boss把这个按钮改成**「下一张」**（按图库顺序走，不随机），
     *    所以判据要跟着改：盯的是「按钮还在 + 它现在走顺序」。
     *    （自动轮换那一路仍然是随机的，由下面另一条判据盯着。）
     */
    ok('「下一张」按钮还在', /onClick: \(\) => \{[\s\S]{0,120}pickNextImageId/.test(CLIENT))
    ok('自动换肤的档位还在', /ROTATE_PRESETS\.map/.test(CLIENT) && /setRotateMinutes\(minutes\)/.test(CLIENT))
    ok('竖图铺法还在（native/center/cover/blur/right）',
      /setFillMode\('native'\)/.test(CLIENT) && /setFillMode\('right'\)/.test(CLIENT))
    ok('提示音开关与试听还在',
      /setSoundOn\(true\)/.test(CLIENT) && /onClick: \(\) => testChime\(\)/.test(CLIENT))
    ok('音量滑杆还在', /setSoundVolume\(Number\(event\.target\.value\) \/ 100\)/.test(CLIENT))
    ok('语言切换还在', /void setLang\('zh'\)/.test(CLIENT) && /void setLang\('en'\)/.test(CLIENT))
    ok('图库还在（换图 + 更多）', /onPick: selectImage/.test(CLIENT) && /onClick: showMore/.test(CLIENT))
    ok('拖动面板还在（onMouseDown: startDrag）', /onMouseDown: startDrag/.test(CLIENT))
    ok('关面板还在', /onClick: \(\) => setOpen\(false\)/.test(CLIENT))

    /**
     * ⑧ 「检查更新」窗口的底色够不够实（10-22 19:1x boss报"透明度太低，底下的字看不清"）
     *
     * 根因：窗口原来直接用 `T.surface`（= `--dsw-alias-bg-overlay`），
     * 而那枚 token 的不透明度被**乘了 0.6**（`normalizePopupAlpha(state.popupAlpha) * 0.6`）——
     * 那是 10-18 为**下拉菜单**调的浓度。默认 0.95 → 实际只有 0.57，聊天区的字直接透上来。
     *
     * 修法：底色换成近乎不透明的实色 + 毛玻璃模糊。
     * ⚠️ 判据盯两件最容易退化的事：
     *   ① 底色**不透明度 ≥ 0.95**（不然又透回去了）
     *   ② **单层** background —— 多层简写在 Chromium 里会**整条解析失败**，
     *      结果连半透那层都没了（实测中心像素还是底下的深色，像没改一样）。
     */
    const winAt = CLIENT.indexOf("className: 'dsh-skin-update-window'")
    const winBlock = winAt >= 0 ? CLIENT.slice(winAt, winAt + 2400) : ''
    const winBg = (winBlock.match(/background:\s*'([^']+)'/) || [])[1] || ''
    const winAlpha = winBg.match(/rgba\([^)]*?,\s*([\d.]+)\s*\)/)
    ok('更新窗口底色是单层（多层简写会被浏览器整条作废）', /background:\s*'/.test(winBlock) && !/background:\s*\[/.test(winBlock), winBg.slice(0, 60))
    ok('更新窗口底色不透明度 ≥ 0.95（底下的字才压得住）',
      !!winAlpha && Number(winAlpha[1]) >= 0.95, winBg)
    ok('更新窗口有毛玻璃模糊（边缘看着还是通透的）', /backdropFilter: 'blur\(/.test(winBlock))

    /**
     * ⑨ 图库里的「下一张」（10-22 20:1x boss）
     *   boss原话：「把这里的『换一张』变成『下一张』，意思是按照当前的图片排列，
     *             变换成下一张的壁纸，**因为下面已经有了『自定义随机换一张』**。」
     *
     * 关键：**顺序**（按图库排列往后走一张，末尾回到第一张），**不是随机**。
     * 判据要盯住三件容易退化的事：
     *   ① 按钮文案是「下一张」；
     *   ② 按钮调的是 `pickNextImageId`（顺序那个），**不是** `pickRandomImageId`（随机那个）；
     *   ③ 顺序逻辑确实按 `library` 的下标 +1、且末尾循环。
     */
    ok('有「下一张」的文案', /pickNext: '下一张'/.test(CLIENT) && /pickNext: 'Next image'/.test(CLIENT))
    ok('有按顺序走的取图函数', /function pickNextImageId\(\)/.test(CLIENT))
    ok('下一张 = 当前下标 +1，末尾回到第一张（循环）',
      /library\[\(at \+ 1\) % library\.length\]/.test(CLIENT))
    ok('图库不足两张时不显示这个按钮', /library\.length > 1[\s\S]{0,400}pickNext/.test(CLIENT))
    ok('★ 这个按钮调的是「顺序」那个函数，不是随机的',
      /onClick: \(\) => \{[\s\S]{0,120}pickNextImageId\(\)/.test(CLIENT)
      && !/onClick: \(\) => \{[\s\S]{0,120}pickRandomImageId\(\)[\s\S]{0,400}dict\.pickNext/.test(CLIENT))
    ok('自动轮换仍然是随机的（那才是它的本意）', /const next = pickRandomImageId\(\)/.test(CLIENT))
    // 顺序逻辑真跑一遍
    const nextAt = CLIENT.indexOf('function pickNextImageId()')
    if (nextAt >= 0) {
      const braceAt = CLIENT.indexOf('{', nextAt)
      let depth = 0
      let end = -1
      for (let i = braceAt; i < CLIENT.length; i += 1) {
        if (CLIENT[i] === '{') depth += 1
        else if (CLIENT[i] === '}') {
          depth -= 1
          if (depth === 0) { end = i; break }
        }
      }
      const fnSrc = CLIENT.slice(nextAt, end + 1)
      const runNext = new Function('library', 'state', fnSrc + '\nreturn pickNextImageId()')
      const lib = [{ id: 'a' }, { id: 'b' }, { id: 'c' }]
      ok('当前是 a → 下一张是 b', runNext(lib, { activeId: 'a' }) === 'b')
      ok('当前是 c（最后一张）→ 回到 a（循环）', runNext(lib, { activeId: 'c' }) === 'a')
      ok('当前不在图库里 → 从第一张开始', runNext(lib, { activeId: 'zzz' }) === 'a')
      ok('只有一张图 → 不换', runNext([{ id: 'a' }], { activeId: 'a' }) === null)
    }
  }

  /* ══ 8. 提示音 / 音效接口在（回归一下别被上面的用例弄坏）═══ */
  console.log('')
  console.log('8 其它接口没被弄坏')
  {
    const { server, baseUrl } = await bootHost(cfg)
    const bell = await req(baseUrl, '/dsh-skin/bell')
    ok('提示音接口在', bell.status === 200 && typeof bell.json === 'object')
    const sounds = await req(baseUrl, '/dsh-skin/sounds')
    ok('音效列表接口在', sounds.status === 200)
    const diag = await req(baseUrl, '/dsh-skin/diag')
    ok('诊断接口在', diag.status === 200)
    server.close()
  }

  fs.rmSync(tmpDir, { recursive: true, force: true })
  console.log('')
  console.log(`== 结果: ${pass} 项通过, ${fail} 项失败 ==`)
  /**
   * 退出方式沿用项目踩过的坑：先设 exitCode，留一拍让 http 句柄自己收干净，
   * 再兜底强退 —— 直接 process.exit 会撞 UV_HANDLE_CLOSING 断言，把全绿显示成失败。
   */
  process.exitCode = fail === 0 ? 0 : 1
  setImmediate(() => setTimeout(() => process.exit(process.exitCode), 50))
})().catch((error) => {
  console.error('跑挂了:', error)
  process.exit(1)
})
