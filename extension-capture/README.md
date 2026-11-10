# dsh-page-capture（浏览器扩展）

把**当前这一页整页**抽成素材包，交给本地 DSH，喂给 `create_ui_block`。

和隔壁 `../extension/`（dsh-element-picker）的区别：**那个取一个元素，这个取整页**。

## 装

1. Chrome/Edge 打开 `chrome://extensions`（Edge 是 `edge://extensions`），开「开发者模式」；
2. 「加载已解压的扩展程序」→ 选这个目录 `extension-capture`；（DSH 侧把该目录从 `.dsh-launcher-plugin-bodies/dsh-ui-block/extension-capture` 提供出来，改完在 `chrome://extensions` 点一次「重新加载」）
3. 点扩展图标（或「扩展程序选项」）配 base URL / instance 名。

装完不用再点任何东西：后台每 2 秒轮询一次，DSH 的 `list_pages` 就能看见你开着的标签。

## 配

| 项 | 默认 | 说明 |
| --- | --- | --- |
| base URL | `http://127.0.0.1:4000` | 只决定往哪个实例上报，测试切实例不用重装 |
| instance 名 | `chrome` | `tabId` 只在单个浏览器内唯一，对外身份是 `instance + tabId` |
| 配对码 | 空 | 插件侧 `agent.requireToken` 打开时才需要；填了就以 `?token=` 带上 |
| 上报开关 | 开 | **关掉 = 一个请求都不发**（连轮询都不发），DSH 那边自然看不见它 |

配置存 `chrome.storage.local`，改完立即生效（`storage.onChanged` 会重启轮询），不用重装。

## 端点契约

```
POST {baseUrl}/ui-blocks/agent/poll[?token=…]
  { instance, tabs: [{ tabId, url, title, focused, capturable, reason? }] }
  → { task: null } | { task: { id, tabId, includes?, maxBytes? } }

POST {baseUrl}/ui-blocks/agent/result[?token=…]
  { instance, taskId, ok, files?, report?, error? }
  → { ok: true, dir } | { ok: false, error }
```

字段名固定。相对契约只加了两处，都在报告里声明过：

- `tabs[]` 多一个 `capturable`（以及 `capturable:false` 时的 `reason`）——坑 3 要在清单阶段就标出来；
- 两个 URL 支持可选的 `?token=`（配对码，默认不填就不带）。

`task.includes` 是逗号分隔的段名：`dom,css,computed,assets`（缺省全做，`all` 等价）。

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

1. **后台标签偷懒**：先 `chrome.tabs.update(tabId,{active:true})` + 窗口置前，等 300ms 再注入；切不动就回 `该页在后台且拒绝激活，请手动切过去`。
2. **标签被关掉**：`chrome.tabs.get` 失败 → `目标已消失，请重新 list_pages`，不猜替代品。
3. **永远抓不到的页**：`chrome://` / 扩展页 / 扩展商店 / 内嵌 PDF → 清单里 `capturable:false` + `reason`，任务阶段再挡一次。

## 皮肤不许被抓进块里

抓取时把 `:root`/`body` 上此刻的自定义属性收成字面值表，再把每条声明里的 `var(--x)` 递归替换；解析不了就丢整条声明，绝不把 `var(--dsw-*)` 留在素材里。SVG 的呈现属性（`fill="var(--dsw-…)"`）同样处理——3080 的图标就是这个形态，漏了会留下 7 处残留。

## 自检

```
node self-check.mjs
```

不依赖 DSH 端点：无头 Chrome 开 `about:blank`，注入一段测试 DOM + `extractor.js` 原文，起一个本地 http 服务（**不发 CORS 头**）当跨域素材来源，跑一遍抽取并断言 11 条：

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
