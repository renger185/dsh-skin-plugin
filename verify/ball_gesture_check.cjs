/**
 * 悬浮球「双击右键」自检（2026-10-22）
 *
 * boss原话：「**双击右键切换为自定义背景，或者是双击右键从自定义背景切换成系统的默认壁纸**」
 *
 * 这条判据必须**真跑**，理由是它有三件很容易写歪的事：
 *   ① 单击右键不能触发（boss要的是"双击"，单下不算数）；
 *   ② 两下必须在 260ms 窗口内才算一次双击；
 *   ③ 切默认时**只能撤壁纸**，不许把boss调好的模式/配色一起清掉
 *      （那是面板里「恢复默认界面」的活，不是这个手势的活）。
 *
 * 跑法：node verify/ball_gesture_check.cjs
 * 退出码：0 = 全过；1 = 有失败
 */
const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const SRC = fs.readFileSync(path.join(ROOT, 'plugin', 'client.js'), 'utf8')

let pass = 0
let fail = 0
const ok = (name, good, extra = '') => {
  console.log((good ? '  ✓ ' : '  ✗ ') + name + (extra ? '  ' + extra : ''))
  good ? pass++ : fail++
}

/** 从某处开始，按花括号配平抠出一个完整函数/箭头函数体 */
function grabBlock(startMarker) {
  const at = SRC.indexOf(startMarker)
  if (at < 0) return ''
  const braceAt = SRC.indexOf('{', at)
  if (braceAt < 0) return ''
  let depth = 0
  for (let i = braceAt; i < SRC.length; i += 1) {
    const ch = SRC[i]
    if (ch === '{') depth += 1
    else if (ch === '}') {
      depth -= 1
      if (depth === 0) return SRC.slice(at, i + 1)
    }
  }
  return ''
}

const rightSrc = grabBlock('const onBallRightClick = (event) =>')
const toggleSrc = grabBlock('async function toggleWallpaperDefault()')

if (!rightSrc || !toggleSrc) {
  ok('抠出右键处理与壁纸切换函数', false)
  console.log(`\n== 结果: ${pass} 项通过, ${fail} 项失败 ==`)
  process.exit(1)
}

