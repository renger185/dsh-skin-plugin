/**
 * dsh-skin — 换肤插件 · 主机端(Host half)
 *
 * 干两件事:
 *   1. 给页面开本机接口,把换肤设置和图库存成文件。
 *   2. 按 id 把存好的背景图发回给页面。
 *
 * 为什么要主机端存盘:桌面版每次启动换一个随机端口,浏览器里的 localStorage /
 * IndexedDB 跟着换了地址就作废,boss刚设的背景一重启就没了。走文件才留得住。
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

import { mkdir, readFile, readdir, rename, rm, stat, writeFile, copyFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
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
/**
 * ═══ 彩蛋：渠道限流贴纸的数据源 ═══
 *
 * 【2026-10-20 boss】把「渠道限流」做成悬浮球旁边的毛玻璃贴纸，
 * 界面上**一个说明字都不给**（不写使用说明、不写引导、不做功能介绍），
 * 但代码在。交互：单击悬浮球 3 次浮现，再单击 3 次关闭；贴纸右上角有个「叉」可直接关。
 *
 * 这里只负责**把数据读出来**，渲染全在页面端。
 * 数据源是 Channel Pack 插件写的状态文件（它才是真正记限流的那一方，
 * 我们只是抄一份出来看）—— 这份台账由 `渠道限流台账维护脚本` 维护。
 *
 * ⚠️ 读不到就返回空数组，**绝不抛错、绝不猜**：
 *   贴纸是彩蛋，读不到数据时它就该是空的，不能把整个插件带崩。
 */
const CHANNEL_LIMIT_PATH = '/dsh-skin/channel-limits'
/**
 * ═══ 更新检查（【10-22 08:0x boss选 B】）═══
 *
 * boss问：「别人下载了 GitHub 上的插件，我们更新之后，他会收到升级的通知吗」
 * 查完的答案是**不会**，三个原因都实测过：
 *   ① 插件自身没有任何版本检查（全文件搜 checkUpdate/latestVersion 零命中）；
 *   ② GitHub 只通知"watch 了 Release 的人"，跟"下载过"没关系；
 *   ③ DSH 应用**有**「有新版本 / 可更新」徽标，但它只认**它自己的插件市场目录**，
 *      我们不在那个目录里（目录里那条 `dsh-skin-market` 是别人的另一个插件）。
 * ⇒ 只能自己查：主机端去问远端仓库的版本，页面在面板里提示一行。
 *
 * 数据源按顺序试（谁通用谁）：
 *   ① jsDelivr CDN —— 国内通常可达
 *   ② GitHub contents API —— `raw.githubusercontent.com` 在部分网络下不通**（本机实测就不通）**，
 *      所以不能把它当唯一来源
 * 没配置 / 全都失败 → 静默返回 `ok:false`，页面**什么都不显示**。
 *   更新提示是加分项，不能因为没网就弹个错去打扰boss。
 */
const UPDATE_CHECK_PATH = '/dsh-skin/update-check'
/** 推荐项目（boss自己的项目）—— 取 Star / Fork / 最近提交的真数字 */
const PROJECTS_PATH = '/dsh-skin/projects'
/**
 * 【10-22 09:0x boss】自动更新的三步，各一个接口：
 *   ① update-manifest —— 读远端那份发布清单（带哈希）
 *   ② update-download —— **只下载到旁边的暂存目录**，不碰现装的那份
 *   ③ update-apply    —— **用户点了确认才替换**（先备份，失败自动回滚）
 */
const UPDATE_MANIFEST_PATH = '/dsh-skin/update-manifest'
const UPDATE_DOWNLOAD_PATH = '/dsh-skin/update-download'
const UPDATE_APPLY_PATH = '/dsh-skin/update-apply'
const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/
const MAX_IMAGE_BYTES = 24 * 1024 * 1024 // 单张 24MB 封顶,挡住误传的离谱文件
/**
 * 读请求体的上限,单独设、比任何单个文件的封顶都大。
 * data URL 会被 base64 撑大三分之一,再套一层 JSON —— 按"文件大小"卡这里
 * 会把合法的大音频误杀(boss 01:00 报「自定义音效添加不上去」就是这个原因)。
 * 真正的大小校验在各自的处理函数里做(音频 8MB、图片 24MB)。
 */
const MAX_BODY_BYTES = 64 * 1024 * 1024

/** 设置的默认值:文字颜色默认跟随主题,遮罩默认交给图片自己算 */
function emptyState() {
  /**
   * 【10-22 00:3x boss】加 `lastWallId`：双击右键切回「上次那张」要能**跨重启**记住。
   * 不存盘的话重启后退化成图库第一张 —— 那就不是"自定义快捷切换"了。
   */
  return { activeId: '', wash: null, text: 'follow', mode: 'normal', rotateMinutes: 0, ballX: null, ballY: null, bleed: 64, soundOn: false, soundVolume: 0.5, soundId: '', lastWallId: '' }
}

/**
 * ═══ 任务完成提示音(boss 10-18 23:45 在 A/B/C/D 里选了 A)═══
 *
 * boss原话:「任务完成后可以有音效提示」。A 案 = 代码合成一声短「叮」,
 * 不用音频文件、不联网,面板开关**默认关**。
 *
 * 为什么走「页面来问」而不是「主机推」:
 * 主机端拿不到界面,声音只能在页面那一半放。两边本来就用本机接口说话,
 * 所以这里记下「最近一次完成的时刻」,页面每秒来问一次 —— 开销可以忽略。
 */
let lastDoneAt = 0
let lastDoneKind = 'done'
/**
 * 【10-20 20:1x】最近几次提示音判定的原因（留痕用）。
 * 放在这儿是为了**函数级最外层声明** —— B 方案里 `handleBell` / `scheduleDone` /
 * `fireDone` / `ringNeedsHuman` 都要用它，挪来挪去会踩 const 暂时性死区
 * （23:18 那次「选图片没反应」就是这个坑，改多处共用的变量一开始就声明在最高层）。
 */
const bellTrace = []
const trace = (why) => {
  bellTrace.unshift({ at: Date.now(), why })
  if (bellTrace.length > 10) bellTrace.length = 10
}

/**
 * ═══ 自定义音效(boss 10-19 00:20 要的)═══
 *
 * 原话:「关于提示音,我们已经确认了,默认的也可以,或者后面我们提供几个音乐。
 * 目前我们需要添加一个自定义的音效,你给一个添加的窗口。」
 *
 * 【为什么走主机端存盘,不存浏览器本地】桌面版每次启动换随机端口,
 * 浏览器里的 localStorage 跟着换地址就作废 —— boss加的音频一重启就没了。
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
 * ═══ 音效的总量上限(boss 10-19 13:55 在 A/B/C/D 里选的 B)═══
 *
 * 原话:「音效支持批量添加,目前最大支持多大的文件,总文件多大?评估过了吗?」
 * 查完发现:单个 8MB 是写死的,但**总量一条上限都没有**(加到磁盘满为止),
 * 而且「批量添加」其实不支持 —— 选多个只会吃第一个,其余静默丢掉。
 * 评估给boss的四个选项里他选了 B:单个 8MB + 总容量 200MB + 最多 30 条。
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
 * boss 10-19 19:2x：「透明度你应该调整到 0~40%」。
 */
const MAX_WASH = 40

