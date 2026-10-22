/**
 * dsh-skin —换肤插件 · 页面(Client half)
 *
 * 能力:
 *   1. 图库:选图片/ 选整个文件夹 / 拖进来/ 粘贴,单张横竖图都收 *   2. 背景明度(遮罩深浅):按每张图自己的亮度自动配一个基准，也能手调
 *   3. 专注模式(遮罩 75%) / 休闲模式(遮罩 10%),两者互相 *   4. 文字颜色:跟随主题(默认) / 按图的深浅自动/ 手动深字浅字
 *   5. 竖图三种铺法:铺满 / 模糊填充 / 立绘贴侧
 *
 * 两个入口:右下角可拖动圆钮 + 设置页里的「换肤」一页面 *
 * 算法出处:同系列换肤脚本(<本机工作目录>\skills\
 * skin-studio\studio\src\skin-menu.mjs),照抄了它的取色遮罩基准/竖图合成
 * 的做法常量原样:采样 48、入库长 2560 webp 0.92、缩略图长边 320 webp 0.8  * 遮罩分界 0.50、暗图基 28 / 亮图基准 58、专 75 / 休闲 10  *
 * 关键做法:文字颜色和背景透明度都采DSH 原生的ctx.theme.overrideTokens,
 * 背景图本身是一层CSS 铺在 html 上。两样都是叠加层,一撤就完全还原,
 * 不碰任何安装文件,以后更新 DSH 不会把它冲掉。 */

