/**
 * Self-check for the dsh-ui-block HOST half (the two file tools).
 *
 *   node self-check.mjs            # registration + file writing (no browser)
 *   node self-check.mjs --shot     # also take one real screenshot end to end
 *
 * It mounts the plugin against a stub Cordis context (a real `tools` service
 * shape, a throwaway DSH_HOME) and asserts the contract the client half and the
 * plan depend on:
 *
 *   1. both tools register, with the plan's verbatim CREATING vs UPDATING text
 *   2. create_ui_block writes BODY ONLY — no meta line, no BOM, sha reproducible
 *   3. a same-named write backs the old file up instead of clobbering it
 *   4. read_ui_block returns a non-empty PNG at the canvas resolution (--shot)
 *
 * The screenshot leg needs a running 4000 instance (its client bundle supplies
 * window.__dshPageBlock.render). Without it the leg is reported SKIPPED, never
 * silently passed.
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SHOT = process.argv.includes('--shot')
const BASE_URL = process.env.DSH_UIBLOCK_BASE_URL ?? 'http://127.0.0.1:4000'
const BODY = [
  '<div class="pb pb-center">',
  '  <div class="pb-card">',
  '    <h1 class="pb-title">自检卡片</h1>',
  '    <p class="pb-sub">read_ui_block 应当拍出这张卡。</p>',
  '    <div class="pb-row pb-row-end"><button class="pb-btn">取消</button><button class="pb-btn pb-btn-primary">确定</button></div>',
  '  </div>',
  '</div>'
].join('\n')

// The create tool takes an explicit file list now (entry + every member), so the
// entry body goes in as files=[{ path: 'index.html', content }] — there is no
// single-body shorthand left to assert against.
const asFiles = (body) => [{ path: 'index.html', content: body }]

const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex')
const tempHome = await mkdtemp(join(tmpdir(), 'dsh-uiblock-home-'))
process.env.DSH_HOME = tempHome

const checks = []
const check = (name, fn) => { fn(); checks.push(name); console.log('  ok - ' + name) }
const checkAsync = async (name, fn) => { await fn(); checks.push(name); console.log('  ok - ' + name) }

const { apply, rendering } = await import('./index.js')

/** The slice of the tools service the plugin uses. */
const registered = []
const stubCtx = {
  tools: { register: (definition) => { registered.push(definition); return () => {} } },
  get: (service) => stubContext[service],
  // A plugin may mount more than one route now (ui-blocks + the extension
  // surface), so the stub records them all and keeps `route` as the FIRST one
  // for the read-route assertion below.
  inject: (services, fn) => { fn({ webServer: { register: (route) => { stubContext.routes.push(route); if (stubContext.route === undefined) stubContext.route = route; return () => {} } } }) },
  logger: { warn: () => {} }
}
const stubContext = { routes: [] }

apply(stubCtx)

console.log('--- 1. registration ---')
const byName = Object.fromEntries(registered.map((definition) => [definition.name, definition]))
check('create_ui_block registered', () => assert.equal(byName.create_ui_block !== undefined, true))
check('read_ui_block registered', () => assert.equal(byName.read_ui_block !== undefined, true))

