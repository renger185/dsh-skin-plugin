/**
 * 提示音「提前响」· 功能测试（10-19 20:4x 新增）
 *
 * 作者原话：「为什么有的时候任务还没跑完，但是它就已经声音提醒你了。
 *            但是基本上过一两分钟任务才结束。这种情况不多见」
 *
 * 查出两个原因：
 *   ① 维护阶段（maintenance，比如压缩上下文）**也报成 idle** ——
 *      应用里 `status = phase.kind === 'idle' || 'maintenance' ? 'idle' : 'running'`，
 *      所以一轮任务干到一半它会发一次 running→idle，我们就提前响了；
 *   ② 广播是**所有 agent** 的：子 agent 干完也报 idle，可作者等的那件事还在跑。
 *
 * 这个脚本把主机端真正注册的那个监听函数抓出来，按真机的顺序喂事件，
 * 看「什么时候响、什么时候不响」。判据全部对着主机端源码里的常量与逻辑，不手抄。
 *
 * 用法：node verify/bell_signal_check.cjs
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const { pathToFileURL } = require('url')
const { EventEmitter } = require('events')

const ROOT = path.join(__dirname, '..')
const HOST_SRC = fs.readFileSync(path.join(ROOT, 'plugin', 'index.js'), 'utf8')

const problems = []
const ok = (label, cond, detail) => {
  if (!cond) problems.push(label)
  console.log(`${cond ? 'OK  ' : 'FAIL'} ${label}${detail ? '  ' + detail : ''}`)
}

// 静一静那个延迟：源码里的默认值（测试用小的覆盖，跑得快）
const defaultSettle = Number((HOST_SRC.match(/BELL_SETTLE_MS = Number\(config\?\.bellSettleMs\) > 0 \? Number\(config\.bellSettleMs\) : (\d+)/) || [])[1])
const SETTLE = 120

function fakeReq(url, body) {
  const req = new EventEmitter()
  req.url = url
  req.destroy = () => {}
  setImmediate(() => {
    if (body !== undefined) req.emit('data', Buffer.from(JSON.stringify(body), 'utf8'))
    req.emit('end')
  })
  return req
}
function fakeRes() {
  const res = { status: 0, text: '', writeHead(s) { this.status = s }, end(t) { this.text = t } }
  res.json = () => { try { return JSON.parse(res.text) } catch { return {} } }
  return res
}

async function main() {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-skin-bell-'))
  const mod = await import(pathToFileURL(path.join(ROOT, 'plugin', 'index.js')).href)
  const routes = new Map()
  let statusHandler = null
  const otherHandlers = new Map()
  const ctx = {
    logger: { warn() {}, info() {}, error() {}, debug() {} },
    effect: (fn) => { try { const d = fn(); return typeof d === 'function' ? d : () => {} } catch { return () => {} } },
    on: (name, fn) => {
      if (name === 'agent/status') statusHandler = fn
      else otherHandlers.set(name, fn)
      return () => {}
    },
    webServer: { register: (route) => { routes.set(route.path, route.handler); return () => {} } },
  }
  mod.apply(ctx, {
    stateFile: path.join(work, 'state.json'),
    libraryFile: path.join(work, 'library.json'),
    imageDir: path.join(work, 'images'),
    bellSettleMs: SETTLE,
  })
  ok('抓到了 agent/status 监听函数', typeof statusHandler === 'function')
  ok('静一静的默认值是从源码里读出来的', Number.isFinite(defaultSettle) && defaultSettle >= 1000, `默认 ${defaultSettle}ms`)
  if (typeof statusHandler !== 'function') return finish(work)

  const bell = routes.get('/dsh-skin/bell')
  const readAt = async () => {
    const res = fakeRes()
    const req = fakeReq('/dsh-skin/bell')
    req.method = 'GET'
    await bell(req, res)
    return Number(res.json()?.at) || 0
  }
  const emit = (status, extra) => statusHandler({ status, id: 'A', phase: { kind: status === 'idle' ? 'idle' : 'running' }, ...extra })
  const wait = (ms) => new Promise((r) => setTimeout(r, ms))

  // ── 场景 1：一轮任务中间跑压缩（维护也报 idle）→ 不许提前响 ──
  console.log('')
  console.log('场景 1：任务干到一半跑维护（压缩上下文），维护报的是 idle')
  emit('running')
  emit('idle', { phase: { kind: 'maintenance' } }) // ← 应用把维护也报成 idle
  await wait(SETTLE + 80)
  ok('维护阶段的 idle 不会让它响', (await readAt()) === 0, 'at=' + (await readAt()))
  emit('running')
  emit('idle') // 真干完
  await wait(SETTLE + 80)
  const after1 = await readAt()
  ok('真干完才响', after1 > 0)
  const after1b = await readAt()
  await wait(SETTLE + 80)
  ok('同一件事只响一次', (await readAt()) === after1b)

  // ── 场景 2：子 agent 先干完，主任务还在跑 → 不许响 ──
  console.log('')
  console.log('场景 2：两个 agent（主任务 + 子 agent）')
  const before2 = await readAt()
  emit('running', { id: 'MAIN' })
  emit('running', { id: 'SUB' })
  emit('idle', { id: 'SUB' }) // 子 agent 先完
  await wait(SETTLE + 80)
  ok('子 agent 干完不响（主任务还在跑）', (await readAt()) === before2, 'at 没变')
  emit('idle', { id: 'MAIN' }) // 主任务真完
  await wait(SETTLE + 80)
  ok('两个都空闲了才响', (await readAt()) > before2)

  // ── 场景 3：短促抖动（空闲一下又跑起来）→ 不许响 ──
  console.log('')
  console.log('场景 3：空闲一下又跑起来（抖动）')
  const before3 = await readAt()
  emit('running', { id: 'A' })
  emit('idle', { id: 'A' })
  await wait(Math.floor(SETTLE / 3))
  emit('running', { id: 'A' }) // 抖动：又跑起来了
  await wait(SETTLE + 80)
  ok('抖动期间被取消，不响', (await readAt()) === before3, 'at 没变')
  emit('idle', { id: 'A' })
  await wait(SETTLE + 80)
  ok('真安静下来才响', (await readAt()) > before3)

  // ── 场景 4：插件刚挂上时的维护（没见过 running）→ 不许响 ──
  console.log('')
  console.log('场景 4：刚启动就来的空闲（没见过 running）')
  mod.apply(ctx, {
    stateFile: path.join(work, 'state.json'),
    libraryFile: path.join(work, 'library.json'),
    imageDir: path.join(work, 'images'),
    bellSettleMs: SETTLE,
  })
  const before4 = await readAt()
  emit('idle', { phase: { kind: 'maintenance' } })
  emit('idle')
  await wait(SETTLE + 80)
  ok('没见过 running 就不算完成', (await readAt()) === before4)

  const at = await readAt()
  console.log('')
  console.log('最终 bell.at = ' + at + '（有值就说明真跑通过一遍）')

  /**
   * ── 场景 5/6：需要人工判断（作者 10-19 22:1x：「出现需要人工判断的时候，也需要加提示音」）──
   * 两个入口：① 落地事件 `approval/asked`（工具要批准）② waterfall `user-questions/request`（工具要人回答）。
   * 判据：**立刻响**（不用等静一静），而且 ② 必须把 next() 原样往下传（不能把问题吞了）。
   */
  console.log('')
  console.log('场景 5：工具要人工批准（approval/asked）')
  const sessionHandler = otherHandlers.get('session/event')
  ok('挂上了 session/event 监听', typeof sessionHandler === 'function')
  if (typeof sessionHandler === 'function') {
    const before5 = await readAt()
    sessionHandler({ id: 's1' }, { type: 'approval/asked', data: { id: 'ap1', toolName: 'pwsh' } })
    await wait(60) // 立刻响：只等 60ms（比静一静窗口短得多）
    const after5 = await readAt()
    ok('要批准 → 立刻响（不等静一静）', after5 > before5, 'at 变了')
    const after5b = await readAt()
    sessionHandler({ id: 's1' }, { type: 'assistant/message', data: {} }) // 别的事件不许响
    await wait(60)
    ok('别的会话事件不会误响', (await readAt()) === after5b)
  }

  console.log('')
  console.log('场景 6：工具要人回答问题（user-questions/request，waterfall）')
  const questionHandler = otherHandlers.get('user-questions/request')
  ok('挂上了 user-questions/request 监听', typeof questionHandler === 'function')
  if (typeof questionHandler === 'function') {
    const before6 = await readAt()
    let nextCalled = 0
    const answer = await questionHandler({ questions: [{ id: 'q1' }] }, () => {
      nextCalled += 1
      return Promise.resolve({ answers: { q1: 'A' } })
    })
    await wait(60)
    ok('要人回答 → 立刻响', (await readAt()) > before6)
    ok('★ 原样把 next() 传下去了（没把问题吞掉）', nextCalled === 1, 'next 被调 ' + nextCalled + ' 次')
    ok('答案原样返回给调用方', Boolean(answer && answer.answers && answer.answers.q1 === 'A'))
    // 没有 next 的极端情况也不能抛
    let threw = false
    try {
      questionHandler({ questions: [] }, undefined)
    } catch {
      threw = true
    }
    ok('没有 next 时也不抛（宁可这一声不响，不能弄坏提问流程）', !threw)
  }

  finish(work)
}

function finish(work) {
  try {
    fs.rmSync(work, { recursive: true, force: true })
  } catch {
    /* 清不掉不影响结论 */
  }
  console.log('')
  if (problems.length) {
    console.log('══ 结论:发现异常 ══')
    problems.forEach((p) => console.log('   ' + p))
    process.exitCode = 1
  } else {
    console.log('══ 结论:维护中的假空闲、子 agent 先完、短促抖动 都不再提前响 ══')
  }
}

main().catch((e) => {
  console.log('跑挂了: ' + (e && e.stack ? e.stack : e))
  process.exitCode = 1
})
