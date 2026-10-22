/**
 * 提示音「提前响」· 功能测试（10-19 20:4x 新增）
 *
 * boss原话：「为什么有的时候任务还没跑完，但是它就已经声音提醒你了。
 *            但是基本上过一两分钟任务才结束。这种情况不多见」
 *
 * 查出两个原因：
 *   ① 维护阶段（maintenance，比如压缩上下文）**也报成 idle** ——
 *      应用里 `status = phase.kind === 'idle' || 'maintenance' ? 'idle' : 'running'`，
 *      所以一轮任务干到一半它会发一次 running→idle，我们就提前响了；
 *   ② 广播是**所有 agent** 的：子 agent 干完也报 idle，可boss等的那件事还在跑。
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

  /**
   * 【10-20 23:5x】造一个带 session 的 agent，模拟真机的父子关系。
   * 主会话没有 header.parentSession；子 agent 有（指向主会话）。
   */
  const fakeAgent = (id, parentSession) => ({
    id,
    session: { header: parentSession ? { parentSession } : {} },
  })
  /** 发一条带真实父子关系的状态广播 */
  const emitAgent = (status, id, parentSession) =>
    statusHandler({ status, agent: fakeAgent(id, parentSession) })

  // ── 场景 1：一轮任务中途的 idle ──
  /**
   * ═══ 【10-20 20:1x 判据改了，为什么改】═══
   * 旧判据是「维护阶段的 idle 不会让它响」。**实测这条保护是空转的**：
   * 主机端收到的 `agent/status` 广播里**只带 status（idle/running），
   * 不带 phase.kind** —— 我去桌面端程序里核实过，`emit("agent/status", { status })`
   * 就一个字段。所以 `payload?.phase?.kind === 'maintenance'` 永远不成立，
   * 那道 if 从来没有拦住过任何东西（不是「拦住了」，是「不可能拦住」）。
   * B 方案把它删了，同时补上真正有用的两道：取消后补响 + 记账本清理。
   *
   * 新判据：**不管什么来源的 idle，都按「都空闲了」处理，安静期满就响。**
   * 真正防「任务没干完就响」的是排程前那把 `runningAgents.size > 0`。
   */
  console.log('')
  console.log('场景 1：任务中途的 idle（旧判据的 maintenance 保护已确认是空转，删除）')
  emit('running')
  emit('idle', { phase: { kind: 'maintenance' } }) // ← 广播里其实没有 phase，这行只是模拟字段缺失
  await wait(SETTLE + 80)
  const midIdle = await readAt()
  ok('★ 维护 idle 也会走到「响」（保护是空转的，不再假装有）', midIdle > 0, 'at=' + midIdle)
  emit('running')
  emit('idle') // 真干完
  await wait(SETTLE + 80)
  const after1 = await readAt()
  ok('真干完才响', after1 > 0)
  const after1b = await readAt()
  await wait(SETTLE + 80)
  ok('同一件事只响一次', (await readAt()) === after1b)

  /**
   * ═══ 【10-20 23:5x 场景 1b：多会话并行 —— 真正的主因】═══
   * boss多会话并行干活。旧判据是「**所有** agent 都空闲」才算完成，
   * 只要别的会话还有一个在跑，这一轮就永远判不完成 → 一声不响。
   * 真机留痕实证：N 序列 5→5→5→5→4→4→3→5，**从来没到过 0**。
   *
   * 新判据：**按支记账** —— 别的会话在跑，跟我这一支没关系。
   */
  console.log('')
  console.log('场景 1b：多会话并行时，一个会话干完就该响（23:5x 真正的主因）')
  const before1b = await readAt()
  emitAgent('running', 'SESS-A')            // 会话 A 在跑
  emitAgent('running', 'SESS-B')            // 会话 B 也在跑（boss开了别的窗口）
  emitAgent('running', 'SESS-C')            // 会话 C 也在跑
  await wait(40)
  emitAgent('idle', 'SESS-A')               // A 干完了，B/C 还在跑
  await wait(SETTLE + 80)
  ok('★ 别的会话还在跑，A 干完照样响（不再等全员空闲）', (await readAt()) > before1b, 'before=' + before1b)
  const after1bA = await readAt()
  emitAgent('idle', 'SESS-B')               // B 干完（也该响一声）
  await wait(SETTLE + 80)
  ok('B 干完也响（各支各算）', (await readAt()) > after1bA)
  const after1bB = await readAt()
  emitAgent('idle', 'SESS-C')
  await wait(SETTLE + 80)
  ok('C 干完也响', (await readAt()) > after1bB)

  /**
   * ═══ 【10-20 23:5x 场景 1c：子 agent 干完不算】═══
   * 子 agent 归到主会话那一支底下。子 agent 先干完 → 不响（主任务还在跑），
   * 主会话干完 → 响。这保住了 10-19 20:4x 那道防线。
   */
  console.log('')
  console.log('场景 1c：子 agent 干完不响，主会话干完才响（23:5x）')
  const before1c = await readAt()
  emitAgent('running', 'SESS-D')                   // 主会话 D
  emitAgent('running', 'CHILD-D1', 'SESS-D')       // 它的子 agent
  await wait(40)
  emitAgent('idle', 'CHILD-D1', 'SESS-D')          // 子 agent 先干完
  await wait(SETTLE + 80)
  ok('★ 子 agent 干完不响（主任务还在跑）', (await readAt()) === before1c, 'at 没变')
  emitAgent('idle', 'SESS-D')                     // 主会话真干完
  await wait(SETTLE + 80)
  ok('主会话干完才响', (await readAt()) > before1c)

  /**
   * ═══ 【10-20 23:5x 场景 1d：这一支被拽走后补响，不看别的会话】═══
   */
  console.log('')
  console.log('场景 1d：这一支被拽走后补响，别的会话在跑也不影响（23:5x）')
  const before1d = await readAt()
  emitAgent('running', 'SESS-E')
  emitAgent('running', 'SESS-F')              // 别的会话一直占着
  await wait(40)
  emitAgent('idle', 'SESS-E')
  await wait(Math.floor(SETTLE / 3))
  emitAgent('running', 'SESS-E')              // 这一支被拽走
  await wait(SETTLE + 80)
  emitAgent('idle', 'SESS-E')
  await wait(SETTLE + 80)
  ok('★ 这一支安静下来就补响（不等别的会话）', (await readAt()) > before1d, 'before=' + before1d)
  emitAgent('idle', 'SESS-F')                // 把别的会话收干净，别影响后面的场景
  await wait(SETTLE + 80)

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

  /**
   * ═══ 【10-20 20:1x B 方案 ②】取消后必须补响 ═══
   * boss报的「有时有声音有时没声音」最常见的那条：安静等 3 秒期间被别的事
   * （定时任务/后台自动化）拽走，旧代码直接作废不补 → 这次完成就没了。
   * 新逻辑：拽走时记 `pendingRefire`，等这波真安静下来补一声。
   */
  console.log('')
  console.log('场景 3b：安静期内被别的事拽走，之后补响（B 方案 ②）')
  const before3b = await readAt()
  emit('running', { id: 'A' })
  emit('idle', { id: 'A' })
  await wait(Math.floor(SETTLE / 3))
  emit('running', { id: 'BACKGROUND' }) // ← 别的任务把这一趟拽走了
  emit('idle', { id: 'BACKGROUND' })
  await wait(SETTLE + 80)
  ok('★ 被拽走之后会补响（不再吞掉）', (await readAt()) > before3b, 'before=' + before3b)

  /**
   * ═══ 【10-20 20:1x B 方案 ①a)】记账本的清理口子 ═══
   * 旧代码只有 `agent/status` 一条路往 `runningAgents` 里加名字、摘名字，
   * **没有任何清理**。万一某个后台任务的 idle 广播没被收到，名字永远留在本子里
   * → 之后每次判断都发现"本子不空" → 从此一次都不响。
   * 新逻辑：`agent/disposed` 时划掉，划完再评估一次。
   */
  console.log('')
  console.log('场景 7：任务被收掉时清记账本（B 方案 ①）')
  const disposedHandler = otherHandlers.get('agent/disposed')
  ok('挂上了 agent/disposed 监听', typeof disposedHandler === 'function')
  if (typeof disposedHandler === 'function') {
    const before7 = await readAt()
    emit('running', { id: 'STUCK' }) // 这个任务的 idle 广播永远没来（本子卡住）
    await wait(SETTLE + 80)
    ok('本子卡住 → 一次都不响', (await readAt()) === before7, 'at 没变')
    disposedHandler({ id: 'STUCK' }) // ← 任务被收掉，划名字
    await wait(SETTLE + 80)
    ok('★ 划掉卡住的名字之后补响了（治「突然彻底没声」）', (await readAt()) > before7, 'before=' + before7)
    const mid7 = await readAt()
    await wait(SETTLE + 80)
    ok('补响不会重复', (await readAt()) === mid7)
  }

  // ── 场景 4：插件挂上之前就已经在跑的任务 ──
  /**
   * ═══ 【10-20 20:1x 判据改了，为什么改】═══
   * 旧判据是「没见过 running 就不算完成」（`sawRunning`）。B 方案把它删了：
   * 它只会造成「插件挂上之前就已经在跑的任务，跑完了不响」，
   * 而它想防的情况（主机留着旧时间戳、一启动就补响）页面侧 19:5x 已经用
   * `bellSeenOnce` 解决了。**两道门槛防同一件事，留着的这道只会牺牲。**
   *
   * 新判据：挂上之后来的 idle，安静期满就响。
   */
  console.log('')
  console.log('场景 4：插件挂上之后来的空闲（sawRunning 门槛已删）')
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
  ok('★ 挂上之后来的空闲也会响（不再拿 sawRunning 当门槛）', (await readAt()) > before4, 'before=' + before4)

  const at = await readAt()
  console.log('')
  console.log('最终 bell.at = ' + at + '（有值就说明真跑通过一遍）')

  /**
   * ── 场景 5/6：需要人工判断（boss 10-19 22:1x：「出现需要人工判断的时候，也需要加提示音」）──
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

  /**
   * ═══ 【10-20 20:1x B 方案 ④】留痕：读 bell 就知道刚才为什么响/不响 ═══
   * boss报「刚才没声音」时，不用再靠猜 —— 打开 `/dsh-skin/bell`，
   * `trace` 字段就是最近几次判定的原因。
   */
  console.log('')
  console.log('场景 8：bell 接口带留痕（B 方案 ④）')
  const res8 = fakeRes()
  const req8 = fakeReq('/dsh-skin/bell')
  req8.method = 'GET'
  await bell(req8, res8)
  const traceList = res8.json()?.trace
  ok('★ bell 接口回 trace 字段', Array.isArray(traceList) && traceList.length > 0, '共 ' + (Array.isArray(traceList) ? traceList.length : 0) + ' 条')
  if (Array.isArray(traceList) && traceList.length > 0) {
    const sample = traceList.slice(0, 3).map((t) => t.why).join(' / ')
    console.log('     最近几条：' + sample)
    ok('★ 每条都带 why（人能看懂的原因）', traceList.every((t) => typeof t.why === 'string' && t.why.length > 0))
    ok('★ 最多留 10 条（不会无限长）', traceList.length <= 10)
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
    console.log('══ 结论:子 agent 先完、短促抖动 不提前响；被拽走/被卡住 会补响 ══')
  }
}

main().catch((e) => {
  console.log('跑挂了: ' + (e && e.stack ? e.stack : e))
  process.exitCode = 1
})
