/**
 * 本轮三件事的静态核验:① 蓝字档 ② 毛玻璃+滑杆恢复 ③ 自定义音效
 * 判据全部从源文件读,不手抄。
 */
const fs = require('fs')
const path = require('path')

const CLIENT = fs.readFileSync(path.join(__dirname, '..', 'plugin', 'client.js'), 'utf8')
const HOST = fs.readFileSync(path.join(__dirname, '..', 'plugin', 'index.js'), 'utf8')

let fails = 0
const ok = (label, cond, detail) => {
  if (!cond) fails += 1
  console.log(`${cond ? 'OK  ' : 'FAIL'} ${label}${detail ? '  ' + detail : ''}`)
}

console.log('══ ① 默认只有黑/白,蓝字是例外(作者 10-19 00:56 打回)══')
ok('蓝字调色板还留着(不删,以后要窄判据再接回来)', /const BLUE_INK = \{[\s\S]{0,200}primary: '#0b57d0'/.test(CLIENT))
/**
 * 【10-19 16:2x 口径变了】作者报「文字通篇蓝色」→ 蓝字档整个撤掉。
 * 现在字色只有黑/白两档，判据只有一个源头：inkToneFor（壁纸明暗）。
 * 旧的两条判据（imageBright / wash>0.08）必须**不在**了 —— 它们正是
 * 「自动底线把 wash 抬起来之后，18 张亮图重新变蓝」的那条漏网路。
 */
ok('字色只按壁纸明暗出黑白两档(inkToneFor 是唯一源头)', /const band = inkToneFor\(entry, scheme\)/.test(CLIENT))
ok('旧蓝字判据已彻底拿掉(壁纸亮 + wash>0.08 这条漏网路)', !/imageBright && brightVeil/.test(CLIENT) && !/brightVeil = veilLum/.test(CLIENT))
ok('蓝字不再被自动选用(ink 只可能是 LIGHT_INK / DARK_INK)', /const ink = band === 'white' \? LIGHT_INK : DARK_INK/.test(CLIENT))
ok('注释里记着作者两次打回的原话', /我们默认的字体只有黑跟白两种[，,]这就不对了[，,]这是一个 bug/.test(CLIENT) && /文字通篇蓝色/.test(CLIENT))

console.log('')
console.log('══ ② 背景明度滑杆回来了,三个模式才不是摆设(作者 10-19 18:5x 打回) ══')
/**
 * 【口径第三次变】00:56 作者说「不要遮罩」→ 我当时把整栏删了、wash 写死 0；
 * 18:5x 他打回:「你把图片背景的明度、透明度给删掉了…要不然我们『休闲』『专注』
 * 和『正常』这三个模式都用不了了」。现在滑杆回来了，模式的值也重新生效。
 * 这两条是**成对**的：控件删了、语义跟着废，模式就成了摆设 —— 判据要把两半都盯住。
 */
ok('明度滑杆回来了(type=range + setWash)', /type: 'range'[\s\S]{0,600}setWash\(clamp\(Number\(event\.target\.value\), 0, MAX_WASH\), false\)/.test(CLIENT))
/**
 * 【口径第四次变，10-19 20:2x 作者：「为什么是从 9 开始的」】
 * 滑杆左端原来顶着「自动底线」（那张图算出来是 9），写着 0~40 却拖不到 0。
 * 现在左端就是 0；底线只当一行建议，不再改数值、不挡手。
 */
ok('滑杆真的从 0 起（不是从这张图的底线起）', /min: 0,\s*\n\s*max: MAX_WASH,/.test(CLIENT) && !/min: floorPct,/.test(CLIENT))
ok('拖到 0 就是 0：底线不再抬数值', !/Math\.max\(base, floor\)/.test(CLIENT) && !/Math\.max\(FOCUS_MASK, floor\)/.test(CLIENT))
ok('底线降级成一行建议（还看得见，只是不挡手）', /建议不低于 \{n\}%/.test(CLIENT) && /dict\.washFloor\.replace/.test(CLIENT))
ok('松手/失焦立刻落盘(不是每动一下写一次)', /onMouseUp: \(\) => flushWash\(\)/.test(CLIENT) && /onBlur: \(\) => flushWash\(\)/.test(CLIENT))
ok('专注模式的值真的生效', /state\.mode === 'focus'\) \{[\s\S]{0,160}Math\.round\(FOCUS_MASK\)/.test(CLIENT))
ok('休闲模式的值真的生效', /state\.mode === 'leisure'\) \{[\s\S]{0,160}Math\.round\(LEISURE_MASK\)/.test(CLIENT))
ok('正常档:手调值优先,没手调过(null)才走每张图自己的基准',
  /raw === null \|\| raw === undefined \? null : Number\(raw\)/.test(CLIENT) &&
    /manual === null \|\| !Number\.isFinite\(manual\) \? Number\(entry\?\.autoMask \?\? 0\) : manual/.test(CLIENT),
  '注意 Number(null)===0，不能拿 isFinite 判「有没有手调过」')
ok('专注档的盖不低过它自己(不然 35 被悄悄削掉)', /Math\.max\(MAX_WASH, FOCUS_MASK\)/.test(CLIENT))
ok('模式把滑杆锁上时给一句明话(不是灰着不解释)', /disabled: locked,/.test(CLIENT) && /dict\.washLocked/.test(CLIENT))
ok('「按图片自动」按钮仍然没有(00:56 点名不要)', !/dict\.washAuto/.test(CLIENT))
ok('那句长提示(遮罩0=最清楚,35=…)仍然没有(同样点名不要)', !/dict\.maxWash/.test(CLIENT))
{
  // 文案里的数字必须跟代码里的常量一致 —— 防「模式说 75%、实际 28%」这种撒谎
  const focus = Number((CLIENT.match(/const FOCUS_MASK = (\d+)/) || [])[1])
  const leisure = Number((CLIENT.match(/const LEISURE_MASK = (\d+)/) || [])[1])
  const zh = CLIENT.slice(CLIENT.indexOf("modeFocusHint:"), CLIENT.indexOf("gallery:"))
  ok('模式提示文案里的数跟代码常量一致', zh.includes(focus + '%') && zh.includes(leisure + '%'), `代码是 专注${focus}% / 休闲${leisure}%`)
}

console.log('')
console.log('══ ③ 自定义音效:上传修好 ══')
ok('读请求体的上限单独放大(64MB),不再拿图片的上限卡音频',
  /const MAX_BODY_BYTES = 64 \* 1024 \* 1024/.test(HOST))
ok('读体闸换成新上限', /if \(size > MAX_BODY_BYTES\)/.test(HOST))
ok('decodeDataUrl 支持按类型传上限', /function decodeDataUrl\(value, maxBytes = MAX_IMAGE_BYTES\)/.test(HOST))
/**
 * 【10-19 14:0x 口径变了】以前是「先按 8MB 解、超了就报 bad sound」——
 * 作者只能看到一句「bad sound」。现在先按读体上限解出来，再单独判 8MB，
 * 报的才是「单个音效最多 8MB」这句人话。
 */
ok('音频按 8MB 判(不是 24MB)，且超限报的是人话',
  /decodeDataUrl\(payload\.data, MAX_BODY_BYTES\)/.test(HOST) &&
    /if \(audio\.buffer\.length > MAX_SOUND_BYTES\)[\s\S]{0,160}单个音效最多/.test(HOST))
ok('上传失败会在面板上显示一句明话(不再静默)',
  /soundNote/.test(CLIENT) && /String\(error\?\.message/.test(CLIENT))
ok('格式不对、文件太大各有各的提示', /这个格式用不了/.test(CLIENT) && /这个文件超了 \$\{Math\.round\(caps\.maxBytes/.test(CLIENT))
ok('提示显示在面板上', /soundNote\s*\n?\s*\? h\('div'/.test(CLIENT))

console.log('')
console.log('══ ③ 自定义音效(作者 00:20 要的「添加窗口」)══')
ok('主机端开了 sounds 接口', /const SOUNDS_PATH = '\/dsh-skin\/sounds'/.test(HOST))
ok('主机端开了音频本体接口', /const SOUND_FILE_PATH = '\/dsh-skin\/sound'/.test(HOST))
ok('两条路由都注册了', /path: SOUNDS_PATH, handler: handleSounds/.test(HOST) && /path: SOUND_FILE_PATH, handler: handleSoundFile/.test(HOST))
ok('存到文件里(换端口不丢)', /soundsDir = imageDir === '' \? '' : join\(dirname\(imageDir\), 'sounds'\)/.test(HOST))
ok('音频有格式白名单', /SOUND_MIME_BY_EXT = \{[\s\S]{0,200}\.mp3/.test(HOST))
ok('单个音频有大小封顶', /MAX_SOUND_BYTES = 8 \* 1024 \* 1024/.test(HOST))
ok('能删(连文件一起)', /await rm\(join\(soundsDir, `\$\{id\}\$\{entry\.ext\}`\), \{ force: true \}\)/.test(HOST))
ok('soundId 会落盘', /next\.soundId = typeof next\.soundId === 'string' \? next\.soundId : ''/.test(HOST))
ok('默认空串 = 用内置那声叮', /soundId: ''/.test(HOST))

ok('页面也有添加按钮', /dict\.soundAdd/.test(CLIENT))
ok('页面有文件选择框(隐藏的,点按钮唤起)',
  /ref: soundFileRef,\s*\n\s*type: 'file',\s*\n\s*accept: 'audio\/\*'/.test(CLIENT))
ok('选完文件清空 value(同一个文件能再选第二次)', /event\.target\.value = ''/.test(CLIENT))
ok('导入函数存在且有校验', /async function importSound\(/.test(CLIENT))
ok('导入校验格式', /\.mp3', '\.wav', '\.ogg', '\.m4a', '\.aac', '\.flac', '\.webm'/.test(CLIENT))
ok('导入校验大小(单个上限，数值从 caps 取、不写死)', /file\.size > caps\.maxBytes/.test(CLIENT))
ok('能选中/取消选中', /async function selectSound\(/.test(CLIENT))
ok('能删除', /async function removeSound\(/.test(CLIENT))
ok('删掉正在用的那个会自动退回内置音效', /if \(state\.soundId === id\) \{[\s\S]{0,400}soundId: ''/.test(CLIENT))
ok('面板打开时拉列表', /void loadSoundList\(\)/.test(CLIENT))
ok('播放用自定义文件而不是合成音', /if \(state\.soundId\) playCustomSound\(\)/.test(CLIENT))
ok('播放函数用 <audio> 元素', /customAudio = new Audio\(url\)/.test(CLIENT))
ok('同一个文件复用同一个元素(不反复请求)', /customAudioUrl !== url/.test(CLIENT))
ok('列表为空时有提示(不会看着像坏了)', /dict\.soundEmpty/.test(CLIENT))
ok('删除按钮有中文提示词', /soundRemove: '删掉这个音效'/.test(CLIENT))
ok('英文提示词也齐全', /soundRemove: 'Delete this sound'/.test(CLIENT))

console.log('')
console.log('══ ③b 提示音「提前响」的三道防线(作者 10-19 20:4x) ══')
/**
 * 作者原话：「有的时候任务还没跑完，但是它就已经声音提醒你了，基本上过一两分钟才结束。」
 * 两个原因：① 维护阶段（压缩上下文）也被应用报成 idle；
 *          ② 广播是所有 agent 的，子 agent 先干完也报 idle。
 * 判据都对着主机端源码，细则见 index.js 那段注释。
 */
ok('维护阶段的假空闲被排除', /phase\?\.kind === 'maintenance'/.test(HOST))
ok('按 agent 记账（子 agent 先完不响）', /runningAgents\.add\(who\)/.test(HOST) && /runningAgents\.delete\(who\)/.test(HOST))
ok('还有人跑着就不响', /if \(runningAgents\.size > 0\) return/.test(HOST))
ok('静一静再响（短促抖动取消）', /BELL_SETTLE_MS/.test(HOST) && /cancelSettle\(\)/.test(HOST))
ok('静一静的默认值 3 秒（可被 config 覆盖，测试用）', /: 3000$/.test(HOST.split('\n').find((l) => l.includes('BELL_SETTLE_MS =')) || ''))
ok('卸载时把定时器清掉', /cancelSettle\(\) \/\/ 卸载时别把定时器留在那儿/.test(HOST))

console.log('')
console.log('══ ④ 毛玻璃还在(遮罩删了但毛玻璃不删) ══')
ok('毛玻璃钩子还在', /--dsw-mask-blur:blur\(28px\)/.test(CLIENT) && /--dsw-menu-backdrop-filter:blur\(44px\)/.test(CLIENT))
ok('毛玻璃跟着壁纸一起挂', /frostedCssFor\(\)/.test(CLIENT))
ok('surfaces 用「垫底色混壁纸」的真实颜色',
  /blendedSurface\(scheme, layer\.name, alpha, toneRgb, wantsWhite\)/.test(CLIENT))

console.log('')
console.log('══ ⑥ 系统图标色(作者 07:15 / 08:03 / 08:45 三次报)══')
ok('图标色不再跟文字三级色走', !/tokens\['--dsw-alias-menu-icon'\] = both\(fixIfBlind\(ink\.tertiary/.test(CLIENT))
// 08:45 的定稿:从**真正写进去的菜单底色**反推,不再自己另算一遍背景
// 10-19 09:5x 再收一刀:菜单材质那层真正用的是 --dsw-menu-surface-fill
// (--dsw-specific-menu 只是它的别名),所以优先读前者。
ok('图标色按「写好的菜单底色」反推(不再自己算背景)',
  /const menuToken =\s*\n?\s*\(\(tokens\['--dsw-menu-surface-fill'\] \|\| tokens\['--dsw-specific-menu'\]\) \|\| \{\}\)\.light \|\| ''/.test(CLIENT))
ok('菜单材质那枚底(--dsw-menu-surface-fill)也洗了',
  /\{ name: '--dsw-menu-surface-fill'/.test(CLIENT))
ok('判据用 parseColorWithAlpha 读回真实值', /const menuRgb = parseColorWithAlpha\(menuToken\)/.test(CLIENT))
ok('底亮→黑图标,底暗→白图标', /menuLum > 0\.45 \? '#1a1c20' : '#ffffff'/.test(CLIENT))
ok('图标色不再走 fixIfBlind(推色会拿壁纸当基准,推反方向)', !/menu-icon'\] = both\(fixIfBlind/.test(CLIENT))
// 08:03 那次「侧栏压暗」实际刷成了 82% 的白,是作者说的白色充填底衬 —— 必须撤掉
ok('侧栏 82% 白垫已撤掉(那正是作者说的白色充填底衬)', !/sidebarVeil/.test(CLIENT))
ok('图标色只有一处来源(以前两处,后者覆盖前者,改漏就白改)',
  (CLIENT.match(/tokens\['--dsw-alias-menu-icon'\] = /g) || []).length === 1)
ok('注释里记着作者原话', /图标里面应该显示黑色,但是现在看不到了/.test(CLIENT))

console.log('')
console.log('══ ⑧ 悬浮球默认位抬到输入框上沿(作者 10-19 07:30)══')
ok('默认位不再贴右下角(right:24/bottom:24 已删)', !/position: 'fixed', right: 24, bottom: 24/.test(CLIENT))
ok('默认位改成算出来的 restY', /top: restY === null \? Math\.max\(80, \(window\.innerHeight \|\| 700\) - 176\) : restY/.test(CLIENT))
ok('会自己去找输入框', /querySelectorAll\('textarea, \[contenteditable="true"\], input\[type="text"\]'\)/.test(CLIENT))
ok('只认屏幕中下部的输入框(侧栏顶部的不算)', /rect\.top < vh \* 0\.5/.test(CLIENT))
ok('球的下沿贴输入框上沿 + 12px 空隙', /top - 56 - 12/.test(CLIENT))
ok('找不到输入框有保守兜底(视口高 - 176)', /Math\.max\(80, vh - 176\)/.test(CLIENT))
ok('窗口尺寸变了会重算', /window\.addEventListener\('resize', find\)/.test(CLIENT))
ok('输入框是后渲染的,晚一点再找两次', /setTimeout\(find, 600\)[\s\S]{0,80}setTimeout\(find, 1800\)/.test(CLIENT))
ok('贴着底边的旧存档位置一律作废', /stuckToBottom/.test(CLIENT))
ok('松手时还在挡输入框 → 抬回去且不存盘', /if \(vh > 0 && at\.y > vh - 56 - 40\)/.test(CLIENT))
ok('注释里记着作者原话', /它会挡着确认键/.test(CLIENT))

console.log('')
console.log('══ ⑨ 回归:wantsWhite 的作用域 ══')
ok('wantsWhite 声明在两个 if 块之外(00:40 又栽在这里)',
  /const wantsWhite = !!entry && inkToneFor\(entry, activeScheme\(\)\) === 'white'/.test(CLIENT),
  '这是 23:18 / 00:40 两次栽过的同一个坑')

console.log('')
console.log('══ ⑩ 音效批量添加 + 容量上限(作者 10-19 13:55 选的 B:单个 8MB / 总量 200MB / 30 条)══')
const hostNum = (name) => {
  const m = HOST.match(new RegExp('const ' + name + ' = ([\\d *]+)'))
  return m ? m[1].split('*').map((s) => Number(s.trim())).reduce((a, b) => a * b, 1) : NaN
}
const clientFallback = CLIENT.match(/SOUND_CAPS_FALLBACK = \{ maxBytes: ([\d *]+), maxCount: (\d+), totalBytes: ([\d *]+) \}/)
const calc = (s) => (s ? s.split('*').map((x) => Number(x.trim())).reduce((a, b) => a * b, 1) : NaN)
ok('选文件框开了多选(不加 multiple 就框选不了多个)', /accept: 'audio\/\*',[\s\S]{0,260}multiple: true/.test(CLIENT))
ok('选中多个会整批交出去(不再只取 files[0])',
  /const picked = Array\.from\(event\.target\.files \|\| \[\]\)[\s\S]{0,120}void importSounds\(picked\)/.test(CLIENT))
ok('批量是逐个上传、不是合成一个大请求(防撞 64MB 读体上限)',
  /for \(const file of picked\)[\s\S]{0,200}importSound\(file, true\)/.test(CLIENT))
ok('批量结束给一句汇总(进了几个/没进几个/为什么)', /加进去 \$\{tally\.added\} 个,没进去 \$\{failed\} 个/.test(CLIENT))
ok('没进去的原因分得开(格式/超大小/条数满/总量满/主机没收)',
  ['bad', 'big', 'full', 'space', 'fail'].every((k) => new RegExp(`tally\\.${k}`).test(CLIENT)))
ok('主机端拦下来的那句人话会传到面板(不再只显示英文状态码)',
  /const body = await response\.json\(\)[\s\S]{0,120}detail = String\(body\?\.error/.test(CLIENT))
ok('页面和主机端的三个数不漂(8MB / 30 条 / 200MB)',
  hostNum('MAX_SOUND_BYTES') === calc(clientFallback && clientFallback[1]) &&
    hostNum('MAX_SOUND_COUNT') === Number(clientFallback && clientFallback[2]) &&
    hostNum('MAX_SOUND_TOTAL_BYTES') === calc(clientFallback && clientFallback[3]),
  `主机 ${hostNum('MAX_SOUND_BYTES') / 1048576}MB/${hostNum('MAX_SOUND_COUNT')}条/${hostNum('MAX_SOUND_TOTAL_BYTES') / 1048576}MB`)
ok('主机端两道闸都在写盘之前拦(条数 + 总量)',
  /list\.length >= MAX_SOUND_COUNT[\s\S]{0,600}after > MAX_SOUND_TOTAL_BYTES/.test(HOST))
ok('覆盖同一条会把旧的占用先减掉', /usageBefore\.used - existingBytes \+ audio\.buffer\.length/.test(HOST))
ok('索引里记了占用字节(不然总量算不出来)', /bytes: audio\.buffer\.length/.test(HOST))
ok('老索引没存 bytes 的会去量文件(不把总量当 0)', /async function soundBytes[\s\S]{0,400}stat\(join\(soundsDir/.test(HOST))
ok('每次回话都带 usage(页面那张「已用/上限」靠它)', (HOST.match(/usage: await soundUsage\(list\)/g) || []).length >= 3)
ok('面板上显示容量那一行(中英都有)', /soundQuota: '容量/.test(CLIENT) && /soundQuota: 'Storage/.test(CLIENT))

console.log('')
console.log(fails === 0 ? '全部通过' : `有 ${fails} 项没过`)
process.exitCode = fails === 0 ? 0 : 1
