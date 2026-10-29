/**
 * dsh-ui-block — host half.
 *
 * The canvas/zoom/picker half is client-side (client.js). This half owns the two
 * file-tools that turn a UI draft into a durable file, plus the route the client
 * reads that file back through:
 *
 *   create_ui_block(name, html, title?)  -> ~/.dsh/ui-blocks/<name>.uiblock
 *   read_ui_block(name, width?, height?) -> a PNG of the SAME rendering the user sees
 *   GET /ui-blocks/<name>.uiblock        -> the client's read path for a reference line
 *
 * The file holds the HTML BODY ONLY. There is no meta first line: the canvas
 * size belongs to the REFERENCE LINE the message emits (`::dsh-ui <name> res=WxH::`),
 * which is a render-side concept this host half cannot see. read_ui_block
 * therefore defaults to the client's DEFAULT_RES (1440x900) and takes explicit
 * width/height so the caller can match the res= it wrote on the reference line.
 *
 * Screenshot fidelity (the point of read_ui_block): the tokens come from a real
 * app page and the document is built by client.js's OWN buildSrcdoc(), reached
 * through window.__dshPageBlock.render.srcdoc. Nothing here re-implements the
 * CSS — a copy would drift the moment client.js changes.
 *
 * @module dsh-ui-block
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { appendFile, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'

/** Stable Cordis plugin name. */
export const name = 'dsh-ui-block'
/** Services required before the tools can register. */
export const inject = ['tools']

const CREATE_TOOL = 'create_ui_block'
const READ_TOOL = 'read_ui_block'
const ROUTE_PATH = '/ui-blocks'
const DIR_NAME = 'ui-blocks'
const EXT = '.uiblock'
/** Canvas geometry shared with client.js (asserted equal by self-check.mjs). */
const DEFAULT_RES = { w: 1440, h: 900 }
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
const EDGE_CANDIDATES = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'
]

/** Absolute ui-blocks directory under the active Harness home. */
function blocksDir() {
  const home = process.env.DSH_HOME !== undefined && process.env.DSH_HOME !== '' ? process.env.DSH_HOME : join(homedir(), '.dsh')
  return join(home, DIR_NAME)
}

/** One block name: a single path segment, no traversal, no separator. */
function assertName(value) {
  const text = String(value == null ? '' : value).trim()
  if (!NAME_RE.test(text) || text.includes('..')) {
    throw new Error(CREATE_TOOL + '/' + READ_TOOL + ': name must be 1-64 chars of [A-Za-z0-9._-], starting with a letter or digit, got ' + JSON.stringify(value))
  }
  return text
}

/** The path the message line and the tool result both spell. */
function blockPath(blockName) {
  return DIR_NAME + '/' + blockName + EXT
}

/**
 * Write one block body, backing up any same-named file first.
 * @param blockName - validated single-segment name.
 * @param html - the HTML body, stored verbatim (no BOM, no meta line).
 * @returns the absolute target path and the backup path when one was made.
 */
async function writeBlock(blockName, html) {
  const dir = blocksDir()
  await mkdir(dir, { recursive: true })
  const target = join(dir, blockName + EXT)
  let backup
  if (existsSync(target)) {
    backup = target + '.bak-' + new Date().toISOString().replace(/[:.]/g, '-')
    await rename(target, backup)
  }
  await writeFile(target, html, { encoding: 'utf8' })
  // The tool path records its change here; the read route records the plain
  // write/edit path. Together every version on disk lands in the patch log.
  await recordChange(blockName, html)
  return { target, backup }
}

/** Every .uiblock name in the directory, for a useful "not found" message. */
async function listBlocks() {
  const dir = blocksDir()
  if (!existsSync(dir)) return []
  const entries = await readdir(dir)
  // .history/ and .pins.json live in the same directory but are not blocks: the
  // suffix filter keeps them out of every "known blocks" listing.
  return entries.filter((entry) => entry.endsWith(EXT)).map((entry) => entry.slice(0, -EXT.length))
}

