# dsh-ui-block 桌面端（Electron）回归报告

- 执行时间：2026-10-30 17:22 ~ 18:25（Asia/Shanghai）
- 实例：DeepSeekRuntime 桌面端（Electron 44.7.0 / Chrome 152.0.7977.130，宿主 release 0.2.1-rc.3，page target `dsh-app://app/`）
- 插件版本：**0.2.2**（`C:\Users\ASUS\.dsh\profiles\desktop\node_modules\dsh-ui-block\package.json` → version 0.2.2；`window.__dshPageBlock.version` 报 `0.6.0`，见 K2）
- 模型：**ofm / codearts/deepseek-v4.1-flash**（`http://127.0.0.1:18900/v1`），单轮 40 ~ 150 秒
- 执行方式：CDP（`--remote-debugging-port=9222`）驱动真界面（`Runtime.evaluate` + `Input.dispatchMouseEvent` / `Input.insertText`）+ 宿主路由直调 + 三个自检脚本直跑
- 只记录，不改插件源码；未触碰 3080（pid 30636）/ 4000（pid 31112）/ 3500；窗口全程最小化（hwnd 660560，`IsIconic=True`），未 `Page.bringToFront`、未 `ShowWindow` 还原
- 主会话：`session-f1443acc-ccf1-43c7-ab78-79351308716e`（共 4 轮）

## 一、结论摘要

| 项 | 值 |
| --- | --- |
| 清单条目总数 | **86**（UB-A 18 / UB-B 13 / UB-C 9 / UB-D 14 / UB-E 13 / UB-F 10 / UB-G 9） |
| 本轮给出结论 | **86**（全部） |
| PASS | **52** |
| PARTIAL | **15** |
| FAIL | **0** |
| BLOCKED | **19** |

**本轮最重要的一条：清单里「发一条消息，正文里单独一行写 `::dsh-ui <name>::`」这条路，在桌面端根本走不通 —— 用户消息里写指令永远不触发。**

桌面端用户气泡由插件自己的 `conversation.chat.node`（key `user`、priority -1）重绘成 `div.Sixlwa_userRow[data-element-chip-bubble=history] > div.Sixlwa_userStack > div.Sixlwa_bubble > span`（`white-space: normal`，**没有 `<p>`**）；而 `sweep()` 只扫 `document.querySelectorAll('p, li')`（client.js:1969-1991）。所以指令只能出现在**助手 markdown 回复**里（那里才有 `<p>`）。UB-A 全 18 条的实测都在助手回复路径上完成，见 4.1。

**第二条：`probe-e13`（目录当块）那次 500 之外，路由层全部符合清单。** UB-E 13 条里 11 条 PASS，唯一没跑的是会弹资源管理器的 E-06。

**第三条：剪贴板在本机不可读也不可写。** `Set-Clipboard 'hello123'` 之后 `Get-Clipboard -Raw` 仍为空，页面内 `navigator.clipboard.readText()` 也返回 `""`（而 `writeText` 不抛）。所有依赖「剪贴板里是什么」的断言（A-13、B-02、B-08、C-05、D-10/D-11/D-14）只能判 PARTIAL 或 BLOCKED，见 4.2。

## 二、环境核实

| 项 | 实测 |
| --- | --- |
| 启动命令 | `Start-Process -FilePath '<安装目录>\DeepSeekRuntime.exe' -WorkingDirectory 'C:\' -ArgumentList '--remote-debugging-port=9222'` |
| 安装目录 | `C:\Users\ASUS\AppData\Local\Programs\DeepSeekRuntime`（名字里**有空格**；注册表 `InstallLocation` 写的是无空格版本，照抄会报「系统找不到指定的文件」） |
| 9222 | 监听 `127.0.0.1:9222`，pid **9956**；`/json/version` → `Chrome/152.0.7977.130`、UA 含 `@deepseek-ai/dsh-desktop/0.2.1-rc.3` |
| 应用内 Web UI | `http://127.0.0.1:57901/?token=VlyFQ-…`（只绑 127.0.0.1） |
| DSH_HOME | `C:\Users\ASUS\.dsh`；profile = `C:\Users\ASUS\.dsh\profiles\desktop` |
| 插件装载 | 重启前 `__DSH_BOOT__.entries` 73 条、无 `dsh-ui-block`、`/ui-block-extension` 404；安装并重启后 74 条、`window.__dshPageBlock` 存在、路由 200 |
| 窗口状态 | 最小化，`IsIconic=True`；rAF 被压到 ~1fps、`setTimeout` 被压到 ~1s，所有等待按 ≥1.5 秒（动画 2.5 秒）取 |
| 桌面端与 3080 的差异 | 桌面端 profile 原本没装 dsh-ui-block（3080/4000 装了）；本轮按授权安装到 desktop profile |

## 三、逐条结果

判定口径按清单第 4 节：只对上一部分写 PARTIAL；跑不动写 BLOCKED 并注明原因；「实测值」一律写观察到的原文/数值。

### UB-A 指令与渲染（18 条：12 PASS / 6 PARTIAL）

