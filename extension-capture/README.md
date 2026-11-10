# dsh-page-capture（浏览器扩展）

把**当前这一页整页**抽成素材包，交给本地 DSH，喂给 `create_ui_block`。

和隔壁 `../extension/`（dsh-element-picker）的区别：**那个取一个元素，这个取整页**。

## 装

1. Chrome/Edge 打开 `chrome://extensions`（Edge 是 `edge://extensions`），开「开发者模式」；
2. 「加载已解压的扩展程序」→ 选这个目录 `extension-capture`；（DSH 侧把该目录从 `.dsh-launcher-plugin-bodies/dsh-ui-block/extension-capture` 提供出来，改完在 `chrome://extensions` 点一次「重新加载」）
3. 点扩展图标（或「扩展程序选项」）配 instance 名；**base URL 可以留空**（留空 = 自动发现，见下一节）。

装完不用再点任何东西：后台每 2 秒轮询一次，DSH 的 `list_pages` 就能看见你开着的标签。

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
pages/current/page.css     本页命中规则（死选择器已丢、var 已固化）+ 元素计算样式清单，引用 ../../assets/
assets/*                   超内嵌上限 1.4MB 的二进制、超 2000px 且降采样后仍超限的图，以及雪碧图/长条图（长宽比 ≥8，原尺寸不降采样）
```

路径一律**段内相对**（`./`、`../`、`../../`），不出现根绝对路径。单段 2MB、单文件 2MB，与 DSH 侧默认对齐；`data:` 内嵌另有一条更紧的 1.4MB 线（base64 会胀 4/3）。调用方给 `maxBytes` 时，内嵌与计算样式两份预算跟着它缩放。

`report` 记：origin、title、bytes、files[]（每段字节）、dropped[]（丢了什么/降级成什么）、规则数与丢弃数、变量解析数、元素数、ancestors（祖先链），以及两份素材账：`assets[]`（每条 URL 的落点 kind/path、字节、取字节通道 `via`、原尺寸 w/h、是否 `downsampled`，`data:` 的 URL 只留前 48 字符）与 `srcsetPicked[]`（响应式图实际取的那档）。`report.bytes` 与 `sum(files[].bytes)` 恒等。

## 资源字节从后台取

内容脚本跑在页面里，取跨域图片/字体受页面的 CORS 限制——logo、app-fold.svg、no-application.png 就是这么 Failed to fetch 的（同一 URL 普通 GET 是 200）。

现在 extractor 只产 URL 清单，字节一律交给 service worker：

```
内容脚本  chrome.runtime.sendMessage({ type: 'dsh-capture-fetch', url })
后台       fetch(url, { credentials: 'include' })   // 带 all_urls 主机权限，不受页面跨域限制
          → { ok: true, base64, mime, bytes } | { ok: false, error }
```

- 单次上限 12MB、单请求 25 秒超时，超了当场回原因，由 extractor 写进 `report.dropped`；
- 后台并发 4（extractor 侧并发 3，取字节和重编码都在页面里跑，贪多反而抖）；
- 取字节期间每 20 秒摸一次扩展 API（`chrome.runtime.getPlatformInfo`）重置空闲计时器，不让 MV3 的 30 秒回收把一轮抓取截断；
- 没有后台可用时（例如离线自检的宿主页面）退回页面自身的 `fetch`，通道记 `page`。

## 雪碧图与 srcset

- **雪碧图/长条图不降采样**：长宽比 ≥ 8（358×20870 这类）判定为雪碧图，原尺寸落 `assets/`；2000px 单边降采样只用于长宽比正常的大图。
- **srcset / imagesrcset 取最大候选**：不再当垃圾属性删。描述符里 `w` 优先于 `x`，选中档位进资源清单；`img` 用 `src` 承载它，`source` 把 `srcset` 收成一条，`link[rel=preload][imagesrcset]`（元素本身会被删）也会被预先收进清单。

## 三个坑怎么处理

1. **后台标签偷懒**：先 `chrome.tabs.update(tabId,{active:true})`（只在本窗口内切标签，**不置前窗口**，否则抢用户焦点），等 300ms 再注入；抓前记下本窗口原本 active 的 tab，抓完切回。切不过去也照抓，只有页面确实 `hidden` 时才在 report 里记 `hiddenTab: true`。
2. **标签被关掉**：`chrome.tabs.get` 失败 → `目标已消失，请重新 list_pages`，不猜替代品。
3. **永远抓不到的页**：`chrome://` / 扩展页 / 扩展商店 / 内嵌 PDF → 清单里 `capturable:false` + `reason`，任务阶段再挡一次。

## 皮肤不许被抓进块里

抓取时把 `:root`/`body` 上此刻的自定义属性收成字面值表，再把每条声明里的 `var(--x)` 递归替换；解析不了就丢整条声明，绝不把 `var(--dsw-*)` 留在素材里。SVG 的呈现属性（`fill="var(--dsw-…)"`）同样处理——3080 的图标就是这个形态，漏了会留下 7 处残留。

## 自检

```
node self-check.mjs
```

不依赖 DSH 端点，分两段跑，一共断言 **17 条**：

**前半段（6 条，`hub-check.mjs`）**：把 `background.js` / `options.js` 原文装进一个假 `chrome`（storage 用内存 Map），再起**一个假登记台 + 两个假实例**（本地 http 服务，记录每个请求），手动跑 tick：

1. 没有配置时向 `/instances` 取实例表，一轮 poll 打到表里两个实例（带 `tabs` 与 `tabsTag`）；
2. 任务由 A 下发、结果只回 A（B 一次 result 都没收到）；
3. 同一份清单的第二轮只带 `tabsTag`、**不发 `tabs`**（插件侧沿用上次）；
4. 实例表写进 `chrome.storage`（`registryTable`）；
5. 登记台停掉 + 扩展重启后，仍按缓存里的表上报（`status.registry.source === 'cache'`）；
6. `options.html?baseURL=` 写进 `chrome.storage` 并回填输入框。

单独跑这一段：`node hub-check.mjs`。

**后半段（11 条）**：无头 Chrome 开 `about:blank`，注入一段测试 DOM + `extractor.js` 原文，起一个本地 http 服务（**不发 CORS 头**）当跨域素材来源，跑一遍抽取：

1. 结构类（8 条）：files 非空、entry 含目标元素、`--dsw-` 残留 0、无根绝对路径、体积账一致、相对引用全部命中、坏资源进 dropped、祖先链停在 body 直系子元素；
2. 跨域 358×20870 长条图原尺寸落文件、report 与落盘 PNG 都是 358×20870、没被重编码；
3. 带 `srcset` 的元素取到最大候选（900w），100w/300w 不出现；
4. 跨域 URL（另一台主机 + 页面里 `fetch` 被拦的对照）经后台取字节拿到字节，dropped 里不再出现它。



后台取字节在自检里由 CDP `Runtime.addBinding` 搭出同一条消息链（页面请求 → Node 用 fetch 取 → 字节回传），所以跑的是 extractor 里真实的「走后台」分支，通道记为 `background`。产出落在 `out-selfcheck/`（已 gitignore）。

`extractor.js` 是纯函数（形参是一个 document 接口），MV3 与自检跑的是**同一份源码**。

## 已知边界

- 抽取只固化子树前 600 个元素的关键计算属性（`computed` 段到 384KB 预算就停，`report.degrade` 里会说）；
- 跨域 `@import` 的样式表读不到 `cssRules`，记进 dropped；
- 只处理顶层文档：iframe 内容不抓（元素本身移除并记名）；
- 自定义属性表取 `:root`+`body`，挂在更深的祖先上的局部变量解析不了 → 丢声明；
- 不追求像素级还原。这一步只保证**结构完整、路径合法、变量已固化**。