// ---------------------------------------------------------------------------
// Change history: one baseline + line patches, never a full copy per version.
//
// ui-blocks/.history/<name>/base.uiblock   the content the first time we saw it
// ui-blocks/.history/<name>/log.json       one JSON line per later change:
//                                          { at: epoch ms, patch: [hunk...] }
// ui-blocks/.pins.json                     "name|nodeKey|index" -> epoch ms
//
// A hunk is { s: first old line, d: old lines dropped, a: lines added there },
// so replay = start at the baseline and apply every hunk appended before the
// moment asked for. Nothing is ever stored twice.
// ---------------------------------------------------------------------------

/** Where one block's change history lives, inside ui-blocks/. */
const HISTORY_DIR = '.history'
const BASE_FILE = 'base.uiblock'
const LOG_FILE = 'log.json'
const PINS_FILE = '.pins.json'
/** Longest patch log we replay for one request; a runaway log is truncated, not fatal. */
const LOG_MAX_BYTES = 4 * 1024 * 1024

function historyDir(blockName) {
  return join(blocksDir(), HISTORY_DIR, blockName)
}

function pinsFile() {
  return join(blocksDir(), PINS_FILE)
}

/** History is line-oriented, so a file with one giant line is one hunk. */
function splitLines(text) {
  return String(text).split('\n')
}

/**
 * Line-level diff (Myers, O((N+M)·D)): the hunks that turn `before` into `after`.
 * @param before - old lines.
 * @param after - new lines.
 * @returns hunks; empty when the two are identical.
 */
function diffLines(before, after) {
  const n = before.length
  const m = after.length
  const max = n + m
  const offset = max
  const v = new Array(2 * max + 2).fill(0)
  const trace = []
  let found = -1
  for (let d = 0; d <= max && found < 0; d += 1) {
    // Snapshot BEFORE round d: the backtrack needs the state after round d-1.
    trace.push(v.slice())
    for (let k = -d; k <= d; k += 2) {
      let x
      if (k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1])) x = v[offset + k + 1]
      else x = v[offset + k - 1] + 1
      let y = x - k
      while (x < n && y < m && before[x] === after[y]) { x += 1; y += 1 }
      v[offset + k] = x
      if (x >= n && y >= m) { found = d; break }
    }
  }
  if (found < 0) return [{ s: 0, d: n, a: after.slice() }]
  // Walk back from (n, m) to (0, 0), one op per step.
  const ops = []
  let x = n
  let y = m
  for (let d = found; d > 0; d -= 1) {
    const prev = trace[d]
    const k = x - y
    const prevK = k === -d || (k !== d && prev[offset + k - 1] < prev[offset + k + 1]) ? k + 1 : k - 1
    const prevX = prev[offset + prevK]
    const prevY = prevX - prevK
    while (x > prevX && y > prevY) { ops.push('='); x -= 1; y -= 1 }
    if (x === prevX) { ops.push('+'); y -= 1 } else { ops.push('-'); x -= 1 }
  }
  while (x > 0 && y > 0) { ops.push('='); x -= 1; y -= 1 }
  while (x > 0) { ops.push('-'); x -= 1 }
  while (y > 0) { ops.push('+'); y -= 1 }
  ops.reverse()
  const hunks = []
  let i = 0
  let j = 0
  let open = null
  for (const op of ops) {
    if (op === '=') {
      if (open !== null) { hunks.push(open); open = null }
      i += 1
      j += 1
      continue
    }
    if (open === null) open = { s: i, d: 0, a: [] }
    if (op === '-') { open.d += 1; i += 1 } else { open.a.push(after[j]); j += 1 }
  }
  if (open !== null) hunks.push(open)
  return hunks
}

/**
 * Apply hunks to lines. Throws on a hunk that does not fit, so a corrupt log
 * never silently rewrites a block into garbage.
 */
function applyHunks(lines, hunks) {
  const out = []
  let at = 0
  for (const hunk of hunks) {
    if (typeof hunk.s !== 'number' || typeof hunk.d !== 'number' || !Array.isArray(hunk.a)) {
      throw new Error('dsh-ui-block: malformed change log hunk ' + JSON.stringify(hunk).slice(0, 120))
    }
    if (hunk.s < at || hunk.s + hunk.d > lines.length) {
      throw new Error('dsh-ui-block: change log hunk at line ' + String(hunk.s) + ' does not fit ' + String(lines.length) + ' lines')
    }
    for (let index = at; index < hunk.s; index += 1) out.push(lines[index])
    for (const line of hunk.a) out.push(line)
    at = hunk.s + hunk.d
  }
  for (let index = at; index < lines.length; index += 1) out.push(lines[index])
  return out
}

