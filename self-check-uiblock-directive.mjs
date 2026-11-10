/**
 * Self-check for the dsh-ui-block DIRECTIVE trigger (new spelling, 2026-10-24).
 *
 *   node self-check-uiblock-directive.mjs
 *
 * The ONE trigger is a whole message line that is exactly:
 *
 *   ::dsh-ui <name>::
 *   ::dsh-ui <name> res=WxH::
 *
 * The old spelling (a bare fenced code block whose BODY FIRST LINE was
 * 'dsh-ui ref: ui-blocks/<name>.uiblock') is RETIRED and must have no
 * recognition path left at all.
 *
 * The script lifts the [directive-parsers] region of client.js verbatim into a
 * function sandbox (it is DOM-free by contract), so a parsing regression fails
 * here instead of silently mis-rendering a block in the app.
 *
 * 2026-10-25: sections 9-12 cover the change history (baseline + line patches)
 * and the message-time pin, against a throwaway DSH_HOME on disk.
 */
import { readFileSync, mkdtempSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { tmpdir } from 'node:os'
import assert from 'node:assert/strict'

const here = dirname(fileURLToPath(import.meta.url))
const clientPath = join(here, 'client.js')
const source = readFileSync(clientPath, 'utf8')
const hostSource = readFileSync(join(here, 'index.js'), 'utf8')
const readmeSource = readFileSync(join(here, 'README.md'), 'utf8')

const START = '// [directive-parsers]'
const END = '// [/directive-parsers]'
const startAt = source.indexOf(START)
const endAt = source.indexOf(END)
if (startAt < 0 || endAt < 0 || endAt < startAt) {
  console.error('self-check: [directive-parsers] region not found in client.js')
  process.exit(2)
}
const region = source.slice(source.indexOf('\n', startAt) + 1, endAt)
if (/document|window|getComputedStyle/.test(region)) {
  console.error('self-check: the parser region must stay DOM-free')
  process.exit(2)
}

// The region reads these constants from the module scope above it; lift the
// declarations themselves so the sandbox mirrors the real scope.
const consts = []

for (const name of ['DEFAULT_RES', 'MIN_RES', 'MAX_RES', 'MIN_VIEW_H', 'FALLBACK_VIEW_H', 'MAX_META_VIEW_H']) {
  const match = new RegExp('var\\s+' + name + '\\s*=\\s*(\\{[^}]*\\}|[\\d.]+)\\s*;').exec(source)
  if (!match) { console.error('self-check: constant ' + name + ' not found in client.js'); process.exit(2) }
  consts.push('var ' + name + ' = ' + match[1] + ';')
}

const api = new Function(
  consts.join('\n') + '\n' + region +
  '; return { DIRECTIVE_RE, DIRECTIVE_MAX, DEFAULT_RES, MIN_RES, MAX_RES, parseDirectiveLine, directivePath, directiveRes, clampRes, formatRes };'
)()

let n = 0
/** Run one assertion group; every throw fails the whole check. */
const t = (name, fn) => {
  fn()
  n += 1
  console.log('  ok - ' + name)
}

console.log('--- 1. the plain directive ---')
t('::dsh-ui foo:: hits, name=foo, no size', () => {
  assert.deepEqual(api.parseDirectiveLine('::dsh-ui foo::'), { name: 'foo', res: null })
})
t('names with dots, dashes and underscores hit', () => {
  assert.deepEqual(api.parseDirectiveLine('::dsh-ui login-modal.v2_b::'), { name: 'login-modal.v2_b', res: null })
})

console.log('--- 2. the size clause ---')
t('::dsh-ui foo res=820x510:: hits at 820x510', () => {
  assert.deepEqual(api.parseDirectiveLine('::dsh-ui foo res=820x510::'), { name: 'foo', res: { w: 820, h: 510 } })
})
t('no res= means the 1440x900 default', () => {
  assert.deepEqual(api.directiveRes(api.parseDirectiveLine('::dsh-ui foo::')), { w: 1440, h: 900 })
  assert.deepEqual(api.directiveRes(api.parseDirectiveLine('::dsh-ui foo res=820x510::')), { w: 820, h: 510 })
})

console.log('--- 3. surrounding whitespace is tolerated ---')
t('leading and trailing spaces still hit', () => {
  assert.deepEqual(api.parseDirectiveLine('   ::dsh-ui foo::   '), { name: 'foo', res: null })
})
t('tabs around and inside still hit', () => {
  assert.deepEqual(api.parseDirectiveLine('\t::dsh-ui\tfoo\tres=820x510::\t'), { name: 'foo', res: { w: 820, h: 510 } })
})

console.log('--- 4. extra content on the line kills it ---')
t('text after the directive does not hit', () => {
  assert.equal(api.parseDirectiveLine('::dsh-ui foo:: 看这里'), null)
})
t('text before the directive does not hit', () => {
  assert.equal(api.parseDirectiveLine('看这里 ::dsh-ui foo::'), null)
})
t('a missing leading :: does not hit', () => {
  assert.equal(api.parseDirectiveLine('dsh-ui foo::'), null)
})
t('a missing trailing :: does not hit', () => {
  assert.equal(api.parseDirectiveLine('::dsh-ui foo'), null)
})
t('two directives on one line do not hit', () => {
  assert.equal(api.parseDirectiveLine('::dsh-ui foo:: ::dsh-ui bar::'), null)
})
t('the name must be followed by a separator', () => {
  assert.equal(api.parseDirectiveLine('::dsh-uifoo::'), null)
})

console.log('--- 5. code blocks are never read ---')
t('a backticked / fenced spelling never hits the line parser', () => {
  assert.equal(api.parseDirectiveLine('`::dsh-ui foo::`'), null)
  assert.equal(api.parseDirectiveLine('```::dsh-ui foo::```'), null)
  assert.equal(api.parseDirectiveLine('```'), null)
})
t('the client refuses nodes inside pre/code by selector', () => {
  assert.match(source, /closest\('[^']*pre, code'\)/)
})
t('the client only ever reads paragraph and list-item nodes', () => {
  assert.match(source, /querySelectorAll\('p, li'\)/)
})

console.log('--- 6. the old spelling is GONE (no recognition path left) ---')
t('the retired fence line does not hit', () => {
  assert.equal(api.parseDirectiveLine('dsh-ui ref: ui-blocks/foo.uiblock'), null)
  assert.equal(api.parseDirectiveLine('dsh-ui ref: ui-blocks/foo.uiblock res=820x510'), null)
  assert.equal(api.parseDirectiveLine('  ref: ui-blocks/foo.uiblock'), null)
})
t('client.js keeps no code path for the fenced trigger', () => {
  for (const dead of ['parseRefLine', 'parseRefRes', 'isPartialRefLine', 'REF_RE', 'REF_PREFIX', 'REF_STEM_RE',
    'isUiTrigger', 'stripUiPrefix', 'splitMeta', 'parseMetaLine', 'META_KEYS']) {
    assert.equal(source.includes(dead), false, 'client.js still mentions ' + dead)
  }
})
t('the code block shell is the CHAT component, not a lookalike (2026-10-24 user call)', () => {
  assert.match(source, /require\('@deepseek-ai\/dsh-client-ui-primitives'\)/)
  assert.match(source, /primitives\.CodeBlock/)
  assert.equal(source.includes("var LANG_LABEL = 'dsh-ui';"), true)
  assert.equal(source.includes("toolbarLabels: { codeLabel: LANG_LABEL"), true)
  assert.equal(source.includes("'.md-code-block.dshpb-active>[data-code-block-content]>pre{display:none!important}'"), true)
})

console.log('--- 7. an ill-formed size is rejected consistently ---')
t('res=axb is not a size, and not a directive', () => {
  assert.equal(api.parseDirectiveLine('::dsh-ui foo res=axb::'), null)
})
t('res=0x0 is not a size, and not a directive', () => {
  assert.equal(api.parseDirectiveLine('::dsh-ui foo res=0x0::'), null)
})
t('a truncated size is rejected too', () => {
  assert.equal(api.parseDirectiveLine('::dsh-ui foo res=820::'), null)
  assert.equal(api.parseDirectiveLine('::dsh-ui foo res=820x::'), null)
  assert.equal(api.parseDirectiveLine('::dsh-ui foo res=820x510x9::'), null)
})
t('a well-formed but extreme size is clamped like the canvas control', () => {
  assert.deepEqual(api.parseDirectiveLine('::dsh-ui foo res=10x10::').res, { w: api.MIN_RES, h: api.MIN_RES })
  assert.deepEqual(api.parseDirectiveLine('::dsh-ui foo res=99999x99999::').res, { w: api.MAX_RES, h: api.MAX_RES })
})

console.log('--- 8. the block path the directive names ---')
t('directivePath maps a name to ui-blocks/<name>.uiblock', () => {
  assert.equal(api.directivePath('foo'), 'ui-blocks/foo.uiblock')
})
t('directiveRes is the canvas default the host screenshots at', () => {
  assert.deepEqual(api.DEFAULT_RES, { w: 1440, h: 900 })
  assert.deepEqual(api.directiveRes({ res: null }), api.DEFAULT_RES)
})


// ---------------------------------------------------------------------------
// 9-13. change history (baseline + patches) and the message-time pin, against
// real files in a throwaway DSH_HOME, via the host module's own test seam.
// ---------------------------------------------------------------------------
const home = mkdtempSync(join(tmpdir(), 'dsh-uiblock-selfcheck-'))
process.env.DSH_HOME = home
const { timeline, apply } = await import(pathToFileURL(join(here, 'index.js')).href)
const sleep = (ms) => new Promise((done) => setTimeout(done, ms))
const sha = (text) => createHash('sha256').update(String(text), 'utf8').digest('hex')
const ta = async (name, fn) => { await fn(); n += 1; console.log('  ok - ' + name) }

console.log('--- 9. the line diff is lossless, and it stays a diff ---')
t('40 random edits replay to exactly the new body', () => {
  let seed = 20261025
  const rand = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648 }
  for (let round = 0; round < 40; round += 1) {
    const before = []
    const count = 1 + Math.floor(rand() * 12)
    for (let i = 0; i < count; i += 1) before.push('line-' + Math.floor(rand() * 6) + '-' + i)
    const after = before.slice()
    const edits = 1 + Math.floor(rand() * 3)
    for (let e = 0; e < edits; e += 1) {
      const at = Math.floor(rand() * (after.length + 1))
      const op = rand()
      if (op < 0.34) after.splice(at, 1)
      else if (op < 0.67) after.splice(at, 0, 'new-' + Math.floor(rand() * 100))
      else if (after.length > 0) after[Math.min(at, after.length - 1)] = 'edit-' + Math.floor(rand() * 100)
    }
    assert.deepEqual(timeline.applyHunks(before, timeline.diffLines(before, after)), after, 'round ' + round)
  }
})
t('one changed line in a 200-line body stays a couple of lines', () => {
  const before = Array.from({ length: 200 }, (_, i) => '<div>row ' + i + '</div>')
  const after = before.slice()
  after[100] = '<div>changed</div>'
  const hunks = timeline.diffLines(before, after)
  assert.deepEqual(timeline.applyHunks(before, hunks), after)
  const added = hunks.reduce((sum, hunk) => sum + hunk.a.length, 0)
  assert.ok(added <= 2, 'a one-line change rewrote ' + added + ' lines')
})
t('a corrupt hunk is refused instead of rewriting the block', () => {
  assert.throws(() => timeline.applyHunks(['a', 'b'], [{ s: 5, d: 1, a: ['x'] }]), /does not fit/)
  assert.throws(() => timeline.applyHunks(['a'], [{ s: 'x', d: 0, a: [] }]), /malformed/)
})

const blockName = 'timeline-probe'
mkdirSync(join(home, 'ui-blocks'), { recursive: true })
const blockFile = join(home, 'ui-blocks', blockName + '.uiblock')
const rows = (tag) => Array.from({ length: 120 }, (_, i) => '  <div class="pb-row">row ' + i + ' ' + tag + '</div>').join('\n')
const v1 = '<div class="pb">\n' + rows('v1') + '\n</div>\n'
const v2 = v1.replace('row 60 v1', 'row 60 v2')
const v3 = v2.replace('</div>\n', '  <footer>after v3</footer>\n</div>\n')
const v4 = v3.replace('row 0 v1', 'row 0 v4')
const v5 = v4.replace('row 119 v1', 'row 119 v5')
const versions = [v1, v2, v3, v4]

console.log('--- 10. the history is one baseline plus patches, never a full copy ---')
await ta('every version written to disk is recorded', async () => {
  for (const body of versions) {
    writeFileSync(blockFile, body, 'utf8')
    await sleep(4)
    await timeline.recordChange(blockName, body)
  }
})
await ta('the history directory holds only base.uiblock and log.json', async () => {
  assert.deepEqual(readdirSync(timeline.historyDir(blockName)).sort(), ['base.uiblock', 'log.json'])
})
await ta('the baseline is the FIRST version, and it is stored once', async () => {
  const history = await timeline.readHistory(blockName)
  assert.equal(sha(history.base), sha(v1))
  assert.equal(history.entries.length, versions.length - 1)
})
await ta('the whole history is smaller than the versions it describes', async () => {
  const dir = timeline.historyDir(blockName)
  const stored = statSync(join(dir, 'base.uiblock')).size + statSync(join(dir, 'log.json')).size
  const copies = versions.reduce((sum, body) => sum + Buffer.byteLength(body, 'utf8'), 0)
  assert.ok(stored < copies / 2, 'history ' + stored + ' bytes vs ' + copies + ' bytes of full copies')
})
await ta('no change, no log line', async () => {
  await timeline.recordChange(blockName, v4)
  assert.equal((await timeline.readHistory(blockName)).entries.length, versions.length - 1)
})

console.log('--- 10b. the log is bounded: rotation at the cap and at 100 versions ---')
await ta('the caps are 8 MB per log, 64 MB per block, 100 versions kept', () => {
  assert.equal(timeline.HISTORY_LOG_MAX_BYTES, 8 * 1024 * 1024)
  assert.equal(timeline.HISTORY_BLOCK_MAX_BYTES, 64 * 1024 * 1024)
  assert.equal(timeline.HISTORY_KEEP_ENTRIES, 100)
})
await ta('past 100 changes the log rotates: newest still exact, stored bytes stay small', async () => {
  const name = 'cap-probe'
  const file = join(home, 'ui-blocks', name + '.uiblock')
  mkdirSync(join(home, 'ui-blocks'), { recursive: true })
  let body = v1
  writeFileSync(file, body, 'utf8')
  await timeline.recordChange(name, body)
  for (let round = 0; round < 105; round += 1) {
    body = v1.replace('row 0 v1', 'row 0 round' + String(round))
    writeFileSync(file, body, 'utf8')
    await timeline.recordChange(name, body)
  }
  const history = await timeline.readHistory(name)
  assert.ok(history.entries.length <= timeline.HISTORY_KEEP_ENTRIES, 'entries=' + String(history.entries.length))
  assert.equal(timeline.replayHistory(history, null), body, 'the newest version replays exactly')
  const dir = timeline.historyDir(name)
  const stored = statSync(join(dir, 'base.uiblock')).size + statSync(join(dir, 'log.json')).size
  assert.ok(stored < 1024 * 1024, 'history stayed small: ' + String(stored) + ' bytes')
})
await ta('a log past the cap is rebuilt from the body instead of replayed', async () => {
  const name = 'big-log-probe'
  const dir = timeline.historyDir(name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'base.uiblock'), 'an old baseline\n', 'utf8')
  writeFileSync(join(dir, 'log.json'), 'x'.repeat(timeline.HISTORY_LOG_MAX_BYTES + 4096), 'utf8')
  const body = '<div class="pb">fresh</div>\n'
  writeFileSync(join(home, 'ui-blocks', name + '.uiblock'), body, 'utf8')
  const result = await timeline.recordChange(name, body)
  assert.equal(result.kind, 'rebase')
  assert.equal(readFileSync(join(dir, 'log.json'), 'utf8'), '')
  assert.equal(readFileSync(join(dir, 'base.uiblock'), 'utf8'), body)
})
await ta('trimHistory cuts an over-grown history and touches no block file', async () => {
  const name = 'trim-probe'
  const dir = timeline.historyDir(name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'base.uiblock'), 'stale baseline\n', 'utf8')
  writeFileSync(join(dir, 'log.json'), 'y'.repeat(24 * 1024 * 1024), 'utf8')
  const body = '<div class="pb">the live page</div>\n'
  const live = join(home, 'ui-blocks', name + '.uiblock')
  writeFileSync(live, body, 'utf8')
  const liveSha = sha(body)
  const result = await timeline.trimHistory()
  assert.ok(result.before - result.after > 20 * 1024 * 1024, 'before=' + String(result.before) + ' after=' + String(result.after))
  assert.equal(sha(readFileSync(live, 'utf8')), liveSha, 'the block file is byte-identical')
  assert.equal(statSync(join(dir, 'log.json')).size, 0)
  assert.equal(readFileSync(join(dir, 'base.uiblock'), 'utf8'), body)
  assert.ok(result.blocks.some((entry) => entry.name === name))
})
await ta('a whole-body rewrite of a big block is rebased, never handed to Myers', async () => {
  const name = 'wide-probe'
  const file = join(home, 'ui-blocks', name + '.uiblock')
  const wide = (tag) => Array.from({ length: 6000 }, (_, i) => '  <div class="pb-row">' + tag + ' ' + String(i) + '</div>').join('\n')
  writeFileSync(file, wide('a'), 'utf8')
  await timeline.recordChange(name, wide('a'))
  const started = Date.now()
  const result = await timeline.recordChange(name, wide('b'))
  assert.equal(result.kind, 'rebase')
  assert.ok(Date.now() - started < 5000, 'it did not try to diff ' + String(6000) + ' lines')
  assert.equal(readFileSync(join(timeline.historyDir(name), 'log.json'), 'utf8'), '')
  assert.equal(readFileSync(join(timeline.historyDir(name), 'base.uiblock'), 'utf8'), wide('b'))
  rmSync(file, { force: true })
})

