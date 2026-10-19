/**
 * dsh-skin — 换肤插件 · 主机端(Host half)
 *
 * 干两件事:
 *   1. 给页面开本机接口,把换肤设置和图库存成文件。
 *   2. 按 id 把存好的背景图发回给页面。
 *
 * 为什么要主机端存盘:桌面版每次启动换一个随机端口,浏览器里的 localStorage /
 * IndexedDB 跟着换了地址就作废,作者刚设的背景一重启就没了。走文件才留得住。
 *
 * 接口:
 *   POST /dsh-skin/state    {method:"get"} | {method:"set", patch:{}}
 *   POST /dsh-skin/library  {method:"list"} | {method:"add", id, entry, image, thumb}
 *                          | {method:"update", id, patch} | {method:"remove", id}
 *   GET  /dsh-skin/image?id=xxx[&thumb=1]     → 图片本体
 *
 * 图库一张图存两个文件(原图 + 缩略图),索引单独一个 JSON —— 一次导入一个文件夹
 * 也不会把所有图塞进一个大 JSON 里反复读写。
 */

import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

export const inject = ['webServer']

const STATE_PATH = '/dsh-skin/state'
const LIBRARY_PATH = '/dsh-skin/library'
const IMAGE_PATH = '/dsh-skin/image'
const DIAG_PATH = '/dsh-skin/diag'
const BELL_PATH = '/dsh-skin/bell'
const SOUNDS_PATH = '/dsh-skin/sounds'
const SOUND_FILE_PATH = '/dsh-skin/sound'
const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/
const MAX_IMAGE_BYTES = 24 * 1024 * 1024 // 单张 24MB 封顶,挡住误传的离谱文件
/**
 * 读请求体的上限,单独设、比任何单个文件的封顶都大。
 * data URL 会被 base64 撑大三分之一,再套一层 JSON —— 按"文件大小"卡这里
 * 会把合法的大音频误杀(作者 01:00 报「自定义音效添加不上去」就是这个原因)。
 * 真正的大小校验在各自的处理函数里做(音频 8MB、图片 24MB)。
 */
const MAX_BODY_BYTES = 64 * 1024 * 1024

/** 设置的默认值:文字颜色默认跟随主题,遮罩默认交给图片自己算 */
function emptyState() {
  return { activeId: '', wash: null, text: 'follow', mode: 'normal', rotateMinutes: 0, ballX: null, ballY: null, bleed: 64, soundOn: false, soundVolume: 0.5, soundId: '' }
}

/**
 * ═══ 任务完成提示音(作者 10-18 23:45 在 A/B/C/D 里选了 A)═══
 *
 * 作者原话:「任务完成后可以有音效提示」。A 案 = 代码合成一声短「叮」,
 * 不用音频文件、不联网,面板开关**默认关**。
 *
 * 为什么走「页面来问」而不是「主机推」:
 * 主机端拿不到界面,声音只能在页面那一半放。两边本来就用本机接口说话,
 * 所以这里记下「最近一次完成的时刻」,页面每秒来问一次 —— 开销可以忽略。
 */
let lastDoneAt = 0
let lastDoneKind = 'done'

/**
 * ═══ 自定义音效(作者 10-19 00:20 要的)═══
 *
 * 原话:「关于提示音,我们已经确认了,默认的也可以,或者后面我们提供几个音乐。
 * 目前我们需要添加一个自定义的音效,你给一个添加的窗口。」
 *
 * 【为什么走主机端存盘,不存浏览器本地】桌面版每次启动换随机端口,
 * 浏览器里的 localStorage 跟着换地址就作废 —— 作者加的音频一重启就没了。
 * 跟背景图一个道理,存文件才留得住。
 *
 * 音频单独放一个目录,索引记 { id, name, mime, at }。
 * 页面要播的时候按 id 来取,主持人端按 id 发回去。
 */
