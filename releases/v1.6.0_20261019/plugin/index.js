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

import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

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
/**
 * ═══ 音效的总量上限(作者 10-19 13:55 在 A/B/C/D 里选的 B)═══
 *
 * 原话:「音效支持批量添加,目前最大支持多大的文件,总文件多大?评估过了吗?」
 * 查完发现:单个 8MB 是写死的,但**总量一条上限都没有**(加到磁盘满为止),
 * 而且「批量添加」其实不支持 —— 选多个只会吃第一个,其余静默丢掉。
 * 评估给作者的四个选项里他选了 B:单个 8MB + 总容量 200MB + 最多 30 条。
 *
 * 【为什么要有总量上限】磁盘现在够(600 多 GB),真正的风险是误选一个装满音乐的
 * 大文件夹 —— 几百 MB 直接进 E 盘,以后备份/同步都会跟着放大。
 * 200MB 按提示音算差不多是 2000~6000 条普通音效,给 30 条封顶就更宽裕了;
 * 两个数是「防误操作」的闸,不是容量规划。
 */
const MAX_SOUND_COUNT = 30
const MAX_SOUND_TOTAL_BYTES = 200 * 1024 * 1024
/**
 * 遮罩（明度/透明度）的封顶，跟页面里那份 `MAX_WASH` 必须一致。
 * 作者 10-19 19:2x：「透明度你应该调整到 0~40%」。
 */
const MAX_WASH = 40

/**
 * ═══ 自带的四个小音效 ═══
 *
 * 【10-19 21:4x 作者】「默认的音效，可以选择我们目前拥有的这几个带上去」
 * 【10-19 22:4x 作者再确认】「打包上传的时候要把目前我们的几个默认音频一起上传」→ 原本 9 条全带。
 * 【10-20 02:5x 作者定】「为了防止品牌风险，你把那几条含 CS 跟 QQ 的音效的品牌撤掉，其他的放在里面」
 *   → **撤掉 5 条品牌资产**（cs-battle / cs-go / cs-knife / cs-sfx / qq-ding），**保留 4 条**（叮 / 咚咚 / 丢硬币 / 拔剑）。
 *   老装机里已铺好的那 5 条，启动时会被 `retireBrandSounds()` 清掉 —— 只动插件自己铺的条目，不碰用户自己加的。
 *
 * 铺法：**只在首次（sounds/index.json 还不存在时）铺一次**，之后就是普通音效（能删能选能试听）。
 */
const BUILTIN_SOUNDS = [
  { id: 'snd-builtin-ding', file: 'ding.mp3', name: '叮的一声', ext: '.mp3', mime: 'audio/mpeg' },
  { id: 'snd-builtin-dong', file: 'dong.mp3', name: '咚咚', ext: '.mp3', mime: 'audio/mpeg' },
  { id: 'snd-builtin-coin', file: 'coin.mp3', name: '丢硬币', ext: '.mp3', mime: 'audio/mpeg' },
  { id: 'snd-builtin-sword', file: 'sword-draw.mp3', name: '拔剑', ext: '.mp3', mime: 'audio/mpeg' },
]

/** 曾经带过、现在撤掉的品牌资产：老装机里若还留着就清掉（只动插件自己铺的条目） */
const RETIRED_BUILTIN = new Set([
  'snd-builtin-cs-battle',
  'snd-builtin-cs-go',
  'snd-builtin-cs-knife',
  'snd-builtin-cs-sfx',
  'snd-builtin-qq-ding',
])