/**
 * Read one block's baseline and patch log.
 * @param blockName - validated single-segment name.
 * @returns null when this block has no history yet (created before the upgrade).
 */
async function readHistory(blockName) {
  const dir = historyDir(blockName)
  const basePath = join(dir, BASE_FILE)
  if (!existsSync(basePath)) return null
  const base = await readFile(basePath, 'utf8')
  const logPath = join(dir, LOG_FILE)
  const entries = []
  if (existsSync(logPath)) {
    const info = await stat(logPath)
    // ponytail: a log past 4 MB is replayed as far as it goes; the upgrade path
    // is checkpointing a newer baseline, which the plan defers on purpose.
    const raw = info.size > LOG_MAX_BYTES
      ? await readFile(logPath, 'utf8').then((text) => text.slice(0, LOG_MAX_BYTES))
      : await readFile(logPath, 'utf8')
    for (const line of raw.split('\n')) {
      const trimmed = line.trim()
      if (trimmed === '') continue
      try {
        const entry = JSON.parse(trimmed)
        if (typeof entry.at === 'number' && Array.isArray(entry.patch)) entries.push(entry)
      } catch { /* a torn trailing line is not history */ }
    }
  }
  entries.sort((left, right) => left.at - right.at)
  return { base, entries }
}

/** Replay the baseline up to and including `at`; null means "the newest". */
function replayHistory(history, at) {
  let lines = splitLines(history.base)
  for (const entry of history.entries) {
    if (at !== null && entry.at > at) continue
    lines = applyHunks(lines, entry.patch)
  }
  return lines.join('\n')
}

/**
 * Head cache: replaying a long log on every 1.5s read would be wasted work.
 * The identity is (baseline length, patch count, newest patch instant), which
 * changes the moment anything is appended — no stat, no stale key.
 */
const headCache = new Map()

function headOf(blockName, history) {
  const newest = history.entries.length === 0 ? 0 : history.entries[history.entries.length - 1].at
  const key = String(history.base.length) + '|' + String(history.entries.length) + '|' + String(newest)
  const cached = headCache.get(blockName)
  if (cached !== undefined && cached.key === key) return cached.head
  const head = replayHistory(history, null)
  headCache.set(blockName, { key, head })
  return head
}

let recordTail = Promise.resolve()

/**
 * Record one observed body. The baseline is stored ONCE; every later change
 * appends one patch line. Called from writeBlock and from the read route, so
 * both the tool path and a plain write/edit are covered.
 * @param blockName - validated single-segment name.
 * @param html - body as it is on disk right now.
 */
function recordChange(blockName, html) {
  const text = String(html == null ? '' : html)
  const run = () => recordNow(blockName, text)
  const next = recordTail.then(run, run)
  recordTail = next.then(() => undefined, () => undefined)
  return next
}

async function recordNow(blockName, text) {
  const dir = historyDir(blockName)
  const basePath = join(dir, BASE_FILE)
  if (!existsSync(basePath)) {
    await mkdir(dir, { recursive: true })
    await writeFile(basePath, text, 'utf8')
    await writeFile(join(dir, LOG_FILE), '', 'utf8')
    return { recorded: true, kind: 'base' }
  }
  const history = await readHistory(blockName)
  if (history === null) return { recorded: false, kind: 'none' }
  const head = headOf(blockName, history)
  if (head === text) return { recorded: false, kind: 'none' }
  const entry = { at: Date.now(), patch: diffLines(splitLines(head), splitLines(text)) }
  await appendFile(join(dir, LOG_FILE), JSON.stringify(entry) + '\n', 'utf8')
  return { recorded: true, kind: 'patch', bytes: JSON.stringify(entry).length }
}

/** The block as it was at `at` (epoch ms); `fallback` when no history exists. */
async function contentAt(blockName, at, fallback) {
  const history = await readHistory(blockName)
  if (history === null) return fallback
  return replayHistory(history, at)
}

