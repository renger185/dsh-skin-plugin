/**
 * 换肤插件 · 完整验证
 *
 * 目的:用boss的真实数据(1387 张图的图库 + 真实设置),
 *      走一遍客户端真实会走的路径:加载 → 装配 → 异步初始化 → 生成主题 token。
 *      任何一步抛错,都会让桌面版起不来,所以每一步都必须过。
 *
 * 测的是「安装档」本身(桌面版真正加载的那个文件),不是工作区副本。
 *
 * 用法:node verify/full_verify.cjs [安装档路径] [指定某张图当底图]
 *   第二参可以喂一个图库里的 id —— 想验**另一个字色档**(亮图/暗图)时用,
 *   比如 node verify/full_verify.cjs "" <某张亮图的id>
 */
const fs = require('fs')
const path = require('path')

const WORK = path.join(__dirname, '..')
/**
 * 被测文件默认就指**仓库/工作区里的 plugin/client.js**（不是装到系统里那一份）——
 * 这样外面的人 clone 下来直接就能跑；想测「真正装进桌面端的那份」，把安装位路径当第一个参数传进来。
 */
const CLIENT_FILE = process.argv[2] || path.join(WORK, 'plugin', 'client.js')

const src = fs.readFileSync(CLIENT_FILE, 'utf8')

/**
 * 【10-19 21:5x 让它对外也能跑】state.json / library.json 是**私人数据**（不在仓库里）。
 * 有就用真数据；没有就用一份最小样例（一张暗图、默认设置），并在开头写明用的是样例。
 */
const usingSample = !fs.existsSync(path.join(WORK, 'state.json')) || !fs.existsSync(path.join(WORK, 'library.json'))
const SAMPLE_STATE = { activeId: 'sample-dark', wash: null, text: 'follow', mode: 'normal', rotateMinutes: 0, popupAlpha: 0.95, ballX: null, ballY: null, bleed: 64, soundOn: false, soundVolume: 0.5, soundId: '', lang: 'zh', onboarded: true }
const SAMPLE_LIB = [
  { id: 'sample-dark', name: '样例·暗图', w: 1920, h: 1080, portrait: false, fillMode: 'cover', avgLum: 30, brightness: 0.12, dominantHex: '#0a2c38', kind: 'dark', autoMask: 12, mask: null, chatP5: 0, chatP95: 0.68, darkShare: 0.89, lightShare: 0.03, midShare: 0.08, midLum: 0.49 },
  { id: 'sample-light', name: '样例·亮图', w: 1920, h: 1080, portrait: false, fillMode: 'cover', avgLum: 182, brightness: 0.71, dominantHex: '#e8e2d8', kind: 'light', autoMask: 6, mask: null, chatP5: 0.42, chatP95: 0.95, darkShare: 0.02, lightShare: 0.79, midShare: 0.19, midLum: 0.72 },
]
const realState = usingSample ? SAMPLE_STATE : JSON.parse(fs.readFileSync(path.join(WORK, 'state.json'), 'utf8'))
const realLib = usingSample ? SAMPLE_LIB : JSON.parse(fs.readFileSync(path.join(WORK, 'library.json'), 'utf8'))

// 挑一张确实存在的图当当前背景(免得 entry 为空测不到 token 生成)
const fixture = { ...realState }
if (process.argv[3] && realLib.some((e) => e.id === process.argv[3])) fixture.activeId = process.argv[3]
if (!realLib.some((e) => e.id === fixture.activeId)) {
  fixture.activeId = realLib[0].id
}

const problems = []
process.on('uncaughtException', (e) => problems.push('uncaughtException: ' + e.message))
process.on('unhandledRejection', (e) => problems.push('unhandledRejection: ' + (e && e.message)))

// ── React 桩 ──
const react = {
  createElement: (type, props, ...kids) => ({ type, props, kids }),
  useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
  useEffect: () => {},
  useRef: (v) => ({ current: v === undefined ? null : v }),
}