// The contract as the description actually reads (checked 2026-11-10). The old
// verbatim block quoted wording that does not exist any more ("with the full
// HTML body", "updating one is write or edit on the file"), so it is asserted as
// clauses of the CURRENT contract instead: create through the tool, a taken name
// is a safe replace (never delete first), a whole page can land in one call with
// fromDir, and updating is edit/write on the file in place.
const CREATE_CLAUSES = [
  'CREATING vs UPDATING:',
  '- To CREATE a UI block, call this tool.',
  'A TAKEN NAME IS NEITHER AN ERROR NOR AN OVERWRITE',
  'Do NOT delete the block first',
  '- Do NOT create a .uiblock file with write.',
  '`edit` for a targeted change',
  'FROMDIR — THE WAY TO LAND A WHOLE PAGE IN ONE CALL',
  'capture_page -> create_ui_block({ name, fromDir })'
]
check('create_ui_block description carries every clause of the CREATING vs UPDATING contract', () => {
  assert.equal(byName.create_ui_block.description.includes('CREATING vs UPDATING:'), true)
  for (const clause of CREATE_CLAUSES) {
    assert.equal(byName.create_ui_block.description.includes(clause), true, 'missing clause: ' + clause)
  }
})
// Read is a check, never the delivery: the image goes to the model and the
// rendered entry is the still screen, so a demo block is not a timeline frame.
check('read_ui_block description keeps render-not-delivery (image for the model, the line delivers)', () => {
  assert.equal(byName.read_ui_block.description.includes('THIS IMAGE GOES TO THE MODEL, NOT TO THE USER'), true)
  assert.equal(/renders the entry page/.test(byName.read_ui_block.description), true)
  assert.equal(/::dsh-ui <name>/.test(byName.read_ui_block.description), true)
})
// 真实事故（44.5 s）：描述里写着 ~/.dsh/ui-blocks，模型去那里找块 → MISSING，然后 glob 扫
// C:\ 根、30 s 超时，最后才在 <DSH_HOME>\ui-blocks 找到。描述必须点名这台机器的真身。
check("the block directory in the description is this machine's <DSH_HOME>\\ui-blocks, not ~/.dsh", () => {
  const expected = join(tempHome, 'ui-blocks', '<name>.uiblock')
  assert.equal(byName.create_ui_block.description.includes(expected), true, 'the create description must spell the real path: ' + expected)
  assert.equal(byName.create_ui_block.description.includes('~/.dsh/ui-blocks'), false, 'the old, wrong path is gone')
  assert.equal(byName.create_ui_block.parameters.properties.name.description.includes(expected), true, 'the name parameter must spell it too')
})
check("create_ui_block returns the block's absolute path as its own field (path stays the relative spelling)", () => {
  const schema = byName.create_ui_block.output.schema
  assert.equal(schema.properties.absolutePath.type, 'string')
  assert.equal(schema.required.includes('absolutePath'), true)
  assert.equal(schema.properties.path.type, 'string', 'path is unchanged: the reference line and read_ui_block take it')
  assert.match(schema.properties.absolutePath.description, /ui-blocks/)
})
check('both descriptions teach the ::dsh-ui line and nothing about fences', () => {
  for (const tool of ['create_ui_block', 'read_ui_block']) {
    assert.equal(byName[tool].description.includes('::dsh-ui'), true)
    assert.equal(/fenced code block|dsh-ui ref:/.test(byName[tool].description), false)
  }
})
// The pitfall that cost two sessions: editing a 5.6 MB .uiblock by hand fails
// with "file has not been read" (or, worse, gets read first and is then lost at
// the next rebuild). Both descriptions must say the block is a product.
check('both descriptions say a block is a product, not an edit target, and point at the material', () => {
  for (const tool of ['create_ui_block', 'read_ui_block']) {
    assert.equal(byName[tool].description.includes('A BLOCK IS A PRODUCT, NOT AN EDIT TARGET'), true, tool + ' does not say the block is a product')
    assert.match(byName[tool].description, /rebuild/, tool + ' does not say to rebuild from the material')
    assert.match(byName[tool].description, /\.uiblock by hand/, tool + ' does not name editing the .uiblock by hand')
    assert.match(byName[tool].description, /lost/, tool + ' does not say the hand edit is lost')
  }
  assert.match(byName.create_ui_block.description, /file has not been read/, 'the failure two sessions hit is named')
})
check('read_ui_block declares a timeout budget', () => {
  assert.equal(byName.read_ui_block.timeoutMs > 0, true)
})
check('read_ui_block takes width AND height, both optional canvas geometry', () => {
  const params = byName.read_ui_block.parameters.properties
  assert.equal(params.width.type, 'number')
  assert.equal(params.height.type, 'number')
  assert.deepEqual(byName.read_ui_block.parameters.required, ['name'])
  assert.equal(/canvas/i.test(params.height.description), true)
})
check('create_ui_block still takes no size parameter (size lives on the reference line)', () => {
  // The parameter list grew (entry / files / fromDir); what must never appear is
  // a canvas size, because the size is declared on the ::dsh-ui line alone.
  const props = byName.create_ui_block.parameters.properties
  for (const sizeKey of ['width', 'height', 'res']) assert.equal(props[sizeKey], undefined, 'size parameter leaked: ' + sizeKey)
  assert.equal(/res=WxH/.test(byName.create_ui_block.description), true)
  assert.equal(/280-420/.test(byName.create_ui_block.description), true)
})
check('read_ui_block description tells the caller to match the reference line', () => {
  assert.equal(/same pair/i.test(byName.read_ui_block.description), true)
  assert.equal(/reference line/.test(byName.read_ui_block.description), true)
  assert.equal(/::dsh-ui <name>::/.test(byName.read_ui_block.description), true)
})
check('output schemas require path and image', () => {
  assert.equal(byName.create_ui_block.output.schema.required.includes('path'), true)
  assert.equal(byName.read_ui_block.output.schema.required.includes('image'), true)
  assert.equal(byName.read_ui_block.output.schema.properties.image.properties.attachmentId.type, 'string')
})
check('the read route registered on /ui-blocks (plus the extension surface)', () => {
  assert.equal(stubContext.route.kind, 'prefix')
  assert.equal(stubContext.route.path, '/ui-blocks')
  // The extension surface is a second prefix route, and it is the only other
  // one: the reveal action hangs off that same fixed path.
  const extension = stubContext.routes.find((route) => route.path === '/ui-block-extension')
  assert.equal(extension !== undefined, true)
  assert.equal(extension.kind, 'prefix')
  assert.equal(typeof extension.handler, 'function')
})

