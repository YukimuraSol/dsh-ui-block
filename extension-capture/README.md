# dsh-page-capture（浏览器扩展）

把**当前这一页整页**抽成素材包，交给本地 DSH，喂给 `create_ui_block`。

和隔壁 `../extension/`（dsh-element-picker）的区别：**那个取一个元素，这个取整页**。

## 装

1. Chrome/Edge 打开 `chrome://extensions`（Edge 是 `edge://extensions`），开「开发者模式」；
2. 「加载已解压的扩展程序」→ 选这个目录 `extension-capture`；（DSH 侧把该目录从 `.dsh-launcher-plugin-bodies/dsh-ui-block/extension-capture` 提供出来，改完在 `chrome://extensions` 点一次「重新加载」）
3. 点扩展图标（或「扩展程序选项」）配 instance 名；**base URL 可以留空**（留空 = 自动发现，见下一节）。

装完不用再点任何东西：后台每 2 秒轮询一次，DSH 的 `list_pages` 就能看见你开着的标签。

## 两个实测踩过的坑（本机品牌版 Chrome 156.0.8078.80 / Chromium 156.0.8078.4）

1. **`--load-extension` 在品牌版 Chrome 137+ 被直接忽略**：参数照传、扩展没装，只在 stderr 留一句
   `--disable-extensions-except is not allowed in Google Chrome, ignoring.`（今晚踩了第二遍，第一次是「命令行为空」）。
   要在命令行里带扩展跑无头/自动化，只能用**未品牌化的 Chromium**（本机 `D:\OpenCode\playwright-browsers\chromium-*\\chrome-win64\\chrome.exe`）：
   `--headless=new` 照旧可用，`chrome.tabs.captureVisibleTab` 在无头下也能拍到真画面（实测一张 1418×689 / 107 KB 的 PNG）。
   品牌版 Chrome 只能走 `chrome://extensions` →「加载已解压的扩展程序」手动装。
2. **重载扩展不要用 `chrome.runtime.reload()`**（现场结论）：Chrome 156 会把命令行/手动加载的 unpacked 扩展直接禁用——
   之后 API 全失败、日志里是 `did not activate`。正确做法是切一次启用状态：
   `chrome.management.setEnabled(id, false)` → `chrome.management.setEnabled(id, true)`（需要 `management` 权限）。

## 参考截图（reference/viewport.png）

抓完 DOM、切回原标签之前，扩展用 `chrome.tabs.captureVisibleTab` 存一张 PNG 到材料目录的 `reference/viewport.png`。
它**不进块**（`create_ui_block({fromDir})` 会把它列进 `skipped`，理由 `unreferenced`），只用来「块渲染 vs 真页面」对照。

- 只拍**可见区域**：这是 `captureVisibleTab` 的硬限制，没有整页拼接（拼接要 attach `chrome.debugger`，会在页顶挂调试横幅并改动 DOM，明确不做）。所以 `report.screenshot.mode` 恒为 `viewport`。
- `width` / `height` / `dpr` / `scrollY` / `scrollHeight` / `captureViewport` 是**抓取那一刻的视口**，只作参考，**不是目标尺寸**。
  块里固化的 `px` 绑在这个宽度上：实测抽屉 `inset:0 1006.67px 0 0` 在 1340 宽下是 333px、1440 宽下变 433px——
  换宽度就不再等于真站。**想跨宽度都像，只能用相对单位重写布局，那不在抓取这一层。**
- 拍不到时（权限、窗口被遮挡、截图配额）**不重试、不阻塞**：`report.screenshot.error` 照实写一行，抓取照常完成；
  返回文本里是 `REFERENCE VIEWPORT unavailable: <reason>`，不静默。

## 抓取前就被页面摘掉的节点（report.removedNodes）

抓取发生在**页面加载完之后**的某一刻。加载层、骨架层、入场覆盖层这类东西，页面自己的 JS 在这之前就摘掉了——抓取那一刻它们在 DOM 里根本不存在。实测 panel.solyukimura.top：入场靠 JS 加 `.in`，覆盖层 `.lwrap`/`.lbox` 抓取时已经没了；块照静态页做出来，模型连「原来有这么一层」都不知道。

