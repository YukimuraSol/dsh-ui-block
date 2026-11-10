/**
 * Self-check for the BLOCK-BUILDING path: the configurable ceilings, fromDir,
 * the reference guard, the soft warn, and same-name replace.
 *
 *   node self-check-blockbuild.mjs
 *
 * Mounts the plugin against a stub Cordis context with a throwaway DSH_HOME, so
 * the create_ui_block tool runs for real: files are read from disk, the block is
 * written, .bak and .history are made by the same code the app runs. Nothing
 * here mocks a helper — a regression in the tool itself fails this file.
 *
 *   1. resolveRef / collectRefs: what counts as a reference, with line numbers
 *   2. fromDir: entry pick, per-type sections, skip ledger, totals, bytes on disk
 *   3. fromDir: a referenced file past the per-file ceiling is skipped, not fatal
 *   4. fromDir: no entry at all names the candidates instead of guessing
 *   5. dangling reference: refused, with where/line/ref, and nothing written
 *   6. same name: old file becomes .bak-<ISO>, history grows by one patch
 *   7. per-file ceiling: the message carries size, limit, DIFFERENCE and the exits
 *   8. limits config: block ceiling read from config, missing fields defaulted
 *   9. soft warn: past 16 MB the block still writes and says why it is heavy
 */
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

const home = await mkdtemp(join(tmpdir(), 'dsh-blockbuild-home-'))
process.env.DSH_HOME = home

const { apply, blockBuild, timeline } = await import('./index.js')

let n = 0
/** One synchronous assertion group; any throw fails the whole file. */
const t = (name, fn) => { fn(); n += 1; console.log('  ok - ' + name) }
/** One async assertion group. */
const ta = async (name, fn) => { await fn(); n += 1; console.log('  ok - ' + name) }

/** Mount the plugin against a stub context and hand back a tool lookup. */
function mount(config) {
  const tools = new Map()
  apply({
    tools: { register: (definition) => { tools.set(definition.name, definition); return () => {} } },
    inject: () => {},
    logger: { warn: () => {}, info: () => {} }
  }, config)
  return (name) => {
    const found = tools.get(name)
    if (found === undefined) throw new Error('tool not registered: ' + name + ' (have: ' + [...tools.keys()].join(', ') + ')')
    return found
  }
}
const create = mount({}).bind(null)('create_ui_block')

const blocksDir = join(home, 'ui-blocks')
const blockFile = (name) => join(blocksDir, name + '.uiblock')

/** A fresh material directory under the temp home. */
function material(name) {
  const dir = join(home, 'material', name)
  mkdirSync(dir, { recursive: true })
  return dir
}
/** Write one text file, creating its parent directories. */
function put(dir, rel, text) {
  const target = join(dir, rel)
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, text)
  return target
}
/** Write one binary file, creating its parent directories. */
function putBytes(dir, rel, bytes) {
  const target = join(dir, rel)
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, bytes)
  return target
}
const sizeOf = (path) => statSync(path).size

console.log('--- 1. what counts as a reference ---')
t('data:, fragment, http(s), // and mailto are not references', () => {
  for (const raw of ['data:image/png;base64,AA', '#top', 'https://x/y.png', '//cdn/z.png', 'mailto:a@b.c', '']) {
    assert.equal(blockBuild.resolveRef(raw, 'index.html'), undefined, 'accepted ' + JSON.stringify(raw))
  }
})
t('a relative reference resolves against the file its own URL', () => {
  assert.equal(blockBuild.resolveRef('./card.css', 'index.html'), 'card.css')
  assert.equal(blockBuild.resolveRef('../assets/x.woff2', 'shared/app.css'), 'assets/x.woff2')
  assert.equal(blockBuild.resolveRef('pages/error.html', 'index.html'), 'pages/error.html')
  assert.equal(blockBuild.resolveRef('./', 'index.html'), undefined)
})
t('a root-absolute reference resolves OUT of the block (that is the bug it catches)', () => {
  assert.equal(blockBuild.resolveRef('/assets/x.png', 'index.html'), 'assets/x.png')
})
t('collectRefs reads link href, img src, url() and @import, with 1-based lines', () => {
  const body = [
    '<!doctype html><html><head>',
    '<link rel="stylesheet" href="./a.css">',
    '</head><body>',
    '<img src="./b.svg"><div style="background:url(&quot;./c.webp&quot;)"></div>',
    '</body></html>'
  ].join('\n')
  const refs = blockBuild.collectRefs(body, 'index.html')
  assert.deepEqual(refs.map((ref) => ref.path), ['a.css', 'b.svg', 'c.webp'])
  assert.deepEqual(refs.map((ref) => ref.line), [2, 4, 4])
  assert.equal(refs[2].ref, './c.webp')
})
t('a navigation href is not a resource reference; ng-src is not src', () => {
  const body = '<a href="/public-course#/all">x</a>\n<img ng-src="/static/x.png">'
  assert.deepEqual(blockBuild.collectRefs(body, 'index.html'), [])
})
t('srcset / imagesrcset candidates are LOADS, descriptors dropped, one ref each', () => {
  const body = '<img srcset="./a.png 1x, ./a@2x.png 2x">\n<picture><source imagesrcset="./b.webp 480w, ./b@2x.webp 800w"></picture>'
  const refs = blockBuild.collectRefs(body, 'index.html')
  assert.deepEqual(refs.map((ref) => ref.path), ['a.png', 'a@2x.png', 'b.webp', 'b@2x.webp'])
  assert.deepEqual(refs.map((ref) => ref.line), [1, 1, 2, 2])
  assert.ok(refs.every((ref) => ref.via === 'srcset'), 'each candidate carries its provenance')
})
t('data-srcset is not a load — only the real attribute counts', () => {
  assert.deepEqual(blockBuild.collectRefs('<img data-srcset="./lazy.png 2x">', 'index.html'), [])
})