let pinsCache = null
let pinsTail = Promise.resolve()

async function readPins() {
  if (pinsCache !== null) return pinsCache
  let pins = {}
  const path = pinsFile()
  if (existsSync(path)) {
    try {
      const parsed = JSON.parse(await readFile(path, 'utf8'))
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) pins = parsed
    } catch { pins = {} }
  }
  pinsCache = pins
  return pinsCache
}

/**
 * First request for one (block, node key, index) pins that instant; every later
 * request reuses it, so a message keeps showing the version it was written with.
 * @param blockName - validated single-segment name.
 * @param nodeKey - the chat node key the reference sits in.
 * @param index - which reference this is inside that node.
 * @returns the pinned epoch ms.
 */
function pinMoment(blockName, nodeKey, index) {
  const key = blockName + '|' + String(nodeKey) + '|' + String(index)
  const run = async () => {
    const pins = await readPins()
    if (typeof pins[key] !== 'number') {
      pins[key] = Date.now()
      const path = pinsFile()
      const temp = path + '.tmp-' + randomBytes(4).toString('hex')
      await mkdir(blocksDir(), { recursive: true })
      await writeFile(temp, JSON.stringify(pins, null, 1), 'utf8')
      await rename(temp, path)
    }
    return pins[key]
  }
  const next = pinsTail.then(run, run)
  pinsTail = next.then(() => undefined, () => undefined)
  return next
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms))

/** Poll until `probe()` returns a truthy value or the deadline passes. */
async function until(probe, timeoutMs, what) {
  const deadline = Date.now() + timeoutMs
  let last
  while (Date.now() < deadline) {
    try { last = await probe(); if (last) return last } catch (error) { last = error }
    await sleep(200)
  }
  throw new Error('timed out waiting for ' + what + (last === undefined ? '' : ' (last: ' + String(last && last.message !== undefined ? last.message : last).slice(0, 200) + ')'))
}

/**
 * Render one block body through the live app's own renderer and screenshot it.
 * @param options.baseUrl - the authenticated app URL (the token source).
 * @param options.body - the block HTML body.
 * @param options.res - canvas geometry; the screenshot is exactly this size.
 * @param options.timeoutMs - overall budget for the page to come up.
 * @returns PNG bytes plus the token count and scheme the render used.
 */
