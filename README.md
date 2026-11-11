# dsh-ui-block — 页面块（Page Block）

## 第一次使用

四步，顺序不能换：扩展只上报它看得见的标签页，目标页没开着，清单就是空的。

1. **装扩展**：`chrome://extensions` 开开发者模式 →「加载已解压的扩展程序」，选插件包里的 `extension-capture\` 目录。这个目录的绝对路径不用猜——插件页 Settings → Plugins → dsh-ui-block 印着它，`GET /ui-block-extension/info` 的 `captureDir` 也是同一个值。
2. **填 baseURL**：扩展选项页把 baseURL 填成本实例的地址（例如 `http://127.0.0.1:4000`）；配对码与实例名按需填，留空即默认。
3. **在你的浏览器里打开目标页**：要让 agent 抓的那一页，先用装好扩展的这个浏览器把它打开。需要登录的页面必须由你自己在已登录的浏览器里打开，插件不读、不复制任何 cookie。
4. **回会话说「列一下能抓的页面」**：agent 调 `list_pages` 就会列出第 3 步那一页，再用该行的 `{ instance, tabId }` 调 `capture_page`。

公开页也一样走第 3 步——扩展只上报它看得见的标签页，插件不替你开页、不读你的 cookie。这台机器上还没有带扩展的浏览器时，由 agent 自己判断要不要配一台固定的、专用于带插件调试的浏览器，配过就沿用；你不用为它准备什么。需要登录的页面仍按第 3 步在你自己的浏览器里打开。

清单为空时不用猜配置：`list_pages` 的返回里直接印出扩展的完整目录、本实例 baseURL 的可复制值，以及这份检查顺序，照它读一遍即可。

> **2026-10-24：触发方式换成独立一行 `::dsh-ui <name>::`。**
>
> - 新写法（消息里单独一行，前后可有空白，**不带反引号、不在围栏里、不带别的字**）：
>   `::dsh-ui 名字::` 或 `::dsh-ui 名字 res=820x510::`。该行会被隐藏，画布插在它原位；
>   `res=` 决定画布尺寸，缺省 1440x900。
> - **旧写法（裸围栏 + 块体首行 `dsh-ui ref: ui-blocks/<name>.uiblock`）已彻底删除**，
>   代码里没有任何兜底识别路径；`scripts/check-meta.mjs`、`scripts/check-selectors.mjs`
>   随之删除。
> - 自检：`node self-check-uiblock-directive.mjs`（当前 46 条断言，含"旧写法不命中"、
>   "代码块里不命中"、"非法 res 被拒"，以及下一条的补丁链/时刻还原）。
> - 缩放、画布内选区、拖拽、读文件、报错处理**未改**。
>
> **2026-10-24 第二轮（用户拍板"就要和代码块一模一样"）**：外壳改回**真·代码块**——
> 座位里用 React 挂载聊天自己的 `CodeBlock`（`require('@deepseek-ai/dsh-client-ui-primitives')`），
> 外框、底色、圆角、横栏、「复制」图标与 tooltip 全是同一个组件的同一份样式，不是仿制品。
> 横栏语言标签固定是 `dsh-ui`（走 `toolbarLabels.codeLabel`，不改写 DOM）；复制按钮复制的是
> `ui-blocks/<name>.uiblock`（`code` 传的就是路径，`<pre>` 只是 `display:none` 藏起来）。
> 下面「围栏块 / 横栏钩子」记的是旧围栏实现的来龙去脉，DOM 钩子与现在这套一致。

> **2026-10-25：引用按消息时刻还原（写法一个字都没改）。**
>
> - 引用语法不变，仍是 `::dsh-ui <name>::` / `::dsh-ui <name> res=WxH::`，本页其它章节
>   讲的解析规则照旧。
> - 一条消息里的引用显示的是**那条消息第一次渲染时**这一版块；之后改块只影响**之后**的新消息。
>   刷新页面也还是各显示各的版本（钉子存在宿主侧的 `ui-blocks/.pins.json`，不在浏览器内存里）。
> - 历史是**补丁链，不是副本**：`ui-blocks/.history/<名字>/base.uiblock` 只有首次见到的那一份基线，
>   `log.json` 每行一条 `{at, patch}`（行级 hunk，自己写的 Myers，无依赖）。
> - 宿主路由：`?at=<epoch毫秒>` 还原那一刻的内容；`?pin=<对话节点键>&i=<第几条>` 首次请求钉住
>   "现在"，之后沿用；两个都不带仍是**最新**（旧客户端兼容）。
> - 钉住的引用**不再 1.5 秒重读**（内容不会再变）；读失败仍然重试。
> - 找不到 `[data-chat-node-key]` 祖先时（草稿预览、非对话场景）退回旧行为：不带 pin，显示最新。
> - **升级前已有的历史消息**：首次渲染时才钉住，钉到的是"现在"，所以它们仍显示最新——这是缺信息，补不回来。
> - 自检：`node self-check-uiblock-directive.mjs` 覆盖补丁链还原（sha 对齐）、`?at=` 取中间版本、
>   pin 幂等、以及"历史目录里没有整份副本"。