console.log('--- 2. fromDir: one call, whole page, accounted for ---')
const site = material('site')
const entryHtml = '<!doctype html>\n<html><head><link rel="stylesheet" href="./shared/app.css"></head>\n<body><img src="./assets/logo.svg"><img src="./assets/pic.png"><p>hi</p></body></html>\n'
put(site, 'entry.html', entryHtml)
put(site, 'shared/app.css', ':root{--x:1}\nbody{background:url("../assets/bg.webp")}\n')
put(site, 'assets/logo.svg', '<svg xmlns="http://www.w3.org/2000/svg"><rect width="4" height="4"/></svg>\n')
putBytes(site, 'assets/pic.png', Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]))
putBytes(site, 'assets/bg.webp', Buffer.from([82, 73, 70, 70, 9, 9, 9]))
put(site, 'extra.css', '.never{color:red}\n')
put(site, 'report.json', '{"dropped":[]}\n')
put(site, 'assets/empty.stream', 'stream-bytes')

await ta('the block is written with entry.html and every file the page loads', async () => {
  const value = await create.execute({ name: 'from-probe', fromDir: site })
  assert.equal(value.entry, 'entry.html')
  assert.equal(value.fromDir, site)
  assert.deepEqual(value.files.map((file) => file.path), ['entry.html', 'assets/bg.webp', 'assets/logo.svg', 'assets/pic.png', 'shared/app.css'])
  assert.ok(value.files.every((file) => existsSync(file.from)), 'every from is a real path')
  assert.equal(value.totalBytes, ['entry.html', 'shared/app.css', 'assets/logo.svg', 'assets/pic.png', 'assets/bg.webp'].reduce((sum, rel) => sum + sizeOf(join(site, rel)), 0))
  assert.ok(value.blockBytes > value.totalBytes, 'base64 and markers make the block text bigger')
  assert.ok(existsSync(blockFile('from-probe')))
  const split = timeline.splitSections(readFileSync(blockFile('from-probe'), 'utf8'))
  assert.equal(split.entry, entryHtml)
  assert.deepEqual(split.files.map((file) => file.path), ['assets/bg.webp', 'assets/logo.svg', 'assets/pic.png', 'shared/app.css'])
  assert.equal(split.files.find((file) => file.path === 'assets/pic.png').base64, true)
  assert.equal(split.files.find((file) => file.path === 'shared/app.css').base64, false)
})
await ta('the skip ledger names each left-out file and why', async () => {
  const value = await create.execute({ name: 'from-probe-2', fromDir: site })
  const byPath = new Map(value.skipped.map((item) => [item.path, item]))
  assert.deepEqual([...byPath.keys()].sort(), ['assets/empty.stream', 'extra.css', 'report.json'])
  assert.equal(byPath.get('extra.css').reason, 'unreferenced')
  assert.equal(byPath.get('report.json').reason, 'unreferenced')
  assert.equal(byPath.get('assets/empty.stream').reason, 'unknown type')
  assert.equal(byPath.get('assets/empty.stream').bytes, 12)
  assert.equal(value.referencedSkipped, undefined, 'nothing referenced is skipped here')
  assert.equal('next' in value, false, 'no next field: the follow-up call lives in the rendered text')
  assert.equal('warnings' in value, false, 'no warnings field either — the render carries those facts')
  assert.match(create.output.render({}, value).map((part) => part.text).join('\n'), /^NEXT: read_ui_block\(\{ name: "from-probe-2" \}\)$/m, 'the rendered text still spells the follow-up call out')
  assert.ok(!value.files.some((file) => file.path === 'report.json'), 'the report never becomes a section')
})

