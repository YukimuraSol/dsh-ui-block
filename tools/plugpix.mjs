// plugpix.mjs — 新口径：**插件里渲染出来的那一块** vs 抓取那一刻的实机帧
// 为什么改口径：装配站点页在普通浏览器里几乎和实机一致（0.55），但插件不是在普通浏览器里
// 打开它——插件把段装到 /ui-blocks/<name>/ 下、以入口文档的形态渲染，路径、CSP、尺寸约束都不同。
// 所以这里直接打开插件自己的路由，1440×900 截图，再和 capture --shot 存下的同刻实机帧比。
import { launch, navigate, evaluate, screenshot } from './cdp.mjs';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';

const OUT = path.resolve('out');
const BASE = process.argv[2] || 'http://127.0.0.1:4000';
const TOK = process.argv[3] || '';
const BLOCK = process.argv[4] || 'data2';
const NAMES = (process.argv[5] || 'home,plugins,market').split(',');
const sha = (b) => createHash('sha256').update(b).digest('hex');
const urlFor = (name) => BASE + '/ui-blocks/' + BLOCK + '/' + (name === 'home' ? '' : 'pages/' + name + '/index.html') + '?token=' + TOK;

const diffExpr = (a, c) =>
  '(async () => {' +
  '  const a = "data:image/png;base64,' + a.toString('base64') + '";' +
  '  const b2 = "data:image/png;base64,' + c.toString('base64') + '";' +
  '  const load = (src) => new Promise((res) => { const i = new Image(); i.onload = () => res(i); i.src = src; });' +
  '  const [ia, ib] = await Promise.all([load(a), load(b2)]);' +
  '  const w = Math.min(ia.width, ib.width), h = Math.min(ia.height, ib.height);' +
  '  const cv = new OffscreenCanvas(w, h); const ctx = cv.getContext("2d", { willReadFrequently: true });' +
  '  ctx.drawImage(ia, 0, 0); const da = ctx.getImageData(0, 0, w, h).data;' +
  '  ctx.clearRect(0, 0, w, h); ctx.drawImage(ib, 0, 0); const db = ctx.getImageData(0, 0, w, h).data;' +
  '  let sum = 0, big = 0;' +
  '  for (let i = 0; i < da.length; i += 4) { const d = Math.abs(da[i]-db[i])+Math.abs(da[i+1]-db[i+1])+Math.abs(da[i+2]-db[i+2]); sum += d; if (d > 48) big++; }' +
  '  const px = w * h;' +
  '  return { width: w, height: h, meanChannelDiff: +(sum/(px*3)).toFixed(2), pctPixelsOver16: +((big/px)*100).toFixed(2) };' +
  '})()';

const b = await launch({ width: 1440, height: 900 });
const report = { mode: '插件内渲染（/ui-blocks/<name>/ 路由，1440x900）vs capture --shot 的同刻实机帧', block: BLOCK, base: BASE, pages: {} };
try {
  for (const name of NAMES) {
    const live = await readFile(path.join(OUT, 'parts', name, 'live.png'));
    const url = urlFor(name);
    await navigate(b.session, url, { settle: 2200 });
    const facts = await evaluate(b.session, () => {
      const w = document.querySelector('[data-dsh-colombia-wallpaper]');
      const cs = w ? getComputedStyle(w) : null;
      return {
        sheets: [...document.styleSheets].length,
        sheetsFailed: [...document.styleSheets].filter((s) => s.href && s.cssRules.length === 0).map((s) => s.href.slice(-30)),
        wallPos: cs ? cs.position : 'none',
        bodyH: document.body.scrollHeight,
      };
    });
    const shot = await screenshot(b.session);
    await writeFile(path.join(OUT, 'plug-' + name + '-1440x900.png'), shot);
    await navigate(b.session, 'about:blank', { settle: 150 });
    const diff = await evaluate(b.session, diffExpr(live, shot), { isExpression: true });
    report.pages[name] = { url, liveSha: sha(live), plugSha: sha(shot), facts, diff };
    console.error('[plugpix] ' + name + ' ' + JSON.stringify(diff) + ' ' + JSON.stringify(facts));
  }
} finally { await b.close(); }
console.log(JSON.stringify(report, null, 1));
await writeFile(path.join(OUT, 'plugpix.json'), JSON.stringify(report, null, 1));