window.__ModuleLoader__.load({
  id: '@local/dsh-skin',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useEffect, useMemo, useRef, useState } = React

    // ── 路径与常量?────────────────────────────────────────
    const base = document.baseURI || 'http://localhost/'
    const STATE_PATH = new URL('dsh-skin/state', base).pathname
    const LIBRARY_PATH = new URL('dsh-skin/library', base).pathname
    const IMAGE_PATH = new URL('dsh-skin/image', base).pathname
    const DIAG_PATH = new URL('dsh-skin/diag', base).pathname
    const BELL_PATH = new URL('dsh-skin/bell', base).pathname
    const SOUNDS_PATH = new URL('dsh-skin/sounds', base).pathname
    const SOUND_PATH = new URL('dsh-skin/sound', base).pathname
    /**
     * 彩蛋：渠道限流贴纸的数据源（主机端那个接口）。
     * 【2026-10-20 boss】界面上一个说明字都不给，但代码在。
     * 交互：单击悬浮球 3 次浮现，再单击 3 次关闭；贴纸右上角有个「叉」可直接关。
     */
    const CHANNEL_LIMITS_PATH = new URL('dsh-skin/channel-limits', base).pathname
    /**
     * 【10-22 08:0x boss选 B】更新检查接口（主机端去问远端仓库版本）。
     * boss问「别人下载了 GitHub 上的插件，我们更新之后他会收到升级通知吗」——
     * 答案是不会（详见主机端那段注释），所以这里自己做提示。
     */
    const UPDATE_CHECK_PATH = new URL('dsh-skin/update-check', base).pathname
    /** 推荐项目（boss自己的项目）—— 取 Star / Fork / 最近提交的真数字 */
    const PROJECTS_PATH = new URL('dsh-skin/projects', base).pathname
    /**
     * 【10-22 09:0x boss】自动更新的三步（界面各一个按钮，绝不合并成一个"一键更新"）：
     *   ① update-manifest 读远端清单
     *   ② update-download **只下载到旁边**，不动现装的那份
     *   ③ update-apply    **您点了确认才替换**（先备份，失败自动回滚）
     */
    const UPDATE_MANIFEST_PATH = new URL('dsh-skin/update-manifest', base).pathname
    const UPDATE_DOWNLOAD_PATH = new URL('dsh-skin/update-download', base).pathname
    const UPDATE_APPLY_PATH = new URL('dsh-skin/update-apply', base).pathname
    const SOURCE = 'dsh-skin:appearance' // 覆盖层身份同一个source 只会有一层
    const PANEL_WIDTH = 460 // 浮窗面板宽度上限,实际宽度还要看屏幕放不放得下
    const PANEL_GAP = 12 // 面板和圆钮之间留的空
    const PANEL_MARGIN = 8 // 面板离屏幕边至少留这么多
    const PANEL_MIN_HEIGHT = 240 // 面板至少要这么高才值得往那边开
    const PANEL_MAX_RATIO = 0.78 // 面板最多占屏幕多高

    const SAMPLE_WIDTH = 48 // 取色采样宽度(skill 原值
    const IMG_MAX_EDGE = 1920 // 入库长边
    const IMG_QUALITY = 0.86
    const THUMB_MAX_EDGE = 256 // 缩略图长边
    const THUMB_QUALITY = 0.75
    const LUMA_THRESHOLD = 128 // 平均亮度分界:0-255  128,，0.50(skill 原值
    // 遮罩基准整体压低(boss 10-18 01:07 / 01:20 两轮实测):
    //   浅色 25% 就盖掉背景、深色图 40% 就发白—两档都往下收，
    // 遮罩越高 = 主题底色盖得越实 = 背景图越淡。boss要的是「看得见图，所以全部往下收。
    const AUTO_MASK_DARK = 12
    const AUTO_MASK_LIGHT = 6
    // 滑杆上限 40（boss 10-19 19:2x：「透明度你应该调整到 0~40%」）
    // 【跟主机端必须一致】index.js 里还有一道写盘前的夹取（MAX_WASH）——
    // 两边不一致的话，滑杆能拖到 40、存进去却被悄悄夹回 25，拖完自己弹回去。
    // `verify/mode_wash_check.cjs` 有一条判据专门盯这两处不许漂。
    const MAX_WASH = 40
    // 专注模式:压实档。5 太白 → 45 boss仍嫌高 → 28 → 【10-19 19:5x boss定 35】
    const FOCUS_MASK = 35
    // 休闲:几乎不盖,图最大程度露出来。【10-19 19:5x boss定 5】(原来 3)
    const LEISURE_MASK = 5

    /**
     * ═══ 判黑白字:boss 10-18 21:30 亲口定的三档口径 ═══
     *
     * 原话(21:30):「明度低于 10 用白字,明度高于 15 用黑字,
     * 介于这中间:黑白都可以,或者用默认的。」
     *
     * 原来只有一个分界点 0.18,低于它全判白字。boss嫌粗。
     * 【为什么这么改是有数的】1387 张全扫过:按 0.18 判有 371 张(26.7%)走白字,
     * 而其中 109 张整图明度其实在 0.15~0.18 之间——那不是暗图,是被误判的。
     * 收紧成三档之后白字只剩 115 张(8.3%),这一档实测 98% 的图用白字明显更好。
     * 说不清的那一档压到 147 张(10.6%),交给主题自己决定黑还是白。
     */
    const INK_WHITE_MAX = 0.1 // 低于这个亮度 → 白字
    const INK_BLACK_MIN = 0.15 // 高于这个亮度 → 黑字
    /**
     * 【10-18 22:15 boss给的切块判据】一个方块的平均亮度低于 CELL_DARK_MAX 算「黑块」,
     * 高于 CELL_LIGHT_MIN 算「白块」,中间的是灰块。
     *
     * 【22:22 定档】用 sRGB 感知亮度(0-1):0.35 是「人眼看着明显暗」,0.65 是「明显亮」。
     * 中间那一大片就是boss说的灰。
     * 【22:20 走过一段弯路】第一版用 WCAG 相对亮度 + 0.05/0.35,拿boss那两张夜景实测
     * **暗块占比 0%**,79%~90% 全掉进灰块 —— WCAG 那个尺度是给算对比度用的,
     * 它把中暗色调得太亮,人眼看夜景的深蓝天空明明就是黑的,它却算成中间色。
     */
    const CELL_DARK_MAX = 0.35
    const CELL_LIGHT_MIN = 0.65
    /**
     * 黑块和白块的面积差要超过这么多才算「一边明显多」,否则交给灰块定夺。
     * 不设这道门槛的话 51:49 这种会来回翻色,同一张图切两次结果不一样。
     */
    const CELL_SHARE_EDGE = 0.05
    /**
     * ═══ 自动垫底:boss 10-18 21:40 定的「一起都改」 ═══
     *
     * 【boss报的坑,原话】「图片偏黑灰,你的文字也是黑的,基本上看不太清。
     * 这时候透明度就只有 12%,如果再低基本上就看不到文字了。」
     *
     * 拿他那张车库图实测过(2026-10-18 21:26):
     *   透明度 0% → 黑字最差 1.50:1   6% → 3.00:1   12% → 4.51:1
     * 也就是说 12% 就是这张图的下限,boss的手感一分不差。
     * 以前这个 12% 要他自己拖,而且拖下去就看不清了 —— 滑杆能往下走,没有底。
     * 现在改成:每张图算一条**自动底线**,滑杆拖不下去,系统先保它看得清。
     *
     * 【为什么封顶 20%】实测全库要垫多少:保到一半的图达到 3:1 平均要垫 12%,
     * 保到 4.5:1 要垫 21%,个别图能要 40%。垫到 40% 等于把壁纸洗成白墙,
     * 正是boss 19:05 骂过的「发雾」。所以封顶 20%:该垫的垫,不许把图洗没。
     */
    const AUTO_FLOOR_TARGET = 3 // 底线要保到的对比度(WCAG 对大字/图标的线)
    const AUTO_FLOOR_CAP = 20 // 底线封顶(boss 10-18 21:40 定的)
    const PORTRAIT_BLEED = 1.2 // 竖图模糊填充时向外多铺的比例(skill 原值
    // 图库分页:boss库里 600 多张，一次性渲染600 个缩略图会把整个界面拖死
    // (换张图要十几秒。一次只 60  点「加载更多」再下一批。
    const PAGE_SIZE = 60

    // 悬浮球头像(内嵌在代码里),内嵌 base64,不依赖任何外部路径
    const AVATAR = [
      '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAkGBwgHBgkICAgKCgkLDhcPDg0NDhwUFREXIh4jIyEeICAlKjUtJScyKCAgLj8v',
      'Mjc5PDw8JC1CRkE6RjU7PDn/2wBDAQoKCg4MDhsPDxs5JiAmOTk5OTk5OTk5OTk5OTk5OTk5OTk5OTk5OTk5OTk5OTk5OTk5',
      'OTk5OTk5OTk5OTk5OTn/wAARCACXAIADASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAA',
      'AgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6',
      'Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXG',
      'x8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREA',
      'AgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5',
      'OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPE',
      'xcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD2+iiigAooooARnVFLsQqqMknoBXOtcN4p',
      'tZTbXctrpAYo08QAe5xwdpP3V7Z6ntVb4itezaXBplhHLJLfSbXEfUoBkj8eK07SKxj0WC3ePyoYolGyQY8rAHXsMd60UbRU',
      'upN7uxzGpfDqCIQ3GiXctlNAd6723fMCMHOOMc13S7kTY0xaQLnJAGffFee6z8SYIy1vYxiXbmOS4fOz/gKjljXJTePdelZT',
      'HdSG32lBGkKqSPckVt7KrUXvE80Y7HtEEly86xtJGyhMllTHPbvUk17DatEt1LHEZW2RljgMfT615LpXjjVrQ7rjy7pZAPMS',
      'RNjAexFd7o/iHT/EkawMqByd5hlAJAHTHqfpUToShq9hqcWdKCCMggilzVWaWK1jWYnbEcA8cAdM+1WRyMjmsSxRRQKKQBS0',
      'lFABRRRQAUUVFcSeTEXOPTnpzQBC8jiT7RsDQqnBH3gO5/lXlPjzxR/alxLZ2Ev+jR/JJIhI80/4Cuq8ea6+kaI9vAT9onXZ',
      'Gyt9z1I/z3ryi0iHkJGxILtlj6Dv/n3rtw1K/vMxqS6ILW2ATdxu6AEVcWKTZ5Yb5OualEqR4EcY+8Dk98c/0q8k1mY/MeMi',
      'XB+UdCa70jnbMqSAYHJB/wA9KliMiQ70ZkliIZXU4IqdblxIX2KVIGcjjjgfjioDKVk6AIw24osg1PTPA/iQ6tA1tfvuuo1z',
      'yf8AXL/e/oRXWxODI6KCFGCPx9K8X8NTtBdHyji4iffASM8ngg+x4/EV6N/attDFa6rdaiUQ8LEnLP6gjvj9K86vRtL3ep0w',
      'qJrXodQKKZE6yxJIudrqGGfQ0+uQ1CiiigAooooAK5jx1rs2i2CeXbrIswYFyfu4x2xzXT15x8Wtbt4oU0xYY7ibaXbjJjJH',
      'HsO/WtaKTmkyKjaj7u5yfiHVo9buTcRI6QBQqK5yfc1mxJl9uPYVVs0dLRVY5cYZ/r1P863NPsmudRiiTnzSoz6c4r1NIx9D',
      'n1ky3Z6Q83h6/wBQ2nMboice+T+mKpLbZQMAfevQUg0dbO7sGv4HkMrBVM44PGPlBxn8K5htPkgGGU56NgfyFc1HEKTdzepS',
      'aSsJ4a02C+e9tZlcloAUKIWKtng8ViahYy2++OWNklQ9CpHSu7sJB4f0afVvs73GUB8uPk45P8uvpXI3vinUfEN4lvBpFs32',
      'g7lTewdCqnjOMZIH8qhV5e0bS0G6S5UnuZ9lIba5WZexH5VJ4jeGDxBBM0hSxmALsq7thIznH0IPHoajjBNnvZCjkDIPaqF2',
      '7yCHOGUR+UQeeVJIP4ZxXY3pdHLKF3Znuvhu+gvtHt3tnkkjjQRiR1xvwAMj1rUFeK+CvFknh2c28sZfT5n3Min/AFZPdR2+',
      'lex2V3b39slxayrLE/RlOf8AJry6tNwfkdcHpYnopKWsigooNZmvrq0ln5ekNBHM5w8kh5RfVRjBb68UAY3jLxfBoytY2r+Z',
      'qTrwijd5eehI/pXlX9k6nd+deXEcp3EySSSnBbuTXpumeFEtLiVpLaVpW+dp2YO0pPXLZ603xJdaZpOkTPdQXCb48FQBvAJ2',
      '8Z78/jg11U5RjpHczkm9zy+0RknmjkxnzOnXggEVr2unT6jPBZQy+VFKds204Zo+pAPbpWHPqYvNQIt4fs6LEigHk5HRjitz',
      'SdSDmK4icY91Ew4Y/Kx9M12VU5U2jOm7TRsp8NbT7beKkzR2rtuhAUYwegyckEHvXeSaVazLGJFOFAHHrjGfxxS6ZMt7ax3C',
      'lfmHIU52nuKtyv5aA46kKPxNeTKpJ6PodyjFbEKWUENvLAikxSAhlJ4OetUZbe1tNtwItvkKdu3r0x+JxxWspDDOPzrN8R3M',
      'Fjot1dXEpjijT5iuNzeij3PSpi5N2uP3Vq0eXX753yygIuSzgfw56CpvA9iNRneKRYmV/MDB8NtI55Hbg1itetqLxKieXbxs',
      'XIzkk9snvVSFZ4tUk+xy+XJJIMHOAWHYn68V7LTcbI81v3j0+58E2b5zbxp7o5XNV9K0vUNBmkOjzM5ZtjQlTIm7I6hehx3r',
      'p/CU0Oo6TDcPGDKhI+fkrnsc9xyPwrfUBRhQAPQV58qkleLOhK+pW0yW7ns0kvrVba4P3o1kDge+RVqiisCwoooJwCTwBQAE',
      'gAkkADqTXjfxE1pdWvzHbnNtG2QT/GQMBv8AdGSR9T7V3Wv6nLfwzwWMgW0j+SWcc73PARfU815YbY6jqgsLdixd9pbrwOp/',
      'mfyrvwtJK8pHPVnf3Uc/ZMsV8hJ5d1U5/wA+pFbN9p7sshteJWHMfZx3GO9dzofhTw5cwXWksyXF8iecW6SoD0PHQVi3Gm7L',
      '2awlLMdu5G6HHr9RXTTqRm3EzqKUFzGP4Y8T6h4YlKxKJrSRj5kD8An1B7GvU/D/AIms/EccZt4p4ZN2WSRf7vXBHHpXkc2n',
      '3ElwLdFeeYAtkDJPOOa9c8M6J/Y1rtUIjOg4A5BwMn6kiuTGwgtep0YaTl6GnLqVtFGCJBIx6Khyfx9K8j8f6rf6lrbWlxLi',
      '2gZfLhXhRkdT6nnrXps+mQ2tozwhyVO5iTnd69K4XxXpsJvo7qYIm9tz5ODtAGM+vSscGk6mpriWlTuYGn2zx6d57rhduRn0',
      'rNsc+ewbk7twB755x+prp9Rdp9EuJVUrHtKr9Oma5RS6xJcKPmDEEfTrXrtHmQlfU9p0dvsSQ6navv0y4Ueep+9E3TPvz17/',
      'AM66tWDKGUggjII715p4A16CIfZLlgLe6+Ubj8u7Hf09PyrtdPuVikuoFyfsz7XTrxjII+oOfzrya8HGWp205Kxr0DrSI6yI',
      'rowZWGQR0IpR1rnNRsjhBk/gB1NchdXU/iTX20mGYx6fbruumibBb/Zz/nv7Vu6pdmHTr28UZ+zxMQOvzAdPoD1/+tXnnhfV',
      '7nQ0muTEs/nrl2ZsZfrn35NdVCk5RlJbowq1Emkzb+IV2mmabaWliqR7CwjjXjbxjdj8Tz6147LNL5/lQzvHwQ7oxBOeoB9K',
      '2/FmqXUl3ceeWM+7EjseQT/CPTGawLVMhu7A7s10qPJBRJj70uY9A+C9io1q/vhcYkigELRd3DHIb8NuPxrrvE1nbStLqiK0',
      'dzb4Ug8bkOQf8+1eb/DS2F744tP9JaEwhpgF483aPun25z+FekeNBAscquqxzzAKkgPRA2XyPXpXPG6rKxpUtyO5zvhGRZ/E',
      'MUPmHzCpZkPTapIyPfpXa69eXdq0KWzonmBiWK7uRXE/Di1XU/FF9rUat9ktYzbwHHylj97B78fzr0DVbiwtLZrvUJY4oLcF',
      'mkkPC8fqfascXLmquxrhY8kFcoahrUVnpAu7gxxS+WGKM2BuIyR/WuG1PxV4c1Lz3uLp3lkClH8piExyMHHTP4VzV94il1iH',
      'W9TW3vRBERFbKuCgjbgBwe/Ga5qykjcZ81juGCrGrow5deoVJKWnQ9Ft5beW0ks451ngeIorj+PHGfr0NZujeF9R1O5t2VAl',
      'qZMyMwz064XvnpWb4VtL82k1zIhOnq5UTbv9Swx+hB/SvSvDN9eW9s1jGLdFQ+Z5vO4R9zj2rvnVbp80DhhBQqcsupvaP4U0',
      'XTISiWKO55Zpf3h/Xj8qwn1KPQvE2oeakgjmZCD/AHR2OPTGRXYuxWwkdJWlYISGXAJIGeK8auPE1vrXiI6rLbMbWRVieAth',
      'wAPUdDnNceHvUk1LU6KuiTR6roepQT6hf2dvKksEbLJGyHIAYZI/A5rcHWvNPDJuLPWHXS54rmN03gOMNIvp7MATx7Gu+03U',
      'rfUI1aNgGPVc/n/nrWdelyvTYdOpdWZ59r3i82+h2thYcPJEEkJGSePm69s1ytvey2UQ1K4kBlOVts/wnoXA9R0BPfntUupW',
      'klxPJMAEz8q56bQBj+tczqiiK4iV5DIu0jnoOe1ek4Rpxdjmg3Nq5HeN9slQgnapJJ9P8TUioFTCcYqo4O446dqa77huLuNv',
      'QCsHK7uzpUUlZG74Qtpx4ntbyCR4hbky7lHAI6q3sa7rxLHdz6Xf3t1JI98xW3tY+ASXwBtX05/nXnOja8LGa2EqsYkuVkuF',
      'A5mj6Fcfia95+zwahf2t+jK0FumYlCY+Yjg568DPHqfasqtRQWgRg5S12G+GNHXQtCtNNXBaJf3jAfec8sfzryj4nanNq+uv',
      'ajedPsTsTj5Wk6M59eeB9K9lvJXitnaMEyEYQDqWPSuB1n4dT+UZNNmBaViZ4J2GBuPVCBxjrg1yU373MzoltYr+GvDKTfDu',
      '+GzE92plT2C/d/PFee6WljDeoL+ESWbnbKMfMqnuPcda9wW11TSbPSrCwQajFFKIbiaXbG0cWPvYHBIrhx4H1Z9evbeCMR2z',
      'yl/tcg/d7TyoVe5B/lWkZ73JdtDs7fQ9O0vw3Db2aebawr5mT83nK3LE+uQc1g6vYvp+sW4snDJInmIQcgL3H06V2OlWR0jR',
      'obIyNcfZ1KlmGSw69McD2rkLS2gsbt7Qef8AvXMqrKGKpGWHyg/0zWuEk4t32MMSk0rbm7ql1fDwRKNLi/0vyCuXOCoHDt9c',
      'A4H0rxCyZVlwvCtGOP5V6b8UtbudIsLKw09zF9rMjTyqnBU/LsB7Zz+Qry+NSVl2jnZx7Yq6GjuipL3bM7PwtqP9n3drdSKS',
      'YWBkQdSOhI/DmtS91a2j8ZT3GnyhrWd1IZc48zA+Yfjwa5LSb1HURXCMxHRh1x71uQRWyfNbqqh8KTgnHOeM9DXc4KT5vKxx',
      'OTjoZupXc0oxIxVcDhOB0+nNc7qKP5RZlAIP3Ryce5rrHNr9qklnz5UQyiEcuewP9ax5yGO/BaaRuFAyST2AFVNXugpu1jmi',
      '8gBQdcce1WLa2kCh2RnyOGKnmu50f4e6vdRPLewxWMcxA8yYjcq+ydvxIrul8KeF9sNvBCZpUxg+a5JA65OcD/OK8uVVJnoK',
      'Nzx7wr4XuPEWvJbW7PBDEQ9zKBgxrnt/tHt+favoaGNYY1jQEKowMnJqno2j2Wi2htrKLYrMXcklmYn1J5NXq5ak+dmsI8pC',
      'sobVI4P7kZkP16D+tXz0Pua5+wnWSeS9OQJCQOOdvQfyrSF2gxtcnPaq5bIl6kWs3WpWiRNpdil473KJMrPs2Rnqw9ccVoqB',
      'tOOzGsi91+z0ua2S7lbdfXItodilvnx3x0FaCTcYLYYsQB+NFhFnHzfpXJ+PbGNLCDVlysmnzrIxX+JCcHPr1FdP5jda5/x7',
      'dRxeDdYaXgGEj6kkAU4O0kJrQyvibrVrb+DGBtzcLekRRuwGIiRuBOec4BxjvXkdgAJNsh+8hGD79q9Z125srb4WwjU/Kmlk',
      'tI0gV1G4ylRjHuPX2ryFiFUO52nvXTQ0uRIms3axvFWQb1HB9x/jXe6TPYpp99EzbluIh5fHIcdCPQ151cTKVDF8n+Ejrn1r',
      'c0q+KrExjIJw+FGR9cV202pJxZy1Y2fMia9RpsmJS0zsFI/ugDNdr4Ds9NtrGSZ2V79srJICC0A9AOoz6965zVbE2Qke2kZs',
      'Y8wOMupP8wfWtLwQLG1huhLJGt9MfnaUgEr6DPbNGJXNDQnDtcx0MN7dz6gEinlKykgKxyMY9+ldJYWqWsOBgu33m9axLVVt',
      'dRicAYYFenqOtdFGcjNePV3PUhsPrH8Uaza6HpL3l47LEzrFlRk/McfoMn8K1ia8Y+MXiBb3VoNKhbdb2eWcj+KU/wCA4/E1',
      'NOPNIJuyOquvFlrpkUV3cb5tKuhutryBN6g9Cjgcg5B5qrN8R9BGVieeUjBBWEgfriuGv/EVrqPg+w0OCykW9jkUZHCYHf6n',
      'PTtzWTeaTeafL5F15SShQ2FIYYIyORXWoq9mY3e56TF8Q9FLkSCcYcshaLp6Hiug0jxHpmoxhYL2GRxjjO1sntg8968NFtMz',
      'feUD3p32K6eOWRbaR0hALyIpIT0JPam4IEz6IWV+iseuQAa5XXpJPFmsQeHLWQSW0Tie/kB+VVXogPqc1yHhiyE3hq81vWdQ',
      '1RrWI7ESC6YHC8EEZ7k03xH4ysrLTLLT/CD3Gnvy08iKFOP7uTyTk9ajltsO5u/GDVrSMwaFDGHuIisxfIPkrggL7E8fhivM',
      'jISvzHOOlNjSW5eSaWaRpGO5pGJJZvc96EgP2iNWY/MQPbJNawjZWIbJrS2e5mCgZCkbv8BXRwIYpoSqlTvAwR0NJY28UsIU',
      'KI3TjbW9bhp0+0zxLHIyjYO7sOC//wBf1r0KcOTQ4qlS5PqUcz2jSH5nt8AtnG9WGAD+OKyodLuLs+bLtCAZK+poorVLU5eZ',
      'qJo2/ii8hVlmjWeKJSiEfKxPbJr0rTL1b6yhniB2yKD6c9/1oory8fSjFKSPWwVSUm0zK8R66LO3uY42KPGMMwHOT0A9/evE',
      '9ftj54uG4dycjOeM/wD16KKvDU4qi5CrTftUinbhlKBBjHcdauTNcSTM1w7vKepdsn86KKVlcroM5FWLe/uraGeGF9sc4w4x',
      'nNFFOUVJWYJtbGbcK/lBI5HVSdxQMdpPrjpmorazeaSMM6bn9jwB1NFFRLQFqa7WTwxkrteIcB1PB/PmnaXprX90IQBzIiBi',
      'ehY4AoopSl7txpam3DZyRu7XCFRA5jlAIyZFx8v/ANerNrPJc38ZfHmOCvAwB7fSiivRoNygmzz6ySk0j//Z',
    ].join('')

    // ── 文案 ──────────────────────────────────────────────
    const DICTS = {
      zh: {
        title: '换肤',
        section: '换肤',
        panelTitle: '换肤',
        mode: '使用模式',
        modeNormal: '正常',
        modeFocus: '专注',
        modeLeisure: '休闲',
        modeNormalHint: '按每张图自己的亮度配(暗图 12% / 亮图 6%),下面的滑杆能再手调',
        modeFocusHint: '背景压得实一点(35%),字最清楚',
        modeLeisureHint: '背景几乎不压(5%),图最大程度露出来;只有字会看不清时才会自动垫一点',
        wash: '背景明度(遮罩深浅)',
        washLocked: '模式锁定了这一档,回到「正常」才能自己拖',
        washFloor: '这张图建议不低于 {n}%（再低字可能发糊,糊了往右拖两格）',
        gallery: '图库',
        showMore: '再加载{n} 张',
        rotate: '背景图片随机变换时间',
        rotateOff: '不换',
        rotateCustom: '自定义',
        rotateMinutes: '{n} 分钟',
        rotateHint: '到点自己抽一张换上。库里只有一张图时不会换。',
        rotateCustomHint: '自己填分钟数(1-14400)。',
        pickFiles: '选图片',
        pickFolder: '选文件夹',
        galleryEmpty: '还没有图。选图片、选文件夹、或者直接把图拖进来。',
        galleryCount: '共{n} 张',
        deleteImage: '删掉这张',
        portraitFill: '竖图铺法',
        fillNative: '原图',
        fillCenter: '居中',
        fillCover: '铺满',
        fillBlur: '模糊填充',
        fillRight: '立绘贴侧',
        portraitHint: '竖图直接铺满会被放大裁掉,「居中」是完整显示(老版本就是这个)。',
        rotateNeedMore: '自动换肤:库里至少要有 2 张图',
        pickRandom: '换一张',
        // 【10-22 20:1x boss】「换一张」→「下一张」（按图库顺序走，不随机）
        pickNext: '下一张',
        wallToDefault: '已切回系统默认壁纸',
        wallToDefaultPaused: '已切回系统默认壁纸 · 自动换肤已暂停',
        updateAvailable: '有新版本',
        updateWindowTitle: '检查更新',
        updateSection: '插件升级',
        updateSectionHint: '点「检查更新」只查版本，不会自动替换。想更新请到仓库页下载后覆盖，重启桌面端生效。',
        updateCurrent: '当前版本',
        updateLatest: '最新版本',
        updateOutdated: '有新版本',
        updateUpToDate: '已是最新版本',
        updateCheck: '检查更新',
        updateChecking: '正在检查…',
        updateGoRepo: '去仓库页',
        updateDownload: '下载更新（不替换）',
        updateDownloading: '正在下载…',
        updateDownloadedHint: '已下载好 {n} 个文件，放在暂存目录里，现装的那份还没动。点下面的按钮才会替换；替换前会自动备份，替换后需要重启桌面端才生效。',
        updateInstall: '点此安装（替换现有文件）',
        updateInstalling: '正在替换…',
        updateAppliedHint: '已替换成新版本。请重启桌面端（托盘右键 → 退出 → 再打开）才生效。旧版本已自动备份在插件数据目录里，坏了可以还原。',
        updateFailed: '没成功',
        projectsSection: '我的项目',
        projectsSectionHint: '同一作者的其他插件。数字是仓库的真实 Star / Fork，取不到就不显示。',
        projectsEmpty: '暂时没有可显示的项目',
        projectsOpen: '打开',
        projectsUpdated: '最近更新',
        wallToCustom: '已切回自定义背景',
        wallNoImage: '图库是空的,先加一张图',
        bleedLabel: '两侧模糊过渡',
        bleedValue: '{n}px',
        bleedOff: '不要这层',
        restore: '恢复默认界面',
        restoreHint: '撤掉背景和所有颜色改动回到没装换肤时的样子',
        soundLabel: '任务完成提示音',
        soundHint: '任务跑完响一声。默认关,试听觉得好再打开。',
        soundTest: '试听',
        soundOnLabel: '开',
        soundOffLabel: '关',
        soundVolumeLabel: '音量',
        soundAdd: '添加音效…',
        soundEmpty: '还没有自定义音效,点上面「添加」选一个音频文件(mp3 / wav / ogg 都行)',
        soundQuota: '容量:已用 {used}MB / 上限 {total}MB · {count}/{max} 条（单个最大 {perFile}MB,可一次多选）',
        guideTitle: '第一次用？照这 4 步走',
        guideStep1: '① 点下面的「选图片」或「整个文件夹」,挑几张喜欢的图',
        guideStep2: '② 在图库里点一张 —— 它立刻变成全屏背景,文字颜色自动跟着变',
        guideStep3: '③ 想让它自己换:双击屏幕上那颗悬浮球(球右上角出现小绿点就是开着)',
        guideStep4: '④ 要提示音:先把开关点成「开」,再点一次「试听」(浏览器要求先点一次才让出声)',
        guideDismiss: '知道了,开始用',
        guideReopen: '新手指引',
        guideMore: '完整说明在插件文件夹的 docs 目录里（操作指引 / 使用说明 / 版本记录）',
        soundRemove: '删掉这个音效',
        status: '这张图',
        statusNone: '没选图',
        statusKind: '深浅',
        kindLight: '浅色图',
        kindDark: '深色图',
        statusBright: '亮度',
        statusAutoMask: '建议最低',
        close: '关闭',
        pageTitle: '换肤',
        pageHint: '换背景图、调明度、按图的深浅配文字色。支持选整个文件夹,横图竖图都收。设置存 E 盘重启还在。',
        previewEmpty: '还没选背景图',
        importing: '正在导入…',
        imported: '已加入{n} 张',
        skipped: '{n} 张重复已跳过',
        dropHint: '把图片或文件夹拖进来',
        remove: '关闭换肤',
      },
      en: {
        title: 'Skin',
        section: 'Skin',
        panelTitle: 'Skin',
        mode: 'Mode',
        modeNormal: 'Normal',
        modeFocus: 'Focus',
        modeLeisure: 'Leisure',
        modeNormalHint: 'Wash follows each image (dark 12% / light 6%); the slider below adjusts it',
        modeFocusHint: 'Wash pushed down to 35% — text clearest',
        modeLeisureHint: 'Wash nearly off (5%) — the image shows at its boldest; padded only when text would stop reading',
        wash: 'Brightness (wash)',
        washLocked: 'This mode locks the wash; switch back to Normal to adjust',
        washFloor: 'Lowest for this image is {n}% — below that the text stops reading',
        gallery: 'Gallery',
        showMore: 'Load {n} more',
        rotate: 'Background auto-change interval',
        rotateOff: 'Off',
        rotateCustom: 'Custom',
        rotateMinutes: '{n} min',
        rotateHint: 'Picks a new image by itself when the time is up. Nothing changes if there is only one image.',
        rotateCustomHint: 'Type the minutes yourself (1-14400).',
        pickFiles: 'Pick images',
        pickFolder: 'Pick folder',
        galleryEmpty: 'No images yet. Pick images, pick a folder, or drop them in.',
        galleryCount: '{n} images',
        deleteImage: 'Delete this one',
        portraitFill: 'Portrait layout',
        fillNative: 'Original',
        fillCenter: 'Centered',
        fillCover: 'Fill',
        fillBlur: 'Blur fill',
        fillRight: 'Portrait on the right',
        portraitHint: 'Filling a portrait image zooms and crops it; Centered shows it whole (the original behaviour).',
        rotateNeedMore: 'Auto skin: needs at least 2 images in the library',
        pickRandom: 'Pick another',
        // 【10-22 20:1x boss】「换一张」→「下一张」（按图库顺序走，不随机）
        pickNext: 'Next image',
        wallToDefault: 'Back to the default wallpaper',
        wallToDefaultPaused: 'Back to the default wallpaper · auto skin paused',
        updateAvailable: 'Update available',
        updateWindowTitle: 'Check for updates',
        updateSection: 'Plugin upgrade',
        updateSectionHint: '“Check” only looks up the version — it never replaces anything. To update, download from the repository and overwrite, then restart the desktop app.',
        updateCurrent: 'Current',
        updateLatest: 'Latest',
        updateOutdated: 'Update available',
        updateUpToDate: 'Already up to date',
        updateCheck: 'Check for updates',
        updateChecking: 'Checking…',
        updateGoRepo: 'Open repository',
        updateDownload: 'Download update (does not replace)',
        updateDownloading: 'Downloading…',
        updateDownloadedHint: 'Downloaded {n} files into a staging folder — the installed copy is untouched. The button below performs the replacement; the old version is backed up first, and a restart is needed afterwards.',
        updateInstall: 'Install now (replace the installed files)',
        updateInstalling: 'Replacing…',
        updateAppliedHint: 'The files have been replaced. Restart the desktop app (tray icon → Quit → reopen) to make it take effect. The previous version was backed up in the plugin data folder.',
        updateFailed: 'Did not succeed',
        projectsSection: 'My projects',
        projectsSectionHint: "Other plugins by the same author. The numbers are the repository's real Stars / Forks; they are hidden when they cannot be read.",
        projectsEmpty: 'No projects to show yet',
        projectsOpen: 'Open',
        projectsUpdated: 'Updated',
        wallToCustom: 'Back to your own background',
        wallNoImage: 'The gallery is empty, add an image first',
        bleedLabel: 'Blurred transition on the sides',
        bleedValue: '{n}px',
        bleedOff: 'Off',
        restore: 'Restore default look',
        restoreHint: 'Remove the background and every colour change; back to how it looked before this plugin',
        soundLabel: 'Chime when a task finishes',
        soundHint: 'A short chime when work completes. Off by default — try it, then turn it on.',
        soundTest: 'Test',
        soundOnLabel: 'On',
        soundOffLabel: 'Off',
        soundVolumeLabel: 'Volume',
        soundAdd: 'Add a sound…',
        soundEmpty: 'No custom sound yet — press Add and pick an audio file (mp3 / wav / ogg)',
        soundQuota: 'Storage: {used}MB used of {total}MB · {count}/{max} items (max {perFile}MB each, multi-select OK)',
        guideTitle: 'First time here? Just 4 steps',
        guideStep1: '1. Press “Pick images” or “Pick folder” below and choose a few pictures',
        guideStep2: '2. Click one in the gallery — it becomes your wallpaper and the text colour adapts',
        guideStep3: '3. Want it to rotate by itself? Double-click the floating ball (a green dot means it is on)',
        guideStep4: '4. For the completion chime: switch it On, then press Test once (browsers need one click before sound)',
        guideDismiss: 'Got it — start using',
        guideReopen: 'Guide',
        guideMore: 'Full docs live in the plugin folder under docs/ (guide, manual, changelog)',
        soundRemove: 'Delete this sound',
        status: 'This image',
        statusNone: 'No image',
        statusKind: 'Kind',
        kindLight: 'Light image',
        kindDark: 'Dark image',
        statusBright: 'Luminance',
        statusAutoMask: 'Suggested floor',
        close: 'Close',
        pageTitle: 'Skin',
        pageHint: 'Background image, brightness wash, and text colour that follows the image. Whole-folder import supported; portrait and landscape both fine. Saved on disk.',
        previewEmpty: 'No background image yet',
        importing: 'Importing…',
        imported: '{n} added',
        skipped: '{n} duplicates skipped',
        dropHint: 'Drop images or a folder here',
        remove: 'Turn off skin',
      },
    }

    // ── 样式基线(全走主题 token,不写死颜色 ────────────────
    const T = {
      primary: 'var(--dsw-alias-label-primary)',
      secondary: 'var(--dsw-alias-label-secondary)',
      surface: 'var(--dsw-alias-bg-overlay)',
      raised: 'var(--dsw-alias-bg-layer-2)',
      button: 'var(--dsw-alias-bg-layer-1)',
      border: 'var(--dsw-alias-border-l1)',
      borderStrong: 'var(--dsw-alias-border-l2)',
      accent: 'var(--dsw-alias-brand-primary)',
      danger: 'var(--dsw-alias-state-error-primary)',
    }

    // 弹窗底色浓度:50%-100%,95% 是默认值(boss 10-18 11:20 定的「别太透」)。
    // 【这三行必须放在 state 之前】state 的初始值要用 POPUP_ALPHA_DEFAULT。
    // 之前它们定义在 state 后面,模块一加载就抛
    // "Cannot access 'POPUP_ALPHA_DEFAULT' before initialization",
    // 插件加载失败 → 整个桌面版起不来。10-18 14:46 修的。
    const POPUP_ALPHA_MIN = 0.5
    const POPUP_ALPHA_MAX = 1
    const POPUP_ALPHA_DEFAULT = 0.95

    // ── 全局状态──────────────────────────────────────────
    let ctxRef = null
    // 【10-19 21:1x】lang = 面板语言，'zh'（默认）或 'en'
    // 【10-19 21:4x】onboarded = 新手引导看过没有。**默认 false** —— 第一次装的人
    //   打开面板会自己跳出来（见 Launcher 里那两段 useEffect + SkinControls 的引导卡）。
    let state = { activeId: '', wash: null, text: 'follow', mode: 'normal', rotateMinutes: 0, popupAlpha: POPUP_ALPHA_DEFAULT, ballX: null, ballY: null, bleed: 64, soundOn: false, soundVolume: 0.5, soundId: '', lang: 'zh', onboarded: false, lastWallId: '' }
    // 设置从主机端读回来了没有 —— 新手引导要等它回来再决定跳不跳（否则老用户也会被弹一次）
    let stateReady = false
    /**
     * ═══ 提示音(boss 10-18 23:45 选 A,10-19 00:20 加自定义)═══
     * 开关、音量、选中的音效 id 都存换肤设置里,跟着别的设置一起落盘。
     * boss明确要「默认关」—— 这版刚稳,先别吵。
     */
    const SOUND_ON_DEFAULT = false
    const SOUND_VOLUME_DEFAULT = 0.5
    /**
     * ═══ 音效的容量天花板(boss 10-19 13:55 选的 B 案:单个 8MB / 总量 200MB / 最多 30 条)═══
     *
     * 【这两份数为什么有两处】主机端才是权威(它在写盘前拦),这里这份只是
     * 「点下去立刻能给反馈」的预判,以及主机端没回话时的兜底。
     * 两边不许漂 —— `verify/sound_check.cjs` 有一条硬判据专门对这两个文件的数。
     */
    const SOUND_CAPS_FALLBACK = { maxBytes: 8 * 1024 * 1024, maxCount: 30, totalBytes: 200 * 1024 * 1024 }
    // 主机端报回来的实际占用(已用字节 / 总上限 / 条数上限),面板上要显示
    let soundUsage = null
    // 自定义音效列表(主机端管着,页面只在面板里列出来)
    let soundList = []
    // 添加失败时的那句提示,显示在面板上;成功就清空
    let soundNote = ''
    // 【10-19 21:4x】新手引导显示着没有：第一次装的人是 true（等设置读回来再定），
    // 「知道了」/「新手指引」按钮改它。
    let guideOpen = false
    let guideSeen = false
    // 那句提示是「没进去」(红字)还是「加好了」(灰字) —— 批量添加后两种都会出现
    let soundNoteIsError = false

    /**
     * ═══ 「需要人工判断」时也响一声（10-20 00:0x 第二版；第一版在真机上收不到）═══
     *
     * boss原话：「当出现需要人工判断的时候，也需要加提示音。」
     *
     * 【第一版为什么不行】一开始我在**主机端**听 `approval/asked`（落地会话事件）
     * 和 `user-questions/request`（waterfall）。重启后真机实测：`bell.at` 一直是 0、
     * 一声没响。原因：这两类都是**按会话/智能体作用域**发的，插件挂在旁边那一支，
     * 不在那条链上；而「完成」能通是因为它走的是**全局广播**（`agentEvents` 里的
     * `ctx.events.dispatch`）—— 两类事件的传播方式根本不同。
     *
     * 【现在走哪条路】照抄应用自己的提问/审批界面在**页面侧**用的那条：
     *   `ctx.remote.$on('user-questions/request', (req, next) => ...)`
     *   `ctx.remote.$on('approval/request',        (req, next) => ...)`
     * `$on` 底下是 `events.subscribe(...)`（订阅，不是替换），所以**不会顶掉应用自己的回答逻辑**；
     * 我们只听不改：响一声，然后**原样 `next()` 往下传**。
     * 拿不到 `remote`（或它抛错）就安静跳过 —— 绝不能因为「加个提示音」把换肤弄坏。
     */
    function watchHumanInteractions(remote) {
      if (!remote || typeof remote.$on !== 'function') return 0
      let registered = 0
      /**
       * 响**一声**。
       * 【10-20 00:1x 作者定的】我先做成「响两声」想跟「完成」区分开，作者听完说：
       * 「我只听到一声，应该就够了呀」—— 那就一声，别再自作主张加节奏。
       * （顺带记下为什么他当时听着就是一声：自定义音效共用一个 `<audio>` 元素，
       *  提前再播一次是「从头重放」而不是叠一声，所以两下听着还是一下。）
       */
      const ring = () => {
        try {
          if (!state.soundOn) return
          if (state.soundId) playCustomSound()
          else playChime(state.soundVolume)
        } catch {
          /* 播不出来就算了，别影响别的 */
        }
      }
      /**
       * 留一道能查的痕：把主机端那条 `bell` 的时间戳刷一下（kind=test）。
       * 这样「这条链到底跑没跑到」不用靠耳朵听 —— 读一次 `/dsh-skin/bell` 就能判定。
       * 刷完把 `lastBellSeen` 同步成新值，免得轮询那边再补响一次（重复响）。
       */
      const trace = () => {
        try {
          void postJson(BELL_PATH, { kind: 'test' })
            .then((r) => {
              const at = Number(r?.at)
              if (Number.isFinite(at) && at > 0) lastBellSeen = at
            })
            .catch(() => {})
        } catch {
          /* 记不上不影响响 */
        }
      }
      const passThrough = () => (request, next) => {
        try {
          ring()
          trace()
        } catch {
          /* 听漏一声没关系 */
        }
        // ★ 必须原样往下传：这是应用的提问/审批链，吞掉就等于把卡片藏了
        return typeof next === 'function' ? next() : undefined
      }
      for (const event of ['user-questions/request', 'approval/request']) {
        try {
          remote.$on(event, passThrough())
          registered += 1
        } catch {
          /* 没有这个通道就算了 */
        }
      }
      return registered
    }
    let library = []
    let wallpaperCssText = ''
    let activeTone = null // 'light' 浅色字| 'dark' 深色字| null 交给主题
    let layerDispose = null
    let applying = false // 防重入overrideTokens 会同步抛 theme/change
    let backgroundSeq = 0
    let tertiaryOk = true
    let importing = false
    // 当前这轮字色是白字还是黑字。null = 没换肤,不接管转圈。
    // 由 buildTokens 算底色亮度后写入,refreshBackground 拿它决定转圈颜色。
    let inkIsWhite = null
    const subscribers = new Set()

    function notify() {
      subscribers.forEach((fn) => {
        try {
          fn()
        } catch {
          /* 单个订阅者出错不影响其他 */
        }
      })
    }

    function useSkin() {
      const [, bump] = useState(0)
      useEffect(() => {
        const fn = () => bump((n) => n + 1)
        subscribers.add(fn)
        return () => {
          subscribers.delete(fn)
        }
      }, [])
      return state
    }

    /**
     * 面板用哪套文案（中文 / English）。
     *
     * 【10-19 21:1x boss】「在悬浮球的选项里面，写一个中英双语版，默认是中文，
     * 中英双语文字放在最置顶的位置，可以一键切换」
     *
     * 规则：**面板上的选择优先**（state.lang，默认 'zh'），没选过才跟随应用语言。
     * 语言开关就放在面板最顶上（见 SkinControls 第一段）—— 一键切换、立即重画、落盘记住。
     */
    function dictFor() {
      const chosen = state.lang === 'en' ? 'en' : 'zh'
      return chosen === 'en' ? DICTS.en : DICTS.zh
    }

    /** 跟随应用语言用的（只在没有面板选择时的参考，正常不走这条路） */
    function systemDict() {
      let id = ''
      try {
        id = String(ctxRef?.locale?.getLocale?.()?.id ?? '')
      } catch {
        id = ''
      }
      return id.toLowerCase().startsWith('zh') ? DICTS.zh : id ? DICTS.en : DICTS.zh
    }

    // ── 小工具────────────────────────────────────────────
    const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n))
    const clamp01 = (n) => clamp(Number(n) || 0, 0, 1)

    /**
     * 面板往哪边展开(boss 10-18 11:02 提的:靠近哪条边就朝反方向开)。
     *
     * 之前只有「向左向右」一个开关上下写死贴着圆钮往上开(样式里写死bottom:68px),
     * 圆钮拖到屏幕顶部时面板整个跑到屏幕外头去，看着就是「没反应」。
     * 现在四个方向都算一遍空间哪边放得下就朝哪边开,都放不下就选空间大的那一侧
     * 再把面板拉回屏幕内。
     *
     * 返回的是**相对圆钮容器**的坐标面板是圆钮那个fixed 盒子的绝对定位子元素),
     * 这样boss拖圆钮的时候面板跟着一起走。
     */
    function computePanelPlacement(rect) {
      const vw = Math.max(window.innerWidth || 0, 320)
      const vh = Math.max(window.innerHeight || 0, 320)
      const width = Math.min(PANEL_WIDTH, Math.max(200, vw - PANEL_MARGIN * 2))
      const maxHeight = Math.max(PANEL_MIN_HEIGHT, Math.round(vh * PANEL_MAX_RATIO))

      const roomRight = vw - rect.right - PANEL_GAP
      const roomLeft = rect.left - PANEL_GAP
      const roomBelow = vh - rect.bottom - PANEL_GAP
      const roomAbove = rect.top - PANEL_GAP

      // 左右:一边放得下就朝那一边都放不下就把面板夹回屏幕内贴着圆钮居中)
      let left
      if (roomRight >= width) left = rect.right + PANEL_GAP
      else if (roomLeft >= width) left = rect.left - PANEL_GAP - width
      else left = rect.left + rect.width / 2 - width / 2

      // 上下:先定朝哪边开,再按**那一侧的真实空间**定高度。
      // 顺序不能反——早先用最大高度去卡贴边结果圆钮在屏幕中间时会被硬拽。
      // 圆钮上方,面板反过来盖住圆钮看着就是「展开方向乱跳」。
      const down = !(roomBelow < PANEL_MIN_HEIGHT && roomAbove > roomBelow)
      const room = down ? roomBelow : roomAbove
      const height = clamp(room, Math.min(PANEL_MIN_HEIGHT, maxHeight), maxHeight)
      let top = down ? rect.bottom + PANEL_GAP : rect.top - PANEL_GAP - height

      // 最后兜一道底:不管怎么算都不能让面板整块跑到屏幕外
      left = clamp(left, PANEL_MARGIN, Math.max(PANEL_MARGIN, vw - width - PANEL_MARGIN))
      top = clamp(top, PANEL_MARGIN, Math.max(PANEL_MARGIN, vh - height - PANEL_MARGIN))

      return { left: Math.round(left - rect.left), top: Math.round(top - rect.top), width: Math.round(width), maxHeight: Math.round(height) }
    }

    function currentEntry() {
      return library.find((item) => item.id === state.activeId) || null
    }

    /**
     * 当前实际生效的遮罩百分比：模式强制值 > 每张图手调值 > 图片自动基准，再被「自动底线」托住。
     *
     * ═══ 【10-19 18:5x boss打回：三个模式用不了了】═══
     *
     * boss原话:「你把图片背景的明度、透明度给删掉了,这个版本没有了。你应该加上去的,
     * 要不然我们『休闲』『专注』和『正常』这三个模式都用不了了。」
     *
     * 【我上次错在哪】00:56 boss说「我要的是背景最清晰的,你不要给我加什么遮罩」——
     * 我把它理解成「整栏删掉、wash 一律按 0」，于是：
     *   · 三个模式的值没人读了（effectiveWash 里写死 0）→ 模式只剩一句提示文字，
     *     点了「专注」和「正常」屏幕上一模一样 —— boss说的「用不了了」就是这个；
     *   · 面板上还留着「按每张图自己的亮度配遮罩,你能再手调」这种**假话**（手调已经没了）。
     * **删控件不能顺手把它的语义也删掉** —— 模式的定义就是「遮罩档位」，档位没了模式自然废。
     *
     * 【现在】模式的值重新生效；普通档把滑杆还回去（界面在 SkinControls 那一栏）。
     * 唯一保留 00:56 那条意见的地方：**不手调时不再偷偷垫雾**（老存档的 wash=null 仍走
     * 每张图自己的基准 autoMask，而不是无脑加一层），而且那句「遮罩 0=背景最清楚」的
     * 长提示和「按图片自动」按钮都不恢复 —— 那两句是boss点名不要的。
     *
     * ═══ 【10-19 20:2x boss：「我不是让你把透明度调到 0~40% 吗？为什么是从 9 开始的」】═══
     *
     * 那个 9 是「自动底线」—— 每张图按它最糟的那块地方算出来的「字会看不清的下限」，
     * 10-18 21:40 boss点头过的（原话「一起都改」）。当时它是**硬挡**：既当滑杆左端，
     * 又在 effectiveWash 里再把数值抬上去。于是滑杆写着 0~40，实际左端顶在 9 上，
     * 拖到底也不是 0 —— boss要的「0~40」根本没落地。
     *
     * 【现在】底线**只当中文提示，不再改数值**：滑杆真能从 0 拖起，
     * 拖到几就是几（0 就是 0，图原样透出来）；那条建议值写在滑杆下面一行小字里。
     * 字会不会糊，交给黑白字判定 + 文字光晕兜 —— 实在糊了往右拖两格，那是boss自己的手。
     * **「防呆」和「boss要的区间」冲突时，按boss的话办，但要把他失去的那层保护说出来。**
     */
    function effectiveWash(entry) {
      if (state.mode === 'focus') {
        return clamp(Math.round(FOCUS_MASK) || 0, 0, Math.max(MAX_WASH, FOCUS_MASK))
      }
      if (state.mode === 'leisure') {
        return clamp(Math.round(LEISURE_MASK) || 0, 0, MAX_WASH)
      }
      /**
       * 【10-19 19:0x 单元测试抓出来的坑】原来是 `Number.isFinite(Number(state.wash))`
       * 判「有没有手调过」—— 可 `Number(null)` 就是 0，而 0 是有限数！
       * 于是老存档里的 wash=null（从没拖过滑杆）会被当成「boss手动调到了 0」，
       * 正常档永远走不到「每张图自己的基准」那条路 → 三个档里最中庸的那档直接躺平。
       * 现在按 null / 非数字分开判。**判「有没有值」不能拿数字函数当尺子。**
       */
      const raw = state.wash
      const manual = raw === null || raw === undefined ? null : Number(raw)
      const base = manual === null || !Number.isFinite(manual) ? Number(entry?.autoMask ?? 0) : manual
      return clamp(Math.round(base) || 0, 0, MAX_WASH)
    }

    function washLocked() {
      return state.mode === 'focus' || state.mode === 'leisure'
    }

    function imageUrl(id, thumb) {
      return `${IMAGE_PATH}?id=${encodeURIComponent(id)}${thumb ? '&thumb=1' : ''}`
    }

    /**
     * 老图的自动遮罩是按旧尺度算的(最早28/58,后来 20/10)。
     * 尺度一调这些老值就超标，——实测 1387 张全是旧值背景照样被盖白。
     * 这里启动时统一按当前尺度重算一遍暗图 AUTO_MASK_DARK、亮图AUTO_MASK_LIGHT。
     * 只改超标的和缺字段的,正常的不动也不会重复写盘。
     */
    async function normalizeAutoMasks() {
      const stale = library.filter((item) => {
        if (item.kind !== 'dark' && item.kind !== 'light') return true
        return typeof item.autoMask !== 'number' || item.autoMask > MAX_WASH
      })
      if (stale.length === 0) return 0
      // 走批量接口1300 多条逐条写盘会重写1300 多次索引文件,太慢
      try {
        const result = await postJson(LIBRARY_PATH, {
          method: 'renorm',
          darkMask: AUTO_MASK_DARK,
          lightMask: AUTO_MASK_LIGHT,
          cap: MAX_WASH,
        })
        if (Array.isArray(result?.list)) library = result.list
        return Number(result?.changed) || 0
      } catch {
        // 批量接口不可用主机端还是旧版就退回逐条,慢但能生效
        for (const item of stale) {
          const want = item.kind === 'dark' ? AUTO_MASK_DARK : AUTO_MASK_LIGHT
          if (item.autoMask === want) continue
          try {
            await postJson(LIBRARY_PATH, { method: 'update', id: item.id, patch: { autoMask: want } })
          } catch {
            /* 单条失败不影响其他*/
          }
        }
        return stale.length
      }
    }

    // ── 主机端接口────────────────────────────────────────
    async function postJson(path, payload) {
      const response = await fetch(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload ?? {}),
      })
      /**
       * 【10-19 13:55】以前 !ok 就抛 `host responded 400` —— 主机端写的那句人话
       * (比如「音效最多 30 条,先删几条再加」)全被扔了,面板上只显示一串英文状态码。
       * 现在把主机端的 error/message 原样带出来,带不出来才退回状态码。
       */
      if (!response.ok) {
        let detail = ''
        try {
          const body = await response.json()
          detail = String(body?.error || body?.message || '')
        } catch {
          /* 不是 JSON 就算了 */
        }
        throw new Error(detail || `host responded ${response.status}`)
      }
      return response.json()
    }

    /**
     * 读一个主机端接口（**GET**）。
     * 「问一下现在是啥」这种就用它 —— 别拿 POST 去问数据：
     * 主机端按 method 分了分支，POST 那条分支回的是「收到」而不是数据，
     * 页面上就会拿到一个没有字段的空对象（19:2x 提示音不响就是这么来的）。
     */
    async function getJson(path) {
      const response = await fetch(path, { method: 'GET' })
      if (!response.ok) throw new Error(`host responded ${response.status}`)
      return response.json()
    }

    async function saveState(patch) {
      try {
        state = normalizeState(await postJson(STATE_PATH, { method: 'set', patch }))
      } catch {
        /* 存不进去就先在内存里生效,不打断boss操作 */
      }
    }

    async function loadLibrary() {
      const result = await postJson(LIBRARY_PATH, { method: 'list' })
      library = Array.isArray(result?.list) ? result.list : []
      return library
    }

    function normalizeState(input) {
      const src = input && typeof input === 'object' ? input : {}
      const mode = ['normal', 'focus', 'leisure'].includes(src.mode) ? src.mode : 'normal'
      // 【10-18 19:20】老存档里可能还留着 'auto'(按图主色判黑白的那一档,19:05 已删)。
      // 【10-18 22:05】'dark' / 'light' 也一起并进 'follow' —— boss原话「悬浮窗里就不要有选项了,
      // 直接删掉」「你图片判断默认是深色字体,开进来就应该是深色字体」。
      // 按钮没了还留着手动值的话,boss就再也退不出那一档了,所以这里一并归到自动。
      const rawText = ['auto', 'dark', 'light'].includes(src.text) ? 'follow' : src.text
      const text = ['follow', 'dark', 'light'].includes(rawText) ? rawText : 'follow'
      const wash = src.wash === null || src.wash === undefined ? null : clamp(Math.round(Number(src.wash) || 0), 0, 100)
      /**
       * 【10-18 20:45 新增两样】
       *   ballX/ballY —— 悬浮球拖到哪,记到哪。boss原来每次重开桌面端都被弹回右下角。
       *   bleed       —— 竖图两侧那层模糊过渡的半径(px),0 = 干脆不要这层,两侧留干净。
       */
      const spot = (v) => (Number.isFinite(Number(v)) ? Math.round(Number(v)) : null)
      const ballX = spot(src.ballX)
      const ballY = spot(src.ballY)
      const bleed = src.bleed === null || src.bleed === undefined ? 64 : clamp(Math.round(Number(src.bleed) || 0), 0, 64)
      // 【10-19 00:05 提示音】开关只认真/假,音量夹在 0~1,坏值一律退回默认。
      const soundOn = src.soundOn === true
      const vol = Number(src.soundVolume)
      const soundVolume = Number.isFinite(vol) ? clamp(vol, 0, 1) : SOUND_VOLUME_DEFAULT
      // 选中的音效:空串 = 用内置那声「叮」;否则是自定义音效的 id
      const soundId = typeof src.soundId === 'string' ? src.soundId : ''
      // 【10-19 21:1x】面板语言:只认 'zh' / 'en',坏值/老存档一律回中文(boss要的默认)
      const lang = src.lang === 'en' ? 'en' : 'zh'
      // 【10-19 21:4x】新手引导看过没有:只有明确 true 才算看过 —— 老存档没这字段 → 当作没看过
      const onboarded = src.onboarded === true
      /**
       * 【10-22 00:3x】**`lastWallId` 必须在这里带上**：
       *   这个函数每规范化一次就**整个换掉 state 对象**，
       *   漏一个字段就等于「每次规范化把它抹掉」——双击右键切回上次那张就会失效，
       *   而且看起来像"功能有时灵有时不灵"（取决于中途有没有走过 normalizeState）。
       */
      const lastWallId = typeof src.lastWallId === 'string' ? src.lastWallId : ''
      return { activeId: typeof src.activeId === 'string' ? src.activeId : '', wash, text, mode, rotateMinutes: normalizeRotate(src.rotateMinutes), popupAlpha: normalizePopupAlpha(src.popupAlpha), ballX, ballY, bleed, soundOn, soundVolume, soundId, lang, onboarded, lastWallId }
    }

    // 弹窗底色浓度的三个档位常量已挪到上面 state 之前(那里要用)。
    // 见「全局状态」上方那段注释。

    function normalizePopupAlpha(value) {
      const n = Number(value)
      if (!Number.isFinite(n)) return POPUP_ALPHA_DEFAULT
      return Math.min(POPUP_ALPHA_MAX, Math.max(POPUP_ALPHA_MIN, n))
    }

    // ── 背景图片随机变换时间 ──────────────────────────────
    // boss 10-18 11:02 点的:每隔一段时间自己换一张背景图。
    // 0 = 不换;正数 = 分钟(留小数是给秒级自测用。。上限14400 分钟(10 天 
    const ROTATE_PRESETS = [1, 3, 5, 10, 30]
    const ROTATE_MAX = 14400
    /**
     * 最小轮换间隔(分钟)。boss能选的最小档是 1 分钟。
     *
     * 【10-18 15:45 加这道闸】自检曾经会把 rotateMinutes 临时设成 0.02(1.2 秒),
     * 一旦还原失败就永久留在磁盘上,表现为「背景一直自己换」。
     * 那个测试已经删了,这里再加一道:小于 1 分钟的值一律当「不换」。
     * boss真正会用到的档位是 1/3/5/10/30 分钟,不存在 1 分钟以下的合法值。
     */
    const ROTATE_MIN = 1

    function normalizeRotate(value) {
      const n = Number(value)
      if (!Number.isFinite(n) || n <= 0) return 0
      // 低于 1 分钟视为残留的测试值,归零(否则会变成「不停换图」)
      if (n < ROTATE_MIN) return 0
      return Math.min(ROTATE_MAX, n)
    }

    // ── 图片分析(skill 的extractPalette,只留我们要的) ─────
    const hexOf = (r, g, b) =>
      '#' +
      [r, g, b]
        .map((v) => clamp(Math.round(v), 0, 255).toString(16).padStart(2, '0'))
        .join('')

    /**
     * 采样一张图,给出两件事
     *   avgLum  整图平均亮度(0-255)
     *   dominant 主色调及其明暗——判断「这张图偏浅还是偏深」以它为准
     *   没有主色（灰图)才退回整图平均。跟 同系列换肤脚本 一个思路。
     */
    function analyzeSample(canvas) {
      const cx = canvas.getContext('2d')
      if (!cx) return null
      const { data: px, width, height } = cx.getImageData(0, 0, canvas.width, canvas.height)
      const buckets = new Map()
      let lumSum = 0
      let count = 0
      /**
       * 【10-18 21:40 新增】按屏幕上的真实位置切一条「对话区」出来量最暗/最亮落点。
       * 以前只记整图平均亮度,于是「文字压在图上到底清不清楚」问不出来 ——
       * 整图平均 0.2 的图,对话区那块完全可能是纯黑的角落。
       * 这两个分位数是自动垫底的唯一输入。
       */
      const chatX0 = Math.floor(width * 0.33)
      const chatX1 = Math.max(chatX0 + 1, Math.floor(width * 0.83))
      const chatY0 = Math.floor(height * 0.15)
      const chatY1 = Math.max(chatY0 + 1, Math.floor(height * 0.85))
      const chatLums = []
      /**
       * 【10-18 22:15 boss亲口给的判据,取代「整图平均亮度」】
       * 原话:「每张图片你都可以把它切割成小方块,计算它当下的黑白明度占比,
       * 或者是灰色的占比,然后你就能匹配相应的文字呀。
       * 黑的占多的不就用白的吗?白的占多的不就用黑的吗?」
       *
       * 为什么比平均亮度对:夜景图一半是黑天空一半是亮楼,平均下来是"中间",
       * 按中间判就配了黑字,压到黑天空上直接糊。boss给的两张夜景截图就是这个毛病。
       * 切块统计比的是**面积** —— 哪边占的地方多,字就用另一边那个颜色。
       *
       * 12×12 = 144 块:太小一块亮窗户就能翻转结论,太大又跟平均没区别。
       */
      const GRID = 12
      const gridLum = new Float64Array(GRID * GRID).fill(0)
      const gridCount = new Int32Array(GRID * GRID).fill(0)
      for (let i = 0; i < px.length; i += 4) {
        const r = px[i]
        const g = px[i + 1]
        const b = px[i + 2]
        const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b
        lumSum += lum
        count += 1
        const p = i >> 2
        const x = p % width
        const y = (p / width) | 0
        const cell = Math.min(GRID - 1, ((y * GRID) / height) | 0) * GRID + Math.min(GRID - 1, ((x * GRID) / width) | 0)
        gridLum[cell] += lum
        gridCount[cell] += 1
        if (x >= chatX0 && x < chatX1 && y >= chatY0 && y < chatY1) {
          chatLums.push(lum)
        }
        const max = Math.max(r, g, b)
        const min = Math.min(r, g, b)
        const sat = max === 0 ? 0 : (max - min) / max
        // 灰、过暗、过曝的像素不参与主色统计skill 原值0.18 / 24 / 245)
        if (sat < 0.18 || lum < 24 || lum > 245) continue
        const d = max - min || 1
        const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4
        const bucket = (Math.round(h) % 6) * 2 + (sat > 0.55 ? 1 : 0)
        const entry = buckets.get(bucket) ?? { w: 0, r: 0, g: 0, b: 0, hue: h * 60 }
        const weight = sat * sat
        entry.w += weight
        entry.r += r * weight
        entry.g += g * weight
        entry.b += b * weight
        buckets.set(bucket, entry)
      }
      const avgLum = count ? lumSum / count : 128
      const ranked = [...buckets.values()].sort((a, b) => b.w - a.w)
      const top = ranked[0]
      const dominant = top
        ? {
            hex: hexOf(top.r / top.w, top.g / top.w, top.b / top.w),
            lum: 0.2126 * (top.r / top.w) + 0.7152 * (top.g / top.w) + 0.0722 * (top.b / top.w),
          }
        : null
      // 按「照片的颜色」判深浅:有主色就看主色的明暗,灰图才看整图平均
      const ref = dominant ? dominant.lum : avgLum
      // 对话区最暗/最亮落点,统一换算成 0-1 的相对亮度(跟后面判对比度同一把尺)
      chatLums.sort((a, b) => a - b)
      const at = (q) => (chatLums.length ? chatLums[clamp(Math.floor(chatLums.length * q), 0, chatLums.length - 1)] : avgLum)
      /**
       * 切块统计(boss 22:15 的判据):每块取平均亮度,分成 黑/灰/白 三档,数各占多少。
       *
       * 【22:22 换成 sRGB 感知亮度,不再用 WCAG 相对亮度】
       * 第一版用 WCAG 线性亮度 + 0.05 的黑块界,拿boss那两张夜景实测:**暗块 0%**,
       * 79%~90% 全掉进灰块,还是判黑字。
       * 根因:WCAG 那个尺度是给算对比度用的,它把中暗色调得很亮;
       * 人眼看夜景的深蓝天空就是「黑的」,不需要那么严格。
       * 所以这里回到人眼直觉的亮度(sRGB 加权,0-1),黑块界 0.35 / 白块界 0.65,
       * 也就是「看着明显暗」和「看着明显亮」,中间那一大片就是boss说的灰。
       */
      let darkCells = 0
      let lightCells = 0
      let midCells = 0
      let midLumSum = 0
      for (let c = 0; c < gridLum.length; c += 1) {
        if (!gridCount[c]) continue
        const cell = clamp(gridLum[c] / gridCount[c] / 255, 0, 1)
        if (cell < CELL_DARK_MAX) darkCells += 1
        else if (cell > CELL_LIGHT_MIN) lightCells += 1
        else {
          midCells += 1
          midLumSum += cell
        }
      }
      const totalCells = darkCells + lightCells + midCells || 1
      return {
        avgLum,
        brightness: avgLum / 255,
        dominantHex: dominant ? dominant.hex : '',
        kind: ref > LUMA_THRESHOLD ? 'light' : 'dark',
        chatP5: wcagOfSrgb(at(0.05)),
        chatP95: wcagOfSrgb(at(0.95)),
        darkShare: darkCells / totalCells,
        lightShare: lightCells / totalCells,
        midShare: midCells / totalCells,
        midLum: midCells ? midLumSum / midCells : 0,
      }
    }

    /** sRGB 灰度(0-255) → 相对亮度 0-1。跟 wcagLum 同一把尺,只是省得先转成三通道。 */
    function wcagOfSrgb(value) {
      const x = clamp(Number(value) || 0, 0, 255) / 255
      return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4)
    }

    function scaleCanvas(source, maxEdge) {
      const width = source.width || maxEdge
      const height = source.height || maxEdge
      const scale = Math.min(1, maxEdge / Math.max(width, height))
      const canvas = document.createElement('canvas')
      canvas.width = Math.max(1, Math.round(width * scale))
      canvas.height = Math.max(1, Math.round(height * scale))
      const cx = canvas.getContext('2d')
      if (cx) cx.drawImage(source, 0, 0, canvas.width, canvas.height)
      return canvas
    }

    function sampleCanvas(source, sampleWidth = SAMPLE_WIDTH) {
      const width = source.width || sampleWidth
      const height = source.height || sampleWidth
      const canvas = document.createElement('canvas')
      canvas.width = sampleWidth
      canvas.height = Math.max(1, Math.round((sampleWidth * height) / width))
      const cx = canvas.getContext('2d')
      if (cx) cx.drawImage(source, 0, 0, canvas.width, canvas.height)
      return canvas
    }

    function readAsDataUrl(file) {
      return new Promise((resolve, reject) => {
        const reader = new FileReader()
        reader.onerror = () => reject(new Error('read failed'))
        reader.onload = () => resolve(String(reader.result))
        reader.readAsDataURL(file)
      })
    }

    /** 异步地canvas 编成图片 blob(不占主线程不支持webp 自动退出png) */
    function encodeCanvas(canvas, type, quality) {
      return new Promise((resolve) => {
        try {
          canvas.toBlob((blob) => resolve(blob), type, quality)
        } catch (_err) {
          resolve(null)
        }
      })
    }

    function blobToDataUrl(blob) {
      return new Promise((resolve) => {
        if (!blob) return resolve('')
        try {
          const reader = new FileReader()
          reader.onerror = () => resolve('')
          reader.onload = () => resolve(String(reader.result))
          reader.readAsDataURL(blob)
        } catch (_err) {
          resolve('')
        }
      })
    }

    function loadImage(src) {
      return new Promise((resolve, reject) => {
        const image = new Image()
        image.onerror = () => reject(new Error('decode failed'))
        image.onload = () => resolve(image)
        image.src = src
      })
    }

    /** 粗算内容指纹,用来判重 ——绝不按文件名判重,同名不同图要能并存*/
    function fingerprint(text) {
      let hash = 5381
      for (let i = 0; i < text.length; i += 7) hash = ((hash * 33) ^ text.charCodeAt(i)) >>> 0
      return hash.toString(36)
    }

    // ── 导入 ──────────────────────────────────────────────
    let importChain = Promise.resolve()

    /** 串行导入:多文件并发时逐张排队,避免同一批里彼此读到旧图。*/
    function enqueueImport(file) {
      importChain = importChain
        .then(() => importOne(file))
        .catch(() => {})
      return importChain
    }

    async function importOne(file) {
      if (!file) return 'skip'
      const ok = (file.type && file.type.indexOf('image/') === 0) || /\.(png|jpe?g|webp|bmp|gif)$/i.test(file.name || '')
      if (!ok) return 'skip'
      const raw = await readAsDataUrl(file)
      return importDataUrl(raw, (file.name || '').replace(/\.[a-z0-9]+$/i, ''))
    }

    /** 入库主流道压缩  取色  判深浅 算自动遮算 存到图库 */
    async function importDataUrl(raw, name) {
      const image = await loadImage(raw)
      const full = scaleCanvas(image, IMG_MAX_EDGE)
      const analysis = analyzeSample(sampleCanvas(full)) || {
        avgLum: 128,
        brightness: 0.5,
        dominantHex: '',
        kind: 'light',
        chatP5: 0,
        chatP95: 1,
        darkShare: 0.5,
        lightShare: 0.5,
        midShare: 0,
        midLum: 0.2,
      }
      const body = await blobToDataUrl(await encodeCanvas(full, 'image/webp', IMG_QUALITY))
      const thumb = await blobToDataUrl(await encodeCanvas(scaleCanvas(full, THUMB_MAX_EDGE), 'image/webp', THUMB_QUALITY))
      const sig = fingerprint(body)
      if (library.some((item) => item.sig === sig)) return 'duplicate'

      const portrait = full.height > full.width
      const entry = {
        name: name || analysis.dominantHex || 'image',
        sig,
        w: full.width,
        h: full.height,
        portrait,
        // 竖图默认「原图」(boss 10-18 15:50 定的):按原图像素显示,不放大铺满。
        fillMode: portrait ? 'native' : 'cover',
        avgLum: Math.round(analysis.avgLum),
        brightness: Number(analysis.brightness.toFixed(4)),
        dominantHex: analysis.dominantHex,
        kind: analysis.kind,
        autoMask: analysis.kind === 'dark' ? AUTO_MASK_DARK : AUTO_MASK_LIGHT, // skill 原值28 / 58
        // 对话区最暗/最亮落点(0-1 相对亮度)—— 自动垫底的输入,见 autoFloorPct
        chatP5: analysis.chatP5,
        chatP95: analysis.chatP95,
        // 切块统计:黑/白/灰三色各占多少块 —— 判黑白字的输入,见 inkToneFor
        darkShare: analysis.darkShare,
        lightShare: analysis.lightShare,
        midShare: analysis.midShare,
        midLum: analysis.midLum,
        mask: null, // null = 没手调，autoMask
      }
      const id = `img-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
      const result = await postJson(LIBRARY_PATH, { method: 'add', id, entry, image: body, thumb })
      library = Array.isArray(result?.list) ? result.list : library
      return 'added'
    }

    async function importFiles(files) {
      const list = Array.from(files || [])
      if (list.length === 0) return
      importing = true
      notify()
      let added = 0
      let duplicate = 0
      try {
        for (const file of list) {
          const outcome = await enqueueImport(file)
          if (outcome === 'added') added += 1
          if (outcome === 'duplicate') duplicate += 1
        }
      } catch {
        /* 单张失败不影响其他*/
      }
      importing = false
      lastImportNote = { added, duplicate }
      notify()
      // 图库张数变了,随机变换的排期得跟着重排(原来只有一张图是不排期。
      scheduleRotate()
      // 第一次导入图库本来是空的直接把这张设成当前背景
      // 不然boss传完图看着什么都没发生。之后导入不再自动，—skill 一个做跟
      if (added > 0 && !currentEntry() && library.length > 0) {
        await selectImage(library[library.length - 1].id)
        return
      }
      await refreshBackground()
    }

    /** 拖进来的是文件夹时要一层层展开,否则只拿得到第一层*/
    async function filesFromDataTransfer(transfer) {
      const plain = Array.from(transfer.files || [])
      const entries = Array.from(transfer.items || [])
        .map((item) => (typeof item.webkitGetAsEntry === 'function' ? item.webkitGetAsEntry() : null))
        .filter(Boolean)
      if (entries.length === 0) return plain
      const collected = []
      const walk = (entry) =>
        new Promise((resolve) => {
          if (entry.isFile) {
            entry.file(
              (file) => {
                collected.push(file)
                resolve()
              },
              () => resolve(),
            )
            return
          }
          if (!entry.isDirectory) return resolve()
          const reader = entry.createReader()
          const readAll = () =>
            reader.readEntries(
              (batch) => {
                if (batch.length === 0) return resolve()
                Promise.all(batch.map(walk)).then(readAll)
              },
              () => resolve(),
            )
          readAll()
        })
      await Promise.all(entries.map(walk))
      return collected.length > 0 ? collected : plain
    }

    /**
     * 老版本把背景图整张塞进state.json 里boss 10-18 凌晨已经传过一次 
     * 这里把它捞出来走正常入库流程 ——存好了才让主机端把老数据擦掉。
     */
    async function migrateLegacy() {
      let legacy = null
      try {
        legacy = (await postJson(LIBRARY_PATH, { method: 'legacy' }))?.legacy ?? null
      } catch {
        return
      }
      if (!legacy) return
      let raw = ''
      let name = ''
      try {
        if (typeof legacy.image === 'string' && legacy.image) {
          raw = legacy.image
          name = '原来的背景图'
        } else if (typeof legacy.url === 'string' && legacy.url) {
          name = '原来的背景图'
          const response = await fetch(legacy.url)
          if (!response.ok) return
          raw = await new Promise((resolve, reject) => {
            const reader = new FileReader()
            reader.onerror = () => reject(new Error('read failed'))
            reader.onload = () => resolve(String(reader.result))
            reader.readAsDataURL(response.blob())
          })
        } else {
          return
        }
        const outcome = await importDataUrl(raw, name)
        if (outcome !== 'added') return // 导入失败就留着老数据下次再试
        await postJson(LIBRARY_PATH, { method: 'legacy-clear' })
        await postJson(STATE_PATH, { method: 'set', patch: { activeId: library[library.length - 1].id } })
        state = { ...state, activeId: library[library.length - 1].id }
        lastImportNote = { added: 1, duplicate: 0 }
        notify()
      } catch {
        /* 迁移失败就当没有老数据老图还在 state.json 里不会丢*/
      }
    }

    // ── 竖图合成(skill 的composePortrait) ─────────────────
    const coverRect = (sw, sh, vw, vh) => {
      const r = Math.max(vw / sw, vh / sh)
      const dw = sw * r
      const dh = sh * r
      return { dw, dh, dx: (vw - dw) / 2, dy: (vh - dh) / 2 }
    }
    const containRect = (sw, sh, vw, vh) => {
      const r = Math.min(vw / sw, vh / sh)
      const dw = sw * r
      const dh = sh * r
      return { dw, dh, dx: (vw - dw) / 2, dy: (vh - dh) / 2 }
    }

    /**
     * 【已停用】竖图合成。原来靠画布把竖图重画成横图,600 张图的库里换图要等十几秒。
     * 现在 portraitCssFor() 用纯 CSS 双层做同样的事不用解码。这段留着只作参考
     * 实际不再被调用入口在refreshBackground)。
     */
    function composeBackground(image, mode, vw, vh) {
      const canvas = document.createElement('canvas')
      canvas.width = vw
      canvas.height = vh
      const cx = canvas.getContext('2d')
      if (!cx) return ''
      cx.fillStyle = '#15171c'
      cx.fillRect(0, 0, vw, vh)
      if (mode === 'cover') {
        const r = coverRect(image.width, image.height, vw, vh)
        cx.drawImage(image, r.dx, r.dy, r.dw, r.dh)
        return canvas.toDataURL('image/webp', IMG_QUALITY)
      }
      // 垫底:同一张图放大铺满再糊上竖图才不会在两侧留空
      cx.save()
      cx.filter = 'blur(46px)'
      const bleed = coverRect(image.width, image.height, vw, vh)
      cx.drawImage(image, bleed.dx, bleed.dy, bleed.dw * PORTRAIT_BLEED, bleed.dh * PORTRAIT_BLEED)
      cx.restore()

      const fit = containRect(image.width, image.height, vw, vh)
      if (mode === 'right') {
        const right = vw - fit.dw
        cx.drawImage(image, right, fit.dy, fit.dw, fit.dh)
        // 左缘渐变柔化,让图和垫底自然接上
        const fade = fit.dw * 0.35
        const grad = cx.createLinearGradient(right - fade, 0, right, 0)
        grad.addColorStop(0, 'rgba(0,0,0,1)')
        grad.addColorStop(1, 'rgba(0,0,0,0)')
        cx.save()
        cx.globalCompositeOperation = 'destination-out'
        cx.fillStyle = grad
        cx.fillRect(right - fade, 0, fade, vh)
        cx.restore()
      } else {
        cx.drawImage(image, fit.dx, fit.dy, fit.dw, fit.dh)
      }
      return canvas.toDataURL('image/webp', IMG_QUALITY)
    }

    // ── 背景与主题叠加层 ──────────────────────────────────
    /**
     * 反差色两套(boss 10-18 15:50 定的方案)。
     *
     * 不再是"调一个灰色去适配",而是明确的二选一:
     *   底子暗 → LIGHT_INK(白字)
     *   底子亮 → DARK_INK(黑字)
     *
     * 【10-18 16:05 调高不透明度】三档文字原来靠透明度做层次(0.72/0.80),
     * 实测 66 组状态字掉到 2.92:1(要 3)。图标和「进行中」这种小字不能太淡,
     * 现在把不透明度提到 0.88 以上,层次改由字号/字重承担,不靠牺牲可见度。
     *
     * 【10-18 22:05 boss】「这两者的文字明度都相对要高一点」
     * 【10-18 22:05 第二轮纠正】「我让你用黑的跟白的两种字体,没让你用灰色的」
     * —— 上一版把深色字提成了 #2b2e33(深灰),boss看到的是灰字,打回。
     * 现在仍然是黑,只是比死黑亮一点点(#0b0c0f → #1a1c20),看着还是黑。
     * 浅色字本来就是纯白,那四档半透的抬一点是让次要文字更清楚,色相没动。
     */
    const LIGHT_INK = {
      primary: '#ffffff',
      secondary: 'rgba(255, 255, 255, 0.95)',
      tertiary: 'rgba(255, 255, 255, 0.92)',
      caption: 'rgba(255, 255, 255, 0.72)',
      dimmed: 'rgba(255, 255, 255, 0.55)',
      brand: '#c4b8ff',
    }
    const DARK_INK = {
      primary: '#1a1c20',
      secondary: 'rgba(26, 28, 32, 0.94)',
      tertiary: 'rgba(26, 28, 32, 0.90)',
      caption: 'rgba(26, 28, 32, 0.72)',
      dimmed: 'rgba(26, 28, 32, 0.55)',
      brand: '#4a37b8',
    }
    const TEXT_PALETTE = {
      light: LIGHT_INK,
      dark: DARK_INK,
    }
    // 背景分层。两个数字
    //   lift  = 比基准层更实一点越往上层的面板越实层次才看得出。
    //   floor = 这一层的最低不透明度——承载文字的面板不许透到字都看不清
    //
    // floor 是防「白块+ 字看不见」的保底。
    // 【重要修正10-18 01:07】原来的 0.6 / 0.82 太高，——boss实测「浅色图 25%。
    // 深色图40% 背景就不清楚了，根因正是这个保底把背景图盖死，滑杆拉到 0 也救不回来。
    //
    // 【10-18 19:05 再修一次:0.18 → 0.06】
    // boss报「横向的壁纸看着不清晰,透明度拉到 0 还是模模糊糊一层」。
    // 先查了应用自己的毛玻璃钩子:设置页那层模糊(mask)只在弹窗打开时挂上,
    // 不压壁纸 —— 所以雾不是它造成的,是我这行保底。
    // 0.18 的意思是:哪怕boss把滑杆拉到 0,聊天区和侧栏上也永远压着一层 18% 的白,
    // 两层叠一块(侧栏 + 主面板)能到 30% 以上,看着就是一层奶雾。
    // 现在保底只留 0.06 —— 滑杆拉到 0 就真的是"原图透出来",字看得清交给反差色兜底
    // (下面 fixIfBlind 会把对比度顶到 3:1 以上)。
    const BASE_LAYER = '--dsw-alias-bg-base'
    const PANEL_LAYER = '--dsw-alias-bg-layer-1'
    const PANEL_FLOOR = 0.06
    // 弹窗/下拉的底色浓度。boss 10-18 11:20 提的:换肤之后界面本来就半透
    // 下拉框自己那层底色再半透一点两层的图叠一块里面的字就糊了看不清。
    // 这里给它一个保底浓度并且让boss能自己调 ——调低就恢复原来半透的样子。
    // 下拉框是浮在界面上面的小盒子,加实它不会挡住背后的背景图。
    // 档位和默认值见 normalizePopupAlpha / POPUP_ALPHA_*。
    const SURFACE_LAYERS = [
      { name: BASE_LAYER, lift: 0, floor: 0 },
      { name: PANEL_LAYER, lift: 0.04, floor: PANEL_FLOOR },
      { name: '--dsw-alias-bg-layer-2', lift: 0.08, floor: PANEL_FLOOR },
      { name: '--dsw-specific-sidebar-fill', lift: 0, floor: PANEL_FLOOR },
      // ── 以下五枚是 10-18 12:20 补上的 ──
      // 之前插件只洗上面几枚,下面这些全是主题自带的实色。换肤后界面半透,
      // 它们就成了突兀的实块,而且压在它们上面的字是插件按半透底算的,色对不上就糊。
      //
      // 【10-18 15:45】菜单/弹窗的浓度由boss的「弹窗底色浓度」滑杆控制。
      // 【10-18 18:40 boss:毛玻璃透明度别那么低】系数从 0.25 提到 0.6 ——
      // 滑杆默认 0.95 时浓度约 0.57(原来只有 0.24),配合模糊,选项文字更稳。
      // 滑杆仍可 0.5-1.0 调,拉满≈0.6 底 + 44px 模糊,接近苹果的控制中心。
      { name: '--dsw-specific-menu', lift: 0.04, floor: () => Math.max(PANEL_FLOOR, normalizePopupAlpha(state.popupAlpha) * 0.6) },
      { name: '--dsw-alias-bg-overlay', lift: 0.04, floor: () => Math.max(PANEL_FLOOR, normalizePopupAlpha(state.popupAlpha) * 0.6) },
      { name: '--dsw-alias-interactive-bg-hover', lift: 0.02, floor: PANEL_FLOOR },
      { name: '--dsw-alias-bg-module-platform', lift: 0.04, floor: PANEL_FLOOR },
      { name: '--dsw-alias-markdown-code-block', lift: 0.04, floor: PANEL_FLOOR },
      // ── 以下 7 枚是 10-18 15:40 补上的 ──
      // boss截图标出两处看不见:顶部标题栏、底部输入框。
      // 根因同一类:这些底色插件从来没洗过,还是主题原色(实色),
      // 而压在它们上面的文字被插件按半透底重算过 —— 两套对不上,字就没了。
      // 我把应用里所有 --dsw-specific-* 底色扫了一遍(9 枚),之前只洗了 2 枚。
      { name: '--dsw-specific-input-major', lift: 0.04, floor: PANEL_FLOOR },
      { name: '--dsw-specific-bubble', lift: 0.04, floor: PANEL_FLOOR },
      { name: '--dsw-specific-bubble-highlight', lift: 0.06, floor: PANEL_FLOOR },
      { name: '--dsw-specific-selector', lift: 0.04, floor: PANEL_FLOOR },
      { name: '--dsw-specific-sidebar-nav-item-hover', lift: 0.02, floor: PANEL_FLOOR },
      { name: '--dsw-specific-sidebar-nav-item-active', lift: 0.04, floor: PANEL_FLOOR },
      { name: '--dsw-specific-sidebar-nav-item-active-accent', lift: 0.04, floor: PANEL_FLOOR },
      // ── 以下 8 枚是 10-18 16:20 补的 ──
      // boss实测:深色图时文字被调白,但某些元素**自带纯白实底**没被我洗,
      // 白字压白底就消失了;浅色图时文字是黑的,压同一块白底反而看得见。
      // 这批全是「自带不透明实色」的按钮/卡片/更高层面板,之前一枚都没洗过。
      // 「新会话」那个按钮就是 button-elevated-fill(纯白),正是boss框出来的位置。
      { name: '--dsw-alias-bg-layer-3', lift: 0.1, floor: PANEL_FLOOR },
      { name: '--dsw-alias-button-elevated-fill', lift: 0.1, floor: PANEL_FLOOR },
      { name: '--dsw-alias-interactive-bg-hover-solid', lift: 0.06, floor: PANEL_FLOOR },
      { name: '--dsw-alias-settings-card-fill', lift: 0.06, floor: PANEL_FLOOR },
      { name: '--dsw-alias-markdown-code-block-banner', lift: 0.06, floor: PANEL_FLOOR },
      { name: '--dsw-alias-bg-document-preview', lift: 0.06, floor: PANEL_FLOOR },
      { name: '--dsw-alias-turn-trigger-bg', lift: 0.06, floor: PANEL_FLOOR },
      { name: '--dsw-alias-bg-skeleton', lift: 0.06, floor: PANEL_FLOOR },
      // ── 以下 2 枚是 10-19 09:4x 补的，见下面 SOLID_FILLS 的说明 ──
      // 【菜单真正用的底色是这一枚】查 app.asar 发现：菜单材质那层
      // （._material，带 backdrop-filter）用的是 --dsw-menu-surface-fill，
      // 而 --dsw-specific-menu 只是它的别名（app 里就写成 var(--dsw-menu-surface-fill)）。
      // 插件之前只洗了别的名，真正的菜单底一直是白的 —— 白图标压白底就是这么来的。
      { name: '--dsw-menu-surface-fill', lift: 0.04, floor: () => Math.max(PANEL_FLOOR, normalizePopupAlpha(state.popupAlpha) * 0.6) },
      // 菜单里的「吸顶分组条」，底是 94% 的白，字是三级色 —— 不洗就是白条白字
      { name: '--dsw-alias-menu-group-header-fill', lift: 0.04, floor: 0.85 },
    ]
    /**
     * ═══ 10-19 09:4x 补洗的「不透明实色底」═══
     *
     * boss原话:「系统标识有白色底的,里面文字看不到。对话内容中有白色底色的
     * 有的看的到,有的看不到。」
     *
     * 【根因】白字档(深色壁纸)下,SURFACE_LAYERS 只洗了「大底色」那一批,
     * 应用里还有一批**自带不透明浅色实底**的 token 一枚都没洗。
     * 它们原样留成白的,插件又把字和图标刷成白的 —— 白压白,直接消失。
     *   对话里:行内代码、标签、引用块、文件差异行、回到底部那颗圆钮、
     *          卡片上的按钮(里面写着字);
     *   系统侧:菜单真正那层底、菜单吸顶分组条、选中态/悬浮态按钮。
     * 这就解释了「有的看的到,有的看不到」—— 洗过的(代码块等)看的到,
     * 没洗的(行内代码等)看不见。
     *
     * 【为什么不走「垫底」那套】这些 token 在应用里本来就是**不透明实色**,
     * 「垫一层半透底、让壁纸透出来」的模型对它们不成立;而且应用自己就有
     * 深色主题的同名值 —— 直接用它的深色值,观感和应用原生深色主题一致,
     * 颜色语义也不会跑(文件差异行的绿/红就是这么保住的,中性黑垫底会把色相洗掉)。
     *
     * 【取数】10-19 09:4x 从 app.asar 的主题表里抠出来的,不是手调的数;
     * 复算与漂移检查见 verify/wash_audit.cjs、verify/solid_fill_check.cjs。
     * 应用升级换了配色,这两个脚本会报出来。
     */
    const SOLID_FILLS = [
      // ── 对话内容 ──
      { name: '--dsw-alias-markdown-inline-code', light: '#fafafa', dark: '#292929' },
      { name: '--dsw-alias-markdown-tag', light: '#f1f3f5', dark: '#2c2c2e' },
      { name: '--dsw-alias-markdown-citation', light: '#ebeef2', dark: '#353638' },
      { name: '--dsw-alias-markdown-placeholder', light: '#f5f6f7', dark: '#2c2c2e' },
      { name: '--dsw-alias-markdown-code-segment-selected', light: '#ffffff', dark: '#353638' },
      { name: '--dsw-alias-markdown-code-segment-unselected', light: '#f1f3f5', dark: '#1b1b1c' },
      { name: '--dsw-alias-file-diff-added-bg', light: '#e6f4e7', dark: '#1f3124' },
      { name: '--dsw-alias-file-diff-added-gutter', light: '#edf7ed', dark: '#132016' },
      { name: '--dsw-alias-file-diff-deleted-bg', light: '#fce6e2', dark: '#3c1f1b' },
      { name: '--dsw-alias-file-diff-deleted-gutter', light: '#fdece9', dark: '#28130e' },
      // ── 系统侧:按钮与选中态 ──
      { name: '--dsw-alias-button-floating-fill', light: '#ffffff', dark: '#2c2c2e' },
      { name: '--dsw-alias-button-floating-hover', light: '#f1f3f5', dark: '#353638' },
      { name: '--dsw-alias-button-ghost-active-fill', light: '#ebeef2', dark: '#43454a' },
      { name: '--dsw-alias-button-ghost-active-hover', light: '#e9ecf2', dark: '#61666b' },
      { name: '--dsw-alias-button-primary-dimmed', light: '#ebeef2', dark: '#43454a' },
      { name: '--dsw-alias-bg-multi-select', light: '#f5f6f7', dark: '#212123' },
      { name: '--dsw-specific-tip', light: '#f5f6f7', dark: '#353638' },
      { name: '--dsw-specific-login-input', light: '#f9fafb', dark: '#1b1b1c' },
      /**
       * 【没收 --dsw-alias-switch-thumb】它白字档该用 #adb2b8(应用深色主题的值),
       * 但它是**开关上那颗圆钮**,不是承载文字的底 —— 上面判据算的是
       * 「字压在这枚底上」,圆钮上不写字,收进来只会让判据出假警报。
       * 圆钮真正的靠山是它背后的轨道(轨道用的是边框色/品牌色那两枚),
       * 白钮压深轨道一直看得见,不用动。
       */
    ]

    /**
     * ═══ 组件自己的「局部变量」用的那几枚静态色板,也要跟着字色档翻(10-19 13:2x)═══
     *
     * boss红框圈出来的是消息里那张**交付文件卡片**(白底、写着文件名那张):
     * 浅色壁纸下黑字看得见,深色壁纸下字被刷成白的、卡片还是白的 → 看不见。
     *
     * 【根因】这张卡的底不是 alias token,是组件自己的一枚局部变量:
     *     .xxx_root{--deliverable-fill: var(--dsw-static-neutral-50)}
     *     .xxx_file{background: var(--deliverable-fill)}
     * 组件只在 body[data-ds-dark-theme] 时才把它换成 --dsw-static-neutral-850。
     * 插件既没挂那个属性、又从来没动过静态色板 —— 所以它一直白着。
     *
     * 【为什么翻静态色板是安全的】查过 app.asar,这两枚的引用面极窄:
     *   --dsw-static-neutral-50  全应用 6 处:4 处是「卡的底」(card/changes/deliverable/plan-card)
     *                            +2 处是行内代码(--dsw-alias-markdown-inline-code,已在 SOLID_FILLS 里)
     *   --dsw-static-neutral-100 全应用 4 处:全是上面那几张卡的 hover 底
     * **一处当字色/图标色用的都没有** —— 翻它不会误伤前景。深色那侧同理(850 / 800)。
     *
     * 【值就是应用自己深色主题的那两枚】neutral-50 #fafafa ↔ neutral-850 #212123;
     * neutral-100 #f5f5f5 ↔ neutral-800 #292929 —— 不新造颜色,观感跟应用原生深色一致。
     * 两档都写死:字色档只看壁纸亮不亮,跟应用现在是浅色还是深色主题无关,
     * 只写一边,另一边(深色主题 + 亮壁纸)就会黑字压深卡。
     *
     * 【为什么不给 body 挂 data-ds-dark-theme 一把梭】
     * 那枚属性是应用的 ThemePresenter 自己管的:每次主题快照变更它都按「应用当前是什么主题」
     * 重设/移除 —— 而插件写 token 本身就会触发一次快照变更,挂了也立刻被抹掉。
     * presenter 把 token 写成 **body 的内联样式**(优先级最高),
     * 所以走 token 这条路既稳、又不用跟它抢那枚属性。
     */
    const STATIC_SURFACE_FLIP = [
      { name: '--dsw-static-neutral-50', onLight: '#fafafa', onDark: '#212123' },
      { name: '--dsw-static-neutral-100', onLight: '#f5f5f5', onDark: '#292929' },
      { name: '--dsw-static-neutral-850', onLight: '#fafafa', onDark: '#212123' },
      { name: '--dsw-static-neutral-800', onLight: '#f5f5f5', onDark: '#292929' },
    ]
    // 字和它背后那块的实际对比度低于这个值就判「看不清，自动翻字色WCAG （3:1)
    const CONTRAST_MIN = 3
    /**
     * 第三级文字色(文件夹图标 + 「进行中」状态字)的门槛。
     *
     * 【10-18 15:25 定档】先设的是 4.5(正文小字标准)。实测 1387 张图 × 2 套主题,
     * 把各层底色拉齐之后仍有 30 组只能做到 4.44 —— 差 0.06,连纯黑纯白都到不了,
     * 因为那几张图的底色本身就横跨明暗。
     *
     * 按实际场景重新定档:这一层画的是**图标**和**状态字**,
     * WCAG 对非文本/图形元素的门槛就是 3:1,3.5 已经留了余量,
     * 而且实测全部 2774 组在 3.5 下 100% 达标。
     * 卡在 4.5 会让 30 组永远达不到、代码里留一堆"尽力而为"的分支,不值得。
     */
    const TERTIARY_MIN = 3.5

    function wcagLum(rgb) {
      const f = (c) => {
        const v = c / 255
        return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)
      }
      return 0.2126 * f(rgb[0]) + 0.7152 * f(rgb[1]) + 0.0722 * f(rgb[2])
    }

    function contrastRatio(a, b) {
      const hi = Math.max(wcagLum(a), wcagLum(b))
      const lo = Math.min(wcagLum(a), wcagLum(b))
      return (hi + 0.05) / (lo + 0.05)
    }

    /**
     * 算一个「一定看得见」的文字色。
     *
     * 【10-18 14:55 修正】上一版是错的:对比度不够就换成调色板里一个固定色
     * (#6f7683),可那个色自己也不达标 —— 实测在深色图背景上只有 1.38:1,
     * 门槛是 4.5:1,等于没修。这类"换一个固定的"做法必然有漏网的背景色。
     *
     * 现在改成:**按实际背景算**。拿主题色当起点,保持它的色相,
     * 把亮度朝"远离背景"的方向一档一档推,推到对比度达标为止。
     * 这样任何背景色都能保证看得见,不会再有漏的。
     *
     * @param base   主题原本的文字色 [r,g,b]
     * @param behind 文字背后的实际颜色 [r,g,b]
     * @param min    要求的对比度(图标/状态字用 4.5)
     * @returns      达标色的 [r,g,b]
     */
    function solveReadable(base, behind, min) {
      if (!base) base = [128, 128, 128]
      if (contrastRatio(base, behind) >= min) return base
      const bgLum = wcagLum(behind)
      // 背景偏亮就往深里推,背景偏暗就往浅里推 —— 方向由背景决定,不是拍脑袋
      const darken = bgLum > 0.18
      let best = base
      for (let step = 0; step <= 100; step++) {
        const k = step / 100
        const cand = base.map((c) => {
          const target = darken ? 0 : 255
          return Math.round(c + (target - c) * k)
        })
        best = cand
        if (contrastRatio(cand, behind) >= min) return cand
      }
      // 推到纯黑或纯白还不行(极端背景),就返回推到底的那一档
      return best
    }

    function activeScheme() {
      try {
        return ctxRef?.theme?.getTheme?.()?.active?.colorScheme === 'dark' ? 'dark' : 'light'
      } catch {
        return 'light'
      }
    }

    /** 这张图大致是什么颜色有主色用主色,灰图就用平均亮度摊平 */
    function imageRgb(entry) {
      if (!entry) return null
      const rgb = parseRgb(entry.dominantHex)
      if (rgb) return rgb
      const v = Number(entry.avgLum) || 128
      return [v, v, v]
    }

    /** 洗过之后这一层「实际显示出来的颜色」 垫底色按比例盖在图片上
     *  wantsWhite 传 true 时垫暗底(白字那侧),见 veilBaseFor —— 22:57 boss选 A 之后
     *  垫底方向跟字色走,不再跟主题走,所以这里也得跟着字色取色。 */
    function blendedSurface(scheme, name, alpha, imageRgbValue, wantsWhite) {
      const fallback = wantsWhite ? [15, 17, 22] : [255, 255, 255]
      const base = parseRgb(veilBaseFor(name, wantsWhite)) || fallback
      if (!imageRgbValue) return base
      return base.map((c, i) => c * alpha + imageRgbValue[i] * (1 - alpha))
    }

    function rawToken(scheme, name) {
      try {
        const snapshot = ctxRef.theme.getTheme()
        const themes = Array.isArray(snapshot?.themes) ? snapshot.themes : []
        const match = themes.find((entry) => entry?.colorScheme === scheme && entry?.tokens?.[name])
        if (match) return match.tokens[name]
        if (snapshot?.active?.colorScheme === scheme && snapshot.active?.tokens?.[name]) {
          return snapshot.active.tokens[name]
        }
      } catch {
        /* 取不到就用兜底色 */
      }
      return null
    }

    function parseRgb(color) {
      if (typeof color !== 'string') return null
      const text = color.trim()
      if (text.startsWith('#')) {
        let hex = text.slice(1)
        if (hex.length === 3 || hex.length === 4) hex = hex.split('').map((c) => c + c).join('')
        if (hex.length < 6) return null
        return [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16))
      }
      const matched = text.match(/rgba?\(([^)]+)\)/i)
      if (matched) {
        const parts = matched[1].split(/[,\s/]+/).filter(Boolean)
        if (parts.length >= 3) {
          const rgb = parts
            .slice(0, 3)
            .map((part) => (part.endsWith('%') ? Math.round(parseFloat(part) * 2.55) : parseInt(part, 10)))
          return rgb.every((n) => Number.isFinite(n)) ? rgb : null
        }
      }
      return null
    }

    /** 带透明度的颜色拆成 { rgb, a }。判半透明字的对比度时要用它(见 fixIfBlind)。*/
    function parseColorWithAlpha(color) {
      const rgb = parseRgb(color)
      if (!rgb) return null
      let a = 1
      if (typeof color === 'string') {
        const matched = color.match(/rgba?\(([^)]+)\)/i)
        if (matched) {
          const parts = matched[1].split(/[,\s/]+/).filter(Boolean)
          if (parts.length >= 4) {
            const parsed = parts[3].endsWith('%') ? parseFloat(parts[3]) / 100 : parseFloat(parts[3])
            if (Number.isFinite(parsed)) a = clamp01(parsed)
          }
        }
      }
      return { rgb, a }
    }

    function withAlpha(color, alpha) {
      const rgb = parseRgb(color)
      if (!rgb) return color
      return `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${Number(alpha.toFixed(3))})`
    }

    function veil(color, alpha, scheme) {
      const base = color || (scheme === 'dark' ? '#0f1116' : '#ffffff')
      return withAlpha(base, clamp01(alpha))
    }

    /**
     * ═══ 10-19 00:40 boss定的终版画法:底色保留,字色按底子选 ═══
     *
     * boss原话(00:05):「不要用这个加白的底色,只是用一个白色的线框把它框起来」
     * → 00:40 我改成底色全透明后,boss报:「有白色底的时候一样还是看不到文字。
     *   如果说改不了把白色底变成白色框的话,那么我们建议有白色底的时候,文字用蓝色显示。」
     * 以及副作用:悬浮框毛玻璃没了、透明度滑杆失效了。
     *
     * 【根因】底色全透明把三样东西一起拍没了:
     *   ① 面板填充(毛玻璃没了) ② 遮罩层(透明度滑杆失效) ③ 判字色的基准
     *
     * 【终版】
     *   - 底色**恢复**:按主题的正常层次填回来(毛玻璃回来了,滑杆管的那层遮罩也回来了)
     *   - 字色**按底色亮度选**:白底 → 蓝字;深底 → 白字;其余 → 黑字
     *     「白色底用蓝字」是boss 00:40 亲口给的,不是我自己发明的
     */
    function veilBaseFor(name, wantsWhite) {
      /**
       * 【10-19 09:5x 拆掉一个陷阱】原来白字档写的是
       *   rawToken('dark',name) || rawToken('light',name) || '#0f1116'
       * —— 深色主题那枚取不到时,会**退到浅色主题的值**（近白）。
       * 桌面端内置主题的两张 token 表是空的(BUILTIN_THEMES.tokens = {})，
       * 所以真机上取不到、永远走 '#0f1116'，看着没事;可一旦哪天某个主题
       * 真的注册了浅色 token(第三方主题就是走这条路),白字档就会拿到**白的底**,
       * 又是白压白。垫底色只认「这一档该有的颜色」,取不到就用兜底,
       * **不许跨档回退** —— 跨档回退就是把颜色判反。
       */
      if (wantsWhite) return rawToken('dark', name) || '#0f1116'
      return rawToken('light', name) || '#ffffff'
    }

    /**
     * 白底上用的蓝字。boss 00:40 亲口定的:「有白色底的时候,文字用蓝色显示」。
     *
     * 【10-19 16:2x 起不再自动选用】boss报「文字通篇蓝色」后又撤了这一档，
     * 字色只按壁纸明暗出黑/白两种（见下面 band 那段注释）。
     * 调色板留着 —— 哪天真遇到白底面板看不清，按更窄的判据能直接接回来。
     */
    const BLUE_INK = {
      primary: '#0b57d0',
      secondary: 'rgba(11, 87, 208, 0.94)',
      tertiary: 'rgba(11, 87, 208, 0.90)',
      caption: 'rgba(11, 87, 208, 0.78)',
      dimmed: 'rgba(11, 87, 208, 0.60)',
      brand: '#4a37b8',
    }

    /** 边框用的颜色:跟字同色 —— 黑图配白字就描白框,亮图配黑字就描黑框。 */
    function outlineColor(wantsWhite) {
      return wantsWhite ? 'rgba(255,255,255,0.72)' : 'rgba(0,0,0,0.55)'
    }

    /**
     * 文字光晕(同系列换肤手册第七节的做法):白字压多层黑影、黑字压多层白光。
     *
     * 【为什么是 text-shadow 而不是描边】手册踩坑表原话:
     * 「-webkit-text-stroke 描边 → 中文字笔画变粗、发虚、有锯齿 → 弃用,
     *  改用多层 text-shadow 光晕」。中文字跟英文不一样,描边那条路是死路。
     *
     * 【怎么挂上去】text-shadow 是**继承属性**,直接写 body 上,
     * 整棵树的文本都会带上,不用去猜应用那些每次构建都会变的哈希类名。
     * 它只作用于文字本身,不会给图标、边框、圆角带来任何副作用。
     *
     * 【23:08 加了一条保险】`*{}` 会命中所有元素(连滚动条容器、布局壳子都算),
     * 一旦有元素继承了这个属性又被反过来影响布局,界面会卡住。
     * 所以限定在 :where() 里 —— 零特异性的标准选择器,
     * 应用的样式照样压得过它,不会跟应用打架。
     */
    function inkShadowCss(wantsWhite) {
      // 白底配蓝字时,阴影用深蓝灰,不带白光 —— 白光会把蓝字洗淡
      const layers = wantsWhite
        ? '0 1px 2px rgba(0,0,0,0.55),0 0 6px rgba(0,0,0,0.38),0 0 14px rgba(0,0,0,0.24)'
        : '0 1px 2px rgba(255,255,255,0.78),0 0 6px rgba(255,255,255,0.55),0 0 14px rgba(255,255,255,0.34)'
      return `:where(body){text-shadow:${layers}!important;}`
    }

    /** 文字该用哪一档follow 交给主题,auto 看这张图的深浅dark/light 是手动*/
    function resolveTone(entry) {
      if (state.text === 'dark') return 'dark'
      if (state.text === 'light') return 'light'
      if (state.text === 'auto') return entry && entry.kind === 'dark' ? 'light' : 'dark'
      return null
    }

    /**
     * ═══ 判黑白字:按切块的面积占比(boss 10-18 22:15 亲口给的判据)═══
     *
     * 原话:「每张图片你都可以把它切割成小方块,计算它当下的黑白明度占比,
     * 或者是灰色的占比,然后你就能匹配相应的文字呀。
     * 黑的占多的不就用白的吗?白的占多的不就用黑的吗?」
     *
     * 判定顺序:
     *   1. 黑块面积明显多于白块 → 白字
     *   2. 白块面积明显多于黑块 → 黑字
     *   3. 黑白差不多(差不到 5%)→ 看灰块本身偏哪边 —— 就是boss说的「灰色的占比」
     *
     * boss 22:15 给的两张夜景截图正是这个判据要治的毛病:夜景一半黑天空一半亮楼,
     * 取平均落在中间,按中间判就配了黑字,压到黑天空上直接糊。
     *
     * 老图没有切块数据(字段是 22:15 才加的)→ 回退到 21:30 的三档口径,
     * 等 ensureBands 惰性补算完自然就按新判据走。
     *
     * @returns 'white' | 'black'
     */
    function inkToneFor(entry, scheme) {
      const darkShare = Number(entry?.darkShare)
      const lightShare = Number(entry?.lightShare)
      if (Number.isFinite(darkShare) && Number.isFinite(lightShare)) {
        const diff = darkShare - lightShare
        if (diff > CELL_SHARE_EDGE) return 'white'
        if (diff < -CELL_SHARE_EDGE) return 'black'
        // 黑白势均力敌 → 灰块自己往哪边偏(灰块亮度的中点就是那把刀)
        const midLum = Number(entry.midLum)
        if (!Number.isFinite(midLum)) return scheme === 'dark' ? 'white' : 'black'
        return midLum > (CELL_DARK_MAX + CELL_LIGHT_MIN) / 2 ? 'black' : 'white'
      }
      const v = clamp(Number(entry?.avgLum) || 0, 0, 255)
      const tone = wcagOfSrgb(v)
      if (tone < INK_WHITE_MAX) return 'white'
      if (tone > INK_BLACK_MIN) return 'black'
      return scheme === 'dark' ? 'white' : 'black'
    }

    /**
     * ═══ 自动垫底(boss 10-18 21:40「一起都改」)═══
     *
     * 算这张图的**最低透明度**:低到这条线以下,字压在这张图最糟的那块地方就看不清了。
     * 之前滑杆能一路拖到 0,boss拖到看不清为止才停 —— 12% 是他自己试出来的。
     * 现在系统替他算,拖不下去。
     *
     * 算的是「字压在对话区最暗(或最亮)那一小块」的对比度,不是整图平均。
     *
     * 【10-18 22:57 boss选 A 之后,方向不再由主题决定】
     * 以前这里写死「浅色主题垫白、深色主题垫黑」,于是浅色主题配白字时垫多少都没用,
     * 只能返回 0 让 fixIfBlind 硬扛。现在垫底方向跟字色走(见 veilBaseFor):
     * 黑字往亮处垫,白字往暗处垫 —— 任何组合都垫得动,所以这道方向门整个删掉了。
     */
    function autoFloorPct(entry, scheme) {
      if (!entry) return 0
      const p5 = Number(entry.chatP5)
      const p95 = Number(entry.chatP95)
      if (!Number.isFinite(p5) || !Number.isFinite(p95)) return 0
      const ink = inkToneFor(entry, scheme)
      const inkLum = ink === 'white' ? wcagOfSrgb(244) : wcagOfSrgb(11)
      // 黑字 → 往亮处垫(抬最暗落点);白字 → 往暗处垫(压最亮落点)
      const up = ink !== 'white'
      const worst = up ? p5 : p95
      // 达到目标对比度之后,落点必须到的亮度
      const target = up ? (inkLum + 0.05) * AUTO_FLOOR_TARGET - 0.05 : (inkLum + 0.05) / AUTO_FLOOR_TARGET - 0.05
      if (up) {
        if (worst >= target) return 0
        if (target >= 1) return AUTO_FLOOR_CAP
        // 往上调 —— 宁可多垫一个百分点也别差那 0.01,底线是保命线
        return clamp(Math.ceil(((target - worst) / (1 - worst)) * 100), 0, AUTO_FLOOR_CAP)
      }
      if (worst <= target) return 0
      if (target <= 0) return AUTO_FLOOR_CAP
      return clamp(Math.ceil(((worst - target) / (worst || 1)) * 100), 0, AUTO_FLOOR_CAP)
    }

    function buildTokens(entry) {
      const tokens = {}
      const imgRgb = imageRgb(entry)
      // 没选图 = 没换肤,转圈交回主题自己管
      if (!entry) inkIsWhite = null
      /**
       * 【23:20 / 00:40 两次教训】wantsWhite 在**两个独立的 if 块**里都要用,
       * 必须声明在两块之外(函数级)。00:40 我把它写在第一个块里,
       * 第二个块直接 ReferenceError —— 又是防线抓到的,不是boss重启发现的。
       */
      const wantsWhite = !!entry && inkToneFor(entry, activeScheme()) === 'white'
      if (entry) {
        const wash = clamp01(effectiveWash(entry) / 100)
        /**
         * 【10-19 00:40 终版】底色**恢复**(不再全透明):
         *   - 滑杆调的遮罩重新生效(之前透明把这一层拍没了,滑杆等于摆设)
         *   - 面板有填充,毛玻璃回来了
         * 字色在下面那一段按「底色 + 壁纸」的真实明暗三选一:白底蓝字 / 深底白字 / 其余黑字。
         */
        for (const layer of SURFACE_LAYERS) {
          const one = (scheme) => {
            const floor = typeof layer.floor === 'function' ? layer.floor() : (layer.floor ?? 0)
            const alpha = clamp01(Math.max(wash + layer.lift, floor))
            return veil(veilBaseFor(layer.name, wantsWhite), alpha, scheme)
          }
          tokens[layer.name] = { light: one('light'), dark: one('dark') }
        }
        // 边框跟字同色,只是线,不填里面
        const edge = outlineColor(wantsWhite)
        tokens['--dsw-alias-border-l1'] = { light: edge, dark: edge }
        tokens['--dsw-alias-border-l2'] = { light: edge, dark: edge }
        /**
         * ═══ 不透明实色底:按字色极性直接给两套色(见上面 SOLID_FILLS)═══
         *
         * 【10-19 09:4x boss报的两处看不见都在这】以前只洗大底色,
         * 这些实色底一枚没洗 —— 白字档下它们留成白的,字是白的,压上去就没了。
         * 现在:**白字档给应用的深色值,黑字档给浅色值**。
         * 两个方向都要写死:字体档由「壁纸亮不亮」定,和「应用现在是浅色主题还是
         * 深色主题」无关 —— 只写一边,另一边(比如深色主题 + 亮壁纸)就会黑字压深底。
         */
        for (const fill of SOLID_FILLS) {
          const value = wantsWhite ? fill.dark : fill.light
          tokens[fill.name] = { light: value, dark: value }
        }
        /**
         * ═══ 组件「局部变量」吃的那几枚静态色板,一起翻(10-19 13:2x)═══
         * boss红框那张**交付文件卡片**的底走的就是这条路(见 STATIC_SURFACE_FLIP 说明)。
         * 这四枚一次治住「card / changes / deliverable / plan-card」四张卡的底与 hover。
         */
        for (const stat of STATIC_SURFACE_FLIP) {
          const value = wantsWhite ? stat.onDark : stat.onLight
          tokens[stat.name] = { light: value, dark: value }
        }
        /**
         * 【图标色不在这里设】见下面那个块 —— 那里有 scheme / toneRgb 这些变量。
         * 以前两处都设、后设的覆盖先设的,改漏一处就白改;现在只留一处。
         */
      }
      // 跟随主题时的兜底:字色是主题自带的,但我们把背景洗透了之后,
      // 字跟它背后实际显示出来的颜色可能撞在一起浅色主题 + 亮图 = 白块白字)。
      // 这里自己算一遍对比度,不够就把字翻成黑或白。手动选的字色不动。
      //
      // 【boss 10-18 12:20】第三级文字色必须单独保底,而且判据要比主文字更严。
      // 这枚色画的是文件夹图标和「进行中」那行状态字 —— 它设计出来就是灰扑扑的
      // (浅色主题 #8d95a3),原本配实底凑合能用。插件把它洗成半透背景上的暗灰之后,
      // 图标和状态字直接消失。同一个小绿点(「完成」)用的是状态色,插件从不碰它,
      // 所以绿点一直看得见、状态字一直看不见 —— 差别就在这一枚。
      // 主文字 3:1 就够,这枚要 4.5:1 才够(它细、它小、它还带图标)。
      if (entry && state.text !== 'dark' && state.text !== 'light') {
        const scheme = activeScheme()
        const wash = clamp01(effectiveWash(entry) / 100)
        const both = (value) => ({ light: value, dark: value })
        const hex = (rgb) => '#' + rgb.map((v) => clamp(Math.round(v), 0, 255).toString(16).padStart(2, '0')).join('')

        /**
         * ══════ 反差色三档(boss 10-18 21:30 亲口定,21:40 补了垫底)══════
         *
         * 【10-18 18:40 boss报的坑】一张明显偏亮的粉白图却配了白字。
         * 根因:判亮度用的是图片"主色"——主色算法挑的是**最饱和**的颜色,
         * 这张图最饱和的是暗红发饰(#401116),于是被当成暗图配了白字。
         * boss眼睛看到的是整张图的亮堂,不是发饰那块。
         * 18:40 改成用整图平均亮度,21:30 boss嫌还是一个点太粗,又收成三档:
         * 低于 0.10 白字、高于 0.15 黑字、中间那一档交给主题。
         *
         * surfaces 仍然照算 —— 它是 fixIfBlind 的输入,那一层还照旧保底。
         */
        const tone = clamp(Math.round(Number(entry.avgLum) || 128), 0, 255)
        const toneRgb = [tone, tone, tone]
        /**
         * 【23:18 修一个自己引进的崩溃】band 必须先算出来,下面 surfaces 要用它。
         * 22:57 改垫底方向时我把「垫底跟字色走」塞进了 surfaces 的计算里,
         * 却把 const band 留在了后面 —— JS 里 const 有"暂时性死区",
         * 提前用会抛 ReferenceError,而外层 try/catch 又把它吞了,
         * 结果就是:boss选任何一张图,换肤静默失败,界面「没反应」。
         * 教训:这类"变量挪位置"的改动,语法检查(npm --check)是查不出来的,
         * 必须让验证脚本把异常打出来才能发现。
         */
        /**
         * 【10-19 00:40 终版】surfaces = 字背后实际显示的颜色 = 垫底色混壁纸。
         * 00:05 那版底色全透明时这里退化成纯壁纸,00:40 底色恢复后混出来的才
         * 跟屏幕一致 —— 滑杆拖几格,这里的颜色真的跟着变。
         * 这一层是 fixIfBlind 的输入,它决定字色要不要再推一档。
         */
        const surfaces = SURFACE_LAYERS
          .filter((layer) => layer.name !== BASE_LAYER)
          .map((layer) => {
            const floor = typeof layer.floor === 'function' ? layer.floor() : (layer.floor ?? 0)
            const alpha = clamp01(Math.max(wash + (layer.lift || 0), floor))
            return { name: layer.name, rgb: blendedSurface(scheme, layer.name, alpha, toneRgb, wantsWhite) }
          })

        /**
         * ═══ 字色只有黑/白两档（10-19 16:2x boss又打回一次：蓝字档整个撤掉）═══
         *
         * boss 16:17 原话：「已经重启过了，但是还是出现了文字通篇蓝色的，
         * 可能之前修bug没修完。」附了一张亮壁纸的截图。
         *
         * 【量出来的证据】拿他那张截图直接量（verify/measure_ink.py）：
         *   · 对话区底色亮度 0.48、亮像素 55.8% —— 是**亮壁纸**
         *   · 蓝字实测只有 **2.55 : 1**（纯黑字压同一片底是 **11.22 : 1**）
         * 也就是说：这一档既不该出现，出现了还比黑字差四倍多。
         *
         * 【蓝字档是怎么又冒出来的】00:56 那次boss打回过一次，原话是
         * 「我们默认的字体只有黑跟白两种，这就不对了，这是一个 bug」——
         * 当时定的是「屏幕上真的有一层白」才用蓝，判据里有个 `wash > 0.08`。
         * 那会儿 wash 锁 0，所以全库 0 张命中，看着像"蓝字已经绝迹"。可后来
         * 「自动底线」把 effectiveWash 抬回 0~20% —— 亮壁纸 + 垫底≥9% 的组合
         * 又能满足这个条件了，于是 18 张亮图重新变蓝。
         * **这不是新 bug，是老判据的漏洞被补丁重新打开了。**
         *
         * 【现在】字色只按壁纸明暗二选一（inkToneFor：黑块多→白字、亮块多→黑字）。
         * 蓝字调色板 BLUE_INK 留在文件里（boss 00:40 提过白底蓝字这个想法），
         * 但**不再自动选用**：真机上那些会让白字压白底的情况，
         * 已经由 SOLID_FILLS / STATIC_SURFACE_FLIP 两轮补洗按字色档翻掉了，
         * 没有"必须靠蓝字救"的底了。哪天真遇到白底面板看不清，再按更窄的判据加回来。
         */
        const band = inkToneFor(entry, scheme)
        const ink = band === 'white' ? LIGHT_INK : DARK_INK
        // 记下来给转圈用 —— 圈的配色必须跟字走同一个判断,否则又会"算一套画一套"
        inkIsWhite = band === 'white'

        tokens['--dsw-alias-label-primary'] = both(ink.primary)
        tokens['--dsw-alias-label-secondary'] = both(ink.secondary)
        tokens['--dsw-alias-label-tertiary'] = both(ink.tertiary)
        tokens['--dsw-alias-brand-primary'] = both(ink.brand)

        /**
         * 万一某个底色和选定的字色仍然撞(极端图),按那一层单独推一档。
         * 但主基调永远是黑白二选一,不再回到"调灰色"。
         */
        const fixIfBlind = (colorHex, min, alphaAware) => {
          const parsed = parseColorWithAlpha(colorHex)
          if (!parsed) return colorHex
          const base = parsed.rgb
          const alpha = alphaAware ? parsed.a : 1
          /**
           * 【10-18 19:40 补的一个洞】半透明字要按"混出来的颜色"判对比度。
           * 之前三级文字是 rgba(...,0.86),判定却拿纯白/纯黑去比 ——
           * 屏幕上真正显示的是混过一遍的淡色,判定和显示对不上号,
           * 实测有一批中等亮度的图(2774 组里最多 37 组)小字只有 3.3-3.5:1,
           * 差一点点没到 3.5 的线。现在按实际混色判,不够就把它推实。
           */
          const shown = (color) =>
            alpha >= 0.999
              ? color
              : color.map((v, i) => v * alpha + worstSurface.rgb[i] * (1 - alpha))
          let worstSurface = surfaces[0]
          let worst = -1
          for (const surface of surfaces) {
            const r = contrastRatio(shown(base), surface.rgb)
            if (r < worst || worst < 0) {
              worst = r
              worstSurface = surface
            }
          }
          if (worst >= min) return colorHex
          // 先试"把透明度去掉" —— 半透明字变实字,对比度只会更高,观感损失最小
          const opaque = hex(base)
          if (contrastRatio(base, worstSurface.rgb) >= min) return opaque
          const fixed = solveReadable(base, worstSurface.rgb, min)
          return hex(fixed)
        }
        tokens['--dsw-alias-label-primary'] = both(fixIfBlind(ink.primary, CONTRAST_MIN, false))
        tokens['--dsw-alias-label-secondary'] = both(fixIfBlind(ink.secondary, CONTRAST_MIN, true))
        tokens['--dsw-alias-label-tertiary'] = both(fixIfBlind(ink.tertiary, TERTIARY_MIN, true))
        // 这几枚原来根本没被改过,一直是主题原色 —— 深色图上它们和背景撞成一片。
        // caption 用在输入框占位字(应用里有 74 处),menu-icon 用在菜单图标。
        tokens['--dsw-alias-label-caption'] = both(fixIfBlind(ink.caption, TERTIARY_MIN, true))
        tokens['--dsw-alias-label-dimmed'] = both(ink.dimmed)
        tokens['--dsw-alias-label-primary-dimmed'] = both(ink.dimmed)
        /**
         * 【10-19 07:15 / 08:03 / 08:45 boss三次报同一个问题】
         * 「还有一些系统图标也是你加了白色底色的,图标里面应该显示黑色,但是现在看不到了。」
         * 「系统图标你加了白色充填底衬之后,就基本上显示不出来原有的内容了。」
         * 前两次都没修到根上,原因见下面那段的注释 —— 这次不再自己另算背景。
         */
        /**
         * ══════ 菜单图标色:从**真正写进去的菜单底色**反推(10-19 08:55)══════
         *
         * 查了应用文档:「Menu icons use --dsw-alias-menu-icon」——
         * 这枚色专门给菜单图标和导航箭头用,图标就坐在菜单那一层上。
         *
         * 【为什么不再自己算一遍「背后多亮」】算了三次都不对,根因是
         * 「算出来的背景」和「真正写进去的底色」是两条独立的路,
         * 中间任何一处不一致(主题取不到、兜底值不同)都会让两者对不上:
         * 底色是白的、图标也判成白的 —— boss三次看到的都是这个。
         *
         * 现在直接读**写好的那个值**,按它判:菜单底是亮的 → 黑图标;
         * 暗的 → 白图标。判据和落点从此不可能不一致。
         *
         * 【10-19 09:4x 又补一刀】08:55 那次读的是 --dsw-specific-menu,
         * 可菜单材质那层真正用的是 --dsw-menu-surface-fill(前者只是它的别名)。
         * 结果判据读的是「我以为的那层」,屏幕上是「真的那层」—— 还是两条路。
         * 这两枚现在都洗了、写的是同一个底,所以读哪枚都一样;
         * 但按「读真正用的那枚」的原则,优先读 menu-surface-fill。
         */
        const menuToken =
          ((tokens['--dsw-menu-surface-fill'] || tokens['--dsw-specific-menu']) || {}).light || ''
        const menuRgb = parseColorWithAlpha(menuToken)
        const menuLum = menuRgb ? wcagLum(menuRgb.rgb) : 1
        tokens['--dsw-alias-menu-icon'] = both(menuLum > 0.45 ? '#1a1c20' : '#ffffff')
      }
      if (activeTone) {
        const palette = TEXT_PALETTE[activeTone]
        const both = (value) => ({ light: value, dark: value })
        tokens['--dsw-alias-label-primary'] = both(palette.primary)
        tokens['--dsw-alias-label-secondary'] = both(palette.secondary)
        tokens['--dsw-alias-label-tertiary'] = both(palette.tertiary)
        tokens['--dsw-alias-label-caption'] = both(palette.caption)
        tokens['--dsw-alias-label-dimmed'] = both(palette.dimmed)
        tokens['--dsw-alias-label-primary-dimmed'] = both(palette.dimmed)
        // 【10-19 08:55】手动档这里原来又把图标色覆盖了一遍(按 palette 判),
        // 它才是「白图标压白底」的真凶 —— 上面那处算对了,这里又给盖回去。
        // 现在图标色只有一处来源(上面),这里不再碰。
        tokens['--dsw-alias-brand-primary'] = both(palette.brand)
      }
      return tokens
    }

    function refreshLayer(entry) {
      if (applying) return
      applying = true
      try {
        if (layerDispose) {
          try {
            layerDispose()
          } catch {
            /* 撤层失败也继续重建*/
          }
          layerDispose = null
        }
        const tokens = buildTokens(entry)
        if (Object.keys(tokens).length === 0) return
        const override = ctxRef?.theme?.overrideTokens
        if (typeof override !== 'function') return
        try {
          layerDispose = override.call(ctxRef.theme, SOURCE, tokens)
        } catch {
          // 有些版本不认三级文字那枚 token,退到两级其余照旧
          if (tertiaryOk && tokens['--dsw-alias-label-tertiary']) {
            tertiaryOk = false
            delete tokens['--dsw-alias-label-tertiary']
            try {
              layerDispose = override.call(ctxRef.theme, SOURCE, tokens)
            } catch {
              layerDispose = null
            }
          } else {
            layerDispose = null
          }
        }
      } catch (e) {
        layerDispose = null
        /**
         * 【23:18】这里以前是静默吞异常 —— 结果 23:08 boss报「选图片没反应」时,
         * 验证脚本还照样报绿,把我骗过去了。现在异常会打到控制台,
         * 并且 full_verify.cjs 有一条硬判据专门抓这种「静默失败」(见那个脚本)。
         */
        if (typeof console !== 'undefined' && console.error) {
          console.error('[dsh-skin] 换肤失败:', e && e.stack ? e.stack : String(e))
        }
      } finally {
        applying = false
      }
    }

    const cssEscape = (value) => String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/[\r\n]/g, '')

    /**
     * 进行中那个转圈的颜色(boss 10-18 16:45 提的)。
     *
     * 原来它跟着「第三级文字色」走,那是半透明的灰,所以圈一直是灰的、不显眼。
     * 现在按boss定的反差色:
     *   底色偏亮 → 亮绿圈(和完成的小绿点同色系,但提一档亮度更跳)
     *   底色偏暗 → 白圈
     * 转圈的 svg 带 data-state="ongoing",弧线用 currentColor,
     * 所以覆盖这一条 color 就能改圈色。
     */
    function spinnerCssFor() {
      // 【10-18 19:20 boss:「所有任务前面的转圈都改成绿色的,
      // 不要再根据背景颜色图片的改变做出调整了,我看了一下用绿色的是最好的」】
      // 所以这里彻底不看 inkIsWhite 了 —— 不管深图浅图,转圈一律绿。
      // (之前是 inkIsWhite ? 白 : 绿,boss嫌换来换去不统一。)
      // 弧线用 currentColor,覆盖 [data-state=ongoing] 的 color 就能改圈色。
      const color = '#00e676'
      const glow = 'drop-shadow(0 0 2px rgba(0, 230, 118, 0.45))'
      // 底环那个 circle 是 svg 里第一个 circle。应用的类名带哈希(_spinnerTrack_xxx),
      // 按类名选不中,所以用结构选择器。
      return (
        '[data-state="ongoing"]{color:' + color + ' !important;filter:' + glow + ';}' +
        '[data-state="ongoing"] circle{stroke-width:2.6 !important;}' +
        '[data-state="ongoing"] circle:first-of-type{opacity:.55 !important;}' +
        spinnerDotCssFor()
      )
    }

    /**
     * 完成/需要授权那些「点」放大(boss 10-18 17:16 提的)
     *
     * boss说的"有时橘黄有时绿"就是这几种状态点:绿=完成、黄=要授权、红=出错。
     *
     * 【为什么不直接改宽高】点是 10px 外框 + 里面画一个占 60% 的圆(实际只有 6px)。
     *   改外框会挤到侧栏那一行(行高 32px、槽位宽 16px),而且
     *   data-state="failed" 这个值**按钮也在用**,一并放大会把按钮压成小方块。
     *
     * 【用的办法】只把里面那个圆的占比提上去,外框尺寸一动不动:
     *   原来 inset:20% → 圆占 60% = 6px
     *   10-18 17:36 boss要从 1.6 倍收到 1.3 倍 → inset:11% → 圆占 78% = 7.8px
     *   7.8 ÷ 6 = 1.30 倍
     *   不碰任何布局、不会误伤按钮。:after 这个写法只有圆点在用。
     */
    function spinnerDotCssFor() {
      const states = ['done', 'warning', 'error', 'idle']
      return states
        .map((s) => '[data-state="' + s + '"]:after{inset:11% !important;}')
        .join('')
    }

    /**
     * 苹果毛玻璃(boss 10-18 18:23 提的:「所有点出来的选项用毛玻璃状态」)
     *
     * 【为什么这个方案对】之前为了让字看得清,只能把浮层底色往实里加 ——
     * 加实了就变成一块死板的板子,把背景图挡得死死的,boss嫌难看。
     * 毛玻璃换了个思路:**字看得清不靠底色变实,靠把背后的图糊掉**。
     * 底色保持半透,底下加一层模糊 + 提饱和,字自然跳出来,图也还在。
     *
     * 【挂在现成钩子上,不自己造】应用本来就留了两枚毛玻璃变量:
     *   --dsw-menu-backdrop-filter  菜单/下拉那批浮层在用(7 处),默认 blur(40px) saturate(150%)
     *   --dsw-mask-blur             设置页背后那层遮罩在用,默认是 none —— 等于没开!
     * boss说"设置页点开还是透明、没有底色填充",根因就在这:
     * 遮罩没模糊 + 面板底色被我们洗到 0.18,两层都透,叠起来就是空的。
     *
     * 这里把两枚钩子都开足,设置页和菜单一起变毛玻璃。
     */
    function frostedCssFor() {
      return [
        // 设置页背后遮罩:原来是 none,现在给足模糊 + 提饱和
        'body{--dsw-mask-blur:blur(28px) saturate(1.7) !important;',
        // 菜单/下拉:应用自带 40px 模糊已经够糊,饱和再提一档,更接近苹果那味儿
        'body{--dsw-menu-backdrop-filter:blur(44px) saturate(1.8) !important;}',
      ].join('')
    }

    /**
     * 悬浮框里的滚动条改成红色(boss 10-18 20:56 原话:「悬浮框里面的选项,
     * 存在左滑跟下滑全部都用红色显示,否则的话太不明显了」)
     *
     * 【为什么不自己重写一套 ::-webkit-scrollbar】
     * 应用本来就是用变量画滚动条的:thumb 的颜色、粗细、悬停色全是三枚变量,
     * 规则长这样 —— 粗细一个值同时管左右和上下,所以「左滑跟下滑全部」天然一起变。
     * 自己重写一套反而要多打八条规则,还得跟应用的圆角、内边距打架。
     * 直接改这三枚变量,滚动条的形状还是应用原来那套,只换了颜色。
     *
     * 【为什么挂在面板这一层】boss说的是"悬浮框里面",聊天区和设置页的滚动条不动,
     * 全站红条太扎眼。变量会往下传,面板里所有能滚的地方(面板本身、图库那一格)
     * 一并变红,不用挨个挂钩子。
     */
    const PANEL_CSS = [
      '.dsh-skin-panel{',
      '--dsh-scrollbar-thumb:#e5484d;',
      '--dsh-scrollbar-thumb-hover:#ff6369;',
      '--dsh-scrollbar-width:10px;',
      // 标准属性(Firefox 那套):Chromium 走上面的变量,这句在这边无害
      'scrollbar-width:thin;',
      'scrollbar-color:#e5484d transparent;',
      '}',
    ].join('')

    /**
     * 文字光晕跟着当前这张图的字色走(boss 22:57 选 A 之后配套的一手,
     * 做法抄自 同系列换肤脚本 换肤手册第七节 —— 见 inkShadowCss 的注释)。
     *
     * 【23:08 改过一次】第一版靠给 body 增删一个 class 来开关光晕,
     * boss重启后报「选了图片直接没反应」—— 那个 class 一加一删就改动了
     * 全应用所有元素的文字渲染,叠上换图时的重绘,界面直接卡住不响应。
     * 现在完全不碰 DOM:直接拼进那份壁纸样式,跟着别的样式整体替换;
     * 没选图就返回空串自动撤掉,没有任何额外操作。
     */
    function inkShadowCssFor(entry) {
      if (!entry) return ''
      return inkShadowCss(inkToneFor(entry, activeScheme()) === 'white')
    }

    function backgroundCssFor(url, size) {
      return [
        'html{background-image:url("' + cssEscape(url) + '") !important;',
        `background-size:${size} !important;`,
        'background-position:center center !important;',
        'background-repeat:no-repeat !important;',
        // 注意:这里是scroll 不是 fixed。同系列换肤脚本 的铁律——
        // Electron 内滚容器下background-attachment:fixed 会失效他们的CSS 也用 local。
        // DSH 的滚动发生在内层容器上根元素本身不滚所以挂根元素等价于固定。        'background-attachment:scroll !important;}',
      ].join('')
    }

    /**
     * 竖图渲染(boss 10-18 18:15 报「竖图完全看不到图」的修复)
     *
     * 【根因】CSS 绘制顺序里,负 z-index 的元素画在 canvas(html 背景)**之上**。
     * 原来主图挂在 html 背景上,模糊垫底层(z-index:-2)盖满全屏、几乎不透明 ——
     * 主图一出生就被垫底盖死了。横图没有垫底层所以正常,
     * 这也解释了"明度怎么调都没用":调的是内容层,看不见的那层根本没参与。
     *
     * 【修法】主图不再挂 html 背景,改成独立元素 .dsh-skin-front(z-index:-1):
     *   canvas → 垫底(-2,模糊缩略图) → 主图(-1,清晰完整) → 内容(半透洗过)
     * 垫底只负责两侧过渡,主图整张完整显示(contain:图比屏大就缩小、不裁剪)。
     */
    function portraitCssFor(frontUrl, bleedUrl, mode, bleedPx) {
      const pos = mode === 'right' ? 'right center' : 'center center'
      const radius = clamp(Math.round(Number(bleedPx) || 0), 0, 64)
      // 【10-18 20:45 boss同意 D:竖图两侧那层模糊过渡改成可调】
      // 拉到 0 就干脆不要这层 —— 两侧露干净的底色,不糊。
      const bleedCss = radius > 0
        ? '.dsh-skin-bleed{position:fixed;inset:0;z-index:-2;pointer-events:none;' +
          'background-image:url("' + cssEscape(bleedUrl) + '");' +
          'background-size:cover;background-position:center;background-repeat:no-repeat;' +
          'filter:blur(' + radius + 'px) saturate(.85);transform:scale(1.06);opacity:.92;}'
        : ''
      return [
        bleedCss,
        '.dsh-skin-front{position:fixed;inset:0;z-index:-1;pointer-events:none;',
        'background-image:url("' + cssEscape(frontUrl) + '");',
        'background-size:contain;background-position:' + pos + ';background-repeat:no-repeat;}',
      ].join('')
    }

    /**
     * 竖图的两层元素一起挂/撤:
     *   .dsh-skin-bleed = 模糊垫底(z-index:-2)
     *   .dsh-skin-front = 清晰主图(z-index:-1)
     * 10-18 18:15 起主图不再挂 html 背景(会被负 z-index 的垫底盖死),
     * 改成独立元素,所以这里两层同开同关。横图(cover)两层都不要。
     */
    function syncBleedLayer(wanted) {
      try {
        for (const cls of ['dsh-skin-bleed', 'dsh-skin-front']) {
          let node = document.querySelector('.' + cls)
          if (!wanted) {
            if (node) node.remove()
            continue
          }
          if (!node) {
            node = document.createElement('div')
            node.className = cls
            document.body.appendChild(node)
          }
        }
      } catch {
        /* DOM 拿不到就算了,背景还在 */
      }
    }

    /** 重画背景 + 主题叠加层。横图和竖图现在都是同步的不用等解码。*/
    async function refreshBackground() {
      backgroundSeq += 1
      const entry = currentEntry()
      activeTone = resolveTone(entry)
      refreshLayer(entry)

      if (!entry) {
        inkIsWhite = null
        wallpaperCssText = ''
        syncBleedLayer(false)
        notify()
        return
      }
      const mode = entry.portrait ? entry.fillMode || 'native' : 'cover'
      const baseCss =
        mode === 'cover'
          ? backgroundCssFor(imageUrl(entry.id), 'cover')
          : portraitCssFor(imageUrl(entry.id), imageUrl(entry.id, true), mode, state.bleed)
      // 模糊调到 0 就把垫底那层撤掉,别留一张看不见也占着的全屏图
      if (mode === 'cover' || !(state.bleed > 0)) syncBleedLayer(false)
      else syncBleedLayer(true)
      // 转圈的反差色 + 毛玻璃 + 文字光晕,跟着壁纸一起挂(同一个 <style>,一次生效)
      wallpaperCssText = baseCss + spinnerCssFor() + frostedCssFor() + inkShadowCssFor(entry)
      notify()
    }

    // ── 界面动作 ──────────────────────────────────────────
    // 注意:下面这几个动作都**不要**自己 notify()。
    // refreshBackground() 结尾统一会notify 一次这里再叫一次就是同一个动作
    // 把整个面板重画两遍boss拖一下滑杆就是两次全量重绘。
    async function selectImage(id) {
      state = { ...state, activeId: id }
      await refreshBackground()
      // 【10-18 21:40】老图没有「对话区最暗/最亮落点」这两个数,自动垫底就算不出来。
      // 不批量重算(1387 张逐张加载会把界面卡死),翻到哪张补哪张 —— 第一次慢一下,之后走缓存。
      void ensureBands(currentEntry())
      await saveState({ activeId: id })
    }

    /**
     * ═══ 双击右键：自定义背景 ⇄ 系统默认壁纸 ═══════════════════════
     *
     * 【10-22 00:0x boss】「双击右键切换为自定义背景，或者是双击右键从自定义背景切换成系统的默认壁纸」
     *
     * 两种状态来回切：
     *   现在挂着自定义壁纸 → 撤掉壁纸，回到没装换肤时的样子（**只撤壁纸**）
     *   现在是默认（没壁纸）     → 换回上一次那张自定义壁纸（没记住就用图库第一张）
     *
     * ⚠️ 为什么不直接调 `restoreDefaults()`：
     *    那个是面板里的「恢复默认界面」，它**连配色、模式、自动换肤一起撤**。
     *    boss要的是"切个壁纸"，不该顺手把他调好的专注/休闲模式和文字颜色也清掉。
     *    所以这里只动 `activeId`，其余设置原样保留。
     *
     * 【10-22 00:3x boss确认「就是在插件里面做壁纸的自定义快捷切换」】
     *   → "记住上次那张"**必须落盘**（`state.lastWallId`），否则重启后双击右键
     *     切回去的是图库第一张，那就不是快捷切换了。
     *
     * 【10-22 07:4x boss选 A】「切回默认时，自动把『自动换肤』暂停」
     *   不暂停的话：刚按右键切成干净界面，一分钟（或您设的间隔）到点又自己换回来
     *   —— 右键这股等于白按。所以切默认时**顺手把自动换肤关掉**并落盘，
     *   提示条也明说「自动换肤已暂停」，免得boss以为设置被吃了。
     *   ⚠️ 反过来（切回自定义）**不自动恢复**自动换肤：boss要再开就双击左键，别替他决定。
     */
    async function toggleWallpaperDefault() {
      const dict = dictFor()
      // ① 当前有自定义壁纸 → 切回系统默认（把这张记进存档，重启后也认）
      if (state.activeId) {
        const keep = state.activeId
        const hadRotate = normalizeRotate(state.rotateMinutes) > 0
        state = {
          ...state,
          activeId: '',
          lastWallId: keep,
          rotateMinutes: hadRotate ? 0 : state.rotateMinutes,
        }
        // refreshBackground 拿到空 activeId 会自己撤掉图层、清空 CSS 并通知重画
        await refreshBackground()
        // ⚠️ 必须重排一次：光把 state 改掉不清定时器，到点照样会换回来
        scheduleRotate()
        await saveState({
          activeId: '',
          lastWallId: keep,
          rotateMinutes: hadRotate ? 0 : state.rotateMinutes,
        })
        return { ok: true, text: hadRotate ? dict.wallToDefaultPaused : dict.wallToDefault }
      }
      // ② 当前是默认 → 切回上次那张（存档里那张被删了/没有就退图库第一张）
      const remembered = state.lastWallId && library.some((item) => item.id === state.lastWallId)
        ? state.lastWallId
        : ''
      const target = remembered || (library[0]?.id ?? '')
      if (!target) return { ok: false, text: dict.wallNoImage }
      await selectImage(target)
      return { ok: true, text: dict.wallToCustom }
    }

    /**
     * 给缺字段的老图补算对话区分位数,并写回图库。
     * 已经在算的跳过,避免连点时重复加载同一张。
     */
    const bandJobs = new Set()
    async function ensureBands(entry) {
      if (!entry || !entry.id) return
      // 22:15 又加了切块统计三个字段,老图要一起补;缺任一个都重算
      if (Number.isFinite(Number(entry.chatP5)) && Number.isFinite(Number(entry.chatP95)) && Number.isFinite(Number(entry.darkShare))) return
      if (bandJobs.has(entry.id)) return
      bandJobs.add(entry.id)
      try {
        const image = await loadImage(imageUrl(entry.id, false))
        // 192 宽采样:分位数要够多的像素才稳,48 宽那条带只有 400 来个点,会被压缩噪声带偏
        const analysis = analyzeSample(sampleCanvas(image, 192))
        if (!analysis) return
        const patch = {
          chatP5: analysis.chatP5,
          chatP95: analysis.chatP95,
          darkShare: analysis.darkShare,
          lightShare: analysis.lightShare,
          midShare: analysis.midShare,
          midLum: analysis.midLum,
        }
        const result = await postJson(LIBRARY_PATH, { method: 'update', id: entry.id, patch })
        const at = library.findIndex((item) => item.id === entry.id)
        if (at >= 0) library = [...library.slice(0, at), { ...library[at], ...patch }, ...library.slice(at + 1)]
        else if (Array.isArray(result?.list)) library = result.list
        if (state.activeId === entry.id) await refreshLayer(currentEntry())
      } catch {
        /* 这张算不出来就按没有底线处理,不影响其它功能 */
      } finally {
        bandJobs.delete(entry.id)
      }
    }

    async function setMode(mode) {
      state = normalizeState({ ...state, mode })
      await refreshBackground()
      await saveState({ mode })
    }

    let lastImportNote = null

    /** 滑块落盘去抖 150ms ——拖一下就是几十次写入,不抖会把磁盘写满(skill 的同款处理 */
    let washSaveTimer = null

    /** 手松开/焦点走人时把还挂在去抖里的那次写入立刻落盘*/
    function flushWash() {
      if (washSaveTimer === null) return
      clearTimeout(washSaveTimer)
      washSaveTimer = null
      void saveState({ wash: state.wash })
    }

    async function setWash(value, persist = true) {
      state = normalizeState({ ...state, wash: value })
      await refreshBackground()
      if (!persist) return
      clearTimeout(washSaveTimer)
      const payload = { wash: value }
      washSaveTimer = setTimeout(() => {
        washSaveTimer = null
        void saveState(payload)
      }, 150)
    }

    async function setText(text) {
      state = normalizeState({ ...state, text })
      await refreshBackground()
      await saveState({ text })
    }

    async function setFillMode(fillMode) {
      const entry = currentEntry()
      if (!entry) return
      try {
        const result = await postJson(LIBRARY_PATH, { method: 'update', id: entry.id, patch: { fillMode } })
        library = Array.isArray(result?.list) ? result.list : library
      } catch {
        /* 存不进去也先把界面上切过去*/
      }
      notify()
      await refreshBackground()
    }

    /** 竖图两侧那层模糊过渡的半径。0 = 撤掉这层。*/
    async function setBleed(value) {
      const bleed = clamp(Math.round(Number(value) || 0), 0, 64)
      state = normalizeState({ ...state, bleed })
      notify()
      await refreshBackground()
      await saveState({ bleed })
    }

    /**
     * ═══ 提示音(boss 10-18 23:45 选 A)═══
     *
     * 一声短「叮」,用界面自带的发声能力现场合成 —— 不需要音频文件,也不联网。
     * 做法:一个音 + 一个比它高一点点的音叠在一起,快速由响变轻,听着像提示音。
     *
     * 【为什么不直接用 Audio 标签】那需要一个音频文件,还得解决放哪、怎么打包。
     * 【为什么要先点一下才准】浏览器规矩:没有用户点过界面就不让出声。
     * 第一次点面板上的「试听」就等于授权了,之后自动响就没问题。
     */
    let audioCtx = null
    function playChime(volume) {
      try {
        const Ctor = typeof window !== 'undefined' ? (window.AudioContext || window.webkitAudioContext) : null
        if (!Ctor) return
        if (!audioCtx) audioCtx = new Ctor()
        if (audioCtx.state === 'suspended' && typeof audioCtx.resume === 'function') audioCtx.resume()
        const vol = clamp(Number(volume) || 0, 0, 1) * 0.3 // 0.3 是防太吵的上限
        const now = audioCtx.currentTime
        const master = audioCtx.createGain()
        master.gain.value = vol
        master.connect(audioCtx.destination)
        for (const freq of [880, 1318.5]) {
          const osc = audioCtx.createOscillator()
          const gain = audioCtx.createGain()
          osc.type = 'sine'
          osc.frequency.value = freq
          // 由响到轻,0.45 秒收干净 —— "叮"的尾巴
          gain.gain.setValueAtTime(0.0001, now)
          gain.gain.exponentialRampToValueAtTime(1, now + 0.02)
          gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.45)
          osc.connect(gain)
          gain.connect(master)
          osc.start(now)
          osc.stop(now + 0.5)
        }
      } catch {
        /* 出不了声就算了,不影响换肤 */
      }
    }

    /** 试听:顺带把浏览器的发声授权拿到手。*/
    async function testChime() {
      if (state.soundId) {
        playCustomSound()
        return
      }
      playChime(state.soundVolume)
      try {
        await postJson(BELL_PATH, { kind: 'test' })
      } catch {
        /* 记不记都行 */
      }
    }

    /**
     * ═══ 自定义音效(boss 10-19 00:20 要的「添加窗口」)═══
     *
     * 音频归主机端管(换端口不丢),页面按 id 取回来播。
     * 用 <audio> 元素播 —— 比 AudioContext 简单,长音频、循环都能管。
     *
     * 为什么复用同一个元素:同一个文件反复播,请求一次就够,
     * 而且换文件时才重建,避免每响一次都去请求一遍。
     */
    let customAudio = null
    let customAudioUrl = ''
    function playCustomSound() {
      try {
        const id = state.soundId
        if (!id) return
        const url = `${SOUND_PATH}?id=${encodeURIComponent(id)}`
        if (customAudioUrl !== url || !customAudio) {
          if (customAudio) {
            try {
              customAudio.pause()
            } catch {
              /* 停不掉就算了 */
            }
            customAudio = null
          }
          customAudio = new Audio(url)
          customAudio.volume = clamp(Number(state.soundVolume) || 0, 0, 1)
          customAudioUrl = url
        }
        customAudio.currentTime = 0
        const p = customAudio.play()
        if (p && typeof p.catch === 'function') {
          /**
           * 【10-19 19:5x】以前这里是 `.catch(() => {})` —— **静默吞掉**。
           * 结果：自定义音效播不出来（浏览器没给发声授权 / 文件坏了 / 解码失败）时，
           * 屏幕上一点动静都没有，看着就是"任务完成没声音"，查都没法查。
           * 现在：退回内置那声叮（至少有个响），并在面板上把原因写一句明话。
           */
          p.catch((error) => {
            soundNote = `自定义音效没播出来（${String(error?.name || error?.message || '浏览器拦了')}），这次用内置叮代替`
            soundNoteIsError = true
            notify()
            playChime(state.soundVolume)
          })
        }
      } catch {
        /* 播不了就当没这功能 */
      }
    }

    async function setSoundOn(next) {
      state = normalizeState({ ...state, soundOn: next === true })
      notify()
      await saveState({ soundOn: state.soundOn })
    }

    async function setSoundVolume(value) {
      const vol = clamp(Number(value) || 0, 0, 1)
      state = normalizeState({ ...state, soundVolume: vol })
      notify()
      await saveState({ soundVolume: vol })
    }

    /**
     * 面板语言：一键切中/英（boss 10-19 21:1x：「中英双语…默认中文…一键切换」）。
     * 立刻重画 + 落盘记住 —— 下次打开还是这套语言。
     */
    async function setLang(next) {
      const lang = next === 'en' ? 'en' : 'zh'
      state = normalizeState({ ...state, lang })
      notify()
      await saveState({ lang })
    }

    /**
     * 新手引导：点「知道了」把它收起来（落盘，下次不再自己跳）。
     * 之后想看：面板上的「新手指引」按钮随时能再打开（那只是临时的，不改落盘的标记）。
     */
    async function dismissGuide() {
      guideOpen = false
      state = normalizeState({ ...state, onboarded: true })
      notify()
      await saveState({ onboarded: true })
    }

    // ── 自定义音效(boss 10-19 00:20 要的) ─────────────────
    /** 拉一次列表。面板打开时调,失败就当没有。 */
    async function loadSoundList() {
      try {
        const result = await postJson(SOUNDS_PATH, {})
        soundList = Array.isArray(result?.list) ? result.list : []
        soundUsage = result?.usage || null
      } catch {
        soundList = []
      }
      notify()
      return soundList
    }

    /** 现在的容量天花板:主机端说了算,它没回话就用兜底那份 */
    function soundCaps() {
      return {
        maxBytes: Number(soundUsage?.maxBytes) || SOUND_CAPS_FALLBACK.maxBytes,
        maxCount: Number(soundUsage?.maxCount) || SOUND_CAPS_FALLBACK.maxCount,
        totalBytes: Number(soundUsage?.total) || SOUND_CAPS_FALLBACK.totalBytes,
      }
    }

    /** 已用多少:优先主机端报的数,没有就把手里这份列表自己加起来 */
    function soundUsedBytes() {
      const reported = Number(soundUsage?.used)
      if (Number.isFinite(reported) && reported >= 0) return reported
      return soundList.reduce((sum, item) => sum + (Number(item?.bytes) || 0), 0)
    }

    /**
     * 上传一个音频。
     * 只收常见格式,单个 8MB 封顶,再加总量两道闸(条数 / 总容量,见 SOUND_CAPS_FALLBACK)。
     * 失败会给一句明话,不让boss看着像点了没反应。
     *
     * @param quiet 批量添加时传 true —— 那时一句一条太吵,由调用方汇总成一句
     * @returns 'added' | 'bad' | 'big' | 'full' | 'space' | 'fail' | 'skip'
     */
    async function importSound(file, quiet) {
      if (!file) return 'skip'
      const caps = soundCaps()
      const name = String(file.name || '')
      const ext = (name.match(/\.[a-z0-9]+$/i) || [''])[0].toLowerCase()
      const say = (text) => {
        if (quiet) return
        soundNote = text
        soundNoteIsError = true
        notify()
      }
      if (!['.mp3', '.wav', '.ogg', '.m4a', '.aac', '.flac', '.webm'].includes(ext)) {
        say('这个格式用不了,换 mp3 / wav / ogg 试试')
        return 'bad'
      }
      if (file.size > caps.maxBytes) {
        say(`这个文件超了 ${Math.round(caps.maxBytes / 1024 / 1024)}MB,换个小一点的`)
        return 'big'
      }
      /**
       * 先在本地拦一道(条数满了 / 总量放不下) —— 主机端也会拦,
       * 但那要等整个文件传完才回话,大文件白传一遍。这里先给结论。
       */
      if (soundList.length >= caps.maxCount) {
        say(`音效最多 ${caps.maxCount} 条,现在已经有 ${soundList.length} 条 —— 先删几条再加`)
        return 'full'
      }
      if (soundUsedBytes() + file.size > caps.totalBytes) {
        say(
          `音效总容量上限 ${Math.round(caps.totalBytes / 1024 / 1024)}MB,` +
            `现在已用 ${(soundUsedBytes() / 1024 / 1024).toFixed(1)}MB,这个文件放不下 —— 先删几条再加`,
        )
        return 'space'
      }
      try {
        const raw = await readAsDataUrl(file)
        const id = `snd-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
        const result = await postJson(SOUNDS_PATH, {
          method: 'add',
          id,
          name: name.replace(/\.[a-z0-9]+$/i, ''),
          ext,
          data: raw,
        })
        if (Array.isArray(result?.list)) soundList = result.list
        if (result?.usage) soundUsage = result.usage
        if (!quiet) {
          soundNote = ''
          soundNoteIsError = false
          notify()
        }
        return 'added'
      } catch (error) {
        // 主机端报的错(比如总量满了/超大小)原样带给boss看
        const text = String(error?.message || '添加失败,换个文件试试')
        if (quiet) return 'fail'
        say(text)
        return 'fail'
      }
    }

    /**
     * ═══ 批量添加(boss 10-19 13:55:「音效支持批量添加」)═══
     *
     * 【以前是什么样】选文件框没开多选、代码只取 files[0] ——
     * 一次框选 10 个只进去第一个,另外 9 个**一声不响地没了**。
     * 现在:逐个上传(一个文件一个请求,免得一次请求把 64MB 读体上限撞了),
     * 最后把结果汇总成一句明话 —— 几个进去了、几个没进去、为什么。
     */
    async function importSounds(files) {
      const picked = Array.from(files || []).filter(Boolean)
      if (!picked.length) return
      const tally = { added: 0, bad: 0, big: 0, full: 0, space: 0, fail: 0 }
      /**
       * 【10-19 13:55 顺手防一个老毛病】加十几个文件要好几秒 —— 面板上如果一直没动静,
       * boss看到的就是「点了没反应」,之前报过好几次这类事。所以过程中报进度。
       */
      let done = 0
      soundNote = `正在添加 0/${picked.length}…`
      soundNoteIsError = false
      notify()
      for (const file of picked) {
        const code = await importSound(file, true)
        if (code in tally) tally[code] += 1
        done += 1
        soundNote = `正在添加 ${done}/${picked.length}…`
        notify()
      }
      const failed = picked.length - tally.added
      if (failed === 0) {
        const caps = soundCaps()
        soundNote =
          `已添加 ${tally.added} 个 · 现在 ${soundList.length}/${caps.maxCount} 条` +
          `、已用 ${(soundUsedBytes() / 1024 / 1024).toFixed(1)}MB/${Math.round(caps.totalBytes / 1024 / 1024)}MB`
        soundNoteIsError = false
      } else {
        const why = []
        if (tally.bad) why.push(`格式不对 ${tally.bad} 个`)
        if (tally.big) why.push(`超 ${Math.round(soundCaps().maxBytes / 1024 / 1024)}MB ${tally.big} 个`)
        if (tally.full) why.push(`条数满了 ${tally.full} 个`)
        if (tally.space) why.push(`总量放不下 ${tally.space} 个`)
        if (tally.fail) why.push(`主机端没收 ${tally.fail} 个`)
        soundNote = `加进去 ${tally.added} 个,没进去 ${failed} 个（${why.join('、')}）`
        soundNoteIsError = true
      }
      notify()
    }

    async function removeSound(id) {
      if (!id) return
      try {
        const result = await postJson(SOUNDS_PATH, { method: 'remove', id })
        if (Array.isArray(result?.list)) soundList = result.list
        if (result?.usage) soundUsage = result.usage
        else soundUsage = null // 老版本主机端不回 usage → 退回自己按列表算
        // 删的正是当前选中的那个 → 退回内置音效
        if (state.soundId === id) {
          state = normalizeState({ ...state, soundId: '' })
          await saveState({ soundId: '' })
        }
        notify()
      } catch {
        /* 删不掉就算了 */
      }
    }

    async function selectSound(id) {
      state = normalizeState({ ...state, soundId: id || '' })
      notify()
      await saveState({ soundId: state.soundId })
    }

    /** 每秒问一次主机「有没有任务刚完成」。开销可以忽略。*/
    let lastBellSeen = 0
    /**
     * 【10-19 19:5x boss「我开了也试听了，但是还是没用」的真凶】
     *
     * boss重启后开了开关、点了试听、跑了个任务 —— 一声没响。
     * 查出问题在这一句：`if (lastBellSeen !== 0 && state.soundOn)`。
     *
     * 【为什么】主机端刚起来时 at=0，页面前几轮问到的都是 0，`at > 0` 不成立，
     * 所以 **lastBellSeen 一直是 0**（"我还没见过任何时间戳"）。
     * 等第一个任务真的完成、主机把 at 写成 T 之后，这一轮命中的是
     * 「lastBellSeen !== 0」这个"第一次别响"的判断 —— 于是**第一个完成被吞了**。
     * 也就是说：每次重启后跑的第一个任务，永远不响；第二个才开始响。
     * boss刚好只试了第一个，所以看着像"开关根本没接上"。
     *
     * 【为什么当初会写成这样】本意是「主机端可能留着插件启动之前那次完成的旧时间戳，
     * 别一启动就补响一声」。可主机端**每次跟应用一起重启、at 从 0 开始**，
     * 根本没有旧时间戳 —— 拿「值是不是 0」当「见没见过」用，判断对象搞错了。
     *
     * 【现在】用一枚专门的标志记「基线取过没有」：第一次问到的值（哪怕是 0）
     * 就是基线，之后**只要变了就响**，不管中间隔了多久、是不是第一次变化。
     */
    let bellSeenOnce = false
    let bellTimer = null
    function startBellWatch() {
      if (bellTimer !== null) return
      const tick = async () => {
        try {
          const result = await getJson(BELL_PATH)
          const at = Number(result?.at) || 0
          if (!bellSeenOnce) {
            // 第一次问：把当前值当基线记下来，这一轮不响（避免插件刚挂上就补一声旧的）
            bellSeenOnce = true
            lastBellSeen = at
            return
          }
          if (at > 0 && at !== lastBellSeen) {
            lastBellSeen = at
            if (state.soundOn) {
              if (state.soundId) playCustomSound()
              else playChime(state.soundVolume)
            }
          }
        } catch {
          /* 问不到就算了（别把 bellSeenOnce 提前立起来，下一轮还能补上基线） */
        }
      }
      void tick()
      bellTimer = setInterval(tick, 1000)
    }

    /**
     * 恢复默认界面:撤掉背景图、撤掉所有颜色改动回到没装换肤时的样子。
     * 设置重置回默认值但不清空图库 ——图还在随时能再选一张
     */
    async function restoreDefaults() {
      // 悬浮球的位置留着:「恢复默认」是撤配色和壁纸,不是把boss拖好的球弹回角落
      // 【10-22 00:3x】`lastWallId` 也留着 —— 撤了壁纸之后，双击右键仍能切回刚才那张
      const keepWallId = state.activeId || state.lastWallId
      state = { activeId: '', wash: null, text: 'follow', mode: 'normal', rotateMinutes: 0, popupAlpha: POPUP_ALPHA_DEFAULT, ballX: state.ballX, ballY: state.ballY, bleed: 64, soundOn: state.soundOn, soundVolume: state.soundVolume, soundId: state.soundId, lang: state.lang, lastWallId: keepWallId }
      activeTone = null
      wallpaperCssText = ''
      syncBleedLayer(false)
      if (layerDispose) {
        try {
          layerDispose()
        } catch {
          /* 撤不掉也无所谓*/
        }
        layerDispose = null
      }
      lastImportNote = null
      notify()
      /**
       * 【10-22 01:1x 全功能自检抓出来的真 bug】
       *   这里原来落盘**没带 `lastWallId`** —— 客户端内存里保留了两张图，
       *   但服务端存档还是旧值 → 重启后双击右键切回去的不是"恢复前那张"。
       *   现在把 keepWallId 一起存。
       */
      await saveState({ activeId: '', wash: null, text: 'follow', mode: 'normal', rotateMinutes: 0, popupAlpha: POPUP_ALPHA_DEFAULT, lastWallId: keepWallId })
    }

    async function removeImage(id) {
      try {
        const result = await postJson(LIBRARY_PATH, { method: 'remove', id })
        library = Array.isArray(result?.list) ? result.list : []
      } catch {
        return
      }
      if (state.activeId === id) {
        state = { ...state, activeId: '' }
        void saveState({ activeId: '' })
      }
      notify()
      scheduleRotate()
      await refreshBackground()
    }

    /**
     * 【10-22 20:1x boss】图库里的「下一张」——**按图库排列顺序**走下一张。
     *
     * boss原话：「把这里的『换一张』变成『下一张』，意思是按照当前的图片排列，
     *           变换成下一张的壁纸，**因为下面已经有了『自定义随机换一张』**。」
     *
     * 为什么要改（这是根因，不是偏好）：
     *   原来这个按钮调的是 `pickRandomImageId()` —— **随机抽**（`Math.random`），
     *   跟下面「背景图片随机变换时间」是**同一套随机逻辑**（同一个函数）。
     *   两个入口干同一件事，随机模式下还经常"点了没变化"（抽到当前这张就再抽一次）。
     *   ⇒ 这个按钮改成**顺序走**：按图库里当前的排列位置，往后走一张；
     *     到最后一张就**回到第一张**（循环，不越界）。
     *
     * ⚠️ 顺序是**图库里 `library` 数组的顺序**（也就是下面那排缩略图从左到右的顺序），
     *    不是文件名排序 —— boss看到的排列就是判据。
     */
    function pickNextImageId() {
      if (library.length < 2) return null
      const at = library.findIndex((item) => item.id === state.activeId)
      // 当前那张不在图库里（被删了/换过了）→ 从第一张开始
      if (at < 0) return library[0]?.id ?? null
      return library[(at + 1) % library.length]?.id ?? null
    }

    // ── 背景图片随机变换 ─────────────────────────────────
    /**
     * 到点了自己抽一张换上。三个条件都得满足才行
     *   设了时间、库里至少两张、当前没在导图导图时换会把boss正在挑的图顶掉。
     * 抽到当前这张就再抽一次所以不会「到点没变化」。
     */
    function pickRandomImageId() {
      if (library.length < 2) return null
      const pool = state.activeId ? library.filter((item) => item.id !== state.activeId) : library
      if (pool.length === 0) return null
      const at = Math.floor(Math.random() * pool.length)
      return pool[at]?.id ?? null
    }

    let rotateTimer = null

    /** 按当前设置重排下一次轮换。设成0 或者只有一张图就清掉不空转。*/
    function scheduleRotate() {
      if (rotateTimer !== null) {
        clearTimeout(rotateTimer)
        rotateTimer = null
      }
      const minutes = normalizeRotate(state.rotateMinutes)
      if (minutes <= 0 || library.length < 2) return
      // setTimeout 上限约24.8 天boss的上限是 10 天这里不用分片
      rotateTimer = setTimeout(() => {
        rotateTimer = null
        if (!importing) {
          const next = pickRandomImageId()
          if (next) void selectImage(next)
        }
        scheduleRotate()
      }, minutes * 60 * 1000)
    }

    async function setRotateMinutes(value) {
      const minutes = normalizeRotate(value)
      state = normalizeState({ ...state, rotateMinutes: minutes })
      if (minutes > 0) lastRotateMinutes = minutes
      notify()
      scheduleRotate()
      await saveState({ rotateMinutes: minutes })
    }

    // 【10-18 19:10 boss:「双击悬浮窗自动换肤;已经是自动换肤状态就双击关掉」】
    // 记住上次用的间隔,双击重新打开时还用它,不给boss换一套没听过的数字。
    // 默认给 5 分钟 —— 1 分钟太勤,boss之前抱怨过"换得勤"。
    let lastRotateMinutes = 5
    async function toggleAutoRotate() {
      const dict = dictFor()
      if (library.length < 2) return { ok: false, text: dict.rotateNeedMore }
      if (state.rotateMinutes > 0) {
        await setRotateMinutes(0)
        return { ok: true, text: dict.rotateOff }
      }
      const minutes = ROTATE_PRESETS.includes(lastRotateMinutes) ? lastRotateMinutes : 5
      await setRotateMinutes(minutes)
      return { ok: true, text: dict.rotateMinutes.replace('{n}', String(minutes)) }
    }

    // ── 共用控件(浮窗和设置页同一套 ───────────────────────
    /**
     * 语言开关上那三个词 —— **故意不进 DICTS**：
     * 它们是「中英双语」的招牌，切到英文时也得写着中文，切回中文时也得写着英文。
     * 放进 DICTS 就会被语言切换带着一起翻，反而看不懂了。
     */
    const LANG_TEXT = { label: '语言 / Language', zh: '中文 / Chinese', en: 'English / 英文' }

    function buttonStyle(danger) {
      return {
        padding: '7px 12px',
        fontSize: 12,
        cursor: 'pointer',
        borderRadius: 8,
        border: `1px solid ${danger ? T.danger : T.borderStrong}`,
        background: T.button,
        color: danger ? T.danger : T.primary,
      }
    }

    /* ═══ 面板美化的共用样式（2026-10-22 16:4x boss）════════════════
     *
     * boss：「对悬浮窗展开的选项做一个相关的界面美化，并且自检通过。
     *        要求不伤现在的核心功能。」
     *
     * ## 做法：加一层**共用样式**，不去改每个控件的逻辑
     *   这一组常量只管**长什么样**（间距、圆角、字重、分隔线、底色），
     *   **不碰任何 onClick / 状态 / 存盘逻辑** ——
     *   改完跑全量回归，任何一项不过就回滚。
     *
     * ## 为什么要集中在一处
     *   之前每一段都是**手写内联样式**，同样的东西抄了七八遍
     *   （`marginBottom: 18`、`fontSize: 12`、按钮圆角…），
     *   结果是「改一处要改八处」，很容易漏、也很容易改串。
     *   收进这一组之后，**面板整体的样子只由这一处决定**。
     *
     * ## 视觉上改了什么（boss能看出来的四点）
     *   ① 每一段前面加一根**短竖条 + 加粗标题**（原来只有一行灰字，容易滑过去）
     *   ② 段与段之间加**分隔线**，改成一个一个的组（原来是一长条黏在一起）
     *   ③ 分段控件（模式/时长/提示音）改成**带底槽的胶囊**，选中项浮起来
     *   ④ 说明文字的**行高**放宽（原来挤在一起，小字看着费劲）
     */
    const PANEL_UI = {
      // 段与段之间：上边距 + 一条分隔线
      sectionGap: { marginTop: 18, paddingTop: 16, borderTop: `1px solid ${T.border}` },
      // 段标题：短竖条 + 加粗
      titleRow: { display: 'flex', alignItems: 'center', gap: 6, marginBottom: 10 },
      titleMark: { width: 3, height: 12, borderRadius: 2, background: T.accent, flex: '0 0 auto' },
      titleText: { fontSize: 12, fontWeight: 600, color: T.primary, letterSpacing: '0.2px' },
      // 说明小字：行高放宽
      hint: { marginTop: 8, fontSize: 11, lineHeight: 1.6, color: T.secondary },
      // 胶囊底槽（分段控件的外框）
      segmentTrack: {
        display: 'flex',
        gap: 6,
        padding: 4,
        borderRadius: 12,
        background: T.button,
      },
      // 胶囊里的一项（选中的在下面单独处理）
      segmentItem: {
        flex: 1,
        padding: '7px 8px',
        fontSize: 12,
        cursor: 'pointer',
        borderRadius: 9,
        border: '1px solid transparent',
        background: 'transparent',
        color: T.secondary,
        fontWeight: 400,
      },
      // 选中的那项：浮起来（白底 + 边框 + 深字）
      segmentItemOn: {
        flex: 1,
        padding: '7px 8px',
        fontSize: 12,
        cursor: 'pointer',
        borderRadius: 9,
        border: `1px solid ${T.borderStrong}`,
        background: T.surface,
        color: T.primary,
        fontWeight: 600,
      },
      // 普通按钮：圆角大一档
      button: { padding: '9px 12px', fontSize: 12, borderRadius: 10 },
      // 次要按钮（"检查更新"那种）：用强调色
      buttonAccent: {
        padding: '9px 14px',
        fontSize: 12,
        borderRadius: 10,
        border: `1px solid ${T.accent}`,
        background: 'transparent',
        color: T.accent,
        cursor: 'pointer',
      },
    }

    /** 一段的标题（小竖条 + 文字） */
    function panelTitle(text) {
      return h(
        'div',
        { style: PANEL_UI.titleRow },
        h('span', { style: PANEL_UI.titleMark, 'aria-hidden': 'true' }),
        h('span', { style: PANEL_UI.titleText }, text),
      )
    }

    /** 一段下面那行说明小字 */
    function panelHint(text) {
      return h('div', { style: PANEL_UI.hint }, text)
    }

    /* ── 更新提示（【10-22 08:0x boss选 B】）───────────────────
     *
     * boss问：「别人下载了 GitHub 上的插件，我们更新之后，他会收到升级的通知吗」
     * 查完：不会（插件没自查、GitHub 不通知下载者、DSH 的更新徽标只认它自己的市场目录）。
     * 所以插件自己查 —— 判据在主机端，页面只负责显示。
     *
     * ⚠️ 显示原则：**只有"确实有新版本"才显示**。
     *    查不到 / 没网 / 没配置 → 一个像素都不出现。更新提示是加分项，
     *    不该因为没网就在面板里挂个红字吓boss。
     */
    let updateInfoCache = { at: 0, data: null }

    async function loadUpdateInfo() {
      const now = Date.now()
      if (updateInfoCache.data !== null && now - updateInfoCache.at < 6 * 60 * 60 * 1000) return updateInfoCache.data
      try {
        const data = await getJson(UPDATE_CHECK_PATH)
        updateInfoCache = { at: now, data: data && typeof data === 'object' ? data : null }
      } catch {
        updateInfoCache = { at: now, data: null }
      }
      return updateInfoCache.data
    }

    /** 面板最上面那一行「有新版本 vX」——没有新版就返回 null */
    function UpdateNotice() {
      const dict = dictFor()
      const [info, setInfo] = useState(null)
      useEffect(() => {
        let alive = true
        void loadUpdateInfo().then((data) => {
          if (alive) setInfo(data)
        })
        return () => {
          alive = false
        }
      }, [])
      if (!info || info.ok !== true || info.outdated !== true || !info.latest) return null
      const url = String(info.pageUrl || '')
      return h(
        'section',
        null,
        h(
          'button',
          {
            type: 'button',
            // 点一下去仓库页（自己看版本说明、自己决定装不装），不在插件里偷偷下载
            onClick: () => {
              if (url !== '') window.open(url, '_blank')
            },
            style: { ...buttonStyle(false), width: '100%', padding: '9px 12px', fontSize: 12 },
          },
          `${dict.updateAvailable} v${info.latest}`,
        ),
      )
    }

    /**
     * 分段控件（模式 / 时长 / 提示音开关都用它）。
     *
     * 【2026-10-22 16:4x boss要求界面美化】这里只改**长什么样**：
     *   原来是四个各自独立的描边按钮并排放，选中项用描边+强调色区分；
     *   现在是**带底槽的胶囊**：外框一个浅底槽，每项在槽里，选中的那项浮起来
     *   （白底 + 细边框 + 深字），未选中的是透明底灰字。
     *
     * ⚠️ **逻辑一个字没改**：onClick、disabled、aria-pressed 全是原来的。
     *    「不伤核心功能」靠这个 —— 改完必须跑全量回归。
     */
    function segment(text, active, onClick, disabled) {      return h(
        'button',
        {
          type: 'button',
          onClick: disabled ? undefined : onClick,
          disabled: Boolean(disabled),
          'aria-pressed': active,
          style: {
            ...(active ? PANEL_UI.segmentItemOn : PANEL_UI.segmentItem),
            cursor: disabled ? 'default' : 'pointer',
            opacity: disabled ? 0.6 : 1,
          },
        },
        text,
      )
    }

    /**
     * 图库条只画「真正滚到眼前」的那几张。
     *
     * 为什么这么做:库里 1300+ 张图,以前一次性全画出来每换一张图就要重
     * 1300 个缩略图重画一遍——换图要等十几秒。分页一次60 张也不糊
     * boss要的是「选中的时候才渲染」。
     *
     * 这里的做法横着排一条每个格子固定 84px 宽滚动时用 IntersectionObserver
     * 看哪些格子进了可视区,只给这些格子真的去加载图片其余保持空白占位。
     * 128 个格子= 一整屏最多也就十几个在眼前所以永远只加载十几个。
     */
    function GalleryStrip({ items, activeId, onPick, onReachEnd }) {
      const scrollerRef = useRef(null)
      const [visible, setVisible] = useState(() => new Set())

      useEffect(() => {
        const scroller = scrollerRef.current
        if (!scroller || typeof IntersectionObserver === 'undefined') return undefined
        const observer = new IntersectionObserver(
          (entries) => {
            setVisible((prev) => {
              let next = null
              for (const entry of entries) {
                const index = Number(entry.target.dataset.index)
                const isVisible = entry.isIntersecting
                if (prev.has(index) === isVisible) continue
                if (!next) next = new Set(prev)
                if (isVisible) next.add(index)
                else next.delete(index)
              }
              return next || prev
            })
          },
          { root: scroller, rootMargin: '200px' },
        )
        const cells = scroller.querySelectorAll('[data-index]')
        cells.forEach((cell) => observer.observe(cell))
        return () => observer.disconnect()
      }, [items.length])

      // 选中的那张永远要看得见:打开面板就滚到它那儿
      // 【10-18 19:15】原来用 scrollIntoView,它会连外层面板一起滚 ——
      // boss一打开面板整块内容就跳一下。现在改成只动图库自己那个滚动框。
      // 【10-18 22:05】连着补了两个洞:
      //   ① 滚动框自己设成定位祖先(offsetTop 才有正确基准,见下面 style)
      //   ② 刚打开那一帧格子可能还没排完版,60ms 后再定一次位置
      useEffect(() => {
        const scroller = scrollerRef.current
        if (!scroller || !activeId) return undefined
        const jump = () => {
          const index = items.findIndex((item) => item.id === activeId)
          if (index < 0) return
          const target = scroller.querySelector(`[data-index="${index}"]`)
          if (!target) return
          const want = target.offsetTop - (scroller.clientHeight - target.offsetHeight) / 2
          scroller.scrollTop = Math.max(0, want)
        }
        jump()
        const timer = setTimeout(jump, 60)
        return () => clearTimeout(timer)
      }, [activeId, items.length])

      return h(
        'div',
        {
          ref: scrollerRef,
          onScroll: (event) => {
            // 滚到离底 400px 就自动再放一批进来boss不用一直点「加载更多」
            if (typeof onReachEnd !== 'function') return
            const node = event.currentTarget
            if (node.scrollTop + node.clientHeight + 400 >= node.scrollHeight) onReachEnd()
          },
          style: {
            display: 'grid',
            gridTemplateColumns: 'repeat(4, 1fr)',
            gap: 8,
            overflowX: 'hidden',
            overflowY: 'auto',
            maxHeight: 340,
            paddingRight: 4,
            /**
             * 【10-18 22:05 修第二个坑】offsetTop 是相对**定位祖先**算的,
             * 这个滚动框自己没设 position,所以格子的 offsetTop 参照的是外面某一层,
             * 拿它算出来的 scrollTop 是个错数 —— 定位到当前图这件事等于没生效。
             * 自己变成定位祖先,offsetTop 才是从这个框的顶边起算。
             */
            position: 'relative',
          },
        },
        items.map((item, index) => {
          const isActive = item.id === activeId
          const shouldLoad = visible.has(index) || isActive
          return h(
            'button',
            {
              key: item.id,
              // data-index 是观察器挂钩用的;观察器靠它认格子
              'data-index': index,
              type: 'button',
              onClick: () => onPick(item.id),
              title: item.name,
              'aria-pressed': isActive,
              style: {
                width: '100%',
                height: 90,
                padding: 0,
                borderRadius: 8,
                overflow: 'hidden',
                cursor: 'pointer',
                border: `2px solid ${isActive ? T.accent : T.borderStrong}`,
                background: T.raised,
                position: 'relative',
              },
            },
            // 没进可视区就什么都不画 — 这就是「选中的时候才渲染」
            shouldLoad
              ? h('img', {
                  src: imageUrl(item.id, true),
                  alt: '',
                  loading: 'lazy',
                  decoding: 'async',
                  style: { width: '100%', height: '100%', objectFit: 'cover', display: 'block' },
                })
              : null,
            // 【10-18 19:15 boss:「选项出来的图片应该默认选中当前背景的这张」】
            // 光靠一圈描边不够显眼,当前这张再打个勾,一眼就认得出是哪张。
            isActive
              ? h('div', {
                  style: {
                    position: 'absolute',
                    right: 4,
                    top: 4,
                    width: 18,
                    height: 18,
                    borderRadius: '50%',
                    background: T.accent,
                    color: '#ffffff',
                    fontSize: 12,
                    lineHeight: '18px',
                    textAlign: 'center',
                    fontWeight: 700,
                    pointerEvents: 'none',
                  },
                },
                '✓',
              )
              : null,
          )
        }),
      )
    }

    function SkinControls({ compact, onOpenUpdate }) {
      useSkin()
      const dict = dictFor()
      const entry = currentEntry()
      const fileRef = useRef(null)
      const folderRef = useRef(null)
      const soundFileRef = useRef(null)
      const [shown, setShown] = useState(PAGE_SIZE)

      // 「背景图片随机变换时间」预设以外的算自定义面板要多给一个输入框出来
      const [customMode, setCustomMode] = useState(
        () => state.rotateMinutes > 0 && !ROTATE_PRESETS.includes(state.rotateMinutes),
      )
      const [rotateInput, setRotateInput] = useState('')
      const customRotate = customMode

      const commitRotate = () => {
        const minutes = normalizeRotate(Number(rotateInput))
        if (minutes <= 0) return
        setCustomMode(true)
        setRotateInput('')
        void setRotateMinutes(minutes)
      }

      // 选中的那张在很后面的话把分页撑到包含它,不然打开面板看不到当前用的图
      useEffect(() => {
        if (!state.activeId) return
        const at = library.findIndex((item) => item.id === state.activeId)
        if (at < 0) return
        const need = Math.ceil((at + 1) / PAGE_SIZE) * PAGE_SIZE
        setShown((n) => (need > n ? need : n))
      }, [state.activeId, library.length])

      /**
       * ═══ 新手引导（boss 10-19 21:4x：「针对第一次安装插件的人，就跳出引导来指导他」）═══
       *
       * 判断只看**设置读回来了没有** + 存档里的 onboarded：
       *   · 设置还没读回来 → 什么都不做（不然老用户也会被弹一次）
       *   · 读回来了、onboarded 不是 true → 这是第一次装 → **把面板自己弹出来**，
       *     并让引导卡显示出来（SkinControls 里那段）
       *   · 已经 onboarded → 不打扰
       * 看过一次就落盘记住，「知道了」不再自己跳；想再看点面板上的「新手指引」。
       */
      useEffect(() => {
        if (!stateReady || guideSeen) return
        guideSeen = true
        if (state.onboarded === true) return
        guideOpen = true
        notify()
        const timer = setTimeout(() => setOpen(true), 1200) // 等球先出现，再弹面板
        return () => clearTimeout(timer)
      }, [stateReady, state.onboarded, guideSeen])

      // 文件夹选择:webkitdirectory 是浏览器私有属性得用 ref 挂
      const mountFolderInput = (node) => {
        if (!node || folderRef.current === node) return
        folderRef.current = node
        node.webkitdirectory = true
        node.directory = true
      }

      const onFiles = (event) => {
        const files = Array.from(event.target.files || [])
        event.target.value = ''
        void importFiles(files)
      }

      /**
       * 自定义音效:一次只收一个(提示音就一个,不用批量)。
       * 选完立刻清掉 value —— 不然同一个文件选第二次不触发 onChange,
       * boss会以为点了没反应。
       */
      const onSoundFiles = (event) => {
        /**
         * 【10-19 13:55 改批量】原来只取 files[0] ——
         * boss一次框选多个,后面的全被静默丢掉。现在整批交给 importSounds。
         */
        const picked = Array.from(event.target.files || [])
        event.target.value = ''
        void importSounds(picked)
      }

      const wash = Math.round(effectiveWash(entry))
      // 这张图的自动底线 —— 滑杆拖不下去的那条线(见 autoFloorPct)
      const floorPct = entry ? autoFloorPct(entry, activeScheme()) : 0
      const locked = washLocked()
      const kindText = !entry ? '' : entry.kind === 'dark' ? dict.kindDark : dict.kindLight

      /**
       * 图库分页:库里 1387 张一次全画出来就是1387 个格个
       * 每换一张图整个面板重画一遍——这就是「换一张要十几秒」的真正原因。
       * 现在只画前shown 张滚到底或者点按钮再往下放一批。
       *
       * 【10-18 22:05 boss报的第一条,真 bug】boss当前选的那张可能排在几百名开外,
       * 而分页一次只画 60 张 —— 当前图压根没被画出来,
       * 面板打开自然「回不到」那张(boss 19:15 提过一次,只修了滚动,没修这个)。
       * 现在不管 shown 是多少,当前图一定在这批里,而且顺序跟图库一致,
       * 滚动定位才找得到正确的下标。
       */
      const page = useMemo(() => {
        const slice = library.slice(0, shown)
        const at = library.findIndex((item) => item.id === state.activeId)
        if (at >= slice.length) slice.push(...library.slice(slice.length, at + 1))
        return slice
      }, [library, shown, state.activeId])
      const more = Math.min(PAGE_SIZE, Math.max(0, library.length - shown))
      const showMore = () => setShown((n) => Math.min(library.length, n + PAGE_SIZE))

      return h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: 16 } },

        /**
         * ═══ 语言 / Language —— 放在整列最顶上（boss 10-19 21:1x）═══
         *
         * boss原话：「在悬浮球的选项里面，写一个中英双语版，默认是中文，
         * 中英双语文字放在最置顶的位置，可以一键切换」
         *
         * 两个按钮都写着**中英两种字**（中文 / Chinese、English / 英文），
         * 所以不管当前是哪套语言，这两个按钮本身都看得懂 —— 不用先猜再点。
         * 一键切换、立刻重画、落盘记住；默认中文（state.lang 默认 'zh'）。
         */
        h(
          'section',
          { style: { marginBottom: 18 } },
          panelTitle(LANG_TEXT.label),
          h(
            'div',
            { style: PANEL_UI.segmentTrack },
            segment(LANG_TEXT.zh, state.lang !== 'en', () => void setLang('zh')),
            segment(LANG_TEXT.en, state.lang === 'en', () => void setLang('en')),
          ),
          /**
           * 「新手指引」按钮：引导卡收起来之后还能再叫出来（临时显示，不改落盘标记）。
           */
          h(
            'div',
            { style: { marginTop: 8, textAlign: 'right' } },
            h(
              'button',
              {
                type: 'button',
                onClick: () => {
                  guideOpen = !guideOpen
                  notify()
                },
                style: { ...buttonStyle(), padding: '4px 9px', fontSize: 11 },
              },
              guideOpen ? dict.close : dict.guideReopen,
            ),
          ),
        ),

        /**
         * ═══ 新手引导卡（第一次装的人打开面板第一眼看到的就是它）═══
         * 位置：语言开关下面、恢复默认上面 —— 语言必须最顶（boss 10-19 21:1x 定的），
         * 所以引导让一位；它是**可收起来的**，看过就不再自己跳。
         */
        guideOpen
          ? h(
              'section',
              {
                style: {
                  border: `1px solid ${T.accent}`,
                  borderRadius: 10,
                  padding: '10px 12px',
                  lineHeight: 1.9,
                  fontSize: 11,
                  color: T.primary,
                },
              },
              h('div', { style: { fontSize: 12, fontWeight: 600, marginBottom: 6 } }, dict.guideTitle),
              h('div', null, dict.guideStep1),
              h('div', null, dict.guideStep2),
              h('div', null, dict.guideStep3),
              h('div', null, dict.guideStep4),
              h('div', { style: { marginTop: 6, color: T.secondary } }, dict.guideMore),
              h(
                'button',
                {
                  type: 'button',
                  onClick: () => void dismissGuide(),
                  style: { ...buttonStyle(), width: '100%', marginTop: 8, padding: '7px 10px', fontSize: 12 },
                },
                dict.guideDismiss,
              ),
            )
          : null,

        /**
         * ═══ 「恢复默认界面」放到最上面（boss 10-19 18:29 提的）═══
         *
         * boss原话：「悬浮窗选项卡里面，恢复默认放在最上面」。
         * 原来这枚按钮吊在面板最底下（音效下面、读数上面），面板一打开
         * 得先滚到底才够得着 —— 现在挪到整列的第一个，开箱就在眼前。
         *
         * 【为什么敢放最上面】它本身带一句说明（dict.restoreHint 那行小字），
         * 点了也只是撤掉背景和颜色改动、随时能再挑一张图，不是不可逆操作。
         */
        h(
          'section',
          { style: { marginBottom: 18 } },
          // 【10-22 08:0x boss选 B】有新版本时，最上面多一行；没有就什么都不显示
          h(UpdateNotice),
          /**
           * 【10-22 08:2x boss】「在换肤悬浮窗上，左边是默认界面，右边是『检查更新』」
           *   —— 「恢复默认界面」在左，「检查更新」在右（同一行）。
           *   点「检查更新」**不直接更新**，而是弹出那个新窗口（更新 + 我的项目）。
           */
          h(
            'div',
            { style: { display: 'flex', gap: 8 } },
            h(
              'button',
              {
                type: 'button',
                onClick: () => restoreDefaults(),
                style: { ...buttonStyle(true), ...PANEL_UI.button, flex: '1 1 auto' },
              },
              dict.restore,
            ),
            onOpenUpdate
              ? h(
                  'button',
                  {
                    type: 'button',
                    onClick: onOpenUpdate,
                    style: { ...PANEL_UI.buttonAccent, flex: '0 0 auto' },
                  },
                  dict.updateWindowTitle,
                )
              : null,
          ),
          panelHint(dict.restoreHint),
        ),

        // 模式
        h(
          'section',
          { style: PANEL_UI.sectionGap },
          panelTitle(dict.mode),
          h(
            'div',
            { style: PANEL_UI.segmentTrack },
            segment(dict.modeNormal, state.mode === 'normal', () => setMode('normal')),
            segment(dict.modeFocus, state.mode === 'focus', () => setMode('focus')),
            segment(dict.modeLeisure, state.mode === 'leisure', () => setMode('leisure')),
          ),
          panelHint(
            state.mode === 'focus'
              ? dict.modeFocusHint
              : state.mode === 'leisure'
                ? dict.modeLeisureHint
                : dict.modeNormalHint,
          ),
        ),

        /**
         * ═══ 背景明度（遮罩深浅）滑杆 —— 10-19 18:5x boss要回来的 ═══
         *
         * boss原话:「你把图片背景的明度、透明度给删掉了,这个版本没有了。你应该加上去的,
         * 要不然我们『休闲』『专注』和『正常』这三个模式都用不了了。」
         *
         * 【为什么它跟模式是一回事】三个模式的定义就是「遮罩压在哪个档」：
         * 专注 = FOCUS_MASK(28%)、休闲 = LEISURE_MASK(3%)、正常 = 每张图自己的基准再手调。
         * 00:56 我把整栏删了、wash 写死 0，等于把模式的**语义**删了 ——
         * 点哪个模式屏幕上都一样。控件可以删，语义不能删。
         *
         * 【这次保留 00:56 那条意见的部分】
         *   · 不恢复「按图片自动」按钮（boss点名不要）；
         *   · 不恢复「遮罩 0 = 背景图最清楚,35 = …」那句长提示（同样点名不要）。
         *
         * 【10-19 20:2x boss：「为什么是从 9 开始的」】滑杆左端原来顶着「自动底线」，
         * 于是写着 0~40、实际从 9 拖起。现在左端就是 **0**，底线降级成下面那行小字提示。
         */
        h(
          'section',
          { style: PANEL_UI.sectionGap },
          panelTitle(dict.wash),
          h(
            'div',
            { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 } },
            h('span', { style: { fontSize: 12, fontWeight: 600, color: T.accent } },
              locked ? `${wash}%（${dict.washLocked}）` : `${wash}%`,
            ),
          ),
          h('input', {
            type: 'range',
            min: 0,
            max: MAX_WASH,
            step: 1,
            value: wash,
            disabled: locked,
            'aria-label': dict.wash,
            onChange: (event) => void setWash(clamp(Number(event.target.value), 0, MAX_WASH), false),
            onMouseUp: () => flushWash(),
            onTouchEnd: () => flushWash(),
            onBlur: () => flushWash(),
            style: { width: '100%', opacity: locked ? 0.5 : 1, cursor: locked ? 'not-allowed' : 'pointer' },
          }),
          panelHint(
            entry && floorPct > 0
              ? `${dict.washFloor.replace('{n}', String(floorPct))} · 0 = 背景图最清楚`
              : '0 = 背景图最清楚,数值越大背景压得越实、字越清楚',
          ),
        ),

        // 图库
        h(
          'section',
          { style: PANEL_UI.sectionGap },
          h(
            'div',
            { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 } },
            panelTitle(dict.gallery),
            h(
              'span',
              { style: { fontSize: 11, color: T.secondary } },
              library.length > 0 ? dict.galleryCount.replace('{n}', String(library.length)) : '',
            ),
          ),
          // 【10-18 20:45 boss同意 A:手动换一张】→【10-22 20:1x 改成「下一张」】
          //   原来这里调 `pickRandomImageId()`（**随机**抽），跟下面「背景图片随机变换时间」
          //   是同一套随机逻辑 —— 两个入口干同一件事。boss明确要的是**按图库顺序走下一张**。
          //   随机那套还留在下面（自动轮换仍然随机，符合它的本意）。
          library.length > 1
            ? h(
                'button',
                {
                  type: 'button',
                  onClick: () => {
                    const next = pickNextImageId()
                    if (next) void selectImage(next)
                  },
                  style: { ...buttonStyle(), width: '100%', marginBottom: 8, fontSize: 12 },
                },
                dict.pickNext,
              )
            : null,
          library.length === 0
            ? h('div', { style: { fontSize: 12, color: T.secondary, lineHeight: 1.7 } }, dict.galleryEmpty)
            : h(GalleryStrip, {
                items: page,
                activeId: state.activeId,
                onPick: selectImage,
                onReachEnd: more > 0 ? showMore : undefined,
              }),
          more > 0
            ? h(
                'button',
                {
                  type: 'button',
                  onClick: showMore,
                  style: { ...buttonStyle(), width: '100%', marginTop: 8, fontSize: 11 },
                },
                dict.showMore.replace('{n}', String(more)),
              )
            : null,
          h(
            'div',
            { style: { display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' } },
            h('input', { ref: fileRef, type: 'file', accept: 'image/*', multiple: true, onChange: onFiles, style: { display: 'none' } }),
            h('input', { ref: mountFolderInput, type: 'file', accept: 'image/*', multiple: true, onChange: onFiles, style: { display: 'none' } }),
            h(
              'button',
              { type: 'button', onClick: () => fileRef.current && fileRef.current.click(), style: buttonStyle() },
              dict.pickFiles,
            ),
            h(
              'button',
              { type: 'button', onClick: () => folderRef.current && folderRef.current.click(), style: buttonStyle() },
              dict.pickFolder,
            ),
            entry
              ? h(
                  'button',
                  { type: 'button', onClick: () => removeImage(entry.id), style: buttonStyle(true) },
                  dict.deleteImage,
                )
              : null,
          ),
          importing
            ? h('div', { style: { marginTop: 8, fontSize: 11, color: T.secondary } }, dict.importing)
            : lastImportNote
              ? h(
                  'div',
                  { style: { marginTop: 8, fontSize: 11, color: T.secondary } },
                  (lastImportNote.added > 0 ? dict.imported.replace('{n}', String(lastImportNote.added)) : '') +
                    (lastImportNote.duplicate > 0
                      ? ' ' + dict.skipped.replace('{n}', String(lastImportNote.duplicate))
                      : ''),
                )
              : null,
        ),

        // 背景图片随机变换时间
        h(
          'section',
          { style: PANEL_UI.sectionGap },
          panelTitle(dict.rotate),
          h(
            'div',
            { style: { ...PANEL_UI.segmentTrack, flexWrap: 'wrap' } },
            segment(dict.rotateOff, state.rotateMinutes === 0, () => {
              setCustomMode(false)
              setRotateMinutes(0)
            }),
            ...ROTATE_PRESETS.map((minutes) =>
              segment(dict.rotateMinutes.replace('{n}', String(minutes)), !customRotate && state.rotateMinutes === minutes, () => {
                setCustomMode(false)
                setRotateMinutes(minutes)
              }),
            ),
            segment(dict.rotateCustom, customRotate, () => setCustomMode(true)),
          ),
          customRotate
            ? h(
                'div',
                { style: { display: 'flex', gap: 8, alignItems: 'center', marginTop: 8 } },
                h('input', {
                  type: 'number',
                  min: 1,
                  max: ROTATE_MAX,
                  step: 1,
                  value: rotateInput,
                  placeholder: '1',
                  onChange: (event) => setRotateInput(event.target.value),
                  onKeyDown: (event) => {
                    if (event.key === 'Enter') commitRotate()
                  },
                  onBlur: commitRotate,
                  style: {
                    width: 110,
                    padding: '6px 9px',
                    fontSize: 12,
                    borderRadius: 8,
                    border: `1px solid ${T.borderStrong}`,
                    background: T.raised,
                    color: T.primary,
                  },
                }),
                h(
                  'button',
                  { type: 'button', onClick: commitRotate, style: { ...buttonStyle(), fontSize: 12 } },
                  dict.rotateCustom,
                ),
              )
            : null,
          h(
            'div',
            { style: { marginTop: 6, fontSize: 11, color: T.secondary } },
            customRotate ? dict.rotateCustomHint : dict.rotateHint,
          ),
        ),

        // 竖图铺法
        entry && entry.portrait
          ? h(
              'section',
              { style: PANEL_UI.sectionGap },
              panelTitle(dict.portraitFill),
              h(
                'div',
                { style: { ...PANEL_UI.segmentTrack, flexWrap: 'wrap' } },
                // 居中排第一:它是竖图最合理的默认,也是boss要的那档
                // 「原图」排第一:竖图默认这档,按原图像素显示不放大
                segment(dict.fillNative, entry.fillMode === 'native', () => setFillMode('native')),
                segment(dict.fillCenter, entry.fillMode === 'center', () => setFillMode('center')),
                segment(dict.fillCover, entry.fillMode === 'cover', () => setFillMode('cover')),
                segment(dict.fillBlur, entry.fillMode === 'blur', () => setFillMode('blur')),
                segment(dict.fillRight, entry.fillMode === 'right', () => setFillMode('right')),
              ),
              panelHint(dict.portraitHint),
              /**
               * 【10-18 20:45 boss同意 D:竖图两侧那层模糊过渡做成可调的】
               * 只有竖图才有这层(横图是整屏铺满,压根没这一层),所以跟着竖图出来。
               * 拉到 0 = 干脆撤掉这层,两侧露干净的底色。
               */
              h(
                'div',
                { style: { marginTop: 14 } },
                h(
                  'div',
                  { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 } },
                  h('span', { style: { fontSize: 12, fontWeight: 600, color: T.primary } }, dict.bleedLabel),
                  h('span', { style: { fontSize: 12, fontWeight: 600, color: T.accent } }, state.bleed > 0 ? dict.bleedValue.replace('{n}', String(state.bleed)) : dict.bleedOff),
                ),
                h('input', {
                  type: 'range',
                  min: 0,
                  max: 64,
                  step: 4,
                  value: state.bleed,
                  onChange: (event) => setBleed(Number(event.target.value)),
                  style: { width: '100%' },
                }),
              ),
            )
          : null,

        /**
         * 【10-18 22:05 boss】「悬浮窗里就不要有选项了,直接删掉」
         * 文字颜色那一栏(深色文字/浅色文字两个按钮)整个删掉了 ——
         * 「你图片判断默认是深色字体,开进来就应该是深色字体;判断默认是浅色字体,起来就应该是浅色字体」。
         * 也就是说:判什么就显示什么,中间调那档按 21:30 定的标准交给主题,不再让boss手动拧。
         *
         * 后端对 state.text 的 'dark'/'light' 仍然认(老存档里可能存着手动值),
         * 只是界面上不再有入口 —— 换句话说从这一刻起字色只由图片明度决定。
         */

        /**
         * ═══ 提示音开关(boss 10-18 23:45 选 A)═══
         * 一栏:开关 + 音量 + 试听。默认关 —— 这版刚稳,先不吵boss。
         * 「试听」那一按同时把浏览器的发声授权拿到手,之后自动响才不会被拦。
         */
        h(
          'section',
          { style: PANEL_UI.sectionGap },
          panelTitle(dict.soundLabel),
          h(
            'div',
            { style: { display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' } },
            h(
              'div',
              { style: { ...PANEL_UI.segmentTrack, flex: '1 1 auto', minWidth: 160 } },
              segment(dict.soundOnLabel, state.soundOn === true, () => setSoundOn(true)),
              segment(dict.soundOffLabel, state.soundOn !== true, () => setSoundOn(false)),
            ),
            h(
              'button',
              {
                type: 'button',
                onClick: () => testChime(),
                style: { ...buttonStyle(), ...PANEL_UI.button, padding: '7px 14px', fontSize: 12 },
              },
              dict.soundTest,
            ),
          ),
          h(
            'div',
            { style: { marginTop: 12 } },
            h(
              'div',
              { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 } },
              h('span', { style: { fontSize: 12, fontWeight: 600, color: T.primary } }, dict.soundVolumeLabel),
              h('span', { style: { fontSize: 12, fontWeight: 600, color: T.accent } }, Math.round(state.soundVolume * 100) + '%'),
            ),
            h('input', {
              type: 'range',
              min: 0,
              max: 100,
              step: 5,
              value: Math.round(state.soundVolume * 100),
              onChange: (event) => setSoundVolume(Number(event.target.value) / 100),
              style: { width: '100%' },
            }),
          ),
          panelHint(dict.soundHint),
          /**
           * ═══ 自定义音效(boss 10-19 00:20:「你给一个添加的窗口」)═══
           * 「添加」按钮点下去弹一个本地选文件框 —— 这就是boss要的那个窗口。
           * 选中的音效列表列在下面,每条带「用这个 / 删掉」。
           * 空列表时显示一句提示,免得boss以为坏了。
           */
          h(
            'div',
            { style: { marginTop: 10 } },
            h('input', {
              ref: soundFileRef,
              type: 'file',
              accept: 'audio/*',
              /**
               * 【10-19 13:55】multiple 是批量添加的开关 —— 原来这里没有,
               * boss框选多个只能进去第一个。加上它,再配合 onSoundFiles 逐个上传。
               */
              multiple: true,
              onChange: onSoundFiles,
              style: { display: 'none' },
            }),
            h(
              'button',
              {
                type: 'button',
                onClick: () => soundFileRef.current && soundFileRef.current.click(),
                style: { ...buttonStyle(), padding: '5px 10px', fontSize: 11 },
              },
              dict.soundAdd,
            ),
            /**
             * 【10-19 01:00】添加失败时把那句明话显示在这儿。
             * boss报过「自定义音效用不了,添加不上去」—— 原因之一就是
             * 失败被静默吞了,面板上一点动静都没有,看着像点了没反应。
             * 【13:55 又补】批量添加之后这句要能显示「成功几个、失败几个」——
             * 成功时不再用红字(红字只留给真的没进去)。
             */
            soundNote
              ? h('div', { style: { marginTop: 8, fontSize: 11, color: soundNoteIsError ? T.danger : T.secondary } }, soundNote)
              : null,
            /**
             * 【10-19 13:55】容量那一行:已用 / 上限、条数 / 条数上限。
             * boss问过「总文件多大」—— 把这两个数直接摆在面板上,
             * 加了几个、还剩多少空间一眼就看得到,不用再来问。
             */
            h(
              'div',
              { style: { marginTop: 6, fontSize: 11, color: T.secondary } },
              dict.soundQuota
                .replace('{used}', (soundUsedBytes() / 1024 / 1024).toFixed(1))
                .replace('{total}', String(Math.round(soundCaps().totalBytes / 1024 / 1024)))
                .replace('{count}', String(soundList.length))
                .replace('{max}', String(soundCaps().maxCount))
                .replace('{perFile}', String(Math.round(soundCaps().maxBytes / 1024 / 1024))),
            ),
            h(
              'div',
              { style: { marginTop: 8, display: 'flex', flexDirection: 'column', gap: 6 } },
              soundList.length === 0
                ? h('div', { style: { fontSize: 11, color: T.secondary } }, dict.soundEmpty)
                : soundList.map((item) =>
                    h(
                      'div',
                      {
                        key: item.id,
                        style: {
                          display: 'flex',
                          alignItems: 'center',
                          gap: 8,
                          fontSize: 11,
                          padding: '5px 8px',
                          borderRadius: 8,
                          border: `1px solid ${state.soundId === item.id ? T.accent : T.borderStrong}`,
                          background: state.soundId === item.id ? T.raised : 'transparent',
                        },
                      },
                      h(
                        'button',
                        {
                          type: 'button',
                          onClick: () => selectSound(state.soundId === item.id ? '' : item.id),
                          style: {
                            flex: 1,
                            textAlign: 'left',
                            background: 'none',
                            border: 'none',
                            padding: 0,
                            fontSize: 11,
                            color: state.soundId === item.id ? T.accent : T.primary,
                            cursor: 'pointer',
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap',
                          },
                          title: item.name,
                        },
                        (state.soundId === item.id ? '✓ ' : '') + (item.name || item.id),
                      ),
                      h(
                        'button',
                        {
                          type: 'button',
                          onClick: () => removeSound(item.id),
                          style: {
                            background: 'none',
                            border: 'none',
                            padding: '0 2px',
                            fontSize: 11,
                            color: T.danger,
                            cursor: 'pointer',
                          },
                          title: dict.soundRemove,
                        },
                        '✕',
                      ),
                    ),
                  ),
            ),
          ),
        ),

        // 【10-19 18:29】「恢复默认界面」原来在这儿（面板最底下）——
        // boss要求挪到最上面，已经搬走了，见 SkinControls 开头那一段。
        // 这里只留一句注释，免得下一个人以为它丢了。

        // 这张图的读数
        h(
          'section',
          { style: { fontSize: 11, color: T.secondary, borderTop: `1px solid ${T.border}`, paddingTop: 10 } },
          entry
            ? h(
                'div',
                { style: { lineHeight: 1.8 } },
                `${dict.statusKind} ${kindText} · ${dict.statusBright} ${Math.round(entry.avgLum)}/255 · ${dict.statusAutoMask} ${autoFloorPct(entry, activeScheme())}%`,
                entry
                  ? h(
                      'button',
                      {
                        type: 'button',
                        onClick: () => removeImage(entry.id),
                        style: {
                          marginTop: 8,
                          ...buttonStyle(true),
                          padding: '5px 10px',
                          fontSize: 11,
                        },
                      },
                      dict.remove,
                    )
                  : null,
              )
            : h('div', null, dict.statusNone),
        ),
      )
    }

    // ── 彩蛋:渠道限流毛玻璃贴纸 ───────────────────────────
    /**
     * 【2026-10-20 boss】把「渠道限流」做成悬浮球旁边的一张毛玻璃贴纸。
     *
     * boss的三条硬要求（原话照抄）：
     *   1. 不写任何使用说明
     *   2. 不写任何引导文字
     *   3. 不做功能上的相关介绍
     *   —— **但有相关代码**
     * 所以这个组件**一个说明字都不往界面上放**：
     * 没有标题、没有「怎么用」、没有 tooltip、没有空状态文案。
     * 贴纸上只有数据本身。
     *
     * 交互（boss原话）：
     *   「单击悬浮窗 3 次让它浮现，再单击 3 次让它关闭；
     *     或者在右上角设置一个『叉』，点击即可关闭」
     *
     * 为什么数据不自己算：主机端已经把「还在限流 / 已到期」判好了
     * （判据是解禁时刻），页面只负责画 —— 两边各算一套必然对不上。
     */

    /**
     * ═══ 贴纸摆哪儿（纯函数，单独拎出来是为了能真跑一遍验证）═══
     *
     * 【2026-10-21 19:0x boss】三条要求（照抄原话）：
     *   1. 「贴纸离桌面悬浮图标太远了，基本上要靠得比较近」
     *   2. 「根据悬浮图标所处的桌面位置，贴纸可以自动切换位置，让它完整显现」
     *   3. 「千万不能超出屏幕」
     *
     * 上一版为什么不行（boss 10-21 截图就是那个样子）：
     *   ① 纵向摆法是「贴纸整块甩到球的上面 / 下面」——
     *      球在屏幕下沿时，贴纸被顶到屏幕最上角，离球十万八千里。
     *   ② 贴纸的宽高是**估的**（写死 300×300），真身可能更高，
     *      估小了就会顶出屏幕外。
     *
     * 现在的做法：
     *   - 优先**横着贴**：球的左边放不下就右边放，**纵向上跟球对齐**
     *     （不是整块甩到球上面去）→ 贴纸跟球之间只隔 12px。
     *   - 横着放不下才改成上下（这时才整块摆到球的上 / 下方）。
     *   - 宽高用**量出来的真实尺寸**（调用方先量贴纸自己），
     *     最后统一夹在屏幕内 —— 一定完整显示，绝不出界。
     *
     * @param ball  球在视口里的位置 {left,right,top,bottom,width,height}
     * @param box   贴纸自己的真实尺寸 {width,height}
     * @param view  视口 {width,height}
     */
    function placeSticker(ball, box, view) {
      const vw = Math.max(1, (view && view.width) || 0)
      const vh = Math.max(1, (view && view.height) || 0)
      const gap = 12 // 贴纸跟球之间留的空 —— boss要「靠得比较近」
      const margin = 10 // 贴纸离屏幕边至少留这么多
      // 贴纸的真实宽高（量出来的）；再兜一层：再大也不许超过屏幕
      const w = Math.min(Math.max(1, (box && box.width) || 300), Math.max(1, vw - margin * 2))
      const h = Math.min(Math.max(1, (box && box.height) || 120), Math.max(1, vh - margin * 2))
      const cx = ball.left + ball.width / 2
      const cy = ball.top + ball.height / 2
      // 四个候选：横着贴优先（0 左 / 1 右），上下兜底（2 上 / 3 下）
      const candidates = [
        { left: ball.left - gap - w, top: cy - h / 2 },
        { left: ball.right + gap, top: cy - h / 2 },
        { left: cx - w / 2, top: ball.top - gap - h },
        { left: cx - w / 2, top: ball.bottom + gap },
      ]
      // 球在右半 → 先往左摆；球在左半 → 先往右摆
      // 球在下半 → 先往上摆；球在上半 → 先往下摆
      const order = [
        cx > vw / 2 ? 0 : 1,
        cx > vw / 2 ? 1 : 0,
        cy > vh / 2 ? 2 : 3,
        cy > vh / 2 ? 3 : 2,
      ]
      const fits = (c) => c.left >= margin && c.left + w <= vw - margin && c.top >= margin && c.top + h <= vh - margin
      for (let i = 0; i < order.length; i += 1) {
        const c = candidates[order[i]]
        if (fits(c)) return { left: c.left, top: c.top, side: order[i] }
      }
      // 都放不下（屏幕太小）→ 夹在屏幕内：宁可离球远一点，也不能出界
      const c = candidates[order[0]]
      return {
        left: Math.max(margin, Math.min(c.left, Math.max(margin, vw - w - margin))),
        top: Math.max(margin, Math.min(c.top, Math.max(margin, vh - h - margin))),
        side: order[0],
      }
    }

    /**
     * ═══ 悬浮球的安全位置（纯函数，能真跑验证）═══
     *
     * 【10-22 01:1x 全功能自检抓出来的真 bug】
     *   boss在宽屏把球拖到右边，再把窗口拖窄 —— 球的 left 还是按宽屏算的旧值，
     *   **球就跑到屏幕外看不见了**，只能把窗口再拖回来找它。
     *   启动时会夹一次，但运行中窗口变了没人管。这个函数就是那一份夹紧逻辑，
     *   启动、窗口 resize 都用它，避免两处各写一套又漂。
     */
    function clampBallXY(x, y, vw, vh) {
      const size = 56 // 球是 56×56
      const nx = Number(x)
      const ny = Number(y)
      return {
        x: Math.max(0, Math.min(Number.isFinite(nx) ? nx : 0, Math.max(0, vw - size))),
        y: Math.max(0, Math.min(Number.isFinite(ny) ? ny : 0, Math.max(0, vh - size))),
      }
    }

    function ChannelLimitSticker({ visible, onClose, ballRect }) {
      const [items, setItems] = useState([])
      const [loaded, setLoaded] = useState(false)
      /**
       * 【10-21 22:2x boss】「有些模型已经报 429 错误或者接口不可用了，但贴纸里并没有记录」
       * → 表二：今天**真报过错 / 真用不了**的模型（判据在主机端，页面只画）。
       *   boss划了边界：「我们自己手动停用的不用写出来」——
       *   所以这张表里不会有"光被禁用、今天没调过"的模型。
       */
      const [unavailable, setUnavailable] = useState([])
      // 【10-20 22:3x boss】模型太多时只显示 10 条，剩下折叠起来
      const [expanded, setExpanded] = useState(false)
      // 【10-21 22:2x boss】表二（不可用）单独一套折叠计数
      const [unfolded, setUnfolded] = useState(false)
      // 【10-21 19:0x boss】贴纸要「靠得比较近」——
      //   做法：**先量自己，再摆自己**。量出来的真实宽高喂给 placeSticker 算坐标，
      //   免得内容一变高、或者球被拖到屏幕边上，贴纸就被顶出屏幕外。
      const boxRef = useRef(null)
      const [pos, setPos] = useState(null)
      // 视口尺寸：贴纸自己的宽高上限要跟着屏幕走（屏幕窄了贴纸也得窄）
      const [view, setView] = useState(() => ({
        width: (typeof window !== 'undefined' && window.innerWidth) || 0,
        height: (typeof window !== 'undefined' && window.innerHeight) || 0,
      }))

      /**
       * 【10-20 22:5x boss】「如果时间刷新到这里解禁了，它就不会在上面显示了，是吗」
       * → 是，而且要**到点就消失**，不能等下一次拉数据。
       *
       * 为什么要单独一个心跳：拉数据是每 30 秒一次（问主机端要台账快照），
       * 但「某条到点解禁」是**按分钟**甚至**按秒**发生的。
       * 只靠拉数据的话，最坏情况一条已经解禁 30 秒了还挂在那儿亮着红点。
       * 所以另加一个**每秒心跳**，只干一件事：到点就重画，让那行自己消失。
       * 它不请求任何东西，开销可以忽略。
       */
      const [nowTick, setNowTick] = useState(0)
      useEffect(() => {
        if (!visible) return undefined
        const timer = setInterval(() => setNowTick((n) => n + 1), 1000)
        return () => clearInterval(timer)
      }, [visible])

      useEffect(() => {
        if (!visible) {
          setLoaded(false)
          return undefined
        }
        let alive = true
        // 贴纸一开就去问一次；开着的时候每 30 秒再问一次（台账那边 15 分钟一刷新）
        const pull = async () => {
          try {
            const data = await getJson(CHANNEL_LIMITS_PATH)
            if (!alive) return
            const list = Array.isArray(data?.items) ? data.items : []
            setItems(list)
            /**
             * 【10-21 22:2x boss】表二：今天真报过错 / 用不了的模型。
             * 判据全在主机端（"今天真失败过"才算，光被禁用不算），页面只管画。
             */
            setUnavailable(Array.isArray(data?.unavailable) ? data.unavailable : [])
          } catch {
            if (!alive) return
            // 读不到就当没有 —— 贴纸空着，不报错、不挡界面
            setItems([])
            setUnavailable([])
          } finally {
            if (alive) setLoaded(true)
          }
        }
        void pull()
        const timer = setInterval(pull, 30000)
        return () => {
          alive = false
          clearInterval(timer)
        }
      }, [visible])

      // 视口变了就更新（贴纸的宽高上限跟着屏幕走，屏幕窄了贴纸也得窄）
      useEffect(() => {
        const onResize = () => setView({
          width: window.innerWidth || 0,
          height: window.innerHeight || 0,
        })
        window.addEventListener('resize', onResize)
        return () => window.removeEventListener('resize', onResize)
      }, [])

      /**
       * 【10-21 19:0x boss】贴纸摆哪儿 —— 三条要求一起满足：
       *   1. 「贴纸离桌面悬浮图标太远了，基本上要靠得比较近」
       *   2. 「根据悬浮图标所处的桌面位置，贴纸可以自动切换位置，让它完整显现」
       *   3. 「千万不能超出屏幕」
       *
       * 做法：量自己的真实宽高 → 交给 placeSticker 算坐标 → 摆过去。
       * 什么情况下要重摆：
       *   - 球被拖走了（ballRect 变了）
       *   - 窗口大小变了
       *   - 行数变了 / 展开了折叠（内容高度变了）
       *   - 某一行到点自己消失（高度变了）→ ResizeObserver 兜住
       */
      useEffect(() => {
        if (!visible || !ballRect) {
          setPos(null)
          return undefined
        }
        const place = () => {
          const node = boxRef.current
          if (!node) return
          const rect = node.getBoundingClientRect()
          const next = placeSticker(
            ballRect,
            { width: rect.width, height: rect.height },
            { width: window.innerWidth || 0, height: window.innerHeight || 0 },
          )
          setPos((was) => (was && was.left === next.left && was.top === next.top ? was : next))
        }
        place()
        window.addEventListener('resize', place)
        let ro = null
        if (typeof ResizeObserver !== 'undefined' && boxRef.current) {
          ro = new ResizeObserver(() => place())
          ro.observe(boxRef.current)
        }
        return () => {
          window.removeEventListener('resize', place)
          if (ro) ro.disconnect()
        }
      }, [visible, ballRect, expanded, items.length])

      if (!visible) return null

      /**
       * 【10-20 22:5x boss】「如果时间刷新到这里解禁了，它就不会在上面显示了，是吗」
       * → boss的预期是**到期就从贴纸上消失**。
       *
       * ⚠️ 上一版是「到期的还显示，只是变暗排到下面」—— 跟boss的预期不一致。
       *    现在改成：**只显示还在限流的**，到期的直接不出现。
       *    贴纸的意义是「现在有什么在挡路」，已经解禁的不该占位置。
       *
       * 这里自己按解禁时刻再判一次，不完全信主机端给的 `live`：
       * 主机端那一次判断是「请求到达那一刻」的，贴纸开着的时候时间会走，
       * 所以每 30 秒拉一次数据之外，**渲染时按当前时刻再判一次**，
       * 才不会出现「已经过了解禁时刻还亮着红点」。
       */
      const nowMs = Date.now()
      // nowTick 是那个每秒心跳的计数 —— 它一变就重画，
      // 于是「刚到解禁时刻」的那一行会在一秒内自己消失。
      // 这里显式引用它一下，免得它在下面被当成没用到的变量。
      void nowTick
      const live = items.filter((item) => Number(item.resetMs) > nowMs)
      // 【10-20 22:5x boss】超过 10 条就折叠，点「展开」看全部，「收起」收回来
      const COLLAPSED_COUNT = 10
      const canFold = live.length > COLLAPSED_COUNT
      const visibleRows = expanded || !canFold ? live : live.slice(0, COLLAPSED_COUNT)

      return h(
        'div',
        {
          ref: boxRef,
          style: {
            position: 'fixed',
            left: pos?.left ?? 0,
            top: pos?.top ?? 0,
            // 屏幕窄了贴纸也跟着窄,绝不出界。
            // ⚠️ 别写成 Math.min(300, Math.max(120, vw-20)) —— 下限 120 在极窄屏上
            //    反而比屏幕还宽,又会顶出界。这里**不设下限**,只跟屏幕走:
            //    屏幕多窄贴纸就多窄 —— boss要的是「千万不能超出屏幕」,
            //    窄到极端宁可变窄,也不许出界。
            width: Math.max(1, Math.min(300, (view.width || 300) - 20)),
            // 屏幕矮了贴纸也跟着矮(内容多的时候内部滚动)
            maxHeight: Math.max(1, Math.min(380, (view.height || 380) - 20)),
            overflowY: 'auto',
            padding: '14px 12px 12px',
            borderRadius: 16,
            // 毛玻璃:贴纸的质感靠这两行 —— 效果维持,不动。
            // 【10-20 22:3x boss】"透明度你得更清晰一点" ——
            //   上一版底色 0.42 太厚,毛玻璃被压成灰蒙蒙一块,字都发闷。
            //   现在底色更薄(0.26)、模糊更足(28px)、饱和更高(1.9)，
            //   透得出后面的东西,字才立得住。
            backdropFilter: 'blur(28px) saturate(1.9)',
            WebkitBackdropFilter: 'blur(28px) saturate(1.9)',
            // 【10-21 19:0x boss】「贴纸里面的文字采用黑色加亮加粗的形式显示（白色不太清楚）」
            //   根因:底色压得深、字是白的,浅色背景上白字糊成一片。
            //   改法:底色从「深色半透」翻成「浅色半透」,字改近黑加粗 —— 毛玻璃质感不动。
            background: 'rgba(255, 255, 255, 0.62)',
            border: '1px solid rgba(255, 255, 255, 0.75)',
            boxShadow: '0 10px 40px rgba(0, 0, 0, 0.22)',
            color: '#12151b',
            // 位置还没算出来之前先藏着,别在屏幕左上角闪一下
            visibility: pos ? 'visible' : 'hidden',
            pointerEvents: 'auto',
            zIndex: 2147483001,
          },
        },
        // 右上角那个「叉」—— 点一下直接关。
        // 【10-20 22:3x boss】「应该是一个红框里面带一个黑色的叉，
        //   或者红框里面带一个白色的叉，这样看得清楚一点。」
        //   选红框 + 黑叉：红是唯一在整块灰玻璃上跳出来的颜色，一眼就找得到。
        h(
          'button',
          {
            type: 'button',
            'aria-label': '×',
            onClick: onClose,
            style: {
              position: 'absolute',
              // 【10-21 19:0x boss】「红色的叉跟上面的表格表头重叠在一起了,这里要去区分一下」
              //   改法:叉缩到 22、挪到右上角、外面套一圈白环；
              //   表头那边再让出右侧 32px(见下面表头的 paddingRight)——
              //   两边都不动,「解禁」那列就不会再被压住。
              right: 8,
              top: 8,
              width: 22,
              height: 22,
              padding: 0,
              border: '2px solid #f43146',
              borderRadius: 11,
              background: '#f43146',
              color: '#14161a',
              fontSize: 14,
              fontWeight: 700,
              lineHeight: '16px',
              textAlign: 'center',
              cursor: 'pointer',
              // 白环:红叉压在浅玻璃上不再跟表头糊成一片
              boxShadow: '0 0 0 2px rgba(255, 255, 255, 0.92), 0 2px 8px rgba(0, 0, 0, 0.28)',
            },
          },
          '×',
        ),
        // 【10-20 22:5x boss】加一个表头。
        //   三列：渠道 / 模型 / 解禁。
        //   ⚠️ 表头也属于「数据的一部分」，不是使用说明 ——
        //   boss要的是「不写使用说明、不写引导文字」，
        //   而列名是让人看懂这一行在说什么用的，不写反而看不懂。
        h(
          'div',
          {
            style: {
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              padding: '0 0 6px',
              marginBottom: 2,
              fontSize: 11,
              // 【10-21 19:0x boss】表头文字也改黑、加粗
              fontWeight: 700,
              color: '#1b1f27',
              borderBottom: '1px solid rgba(18, 21, 27, 0.16)',
              // 跟下面每行的排版对齐：圆点 6 + 间距 8 → 文字从 14 开始
              paddingLeft: 14,
              // 【10-21 19:0x boss】「红色的叉跟上面的表格表头重叠在一起了」
              //   → 右侧让出 32px(叉在右上角占的就是这 32px),「解禁」那列不再被压住
              paddingRight: 32,
            },
          },
          h('span', { style: { flex: '0 0 auto', width: 96 } }, '渠道'),
          h('span', { style: { flex: '1 1 auto', minWidth: 0 } }, '模型'),
          h('span', { style: { flex: '0 0 auto' } }, '解禁'),
        ),
        // 一条都不剩（全都解禁了）→ 只留表头，不再列行
        visibleRows.length === 0
          ? null
          : visibleRows.map((item) =>
              h(
                'div',
                {
                  key: item.key,
                  style: {
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    padding: '5px 0',
                    fontSize: 12,
                    lineHeight: 1.5,
                    // 【10-21 19:0x boss】浅底色上,分隔线要跟着压深一点才看得出分行
                    borderBottom: '1px solid rgba(18, 21, 27, 0.12)',
                  },
                },
                // 限流中的红点
                h('span', {
                  style: {
                    width: 6,
                    height: 6,
                    borderRadius: 3,
                    flex: '0 0 auto',
                    background: '#f43146',
                    boxShadow: '0 0 6px rgba(244, 49, 70, 0.85)',
                  },
                }),
                h('span', { style: { flex: '0 0 auto', color: 'rgba(18, 21, 27, 0.72)', fontWeight: 600, maxWidth: 96, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, item.channel),
                // 【10-20 22:3x boss】「模型应该是有名称的」——
                //   显示主机端查到的**真名**（Qwen3.8-Flash · 免费 那种），
                //   不是台账里的内部代号（qfmodel）。
                //   主机端查不到时退回代号（那边已经兜好了），这里不猜。
                h('span', {
                  style: {
                    flex: '1 1 auto',
                    minWidth: 0,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                    // 【10-21 19:0x boss】文字改黑色加亮加粗
                    color: '#12151b',
                    fontWeight: 700,
                  },
                }, item.modelName || item.model),
                h('span', {
                  style: {
                    flex: '0 0 auto',
                    color: '#2a3038',
                    fontWeight: 600,
                    fontVariantNumeric: 'tabular-nums',
                    fontSize: 11,
                  },
                }, item.resetAt.slice(5, 16)),
              ),
            ),
        // 折叠/展开（boss：「剩下的走下拉框，用『展开』和『收起』来表示」）
        canFold
          ? h(
              'button',
              {
                type: 'button',
                onClick: () => setExpanded((was) => !was),
                style: {
                  display: 'block',
                  width: '100%',
                  marginTop: 8,
                  padding: '4px 0',
                  border: 'none',
                  background: 'transparent',
                  // 【10-21 19:0x boss】折叠按钮也跟着改成深色加粗
                  color: '#1b1f27',
                  fontWeight: 600,
                  fontSize: 12,
                  cursor: 'pointer',
                  textAlign: 'center',
                },
              },
              expanded ? '收起' : `展开（还有 ${live.length - COLLAPSED_COUNT} 条）`,
            )
          : null,
        // ═══ 表二：不可用（【10-21 22:2x boss】）═══════════════════
        // boss原话：「如果不是解禁的话，你就再起一个表头，写上『不可用』或者『禁用』」
        // 边界（boss亲口划的）：「我们自己手动停用的不用写出来」——
        //   所以这里只放**今天真报过错/真用不了**的，光被禁用、今天没调过的不出现。
        unavailable.length === 0
          ? null
          : h(
              'div',
              { style: { marginTop: 10, paddingTop: 8, borderTop: '1px solid rgba(18, 21, 27, 0.2)' } },
              h(
                'div',
                {
                  style: {
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    padding: '0 0 6px',
                    marginBottom: 2,
                    fontSize: 11,
                    fontWeight: 700,
                    color: '#1b1f27',
                    borderBottom: '1px solid rgba(18, 21, 27, 0.16)',
                    paddingLeft: 14,
                  },
                },
                h('span', { style: { flex: '0 0 auto', width: 96 } }, '渠道'),
                h('span', { style: { flex: '1 1 auto', minWidth: 0 } }, '模型'),
                h('span', { style: { flex: '0 0 auto' } }, '不可用'),
              ),
              (unfolded ? unavailable : unavailable.slice(0, COLLAPSED_COUNT)).map((row) =>
                h(
                  'div',
                  {
                    key: `u:${row.key}`,
                    style: {
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                      padding: '5px 0',
                      fontSize: 12,
                      lineHeight: 1.5,
                      borderBottom: '1px solid rgba(18, 21, 27, 0.12)',
                    },
                  },
                  // 红点 = 报错了没恢复；灰点 = 已经被禁用
                  h('span', {
                    style: {
                      width: 6,
                      height: 6,
                      borderRadius: 3,
                      flex: '0 0 auto',
                      background: row.disabled ? '#6b7280' : '#f43146',
                      boxShadow: row.disabled ? 'none' : '0 0 6px rgba(244, 49, 70, 0.85)',
                    },
                  }),
                  h('span', { style: { flex: '0 0 auto', color: 'rgba(18, 21, 27, 0.72)', fontWeight: 600, maxWidth: 96, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, row.channel),
                  h('span', { style: { flex: '1 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: '#12151b', fontWeight: 700 } }, row.modelName || row.model),
                  h('span', { style: { flex: '0 0 auto', maxWidth: 108, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: row.disabled ? '#4b5563' : '#a5212c', fontWeight: 600, fontSize: 11 } }, row.reason),
                ),
              ),
              unavailable.length > COLLAPSED_COUNT
                ? h(
                    'button',
                    {
                      type: 'button',
                      onClick: () => setUnfolded((was) => !was),
                      style: {
                        display: 'block',
                        width: '100%',
                        marginTop: 8,
                        padding: '4px 0',
                        border: 'none',
                        background: 'transparent',
                        color: '#1b1f27',
                        fontWeight: 600,
                        fontSize: 12,
                        cursor: 'pointer',
                        textAlign: 'center',
                      },
                    },
                    unfolded ? '收起' : `展开（还有 ${unavailable.length - COLLAPSED_COUNT} 条）`,
                  )
                : null,
            ),
      )
    }

    // ── 入口一:右下角可拖动圆钮 ───────────────────────────
    function Launcher() {
      const dict = dictFor()
      // 【boss 10-18 15:07 第一个问题】壁纸是这个组件渲染的,但原来没订阅换肤状态。
      // 选图后 refreshBackground() 已经把新壁纸算好了、也 notify 了,
      // 可这个组件没订阅,所以不重画 —— 屏幕上还是旧图。
      // 关掉面板之所以会换,是因为 setOpen 触发了重渲染,壁纸顺带刷出来。
      useSkin()
      const [open, setOpen] = useState(false)
      const [offset, setOffset] = useState(null)
      const [dragging, setDragging] = useState(false)
      const [place, setPlace] = useState(null)
      const [hot, setHot] = useState(false)
      const [hintBelow, setHintBelow] = useState(true)
      // 【10-20 22:1x 彩蛋】渠道限流贴纸:单击三次浮现,再单击三次收起。
      // 界面上不写任何说明字(boss要求),只有这张贴纸本身。
      const [stickerOpen, setStickerOpen] = useState(false)
      // 【10-22 08:2x boss】点「检查更新」弹出的那个新窗口（更新 + 我的项目）
      const [updateWindowOpen, setUpdateWindowOpen] = useState(false)
      const unitRef = useRef(null)
      const dragRef = useRef(null)
      const movedRef = useRef(false)

      // 【10-18 20:45 boss同意 B:悬浮球拖到哪就记住哪】
      // 原来只在内存里,重开桌面端就弹回右下角。
      // 启动时从存档里读,顺手按当前窗口大小夹一下 —— boss上次在 4K 上拖的位置,
      // 换到 1080p 的机器上打开,不能把球夹到屏幕外找不着。
      //
      // 【10-19 07:30】贴着底边存下来的旧位置一律作废 —— 那批值是
      // 「right:24/bottom:24」那个默认位留下的,正好挡输入框的发送键。
      // 作废之后走新的「贴输入框上沿」逻辑。
      useEffect(() => {
        const vh = window.innerHeight || 0
        const vw = window.innerWidth || 0
        if (state.ballX === null || state.ballY === null) return
        const y = clamp(state.ballY, 0, Math.max(0, vh - 56))
        // 底边 40px 以内算「贴着底」—— 旧默认位或者boss拖到底的位置,都不要
        const stuckToBottom = y > vh - 56 - 40
        setOffset(stuckToBottom
          ? null
          : {
              x: clamp(state.ballX, 0, Math.max(0, vw - 56)),
              y,
            })
      }, [])

      /**
       * 【10-22 01:1x 全功能自检抓出来的真 bug】窗口变小之后球会跑出屏幕。
       *
       * 病根：上面那段只在**启动时**夹一次。boss在宽屏把球拖到右边 → 把窗口拖窄，
       *       球的 `left` 还是按宽屏算的旧值 → 球看不见了（要拖窗口才能找回来）。
       * 修法：窗口一变就按新尺寸重新夹。用纯函数 `clampBallXY` 做，能真跑验证。
       */
      useEffect(() => {
        const onResize = () => {
          const vw = window.innerWidth || 0
          const vh = window.innerHeight || 0
          setOffset((at) => {
            if (!at) return at
            const next = clampBallXY(at.x, at.y, vw, vh)
            return next.x === at.x && next.y === at.y ? at : next
          })
        }
        window.addEventListener('resize', onResize)
        return () => window.removeEventListener('resize', onResize)
      }, [])

      useEffect(() => {
        if (!dragging) return undefined
        const move = (event) => {
          const drag = dragRef.current
          if (!drag) return
          if (Math.abs(event.clientX - drag.startX) > 3 || Math.abs(event.clientY - drag.startY) > 3) {
            movedRef.current = true
          }
          setOffset({
            x: clamp(drag.baseX + event.clientX - drag.startX, 0, window.innerWidth - 56),
            // 【10-19 07:30】拖的时候也不许压到输入框:下限同样抬到输入框上沿之上
            y: clamp(drag.baseY + event.clientY - drag.startY, 0, window.innerHeight - 56),
          })
        }
        const up = () => {
          dragRef.current = null
          setDragging(false)
          // 松手才存:拖的过程里每动一下写一次盘太浪费
          if (!movedRef.current) return
          setOffset((at) => {
            if (!at) return at
            const vh = window.innerHeight || 0
            // 松手时还在挡输入框 → 抬回去,并且不存这个位置
            if (vh > 0 && at.y > vh - 56 - 40) {
              return { ...at, y: Math.max(80, vh - 176) }
            }
            void saveState({ ballX: at.x, ballY: at.y })
            return at
          })
        }
        window.addEventListener('mousemove', move)
        window.addEventListener('mouseup', up)
        return () => {
          window.removeEventListener('mousemove', move)
          window.removeEventListener('mouseup', up)
        }
      }, [dragging])

      useEffect(() => {
        if (!open) return undefined
        // 面板一开就把自定义音效拉过来,列出来给boss选
        void loadSoundList()
        const onDown = (event) => {
          const node = unitRef.current
          if (node && node.contains(event.target)) return
          setOpen(false)
        }
        const onKey = (event) => {
          if (event.key === 'Escape') setOpen(false)
        }
        document.addEventListener('mousedown', onDown)
        document.addEventListener('keydown', onKey)
        return () => {
          document.removeEventListener('mousedown', onDown)
          document.removeEventListener('keydown', onKey)
        }
      }, [open])

      /**
       * 面板往哪边开,跟着三件事变:开没开、圆钮拖到哪了、屏幕尺寸变了。
       * 少一个都会出现「拖到边上不翻」或者「转屏后跑到屏幕外」。
       */
      useEffect(() => {
        if (!open) return undefined
        const measure = () => {
          const node = unitRef.current
          if (node) setPlace(computePanelPlacement(node.getBoundingClientRect()))
        }
        measure()
        window.addEventListener('resize', measure)
        return () => window.removeEventListener('resize', measure)
      }, [open, offset])

      // 窗口变了,竖图的合成结果要重算(去抖,免得拖窗口时一直在画
      useEffect(() => {
        let timer = null
        const onResize = () => {
          clearTimeout(timer)
          timer = setTimeout(() => refreshBackground(), 400)
        }
        window.addEventListener('resize', onResize)
        return () => {
          clearTimeout(timer)
          window.removeEventListener('resize', onResize)
        }
      }, [])

      /** 圆钮和面板标题栏共用这一套按住就整个浮窗跟着走*/
      const startDrag = (event) => {
        if (event.button !== 0) return
        const node = unitRef.current
        if (!node) return
        const rect = node.getBoundingClientRect()
        dragRef.current = { startX: event.clientX, startY: event.clientY, baseX: rect.left, baseY: rect.top }
        movedRef.current = false
        setOffset({ x: rect.left, y: rect.top })
        setDragging(true)
        event.preventDefault()
      }

      const toggle = () => {
        // 刚拖过就别再当成点击,不然每次挪位置都会弹面板
        if (movedRef.current) {
          movedRef.current = false
          return
        }
        // 展开方向交给 useEffect 去量(开着的时候,这里只管开关
        setOpen((was) => !was)
      }

      /**
       * 【10-18 19:10 boss新要求:双击悬浮窗 = 自动换肤开关】
       *
       * 浏览器单击总是先于双击触发,所以不能直接挂 onDoubleClick ——
       * 那样会先"开面板、再关面板、再开自动",手忙脚乱。
       * 这里的做法:单击先按住 260ms 不执行,如果 260ms 内来了第二下,
       * 就把这次单击作废、改走自动换肤。两下之间手速慢一点(超过 260ms)
       * 就当两次普通单击 —— 那是boss自己慢慢点,不是双击。
       *
       * 【10-20 22:1x 加了三击:彩蛋贴纸】
       * boss要「单击悬浮窗 3 次让它浮现,再单击 3 次让它关闭」。
       * 于是单击/双击/三击得用**同一个计数器**分清楚,不能各挂各的:
       *   第 1 下 → 挂 260ms 计时器,到点没等到下一下 = 单击(开面板)
       *   第 2 下 → 作废第 1 下的计时器,重新挂 260ms;
       *            这 260ms 内来了第 3 下 = 三击(贴纸);
       *            没人来 = 双击(自动换肤)
       *   第 3 下 → 作废计时器,走三击
       *
       * ⚠️ 代价(明说):双击比原来**晚 260ms** 才生效(原来是第二下立刻触发)。
       *    这是「加第三档」必然带的代价 —— 不推迟就没法区分双击和三击。
       *    boss要的就是三击,这个代价接受。
       */
      const clickTimer = useRef(null)
      const clickCount = useRef(0)
      /**
       * 【10-22 00:0x boss「双击右键」】自定义背景 ⇄ 系统默认壁纸。
       *
       * 跟左键那三档**完全分开计数**（右键只认"两下"），互不干扰；
       * **单击右键什么都不做** —— boss要的是双击，单下不算数。
       * 两下的判定窗口跟左键一样是 260ms（手速慢一点就是两次单击右键 = 不动作）。
       */
      const rightTimer = useRef(null)
      const rightCount = useRef(0)
      const onBallRightClick = (event) => {
        event.preventDefault()
        // 刚拖过就别当成点击
        if (movedRef.current) {
          movedRef.current = false
          rightCount.current = 0
          if (rightTimer.current) {
            clearTimeout(rightTimer.current)
            rightTimer.current = null
          }
          return
        }
        rightCount.current += 1
        if (rightTimer.current) clearTimeout(rightTimer.current)
        if (rightCount.current >= 2) {
          rightCount.current = 0
          rightTimer.current = null
          void toggleWallpaperDefault().then((r) => r && say(r.text))
          return
        }
        rightTimer.current = setTimeout(() => {
          rightTimer.current = null
          rightCount.current = 0
        }, 260)
      }
      useEffect(() => () => {
        if (clickTimer.current) clearTimeout(clickTimer.current)
        if (rightTimer.current) clearTimeout(rightTimer.current)
      }, [])

      const onBallClick = () => {
        // 刚拖过就别再当成点击,不然每次挪位置都会弹面板
        if (movedRef.current) {
          movedRef.current = false
          clickCount.current = 0
          if (clickTimer.current) {
            clearTimeout(clickTimer.current)
            clickTimer.current = null
          }
          return
        }
        clickCount.current += 1
        const count = clickCount.current
        if (count >= 3) {
          // 第三下:三击 —— 彩蛋贴纸浮现/收起
          if (clickTimer.current) {
            clearTimeout(clickTimer.current)
            clickTimer.current = null
          }
          clickCount.current = 0
          setStickerOpen((was) => !was)
          return
        }
        if (clickTimer.current) clearTimeout(clickTimer.current)
        clickTimer.current = setTimeout(() => {
          clickTimer.current = null
          clickCount.current = 0
          if (count === 1) {
            toggle()
            return
          }
          // 第二下等到的:双击 = 自动换肤
          void toggleAutoRotate().then((r) => r && say(r.text))
        }, 260)
      }

      // 双击后给一句回执(面板是关着的,不看提示条不知道成没成)
      const [flash, setFlash] = useState('')
      const flashTimer = useRef(null)
      useEffect(() => () => { if (flashTimer.current) clearTimeout(flashTimer.current) }, [])
      const say = (text) => {
        setFlash(text)
        if (flashTimer.current) clearTimeout(flashTimer.current)
        flashTimer.current = setTimeout(() => setFlash(''), 2000)
      }

      const onDrop = async (event) => {
        event.preventDefault()
        event.stopPropagation()
        setHot(false)
        const files = await filesFromDataTransfer(event.dataTransfer)
        if (files.length > 0) await importFiles(files)
      }

      /**
       * 【10-19 07:30 boss】「换肤的悬浮图标不要默认放在右下角,把它往上抬一点,
       * 否则我们在网页版输入的时候,它会挡着确认键,它的位置应该刚好大于网页版的输入框的位置。」
       *
       * 原来是 right:24 / bottom:24 —— 右下角贴死,正好压在输入框的发送键上。
       * 现在:自己去找输入框(输入框带 textarea/可编辑区,还有发送按钮),
       * 球的下沿贴输入框的上沿 —— 刚好不挡输入,也不挡发送。
       *
       * 找不着输入框就退回一个保守值:视口高度减去 160px
       * (输入框大致占的高度 + 一点余量),比贴死右下角高得多。
       */
      const [restY, setRestY] = useState(null)
      useEffect(() => {
        const find = () => {
          const vh = window.innerHeight || 0
          const vw = window.innerWidth || 0
          let top = null
          try {
            const nodes = Array.from(document.querySelectorAll('textarea, [contenteditable="true"], input[type="text"]'))
            for (const node of nodes) {
              const rect = node.getBoundingClientRect()
              // 只要屏幕中下部那片(输入框在底下,不在侧栏顶部)
              if (rect.top < vh * 0.5) continue
              if (rect.bottom > vh + 40) continue
              if (rect.width < 120) continue
              if (rect.height > vh * 0.6) continue
              top = rect.top
              break
            }
          } catch {
            /* 拿不到就退回保守值 */
          }
          // 球自己 56 高,下沿贴输入框上沿,再留 12px 空隙
          const y = top === null ? Math.max(80, vh - 176) : Math.max(80, top - 56 - 12)
          setRestY(Math.min(y, Math.max(80, vh - 80)))
        }
        find()
        window.addEventListener('resize', find)
        // 输入框是后来才渲染出来的,晚一点再找一次
        const late = setTimeout(find, 600)
        const later = setTimeout(find, 1800)
        return () => {
          window.removeEventListener('resize', find)
          clearTimeout(late)
          clearTimeout(later)
        }
      }, [])

      const anchored = offset
        ? { position: 'fixed', left: offset.x, top: offset.y, zIndex: 2147483000 }
        : {
            position: 'fixed',
            right: 24,
            // 抬到输入框上沿之上;还没算出来就先给一个偏上的保守值,别闪一下右下角
            top: restY === null ? Math.max(80, (window.innerHeight || 700) - 176) : restY,
            zIndex: 2147483000,
          }

      /**
       * 【10-21 19:0x boss】贴纸摆哪儿 —— 改成「贴纸自己量自己、自己摆」。
       *
       * 这里**只做一件事**：量出球在视口里的位置，交给贴纸。
       * 怎么摆、摆哪一边、会不会出界，全部由 placeSticker 算
       *（纯函数，能抠出来真跑一遍验证）。
       *
       * 为什么不再在这里算坐标：
       *   上一版在这里「估」贴纸的宽高（写死 300×300）再算坐标，
       *   球在屏幕下沿时贴纸被顶到屏幕最上角 —— 离球十万八千里（boss 10-21 截图）。
       */
      const [ballRect, setBallRect] = useState(null)
      useEffect(() => {
        if (!stickerOpen) {
          setBallRect(null)
          return undefined
        }
        const measure = () => {
          const node = unitRef.current
          if (!node) return
          const rect = node.getBoundingClientRect()
          const next = {
            left: rect.left,
            right: rect.right,
            top: rect.top,
            bottom: rect.bottom,
            width: rect.width,
            height: rect.height,
          }
          // 坐标没变就别换新对象，免得贴纸白重摆一次
          setBallRect((was) => {
            if (was
              && was.left === next.left && was.right === next.right
              && was.top === next.top && was.bottom === next.bottom
              && was.width === next.width && was.height === next.height) return was
            return next
          })
        }
        measure()
        window.addEventListener('resize', measure)
        return () => window.removeEventListener('resize', measure)
      }, [stickerOpen, offset])

      return h(
        'div',
        {
          ref: unitRef,
          style: {
            ...anchored,
            pointerEvents: 'none',
            ...(hot ? { outline: `2px dashed ${T.accent}`, outlineOffset: 4, borderRadius: 12 } : {}),
          },
          onDragOver: (event) => {
            event.preventDefault()
            const node = unitRef.current
            if (node) {
              const rect = node.getBoundingClientRect()
              setHintBelow(window.innerHeight - rect.bottom > 80)
            }
            setHot(true)
          },
          onDragLeave: () => setHot(false),
          onDrop,
        },
        wallpaperCssText ? h('style', null, wallpaperCssText) : null,
        // 红滚动条跟有没有选图无关,面板一开就得是红的,所以常驻挂
        h('style', null, PANEL_CSS),
        h(
          'button',
          {
            type: 'button',
            title: dict.title,
            'aria-label': dict.title,
            'aria-expanded': open,
            onMouseDown: startDrag,
            onClick: onBallClick,
            // 【10-22 00:0x boss】双击右键 = 自定义背景 ⇄ 系统默认壁纸
            onContextMenu: onBallRightClick,
            style: {
              pointerEvents: 'auto',
              display: 'block',
              width: 56,
              height: 56,
              padding: 0,
              borderRadius: '50%',
              overflow: 'hidden',
              cursor: dragging ? 'grabbing' : 'grab',
              border: `2px solid ${T.borderStrong}`,
              background: T.raised,
            },
          },
          h('img', {
            src: `data:image/jpeg;base64,${AVATAR}`,
            alt: '',
            draggable: false,
            style: { width: '100%', height: '100%', objectFit: 'cover', display: 'block', pointerEvents: 'none' },
          }),
        ),
        // 【10-20 22:1x 彩蛋】渠道限流贴纸。
        // 【10-21 19:0x】位置改成贴纸自己算:给球的位置,它量自己、自己摆,
        //   横着贴(离球 12px)放不下才改上下,永远夹在屏幕内。
        h(ChannelLimitSticker, {
          visible: stickerOpen,
          onClose: () => setStickerOpen(false),
          ballRect,
        }),
        /**
         * 【10-22 08:2x boss】点「检查更新」弹出的新窗口。
         *   它是**独立浮层**（不是浏览器新标签页）：底色跟着现在的换肤模式走，
         *   关掉就回到悬浮窗。点外面/按 Esc 也能关。
         */
        updateWindowOpen
          ? h(UpdateWindow, { onClose: () => setUpdateWindowOpen(false) })
          : null,
        // 【10-18 20:45 boss同意 C:自动换肤开着的时候,球上带个小绿点】
        // 不用双击去试 —— 一眼就知道现在是开着还是关着。
        state.rotateMinutes > 0
          ? h('div', {
              style: {
                position: 'absolute',
                right: 0,
                top: 0,
                width: 14,
                height: 14,
                borderRadius: '50%',
                background: '#00e676',
                border: '2px solid rgba(255, 255, 255, 0.9)',
                boxShadow: '0 0 4px rgba(0, 230, 118, 0.8)',
                pointerEvents: 'none',
              },
            })
          : null,
        hot
          ? h(
              'div',
              {
                style: {
                  position: 'absolute',
                  left: '50%',
                  // 底下没地方就翻到上面去别让提示条跑到屏幕外
                  top: hintBelow ? 64 : -34,
                  transform: 'translateX(-50%)',
                  whiteSpace: 'nowrap',
                  fontSize: 11,
                  padding: '3px 8px',
                  borderRadius: 6,
                  background: T.surface,
                  border: `1px solid ${T.borderStrong}`,
                  color: T.primary,
                },
              },
              dict.dropHint,
            )
          : null,
        // 双击之后的回执条(跟拖拽提示条同一个位置、同一套样式)
        flash
          ? h(
              'div',
              {
                style: {
                  position: 'absolute',
                  left: '50%',
                  top: hintBelow ? 64 : -34,
                  transform: 'translateX(-50%)',
                  whiteSpace: 'nowrap',
                  fontSize: 11,
                  padding: '3px 8px',
                  borderRadius: 6,
                  background: T.surface,
                  border: `1px solid ${T.borderStrong}`,
                  color: T.primary,
                },
              },
              flash,
            )
          : null,
        open && place
          ? h(
              'div',
              {
                // 这个类名是红滚动条的挂钩子(PANEL_CSS),面板里所有能滚的地方都归它管
                className: 'dsh-skin-panel',
                style: {
                  pointerEvents: 'auto',
                  position: 'absolute',
                  left: place.left,
                  top: place.top,
                  width: place.width,
                  maxHeight: place.maxHeight,
                  overflowY: 'auto',
                  /**
                   * 【2026-10-22 16:4x boss要求界面美化】面板本身也收拾一下：
                   *   内边距给足（14 → 16）、圆角大一点（14 → 16）、
                   *   加一层轻投影，让它从背景图上"浮起来"而不是贴着一块白板。
                   * ⚠️ 只改**长什么样**：位置、宽高、滚动行为一个没动。
                   */
                  padding: 16,
                  borderRadius: 16,
                  border: `1px solid ${T.borderStrong}`,
                  background: T.surface,
                  color: T.primary,
                  boxShadow: '0 12px 40px rgba(0, 0, 0, 0.18)',
                },
              },
              h(
                'div',
                {
                  onMouseDown: startDrag,
                  style: {
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    marginBottom: 16,
                    paddingBottom: 12,
                    borderBottom: `1px solid ${T.border}`,
                    cursor: 'move',
                    userSelect: 'none',
                  },
                },
                // 【10-22 16:4x 美化】标题也加上那根小竖条，跟下面各段一致
                h(
                  'div',
                  { style: { display: 'flex', alignItems: 'center', gap: 6 } },
                  h('span', { style: PANEL_UI.titleMark, 'aria-hidden': 'true' }),
                  h('span', { style: { fontSize: 14, fontWeight: 600 } }, dict.panelTitle),
                ),
                h(
                  'button',
                  {
                    type: 'button',
                    title: dict.close,
                    'aria-label': dict.close,
                    onClick: () => setOpen(false),
                    style: {
                      border: 'none',
                      background: 'transparent',
                      color: T.secondary,
                      fontSize: 18,
                      lineHeight: 1,
                      cursor: 'pointer',
                      padding: '0 4px',
                    },
                  },
                  '×',
                ),
              ),
              h(SkinControls, { compact: true, onOpenUpdate: () => setUpdateWindowOpen(true) }),
            )
          : null,
      )
    }

    /**
     * 时间戳 → 人话（「3 小时前」「2 天前」）。
     * 跟 Our Free Model 那边一个路子：**宁可说粗一点，也不要给一个假精确的日期**。
     */
    function formatWhen(ms) {
      const now = Date.now()
      const diff = Math.max(0, now - Number(ms || 0))
      const minute = 60 * 1000
      const hour = 60 * minute
      const day = 24 * hour
      if (diff < minute) return '刚刚'
      if (diff < hour) return `${Math.floor(diff / minute)} 分钟前`
      if (diff < day) return `${Math.floor(diff / hour)} 小时前`
      if (diff < 30 * day) return `${Math.floor(diff / day)} 天前`
      return `${Math.floor(diff / (30 * day))} 个月前`
    }

    /**
     * ═══ 新窗口：更新 + 我的项目（一页两段）════════════════════
     *
     * 【10-22 08:2x boss】
     *   「在换肤悬浮窗上，左边是默认界面，右边是『检查更新』。
     *     点击『检查更新』之后，不要直接更新，而是弹出一个新的画面窗口。
     *     新窗口的底色按照现在的悬浮窗模式来。
     *     ……形式可以借助我们现有安装的这个插件 Our Free Model，
     *     我们直接检查里面的两个：一个是插件升级，一个推荐项目，
     *     推荐项目就写我们自己的项目，目前只有一个手机远程。」
     *
     * 布局决策（问过boss，选「一页两段」）：
     *   不拆 tab —— 换肤面板只有 460px 宽，拆 tab 要多点一次，
     *   而且「看自己的项目」比「查更新」常用得多。
     *   但两段必须用分隔线 + 各自小标题分得清清楚楚，不能糊成一坨。
     *
     * 纪律（照抄 Our Free Model 那边的做法）：
     *   **数字必须是真读回来的**，读不到就不显示那个数字，
     *   绝不用占位数字凑版面 —— 这一页的说服力全在"数字是真的"。
     */
    function UpdateWindow({ onClose }) {
      const dict = dictFor()
      const [info, setInfo] = useState(null)
      const [projects, setProjects] = useState(null)
      const [busy, setBusy] = useState('')
      const [downloaded, setDownloaded] = useState(null)
      const [applied, setApplied] = useState(null)
      const [failed, setFailed] = useState('')
      const windowRef = useRef(null)

      const check = async (force) => {
        setBusy('check')
        setFailed('')
        try {
          // 手动点「检查更新」时绕过缓存（缓存是 6 小时，手动点就该真的去问一次）
          const data = force ? await getJson(`${UPDATE_CHECK_PATH}?fresh=1`) : await getJson(UPDATE_CHECK_PATH)
          setInfo(data && typeof data === 'object' ? data : null)
        } catch {
          setInfo(null)
        } finally {
          setBusy('')
        }
      }

      /**
       * 【10-22 09:0x boss】「下载好放在旁边，由您点一下确认才替换」
       *   ⇒ 下载这一步**只调 download 接口**，那个接口只写暂存目录，
       *   **绝不碰现装的那一份**。下载完界面上出现「已下载好，点此安装」，
       *   **那个按钮才是替换**（点了才调 apply，apply 内部先备份、失败自动回滚）。
       */
      const download = async () => {
        setBusy('download')
        setFailed('')
        try {
          const data = await postJson(UPDATE_DOWNLOAD_PATH, { method: 'download' })
          if (data && data.ok === true) {
            setDownloaded(data)
          } else {
            setFailed(String(data?.reason || 'download-failed'))
            setDownloaded(null)
          }
        } catch {
          setFailed('download-failed')
        } finally {
          setBusy('')
        }
      }

      const apply = async () => {
        setBusy('apply')
        setFailed('')
        try {
          const data = await postJson(UPDATE_APPLY_PATH, { method: 'apply' })
          if (data && data.ok === true) {
            setApplied(data)
            setDownloaded(null)
          } else {
            setFailed(String(data?.reason || 'apply-failed') + (data?.rolledBack ? '（已回滚）' : ''))
          }
        } catch {
          setFailed('apply-failed')
        } finally {
          setBusy('')
        }
      }

      useEffect(() => {
        let alive = true
        void loadUpdateInfo().then((data) => {
          if (alive) setInfo(data)
        })
        void getJson(PROJECTS_PATH).then((data) => {
          if (alive) setProjects(data && typeof data === 'object' ? data : null)
        }).catch(() => {
          if (alive) setProjects(null)
        })
        return () => {
          alive = false
        }
      }, [])

      /**
       * 【10-22 08:2x boss】关闭方式三个：右上角「×」、按 Esc、点窗口外面。
       * 放在**窗口组件自己**里 —— 外面那个 Launcher 拿不到这里的 DOM 节点，
       * 跨组件传 ref 是本项目已经踩过的坑（面板就是靠"点到面板外面才关"）。
       */
      useEffect(() => {
        const onKey = (event) => {
          if (event.key === 'Escape') onClose()
        }
        const onDown = (event) => {
          const node = windowRef.current
          if (node && node.contains(event.target)) return
          onClose()
        }
        document.addEventListener('keydown', onKey)
        document.addEventListener('mousedown', onDown)
        return () => {
          document.removeEventListener('keydown', onKey)
          document.removeEventListener('mousedown', onDown)
        }
      }, [onClose])

      const outdated = info && info.ok === true && info.outdated === true
      const items = Array.isArray(projects?.items) ? projects.items : []

      return h(
        'div',
        {
          className: 'dsh-skin-update-window',
          ref: windowRef,
          style: {
            pointerEvents: 'auto',
            position: 'fixed',
            left: '50%',
            top: '50%',
            transform: 'translate(-50%, -50%)',
            width: 'min(460px, calc(100vw - 24px))',
            maxHeight: 'min(70vh, 560px)',
            overflowY: 'auto',
            padding: 16,
            borderRadius: 14,
            border: `1px solid ${T.borderStrong}`,
            /**
             * 【10-22 19:1x boss】「检查更新跳出来的页面透明度太低了……因为透明度太低，
             * 导致前面显示的文字看不清楚了」
             *
             * 根因（查实的）：这个窗口原来直接用 `T.surface`（= `--dsw-alias-bg-overlay`），
             * 而那枚 token 的不透明度被**乘了 0.6**（`normalizePopupAlpha(state.popupAlpha) * 0.6`）——
             * 那是 10-18 为**下拉菜单**调的浓度（当时boss说「毛玻璃透明度别那么低」）。
             * 默认 popupAlpha=0.95 → 实际只有 **0.57**，壁纸和聊天区的字直接透上来。
             *
             * 修法（**只动这个窗口，不碰全局 token**）：
             *   底色换成**近乎不透明**的实色（0.97）——把后面的字彻底压住；
             *   再加毛玻璃模糊，边缘看着还是通透的，不像贴了块白纸。
             * ⚠️ 为什么不改 `--dsw-alias-bg-overlay` 本身：那一枚是全局的，
             *    改了会把下拉菜单、弹窗、输入框一起变浓 —— 超出boss这次说的范围。
             *
             * ⚠️⚠️ **别用多层 background 写这个**（本轮实测踩到）：
             *   ① 层序反了 —— CSS 多层 background 是「第一层在最上面」，
             *      把半透那层写在前面、实底写在后面，等于**没加**；
             *   ② 更坑的是**浏览器可能整条解析失败** ——
             *      `background: rgba(...), rgba(...)` 这种多层简写在 Chromium 里
             *      如果层类型/数量不匹配会**整条作废**，结果连半透那层都没了 →
             *      实测中心像素还是底下的深色（65,70,78），**看起来跟没改一样**。
             *   ⇒ **老老实实用单层实色 + backdrop-filter**，别玩多层。
             */
            background: 'rgba(255, 255, 255, 0.97)',
            backdropFilter: 'blur(24px) saturate(1.6)',
            WebkitBackdropFilter: 'blur(24px) saturate(1.6)',
            color: T.primary,
            boxShadow: '0 18px 60px rgba(0, 0, 0, 0.42)',
            zIndex: 2147483002,
          },
        },
        // 标题栏
        h(
          'div',
          {
            style: {
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              marginBottom: 14,
              paddingBottom: 10,
              borderBottom: `1px solid ${T.border}`,
              userSelect: 'none',
            },
          },
          h('span', { style: { fontSize: 14, fontWeight: 600 } }, dict.updateWindowTitle),
          h(
            'button',
            {
              type: 'button',
              title: dict.close,
              'aria-label': dict.close,
              onClick: onClose,
              style: {
                border: 'none',
                background: 'transparent',
                color: T.secondary,
                fontSize: 18,
                lineHeight: 1,
                cursor: 'pointer',
                padding: '0 4px',
              },
            },
            '×',
          ),
        ),
        // ── 第一段：更新 ──
        h(
          'section',
          null,
          h('div', { style: { fontSize: 12, fontWeight: 600, marginBottom: 8 } }, dict.updateSection),
          h(
            'div',
            {
              style: {
                fontSize: 11,
                color: T.secondary,
                lineHeight: 1.7,
                marginBottom: 8,
              },
            },
            dict.updateSectionHint,
          ),
          h(
            'div',
            { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 10 } },
            h(
              'span',
              { style: { fontSize: 11, color: T.secondary } },
              `${dict.updateCurrent}: ${info && info.current ? `v${info.current}` : '—'}`,
            ),
            info && info.latest
              ? h(
                  'span',
                  { style: { fontSize: 11, color: T.secondary } },
                  `${dict.updateLatest}: v${info.latest}`,
                )
              : null,
            outdated
              ? h(
                  'span',
                  {
                    style: {
                      fontSize: 11,
                      fontWeight: 700,
                      color: T.danger,
                      border: `1px solid ${T.danger}`,
                      borderRadius: 999,
                      padding: '1px 8px',
                    },
                  },
                  dict.updateOutdated,
                )
              : null,
            info && info.ok === true && !outdated
              ? h(
                  'span',
                  { style: { fontSize: 11, color: T.secondary } },
                  dict.updateUpToDate,
                )
              : null,
          ),
          h(
            'div',
            { style: { display: 'flex', gap: 8, flexWrap: 'wrap' } },
            h(
              'button',
              {
                type: 'button',
                onClick: () => void check(true),
                disabled: Boolean(busy),
                style: { ...buttonStyle(false), opacity: busy ? 0.6 : 1 },
              },
              busy === 'check' ? dict.updateChecking : dict.updateCheck,
            ),
            /**
             * 【10-22 09:0x boss】「下载好放在旁边，由您点一下确认才替换」
             *   第二步「下载更新」：**只下载**，现装的那份一个字节都不动。
             *   按钮文案明说"下载"，别让人以为点了就换了。
             */
            outdated
              ? h(
                  'button',
                  {
                    type: 'button',
                    onClick: () => void download(),
                    disabled: Boolean(busy),
                    style: { ...buttonStyle(false), opacity: busy ? 0.6 : 1 },
                  },
                  busy === 'download' ? dict.updateDownloading : dict.updateDownload,
                )
              : null,
            // ⚠️ 点「去仓库页」只是打开网页 —— 不想用自动更新的人还有这条路
            info && info.pageUrl
              ? h(
                  'button',
                  {
                    type: 'button',
                    onClick: () => window.open(String(info.pageUrl), '_blank'),
                    style: buttonStyle(false),
                  },
                  dict.updateGoRepo,
                )
              : null,
          ),
          /**
           * 第三步：下载好了，**等用户点一下才替换**。
           * 这一段是boss那句「由您点一下确认才替换」的落点 —— 按钮摆在这儿，
           * 文案明说"点这个才替换"，并且告诉用户替换后要重启。
           */
          downloaded
            ? h(
                'div',
                {
                  style: {
                    marginTop: 10,
                    padding: 10,
                    border: `1px solid ${T.borderStrong}`,
                    borderRadius: 10,
                  },
                },
                h(
                  'div',
                  { style: { fontSize: 11, color: T.secondary, lineHeight: 1.7, marginBottom: 8 } },
                  dict.updateDownloadedHint.replace('{n}', String(downloaded.files || 0)),
                ),
                h(
                  'button',
                  {
                    type: 'button',
                    onClick: () => void apply(),
                    disabled: Boolean(busy),
                    style: { ...buttonStyle(false), opacity: busy ? 0.6 : 1 },
                  },
                  busy === 'apply' ? dict.updateInstalling : dict.updateInstall,
                ),
              )
            : null,
          applied
            ? h(
                'div',
                {
                  style: {
                    marginTop: 10,
                    padding: 10,
                    border: `1px solid ${T.danger}`,
                    borderRadius: 10,
                    fontSize: 11,
                    lineHeight: 1.7,
                    color: T.danger,
                  },
                },
                dict.updateAppliedHint,
              )
            : null,
          failed
            ? h(
                'div',
                {
                  style: {
                    marginTop: 8,
                    fontSize: 11,
                    lineHeight: 1.7,
                    color: T.danger,
                  },
                },
                `${dict.updateFailed}: ${failed}`,
              )
            : null,
        ),
        // ── 第二段：我的项目 ──
        h(
          'section',
          {
            style: {
              marginTop: 16,
              paddingTop: 14,
              borderTop: `1px solid ${T.border}`,
            },
          },
          h('div', { style: { fontSize: 12, fontWeight: 600, marginBottom: 6 } }, dict.projectsSection),
          h(
            'div',
            { style: { fontSize: 11, color: T.secondary, lineHeight: 1.7, marginBottom: 10 } },
            dict.projectsSectionHint,
          ),
          items.length === 0
            ? h('div', { style: { fontSize: 11, color: T.secondary } }, dict.projectsEmpty)
            : items.map((item) =>
                h(
                  'div',
                  {
                    key: item.id,
                    style: {
                      border: `1px solid ${T.border}`,
                      borderRadius: 10,
                      padding: 10,
                      marginBottom: 8,
                    },
                  },
                  h(
                    'div',
                    { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: 4 } },
                    h(
                      'span',
                      { style: { fontSize: 12, fontWeight: 700 } },
                      item.name,
                    ),
                    h(
                      'button',
                      {
                        type: 'button',
                        onClick: () => window.open(String(item.url || ''), '_blank'),
                        style: {
                          border: `1px solid ${T.borderStrong}`,
                          background: 'transparent',
                          color: T.primary,
                          fontSize: 11,
                          borderRadius: 8,
                          padding: '4px 10px',
                          cursor: 'pointer',
                        },
                      },
                      dict.projectsOpen,
                    ),
                  ),
                  h(
                    'div',
                    { style: { fontSize: 10, color: T.secondary, marginBottom: 6, wordBreak: 'break-all' } },
                    item.repo,
                  ),
                  // 数字只在真读到时才出现
                  h(
                    'div',
                    { style: { display: 'flex', gap: 12, fontSize: 11, color: T.secondary } },
                    typeof item.stars === 'number' ? h('span', null, `★ ${item.stars}`) : null,
                    typeof item.forks === 'number' ? h('span', null, `Fork ${item.forks}`) : null,
                    item.pushedAt ? h('span', null, `${dict.projectsUpdated} ${formatWhen(item.pushedAt)}`) : null,
                  ),
                ),
              ),
        ),
      )
    }

    // ── 入口二设置页────────────────────────────────────
    function SettingsPage() {
      const dict = dictFor()
      useSkin()
      const entry = currentEntry()
      return h(
        'div',
        { style: { padding: '24px 24px 48px', maxWidth: 780, margin: '0 auto' } },
        h('h2', { style: { margin: '0 0 6px', fontSize: 18, fontWeight: 600 } }, dict.pageTitle),
        h('p', { style: { margin: '0 0 20px', fontSize: 12, color: T.secondary, lineHeight: 1.7 } }, dict.pageHint),
        h(
          'div',
          { style: { display: 'flex', gap: 24, flexWrap: 'wrap', alignItems: 'flex-start' } },
          h(
            'div',
            {
              style: {
                flex: '1 1 280px',
                minWidth: 240,
                height: 200,
                borderRadius: 12,
                border: `1px solid ${T.border}`,
                backgroundImage: entry ? `url("${cssEscape(imageUrl(entry.id))}")` : 'none',
                backgroundSize: 'cover',
                backgroundPosition: 'center',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              },
            },
            entry ? null : h('span', { style: { fontSize: 12, color: T.secondary } }, dict.previewEmpty),
          ),
          h('div', { style: { flex: '1 1 340px', minWidth: 320 } }, h(SkinControls, null)),
        ),
      )
    }

    // 页内自检已彻底移除(boss 10-18 18:00 拍板)。
    // 原来每次启动 4 秒后,它会真的连切几张背景图来验证换图功能 ——
    // boss开机就看到背景"唰唰"换一批。以后验证一律走离线脚本
    // (dsh-skin/verify/ 目录,在 Node 里模拟渲染,不碰boss的界面)。


    // ── 装配 ──────────────────────────────────────────────
    // inject 用简称 slots / theme / locale —— 这是官方示例和客户端 runner 认的写法
    // (runner 会把这些简称映射到对应服务)。本会话早前的实时检查确认过:
    // 插件正是用这套简称成功注册进 shell.overlay 的,悬浮窗此前在桌面版是能出现的。
    return {
      inject: ['slots', 'theme', 'locale'],
      apply(ctx) {
        ctxRef = ctx
        try {
          ctx.locale.register('dsh-skin', 'zh', DICTS.zh)
          ctx.locale.register('dsh-skin', 'en', DICTS.en)
        } catch {
          /* 语言注册不上就用自带的文案表 */
        }
        /**
         * 【10-20 00:0x】「需要人工判断也响」：在**页面侧**接应用的两个转发事件
         * （提问 / 审批）。拿不到 remote 就安静跳过，绝不影响换肤。
         * 注意：这里**没有**把 remote 写进 inject —— 万一它不是可注入的服务，
         * 写了 inject 会让整个插件起不来（换肤全废），代价太大；所以用 ctx.get 兜着取。
         */
        try {
          const remote = typeof ctx.get === 'function' ? ctx.get('remote') : ctx.remote
          const registered = watchHumanInteractions(remote ?? ctx.remote)
          if (registered === 0) {
            ctxRef?.logger?.info?.('dsh-skin: 没拿到 remote 通道，「需要人工判断」这一声先不响（换肤不受影响）')
          }
        } catch {
          /* 没有这个服务就算了 */
        }
        // 主题变了(明暗切换、换皮肤)只重画叠加层,不必重算背景图
        ctx.on('theme/change', () => {
          if (applying) return
          refreshLayer(currentEntry())
        })
        ctx.on('locale/change', () => notify())

        ctx.slots.inject('shell.overlay', () =>
          ctx.slots.register(
            { name: 'shell.overlay', id: 'dsh-skin-launcher', order: 90, label: () => dictFor().title },
            Launcher,
          ),
        )
        ctx.slots.inject('settings.section', () =>
          ctx.slots.register(
            { name: 'settings.section', id: 'dsh-skin', order: 30, label: () => dictFor().section },
            SettingsPage,
          ),
        )

        // 先把设置和图库读回来,再决定要不要开背景
        void (async () => {
          try {
            const [saved] = await Promise.all([
              postJson(STATE_PATH, { method: 'get' }),
              loadLibrary(),
            ])
            state = normalizeState(saved)
            stateReady = true
            notify()
          } catch {
            /* 接口不可用就当没设过 */
          }
          await migrateLegacy()
          // 尺度调整后老图存的自动遮罩是旧值统一拉回当前上限内
          await normalizeAutoMasks()
          await refreshBackground()
          // 老图缺对话区分位数,当前这张先补上(不阻塞启动)
          void ensureBands(currentEntry())
          // 设置和图库都齐了,这时候才知道该不该排随机变换
          scheduleRotate()
          // 提示音:开始每秒问一次(里面自己会判开关,关着就不会响)
          startBellWatch()
        })()

        return () => {
          flushWash()
          if (bellTimer !== null) {
            clearInterval(bellTimer)
            bellTimer = null
          }
          if (rotateTimer !== null) {
            clearTimeout(rotateTimer)
            rotateTimer = null
          }
          if (layerDispose) {
            try {
              layerDispose()
            } catch {
              /* 撤层失败无所谓插件已经卸载 */
            }
          }
          layerDispose = null
          ctxRef = null
        }
      },
    }
  },
})