let soundsDir = ''
let soundsCache = null
const SOUND_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/
const MAX_SOUND_BYTES = 8 * 1024 * 1024 // 单个音效 8MB 封顶(提示音用不了更大)
// 只收浏览器都能放的常见音频,别的格式一律拒 —— 放不出来的文件不如不收
const SOUND_MIME_BY_EXT = {
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.flac': 'audio/flac',
  '.webm': 'audio/webm',
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = []
    let size = 0
    let done = false
    const finish = () => {
      if (done) return
      done = true
      resolve(Buffer.concat(chunks).toString('utf8'))
    }
    req.on('data', (chunk) => {
      size += chunk.length
      /**
       * 【10-19 01:00 修一个「自定义音效用不了」的真 bug】
       * 原来这里拿 MAX_IMAGE_BYTES(24MB)当闸。音频走 data URL 会被 base64
       * 撑大三分之一,JSON 里再包一层 —— 上限卡得太死,
       * 音频稍大请求就被掐断,页面既收不到成功也收不到失败,就是「添加不上去」。
       * 现在读体上限单独放宽到 64MB(音频/图片都够),真正的大小校验
       * 交给各自的处理函数按类型判(音频 8MB、图片 24MB),报错也明确。
       */
      if (size > MAX_BODY_BYTES) {
        req.destroy()
        return finish()
      }
      chunks.push(chunk)
    })
    req.on('end', finish)
    req.on('error', finish)
  })
}

/** data URL → { mime, buffer } */
function decodeDataUrl(value, maxBytes = MAX_IMAGE_BYTES) {
  if (typeof value !== 'string') return null
  const matched = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(value)
  if (!matched) return null
  const mime = matched[1] || 'application/octet-stream'
  const isBase64 = Boolean(matched[2])
  try {
    const buffer = isBase64
      ? Buffer.from(matched[3], 'base64')
      : Buffer.from(decodeURIComponent(matched[3]), 'utf8')
    if (buffer.length === 0 || buffer.length > maxBytes) return null
    return { mime, buffer }
  } catch {
    return null
  }
}

const MIME_BY_EXT = {
  '.webp': 'image/webp',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
}