做法：`removed-watch.js` 由 `manifest.json` 以 `content_scripts` + `run_at: document_start` 注入（`<all_urls>`，只顶层文档），装一个 `MutationObserver`，把**被摘掉的元素节点**压进一个有界环（最多 40 条引用，只存引用不算 outerHTML——摘除时序列化等于给页面每次 DOM 操作加一笔）。抓取时 `extractor.js` 读 `globalThis.__dshRemovedWatch`（内容脚本与 `chrome.scripting.executeScript` 同在扩展的 ISOLATED world，共用一个 `globalThis`），序列化最近的那些：

```
report.removedNodes = [{ tag, id, cls, bytes, outerHTMLHead }, …]   // 新的在前，最多 20 条
report.removedNodesTruncated = n                                    // 环里还有 n 条没列出
report.removedNodesNotObserved = true                               // 这一页加载时观察器还没装（扩展旧版/刚装）
```

- `outerHTMLHead` 是序列化后**前 300 字**；`bytes` 是整段序列化的 UTF-8 字节数。要复刻加载层，先从这 300 字里把它长什么样读出来。
- 只报，**不把节点塞回页面**：要不要在块里复刻、用什么动画，是模型在块里该做的决定。`capture_page` 的返回文本因此写一行 `N node(s) were removed from the DOM before this capture: p1, p2, p3`，并给一句「若是加载/骨架层，可以在块里显示并用 CSS 动画模拟，**但必须在差异里说明这是推断**」。
- 死标签（`script`/`style`/`link`/`meta`/`iframe`/… ）不记：它们本来就没有版式形态可复刻。抽取时从副本里摘掉的死标签条数另有字段 `report.deadTagsStripped`——旧版把它错记成 `removedNodes` 那个数字，两者别混。
- 代价与边界：装了这个扩展就会在**每个页面**（含非抓取页面）注入一个观察器，只推环、不做任何 DOM 操作；页面在扩展安装/更新**之前**就已打开的，这一页没有观察器（`removedNodesNotObserved`），重载一次页面即恢复。

## 动画的账：会循环、只播一次、还是根本跑不起来

`countAnimations()` 数的是**落盘后那两份 CSS 原文**（不是抽取时的规则条数——`@keyframes` 全被提到 `shared/app.css`）。同一份 counts 同时进 `report` 与 `capture_page` 的文本：

| 字段 | 口径 |
| --- | --- |
| `animationCount` | `animation` / `animation-*` 声明条数（一条 shorthand 里逗号分隔的多层算 1 条） |
| `infiniteCount` | 原文里带 `infinite` 的声明条数（旧的、只管字面） |
| `oneShotAnimations` | 迭代次数有限、且动画名在产物里找得到的声明条数（没写 `iteration-count` 的默认 1 次，算有限） |
| `infiniteAnimations` | 会真的无限循环的声明条数（有名字且找得到，否则归 dangling） |
| `danglingAnimationNames` | 引用的 `animation-name` 在产物里**没有任何 @keyframes** 的声明条数；名字另列在 `danglingAnimationNameSample`（最多 10 个） |

三个桶互斥：`oneShotAnimations + infiniteAnimations + danglingAnimationNames = animationCount`（除非一条声明既写了 `infinite` 又引用了不存在的 keyframes——那种归 dangling，而 `infiniteCount` 仍按字面算它）。

为什么非要分这三个数：实测那次复刻，模型照抄了 loop 用的 `@keyframes`，却把迭代次数漏成一次，每条只播 7 s、可见运动 238–420 ms，整块看起来是静态的。文本里那行现在长这样：

```
  @keyframes: 26 in shared/app.css, 0 in pages/current/page.css; animations: 49 declarations, 12 with infinite — 37 play once (finite iterations), 12 loop forever (infinite); every animation-name resolves to a captured @keyframes
```

## 配

| 项 | 默认 | 说明 |
| --- | --- | --- |
| base URL | 空（自动发现） | 留空就打发现出来的**每一个**实例；填了就只打它（钉死单个实例，测试时用） |
| instance 名 | 自动生成 `chrome-xxxx` | `tabId` 只在单个浏览器内唯一，对外身份是 `instance + tabId`；插件侧按 instance 名分开记账，**两台浏览器都叫 `chrome` 会互相覆盖清单**，所以每台首次运行各自生成一个 4 位十六进制后缀存进 `instanceId`，之后一直用它。手填仍然优先，留空 = 用自动的那个 |
| 配对码 | 空 | 插件侧 `agent.requireToken` 打开时才需要；填了就以 `?token=` 带上 |
| 上报开关 | 开 | **关掉 = 一个请求都不发**（连轮询都不发），DSH 那边自然看不见它 |