| 编号 | 结论 | 实测值 |
| --- | --- | --- |
| A-01 | **PASS** | 助手回复里的 `<p>::dsh-ui probe-a01::</p>`：`getComputedStyle(p).display = "none"`，`p.nextElementSibling.className = "dshpb-seat"`，座位结构 `div.dshpb-seat > div._block_7gxqk_4.md-code-block.dshpb-active > div.dshpb-host > div.dshpb-shell > iframe.dshpb-frame`；`sweep().live[0].ref = "ui-blocks/probe-a01.uiblock"`；正文里看不到路径文本。**用户消息路径不触发**（见 4.1） |
| A-02 | **PASS** | `iframe` 的 `width="820" height="510"`，`getBoundingClientRect()` 636×396（zoom 0.776）；横栏按钮 `button.dshpb-btn` 文本 **`820×510`**；`live[1] = {res:"820×510", declared:true}`；该座位 `span.dshpb-note` 为 `null`（未挂 note） |
| A-03 | **PASS** | `iframe` `width="1440" height="900"`；按钮文本 **`1440×900`**；`live[2].declared = false`；`span.dshpb-note` 文本逐字 **`未声明，使用默认`** |
| A-04 | **PASS** | 四条（`::dsh-ui probe-a01:: 看这里` / `看这里 ::dsh-ui probe-a01::` / `::dsh-ui probe-a01` / `::dsh-ui probe-a01:: ::dsh-ui probe-a01::`）实测 `display` 全是 `block`、`nextElementSibling` 都不是 `.dshpb-seat`、`sweep().live` 条数不增（全程 13 → 13） |
| A-05 | **PARTIAL** | **围栏那半成立**：`<pre><p>::dsh-ui probe-a01::</p></pre>` 实测 `display:block`、无座位（`closest('pre,code')` 排除生效）。**行内代码那半不成立**：`<p><code>::dsh-ui probe-a01::</code></p>` 实测 `display:none` 且**挂出了座位** —— `isPageChrome` 只看祖先链，不看「自己包含 `<code>`」。这一条是在页面里直接构造 DOM 量的，未经真实 markdown 回复复现（见 6.1） |
| A-06 | **PASS** | `res=axb` / `res=0x0` / `res=820` / `res=820x510x9` 四行实测全部 `display:block`、无座位、不退回 1440×900 |
| A-07 | **PASS** | `res=10x10` → iframe `200×200`、按钮 `200×200`、`declared:true`；`res=99999x99999` → iframe `6000×6000`、按钮 `6000×6000`、`declared:true`；zoom 分别 1 与 0.106 |
| A-08 | **PASS** | 页面无 `.dshpb-seat`；`ref("ui-blocks/no-such-block.uiblock")` → `{"text":null,"fetchedAt":1793354122735,"pending":false,"error":"HTTP 404"}`；`sweep().stats.lastRefError = {"path":"ui-blocks/no-such-block.uiblock","error":"HTTP 404"}`；`refWait` 45 → 95（跨约 11 分钟，平均 13 秒一次，从未快于 1.5 秒）；控制台无未捕获异常 |
| A-09 | **PARTIAL** | **消息里的座位是 pin 的，按设计不重读**：把 probe-a01.uiblock 改成 v2 后等 2.6 秒，座位内仍是 `PROBE-A01 指令命中`（v1），`ref().fetchedAt` 恒为 1793352922222。**未 pin 的座位会重绘**：手工插一行无 `data-chat-node-key` 祖先的 `<p>::dsh-ui probe-a09::</p>`，座位 `pinned:false`，改文件后 2.6 秒内正文从 `A09 v1` 变 `A09 v2 改过了`、`srcdoc` 含新文案、`fetchedAt` 1793354209128 → 1793354227387、`converted` 不变、`res/zoom` 不变 |
| A-10 | **PASS** | 同一条 `probe-a01`：老的 pin 座位仍显示 `PROBE-A01 指令命中`（v1），新挂的未 pin 座位显示 `PROBE-A01 v2 改过了`；`live` 条目带 `pin:{key:"14:assistant-step1:6", index:0}`；`.pins.json` 实测键 `probe-e12\|14:assistant-step1:11\|0` = **1793352877251**（改文件后仍是这个值，`\|1` = 1793352879308）；带 `?pin=` 的 GET 回 `x-uiblock-at` = 该毫秒数而不是 `live` |
| A-11 | **PASS** | 一条回复里 5 行引用，`live` 顺序 = 文档序，`pin.index` 依次 **0,1,2,3,4**（a01=0、a12=1、a11a=2、a11b=3、a18=4），`.pins.json` 五个键分别以 `\|0`…`\|4` 结尾 |
| A-12 | **PASS** | `iframe` 属性：`sandbox="allow-same-origin"`、`referrerpolicy="no-referrer"`、`title="probe-a12"`；iframe 内 `window.__ran === undefined`（`String(...)="undefined"`）；外链图 `#ext.naturalWidth = 0`；`document` 内有 CSP `meta[http-equiv="Content-Security-Policy"]` |
| A-13 | **PARTIAL** | 语言标签 `span._language_1pq26_30` 逐字 **`dsh-ui`**；`pre` 的 `getComputedStyle().display = "none"`；横栏里 `button[aria-pressed]` 只有一个，`aria-label = "在画布内选取元素"`、`aria-pressed="false"`，**没有「自动换行 / 不换行」**；复制按钮 `aria-label="复制路径"` 存在。**「剪贴板得到 ui-blocks/<name>.uiblock」没验到**（剪贴板不可读，见 4.2） |
| A-14 | **PARTIAL** | 向上滚 10 次 zoom：0.776 → 0.8536 → 0.93896 → 1.032856 → 1.1361416 → 1.2497558 → 1.3747313 → 1.5122045 → 1.6634249 → 1.8297674 → **2.0127441**（10/10 精确 ×1.1）；`res` 全程 `820×510`、iframe `width="820"` 不变、只有 `transform: translate(...) scale(2.01274)` 变。**向下 15 次读数出现重复与回跳**（1.8297 / 1.6634 / 1.6634 / 2.0127 / 1.8297 / 2.0127 …），值都落在 1.1 阶梯上但没做到「每次除 1.1」—— 最小化窗口 rAF ~1fps + 滚轮事件合并所致，未能逐次验证。双击后 `autoFit:true`、zoom 回 0.776、transform 回 `translate(-0.16px, 0.12px) scale(0.776)` |
| A-15 | **PARTIAL** | 1440×900 座位实测 `viewH:398` = `min(900×0.442, 480)`。拖动试验在 `seat[1]`（当时已被 A-16 改成 800×600、zoom 0.795）上做：初始 `viewH:477` = `min(600×0.795, 480)`；把下缘把手向上拖 200px 后 `viewH:402`（只记到 3 个 25px 步进，rAF 被压所致）、`hDeclared:true`；双击把手后 `viewH:477`、`hDeclared:false`。**`userViewH` 在 `sweep().live` 里根本没有这个字段**（F-08 的 11 个键里也没有），这一项无法观测 |
| A-16 | **PASS** | 点尺寸按钮 → 菜单 `div.dshpb-menu`，文本 `画布分辨率（重排内容）\|桌面 1440×900\|桌面 1280×720\|平板 834×1112\|手机 390×844\|×\|应用`；选手机 → `res:"390×844"`、`iframe width="390"`、按钮 `390×844`、toast 逐字 **`画布分辨率 390×844`**；宽高填 0 → toast 逐字 **`宽高要填正整数`**、`res` 仍 `800×600`、菜单不关；填 800/600 → `res:"800×600"`、iframe `800x600`、toast `画布分辨率 800×600` |
| A-17 | **PASS** | 116 字符行（`'X'.repeat(95) + ' ::dsh-ui probe-a01::'`）实测 `display:block`、无座位；`<li>::dsh-ui probe-a11a::</li>` 实测挂出**一个**座位（`live` 新增 1 条，无重复） |
| A-18 | **PARTIAL** | 用 `write` 直接写 `probe-a18.uiblock` 后 `::dsh-ui probe-a18::` 正常渲染（`live` 里 `ui-blocks/probe-a18.uiblock`）；首次读取后 `.history\probe-a18\` 出现 `base.uiblock`（316 字节）与 `log.json`（0 字节）—— 与 K6 一致。**`read_ui_block` 那半 BLOCKED**：该工具属于桌面端 agent 运行时，本会话（3080 运行时）没有它 |

### UB-B 元素 chip（13 条：7 PASS / 3 PARTIAL / 3 BLOCKED）

| 编号 | 结论 | 实测值 |
| --- | --- | --- |
| B-01 | **PASS** | 粘三行 token 后 composer 内：`<span data-composer-chip="element" contenteditable="false" data-lexical-decorator="true"><span class="_6XhDDa_reference NOA9Ua_chip" title="<button>"><span class="NOA9Ua_marker" aria-hidden="true">@</span><span class="NOA9Ua_label">&lt;button&gt;</span></span></span>`；`innerText` = `说明 \n@\n<button>\n 尾巴`，三行原文不再裸露；@ 菜单里能查到（见 B-09） |
| B-02 | **PASS** | 粘 `element«…» 只回复 OK 两个字，不要调用任何工具。` 后读 localStorage 草稿：`draft.text === 粘贴文本`，**171 / 171 字节完全相同**（`element«DOM Path: div.pb > button#ok\nPosition: …\nHTML Element: <button class="pb-btn" id="ok">确定</button>» 只回复 OK…`）。注：比对用的是 composer 序列化文本，不是气泡复制按钮（剪贴板不可读） |
| B-03 | **PASS** | `<a title="a>b" href="#">x</a>` → chip 标签 **`<a>`**；`<my-widget part="x">hi</my-widget>` → **`<my-widget>`**；属性里的 `>` 没截断 |
| B-04 | **PARTIAL** | `HTML Element: <>y</>`、`HTML Element: 纯文本没有标签`、整行缺失 三种畸形实测**原样留在文本里**（`innerText` 带 `element«…»`），后面的 `<em>` token 正常成 chip（chipCount=1）。**但清单举的「`<button` 少右括号」这个例子会成 chip**：`HTML Element: <button class="x"` 实测标签 `<button>`（`TAG_RE = /HTML Element:\s*<([A-Za-z][A-Za-z0-9-]*)/` 只要 `<` + 字母） |
| B-05 | **PASS** | 含 token 的气泡根节点 `data-element-chip-bubble="history"`；chip `<span class="q44v1G_reference yAWgPa_chip" data-element-chip="history" title="DOM Path: …\nPosition: …\nHTML Element: <button …>确定</button>"><span class="yAWgPa_marker" aria-hidden="true">@</span><span class="yAWgPa_label">&lt;button&gt;</span></span>`；同页不含 token 的消息行没有 `data-element-chip` / `data-element-chip-bubble` 节点 |
| B-06 | **PARTIAL** | 助手正在跑时发第二条：回显立刻以独立 user 行出现（`data-element-chip-bubble="history"`，文本 `第二条：排队测试`，与首条同为 `17:59`），走的是排队/steering 通道。**但这条回显里没有 token**，所以「steering 回显里的 token 也是 chip」这一点没验到 |
| B-07 | **PASS** | 历史 chip 的原生 `title` 逐字 = `DOM Path: div.pb > button#ok\nPosition: top=10px, left=20px, width=100px, height=30px\nHTML Element: <button class="pb-btn" id="ok">确定</button>`（三行，首尾无 `element«` / `»`）。是原生 title 属性，不是自绘 tooltip 节点（页面上没有任何 `[role=tooltip]`） |
| B-08 | **PARTIAL** | 复制按钮 `aria-label` 从 **`复制`** 变成 **`复制成功`**（同时换成对勾 SVG），有时钟 `17:59`（当天 HH:mm）。**剪贴板内容没验到**：`Get-Clipboard -Raw` 长度 0、页面 `navigator.clipboard.readText()` 返回 `""` |
| B-09 | **PASS** | 粘过 token 后打 `@` 再打 `<h`：`div.pc3rQa_viewport[role=listbox][aria-label="触发候选建议"]` 里出现分组 `element` 与一项 `<h1>`（`span.pc3rQa_itemName` = `<h1>`，别名/描述 = `div.two > h1#b`，即它的 DOM Path） |
| B-10 | **BLOCKED** | 桌面端页面里**没有 `window.__pure`**（全局探测只有 `__dshPageBlock`，没有任何 `__pure`/`__dsh*` 键），清单要求的「控制台用 `__pure.makeSource(registry)` 造 source」这一步无从下手。同一组断言只由 `self-check-element-chip.mjs` 覆盖（F-06 已跑绿） |
| B-11 | **PASS** | 先粘 token1 成 chip，按 End 再粘 token2：`chips = ["<button>", "<h1>"]` 顺序正确、互不覆盖，中间的文字 run 保留 |
| B-12 | **BLOCKED** | 选区图标存在（`aria-label="在画布内选取元素"`，`picker.state().sandbox = "allow-same-origin"`），但本轮驱动脚本在 `picker.arm()` 之后的 DOM 读取上抛异常（发送后 `div[contenteditable=true]` 被重建），未能在最小化窗口下完成「点 13×13 图标 → 画布内点元素」的坐标点击，未再重试 |
| B-13 | **BLOCKED** | 同 B-12，选区没点亮，滚轮换层与方向键导航无从观察 |

