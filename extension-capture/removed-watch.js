// dsh-page-capture / removed-watch.js
// 「抓取那一刻已经不在 DOM 里的节点」的观察器。
//
// 为什么需要它：抓取发生在页面加载完之后，页面自己的 JS 早就把加载层/骨架层摘掉了
// （实测 panel.solyukimura.top：入场靠 JS 加 .in，覆盖层 .lwrap/.lbox 抓取时节点已不存在）。
// 抽取函数只能在**那一刻**的 DOM 上工作，看不到过去；旧 report 里那个 removedNodes 数字
// 数的是「抽取时从副本里摘掉的 <script>/<style>」，跟加载层毫无关系——模型没有任何依据
// 判断要不要在块里把它放回去。
//
// 做法：manifest 以 content_scripts / run_at=document_start 注入本文件，只把「被摘掉的
// 元素节点」压进一个有界环（引用照留，序列化留到抓取时再做——摘除时算一次 outerHTML 等于
// 给页面的每次 DOM 操作加一笔，SPA 会明显卡）。抓取时 extractor.js 读 globalThis.__dshRemovedWatch。
// 内容脚本与 chrome.scripting.executeScript 注入的文件同在扩展的 ISOLATED world，所以
// globalThis 是共用的那个。
//
// 边界：只观察，不拦截、不改页面、不尝试把节点放回去——要不要在块里复刻是模型的决定。
// 上限 40 条引用（约等于 40 棵被摘下来的子树，内存有界）；更早的被环丢掉，但 total
// 照记，抓取时用 total - 列出的条数 算出「还有多少没列」。
(function () {
  'use strict'
  var G = typeof globalThis !== 'undefined' ? globalThis : self
  if (G.__dshRemovedWatch) return // 重复注入只留第一份
  // 这些标签本来就没有「版式形态」可复刻（抽取时也会从副本里删掉），记它们纯属噪音。
  var SKIP = {
    script: 1, style: 1, link: 1, meta: 1, noscript: 1, template: 1, base: 1, title: 1,
    iframe: 1, object: 1, embed: 1, canvas: 1, source: 1, track: 1
  }
  var MAX = 40
  var rows = []
  var total = 0
  var watch = { rows: rows, total: function () { return total }, version: 1, error: '' }
  G.__dshRemovedWatch = watch
  var classOf = function (el) {
    var c = el.getAttribute ? el.getAttribute('class') : null
    return c ? String(c).slice(0, 120) : ''
  }
  try {
    new MutationObserver(function (records) {
      for (var i = 0; i < records.length; i++) {
        var removed = records[i].removedNodes
        for (var j = 0; removed && j < removed.length; j++) {
          var node = removed[j]
          if (!node || node.nodeType !== 1) continue // 只记元素：文本/注释节点没有形态
          var tag = String(node.tagName || '').toLowerCase()
          if (SKIP[tag]) continue
          total++
          rows.push({ el: node, tag: tag, id: String(node.id || ''), cls: classOf(node) })
          if (rows.length > MAX) rows.shift() // 环：丢掉最老的那条引用，子树随之可回收
        }
      }
    }).observe(document, { childList: true, subtree: true })
  } catch (e) {
    watch.error = String((e && e.message) || e)
  }
})()
