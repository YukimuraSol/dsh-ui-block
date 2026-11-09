/**
 * dsh-ui-block — host half.
 *
 * The canvas/zoom/picker half is client-side (client.js). This half owns the two
 * file-tools that turn a UI draft into a durable file, plus the route the client
 * reads that file back through:
 *
 *   create_ui_block(name, entry?, title?, files) -> ~/.dsh/ui-blocks/<name>.uiblock
 *   read_ui_block(name, width?, height?, probe?) -> a PNG of the SAME rendering the user sees,
 *     plus, when `probe` is given, the measured box of each selector
 *   GET /ui-blocks/<name>.uiblock        -> the client's read path for a reference line
 *   GET /ui-blocks/<name>                -> the ENTRY as a document (sectioned blocks)
 *   GET /ui-blocks/<name>/<path>         -> one virtual file section the entry links
 *   POST /ui-blocks/agent/poll           -> a browser extension reports its tabs, takes one task
 *   POST /ui-blocks/agent/result         -> the extension hands the material back
 *
 * A task handed out by /poll carries an OPTIONAL `name`: the block name its
 * capture lands under, ui-captures/<name>/. Omitted, the directory is
 * capture-<YYYYMMDD-HHmmss>. The extension may ignore the field entirely — the
 * name is also resolved from the taskId on this side — so nothing downstream has
 * to parse it to get the same directory.
 *
 * The file holds the ENTRY MARKUP plus, optionally, virtual-file SECTIONS. There
 * is no meta first line: the canvas size belongs to the REFERENCE LINE the
 * message emits (`::dsh-ui <name> res=WxH::`), which is a render-side concept
 * this host half cannot see. read_ui_block therefore defaults to the client's
 * DEFAULT_RES (1440x900) and takes explicit width/height so the caller can match
 * the res= it wrote on the reference line.
 *
 * A section starts at a line that is exactly `<!-- @@file <path> [base64] -->`
 * and runs to the next such line or the end of the file. Serving each one at its
 * own URL is what lets the entry <link> a stylesheet, @font-face a real .woff2
 * and <img src> an icon — the one thing an about:srcdoc document cannot do. A
 * file with no marker keeps the srcdoc path, byte for byte.
 *
 * Screenshot fidelity (the point of read_ui_block): the tokens come from a real
 * app page and the document is built by client.js's OWN buildSrcdoc(), reached
 * through window.__dshPageBlock.render.srcdoc. Nothing here re-implements the
 * CSS — a copy would drift the moment client.js changes.
 *
 * @module dsh-ui-block
 */
import { spawn } from 'node:child_process'
import { existsSync, realpathSync } from 'node:fs'
import { appendFile, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { homedir, tmpdir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineTool } from '@deepseek-ai/dsh-tools'

/** Stable Cordis plugin name. */
export const name = 'dsh-ui-block'
/** Services required before the tools can register. */
export const inject = ['tools']

const CREATE_TOOL = 'create_ui_block'
const READ_TOOL = 'read_ui_block'
const LIST_TOOL = 'list_pages'
const CAPTURE_TOOL = 'capture_page'
const ROUTE_PATH = '/ui-blocks'
const EXTENSION_ROUTE = '/ui-block-extension'
const EXTENSION_DIR_NAME = 'extension'
/**
 * The second companion extension: the same package, a sibling directory. Two
 * extensions, one plugin — the picker takes one element, the capture takes the
 * whole page, and both are installed by hand from chrome://extensions.
 */
const EXTENSION_CAPTURE_DIR_NAME = 'extension-capture'
const DIR_NAME = 'ui-blocks'
/**
 * The extension hub. A LONGER prefix than ROUTE_PATH, which is what keeps it out
 * of the block route's way: the webserver matches longest prefix first.
 */
const AGENT_ROUTE = '/ui-blocks/agent'
/** Where a capture lands: <DSH_HOME>/ui-captures/<block name>/ (sibling of ui-blocks). */
const CAPTURES_DIR_NAME = 'ui-captures'
/** One JSON report ceiling. Material is text plus data: assets, so this is generous. */
const AGENT_BODY_MAX_BYTES = 32 * 1024 * 1024
/** How many requests the ring keeps in memory. */
const AGENT_RECENT_MAX = 20
const EXT = '.uiblock'
/** A section marker: a WHOLE line, `<!-- @@file <path> [base64] -->`. */
const SECTION_RE = /^<!--\s*@@file\s+(\S+?)(\s+base64)?\s*-->\s*$/
/** Ceilings per section and per file; the route answers 413 past either. */
const SECTION_MAX_BYTES = 256 * 1024
const BLOCK_MAX_BYTES = 2 * 1024 * 1024
/** What a section may be, by extension; anything else is a 415, never a guess. */
const SECTION_TYPES = {
  // A page section: a sectioned block can carry whole pages the entry links to,
  // which is what a demo block needs (one served document per timeline snapshot).
  // The block CSP still ships with every one of them, so script-src stays 'none'.
  html: 'text/html; charset=utf-8',
  css: 'text/css; charset=utf-8',
  svg: 'image/svg+xml',
  json: 'application/json; charset=utf-8',
  woff2: 'font/woff2',
  woff: 'font/woff',
  ttf: 'font/ttf',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp'
}
/** Extensions whose payload is BYTES, not text: those sections are stored base64. */
const BINARY_EXTENSIONS = new Set(['woff2', 'woff', 'ttf', 'png', 'jpg', 'jpeg', 'webp'])
/** The one policy served with the entry document and with every section. */
const BLOCK_CSP = "default-src 'none'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; script-src 'none'; form-action 'none'; base-uri 'none'"
/** Canvas geometry shared with client.js (asserted equal by self-check.mjs). */
const DEFAULT_RES = { w: 1440, h: 900 }
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
const EDGE_CANDIDATES = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'
]

/** The active Harness home: DSH_HOME when set, else ~/.dsh. */
function harnessHome() {
  return process.env.DSH_HOME !== undefined && process.env.DSH_HOME !== '' ? process.env.DSH_HOME : join(homedir(), '.dsh')
}

/** Absolute ui-blocks directory under the active Harness home. */
function blocksDir() {
  return join(harnessHome(), DIR_NAME)
}

/** Absolute ui-captures directory: the material workshop, one directory per capture. */
function capturesDir() {
  return join(harnessHome(), CAPTURES_DIR_NAME)
}

/**
 * The packaged browser extension directory, as an ABSOLUTE path.
 *
 * Derived from THIS module's own location plus one constant child segment. A
 * request value never reaches it: realpathSync collapses the profile's
 * node_modules junction back to the package body, so the string is the same no
 * matter which spelling the loader resolved the plugin through — and the
 * "open the folder" route below cannot be talked into opening anything else.
 */
function extensionDir(dirName = EXTENSION_DIR_NAME) {
  return join(dirname(realpathSync(fileURLToPath(import.meta.url))), dirName)
}