> **下面从「围栏块 / 横栏钩子」讲起的段落是已退役实现的历史记录**（`.md-code-block`
> 三个钩子、A 路径"同壳替换"等），保留只为排查旧问题；当前代码**不再从围栏里取内容**，
> 但重新借用代码块组件当外壳（见上一段）。

**v0.4.0（2026-10-10）画布内选区**：横栏加一个**选区按钮**（分辨率按钮右边，只有 13×13 SVG 图标、无文字）。点亮后可在**画布内部**点选元素，选中的元素变成 `element«…»` chip **直接插进 composer**。交互与浏览器选区插件 element-picker 对齐：鼠标移动高亮 / **滚轮切层** / ↑↓←→ 层导航 / 点击选中 / **再点一次图标退出**。**Enter 与 Esc 都不绑**（选区不越界占用全局键）。

**两份独立副本（2026-10-09 实测澄清）**：3080 的 `profiles\web\node_modules\dsh-ui-block` junction 指向 `D:\dsh-plugins\dsh-ui-block`；4000 的 junction 指向 `D:\dsh-fallback\plugins\dsh-ui-block` —— 后者是一个**独立的真实目录**（`fsutil reparsepoint query` 报 4390「不是重解析点」），两边**不共享**。改代码必须**两处都同步**，否则只有一边生效。改完 **4000 重启即生效，3080 要用户自己重启**。

## A 路径：同壳替换（不碰任何聊天包）

用 MutationObserver 找到消息流里的围栏代码块 DOM，把内容节点换成 iframe，并往横栏右侧注入控件。**没有任何包补丁**要回滚，卸载 = 删插件目录 + 还原 profile 两处。

### 只依赖三个稳定钩子（每 1.5s 自愈一次）

| 钩子 | 来源 | 作用 |
| --- | --- | --- |
| `.md-code-block` | `CodeBlock` 显式加的字面 class（不是哈希类名） | 找块 |
| `[data-code-block-content]` | primitives 里注明 "consumers may turn the stable content node into a viewport" | 内容节点 |
| `[data-code-block-banner]` | 横栏 | 注入分辨率控件 + 选区按钮（缩放/写回控件已删；0.2.3 起隐藏外壳自动换行开关） |

`node scripts/check-selectors.mjs` 会把 `client.js` 里的 `SEL_*` 常量拿去 4000 自己的产物语料里对，**缺一个就 exit 1**。页面里另有运行时断言：`window.__dshPageBlock.stats.selectorMiss`（>0 说明钩子变了）。

## 尺寸模型（v2：地图视口，三个独立状态）

把块当成**一扇看画布的窗户**：窗宽由聊天栏决定，画布（iframe）在窗内做地图式变换。

- **画布分辨率**：`res=1440x900` 声明，改它 = 改 iframe 真实的 CSS 视口 ⇒ **内容重新排版**（media query 生效）。横栏控件，改法与 v1 相同。
- **缩放**：光标悬在画布上**直接滚轮**，**朝光标点缩放**（newOffset = cursor − (cursor − offset) × newZ/oldZ），只加 `transform: translate+scale` ⇒ **永不重排**；钳制 20%–400%；**双击画布复位**（适应宽度一次）。横栏**不显示**缩放控件与百分比。
- **外框高度**（窗户高度）：`h=300` 声明默认值；缺省/非法回退 `min(画布高×初始适应, 480px)`。**拖下缘把手**调整（120px–视口高），**双击把手复位**。横栏不显示高度。

画布比窗小 → 居中；比窗大 → 拖拽平移（grab 光标；拖拽/调高的 move+up 挂在 window 上，不怕光标出块、不怕聊天壳的浮层盖住画布），**没有原生滚动条**。iframe 自身 `pointer-events:none`，交互全由插件自有的透明窗体层接管。

## 触发与元信息（v0.3.0）