async function screenshotBlock(options) {
  const res = options.res ?? DEFAULT_RES
  const scale = 1
  const edge = EDGE_CANDIDATES.find((candidate) => existsSync(candidate))
  if (edge === undefined) throw new Error('no Microsoft Edge found at ' + EDGE_CANDIDATES.join(' or '))
  const port = 9400 + Math.floor(Math.random() * 400)
  const profile = join(tmpdir(), 'dsh-uiblock-' + randomBytes(6).toString('hex'))
  const child = spawn(edge, [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--remote-debugging-port=' + String(port),
    '--user-data-dir=' + profile,
    'about:blank'
  ], { stdio: 'ignore', windowsHide: true })
  try {
    await until(async () => (await fetch('http://127.0.0.1:' + String(port) + '/json/version')).ok, Math.min(options.timeoutMs, 15000), 'the headless browser to answer /json/version')
    const targets = await (await fetch('http://127.0.0.1:' + String(port) + '/json/list')).json()
    const page = targets.find((target) => target.type === 'page')
    if (page === undefined) throw new Error('no page target in the headless browser')

    const socket = new WebSocket(page.webSocketDebuggerUrl)
    await new Promise((done, fail) => { socket.onopen = done; socket.onerror = fail })
    let nextId = 0
    const pending = new Map()
    socket.onmessage = (event) => {
      const message = JSON.parse(event.data)
      const resolve = pending.get(message.id)
      if (resolve !== undefined) { pending.delete(message.id); resolve(message) }
    }
    const send = (method, params) => new Promise((resolve) => {
      const id = ++nextId
      pending.set(id, resolve)
      socket.send(JSON.stringify({ id, method, params: params ?? {} }))
    })
    const evaluate = (expression) => send('Runtime.evaluate', {
      expression, awaitPromise: true, returnByValue: true
    }).then((reply) => {
      if (reply.result !== undefined && reply.result.exceptionDetails !== undefined) {
        throw new Error('page threw: ' + String(reply.result.exceptionDetails.text ?? '') + ' ' + String(reply.result.exceptionDetails.exception && reply.result.exceptionDetails.exception.description !== undefined ? reply.result.exceptionDetails.exception.description : ''))
      }
      const result = reply.result && reply.result.result
      if (result === undefined) throw new Error('Runtime.evaluate returned nothing for ' + expression.slice(0, 60))
      return result.value
    })

    try {
      await send('Page.enable')
      await send('Runtime.enable')
      await send('Page.navigate', { url: options.baseUrl })
      // The client bundle installs window.__dshPageBlock on load, and the theme
      // tokens only exist once the app's own stylesheets are live.
      await until(async () => evaluate('!!(window.__dshPageBlock && window.__dshPageBlock.render)'), options.timeoutMs, 'the app page and its client bundle')
      const srcdoc = await evaluate('window.__dshPageBlock.render.srcdoc(' + JSON.stringify(String(options.body)) + ')')
      const tokens = JSON.parse(await evaluate('JSON.stringify(window.__dshPageBlock.render.tokens())'))
      if (typeof srcdoc !== 'string' || srcdoc === '') throw new Error('client render.srcdoc returned an empty document')

      await send('Page.navigate', { url: 'about:blank' })
      await sleep(200)
      await send('Emulation.setDeviceMetricsOverride', { width: res.w, height: res.h, deviceScaleFactor: 1, mobile: false })
      await evaluate('document.open();document.write(' + JSON.stringify(srcdoc) + ');document.close();')
      // Two frames: one for the write to lay out, one for it to paint.
      await evaluate('new Promise(function(done){requestAnimationFrame(function(){requestAnimationFrame(function(){done(1)})})})')
      const shot = await send('Page.captureScreenshot', {
        format: 'png',
        clip: { x: 0, y: 0, width: res.w, height: res.h, scale }
      })
      const data = shot.result && shot.result.data
      if (typeof data !== 'string' || data === '') throw new Error('Page.captureScreenshot returned no data')
      return { png: Buffer.from(data, 'base64'), tokenCount: tokens.count, scheme: tokens.scheme, width: Math.round(res.w * scale), height: res.h }
    } finally {
      try { socket.close() } catch { /* already closed */ }
    }
  } finally {
    try { child.kill() } catch { /* already gone */ }
    // The profile dir stays locked for a moment after the kill; retry, then give up.
    for (let attempt = 0; attempt < 25; attempt += 1) {
      try { await rm(profile, { recursive: true, force: true }); break } catch { await sleep(100) }
    }
  }
}

/** Read a block body, or throw with the spelling the caller should use. */
async function readBlockBody(blockName) {
  const target = join(blocksDir(), blockName + EXT)
  if (!existsSync(target)) {
    const known = await listBlocks()
    throw new Error('ui block not found: ' + blockPath(blockName) + (known.length === 0 ? ' (no blocks exist yet)' : ' (known: ' + known.join(', ') + ')'))
  }
  return await readFile(target, 'utf8')
}