/** The extension's own manifest: its version is the one the browser installed. */
async function readExtensionManifest(dirName = EXTENSION_DIR_NAME) {
  const dir = extensionDir(dirName)
  const manifest = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8'))
  return { dir, manifest }
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

/**
 * Split one block file into its entry markup and its virtual-file sections.
 * A marker line belongs to the section that FOLLOWS it, so whoever writes the
 * entry never has to remember a closing tag.
 * @param text - the file as it is on disk, or as replayed from history.
 * @returns entry plus every section in file order; no marker means no sections
 *   and then the entry is the whole file.
 */
function splitSections(text) {
  const files = []
  const entry = []
  let current = null
  for (const line of splitLines(text)) {
    const match = SECTION_RE.exec(line)
    if (match === null) {
      if (current === null) entry.push(line)
      else current.lines.push(line)
      continue
    }
    current = { path: match[1], base64: match[2] !== undefined, lines: [] }
    files.push(current)
  }
  return {
    entry: entry.join('\n'),
    files: files.map((file) => ({ path: file.path, base64: file.base64, body: file.lines.join('\n') }))
  }
}

/**
 * One section path: relative, inside the block, with an extension that names a
 * content type. A path this refuses never reaches the filesystem at all.
 * @returns the content type to serve it with.
 */
function sectionType(path) {
  const text = String(path == null ? '' : path)
  if (text === '' || text.startsWith('/') || text.includes('..') || text.includes('\\') || text.includes('\0')) {
    throw Object.assign(new Error('bad section path: ' + text), { status: 404 })
  }
  const dot = text.lastIndexOf('.')
  const type = dot < 0 ? undefined : SECTION_TYPES[text.slice(dot + 1).toLowerCase()]
  if (type === undefined) throw Object.assign(new Error('unknown section type: ' + text), { status: 415 })
  return type
}

/**
 * Assemble the virtual folder the tool receives into the one block body the
 * route already serves: the ENTRY text, then one `<!-- @@file <path> -->`
 * marker + body per remaining file, in argument order.
 *
 * Every check happens here, before anything touches the disk: a bad path, a
 * broken content/from pair, a body that would forge a section marker, a file
 * past SECTION_MAX_BYTES, or a block past BLOCK_MAX_BYTES all throw with the
 * offending file named. The route's 404/413 answers stay the last resort; this
 * is the first.
 *
 * @param files - [{ path, content } | { path, from }], at least one.
 * @param entryPath - which file renders; must be in files and at the root.
 * @returns the body to store, the chosen entry path, and the per-file facts the
 *   tool result reports.
 */
async function assembleBlock(files, entryPath) {
  if (!Array.isArray(files) || files.length === 0) {
    throw new Error(CREATE_TOOL + ': files must be a non-empty array of { path, content } or { path, from }')
  }
  const seen = new Set()
  const items = []
  for (const file of files) {
    const isObject = file !== null && typeof file === 'object' && !Array.isArray(file)
    const path = isObject ? String(file.path === undefined || file.path === null ? '' : file.path) : ''
    // Syntax first (the entry is usually .html, which is not a section type):
    // the extension check runs once the entry path is known.
    if (path === '' || path.startsWith('/') || path.includes('..') || path.includes('\\') || path.includes('\0')) {
      throw new Error(CREATE_TOOL + ': bad file path ' + JSON.stringify(isObject ? file.path : file) + ' — paths are relative, with no leading "/", no "..", no "\\"')
    }
    if (seen.has(path)) throw new Error(CREATE_TOOL + ': duplicate file path ' + path)
    seen.add(path)
    const hasContent = file.content !== undefined
    const hasFrom = file.from !== undefined
    if (hasContent === hasFrom) {
      throw new Error(CREATE_TOOL + ': file ' + path + ' needs exactly one of content / from')
    }
    const binary = BINARY_EXTENSIONS.has(path.slice(path.lastIndexOf('.') + 1).toLowerCase())
    let body
    let bytes
    let from
    if (hasContent) {
      if (typeof file.content !== 'string') throw new Error(CREATE_TOOL + ': content of ' + path + ' must be a string')
      body = binary ? file.content.trim() : file.content
      bytes = binary ? Buffer.from(body, 'base64').length : Buffer.byteLength(body, 'utf8')
    } else {
      if (typeof file.from !== 'string' || file.from.trim() === '') {
        throw new Error(CREATE_TOOL + ': from of ' + path + ' must be an absolute disk path')
      }
      from = file.from
      if (!isAbsolute(from)) throw new Error(CREATE_TOOL + ': from must be an absolute path, got ' + JSON.stringify(from))
      if (!existsSync(from)) throw new Error(CREATE_TOOL + ': from file does not exist: ' + from)
      const info = await stat(from)
      if (!info.isFile()) throw new Error(CREATE_TOOL + ': from is not a file: ' + from)
      if (info.size > SECTION_MAX_BYTES) throw new Error(CREATE_TOOL + ': from file is ' + String(info.size) + ' bytes; the limit is ' + String(SECTION_MAX_BYTES) + ': ' + from)
      const raw = await readFile(from)
      bytes = raw.length
      body = binary ? raw.toString('base64') : raw.toString('utf8')
    }
    if (bytes > SECTION_MAX_BYTES) {
      throw new Error(CREATE_TOOL + ': file ' + path + ' is ' + String(bytes) + ' bytes; the limit is ' + String(SECTION_MAX_BYTES))
    }
    for (const line of splitLines(body)) {
      if (SECTION_RE.test(line)) {
        throw new Error(CREATE_TOOL + ': the content of ' + path + ' contains a whole line that is a section marker ("<!-- @@file ... -->"); it would split the entry — remove or reword that line')
      }
    }
    items.push({ path, binary, body, bytes, from })
  }
  let entryName = entryPath === undefined || entryPath === null ? undefined : String(entryPath)
  if (entryName !== undefined) {
    if (entryName.includes('/') || entryName.includes('\\')) {
      throw new Error(CREATE_TOOL + ': entry must be a file at the block root (no "/" or "\\"), got ' + JSON.stringify(entryName))
    }
    if (!items.some((item) => item.path === entryName)) {
      throw new Error(CREATE_TOOL + ': entry ' + JSON.stringify(entryName) + ' is not one of files (' + items.map((item) => item.path).join(', ') + ')')
    }
  } else {
    const index = items.findIndex((item) => item.path === 'index.html')
    entryName = (index < 0 ? items[0] : items[index]).path
  }
  // The entry is served as a DOCUMENT, so its own extension may be html/htm;
  // every other file is a section and must map to a real content type.
  for (const item of items) {
    try {
      sectionType(item.path)
    } catch {
      if (item.path !== entryName || !/\.html?$/i.test(item.path)) {
        throw new Error(CREATE_TOOL + ': bad file path ' + JSON.stringify(item.path) + ' — sections need one of ' + Object.keys(SECTION_TYPES).join(' '))
      }
    }
  }
  const entry = items.find((item) => item.path === entryName)
  if (entry.body.trim() === '') throw new Error(CREATE_TOOL + ': the entry ' + entry.path + ' is empty')
  // Join with ONE newline: splitSections() separates on '\n', so a body that ends
  // with a newline keeps it (it becomes a trailing empty line inside the section).
  const rest = items.filter((item) => item.path !== entryName)
  const text = [entry.body, ...rest.map((item) => '<!-- @@file ' + item.path + (item.binary ? ' base64' : '') + ' -->\n' + item.body)].join('\n')
  const total = Buffer.byteLength(text, 'utf8')
  if (total > BLOCK_MAX_BYTES) {
    throw new Error(CREATE_TOOL + ': the assembled block is ' + String(total) + ' bytes; the limit is ' + String(BLOCK_MAX_BYTES) + ' — keep binary sections small (an SVG text section costs almost nothing)')
  }
  return {
    text,
    entry: entry.path,
    files: items.map((item) => ({
      path: item.path,
      bytes: item.bytes,
      ...item.from === undefined ? {} : { from: item.from }
    }))
  }
}

/** One plain-text answer: no cache, an exact length, no sniffing. */
function sendText(res, status, message) {
  const text = String(message)
  res.writeHead(status, {
    'cache-control': 'no-store',
    'content-type': 'text/plain; charset=utf-8',
    'content-length': String(Buffer.byteLength(text))
  })
  res.end(text)
}

/** Headers carried by the entry document and by every section. */
function blockHeaders() {
  return { 'content-security-policy': BLOCK_CSP, 'x-content-type-options': 'nosniff' }
}

/** The HTTP status a helper threw with; 500 when it threw without one. */
function httpStatus(error) {
  const status = error === null || error === undefined ? undefined : error.status
  return typeof status === 'number' ? status : 500
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
 * Measure CSS selectors in the document that is already rendered.
 *
 * Each row is [selector, matchCount, x, y, width, height]: integers, rounded,
 * relative to the document; matchCount -1 means querySelectorAll rejected the
 * selector itself.
 */
function probeScript(selectors) {
  return '(function(){var out=[],sels=' + JSON.stringify(selectors.map((one) => String(one))) + ';'
    + 'for(var i=0;i<sels.length;i++){var s=sels[i],list;'
    + 'try{list=document.querySelectorAll(s)}catch(error){out.push([s,-1,0,0,0,0]);continue}'
    + 'if(list.length===0){out.push([s,0,0,0,0,0]);continue}'
    + 'var r=list[0].getBoundingClientRect();'
    + 'out.push([s,list.length,Math.round(r.left+window.scrollX),Math.round(r.top+window.scrollY),Math.round(r.width),Math.round(r.height)])}'
    + 'return JSON.stringify(out)})()'
}

/** One compact line per probed selector: how many matched, then the first box. */
function formatProbe(rows) {
  return rows.map((row) => {
    const selector = String(row[0])
    const count = Number(row[1])
    if (count < 0) return selector + ': invalid selector'
    if (count === 0) return selector + ': no match'
    return selector + ': ' + (count === 1 ? '1 match' : String(count) + ' matches')
      + ', first x=' + row[2] + ' y=' + row[3] + ' w=' + row[4] + ' h=' + row[5]
  }).join('\n')
}

/**
 * Render one block body through the live app's own renderer and screenshot it.
 * @param options.baseUrl - the authenticated app URL (the token source).
 * @param options.body - the block body, entry plus sections, as stored on disk.
 * @param options.blockName - the block's name. A sectioned body is screenshotted
 *   through its OWN url: that is the only place its <link>/url()/src resolve.
 * @param options.res - canvas geometry; the screenshot is exactly this size.
 * @param options.timeoutMs - overall budget for the page to come up.
 * @param options.probe - CSS selectors to measure; measured AFTER the shot, in
 *   the document the shot came from.
 * @returns PNG bytes plus the token count and scheme the render used, and the
 *   probe lines when selectors were given.
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
      const tokens = JSON.parse(await evaluate('JSON.stringify(window.__dshPageBlock.render.tokens())'))
      const asDocument = options.blockName !== undefined && splitSections(String(options.body)).files.length > 0
      // The token sheet comes from the client's own builder (no second copy of
      // BASE_CSS here) and is captured BEFORE the page navigates away.
      const srcdoc = asDocument ? '' : await evaluate('window.__dshPageBlock.render.srcdoc(' + JSON.stringify(String(options.body)) + ')')
      const sheet = asDocument ? await evaluate('window.__dshPageBlock.render.sheet()') : ''
      if (!asDocument && (typeof srcdoc !== 'string' || srcdoc === '')) throw new Error('client render.srcdoc returned an empty document')
      if (asDocument && (typeof sheet !== 'string' || sheet === '')) throw new Error('client render.sheet returned an empty token sheet')

      await send('Page.navigate', { url: 'about:blank' })
      await sleep(200)
      await send('Emulation.setDeviceMetricsOverride', { width: res.w, height: res.h, deviceScaleFactor: 1, mobile: false })
      if (asDocument) {
        const entry = new URL(options.baseUrl)
        entry.pathname = ROUTE_PATH + '/' + encodeURIComponent(String(options.blockName)) + '/'
        await send('Page.navigate', { url: entry.toString() })
        // Load first, then inject exactly as the canvas does, then let it paint.
        await until(async () => evaluate("document.readyState === 'complete' && !!document.head"), options.timeoutMs, 'the block document to load')
        await evaluate('document.head.insertAdjacentHTML("afterbegin", ' + JSON.stringify('<style id="dshpb-tokens">' + sheet + '</style>') + ');1')
      } else {
        await evaluate('document.open();document.write(' + JSON.stringify(srcdoc) + ');document.close();')
      }
      // Two frames: one for the write to lay out, one for it to paint.
      await evaluate('new Promise(function(done){requestAnimationFrame(function(){requestAnimationFrame(function(){done(1)})})})')
      const shot = await send('Page.captureScreenshot', {
        format: 'png',
        clip: { x: 0, y: 0, width: res.w, height: res.h, scale }
      })
      const data = shot.result && shot.result.data
      if (typeof data !== 'string' || data === '') throw new Error('Page.captureScreenshot returned no data')
      // After the capture, before the page goes away: the same document the shot
      // came from. Nothing here runs when no selectors were asked for.
      const measurements = Array.isArray(options.probe) && options.probe.length > 0
        ? formatProbe(JSON.parse(await evaluate(probeScript(options.probe))))
        : undefined
      return {
        png: Buffer.from(data, 'base64'),
        tokenCount: tokens.count,
        scheme: tokens.scheme,
        width: Math.round(res.w * scale),
        height: res.h,
        ...measurements === undefined ? {} : { measurements }
      }
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
  'Create one UI block: a small virtual folder at ~/.dsh/ui-blocks/<name>.uiblock. One file is the ENTRY that renders; the rest are assets and extra pages it links. Use it whenever the user asks for a page, panel, dialog, card, widget or any other visual object — something to look at rather than read about.',
  '',
  'NO SCRIPTING: a block is pure data. Every document it serves ships under CSP `script-src \'none\'`, so a <script>, an on* handler or a javascript: URL in it never runs, and nothing remote arrives either — a CDN stylesheet or a remote image stays empty. Everything the block shows comes from its own files; anything that moves (a state switch, a canned demo) is produced from outside the block, by the message or by the timeline in DEMO below.',
  '',
  'WORK FROM THE REAL SOURCE. When the block depicts or redesigns an existing part of this app, the existing source is the basis — never hand-build a lookalike. Read the component\'s compiled CSS (the `const css$NN = "..."` strings inside node_modules/@deepseek-ai/dsh-client-ui-*/lib/client.js) and pass it as a file with `from`; write the entry with that component\'s REAL class names. To change the design, edit those real rules or add a stylesheet that overrides them. For a sketch with nothing to copy, style it with inline CSS and the theme tokens (var(--dsw-*)).',
  '',
  'FILES: prefer `from` — an absolute disk path the host copies verbatim — for anything large (compiled CSS, fonts, images) instead of retyping its text.',
  '',
  'ENTRY AND URLS: the entry is served at /ui-blocks/<name>/, every other file at /ui-blocks/<name>/<path>, so all of them are siblings. Link them relatively from the entry: ./card.css, ./icons/ok.svg, ./pages/error.html — and ./ on its own comes back to the entry. Writing index.html does not: only a real member answers at its own path, and the entry has its own URL.',
  '',
  'PAGES: any .html member is a whole page of its own, so one block can carry several screens of the same product — the same form at rest, in error, mid-load — instead of faking them inside one document.',
  '',
  'DEMO: add a demo.json member — { snapshots: { home: "pages/home.html" }, timeline: { steps: [{ at: 0, do: "switch", snapshot: "home" }, { at: 900, do: "type", to: "#email", text: "a@b.c" }] } } — and with a non-empty timeline.steps the plugin plays the block itself and loops it: switch / move / highlight / click / type all run from outside, and a page change is a snapshot change. Without that member, or with an empty timeline, the block is a still page. A demo may be orchestrated and fictional; the screens it switches between are ones you wrote.',
  '',
  'DELIVERY: nothing is visible until a reply carries the block\'s own line `::dsh-ui <name>::` — optionally res=WxH, the only way to set canvas size (default 1440x900). Size the height to the content: a dialog, card or toolbar wants roughly 280-420, a full page 600+; a card left at 900 reads as a broken preview. The line must be exactly that, alone on its line, no backticks or fence. A reference renders the version the block had when that message was first seen — updating a block only changes messages that reference it afterwards.',
  '',
  'INSIDE THE BLOCK: only the rendered UI — no headings, notes, captions or "方案 A" commentary; every character renders into the canvas.',
  '',
  'CREATING vs UPDATING:',
  '- To CREATE a UI block, call this tool.',
  '- Do NOT create a .uiblock file with write. A block that was not created through this tool has no registered metadata, so read_ui_block and the reference line cannot find it.',
  '- To UPDATE an existing block, change the .uiblock file in place: `edit` for a targeted change, or `write` when the block is almost entirely new. Then reference it again in the same message. Do NOT call this tool again to update it, and do NOT write it through a shell command or a script.',
  '- Editing by hand means writing the file format: every extra member is a section that starts on a whole line `<!-- @@file <path> [base64] -->` and runs to the next such line or to the end. Add `base64` to a binary one (png webp jpg jpeg woff woff2 ttf) — unmarked, its bytes are decoded as text and the member arrives corrupted. No member\'s own content may contain such a line; it would split the file.'
].join('\n')

