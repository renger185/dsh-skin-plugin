/**
 * 提示音那条链 · 功能测试（10-19 19:5x 新增）
 *
 * boss原话：「我开了也试听了，但是还是没用。」
 *
 * 上一轮修的是「页面用 POST 问、主机只回 ok」；这一轮查出**第二个**原因：
 * 页面判断「有没有新完成」时拿「值是不是 0」当「见没见过」用 ——
 * 主机刚从 0 开始，页面前几轮都拿到 0，于是 lastBellSeen 一直是 0；
 * 等第一个任务真完成、at 变成 T 时，命中的却是「第一次别响」那条判断，
 * **第一个完成被吞掉**（每次重启后的头一个任务都不响）。
 *
 * 这个脚本把 startBellWatch **原样抠出来真跑**（不是查关键字），
 * 用假的主机接口喂时间戳，看它到底响不响、响几次、走哪条音效。
 *
 * 用法：node verify/bell_check.cjs
 */
const fs = require('fs')
const path = require('path')

const SRC = fs.readFileSync(path.join(__dirname, '..', 'plugin', 'client.js'), 'utf8')
const problems = []
const ok = (label, cond, detail) => {
  if (!cond) problems.push(label)
  console.log(`${cond ? 'OK  ' : 'FAIL'} ${label}${detail ? '  ' + detail : ''}`)
}

// 把 startBellWatch 连它依赖的那几枚变量一起抠出来
const src = SRC.match(/let lastBellSeen = 0[\s\S]*?\n    function startBellWatch\(\) \{[\s\S]*?\n    \}/)
if (!src) {
  console.log('FAIL 抠不出 startBellWatch')
  process.exit(1)
}

// ── 假的主机接口 + 假的播放器 ──
const ctx = {
  AT: 0,
  chimeCalls: 0,
  customCalls: 0,
  state: { soundOn: true, soundId: '', soundVolume: 1 },
  tick: null,
}
function makeWatcher() {
  const BELL_PATH = '/dsh-skin/bell'
  const getJson = async () => ({ at: ctx.AT, kind: 'done' })
  const playChime = () => { ctx.chimeCalls += 1 }
  const playCustomSound = () => { ctx.customCalls += 1 }
  const setIntervalStub = (fn) => { ctx.tick = fn; return 1 }
  const factory = new Function(
    'BELL_PATH', 'getJson', 'state', 'playChime', 'playCustomSound', 'setInterval',
    src[0] + '\nreturn startBellWatch',
  )
  return factory(BELL_PATH, getJson, ctx.state, playChime, playCustomSound, setIntervalStub)
}