console.log('--- 2. create_ui_block writes body only ---')
const first = await byName.create_ui_block.execute({ name: 'selfcheck-card', files: asFiles(BODY), title: '自检' }, {})
const blockFile = join(tempHome, 'ui-blocks', 'selfcheck-card.uiblock')
await checkAsync('returns {path, name}', async () => {
  assert.equal(first.path, 'ui-blocks/selfcheck-card.uiblock')
  assert.equal(first.name, 'selfcheck-card')
})
await checkAsync('file exists at DSH_HOME/ui-blocks/<name>.uiblock', async () => {
  assert.equal(existsSync(blockFile), true)
})
await checkAsync('file content is the body verbatim (no meta line)', async () => {
  const text = await readFile(blockFile, 'utf8')
  assert.equal(text, BODY)
  assert.equal(/^dsh-ui/m.test(text), false)
  assert.equal(/^res=/m.test(text), false)
})
await checkAsync('no BOM, no CRLF rewrite', async () => {
  const bytes = await readFile(blockFile)
  assert.equal(bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf, false)
  assert.equal(bytes.includes(0x0d), false)
})
await checkAsync('sha256 is reproducible from the same input', async () => {
  const a = sha256(await readFile(blockFile))
  await byName.create_ui_block.execute({ name: 'selfcheck-card', files: asFiles(BODY) }, {})
  const b = sha256(await readFile(blockFile))
  assert.equal(a, b)
  assert.equal(a.length, 64)
})

console.log('--- 3. a taken name lands on the next free number, and says which ---')
const v2Body = BODY.replace('自检卡片', '自检卡片 v2')
await checkAsync('a different page under a taken name is written as <name>-2', async () => {
  const before = sha256(await readFile(blockFile))
  const result = await byName.create_ui_block.execute({ name: 'selfcheck-card', files: asFiles(v2Body) }, {})
  assert.equal(result.name, 'selfcheck-card-2', 'the result carries the name that EXISTS')
  assert.equal(result.requested, 'selfcheck-card')
  assert.equal(result.path, 'ui-blocks/selfcheck-card-2.uiblock')
  assert.equal(result.backup, undefined, 'no timestamp backup on the rename path')
  assert.equal(existsSync(join(tempHome, 'ui-blocks', 'selfcheck-card-2.uiblock')), true)
  assert.equal(sha256(await readFile(blockFile)), before, 'the first block is byte-identical')
})
await checkAsync('the result text spells the rename out in one sentence, with the new name', async () => {
  const parts = byName.create_ui_block.output.render({ name: 'selfcheck-card' }, {
    path: 'ui-blocks/selfcheck-card-2.uiblock', name: 'selfcheck-card-2', requested: 'selfcheck-card',
    entry: 'index.html', blockBytes: 1, totalBytes: 1, files: []
  })
  const text = parts.map((part) => (part.text === undefined ? '' : part.text)).join('')
  assert.match(text, /RENAMED — "selfcheck-card" is already taken, so this one was written as "selfcheck-card-2"/)
  assert.match(text, /read_ui_block\(\{ name: "selfcheck-card-2" \}\)/)
  assert.match(text, /::dsh-ui selfcheck-card-2::/)
})
await checkAsync('a third one is -3, and byte-identical content keeps its name', async () => {
  const third = await byName.create_ui_block.execute({ name: 'selfcheck-card', files: asFiles(v2Body.replace('自检卡片 v2', '自检卡片 v3')) }, {})
  assert.equal(third.name, 'selfcheck-card-3')
  assert.equal(third.requested, 'selfcheck-card')
  const same = await byName.create_ui_block.execute({ name: 'selfcheck-card', files: asFiles(BODY) }, {})
  assert.equal(same.name, 'selfcheck-card')
  assert.equal(same.requested, undefined, 'an idempotent rebuild keeps the requested name')
})
await checkAsync('overwrite: true is the in-place path and still keeps .bak', async () => {
  const result = await byName.create_ui_block.execute({ name: 'selfcheck-card', files: asFiles(v2Body), overwrite: true }, {})
  assert.equal(result.name, 'selfcheck-card')
  assert.equal(typeof result.backup, 'string')
  assert.equal(await readFile(result.backup, 'utf8'), BODY)
  assert.equal((await readFile(blockFile, 'utf8')).includes('自检卡片 v2'), true)
})
await checkAsync('the overwrite result text says OVERWROTE, not a footnote', async () => {
  const parts = byName.create_ui_block.output.render({ name: 'selfcheck-card' }, {
    path: 'ui-blocks/selfcheck-card.uiblock', name: 'selfcheck-card', entry: 'index.html',
    blockBytes: 1, totalBytes: 1, files: [], backup: 'ui-blocks/selfcheck-card.uiblock.bak-x'
  })
  const text = parts.map((part) => (part.text === undefined ? '' : part.text)).join('')
  assert.match(text, /OVERWROTE THE PREVIOUS VERSION/)
})