const READ_DESCRIPTION = [
  'Render one UI block the way the user sees it and return the image. This is the real canvas, not a mock-up: live theme tokens, the current light/dark scheme and the block\'s own files, so the picture is what the user will get.',
  '',
  'The entry is laid out at the width/height you pass — media queries re-evaluate, it is not a PNG downscale. Pass the same pair you will declare on the reference line, otherwise you are checking a different layout than the user is looking at.',
  '',
  'Use it to check layout, spacing, overflow and colour before handing a draft to the user. It renders the entry page, so a demo block comes back as its still screen, not as a timeline frame.',

  'When a size is not readable from the image — cards that should end up equal height — pass `probe` and compare the numbers it returns.',
  '',
  'THIS IMAGE GOES TO THE MODEL, NOT TO THE USER. The user only sees what a message references with `::dsh-ui <name>::` on a line of its own. Rendering here without that line leaves the draft invisible to them — pass the check, then reference it in the same message.'
].join('\n')

const LIST_DESCRIPTION = [
  'List the web pages a browser extension is reporting to this DSH instance right now, so a capture targets a page that exists instead of a URL someone guessed.',
  '',
  'Call this first, then capture_page with one row\'s { instance, tabId }: a tab id is unique only inside one instance, so the pair is the identity. url and title say what the page is, focused says whether it is the active tab, and capturable:false carries the reason that tab can never be captured (a chrome:// page, the extension store, an extension page, an embedded PDF).',
  '',
  'The list is only what the extension last reported: a tab it cannot see is absent, never guessed. A report more than 10 minutes old is marked stale on its rows, because a tab closed since then is still listed — refresh by calling again once the extension has polled (it polls every couple of seconds). An empty list means nothing is connected, and the result then says what to check.'
].join('\n')

const CAPTURE_DESCRIPTION = [
  'Capture one web page — a row from list_pages, given as { instance, tabId } — into a material directory, and hand back a file list that create_ui_block can load straight off disk, so no page content has to pass through this conversation.',
  '',
  'The extension does the extraction: the DOM, the styles that actually apply, and the fonts and images, plus a report of what it kept and what it dropped. This tool only queues the task for that instance, waits for the answer, and lets the plugin write the material to <DSH_HOME>/ui-captures/<name>/ — the entry document, its shared/pages/assets material and report.json.',
  '',
  'files[].from is the ABSOLUTE path of each file on disk. Pass those strings as create_ui_block\'s files[].from and the host copies the bytes itself: a few hundred KB of material then costs no context at all. Read a file only when the caller asked to change its content.',
  '',
  'A failure is always one concrete cause: the extension never reported in, it reported but never took the task, it took the task and never answered, the target tab is gone (call list_pages again — do not substitute another tab), or the extension itself failed, in which case its own message is repeated verbatim.'
].join('\n')

// ---------------------------------------------------------------------------
// The extension hub: two endpoints, one task queue, one material workshop.
//
// Local polling on purpose: the extension POSTs /poll every couple of seconds,
// reports the tabs it can see and takes at most one task; it then POSTs /result
// with the material. No socket, so a browser restart or a DSH restart needs no
// reconnect logic — the next poll IS the reconnect.
//
// The two model-facing tools (list_pages / capture_page) sit on top of this
// hub: they read the instance table and the completed table, and drop a task
// into the same queue the endpoint hands out. The HTTP contract stays exactly
// as it is — enqueue(), take() and complete() are the seam.
// ---------------------------------------------------------------------------