**触发与常量同在围栏块体的第一行**：第一行以字面 `dsh-ui` 开头，后面跟可选的空格分隔常量。**正文 = 第二行起**（`dsh-ui` 那行永远不进沙箱）。

```dsh-ui
dsh-ui res=1440x900 h=300 title="登录弹窗"
<div class="pb pb-center">…</div>
```

`dsh-ui` **单独一行** = 全部用默认（1440×900）：

```dsh-ui
dsh-ui
<div class="pb pb-center">…</div>
```

未加引号的写法同样有效，多词值一路读到下一个 `key=`：

```dsh-ui
dsh-ui res=1440x900 h=760 title=首页 · 改版 (非对称 · 分级卡片)
<div class="pb pb-center">…</div>
```

- 触发：**第一行匹配 `/^dsh-ui(?:\s|$)/`**（`trim()` 之后）。`dsh-ui` 必须是完整的首词 ⇒ `dsh-uires=1`、`dsh-ui2` **不触发**。
- **围栏语言无关**：写 ```dsh-ui`、````（无语言）还是 ```text` 完全一样（宿主只印它认得的语言名，`dsh-ui` 会显示成"代码块"——见下）。
- **未加引号的多词值现在也能解析**：值的边界是下一个合法键（`^[a-z][a-z0-9-]*=`），所以 `res=1440x900 h=760 title=首页 · 改版 (非对称 · 分级卡片)` 解析为 `{res:"1440x900", h:"760", title:"首页 · 改版 (非对称 · 分级卡片)"}`。引号形式 `title="a b"` / `title='a b'` **行为不变**（引号值在闭合引号处结束，后面不再续接）。
- **坏 token 跳过，不再连坐**：`·`、`改版`、`(非对称`、空值的 `key=`、未闭合引号这类 token 只被丢弃，**不影响触发**（触发只看 `dsh-ui` 前缀）；被丢弃的只是那个常量的值。
- **只有 `title` 的值会续接多词**；`res` / `h` / `width` / `height` / `zoom` 仍是单 token ⇒ `res=1440x900 随便 垃圾` 取 `1440x900`、其余丢弃。未知键（`x=1`）保留在 meta 上但没人读。**一个常量都没有（`dsh-ui` 单独一行）也照常渲染**，只是全用默认。
- 诊断（只进控制台，不影响渲染）：**迁移诊断** —— 第一行**像旧 meta 行但没有 `dsh-ui` 前缀**时（`looksLikeMetaLine()` 命中，或该行能解析出至少一个已知键），`window.__dshPageBlock.stats.metaBail` 计数 +1、`stats.lastMetaBail = {line, reason:'missing-dsh-ui-prefix'}`，并 `console.warn` 一行提示加前缀（同一条只 warn 一次，不随 1.5s 扫描刷屏）。这类块**不渲染**。普通散文/代码不打印任何东西。**`res` 非法不走这条路**，一行也不打印。
- **`res` 缺失或非法 ⇒ 同一条路（2026-10-04 契约变更，2026-10-09 复核仍成立）**：`res=abc`、`res=default`、`res=1180`、`width=x` 与完全不写 `res` **等价**，统一用默认 **1440×900** 正常渲染，**不再退回普通代码块，也不加任何 UI 提示**（用户原话：「就直接用那个默认的吧」）。旧版"声明了却解析不出来 ⇒ 整块退普通代码块"的 `resBails()` 闸门已删除，那条硬契约作废。
- `h` 缺省或非法（`h=abc`）⇒ **不炸块**，回退高度 min(画布高×初始适应, 480px)。
- 缺 `res`（或 `res` 非法，同上）但有其它键 ⇒ 默认 1440×900，横栏沿用既有那条"未声明，使用默认"的显示；非法值不另做文案。
- ~~`html` 别名~~：**v0.3.0 已删除**（语料实测 0 次使用）。现在 ```html` + `<div>` 的普通 HTML 示例**不渲染**。
- **旧写法（首行没有 `dsh-ui` 前缀）一律不渲染**，只留一条 `missing-dsh-ui-prefix` warn。

### 分段与虚拟文件（2026-11-04）

一个 `.uiblock` 可以同时是**入口 + 若干虚拟文件**。分隔符是**独占一行**的 `<!-- @@file <路径> -->`（二进制资源写成 `<!-- @@file <路径> base64 -->`，段体是 base64）：