配置存 `chrome.storage.local`，改完立即生效（`storage.onChanged` 会重启轮询），不用重装。

老版本把 `chrome` 写进了 storage 当默认值；这一版把它当"没填"处理（换成自动生成的名字），所以升级后两台浏览器不会因为都叫 `chrome` 而打架。

## 没有配置时怎么找实例（发现）

不写死任何端口。`baseUrl` 为空时按下面三步问一遍，只打回环地址：

1. **登记台**：`GET http://127.0.0.1:38520/instances` → `{ "instances": [ { "port": 4000, "instance": "4000", "bootAt": 1730000000000 } ] }`。
   `port` 是 DSH 实例的 HTTP 端口，`instance` 是实例名（缺省用端口号），`bootAt` 是启动毫秒时间戳（只影响排序）。
   这是**与插件侧约定的候选形状**，插件侧随后落地；台不可达或应答不是这个形状就当没有表。
2. **缓存**：`chrome.storage.local.registryTable` 里上一次拿到的表（台死了直接用）。
3. **本机小范围探测**：`GET http://127.0.0.1:<port>/ui-block-extension/info`，只认应答里带 `captureDir` 的（别的服务也会 200，靠字段确认是 DSH）；端口段 3000–4100、并发 6、**命中即停**。

没有表时最多每 5 秒发现一次（别每 2 秒扫一遍端口）；显式填了 base URL 就完全不发现。

## 多播上报：每个实例都听得到

一轮 poll 打向实例表里的**每一个**实例，各收各的任务，**结果回到发它的那个实例**（不走别的端口）。本机通常 1–3 个实例，2 秒一轮，成本可忽略；新实例启动后一个周期内自动被听到，不用改任何配置。

连续 3 轮**整轮全失败**（所有实例都没应答）才重发现一次——那通常意味着换实例或重启过了。

标签页清单**每 10 秒整份一次，其余轮次只带指纹 `tabsTag`**（`background.js` 的 `TABS_FINGERPRINT_ONLY`）。靠的是插件侧那条语义：poll **没有 `tabs` 字段就沿用上一次的清单**，只有显式 `tabs: []` 才算"这个浏览器现在真的没有标签页"。

三种情况仍旧整份传：① 这个实例第一次被看到（它还没有缓存）；② 指纹变了（开/关标签、跳页、激活切换）；③ 距上次整份超过 10 秒。`lastFullByTarget` 按实例各记一份，所以多播时新加入的实例第一轮就能拿到完整清单。

## 让 agent 自己开一个网址（可选路径）

用户给一个网址、由 agent 起一个带扩展的干净浏览器把它打开、再抓下来——这条链本身是产品的一部分，脚本在 `launch.mjs`：

```
node launch.mjs --url=https://example.com --base-url=http://127.0.0.1:4000
```

固定参数：`--headless=new`（MV3 在旧 headless 里不工作）、独立临时 `--user-data-dir`（每次干净）、空闲 `--remote-debugging-port`。**Chrome 156 起正式版停用了 `--load-extension`**（`--disable-extensions-except` 还会把 CDP 加载的扩展标成「已被屏蔽」），所以扩展改由 CDP 的 `Extensions.loadUnpacked` 加载，启动参数因此带 `--enable-unsafe-extension-debugging` 与 `--remote-allow-origins=*`。

`--base-url` 走确定性路径：打开 `chrome-extension://<扩展ID>/options.html?baseURL=<本实例>`，`options.js` 读到查询参数即写进 `chrome.storage.local`，脚本把**读回值**一并打印。

返回里已经带好下一步要用的那一对：

```json
{ "extensionId": "…", "debugPort": 64023, "storageBack": "http://127.0.0.1:4000",
  "tab": { "instance": "chrome", "tabId": 47032464, "url": "http://127.0.0.1:4000/", "title": "…", "matched": "exact" } }
```

`tab.instance` + `tab.tabId` 直接交给 `capture_page`；拿不到就回 `list_pages` 挑一行（`matched` 说明是精确命中原网址还是重定向后的兜底）。

两条边界：**不碰 cookie、不碰用户自己的浏览器配置**（每次全新临时 profile，用完即弃）；**需要登录态的页面不替用户登录**——那种页面请用户在他自己已登录的浏览器里打开，扩展装过一次就不用再装。