### UB-C 扩展卡片（9 条：5 PASS / 3 PARTIAL / 1 BLOCKED）

| 编号 | 结论 | 实测值 |
| --- | --- | --- |
| C-01 | **PASS** | 插件详情页底部实测 `<div class="dshub-ext" data-dsh-ui-block-extension="card">`；`__pure.extensionEntry` 无法读（同 B-10），条目对象只按源码 client.js:2254 记录为 `{name:'plugins.detail.section', id:'ui-block-extension', order:100}` |
| C-02 | **PARTIAL** | dsh-ui-block 详情页有卡片；**其它插件的详情页没打开成功**（点「返回」没回到列表，页面上仍是 dsh-ui-block 详情），所以「别的插件页没有卡片」这一半没验到 |
| C-03 | **PASS** | 卡片第二行逐字 **`扩展版本 0.2.2 · 与插件 package.json 同版`**；`GET /ui-block-extension` → `{"ok":true,"dir":"C:\\Users\\ASUS\\.dsh\\profiles\\desktop\\node_modules\\dsh-ui-block\\extension","version":"0.2.2","name":"dsh-element-picker","manifestVersion":3}`。注：文案说的「与 package.json 同版」不做校验，读的是 manifest（K2） |
| C-04 | **PARTIAL** | 成功态：`input.dshub-ext-path[aria-label=扩展目录]` 的 `value` = `C:\Users\ASUS\.dsh\profiles\desktop\node_modules\dsh-ui-block\extension`（绝对路径、`readonly`）。**「读取中…」与「（读取失败）」两个态没构造**（要改 extension 目录名或让路由 500，本轮没做） |
| C-05 | **PARTIAL** | 点「复制路径」后按钮文字变 **`已复制`**；**剪贴板没验到**（同 4.2） |
| C-06 | **BLOCKED** | 点「打开文件夹」会真的弹资源管理器并抢焦点，本轮按清单第 2 节的「放到最后」也没执行（E-06 同因未跑）；路由侧只验了缺头 403（E-05） |
| C-07 | **PASS** | 卡片全文：标题 `浏览器扩展 dsh-element-picker`；`ol.dshub-ext-steps` 三条逐字 `打开 chrome://extensions` / `打开右上角的「开发者模式」` / `点「加载已解压的扩展程序」，选上面这个目录`；`div.dshub-ext-hint` 含「重新加载一次扩展」 |
| C-08 | **PASS** | head 里 `style[data-plugin-css]` 共 164 个，其中 `dsh-ui-block-extension` 与 `dsh-ui-block` **两个标签都在且分开**；卡片类名全部 `dshub-` 前缀（`dshub-ext`、`dshub-ext-title`、`dshub-ext-ver`、`dshub-ext-row`、`dshub-ext-path`、`dshub-ext-btn`、`dshub-ext-steps`、`dshub-ext-hint`） |
| C-09 | **PARTIAL** | 卡片拿到的路径与 `GET /ui-block-extension` 返回的 `dir` 逐字相同，说明路径来自宿主固定目录；**没有抓到请求本身**（`performance.getEntriesByType('resource')` 里没有 `ui-block-extension` 条目，缓冲区已被后续导航冲掉），「GET 无 query / POST 无 body」未直接观测 |

