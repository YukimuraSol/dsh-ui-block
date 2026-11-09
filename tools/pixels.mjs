// pixels.mjs — 像素对照：抓取那一刻的实机帧 vs 组装后的多文件页面
// 为什么用 capture --shot 存下来的那张实机帧：同一页、同一刻、同一个 prep，
// 应用状态零漂移。另开一次实机会掺进"还在加载 / 没选工作区"这类状态差，
// 那个数字反映的是应用状态，不是快照质量（本轮就因为这点算错过两次）。
import { launch, navigate, evaluate, screenshot } from './cdp.mjs';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';

const OUT = path.resolve('out');
const NAMES = (process.argv[2] || 'home,plugins,market').split(',');
const SERVE = process.argv[3] || 'http://127.0.0.1:3911';
const sha = (b) => createHash('sha256').update(b).digest('hex');

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
const report = { mode: '同一时刻：capture --shot 的实机帧 vs 组装后的多文件页', pages: {} };
try {
  for (const name of NAMES) {
    const live = await readFile(path.join(OUT, 'parts', name, 'live.png'));
    await navigate(b.session, SERVE + '/out/site/pages/' + name + '/index.html', { settle: 1600 });
    const snap = await screenshot(b.session);
    await writeFile(path.join(OUT, 'live3-' + name + '-1440x900.png'), live);
    await writeFile(path.join(OUT, 'snap3-' + name + '-1440x900.png'), snap);
    await navigate(b.session, SERVE + '/harness.html?autoplay=0', { settle: 250 });
    const diff = await evaluate(b.session, diffExpr(live, snap), { isExpression: true });
    report.pages[name] = { liveSha: sha(live), snapSha: sha(snap), diff };
    console.error('[pixels] ' + name + ' ' + JSON.stringify(diff));
  }
} finally { await b.close(); }
console.log(JSON.stringify(report, null, 1));
await writeFile(path.join(OUT, 'pixels.json'), JSON.stringify(report, null, 1));
