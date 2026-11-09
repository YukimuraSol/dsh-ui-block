// 打开“插件 → 插件市场”页（快照 C 的现场）
(async () => {
  const clickExact = (t, filter) => {
    const e = [...document.querySelectorAll('button, [role="tab"]')].find(
      (x) => (x.innerText || '').trim() === t && (!filter || filter(x))
    );
    if (!e) throw new Error(t + ' not found');
    e.click();
    return e;
  };
  clickExact('插件');
  await new Promise((r) => setTimeout(r, 1500));
  clickExact('插件市场', (x) => x.getBoundingClientRect().top < 160); // 顶部那排 tab，不是列表里的插件名
  await new Promise((r) => setTimeout(r, 1800));
  return true;
})()