console.log('--- 4. read_ui_block defaults to the FIRST SCREEN ---')
check('no height asked for: the historical 1440x900, and no note', () => {
  const { res, note } = rendering.readCanvas({})
  assert.deepEqual(res, { w: 1440, h: 900 })
  assert.equal(note, undefined)
})
check('a height past 1000 is clamped to the first screen and says both numbers', () => {
  const { res, note } = rendering.readCanvas({ width: 1440, height: 1400 })
  assert.deepEqual(res, { w: 1440, h: rendering.FIRST_SCREEN_H })
  assert.match(note, /FIRST SCREEN \(1440x1000\)/)
  assert.match(note, /1400 px height you asked for/)
  assert.match(note, /fullPage: true/)
})
check('fullPage: true renders exactly the height asked for', () => {
  const { res, note } = rendering.readCanvas({ width: 1440, height: 1400, fullPage: true })
  assert.deepEqual(res, { w: 1440, h: 1400 })
  assert.equal(note, undefined)
})
check('a bad size is still refused, not clamped', () => {
  assert.throws(() => rendering.readCanvas({ height: 0 }), /must be positive pixel counts/)
})
check('probe measures the rendered screen unless fullPage', () => {
  assert.match(rendering.probeScript(['#a'], 1000), /limit=1000/)
  assert.match(rendering.probeScript(['#a'], undefined), /limit=null/)
  assert.match(rendering.formatProbe([['.card', 3, 0, 10, 20, 30, 0]]), /none in the first screen — pass fullPage: true/)
  assert.match(rendering.formatProbe([['.card', 3, 0, 10, 20, 30, 1]]), /3 matches \(1 in the first screen\)/)
})
check('the read tool declares fullPage, and a note in its result', () => {
  assert.equal(byName.read_ui_block.parameters.properties.fullPage.type, 'boolean')
  assert.equal(byName.read_ui_block.output.schema.properties.note.type, 'string')
  assert.equal(/first screen/i.test(byName.read_ui_block.parameters.properties.probe.description), true)
})

console.log('--- 5. name and body guards ---')
await checkAsync('path traversal is rejected', async () => {
  await assert.rejects(() => byName.create_ui_block.execute({ name: '../escape', files: asFiles(BODY) }, {}), /name must be/)
  await assert.rejects(() => byName.create_ui_block.execute({ name: 'a/b', files: asFiles(BODY) }, {}), /name must be/)
})
await checkAsync('empty body is rejected', async () => {
  await assert.rejects(() => byName.create_ui_block.execute({ name: 'x', files: asFiles('   ') }, {}), /entry index\.html is empty/)
})
await checkAsync('read of a missing block names the known ones', async () => {
  // Stub the services so the not-found guard is what fires, not the service guard.
  stubContext.attachments = { saveImage: async () => { throw new Error('unreachable') } }
  stubContext.webServer = { port: 4000 }
  stubContext.connection = { authenticatedUrl: (base) => base }
  await assert.rejects(() => byName.read_ui_block.execute({ name: 'nope' }, {}), /ui block not found: ui-blocks\/nope\.uiblock/)
  assert.equal(byName.read_ui_block !== undefined, true)
})