export function apply(ctx, config) {
  const stateFile = String(config?.stateFile ?? '').trim()
  const libraryFile = String(config?.libraryFile ?? '').trim()
  const imageDir = String(config?.imageDir ?? '').trim()
  // 自定义音效跟图片同目录(都归插件管),文件名加 sounds- 前缀防撞
  soundsDir = imageDir === '' ? '' : join(dirname(imageDir), 'sounds')

  if (stateFile === '' || libraryFile === '' || imageDir === '') {
    ctx.logger?.warn?.('dsh-skin: 状态文件/图库/图片目录配置不全,换肤设置不会保存')
  }

  let stateCache = null
  let libraryCache = null
  // 图片目录列表缓存:目录里有几千个文件,每张缩略图都 readdir 一遍等于反复全量列目录。
  // null = 没读过;读失败也不缓存(保持 null),让下一次请求重试。
  let imageNamesCache = null

  async function readJson(file, fallback) {
    try {
      return JSON.parse(await readFile(file, 'utf8'))
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        ctx.logger?.warn?.(`dsh-skin: 读 ${file} 失败: ${String(error?.message ?? error)}`)
      }
      return fallback
    }
  }

  /** 先写临时文件再改名:写到一半断电也不会把原文件弄成半截 JSON */
  async function writeJson(file, value) {
    if (file === '') return false
    try {
      await mkdir(dirname(file), { recursive: true })
      const temp = `${file}.tmp`
      await writeFile(temp, JSON.stringify(value, null, 2), 'utf8')
      await rename(temp, file)
      return true
    } catch (error) {
      ctx.logger?.warn?.(`dsh-skin: 写 ${file} 失败: ${String(error?.message ?? error)}`)
      return false
    }
  }

  async function loadState() {
    if (!stateCache) {
      const parsed = await readJson(stateFile, null)
      stateCache = { ...emptyState(), ...(parsed && typeof parsed === 'object' ? parsed : {}) }
    }
    return stateCache
  }

  async function loadLibrary() {
    if (!libraryCache) {
      const parsed = await readJson(libraryFile, [])
      libraryCache = Array.isArray(parsed) ? parsed : []
    }
    return libraryCache
  }

  function sendJson(res, status, value) {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify(value))
  }

  async function safeJson(req) {
    try {
      const raw = await readBody(req)
      return raw ? JSON.parse(raw) : {}
    } catch {
      return {}
    }
  }

  // ── 设置 ──────────────────────────────────────────────
  async function handleState(req, res) {
    const payload = await safeJson(req)
    if (payload?.method !== 'set') return sendJson(res, 200, await loadState())

    const current = await loadState()
    const patch = payload.patch && typeof payload.patch === 'object' ? payload.patch : {}
    const next = { ...current, ...patch }
    if (!['normal', 'focus', 'leisure'].includes(next.mode)) next.mode = 'normal'
    next.activeId = typeof next.activeId === 'string' ? next.activeId : ''
    if (next.wash !== null && next.wash !== undefined) {
      const value = Number(next.wash)
      // 页面封顶 25(作者 10-18 01:20 定),主机端同步封顶,防止旧存档里的大值绕过
      next.wash = Number.isFinite(value) ? Math.min(25, Math.max(0, Math.round(value))) : null
    } else {
      next.wash = null
    }
    if (!['follow', 'dark', 'light'].includes(next.text)) next.text = 'follow'
    // 【10-18 20:45 新增】悬浮球位置和竖图两侧的模糊过渡半径。
    // 这两个主机端也要归一化:页面万一传来 NaN / 负数 / 超大值,不能让屏幕上的球跑到看不见的地方。
    for (const key of ['ballX', 'ballY']) {
      const value = Number(next[key])
      next[key] = Number.isFinite(value) ? Math.round(value) : null
    }
    {
      const value = Number(next.bleed)
      next.bleed = Number.isFinite(value) ? Math.min(64, Math.max(0, Math.round(value))) : 64
    }
    // 【10-19 00:05 提示音】开关只认真/假;音量夹在 0~1;坏值退回默认(关、一半音量)。
    next.soundOn = next.soundOn === true
    {
      const value = Number(next.soundVolume)
      next.soundVolume = Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0.5
    }
    // 【10-19 00:20 自定义音效】空串 = 用内置那声「叮」;否则是自定义音效的 id。
    next.soundId = typeof next.soundId === 'string' ? next.soundId : ''
    // 背景图片随机变换时间:0 = 不轮换,正数 = 分钟。
    // 【10-18 15:45】下限提到 1 分钟。原来允许小数,自检留下的 0.02(1.2 秒)
    // 会导致「背景一直自己换」。作者能选的最小档就是 1 分钟,不存在更小的合法值,
    // 所以这里把小于 1 的一律归零,防止旧存档/异常值让轮换停不下来。
    const rotateValue = Number(next.rotateMinutes)
    if (Number.isFinite(rotateValue) && rotateValue >= 1) {
      next.rotateMinutes = Math.min(14400, rotateValue)
    } else {
      next.rotateMinutes = 0
    }
    if (writeJson(stateFile, next)) stateCache = next
    return sendJson(res, 200, stateCache)
  }

  // ── 图库 ──────────────────────────────────────────────
  async function handleLibrary(req, res) {
    const payload = await safeJson(req)
    const method = payload?.method || 'list'
    const list = await loadLibrary()

    if (method === 'add') {
      const id = String(payload.id ?? '')
      const image = decodeDataUrl(payload.image)
      const thumb = decodeDataUrl(payload.thumb)
      if (!ID_PATTERN.test(id) || !image) return sendJson(res, 400, { error: 'bad image' })
      if (imageDir === '') return sendJson(res, 400, { error: 'no image dir' })
      try {
        await mkdir(imageDir, { recursive: true })
        await writeFile(join(imageDir, `${id}.webp`), image.buffer)
        if (thumb) await writeFile(join(imageDir, `${id}-thumb.webp`), thumb.buffer)
      } catch (error) {
        return sendJson(res, 500, { error: String(error?.message ?? error) })
      }
      // 刚落盘了新图片文件,目录列表缓存已经不认它了 —— 不失效的话这张图会一直 404
      imageNamesCache = null
      const entry = { ...(payload.entry ?? {}), id }
      const at = list.findIndex((item) => item.id === id)
      if (at >= 0) list[at] = entry
      else list.push(entry)
      if (!writeJson(libraryFile, list)) return sendJson(res, 500, { error: 'library write failed' })
      libraryCache = list
      return sendJson(res, 200, { entry, list })
    }

    if (method === 'update') {
      const id = String(payload.id ?? '')
      const at = list.findIndex((item) => item.id === id)
      if (at < 0) return sendJson(res, 404, { error: 'not found' })
      const patch = payload.patch && typeof payload.patch === 'object' ? payload.patch : {}
      // 只让改这几个字段,免得页面把 id / 尺寸之类也改了
      const next = { ...list[at] }
      if (patch.mask === null || typeof patch.mask === 'number') {
        next.mask = patch.mask === null ? null : Math.min(100, Math.max(0, Math.round(patch.mask)))
      }
      // autoMask:尺度调整后老图要能重算(页面启动时统一拉回当前上限内)
      if (typeof patch.autoMask === 'number') {
        next.autoMask = Math.min(25, Math.max(0, Math.round(patch.autoMask)))
      }
      // chatP5 / chatP95:对话区最暗/最亮落点(0-1 相对亮度),自动垫底的输入。
      // darkShare/lightShare/midShare/midLum:切块统计的三色占比 + 灰块平均亮度,
      // 判黑白字的输入(作者 10-18 22:15 亲口给的判据)。
      // 页面按需补算后回写,所以这里是唯一的落盘口子。
      for (const key of ['chatP5', 'chatP95']) {
        const value = Number(patch[key])
        if (Number.isFinite(value)) next[key] = Math.min(1, Math.max(0, value))
      }
      for (const key of ['darkShare', 'lightShare', 'midShare', 'midLum']) {
        const value = Number(patch[key])
        if (Number.isFinite(value)) next[key] = Math.min(1, Math.max(0, value))
      }
      // native = 竖图按原图像素显示(作者 10-18 15:50 定的默认)
      // center = 完整居中;cover = 铺满;blur = 模糊填充;right = 立绘贴侧
      if (['native', 'center', 'cover', 'blur', 'right'].includes(patch.fillMode)) next.fillMode = patch.fillMode
      list[at] = next
      if (!writeJson(libraryFile, list)) return sendJson(res, 500, { error: 'library write failed' })
      libraryCache = list
      return sendJson(res, 200, { entry: next, list })
    }

    if (method === 'renorm') {
      // 尺度调整后,老图存的 autoMask 是旧尺度的值(实测 1387 条全部超标)。
      // 逐条 update 要重写 1387 次索引文件,太慢 —— 这里一次批量改完、只写一次盘。
      const darkOf = Number(payload.darkMask)
      const lightOf = Number(payload.lightMask)
      const cap = Number(payload.cap)
      if (!Number.isFinite(darkOf) || !Number.isFinite(lightOf) || !Number.isFinite(cap)) {
        return sendJson(res, 400, { error: 'renorm needs darkMask/lightMask/cap' })
      }
      let changed = 0
      for (const item of list) {
        const want = item.kind === 'dark' ? darkOf : lightOf
        const capped = Math.min(cap, Math.max(0, Math.round(want)))
        if (item.autoMask === capped) continue
        item.autoMask = capped
        changed += 1
      }
      if (changed > 0) {
        if (!writeJson(libraryFile, list)) return sendJson(res, 500, { error: 'library write failed' })
        libraryCache = list
      }
      return sendJson(res, 200, { changed, list })
    }

    if (method === 'legacy') {
      // 老版本把背景图直接塞在 state.json 里。读出来交给页面走正常入库流程,
      // 页面确认收下了再让页面调 legacy-clear —— 两步走,导入失败不会把老图弄丢。
      const raw = await readJson(stateFile, null)
      if (!raw || typeof raw !== 'object') return sendJson(res, 200, { legacy: null })
      const legacy =
        typeof raw.image === 'string' && raw.image !== ''
          ? { image: raw.image }
          : typeof raw.url === 'string' && raw.url !== ''
            ? { url: raw.url }
            : null
      return sendJson(res, 200, { legacy })
    }

    if (method === 'legacy-clear') {
      const fresh = emptyState()
      if (writeJson(stateFile, fresh)) stateCache = fresh
      return sendJson(res, 200, { ok: true })
    }

    if (method === 'remove') {
      const id = String(payload.id ?? '')
      const keep = list.filter((item) => item.id !== id)
      if (keep.length === list.length) return sendJson(res, 200, { list })
      try {
        if (imageDir !== '' && ID_PATTERN.test(id)) {
          const names = await readdir(imageDir)
          await Promise.all(
            names
              .filter((name) => name === `${id}.webp` || name === `${id}-thumb.webp`)
              .map((name) => rm(join(imageDir, name), { force: true })),
          )
        }
      } catch (error) {
        ctx.logger?.warn?.(`dsh-skin: 删图失败: ${String(error?.message ?? error)}`)
      }
      // 删完文件目录列表就变了,同样要失效,否则已删的图还能继续被读到
      imageNamesCache = null
      if (!writeJson(libraryFile, keep)) return sendJson(res, 500, { error: 'library write failed' })
      libraryCache = keep
      return sendJson(res, 200, { list: keep })
    }

    return sendJson(res, 200, { list })
  }

  /**
   * 自检回传通道:页面端在真实浏览器里测完,把结果 POST 回来存下;
   * 自检脚本再从这里 GET 走。这样自检读的是**真实浏览器**的数据,
   * 不用连 CDP(桌面版没开调试口,连不上)。
   *   POST {results:[...], at:...}  → 存
   *   GET  (任意)                    → 取最近一次
   */
  const DIAG_MAX_AGE_MS = 10 * 60 * 1000
  let diagCache = null

  async function handleDiag(req, res) {
    if (req.method === 'POST') {
      const payload = await safeJson(req)
      diagCache = { at: Date.now(), results: Array.isArray(payload?.results) ? payload.results : [] }
      return sendJson(res, 200, { ok: true })
    }
    if (!diagCache) return sendJson(res, 200, { at: null, results: [] })
    const age = Date.now() - diagCache.at
    return sendJson(res, 200, {
      at: diagCache.at,
      ageMs: age,
      stale: age > DIAG_MAX_AGE_MS,
      results: diagCache.results,
    })
  }

  // ── 图片本体 ──────────────────────────────────────────
  async function handleImage(req, res) {
    if (imageDir === '') return sendJson(res, 503, { error: 'no image dir' })
    let parsed
    try {
      parsed = new URL(req.url ?? '/', 'http://local')
    } catch {
      return sendJson(res, 400, { error: 'bad url' })
    }
    const id = parsed.searchParams.get('id') ?? ''
    const thumb = parsed.searchParams.get('thumb') === '1'
    if (!ID_PATTERN.test(id)) return sendJson(res, 400, { error: 'bad id' })
    let names
    if (imageNamesCache === null) {
      try {
        names = await readdir(imageDir)
        imageNamesCache = names
      } catch {
        // 目录还没建好之类的情况不缓存空值,保持 null,下一次请求重新读
        return sendJson(res, 404, { error: 'not found' })
      }
    } else {
      names = imageNamesCache
    }
    const wanted = thumb ? `${id}-thumb.webp` : `${id}.webp`
    if (!names.includes(wanted)) return sendJson(res, 404, { error: 'not found' })
    try {
      const buffer = await readFile(join(imageDir, wanted))
      const ext = wanted.slice(wanted.lastIndexOf('.'))
      res.writeHead(200, {
        'content-type': MIME_BY_EXT[ext] ?? 'application/octet-stream',
        'cache-control': 'no-cache',
        'content-length': String(buffer.length),
      })
      res.end(buffer)
    } catch (error) {
      sendJson(res, 500, { error: String(error?.message ?? error) })
    }
  }

  /**
   * 提示音通道:页面每隔一秒来问一次「有没有任务刚完成」。
   * GET → { at, kind }:at 是完成的时刻(0 = 没有),kind 是 'done'。
   * 页面记着上次的 at,不一样才响 —— 这样同一件事不会响第二遍。
   */
  async function handleBell(req, res) {
    if (req.method === 'POST') {
      const payload = await safeJson(req)
      // 也允许页面自己触发(比如面板上试听那一声)
      if (payload?.kind === 'test') {
        lastDoneAt = Date.now()
        lastDoneKind = 'test'
      }
      return sendJson(res, 200, { ok: true })
    }
    return sendJson(res, 200, { at: lastDoneAt, kind: lastDoneKind })
  }

  /**
   * ═══ 自定义音效(作者 10-19 00:20 要的「添加窗口」)═══
   *
   *   POST {method:"add", id, name, ext, data}  → 存一个音频文件
   *   POST {method:"remove", id}                → 删一个
   *   GET  (任意)                               → { list:[{id,name,ext,at}] }
   *
   * 音频本体单独存目录,索引单独一个 JSON —— 跟图库一个套路。
   */
  async function loadSounds() {
    if (!soundsCache) {
      const parsed = await readJson(join(soundsDir, 'index.json'), [])
      soundsCache = Array.isArray(parsed) ? parsed : []
    }
    return soundsCache
  }

  async function handleSounds(req, res) {
    if (soundsDir === '') return sendJson(res, 503, { error: 'no sounds dir' })
    const payload = await safeJson(req)
    const method = payload?.method || 'list'
    const list = await loadSounds()

    if (method === 'add') {
      const id = String(payload.id ?? '')
      const ext = String(payload.ext ?? '').toLowerCase()
      const mime = SOUND_MIME_BY_EXT[ext]
      const audio = decodeDataUrl(payload.data, MAX_SOUND_BYTES)
      if (!SOUND_ID_PATTERN.test(id) || !mime || !audio) {
        return sendJson(res, 400, { error: 'bad sound' })
      }
      if (audio.buffer.length > MAX_SOUND_BYTES) {
        return sendJson(res, 400, { error: 'sound too large' })
      }
      try {
        await mkdir(soundsDir, { recursive: true })
        await writeFile(join(soundsDir, `${id}${ext}`), audio.buffer)
      } catch (error) {
        return sendJson(res, 500, { error: String(error?.message ?? error) })
      }
      const entry = { id, name: String(payload.name ?? id), ext, mime, at: Date.now() }
      const at = list.findIndex((item) => item.id === id)
      if (at >= 0) list[at] = entry
      else list.push(entry)
      if (!writeJson(join(soundsDir, 'index.json'), list)) {
        return sendJson(res, 500, { error: 'sounds write failed' })
      }
      soundsCache = list
      return sendJson(res, 200, { entry, list })
    }

    if (method === 'remove') {
      const id = String(payload.id ?? '')
      const at = list.findIndex((item) => item.id === id)
      if (at < 0) return sendJson(res, 404, { error: 'not found' })
      const entry = list[at]
      list.splice(at, 1)
      try {
        await rm(join(soundsDir, `${id}${entry.ext}`), { force: true })
      } catch {
        /* 文件本来就不在也无所谓 */
      }
      if (!writeJson(join(soundsDir, 'index.json'), list)) {
        return sendJson(res, 500, { error: 'sounds write failed' })
      }
      soundsCache = list
      return sendJson(res, 200, { list })
    }

    return sendJson(res, 200, { list })
  }

  /** 音频本体:GET /dsh-skin/sound?id=xxx → 文件流 */
  async function handleSoundFile(req, res) {
    if (soundsDir === '') return sendJson(res, 503, { error: 'no sounds dir' })
    let parsed
    try {
      parsed = new URL(req.url ?? '/', 'http://local')
    } catch {
      return sendJson(res, 400, { error: 'bad url' })
    }
    const id = parsed.searchParams.get('id') ?? ''
    if (!SOUND_ID_PATTERN.test(id)) return sendJson(res, 400, { error: 'bad id' })
    const list = await loadSounds()
    const entry = list.find((item) => item.id === id)
    if (!entry) return sendJson(res, 404, { error: 'not found' })
    try {
      const buffer = await readFile(join(soundsDir, `${id}${entry.ext}`))
      res.writeHead(200, {
        'content-type': entry.mime,
        'cache-control': 'no-cache',
        'content-length': String(buffer.length),
      })
      res.end(buffer)
    } catch (error) {
      sendJson(res, 500, { error: String(error?.message ?? error) })
    }
  }

  const routes = [
    { kind: 'exact', path: STATE_PATH, handler: handleState },
    { kind: 'exact', path: LIBRARY_PATH, handler: handleLibrary },
    { kind: 'exact', path: IMAGE_PATH, handler: handleImage },
    { kind: 'exact', path: DIAG_PATH, handler: handleDiag },
    { kind: 'exact', path: BELL_PATH, handler: handleBell },
    { kind: 'exact', path: SOUNDS_PATH, handler: handleSounds },
    { kind: 'exact', path: SOUND_FILE_PATH, handler: handleSoundFile },
  ]
  const disposers = routes.map((route) => ctx.webServer.register(route))

  /**
   * 听「运行状态变了」这个广播:任务开始是「正在跑」,跑完变回「空闲」。
   * 只有「正在跑过 → 回到空闲」才算一次**完成**,刚启动那次空闲不算。
   *
   * 【为什么不用会话编号去配对】我没能确认那个编号字段的确切名字,
   * 猜错就永远匹配不上、一声不响。所以这里只看状态本身:
   * 出现过「正在跑」就记一笔,下一次「空闲」就响一声并清掉这一笔。
   * 多会话并行时会有轻微偏差,但不会哑掉 —— 宁可错响一次,不要永不响。
   *
   * 【为什么要先判断 ctx.on 在不在】万一这个版本没有这个监听能力,
   * 直接调用会让主机端启动就抛错 → 整个换肤插件挂掉 → 作者连背景都没了。
   * 所以先确认是函数再用,拿不到就安静跳过,换肤不受影响。
   */
  let offStatus = null
  let sawRunning = false
  if (typeof ctx?.on === 'function') {
    try {
      offStatus = ctx.on('agent/status', (payload) => {
        try {
          const status = payload?.status
          if (status === 'running') {
            sawRunning = true
            return
          }
          if (status === 'idle' && sawRunning) {
            sawRunning = false
            lastDoneAt = Date.now()
            lastDoneKind = 'done'
          }
        } catch {
          /* 单次回调出错不影响换肤 */
        }
      })
    } catch {
      offStatus = null
    }
  }

  ctx.effect(
    () => () => {
      for (const dispose of disposers) {
        try {
          dispose()
        } catch {
          /* 已经没了就算了 */
        }
      }
      try {
        if (typeof offStatus === 'function') offStatus()
      } catch {
        /* 摘监听失败无所谓 */
      }
    },
    'dsh-skin: 换肤接口',
  )
}