/**
 * ═══ 自带的四个小音效 ═══
 *
 * 【10-19 21:4x boss】「默认的音效，可以选择我们目前拥有的这几个带上去」
 * 【10-19 22:4x boss再确认】「打包上传的时候要把目前我们的几个默认音频一起上传」→ 原本 9 条全带。
 * 【10-20 02:5x boss定】「为了防止品牌风险，你把那几条含 CS 跟 QQ 的音效的品牌撤掉，其他的放在里面」
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
  /**
   * 彩蛋：渠道限流贴纸的数据源。
   * ⚠️ 路径**不写死**，从配置来（跟 stateFile / libraryFile 一个规矩）——
   *    写死的路径一旦搬目录就静默失效，贴纸会悄悄变成空的，没人知道为什么。
   *    读不到就当没数据，贴纸空着，不报错、不影响插件其它功能。
   */
  const channelLimitFile = String(config?.channelLimitFile ?? '').trim()
  /**
   * 【10-21 22:2x boss】「有些模型已经报 429 错误或者接口不可用了，但贴纸里并没有记录」
   *
   * → 贴纸原来只认「有解禁时刻的限流」这一种状态，剩下全漏了。
   *   现在要多读一份 **Channel Pack 的运行时账本**，把「今天真报过错」的模型
   *   也摆到贴纸的第二张表里（表头写「不可用」）。
   *
   * 数据源目录（DSH 的 Channel Pack 插件自己维护）：
   *   state.json        —— 账号（启用/凭据到期）+ disabledModels（模型黑名单）
   *   token-ledger.json —— 今天每个模型请求几次 / 失败几次
   *   dead-models.json  —— 已被实证「模型不存在」的模型（可能没有这个文件）
   *
   * 目录从配置来；没配就按 DSH 家目录推（`~/.dsh/channel-pack`），
   * 推不出来/读不到 → 这一栏就是空的，**不影响限流那张表**。
   */
  const channelPackDir = String(config?.channelPackDir ?? '').trim()
    || join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'channel-pack')

  /**
   * 【10-22 08:0x boss选 B】更新检查的缓存：6 小时内用同一个答案。
   * boss不会天天开面板，但也不该每次打开都去打一次 GitHub
   *（未认证的 GitHub 接口 60 次/小时就限流，别人多人用更容易同时撞上）。
   */
  const UPDATE_CACHE_MS = 6 * 60 * 60 * 1000
  let updateCache = { at: 0, data: null }
  /** 推荐项目那页的数字缓存（Star/Fork 不会一分钟一变，缓久一点） */
  const PROJECTS_CACHE_MS = 60 * 60 * 1000
  let projectsCache = { at: 0, data: null }
  /**
   * 【10-22 09:0x boss】「下载好放在旁边，由您点一下确认才替换」
   *   下载完成但**还没替换**时，暂存信息放在这儿（只在内存里，进程重启就没了）。
   *   同理 `updateApplied` 记"已经替换过、等你重启"。
   */
  let updateStaged = null
  let updateApplied = null
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
       * 【10-19 19:2x boss】「透明度你应该调整到 0~40%」—— 上限从 25 提到 40。
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
    /**
     * 【10-22 00:3x boss】双击右键「切回上次那张」记住的图 id。
     * 只认字符串（老存档没有这个键 → 空串），不猜、不乱填。
     */
    next.lastWallId = typeof next.lastWallId === 'string' ? next.lastWallId : ''
    // 【10-19 21:1x 中英双语】面板语言只认 'zh' / 'en';默认(老存档/坏值)一律中文。
    next.lang = next.lang === 'en' ? 'en' : 'zh'
    // 【10-19 21:4x 新手引导】只看 true:老存档没这字段 → 当作没看过(第一次装的人会看到引导)。
    next.onboarded = next.onboarded === true
    // 背景图片随机变换时间:0 = 不轮换,正数 = 分钟。
    // 【10-18 15:45】下限提到 1 分钟。原来允许小数,自检留下的 0.02(1.2 秒)
    // 会导致「背景一直自己换」。boss能选的最小档就是 1 分钟,不存在更小的合法值,
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
      // 判黑白字的输入(boss 10-18 22:15 亲口给的判据)。
      // 页面按需补算后回写,所以这里是唯一的落盘口子。
      for (const key of ['chatP5', 'chatP95']) {
        const value = Number(patch[key])
        if (Number.isFinite(value)) next[key] = Math.min(1, Math.max(0, value))
      }
      for (const key of ['darkShare', 'lightShare', 'midShare', 'midLum']) {
        const value = Number(patch[key])
        if (Number.isFinite(value)) next[key] = Math.min(1, Math.max(0, value))
      }
      // native = 竖图按原图像素显示(boss 10-18 15:50 定的默认)
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
   * GET → { at, kind, trace }:at 是完成的时刻(0 = 没有),kind 是 'done'。
   * 页面记着上次的 at,不一样才响 —— 这样同一件事不会响第二遍。
   *
   * 【10-20 20:1x】多回一个 `trace`：最近几次判定为什么响/为什么不响。
   * 用途：boss报「刚才没声音」时，读一次这个接口就知道原因，
   * 不用再靠猜。**只是留痕，不影响页面原本的判断。**
   */
  async function handleBell(req, res) {
    if (req.method === 'POST') {
      const payload = await safeJson(req)
      // 也允许页面自己触发(比如面板上试听那一声)
      if (payload?.kind === 'test') {
        lastDoneAt = Date.now()
        lastDoneKind = 'test'
        trace('响（试听）')
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
      return sendJson(res, 200, { ok: true, at: lastDoneAt, kind: lastDoneKind, trace: bellTrace })
    }
    return sendJson(res, 200, { at: lastDoneAt, kind: lastDoneKind, trace: bellTrace })
  }

  /**
   * ═══ 自定义音效(boss 10-19 00:20 要的「添加窗口」)═══
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
   * 【10-20 02:5x boss】「为了防止品牌风险，把那几条含 CS 跟 QQ 的音效撤掉，其他的放在里面」
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
       * 单独判大小 —— boss看到的才是「单个音效最多 8MB」这句人话。
       */
      if (audio.buffer.length > MAX_SOUND_BYTES) {
        return sendJson(res, 400, { error: `单个音效最多 ${Math.round(MAX_SOUND_BYTES / 1024 / 1024)}MB`, code: 'big' })
      }
      /**
       * ═══ 总量两道闸(boss 10-19 13:55 选的 B:30 条 / 200MB)═══
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

  /**
   * ═══ 模型代号 → 人看的名字 ═══
   *
   * 【2026-10-20 22:3x boss】「模型应该是有名称的，你不能光写一个名字，
   *  或者说你写的这个模型跟我们本地的模型名字是不符的。」
   *
   * 台账里记的是**内部代号**（`qfmodel` / `dfmodel` / `step-5-preview`），
   * 那是程序里的 key，不是给人看的模型名。
   * 界面上该显示的是「Qwen3.8-Flash · 免费」这种**真名**。
   *
   * 真源只有一个：**DSH 运行时的 llm 服务**。
   *   llm.listProviders()      → 现在挂着哪些渠道
   *   llm.listModels(渠道)      → 这个渠道下有哪些模型，形如 { id, name }
   * `name` 才是界面上那个名字（应用自己的模型选择器也是渲染 name）。
   *
   * ⚠️ 读不到就**退回代号**，不猜、不编。
   *   宁可显示 `qfmodel`（一眼知道是代号），也不能显示一个错的模型名 ——
   *   贴纸本来就是彩蛋，显示错名字比显示代号更糟。
   *
   * 缓存：模型清单不会一分钟变一次，缓存 5 分钟，够用又不至于每次请求都去问。
   */
  let modelNameCache = null
  let modelNameCacheAt = 0
  const MODEL_NAME_TTL_MS = 5 * 60 * 1000

  async function resolveModelNames() {
    const now = Date.now()
    if (modelNameCache && now - modelNameCacheAt < MODEL_NAME_TTL_MS) return modelNameCache
    const out = new Map()
    try {
      const llm = typeof ctx.get === 'function' ? ctx.get('llm') : (ctx.llm || null)
      if (llm && typeof llm.listProviders === 'function') {
        const providers = llm.listProviders() || []
        for (const p of providers) {
          const providerId = String(p?.id ?? '')
          if (!providerId) continue
          let models = []
          try {
            models = (await llm.listModels(providerId)) || []
          } catch {
            models = []
          }
          for (const m of models) {
            const id = String(m?.id ?? '')
            const name = String(m?.name ?? '').trim()
            if (!id || !name) continue
            // 同名模型要消歧：先记下的那份不加后缀，后来出现的加上渠道名
            if (!out.has(`${providerId}::${id}`)) {
              out.set(`${providerId}::${id}`, name)
            }
          }
        }
      }
    } catch (error) {
      ctx.logger?.warn?.(`dsh-skin: 读模型真名失败: ${String(error?.message ?? error)}`)
    }
    modelNameCache = out
    modelNameCacheAt = now
    return out
  }

  /**
   * 渠道 id → 人看的名字。
   *
   * 优先用限流快照里那个 `channel_cn`（记账脚本维护的权威写法）；
   * 快照里没有的渠道（比如今天没限流过的 minimax / raccoon）就**把 id 首字母大写**顶上。
   *
   * ⚠️ 2026-10-21 23:1x 踩的坑（务必别再踩）：
   *    第一版在这里写了一张「渠道 id → 中文品牌名」的对照表。结果**发布打包时脱敏规则**
   *    会把品牌名连同未加引号的对象键一起替换掉 →
   *    ① 键名 `skin-studio:` 被换成带连字符的词 → **整个 index.js 语法坏掉**（脱敏闸门拦住）；
   *    ② 值里的品牌名被换成「同系列换肤脚本」→ 就算语法没坏，用户看到的渠道名也是错的。
   *    ⇒ **代码里不要把品牌名当数据写死**：要么从快照拿，要么按 id 自动美化。
   */
  function prettyChannel(provider) {
    const id = String(provider || '').trim()
    if (id === '') return ''
    return id.charAt(0).toUpperCase() + id.slice(1)
  }

  /** 本地日期键，跟账本 `days` 的写法一致（YYYY-MM-DD） */
  function localDayKey(nowMs) {
    const d = new Date(nowMs)
    const p = (n) => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
  }

  /**
   * ═══ 收集「不可用」的模型（贴纸第二张表）═══
   *
   * 【10-21 22:2x boss】**判据的边界是boss亲口划的**：
   *   「如果是我们手动自己停用的，那就不用写出来。因为你写的『禁用』，
   *     一定是要我们对话当中出了相关提示的。这种我们自己禁用的，你也不用写进去，
   *     这个是不需要的，因为我们本身就不用它」
   *
   * ⇒ **只有「今天真发过请求、并且今天真的失败过」的模型才进这张表。**
   *   光在黑名单里（`disabledModels`）、今天一次没调过的 → **不写**（那是我们自己不用它）。
   *
   * 每条至少命中一条「实证」才收：
   *   ① 账本里今天 请求全失败（errors = requests）
   *   ② 今天失败率 ≥ 50% 且至少 2 次（偶发 1 次错误不算「不可用」）
   *   ③ 渠道账号被停用 / 凭据已过期（且今天确实有请求）
   *   ④ 该模型在 dead-models 里（被实证「模型不存在」）
   * 顺带：如果它同时还在黑名单里，原因后面追加「已禁用」——
   *   因为这时候的"禁用"是**报过错之后**的结果，boss要的就是这种。
   */
  async function collectUnavailable(now, limitItems, names, channelOf) {
    const state = await readJson(join(channelPackDir, 'state.json'), null)
    const ledger = await readJson(join(channelPackDir, 'token-ledger.json'), null)
    if (!state || typeof state !== 'object' || !ledger || typeof ledger !== 'object') return []
    const dead = await readJson(join(channelPackDir, 'dead-models.json'), null)
    const accounts = Array.isArray(state.accounts) ? state.accounts : []
    const disabled = state.disabledModels && typeof state.disabledModels === 'object' ? state.disabledModels : {}
    const day = ledger.days && typeof ledger.days === 'object' ? ledger.days[localDayKey(now)] : null
    if (!day || typeof day !== 'object') return []
    // 还在限流的那批已经排在表一了，这里不重复
    const limited = new Set(
      limitItems.filter((item) => item.live).map((item) => `${item.provider}::${item.model}`),
    )
    const out = []
    for (const key of Object.keys(day)) {
      const stat = day[key]
      if (!stat || typeof stat !== 'object') continue
      // 键形态：`direct|provider|accountId|model`（accountId 可能是空串）
      const parts = String(key).split('|')
      if (parts.length < 4) continue
      const provider = String(parts[1] ?? '')
      const accountId = String(parts[2] ?? '')
      const model = parts.slice(3).join('|')
      if (provider === '' || model === '') continue
      if (limited.has(`${provider}::${model}`)) continue
      const requests = Number(stat.requests) || 0
      const errors = Number(stat.errors) || 0
      if (requests <= 0) continue
      const account = accounts.find((acc) => acc && acc.provider === provider && (accountId === '' || acc.id === accountId)) || null
      const reasons = []
      if (dead && dead[provider] && dead[provider][model]) reasons.push('接口不可用')
      if (errors >= requests) reasons.push(`全失败 ${errors}/${requests}`)
      else if (requests >= 2 && errors * 2 >= requests) reasons.push(`失败 ${errors}/${requests}`)
      if (account && account.enabled === false) reasons.push('渠道停用')
      const expiresAt = Number(account?.expiresAt) || 0
      if (expiresAt > 0 && expiresAt < now) reasons.push('凭据过期')
      // ⚠️ 一条实证都没有 → 不写。这就是「我们自己手动停用的不显示」那条规矩。
      if (reasons.length === 0) continue
      const isDisabled = Boolean(disabled[provider] && disabled[provider][model])
      // 只有**报过错之后**被禁用的，才把「已禁用」写出来（boss划的边界）
      if (isDisabled) reasons.push('已禁用')
      out.push({
        key,
        provider,
        channel: channelOf(provider),
        model,
        modelName: names.get(`${provider}::${model}`) || model,
        reason: reasons.join(' · '),
        disabled: isDisabled,
        requests,
        errors,
      })
    }
    // 排序：越"用不了"越靠上。接口不可用 / 渠道停用 / 凭据过期 排最前，其次按失败次数
    const weight = (row) => {
      let w = 0
      if (row.reason.includes('接口不可用')) w += 40
      if (row.reason.includes('渠道停用')) w += 30
      if (row.reason.includes('凭据过期')) w += 20
      if (row.reason.includes('全失败')) w += 15
      return w
    }
    out.sort((a, b) => weight(b) - weight(a) || b.errors - a.errors || a.model.localeCompare(b.model))
    return out.slice(0, 60)
  }

  /**
   * ═══ 彩蛋：渠道限流数据 ═══
   *
   * GET /dsh-skin/channel-limits → { at, items: [...] }
   *
   * 数据源是那本台账的**快照**（`渠道限流快照.json`），
   * 由 `渠道限流记账_20261020.py` 每 15 分钟刷新一次。
   * 快照里每条长这样：
   *   { provider, channel_cn, nickname, model, reset_ms, reset_at }
   *
   * 这里做三件事：
   *   ① 算清楚「现在还在限流 / 已经到期」（判据是解禁时刻，**不是**文件里有没有那条）
   *   ② 排序：还在限流的按解禁时刻从近到远在前，已到期的排后面
   *   ③ 只给页面**用得到**的字段，页面不参与任何计算
   *
   * ⚠️ 读不到 / 结构不对 → 返回空列表（`items: []`），**不抛错**。
   *   彩蛋是加分项，读不到数据它就该是空的，不能把插件带崩。
   */
  async function handleChannelLimits(req, res) {
    if (channelLimitFile === '') return sendJson(res, 200, { at: 0, items: [] })
    let parsed = null
    try {
      parsed = await readJson(channelLimitFile, null)
    } catch {
      parsed = null
    }
    const rawItems = parsed && typeof parsed === 'object' ? parsed.items : null
    if (!rawItems || typeof rawItems !== 'object') {
      return sendJson(res, 200, { at: 0, items: [] })
    }
    const now = Date.now()
    // 模型代号 → 人看的名字（boss 22:3x 提的：不能只写代号）。
    //   `qfmodel` / `dfmodel` / `step-5-preview` 这些是**内部代号**，
    //   界面上要显示的是「Qwen3.8-Flash · 免费」这种真名。
    const names = await resolveModelNames()
    const items = []
    for (const key of Object.keys(rawItems)) {
      const row = rawItems[key]
      if (!row || typeof row !== 'object') continue
      const resetMs = Number(row.reset_ms)
      if (!Number.isFinite(resetMs) || resetMs <= 0) continue
      const provider = String(row.provider ?? '')
      const model = String(row.model ?? '')
      items.push({
        key: String(key),
        provider,
        channel: String(row.channel_cn ?? provider ?? ''),
        model,
        // 真名；查不到就退回代号（宁可显示代号，也别显示空）
        modelName: names.get(`${provider}::${model}`) || model,
        resetAt: String(row.reset_at ?? ''),
        resetMs,
        live: resetMs > now,
      })
    }
    // 渠道 id → 人看的名字：先按快照里出现过的 channel_cn，再走兜底表
    const snapshotChannel = {}
    for (const key of Object.keys(rawItems)) {
      const row = rawItems[key]
      if (!row || typeof row !== 'object') continue
      const provider = String(row.provider ?? '')
      const name = String(row.channel_cn ?? '')
      if (provider !== '' && name !== '' && !snapshotChannel[provider]) snapshotChannel[provider] = name
    }
    const channelOf = (provider) => snapshotChannel[provider] || prettyChannel(provider) || provider
    // 还在限流的排前面（解禁时刻从近到远），已到期的排后面（从远到近）
    items.sort((a, b) => {
      if (a.live !== b.live) return a.live ? -1 : 1
      return a.live ? a.resetMs - b.resetMs : b.resetMs - a.resetMs
    })
    const unavailable = await collectUnavailable(now, items, names, channelOf)
    return sendJson(res, 200, {
      at: Number(parsed?.updated_at_ms ?? 0) || now,
      live: items.filter((item) => item.live).length,
      items,
      // 【10-21 22:2x boss】第二张表：今天真报过错 / 用不了的模型
      unavailable,
    })
  }

  /**
   * 版本比较：latest 是否比 current 新。
   * 只按点分数字比（我们是 1.8.7 这种三段的版本号，够用且不会误判）。
   * 预发布后缀（-rc.1）一律取数字部分比较 —— 提示"有新版本"属于加分项，
   * 宁可保守（比不出就当没新版），也不要天天误报。
   */
  function isNewerVersion(latest, current) {
    const parse = (v) => String(v ?? '')
      .trim()
      .replace(/^v/i, '')
      .split('-')[0]
      .split('.')
      .map((part) => Number.parseInt(part, 10))
      .map((n) => (Number.isFinite(n) ? n : 0))
    const a = parse(latest)
    const b = parse(current)
    const len = Math.max(a.length, b.length)
    for (let i = 0; i < len; i += 1) {
      const x = a[i] ?? 0
      const y = b[i] ?? 0
      if (x > y) return true
      if (x < y) return false
    }
    return false
  }

  /** 当前版本 = 插件自己的 package.json（唯一事实源，不手抄） */
  async function readOwnVersion() {
    try {
      const text = await readFile(new URL('./package.json', import.meta.url), 'utf8')
      return String(JSON.parse(text)?.version ?? '')
    } catch {
      return ''
    }
  }

  /* ══════════════════════════════════════════════════════════════
   * ═══ 下载到旁边 → 您点一下才替换（boss 10-22 09:0x 拍板）═══
   * ══════════════════════════════════════════════════════════════
   *
   * boss原话：「做成**『下载好放在旁边，由您点一下确认才替换』**——既省事，又不越界。」
   *
   * ## 两条铁律（这一段是整个功能的安全底座）
   *
   * **① 下载阶段绝对不碰现装的那一份。**
   *   新版先落到一个**暂存目录**（插件自己的数据目录下面），
   *   逐文件核对 SHA-256；**一个字节都不写进安装目录**。
   *   ⇒ 下载失败/断网/哈希对不上 = 现装的那份**毫发无损**，用户还在用。
   *
   * **② 替换只在用户点了之后才做，而且替换前一定备份。**
   *   替换顺序：备份现装的 → 写新文件（先写 `<文件>.new` 再改名，避免写到一半崩掉）→
   *   核对替换结果。**任何一步失败 → 用备份还原**，并在界面上明说"已回滚"。
   *
   * ## 关于"验证签名"
   *   boss 10-22 明说「**只要哈希，不要签名**」——
   *   清单里只有 SHA-256，能挡"下载损坏/被截断"，
   *   **挡不住"仓库被人改了"**（那需要 Ed25519 签发私钥，是另一件事）。
   *   所以这里**不假装**有签名能力，注释里写清楚边界。
   */

  /** 暂存目录：插件数据目录下的 upgrade-staging（跟图库/设置同根，不污染安装目录） */
  function stagingDir() {
    const base = stateFile ? dirname(stateFile) : ''
    return base === '' ? '' : join(base, 'upgrade-staging')
  }

  /** 备份目录：替换前把现装的那份复制一份留底 */
  function backupDir() {
    const base = stateFile ? dirname(stateFile) : ''
    return base === '' ? '' : join(base, 'upgrade-backup')
  }

  /** 插件自己装在哪（node_modules/@local/dsh-skin 这个软链指向的那份） */
  function installDir() {
    return dirname(fileURLToPath(import.meta.url))
  }

  /**
   * 清单里的路径是**相对仓库根**的（`plugin/index.js`），
   * 而**安装目录本身就是那个 `plugin/` 目录**。
   * ⇒ 直接拼会变成 `plugin/plugin/index.js` —— 写到一个不存在的地方。
   *
   * 这里把「仓库里的相对路径」换算成「安装目录里的相对路径」：
   *   `plugin/index.js` → `index.js`
   *   `plugin/locale/zh.json` → `locale/zh.json`
   *   不是 `plugin/...` 开头的（理论上不该有）→ 原样返回（后面还有一道越界检查兜着）。
   */
  function toInstallRelative(repoPath) {
    const rel = String(repoPath ?? '').replace(/\\/g, '/')
    if (rel.startsWith('plugin/')) return rel.slice('plugin/'.length)
    return rel
  }

  /** 递归复制一个目录（只拷普通文件，不跟随软链） */
  async function copyTree(from, to, relative = '') {
    let entries
    try {
      entries = await readdir(from, { withFileTypes: true })
    } catch {
      return 0
    }
    let count = 0
    for (const entry of entries) {
      const rel = relative === '' ? entry.name : `${relative}/${entry.name}`
      const src = join(from, entry.name)
      const dst = join(to, rel)
      if (entry.isDirectory()) {
        await mkdir(dst, { recursive: true })
        count += await copyTree(src, dst, rel)
        continue
      }
      if (!entry.isFile()) continue
      await mkdir(dirname(dst), { recursive: true })
      await copyFile(src, dst)
      count += 1
    }
    return count
  }

  async function pathExists(target) {
    try {
      await stat(target)
      return true
    } catch {
      return false
    }
  }

  /**
   * ═══════════════════════════════════════════════════════════════
   * 取源清单：**清单和文件必须从同一个源取**（这是这一版的要害）
   * ═══════════════════════════════════════════════════════════════
   *
   * 【为什么必须有这个函数】2026-10-22 实测踩出来的：
   *   原来「取清单」和「下载文件」各自写死 `cdn.jsdelivr.net/gh/<repo>@<branch>/`。
   *   那天推完 v1.8.13，jsDelivr 对**其中 1 个文件**（plugin/package.json）
   *   的边缘缓存是陈旧的（还给 1.6.0），而清单那份是新的（1.8.13）。
   *   ⇒ 清单说「package.json 该是这个哈希」，CDN 给的是旧内容
   *   ⇒ 下载在**哈希核对那一步**直接失败，报 `hash-mismatch`，
   *      **用户看到的就是「下载更新」按钮点了没反应**。
   *
   * 【判据：清单与文件必须同源】
   *   哈希核对只有在一个源内部才有意义 ——
   *   清单从 A 取、文件从 B 取，两边版本不一致时**必然**对不上。
   *   所以：**先选定一个源，清单和文件都用它**，不混着来。
   *
   * 【源的顺序：raw 第一，jsDelivr 第二 —— 这是两轮实测定的】
   *   ⚠️ 我在这上面**反复了一次**（自己打自己的脸），过程记下来：
   *   第一版把 jsDelivr 排第一（它当时稳），后来看到「个别文件缓存陈旧」就改成 raw 第一；
   *   改完真机一测，raw **连不上**（Node fetch `fetch failed`、10.7 秒超时；curl 8 个文件挂 6 个）
   *   ⇒ 又改回 jsDelivr 第一。
   *   **然后又测了一轮，才把真相测出来** ——
   *   那次 raw 连不上是**偶发**（网络抖动），不是常态。连测：raw 清单 **6/6 成功**
   *   （774/978/1472/999/331/328ms），大文件 91KB **4/4 成功**（2667/2434/1394/1111ms）。
   *
   *   **决定性的那组数据**（同一份清单，两轮实测）：
   *   | 源 | 清单 | 文件哈希对上 | 取不到 |
   *   |---|---|---|---|
   *   | jsDelivr | v1.8.14 | **15/18** | 0 |
   *   | github-raw | v1.8.14 | **18/18** | 0 |
   *   ⇒ **jsDelivr 每个文件各缓存各的**（清单刷新了，某些文件还是旧的），
   *     连测两轮都是**同样那 3 个文件**不符（plugin/index.js、docs/版本记录.md、docs/清单.json）
   *     ⇒ 这**不是偶发**，是它的缓存机制决定的。
   *   ⇒ 而「清单和文件同源」这个判据，**只有 raw 能真正满足**：
   *     jsDelivr 同一个源内部都不一致，清单是新的、文件是旧的。
   *   ⇒ **raw 第一（唯一能保证一致），jsDelivr 第二（国内快，但当备胎时可能哈希不符）**。
   *
   *   ⚠️ 备胎也不是万能的：万一退到 jsDelivr 而它正好缓存陈旧，
   *      哈希核对会拦住（报 hash-mismatch）—— **这是好事**：
   *      总比"装上去一个半新半旧的版本"强。
   *
   * 【为什么不用 @latest】
   *   实测：`@latest` 解析到的是**最新的 tag**（v1.8.13），**不是分支头**。
   *   而 tag 是发版时才打的 ⇒ 用 @latest 就变成「发完版才看得到新版」，
   *   反而更慢。**用分支头（main）才对** —— 推上去就能看到。
   *
   * @param {string} repo   owner/repo
   * @param {string} branch 分支名
   * @returns {Array<{name: string, base: string}>} 按优先级排好的源
   */
  function updateSources(repo, branch) {
    const ref = String(branch ?? '').trim() || 'main'
    return [
      {
        name: 'github-raw',
        // 清单在 publish/ 下，文件路径跟仓库里的相对路径一致 ⇒ 同一个 base 通吃
        base: `https://raw.githubusercontent.com/${repo}/${ref}/`,
      },
      {
        name: 'jsdelivr',
        base: `https://cdn.jsdelivr.net/gh/${repo}@${ref}/`,
      },
      {
        name: 'github-contents',
        base: `https://api.github.com/repos/${repo}/contents/`,
      },
    ]
  }

  /**
   * 从某个源读一个文本文件（拿清单用）
   * @returns {Promise<string|null>} 读不到返回 null
   */
  async function fetchTextFrom(source, path) {
    const timeout = typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(8000) : undefined
    try {
      let url
      if (source.name === 'github-contents') {
        url = `${source.base}${path}?ref=${source.ref ?? 'main'}`
      } else {
        url = source.base + path
      }
      const res = await fetch(url, { headers: { 'user-agent': 'dsh-skin' }, signal: timeout })
      if (!res.ok) return null
      if (source.name === 'github-contents') {
        const payload = JSON.parse(await res.text())
        if (!payload || typeof payload.content !== 'string') return null
        return Buffer.from(payload.content, 'base64').toString('utf8')
      }
      return await res.text()
    } catch {
      return null
    }
  }

  /**
   * 从某个源读一个二进制文件（下载用）
   * @returns {Promise<Buffer|null>} 读不到返回 null
   */
  async function fetchBufferFrom(source, path) {
    const timeout = typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(20000) : undefined
    try {
      let url
      if (source.name === 'github-contents') {
        url = `${source.base}${path}?ref=${source.ref ?? 'main'}`
      } else {
        url = source.base + path
      }
      const res = await fetch(url, { headers: { 'user-agent': 'dsh-skin' }, signal: timeout })
      if (!res.ok) return null
      if (source.name === 'github-contents') {
        const payload = JSON.parse(await res.text())
        if (!payload || typeof payload.content !== 'string') return null
        return Buffer.from(payload.content, 'base64')
      }
      return Buffer.from(await res.arrayBuffer())
    } catch {
      return null
    }
  }

  /**
   * GET /dsh-skin/update-manifest → 远端那份发布清单（带哈希）
   *
   * 跟 update-check 分开：那个只回**一个版本号**（省流量），
   * 这个回**整份清单**（下载时才需要）。
   *
   * ⚠️ 清单里**不记用的是哪个源** —— 真正的下载那一步会**自己重新选一次源**，
   *    选中的源会连同清单一起记下来（见 handleUpdateDownload）。
   *    这样两边**必然同源**，哈希核对才有意义（见 updateSources 的注释）。
   */
  async function handleUpdateManifest(req, res) {
    const repo = String(config?.updateRepo ?? '').trim()
    if (repo === '') return sendJson(res, 200, { ok: false, reason: 'not-configured' })
    const branch = String(config?.updateBranch ?? 'main').trim() || 'main'
    const manifestPath = 'publish/release-manifest.json'
    for (const source of updateSources(repo, branch)) {
      const text = await fetchTextFrom(source, manifestPath)
      if (text === null) continue
      try {
        const manifest = JSON.parse(text)
        const files = Array.isArray(manifest?.files) ? manifest.files : []
        if (files.length === 0) continue
        return sendJson(res, 200, { ok: true, manifest })
      } catch {
        /* 这份不是合法清单，试下一个源 */
      }
    }
    return sendJson(res, 200, { ok: false, reason: 'manifest-unavailable' })
  }

  /**
   * POST /dsh-skin/update-download → **只下载到暂存目录，不碰现装的那份**
   *
   * 返回 { ok, version, staged, files, bytes, source }
   *
   * ⚠️【要害：整个下载过程必须「一个源 + 全套校验」】
   *   2026-10-22 实测：jsDelivr **每个文件各缓存各的** ——
   *   清单刷新了，但某些文件还是旧的（连测两轮都是同样那 3 个文件不符）。
   *   ⇒ 「清单和文件同源」这个判据**还不够**：同一个源内部也可能不一致。
   *   ⇒ 所以这里改成：**一个源从头走到尾**（取清单 → 下全部文件 → 逐个核哈希），
   *     **任何一步不过，就换下一个源重头再来**。
   *   ⇒ 换源重来的代价是白下一次（无副作用，暂存目录每次清空），
   *     换来的是**装上去的一定是同一版**。
   */
  async function handleUpdateDownload(req, res) {
    const repo = String(config?.updateRepo ?? '').trim()
    if (repo === '') return sendJson(res, 200, { ok: false, reason: 'not-configured' })
    const branch = String(config?.updateBranch ?? 'main').trim() || 'main'
    const stage = stagingDir()
    if (stage === '') return sendJson(res, 200, { ok: false, reason: 'no-data-dir' })
    const manifestPath = 'publish/release-manifest.json'

    /** 最后一次失败的原因（换源全失败时，报这个） */
    let lastReason = 'manifest-unavailable'
    let lastFile = ''

    // ① 依次试每个源：**一个源走完全程**，全程过了才算数
    for (const candidate of updateSources(repo, branch)) {
      const text = await fetchTextFrom(candidate, manifestPath)
      if (text === null) {
        // ⚠️ 别覆盖更有信息量的原因（hash-mismatch 更有用，见下面注释）
        if (lastReason !== 'hash-mismatch') lastReason = 'manifest-unavailable'
        continue
      }
      let manifest = null
      try {
        const parsed = JSON.parse(text)
        const list = Array.isArray(parsed?.files) ? parsed.files : []
        if (list.length === 0) {
          // ⚠️ 别覆盖更有信息量的原因（hash-mismatch 更有用，见下面注释）
          if (lastReason !== 'hash-mismatch') lastReason = 'manifest-empty'
          continue
        }
        manifest = parsed
      } catch {
        if (lastReason !== 'hash-mismatch') lastReason = 'manifest-unavailable'
        continue
      }

      const files = Array.isArray(manifest?.files) ? manifest.files : []
      const version = String(manifest?.version ?? '')

      // ② 下载到暂存目录，**一个字节都不写进安装目录**
      const staged = join(stage, version || 'unknown')
      let bytes = 0
      let failed = null
      try {
        await rm(staged, { recursive: true, force: true })
        await mkdir(staged, { recursive: true })
        for (const file of files) {
          const rel = String(file?.path ?? '')
          const expect = String(file?.sha256 ?? '')
          // 路径不许越出暂存目录（清单来自网络，必须防目录穿越）
          if (rel === '' || rel.includes('..') || rel.startsWith('/') || rel.includes('\\')) {
            failed = { reason: 'manifest-path-invalid', file: rel }
            break
          }
          const buf = await fetchBufferFrom(candidate, rel)
          if (buf === null) {
            failed = { reason: 'download-failed', file: rel }
            break
          }
          // 逐文件核对哈希 —— 挡"下载损坏/被截断"，也挡"这个源内部缓存不一致"
          if (expect !== '' && createHash('sha256').update(buf).digest('hex') !== expect) {
            failed = { reason: 'hash-mismatch', file: rel }
            break
          }
          const target = join(staged, rel)
          await mkdir(dirname(target), { recursive: true })
          await writeFile(target, buf)
          bytes += buf.length
        }
      } catch (error) {
        failed = { reason: 'download-failed', file: '', error: String(error?.message ?? error) }
      }

      // 这个源全程过了 → 就用它
      if (!failed) {
        updateStaged = {
          version,
          dir: staged,
          /**
           * ⚠️ 这里必须存**文件清单本身**（不是文件数）。
           *    第一版只存了 `files: files.length`（一个数字），
           *    替换时要逐个遍历文件 → `for (const file of 数字)` 直接抛
           *    「number is not iterable」→ 备份阶段就炸了，而且报的是 `backup-failed`，
           *    **跟真正的原因对不上**，极难查。
           */
          files,
          fileCount: files.length,
          bytes,
          at: Date.now(),
        }
        return sendJson(res, 200, {
          ok: true,
          version,
          files: files.length,
          bytes,
          staged: true,
          // 记下用的哪个源 —— 排查"下载失败"时能一眼看出是源的问题还是包的问题
          source: candidate.name,
          // 明确告诉页面"还没替换"——替换要用户点确认
          applied: false,
          notice: 'downloaded',
        })
      }

      // 这个源没过 ⇒ 记下原因，**换下一个源从头再来**
      /**
       * ⚠️ 原因要取**最有信息量的那个**：
       *   `hash-mismatch` 比 `manifest-unavailable` 有用得多 ——
       *   前者说明"东西拿到了但对不上"（多半是缓存陈旧），
       *   后者只说明"这个源没给出清单"。
       *   ⇒ 只要**任何一个**源报过 hash-mismatch，最终就报它。
       */
      if (failed.reason === 'hash-mismatch' || lastReason !== 'hash-mismatch') {
        lastReason = failed.reason
      }
      lastFile = failed.file
      // 目录穿越这种是**清单本身有问题**，换源也没用 —— 直接报出去
      if (failed.reason === 'manifest-path-invalid') {
        return sendJson(res, 200, { ok: false, reason: failed.reason, file: failed.file })
      }
    }

    return sendJson(res, 200, { ok: false, reason: lastReason, file: lastFile })
  }

  /**
   * POST /dsh-skin/update-apply → **用户点了确认才走这一步**
   *
   * 顺序：备份现装的 → 写新文件 → 核对；任何一步失败 → 从备份回滚。
   * 替换完**需要重启桌面端**才生效（页面代码是启动加载的）——重启由用户自己来。
   */
  async function handleUpdateApply(req, res) {
    if (!updateStaged) return sendJson(res, 200, { ok: false, reason: 'nothing-staged' })
    const stage = updateStaged.dir
    if (!(await pathExists(stage))) return sendJson(res, 200, { ok: false, reason: 'staging-gone' })
    const target = installDir()
    const backup = backupDir()
    const backupSlot = backup === '' ? '' : join(backup, `v${updateStaged.version}`)
    if (backupSlot === '') return sendJson(res, 200, { ok: false, reason: 'no-data-dir' })

    // ① 先备份现装的那份（只备清单里列的那些文件，别把用户自己的东西也卷进来）
    let backed = 0
    try {
      await rm(backupSlot, { recursive: true, force: true })
      await mkdir(backupSlot, { recursive: true })
      for (const file of updateStaged.files || []) {
        // 仓库路径 → 安装目录里的相对路径（见 toInstallRelative 的注释）
        const rel = toInstallRelative(file?.path)
        if (rel === '' || rel.includes('..')) continue
        const from = join(target, rel)
        if (!(await pathExists(from))) continue
        /**
         * ⚠️ 单个文件备不下来（目标是个目录、或权限不让读）**不许让整次备份失败**：
         *    第一版是一个 copyFile 抛了就整体 return `backup-failed`，
         *    结果**一个坏条目就把整次更新挡掉**，而且用户看不出是哪个文件的问题。
         *    正确做法：**跳过它、记下来、继续备其他的** ——
         *    备不下来的那个文件在替换阶段本来也写不进去，那时才报替换失败 + 回滚。
         */
        try {
          const to = join(backupSlot, rel)
          await mkdir(dirname(to), { recursive: true })
          await copyFile(from, to)
          backed += 1
        } catch (error) {
          ctx.logger?.warn?.(`dsh-skin: 备份 ${rel} 失败: ${String(error?.message ?? error)}`)
        }
      }
    } catch (error) {
      // 整块备份目录都建不出来 —— 这才是真的失败
      return sendJson(res, 200, { ok: false, reason: 'backup-failed', error: String(error?.message ?? error) })
    }

    // ② 写新文件：先写 `.new` 再改名（写到一半崩了不会把原文件截断）
    const written = []
    try {
      for (const file of updateStaged.files || []) {
        const rel = toInstallRelative(file?.path)
        if (rel === '' || rel.includes('..')) continue
        // 暂存目录里存的是**仓库结构**（plugin/xxx），要按同一个相对路径取
        const src = join(stage, String(file?.path ?? '').replace(/\\/g, '/'))
        if (!(await pathExists(src))) continue
        const dst = join(target, rel)
        const tmp = `${dst}.new`
        await mkdir(dirname(dst), { recursive: true })
        await copyFile(src, tmp)
        await rename(tmp, dst)
        written.push({ rel, dst, backup: join(backupSlot, rel) })
      }
    } catch (error) {
      // ③ 出错 → 从备份回滚
      await rollback(written, backupSlot)
      return sendJson(res, 200, { ok: false, reason: 'replace-failed', rolledBack: true, error: String(error?.message ?? error) })
    }

    // ④ 核对：替换后的文件哈希要跟清单一致
    const mismatched = []
    for (const file of updateStaged.files || []) {
      const rel = toInstallRelative(file?.path)
      const expect = String(file?.sha256 ?? '')
      if (rel === '' || expect === '') continue
      try {
        const buf = await readFile(join(target, rel))
        if (createHash('sha256').update(buf).digest('hex') !== expect) mismatched.push(rel)
      } catch {
        mismatched.push(rel)
      }
    }
    if (mismatched.length > 0) {
      await rollback(written, backupSlot)
      return sendJson(res, 200, { ok: false, reason: 'verify-failed', rolledBack: true, mismatched })
    }

    const applied = { version: updateStaged.version, at: Date.now(), backup: backupSlot, files: written.length }
    updateApplied = applied
    updateStaged = null
    return sendJson(res, 200, {
      ok: true,
      version: applied.version,
      files: applied.files,
      backup: backupSlot,
      applied: true,
      // ⚠️ 必须重启桌面端才生效 —— 页面代码是启动加载的。重启由用户自己来。
      needRestart: true,
    })
  }

  /** 从备份把文件还原回去（替换失败时的回滚） */
  async function rollback(written, backupSlot) {
    for (const item of written) {
      try {
        if (await pathExists(item.backup)) {
          await copyFile(item.backup, item.dst)
        } else {
          // 备份里没有（原先就没有这个文件）→ 把新写的那份删掉
          await rm(item.dst, { force: true })
        }
      } catch {
        /* 回滚尽力而为 */
      }
    }
  }

  /**
   * 依次试各个源拿远端版本；全都失败就返回 null
   *
   * ⚠️ `pkgPath` 不能写死成 `plugin/package.json`：
   *    换肤仓库的清单在 `plugin/` 下，手机远程的清单在**仓库根目录** —— 两个仓库布局不一样。
   *    写死路径查手机远程会一直 404（实测过）。
   *
   * ⚠️【10-22 23:5x 加了 raw 作备胎】原来只有 jsDelivr 一个源，
   *    它对个别文件的边缘缓存是陈旧的（还给 1.6.0，而远端已经是 1.8.13）——
   *    面板会因此显示"没有新版本"（拿到的版本号比现装还旧）。
   *
   * ⚠️【10-23 00:3x 源顺序最终定稿】**以「同一个源内部一致」为准绳**（不是「哪个快」）：
   *    实测同一份清单：jsDelivr **15/18**（它每个文件各缓存各的），
   *    github-raw **18/18**。⇒ raw 第一（唯一能保证整套一致），jsDelivr 第二。
   *    （注：raw 偶尔会连不上，那是**偶发**网络抖动 —— 连测清单 6/6 成功。
   *      真的连不上会自动退到 jsDelivr，且哈希核对会兜住。）
   */
  async function fetchRemoteVersion(repo, branch, pkgPath = 'plugin/package.json') {
    const timeout = typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(6000) : undefined
    const sources = [
      {
        name: 'github-raw',
        url: `https://raw.githubusercontent.com/${repo}/${branch}/${pkgPath}`,
        read: (text) => String(JSON.parse(text)?.version ?? ''),
      },
      {
        name: 'jsdelivr',
        url: `https://cdn.jsdelivr.net/gh/${repo}@${branch}/${pkgPath}`,
        read: (text) => String(JSON.parse(text)?.version ?? ''),
      },
      {
        name: 'github-contents',
        url: `https://api.github.com/repos/${repo}/contents/${pkgPath}?ref=${branch}`,
        read: (text) => {
          const payload = JSON.parse(text)
          if (!payload || typeof payload.content !== 'string') return ''
          const decoded = Buffer.from(payload.content, 'base64').toString('utf8')
          return String(JSON.parse(decoded)?.version ?? '')
        },
      },
    ]
    for (const source of sources) {
      try {
        const res = await fetch(source.url, {
          headers: { accept: 'application/vnd.github+json, application/json', 'user-agent': 'dsh-skin' },
          signal: timeout,
        })
        if (!res.ok) continue
        const version = source.read(await res.text())
        if (version) return { version, source: source.name }
      } catch {
        /* 这个源不行就试下一个 */
      }
    }
    return null
  }

  /**
   * GET /dsh-skin/update-check → { ok, current, latest, outdated, source, checkedAt, pageUrl }
   *
   * 缓存 6 小时：boss不会天天开面板，但也不该每次开都去打一次 GitHub
   *（未认证的 GitHub 接口 60 次/小时就限流）。
   */
  async function handleUpdateCheck(req, res) {
    const now = Date.now()
    if (updateCache.data && now - updateCache.at < UPDATE_CACHE_MS) {
      return sendJson(res, 200, { ...updateCache.data, cached: true })
    }
    const repo = String(config?.updateRepo ?? '').trim()
    if (repo === '') {
      updateCache = { at: now, data: { ok: false, reason: 'not-configured' } }
      return sendJson(res, 200, updateCache.data)
    }
    const branch = String(config?.updateBranch ?? 'main').trim() || 'main'
    const pkgPath = String(config?.updatePkgPath ?? 'plugin/package.json').trim() || 'plugin/package.json'
    const current = await readOwnVersion()
    const remote = await fetchRemoteVersion(repo, branch, pkgPath)
    const data = remote
      ? {
          ok: true,
          current,
          latest: remote.version,
          outdated: isNewerVersion(remote.version, current),
          source: remote.source,
          checkedAt: now,
          pageUrl: `https://github.com/${repo}`,
        }
      : { ok: false, reason: 'fetch-failed', current, checkedAt: now, pageUrl: `https://github.com/${repo}` }
    updateCache = { at: now, data }
    return sendJson(res, 200, data)
  }

  /**
   * GET /dsh-skin/projects → { ok, items: [{ id, name, repo, url, description, stars, forks, pushedAt, updatedAt }] }
   *
   * 【10-22 08:2x boss】「推荐项目就写我们自己的项目，目前只有一个手机远程」
   *
   * 借鉴 Our Free Model 的「推荐项目」页，但守住它那条纪律：
   *   **数字必须是真读回来的**（Star / Fork / 最近提交），
   *   读不到就**不显示那个数字**，绝不用占位数字凑版面 ——
   *   这一页的全部说服力都在"数字是真的"。
   *
   * 项目清单从配置来（`config.updateProjects`），没配就返回空 —— 不写死品牌名。
   */
  async function handleProjects(req, res) {
    const now = Date.now()
    if (projectsCache.data && now - projectsCache.at < PROJECTS_CACHE_MS) {
      return sendJson(res, 200, { ...projectsCache.data, cached: true })
    }
    const configured = config?.updateProjects
    const list = Array.isArray(configured) ? configured : []
    const timeout = typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(6000) : undefined
    const items = []
    for (const entry of list) {
      const repo = String(entry?.repo ?? '').trim()
      if (repo === '') continue
      const id = String(entry?.id ?? repo).trim()
      let stat = null
      try {
        const res2 = await fetch(`https://api.github.com/repos/${repo}`, {
          headers: { accept: 'application/vnd.github+json', 'user-agent': 'dsh-skin' },
          signal: timeout,
        })
        if (res2.ok) {
          const data = await res2.json()
          /**
           * ⚠️ GitHub 的 `pushed_at` / `updated_at` 是**字符串**（ISO 格式），
           *    不是时间戳。第一版直接 `Number(data.pushed_at)` → 永远 NaN → 0，
           *    「最近提交」那一栏就一直是空的（而且不报错，很难发现）。
           *    这里要**先转成 Date 再取时间戳**。
           */
          const toMs = (value) => {
            if (typeof value === 'number' && Number.isFinite(value)) return value
            const parsed = Date.parse(String(value ?? ''))
            return Number.isFinite(parsed) ? parsed : 0
          }
          stat = {
            stars: Number.isFinite(Number(data?.stargazers_count)) ? Number(data.stargazers_count) : null,
            forks: Number.isFinite(Number(data?.forks_count)) ? Number(data.forks_count) : null,
            pushedAt: toMs(data?.pushed_at),
            updatedAt: toMs(data?.updated_at),
            description: String(data?.description ?? ''),
            openIssues: Number.isFinite(Number(data?.open_issues_count)) ? Number(data.open_issues_count) : null,
          }
        }
      } catch {
        /* 读不到就当没有这个数字，不编 */
      }
      items.push({
        id,
        name: String(entry?.name ?? id),
        repo,
        url: `https://github.com/${repo}`,
        tagline: String(entry?.tagline ?? ''),
        stars: stat?.stars ?? null,
        forks: stat?.forks ?? null,
        pushedAt: stat?.pushedAt ?? 0,
        description: stat?.description ?? '',
      })
    }
    const data = { ok: true, items, checkedAt: now }
    projectsCache = { at: now, data }
    return sendJson(res, 200, data)
  }

  const routes = [
    { kind: 'exact', path: STATE_PATH, handler: handleState },
    { kind: 'exact', path: LIBRARY_PATH, handler: handleLibrary },
    { kind: 'exact', path: IMAGE_PATH, handler: handleImage },
    { kind: 'exact', path: DIAG_PATH, handler: handleDiag },
    { kind: 'exact', path: BELL_PATH, handler: handleBell },
    { kind: 'exact', path: SOUNDS_PATH, handler: handleSounds },
    { kind: 'exact', path: SOUND_FILE_PATH, handler: handleSoundFile },
    { kind: 'exact', path: CHANNEL_LIMIT_PATH, handler: handleChannelLimits },
    { kind: 'exact', path: UPDATE_CHECK_PATH, handler: handleUpdateCheck },
    { kind: 'exact', path: PROJECTS_PATH, handler: handleProjects },
    { kind: 'exact', path: UPDATE_MANIFEST_PATH, handler: handleUpdateManifest },
    { kind: 'exact', path: UPDATE_DOWNLOAD_PATH, handler: handleUpdateDownload },
    { kind: 'exact', path: UPDATE_APPLY_PATH, handler: handleUpdateApply },
  ]
  const disposers = routes.map((route) => ctx.webServer.register(route))

  /**
   * ═══ 听「运行状态变了」这个广播：开始是 running、跑完变回 idle ═══
   *
   * 【10-19 20:4x boss：「有的时候任务还没跑完，但它就已经声音提醒你了，
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
   *    子 agent 干完了 → 也报 idle → 我们响了，可boss等的那件事还在跑。
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
   * 直接调用会让主机端启动就抛错 → 整个换肤插件挂掉 → boss连背景都没了。
   * 所以先确认是函数再用，拿不到就安静跳过，换肤不受影响。
   *
   * 【10-20 20:1x】下面这段的声明已挪到大注释块之后，跟 B 方案的新逻辑放在一起。
   */
  /**
   * ═══ 【10-20 20:1x B 方案修「完成任务有时有声音有时没声音」═══
   *
   * boss原话：「为什么完成任务有的时候有声音，有的时候没声音了？」
   *
   * 排查结论（根因都在这一段判断里）：
   * ① **安静只等 3 秒，中途被别的事拽走就作废、不补响** —— 这台机器上有定时任务/
   *    后台自动化，任务真干完的那一刻只要任一路又跑起来，这一次完成就被吞掉，
   *    而且不补 → 最常见的那种「任务明明完了没声音」。
   * ② **记账本只加不减** —— 谁在跑就往集合里加，谁空闲就摘掉，但**没有任何清理**。
   *    万一某个后台小任务的"空闲"广播没被收到（广播早于插件挂上、或监听中途掉了），
   *    这个名字就永远留在本子上 → 之后每次判断都发现"本子不空"→ **从此一次都不响**。
   * ③ `sawRunning` 这道门槛是多余的牺牲 —— 本意是「见过 running 才算完成」，
   *    但主机端每次跟应用一起重启、`lastDoneAt` 从 0 开始，而页面侧 19:5x 修好
   *    「第一个任务被吞」之后，早就不依赖它了。它现在只会造成：插件挂上之前
   *    就已经在跑的任务，跑完了不响。删掉。
   * ④ 页面侧**拿不到**可靠信号：实测桌面端转发清单（28 个）里没有 turn/end、
   *    也没有 session/event、agent/status —— 所以「换更可靠的信号源」这条路不通，
   *    只能把现有这条修对。（@local/dsh-skin 20:0x 实测）
   *
   * 【现在的判断】四件事一起：
   *   a) 任务被收掉（agent/disposed）→ 从记账本里划掉，然后重新评估一次
   *      （万一正是因为它卡住才不响的，这一步就补回来了）；
   *   b) 取消的那次**不再作废就扔**：记下「pendingRefire」，等这波真安静下来补响；
   *   c) `sawRunning` 删掉；
   *   d) 每次响/不响都留一笔原因在 `bellTrace`，读 `/dsh-skin/bell` 就能查到。
   */
  const BELL_SETTLE_MS = Number(config?.bellSettleMs) > 0 ? Number(config.bellSettleMs) : 3000
  let offStatus = null
  let offApproval = null
  let offQuestion = null
  let offDisposed = null
  /**
   * ═══ 【10-20 23:5x 第三个根因（真正的主因）：门槛定太高 ═══
   *
   * boss又报「完成任务有的时候有声音有的时候没声音」。这轮加了留痕，
   * 一眼就看见了现场：留痕里**清一色「还有 3 个在跑，先别响」**，
   * 而且 N 的序列是 5→5→5→5→4→4→3→5 —— **有进有出（账本是活的），
   * 但从来没到过 0**。
   *
   * 【为什么到不了 0】原来的判据是「**所有** agent 都空闲」才算完成。
   * 而这台机器上**同时有 10 个会话目录**，boss是多会话并行干活的 ——
   * 只要**别的**会话还有一个在跑，这一轮就永远判不完成，一声不响。
   * **这不是"偶尔"，是"多会话并行时基本不响"** —— 这才是主因。
   *
   * 【修法】把「一个全局本子」改成「**每个会话一个本子**」：
   *   ① 记账按**根会话**分（子 agent 归到它的 parentSession 底下）；
   *   ② 谁跑完就**只等它自己这一支**（自己 + 它的子 agent）空掉，不看别的会话；
   *   ③ **只有根会话跑完才响**（子 agent 干完不算 —— 主任务还在跑）。
   *
   * 【为什么不能"谁跑完谁就响"】那正是 10-19 20:4x 修掉的毛病：
   * 子 agent 先干完就响，boss等的那件事还在跑。现在保留那道防线，
   * 只是把"所有会话"收窄成"这一支"。
   */
  /** 根会话 id -> 正在跑的 agent id 集合（子 agent 算进它的根会话） */
  const runningByRoot = new Map()
  /** agent id -> 它归属的根会话 id（子 agent 指向 parentSession） */
  const rootOfAgent = new Map()
  let settleTimer = null
  /** 取消过一次、还没补响的：等真安静下来给boss补一声 */
  let pendingRefire = false
  /**
   * 这个 agent 归哪个根会话管。
   * 【怎么找根会话】`payload.agent` 是活的 Agent 对象，它带 `.session`；
   * 子 agent 的 session 有 `header.parentSession`（指向主会话），
   * 主会话没有 ⇒ 它自己就是根。
   * ⚠️ 拿不到就退化成「按 agent 自己算一个根」——宁可多响一声，
   *    也不能因为读不到父子关系就永远不响。
   */
  const resolveRoot = (agent) => {
    try {
      const session = agent?.session
      const parent = session?.header?.parentSession
      if (parent) return String(parent)
      return String(agent?.id ?? 'unknown')
    } catch {
      return String(agent?.id ?? 'unknown')
    }
  }
  /** 是不是子 agent（有主的） */
  const isChildAgent = (agent) => {
    try {
      return Boolean(agent?.session?.header?.parentSession)
    } catch {
      return false
    }
  }
  const rootRunning = (root) => runningByRoot.get(root)?.size ?? 0
  const cancelSettle = () => {
    if (settleTimer === null) return
    clearTimeout(settleTimer)
    settleTimer = null
  }
  /**
   * 真正「这一趟算完成」的动作：静默期满、这一支也空，才落这一次。
   * 【10-20 20:1x】带上了 pendingRefire —— 之前那次被别的事拽走的，这里一并算，
   * 不再吞掉。
   */
  const fireDone = (why) => {
    cancelSettle()
    pendingRefire = false
    lastDoneAt = Date.now()
    lastDoneKind = 'done'
    trace(`响：${why}`)
  }
  /**
   * 排一次静默计时。
   * 【10-20 23:5x】**只看这一支**（root 这一支还有几个在跑），
   * 不再看别的会话 —— 别的会话在跑跟我这一支没关系。
   */
  const scheduleDone = (why, root) => {
    if (rootRunning(root) > 0) return
    if (settleTimer !== null) return // 已经排过了，别重复排
    trace(`等 ${BELL_SETTLE_MS}ms：${why}`)
    settleTimer = setTimeout(() => {
      settleTimer = null
      if (rootRunning(root) > 0) {
        // 静默期间这一支又被拽走了：记住要补，等真安静下来那轮补响（B 方案 ②）
        pendingRefire = true
        trace('被别的事拽走，记下待补')
        return
      }
      fireDone(pendingRefire ? '补响（之前那次被拽走了）' : why)
    }, BELL_SETTLE_MS)
  }
  if (typeof ctx?.on === 'function') {
    try {
      offStatus = ctx.on('agent/status', (payload) => {
        try {
          const status = payload?.status
          const agent = payload?.agent ?? null
          const who = String(payload?.id ?? agent?.id ?? 'unknown')
          const root = resolveRoot(agent)
          const child = isChildAgent(agent)
          if (status === 'running') {
            // 又跑起来了：刚才排的静默作废（但要记住补，见 scheduleDone）
            if (settleTimer !== null) pendingRefire = true
            cancelSettle()
            rootOfAgent.set(who, root)
            if (!runningByRoot.has(root)) runningByRoot.set(root, new Set())
            runningByRoot.get(root).add(who)
            return
          }
          if (status !== 'idle') return
          // 归到它那一支去摘；摘不到就说明本来没在跑（不是本支的活），不动别的支
          const set = runningByRoot.get(root)
          if (set) {
            set.delete(who)
            if (set.size === 0) runningByRoot.delete(root)
          }
          rootOfAgent.delete(who)
          if (child) {
            // 子 agent 干完不算 —— 主任务还在跑，等主会话那边响
            trace(`子任务干完（还剩 ${rootRunning(root)} 个在本支），先别响`)
            return
          }
          const left = rootRunning(root)
          if (left > 0) {
            trace(`本支还有 ${left} 个在跑，先别响`)
            return // 这一支里还有别人在跑（子 agent），先别响
          }
          scheduleDone('这一支都空闲了', root)
        } catch {
          /* 单次回调出错不影响换肤 */
        }
      })
    } catch {
      offStatus = null
    }
    /**
     * ═══ 【10-20 20:1x B 方案 ① a)】记账本的清理口子 ═══
     *
     * 原来只有 "agent/status" 一条路往本子上加名字、摘名字，**没有任何清理**。
     * 后果：某个后台小任务的"空闲"广播一旦没被收到（广播早于插件挂上、或监听掉了），
     * 这个名字永远留在本子里 → 之后每次判断都发现"本子不空" → 一次都不响。
     *
     * 任务被收掉（agent/disposed）时把它的名字划掉，划完**再评估一次**：
     * 万一是它卡住才不响的，这一步就补回来了。
     *
     * 【10-20 23:5x】跟着新的「按支记账」一起改：名字挂在**它那一支**下面，
     * 划完只看**这一支**空没空（别的支在跑跟我无关）。
     */
    try {
      offDisposed = ctx.on('agent/disposed', (payload) => {
        try {
          const agent = payload?.agent ?? null
          const who = String(payload?.id ?? agent?.id ?? 'unknown')
          const root = rootOfAgent.get(who) ?? resolveRoot(agent)
          const set = runningByRoot.get(root)
          if (!set || !set.has(who)) return
          set.delete(who)
          if (set.size === 0) runningByRoot.delete(root)
          rootOfAgent.delete(who)
          trace(`任务被收掉，划掉 ${who}（本支还剩 ${rootRunning(root)}）`)
          if (rootRunning(root) === 0) scheduleDone('划完之后这一支空了', root)
        } catch {
          /* 单次回调出错不影响换肤 */
        }
      })
    } catch {
      offDisposed = null
    }
    /**
     * ═══ 【10-19 22:1x boss：「当出现需要人工判断的时候，也需要加提示音」】═══
     *
     * 「需要人工判断」在这套应用里有两个入口，两个都听：
     *
     * ① `approval/asked` —— **落地会话事件**（在 `KNOWN_SESSION_EVENT_TYPES` 里），
     *    载荷 `{ id, toolName, callId?, reason? }`：某个工具要作者批准才能往下走。
     *    它不会改 agent 状态（还是 running），所以「完成」那条路根本看不见它。
     *    【10-20 00:0x】主机端**收不到**它（按作用域发的，插件挂在旁边那一支），
     *    真机实测 `bell.at` 一直是 0。这条留着当兜底，真响走的是页面侧那条通道
     *    （`client.js` 里 `remote.$on('approval/request')`，20:1x 已实测能收到）。
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
        pendingRefire = false // 人都被卡住了，别补那次完成了
        lastDoneAt = Date.now()
        lastDoneKind = 'ask'
        trace(`响（要人判断）：${why}`)
        ctx.logger?.info?.(`dsh-skin: 需要作者判断（${why}）`)
      } catch {
        /* 记不上也不影响响 */
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
      for (const off of [offStatus, offDisposed, offApproval, offQuestion]) {
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