const CREATE_DESCRIPTION = [
  'Create one UI block: a durable HTML draft at ~/.dsh/ui-blocks/<name>.uiblock.',
  '',
  'Use it whenever the user asks for a page, panel, dialog, card, widget or any other visual object — something they want to look at rather than read about.',
  '',
  'The html argument is stored VERBATIM — plain HTML, no metadata line, no <html>/<head> wrapper. Use the pb helper classes for the app look: pb, pb-center, pb-card, pb-title, pb-sub, pb-row, pb-btn, pb-btn-primary, pb-field, pb-label, pb-input, pb-mask.',
  '',
  'REFERENCING IS PART OF DELIVERY. A block this message never references has NOT been delivered: the file exists on disk and read_ui_block may return a picture, but the user sees NOTHING. The only thing that puts a draft on the user\'s screen is the reference line, in the message body, on a line of its own:',
  '',
  '::dsh-ui <name>::',
  '',
  '`res=WxH` is optional and is the ONLY way to pick the canvas size:',
  '',
  '::dsh-ui <name> res=1440x620::',
  '',
  'Omit it and the canvas is 1440x900. PICK THE HEIGHT FROM THE CONTENT: a dialog, card or one-row toolbar wants roughly 280-420, NOT the default 900 — 900 leaves a large empty band under the draft, which reads as a broken preview. A full page draft may go 600+. Width can stay wide (narrow content just centres), but the height must hug the content.',
  '',
  'The line must be exactly that: nothing else on it, no backticks, no fence, no trailing words. Inside a code block it is not read at all.',
  '',
  'Rendered, the reference line becomes a code block labelled `dsh-ui`, with the canvas in its body and a copy button that copies the block\'s file path.',
  '',
  'RENDERED AT MESSAGE TIME: a reference shows the version the block had when that message was first seen, not the newest one. Updating a block therefore only changes the messages that reference it AFTER the update — old messages keep their old picture. The reference spelling itself does not change.',
  '',
  'INSIDE THE BLOCK: only the rendered UI itself. No headings, notes, captions, separators or "this is the login page" / "方案 A" commentary — every character renders into the canvas and wrecks the preview. Put explanations in the message text, not in the block.',
  '',
  'CREATING vs UPDATING:',
  '- To CREATE a UI block, call this tool with the full HTML body.',
  '- Do NOT create a .uiblock file with write. A block that was not created through this tool has no registered metadata, so read_ui_block and the reference line cannot find it.',
  '- To UPDATE an existing block, edit the .uiblock file with write or edit, then reference it again in the same message. Do NOT call this tool again to update it, and do NOT write the file through a shell command or a script — the card reads the file through the host route, and an unregistered write bypasses it.',
  '',
  'A created or edited block stays invisible until a reply carries its reference line. Ending your message without it means the user sees nothing at all.',
].join('\n')

const READ_DESCRIPTION = [
  'Render one UI block exactly as the user sees it and return the image.',
  '',
  'The screenshot is taken through the live app page: the CSS custom properties are collected from the running theme and the document is built by the client plugin\'s own renderer, so the picture matches the canvas the user is looking at (skin, light/dark, pb-* classes).',
  '',
  'CANVAS SIZE: defaults to 1440x900. Pass width and/or height to render at another canvas size — the draft is LAID OUT at that size (media queries re-evaluate), it is not a PNG downscale. Pass the SAME pair you will declare on the reference line, otherwise you are checking a different layout than the user is looking at.',
  '',
  'Use it to check layout, spacing, overflow, and colour before handing a draft to the user.',
  '',
  'THIS IMAGE GOES TO THE MODEL, NOT TO THE USER. The user only sees what a message references with `::dsh-ui <name>::` on a line of its own. Rendering here without that line leaves the draft invisible to them — pass the check, then reference it in the same message.',
  '',
  'Creating a block is create_ui_block; updating one is write or edit on the file.',
].join('\n')

/**
 * Mount the two tools and the read route.
 * @param ctx - plugin context carrying `tools` (and `webServer`/`attachments`/`connection` when composed).
 */