console.log('--- 2b. srcset-only material is loaded, never reported as unreferenced ---')
const retina = material('retina')
put(retina, 'entry.html', '<!doctype html>\n<html><body><img src="./assets/hero.png" srcset="./assets/hero@2x.png 2x, ./assets/hero@3x.png 3x"><picture><source imagesrcset="./assets/icon.avif 1x"></picture></body></html>\n')
putBytes(retina, 'assets/hero.png', Buffer.from([1]))
putBytes(retina, 'assets/hero@2x.png', Buffer.from([2, 2]))
putBytes(retina, 'assets/hero@3x.png', Buffer.from([3, 3, 3]))
putBytes(retina, 'assets/icon.avif', Buffer.from([4, 4, 4, 4]))
await ta('the 2x/3x candidates land in the block; no srcset file is called unreferenced', async () => {
  const value = await create.execute({ name: 'srcset-probe', fromDir: retina })
  assert.deepEqual(value.files.map((file) => file.path), ['entry.html', 'assets/hero.png', 'assets/hero@2x.png', 'assets/hero@3x.png'])
  assert.equal(value.skipped.length, 1, 'only the .avif is left out')
  assert.equal(value.skipped[0].path, 'assets/icon.avif')
  assert.equal(value.skipped[0].reason, 'unknown type')
  assert.equal(value.skipped[0].via, 'srcset', 'the ledger says WHY it was referenced')
  assert.ok(!value.skipped.some((item) => item.reason === 'unreferenced'), 'a srcset candidate is referenced')
  assert.deepEqual(value.srcsetReferenced, ['assets/hero@2x.png', 'assets/hero@3x.png', 'assets/icon.avif'])
  assert.ok(value.referencedSkipped.some((line) => /icon\.avif/.test(line)), 'the skipped-but-referenced report names it')
  assert.equal('warnings' in value, false, 'the two facts stay in the data below and in the render, not in a warnings field')
})
await ta('the rendered report separates "srcset only" from "unreferenced"', async () => {
  const value = await create.execute({ name: 'srcset-probe-2', fromDir: retina })
  const text = create.output.render({}, value).map((part) => part.text).join('\n')
  assert.match(text, /Referenced via srcset only \(3\)/)
  assert.match(text, /assets\/icon\.avif \(4 bytes, unknown type: no section type for "\.avif"; referenced via srcset\)/)
  assert.doesNotMatch(text, /assets\/hero@[23]x\.png[^\n]*unreferenced/)
})

console.log('--- 3. fromDir: a referenced file past the per-file ceiling is skipped, not fatal ---')
const heavy = material('heavy')
const bigCss = 'a'.repeat(2 * 1024 * 1024 + 1)
put(heavy, 'entry.html', '<!doctype html>\n<html><head><link rel="stylesheet" href="./big.css"></head><body>ok</body></html>\n')
put(heavy, 'big.css', bigCss)
await ta('big.css is skipped with its exact overage, and the reference is reported back', async () => {
  const value = await create.execute({ name: 'heavy-probe', fromDir: heavy })
  assert.deepEqual(value.files.map((file) => file.path), ['entry.html'])
  assert.equal(value.skipped.length, 1)
  assert.equal(value.skipped[0].path, 'big.css')
  assert.equal(value.skipped[0].reason, 'over limit')
  assert.match(value.skipped[0].detail, /1 bytes over the per-file limit 2097152/)
  assert.equal(value.referencedSkipped.length, 1)
  assert.match(value.referencedSkipped[0], /entry\.html:2 +\.\/big\.css -> big\.css/)
  assert.ok(existsSync(blockFile('heavy-probe')), 'the block still lands — the page renders without it')
})

console.log('--- 4. fromDir with no entry names the candidates ---')
const noEntry = material('noentry')
put(noEntry, 'page-a.html', '<p>a</p>')
put(noEntry, 'page-b.html', '<p>b</p>')
await ta('the refusal lists the .html candidates instead of guessing', async () => {
  await assert.rejects(create.execute({ name: 'noentry-probe', fromDir: noEntry }), (error) => {
    assert.match(error.message, /has no entry/)
    assert.match(error.message, /page-a\.html, page-b\.html/)
    return true
  })
  assert.ok(!existsSync(blockFile('noentry-probe')))
})