// ── DOM 桩 ──
function mkEl(tag) {
  return {
    tagName: tag, style: {}, className: '', dataset: {}, children: [],
    classList: { add() {}, remove() {}, contains: () => false },
    setAttribute() {}, removeAttribute() {}, getAttribute: () => null,
    appendChild(c) { this.children.push(c); return c },
    removeChild(c) { this.children = this.children.filter((x) => x !== c) },
    remove() {}, addEventListener() {}, removeEventListener() {},
    querySelector: () => null, querySelectorAll: () => [],
    getBoundingClientRect: () => ({ left: 100, top: 100, right: 156, bottom: 156, width: 56, height: 56 }),
    getContext: () => null, focus() {}, click() {}, contains: () => false, insertBefore() {},
  }
}
global.document = {
  baseURI: 'http://127.0.0.1:60281/',
  createElement: mkEl,
  querySelector: () => null,
  querySelectorAll: () => [],
  addEventListener() {}, removeEventListener() {},
  documentElement: mkEl('html'), head: mkEl('head'), body: mkEl('body'),
  readyState: 'complete',
}
global.window = {
  innerWidth: 1920, innerHeight: 1080,
  addEventListener() {}, removeEventListener() {},
  matchMedia: () => ({ matches: false, addEventListener() {} }),
}
global.getComputedStyle = () => ({ getPropertyValue: () => '', backgroundImage: 'none' })
global.IntersectionObserver = class { observe() {} disconnect() {} unobserve() {} }
global.performance = { now: () => Date.now() }
global.navigator = { clipboard: {}, userAgent: 'verify' }
global.location = { href: 'http://127.0.0.1:60281/' }
global.localStorage = { getItem: () => null, setItem() {}, removeItem() {} }
global.Image = class {}
global.FileReader = class {}
global.requestAnimationFrame = (f) => setTimeout(f, 16)
global.cancelAnimationFrame = clearTimeout
global.matchMedia = global.window.matchMedia

// ── 主机接口桩(返回boss的真实数据)──
let apiCalls = 0
global.fetch = (url) => {
  const u = String(url)
  apiCalls++
  let payload = {}
  if (u.includes('/dsh-skin/state')) payload = fixture
  else if (u.includes('/dsh-skin/library')) payload = { list: realLib }
  return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(payload) })
}

// ── 捕获 overrideTokens ──
let captured = null
let overrideCalls = 0

// ── 真实主题 token（按 DSH 浅色主题取值）──
/**
 * 【10-19 09:5x 把桩改成「跟真机一样」】上一版这里塞了 11 枚浅色值，
 * 于是 mock 的 rawToken('light', ...) 能取到东西 —— 而真机上桌面端内置主题
 * 的 token 表是空的（BUILTIN_THEMES.tokens = {}），插件 rawToken() 永远取不到、
 * 只能走兜底色。桩比真机「更丰富」，就会把「白字档退回浅色值」这类错盖住，
 * 测出一个假的绿。现在桩照真机来：里面什么都没有。
 */
const LIGHT_TOKENS = {}

const slots = []
const ctx = {
  effect: (fn) => { try { const d = fn(); return typeof d === 'function' ? d : () => {} } catch { return () => {} } },
  on: () => {}, once: () => {},
  logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
  slots: {
    inject: (name, fn) => fn(),
    register: (opts) => { slots.push(opts.name + '#' + opts.id); return () => {} },
    getVersion: () => 0, entries: () => [], subscribe: () => () => {},
  },
  theme: {
    getTheme: () => ({ active: { colorScheme: 'light', tokens: LIGHT_TOKENS }, themes: [] }),
    overrideTokens: (source, tokens) => { overrideCalls++; captured = tokens; return () => {} },
  },
  locale: { register: () => {}, getLocale: () => ({ id: 'zh-CN' }) },
}

console.log('被测文件 :', CLIENT_FILE)
console.log('文件大小 :', src.length, '字节')
console.log('数据来源 :', usingSample ? '内置样例（没找到 state.json / library.json —— 正常，仓库里不带私人数据）' : '本机真实设置 + 图库')
console.log('图库张数 :', realLib.length)
console.log('当前底图 :', fixture.activeId)
console.log('')

// ═══ ① 加载 ═══
const registry = {}
global.window.__ModuleLoader__ = {
  load(entry) {
    registry[entry.id] = entry.factory((id) => {
      if (id === 'react') return react
      throw new Error('unknown module: ' + id)
    })
  },
}
try {
  new Function(src)()
  console.log('① 加载插件            ✓')
} catch (e) {
  console.log('① 加载插件            ✗ ' + e.constructor.name + ': ' + e.message)
  process.exit(1)
}

const plugin = registry['@local/dsh-skin']
if (!plugin || typeof plugin.apply !== 'function') {
  console.log('   返回的不是可挂载插件 ✗')
  process.exit(1)
}
console.log('   返回插件对象        ✓  inject=' + JSON.stringify(plugin.inject))

// ═══ ② 装配 ═══
try {
  plugin.apply(ctx)
  console.log('② 装配 apply(ctx)     ✓')
  console.log('   注册的界面入口      ' + JSON.stringify(slots))
} catch (e) {
  console.log('② 装配 apply(ctx)     ✗ ' + e.constructor.name + ': ' + e.message)
  process.exit(1)
}

