// 打开“插件”面板（快照 B 的现场）
(async () => {
  const row = [...document.querySelectorAll('button')].find((b) => (b.innerText || '').trim() === '插件');
  if (!row) throw new Error('plugin row not found');
  row.click();
  await new Promise((r) => setTimeout(r, 1500));
  return true;
})()