## 端点契约

```
POST {每个实例的 baseUrl}/ui-blocks/agent/poll[?token=…]
  { instance, tabs: [{ tabId, url, title, focused, capturable, reason? }], tabsTag }
  → { task: null } | { task: { id, tabId, includes?, maxBytes? } }   // includes 已废弃，只记录

POST {发任务那个实例的 baseUrl}/ui-blocks/agent/result[?token=…]
  { instance, taskId, ok, files?, report?, error? }
  → { ok: true, dir } | { ok: false, error }
```

字段名固定。相对契约多出三处，都在报告里声明过：

- `tabs[]` 多一个 `capturable`（以及 `capturable:false` 时的 `reason`）——坑 3 要在清单阶段就标出来；
- 两个 URL 支持可选的 `?token=`（配对码，默认不填就不带）；
- poll 的 body 多一个 `tabsTag`（清单指纹，见上一节），插件侧可忽略。

`task.includes` **已废弃**：仍然可以被接收，但只记进 `report.includesIgnored: true` 与 `report.degrade` 的一条说明，不影响抽取。抓取恒定输出 dom + 两份 CSS + 计算样式 + 全部资源落点——同一个页面任何入参产物都一样（原因见 `技术文档.md` 的「includes 废掉」一节：那个 `want()` 开关同时管「输出哪段」和「资源要不要本地化」，一关就产出带 `/static/...` 绝对引用的块）。要压体积用 `maxBytes`。

## 产出形状

```
entry.html                 入口：<link rel="stylesheet" href="./shared/app.css"> + ./pages/current/page.css
shared/app.css             基线（重置 + @font-face + @keyframes），字体引用 ../assets/
pages/current/page.css     本页命中规则（死选择器已丢、站内 var() 原样保留、宿主皮肤 --dsw-* 已固化）+ 元素计算样式清单，引用 ../../assets/
assets/*                   超内嵌上限 1.4MB 的二进制、超 2000px 且降采样后仍超限的图，以及雪碧图/长条图（长宽比 ≥8，原尺寸不降采样）
```

路径一律**段内相对**（`./`、`../`、`../../`），不出现根绝对路径。元素属性里的根绝对 URL 会被改写成原站绝对地址（含 `ng-href`/`:href`/`v-bind:href`/`xlink:href` 这些同一个 URL 的别名；`#片段`、`data:`、`javascript:`、`mailto:`、`tel:` 不动）。单段 2MB、单文件 2MB，与 DSH 侧默认对齐；`data:` 内嵌另有一条更紧的 1.4MB 线（base64 会胀 4/3）。调用方给 `maxBytes` 时，内嵌与计算样式两份预算跟着它缩放。

`report` 记：origin、title、bytes、files[]（每段字节）、dropped[]（**只放真丢**：取不到字节 / 超单文件上限 / 读不到样式表）、spilled[]（改存 `assets/` 的，每条 {url, bytes, path, reason}，搬走不是丢）、notices[]（重编码、摘属性这类既没丢也没落文件的信息行）、规则数与丢弃数、变量解析数、元素数、ancestors（祖先链），以及两份素材账：`assets[]`（每条 URL 的落点 kind/path、字节、取字节通道 `via`、原尺寸 w/h、是否 `downsampled`，`data:` 的 URL 只留前 48 字符）与 `srcsetPicked[]`（响应式图实际取的那档）。`report.bytes` 与 `sum(files[].bytes)` 恒等。

## 资源字节从后台取

内容脚本跑在页面里，取跨域图片/字体受页面的 CORS 限制——logo、app-fold.svg、no-application.png 就是这么 Failed to fetch 的（同一 URL 普通 GET 是 200）。

现在 extractor 只产 URL 清单，字节一律交给 service worker：

```
内容脚本  chrome.runtime.sendMessage({ type: 'dsh-capture-fetch', url })
后台       fetch(url, { credentials: 'include' })   // 带 all_urls 主机权限，不受页面跨域限制
          → { ok: true, base64, mime, bytes } | { ok: false, error }
```

- 单次上限 12MB（跨域样式表那条按 16MB 传，见下一节）、单请求 25 秒超时，超了当场回原因，由 extractor 写进 `report.dropped`；
- 后台并发 4（extractor 侧并发 3，取字节和重编码都在页面里跑，贪多反而抖）；
- 取字节期间每 20 秒摸一次扩展 API（`chrome.runtime.getPlatformInfo`）重置空闲计时器，不让 MV3 的 30 秒回收把一轮抓取截断；
- 没有后台可用时（例如离线自检的宿主页面）退回页面自身的 `fetch`，通道记 `page`。