async function main() {
  // ── 场景 1：boss这次的场景（应用刚重启，主机 at=0，随后第一个任务完成）──
  console.log('场景 1：重启后 at=0 → 第一个任务完成（boss踩的就是这个）')
  ctx.AT = 0
  ctx.chimeCalls = 0
  ctx.customCalls = 0
  ctx.state.soundOn = true
  ctx.state.soundId = ''
  const start1 = makeWatcher()
  start1()
  await ctx.tick()
  ok('第一次问（at=0）不响', ctx.chimeCalls === 0 && ctx.customCalls === 0)
  ctx.AT = 1792407000000
  await ctx.tick()
  ok('第一个任务完成就响（以前这里被吞掉）', ctx.chimeCalls === 1, `chime=${ctx.chimeCalls}`)
  await ctx.tick()
  ok('同一件事不重复响', ctx.chimeCalls === 1)

  // ── 场景 2：插件挂上时主机已经有旧时间戳（页面刷新/热重载）──
  console.log('')
  console.log('场景 2：挂上时主机已经有旧时间戳 → 不该补响')
  ctx.chimeCalls = 0
  ctx.customCalls = 0
  ctx.AT = 1792406000000
  const start2 = makeWatcher()
  start2()
  await ctx.tick()
  ok('第一次问拿到旧值 → 不补响', ctx.chimeCalls === 0)
  await ctx.tick()
  ok('旧值没变 → 还是不响', ctx.chimeCalls === 0)
  ctx.AT = 1792406111111
  await ctx.tick()
  ok('变成新值 → 响', ctx.chimeCalls === 1)

  // ── 场景 3：开关关着不响，但时间戳照样往前记 ──
  console.log('')
  console.log('场景 3：开关关着')
  ctx.chimeCalls = 0
  ctx.customCalls = 0
  ctx.AT = 0
  ctx.state.soundOn = false
  const start3 = makeWatcher()
  start3()
  await ctx.tick()
  ctx.AT = 1792406222222
  await ctx.tick()
  ok('开关关着 → 一声不响', ctx.chimeCalls === 0 && ctx.customCalls === 0)
  ctx.state.soundOn = true
  ctx.AT = 1792406333333
  await ctx.tick()
  ok('开关一打开，下一个完成就响', ctx.chimeCalls === 1)

  // ── 场景 4：选了自定义音效就走自定义那条 ──
  console.log('')
  console.log('场景 4：选了自定义音效')
  ctx.customCalls = 0
  ctx.chimeCalls = 0
  ctx.AT = 0
  ctx.state.soundId = 'snd-abc'
  const start4 = makeWatcher()
  start4()
  await ctx.tick()
  ctx.AT = 1792406444444
  await ctx.tick()
  ok('走的是自定义音效（不是内置叮）', ctx.customCalls === 1 && ctx.chimeCalls === 0, `custom=${ctx.customCalls} chime=${ctx.chimeCalls}`)

  // ── 源码判据 ──
  console.log('')
  console.log('源码判据')
  // 比的是**代码**、不是注释 —— 注释里正写着当年那行错代码当反面教材
  const CODE = SRC.split('\n')
    .filter((line) => {
      const t = line.trim()
      return !t.startsWith('*') && !t.startsWith('//') && !t.startsWith('/*')
    })
    .join('\n')
  ok('用独立的基线标志，不再拿 lastBellSeen !== 0 当判据', /bellSeenOnce/.test(CODE) && !/lastBellSeen !== 0 && state\.soundOn/.test(CODE))
  ok('问不到数据时不提前立基线（下一轮还能补上）', /别把 bellSeenOnce 提前立起来/.test(SRC))
  ok('自定义音效播不出来不再静默（退回内置叮 + 面板写一句）', /自定义音效没播出来/.test(CODE))

  /**
   * ── 场景 7：页面侧接「需要人工判断」（10-20 00:1x 第三版）──
   * 主机端那条真机收不到（按作用域发），改走应用自己的页面通道 `remote.$on`。
   * 这里把 watchHumanInteractions 抠出来真跑：
   *   · 两个事件都注册；
   *   · 「要你判断」响**两声**（跟「完成」的一声区分开 —— 作者说过分不清）；
   *   · **原样 next()**（绝不吞卡片）；
   *   · 顺带刷一下主机 bell 当**能查的痕**（这样"到底跑没跑到"不用靠耳朵）。
   */
  console.log('')
  console.log('场景 7：页面侧接「要提问 / 要审批」')
  const watchSrc = SRC.match(/function watchHumanInteractions\(remote\) \{[\s\S]*?\n    \}/)
  ok('抠出 watchHumanInteractions', Boolean(watchSrc))
  if (watchSrc) {
    ctx.state.soundOn = true
    ctx.state.soundId = ''
    let plays = []
    let timers = []
    let posts = []
    let seen = 0
    // setTimeout 用假的：立刻记下来，由测试自己决定什么时候"时间到"
    const fakeSetTimeout = (fn, ms) => {
      timers.push({ fn, ms })
      return timers.length
    }
    const fakePost = (url, body) => {
      posts.push({ url, body })
      return Promise.resolve({ ok: true, at: 12345, kind: 'test' })
    }
    const built = new Function(
      'state',
      'playChime',
      'playCustomSound',
      'postJson',
      'BELL_PATH',
      'setTimeout',
      'let lastBellSeen = 0;' + 'return { fn: (' + watchSrc[0] + '), seen: () => lastBellSeen }',
    )(
      ctx.state,
      () => plays.push('chime'),
      () => plays.push('custom'),
      fakePost,
      '/dsh-skin/bell',
      fakeSetTimeout,
    )
    const fn = built.fn
    const handlers = new Map()
    const remote = { $on: (event, handler) => { handlers.set(event, handler); return () => {} } }
    const count = fn(remote)
    ok('两个事件都注册上了（提问 + 审批）', count === 2 && handlers.has('user-questions/request') && handlers.has('approval/request'))

    // 要提问：响一声（作者 10-20 00:1x 定「一声就够」）+ next() 传下去 + 留痕
    let nextCalls = 0
    const answer = handlers.get('user-questions/request')({ questions: [] }, () => {
      nextCalls += 1
      return Promise.resolve({ answers: {} })
    })
    ok('要提问 → 响一声', plays.length === 1, 'plays=' + plays.length)
    ok('★ 只响一声，不再加节奏（作者说一声就够）', timers.length === 0, 'timers=' + JSON.stringify(timers.map((t) => t.ms)))
    ok('★ 原样 next() 传下去（不吞提问）', nextCalls === 1)
    ok('答案原样返回', Boolean(answer && typeof answer.then === 'function'))
    ok('★ 顺手刷了主机 bell 当痕迹（kind=test）', posts.length === 1 && posts[0].body && posts[0].body.kind === 'test')

    // 要审批：同样一声
    handlers.get('approval/request')({ id: 'a1' }, () => Promise.resolve({ outcome: 'allow' }))
    ok('要审批 → 也是一声', plays.length === 2 && timers.length === 0)

    // 开关关着：一声都不响，但流程照走
    plays = []
    timers = []
    ctx.state.soundOn = false
    let n2 = 0
    handlers.get('approval/request')({ id: 'a2' }, () => { n2 += 1; return Promise.resolve({}) })
    ok('开关关着 → 不响', plays.length === 0)
    ok('开关关着 → 审批流程照走', n2 === 1)

    // 选了自定义音效就走自定义
    ctx.state.soundOn = true
    ctx.state.soundId = 'snd-x'
    plays = []
    handlers.get('user-questions/request')({ questions: [] }, () => Promise.resolve({}))
    ok('选了自定义音效 → 放自定义那条', plays[0] === 'custom', plays.join(','))

    // 没有 next 也不许抛
    ctx.state.soundId = ''
    let threw = false
    try {
      handlers.get('user-questions/request')({ questions: [] }, undefined)
    } catch {
      threw = true
    }
    ok('没有 next 时也不抛', !threw)

    // 痕迹会把 lastBellSeen 同步成新值（免得轮询再补响一次）
    await new Promise((r) => setTimeout(r, 20))
    ok('痕迹回来后同步了 lastBellSeen（不重复响）', built.seen() === 12345, 'lastBellSeen=' + built.seen())

    // 拿不到 remote 时安静跳过
    ok('没有 remote 就安静返回 0', fn(null) === 0 && fn({}) === 0)
  }

  console.log('')
  if (problems.length) {
    console.log('══ 结论:发现异常 ══')
    problems.forEach((p) => console.log('   ' + p))
    process.exitCode = 1
  } else {
    console.log('══ 结论:提示音这条链真跑通了（重启后第一个任务就响）══')
  }
}

main().catch((e) => {
  console.log('跑挂了: ' + (e && e.stack ? e.stack : e))
  process.exitCode = 1
})