// ═══ ③ 异步初始化 + token 生成 ═══
setTimeout(() => {
  console.log('③ 异步初始化          ' + (problems.length === 0 ? '✓' : '✗ 有异常'))
  console.log('   调用主机接口        ' + apiCalls + ' 次')
  console.log('   写入主题 token      ' + overrideCalls + ' 次')
  console.log('')

  if (captured) {
    const names = Object.keys(captured)
    console.log('④ 生成的主题 token    ' + names.length + ' 项')
    const want = [
      '--dsw-specific-menu',
      '--dsw-alias-bg-overlay',
      '--dsw-alias-interactive-bg-hover',
      '--dsw-alias-bg-module-platform',
      '--dsw-alias-markdown-code-block',
    ]
    const missing = want.filter((w) => !names.includes(w))
    console.log('   本轮新加的 5 枚底色 ' + (missing.length === 0 ? '✓ 全在' : '✗ 缺 ' + JSON.stringify(missing)))
    console.log('   菜单底色(下拉别太透)  ' + JSON.stringify(captured['--dsw-specific-menu']))
    console.log('   选中行底色(状态栏看不见) ' + JSON.stringify(captured['--dsw-alias-interactive-bg-hover']))
    const t = captured['--dsw-alias-label-tertiary']
    console.log('   三级文字色(图标/进行中) ' + (t ? JSON.stringify(t) : '(未触发保底:对比度够)'))
    /**
     * 【10-19 08:51 加这一段】boss三次报「系统图标看不见」,每次都得手算才知道
     * 图标色到底是多少。直接打出来 + 算对比度 —— 白图标压白底这种错,
     * 以后在这一步就会被拦下,不会再等到boss重启才发现。
     */
    const icon = captured['--dsw-alias-menu-icon']
    const iconV = icon ? String(icon.light || '') : ''
    console.log('   菜单图标色           ' + (icon ? JSON.stringify(icon) : '(没设)'))
    const lumOf = (c) => {
      const s = String(c)
      let r, g, b
      const rgba = s.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i)
      if (rgba) {
        r = Number(rgba[1]); g = Number(rgba[2]); b = Number(rgba[3])
      } else {
        const hex = s.match(/#([0-9a-f]{6})/i)
        if (!hex) return null
        r = parseInt(hex[1].slice(0, 2), 16)
        g = parseInt(hex[1].slice(2, 4), 16)
        b = parseInt(hex[1].slice(4, 6), 16)
      }
      const f = (v) => { const x = v / 255; return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4) }
      return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b)
    }
    const li = lumOf(iconV)
    const lm = lumOf(String((captured['--dsw-specific-menu'] || {}).light || ''))
    if (li !== null && lm !== null) {
      const cr = (Math.max(li, lm) + 0.05) / (Math.min(li, lm) + 0.05)
      console.log('   图标 vs 菜单底对比度 ' + cr.toFixed(2) + ':1  (门槛 3:1)')
      if (cr < 3) {
        problems.push(`菜单图标看不清:对比度只有 ${cr.toFixed(2)}:1(门槛 3)`)
      }
    }

    /**
     * ═══ 【10-19 09:5x 新加】boss报的「白底 + 看不见」两类，全部转成硬判据 ═══
     *
     * boss原话:「系统标识有白色底的，里面文字看不到。对话内容中有白色底色的
     * 有的看的到，有的看不到。」根因是这批**不透明实色底**一枚都没洗过。
     * 判据不手抄：两套值直接从 client.js 的 SOLID_FILLS 表里抠；
     * 「该用哪一档」按当前这张图自己算（跟 inkToneFor 同一套切块口径）。
     */
    const fx = realLib.find((x) => x.id === fixture.activeId) || {}
    const dShare = Number(fx.darkShare)
    const lShare = Number(fx.lightShare)
    const whiteInk = Number.isFinite(dShare) && Number.isFinite(lShare)
      ? dShare - lShare > 0.05 || (Math.abs(dShare - lShare) <= 0.05 && Number(fx.midLum) <= 0.5)
      : Number(fx.avgLum) < 100
    const fills = [...src.matchAll(/\{ name: '(--dsw-[^']+)', light: '(#[0-9a-f]{6})', dark: '(#[0-9a-f]{6})' \}/g)]
      .map((m) => ({ name: m[1], light: m[2], dark: m[3] }))
    const wantKey = whiteInk ? 'dark' : 'light'
    const wrong = []
    for (const f of fills) {
      const got = String((captured[f.name] || {}).light || '').toLowerCase()
      if (got !== f[wantKey]) wrong.push(`${f.name}: 应 ${f[wantKey]}，实际 ${got || '(没写进 token)'}`)
    }
    console.log('')
    console.log('   这张图判定           ' + (whiteInk ? '白字档（壁纸偏暗）' : '黑字档（壁纸偏亮）'))
    console.log('   实色底表             ' + fills.length + ' 枚，写对本档 ' + (fills.length - wrong.length) + ' 枚' + (wrong.length ? ' ✗' : ' ✓'))
    wrong.slice(0, 6).forEach((w) => console.log('      ✗ ' + w))
    if (wrong.length) problems.push(`实色底写错档:${wrong.length} 枚（例：${wrong[0]}）`)

    /**
     * 【10-19 13:2x】boss红框那张**交付文件卡片**走的是「组件局部变量 ← 静态色板」那条路，
     * 这四枚也必须跟着字色档翻，否则深色壁纸下卡片还是白的、字是白的。
     */
    const flips = [...src.matchAll(/\{ name: '(--dsw-static-neutral-[0-9]+)', onLight: '(#[0-9a-f]{6})', onDark: '(#[0-9a-f]{6})' \}/g)]
      .map((m) => ({ name: m[1], onLight: m[2], onDark: m[3] }))
    const flipWrong = []
    for (const f of flips) {
      const got = String((captured[f.name] || {}).light || '').toLowerCase()
      const want = whiteInk ? f.onDark : f.onLight
      if (got !== want) flipWrong.push(`${f.name}: 应 ${want}，实际 ${got || '(没写进 token)'}`)
    }
    console.log('   静态色板(卡片底)      ' + flips.length + ' 枚，写对本档 ' + (flips.length - flipWrong.length) + ' 枚' + (flipWrong.length ? ' ✗' : ' ✓'))
    flipWrong.slice(0, 4).forEach((w) => console.log('      ✗ ' + w))
    if (flipWrong.length) problems.push(`静态色板写错档:${flipWrong.length} 枚（例：${flipWrong[0]}）`)

    // 菜单那两枚底 + 图标：同一条极性
    const menuKeys = ['--dsw-menu-surface-fill', '--dsw-alias-menu-group-header-fill', '--dsw-specific-menu']
    const menuWrong = []
    for (const k of menuKeys) {
      const v = String((captured[k] || {}).light || '')
      const l = lumOf(v)
      if (l === null) { menuWrong.push(`${k}: 没写进 token`); continue }
      if (whiteInk ? l > 0.45 : l < 0.45) menuWrong.push(`${k}: ${v} 与「${whiteInk ? '白字档该用深底' : '黑字档该用浅底'}」相反`)
    }
    const wantIcon = whiteInk ? '#ffffff' : '#1a1c20'
    if (String(iconV).toLowerCase() !== wantIcon) menuWrong.push(`菜单图标色应为 ${wantIcon}，实际 ${iconV}`)
    console.log('   菜单底+图标极性       ' + (menuWrong.length ? '✗' : '✓') + (menuWrong.length ? ' ' + menuWrong.join('；') : ''))
    if (menuWrong.length) problems.push('菜单底与图标极性不一致:' + menuWrong[0])
  } else {
    console.log('④ 生成的主题 token    ⚠ 没捕获到')
  }

  console.log('')
  /**
   * 【23:20 补一条硬判据,防「静默失败」】
   * 23:08 boss报「选了图片直接没反应」,根因是 buildTokens 里有个
   * ReferenceError 被外层 try/catch 吞了 —— token 一次都没写进去,
   * 而这份报告当时还写着「全部无异常」,把我骗过去了。
   * 现在:只要有底图却一次 token 都没写,直接判失败,不许报绿。
   */
  const silent = fixture.activeId && overrideCalls === 0
  if (silent) {
    console.log('══ 结论:发现异常 ══')
    console.log('   ⚠ 有底图却一次 token 都没写 —— 换肤静默失败了!')
    console.log('   典型根因:buildTokens 内部抛异常被吞。')
    problems.push('换肤静默失败:overrideTokens 一次都没被调用')
  }

  if (problems.length === 0 && !silent) {
    console.log('══ 结论:加载、装配、异步初始化、出图 全部无异常 ══')
  } else if (problems.length) {
    console.log('══ 结论:发现异常 ══')
    problems.forEach((p) => console.log('   ' + p))
    process.exitCode = 1
  }
  /**
   * 【10-19 09:5x】显式退出。插件自己起了定时器(每秒问 bell 接口),
   * 不显式退的话这个进程会一直挂着、被外层的 timeout 杀掉 ——
   * 退出码就成了 null,「有没有过」只能靠肉眼看文字,当不了闸门。
   */
  process.exit(problems.length ? 1 : 0)
}, 1500)