## 跨域样式表：字节也从后台取，按原位置接回管道

页面读不到 `sheet.cssRules` 的样式表（跨域，抛 SecurityError）过去只记一条 `dropped`，等于这张表里的版式整张丢掉——真实事故是 `pure-drawer.css` 里的 `position/left/transform` 没固化，抽屉停在 `x=-334`，它的 `.drawer-header` 正好盖住左上角图标位（一块空白灰块）。

现在的做法：

1. extractor 先扫一遍 `document.styleSheets`（含 shadow root 里的 `<link>` 与 `adoptedStyleSheets`），挑出读不到 `cssRules` 的那几张；
2. 同一个 `href` 走上面那条后台通道取回**文本**（service worker 带 `all_urls` 主机权限，CORS 不拦它）；
3. 取回的正文用 `CSSStyleSheet.replaceSync` 解析成一张真表，**在那条 `<link>` 原来的位置**接进规则管道——选择器重写、死选择器探针、层叠顺序全走原来那条路，不挪到末尾；
4. 表里的相对 `url()` 与 `@import` 按这张表自己的地址解析；`@import` 递归展开，并按 CSS 规定排在本文之前。

护栏：单条 16MB、`@import` 最多 3 层（成环即止）、只取 `http(s)`、失败重试一次即止。取不到就退回原来那条 `dropped`，**抓取照常完成**（`ok: true`，不因为一张样式表把整次抓取拖死）。

正文先摘掉注释再扫 `@import`：注释里写着 `@import url(...)` 的一句说明，曾经被当成真的 import 去取（多一次 fetch、多一条 404、多一行 `dropped`，实测于真实浏览器的跨域夹具）。

`report.sheetsFetchedViaBackground = { count, items: [{ href, bytes }] }`——没有这个字段 = 这一页没有跨域样式表，或一张都没取回来（那就还是 `dropped` 里那条）。

`report.sheetsFailedItems = [{ href, reason, via: 'background'|'cssom', httpStatus?, bytes? }]`——**每张读不到的表一条**，href 是它的唯一身份：文本里那条 `dropped` 行也点名 href，并直接给一句能照做的指引（接受并在差异里说明，或让用户在该表所在的域上再抓一次）。`report.sheetsFailed` 恒等于这个数组的长度。

`report.atRulesUnsupported = { count, items: [{ type, count, sample }] }`——认不出的 at-rule（`@layer` 语句、`@page`、`@namespace`…）。它**不是**「样式表失败」：没有 href、也不是一张表，绝不计入 `sheetsFailed`（过去计进去过，于是报告喊「1 张表没取到」，模型只能去猜）。

资源四本账按**最终落点**数，自洽：`assetsInlined + assetsSpilled + assetsDropped = assetsTotal = assets.length`，且 `spilled.length === assetsSpilled`。

## 雪碧图与 srcset

- **雪碧图/长条图不降采样**：长宽比 ≥ 8（358×20870 这类）判定为雪碧图，原尺寸落 `assets/`；2000px 单边降采样只用于长宽比正常的大图。
- **srcset / imagesrcset 取最大候选**：不再当垃圾属性删。描述符里 `w` 优先于 `x`，选中档位进资源清单；`img` 用 `src` 承载它，`source` 把 `srcset` 收成一条，`link[rel=preload][imagesrcset]`（元素本身会被删）也会被预先收进清单。

## 三个坑怎么处理

1. **后台标签偷懒**：先 `chrome.tabs.update(tabId,{active:true})`（只在本窗口内切标签，**不置前窗口**，否则抢用户焦点），等 300ms 再注入；抓前记下本窗口原本 active 的 tab，抓完切回。切不过去也照抓，只有页面确实 `hidden` 时才在 report 里记 `hiddenTab: true`。
2. **标签被关掉**：`chrome.tabs.get` 失败 → `目标已消失，请重新 list_pages`，不猜替代品。
3. **永远抓不到的页**：`chrome://` / 扩展页 / 扩展商店 / 内嵌 PDF → 清单里 `capturable:false` + `reason`，任务阶段再挡一次。

## 皮肤不许被抓进块里