/**
 * The hub. Module scope, not per-fiber: a task is handed out in one request and
 * completed in the next, and the capture tools that will enqueue tasks land
 * later against this same object.
 */
const agentHub = {
  /** Queued tasks, oldest first: { id, instance?, tabId, name?, includes?, maxBytes?, queuedAt }. */
  tasks: [],
  /** taskId -> the task as it was handed out. */
  issued: new Map(),
  /** taskId -> { dir, at }: where a completed task's material landed. */
  completed: new Map(),
  /** instance -> { tabs, at, origin }: the last tab list an extension reported. */
  instances: new Map(),
  /** Newest requests, oldest first. Loose mode records the source, never blocks. */
  recent: [],
  /** Live switches; apply() writes them, every request reads them (no restart). */
  options: { enabled: true, requireToken: false, token: '' },

  /** Queue one task; the id is ours, never the caller's. */
  enqueue(task) {
    const queued = {
      id: 't-' + randomBytes(6).toString('hex'),
      ...task.instance === undefined ? {} : { instance: String(task.instance) },
      tabId: Number(task.tabId),
      ...task.name === undefined ? {} : { name: String(task.name) },
      ...task.includes === undefined ? {} : { includes: String(task.includes) },
      ...task.maxBytes === undefined ? {} : { maxBytes: Number(task.maxBytes) },
      queuedAt: new Date().toISOString()
    }
    this.tasks.push(queued)
    return queued
  },

  /**
   * Take the next task this instance may run, off the queue.
   * ponytail: a task nobody answers stays queued forever and a later poll will
   * hand it out again — one browser, one user. Add a queuedAt deadline when a
   * second instance or an abandoned task shows up.
   * @param instance - the polling instance, matched against a task's optional instance.
   * @returns the task, or undefined when the queue holds nothing for it.
   */
  take(instance) {
    for (let index = 0; index < this.tasks.length; index += 1) {
      const task = this.tasks[index]
      if (task.instance !== undefined && task.instance !== instance) continue
      this.tasks.splice(index, 1)
      this.issued.set(task.id, task)
      return task
    }
    return undefined
  },

  /**
   * Record what a task produced: the directory, the files and the report as
   * written. capture_page awaits this record, so it never has to re-read a file
   * it just made the endpoint write.
   */
  complete(taskId, made) {
    this.completed.set(taskId, { ...made, at: new Date().toISOString() })
  },

  /**
   * Drop a task that will never be answered, so it cannot be handed out on some
   * later poll and hijack a caller who has already given up. The issued entry
   * stays put: a late answer still lands in the same directory.
   */
  cancel(taskId) {
    const index = this.tasks.findIndex((task) => task.id === taskId)
    if (index >= 0) this.tasks.splice(index, 1)
  },

  /** Push one request onto the ring. */
  record(entry) {
    this.recent.push(entry)
    if (this.recent.length > AGENT_RECENT_MAX) this.recent.shift()
  }
}

/**
 * Read the three switches off the plugin config, keeping the documented defaults.
 * A missing agent block, a missing field and an unreadable value are all the
 * default: enabled, loose, no token.
 * @param config - the plugin config; the row lives in the profile patch.
 * @returns the live options object every request reads.
 */
function applyAgentConfig(config) {
  const raw = config !== null && typeof config === 'object' && config.agent !== null && typeof config.agent === 'object' ? config.agent : {}
  agentHub.options = {
    enabled: raw.enabled !== false,
    requireToken: raw.requireToken === true,
    token: raw.token === undefined || raw.token === null ? '' : String(raw.token)
  }
  return agentHub.options
}

/** CORS for the extension only: a chrome-extension:// page needs it, a web page never gets one. */
function corsHeaders(req) {
  const origin = String(req.headers.origin === undefined ? '' : req.headers.origin)
  if (!origin.startsWith('chrome-extension://')) return {}
  return {
    'access-control-allow-origin': origin,
    'access-control-allow-methods': 'POST, OPTIONS',
    'access-control-allow-headers': 'content-type, x-uiblock-token, authorization',
    'access-control-max-age': '600',
    vary: 'origin'
  }
}

/** The pairing code a request carried: ?token=, the x-uiblock-token header, or Authorization: Bearer. */
function requestToken(req, url) {
  const query = url.searchParams.get('token')
  if (query !== null && query !== '') return query
  const header = req.headers['x-uiblock-token']
  if (typeof header === 'string' && header !== '') return header
  const authorization = req.headers.authorization
  if (typeof authorization === 'string' && /^bearer\s+/i.test(authorization)) return authorization.replace(/^bearer\s+/i, '').trim()
  return ''
}

/** One JSON body, with the ceiling applied while reading rather than after. */
async function readJsonBody(req, limit) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) {
      const error = new Error('request body is larger than ' + String(limit) + ' bytes')
      error.status = 413
      throw error
    }
    chunks.push(chunk)
  }
  const text = Buffer.concat(chunks).toString('utf8').trim()
  if (text === '') return {}
  try {
    const parsed = JSON.parse(text)
    return parsed !== null && typeof parsed === 'object' ? parsed : {}
  } catch {
    const error = new Error('request body is not JSON')
    error.status = 400
    throw error
  }
}

/**
 * A tab report, cleaned: a malformed row is dropped, never guessed at.
 *
 * The four documented fields are normalized and EVERY OTHER field is carried
 * through untouched — capturable, reason, and whatever the extension adds next.
 * There is no field whitelist here: refusing an unknown key would break the
 * extension for a field this side has not learned about yet.
 */
function normalizeTabs(value) {
  if (!Array.isArray(value)) return []
  const tabs = []
  for (const entry of value) {
    if (entry === null || typeof entry !== 'object') continue
    const tabId = Number(entry.tabId)
    if (!Number.isFinite(tabId)) continue
    const tab = {
      tabId,
      url: String(entry.url === undefined ? '' : entry.url),
      title: String(entry.title === undefined ? '' : entry.title),
      focused: entry.focused === true
    }
    for (const [key, extra] of Object.entries(entry)) {
      if (key === 'tabId' || key === 'url' || key === 'title' || key === 'focused') continue
      tab[key] = extra
    }
    tabs.push(tab)
  }
  return tabs
}

/** The block name a capture gets when the task named none: capture-YYYYMMDD-HHmmss, local time. */
function captureStamp(date) {
  const pad = (value) => String(value).padStart(2, '0')
  return 'capture-' + String(date.getFullYear()) + pad(date.getMonth() + 1) + pad(date.getDate()) +
    '-' + pad(date.getHours()) + pad(date.getMinutes()) + pad(date.getSeconds())
}

/**
 * One material path as reported by the extension: relative, forward slashes, no
 * traversal. Anything else is a 400, because the alternative is writing outside
 * the capture directory.
 */
function captureRelativePath(value) {
  const text = String(value === undefined || value === null ? '' : value).replace(/\\/g, '/').trim()
  const parts = text.split('/')
  const bad = text === '' || text.startsWith('/') || /^[A-Za-z]:/.test(text) ||
    parts.some((part) => part === '' || part === '.' || part === '..')
  if (bad) {
    const error = new Error('files[].path must be a relative path inside the capture directory, got ' + JSON.stringify(value))
    error.status = 400
    throw error
  }
  return parts.join('/')
}

/**
 * The directory one capture writes into: the task's block name when it has a
 * usable one, else capture-<stamp>; a name already taken gets -2, -3, and so on.
 * @returns the absolute directory, created.
 */
async function captureDirFor(task) {
  const wanted = task !== undefined && typeof task.name === 'string' && NAME_RE.test(task.name) ? task.name : captureStamp(new Date())
  let dir = join(capturesDir(), wanted)
  for (let n = 2; existsSync(dir) && n < 100; n += 1) dir = join(capturesDir(), wanted + '-' + String(n))
  await mkdir(dir, { recursive: true })
  return dir
}

/**
 * Write one capture: every files[] entry at its own relative path, then report.json.
 * @param result - the result body the extension posted.
 * @param task - the task as handed out, when this side still knows it.
 * @returns the absolute directory and the files it wrote.
 */