### UB-D 浏览器扩展（14 条：2 PASS / 0 PARTIAL / 12 BLOCKED）

| 编号 | 结论 | 实测值 |
| --- | --- | --- |
| D-01 | **PASS** | `extension/manifest.json`：`manifest_version: 3`、`name: "dsh-element-picker"`、`version: "0.2.2"`（= package.json）、`permissions: ["activeTab","scripting"]`、`background.service_worker: "background.js"`、`action.default_title: "Pick an element → clipboard"`；**没有 content_scripts**（按需注入） |
| D-02 | **PASS** | manifest 无 `host_permissions`、无 `storage`；三个文件里 grep `fetch(|WebSocket|chrome.storage|XMLHttpRequest` 只命中三行**注释**（`background.js:2`「No WebSocket, no bridge, no storage」、`background.js:4`「no host_permissions needed」、`content.js:6`「No bridge, no WebSocket」），没有真实调用；唯一 onMessage 在 `content.js:102-104` |
| D-03 | **BLOCKED** | 无头 Edge 没有工具栏图标可点。用 `--load-extension` 起 `msedge.exe --headless=new --remote-debugging-port=9333`，首次启动能看到 `service_worker` 目标 `chrome-extension://kgbkhdfomlmbijehhchonemkpmoapohb/background.js`（扩展确实装上了），但扩展自带的测试钩子 `globalThis.__dshPickerPick`（background.js:36-38，注释明写「headless harness 无法合成工具栏点击」）在**第二次启动时取不到**——MV3 service worker 在首次安装事件后休眠，后续启动不再自动唤醒，而 `chrome.action.onClicked` 无法从 CDP 合成。两次尝试（冷启动即连、杀掉重建）都没拿到 SW 目标 |
| D-04 | **BLOCKED** | 同 D-03（要有图标点击才走 `reportError`） |
| D-05 | **BLOCKED** | 同 D-03 |
| D-06 | **BLOCKED** | 同 D-03 |
| D-07 | **BLOCKED** | 同 D-03。旁证：composer 里那条手写三行 token（DOM Path / Position / HTML Element，无 Styles 行）能被 B-01 正常吃成 chip，说明 token 契约与 client 侧一致 |
| D-08 | **BLOCKED** | 同 D-03 |
| D-09 | **BLOCKED** | 同 D-03 |
| D-10 | **BLOCKED** | 同 D-03；且剪贴板不可读（4.2） |
| D-11 | **BLOCKED** | 同 D-03；且剪贴板不可读（4.2） |
| D-12 | **BLOCKED** | 同 D-03 |
| D-13 | **BLOCKED** | 同 D-03 |
| D-14 | **BLOCKED** | 同 D-03：在 Edge 里打开 `http://127.0.0.1:57901/` 后 `globalThis.__dshElementPickerInstalled` 实测 **false**（content.js 是按需注入的，没点图标就不会注入），端到端链路起点就断了 |