只固化**宿主皮肤**：`var(--dsw-*)` / `var(--columbina-*)` 换成字面值、对应声明丢掉；SVG 的呈现属性（`fill="var(--dsw-…)"`）同样处理——3080 的图标就是这个形态，漏了会留下 7 处残留。

**站点自己的自定义属性与 `var()` 一律原样保留**：`--color` 这类令牌大多是逐元素/逐组件声明的（同一页两个按钮的 `--color` 不同），拿一张「文档级全局变量表」去替换，就会把每个元素都写成**别的**作用域的值——真实事故：pintia 考试页「保存」按钮冻结成 `hsl(0,0%,25%)` 灰，真站是 `#3E7EEA`。现在规则里的 `var(--color)` 原样写出去，谁覆盖谁交给浏览器的层叠按元素算；只声明自定义属性的规则（`.pc-active-primary{--color:…}`）也照旧输出，不再被当成空规则丢掉。

对应 `report`：`customPropsKept`（原样输出的站内自定义属性条数）、`varDeclsKept`（原样保留的含 var() 声明条数）、`unresolvedVars`（被引用但产物里找不到声明的令牌名——浏览器会退成 unset）、`varsFromElements[]`（只在某个元素上探到的令牌值，带 `from:'element-probe'` 与 `at:'tag#id.cls'` 出处，**不会**升级成全局单值）。样式表里没有任何规则声明的令牌才由 `:root{…}` 兜底层补值，兜底层放在 page.css 最前，任何声明了同名令牌的规则都会覆盖它。

## 表单活值：值住在 property 里，抓取时写成属性

序列化（`innerHTML` / `outerHTML`）只输出**属性**，表单控件的当前值在 DOM 属性（property）里，抓不到。
真实事故：智云课堂右上角周选择器就是

```html
<input type="text" placeholder="筛选往周课程" class="el-input__inner">
```

真站显示「当前周」（property `value === "当前周"`），抓下来的块是个空框。现在抓取时把活值写回属性：

| 控件 | 写什么 |
| --- | --- |
| `input`（文本类） | `value`，非空才写 |
| `input[type=checkbox/radio]` | `checked`：勾上写 `checked`，没勾把过时的 `checked` 摘掉 |
| `textarea` | 文本内容（就是它的 value） |
| `select` | 选中项写 `selected`，没选中的摘掉 |

空值一律不写——空串等于默认值，写进块只是白胖。

**敏感字段一律跳过，密码不进块**：`type=password`、`type=hidden`（常放 CSRF / 一次性令牌）、`type=file`，以及 `autocomplete` 里点名了密码 / 信用卡 / 一次性验证码的字段（`current-password`、`new-password`、`cc-*`、`one-time-code`、`webauthn`）。被跳过的控件只在 `report.liveValues.sensitiveSample` 里留「哪个控件被跳过」的标识（标签 + 理由 + id/name），**值一个字符都不写**。

`autocomplete="off"` **本身不是跳过条件**：上面那个周选择器就是 `autocomplete="off"`，值是「当前周」——按 `off` 跳过等于把这条 bug 原样留着。判敏感看的是 `type` 与 `autocomplete` 的令牌，不是 `off`。

## shadow DOM：open shadow root 会被展开

`querySelectorAll` 只看主文档这棵树，`attachShadow` 进去的东西一个都看不到——和 iframe 同级。真实事故：学在浙大五页都缺右下角那个紫色客服悬浮按钮，它就在 shadow root 里。

做法（只做 **open**；closed 的 `shadowRoot` 直接是 `null`，读不到也不硬来）：

1. **元素清单**里紧跟 host 收进 shadow root 的后代——它们同样要固化计算样式与活值。排在队尾会挤不进 600 个元素的固化预算，等于白收；
2. **样式**：shadow root 里的 `<style>` / `<link rel=stylesheet>` / `adoptedStyleSheets` 走同一条 CSS 管道，选择器加 `[data-dsh-shadow="sN"]` 前缀；死选择器探针改成在那个 root 里 `querySelector`（用主文档探针会把整套 shadow 规则判成死选择器丢光）；
3. **序列化**：把 shadow 内容拷进一个真实容器 `<div class="dsh-shadow-root" data-dsh-shadow="sN" data-dsh-shadow-host="标签名">`，挂在 host 的克隆里；host 自己的 light DOM 子节点原地不动。

`report.shadowRoots` 记 `{found, inlined, rules, slots, droppedSelectors}`。