```text
<!doctype html><html><head><link rel="stylesheet" href="./panel.css"></head><body>…</body></html>
<!-- @@file panel.css -->
@font-face{font-family:Demo;src:url(./f.woff2) format('woff2')}
.card{background:var(--dsw-alias-bg-layer-1)}
<!-- @@file logo.svg -->
<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16">…</svg>
<!-- @@file f.woff2 base64 -->
d09GMgABAAAAA…
```

- **为什么要有它**：srcdoc 文档的 URL 是 `about:srcdoc`，相对路径无处可解，块里引用不了任何别的文件。分段把每一段变成**真有地址**的虚拟文件。
- **三条路由**（都在 `/ui-blocks` 前缀下）：`/ui-blocks/<name>.uiblock` = 原文（复制按钮、`?at=`、`?pin=` 全走它，行为不变）；`/ui-blocks/<name>` = 入口段，`text/html`；`/ui-blocks/<name>/<路径>` = 该段，按扩展名给 content-type。
- **段路径守卫**：不得含 `..`、不得以 `/` 开头、不得为空（404）；扩展名白名单 `css svg json woff2 woff ttf png jpg jpeg webp`，其它一律 **415**；允许子目录（`img/logo.svg`），因为相对路径按"段所在的 URL"解析。
- **上限**：单段 256 KB、整文件 2 MB，超了 **413**。版本历史是整文件行级补丁链，大 base64 段会让每次改动记录变肥 —— 这是硬上限，不是建议。
- **响应头**（入口与每一段都带）：`default-src 'none'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; script-src 'none'; base-uri 'none'`。**唯一放宽的是同源样式/图片/字体**，`script-src` 仍是 `'none'`，sandbox 仍只有 `allow-same-origin`。
- **没有分段标记的块一个字节都不变**：`splitSections()` 返回空 `files` ⇒ 客户端仍走 `srcdoc`，`buildSrcdoc()` 的输出与改动前逐字节相同。
- **`?at=` 对 CSS 同样生效**：段是从"那一刻的文件内容"里解析出来的，所以入口与它的样式表永远是同一个版本。

## 画布内选区（v0.4.0）

### 按钮

分辨率按钮**右边**，**只有 SVG 图标、无文字**，13×13，箭头形状 `M2.5 2.5l5 11 1.8-4.2 4.2-1.8z`。

| 项 | 未点亮 | 点亮 |
| --- | --- | --- |
| 内容 | 只有 SVG | 同 |
| 图标尺寸 | 13×13 | 同 |
| **底色** | 透明 | **透明（不变）** |
| **边框颜色** | `var(--dsw-alias-border-l2)` | **`#22d3ee`（青蓝）** |
| **线条颜色** | `var(--dsw-alias-label-secondary)` | **`#22d3ee`（青蓝）** |
| 线宽 | 1.3 | 1.5 |
| `title` | 在画布内选取元素 | 同 |

**点亮 = 图标线条 + 圆角边框都变青蓝，底色仍透明**（整个按钮的"线"高亮，不加实心背景）。

> ⚠️ **不要用 `var(--dsw-alias-brand-primary)` 做高亮色**。实测它映射到 `--dsw-static-neutral-bluish-*`（**灰蓝色**），深色主题下观感接近白色 —— 这就是"高亮像白色"的原因。要真青蓝只能写死色值，本插件用 **`#22d3ee`**。

### 交互（与 element-picker 同一套心智）

| 操作 | 行为 |
| --- | --- |
| 鼠标移动 | 高亮指针下的元素（蓝框） |
| **滚轮** | **在层叠栈里上下切换**（穿透遮挡，选到被盖住的元素）；**已 `preventDefault`，不会同时触发画布缩放** |
| ↑ | 选父元素 |
| ↓ | 选第一个子元素 |
| ← / → | 选前/后兄弟 |
| 点击 | 确认选中 → token 直接进 composer |
| **Enter** | **不绑**（无意义，留给页面） |
| **Esc** | **不绑**（交给上层） |
| **结束选区** | **再点一次选区图标** |

层叠栈用 `doc.elementsFromPoint(x, y)`（**iframe 内部的 doc**），并按 element-picker 的写法补上 `pointer-events:none` 子树漏掉的祖先。

**方向键前提**：`keydown` 绑在 iframe 的 `contentWindow` 上，所以点亮时插件会 `frame.focus({preventScroll:true})`、并在 `pointerdown` 里补一次 `win.focus()`（`preventDefault` 顺带压掉了本该转移焦点的兼容 `mousedown`）。焦点在画布内时方向键才收得到。