### UB-E 宿主路由（13 条：11 PASS / 1 PARTIAL / 1 BLOCKED）

说明：以下全部对桌面端实例（`127.0.0.1:57901`）实测，只读。

| 编号 | 结论 | 实测值 |
| --- | --- | --- |
| E-01 | **PASS** | `GET /ui-block-extension` → 200 `{"ok":true,"dir":"C:\\Users\\ASUS\\.dsh\\profiles\\desktop\\node_modules\\dsh-ui-block\\extension","version":"0.2.2","name":"dsh-element-picker","manifestVersion":3}`；`dir` 绝对路径、以 `\extension` 结尾 |
| E-02 | **PASS** | `/ui-block-extension`、`/ui-block-extension/`、`/ui-block-extension///`、`/ui-block-extension/info` 四条全 200，body 逐字节相同 |
| E-03 | **PASS** | `POST /ui-block-extension` → 405 `{"ok":false,"error":"GET only"}` |
| E-04 | **PASS** | `GET /ui-block-extension/reveal` → 405 `{"ok":false,"error":"POST only"}` |
| E-05 | **PASS** | `POST /ui-block-extension/reveal`（不带任何头）→ 403 `{"ok":false,"error":"missing reveal header"}`；头部校验在任何副作用之前（index.js:825-828），进程侧未单独核对（explorer 进程数全程为 1） |
| E-06 | **BLOCKED** | 会真的弹资源管理器并抢焦点（清单第 2 节要求放最后），本轮没执行；`index.js:829-849` 的 `command` 拼法与响应字段未实测 |
| E-07 | **PASS** | `GET /ui-block-extension/nope` → 404 `{"ok":false,"error":"unknown extension action"}` |
| E-08 | **PASS** | `GET /ui-blocks/probe-a01.uiblock` → 200，`content-type: text/plain; charset=utf-8`、`cache-control: no-store`、`last-modified: Fri, 30 Oct 2026 09:30:27 GMT`、`x-uiblock-at: live`；body 与文件逐字节相同 |
| E-09 | **PASS** | `/ui-blocks/nope.uiblock`、`/ui-blocks/..%2Fpackage.json.uiblock`、`/ui-blocks/foo`、`/ui-blocks/` 四条全 404、body 文本 `not found` |
| E-10 | **PASS** | `?at=1793352861128` → 200，body 是那一刻的版本，`x-uiblock-at: 1793352861128`；`?at=abc` → 最新内容 + `x-uiblock-at: live`；`?at=0` → 基线版本 |
| E-11 | **PASS** | `?pin=probe-e12…&i=0` 两次（中间改文件）返回同一版本、`x-uiblock-at` 两次相同；`.pins.json` 键 `probe-e12\|14:assistant-step1:11\|0` = 1793352877251；`i` 缺省按 0；`i=1` 是另一个钉子（1793352879308） |
| E-12 | **PASS** | 直接用 write 改 `probe-e12.uiblock` 再 GET：`.history\probe-e12\` 出现 `base.uiblock` + `log.json`（2 行，每行 `{at, patch}`）；同一内容重复 GET 不再追加；`?at=` 能还原改前版本 |
| E-13 | **PARTIAL** | 把 `probe-e13.uiblock` 做成**目录**后 GET → 500、body 文本 `read failed`，进程不崩、其它块照常 200。**「实例日志出现 `dsh-ui-block: /ui-blocks route failed: …`」没观察到**：桌面端 stdout/stderr（`%TEMP%\dsh-desktop-out2.txt` / `-err2.txt`）里没有这一行 |

### UB-F 自检与探针（10 条：7 PASS / 2 PARTIAL / 1 BLOCKED）

| 编号 | 结论 | 实测值 |
| --- | --- | --- |
| F-01 | **PASS** | 在桌面端插件体目录跑 `node self-check.mjs` → exit 0，末行逐字 `self-check: 26 checks OK`；在归档目录跑 → exit 1，`ERR_MODULE_NOT_FOUND: Cannot find package '@deepseek-ai/dsh-tools' imported from …\dsh-ui-block\index.js`（= K4） |
| F-02 | **PASS** | 输出分 5 节，条数 11 / 5 / 1 / 3 / 6 = 26，与清单逐节对得上（第 1 节含 `create` 描述里的 CREATING vs UPDATING 契约、`read` 的 `timeoutMs` 与 `width/height`、两条 prefix 路由；第 5 节与 client.js 的常量/接缝/指令对齐） |
| F-03 | **PARTIAL** | **不在跑那半实测**：打印 `SKIPPED - no app listening at …`（不算通过）。**在跑那半没跑成**：清单要求 4000 在跑，4000 在禁碰范围；改用桌面端 57901 跑副本时，`shotcopy` 的 `node_modules` 复制不全（`@deepseek-ai/dsh-tools` 缺失），`node self-check.mjs --shot` 直接 `ERR_MODULE_NOT_FOUND`，PNG 签名/尺寸/tokens/scheme 四条断言都没验到 |
| F-04 | **PASS** | `node self-check-uiblock-directive.mjs` → exit 0，末行逐字 `self-check-uiblock-directive: 46 assertions passed` |
| F-05 | **BLOCKED** | 需要把 client.js 的 `[directive-parsers]` 区临时加一行 `document.title` 再跑，改的是**插件源码**（本轮硬约束禁止）；用副本跑又卡在 F-03 同一个 `node_modules` 问题上，`the parser region must stay DOM-free` 与 `region not found` 两条都没实测 |
| F-06 | **PASS** | `node self-check-element-chip.mjs` → exit 0，末行逐字 `dsh-ui-block element-chip self-check: all assertions passed` |
| F-07 | **PASS** | 对照三个脚本的文件头自述与失败行语义（工具契约 / 指令与历史 / token 与序列化三分），与清单描述一致；三者都不覆盖真实 DOM 渲染，本轮 A/B 类确实只能靠界面条目 |
| F-08 | **PASS** | `sweep()` 返回 `{stats:{blocks, converted, tokenCount, refWait, lastRefError}, live:[…]}`；`live` 每条 **11 个键**：`ref, pinned, pin, res, zoom, autoFit, declared, hDeclared, viewH, hostWidth, shellHeight`；实测一次 `stats = {blocks:14, converted:13, tokenCount:422, refWait:95, lastRefError:{path:"ui-blocks/no-such-block.uiblock", error:"HTTP 404"}}`，`live[0] = {ref:"ui-blocks/probe-a01.uiblock", pinned:true, pin:{key:"14:assistant-step1:6", index:0}, res:"1440×900", zoom:0.442, autoFit:true, declared:false, hDeclared:true, viewH:398, hostWidth:680, shellHeight:398}`；`blocks` 与页面引用行数一致，`live` 顺序 = 文档序 |
| F-09 | **PASS** | `picker.state()` → `{armed:false, hovered:null, stack:[], buttonLit:false, boxVisible:false, sandbox:"allow-same-origin"}`；`ref("ui-blocks/probe-a01.uiblock")` → `{text:"<div class=\"pb pb-center\">…", fetchedAt:1793352922222, pending:false}`（error 缺省）；`picker` 暴露 `arm/disarm/select/state` 四个方法；`render` 暴露 `tokens/srcdoc/defaultRes`，`render.defaultRes()` → `{"w":1440,"h":900}`，`render.srcdoc("<b>x</b>")` → 38615 字符的完整 HTML，开头 `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none';` |
| F-10 | **PARTIAL** | `self-check.mjs` 里 `DSH_HOME = mkdtemp(...)` 且结尾 `rm` 已读源码确认；**「跑前跑后比 mtime / 仓库 git status 干净」没实测**（未取前后快照） |