**代价（已知边界）**：展平后不再是 shadow 作用域。`<slot>` 投影的内容留在 light DOM 原位置、不重复拷，投影位置还原不了（只记进 `slots`）；`:host` 映射到 wrapper 自己；`::slotted()` 与 `:host-context()` 还原不了，丢掉并记进 `droppedSelectors`。宿主选择器的权重与继承关系有细微差别，但元素的计算样式已逐条固化，外观不靠这条链路兜底。

## 自检

```
node self-check.mjs
```

不依赖 DSH 端点，分两段跑，一共断言 **40 条**：

**前半段（6 条，`hub-check.mjs`）**：把 `background.js` / `options.js` 原文装进一个假 `chrome`（storage 用内存 Map），再起**一个假登记台 + 两个假实例**（本地 http 服务，记录每个请求），手动跑 tick：

1. 没有配置时向 `/instances` 取实例表，一轮 poll 打到表里两个实例（带 `tabs` 与 `tabsTag`）；
2. 任务由 A 下发、结果只回 A（B 一次 result 都没收到）；
3. 同一份清单的第二轮只带 `tabsTag`、**不发 `tabs`**（插件侧沿用上次）；
4. 实例表写进 `chrome.storage`（`registryTable`）；
5. 登记台停掉 + 扩展重启后，仍按缓存里的表上报（`status.registry.source === 'cache'`）；
6. `options.html?baseURL=` 写进 `chrome.storage` 并回填输入框。

单独跑这一段：`node hub-check.mjs`。

**后半段（34 条）**：无头 Chrome 开 `about:blank`，注入一段测试 DOM + `extractor.js` 原文，起一个本地 http 服务（**不发 CORS 头**）当跨域素材来源，跑一遍抽取：

1. 结构类（8 条）：files 非空、entry 含目标元素、`--dsw-` 残留 0、无根绝对路径、体积账一致、相对引用全部命中、坏资源进 dropped、祖先链停在 body 直系子元素；
2. 跨域 358×20870 长条图原尺寸落文件、report 与落盘 PNG 都是 358×20870、没被重编码；
3. 带 `srcset` 的元素取到最大候选（900w），100w/300w 不出现；
4. 跨域 URL（另一台主机 + 页面里 `fetch` 被拦的对照）经后台取字节拿到字节，dropped 里不再出现它；
5. **活值固化**：夹具里 `input` / `select` / `textarea` / `checkbox` 的值只存在于 property（改前 outerHTML 里没有 `value`），抓完必须是属性（`value="当前周"`、`<option selected>第二周`、`<textarea>hello</textarea>`、`checked`），且 `type=password` 那个框**没被写**、值不在任何产出文件里出现；
6. **shadow DOM**：open shadow root 里的按钮以 `<div class="dsh-shadow-root" data-dsh-shadow="s1">` 展开进 entry，它那条 `<style>` 以 `[data-dsh-shadow="s1"] .kf-fab{…}` 进 page.css。



后台取字节在自检里由 CDP `Runtime.addBinding` 搭出同一条消息链（页面请求 → Node 用 fetch 取 → 字节回传），所以跑的是 extractor 里真实的「走后台」分支，通道记为 `background`。产出落在 `out-selfcheck/`（已 gitignore）。

`extractor.js` 是纯函数（形参是一个 document 接口），MV3 与自检跑的是**同一份源码**。

## 已知边界

- 抽取只固化子树前 600 个元素的关键计算属性（`computed` 段到 384KB 预算就停，`report.degrade` 里会说）；属性里含布局位置（`position/inset/top/right/bottom/left/transform/z-index/overflow`），等于默认值时一律不写——定位样式表跨域取不到时（`pure-drawer.css` 那种），抽屉的版式就靠这些规则立住；
- 跨域 `@import` 的样式表读不到 `cssRules`，记进 dropped；
- 只处理顶层文档：iframe 内容不抓（元素本身移除并记名）；
- 只展开 **open** shadow root（closed 的 `shadowRoot` 是 `null`，读不到）；展平后 `<slot>` 投影位置、`:host` 的原始宿主语义还原不了，见上文「shadow DOM」一节的代价说明；
- 自定义属性表取 `:root`+`body`，挂在更深的祖先上的局部变量解析不了 → 丢声明；
- 不追求像素级还原。这一步只保证**结构完整、路径合法、变量已固化**。
