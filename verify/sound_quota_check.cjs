/**
 * 音效容量闸门 · 功能测试（10-19 14:0x 新增）
 *
 * 前面那些 `*_check.cjs` 都是「读源码对关键字」，这个是**真的把主机端跑起来**：
 * 用假的 webServer 把路由接下来，直接调处理函数，看这几条闸门到底拦不拦得住：
 *
 *   ① 单个 8MB 封顶
 *   ② 最多 30 条
 *   ③ 总容量 200MB
 *   ④ 覆盖同一个 id 时，旧的占用要先减掉（不然改个文件也会撞墙）
 *   ⑤ 每次回话都带 usage（页面那张「已用 / 上限」靠它）
 *   ⑥ 批量添加：一个文件一个请求，不把 64MB 读体上限撞了（源码级判据）
 *
 * 判据的数是**从 plugin/index.js 抠出来的**，不手抄。
 * 用法：node verify/sound_quota_check.cjs
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const { pathToFileURL } = require('url')
const { EventEmitter } = require('events')

const ROOT = path.join(__dirname, '..')
const SRC = fs.readFileSync(path.join(ROOT, 'plugin', 'index.js'), 'utf8')

function numIn(name) {
  const m = SRC.match(new RegExp('const ' + name + ' = ([\\d *]+)'))
  if (!m) throw new Error('抠不到常量 ' + name)
  // 允许 8 * 1024 * 1024 这种写法
  return m[1].split('*').map((s) => Number(s.trim())).reduce((a, b) => a * b, 1)
}
const MAX_SOUND_BYTES = numIn('MAX_SOUND_BYTES')
const MAX_SOUND_COUNT = numIn('MAX_SOUND_COUNT')
const MAX_SOUND_TOTAL_BYTES = numIn('MAX_SOUND_TOTAL_BYTES')

const problems = []
const ok = (label, cond, detail) => {
  if (!cond) problems.push(label)
  console.log(`${cond ? 'OK  ' : 'FAIL'} ${label}${detail ? '  ' + detail : ''}`)
}

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-skin-sound-'))
const soundsDir = path.join(work, 'sounds')
fs.mkdirSync(soundsDir, { recursive: true })
/**
 * 【10-19 21:4x】先把索引写成空数组：这里测的是「加/删/闸门」，
 * 不要跟「首次安装铺自带音效」搅在一起（那个另有 ⑩ 节专门测）。
 * 同时也符合真机：老用户目录里早就有 index.json 了，不会再铺。
 */
fs.writeFileSync(path.join(soundsDir, 'index.json'), '[]', 'utf8')

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
  res.json = () => {
    try {
      return JSON.parse(res.text)
    } catch {
      return {}
    }
  }
  return res
}