// Those three blocks were only there to exercise the caps; the disk is shared with
// the listBlocks assertion further down, which expects one block.
for (const name of ['cap-probe', 'big-log-probe', 'trim-probe']) rmSync(join(home, 'ui-blocks', name + '.uiblock'), { force: true })

await ta('trimHistory leaves a history that is inside the caps alone', async () => {
  const before = statSync(join(timeline.historyDir('timeline-probe'), 'log.json')).size
  await timeline.trimHistory()
  assert.equal(statSync(join(timeline.historyDir('timeline-probe'), 'log.json')).size, before)
})

console.log('--- 11. ?at= replays the version that existed at that moment (sha equal) ---')
await ta('every version is reproducible at its own moment', async () => {
  const history = await timeline.readHistory(blockName)
  for (let i = 0; i < versions.length; i += 1) {
    const at = i === 0 ? history.entries[0].at - 1 : history.entries[i - 1].at
    assert.equal(sha(timeline.replayHistory(history, at)), sha(versions[i]), 'version ' + (i + 1))
  }
})
await ta('a middle moment returns the middle version, not the newest', async () => {
  const history = await timeline.readHistory(blockName)
  const atV2 = history.entries[0].at
  assert.equal(sha(await timeline.contentAt(blockName, atV2, 'fallback')), sha(v2))
  assert.equal(sha(timeline.replayHistory(history, null)), sha(v4))
})
await ta('a moment before the first patch is the baseline', async () => {
  const history = await timeline.readHistory(blockName)
  assert.equal(sha(await timeline.contentAt(blockName, history.entries[0].at - 1, 'x')), sha(v1))
})
await ta('a block with no history falls back to its live body', async () => {
  assert.equal(await timeline.contentAt('no-such-block', 0, 'live-body'), 'live-body')
})