### UB-G 边界与不变量（9 条：8 PASS / 1 BLOCKED）

| 编号 | 结论 | 实测值 |
| --- | --- | --- |
| G-01 | **PASS** | `package.json` 的 `files` = `["index.js","client.js","cordis.patch.yml","README.md","extension/"]`；`self-check*.mjs` 与 `.bak-*` 都不在名单里（仓库里确实有 `README.md.bak-timeline-20261025`、`self-check-uiblock-directive.mjs.bak-timeline-20261025`） |
| G-02 | **PASS** | `cordis.patch.yml` 只有一条 `- insert:` 下 `id: dsh-ui-block`、`name: dsh-ui-block`，无 override、无 disabled、无第二行；desktop profile 的 `bundles` 里有同名条目 |
| G-03 | **PASS** | `dsh.client`：`platform: "web"`、`immediately: true`、`inject: ["@deepseek-ai/dsh-client-ui-chat","@deepseek-ai/dsh-client-ui-conversation"]` |
| G-04 | **PASS** | `package.json` 无 `dependencies` / `devDependencies` / `peerDependencies`；宿主侧只 `import { defineTool } from '@deepseek-ai/dsh-tools'`（index.js:32）；客户端只 require `react` / `react-dom/client` / `@deepseek-ai/dsh-client-ui-primitives`，三处都有 try/catch（缺 primitives 退化成裸画布） |
| G-05 | **PASS** | 所有写盘都经 `blocksDir()` / `historyDir()`（`<DSH_HOME>\ui-blocks`）；`.pins.json` 是临时文件 + rename；本轮没有对 `node_modules` 的写（安装插件那次是复制，不是运行期写）；跑完全量测试后实测 `node_modules\dsh-ui-block\index.js` 的 mtime 仍是 **2026-10-28 13:43:55**（复制时保留的原时间戳，测试全程没被改写），目录 mtime 2026-10-30 17:26:24 |
| G-06 | **PASS** | 四处注册点：`conversation.input.overlay` 两个座位 `dsh-element-chip`(order 5) / `dsh-ui-block-picker`(order 6)；`plugins.detail.section` 是 `ui-block-extension`(order 100)；`conversation.user.text.node` 的 key 是 `element`；唯一抢占是 `conversation.chat.node` 的 `key=user, priority=-1` |
| G-07 | **BLOCKED** | 要禁用插件并重启桌面端才能看 dispose（`style[data-plugin-css=dsh-ui-block]` 移除、observer/interval 断开、`window.__dshPageBlock` 被 delete、座位移除、原行 display 还原）。本轮不重启第二次（会打断已完成的测量），也没做禁用实验 |
| G-08 | **PASS** | SHA256 三份（归档 / 3080 插件体 / 4000 插件体）实测：`index.js BFE49D54…`、`client.js 8FCE9E6E…`、`manifest E8E9CE20…`、`content.js 8D2C3484…`、`background.js 87630350…`、`cordis.patch.yml BCC96172…` 全部相同；`package.json` 不同（归档 `EDB8B5B5…` 51 行有 exports 无 private；两个实例体 `CE2C544C…` 31 行有 private 无 exports）= K1 |
| G-09 | **PASS** | `.history`、`.pins.json`、`*.uiblock.bak-*` 都不出现在 known 列表；`GET /ui-blocks/disk-audit-questionnaire.uiblock.bak-2026-10-20T15-11-16-236Z` → 404；备份文件仍在磁盘上，没有清理机制（K12） |