/** 插件自己所在目录（内置音效从这儿取） */
const PLUGIN_DIR = dirname(fileURLToPath(import.meta.url))
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
  /**
   * 【10-19 14:0x 顺手清一个隐患】soundsCache / soundsDir 是**模块级**变量
   * （不在 apply 里面的局部变量），重新装配时如果不清，就会一直用上一轮读到的
   * 旧列表 —— 表现是「明明加过了/删过了，面板上还是老样子」这类静默假数据。
   * 现在每次 apply 都从盘上重新读一次。
   */
  soundsCache = null

  if (stateFile === '' || libraryFile === '' || imageDir === '') {
    ctx.logger?.warn?.('dsh-skin: 状态文件/图库/图片目录配置不全,换肤设置不会保存')
  }

  // 首次安装：把自带音效铺进 sounds/（异步、失败不打扰；见 seedBuiltinSounds 的注释）
  void seedBuiltinSounds()
  // 老装机清理：把已经撤掉的品牌音效从 sounds/ 里清掉（只动插件自己铺的条目）
  void retireBrandSounds()

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
      /**
       * 主机端同步封顶，防止旧存档/异常值绕过页面。
       * 【10-19 19:2x 作者】「透明度你应该调整到 0~40%」—— 上限从 25 提到 40。
       * 【两边必须一致】页面里那份叫 MAX_WASH，也是 40；改这里不改那里，
       * 会出现「拖到 40、存进去被夹回 25、下次打开自己弹回去」的怪事。
       * 判据：`verify/mode_wash_check.cjs` 对这两个数。
       */
      next.wash = Number.isFinite(value) ? Math.min(MAX_WASH, Math.max(0, Math.round(value))) : null
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
    // 【10-19 21:1x 中英双语】面板语言只认 'zh' / 'en';默认(老存档/坏值)一律中文。
    next.lang = next.lang === 'en' ? 'en' : 'zh'
    // 【10-19 21:4x 新手引导】只看 true:老存档没这字段 → 当作没看过(第一次装的人会看到引导)。
    next.onboarded = next.onboarded === true
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
    if (await writeJson(stateFile, next)) stateCache = next
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
      if (!(await writeJson(libraryFile, list))) return sendJson(res, 500, { error: 'library write failed' })
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
        next.autoMask = Math.min(MAX_WASH, Math.max(0, Math.round(patch.autoMask)))
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
      if (!(await writeJson(libraryFile, list))) return sendJson(res, 500, { error: 'library write failed' })
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
        if (!(await writeJson(libraryFile, list))) return sendJson(res, 500, { error: 'library write failed' })
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
      if (await writeJson(stateFile, fresh)) stateCache = fresh
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
      if (!(await writeJson(libraryFile, keep))) return sendJson(res, 500, { error: 'library write failed' })
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
      /**
       * ═══ 【10-19 19:2x 修「任务完成了不响」的真凶】═══
       * 以前这里只回 `{ ok: true }`，而**页面是用 POST 来问的** ——
       * 页面拿到的是一个没有 `at` 字段的对象，`Number(undefined) || 0` 恒等于 0，
       * 于是「时间戳变了没有」永远判为没变，**内置叮和自定义音效都一次不会响**。
       * 试听能响（那是页面自己直接播的），所以一直没被发现：
       * 看起来像"设置里那个开关没用"，其实是协议对不上。
       *
       * 现在 POST 也把 at/kind 一起回 —— 页面无论用 GET 还是 POST 都能问到。
       */
      return sendJson(res, 200, { ok: true, at: lastDoneAt, kind: lastDoneKind })
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

  /**
   * 首次安装时把插件自带的三个小音效铺进 sounds/（只在索引文件还不存在时铺一次）。
   * 失败一律不管：铺不上顶多没有现成音效，绝不能让换肤插件起不来。
   */
  async function seedBuiltinSounds() {
    if (soundsDir === '') return
    try {
      const exists = await stat(join(soundsDir, 'index.json')).then(() => true, () => false)
      if (exists) return // 已经有音效（哪怕是空列表）就不动
      await mkdir(soundsDir, { recursive: true })
      const seeded = []
      for (const item of BUILTIN_SOUNDS) {
        try {
          const buffer = await readFile(join(PLUGIN_DIR, 'assets', 'sounds', item.file))
          await writeFile(join(soundsDir, `${item.id}${item.ext}`), buffer)
          seeded.push({ id: item.id, name: item.name, ext: item.ext, mime: item.mime, bytes: buffer.length, at: Date.now() })
        } catch {
          /* 这一个铺不上就跳过 */
        }
      }
      if (seeded.length === 0) return
      await writeJson(join(soundsDir, 'index.json'), seeded)
      soundsCache = seeded
      ctx.logger?.info?.(`dsh-skin: 已铺好 ${seeded.length} 个自带音效`)
    } catch (error) {
      ctx.logger?.warn?.(`dsh-skin: 铺自带音效失败: ${String(error?.message ?? error)}`)
    }
  }

  /**
   * 撤掉旧版本铺进去的品牌音效（cs-* / qq-*）。启动时清一次，只动插件自己铺的条目。
   * 【10-20 02:5x 作者】「为了防止品牌风险，把那几条含 CS 跟 QQ 的音效撤掉，其他的放在里面」
   * —— CS / QQ 是可识别品牌资产，公开仓库不带了；老装机里已经铺的也得清掉，否则风险还在本机上。
   * 失败一律不管：顶多没清干净，绝不能让换肤插件起不来。
   */
  async function retireBrandSounds() {
    if (soundsDir === '') return
    try {
      const list = await loadSounds()
      const kept = []
      let removed = 0
      for (const entry of list) {
        if (RETIRED_BUILTIN.has(entry?.id)) {
          await rm(join(soundsDir, `${entry.id}${entry.ext}`), { force: true })
          removed += 1
          continue
        }
        kept.push(entry)
      }
      if (removed === 0) return
      await writeJson(join(soundsDir, 'index.json'), kept)
      soundsCache = kept
      ctx.logger?.info?.(`dsh-skin: 已清掉 ${removed} 条品牌音效`)
    } catch (error) {
      ctx.logger?.warn?.(`dsh-skin: 清品牌音效失败: ${String(error?.message ?? error)}`)
    }
  }

  /**
   * 这条音效占多少字节。
   * 【为什么要兼容老索引】`bytes` 是 10-19 13:55 才加进索引的字段,
   * 之前存的条目没有 —— 没有就现量一次文件,免得总量算成 0、闸门形同虚设。
   */
  async function soundBytes(entry) {
    const known = Number(entry?.bytes)
    if (Number.isFinite(known) && known > 0) return known
    try {
      const info = await stat(join(soundsDir, `${entry.id}${entry.ext}`))
      return Number(info.size) || 0
    } catch {
      return 0
    }
  }

  /** 当前占用:给页面显示「已用多少 / 上限多少」,也给自己当闸门 */
  async function soundUsage(list) {
    let used = 0
    for (const item of list) used += await soundBytes(item)
    return {
      used,
      total: MAX_SOUND_TOTAL_BYTES,
      count: list.length,
      maxCount: MAX_SOUND_COUNT,
      maxBytes: MAX_SOUND_BYTES,
    }
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
      const audio = decodeDataUrl(payload.data, MAX_BODY_BYTES)
      if (!SOUND_ID_PATTERN.test(id) || !mime || !audio) {
        return sendJson(res, 400, { error: 'bad sound' })
      }
      /**
       * 【10-19 14:0x 修一处「报错报得不对」】以前这里 decodeDataUrl 就按 8MB 解，
       * 超了直接返回 null，外面只能报一句「bad sound」。现在先按读体上限解出来、
       * 单独判大小 —— 作者看到的才是「单个音效最多 8MB」这句人话。
       */
      if (audio.buffer.length > MAX_SOUND_BYTES) {
        return sendJson(res, 400, { error: `单个音效最多 ${Math.round(MAX_SOUND_BYTES / 1024 / 1024)}MB`, code: 'big' })
      }
      /**
       * ═══ 总量两道闸(作者 10-19 13:55 选的 B:30 条 / 200MB)═══
       * 先算「加进去之后」会怎样,再决定收不收 —— 收完再报错就得回滚文件,不如先拦。
       * 覆盖同一条(同一个 id)时,把旧的占用先减掉,不然改个文件也会撞墙。
       */
      const existingAt = list.findIndex((item) => item.id === id)
      const existingBytes = existingAt >= 0 ? await soundBytes(list[existingAt]) : 0
      if (existingAt < 0 && list.length >= MAX_SOUND_COUNT) {
        return sendJson(res, 400, {
          error: `音效最多 ${MAX_SOUND_COUNT} 条,现在已经有 ${list.length} 条 —— 先删几条再加`,
          code: 'full',
        })
      }
      const usageBefore = await soundUsage(list)
      const after = usageBefore.used - existingBytes + audio.buffer.length
      if (after > MAX_SOUND_TOTAL_BYTES) {
        return sendJson(res, 400, {
          error:
            `音效总容量上限 ${Math.round(MAX_SOUND_TOTAL_BYTES / 1024 / 1024)}MB,` +
            `现在已用 ${(usageBefore.used / 1024 / 1024).toFixed(1)}MB,这个文件放不下 —— 先删几条再加`,
          code: 'space',
        })
      }
      try {
        await mkdir(soundsDir, { recursive: true })
        await writeFile(join(soundsDir, `${id}${ext}`), audio.buffer)
      } catch (error) {
        return sendJson(res, 500, { error: String(error?.message ?? error) })
      }
      const entry = { id, name: String(payload.name ?? id), ext, mime, bytes: audio.buffer.length, at: Date.now() }
      if (existingAt >= 0) list[existingAt] = entry
      else list.push(entry)
      if (!(await writeJson(join(soundsDir, 'index.json'), list))) {
        return sendJson(res, 500, { error: 'sounds write failed' })
      }
      soundsCache = list
      return sendJson(res, 200, { entry, list, usage: await soundUsage(list) })
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
      if (!(await writeJson(join(soundsDir, 'index.json'), list))) {
        return sendJson(res, 500, { error: 'sounds write failed' })
      }
      soundsCache = list
      return sendJson(res, 200, { list, usage: await soundUsage(list) })
    }

    return sendJson(res, 200, { list, usage: await soundUsage(list) })
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
   * ═══ 听「运行状态变了」这个广播：开始是 running、跑完变回 idle ═══
   *
   * 【10-19 20:4x 作者：「有的时候任务还没跑完，但它就已经声音提醒你了，
   *  基本上过一两分钟任务才结束，这种情况不多见」】
   *
   * 查出来的两个原因（都会造成"提前响"）：
   *
   * ① **空闲 ≠ 干完了。** 应用里 agent 的状态是这样算的：
   *      `status = phase.kind === 'idle' || phase.kind === 'maintenance' ? 'idle' : 'running'`
   *    也就是说**维护阶段（maintenance）也报成 idle** —— 而"压缩上下文/溢出恢复"
   *    这类维护正是在一轮任务**干到一半**时跑的（应用自己的注释说：
   *    "Wait on durable events such as turn/end … Do not poll agent/status"）。
   *    于是 running → idle(维护) 就骗着我们响了一声，等真干完（1~2 分钟后）又响一声。
   *
   * ② **一台机器上不止一个 agent。** 这个广播是**所有 agent** 的（子 agent、别的会话都算）。
   *    子 agent 干完了 → 也报 idle → 我们响了，可作者等的那件事还在跑。
   *
   * 【现在的判断】三件事一起看：
   *   a) 用 `payload.phase?.kind === 'maintenance'` 把"维护中的假空闲"排除掉
   *      （拿不到这个字段也不怕，还有 b/c 兜着）；
   *   b) **按 agent 记账**：谁在跑就往集合里加谁，谁空闲就把谁摘掉 ——
   *      只有「所有 agent 都不在跑了」才算一次完成（子 agent 先完不响、主任务完才响）；
   *   c) **静一静再响**：所有 agent 都空闲后再等 `bellSettleMs`（默认 3 秒），
   *      这期间任何一个 agent 又跑起来就取消 —— 短促抖动不会响。
   *
   * 【为什么要先判断 ctx.on 在不在】万一这个版本没有这个监听能力，
   * 直接调用会让主机端启动就抛错 → 整个换肤插件挂掉 → 作者连背景都没了。
   * 所以先确认是函数再用，拿不到就安静跳过，换肤不受影响。
   */
  const BELL_SETTLE_MS = Number(config?.bellSettleMs) > 0 ? Number(config.bellSettleMs) : 3000
  let offStatus = null
  let offApproval = null
  let offQuestion = null
  const runningAgents = new Set()
  let sawRunning = false
  let settleTimer = null
  const cancelSettle = () => {
    if (settleTimer === null) return
    clearTimeout(settleTimer)
    settleTimer = null
  }
  if (typeof ctx?.on === 'function') {
    try {
      offStatus = ctx.on('agent/status', (payload) => {
        try {
          const status = payload?.status
          const who = String(payload?.id ?? payload?.agent?.id ?? 'unknown')
          if (status === 'running') {
            sawRunning = true
            cancelSettle() // 又跑起来了：刚才那次"都空闲"作废
            runningAgents.add(who)
            return
          }
          if (status !== 'idle') return
          // 维护阶段的 idle 不算干完（压缩上下文就发生在这儿）
          if (payload?.phase?.kind === 'maintenance' || payload?.agent?.phase?.kind === 'maintenance') return
          runningAgents.delete(who)
          if (!sawRunning) return
          if (runningAgents.size > 0) return // 还有别人在跑（子 agent / 别的会话），先别响
          cancelSettle()
          settleTimer = setTimeout(() => {
            settleTimer = null
            if (runningAgents.size > 0) return
            lastDoneAt = Date.now()
            lastDoneKind = 'done'
          }, BELL_SETTLE_MS)
        } catch {
          /* 单次回调出错不影响换肤 */
        }
      })
    } catch {
      offStatus = null
    }
    /**
     * ═══ 【10-19 22:1x 作者：「当出现需要人工判断的时候，也需要加提示音」】═══
     *
     * 「需要人工判断」在这套应用里有两个入口，两个都听：
     *
     * ① `approval/asked` —— **落地会话事件**（在 `KNOWN_SESSION_EVENT_TYPES` 里），
     *    载荷 `{ id, toolName, callId?, reason? }`：某个工具要作者批准才能往下走。
     *    它不会改 agent 状态（还是 running），所以「完成」那条路根本看不见它。
     *
     * ② `user-questions/request` —— **waterfall** 事件：某个工具要作者**回答问题**
     *    （就是插件里那个「弹出选项让人选」的流程）。
     *    【关键】waterfall 的听众必须把 `next()` 往下传 —— 我们只听、不改，
     *    回调里先记一笔再原样 `return next()`；宁可这一声不响，也绝不能把
     *    作者要回答的那个问题吞掉。
     *
     * 两种都是「卡住等你」，**立刻响**（不走「全部空闲 + 静 3 秒」那套：
     * 那套是防"任务没干完就报完成"，而这里是明确等人）。
     */
    const ringNeedsHuman = (why) => {
      try {
        cancelSettle()
        lastDoneAt = Date.now()
        lastDoneKind = 'ask'
        ctx.logger?.info?.(`dsh-skin: 需要作者判断（${why}）`)
      } catch {
        /* 记不上也不影响换肤 */
      }
    }
    if (typeof ctx?.on === 'function') {
      try {
        offApproval = ctx.on('session/event', (session, event) => {
          try {
            if (event?.type === 'approval/asked') ringNeedsHuman('approval/asked')
          } catch {
            /* 单次回调出错不影响换肤 */
          }
        })
      } catch {
        offApproval = null
      }
      try {
        offQuestion = ctx.on('user-questions/request', (request, next) => {
          try {
            ringNeedsHuman('user-questions/request')
          } catch {
            /* 听漏一声没关系 */
          }
          // ★ 必须原样往下传：这是 waterfall，吞掉就等于把问题藏了
          return typeof next === 'function' ? next() : undefined
        })
      } catch {
        offQuestion = null
      }
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
      cancelSettle() // 卸载时别把定时器留在那儿
      for (const off of [offStatus, offApproval, offQuestion]) {
        try {
          if (typeof off === 'function') off()
        } catch {
          /* 摘监听失败无所谓 */
        }
      }
    },
    'dsh-skin: 换肤接口',
  )
}