async function writeCapture(result, task) {
  const dir = await captureDirFor(task)
  const written = []
  const files = Array.isArray(result.files) ? result.files : []
  for (const file of files) {
    const entry = file !== null && typeof file === 'object' ? file : {}
    const relative = captureRelativePath(entry.path)
    const bytes = entry.base64 === true
      ? Buffer.from(String(entry.content === undefined ? '' : entry.content), 'base64')
      : Buffer.from(String(entry.content === undefined ? '' : entry.content), 'utf8')
    const target = join(dir, relative)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, bytes)
    written.push({ path: relative, bytes: bytes.length })
  }
  const report = result.report !== null && typeof result.report === 'object' ? result.report : {}
  // The extension's report goes in VERBATIM at the top level: origin, title,
  // bytes, dropped and every extra counter it carries (files[], rulesTotal,
  // sheets, varsResolved, assetsInlined, degrade[]...) — that report is the only
  // record of how a capture was taken, so nothing here may drop or rename a
  // field. Our own bookkeeping lives under "capture" and cannot shadow theirs.
  const body = {
    ...report,
    ...report.bytes === undefined
      ? { bytes: written.reduce((sum, file) => sum + file.bytes, 0) }
      : {},
    capture: {
      taskId: result.taskId === undefined ? null : String(result.taskId),
      instance: result.instance === undefined ? null : String(result.instance),
      ok: result.ok !== false,
      reportedAt: new Date().toISOString(),
      dir,
      error: result.error === undefined ? null : String(result.error),
      files: written
    }
  }
  await writeFile(join(dir, 'report.json'), JSON.stringify(body, null, 2) + '\n', 'utf8')
  return { dir, files: written, report: body }
}

// ---------------------------------------------------------------------------
// The two capture tools: what can be captured, then capture one.
//
// list_pages reads agentHub.instances (every tab list an extension reported)
// and answers an array of rows. An empty array cannot carry advice, so the
// rendered text is composed from live hub state instead — a model that reads
// "[]" alone would have nothing to act on.
//
// capture_page enqueues a task and awaits the record the result endpoint
// completes. The record carries the files and the report, so a successful
// capture never re-reads a file it just wrote — and every file comes back with
// its absolute path, which is what create_ui_block's `from` takes.
// ---------------------------------------------------------------------------

/** A tab report older than this cannot be trusted: the tab may be long closed. */
const STALE_AFTER_MS = 10 * 60 * 1000
/** How long capture_page waits for the extension unless the caller says otherwise. */
const CAPTURE_DEFAULT_TIMEOUT_MS = 60000
/** Ceilings for timeout_ms: below this the extension gets no chance to poll even once. */
const CAPTURE_MIN_TIMEOUT_MS = 1000
const CAPTURE_MAX_TIMEOUT_MS = 110000

/**
 * The port this instance listens on, for the "point the extension here" advice.
 * Learned when the web server is composed; 0 before that.
 */
let agentPort = 0

/** How to spell the current instance in an instruction a human can follow. */
function instancePortText() {
  return agentPort > 0 ? 'http://127.0.0.1:' + String(agentPort) : 'this instance\'s own port'
}

/** One compact time for the recent-request trail: HH:MM:SS, local. */
function shortTime(at) {
  const date = new Date(at)
  const pad = (value) => String(value).padStart(2, '0')
  return pad(date.getHours()) + ':' + pad(date.getMinutes()) + ':' + pad(date.getSeconds())
}

/** The rows table, or — when there is nothing to list — what to check, in order. */
function pagesText(rows, args) {
  const wanted = String(args === undefined || args === null || args.instance === undefined || args.instance === null ? '' : args.instance).trim()
  if (rows.length > 0) {
    const lines = rows.map((row) => (row.capturable ? '' : '[cannot capture] ') + 'instance=' + row.instance + ' tabId=' + String(row.tabId)
      + ' | ' + (row.title === '' ? '(no title)' : row.title) + ' | ' + row.url
      + ' | ' + (row.focused ? 'focused' : 'background')
      + (row.capturable ? '' : ' | ' + (row.reason === undefined ? 'no reason given' : row.reason))
      + (row.stale ? ' | STALE: last reported ' + row.seenAt + ', call the extension to refresh before capturing' : ''))
    if (rows.some((row) => !row.capturable)) lines.push('', 'Each [cannot capture] row is there so it does not become a target: those pages have no DOM to extract. capture_page takes only the other rows.')
    return lines.join('\n')
  }
  const known = [...agentHub.instances.keys()]
  const lines = []
  if (wanted === '') {
    lines.push(known.length === 0
      ? 'No browser tab is on the list: no extension has reported to this instance yet.'
      : 'No browser tab is on the list, though these instances are reporting: ' + known.join(', ') + ' — each of them reported zero tabs.')
  } else {
    lines.push('No browser tab is on the list for instance "' + wanted + '".'
      + (known.length === 0 ? ' No extension has reported to this instance at all.' : ' Instances reporting right now: ' + known.join(', ') + '.'))
  }
  const recent = agentHub.recent.slice(-6)
  if (recent.length > 0) {
    lines.push('', 'Last requests this endpoint saw (newest last): ' + recent.map((entry) => shortTime(entry.at) + ' ' + entry.kind
      + (entry.instance === '' || entry.instance === undefined ? '' : ' instance=' + entry.instance) + ' -> ' + entry.outcome).join('; '))
  }
  lines.push('', 'Check these in order:')
  lines.push('1. Is the capture extension installed? chrome://extensions must list dsh-page-capture. Its install path and the three loading steps are on this plugin\'s page under Settings -> Plugins -> dsh-ui-block.')
  lines.push('2. Does its options page point baseURL at ' + instancePortText() + '? The extension is installed once and reports to whichever instance that baseURL names, so pointing it at the other instance makes this list empty while the other one fills up.')
  lines.push('3. Is the extension\'s own reporting switch on? With it off the extension sends nothing at all — not even a poll — so nothing here can see it.')
  lines.push('4. Are the plugin\'s agent switches on (agent.enabled)? Off, both endpoints answer 404 and the extension gives up. The request trail above says whether anything arrived at all: no line at all means the request never reached this instance.')
  lines.push('5. Even when connected, some pages never reach the list: chrome:// pages, extension pages, the extension store and embedded PDFs are reported as capturable=false, and a window showing only those leaves nothing to capture.')
  return lines.join('\n')
}

/** One line a human can read: how many files, how big, what the extension dropped. */
function captureSummary(files, report) {
  const total = files.reduce((sum, file) => sum + file.bytes, 0)
  const dropped = report !== null && typeof report === 'object' ? report.dropped : undefined
  const droppedText = Array.isArray(dropped)
    ? String(dropped.length) + ' resource(s) dropped'
    : typeof dropped === 'number' ? String(dropped) + ' resource(s) dropped' : 'nothing recorded as dropped'
  return String(files.length) + ' file(s), ' + String(total) + ' bytes total, ' + droppedText
}

/** The capture tool's rendered text: where it landed, what to do with it, the report. */
function captureText(value) {
  const lines = ['Capture landed in ' + value.dir + ' — ' + value.summary, '']
  lines.push('files[] — `from` is the file\'s absolute path on disk. Hand those strings to create_ui_block as files[].from and the host copies the bytes itself, so none of this material enters the conversation:')
  for (const file of value.files) lines.push('  ' + file.path + '  ' + String(file.bytes) + ' bytes  from=' + file.from)
  const entry = value.files.find((file) => /\.html$/.test(file.path))
  if (entry !== undefined) {
    lines.push('', 'A create_ui_block call with this material: name "' + baseNameOf(value.dir) + '", entry "' + entry.path + '", and one { path, from } item per line above.')
  }
  const reportText = JSON.stringify(value.report, null, 2)
  if (reportText.length <= 4000) lines.push('', 'report.json, verbatim (also on disk at ' + value.dir + '/report.json):', reportText)
  else lines.push('', 'report.json is ' + String(reportText.length) + ' bytes — too long to repeat here; it is on disk at ' + value.dir + '/report.json and its counters are in the summary above.')
  return lines.join('\n')
}

/** The last path segment, used only to suggest a block name. */
function baseNameOf(dir) {
  const parts = String(dir).split(/[\\/]/).filter((part) => part !== '')
  return parts.length === 0 ? '' : parts[parts.length - 1]
}

/**
 * Wait for one task's material.
 * @param task - the task as enqueued, for its id, instance and tabId.
 * @param timeoutMs - how long to wait.
 * @param watched - true when the tab was in the instance's list BEFORE the task
 *   was queued: only then does its disappearance prove the tab was closed (and
 *   only then is it safe to fail early instead of waiting out the timeout).
 * @returns the completed record, or undefined when the deadline passes first.
 */
async function awaitCapture(task, timeoutMs, watched) {
  const deadline = Date.now() + timeoutMs
  const queuedAt = Date.parse(task.queuedAt)
  while (Date.now() < deadline) {
    const done = agentHub.completed.get(task.id)
    if (done !== undefined) return done
    if (watched && task.instance !== undefined) {
      const seen = agentHub.instances.get(task.instance)
      // >= on purpose: a poll can land in the same millisecond as the enqueue, and
      // that report is still a statement about the tab AFTER we asked for it.
      if (seen !== undefined && seen.at >= queuedAt && !seen.tabs.some((tab) => tab.tabId === task.tabId)) {
        const error = new Error(CAPTURE_TOOL + ': the target tab is gone — tabId ' + String(task.tabId) + ' is no longer in instance "'
          + String(task.instance) + '"\'s latest report (' + String(seen.tabs.length) + ' tab(s) left). The page was closed or navigated away while the capture was running; call list_pages again and pick a live tab rather than substituting another one.')
        error.status = 409
        throw error
      }
    }
    await sleep(120)
  }
  return undefined
}