;(async () => {
/* ── 1. 手势判定：单下不算，两下才算 ────────────────────── */
console.log('1 手势：单击右键不动作，260ms 内双击才切')
{
  let toggled = 0
  let prevented = 0
  const timers = []
  const sandbox = {
    movedRef: { current: false },
    rightTimer: { current: null },
    rightCount: { current: 0 },
    toggleWallpaperDefault: () => { toggled += 1; return Promise.resolve({ ok: true, text: 'x' }) },
    say: () => {},
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length },
    clearTimeout: (id) => { if (id) timers[id - 1] = null },
  }
  // eslint-disable-next-line no-new-func
  const onRight = new Function(
    'movedRef', 'rightTimer', 'rightCount', 'toggleWallpaperDefault', 'say', 'setTimeout', 'clearTimeout',
    rightSrc + '\nreturn onBallRightClick',
  )(sandbox.movedRef, sandbox.rightTimer, sandbox.rightCount, sandbox.toggleWallpaperDefault, sandbox.say, sandbox.setTimeout, sandbox.clearTimeout)

  const fakeEvent = { preventDefault: () => { prevented += 1 } }

  // 单下：不能触发
  onRight(fakeEvent)
  ok('单击右键不触发切换', toggled === 0, `(实际 ${toggled} 次)`)
  ok('右键会拦掉系统默认菜单', prevented === 1, `(preventDefault ${prevented} 次)`)

  // 第二下（窗口内）→ 触发
  onRight(fakeEvent)
  ok('260ms 内双击右键触发切换', toggled === 1, `(实际 ${toggled} 次)`)

  // 再来一组，中间把定时器跑掉（模拟"手慢"）：两下都会超时 → 不该触发
  toggled = 0
  const before = toggled
  sandbox.rightCount.current = 0
  onRight(fakeEvent)
  // 手慢：第一下的计时器到点清掉计数
  const t = timers.filter(Boolean).pop()
  if (t && typeof t.fn === 'function') t.fn()
  onRight(fakeEvent)
  ok('手慢（超过 260ms）当成两次单击 → 不切换', toggled === before, `(实际 ${toggled} 次)`)
}

/* ── 2. 切换本身：两个方向 + 只撤壁纸 ───────────────────── */
console.log('')
console.log('2 切换：自定义背景 ⇄ 系统默认壁纸（只撤壁纸，不动模式/配色）')
{
  const dict = {
    wallToDefault: '已切回系统默认壁纸',
    wallToCustom: '已切回自定义背景',
    wallNoImage: '图库是空的,先加一张图',
  }
  /**
   * 造一个沙箱跑真函数：
   *   state / library 由测试换，refreshBackground / saveState / selectImage 用桩；
   *   `normalizeRotate` / `scheduleRotate` 也补上 —— 【10-22 07:4x boss选 A】
   *   切回默认时会顺手暂停「自动换肤」，真函数里会调这两个。
   *   「上次那张」走 **`state.lastWallId`（落盘字段）**，所以
   *   「重启后还能切回去」这条可以直接用"换一个全新 runner + 带存档"来验。
   */
  function makeRunner(stateInit, libraryInit, lastWallId = '', rotateMinutes = 5) {
    const env = {
      state: { activeId: stateInit, lastWallId, mode: 'focus', text: 'auto', rotateMinutes },
      library: libraryInit,
      saved: [],
      selected: [],
      refreshed: 0,
      rescheduled: 0,
    }
    const runner = new Function(
      'env', 'dictFor',
      [
        'let state = env.state',
        'let library = env.library',
        'const refreshBackground = async () => { env.refreshed += 1 }',
        'const saveState = async (patch) => { env.saved.push(patch) }',
        'const selectImage = async (id) => { env.selected.push(id); state = { ...state, activeId: id } }',
        // 真代码里 normalizeRotate 会把 <1 分钟、负数、非数归 0
        'const normalizeRotate = (v) => { const n = Number(v); if (!Number.isFinite(n) || n <= 0) return 0; if (n < 1) return 0; return Math.min(14400, n) }',
        // 真代码里 scheduleRotate 会按当前设置重排定时器（这里是"有没有被重新排"的桩）
        'const scheduleRotate = () => { env.rescheduled += 1 }',
        toggleSrc,
        'return { toggleWallpaperDefault, snapshot: () => ({ state }) }',
      ].join('\n'),
    )(env, () => dict)
    return { env, runner }
  }

  // ① 有壁纸 → 切默认
  {
    const { env, runner } = makeRunner('img-A', [{ id: 'img-A' }, { id: 'img-B' }])
    const r = await runner.toggleWallpaperDefault()
    /**
     * 【10-22 07:4x boss选 A】自动换肤开着（rotateMinutes=5）时切默认，
     *   提示要明说"已暂停"，否则boss会以为设置被吃了。
     */
    ok('有壁纸时切到系统默认', r.ok === true && r.text === dict.wallToDefaultPaused, r.text)
    /**
     * ⚠️ 这里必须读 `runner.snapshot()`，**不能读 env.state**：
     *    函数里 `state = { ...state, activeId: '' }` 是给**闭包内那个变量**重新赋值，
     *    外面 `env.state` 还指着旧对象 → 会读到一个"没变化"的假象。
     *    第一版就是这么错判成"壁纸没撤"的（代码其实是对的）。
     */
    const after = runner.snapshot().state
    ok('壁上真的撤了（activeId 清空）', after.activeId === '', `(实际 ${JSON.stringify(after.activeId)})`)
    ok('撤壁纸不碰模式/配色', after.mode === 'focus' && after.text === 'auto', JSON.stringify(after))
    ok('切默认时自动换肤被暂停（boss选 A）', after.rotateMinutes === 0, `实际 ${after.rotateMinutes}`)
    ok('暂停要落盘（重启后别又自己换起来）', env.saved.some((p) => p.rotateMinutes === 0), JSON.stringify(env.saved))
    ok('要重排一次定时器（光改 state 不清定时器，到点照样换）', env.rescheduled >= 1, `重排 ${env.rescheduled} 次`)
    ok('切默认会把 activeId 落盘（重启后也是默认）', env.saved.some((p) => p.activeId === ''))
    ok('「上次那张」落盘了（lastWallId = img-A）',
      env.saved.some((p) => p.lastWallId === 'img-A') && after.lastWallId === 'img-A',
      `存档=${JSON.stringify(env.saved)}`)
  }

  // ①b 自动换肤本来就没开 → 提示不该说"已暂停"
  {
    const { runner } = makeRunner('img-A', [{ id: 'img-A' }], '', 0)
    const r = await runner.toggleWallpaperDefault()
    ok('自动换肤本来关着 → 提示普通版（不乱说"已暂停"）', r.text === dict.wallToDefault, r.text)
    ok('本来关着也不受影响', runner.snapshot().state.rotateMinutes === 0)
  }

  // ② 默认 → 切回上次那张
  {
    // 先用一个 runner 切到默认（把 img-A 记进 lastWallId）
    const { runner: r2 } = makeRunner('img-A', [{ id: 'img-A' }, { id: 'img-B' }])
    await r2.toggleWallpaperDefault()
    ok('（准备）lastWallId 记住 img-A', r2.snapshot().state.lastWallId === 'img-A', r2.snapshot().state.lastWallId)
    const r = await r2.toggleWallpaperDefault()
    ok('默认状态下再双击 → 切回上次那张', r.ok === true && r.text === dict.wallToCustom, r.text)
    ok('切回来用的就是记住的 img-A', r2.snapshot().state.activeId === 'img-A', r2.snapshot().state.activeId)

    /**
     * ★ 跨重启验证：换一个**全新的 runner**（模拟重启后重新载入），
     *   只把存档里的 lastWallId 带进去 → 必须还能切回 img-A。
     *   这一条就是"自定义快捷切换"能不能当真的分界线：
     *   不落盘的话这里会退化成图库第一张（img-B）。
     */
    const { runner: afterReboot } = makeRunner('', [{ id: 'img-B' }, { id: 'img-A' }], 'img-A')
    const rr = await afterReboot.toggleWallpaperDefault()
    ok('重启后仍能切回上次那张（不是退成图库第一张）',
      rr.ok === true && afterReboot.snapshot().state.activeId === 'img-A',
      `实际=${afterReboot.snapshot().state.activeId}（若=img-B 就是没落盘）`)
  }

  // ③ 记住的那张被删了 → 退图库第一张
  {
    const { runner } = makeRunner('', [{ id: 'img-C' }], 'img-GONE')
    const r = await runner.toggleWallpaperDefault()
    ok('记住的图没了就退图库第一张', r.ok === true && runner.snapshot().state.activeId === 'img-C', runner.snapshot().state.activeId)
  }

  // ④ 图库空 + 没记住 → 明确失败（不假装成功）
  {
    const { runner } = makeRunner('', [])
    const r = await runner.toggleWallpaperDefault()
    ok('图库空时明确说"加一张图"，不假装成功', r.ok === false && r.text === dict.wallNoImage, r.text)
  }
}

/* ── 3. 静态判据：挂上了、中英文都写了 ─────────────────── */
console.log('')
console.log('3 静态：右键挂上了、菜单不弹了、中英文提示都有')
ok('球上挂了 onContextMenu', /onContextMenu: onBallRightClick/.test(SRC))
ok('右键会拦掉系统默认菜单', /event\.preventDefault\(\)/.test(rightSrc))
ok('右键计数跟左键分开（不共用 clickCount）', !/clickCount/.test(rightSrc))
ok('两下窗口是 260ms（跟左键一致）', /, 260\)/.test(rightSrc))
ok('清理时把右键计时器也清了', /rightTimer\.current\) clearTimeout\(rightTimer\.current\)/.test(SRC))
ok('中文提示齐了', /wallToDefault: '已切回系统默认壁纸'/.test(SRC) && /wallToCustom: '已切回自定义背景'/.test(SRC))
ok('英文提示齐了', /wallToDefault: 'Back to the default wallpaper'/.test(SRC) && /wallToCustom: 'Back to your own background'/.test(SRC))
ok('切默认不串到「恢复默认界面」(不调 restoreDefaults)', !/restoreDefaults\(\)/.test(toggleSrc))
/**
 * ⚠️ 2026-10-22 00:3x 抓到的真坑：`normalizeState()` 每次都会**整个换掉 state 对象**，
 *    第一版没把 `lastWallId` 放进它的返回值 → 只要中途走过一次规范化，
 *    这个字段就被抹掉，「切回上次那张」变成"有时灵有时不灵"。
 *    这条判据专门盯住"三个地方都得有这个字段"：默认值 / 规范化返回值 / 落盘归一化。
 */
ok('默认 state 里有 lastWallId', /onboarded: false, lastWallId: ''/.test(SRC))
ok('normalizeState 不会把它抹掉', /onboarded, lastWallId \}/.test(SRC))
ok('主机端落盘也归一化了它', /next\.lastWallId = typeof next\.lastWallId === 'string'/.test(fs.readFileSync(path.join(ROOT, 'plugin', 'index.js'), 'utf8')))

  console.log('')
  console.log(`== 结果: ${pass} 项通过, ${fail} 项失败 ==`)
  process.exit(fail === 0 ? 0 : 1)
})()
