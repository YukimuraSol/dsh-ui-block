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
const { timeline } = await import(pathToFileURL(join(here, 'index.js')).href)
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
  assert.match(hostSource, /RENDERED AT MESSAGE TIME/)
  assert.match(readmeSource, /按消息时刻还原/)
})

rmSync(home, { recursive: true, force: true })

console.log('\nself-check-uiblock-directive: ' + n + ' assertions passed')