/** Why no material came back: the three causes are different problems for the user. */
function noResultText(task, timeoutMs) {
  const seconds = Math.round(timeoutMs / 1000)
  const head = LIST_TOOL + ' -> ' + CAPTURE_TOOL + ': no material came back within ' + String(seconds) + 's for tabId ' + String(task.tabId)
    + ' on instance "' + String(task.instance) + '". '
  const seen = task.instance === undefined ? undefined : agentHub.instances.get(task.instance)
  if (seen === undefined) {
    return head + 'That instance never reported in, so the extension is not polling this instance at all. Check that it is installed, that its options baseURL points at '
      + instancePortText() + ', and that its reporting switch is on; then call ' + LIST_TOOL + ' again.'
  }
  if (agentHub.tasks.some((queued) => queued.id === task.id)) {
    return head + 'The extension IS polling ("' + String(task.instance) + '" reported ' + String(seen.tabs.length)
      + ' tab(s), last at ' + new Date(seen.at).toISOString() + ') but never took the task off the queue — it is most likely running a build without task support. Reload it from chrome://extensions.'
  }
  return head + 'The extension took the task and never answered: the page may be stuck loading, or the extension hit an error and dropped the result. Its own console is the place to look (chrome://extensions -> the extension -> service worker). The task is still remembered here, so a late answer still lands in ui-captures.'
}
/**
 * Mount the tools and the read route, plus the extension hub.
 * @param ctx - plugin context carrying `tools` (and `webServer`/`attachments`/`connection` when composed).
 * @param config - plugin config; the agent block holds the three switches.
 */