**一次只属于一个块**：点亮第二个块的选区会自动熄灭第一个（模块级 `armedPick`），同页多个页面块不会互相抢指针。

### 插入路径（乙：直接插 composer，不走剪贴板）

1. 注册一个 **`conversation.input.overlay`** 座位，**id `dsh-ui-block-picker`**（与 dsh-element-chip 的 `dsh-element-chip` 不同；该座位是 additive list，两个共存），组件**返回 `null`**，只用来接住 `props.sessionId` 与 `props.inputActions`。
2. 选中时取 `inputActions.captureInsertion()` 拿**带 `draftRev` 的插入 span**，然后
   `emit(sessionId, 'slash/input-insert-reference', { reference: {source:'element', ref:token, label:tag, clipboardText:token}, span })`。
3. **`source` 复用 `'element'`** —— chip 的渲染、序列化、复制全部复用 dsh-element-chip 的既有实现，零重复。
4. 座位注册走 **`ctx.get('slots')`**（不是 `ctx.slots`），并在 1.5s sweep 里**惰性重试**：slots 服务缺席时页面块照常工作，只是选区会提示"插入失败"，不会因为缺服务整块停摆。

### token（3 行，复用 element-picker 格式与截断规则）

```
element«DOM Path: #lbtn
Position: top=0px, left=0px, width=72px, height=27px
HTML Element: <button id="lbtn" class="cta" data-role="primary">实时按钮</button>»
```

- 选择器：有 `#id` 用 `#id`，否则最多 4 层 `tag.class:nth-of-type`。
- 位置：`getBoundingClientRect()`，**在画布自己的坐标系里**（即 `res=` 声明的那个逻辑视口）。
- HTML 行：只印元素**自己的**属性（**≤8**，多出的记 `... +N more`）与**自己的**文本（**≤80** 字符），子节点标记不展开。
- `«` / `»` / 反斜杠按 element-picker 的规则转义，保证第一个裸闭合书名号永远是 token 结尾。
- **Styles 行已删**（与 element-picker 同步，token 现在是 3 行）。

## 重播按钮（2026-11-11）

**问题**：块里的动画是**一次性**的（`iterations=1`），播完停在终态，用户任何时候看都是静态的。**不改成循环**——那等于改原站的效果。

分辨率与选区图标**右边**再一颗 13×13 图标：断开的圆 + 箭头 + 一个实心小三角（「再播一遍」，不是「刷新整页」）。按一下做两件事：

1. 先往块里 `postMessage({ type: 'dsh:replay' })`（`targetOrigin: '*'`，消息里没有秘密）；有监听者可以在这时复位自己的状态，没有就什么也不发生。
2. 一个任务之后（`setTimeout(…, 0)`）重新加载 entry：srcdoc 块 `removeAttribute('srcdoc')` 再写回；分段块重设 `src`，带一个只这一下用的 `replay=N` 参数。块里所有 CSS 动画与过渡从头播，**时序一个字节都不改**。

重载必须晚于消息：同一个 tick 里换文档会把这条消息连同旧文档一起丢掉（实测踩过，`setTimeout(…, 0)` 之后正常）。演示块不挂这颗按钮（已有 播放 / 暂停 / 重新开始），尺寸、缩放、sandbox 都不动。

**消息现在到不了块里的脚本**：块是 script-inert 的（iframe `sandbox="allow-same-origin"`、文档 CSP `script-src 'none'`），块内 `<script>` 不执行。这条消息是「将来块能带脚本」时的接口，不是重播的依赖——现在真正让动画重播的是重新加载 entry。测试接缝：`window.__dshPageBlock.replay(i)`。

## 演示块：宿主驱动的时间轴（2026-11-09，路线 1）