async function main() {
  const mod = await import(pathToFileURL(path.join(ROOT, 'plugin', 'index.js')).href)
  const routes = new Map()
  const ctx = {
    logger: { warn() {}, info() {}, error() {}, debug() {} },
    effect: (fn) => { try { const d = fn(); return typeof d === 'function' ? d : () => {} } catch { return () => {} } },
    on: () => () => {},
    webServer: { register: (route) => { routes.set(route.path, route.handler); return () => {} } },
  }
  mod.apply(ctx, {
    stateFile: path.join(work, 'state.json'),
    libraryFile: path.join(work, 'library.json'),
    imageDir: path.join(work, 'images'),
  })
  const handler = routes.get('/dsh-skin/sounds')
  ok('路由注册上了（/dsh-skin/sounds）', typeof handler === 'function')
  if (!handler) return finish()

  const call = async (payload) => {
    const res = fakeRes()
    await handler(fakeReq('/dsh-skin/sounds', payload), res)
    return { status: res.status, body: res.json() }
  }
  const audioData = (bytes) => 'data:audio/mpeg;base64,' + Buffer.alloc(bytes, 7).toString('base64')

  // ① 正常加一个
  let r = await call({ method: 'add', id: 'snd-a', name: 'A', ext: '.mp3', data: audioData(1024) })
  ok('正常音频能加进去', r.status === 200 && r.body.list.length === 1, `HTTP ${r.status}`)
  ok('回话里带 usage（页面显示「已用/上限」靠它）', Number(r.body.usage?.total) === MAX_SOUND_TOTAL_BYTES && Number(r.body.usage?.maxCount) === MAX_SOUND_COUNT)
  ok('占用按实际字节记（1024）', Number(r.body.usage?.used) === 1024, 'used=' + r.body.usage?.used)

  // ①b 单个超限：给一句人话，不是「bad sound」
  r = await call({ method: 'add', id: 'snd-big', name: 'big', ext: '.mp3', data: audioData(MAX_SOUND_BYTES + 1024) })
  ok('单个超 8MB 被拦，且报的是一句人话', r.status === 400 && /最多 8MB/.test(String(r.body.error || '')), String(r.body.error || ''))
  ok('被拦的文件没落盘', !fs.existsSync(path.join(soundsDir, 'snd-big.mp3')))

  // ② 条数闸门：先把索引塞满 30 条（文件不真写，只写索引）
  const full = []
  for (let i = 0; i < MAX_SOUND_COUNT; i++) full.push({ id: `snd-fill-${i}`, name: `fill${i}`, ext: '.mp3', mime: 'audio/mpeg', bytes: 1024, at: Date.now() })
  fs.writeFileSync(path.join(soundsDir, 'index.json'), JSON.stringify(full), 'utf8')
  // 主机端有索引缓存 → 换个新的 ctx 重装一遍，让它重新读盘
  routes.clear()
  mod.apply(ctx, { stateFile: path.join(work, 'state.json'), libraryFile: path.join(work, 'library.json'), imageDir: path.join(work, 'images') })
  const handler2 = routes.get('/dsh-skin/sounds')
  const call2 = async (payload) => {
    const res = fakeRes()
    await handler2(fakeReq('/dsh-skin/sounds', payload), res)
    return { status: res.status, body: res.json() }
  }
  r = await call2({ method: 'add', id: 'snd-31', name: '31', ext: '.mp3', data: audioData(1024) })
  ok(`第 ${MAX_SOUND_COUNT + 1} 条被拦，提示条数满了`, r.status === 400 && /最多 30 条/.test(String(r.body.error || '')), String(r.body.error || ''))
  ok('被拦的那条没进索引', !(r.body.list || []).some((x) => x.id === 'snd-31'))

  // ③ 总容量闸门：29 条（不到条数上限）但占用已经 197MB，再加个 5MB 的照样该拦
  const heavy = []
  for (let i = 0; i < MAX_SOUND_COUNT - 1; i++) heavy.push({ id: `snd-heavy-${i}`, name: `h${i}`, ext: '.mp3', mime: 'audio/mpeg', bytes: 7 * 1024 * 1024, at: Date.now() })
  heavy[0] = { ...heavy[0], bytes: 1 * 1024 * 1024 } // 留一条小的，等下测「覆盖同一条能过」
  fs.writeFileSync(path.join(soundsDir, 'index.json'), JSON.stringify(heavy), 'utf8')
  routes.clear()
  mod.apply(ctx, { stateFile: path.join(work, 'state.json'), libraryFile: path.join(work, 'library.json'), imageDir: path.join(work, 'images') })
  const handler3 = routes.get('/dsh-skin/sounds')
  const call3 = async (payload) => {
    const res = fakeRes()
    await handler3(fakeReq('/dsh-skin/sounds', payload), res)
    return { status: res.status, body: res.json() }
  }
  const usedNow = heavy.reduce((s, e) => s + e.bytes, 0)
  r = await call3({ method: 'add', id: 'snd-space', name: 'space', ext: '.mp3', data: audioData(5 * 1024 * 1024) })
  ok('总容量超了被拦，提示写清已用多少', r.status === 400 && /总容量上限 200MB/.test(String(r.body.error || '')), String(r.body.error || ''))
  ok('已用数对得上（29 条合计）', String(r.body.error || '').includes((usedNow / 1024 / 1024).toFixed(1)), 'used=' + (usedNow / 1024 / 1024).toFixed(1) + 'MB')

  // ④ 覆盖同一条：把那条 1MB 的换成 1MB 的，旧的先减掉 → 不该撞墙
  r = await call3({ method: 'add', id: 'snd-heavy-0', name: 'h0-new', ext: '.mp3', data: audioData(1024 * 1024) })
  ok('覆盖同一条能过（旧占用先减掉）', r.status === 200, `HTTP ${r.status} ${String(r.body.error || '')}`)

  // ⑤ 删掉一条，usage 跟着降
  r = await call3({ method: 'remove', id: 'snd-heavy-1' })
  ok('删掉一条后 usage 跟着变', r.status === 200 && Number(r.body.usage?.count) === MAX_SOUND_COUNT - 2, 'count=' + r.body.usage?.count)

  // ⑥ 批量添加是「一个文件一个请求」（源码判据）
  const CLIENT = fs.readFileSync(path.join(ROOT, 'plugin', 'client.js'), 'utf8')
  ok('客户端逐个上传（批量时不合成一个大请求）', /for \(const file of picked\)[\s\S]{0,200}importSound\(file, true\)/.test(CLIENT))

  /**
   * ═══ ⑦ 提示音那条链：为什么「任务完成了不响」（10-19 19:2x 查出来的）
   *
   * 真凶是协议对不上：页面用 **POST** 去问「任务完成了吗」，
   * 而主机端 POST 分支只回 `{ ok: true }` —— **没有 at 字段**，
   * 于是页面那边 `Number(result?.at) || 0` 恒等于 0，「时间戳变了」永远不成立，
   * 内置叮和自定义音效一次都没响过。试听能响是因为它绕过这条路直接播。
   *
   * 这里就照着真机的两条路各问一次。
   */
  const bell = routes.get('/dsh-skin/bell')
  ok('bell 路由注册上了', typeof bell === 'function')
  if (bell) {
    const callBell = async (method, payload) => {
      const res = fakeRes()
      const req = fakeReq('/dsh-skin/bell', payload)
      req.method = method
      await bell(req, res)
      return { status: res.status, body: res.json() }
    }
    const before = await callBell('GET')
    ok('GET 能问到 at/kind', before.status === 200 && 'at' in before.body && 'kind' in before.body, JSON.stringify(before.body))
    const posted = await callBell('POST', { kind: 'test' })
    ok('POST 也把 at 一起回（真凶就是这儿只回 ok）', posted.status === 200 && Number(posted.body.at) > 0, JSON.stringify(posted.body))
    const after = await callBell('GET')
    ok('试听之后 at 真的变了（页面靠这个判断「有新完成」）', Number(after.body.at) > 0 && Number(after.body.at) >= Number(posted.body.at), 'at=' + after.body.at)
    // 源码判据：页面问 bell 用的是 GET，不是 POST
    // 【注意】要比的是**代码**、不是注释 —— 注释里正写着当年那行错代码当反面教材，
    // 直接拿正则扫全文会把注释也算进去（这次自己踩过一次）。
    const CLIENT_CODE = CLIENT.split('\n')
      .filter((line) => {
        const t = line.trim()
        return !t.startsWith('*') && !t.startsWith('//') && !t.startsWith('/*')
      })
      .join('\n')
    ok(
      '页面用 GET 问 bell（问数据就用 GET）',
      /await getJson\(BELL_PATH\)/.test(CLIENT_CODE) && !/postJson\(BELL_PATH, \{\}\)/.test(CLIENT_CODE),
    )
    ok('主机端的分支结构看得清：POST 只认 kind:test', /payload\?\.kind === 'test'/.test(SRC))
  }

  /**
   * ⑧ 遮罩上限：页面 40、主机端 40，谁都不许单独改一边
   * （不然「拖到 40 → 存进去被夹回 25 → 下次打开自己弹回去」）
   */
  const clientWash = Number((CLIENT.match(/const MAX_WASH = (\d+)/) || [])[1])
  const hostWash = Number((SRC.match(/const MAX_WASH = (\d+)/) || [])[1])
  ok('页面和主机端的遮罩上限一致，且是boss要的 0~40%', clientWash === 40 && hostWash === 40, `页面 ${clientWash} / 主机 ${hostWash}`)
  ok('主机端写盘前用的是这个常量（不是写死的数）', /Math\.min\(MAX_WASH, Math\.max\(0, Math\.round\(value\)\)\)/.test(SRC))

  /**
   * ⑨ 真机跑一遍：把 wash=40 存进去，读回来还是不是 40
   * （只查源码不够 —— 「拖到 40 被偷偷夹回 25、下次打开自己弹回去」这种
   *   必须真的写一次读一次才看得出来）
   */
  const stateRoute = routes.get('/dsh-skin/state')
  if (typeof stateRoute === 'function') {
    const callState = async (patch) => {
      const res = fakeRes()
      const req = fakeReq('/dsh-skin/state', { method: 'set', patch })
      req.method = 'POST'
      await stateRoute(req, res)
      return res.json()
    }
    const saved = await callState({ wash: 40 })
    ok('wash=40 存得住（不会又被夹回 25）', Number(saved?.wash) === 40, '读回来 wash=' + saved?.wash)
    const huge = await callState({ wash: 999 })
    ok('离谱的大值仍然被夹在 40', Number(huge?.wash) === 40, 'wash=999 → ' + huge?.wash)
    const zero = await callState({ wash: 0 })
    ok('wash=0 是「真的 0」，不会被当成「没设过」', Number(zero?.wash) === 0 && zero?.wash !== null, 'wash=' + zero?.wash)
  } else {
    ok('state 路由注册上了', false)
  }

  /**
   * ⑩ 首次安装自带音效（boss 10-19 21:4x：「默认的音效，可以选择我们目前拥有的这几个带上去」）
   * 判据：**全新目录**（没有 index.json）才铺；已经有索引就不动（删掉的不会自己长回来）。
   */
  {
    const fresh = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-skin-seed-'))
    const freshRoutes = new Map()
    const freshCtx = {
      logger: { warn() {}, info() {}, error() {}, debug() {} },
      effect: (fn) => { try { const d = fn(); return typeof d === 'function' ? d : () => {} } catch { return () => {} } },
      on: () => () => {},
      webServer: { register: (route) => { freshRoutes.set(route.path, route.handler); return () => {} } },
    }
    mod.apply(freshCtx, {
      stateFile: path.join(fresh, 'state.json'),
      libraryFile: path.join(fresh, 'library.json'),
      imageDir: path.join(fresh, 'images'),
    })
    await new Promise((r) => setTimeout(r, 300)) // 铺音效是异步的，等它落盘
    const listRoute = freshRoutes.get('/dsh-skin/sounds')
    const readList = async () => {
      const res = fakeRes()
      const req = fakeReq('/dsh-skin/sounds', {})
      req.method = 'POST'
      await listRoute(req, res)
      return res.json()
    }
    const first = await readList()
    const names = (first.list || []).map((x) => x.name)
    ok('全新目录会铺出自带音效', (first.list || []).length === 4, '铺了 ' + (first.list || []).length + ' 个：' + names.join(' / '))
    ok('四条的名字都对得上',
      ['叮的一声', '咚咚', '丢硬币', '拔剑'].every((n) => names.includes(n)),
      names.join(' / '))
    const firstId = (first.list || [])[0]?.id
    ok('自带音效的音频文件真的落盘了', firstId ? fs.existsSync(path.join(fresh, 'sounds', firstId + '.mp3')) : false, firstId)
    // 删掉一个，再重新装配一次 —— 不许自己长回来（只有索引不存在时才铺）
    const after = await readList()
    const del = after.list[0].id
    const delRes = fakeRes()
    const delReq = fakeReq('/dsh-skin/sounds', { method: 'remove', id: del })
    delReq.method = 'POST'
    await listRoute(delReq, delRes)
    mod.apply(freshCtx, {
      stateFile: path.join(fresh, 'state.json'),
      libraryFile: path.join(fresh, 'library.json'),
      imageDir: path.join(fresh, 'images'),
    })
    await new Promise((r) => setTimeout(r, 200))
    const again = await readList()
    ok('删掉的自带音效不会自己长回来', (again.list || []).length === 3, '现在 ' + (again.list || []).length + ' 个')
    try {
      fs.rmSync(fresh, { recursive: true, force: true })
    } catch {
      /* 清不掉不影响结论 */
    }
  }

  /**
   * ⑪ 撤掉的品牌音效会自动清掉（boss 10-20 02:5x：「把 CS / QQ 的撤掉，其他的放在里面」）
   * 判据：模拟一台「老装机」—— sounds/index.json 里已有 4 条保留 + 2 条品牌（CS / QQ），
   * 重新装配后：品牌条目从列表消失、文件也从磁盘删掉；保留的 2 条一个不少。
   */
  {
    const old = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-skin-retire-'))
    const oldSounds = path.join(old, 'sounds')
    fs.mkdirSync(oldSounds, { recursive: true })
    const oldIndex = [
      { id: 'snd-builtin-ding', name: '叮的一声', ext: '.mp3' },
      { id: 'snd-builtin-coin', name: '丢硬币', ext: '.mp3' },
      { id: 'snd-builtin-cs-go', name: 'CS Go Go GO', ext: '.mp3' },
      { id: 'snd-builtin-qq-ding', name: 'QQ提示音噔噔噔', ext: '.wav' },
    ]
    fs.writeFileSync(path.join(oldSounds, 'index.json'), JSON.stringify(oldIndex))
    for (const it of oldIndex) fs.writeFileSync(path.join(oldSounds, it.id + it.ext), 'stub')

    const oldRoutes = new Map()
    const oldCtx = {
      logger: { info() {}, warn() {}, error() {} },
      effect: (fn) => { try { const d = fn(); return typeof d === 'function' ? d : () => {} } catch { return () => {} } },
      on: () => () => {},
      webServer: { register: (route) => { oldRoutes.set(route.path, route.handler); return () => {} } },
    }
    mod.apply(oldCtx, {
      stateFile: path.join(old, 'state.json'),
      libraryFile: path.join(old, 'library.json'),
      imageDir: path.join(old, 'images'),
    })
    await new Promise((r) => setTimeout(r, 300)) // retire 是异步的，等它跑完

    const listRoute2 = oldRoutes.get('/dsh-skin/sounds')
    const res2 = fakeRes()
    const req2 = fakeReq('/dsh-skin/sounds', {})
    req2.method = 'POST'
    await listRoute2(req2, res2)
    const left = (res2.json().list || []).map((x) => x.name)
    ok('品牌音效被自动清掉、其余保留',
      left.length === 2 && left.includes('叮的一声') && left.includes('丢硬币'),
      '剩：' + (left.join(' / ') || '（空）'))
    ok('品牌音效的文件也删了',
      !fs.existsSync(path.join(oldSounds, 'snd-builtin-cs-go.mp3')) &&
      !fs.existsSync(path.join(oldSounds, 'snd-builtin-qq-ding.wav')))
    try {
      fs.rmSync(old, { recursive: true, force: true })
    } catch {
      /* 清不掉不影响结论 */
    }
  }

  finish()
}

function finish() {
  try {
    fs.rmSync(work, { recursive: true, force: true })
  } catch {
    /* 清不掉也不影响结论 */
  }
  console.log('')
  if (problems.length) {
    console.log('══ 结论:发现异常 ══')
    problems.forEach((p) => console.log('   ' + p))
    process.exitCode = 1
  } else {
    console.log('══ 结论:音效容量三道闸（单个 8MB / 30 条 / 200MB）功能上都拦得住；提示音那条链也通了 ══')
  }
}

main().catch((e) => {
  console.log('跑挂了: ' + (e && e.stack ? e.stack : e))
  process.exitCode = 1
})
