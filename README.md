# dsh-ui-block — 页面块（Page Block）

## 这是什么

DeepSeek Harness 插件。消息里独占一行写 `::dsh-ui 名字::`，这一行变成一块沙箱画布，渲染 `<DSH_HOME>/ui-blocks/名字.uiblock` 这个文件。块是纯数据，块内不执行脚本；画布可以改分辨率、缩放、拖高度、在画布里点选元素把 `element«…»` 引用插回输入框、重新播放动画。另带 `list_pages` 与 `capture_page` 两个工具，把浏览器里开着的页面抓成素材、组装成块。

设计、判定顺序与已知边界写在 [技术文档.md](技术文档.md)。

## 装什么

- DeepSeek Harness（DSH）：本插件是它的 profile bundle 加客户端插件，不单独运行。
- Node.js 与 pnpm：装 profile 依赖，跑自检与 `tools/` 里的脚本。
- 浏览器加扩展：只有抓页需要。扩展在 `extension-capture/`，以「加载已解压的扩展程序」装。

## 怎么装

1. 在 profile 的 `package.json` 的 `dependencies` 里加一行：`"dsh-ui-block": "link:<仓库目录>"`。
2. 同一个文件的 `dsh.profile.bundles` 里加一项 `"dsh-ui-block"`。
3. 在 profile 目录跑：`pnpm install --config.auto-install-peers=false`。
4. 重启该实例，然后刷新页面。客户端 bundle 图只在启动时合成，刷新页面不算。

装扩展（抓页才要）：

1. `chrome://extensions` 开开发者模式，「加载已解压的扩展程序」，选 `extension-capture/` 目录。
2. 扩展选项页把 baseURL 填成本实例地址：`http://127.0.0.1:<端口>`。
3. 用这个浏览器打开要抓的那一页。需要登录的页面只能由你自己打开，插件不读、不复制任何 cookie。

依赖加了但插件没出现：启动日志里会有 `skipping profile bundle "dsh-ui-block"`，那是还没重启，不是失败。

## 怎么用

最小例子，三步。

1. 写一个块文件 `<DSH_HOME>/ui-blocks/hello.uiblock`：

```html
<!doctype html>
<meta charset="utf-8">
<h1 style="font:600 28px system-ui;padding:24px">Hello</h1>
```

2. 会话里发一条消息，正文里**单独一行**写引用。不包反引号，不放在代码围栏里，前后不加别的字：

```text
::dsh-ui hello::
```

3. 那一行变成画布，原位插在它后面。要指定画布尺寸写 `::dsh-ui hello res=820x510::`；不写是 1440x900。

同一条消息里的引用**按消息时刻还原**：显示的是这条消息第一次渲染时那一版块，之后改块只影响之后的新消息。

抓一个现有页面：让模型调 `list_pages` 列出装着扩展的浏览器里开着的标签页，用其中一行的 `{instance, tabId}` 调 `capture_page`；抓完调 `create_ui_block` 落到 `ui-blocks/`，再用上面那行引用它。

## 自检

```text
node self-check-uiblock-directive.mjs          # 引用行解析、画布控件、时间轴、版本历史
node self-check-element-chip.mjs              # element«…» token 的编解码与 chip
node self-check-blockbuild.mjs                # 块文件分段与素材目录组装
node self-check-agent-tools.mjs               # list_pages / capture_page 的通道与实例登记台
node self-check.mjs                           # 宿主半边：两个文件工具注册与写盘（不加 --shot 不碰浏览器）
cd extension-capture; node self-check.mjs     # 抓取扩展
```

都是零依赖的 Node 脚本，失败时退出码非 0。

## License

MIT，见 [LICENSE](LICENSE)。Copyright (c) 2026 YukimuraSol