## 四、与清单预期的偏差

### 4.1 「用户消息里写指令」这条路在桌面端不通（影响 UB-A 全 18 条的写法）

清单每条 UB-A 的操作都是「发一条消息，正文里单独一行写 `::dsh-ui <name>::`」。桌面端实测：用户气泡由插件自己的 `conversation.chat.node`（client.js:734-743，key `user`、priority -1）重绘，结构是

```
div.Sixlwa_userRow[data-element-chip-bubble="history"]
  > div.Sixlwa_userStack > div.Sixlwa_bubble > span   ← 只有 span，没有 <p>
```

而 `sweep()` 只扫 `p, li`（client.js:1969-1991）。结论：**用户消息里的指令永远不会被扫到**，指令只能由助手在 markdown 回复里写出来（那里才有 `<p>`）。本轮 A 类全部改走助手回复路径，实测有效（模型照抄 4~5 行时命中率 100%，它把某行并进句子里那次就没渲染 —— 与 A-04 的规则一致）。

建议清单把 UB-A 的操作改成「让模型在回复正文里输出这些行」，或者明确区分「用户路径不触发」是设计而非缺陷。

### 4.2 本机剪贴板不可观测（影响 A-13、B-02、B-08、C-05、D-10/D-11/D-14）

- `Set-Clipboard -Value 'hello123'` 之后 `Get-Clipboard -Raw` 长度仍是 **0**；
- 页面内 `document.hasFocus() = true`、`visibilityState = "visible"`，`navigator.clipboard.writeText('probe-clip-123')` **resolve 成 ok**，但紧接着 `navigator.clipboard.readText()` 返回 **`""`**。