console.log('--- 6. client contract parity ---')
const clientSource = await readFile(new URL('./client.js', import.meta.url), 'utf8')
check('client DEFAULT_RES is the host DEFAULT_RES (1440x900)', () => {
  assert.equal(/var DEFAULT_RES = \{ w: 1440, h: 900 \};/.test(clientSource), true)
})
check('client exposes the render seam read_ui_block uses', () => {
  assert.equal(clientSource.includes('srcdoc: function (body)'), true)
  assert.equal(clientSource.includes('tokens: function ()'), true)
})
check('client triggers on the ::dsh-ui line and nothing else', () => {
  assert.equal(clientSource.includes('var DIRECTIVE_RE = /^[ \\t]*::dsh-ui'), true)
  assert.equal(clientSource.includes('parseDirectiveLine(text)'), true)
})
check('the reference line carries the canvas size: res= is parsed, not hardcoded', () => {
  assert.equal(clientSource.includes('res=(\\d{2,5})x(\\d{2,5})'), true)
  assert.equal(clientSource.includes('res: directiveRes(directive)'), true)
  assert.equal(clientSource.includes('return directive.res || { w: DEFAULT_RES.w, h: DEFAULT_RES.h };'), true)
})
check('the retired fenced spelling has no code path left', () => {
  assert.equal(/split\.body/.test(clientSource), false)
  assert.equal(/state\.textKey/.test(clientSource), false)
  assert.equal(clientSource.includes('parseRefLine'), false)
  assert.equal(clientSource.includes('REF_RE'), false)
})
check('the canvas shell is the chat code block component (2026-10-24 user call)', () => {
  assert.equal(clientSource.includes("require('@deepseek-ai/dsh-client-ui-primitives')"), true)
  assert.equal(clientSource.includes('primitives.CodeBlock'), true)
  assert.equal(clientSource.includes("var LANG_LABEL = 'dsh-ui';"), true)
  assert.equal(clientSource.includes('data-code-block-banner'), true)
})

if (SHOT) {
  console.log('--- 7. read_ui_block returns a real image ---')
  const probe = await fetch(BASE_URL + '/json/version').catch(() => undefined)
  const up = probe !== undefined
  if (!up) {
    console.log('  SKIPPED - no app listening at ' + BASE_URL + ' (start the 4000 instance to run this leg)')
  } else {
    const module = await import('./index.js')
    void module
    // Reuse the plugin's own screenshot path with a stubbed attachments service,
    // so the leg proves the browser pipeline rather than a second implementation.
    const png = await runScreenshotLeg()
    check('PNG is non-empty and has the PNG signature', () => {
      assert.equal(png.png.length > 1000, true)
      assert.equal(png.png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a')
    })
    check('canvas geometry is 1440x900', () => {
      assert.equal(png.width, 1440)
      assert.equal(png.height, 900)
    })
    check('theme tokens came from the live page', () => {
      assert.equal(png.tokens > 100, true)
      assert.equal(['light', 'dark'].includes(png.scheme), true)
    })
    console.log('  image bytes=' + png.png.length + ' tokens=' + png.tokens + ' scheme=' + png.scheme)
  }
}

/**
 * The launch token the running instance printed. In production
 * `connection.authenticatedUrl()` supplies it; the self-check reads the same log
 * line so this leg exercises the real authenticated page, not a 401.
 */
function launchTokenFromLog() {
  const candidates = [
    join(process.env.DSH_FALLBACK_HOME ?? 'D:/dsh-fallback/home', '..', 'logs', 'dsh-4000.log'),
    'D:/dsh-fallback/logs/dsh-4000.log'
  ]
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue
    const text = readFileSync(candidate, 'utf8')
    const matches = [...text.matchAll(/token=([A-Za-z0-9_-]+)/g)]
    if (matches.length > 0) return matches[matches.length - 1][1]
  }
  return undefined
}

async function runScreenshotLeg() {
  const saved = []
  stubContext.attachments = { saveImage: async (input) => { saved.push(input); return { attachmentId: 'stub', mediaType: input.mediaType, bytes: input.data.length, width: 1440, height: 900, name: input.name } } }
  stubContext.webServer = { port: Number(new URL(BASE_URL).port) }
  const token = launchTokenFromLog()
  stubContext.connection = {
    authenticatedUrl: (base) => (token === undefined ? base : base + '/?token=' + token)
  }
  const value = await byName.read_ui_block.execute({ name: 'selfcheck-card' }, {})
  // 读回来的 note 必须自己说清块在磁盘上的绝对位置：否则模型只能拿相对串去猜。
  assert.ok(String(value.note).includes(join(tempHome, 'ui-blocks', 'selfcheck-card.uiblock')),
    'the note carries the absolute path: ' + JSON.stringify(value.note))
  assert.equal(value.image.mediaType, 'image/png')
  assert.equal(saved.length, 1)
  return { png: saved[0].data, width: value.width, height: value.height, tokens: value.tokens, scheme: value.scheme }
}

await rm(tempHome, { recursive: true, force: true })
console.log('self-check: ' + checks.length + ' checks OK')