**效果：** 块文件里多一份 `<!-- @@file demo.json -->` 段（内容是 `{ snapshots, timeline }`）时，这个块变成**演示块**：块本身仍是纯数据（沙箱不变、帧仍 `pointer-events:none`），由插件在外层把时间轴演给块看——光标、高亮、合成点击、切页（换快照）、逐字输入都由宿主完成。
1. 判据只有一条：块文件里存在可解析的 `demo.json` 段，且 `snapshots` 非空、`timeline.steps` 非空。不带这段的块走原来的 srcdoc 路径，**不建任何新 DOM、不起 rAF、不加控件**。
2. `demo.json` 解析失败 → `console.warn` 一条并退回静态显示；`steps` 为空 → 同样退回静态。**不会白屏。**
3. 时间轴没写 `loop` 时**默认循环**（`loop !== false`）；播到末尾回到第一份快照，不会停在末帧。
4. 快照写 `url:pages/home/index.html` 这类相对块根的路径，插件按块自身的服务目录解析；空块 → 静态。
5. 播放层是 `<div class="dshpb-stage">`（绝对定位，几何与画布帧逐帧同步，`pointer-events:none`），里面挂 vendored 播放器；块自己的 frame 在演示块里 `display:none`。
6. 工具条：`播放 / 暂停 / 重新开始` 三个按钮，复用 `dshpb-ctl` + `dshpb-btn`，放在 banner 的**标题侧**——实测放在右侧动作组里会把 `1440×900 / 选取元素` 左移 162px，所以不放那儿。静态块的 banner 一个字节不变。
7. 进入可视区自动播放、离开暂停、回来继续（`IntersectionObserver`）；用户点过"暂停"后，滚进滚出不会自己恢复。
8. 选取元素（pick）与播放互斥：`armPick` 时暂停播放并记住状态，`disarmPick` 后恢复；`frame.pointerEvents` 的置位/复位逻辑未改。
9. 宿主侧新增一种 section 类型 `html`（`index.js` 的 `SECTION_TYPES`）：多页快照的 `pages/*.html` 需要能当 section 服务（原来只允许 ENTRY 是 `.html`，其余一律 415）。路径校验不变（`..` / 前导 `/` / 反斜杠 / NUL 全部拒），每个 section 仍带 `script-src 'none'` 的 CSP。
10. 新增测试接缝 `__dshPageBlock.demos.{count,state,play,pause,restart}(index)`，`sweep().live[]` 多一个 `demo` 字段。

**锚点：** `client.js` 的 `readDemo / blockSections / paintDemo / ensureStage / armAutoplay / buildTransport / demoSet / demoInfoOf`；`player.mjs`（从 ui-snapshot 复制、独立维护，`self-check-player-vendor.mjs` 断言它与 client.js 里的 `[vendored-player]` 段逐字一致）；`index.js` 的 `SECTION_TYPES.html`。

**验：** `node self-check-player-vendor.mjs`；CDP 用 `demos.state()` 读 `t/snapshot`，点 `[data-dshpb-demo=pause]` 后两帧哈希应相同。

## 沙箱（v0.4.0 变更）

- `sandbox="allow-same-origin"`：**只有** `allow-same-origin`，**绝不**加 `allow-scripts`（两者同时 = 沙箱失效，规范明示）。
  - **为什么加**：画布选区要读 iframe 内部的 DOM（`contentDocument` + `elementsFromPoint`）；没有同源就是 `null`，选区做不了。
  - **代价**：父页面能访问草稿 DOM（草稿能用 CSS 做视觉欺骗，但它本来就能）。
  - **没有放开的**：`<script>` **仍不执行**（`window.__ran === undefined`，实测）；CSP 仍生效（外链 `<img>` `naturalWidth === 0`，实测）；iframe 读父页面仍失败。三条都在 `tmp\dshui-canvas-picker-20261010` 的验证里逐条断言过。
- 旧值 `sandbox=""`（v0.3.0 及以前）**已不再使用**。
- srcdoc 里 CSP `default-src none; style-src unsafe-inline; img-src data: blob:; font-src data:; media-src data:; form-action none; base-uri none`，`referrerpolicy="no-referrer"`。
- 主题令牌：读宿主 `document.body` / `documentElement` 上的全部 `--dsw-*`（0.1.7 时 384 个，0.2.0-rc.2 实测 413 个）。**两条注入路径**：srcdoc 块照旧在 `buildSrcdoc()` 里内联进 `:root`；分段块（URL 文档）由父页面在 `load` 之后写进同源的 `contentDocument`，一个 `<style id="dshpb-tokens">` 插在 `head` **最前面**（块的样式表要能盖住 `BASE_CSS`）。两条都写 `color-scheme`；主题切换后 1.5s 内自动重绘（srcdoc 块重建文档，URL 块只重写那张 `<style>`，不重新导航、不闪白）。

## 素材抓取脚本怎么跑（tools/）

脚本从 ui-snapshot 并进来，相对路径按启动目录解析，所以统一在插件目录里跑；插件目录的 `out\` 已在 `.gitignore` 里。

```powershell
# token（3080）
Select-String -LiteralPath 'D:\DSH Pack Launcher\dsh-packs\dsh-origin-3080\logs\launcher.out.log' -Pattern 'dsh web: http' | Select-Object -Last 1