console.log('--- 12. ?pin= pins once, keeps the moment, and freezes that message ---')
await ta('the same node key and index always answer the same moment', async () => {
  const first = await timeline.pinMoment(blockName, '12:assistant-step42', 0)
  await sleep(6)
  const second = await timeline.pinMoment(blockName, '12:assistant-step42', 0)
  assert.equal(second, first)
  const pins = JSON.parse(readFileSync(timeline.pinsFile(), 'utf8'))
  assert.equal(typeof pins[blockName + '|12:assistant-step42|0'], 'number')
})
await ta('a later edit does not move the pinned version', async () => {
  const pinned = await timeline.pinMoment(blockName, '12:assistant-step42', 0)
  writeFileSync(blockFile, v5, 'utf8')
  await sleep(4)
  await timeline.recordChange(blockName, v5)
  assert.equal(sha(await timeline.contentAt(blockName, pinned, 'x')), sha(v4))
  assert.equal(sha(await timeline.contentAt(blockName, null, 'x')), sha(v5))
})
await ta('a different index is a different reference (its own pin)', async () => {
  const other = await timeline.pinMoment(blockName, '12:assistant-step42', 1)
  assert.equal(typeof other, 'number')
  const pins = JSON.parse(readFileSync(timeline.pinsFile(), 'utf8'))
  assert.equal(typeof pins[blockName + '|12:assistant-step42|1'], 'number')
})
await ta('history and pins are not listed as blocks', async () => {
  assert.deepEqual(await timeline.listBlocks(), [blockName])
})