console.log('--- 5. a dangling reference is refused, with where / line / ref ---')
const broken = material('broken')
put(broken, 'entry.html', '<!doctype html>\n<html><head><link rel="stylesheet" href="./missing.css"></head><body><img src="./assets/ok.svg"></body></html>\n')
put(broken, 'assets/ok.svg', '<svg xmlns="http://www.w3.org/2000/svg"></svg>\n')
await ta('the call fails, names the missing file and its line, and writes nothing', async () => {
  await assert.rejects(create.execute({ name: 'broken-probe', fromDir: broken }), (error) => {
    assert.match(error.message, /1 reference\(s\) point at files this block does not have/)
    assert.match(error.message, /entry\.html:2/)
    assert.match(error.message, /\.\/missing\.css -> missing\.css/)
    assert.match(error.message, /Nothing was written/)
    return true
  })
  assert.ok(!existsSync(blockFile('broken-probe')), 'no block file appeared')
})

console.log('--- 6. a taken name: the next free number, and only overwrite: true keeps .bak ---')
await ta('a second build lands as <name>-2 and leaves the first byte for byte', async () => {
  const firstRun = await create.execute({ name: 'name-probe', fromDir: site })
  assert.equal(firstRun.name, 'name-probe')
  const firstText = readFileSync(blockFile('name-probe'), 'utf8')
  // Change the material, then rebuild over the same name: the exact move that used
  // to silently destroy the other session's page now lands under a new name.
  put(site, 'entry.html', entryHtml.replace('<p>hi</p>', '<p>v2</p>'))
  const again = await create.execute({ name: 'name-probe', fromDir: site })
  assert.equal(again.name, 'name-probe-2')
  assert.equal(again.requested, 'name-probe')
  assert.equal(again.backup, undefined, 'the rename path writes no timestamp backup')
  assert.ok(existsSync(blockFile('name-probe-2')))
  assert.equal(readFileSync(blockFile('name-probe'), 'utf8'), firstText, 'the first block is untouched')
  assert.ok(readFileSync(blockFile('name-probe-2'), 'utf8').includes('<p>v2</p>'))
})
await ta('overwrite: true is the in-place path: .bak-<ISO>, bytes kept, one more patch', async () => {
  const before = await timeline.readHistory('name-probe')
  const firstText = readFileSync(blockFile('name-probe'), 'utf8')
  put(site, 'entry.html', entryHtml.replace('<p>hi</p>', '<p>v3</p>'))
  const again = await create.execute({ name: 'name-probe', fromDir: site, overwrite: true })
  assert.equal(again.name, 'name-probe')
  assert.match(again.backup, /\.uiblock\.bak-\d{4}-\d{2}-\d{2}T/)
  assert.ok(existsSync(again.backup))
  assert.equal(readFileSync(again.backup, 'utf8'), firstText, 'the backup is the previous version, byte for byte')
  const after = await timeline.readHistory('name-probe')
  assert.equal(after.entries.length, before.entries.length + 1)
  const live = readFileSync(blockFile('name-probe'), 'utf8')
  assert.ok(live.includes('<p>v3</p>'))
  assert.notEqual(live, firstText)
})

console.log('--- 7. the per-file refusal carries size, limit, difference and the exits ---')
await ta('a 2 MB + 1 file: the message says how far over and what to do', async () => {
  const over = join(home, 'over.css')
  writeFileSync(over, bigCss)
  await assert.rejects(create.execute({
    name: 'over-probe',
    files: [{ path: 'index.html', content: '<p>x</p>' }, { path: 'big.css', from: over }]
  }), (error) => {
    assert.match(error.message, /the limit is 2097152 bytes \(per file, 2\.0 MB\)/)
    assert.match(error.message, /1 bytes over/)
    assert.match(error.message, /Three ways out/)
    assert.match(error.message, /limits\.sectionBytes/)
    return true
  })
  assert.ok(!existsSync(blockFile('over-probe')))
})

