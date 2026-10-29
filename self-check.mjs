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

const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex')
const tempHome = await mkdtemp(join(tmpdir(), 'dsh-uiblock-home-'))
process.env.DSH_HOME = tempHome

const checks = []
const check = (name, fn) => { fn(); checks.push(name); console.log('  ok - ' + name) }
const checkAsync = async (name, fn) => { await fn(); checks.push(name); console.log('  ok - ' + name) }

const { apply } = await import('./index.js')

/** The slice of the tools service the plugin uses. */
const registered = []
const stubCtx = {
  tools: { register: (definition) => { registered.push(definition); return () => {} } },
  get: (service) => stubContext[service],
  inject: (services, fn) => { fn({ webServer: { register: (route) => { stubContext.route = route; return () => {} } } }) },
  logger: { warn: () => {} }
}
const stubContext = {}

apply(stubCtx)

console.log('--- 1. registration ---')
const byName = Object.fromEntries(registered.map((definition) => [definition.name, definition]))
check('create_ui_block registered', () => assert.equal(byName.create_ui_block !== undefined, true))
check('read_ui_block registered', () => assert.equal(byName.read_ui_block !== undefined, true))

// The 2026-10-24 contract, verbatim. A wording change here breaks what the user
// asked for: create through the tool, update through write/edit, and the ONLY
// delivery is a ::dsh-ui line of its own.
const CREATE_CONTRACT = [
  'CREATING vs UPDATING:',
  '- To CREATE a UI block, call this tool with the full HTML body.',
  '- Do NOT create a .uiblock file with write. A block that was not created through this tool has no registered metadata, so read_ui_block and the reference line cannot find it.',
  '- To UPDATE an existing block, edit the .uiblock file with write or edit, then reference it again in the same message. Do NOT call this tool again to update it, and do NOT write the file through a shell command or a script — the card reads the file through the host route, and an unregistered write bypasses it.'
].join('\n')
check('create_ui_block description carries the plan §A contract verbatim', () => {
  assert.equal(byName.create_ui_block.description.includes(CREATE_CONTRACT), true)
})
check('read_ui_block description points updates at write/edit', () => {
  assert.equal(/create_ui_block/i.test(byName.read_ui_block.description), true)
  assert.equal(byName.read_ui_block.description.includes('updating one is write or edit on the file'), true)
})
check('both descriptions teach the ::dsh-ui line and nothing about fences', () => {
  for (const tool of ['create_ui_block', 'read_ui_block']) {
    assert.equal(byName[tool].description.includes('::dsh-ui'), true)
    assert.equal(/fenced code block|dsh-ui ref:/.test(byName[tool].description), false)
  }
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
  const keys = Object.keys(byName.create_ui_block.parameters.properties).sort()
  assert.deepEqual(keys, ['html', 'name', 'title'])
  assert.equal(/res=WxH/.test(byName.create_ui_block.description), true)
  assert.equal(/280-420/.test(byName.create_ui_block.description), true)
})
check('read_ui_block description tells the caller to match the reference line', () => {
  assert.equal(/SAME pair/.test(byName.read_ui_block.description), true)
  assert.equal(/reference line/.test(byName.read_ui_block.description), true)
  assert.equal(/::dsh-ui <name>::/.test(byName.read_ui_block.description), true)
})
check('output schemas require path and image', () => {
  assert.equal(byName.create_ui_block.output.schema.required.includes('path'), true)
  assert.equal(byName.read_ui_block.output.schema.required.includes('image'), true)
  assert.equal(byName.read_ui_block.output.schema.properties.image.properties.attachmentId.type, 'string')
})
check('the read route registered on /ui-blocks', () => {
  assert.equal(stubContext.route.kind, 'prefix')
  assert.equal(stubContext.route.path, '/ui-blocks')
})

console.log('--- 2. create_ui_block writes body only ---')
const first = await byName.create_ui_block.execute({ name: 'selfcheck-card', html: BODY, title: '自检' }, {})
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
  await byName.create_ui_block.execute({ name: 'selfcheck-card', html: BODY }, {})
  const b = sha256(await readFile(blockFile))
  assert.equal(a, b)
  assert.equal(a.length, 64)
})

console.log('--- 3. same-name write backs up, never clobbers ---')
await checkAsync('second create with the same name makes a backup', async () => {
  const result = await byName.create_ui_block.execute({ name: 'selfcheck-card', html: BODY.replace('自检卡片', '自检卡片 v2') }, {})
  assert.equal(typeof result.backup, 'string')
  const backupText = await readFile(result.backup, 'utf8')
  assert.equal(backupText, BODY)
  const current = await readFile(blockFile, 'utf8')
  assert.equal(current.includes('自检卡片 v2'), true)
})

console.log('--- 4. name and body guards ---')
await checkAsync('path traversal is rejected', async () => {
  await assert.rejects(() => byName.create_ui_block.execute({ name: '../escape', html: BODY }, {}), /name must be/)
  await assert.rejects(() => byName.create_ui_block.execute({ name: 'a/b', html: BODY }, {}), /name must be/)
})
await checkAsync('empty body is rejected', async () => {
  await assert.rejects(() => byName.create_ui_block.execute({ name: 'x', html: '   ' }, {}), /non-empty HTML body/)
})
await checkAsync('read of a missing block names the known ones', async () => {
  // Stub the services so the not-found guard is what fires, not the service guard.
  stubContext.attachments = { saveImage: async () => { throw new Error('unreachable') } }
  stubContext.webServer = { port: 4000 }
  stubContext.connection = { authenticatedUrl: (base) => base }
  await assert.rejects(() => byName.read_ui_block.execute({ name: 'nope' }, {}), /ui block not found: ui-blocks\/nope\.uiblock/)
  assert.equal(byName.read_ui_block !== undefined, true)
})

console.log('--- 5. client contract parity ---')
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
  console.log('--- 6. read_ui_block returns a real image ---')
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
  assert.equal(value.image.mediaType, 'image/png')
  assert.equal(saved.length, 1)
  return { png: saved[0].data, width: value.width, height: value.height, tokens: value.tokens, scheme: value.scheme }
}

await rm(tempHome, { recursive: true, force: true })
console.log('self-check: ' + checks.length + ' checks OK')