console.log('--- 13. the client asks for that moment, and stops re-reading it ---')
t('the pin comes from the message node', () => {
  assert.match(source, /closest\('\[data-chat-node-key\]'\)/)
})
t('the request carries the node key and the reference index', () => {
  assert.match(source, /\?pin=' \+ encodeURIComponent/)
  assert.match(source, /&i=' \+ String\(pin\.index\)/)
})
t('a pinned reference is frozen: no TTL re-read', () => {
  assert.match(source, /return state\.pinned \? entry\.text === null : true/)
})
t('without a chat node the client keeps the old newest behaviour', () => {
  assert.match(source, /if \(host === null\) return null;/)
})
t('the reference syntax itself is untouched', () => {
  assert.match(source, /var DIRECTIVE_RE = \/\^\[ \\t\]\*::dsh-ui\[ \\t\]\+/)
})
t('the tool description and the README both say it', () => {
  assert.match(hostSource, /renders the version the block had when that message was first seen/)
  assert.match(readmeSource, /按消息时刻还原/)
})

// ---------------------------------------------------------------------------
// 14-16. SECTIONS (2026-11-04): one file, virtual files. A marker line
// '<!-- @@file <path> [base64] -->' starts a virtual file; the entry before it
// is served at /ui-blocks/<name>, every section at /ui-blocks/<name>/<path>.
// ---------------------------------------------------------------------------
const MARK = '<!-- @@file '
const fontBytes = Buffer.from([0x77, 0x4f, 0x46, 0x32, 0x00, 0x01, 0x02, 0x03, 0xff])

console.log('--- 14. section parsing ---')
t('a marker line splits the entry from one virtual file', () => {
  const split = timeline.splitSections('<div>entry</div>\n' + MARK + 'panel.css -->\n.a{color:red}\n')
  assert.equal(split.entry, '<div>entry</div>')
  assert.deepEqual(split.files.map((file) => [file.path, file.base64, file.body]), [['panel.css', false, '.a{color:red}\n']])
})
t('no marker: no sections, and the entry is the whole file', () => {
  const text = '<div class="pb">plain</div>\n'
  const split = timeline.splitSections(text)
  assert.equal(split.files.length, 0)
  assert.equal(split.entry, text)
})
t('sections keep file order and each runs to the next marker', () => {
  const split = timeline.splitSections(
    MARK + 'a.css -->\nA\n' +
    MARK + 'img/b.svg -->\n<svg/>\n' +
    MARK + 'f.woff2 base64 -->\nAAAA\n')
  assert.deepEqual(split.files.map((file) => file.path), ['a.css', 'img/b.svg', 'f.woff2'])
  assert.equal(split.files[0].body, 'A')
  assert.equal(split.files[1].body, '<svg/>')
  assert.equal(split.files[2].base64, true)
  assert.equal(split.files[2].body, 'AAAA\n')
})
t('CRLF and trailing spaces around a marker still split', () => {
  const split = timeline.splitSections('x\r\n' + MARK + 'a.css -->  \r\nbody{}')
  assert.equal(split.files.length, 1)
  assert.equal(split.files[0].path, 'a.css')
  assert.equal(split.files[0].body, 'body{}')
})
t('base64 decodes to exactly the bytes the file holds', () => {
  const split = timeline.splitSections(MARK + 'f.woff2 base64 -->\n' + fontBytes.toString('base64') + '\n')
  const decoded = Buffer.from(split.files[0].body.trim(), 'base64')
  assert.equal(decoded.length, fontBytes.length)
  assert.deepEqual([...decoded], [...fontBytes])
})
t('a marker inside a longer line is NOT a section', () => {
  assert.equal(timeline.splitSections('<p>see ' + MARK + 'x.css --></p>').files.length, 0)
})

console.log('--- 15. the section guard ---')
t('traversal, absolute and empty paths are refused (404)', () => {
  for (const bad of ['../package.json', 'a/../../package.json', '/etc/passwd', '', 'a\\b.css']) {
    assert.throws(() => timeline.sectionType(bad), (error) => error.status === 404, 'accepted ' + JSON.stringify(bad))
  }
})
t('an unknown extension is 415, never a guess', () => {
  // html/htm ARE section types (a block can carry whole pages); the rest are not.
  for (const bad of ['notes.txt', 'noext', 'x.js', 'stream']) {
    assert.throws(() => timeline.sectionType(bad), (error) => error.status === 415, 'accepted ' + bad)
  }
})
t('every whitelisted extension maps to a real content type', () => {
  assert.equal(timeline.sectionType('panel.css'), 'text/css; charset=utf-8')
  assert.equal(timeline.sectionType('logo.svg'), 'image/svg+xml')
  assert.equal(timeline.sectionType('img/deep/LOGO.PNG'), 'image/png')
  assert.equal(timeline.sectionType('f.woff2'), 'font/woff2')
  assert.equal(timeline.sectionType('f.ttf'), 'font/ttf')
  assert.equal(timeline.sectionType('page.html'), 'text/html; charset=utf-8')
  assert.equal(timeline.sectionType('page.htm'), 'text/html; charset=utf-8')
})
t('the host carries one CSP for the entry and every section, still no script', () => {
  assert.match(hostSource, /'content-security-policy': BLOCK_CSP/)
  assert.match(hostSource, /style-src 'self' 'unsafe-inline'/)
  assert.match(hostSource, /script-src 'none'/)
  // The ceilings are config now: 2 MB per file, 64 MB per block, 16 MB soft warn.
  assert.match(hostSource, /sectionBytes: 2 \* 1024 \* 1024/)
  assert.match(hostSource, /blockBytes: 64 \* 1024 \* 1024/)
  assert.match(hostSource, /softWarnBytes: 16 \* 1024 \* 1024/)
})
t('the client swaps srcdoc for a URL only when sections are present', () => {
  assert.match(source, /function hasSections\(text\)/)
  assert.match(source, /state\.frame\.setAttribute\('src', entryUrl\(state\)\)/)
  assert.match(source, /state\.frame\.setAttribute\('srcdoc', buildSrcdoc\(state, tokenCache\)\)/)
})
t('a served document gets the token sheet first in head, hidden until it is in', () => {
  assert.match(source, /doc\.head\.insertBefore\(style, doc\.head\.firstChild\)/)
  assert.match(source, /state\.frame\.style\.visibility = 'hidden'/)
  assert.match(source, /state\.frame\.style\.visibility = ''/)
})

console.log('--- 16. the /ui-blocks route, driven directly ---')
const routes = []
apply({
  tools: { register: () => undefined },
  get: () => undefined,
  inject: (names, fn) => fn({ webServer: { register: (entry) => routes.push(entry) } })
})
const route = routes.find((entry) => entry.path === '/ui-blocks')
const call = async (raw) => {
  const answer = { status: 0, headers: {}, body: null }
  await route.handler(
    { method: 'GET', url: raw, headers: {} },
    { writeHead: (status, headers) => { answer.status = status; answer.headers = headers || {} }, end: (payload) => { answer.body = payload } }
  )
  return answer
}
const html = (value) => (Buffer.isBuffer(value) ? value.toString('utf8') : String(value))

const entryHtml = '<!doctype html><html><head><link rel="stylesheet" href="./panel.css"></head><body><div class="Ww4dvW_card">hi</div></body></html>'
const cssV1 = '.Ww4dvW_card{color:var(--dsw-alias-label-primary)}\n'
const cssV2 = '.Ww4dvW_card{color:rgb(1, 2, 3)}\n'
const svgText = '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8"/></svg>\n'
const sectioned = (css) => entryHtml + '\n' + MARK + 'panel.css -->\n' + css + MARK + 'logo.svg -->\n' + svgText + MARK + 'f.woff2 base64 -->\n' + fontBytes.toString('base64') + '\n'
const probe = join(home, 'ui-blocks', 'section-probe.uiblock')
const plainProbe = join(home, 'ui-blocks', 'plain-probe.uiblock')
const plainBody = '<div class="pb">plain</div>\n'
writeFileSync(probe, sectioned(cssV1), 'utf8')
writeFileSync(plainProbe, plainBody, 'utf8')

await ta('a block with no marker still answers its .uiblock byte for byte', async () => {
  const answer = await call('/ui-blocks/plain-probe.uiblock')
  assert.equal(answer.status, 200)
  assert.equal(answer.headers['content-type'], 'text/plain; charset=utf-8')
  assert.equal(html(answer.body), plainBody)
  assert.equal(answer.headers['x-uiblock-at'], 'live')
  assert.equal(answer.headers['content-security-policy'], undefined)
})
await ta('the entry is a document, with the CSP header', async () => {
  const answer = await call('/ui-blocks/section-probe')
  assert.equal(answer.status, 200)
  assert.equal(answer.headers['content-type'], 'text/html; charset=utf-8')
  assert.equal(html(answer.body), entryHtml)
  assert.match(answer.headers['content-security-policy'], /^default-src 'none'; style-src 'self' 'unsafe-inline';/)
  assert.match(answer.headers['content-security-policy'], /script-src 'none'/)
})
await ta('the trailing-slash spelling serves the same entry (relative paths need it)', async () => {
  const answer = await call('/ui-blocks/section-probe/')
  assert.equal(answer.status, 200)
  assert.equal(answer.headers['content-type'], 'text/html; charset=utf-8')
  assert.equal(html(answer.body), entryHtml)
})
await ta('each section is served with its own content type and the same CSP', async () => {
  const css = await call('/ui-blocks/section-probe/panel.css')
  assert.equal(css.status, 200)
  assert.equal(css.headers['content-type'], 'text/css; charset=utf-8')
  assert.equal(html(css.body), cssV1.trim())
  assert.match(css.headers['content-security-policy'], /font-src 'self' data:/)
  const svg = await call('/ui-blocks/section-probe/logo.svg')
  assert.equal(svg.status, 200)
  assert.equal(svg.headers['content-type'], 'image/svg+xml')
  assert.equal(html(svg.body), svgText.trim())
  const font = await call('/ui-blocks/section-probe/f.woff2')
  assert.equal(font.status, 200)
  assert.equal(font.headers['content-type'], 'font/woff2')
  assert.equal(font.body.length, fontBytes.length)
  assert.deepEqual([...font.body], [...fontBytes])
})
await ta('a missing section is a 404, not an empty 200', async () => {
  assert.equal((await call('/ui-blocks/section-probe/nope.css')).status, 404)
  assert.equal((await call('/ui-blocks/plain-probe/panel.css')).status, 404)
})
await ta('an unknown extension is a 415', async () => {
  writeFileSync(join(home, 'ui-blocks', 'txt-probe.uiblock'), '<b>x</b>\n' + MARK + 'notes.txt -->\nhello\n', 'utf8')
  assert.equal((await call('/ui-blocks/txt-probe/notes.txt')).status, 415)
})
await ta('a path that walks out of the prefix is a 404, and no file content leaks', async () => {
  const answer = await call('/ui-blocks/x/../../package.json')
  assert.equal(answer.status, 404)
  assert.equal(answer.body, 'not found')
  const encoded = await call('/ui-blocks/x/%2e%2e%2f%2e%2e%2fpackage.json')
  assert.equal(encoded.status, 404)
  const direct = await call('/ui-blocks/../../package.json')
  assert.equal(direct.status, 404)
})
await ta('a section over the 2 MB per-file ceiling is refused with 413', async () => {
  const big = 'a{color:red}'.repeat(200000)
  writeFileSync(join(home, 'ui-blocks', 'big-probe.uiblock'), '<b>x</b>\n' + MARK + 'big.css -->\n' + big + '\n', 'utf8')
  const answer = await call('/ui-blocks/big-probe/big.css')
  assert.equal(answer.status, 413)
  assert.match(html(answer.body), /the limit is 2097152/)
})
await ta('?at= replays the entry AND its stylesheet from one moment', async () => {
  await call('/ui-blocks/section-probe')
  await sleep(12)
  writeFileSync(probe, sectioned(cssV2), 'utf8')
  await sleep(12)
  const live = await call('/ui-blocks/section-probe/panel.css')
  assert.equal(html(live.body), cssV2.trim())
  const history = await timeline.readHistory('section-probe')
  const patchedAt = history.entries[history.entries.length - 1].at
  const at = '?at=' + String(patchedAt - 1)
  const oldEntry = await call('/ui-blocks/section-probe' + at)
  const oldCss = await call('/ui-blocks/section-probe/panel.css' + at)
  assert.equal(html(oldEntry.body), entryHtml)
  assert.equal(html(oldCss.body), cssV1.trim())
  assert.equal(oldEntry.headers['x-uiblock-at'], String(patchedAt - 1))
  assert.equal(oldCss.headers['x-uiblock-at'], String(patchedAt - 1))
})

// ---------------------------------------------------------------------------
// 17. assembleBlock (2026-11-05): the tool takes a virtual FOLDER; the host
// assembles the one body the route already serves. Every rejection here is
// before the disk is touched.
// ---------------------------------------------------------------------------
const cssSource = '.card{color:rgb(9, 8, 7)}\n'
const cssSourcePath = join(home, 'source.css')
writeFileSync(cssSourcePath, cssSource, 'utf8')
const fontPath = join(home, 'KaTeX_Main.woff2')
writeFileSync(fontPath, fontBytes)
const cardHtml = '<!doctype html><html><head><link rel="stylesheet" href="./styles/card.css"></head><body><div class="card">hi</div></body></html>'

console.log('--- 16b. a taken block name lands on -2, and that name answers 200 ---')
await ta('create twice with one name: <name>-2 exists, both serve 200', async () => {
  const localTools = []
  apply({ tools: { register: (definition) => { localTools.push(definition); return () => undefined } }, get: () => undefined, inject: () => undefined })
  const create = localTools.find((definition) => definition.name === 'create_ui_block')
  const first = await create.execute({ name: 'dup-probe', files: [{ path: 'index.html', content: '<div class="pb">one</div>' }] }, {})
  assert.equal(first.name, 'dup-probe')
  const second = await create.execute({ name: 'dup-probe', files: [{ path: 'index.html', content: '<div class="pb">two</div>' }] }, {})
  assert.equal(second.name, 'dup-probe-2')
  assert.equal(second.requested, 'dup-probe')
  assert.equal(second.path, 'ui-blocks/dup-probe-2.uiblock')
  const a = await call('/ui-blocks/dup-probe/')
  const b = await call('/ui-blocks/dup-probe-2/')
  assert.equal(a.status, 200)
  assert.equal(b.status, 200)
  assert.match(html(b.body), /two/)
  assert.match(html(a.body), /one/)
})

console.log('--- 17. the tool assembles a virtual folder ---')
await ta('the entry is index.html, and the sections keep the argument order', async () => {
  const made = await timeline.assembleBlock([
    { path: 'styles/card.css', from: cssSourcePath },
    { path: 'index.html', content: cardHtml },
    { path: 'icons/ok.svg', content: svgText }
  ])
  assert.equal(made.entry, 'index.html')
  assert.deepEqual(made.files.map((file) => file.path), ['styles/card.css', 'index.html', 'icons/ok.svg'])
  const split = timeline.splitSections(made.text)
  assert.equal(split.entry, cardHtml)
  assert.deepEqual(split.files.map((file) => file.path), ['styles/card.css', 'icons/ok.svg'])
  assert.equal(split.files[0].body, cssSource)
  assert.equal(split.files[1].body, svgText)
  assert.equal(made.files[0].bytes, Buffer.byteLength(cssSource))
})
await ta('without index.html the first file is the entry', async () => {
  // cardHtml links ./styles/card.css, so that member has to be here: a block
  // whose entry loads a file it does not carry is refused now (see 18).
  const made = await timeline.assembleBlock([
    { path: 'card.html', content: cardHtml },
    { path: 'styles/card.css', content: '.a{}' }
  ])
  assert.equal(made.entry, 'card.html')
  const split = timeline.splitSections(made.text)
  assert.equal(split.entry, cardHtml)
  assert.deepEqual(split.files.map((file) => file.path), ['styles/card.css'])
})
await ta('entry names another root file; a nested or unknown entry is refused', async () => {
  const made = await timeline.assembleBlock([
    { path: 'styles/card.css', content: 'body{margin:0}' },
    { path: 'card.html', content: cardHtml }
  ], 'card.html')
  assert.equal(made.entry, 'card.html')
  assert.equal(timeline.splitSections(made.text).entry, cardHtml)
  await assert.rejects(timeline.assembleBlock([{ path: 'sub/card.html', content: cardHtml }], 'sub/card.html'), /block root/)
  await assert.rejects(timeline.assembleBlock([{ path: 'index.html', content: cardHtml }], 'card.html'), /is not one of files/)
})
await ta('a binary file is base64 from disk or from content, byte for byte', async () => {
  const fromDisk = await timeline.assembleBlock([{ path: 'index.html', content: cardHtml }, { path: 'styles/card.css', content: cssSource }, { path: 'KaTeX_Main.woff2', from: fontPath }])
  const fromText = await timeline.assembleBlock([{ path: 'index.html', content: cardHtml }, { path: 'styles/card.css', content: cssSource }, { path: 'KaTeX_Main.woff2', content: fontBytes.toString('base64') }])
  for (const made of [fromDisk, fromText]) {
    assert.match(made.text, /<!-- @@file KaTeX_Main\.woff2 base64 -->/)
    const section = timeline.splitSections(made.text).files.find((file) => file.path === 'KaTeX_Main.woff2')
    assert.deepEqual([...Buffer.from(section.body.trim(), 'base64')], [...fontBytes])
    assert.equal(made.files.find((file) => file.path === 'KaTeX_Main.woff2').bytes, fontBytes.length)
  }
})
await ta('a text from file lands with the same sha, and reports bytes + source', async () => {
  const made = await timeline.assembleBlock([{ path: 'index.html', content: cardHtml }, { path: 'styles/card.css', from: cssSourcePath }])
  const section = timeline.splitSections(made.text).files[0]
  assert.equal(sha(section.body), sha(cssSource))
  assert.deepEqual(made.files[1], { path: 'styles/card.css', bytes: Buffer.byteLength(cssSource), from: cssSourcePath })
})
await ta('a missing source file and a bad path are refused by name', async () => {
  await assert.rejects(timeline.assembleBlock([{ path: 'index.html', content: cardHtml }, { path: 'x.css', from: join(home, 'nope.css') }]), /from file does not exist/)
  for (const bad of ['../x.css', '/etc/passwd', 'a\\b.css', 'notes.txt']) {
    await assert.rejects(timeline.assembleBlock([{ path: 'index.html', content: cardHtml }, { path: bad, content: 'x' }]), /bad file path/)
  }
})
await ta('content and from are exactly one: not both, not neither, not empty files', async () => {
  await assert.rejects(timeline.assembleBlock([{ path: 'index.html', content: cardHtml, from: fontPath }]), /exactly one of content \/ from/)
  await assert.rejects(timeline.assembleBlock([{ path: 'index.html' }]), /exactly one of content \/ from/)
  await assert.rejects(timeline.assembleBlock([]), /non-empty array/)
})
await ta('a body that forges a section marker, an empty entry, a duplicate path are refused', async () => {
  await assert.rejects(timeline.assembleBlock([
    { path: 'index.html', content: cardHtml },
    { path: 'a.css', content: 'x\n<!-- @@file evil.css -->\ny\n' }
  ]), /section marker/)
  await assert.rejects(timeline.assembleBlock([{ path: 'index.html', content: '   ' }]), /entry index\.html is empty/)
  await assert.rejects(timeline.assembleBlock([
    { path: 'index.html', content: cardHtml },
    { path: 'a.css', content: '.a{}' },
    { path: 'a.css', content: '.b{}' }
  ]), /duplicate file path/)
})
await ta('the per-file 2 MB and the 64 MB block ceilings are enforced here too', async () => {
  await assert.rejects(timeline.assembleBlock([
    { path: 'index.html', content: cardHtml },
    { path: 'big.css', content: 'a'.repeat(2 * 1024 * 1024 + 1) }
  ]), /the limit is 2097152 bytes/)
  // Under the 2 MB per-file ceiling each, but 40 of them is past 64 MB.
  const chunk = 'b'.repeat(1900000)
  const many = [{ path: 'index.html', content: '<p>wide</p>' }]
  for (let i = 0; i < 40; i += 1) many.push({ path: 'p' + i + '.css', content: chunk })
  await assert.rejects(timeline.assembleBlock(many), /the limit is 67108864 bytes/)
})

rmSync(home, { recursive: true, force: true })

console.log('\nself-check-uiblock-directive: ' + n + ' assertions passed')