console.log('--- 8. the limits are config, and a missing field falls back ---')
await ta('limits.blockBytes from the config refuses a block past it', async () => {
  const small = mount({ limits: { blockBytes: 400 } })
  await assert.rejects(small('create_ui_block').execute({
    name: 'small-probe',
    files: [{ path: 'index.html', content: '<p>' + 'x'.repeat(600) + '</p>' }]
  }), (error) => {
    assert.match(error.message, /the limit is 400 bytes \(per block/)
    assert.match(error.message, /limits\.blockBytes/)
    return true
  })
})
await ta('unspecified fields keep the documented defaults', async () => {
  mount({ limits: { sectionBytes: 1024 } })
  assert.deepEqual({ ...blockBuild.limits }, { sectionBytes: 1024, blockBytes: 67108864, softWarnBytes: 16777216 })
  mount({})
  assert.deepEqual({ ...blockBuild.limits }, { sectionBytes: 2097152, blockBytes: 67108864, softWarnBytes: 16777216 })
  mount({ limits: { sectionBytes: -5, blockBytes: 'nope' } })
  assert.deepEqual({ ...blockBuild.limits }, blockBuild.LIMIT_DEFAULTS)
})

console.log('--- 9. the 16 MB soft warn: written, not blocked ---')
await ta('a 17 MB block lands and carries the advisory instead of an error', async () => {
  const wide = mount({ limits: { sectionBytes: 20 * 1024 * 1024 } })
  const huge = join(home, 'huge.css')
  writeFileSync(huge, 'h'.repeat(17 * 1024 * 1024))
  const value = await wide('create_ui_block').execute({
    name: 'soft-probe',
    files: [{ path: 'index.html', content: '<p>wide</p>' }, { path: 'huge.css', from: huge }]
  })
  assert.ok(existsSync(blockFile('soft-probe')), 'a soft warn never blocks the write')
  assert.ok(value.blockBytes > 16 * 1024 * 1024)
  assert.match(value.warning, /16777216-byte soft-warn line/)
  assert.match(value.warning, /renders normally/)
})

console.log('--- 10. the capture index: groups, totals, dropped, dangling ---')
const cap = material('capture-index')
put(cap, 'entry.html', '<!doctype html>\n<html><head><link rel="stylesheet" href="./app.css"></head><body><img src="./logo.png"><img src="./missing.png"></body></html>\n')
put(cap, 'app.css', 'body{background:url("./bg.png")}\n')
putBytes(cap, 'logo.png', Buffer.from([1, 2, 3]))
putBytes(cap, 'bg.png', Buffer.from([4, 5]))
put(cap, 'font.woff2', 'not-really-a-font')
putBytes(cap, 'sprite.stream', Buffer.from([1]))
const capFiles = ['app.css', 'bg.png', 'entry.html', 'font.woff2', 'logo.png', 'sprite.stream'].map((rel) => ({ path: rel, bytes: sizeOf(join(cap, rel)) }))
const capReport = { dropped: [{ url: 'https://example.test/y.png', reason: 'Failed to fetch' }] }
await ta('files are grouped by type, bytes totalled, dropped summarised', async () => {
  const index = await blockBuild.indexMaterial(cap, capFiles, capReport)
  assert.equal(index.count, 6)
  assert.equal(index.totalBytes, capFiles.reduce((sum, file) => sum + file.bytes, 0))
  assert.deepEqual(index.groups.html.map((file) => file.path), ['entry.html'])
  assert.deepEqual(index.groups.css.map((file) => file.path), ['app.css'])
  assert.deepEqual(index.groups.images.map((file) => file.path), ['bg.png', 'logo.png'])
  assert.deepEqual(index.groups.fonts.map((file) => file.path), ['font.woff2'])
  assert.deepEqual(index.groups.other.map((file) => file.path), ['sprite.stream'])
  assert.equal(index.dropped.count, 1)
  assert.deepEqual(index.dropped.items[0], { url: 'https://example.test/y.png', reason: 'Failed to fetch' })
  assert.equal(index.fromDir, cap)
})
await ta('the dangling list is what the capture does NOT have, and the render says so', async () => {
  const index = await blockBuild.indexMaterial(cap, capFiles, capReport)
  assert.equal(index.dangling.length, 1)
  assert.deepEqual(index.dangling[0], { where: 'entry.html', line: 2, ref: './missing.png', path: 'missing.png' })
  const value = { dir: cap, files: capFiles.map((file) => ({ ...file, from: join(cap, file.path) })), report: capReport, summary: '6 file(s), 20 bytes total, 1 resource(s) dropped', fromDir: cap, index }
  const text = mount({})('capture_page').output.render({}, value).map((part) => part.text).join('\n')
  assert.match(text, /index: 6 file\(s\)/)
  assert.match(text, /DANGLING — referenced but not captured \(1\)/)
  assert.match(text, /entry\.html:2 +\.\/missing\.png -> missing\.png/)
  assert.match(text, /create_ui_block\(\{ name: "capture-index", fromDir: "/)
})

await rm(home, { recursive: true, force: true })

console.log('\nself-check-blockbuild: ' + String(n) + ' assertions passed')