export function apply(ctx) {
  ctx.tools.register(defineTool({
    name: CREATE_TOOL,
    description: CREATE_DESCRIPTION,
    parameters: {
      name: {
        type: 'string',
        required: true,
        description: 'Block name: 1-64 chars of [A-Za-z0-9._-], starting with a letter or digit. The file is ~/.dsh/ui-blocks/<name>.uiblock.'
      },
      html: {
        type: 'string',
        required: true,
        description: 'The complete HTML body, stored verbatim. No <html>/<head> wrapper and no dsh-ui line — the host builds the document shell.'
      },
      title: {
        type: 'string',
        description: 'Optional human label for the preview card. Not stored in the file.'
      }
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string', required: true },
          name: { type: 'string', required: true },
          backup: { type: 'string' }
        }
      },
      render: (args, value) => [{
        type: 'text',
        text: 'UI block: ' + value.path + '\nNOT VISIBLE TO THE USER YET. Reference it in the same message with a line of its own (canvas size optional as res=WxH):\n  ::dsh-ui ' + value.name + '::' + (value.backup === undefined ? '' : '\nPrevious version backed up to: ' + value.backup)
      }]
    },
    execute: async (args) => {
      const blockName = assertName(args.name)
      const html = String(args.html == null ? '' : args.html)
      if (html.trim() === '') throw new Error(CREATE_TOOL + ': html must be a non-empty HTML body')
      const written = await writeBlock(blockName, html)
      return {
        path: blockPath(blockName),
        name: blockName,
        ...written.backup === undefined ? {} : { backup: written.backup }
      }
    },
    presentCall: (args) => ({
      card: 'generic',
      title: String(args.title ?? args.name ?? 'UI block'),
      kind: 'other',
      content: [{ type: 'text', text: String(args.html ?? '') }]
    })
  }))

  ctx.tools.register(defineTool({
    name: READ_TOOL,
    description: READ_DESCRIPTION,
    timeoutMs: 120000,
    parameters: {
      name: {
        type: 'string',
        required: true,
        description: 'Block name as passed to create_ui_block (no directory, no extension).'
      },
      width: {
        type: 'number',
        description: 'Optional canvas WIDTH in pixels — the draft is laid out at this width, so media queries re-evaluate against it. Default 1440. Pass the same width the `::dsh-ui <name> res=WxH::` line declares so the picture matches the canvas the user sees.'
      },
      height: {
        type: 'number',
        description: 'Optional canvas HEIGHT in pixels. Default 900. For a dialog / card / toolbar pass the height the content actually needs (roughly 280-420) instead of leaving 900 of mostly empty canvas; the `::dsh-ui <name> res=WxH::` line declares the same pair.'
      }
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string', required: true },
          width: { type: 'number', required: true },
          height: { type: 'number', required: true },
          bytes: { type: 'number', required: true },
          tokens: { type: 'number', required: true },
          scheme: { type: 'string', required: true },
          image: {
            type: 'object',
            required: true,
            additionalProperties: false,
            properties: {
              attachmentId: { type: 'string', required: true },
              mediaType: { type: 'string', required: true },
              bytes: { type: 'number', required: true },
              width: { type: 'number', required: true },
              height: { type: 'number', required: true },
              name: { type: 'string' }
            }
          }
        }
      },
      render: (args, value) => [{
        type: 'text',
        text: '<path>' + value.path + '</path>\n<type>image</type>\n<content>PNG image, ' + value.width + 'x' + value.height + ' px, ' + value.bytes + ' bytes; rendered with ' + value.tokens + ' theme tokens, color-scheme ' + value.scheme + '</content>'
      }, { type: 'image', attachment: value.image }]
    },
    execute: async (args, exec) => {
      const blockName = assertName(args.name)
      const attachments = ctx.get('attachments')
      if (attachments === undefined) throw new Error(READ_TOOL + ': the attachments service is not composed, so no image can be returned')
      const webServer = ctx.get('webServer')
      const connection = ctx.get('connection')
      if (webServer === undefined || connection === undefined) {
        // Not a content problem: a profile with no host/webserver (e.g. headless) cannot
        // open the live app page. Say so once, so the caller reports it instead of retrying.
        throw new Error(READ_TOOL + ': this profile composes no web server / connection service, so the live app page cannot be opened for a faithful screenshot. The block itself is written and fine — do NOT retry this tool here; the user\'s Web UI renders the reference line normally.')
      }
      const body = await readBlockBody(blockName)
      const baseUrl = connection.authenticatedUrl('http://127.0.0.1:' + String(webServer.port))
      // width/height are CANVAS geometry (the draft is laid out at that size, so
      // media queries re-evaluate) — not a PNG downscale. Omitting both keeps the
      // historical 1440x900 shot.
      const canvas = {
        w: args.width === undefined ? DEFAULT_RES.w : Math.round(Number(args.width)),
        h: args.height === undefined ? DEFAULT_RES.h : Math.round(Number(args.height))
      }
      if (!(canvas.w > 0) || !(canvas.h > 0)) throw new Error(READ_TOOL + ': width and height must be positive pixel counts, got ' + JSON.stringify({ width: args.width, height: args.height }))
      const shot = await screenshotBlock({
        baseUrl,
        body,
        res: canvas,
        timeoutMs: 45000
      })
      if (exec !== undefined && exec.signal !== undefined && exec.signal.aborted) throw new Error(READ_TOOL + ': aborted')
      const image = await attachments.saveImage({ data: shot.png, mediaType: 'image/png', name: blockName + '.png' })
      return {
        path: blockPath(blockName),
        width: shot.width,
        height: shot.height,
        bytes: shot.png.length,
        tokens: shot.tokenCount,
        scheme: String(shot.scheme ?? ''),
        image: {
          attachmentId: String(image.attachmentId),
          mediaType: String(image.mediaType),
          bytes: image.bytes,
          width: image.width,
          height: image.height,
          ...image.name === undefined ? {} : { name: String(image.name) }
        }
      }
    },
    presentCall: (args) => ({
      card: 'generic',
      title: 'UI block: ' + String(args.name ?? ''),
      kind: 'other',
      content: [{ type: 'text', text: blockPath(String(args.name ?? '')) }]
    })
  }))

  ctx.inject(['webServer'], (webCtx) => {
    webCtx.webServer.register({
      kind: 'prefix',
      path: ROUTE_PATH,
      handler: async (req, res) => {
        try {
          const url = new URL(req.url ?? '/', 'http://127.0.0.1')
          const rest = url.pathname.slice(ROUTE_PATH.length + 1)
          const blockName = rest.endsWith(EXT) ? rest.slice(0, -EXT.length) : ''
          const target = blockName === '' ? '' : join(blocksDir(), blockName + EXT)
          if (blockName === '' || !NAME_RE.test(blockName) || !existsSync(target)) {
            res.writeHead(404, { 'cache-control': 'no-store' })
            res.end('not found')
            return
          }
          const info = await stat(target)
          const body = await readFile(target, 'utf8')
          // Reading is a write path too: a block edited through write/edit (or a
          // shell command) never passes writeBlock, so its change is logged here.
          try {
            await recordChange(blockName, body)
          } catch (error) {
            if (ctx.logger !== undefined) ctx.logger.warn('dsh-ui-block: change log failed for ' + blockName + ': ' + String(error))
          }
          // ?pin=<chat node key>&i=<n>  -> the moment that message was first seen
          // ?at=<epoch ms>              -> an explicit moment
          // neither                     -> the newest body (unchanged behaviour)
          const pinKey = url.searchParams.get('pin')
          const pinIndex = url.searchParams.get('i')
          const atParam = url.searchParams.get('at')
          let moment = null
          if (pinKey !== null && pinKey !== '') {
            try {
              moment = await pinMoment(blockName, pinKey, pinIndex === null || pinIndex === '' ? 0 : pinIndex)
            } catch (error) {
              if (ctx.logger !== undefined) ctx.logger.warn('dsh-ui-block: pin failed for ' + blockName + ': ' + String(error))
            }
          } else if (atParam !== null && atParam !== '') {
            const parsed = Number(atParam)
            moment = Number.isFinite(parsed) ? parsed : null
          }
          let served = body
          if (moment !== null) {
            try {
              served = await contentAt(blockName, moment, body)
            } catch (error) {
              if (ctx.logger !== undefined) ctx.logger.warn('dsh-ui-block: history replay failed for ' + blockName + ': ' + String(error))
            }
          }
          res.writeHead(200, {
            'content-type': 'text/plain; charset=utf-8',
            'content-length': String(Buffer.byteLength(served)),
            'cache-control': 'no-store',
            'last-modified': info.mtime.toUTCString(),
            'x-uiblock-at': moment === null ? 'live' : String(moment)
          })
          res.end(served)
        } catch (error) {
          try { res.writeHead(500); res.end('read failed') } catch { /* client gone */ }
          if (ctx.logger !== undefined) ctx.logger.warn('dsh-ui-block: ' + ROUTE_PATH + ' route failed: ' + String(error))
        }
      }
    })
  })
}
/**
 * Test seam for self-check-uiblock-directive.mjs: the pure diff/replay helpers
 * plus the recording entry, so the patch chain can be asserted against real
 * files in a throwaway DSH_HOME. Not used by the tools or the route.
 */
export const timeline = {
  diffLines,
  listBlocks,
  applyHunks,
  replayHistory,
  readHistory,
  recordChange,
  contentAt,
  pinMoment,
  historyDir,
  pinsFile,
  resetPinsCache: () => { pinsCache = null }
}