# 1) 抓（--split = 多文件模式）
node tools\capture.mjs --url "http://127.0.0.1:3080/?token=<token>" --split out\parts\home --shot out\parts\home\live.png --settle 2500

# 2) 组装多文件站 + 块
node tools\assemble.mjs --parts out\parts --names home,plugins,market --out out\site --timeline tools\timeline-multi.json

# 3) 起服务看：http://127.0.0.1:3911/out/site/index.html
node tools\serve.mjs 3911

# 块校验（--allow-html 给多页块用；--selftest 期望 "selftest": "PASS"）
node tools\blockcheck.mjs out\data.uiblock --allow-html
node tools\blockcheck.mjs --selftest

# 验收（服务与目标实例都要在）
node tools\verify2.mjs "http://127.0.0.1:3911/out/site/index.html"
node tools\pixels.mjs home,plugins,market
node tools\plugpix.mjs http://127.0.0.1:4000 <4000 的 token> <块名> home,plugins,market

# 单文件模式：抓一份自包含 html，看 harness.html
node tools\capture.mjs --url "http://127.0.0.1:3080/?token=<token>" --out out\snap-home.html --settle 2500
# 然后打开 http://127.0.0.1:3911/tools/harness.html
```

搬家前的产物还在 `..\ui-snapshot\out\`（含现成的 `data.uiblock`，可直接拿来试 `blockcheck`），新抓的一律写在插件目录的 `out\`。

## 安装到 4000

文件清单：

- `D:\dsh-fallback\plugins\dsh-ui-block\package.json`
- `D:\dsh-fallback\plugins\dsh-ui-block\cordis.patch.yml`
- `D:\dsh-fallback\plugins\dsh-ui-block\index.js`（宿主半边，空 apply）
- `D:\dsh-fallback\plugins\dsh-ui-block\client.js`（全部实现）
- `D:\dsh-fallback\plugins\dsh-ui-block\scripts\check-selectors.mjs`
- `D:\dsh-fallback\plugins\dsh-ui-block\scripts\check-meta.mjs`（v3：把 client.js 的纯解析区抽进沙箱，**50 断言**盯 `dsh-ui` 触发 + `res=/h=/title=` 契约，含首词边界、正文剥离、未加引号多词 title、坏 token 跳过，以及 2026-10-04 契约 `res` 缺失/非法 ⇒ 默认 1440×900 不退块 + "旧 metaTrigger/htmlTrigger 已删除"的结构断言）
- `D:\dsh-fallback\plugins\dsh-ui-block\README.md`

步骤：

1. profile 的 `package.json` 加依赖 `"dsh-ui-block": "link:D:/dsh-fallback/plugins/dsh-ui-block"`，并把 `dsh-ui-block` 追加进 `dsh.profile.bundles`。
2. 在 `D:\dsh-fallback\home\profiles\web` 跑 `pnpm install --config.auto-install-peers=false --store-dir D:\dsh-fallback\pnpm-store`。
3. **重启 4000**（client bundle 图只在启动时合成）：按端口杀 `Get-NetTCPConnection -State Listen -LocalPort 4000` 的 pid，再 `Start-Process cmd.exe -ArgumentList /c,D:\dsh-fallback\start.cmd -WindowStyle Hidden`。
4. 浏览器刷新页面（URL 见启动日志最后一行）。

⚠️ 改完 profile `package.json` 后、`pnpm install` 之前，运行中的实例会热加载 manifest 并打印两条 `skipping profile bundle "dsh-ui-block"` —— 那是**装的先后顺序**，不是失败；重启后就没了。

### 卸载 / 回滚

1. 从 profile `package.json` 删依赖与 bundles 行（同目录 `.bak-pageblock-20260928` 是原样备份）。
2. `pnpm install`（同上）。
3. 重启 4000。插件目录可留可删。

## 与计划的冲突（照实说明）

计划写的是条目行元信息：`dsh-ui res=1440x900 title=…`。**这在本版做不到**，证据：

- `dsh-client-ui-primitives/lib/index.js` 的 `renderCode()` 只把 `/^[\w-]+/.exec(info)`（第一段）当 `lang` 传给 `CodeBlock`，其余 token 直接丢弃；
- 横栏标签走 shell 产物里的 `I6(lang) ? lang : labels.codeLabel`，`I6` 是产物自带的语言表（含 `html`、`ts`、`mermaid`…，**不含 `dsh-ui`**），所以 `dsh-ui` 落到 `codeLabel`；
- **2026-10-24 起直接把 `toolbarLabels.codeLabel` 传成 `dsh-ui`**，于是横栏左边就印 `dsh-ui`（字号/颜色/位置与 `bash` 这类真语言名完全一致，实测 dx=22、dy=13 相同），不需要改写 DOM。

**替代做法（本次实现）**：元信息写进块体第一行（仍是纯文本、可 diff、可复用）。**升级路径**：若要条目行形式，需要走 B 路径（读会话事件的原始 markdown / `ctx.sessions`）或 C 路径（改聊天包），另议。

## 已知上限（ponytail 记录）

- **旧块全部失效（v0.3.0 的既定代价）**：首行没有 `dsh-ui` 前缀的历史块在重启后不再渲染，只留一条 warn。用户已接受（插件在测试期）。

- **依赖 DOM 钩子**：聊天包升级换钩子会失效 → 由 `scripts/check-selectors.mjs` + `stats.selectorMiss` 兜住，不静默坏掉。
- **React 重渲染**（点复制/换行按钮）可能把我注入的节点摘掉 → 1.5s 常驻 sweep + MutationObserver 自愈；用户改过的分辨率/缩放存在 `WeakMap` 里不会丢。
- **块被改写后不再触发**时，已渲染的宿主不会自动拆除（只有内容变化的块才重解析）。升级路径：在 `ensure()` 的早退分支里比对 textKey 并 teardown。
- **`res` 写错不再报错**（2026-10-04 用户决定）：`res=1180` 这类漏写尺寸的值会安静地按默认 1440×900 渲染，界面无提示、控制台不打印，`stats.metaBail` 也不计（它只统计"像旧 meta 行但缺 `dsh-ui` 前缀"那种）。想知道生效分辨率只能看横栏上那个数字。升级路径：要恢复"写错就退普通块"，把删掉的 `resBails()` 判定加回 `ensure()` 即可。
- **多词续接只认 `title`**：其它键（含未知键）的值仍是单个 token，所以 `zoom=` 之类的多词值用不上；要放开就改 `parseMetaLine()` 里那行 `runOn` 判断。
- **画布上的点击被窗体层吞掉**：iframe 默认 `pointer-events:none`（沙箱无脚本，静态稿无感）。**v0.4.0 选区点亮时会临时改成 `auto`**，退出时还原 —— 所以选区模式下的点击被选区接管，退出后仍由窗体层吞掉。阶段 L 上真交互时要改成转发点击（client.js 里 ponytail 注释标了位置）。
- **滚轮被劫持**：光标在画布上时滚轮属于缩放（用户已接受）；滚聊天页移出块即可。**选区点亮时滚轮改为切层**（`preventDefault`，不会同时缩放）—— 这是刻意的，见上。
- **选区焦点**：点亮选区会把焦点移进 iframe（方向键需要）；再点图标退出后焦点不主动还回 composer。
- **选区依赖同源**：`sandbox` 去掉 `allow-same-origin` 会让选区整体失效（`contentDocument` 变 `null`，会提示"画布还没准备好"）。
- 计划卡片内的块走同一套 primitives，预期同样生效，但**本次未单独验证**（试点范围是聊天消息）。
- 交互回流（点击经 HTTP 桥 `agent.steer`）是计划的阶段 L，本次未做。**沙箱自 v0.4.0 起是 `allow-same-origin`**（见「沙箱」节）。
- **分段块仍无脚本**（2026-11-04）：`script-src 'none'` + sandbox 没有 `allow-scripts`，分段只解锁"同源可读样式/字体/图片"这一件事；要交互还得走阶段 L。
- **分段块不能引外网**：`img-src` / `font-src` 只含 `'self' data: blob:`，`https://…` 的图与字会被 CSP 拦掉并在控制台报错——这是刻意的，不是待修的 bug。
- **跨源即失去选区**：分段块是**同源文档**（`/ui-blocks/<name>` 与页面同源），所以选区照旧可用；若哪天把 `src=` 指向别的主机或本地 dev server，`contentDocument` 就是 `null`，选区整体失效——这也是计划里"不做 `src=` 指向 dev server"的一半原因。
- **大 base64 段让历史变肥**：版本历史是行级补丁，一次大段改动就是一条大补丁，单段 256 KB 的上限就是兜住它。本轮未单独给 `recordNow()` 计时；若哪天真超 100 ms，就加"超过 128 KB 的段不进历史、只留最新"的规则。