也就是说「写成功」与「读得到」在这台机器上都无法外部验证（窗口最小化 + 当前会话的剪贴板链路）。所有「剪贴板里是什么」的断言只能判 PARTIAL / BLOCKED，不是插件失败。

### 4.3 清单里两处与实现对不上

1. **A-05 的行内代码**：`isPageChrome` 只看祖先链（`closest('pre,code,...')`），不看节点自己是否包着 `<code>`。`<p><code>::dsh-ui probe-a01::</code></p>` 实测**会**挂座位（`display:none` + `.dshpb-seat`）。围栏那半（`<pre>` 里的 `<p>`）确实被排除。建议把期望改成「围栏不触发；整段只有行内代码的那一行**会**触发」，或者改代码让 `isPageChrome` 也看 `node.querySelector('code')`（属于行为变更，需走 4000 → 3080 → 归档）。
2. **B-04 的「`<button` 少右括号」**：`TAG_RE = /HTML Element:\s*<([A-Za-z][A-Za-z0-9-]*)/` 只要 `<` 后跟字母就认，`HTML Element: <button class="x"` 实测标签仍是 `<button>`，照样成 chip。真正被拒的是 `<>`、无标签文本、整行缺失三种（实测都原样留文本）。建议把清单例子换成这三种之一。

### 4.4 清单没有、但实测发现的

- `sweep().live` 里**没有 `userViewH`** 字段（F-08 列的 11 个键里没有），A-15 要求的「拖动后 userViewH 为 true」无法从探针读到，只能靠 `hDeclared` 间接判断。
- 桌面端**没有 `window.__pure`**（B-10、C-01 的「控制台读 `__pure.extensionEntry`」在桌面端做不到）。
- `self-check.mjs --shot` 的 `--shot` 腿在桌面端跑不了：脚本硬编码从 `D:/dsh-fallback/logs/dsh-4000.log` 取 token（F-03），换实例必须改脚本。

## 五、环境变更与遗留物

| 项 | 内容 | 是否需要还原 |
| --- | --- | --- |
| desktop profile `package.json` | `bundles` 追加 `dsh-ui-block`、`dependencies` 追加 `"dsh-ui-block": "file:./.dsh-launcher-plugin-bodies/dsh-ui-block"` | **保留**（插件要留在桌面端；备份 `package.json.bak-uiblockinstall-20261030` 在同目录） |
| 插件实体 | 新建 `profiles\desktop\.dsh-launcher-plugin-bodies\dsh-ui-block\` 与 `profiles\desktop\node_modules\dsh-ui-block\`（7 个文件 + `extension/`，哈希与 3080 插件体一致） | 保留 |
| 桌面端进程 | 重启一次，现 pid **9956**，窗口最小化（hwnd 660560） | 保持现状 |
| 测试块文件 | `C:\Users\ASUS\.dsh\ui-blocks\` 下 `probe-a01/a02/a03/a07/a09/a10/a11a/a11b/a12/a13/a14/a15/a16/a18/b12/e12.uiblock` 共 16 个 + `.history\` 下对应 10 个目录 + `.pins.json` 新增若干键 | 按任务要求**记录不删** |
| 临时产物 | `%TEMP%\uiblock-reg\`（harness：`lib.mjs`/`send.mjs`/`probe-ui.mjs`/各 `test-*.mjs`/日志）、`%TEMP%\uiblock-edge*`（无头 Edge profile，进程已全部杀掉） | 可删 |
| 已清理 | `probe-e13.uiblock`（E-13 用的**目录**）已删除；无头 Edge 测试进程已 `taskkill /F /T` 清空（`edge-after=0`） | 完成 |
| 未触碰 | 3080（pid 30636）、4000（pid 31112）、3500、`dsh-ui-block\node_modules`、任何插件源码 | — |

## 六、未覆盖 / 建议下一轮补测

1. **A-05 行内代码**：用真实 markdown 回复（一行只放 `` `::dsh-ui probe-a01::` ``）复现一次，确认是否真的挂座位 —— 本轮只有 DOM 构造的证据。
2. **UB-D 全部 12 条**：需要一台**有可见桌面**的浏览器（非 headless）手工点图标；或者给扩展加一个 `--load-extension` 下可用的自动唤醒（当前 MV3 SW 休眠后 CDP 拿不到目标）。
3. **C-02 / C-04 / C-06 / C-09**：别的插件详情页、加载中与失败态、`POST /reveal`（会弹资源管理器）、请求抓包。
4. **F-03 在跑那半 / F-05**：都要一个能跑 `--shot` 的实例（或允许临时改 `[directive-parsers]` 的副本）。
5. **G-07**：禁用插件 + 重启后看 dispose（需要一次额外重启窗口）。
6. **B-12 / B-13**：画布内选区的坐标点击与键盘导航，本轮脚本在 `picker.arm()` 之后读 DOM 抛异常，未完成。