export function apply(ctx, config) {
  applyAgentConfig(config)
  ctx.tools.register(defineTool({
    name: CREATE_TOOL,
    description: CREATE_DESCRIPTION,
    parameters: {
      name: {
        type: 'string',
        required: true,
        description: 'Block name: 1-64 chars of [A-Za-z0-9._-], starting with a letter or digit. The file is ~/.dsh/ui-blocks/<name>.uiblock.'
      },
      entry: {
        type: 'string',
        description: 'Which file renders: a path at the block ROOT (no "/"). Omitted, it is the file called index.html, else the first file.'
      },
      title: {
        type: 'string',
        description: 'Optional human label for the preview card. Not stored in the file.'
      },
      files: {
        type: 'array',
        required: true,
        description: 'One item per file: { path, content } for text you write, or { path, from } for an absolute disk path the host copies verbatim. Binary extensions (woff2 woff ttf png jpg jpeg webp) are stored as base64 automatically, so pass a binary either as a base64 string in `content` or, better, as `from`. At least one item; the entry must be among them. 256 KB per file, measured on the decoded bytes; 2 MB per block, measured on the stored file text, where a base64 payload counts about 4/3 of its real size.',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            path: { type: 'string', required: true, description: 'Relative path inside the block: no leading "/", no "..", no backslash. The extension decides the content type: html css svg json woff2 woff ttf png jpg jpeg webp.' },
            content: { type: 'string', description: 'The file body, for a small text file.' },
            from: { type: 'string', description: 'Absolute disk path to copy verbatim, for anything large (compiled CSS, fonts, images).' }
          }
        }
      }
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string', required: true },
          name: { type: 'string', required: true },
          backup: { type: 'string' },
          files: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                path: { type: 'string', required: true },
                bytes: { type: 'number', required: true },
                from: { type: 'string' }
              }
            }
          }
        }
      },
      render: (args, value) => [{
        type: 'text',
        text: 'UI block: ' + value.path + '\nFiles:\n' + value.files.map((file) => '  - ' + file.path + ' (' + String(file.bytes) + ' bytes' + (file.from === undefined ? '' : ', from ' + file.from) + ')').join('\n') + '\nNOT VISIBLE TO THE USER YET. Reference it in the same message with a line of its own (canvas size optional as res=WxH):\n  ::dsh-ui ' + value.name + '::' + (value.backup === undefined ? '' : '\nPrevious version backed up to: ' + value.backup)
      }]
    },
    execute: async (args) => {
      const blockName = assertName(args.name)
      const assembled = await assembleBlock(args.files, args.entry)
      const written = await writeBlock(blockName, assembled.text)
      return {
        path: blockPath(blockName),
        name: blockName,
        ...written.backup === undefined ? {} : { backup: written.backup },
        files: assembled.files
      }
    },
    presentCall: (args) => {
      const files = Array.isArray(args.files) ? args.files : []
      const wanted = typeof args.entry === 'string' && args.entry !== ''
        ? args.entry
        : (files.find((file) => file !== null && typeof file === 'object' && file.path === 'index.html') === undefined
          ? (files[0] === undefined ? undefined : files[0].path)
          : 'index.html')
      const entry = files.find((file) => file !== null && typeof file === 'object' && file.path === wanted)
      return {
        card: 'generic',
        title: String(args.title ?? args.name ?? 'UI block'),
        kind: 'other',
        content: [{ type: 'text', text: String(entry !== undefined && entry.content !== undefined ? entry.content : '') }]
      }
    }
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
      },
      probe: {
        type: 'array',
        description: 'Optional CSS selectors to measure in the rendered document, for when the image cannot show a size. Each returns how many elements matched and the FIRST match\'s x / y / width / height in document pixels, rounded to integers; nothing matched reads `no match`. A comma list is one selector list: the count and the box are over the union, and "first" means document order.',
        items: { type: 'string' }
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
          measurements: {
            type: 'string',
            description: 'One line per probed selector: match count, then the first match box. Present only when probe was passed.'
          },
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
          + (value.measurements === undefined ? '' : '\n<measurements>\n' + value.measurements + '\n</measurements>')
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
        blockName,
        res: canvas,
        probe: Array.isArray(args.probe) ? args.probe : undefined,
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
        ...shot.measurements === undefined ? {} : { measurements: shot.measurements },
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

  // --- the capture tools ---------------------------------------------------
  // Both are thin: they read the hub and drop a task in its queue. Nothing here
  // touches the HTTP contract, so an extension that ignores these tools keeps
  // working exactly as before.
  ctx.tools.register(defineTool({
    name: LIST_TOOL,
    description: LIST_DESCRIPTION,
    parameters: {
      instance: {
        type: 'string',
        description: 'Only the tabs one extension reported, named by the instance it polls under. Omitted, every reporting instance is listed.'
      }
    },
    output: {
      schema: {
        type: 'array',
        description: 'One row per capturable-or-not tab the extensions reported. Empty when nothing is connected, and the rendered text then says what to check.',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            instance: { type: 'string', required: true, description: 'Which extension reported it.' },
            tabId: { type: 'number', required: true, description: 'Unique inside its instance only; pass the pair to capture_page.' },
            url: { type: 'string', required: true },
            title: { type: 'string', required: true },
            focused: { type: 'boolean', required: true },
            capturable: { type: 'boolean', required: true, description: 'False for pages with no extractable DOM (chrome://, extension pages, the store, embedded PDFs).' },
            reason: { type: 'string', description: 'Why the tab cannot be captured. Present only when capturable is false.' },
            seenAt: { type: 'string', required: true, description: 'When this list was reported, ISO 8601.' },
            stale: { type: 'boolean', required: true, description: 'True when the report is older than 10 minutes: the tab may be closed by now.' }
          }
        }
      },
      render: (args, value) => [{ type: 'text', text: pagesText(value, args) }]
    },
    execute: async (args) => {
      const wanted = String(args.instance === undefined || args.instance === null ? '' : args.instance).trim()
      const rows = []
      for (const [instance, seen] of agentHub.instances) {
        if (wanted !== '' && instance !== wanted) continue
        const stale = Date.now() - seen.at > STALE_AFTER_MS
        for (const tab of seen.tabs) {
          rows.push({
            instance,
            tabId: tab.tabId,
            url: String(tab.url === undefined ? '' : tab.url),
            title: String(tab.title === undefined ? '' : tab.title),
            focused: tab.focused === true,
            capturable: tab.capturable !== false,
            ...tab.reason === undefined ? {} : { reason: String(tab.reason) },
            seenAt: new Date(seen.at).toISOString(),
            stale
          })
        }
      }
      return rows
    }
  }))

  ctx.tools.register(defineTool({
    name: CAPTURE_TOOL,
    description: CAPTURE_DESCRIPTION,
    // Longer than the wait this tool allows, so our own timeout message wins.
    timeoutMs: CAPTURE_MAX_TIMEOUT_MS + 5000,
    parameters: {
      instance: {
        type: 'string',
        required: true,
        description: 'The instance from the list_pages row.'
      },
      tabId: {
        type: 'number',
        required: true,
        description: 'The tabId from the same row. Both are required because a tab id is unique only inside one instance.'
      },
      includes: {
        type: 'string',
        description: 'Optional extraction hint handed to the extension verbatim (e.g. "css,fonts,images"); what it does with it is its own decision.'
      },
      max_bytes: {
        type: 'number',
        description: 'Optional ceiling in bytes the extension should keep the material under. Omitted, the extension decides.'
      },
      name: {
        type: 'string',
        description: 'Block name the material lands under: <DSH_HOME>/ui-captures/<name>/. Pass the block name you will use with create_ui_block so the two agree. Omitted, the directory is capture-<YYYYMMDD-HHmmss>.'
      },
      timeout_ms: {
        type: 'number',
        description: 'How long to wait for the extension, in milliseconds. Default 60000, 1000-110000. The extension polls every couple of seconds, so a longer wait only covers a slow page.'
      }
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          dir: { type: 'string', required: true, description: 'Absolute directory the material landed in (the sibling ui-captures workshop, not the block).' },
          files: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                path: { type: 'string', required: true, description: 'Relative path inside the capture directory.' },
                bytes: { type: 'number', required: true },
                from: { type: 'string', required: true, description: 'Absolute path on disk — pass it straight to create_ui_block as files[].from.' }
              }
            }
          },
          report: { type: 'json', required: true, description: 'report.json exactly as written: the extension report plus a "capture" section of our bookkeeping. Nothing is trimmed.' },
          summary: { type: 'string', required: true, description: 'One line for humans: file count, total bytes, how many resources the extension dropped.' }
        }
      },
      render: (args, value) => [{ type: 'text', text: captureText(value) }]
    },
    execute: async (args) => {
      const instance = String(args.instance === undefined || args.instance === null ? '' : args.instance).trim()
      if (instance === '') throw new Error(CAPTURE_TOOL + ': instance is required — take it from a ' + LIST_TOOL + ' row.')
      const tabId = Number(args.tabId)
      if (!Number.isFinite(tabId)) throw new Error(CAPTURE_TOOL + ': tabId must be the number ' + LIST_TOOL + ' returned, got ' + JSON.stringify(args.tabId))
      const wantedName = args.name === undefined || args.name === null ? '' : String(args.name).trim()
      if (wantedName !== '' && (!NAME_RE.test(wantedName) || wantedName.includes('..'))) {
        throw new Error(CAPTURE_TOOL + ': name must be 1-64 chars of [A-Za-z0-9._-], starting with a letter or digit, got ' + JSON.stringify(args.name))
      }
      const before = agentHub.instances.get(instance)
      const watched = before !== undefined && before.tabs.some((tab) => tab.tabId === tabId)
      const task = agentHub.enqueue({
        instance,
        tabId,
        ...wantedName === '' ? {} : { name: wantedName },
        ...args.includes === undefined ? {} : { includes: String(args.includes) },
        ...args.max_bytes === undefined ? {} : { maxBytes: Number(args.max_bytes) }
      })
      const asked = Number(args.timeout_ms)
      const timeoutMs = Number.isFinite(asked) && asked > 0
        ? Math.min(Math.max(Math.round(asked), CAPTURE_MIN_TIMEOUT_MS), CAPTURE_MAX_TIMEOUT_MS)
        : CAPTURE_DEFAULT_TIMEOUT_MS
      let done
      try {
        done = await awaitCapture(task, timeoutMs, watched)
      } catch (error) {
        agentHub.cancel(task.id)
        throw error
      }
      if (done === undefined) {
        // Compose BEFORE cancelling: the message is chosen from the queue state,
        // and cancelling first would make every timeout read "took the task".
        const reason = noResultText(task, timeoutMs)
        agentHub.cancel(task.id)
        throw new Error(reason)
      }
      const report = done.report
      const capture = report !== null && typeof report === 'object' && report.capture !== undefined ? report.capture : undefined
      if (capture !== undefined && capture.ok === false) {
        throw new Error(CAPTURE_TOOL + ': the extension itself reported a failure, its own words: ' + String(capture.error)
          + ' (' + String(done.files.length) + ' file(s) landed in ' + done.dir + ' anyway; the report there says why.)')
      }
      if (done.files.length === 0) {
        throw new Error(CAPTURE_TOOL + ': the extension answered but sent no files, so there is nothing to build a block from. Directory: ' + done.dir + '.')
      }
      return {
        dir: done.dir,
        files: done.files.map((file) => ({ path: file.path, bytes: file.bytes, from: join(done.dir, file.path) })),
        report,
        summary: captureSummary(done.files, report)
      }
    }
  }))

  ctx.inject(['webServer'], (webCtx) => {
    webCtx.webServer.register({
      kind: 'prefix',
      path: ROUTE_PATH,
      handler: async (req, res) => {
        try {
          const url = new URL(req.url ?? '/', 'http://127.0.0.1')
          const rest = url.pathname.slice(ROUTE_PATH.length + 1)
          // Three shapes share this prefix:
          //   <name>.uiblock   the plain text read (copy button, ?at=, ?pin=)
          //   <name>           the ENTRY as a document, for a sectioned block
          //   <name>/<path>    one virtual file section that entry links
          // Only the first predates sections, and it keeps its behaviour exactly.
          const asDocument = !rest.endsWith(EXT)
          const slash = rest.indexOf('/')
          const blockName = asDocument
            ? (slash < 0 ? rest : rest.slice(0, slash))
            : rest.slice(0, -EXT.length)
          const sectionPath = asDocument && slash >= 0 ? rest.slice(slash + 1) : null
          const target = blockName === '' || !NAME_RE.test(blockName) || blockName.includes('..')
            ? ''
            : join(blocksDir(), blockName + EXT)
          if (target === '' || !existsSync(target)) {
            sendText(res, 404, 'not found')
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
          const at = moment === null ? 'live' : String(moment)
          if (!asDocument) {
            res.writeHead(200, {
              'content-type': 'text/plain; charset=utf-8',
              'content-length': String(Buffer.byteLength(served)),
              'cache-control': 'no-store',
              'last-modified': info.mtime.toUTCString(),
              'x-uiblock-at': at
            })
            res.end(served)
            return
          }
          // From here the block is a DOCUMENT on this origin, which is the whole
          // point: <link href="./panel.css">, url(./x.woff2) and <img src="./y.svg">
          // resolve against the section URLs below instead of about:srcdoc.
          const wholeFile = Buffer.byteLength(served)
          if (wholeFile > BLOCK_MAX_BYTES) {
            sendText(res, 413, 'block ' + blockPath(blockName) + ' is ' + String(wholeFile) + ' bytes; the limit is ' + String(BLOCK_MAX_BYTES) + ' — keep binary sections small (an SVG text section costs almost nothing)')
            return
          }
          const sections = splitSections(served)
          // Both spellings serve the entry: /ui-blocks/<name> and, the one the
          // client navigates to, /ui-blocks/<name>/ — only the trailing slash makes
          // the entry's own ./logo.svg resolve to /ui-blocks/<name>/logo.svg.
          if (sectionPath === null || sectionPath === '') {
            const html = sections.entry
            res.writeHead(200, {
              'content-type': 'text/html; charset=utf-8',
              'content-length': String(Buffer.byteLength(html)),
              'cache-control': 'no-store',
              'x-uiblock-at': at,
              ...blockHeaders()
            })
            res.end(html)
            return
          }
          let type
          try {
            type = sectionType(sectionPath)
          } catch (error) {
            const status = httpStatus(error)
            sendText(res, status, status === 415
              ? 'unknown section type: ' + sectionPath + ' (allowed: ' + Object.keys(SECTION_TYPES).join(' ') + ')'
              : 'not found')
            return
          }
          const file = sections.files.find((entry) => entry.path === sectionPath)
          if (file === undefined) {
            sendText(res, 404, 'no section ' + sectionPath + ' in ' + blockPath(blockName))
            return
          }
          const bytes = file.base64 ? Buffer.from(file.body.trim(), 'base64') : Buffer.from(file.body, 'utf8')
          if (bytes.length > SECTION_MAX_BYTES) {
            sendText(res, 413, 'section ' + file.path + ' is ' + String(bytes.length) + ' bytes; the limit is ' + String(SECTION_MAX_BYTES) + ' — use an SVG text section or a smaller asset')
            return
          }
          res.writeHead(200, {
            'content-type': type,
            'content-length': String(bytes.length),
            'cache-control': 'no-store',
            'x-uiblock-at': at,
            ...blockHeaders()
          })
          res.end(bytes)
        } catch (error) {
          try { res.writeHead(500); res.end('read failed') } catch { /* client gone */ }
          if (ctx.logger !== undefined) ctx.logger.warn('dsh-ui-block: ' + ROUTE_PATH + ' route failed: ' + String(error))
        }
      }
    })
  })
  // Browser-extension surface: two routes, one read and one action.
  //
  // Neither takes a path argument. GET answers with the package's own
  // extension/ directory and the manifest version inside it; POST spawns
  // explorer.exe /select, on that SAME fixed directory. A request can therefore
  // never widen either route into "read an arbitrary path" or "open an
  // arbitrary path" — the only variable is which of the two actions runs.
  ctx.inject(['webServer'], (webCtx) => {
    webCtx.webServer.register({
      kind: 'prefix',
      path: EXTENSION_ROUTE,
      handler: async (req, res) => {
        const send = (status, body) => {
          const text = JSON.stringify(body)
          res.writeHead(status, {
            'content-type': 'application/json; charset=utf-8',
            'content-length': String(Buffer.byteLength(text)),
            'cache-control': 'no-store'
          })
          res.end(text)
        }
        try {
          const url = new URL(req.url ?? '/', 'http://127.0.0.1')
          const action = url.pathname.slice(EXTENSION_ROUTE.length).replace(/\/+$/, '')
          if (action === '' || action === '/info') {
            if (req.method !== 'GET' && req.method !== 'HEAD') {
              send(405, { ok: false, error: 'GET only' })
              return
            }
            const facts = await readExtensionManifest()
            // The capture extension is ADDITIVE: the four fields above keep
            // their exact meaning and order, and the second card reads these
            // two. A package without it answers captureExists:false and its
            // card says so instead of printing a path that is not there.
            let captureDir = extensionDir(EXTENSION_CAPTURE_DIR_NAME)
            let captureVersion = ''
            try {
              const capture = await readExtensionManifest(EXTENSION_CAPTURE_DIR_NAME)
              captureDir = capture.dir
              captureVersion = String(capture.manifest.version ?? '')
            } catch { /* not installed in this build: the card reports it */ }
            send(200, {
              ok: true,
              dir: facts.dir,
              version: String(facts.manifest.version ?? ''),
              name: String(facts.manifest.name ?? ''),
              manifestVersion: facts.manifest.manifest_version,
              captureDir,
              captureVersion,
              captureExists: existsSync(captureDir)
            })
            return
          }
          if (action === '/reveal') {
            if (req.method !== 'POST') {
              send(405, { ok: false, error: 'POST only' })
              return
            }
            // A custom header is the CSRF guard: a cross-site page can post a
            // plain form here, but it cannot add a header without a preflight
            // this server never answers. The card is same-origin, so it can.
            if (req.headers['x-dsh-ui-block-reveal'] !== '1') {
              send(403, { ok: false, error: 'missing reveal header' })
              return
            }
            // ?which= picks by NAME from a fixed pair, never by a path from the
            // caller: a request can still only open one of two directories that
            // this package owns.
            const which = url.searchParams.get('which') === EXTENSION_CAPTURE_DIR_NAME ? EXTENSION_CAPTURE_DIR_NAME : EXTENSION_DIR_NAME
            const dir = extensionDir(which)
            if (!existsSync(dir)) {
              send(404, { ok: false, error: which + ' directory missing' })
              return
            }
            // windowsVerbatimArguments keeps OUR quoting: explorer wants
            // /select,"<path>" (the comma must stay outside the quotes), which
            // Node's default escaping would rewrite into "\/select,<path>".
            const command = '/select,"' + dir + '"'
            const child = spawn('explorer.exe', [command], {
              detached: true,
              stdio: 'ignore',
              windowsVerbatimArguments: true
            })
            child.on('error', (error) => {
              if (ctx.logger !== undefined) ctx.logger.warn('dsh-ui-block: explorer reveal failed: ' + String(error))
            })
            // Revised here so a failing spawn still answers instead of hanging.
            const pid = child.pid
            child.unref()
            send(200, { ok: true, dir, pid: pid === undefined ? null : pid, command: 'explorer.exe ' + command })
            return
          }
          send(404, { ok: false, error: 'unknown extension action' })
        } catch (error) {
          try { send(500, { ok: false, error: String(error && error.message ? error.message : error) }) } catch { /* client gone */ }
          if (ctx.logger !== undefined) ctx.logger.warn('dsh-ui-block: ' + EXTENSION_ROUTE + ' route failed: ' + String(error))
        }
      }
    })
  })
  // Browser-extension hub: poll and result, one prefix, one contract.
  //
  // agent.enabled=false answers 404 on both paths, so OFF looks exactly like
  // "this plugin has no such surface"; the extension's own switch is what stops
  // it from sending anything at all. Everything here reads the live options,
  // so flipping a switch does not need a restart.
  ctx.inject(['webServer'], (webCtx) => {
    // Learned here so the empty-list advice can name this instance's own port
    // instead of telling the user to guess between 3080 and 4000.
    const listened = Number(webCtx.webServer.port)
    if (Number.isFinite(listened) && listened > 0) agentPort = listened
    webCtx.webServer.register({
      kind: 'prefix',
      path: AGENT_ROUTE,
      handler: async (req, res) => {
        const cors = corsHeaders(req)
        const send = (status, payload) => {
          const text = JSON.stringify(payload)
          res.writeHead(status, {
            'content-type': 'application/json; charset=utf-8',
            'content-length': String(Buffer.byteLength(text)),
            'cache-control': 'no-store',
            ...cors
          })
          res.end(text)
        }
        const url = new URL(req.url ?? '/', 'http://127.0.0.1')
        const options = agentHub.options
        const ip = String(req.socket === undefined || req.socket.remoteAddress === undefined ? '' : req.socket.remoteAddress)
        const origin = String(req.headers.origin === undefined ? '' : req.headers.origin)
        // Loose mode still leaves a trail: this ring plus one log line per request
        // is what makes "who read my tabs" answerable after the fact.
        const note = (kind, instance, token, outcome) => {
          agentHub.record({ at: Date.now(), kind, ip, origin, instance, token, outcome })
          if (ctx.logger === undefined || typeof ctx.logger.info !== 'function') return
          ctx.logger.info('dsh-ui-block: agent ' + kind + ' ip=' + ip + (origin === '' ? '' : ' origin=' + origin) +
            ' instance=' + (instance === '' ? '-' : instance) + ' token=' + token + ' ' + outcome)
        }
        if (options.enabled !== true) {
          note('off', '', 'off', '404 disabled')
          send(404, { ok: false, error: 'the agent endpoints are off (agent.enabled: false)' })
          return
        }
        if (req.method === 'OPTIONS') {
          res.writeHead(204, { 'cache-control': 'no-store', ...cors })
          res.end()
          return
        }
        const carried = requestToken(req, url)
        const tokenState = carried === '' ? 'none' : carried === options.token ? 'match' : 'bad'
        if (options.requireToken === true && (options.token === '' || carried !== options.token)) {
          note('guard', '', tokenState, '401 token required')
          send(401, { ok: false, error: 'a pairing token is required: ?token=..., x-uiblock-token, or Authorization: Bearer' })
          return
        }
        const action = url.pathname.slice(AGENT_ROUTE.length).replace(/\/+$/, '')
        try {
          if (action === '/poll') {
            if (req.method !== 'POST') {
              send(405, { task: null, error: 'POST only' })
              return
            }
            const posted = await readJsonBody(req, AGENT_BODY_MAX_BYTES)
            const instance = String(posted.instance === undefined ? '' : posted.instance).trim()
            if (instance === '') {
              note('poll', '', tokenState, '400 no instance')
              send(400, { task: null, error: 'instance is required' })
              return
            }
            const tabs = normalizeTabs(posted.tabs)
            agentHub.instances.set(instance, { tabs, at: Date.now(), origin })
            const task = agentHub.take(instance)
            note('poll', instance, tokenState, '200 tabs=' + String(tabs.length) + ' task=' + (task === undefined ? 'none' : task.id))
            send(200, {
              task: task === undefined ? null : {
                id: task.id,
                tabId: task.tabId,
                ...task.includes === undefined ? {} : { includes: task.includes },
                ...task.maxBytes === undefined ? {} : { maxBytes: task.maxBytes },
                // Optional and additive: the block name this capture will land
                // under. Resolved from the taskId as well, so an extension that
                // ignores this field still gets the name right.
                ...task.name === undefined ? {} : { name: task.name }
              }
            })
            return
          }
          if (action === '/result') {
            if (req.method !== 'POST') {
              send(405, { ok: false, error: 'POST only' })
              return
            }
            const posted = await readJsonBody(req, AGENT_BODY_MAX_BYTES)
            const taskId = String(posted.taskId === undefined ? '' : posted.taskId).trim()
            if (taskId === '') {
              note('result', '', tokenState, '400 no taskId')
              send(400, { ok: false, error: 'taskId is required' })
              return
            }
            const instance = String(posted.instance === undefined ? '' : posted.instance).trim()
            // An unknown taskId is accepted, not refused: a retry after a DSH
            // restart has to land somewhere, and the material is worth more than
            // the bookkeeping.
            const made = await writeCapture(posted, agentHub.issued.get(taskId))
            agentHub.complete(taskId, made)
            note('result', instance, tokenState, '200 files=' + String(made.files.length) + ' dir=' + made.dir)
            send(200, { ok: true, dir: made.dir })
            return
          }
          send(404, { ok: false, error: 'unknown agent action: ' + (action === '' ? AGENT_ROUTE : action) })
        } catch (error) {
          const status = httpStatus(error)
          note('agent', '', tokenState, String(status) + ' ' + String(error && error.message ? error.message : error))
          send(status, { ok: false, error: String(error && error.message ? error.message : error) })
        }
      }
    })
  })
}
/**
 * Test seam for self-check-agent.mjs: the queue, the instance table and the
 * live switches, so the endpoint contract can be asserted without HTTP.
 */
export const extensionHub = {
  hub: agentHub,
  capturesDir,
  captureRelativePath,
  applyAgentConfig
}
/**
 * Test seam for self-check-uiblock-directive.mjs: the pure diff/replay helpers
 * plus the recording entry, so the patch chain can be asserted against real
 * files in a throwaway DSH_HOME. Not used by the tools or the route.
 */
export const timeline = {
  assembleBlock,
  diffLines,
  listBlocks,
  splitSections,
  sectionType,
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

