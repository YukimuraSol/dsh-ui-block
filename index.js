/**
 * dsh-ui-block — host half.
 *
 * The canvas/zoom/picker half is client-side (client.js). This half owns the two
 * file-tools that turn a UI draft into a durable file, plus the route the client
 * reads that file back through:
 *
 *   create_ui_block(name, entry?, title?, files) -> <DSH_HOME>/ui-blocks/<name>.uiblock
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
import { existsSync, mkdirSync, readFileSync, realpathSync, watch, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { appendFile, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { createHash, randomBytes } from 'node:crypto'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join } from 'node:path'
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
// ---------------------------------------------------------------------------
// The instance registry ("登记台"): ONE fixed loopback address that answers
// "which DSH instances are alive right now?".
//
// Why it exists: a Chrome extension cannot listen on a port, so it needs a fixed
// place to ask. Why it is not a broker: the extension still POSTs its poll to
// every instance in this table and every instance still writes its own tasks —
// the registry only publishes addresses.
//
// Lifecycle, in the order it happens:
//   * every instance first GETs /health. An answer that identifies the registry
//     is REUSED: the instance registers and heartbeats every 10 seconds.
//   * only when nobody answers does an instance try to listen on the fixed port.
//     EADDRINUSE means "someone won the race", so it waits and asks again
//     instead of fighting for the port.
//   * a registration older than 45 seconds is dropped from the table.
//   * with no heartbeat from ANY instance for 20 seconds the registry closes
//     itself, so it never sits on the fixed port as an orphan. The next
//     instance to start (or to heartbeat) brings one back.
//   * a port held by something that is NOT the registry is reported once and
//     the instance continues without one — no retry loop.
// ---------------------------------------------------------------------------
const REGISTRY_PORT = 38520
const REGISTRY_HOST = '127.0.0.1'
/** What /health must answer for a listener to count as OUR registry. */
const REGISTRY_SERVICE = 'dsh-ui-block-registry'
const REGISTRY_HEARTBEAT_MS = 10 * 1000
const REGISTRY_EXPIRE_MS = 45 * 1000
const REGISTRY_IDLE_MS = 20 * 1000
/** /register carries four small fields; nothing else may arrive on that port. */
const REGISTRY_BODY_MAX_BYTES = 4096
/** A table this size is already wrong: a real machine runs one to three. */
const REGISTRY_MAX_INSTANCES = 16
const EXT = '.uiblock'
/** A section marker: a WHOLE line, `<!-- @@file <path> [base64] -->`. */
const SECTION_RE = /^<!--\s*@@file\s+(\S+?)(\s+base64)?\s*-->\s*$/
/**
 * The three write-path ceilings, as DEFAULTS. The plugin config overrides each
 * one under `limits:` (a sibling of `agent:`), and every read of `limits`
 * below happens at request time, so a config bump needs no restart.
 *
 * These are not render limits: the block route only sends the ENTRY out, and
 * every other section is fetched on its own URL. What a big block really costs
 * is edit weight — each rewrite reads the whole text, keeps one history
 * baseline and appends one patch line. The single-file one is the real grain,
 * because a binary section is stored as base64 text: 4/3 of its bytes.
 */
const LIMIT_DEFAULTS = {
  /**
   * One file's own bytes, measured on the decoded bytes. 8 MB, not 2: the campus
   * page ships two real web fonts (2.28 MB and 4.19 MB) and a 2 MB ceiling
   * silently dropped both — the stylesheet kept its @font-face, the block had no
   * file behind it, and the page fell back to a system face. blockBytes is
   * unchanged, so the block as a whole is still capped; this ceiling is per file.
   */
  sectionBytes: 8 * 1024 * 1024,
  /** The whole stored block text, section markers included. */
  blockBytes: 64 * 1024 * 1024,
  /** Not a ceiling: past this a block still writes, with one advisory line. */
  softWarnBytes: 16 * 1024 * 1024
}
/** The live limits every check reads; apply() overwrites the fields it is given. */
const limits = { ...LIMIT_DEFAULTS }
/** What a section may be, by extension; anything else is a 415, never a guess. */
const SECTION_TYPES = {
  // A page section: a sectioned block can carry whole pages the entry links to,
  // which is what a demo block needs (one served document per timeline snapshot).
  // The block CSP still ships with every one of them, so script-src stays 'none'.
  html: 'text/html; charset=utf-8',
  htm: 'text/html; charset=utf-8',
  css: 'text/css; charset=utf-8',
  svg: 'image/svg+xml',
  json: 'application/json; charset=utf-8',
  woff2: 'font/woff2',
  woff: 'font/woff',
  ttf: 'font/ttf',
  otf: 'font/otf',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif'
}
/** Extensions whose payload is BYTES, not text: those sections are stored base64. */
const BINARY_EXTENSIONS = new Set(['woff2', 'woff', 'ttf', 'otf', 'png', 'jpg', 'jpeg', 'webp', 'gif'])
/** The one policy served with the entry document and with every section. */
const BLOCK_CSP = "default-src 'none'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; script-src 'none'; form-action 'none'; base-uri 'none'"
/** Canvas geometry shared with client.js (asserted equal by self-check.mjs). */
const DEFAULT_RES = { w: 1440, h: 900 }
/**
 * The first screen. A shot taller than this is taken only when the caller asks
 * for the whole page: measured on a 6 MB sectioned block, a 1440x1400 full-page
 * read cost 18 s (43.6 s with a probe) against 10-14 s at first-screen height,
 * and nothing below the fold is any more readable in the picture. The default
 * height (900) is already under it, so only an explicit tall height changes.
 */
const FIRST_SCREEN_H = 1000
/**
 * The inline ceiling for a binary carried INSIDE a stylesheet or a document as a
 * data: URI: past this it is de-inlined into its own assets/ section.
 *
 * base64 costs 4/3, and for a big payload that buys nothing: a 4 MB font inlined
 * in CSS is 5.3 MB of block text, and it cannot be cached, range-served or
 * counted against sectionBytes. As its own section the same font costs the block
 * 5.3 MB of text and the browser one request it can skip. Small icons stay
 * inline — one request saved is worth 4/3 of 8 KB, not of 4 MB.
 */
const ASSET_INLINE_MAX_BYTES = 512 * 1024
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

/** One byte count as a human number: 2097152 -> "2.0 MB". */
function sizeText(bytes) {
  const n = Number(bytes)
  if (!Number.isFinite(n)) return String(bytes) + ' bytes'
  if (n < 1024) return String(n) + ' B'
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB'
  return (n / (1024 * 1024)).toFixed(1) + ' MB'
}

/**
 * One over-limit refusal, in the shape a caller can act on: what it weighed,
 * what the ceiling is, and HOW MUCH OVER it was — the difference is what says
 * whether "shrink it a bit" is enough. Then the three ways out, best first.
 * @param scope - 'per file' or 'per block', the limit that was hit.
 * @param subject - the file (or "the assembled block") that exceeded it.
 * @param size - its bytes.
 * @param max - the ceiling it exceeded.
 * @param key - the config field that controls it (limits.sectionBytes / limits.blockBytes).
 * @param exits - the three one-line ways out.
 */
function overLimitText(scope, subject, size, max, key, exits) {
  const over = Number(size) - Number(max)
  return CREATE_TOOL + ': ' + subject + ' is ' + String(size) + ' bytes; the limit is ' + String(max) + ' bytes (' + scope + ', '
    + sizeText(max) + ') — ' + String(over) + ' bytes over (' + sizeText(over) + ' too big).'
    + '\nThree ways out, best first:'
    + exits.map((exit, index) => '\n  ' + String(index + 1) + '. ' + exit).join('')
    + '\nIf the ceiling itself is wrong for this case, raise ' + key + ' in the plugin config (currently ' + String(max) + ' bytes).'
}

/**
 * Read the `limits:` block off the plugin config, keeping the defaults per
 * field: a missing block, a missing key and a non-positive or non-numeric value
 * all fall back to LIMIT_DEFAULTS. A value is bytes, unrounded.
 * @param config - the plugin config; `limits` is a sibling of `agent`.
 * @returns the live limits object every check reads.
 */
function applyLimitsConfig(config) {
  const raw = config !== null && typeof config === 'object' && config.limits !== null && typeof config.limits === 'object' ? config.limits : {}
  const read = (key) => {
    const value = Number(raw[key])
    return Number.isFinite(value) && value > 0 ? Math.round(value) : LIMIT_DEFAULTS[key]
  }
  limits.sectionBytes = read('sectionBytes')
  limits.blockBytes = read('blockBytes')
  limits.softWarnBytes = read('softWarnBytes')
  return limits
}

/** The advisory a block past limits.softWarnBytes carries: it still writes. */
function softWarnText(bytes) {
  if (!(bytes > limits.softWarnBytes)) return undefined
  return 'This block is ' + String(bytes) + ' bytes (' + sizeText(bytes) + '), past the ' + String(limits.softWarnBytes)
    + '-byte soft-warn line (' + sizeText(limits.softWarnBytes) + '). It is written and renders normally, but every later edit reads and rewrites the whole text'
    + ' and keeps one history baseline, so edits get slower and .history grows. Prefer fewer, leaner files — or raise limits.softWarnBytes if this is deliberate.'
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
    // Byte-identical: no rename, no write, no history line. A rebuild of the same
    // page is idempotent, so it leaves no .bak-* behind.
    if ((await readFile(target, 'utf8')) === html) return { target, backup: undefined, unchanged: true }
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

/** The lowercase extension of a path, without the dot. */
function extOf(path) {
  const text = String(path)
  const dot = text.lastIndexOf('.')
  return dot < 0 ? '' : text.slice(dot + 1).toLowerCase()
}

/** Section types whose body is TEXT we can parse for references to siblings. */
const REFERENCE_TEXT_EXTENSIONS = new Set(['html', 'htm', 'css', 'svg'])

/**
 * One reference a text file makes, as a block-relative path; undefined when it
 * is not a reference to a sibling file at all (a data: URL, a fragment, a
 * remote URL, a bare directory).
 *
 * Navigation is NOT a reference: <a href> and <form action> are allowed to
 * point anywhere, because a dead link renders nothing wrong. What this looks at
 * is what the document LOADS — <link href>, src= on an element that fetches,
 * and CSS url() / @import.
 */
function resolveRef(raw, ownPath) {
  const text = String(raw === undefined || raw === null ? '' : raw).trim()
  if (text === '') return undefined
  if (/^(?:data:|blob:|about:|#|mailto:|tel:|javascript:|https?:\/\/|\/\/)/i.test(text)) return undefined
  let url
  try {
    url = new URL(text, 'http://block.invalid/' + String(ownPath))
  } catch {
    return undefined
  }
  let path
  try {
    path = decodeURIComponent(url.pathname)
  } catch {
    path = url.pathname
  }
  path = path.replace(/^\/+/, '')
  // The block root itself ("./") and a directory link are not missing files.
  if (path === '' || path.endsWith('/')) return undefined
  return path
}

/**
 * The URLs one srcset / imagesrcset value names: comma-separated candidates,
 * each "URL [descriptor]". A descriptor never matters to us — the URL is what
 * a block has to carry — so the first whitespace-delimited token wins. A data:
 * URL containing a comma splits wrong here, and resolveRef rejects it anyway.
 */
function srcsetUrls(value) {
  return String(value).split(',').map((candidate) => candidate.trim().split(/\s+/)[0]).filter((url) => url !== '')
}

/** Every reference one text body makes: { line, ref, path, via? }, with a 1-based line. */
function collectRefs(body, ownPath) {
  const refs = []
  const lines = splitLines(body)
  for (let index = 0; index < lines.length; index += 1) {
    // Inline style is serialized with &quot; / &#39;: unescape, or the entity
    // becomes part of the path.
    const line = lines[index].replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')
    const push = (raw, via) => {
      const path = resolveRef(raw, ownPath)
      if (path !== undefined) refs.push({ line: index + 1, ref: String(raw).trim(), path, ...via === undefined ? {} : { via } })
    }
    for (const match of line.matchAll(/<link\b[^>]*?(?<![\w-])href\s*=\s*["']([^"']+)["']/gi)) push(match[1])
    for (const match of line.matchAll(/<(?:img|script|source|video|audio|iframe|embed|track)\b[^>]*?(?<![\w-])src\s*=\s*["']([^"']+)["']/gi)) push(match[1])
    // srcset / imagesrcset are LOADS: a 2x candidate is the image a retina
    // screen actually fetches, so leaving it out of the block breaks the page
    // it was captured from. Each candidate is its own reference.
    for (const match of line.matchAll(/(?<![\w-])(?:srcset|imagesrcset)\s*=\s*["']([^"']*)["']/gi)) {
      for (const candidate of srcsetUrls(match[1])) push(candidate, 'srcset')
    }
    for (const match of line.matchAll(/url\(\s*["']?([^"')]+?)["']?\s*\)/gi)) push(match[1])
    for (const match of line.matchAll(/@import\s+["']([^"']+)["']/gi)) push(match[1])
  }
  return refs
}

/**
 * Refuse a block whose own files point at files it does not have.
 *
 * This is the one failure that LOOKS like success: the block is written, the
 * entry renders, and one icon or font silently 404s. So it is an error here,
 * with the line, the missing member and the URL as written.
 *
 * "tolerated" is the account of files that exist on disk but were deliberately
 * left out (over the per-file ceiling, an extension no section type serves);
 * a reference to one of those is reported back, not refused — the caller
 * already has that ledger.
 * @param files - [{ path, body }] in block order, entry first.
 * @param tolerated - block-relative paths that are knowingly absent.
 * @returns the tolerated references, so the caller can report them.
 */
function assertRefsResolve(files, tolerated) {
  const present = new Set(files.map((file) => file.path))
  const allowed = tolerated === undefined || tolerated === null ? new Set() : new Set(tolerated)
  const missing = []
  const known = []
  for (const file of files) {
    if (!REFERENCE_TEXT_EXTENSIONS.has(extOf(file.path))) continue
    for (const ref of collectRefs(file.body, file.path)) {
      if (present.has(ref.path)) continue
      if (allowed.has(ref.path)) known.push({ where: file.path, ...ref })
      else missing.push({ where: file.path, ...ref })
    }
  }
  if (missing.length > 0) {
    const rows = missing.slice(0, 20).map((row) => '  ' + row.where + ':' + String(row.line) + '  ' + row.ref + ' -> ' + row.path)
    const more = missing.length > 20 ? '\n  ... and ' + String(missing.length - 20) + ' more' : ''
    throw new Error(CREATE_TOOL + ': ' + String(missing.length) + ' reference(s) point at files this block does not have — every loaded file must be one of its own members (or a data: URL):'
      + '\n' + rows.join('\n') + more
      + '\nAdd each missing file to files[] (or put it in the fromDir directory and let the entry link it), or fix the URL. Nothing was written.')
  }
  return known
}

/**
 * Walk one material directory into a map of relativePath -> { abs, bytes }.
 * Forward slashes only, so the keys ARE the block's virtual paths. Dot-prefixed
 * entries are skipped: a .git or a .DS_Store is never block material.
 */
async function walkMaterial(root, rel, out, depth) {
  if (depth > 8) return out
  let entries
  try {
    entries = await readdir(rel === '' ? root : join(root, rel), { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue
    const childRel = rel === '' ? entry.name : rel + '/' + entry.name
    if (entry.isDirectory()) {
      await walkMaterial(root, childRel, out, depth + 1)
      continue
    }
    if (!entry.isFile()) continue
    try {
      const info = await stat(join(root, childRel))
      out.set(childRel, { abs: join(root, childRel), bytes: info.size })
    } catch { /* vanished mid-walk: leave it out */ }
  }
  return out
}

/** data: mime -> the section extension that can serve it, for the binaries a block carries. */
const DATA_URI_EXTENSIONS = {
  'font/woff2': 'woff2',
  'application/font-woff2': 'woff2',
  'font/woff': 'woff',
  'application/font-woff': 'woff',
  'font/ttf': 'ttf',
  'application/x-font-ttf': 'ttf',
  'font/otf': 'otf',
  'application/x-font-opentype': 'otf',
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif'
}
/** One url(data:...) / src="data:..." / href="data:...", with the head and tail kept in the match. */
const DATA_URL_RE = /(url\(\s*)(['"]?)(data:[^)'"]*)\2(\s*\))/g
const DATA_ATTR_RE = /((?:src|href|poster)\s*=\s*)(['"])(data:[^'"]*)\2/g
/**
 * The path from one block-internal file to another. A stylesheet one level down
 * reaches its assets with ../assets/, the entry with ./assets/.
 */
function assetPathFrom(filePath, assetPath) {
  const slash = filePath.lastIndexOf('/')
  const depth = slash < 0 ? 0 : filePath.slice(0, slash).split('/').length
  return (depth === 0 ? './' : '../'.repeat(depth)) + assetPath
}

/**
 * Pull the big base64 binaries out of one text file into their own assets/
 * sections, and rewrite each reference to a path.
 *
 * Returns the rewritten text and the assets it created; a payload already seen
 * in this directory is reused, so one font inlined by two stylesheets becomes one
 * section. Anything at or under ASSET_INLINE_MAX_BYTES is left exactly as it was.
 * @param text - the file body.
 * @param filePath - its block-internal path, for the relative rewrite.
 * @param made - payload -> asset path, shared across the directory.
 * @param assets - output: [{ path, bytes, content, referencedBy }].
 */
function deinlineBinaries(text, filePath, made, assets) {
  if (!text.includes('data:')) return text
  const swap = (whole, head, quote, uri, tail) => {
    const comma = uri.indexOf(',')
    if (comma < 0 || !/;base64$/i.test(uri.slice(0, comma).replace(/\s+$/, ''))) return whole
    const ext = DATA_URI_EXTENSIONS[uri.slice(5, comma).split(';')[0].trim().toLowerCase()]
    if (ext === undefined) return whole
    const payload = uri.slice(comma + 1).replace(/\s+/g, '')
    const bytes = Buffer.from(payload, 'base64').length
    if (bytes <= ASSET_INLINE_MAX_BYTES) return whole
    let asset = made.get(payload)
    if (asset === undefined) {
      asset = 'assets/inline-' + createHash('sha1').update(payload).digest('hex').slice(0, 10) + '.' + ext
      made.set(payload, asset)
      assets.push({ path: asset, bytes, content: payload, referencedBy: filePath })
    }
    return head + quote + assetPathFrom(filePath, asset) + quote + (tail === undefined ? '' : tail)
  }
  return text.replace(DATA_URL_RE, swap).replace(DATA_ATTR_RE, swap)
}
/**
 * The reasons a file was left out ON PURPOSE. Everything else (a reference nobody
 * could resolve, an unknown type) is a real gap and says so without the note below.
 */
const BUDGET_REASONS = new Set(['over limit'])
/**
 * One sentence, said once, at the end of the list.
 *
 * A model reading "over the per-file limit" treats it as a to-do list: measured
 * once, it fetched 84 files by hand, rewrote the CSS and rebuilt the directory.
 * The ceiling is a product decision, so the text says so plainly and does not
 * repeat it on every line.
 */
const DEGRADED_TEXT = 'NOTE ON THE CEILINGS: every file above that was left out for a size / budget reason is a DELIBERATE degradation, not a defect — do not fetch, inline or copy those files by hand to "fix" it. The block renders without them: what is missing shows as a placeholder or falls back to the default.'
/**
 * Names whose content the HTML parser does NOT build elements from: everything
 * up to the matching close tag comes back as text (RCDATA / raw text).
 */
const RAW_TEXT_TAGS = new Set(['title', 'textarea', 'style', 'script', 'xmp', 'plaintext'])
/**
 * The index just past the `>` that closes an open tag, quote-aware: a `>` inside
 * an attribute value is not the end of the tag.
 */
function openTagEnd(text, start) {
  let quote = ''
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i]
    if (quote !== '') {
      if (ch === quote) quote = ''
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      continue
    }
    if (ch === '>') return i + 1
  }
  return -1
}
/**
 * Where the BODY content of this document lies. A real <title> sits in <head> and
 * must never be touched, so only the body is a candidate region. A fragment with
 * no <body> is body unless it carries a <head>.
 */
function bodyRegion(text) {
  const bodyOpen = /<body\b/i.exec(text)
  if (bodyOpen !== null) {
    const start = openTagEnd(text, bodyOpen.index)
    if (start < 0) return undefined
    const bodyClose = /<\/body\s*>/i.exec(text.slice(start))
    return { start, end: bodyClose === null ? text.length : start + bodyClose.index }
  }
  if (/<head\b/i.test(text) === false) return { start: 0, end: text.length }
  const headClose = /<\/head\s*>/i.exec(text)
  if (headClose === null) return undefined
  return { start: headClose.index + headClose[0].length, end: text.length }
}
/**
 * A raw-text tag used as a CONTAINER in the body is rewritten to <div>, every
 * attribute kept. Nothing on disk is touched: this runs on the text the build
 * hands to assembleBlock.
 *
 * Why: a DOM built with createElement (Vue, React, anything imperative) treats
 * <title> as an ordinary element with children, so serializing it is fine — but
 * parse that HTML again and <title> is RCDATA, so a card whose header is a
 * <title> renders its own markup as source text AND swallows the siblings it
 * wrapped. The material is not wrong, the reparse is; the fix belongs at build
 * time so the capture stays the truth.
 *
 * Deliberately conservative — two conditions, both required:
 *   1. inside the body (a <head> title is a real page title: no children, leave it);
 *   2. the content holds a CLOSING tag, which is the proof it was serialized with
 *      element children. That also keeps a real <style> or <script> body out of
 *      this rewrite: CSS `a > b` and JS `x < y` have no closing tag.
 *
 * @returns { text, fixed } — `fixed` is [{ from, to }] of the ORIGINAL and the
 *   rewritten opening tag, so the build can report exactly what it changed.
 */
function rewriteRawTextContainers(text) {
  const region = bodyRegion(text)
  if (region === undefined) return { text, fixed: [] }
  const swaps = []
  const fixed = []
  const open = /<([A-Za-z][A-Za-z0-9:_-]*)/g
  open.lastIndex = region.start
  let match
  while ((match = open.exec(text)) !== null && match.index < region.end) {
    const tagEnd = openTagEnd(text, match.index)
    if (tagEnd < 0 || tagEnd > region.end) break
    open.lastIndex = tagEnd
    const name = match[1].toLowerCase()
    if (!RAW_TEXT_TAGS.has(name)) continue
    const close = new RegExp('</' + name + '\\s*>', 'i').exec(text.slice(tagEnd, region.end))
    const contentEnd = close === null ? region.end : tagEnd + close.index
    if (/<\/[A-Za-z][A-Za-z0-9:_-]*\s*>/.test(text.slice(tagEnd, contentEnd)) === false) continue
    const from = text.slice(match.index, tagEnd)
    const to = '<div' + from.slice(1 + match[1].length)
    swaps.push({ start: match.index, end: match.index + 1 + match[1].length, text: '<div' })
    if (close !== null) {
      const closeStart = tagEnd + close.index
      swaps.push({ start: closeStart, end: closeStart + 2 + match[1].length, text: '</div' })
    }
    fixed.push({ from, to })
  }
  if (swaps.length === 0) return { text, fixed: [] }
  swaps.sort((a, b) => a.start - b.start)
  let out = ''
  let cursor = 0
  for (const swap of swaps) {
    if (swap.start < cursor) continue
    out += text.slice(cursor, swap.start) + swap.text
    cursor = swap.end
  }
  return { text: out + text.slice(cursor), fixed }
}
/**
 * Turn one material directory into an assembly argument list, doing the picking
 * a caller should not have to do by hand.
 *
 * Four decisions, each accounted for:
 *   1. the entry is entry.html, else index.html, else the call fails and names
 *      the candidates — guessing an entry renders the wrong page;
 *   2. a file nobody loads is left out: the block carries what the page loads;
 *   3. a file past limits.sectionBytes is left out (it cannot be a section);
 *   4. an extension no section type serves is left out (no 415 at read time).
 * Every left-out file lands in "skipped" with its bytes and reason, and a
 * reference to one of them is reported back rather than refused.
 *
 * @param dir - absolute path of the material directory.
 * @param entryHint - optional entry file name at the root.
 * @returns the files argument, the entry path, and the ledger.
 */
async function collectFromDir(dir, entryHint) {
  const root = String(dir === undefined || dir === null ? '' : dir).trim()
  if (root === '') throw new Error(CREATE_TOOL + ': fromDir must be an absolute directory path')
  if (!isAbsolute(root)) throw new Error(CREATE_TOOL + ': fromDir must be an absolute path, got ' + JSON.stringify(dir))
  if (!existsSync(root)) throw new Error(CREATE_TOOL + ': fromDir does not exist: ' + root)
  const rootInfo = await stat(root)
  if (!rootInfo.isDirectory()) throw new Error(CREATE_TOOL + ': fromDir is not a directory: ' + root)
  const found = await walkMaterial(root, '', new Map(), 0)
  if (found.size === 0) throw new Error(CREATE_TOOL + ': fromDir holds no files (dot-prefixed entries are ignored): ' + root)
  const rootHtml = [...found.keys()].filter((path) => !path.includes('/') && /\.html?$/i.test(path))
  const wanted = entryHint === undefined || entryHint === null || String(entryHint).trim() === '' ? undefined : String(entryHint).trim()
  const entryPath = wanted !== undefined
    ? wanted
    : (found.has('entry.html') ? 'entry.html' : (found.has('index.html') ? 'index.html' : undefined))
  if (entryPath === undefined) {
    throw new Error(CREATE_TOOL + ': fromDir has no entry: expected entry.html or index.html at the top of ' + root
      + (rootHtml.length === 0 ? ' — and there is no .html file at the root at all, so name one with "entry".' : ' — candidates: ' + rootHtml.join(', ') + '. Name one with "entry".'))
  }
  if (!found.has(entryPath)) throw new Error(CREATE_TOOL + ': entry ' + JSON.stringify(entryPath) + ' is not a file in fromDir ' + root)
  // Reachability: only what the page actually loads. Text is read as text, with
  // a ceiling, so a giant file in the folder is not slurped for nothing.
  const reachable = new Set([entryPath])
  const queue = [entryPath]
  const bodies = new Map()
  // path -> { direct, srcset }: HOW the page names each file. Kept apart because
  // a file named only by srcset is loaded by a retina screen, not optional.
  const referencedBy = new Map()
  while (queue.length > 0) {
    const current = queue.shift()
    if (!REFERENCE_TEXT_EXTENSIONS.has(extOf(current))) continue
    if (!bodies.has(current)) {
      const info = found.get(current)
      try {
        bodies.set(current, info.bytes > limits.softWarnBytes ? '' : await readFile(info.abs, 'utf8'))
      } catch {
        bodies.set(current, '')
      }
    }
    for (const ref of collectRefs(bodies.get(current), current)) {
      const known = found.get(ref.path)
      if (known === undefined) continue
      const how = referencedBy.get(ref.path) ?? { direct: false, srcset: false }
      if (ref.via === 'srcset') how.srcset = true
      else how.direct = true
      referencedBy.set(ref.path, how)
      if (reachable.has(ref.path)) continue
      reachable.add(ref.path)
      queue.push(ref.path)
    }
  }
  const accepted = []
  const skipped = []
  /** Files the entry loads ONLY through srcset: "not unreferenced" must be visible. */
  const srcsetReferenced = []
  for (const [path, info] of found) {
    if (path === entryPath) continue
    const how = referencedBy.get(path)
    const srcsetOnly = how !== undefined && how.srcset && !how.direct
    if (srcsetOnly) srcsetReferenced.push(path)
    if (SECTION_TYPES[extOf(path)] === undefined) {
      skipped.push({ path, bytes: info.bytes, reason: 'unknown type', detail: 'no section type for ".' + extOf(path) + '"', ...srcsetOnly ? { via: 'srcset' } : {} })
      continue
    }
    if (info.bytes > limits.sectionBytes) {
      skipped.push({ path, bytes: info.bytes, reason: 'over limit', detail: String(info.bytes - limits.sectionBytes) + ' bytes over the per-file limit ' + String(limits.sectionBytes), ...srcsetOnly ? { via: 'srcset' } : {} })
      continue
    }
    if (!reachable.has(path)) {
      skipped.push({ path, bytes: info.bytes, reason: 'unreferenced', detail: 'nothing the entry loads points at it' })
      continue
    }
    accepted.push({ path, from: info.abs, bytes: info.bytes })
  }
  // De-inline: a data: URI past ASSET_INLINE_MAX_BYTES becomes an assets/ section
  // of its own, so the same bytes are not carried twice at 4/3 (see the constant).
  const deinlined = []
  const made = new Map()
  for (const file of accepted) {
    if (!REFERENCE_TEXT_EXTENSIONS.has(extOf(file.path))) continue
    if (file.bytes > limits.softWarnBytes) continue
    let text
    try {
      text = await readFile(file.from, 'utf8')
    } catch {
      continue
    }
    if (!text.includes('data:')) continue
    const next = deinlineBinaries(text, file.path, made, deinlined)
    if (next === text) continue
    file.content = next
    file.from = undefined
  }
  const carried = [...accepted, ...deinlined]
  accepted.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  srcsetReferenced.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
  // Tag hygiene, ENTRY ONLY, build time (see rewriteRawTextContainers): a capture
  // serializes a DOM whose <title>/<textarea> were ordinary containers, and
  // parsing that HTML back turns their children into text. The directory is read,
  // never written — the block is built from a rewritten copy of the entry text, so
  // the material stays byte-identical and a rebuild repeats the same fix.
  const entryInfo = found.get(entryPath)
  const entryText = bodies.get(entryPath)
  const hygiene = typeof entryText === 'string' && entryText !== ''
    ? rewriteRawTextContainers(entryText)
    : { text: entryText, fixed: [] }
  const rewritten = hygiene.fixed.length > 0
  return {
    root,
    entryPath,
    files: [rewritten
      ? { path: entryPath, content: hygiene.text }
      : { path: entryPath, from: entryInfo.abs }].concat(carried.map((file) => (file.content === undefined
      ? { path: file.path, from: file.from }
      : { path: file.path, content: file.content }))) ,
    loaded: [rewritten
      ? { path: entryPath, bytes: Buffer.byteLength(hygiene.text, 'utf8'), from: entryInfo.abs, rewrittenRawTextTags: hygiene.fixed.length }
      : { path: entryPath, bytes: entryInfo.bytes, from: entryInfo.abs }].concat(carried.map((file) => (file.content === undefined
      ? { path: file.path, bytes: file.bytes, from: file.from }
      : { path: file.path, bytes: file.bytes, deinlinedFrom: file.referencedBy }))) ,
    skipped,
    srcsetReferenced,
    hygiene: hygiene.fixed,
    tolerated: skipped.map((item) => item.path)
  }
}

/**
 * Assemble the virtual folder the tool receives into the one block body the
 * route already serves: the ENTRY text, then one `<!-- @@file <path> -->`
 * marker + body per remaining file, in argument order.
 *
 * Every check happens here, before anything touches the disk: a bad path, a
 * broken content/from pair, a body that would forge a section marker, a file
 * past limits.sectionBytes, a block past limits.blockBytes, and a reference to
 * a file the block does not carry all throw with the offending file named. The
 * route's 404/413 answers stay the last resort; this is the first.
 *
 * @param files - [{ path, content } | { path, from }], at least one.
 * @param entryPath - which file renders; must be in files and at the root.
 * @param options - { toleratedMissing: string[] }: files the caller knowingly
 *   left out (fromDir's ledger), so a reference to one is reported by the
 *   caller instead of refused here.
 * @returns the body to store, the chosen entry path, the per-file facts the
 *   tool result reports, the references that only resolve to a tolerated file,
 *   and one advisory line when the block is past the soft-warn size.
 */
async function assembleBlock(files, entryPath, options) {
  const tolerated = options !== undefined && options !== null && Array.isArray(options.toleratedMissing) ? options.toleratedMissing : []
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
      if (info.size > limits.sectionBytes) {
        throw new Error(overLimitText('per file', 'file ' + path + ' (' + from + ')', info.size, limits.sectionBytes, 'limits.sectionBytes', [
          'leave it out of the block: with fromDir it stays in the material directory and is listed in skipped[], and the page still renders',
          'shrink it: an image to webp, a font to woff2 and only the weight the page uses',
          'split it: a CSS file that big is usually two stylesheets, a JSON that big is usually data the entry does not need'
        ]))
      }
      const raw = await readFile(from)
      bytes = raw.length
      body = binary ? raw.toString('base64') : raw.toString('utf8')
    }
    if (bytes > limits.sectionBytes) {
      throw new Error(overLimitText('per file', 'file ' + path, bytes, limits.sectionBytes, 'limits.sectionBytes', [
        'pass the file with "from" instead of "content", or leave it out of the block entirely',
        'shrink it: an image to webp, a font to woff2 and only the weight the page uses',
        'split it: a CSS file that big is usually two stylesheets, a JSON that big is usually data the entry does not need'
      ]))
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
  if (total > limits.blockBytes) {
    throw new Error(overLimitText('per block', 'the assembled block', total, limits.blockBytes, 'limits.blockBytes', [
      'load fewer files: fromDir keeps the block to what the entry loads, so a leftover copy of the page (a _build/ or a report.json) is not the problem — check what IS loaded',
      'shrink the big sections: base64 costs 4/3, so a 3 MB font is 4 MB of block text; woff2 of the used subset is usually under 100 KB',
      'drop the heavy originals from the directory: with fromDir an over-limit file is skipped and listed, and the page still renders without it'
    ]))
  }
  const toleratedRefs = assertRefsResolve(
    [{ path: entry.path, body: entry.body }, ...rest.map((item) => ({ path: item.path, body: item.body }))],
    tolerated
  )
  return {
    text,
    entry: entry.path,
    files: items.map((item) => ({
      path: item.path,
      bytes: item.bytes,
      ...item.from === undefined ? {} : { from: item.from }
    })),
    toleratedRefs,
    warning: softWarnText(total)
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
/**
 * The most patch text one block's log may hold. Past it the log is folded into a
 * fresh baseline (rotation), so no log is ever unbounded — the defect this
 * replaces left ONE block's log at 513 MB / 543 MB for the whole .history.
 * 8 MB is ~130x an ordinary 60 KB page, so hundreds of edits fit, and it still
 * holds one full body of the biggest block the 64 MB limit allows, so no single
 * write can force a rotation loop.
 */
const HISTORY_LOG_MAX_BYTES = 8 * 1024 * 1024
/**
 * The most history one block may cost in total — baseline + log. The baseline IS
 * a copy of the block, so this mirrors limits.blockBytes: history may cost one
 * more copy of the largest legal block, never a library of them. A block whose
 * baseline leaves no room keeps no history at all, which is correct: the block
 * file, not the history, is the truth.
 */
const HISTORY_BLOCK_MAX_BYTES = 64 * 1024 * 1024
/** How many changes one log keeps before the oldest are folded into the baseline. */
const HISTORY_KEEP_ENTRIES = 100
/**
 * The most line comparisons one Myers diff may cost before the change is folded
 * into the baseline instead. Memory is O(distance x lines) — one snapshot per
 * edit distance — so a whole-body rewrite of a 6 MB block (20k lines, 20k lines
 * of distance) asked for gigabytes and OOM'd the host. 5e7 keeps a normal page's
 * hundreds of edits free and refuses only the degenerate case, which keeps the
 * newest version as a baseline (the block file is the truth either way).
 */
const HISTORY_DIFF_WORK_MAX = 5e7

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
    // A log past the cap is either a leftover from before the cap existed or a
    // torn write: its newer entries were diffed against a baseline that has been
    // rotated away, so replaying them onto today's baseline would rewrite the
    // block into garbage. Treat it as empty (recordNow folds it into a fresh
    // baseline on the next write) instead of reading 500 MB to find that out.
    const raw = info.size <= HISTORY_LOG_MAX_BYTES ? await readFile(logPath, 'utf8') : ''
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

/** Position-wise line differences — a cheap lower bound on the diff distance. */
function positionalChanges(left, right) {
  let count = Math.abs(left.length - right.length)
  const shared = Math.min(left.length, right.length)
  for (let index = 0; index < shared; index += 1) if (left[index] !== right[index]) count += 1
  return count
}

/**
 * Record one observed body. The baseline is stored ONCE; every later change
 * appends one patch line, and both files are capped (see HISTORY_* above).
 *
 * Two callers and no third: writeBlock (this tool wrote the block) and the
 * ui-blocks WATCHER (something else did). A READ is not a change — a GET, a
 * preview, read_ui_block's own render must leave history exactly as it was.
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

/**
 * The change log follows the FILE, not the reader.
 *
 * writeBlock covers this tool's own writes; fs.watch covers every other way a
 * block's bytes can change (the write/edit tools, a shell command, a copy), so a
 * block's history stays the story of what actually changed on disk while a read
 * writes nothing. One save can raise several events, so each block is recorded
 * once, after the writes settle; recordNow compares bodies and appends nothing
 * when they match.
 */
let watcher = null
let watcherTail = Promise.resolve()
function watchBlocksDir(ctx) {
  if (watcher !== null) return
  const dir = blocksDir()
  try {
    mkdirSync(dir, { recursive: true })
  } catch {
    return
  }
  try {
    watcher = watch(dir, { persistent: false }, (_event, filename) => {
      // Windows keeps firing events for a directory that is gone (a test that
      // removes its temp home does exactly that), and each one would start a
      // record. Stop the watcher instead of spinning on nothing.
      if (!existsSync(dir)) {
        closeWatcher()
        return
      }
      if (filename === null || filename === undefined) return
      const name = String(filename)
      if (!name.endsWith(EXT)) return
      const blockName = name.slice(0, -EXT.length)
      if (!NAME_RE.test(blockName)) return
      queueRecord(ctx, blockName)
    })
    // A lost watcher must not take the host down with it: history is bookkeeping.
    watcher.on('error', () => {
      closeWatcher()
    })
  } catch {
    closeWatcher()
  }
}
function closeWatcher() {
  const handle = watcher
  watcher = null
  if (handle !== null) {
    try {
      handle.close()
    } catch {
      // already closed: nothing to do
    }
  }
}
function queueRecord(ctx, blockName) {
  const step = async () => {
    await new Promise((settle) => setTimeout(settle, 150))
    const target = join(blocksDir(), blockName + EXT)
    if (!existsSync(target)) return
    const body = await readFile(target, 'utf8')
    await recordChange(blockName, body)
  }
  watcherTail = watcherTail.then(step, step).then(() => undefined, (error) => {
    if (ctx !== undefined && ctx.logger !== undefined) ctx.logger.warn('dsh-ui-block: change log failed for ' + blockName + ': ' + String(error))
  })
}

async function recordNow(blockName, text) {
  const dir = historyDir(blockName)
  const basePath = join(dir, BASE_FILE)
  const logPath = join(dir, LOG_FILE)
  const bytes = Buffer.byteLength(text, 'utf8')
  if (!existsSync(basePath)) {
    if (bytes > HISTORY_BLOCK_MAX_BYTES) return { recorded: false, kind: 'too-big' }
    await mkdir(dir, { recursive: true })
    await writeFile(basePath, text, 'utf8')
    await writeFile(logPath, '', 'utf8')
    return { recorded: true, kind: 'base' }
  }
  const baseBytes = (await stat(basePath)).size
  // What the log may still grow by: the per-log cap, minus what THIS block's
  // baseline costs, so one directory can never pass the per-block cap.
  const logCap = Math.min(HISTORY_LOG_MAX_BYTES, HISTORY_BLOCK_MAX_BYTES - baseBytes)
  const logBytes = existsSync(logPath) ? (await stat(logPath)).size : 0
  if (logBytes > HISTORY_LOG_MAX_BYTES || logBytes > logCap) {
    // Unreplayable log (leftover or torn): the body in hand is the truth, so it
    // becomes the new baseline. Only history is lost.
    await writeFile(basePath, text, 'utf8')
    await writeFile(logPath, '', 'utf8')
    headCache.delete(blockName)
    return { recorded: true, kind: 'rebase' }
  }
  const history = await readHistory(blockName)
  if (history === null) return { recorded: false, kind: 'none' }
  const head = headOf(blockName, history)
  if (head === text) return { recorded: false, kind: 'same' }
  if (logCap <= 0) return { recorded: false, kind: 'too-big' }
  const headLines = splitLines(head)
  const textLines = splitLines(text)
  // Refuse the diff nobody can afford, BEFORE allocating it (see the constant).
  if (positionalChanges(headLines, textLines) * (headLines.length + textLines.length) > HISTORY_DIFF_WORK_MAX) {
    await writeFile(basePath, text, 'utf8')
    await writeFile(logPath, '', 'utf8')
    headCache.delete(blockName)
    return { recorded: true, kind: 'rebase' }
  }
  const entry = { at: Date.now(), patch: diffLines(headLines, textLines) }
  const line = JSON.stringify(entry) + '\n'
  const entryBytes = Buffer.byteLength(line, 'utf8')
  // Every bounded path lands here: a rotation makes the head the new baseline and
  // restarts the log at this one entry, so the append below is always in budget.
  if (entryBytes > logCap || logBytes + entryBytes > logCap || history.entries.length >= HISTORY_KEEP_ENTRIES) {
    await writeFile(basePath, head, 'utf8')
    await writeFile(logPath, entryBytes > logCap ? '' : line, 'utf8')
    headCache.delete(blockName)
    return { recorded: true, kind: entryBytes > logCap ? 'rebase' : 'rotate', bytes: entryBytes }
  }
  await appendFile(logPath, line, 'utf8')
  return { recorded: true, kind: 'patch', bytes: entryBytes }
}

/**
 * One-shot repair for a history written before the caps existed: every log past
 * HISTORY_LOG_MAX_BYTES (or a directory past HISTORY_BLOCK_MAX_BYTES) is dropped
 * and its block's on-disk body becomes the new baseline.
 *
 * It touches .history/ ONLY: no .uiblock is written, moved or removed, and
 * ui-captures/ is not looked at. The newest version is never lost — the block
 * file on disk IS the newest version, and it is what the new baseline copies.
 * What goes is history older than the cap, which is unreadable anyway: those
 * entries were diffed against a baseline the old cap had already abandoned.
 * @returns total bytes under .history before and after, plus what each block got.
 */
async function trimHistory() {
  const root = join(blocksDir(), HISTORY_DIR)
  const sizeOf = async (path) => (existsSync(path) ? (await stat(path)).size : 0)
  const dirsUnder = async () => {
    if (!existsSync(root)) return []
    return (await readdir(root, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name)
  }
  const total = async () => {
    let sum = 0
    for (const name of await dirsUnder()) {
      sum += await sizeOf(join(root, name, BASE_FILE))
      sum += await sizeOf(join(root, name, LOG_FILE))
    }
    return sum
  }
  const before = await total()
  const blocks = []
  for (const name of await dirsUnder()) {
    const basePath = join(root, name, BASE_FILE)
    const logPath = join(root, name, LOG_FILE)
    const baseBytes = await sizeOf(basePath)
    const logBytes = await sizeOf(logPath)
    if (logBytes <= HISTORY_LOG_MAX_BYTES && baseBytes + logBytes <= HISTORY_BLOCK_MAX_BYTES) continue
    // The file next to the history is the truth; with none, the baseline stays
    // and only the unreplayable log goes.
    const live = join(blocksDir(), name + EXT)
    const body = existsSync(live) ? await readFile(live, 'utf8') : null
    if (body !== null && Buffer.byteLength(body, 'utf8') <= HISTORY_BLOCK_MAX_BYTES) await writeFile(basePath, body, 'utf8')
    await writeFile(logPath, '', 'utf8')
    headCache.delete(name)
    blocks.push({
      name,
      baseBytes,
      logBytes,
      action: body === null ? 'log dropped, baseline kept' : 'rebased on the block on disk'
    })
  }
  return { before, after: await total(), blocks }
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
function probeScript(selectors, firstScreen) {
  // firstScreen === undefined measures the whole document; a number restricts
  // both the reported box and the match count to that many pixels from the top,
  // because past it nothing was rendered into the image being checked.
  const limit = firstScreen === undefined ? 'null' : String(Math.round(firstScreen))
  return '(function(){var out=[],limit=' + limit + ',sels=' + JSON.stringify(selectors.map((one) => String(one))) + ';'
    + 'for(var i=0;i<sels.length;i++){var s=sels[i],list;'
    + 'try{list=document.querySelectorAll(s)}catch(error){out.push([s,-1,0,0,0,0,0]);continue}'
    + 'if(list.length===0){out.push([s,0,0,0,0,0,0]);continue}'
    + 'var pick=null,inView=0;'
    + 'for(var j=0;j<list.length;j++){var box=list[j].getBoundingClientRect(),top=box.top+window.scrollY;'
    + 'if(limit===null||(top+box.height>0&&top<limit)){inView+=1;if(pick===null)pick=list[j]}}'
    + 'if(pick===null){out.push([s,list.length,0,0,0,0,0]);continue}'
    + 'var r=pick.getBoundingClientRect();'
    + 'out.push([s,list.length,Math.round(r.left+window.scrollX),Math.round(r.top+window.scrollY),Math.round(r.width),Math.round(r.height),inView])}'
    + 'return JSON.stringify(out)})()'
}

/** One compact line per probed selector: how many matched, then the first box. */
function formatProbe(rows) {
  return rows.map((row) => {
    const selector = String(row[0])
    const count = Number(row[1])
    if (count < 0) return selector + ': invalid selector'
    if (count === 0) return selector + ': no match'
    const inView = Number(row[6])
    const head = selector + ': ' + (count === 1 ? '1 match' : String(count) + ' matches')
    if (inView === 0) return head + ', none in the first screen — pass fullPage: true to measure the whole page'
    return head + (inView === count ? '' : ' (' + String(inView) + ' in the first screen)')
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
 * @param options.firstScreen - pixel height of the screen that was rendered; when
 *   given, probe measures inside it only. Undefined measures the whole document.
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
        ? formatProbe(JSON.parse(await evaluate(probeScript(options.probe, options.firstScreen))))
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

/**
 * Canvas geometry for one read: the first screen unless the whole page was asked
 * for. A function of its own so the clamp is asserted without a browser.
 * @param args - the tool arguments (width / height / fullPage).
 * @returns { res, note } — the geometry used, and why it is not what was asked.
 */
function readCanvas(args) {
  const w = args.width === undefined ? DEFAULT_RES.w : Math.round(Number(args.width))
  const h = args.height === undefined ? DEFAULT_RES.h : Math.round(Number(args.height))
  if (!(w > 0) || !(h > 0)) throw new Error(READ_TOOL + ': width and height must be positive pixel counts, got ' + JSON.stringify({ width: args.width, height: args.height }))
  if (args.fullPage === true || h <= FIRST_SCREEN_H) return { res: { w, h }, note: undefined }
  return {
    res: { w, h: FIRST_SCREEN_H },
    note: 'rendered the FIRST SCREEN (' + String(w) + 'x' + String(FIRST_SCREEN_H) + ') instead of the ' + String(h) + ' px height you asked for; pass fullPage: true to render and probe the whole page'
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

/** Where blocks actually live on this machine: <DSH_HOME>\ui-blocks, never ~/.dsh when DSH_HOME is set. */
const BLOCKS_DIR_ABS = blocksDir()

const CREATE_DESCRIPTION = [
  'Create one UI block: a small virtual folder at ' + join(BLOCKS_DIR_ABS, '<name>.uiblock') + ' — that is <DSH_HOME>\\ui-blocks, NOT ~/.dsh. One file is the ENTRY that renders; the rest are assets and extra pages it links. Use it whenever the user asks for a page, panel, dialog, card, widget or any other visual object — something to look at rather than read about.',
  '',
  'NO SCRIPTING: a block is pure data. Every document it serves ships under CSP `script-src \'none\'`, so a <script>, an on* handler or a javascript: URL in it never runs, and nothing remote arrives either — a CDN stylesheet or a remote image stays empty. Everything the block shows comes from its own files; anything that moves (a state switch, a canned demo) is produced from outside the block, by the message or by the timeline in DEMO below.',
  '',
  'WORK FROM THE REAL SOURCE. When the block depicts or redesigns an existing part of this app, the existing source is the basis — never hand-build a lookalike. Read the component\'s compiled CSS (the `const css$NN = "..."` strings inside node_modules/@deepseek-ai/dsh-client-ui-*/lib/client.js) and pass it as a file with `from`; write the entry with that component\'s REAL class names. To change the design, edit those real rules or add a stylesheet that overrides them. For a sketch with nothing to copy, style it with inline CSS and the theme tokens (var(--dsw-*)).',
  '',
  'FILES: prefer `from` — an absolute disk path the host copies verbatim — for anything large (compiled CSS, fonts, images) instead of retyping its text.',
  '',
  'FROMDIR — THE WAY TO LAND A WHOLE PAGE IN ONE CALL: pass `fromDir` (an absolute directory, e.g. what capture_page just wrote) INSTEAD of `files`, and the host does the picking. It takes entry.html as the entry, else index.html, else it fails and names the candidates (pass `entry` to choose); every other file becomes a section at its own relative path, binaries base64 automatically. It leaves out, and lists in `skipped` with bytes and reason, three kinds: files the entry loads nothing from (a leftover _build/ copy, report.json), files past the per-file limit, and extensions no section type serves (.stream, .pdf). A reference to a file that does not exist at all is refused before anything is written; a reference to one it skipped is reported under referencedSkipped and the page still renders. So a capture of 100+ files costs one call and no content in the conversation: capture_page -> create_ui_block({ name, fromDir }) -> read_ui_block.',
  '',
  'REFERENCES MUST RESOLVE: every file the entry or one of its stylesheets LOADS (link href, img/script/source/video/audio/iframe src, CSS url() and @import) must be a member of this block or a data: URL. Resolution is relative to that file\'s own URL, so ./card.css from the entry and ../assets/x.woff2 from shared/app.css both work; a bare /assets/x.png does not (the block is served under /ui-blocks/<name>/, not at the site root). A dangling reference fails the call with the line, the member and the URL as written — a block that builds and then silently 404s is worse than one that refuses. Navigation is exempt: an <a href> or a <form action> may point anywhere.',
  '',
  'ENTRY AND URLS: the entry is served at /ui-blocks/<name>/, every other file at /ui-blocks/<name>/<path>, so all of them are siblings. Link them relatively from the entry: ./card.css, ./icons/ok.svg, ./pages/error.html — and ./ on its own comes back to the entry. Writing index.html does not: only a real member answers at its own path, and the entry has its own URL.',
  '',
  'PAGES: any .html member is a whole page of its own, so one block can carry several screens of the same product — the same form at rest, in error, mid-load — instead of faking them inside one document.',
  '',
  'DEMO: add a demo.json member — { snapshots: { home: "pages/home.html" }, timeline: { steps: [{ at: 0, do: "switch", snapshot: "home" }, { at: 900, do: "type", to: "#email", text: "a@b.c" }] } } — and with a non-empty timeline.steps the plugin plays the block itself and loops it: switch / move / highlight / click / type all run from outside, and a page change is a snapshot change. Without that member, or with an empty timeline, the block is a still page. A demo may be orchestrated and fictional; the screens it switches between are ones you wrote.',
  '',
  'REPLAY: the card\'s banner carries one more button — a broken circle with a play mark. Clicking it sends { type: "dsh:replay" } into the block and then loads the entry again, so every CSS animation and transition in the block starts over. Nothing about the block itself changes: a one-shot animation stays one-shot and still comes to rest on its final frame, because that is what the site does — the button only runs it again. If an entrance animation in your block is driven by a class switch, the block\'s own script may listen for that message, put the initial class back and take it off again. A block is script-inert by default (see NO SCRIPTING), so do not depend on that: write the resting state into the markup and a plain reload replays it.',
  '',
  'DELIVERY: nothing is visible until a reply carries the block\'s own line, PASTED as one of these two — nothing else on the line, no backticks, no fence:\n\n    ::dsh-ui <name>::\n    ::dsh-ui <name> res=WxH::\n\nres=WxH goes BEFORE the closing `::` and is the only way to set the canvas size (default 1440x900). The closing `::` ENDS the line: `::dsh-ui <name>:: res=WxH` — the size after the closing colons — is not a reference and shows up in the chat as plain text. Size the height to the content: a dialog, card or toolbar wants roughly 280-420, a full page 600+; a card left at 900 reads as a broken preview. The line must be exactly that, alone on its line, no backticks or fence. A reference renders the version the block had when that message was first seen — updating a block only changes messages that reference it afterwards.',
  '',
  'INSIDE THE BLOCK: only the rendered UI — no headings, notes, captions or "方案 A" commentary; every character renders into the canvas.',
  '',
  'CREATING vs UPDATING:',
  '- To CREATE a UI block, call this tool.',
  '- A TAKEN NAME IS NEITHER AN ERROR NOR AN OVERWRITE: if <name>.uiblock already exists and holds different bytes, this block is written as <name>-2 (then -3, -4 ...) — the same numbering the capture\'s material directory uses — and the result carries the name actually used, plus one line saying so. READ THAT NAME: read_ui_block and the ::dsh-ui line must both use it, otherwise you are looking at the other page. Byte-identical content keeps the requested name (an idempotent rebuild writes nothing). overwrite: true is the only way to replace a block in place, and it keeps the old file as <name>.uiblock.bak-<ISO timestamp>. Do NOT delete the block first, and do not try to "clear" it: deleting is the only operation here that loses the old version, and it is never needed.',
  '- Do NOT create a .uiblock file with write. A block that was not created through this tool has no registered metadata, so read_ui_block and the reference line cannot find it.',
  '- A BLOCK IS A PRODUCT, NOT AN EDIT TARGET. A block built from a material directory (fromDir — a capture) is assembled output: to change its layout, change the MATERIAL and rebuild (call this tool again with overwrite: true). Do NOT edit that .uiblock by hand — the edit is lost the next time the block is rebuilt from the same material, and reading a 5.6 MB block just to change one line is what produces "file has not been read" in the first place. Only a block you authored here from `files` (no material directory, nothing to rebuild from) is edited in place: `edit` for a targeted change, or `write` when it is almost entirely new. Then reference it again in the same message. Do NOT write a block through a shell command or a script.',
  '- Editing by hand means writing the file format: every extra member is a section that starts on a whole line `<!-- @@file <path> [base64] -->` and runs to the next such line or to the end. Add `base64` to a binary one (png webp jpg jpeg woff woff2 ttf) — unmarked, its bytes are decoded as text and the member arrives corrupted. No member\'s own content may contain such a line; it would split the file.'
].join('\n')

const READ_DESCRIPTION = [
  'Render one UI block the way the user sees it and return the image. This is the real canvas, not a mock-up: live theme tokens, the current light/dark scheme and the block\'s own files, so the picture is what the user will get.',
  '',
  'The entry is laid out at the width/height you pass — media queries re-evaluate, it is not a PNG downscale. Pass the same pair you will declare on the reference line, otherwise you are checking a different layout than the user is looking at.',
  '',
  'Use it to check layout, spacing, overflow and colour before handing a draft to the user. It renders the entry page, so a demo block comes back as its still screen, not as a timeline frame.',
  '',
  'A BLOCK IS A PRODUCT, NOT AN EDIT TARGET: when the layout is wrong, change the material directory (or the source files it was built from) and rebuild with create_ui_block — do not edit the .uiblock by hand. The edit is lost on the next rebuild, and the whole file has to be read before it can be edited.',

  'When a size is not readable from the image — cards that should end up equal height — pass `probe` and compare the numbers it returns.',
  '',
  'THIS IMAGE GOES TO THE MODEL, NOT TO THE USER. The user only sees what a message references on a line of its own: `::dsh-ui <name>::`, or with the size you just rendered `::dsh-ui <name> res=WxH::` — res BEFORE the closing colons. Rendering here without that line leaves the draft invisible to them — pass the check, then reference it in the same message.'
].join('\n')

const LIST_DESCRIPTION = [
  'List the web pages a browser extension is reporting to this DSH instance right now, so a capture targets a page that exists instead of a URL someone guessed. The answer is the row array itself — one row per tab, each carrying the { instance, tabId } pair capture_page takes.',
  '',
  'THE PAGE HAS TO BE OPEN FIRST. The extension reports open tabs only, so the page must already be open in a browser that has dsh-page-capture installed.',
  '',
  'Whether this machine has such a browser is YOUR call, not this tool\'s: (1) a browser already reporting the extension means yes — use it; (2) if none is reporting, set up one fixed browser instance of your own for "CDP debugging with the extension" and reuse it from then on instead of rebuilding one per task; the extension\'s absolute directory is captureDir in GET /ui-block-extension/info; (3) if none of that is available, ask the user to install the extension in their own browser and open the page there. A page that needs a login can only come from the user\'s own browser.',
  '',
  'Call this first, then capture_page with one row\'s { instance, tabId }: a tab id is unique only inside one instance, so the pair is the identity. url and title say what the page is, focused says whether it is the active tab, and capturable:false carries the reason that tab can never be captured (a chrome:// page, the extension store, an extension page, an embedded PDF).',
  '',
  'The list is only what the extension last reported: a tab it cannot see is absent, never guessed. An instance that has not polled for a minute is offline and its rows are LEFT OUT, with one line naming it and how long it has been quiet; a report 45 to 60 seconds old is still listed but marked stale, because a tab closed since then is still in it — refresh by calling again once the extension has polled (it polls every couple of seconds). An empty list means nothing is connected, and the result then says what to check, including the extension\'s absolute path and this instance\'s address.'
].join('\n')

const CAPTURE_DESCRIPTION = [
  'Capture one web page — a row from list_pages, given as { instance, tabId } — into a material directory, and hand back a file list that create_ui_block can load straight off disk, so no page content has to pass through this conversation.',
  '',
  'THE PAIR COMES FROM list_pages: this tool can only target a tab that already exists in a browser with dsh-page-capture loaded, so the previous step is one row\'s instance + tabId, and the next one is create_ui_block({ name, fromDir }) with the material this call hands back.',
  '',
  'RECREATING A PAGE MEANS CAPTURE + BUILD, DELIVERED IN ONE GO: when the user says "clone this page" / "复刻这个页面 in dsh-ui", the deliverable is capture_page -> create_ui_block({ name, fromDir }) -> one message that references ::dsh-ui <name>:: and states the differences. Do NOT write a plan for the recreation first and do NOT ask which kind of recreation is wanted: a session that asked that question up front cost the user 132 seconds and then handed over a 5.6 MB static snapshot plus a plan nobody ever ran. Capture, build, deliver.',
  '',
  'SAY WHAT DIFFERS, EVERY TIME — a capture is not the site: the stylesheets that could not be fetched (report.sheetsFailed; a missing <link> takes all its rules with it), the files a ceiling left out (report.dropped, skipped), and the positioning the capture froze into element rules (position / inset / top / right / bottom / transform / z-index / overflow written as values, so a sticky header no longer sticks). One line per difference, named. "已完成" on its own is not a delivery.',
  '',
  'If the report says the page is a frame shell, the visible content lives in a frame the top document does not expose. Do not ask the user to choose between a screenshot, a rebuild and a guess. Give one instruction: right-click inside that frame, open it in its own tab, and capture that tab — that is the only route to real DOM and real styles.',
  '',
  'The extension does the extraction: the DOM, the styles that actually apply, and the fonts and images, plus a report of what it kept and what it dropped. This tool only queues the task for that instance, waits for the answer (60 seconds; a tab closed or navigated since list_pages fails here, and a timeout means the extension never answered — either way call list_pages again instead of retrying the same tabId), and lets the plugin write the material to <DSH_HOME>/ui-captures/<name>/ — the entry document, its shared/pages/assets material and report.json.',
  '',
  'files[].from is the ABSOLUTE path of each file on disk. Pass those strings as create_ui_block\'s files[].from and the host copies the bytes itself: a few hundred KB of material then costs no context at all. Read a file only when the caller asked to change its content.',
  '',
  'THE RESULT IS AN INDEX, NOT A PILE: files grouped by type with their bytes, the totals, report.dropped summarised, and "dangling" — every url()/src/link href the captured documents make to something the capture does NOT have. That list is the honest answer to "which icon is missing", so read it instead of re-capturing. fromDir names the directory to hand create_ui_block, so the whole material set becomes one block in one call: capture_page -> create_ui_block({ name, fromDir }) -> read_ui_block.',
  '',
  'A failure is always one concrete cause: the extension never reported in, it reported but never took the task, it took the task and never answered, the target tab is gone (call list_pages again — do not substitute another tab), or the extension itself failed, in which case its own message is repeated verbatim.',
  '',
  'IF YOU CALL THIS FROM INSIDE A SCRIPT, PRINT THE RETURNED `text` FIELD VERBATIM: a program gets the value and not the rendered result, so `text` is the only place the whole account of the capture exists — print it instead of picking fields out of the object.'
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
 * Where the registry token lives: the USER's own DSH home, not this instance's.
 * 4000 and 3080 have different DSH_HOMEs, and a token an instance keeps to
 * itself cannot be used to register with another instance's registry.
 * ponytail: a file every instance can read is a guard against accidents (a web
 * page, a blind local scan), not against a process that goes looking for it.
 */
function registryTokenFile() {
  return join(homedir(), '.dsh', 'instance-registry.token')
}

/**
 * The token a registration must carry.
 *
 * Order: the profile's own pairing code (agent.token) when set — the documented
 * way to make two instances agree — then DSH_INSTANCE_REGISTRY_TOKEN, then one
 * random string per user, created once and kept across restarts.
 */
function registryToken() {
  if (agentHub.options.token !== '') return agentHub.options.token
  const fromEnv = String(process.env.DSH_INSTANCE_REGISTRY_TOKEN === undefined ? '' : process.env.DSH_INSTANCE_REGISTRY_TOKEN).trim()
  if (fromEnv !== '') return fromEnv
  const file = registryTokenFile()
  try {
    const found = readFileSync(file, 'utf8').trim()
    if (/^[A-Za-z0-9._-]{16,128}$/.test(found)) return found
  } catch { /* first run: created below */ }
  const made = randomBytes(16).toString('hex')
  try {
    mkdirSync(dirname(file), { recursive: true })
    // 'wx' loses the race on purpose: the loser re-reads the winner's token
    // instead of overwriting it, so two instances starting together still agree.
    writeFileSync(file, made + '\n', { encoding: 'utf8', flag: 'wx' })
    return made
  } catch {
    try {
      const found = readFileSync(file, 'utf8').trim()
      if (found !== '') return found
    } catch { /* unreadable: fall through to a per-process token */ }
    return randomBytes(16).toString('hex')
  }
}

/** The token a registration carries: a header only, never a query string in a log. */
function registryRequestToken(req) {
  const header = req.headers['x-uiblock-token']
  if (typeof header === 'string' && header !== '') return header
  const authorization = req.headers.authorization
  if (typeof authorization === 'string' && /^bearer\s+/i.test(authorization)) return authorization.replace(/^bearer\s+/i, '').trim()
  return ''
}

/**
 * One registry: the table, three routes and two clocks.
 *
 * Every timing is an option with the real default, so a self-check can drive
 * expiry and self-shutdown in milliseconds instead of seconds.
 *
 * @param options - { host, port, token, expireMs, idleMs, log }.
 * @returns the registry; call start() to listen.
 */
function createRegistry(options = {}) {
  const host = options.host === undefined ? REGISTRY_HOST : String(options.host)
  const wanted = options.port === undefined ? REGISTRY_PORT : Number(options.port)
  const token = options.token === undefined ? '' : String(options.token)
  const expireMs = options.expireMs === undefined ? REGISTRY_EXPIRE_MS : Number(options.expireMs)
  const idleMs = options.idleMs === undefined ? REGISTRY_IDLE_MS : Number(options.idleMs)
  const log = typeof options.log === 'function' ? options.log : () => {}
  /**
   * port -> { port, instance, bootAt, lastSeenAt }. Keyed by port so a
   * re-announcing instance cannot double a row; sorted on read so the extension
   * always sees one stable order.
   */
  const entries = new Map()
  let server = null
  let startedAt = 0
  let lastBeatAt = Date.now()
  let closedAt = 0
  let watchdog = null

  /** The table as the extension reads it, expired rows already gone. */
  function table(now = Date.now()) {
    for (const [key, entry] of entries) if (now - entry.lastSeenAt > expireMs) entries.delete(key)
    return [...entries.values()].sort((left, right) => left.port - right.port)
  }

  /**
   * Record one instance. The token is checked by the CALLER (the HTTP handler
   * and the hosting client both know it), so this stays a plain table write and
   * an in-process call cannot quietly become a way around the check.
   */
  function register(body) {
    const now = Date.now()
    const port = Number(body.port)
    if (!Number.isInteger(port) || port < 1 || port > 65535) return { status: 400, body: { ok: false, error: 'port must be an integer 1-65535' } }
    if (!entries.has(port) && entries.size >= REGISTRY_MAX_INSTANCES) {
      return { status: 429, body: { ok: false, error: 'the instance table is full (' + String(REGISTRY_MAX_INSTANCES) + ')' } }
    }
    const instance = (String(body.instance === undefined ? '' : body.instance).trim() || String(port)).slice(0, 64)
    const bootAt = Number(body.bootAt) > 0 ? Number(body.bootAt) : 0
    entries.set(port, { port, instance, bootAt, lastSeenAt: now })
    lastBeatAt = now
    return { status: 200, body: { ok: true, port, instance, instances: entries.size } }
  }

  function authorized(carried) {
    return token !== '' && carried !== '' && carried === token
  }

  function send(res, status, payload) {
    const text = JSON.stringify(payload)
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': String(Buffer.byteLength(text)),
      'cache-control': 'no-store'
    })
    res.end(text)
  }

  async function handle(req, res) {
    try {
      const url = new URL(req.url === undefined || req.url === null ? '/' : req.url, 'http://' + host)
      if ((req.method === 'GET' || req.method === 'HEAD') && url.pathname === '/health') {
        send(res, 200, { ok: true, service: REGISTRY_SERVICE, pid: process.pid, instances: entries.size, startedAt: new Date(startedAt).toISOString() })
        return
      }
      if ((req.method === 'GET' || req.method === 'HEAD') && url.pathname === '/instances') {
        // No token in this answer, ever: the extension only needs addresses.
        send(res, 200, { ok: true, instances: table() })
        return
      }
      if (req.method === 'POST' && url.pathname === '/register') {
        if (!authorized(registryRequestToken(req))) {
          send(res, 401, { ok: false, error: 'a registry token is required: x-uiblock-token or Authorization: Bearer' })
          log('registry: rejected a registration from ' + String(req.socket === undefined ? '?' : req.socket.remoteAddress) + ' (bad token)')
          return
        }
        const made = register(await readJsonBody(req, REGISTRY_BODY_MAX_BYTES))
        send(res, made.status, made.body)
        return
      }
      send(res, 404, { ok: false, error: 'unknown registry path: ' + url.pathname })
    } catch (error) {
      try { send(res, httpStatus(error), { ok: false, error: String(error && error.message ? error.message : error) }) } catch { /* client gone */ }
    }
  }

  /** The port actually bound (the asked one before start, or when ephemeral). */
  function port() {
    if (server === null) return wanted
    const address = server.address()
    return address === null || typeof address === 'string' ? wanted : address.port
  }

  /** Close the listener. Called by the watchdog and by whoever owns this registry. */
  function stop(reason) {
    if (closedAt !== 0) return
    closedAt = Date.now()
    if (watchdog !== null) {
      clearInterval(watchdog)
      watchdog = null
    }
    const made = server
    server = null
    if (made !== null) made.close(() => {})
    log('registry: closed at ' + new Date(closedAt).toISOString() + ' (' + String(reason) + ')')
  }

  function start() {
    return new Promise((resolve, reject) => {
      const made = createServer((req, res) => { handle(req, res).catch(() => {}) })
      const onError = (error) => { reject(error) }
      made.once('error', onError)
      made.listen(wanted, host, () => {
        made.removeListener('error', onError)
        made.on('error', (error) => log('registry: server error: ' + String(error && error.message ? error.message : error)))
        server = made
        startedAt = Date.now()
        lastBeatAt = startedAt
        // A quarter of the idle window, capped, so the shutdown lands within a
        // second of the deadline instead of a minute after it.
        watchdog = setInterval(() => {
          if (Date.now() - lastBeatAt <= idleMs) return
          stop('no instance heartbeat for ' + String(Math.round(idleMs / 1000)) + 's')
        }, Math.max(50, Math.min(500, Math.floor(idleMs / 4))))
        if (typeof watchdog.unref === 'function') watchdog.unref()
        log('registry: listening on http://' + host + ':' + String(port()) + ' (pid ' + String(process.pid) + ')')
        resolve(api)
      })
    })
  }

  const api = {
    port,
    start,
    stop,
    table,
    register,
    authorized,
    handle,
    entries,
    isClosed: () => closedAt !== 0,
    closedAt: () => closedAt,
    startedAt: () => startedAt,
    lastBeatAt: () => lastBeatAt,
    idleMs: () => idleMs,
    expireMs: () => expireMs
  }
  return api
}

/**
 * One instance's side of the registry: announce this instance, keep the
 * heartbeat, and host the registry when nobody else does.
 *
 * @param options - { instancePort, instance, bootAt, registryPort, token,
 *   heartbeatMs, expireMs, idleMs, log }.
 * @returns the client; start() announces now and keeps announcing.
 */
function createRegistryClient(options = {}) {
  const instancePort = Number(options.instancePort)
  const instance = String(options.instance === undefined ? 'dsh-' + String(instancePort) : options.instance)
  const bootAt = Number(options.bootAt) > 0 ? Number(options.bootAt) : Date.now()
  const registryPort = Number(options.registryPort === undefined ? REGISTRY_PORT : options.registryPort)
  const token = options.token === undefined || options.token === '' ? registryToken() : String(options.token)
  const heartbeatMs = Number(options.heartbeatMs === undefined ? REGISTRY_HEARTBEAT_MS : options.heartbeatMs)
  const expireMs = Number(options.expireMs === undefined ? REGISTRY_EXPIRE_MS : options.expireMs)
  const idleMs = Number(options.idleMs === undefined ? REGISTRY_IDLE_MS : options.idleMs)
  const log = typeof options.log === 'function' ? options.log : () => {}
  const base = 'http://' + REGISTRY_HOST + ':' + String(registryPort)
  let hosted = null
  let degraded = ''
  let timer = null
  let running = false

  /**
   * What the fixed port answers: 'registry', 'other' (something that is not
   * us) or 'down'. The distinction is why nobody retries blindly: 'other' is a
   * decision to stop, 'down' is a port that is simply free.
   */
  async function probe() {
    try {
      const res = await fetch(base + '/health', { cache: 'no-store', signal: AbortSignal.timeout(1000) })
      let body = null
      try { body = await res.json() } catch { body = null }
      if (res.ok && body !== null && body.service === REGISTRY_SERVICE) return 'registry'
      return 'other'
    } catch {
      return 'down'
    }
  }

  async function announce() {
    const res = await fetch(base + '/register', {
      method: 'POST',
      cache: 'no-store',
      headers: { 'content-type': 'application/json', 'x-uiblock-token': token },
      body: JSON.stringify({ port: instancePort, instance, bootAt }),
      signal: AbortSignal.timeout(2000)
    })
    let body = null
    try { body = await res.json() } catch { body = null }
    return { status: res.status, body }
  }

  /** One attempt: register with whoever is there, or become the registry. */
  async function beat() {
    if (!running) return
    if (hosted !== null) {
      if (!hosted.isClosed()) {
        hosted.register({ port: instancePort, instance, bootAt })
        return
      }
      // It closed itself (nothing beat it for the idle window) yet this instance
      // is alive: host a new one instead of leaving the extension without an address.
      hosted = null
    }
    let state = await probe()
    if (state === 'registry') {
      const answer = await announce().catch(() => null)
      if (answer === null) { degrade('the registry at ' + base + ' stopped answering mid-registration'); return }
      if (answer.status === 401) degrade('the registry at ' + base + ' rejected this token (401): both instances must use the same agent.token, or delete ' + registryTokenFile() + ' and restart')
      return
    }
    if (state === 'other') { degrade('127.0.0.1:' + String(registryPort) + ' answers but is not the instance registry'); return }
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const made = createRegistry({ host: REGISTRY_HOST, port: registryPort, token, expireMs, idleMs, log })
      try {
        await made.start()
      } catch (error) {
        made.stop('bind failed')
        if (error === null || typeof error !== 'object' || error.code !== 'EADDRINUSE') {
          degrade('cannot listen on ' + base + ': ' + String(error && error.message ? error.message : error))
          return
        }
        // Lost the race: somebody else is binding the port right now. Wait, then
        // look again — a second bind attempt only repeats the failure.
        await sleep(200 * attempt)
        state = await probe()
        if (state === 'registry') {
          const answer = await announce().catch(() => null)
          if (answer !== null && answer.status === 401) degrade('the registry at ' + base + ' rejected this token (401): both instances must use the same agent.token')
          return
        }
        if (state === 'other') { degrade('127.0.0.1:' + String(registryPort) + ' answers but is not the instance registry'); return }
        continue
      }
      hosted = made
      const registered = made.register({ port: instancePort, instance, bootAt })
      if (registered.status !== 200) {
        made.stop('registration refused: ' + String(registered.body.error))
        hosted = null
        degrade('the registry refused this instance: ' + String(registered.body.error))
        return
      }
      degraded = ''
      log('registry: this instance hosts http://' + REGISTRY_HOST + ':' + String(registryPort) + ' as ' + instance)
      return
    }
    degrade('could not host or reach the registry at ' + base + ' (5 attempts)')
  }

  /** Stop trying, once, with one line that says what to fix. It never loops. */
  function degrade(reason) {
    if (degraded === reason) return
    degraded = reason
    log('registry: ' + reason + ' — the registry is disabled for this instance (no retry; free the port or align the token, then restart)')
    if (timer !== null) {
      clearInterval(timer)
      timer = null
    }
  }

  function start() {
    if (running) return Promise.resolve()
    running = true
    timer = setInterval(() => { beat().catch(() => {}) }, heartbeatMs)
    if (typeof timer.unref === 'function') timer.unref()
    return beat()
  }

  function stop() {
    running = false
    if (timer !== null) {
      clearInterval(timer)
      timer = null
    }
    if (hosted !== null) {
      hosted.stop('this instance stopped its registry client')
      hosted = null
    }
  }

  return {
    instance,
    instancePort,
    registryPort,
    start,
    stop,
    beat,
    status: () => ({
      url: base,
      degraded,
      hosting: hosted !== null && !hosted.isClosed(),
      table: hosted === null ? [] : hosted.table()
    })
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
 * The first free spelling of `wanted` inside `root`: wanted itself, else wanted-2,
 * wanted-3, ... One implementation serves both kingdoms — a capture's material
 * directory and a block file — so a page and its material always carry the SAME
 * number instead of two counters that drift (material -3, block -2).
 * @param root - the directory to look in.
 * @param wanted - the name as asked for.
 * @param extension - '.uiblock' for a block file, '' for a directory.
 * @returns an absolute path that does not exist yet.
 */
function freeNamePath(root, wanted, extension) {
  let candidate = join(root, wanted + extension)
  for (let n = 2; existsSync(candidate) && n < 100; n += 1) candidate = join(root, wanted + '-' + String(n) + extension)
  return candidate
}

/**
 * The directory one capture writes into: the task's block name when it has a
 * usable one, else capture-<stamp>; a name already taken gets -2, -3, and so on.
 * @returns the absolute directory, created.
 */
async function captureDirFor(task) {
  const wanted = task !== undefined && typeof task.name === 'string' && NAME_RE.test(task.name) ? task.name : captureStamp(new Date())
  const dir = freeNamePath(capturesDir(), wanted, '')
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

/**
 * A report older than this is still listed but marked stale: the tab may have
 * closed since, so refresh before capturing.
 */
const STALE_AFTER_MS = 45 * 1000
/**
 * A report older than THIS is not listed at all: the instance is offline.
 * The extension polls every couple of seconds, so a minute of silence means it
 * is gone — a stopped browser, a closed browser, a dead service worker. A row
 * from such an instance is worse than no row: it names a tab nobody can capture.
 */
const AGENT_OFFLINE_MS = 60 * 1000
/** How long a quiet instance keeps being NAMED in the result instead of silently dropped. */
const AGENT_QUIET_REPORT_MS = 60 * 60 * 1000
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

/** True when this instance has not reported for the offline window. */
function isOffline(seen, now = Date.now()) {
  return seen === undefined || seen === null || !(now - seen.at <= AGENT_OFFLINE_MS)
}

/** "3 minutes" / "12 seconds": how long ago, spelled for one line of a tool result. */
function ageText(ms) {
  const seconds = Math.max(1, Math.round(Number(ms) / 1000))
  if (seconds < 90) return String(seconds) + ' seconds'
  const minutes = Math.round(seconds / 60)
  if (minutes < 90) return String(minutes) + ' minutes'
  return String(Math.round(minutes / 60)) + ' hours'
}

/**
 * The hub's instances split into the two answers a caller needs: which ones are
 * reporting right now (their rows are usable) and which ones went quiet so
 * recently that saying so beats dropping them in silence.
 */
function instanceStates(args) {
  const wanted = String(args === undefined || args === null || args.instance === undefined || args.instance === null ? '' : args.instance).trim()
  const now = Date.now()
  const live = []
  const quiet = []
  for (const [instance, seen] of agentHub.instances) {
    if (!isOffline(seen, now)) {
      // "Instances reporting right now" is about the hub, not about the filter:
      // asking for an unknown name must still say who IS there.
      live.push(instance)
      continue
    }
    if (wanted !== '' && instance !== wanted) continue
    if (now - seen.at <= AGENT_QUIET_REPORT_MS) quiet.push({ instance, at: seen.at })
  }
  quiet.sort((left, right) => right.at - left.at)
  return { live, quiet }
}

/** One line per recently-quiet instance: named, timed, and not offered as a target. */
function quietLines(args) {
  const now = Date.now()
  return instanceStates(args).quiet.slice(0, 5).map((item) => 'instance ' + item.instance + ' went quiet ' + ageText(now - item.at) + ' ago and is not listed.')
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
    const quiet = quietLines(args)
    if (quiet.length > 0) lines.push('', ...quiet)
    return lines.join('\n')
  }
  const known = instanceStates(args).live
  const lines = []
  if (wanted === '') {
    lines.push(known.length === 0
      ? 'No browser tab is on the list: no extension has reported to this instance yet.'
      : 'No browser tab is on the list, though these instances are reporting: ' + known.join(', ') + ' — each of them reported zero tabs.')
  } else {
    lines.push('No browser tab is on the list for instance "' + wanted + '".'
      + (known.length === 0 ? ' No extension has reported to this instance at all.' : ' Instances reporting right now: ' + known.join(', ') + '.'))
  }
  // A quiet instance is named rather than silently missing: "it was here a
  // minute ago" is the difference between "nothing is connected" and "the thing
  // that was connected stopped reporting".
  const quiet = quietLines(args)
  if (quiet.length > 0) lines.push('', ...quiet)
  const recent = agentHub.recent.slice(-6)
  if (recent.length > 0) {
    lines.push('', 'Last requests this endpoint saw (newest last): ' + recent.map((entry) => shortTime(entry.at) + ' ' + entry.kind
      + (entry.instance === '' || entry.instance === undefined ? '' : ' instance=' + entry.instance) + ' -> ' + entry.outcome).join('; '))
  }
  // The extension's directory is derived, never a literal: the same string the
  // info route and the plugin page hand out, so the advice below cannot drift.
  let capturePath = ''
  try { capturePath = extensionDir(EXTENSION_CAPTURE_DIR_NAME) } catch (error) { capturePath = 'the extension-capture folder inside this plugin package' }
  lines.push('', 'Check these in order:')
  lines.push('1. Is the target page open right now? The extension reports open tabs only, so nothing appears here until the page is open in a browser that has dsh-page-capture loaded. Whether such a browser exists here is your call: if none is reporting, set up one fixed browser instance for this work and reuse it; the extension\'s absolute directory is ' + capturePath + '. A page that needs a login has to be opened by the user in their own browser, since no cookie is ever copied.')
  lines.push('2. Is the capture extension installed in that browser? chrome://extensions must list dsh-page-capture (Developer mode -> Load unpacked). Its directory on this machine: ' + capturePath)
  lines.push('3. Does its options page point baseURL at ' + instancePortText() + '? That one line is the whole setting: installed once, the extension reports to whichever instance baseURL names, so pointing it at the other instance makes this list empty while the other one fills up.')
  lines.push('4. Is the extension\'s own reporting switch on? With it off the extension sends nothing at all — not even a poll — so nothing here can see it.')
  lines.push('5. Are the plugin\'s agent switches on (agent.enabled)? Off, both endpoints answer 404 and the extension gives up. The request trail above says whether anything arrived at all: no line at all means the request never reached this instance.')
  lines.push('6. Even when connected, some pages never reach the list: chrome:// pages, extension pages, the extension store and embedded PDFs are reported as capturable=false, and a window showing only those leaves nothing to capture.')
  return lines.join('\n')
}

/** One line a human can read: how many files, how big, what was lost versus kept. */
function captureSummary(files, report) {
  const total = files.reduce((sum, file) => sum + file.bytes, 0)
  const split = splitDropped(report)
  const lost = split.dropped.count === 0 ? 'nothing lost' : String(split.dropped.count) + ' resource(s) really lost'
  const kept = split.movedToAssets.count === 0 ? '' : ', ' + String(split.movedToAssets.count) + ' moved into assets/ (kept, not lost)'
  return String(files.length) + ' file(s), ' + String(total) + ' bytes total, ' + lost + kept
}

/**
 * Split the extension's ONE dropped list into what was really lost and what was
 * safely moved out of the inline budget.
 *
 * The extension writes both into the same array of free-form sentences —
 * "字体 209KB 超 200KB，改存 assets/font-1.woff" next to "取不到字节（HTTP 404）" — so
 * the split has to read the words it writes. Counting them together reported 40
 * dropped for a page that had lost 4, and the model then re-captured the page and
 * read the whole table by hand. ponytail: the ceiling is a reworded sentence; the
 * upgrade path is a kind field on the item, in extension-capture.
 */
const MOVED_REASON_RE = /改存|落\s*assets\/|原尺寸|重编码|moved to assets|spilled/i
function droppedItemOf(item) {
  const line = typeof item === 'string'
    ? item
    : (item !== null && typeof item === 'object'
      ? String(item.url === undefined ? (item.src === undefined ? (item.ref === undefined ? JSON.stringify(item) : item.ref) : item.src) : item.url)
        + (item.reason === undefined && item.why === undefined ? '' : ' ' + String(item.reason === undefined ? item.why : item.reason))
      : String(item))
  const found = line.match(/https?:\/\/[^\s]+/)
  const url = found === null ? '' : found[0]
  const reason = (url === '' ? line : line.replace(url, '')).replace(/[：:]\s*$/, '').trim()
  return { url, reason, line }
}
function splitDropped(report) {
  const raw = report !== null && typeof report === 'object' ? report.dropped : undefined
  if (typeof raw === 'number') return { dropped: { count: raw, items: [] }, movedToAssets: { count: 0, sample: [] }, placeholders: [] }
  // The extension writes moved-to-assets work into report.spilled (one row per resource,
  // with its path and bytes) and keeps report.dropped for real losses only. When that
  // field exists it IS the moved count; the word-matching below stays for older captures
  // whose report has no spilled array at all.
  const spilled = report !== null && typeof report === 'object' && Array.isArray(report.spilled) ? report.spilled : null
  // 未插值的模板占位名不是「丢了的资源」：单列一栏。它们混进 really lost 的账里，
  // 就是那次十个 web_fetch 复核的由来——数它们等于告诉模型"有东西真的没了"。
  const placeholderTexts = new Set()
  const kinds = report !== null && typeof report === 'object' && Array.isArray(report.droppedItems) ? report.droppedItems : []
  for (const item of kinds) {
    if (item !== null && typeof item === 'object' && item.kind === 'templatePlaceholder') placeholderTexts.add(String(item.text))
  }
  const lost = []
  const moved = []
  const placeholders = []
  for (const item of Array.isArray(raw) ? raw : []) {
    const parsed = droppedItemOf(item)
    if (placeholderTexts.has(parsed.line)) placeholders.push({ url: parsed.url, reason: parsed.reason })
    else if (spilled === null && MOVED_REASON_RE.test(parsed.line)) moved.push({ url: parsed.url, reason: parsed.reason })
    else lost.push({ url: parsed.url, reason: parsed.reason })
  }
  if (spilled !== null) {
    for (const row of spilled) {
      const url = String(row !== null && typeof row === 'object' && row.url !== undefined ? row.url : '')
      const path = String(row !== null && typeof row === 'object' && row.path !== undefined ? row.path : '')
      const reason = String(row !== null && typeof row === 'object' && row.reason !== undefined ? row.reason : '')
      moved.push({ url, reason: (reason === '' ? 'moved into assets/' : reason) + (path === '' ? '' : ' -> ' + path) })
    }
  }
  return { dropped: { count: lost.length, items: lost }, movedToAssets: { count: moved.length, sample: moved.slice(0, 1) }, placeholders }
}

/** The type bucket one captured file belongs to, for the index. */
function materialGroup(path) {
  const ext = extOf(path)
  if (ext === 'html' || ext === 'htm') return 'html'
  if (ext === 'css') return 'css'
  if (['png', 'jpg', 'jpeg', 'webp', 'svg', 'gif', 'ico', 'avif', 'bmp'].includes(ext)) return 'images'
  if (['woff2', 'woff', 'ttf', 'otf', 'eot'].includes(ext)) return 'fonts'
  return 'other'
}

/**
 * The material INDEX: what a capture actually left on disk, grouped, counted,
 * and — the part that answers "which icon is missing" without a re-capture —
 * every reference the captured documents make to something that was NOT
 * captured.
 *
 * The extension's own report says what IT dropped; this says what the PRODUCT
 * of that dropping looks like: a url() with no file behind it.
 * @param dir - the capture directory.
 * @param files - [{ path, bytes }] as written.
 * @param report - report.json as written, for its dropped account.
 * @returns the index object the tool returns and renders.
 */
async function indexMaterial(dir, files, report) {
  const groups = { html: [], css: [], images: [], fonts: [], other: [] }
  let totalBytes = 0
  const present = new Set(files.map((file) => file.path))
  for (const file of files) {
    groups[materialGroup(file.path)].push({ path: file.path, bytes: file.bytes })
    totalBytes += file.bytes
  }
  const split = splitDropped(report)
  const dropped = split.dropped
  const movedToAssets = split.movedToAssets
  const placeholders = split.placeholders
  // A stylesheet the extension could not read (cross-origin) takes its whole
  // <link> with it, so the dangling scan below looks clean by construction.
  const sheetsFailed = report !== null && typeof report === 'object' && Number.isFinite(Number(report.sheetsFailed))
    ? Number(report.sheetsFailed)
    : 0
  // Dangling: read the text members (capped) and resolve every reference. A
  // capture of a real page is 100+ files, so the read is bounded on purpose.
  const dangling = []
  let scanned = 0
  for (const file of files) {
    if (!REFERENCE_TEXT_EXTENSIONS.has(extOf(file.path))) continue
    if (scanned >= 60 || file.bytes > limits.sectionBytes) continue
    scanned += 1
    let body
    try {
      body = await readFile(join(dir, file.path), 'utf8')
    } catch {
      continue
    }
    for (const ref of collectRefs(body, file.path)) {
      if (present.has(ref.path)) continue
      dangling.push({ where: file.path, line: ref.line, ref: ref.ref, path: ref.path })
    }
  }
  return {
    dir,
    count: files.length,
    totalBytes,
    groups,
    dropped,
    movedToAssets,
    placeholders,
    sheetsFailed,
    dangling,
    /** What create_ui_block needs: the directory itself is the whole material set. */
    fromDir: dir,
    suggestedName: baseNameOf(dir)
  }
}

/** One line: how many files and bytes, per bucket. */
function indexGroupsText(index) {
  const parts = []
  for (const key of ['html', 'css', 'images', 'fonts', 'other']) {
    const bucket = index.groups[key]
    if (bucket.length === 0) continue
    const bytes = bucket.reduce((sum, file) => sum + file.bytes, 0)
    parts.push(key + ' ' + String(bucket.length) + ' (' + String(bytes) + ' bytes)')
  }
  return 'index: ' + String(index.count) + ' file(s), ' + String(index.totalBytes) + ' bytes — ' + parts.join(', ')
}

/**
 * The one sentence a frame-shell capture must lead with. Fixed wording, and greppable
 * on purpose: the extension writes the same string first into report.dropped.
 */
const FRAME_SHELL_LINE = 'THIS PAGE IS A FRAME SHELL — the visible content lives inside a frame; capturing the top document yields nothing usable.'
/** The follow-up instruction that belongs with that sentence, in the same voice. */
const FRAME_SHELL_NEXT = 'The visible content is not in the document that was captured: right-click inside that frame, open it in its own tab, and capture THAT tab — it is the only route to the real DOM and the real styles.'

/**
 * True when the extension flagged the page as a frame shell. The extension decides
 * (it is the one that can measure the frames); this only reads its answer, so a
 * report without the flag never invents one.
 */
function isFrameShell(report) {
  return report !== null && typeof report === 'object' && report.frameShell === true
}

/** The two CSS files a capture always writes, in the order the @keyframes line names them. */
const ANIMATION_FILE_ORDER = ['shared/app.css', 'pages/current/page.css']

/** The capture tool's rendered text: where it landed, what to do with it, the index, the report. */
function captureText(value) {
  const lines = []
  // A frame shell goes FIRST, before any file list, byte count or dropped summary.
  // Buried in report.dropped it reads like the 40 false "lost resource" lines that
  // sent a model off to re-capture the whole page; this one decides what to do next.
  if (isFrameShell(value.report)) lines.push(FRAME_SHELL_LINE, FRAME_SHELL_NEXT, '')
  // REFERENCE VIEWPORT: the capture-time viewport to compare a render against — NOT a target size.
  const shot = value.report !== null && typeof value.report === 'object' ? value.report.screenshot : null
  if (shot !== null && typeof shot === 'object') lines.push('', shot.mode === 'viewport' && shot.path ? 'REFERENCE VIEWPORT ' + String(shot.width) + 'x' + String(shot.height) + ' dpr=' + String(shot.dpr) + ' page-height=' + String(shot.scrollHeight) + ' saved to ' + String(shot.path) + '\nThat viewport is the capture viewport, NOT a target size. Render the block at whatever width you actually need, and compare against this image only at the same width. Geometry inside the block was frozen at the capture width, so do not rescale or copy those pixel values to another width.' : 'REFERENCE VIEWPORT unavailable: ' + String(shot.error || 'no screenshot'))
  // Nodes the page removed BEFORE the capture ran (a loading overlay is the measured case):
  // right next to the viewport line, because both describe the state the capture froze.
  for (const line of removedNodesText(value.report)) lines.push(line)
  lines.push('Capture landed in ' + value.dir + ' — ' + value.summary, '')
  const index = value.index
  if (index !== undefined && index !== null) {
    lines.push(indexGroupsText(index))
    for (const key of ['html', 'css', 'images', 'fonts', 'other']) {
      const bucket = index.groups[key]
      if (bucket.length === 0) continue
      lines.push('  ' + key + ': ' + bucket.map((file) => file.path + ' ' + String(file.bytes)).join(', '))
    }
    // 动画在哪份文件里。抓取把 @keyframes 全提到 shared/app.css，page.css 里一条都没有；
    // 不说这一句，模型就在 page.css 里找 @keyframes，找不到再去 web_fetch 原站（实测 57.5 s）。
    const anim = value.report !== null && typeof value.report === 'object' ? value.report.keyframesByFile : undefined
    if (anim !== null && typeof anim === 'object') {
      const parts = ANIMATION_FILE_ORDER.filter((file) => anim[file] !== undefined)
        .map((file) => String(anim[file]) + ' in ' + file)
      // Iteration counts decide whether motion is visible at all: the same @keyframes with the
      // default single iteration plays once and looks static (measured: 7 s, 238-420 ms of motion).
      const oneShot = value.report.oneShotAnimations
      const looped = value.report.infiniteAnimations === undefined ? value.report.infiniteCount : value.report.infiniteAnimations
      // Undefined = a report that predates this field: say nothing rather than claim all-clear.
      const danglingCount = Number(value.report.danglingAnimationNames)
      const dangling = Number.isFinite(danglingCount) ? danglingCount : undefined
      const danglingSample = Array.isArray(value.report.danglingAnimationNameSample) ? value.report.danglingAnimationNameSample : []
      lines.push('  @keyframes: ' + parts.join(', ') + '; animations: ' + String(value.report.animationCount)
        + ' declarations, ' + String(value.report.infiniteCount) + ' with infinite'
        + (oneShot === undefined ? '' : ' — ' + String(oneShot) + ' play once (finite iterations), ' + String(looped) + ' loop forever (infinite)')
        + (dangling === undefined ? '' : dangling === 0 ? '; every animation-name resolves to a captured @keyframes'
          : '; ' + String(dangling) + ' animation-name reference(s) point at @keyframes that are NOT in this capture'
            + (danglingSample.length === 0 ? '' : ' (' + danglingSample.join(', ') + ')') + ', so those declarations never run'))
      if (oneShot !== undefined && looped > 0) {
        lines.push('  A looping animation stays infinite in your copy — replay it once and it looks static. One-shot animations stay one-shot.')
      }
    }
    // Template placeholders are NOT lost resources: they are names that never got a value,
    // and the browser cannot fetch them either. Listing them under "really LOST" is what
    // sent a model off to web_fetch ten of them (93.6 s).
    if (index.placeholders !== undefined && index.placeholders.length > 0) {
      const urls = index.placeholders.map((item) => item.url).filter((url) => url !== '')
      lines.push('  ' + String(index.placeholders.length) + ' resource(s) look like UNRESOLVED TEMPLATE placeholders (not real resources): '
        + (urls.length === 0 ? '(no url)' : urls.join(', ')))
      lines.push('  A placeholder is a template name that never got a value: the browser cannot load it either and nothing on screen is missing because of it — do not go and re-check these.')
    }
    if (index.dropped.count > 0) {
      // Every lost one, in full: a lost resource is a defect to report, and a count
      // with eight samples is what sent a model off to re-capture the whole page.
      lines.push('  report.dropped: ' + String(index.dropped.count) + ' resource(s) really LOST (not fetched, over a ceiling, or unreadable) — hand-fetching them is not the fix:')
      for (const item of index.dropped.items) lines.push('    ' + (item.url === '' ? '(no url)' : item.url) + (item.reason === '' ? '' : '  [' + item.reason + ']'))
    } else {
      lines.push('  report.dropped: nothing lost')
    }
    if (index.movedToAssets !== undefined && index.movedToAssets.count > 0) {
      const kept = index.movedToAssets.sample[0]
      lines.push('  report.movedToAssets: ' + String(index.movedToAssets.count) + ' resource(s) KEPT — stored under assets/ instead of inlined, NOT lost'
        + (kept === undefined ? '' : ' (e.g. ' + kept.reason + ')'))
    }
    if (index.dangling.length === 0) {
      // "Everything resolves" is only true of the documents that were captured:
      // a cross-origin stylesheet never arrived, so its whole <link> is gone and the
      // scan is clean by construction. Saying "all clear" here is the expensive lie.
      lines.push(index.sheetsFailed > 0
        ? '  references: every url()/src/href inside the CAPTURED documents resolves — but ' + String(index.sheetsFailed) + ' stylesheet(s) could NOT be captured (cross-origin), and a missing <link> takes all its rules with it: the layout may be missing chunks. Build it, then RENDER it and look. Do not read this line as nothing is wrong.'
        : '  references: every url()/src/href in the captured documents resolves to a captured file')
    } else {
      lines.push('  DANGLING — referenced but not captured (' + String(index.dangling.length) + '), these 404 if you build the block as-is:')
      for (const row of index.dangling.slice(0, 20)) lines.push('    ' + row.where + ':' + String(row.line) + '  ' + row.ref + ' -> ' + row.path)
      if (index.dangling.length > 20) lines.push('    ... and ' + String(index.dangling.length - 20) + ' more')
    }
    lines.push('')
    lines.push('NEXT: create_ui_block({ name: "' + index.suggestedName + '", fromDir: "' + value.dir + '" })')
    // The delivery rule, said where the next action is chosen: a capture is not
    // the site, and "recreate this page" is finished by a block plus its
    // differences — not by a plan, not by a question, not by "已完成".
    lines.push('')
    lines.push('RECREATING A PAGE IS CAPTURE + BUILD: create_ui_block({ name, fromDir }) above IS the deliverable — reference it with ::dsh-ui <name>:: in the same message. Do not plan the recreation first and do not ask which kind of recreation is wanted; build it and hand it over.')
    lines.push('THEN SAY WHAT DIFFERS — this is a capture, not the site: the stylesheets that could not be fetched, the files a ceiling left out, and the position / inset / top / right / bottom / transform / z-index / overflow values frozen into element rules (a sticky header no longer sticks). One line per difference. "已完成" alone is not a delivery.')
  }
  lines.push('')
  lines.push('files[] — `from` is the file\'s absolute path on disk. A create_ui_block call that passes them as files[].from copies the bytes on the host and none of this material enters the conversation; better still, pass fromDir (above) and list no files at all:')
  for (const file of value.files) lines.push('  ' + file.path + '  ' + String(file.bytes) + ' bytes  from=' + file.from)
  const entry = value.files.find((file) => /\.html$/.test(file.path))
  if (entry !== undefined) {
    lines.push('', 'A create_ui_block call with this material: name "' + baseNameOf(value.dir) + '", entry "' + entry.path + '", and one { path, from } item per line above.')
  }
  const reportText = JSON.stringify(value.report, null, 2)
  if (reportText.length <= 4000) lines.push('', 'report.json, verbatim (also on disk at ' + value.dir + '/report.json):', reportText)
  else lines.push('', 'report.json is ' + String(reportText.length) + ' bytes — too long to repeat here; it is on disk at ' + value.dir + '/report.json and its counters are in the summary above.')
  // The last line closes the one open question this text creates: WHERE did those
  // lines come from. Measured: an agent grepped the material directory for
  // "@keyframes:|UNRESOLVED TEMPLATE|report.dropped:" (hits=[]) because it assumed
  // they were in a file. They are not — this text is their only home.
  lines.push('', 'THESE LINES ARE NOT ON DISK: the @keyframes / UNRESOLVED TEMPLATE / report.dropped lines above exist only in this text. The material directory has none of them, so grepping it for them returns nothing and costs a call.')
  return lines.join('\n')
}

/**
 * One removed node as "<tag#id.cls>" — the shortest thing that lets a model recognise it.
 * The attribute values themselves are in report.removedNodes; only the first two classes are spelled here.
 */
function removedNodeLabel(item) {
  const tag = String(item.tag === '' ? '?' : item.tag)
  const id = item.id === undefined || item.id === '' ? '' : '#' + String(item.id)
  const classes = String(item.cls === undefined ? '' : item.cls).trim().split(/\s+/).filter((part) => part !== '').slice(0, 2)
  return tag + id + (classes.length === 0 ? '' : '.' + classes.join('.'))
}

/**
 * The traceability line for nodes the page itself removed before the capture ran.
 * Why it exists: a loading overlay that is gone at capture time leaves a static-looking block,
 * and a bare count ("removedNodes: 2") gave the model nothing to decide with. This line names
 * them, and says what may be done about it — including that doing it is an inference.
 */
function removedNodesText(report) {
  const items = report !== null && typeof report === 'object' && Array.isArray(report.removedNodes) ? report.removedNodes : []
  if (items.length === 0) return []
  const extra = Number(report.removedNodesTruncated) || 0
  const total = items.length + extra
  const shown = items.slice(0, 3).map(removedNodeLabel)
  return [
    String(total) + ' node(s) were removed from the DOM before this capture: ' + shown.join(', ')
      + (total > 3 ? ' … (first 3 of ' + String(total) + ')' : '')
      + (extra > 0 ? ' — report.removedNodes lists the newest ' + String(items.length) + ', report.removedNodesTruncated counts the ' + String(extra) + ' older one(s) not listed' : '')
      + '. Each entry has tag / id / cls / bytes / the first 300 chars of its outerHTML.',
    'If one of them was a loading or skeleton layer, you may put it back inside the block and drive it with a CSS animation — but say in your diff that this is inferred: the capture never saw that state, and the block is not the site.'
  ]
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
  // limits is a SIBLING of agent: the ceilings are not a switch, they are sizes.
  applyLimitsConfig(config)
  // History follows the file, never the reader: install the watcher once.
  watchBlocksDir(ctx)
  // registry is a third sibling. enabled:false turns the whole 登记台 off for
  // this instance — the self-check uses it so a test run never fights a running
  // instance over the fixed port.
  const registryConfig = config !== null && typeof config === 'object' && config.registry !== null && typeof config.registry === 'object' ? config.registry : {}
  const registryAllowed = registryConfig.enabled !== false
  /**
   * create_ui_block's rendered text. It is one function because the value carries
   * the SAME string in its `text` field: under run_code a program receives the value
   * and never the rendered content, and this text holds the delivery line
   * (::dsh-ui <name>::) a block is useless without.
   */
  function createText(value) {
    return 'UI block: ' + value.path + '\nAbsolute path: ' + value.absolutePath + '\nEntry: ' + value.entry + (value.fromDir === undefined ? '' : '\nBuilt from: ' + value.fromDir)
      + (value.requested === undefined ? '' : '\nRENAMED — "' + value.requested + '" is already taken, so this one was written as "' + value.name + '". Use the NEW name everywhere: read_ui_block({ name: "' + value.name + '" }) and the ::dsh-ui ' + value.name + ':: line.')
      + '\nFiles (loaded ' + String(value.files.length) + ', ' + String(value.totalBytes) + ' bytes; block text ' + String(value.blockBytes) + ' bytes):\n'
      + value.files.map((file) => '  - ' + file.path + ' (' + String(file.bytes) + ' bytes' + (file.from === undefined ? '' : ', from ' + file.from) + ')').join('\n')
      + (Array.isArray(value.hygiene) && value.hygiene.length > 0
        ? '\nFIXED ' + String(value.hygiene.length) + ' element(s) that used a raw-text tag as a container: '
          + value.hygiene[0].from + ' → ' + value.hygiene[0].to
          + (value.hygiene.length > 1 ? '\n  ' + value.hygiene.slice(1).map((row) => row.from + ' → ' + row.to).join('\n  ') : '')
          + ' (otherwise its children would render as plain text). Original material untouched; this rewrite happens at build time.'
        : '')
      + (Array.isArray(value.skipped) && value.skipped.length > 0
        ? '\nSkipped (' + String(value.skipped.length) + '):\n' + value.skipped.map((item) => '  - ' + item.path + ' (' + String(item.bytes) + ' bytes, ' + item.reason + (item.detail === undefined ? '' : ': ' + item.detail) + (item.via === 'srcset' ? '; referenced via srcset' : '') + ')').join('\n')
        : '')
      + (Array.isArray(value.skipped) && value.skipped.some((item) => BUDGET_REASONS.has(item.reason))
        ? '\n' + DEGRADED_TEXT
        : '')
      + (Array.isArray(value.referencedSkipped) && value.referencedSkipped.length > 0
        ? '\nReferenced but skipped — those 404 inside the block, the page still renders:\n' + value.referencedSkipped.map((line) => '  - ' + line).join('\n')
        : '')
      + (Array.isArray(value.srcsetReferenced) && value.srcsetReferenced.length > 0
        ? '\nReferenced via srcset only (' + String(value.srcsetReferenced.length) + ') — these are LOADS, not leftovers:\n  - ' + value.srcsetReferenced.join('\n  - ')
        : '')
      + (value.warning === undefined ? '' : '\nNOTE: ' + value.warning)
      + '\nNOT VISIBLE TO THE USER YET. Reference it in the same message with a line of its own, pasted as written:\n'
      + '  ::dsh-ui ' + value.name + '::\n'
      + 'For a canvas size, res=WxH goes BEFORE the closing :: (the closing :: ends the line):\n'
      + '  ::dsh-ui ' + value.name + ' res=WxH::\n'
      + 'Do not append the size after the closing colons — ::dsh-ui ' + value.name + ':: res=WxH is not a reference and shows as plain text.'
      + '\nNEXT: read_ui_block({ name: "' + value.name + '" })'
      + (value.backup === undefined ? '' : '\nOVERWROTE THE PREVIOUS VERSION (overwrite: true). The old one is kept byte for byte at: ' + value.backup)
  }

  ctx.tools.register(defineTool({
    name: CREATE_TOOL,
    description: CREATE_DESCRIPTION,
    parameters: {
      name: {
        type: 'string',
        required: true,
        description: 'Block name: 1-64 chars of [A-Za-z0-9._-], starting with a letter or digit. The file is ' + join(BLOCKS_DIR_ABS, '<name>.uiblock') + '.'
      },
      entry: {
        type: 'string',
        description: 'Which file renders: a path at the block ROOT (no "/"). Omitted, it is the file called index.html, else the first file. With fromDir, omitted means entry.html then index.html at the top of that directory.'
      },
      title: {
        type: 'string',
        description: 'Optional human label for the preview card. Not stored in the file.'
      },
      overwrite: {
        type: 'boolean',
        description: 'Replace an existing block IN PLACE instead of landing on the next free number. Without it a taken name becomes <name>-2 / -3 and the result says which name was used; with it the old file is renamed to <name>.uiblock.bak-<ISO timestamp> first. Use it only when you mean to replace that exact block — never to "claim" a name.'
      },
      fromDir: {
        type: 'string',
        description: 'Absolute path of a material directory (a capture from capture_page, or any folder of a page and its assets). The host walks it and builds the whole block itself: entry.html (else index.html, else name one with entry), every other file at its own relative path, binary extensions base64 automatically. Files nobody loads, files past the per-file limit and extensions no section type serves are LEFT OUT and listed in the result with their bytes and reason — nothing to pick by hand. Use this OR files, not both. A reference the entry or a stylesheet makes to a file that does not exist at all is refused before anything is written.'
      },
      files: {
        type: 'array',
        description: 'One item per file: { path, content } for text you write, or { path, from } for an absolute disk path the host copies verbatim. Binary extensions (woff2 woff ttf png jpg jpeg webp) are stored as base64 automatically, so pass a binary either as a base64 string in `content` or, better, as `from`. At least one item, and the entry must be among them. Defaults: 2 MB per file measured on the decoded bytes, 64 MB per block measured on the stored file text (a base64 payload counts about 4/3 of its real size); both are configurable under `limits`. Every resource the entry or a stylesheet loads must be one of these files (or a data: URL) — otherwise the call fails and names what is missing.',
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
          absolutePath: { type: 'string', required: true, description: 'The block file\'s absolute path on disk (<DSH_HOME>\\ui-blocks\\<name>.uiblock). \'path\' is the relative spelling the reference line uses; this is the one to hand to a shell or an editor.' },
          name: { type: 'string', required: true },
          backup: { type: 'string' },
          requested: { type: 'string', description: 'Present only when the requested name was taken and the block was written under the next free number: the name that was asked for. `name` is the one that exists.' },
          entry: { type: 'string', required: true },
          fromDir: { type: 'string', description: 'The material directory this block was built from, when fromDir was used.' },
          blockBytes: { type: 'number', required: true, description: 'The stored block text, which is what the limits measure.' },
          totalBytes: { type: 'number', required: true, description: 'Sum of the loaded files\' own bytes.' },
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
          },
          skipped: {
            type: 'array',
            description: 'fromDir only: every file left out, with its bytes and why (unknown type / over limit / unreferenced).',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                path: { type: 'string', required: true },
                bytes: { type: 'number', required: true },
                reason: { type: 'string', required: true },
                detail: { type: 'string' },
                via: { type: 'string', description: 'Present when the only references to this skipped file are srcset candidates ("srcset").' }
              }
            }
          },
          srcsetReferenced: {
            type: 'array',
            description: 'fromDir only: files the entry loads ONLY through a srcset/imagesrcset candidate. They are LOADED when type and size allow it — never "unreferenced". A path here that also appears in skipped[] was left out for another reason.',
            items: { type: 'string' }
          },
          referencedSkipped: {
            type: 'array',
            description: 'fromDir only: references that point at a file this block left out — one line each, "where:line ref -> path".',
            items: { type: 'string' }
          },
          hygiene: {
            type: 'array',
            description: 'fromDir only: raw-text tags (title / textarea / style / script / xmp / plaintext) the entry used as CONTAINERS inside the body. Each was rewritten to <div> at build time with all its attributes, because parsed as HTML a raw-text tag turns its children into plain text. Nothing on disk was changed — the material still holds the original bytes.',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                from: { type: 'string', required: true, description: 'The opening tag as the entry has it, e.g. <title class="title flex-row">.' },
                to: { type: 'string', required: true, description: 'What the block carries instead, e.g. <div class="title flex-row">.' }
              }
            }
          },
          warning: { type: 'string', description: 'One advisory line when the block is past limits.softWarnBytes. Not an error: the block is written.' },
          text: {
            type: 'string',
            required: true,
            description: 'The build account as text, verbatim — the same string this tool renders: path, entry, files, skipped, the hygiene rewrite, the ::dsh-ui reference line to paste, and NEXT. A run_code program receives this value and not the rendered text, so print this field; the reference line exists nowhere else.'
          },
        }
      },
      render: (args, value) => [{ type: 'text', text: value.text === undefined ? createText(value) : value.text }]
    },
    execute: async (args) => {
      const blockName = assertName(args.name)
      const hasFiles = args.files !== undefined && args.files !== null
      const hasDir = typeof args.fromDir === 'string' && args.fromDir.trim() !== ''
      if (hasFiles === hasDir) {
        throw new Error(CREATE_TOOL + ': pass exactly one of files / fromDir'
          + (hasDir || hasFiles ? '' : ' — files is the explicit list, fromDir builds the block from a material directory'))
      }
      let assembled
      let from
      let skipped
      let srcsetReferenced
      let referencedSkipped
      let hygiene
      if (hasDir) {
        const collected = await collectFromDir(args.fromDir, args.entry)
        from = collected.root
        assembled = await assembleBlock(collected.files, collected.entryPath, { toleratedMissing: collected.tolerated })
        skipped = collected.skipped
        srcsetReferenced = collected.srcsetReferenced
        hygiene = collected.hygiene
        referencedSkipped = assembled.toleratedRefs.map((row) => row.where + ':' + String(row.line) + ' ' + row.ref + ' -> ' + row.path)
      } else {
        assembled = await assembleBlock(args.files, args.entry)
      }
      // A name that is taken is neither an error nor an overwrite: this block
      // lands on the next free number (-2, -3 ...), through the SAME allocator the
      // capture directory uses, so page and material never get different numbers.
      let finalName = blockName
      if (args.overwrite !== true) {
        const exact = join(blocksDir(), blockName + EXT)
        // Byte-identical under the requested name: an idempotent rebuild. Keep the
        // name (writeBlock writes nothing) instead of littering -2 copies of it.
        const sameBytes = existsSync(exact) && (await readFile(exact, 'utf8')) === assembled.text
        if (!sameBytes) finalName = basename(freeNamePath(blocksDir(), blockName, EXT)).slice(0, -EXT.length)
      }
      const written = await writeBlock(finalName, assembled.text)
      const value = {
        path: blockPath(finalName),
        // The absolute path on disk: 'path' is the spelling the reference line and read_ui_block
        // take, and it is NOT a filesystem path (~/.dsh is wrong here — DSH_HOME decides).
        absolutePath: written.target,
        name: finalName,
        ...finalName === blockName ? {} : { requested: blockName },
        ...written.backup === undefined ? {} : { backup: written.backup },
        entry: assembled.entry,
        ...from === undefined ? {} : { fromDir: from },
        blockBytes: Buffer.byteLength(assembled.text, 'utf8'),
        totalBytes: assembled.files.reduce((sum, file) => sum + file.bytes, 0),
        files: assembled.files,
        ...skipped === undefined ? {} : { skipped },
        ...srcsetReferenced === undefined || srcsetReferenced.length === 0 ? {} : { srcsetReferenced },
        ...referencedSkipped === undefined || referencedSkipped.length === 0 ? {} : { referencedSkipped },
        ...hygiene === undefined || hygiene.length === 0 ? {} : { hygiene },
        ...assembled.warning === undefined ? {} : { warning: assembled.warning },
      }
      return { ...value, text: createText(value) }
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

  /**
   * read_ui_block's rendered text. One function because the value carries the SAME
   * string in its `text` field: run_code hands a program the value and never the
   * rendered content (the PNG still arrives as an attachment, the words did not).
   */
  function readText(value) {
    return '<path>' + value.path + '</path>\n<type>image</type>\n<content>PNG image, ' + value.width + 'x' + value.height + ' px, ' + value.bytes + ' bytes; rendered with ' + value.tokens + ' theme tokens, skin: ' + value.scheme + '</content>'
      + (value.measurements === undefined ? '' : '\n<measurements>\n' + value.measurements + '\n</measurements>')
      + (value.note === undefined ? '' : '\nNOTE: ' + value.note)
  }

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
      fullPage: {
        type: 'boolean',
        description: 'Render the WHOLE page instead of the first screen. Without it a height above ' + String(FIRST_SCREEN_H) + ' px is clamped to the first screen (a 1440x1400 full-page shot of a heavy block measured 18 s, 43.6 s with probe), which is also the range probe looks at. Pass true only when something below the first screen is the thing you must see.'
      },
      probe: {
        type: 'array',
        description: 'Optional CSS selectors to measure in the rendered document, for when the image cannot show a size. Each returns how many elements matched and the FIRST match inside the rendered screen\'s x / y / width / height in document pixels, rounded to integers; nothing matched reads `no match`. A comma list is one selector list: the count and the box are over the union, and "first" means document order. Defaults to the first screen — pass fullPage: true to measure the whole page.',
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
          // Not the page's own colours: `scheme` is the skin the CLIENT renders blocks in (render.tokens().scheme), so a light page painted in the dark canvas still reports "dark".
          scheme: { type: 'string', required: true, description: 'The skin the client rendered this block in (window.__dshPageBlock.render.tokens().scheme: "dark" or "light"). It describes the CANVAS the block was wrapped in, NOT the captured page\'s own colours — a light page rendered in the dark skin still reads "dark" here.' },
          note: { type: 'string', required: true, description: 'The block file\'s absolute path on disk (<DSH_HOME>\\ui-blocks\\<name>.uiblock). When the requested height was clamped to the first screen, the same string also says both numbers and how to get the whole page.' },
          text: {
            type: 'string',
            required: true,
            description: 'The render account as text, verbatim — the same string this tool renders: the PNG size, bytes, theme-token count, skin, and any probe measurements or clamp note. A run_code program receives this value and not the rendered text (the image still arrives as an attachment), so print this field.'
          },
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
      render: (args, value) => [{ type: 'text', text: value.text === undefined ? readText(value) : value.text }, { type: 'image', attachment: value.image }]
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
      // The first screen only, unless the whole page was asked for: those extra
      // pixels are paid for in layout, raster and PNG, and are not looked at.
      const { res: canvas, note } = readCanvas(args)
      const shot = await screenshotBlock({
        baseUrl,
        body,
        blockName,
        res: canvas,
        probe: Array.isArray(args.probe) ? args.probe : undefined,
        firstScreen: args.fullPage === true ? undefined : canvas.h,
        timeoutMs: 45000
      })
      if (exec !== undefined && exec.signal !== undefined && exec.signal.aborted) throw new Error(READ_TOOL + ': aborted')
      const image = await attachments.saveImage({ data: shot.png, mediaType: 'image/png', name: blockName + '.png' })
      // Where the block actually is, in full: 'path' is the reference-line spelling, and a
      // model that treats it as a disk path goes hunting in ~/.dsh (one globbed all of C: for 30 s).
      const blockAbsolute = join(blocksDir(), blockName + EXT)
      const value = {
        path: blockPath(blockName),
        width: shot.width,
        height: shot.height,
        bytes: shot.png.length,
        tokens: shot.tokenCount,
        scheme: String(shot.scheme ?? ''),
        ...shot.measurements === undefined ? {} : { measurements: shot.measurements },
        note: (note === undefined ? '' : note + ' — ') + 'the block file is ' + blockAbsolute,
        image: {
          attachmentId: String(image.attachmentId),
          mediaType: String(image.mediaType),
          bytes: image.bytes,
          width: image.width,
          height: image.height,
          ...image.name === undefined ? {} : { name: String(image.name) }
        }
      }
      return { ...value, text: readText(value) }
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
        description: 'One row per capturable-or-not tab the extensions reported. Empty when nothing is connected — the rendered text then says what to check.',
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
        // An offline instance's rows are not offered at all: the tabs in them
        // belong to a browser that stopped reporting, so capture_page on one of
        // them can only end in "the target is gone".
        if (isOffline(seen)) continue
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
          summary: { type: 'string', required: true, description: 'One line for humans: file count, total bytes, how many resources were really lost, and how many were kept by moving them into assets/.' },
          fromDir: { type: 'string', required: true, description: 'The directory to hand create_ui_block as fromDir — the whole material set becomes a block in one call.' },
          index: {
            type: 'json',
            required: true,
            description: 'The material index: files grouped by type (html/css/images/fonts/other) with bytes, the totals, report.dropped split into really-lost versus moved-to-assets (dropped / movedToAssets), sheetsFailed (stylesheets that could not be read), and "dangling" — every reference the captured documents make to something that was NOT captured (where, line, ref, resolved path).'
          },
          text: {
            type: 'string',
            required: true,
            description: 'The capture account as text, verbatim — the same string this tool renders: where the material landed, the index groups, the @keyframes line, template placeholders, report.dropped, dangling references, and the next calls. A run_code program receives this value and not the rendered text, so print this field.'
          }
        }
      },
      // The field is the source; a value built by hand (a self-check) has none, and
      // the same function answers for it — one wording, two entrances.
      render: (args, value) => [{ type: 'text', text: value.text === undefined ? captureText(value) : value.text }]
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
      const index = await indexMaterial(done.dir, done.files, report)
      const value = {
        dir: done.dir,
        files: done.files.map((file) => ({ path: file.path, bytes: file.bytes, from: join(done.dir, file.path) })),
        report,
        summary: captureSummary(done.files, report),
        fromDir: done.dir,
        index
      }
      // The rendered text travels in the VALUE as well, built by the one function
      // that owns it. Reason: a run_code program receives the tool's value and
      // never its rendered content (dsh-tools/lib/types/ptc.js:454), so a capture
      // taken from inside a script used to arrive with summary/dir/report only —
      // every account line (@keyframes, placeholders, dropped, dangling) invisible.
      return { ...value, text: captureText(value) }
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
          // A read writes nothing, history included: the watcher records the
          // changes, so opening a block (or its 89 sections) leaves the log alone.
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
          if (wholeFile > limits.blockBytes) {
            sendText(res, 413, 'block ' + blockPath(blockName) + ' is ' + String(wholeFile) + ' bytes; the limit is ' + String(limits.blockBytes)
              + ' bytes (per block) — ' + String(wholeFile - limits.blockBytes) + ' bytes over. Shrink or drop the heavy sections (base64 costs 4/3: woff2 instead of ttf), or raise limits.blockBytes in the plugin config.')
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
          if (bytes.length > limits.sectionBytes) {
            sendText(res, 413, 'section ' + file.path + ' is ' + String(bytes.length) + ' bytes; the limit is ' + String(limits.sectionBytes)
              + ' bytes (per file) — ' + String(bytes.length - limits.sectionBytes) + ' bytes over. Shrink the asset, or raise limits.sectionBytes in the plugin config.')
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
            // Who has reported in, out of the hub's own table — no new storage.
            // lastSeenAt is that instance's last POST /poll, which is exactly what
            // the card needs to say "connected: chrome (12s ago)".
            // Every record is kept, INCLUDING the ones that went quiet: the card
            // says "disconnected 3 minutes ago" from this, which is more useful
            // than the row simply vanishing while the user wonders why.
            const now = Date.now()
            const agents = [...agentHub.instances.entries()].map(([instance, seen]) => ({
              instance,
              lastSeenAt: new Date(seen.at).toISOString(),
              tabs: seen.tabs.length,
              stale: isOffline(seen, now)
            }))
            send(200, {
              ok: true,
              dir: facts.dir,
              version: String(facts.manifest.version ?? ''),
              name: String(facts.manifest.name ?? ''),
              manifestVersion: facts.manifest.manifest_version,
              captureDir,
              captureVersion,
              captureExists: existsSync(captureDir),
              agents
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
    // The registry starts HERE, where the port is finally known: publishing that
    // port is its entire job. agent.token has been applied above, so a profile
    // that configures a pairing code uses it as the registry token too.
    if (registryAllowed && Number.isFinite(listened) && listened > 0) {
      const registryClient = createRegistryClient({
        instancePort: listened,
        instance: 'dsh-' + String(listened),
        bootAt: Math.round(Date.now() - process.uptime() * 1000),
        log: (line) => { if (ctx.logger !== undefined && typeof ctx.logger.info === 'function') ctx.logger.info('dsh-ui-block: ' + line) }
      })
      const begin = () => registryClient.start().catch((error) => {
        if (ctx.logger !== undefined) ctx.logger.warn('dsh-ui-block: instance registry failed: ' + String(error && error.message ? error.message : error))
      })
      if (typeof ctx.effect === 'function') ctx.effect(() => { begin(); return () => registryClient.stop() })
      else begin()
    }
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
            // TABS: a poll that CARRIES the field replaces the list; a poll without
            // it KEEPS the previous one. The extension sends the whole list now and
            // then (every 10s) and only a fingerprint (tabsTag) in between, so an
            // absent field must not be read as "no tabs" — that would blank the list
            // on every intermediate poll. An explicit `tabs: []` is the only way to
            // say "this browser really has no tabs now".
            const previous = agentHub.instances.get(instance)
            const carried = Object.prototype.hasOwnProperty.call(posted, 'tabs') && Array.isArray(posted.tabs)
            const tabs = carried ? normalizeTabs(posted.tabs) : (previous === undefined ? [] : previous.tabs)
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
 * Test seam for self-check-blockbuild.mjs: the block-building path — the live
 * limits, the directory collector, the reference guard and the material index —
 * so fromDir, the ceilings and the dangling-reference refusal can be asserted
 * against real files in a throwaway DSH_HOME.
 */
export const blockBuild = {
  limits,
  LIMIT_DEFAULTS,
  applyLimitsConfig,
  collectFromDir,
  rewriteRawTextContainers,
  assertRefsResolve,
  collectRefs,
  resolveRef,
  indexMaterial,
  softWarnText,
  overLimitText
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
 * Test seam for self-check-agent-tools.mjs: the instance registry and the
 * per-instance client, so hosting, reuse, expiry and the idle shutdown can be
 * asserted on an ephemeral port — and driven in milliseconds instead of seconds.
 */
/**
 * Test seam for self-check.mjs: the canvas clamp and the probe geometry, so the
 * first-screen default is asserted on its own terms instead of through a browser.
 */
export const rendering = {
  readCanvas,
  probeScript,
  formatProbe,
  DEFAULT_RES,
  FIRST_SCREEN_H
}
/**
 * The capture ledger as text, so the two honesty rules are assertable without a
 * browser: what was really lost versus kept, and whether the "references" line
 * is allowed to say everything is fine.
 */
export const reporting = {
  splitDropped,
  droppedItemOf,
  captureSummary,
  captureText,
  indexMaterial,
  MOVED_REASON_RE,
  DEGRADED_TEXT,
  BUDGET_REASONS
}
/** The fromDir side: the de-inline rule is pure text handling, worth its own assertions. */
export const materialRules = {
  deinlineBinaries,
  assetPathFrom,
  ASSET_INLINE_MAX_BYTES,
  DATA_URI_EXTENSIONS,
  LIMIT_DEFAULTS
}
export const instanceRegistry = {
  createRegistry,
  createRegistryClient,
  registryToken,
  registryTokenFile,
  REGISTRY_PORT,
  REGISTRY_HOST,
  REGISTRY_SERVICE,
  REGISTRY_EXPIRE_MS,
  REGISTRY_IDLE_MS,
  REGISTRY_HEARTBEAT_MS
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
  resetPinsCache: () => { pinsCache = null },
  trimHistory,
  /** Test hook: wait until the ui-blocks watcher has recorded everything it saw. */
  settleHistory: () => watcherTail.then(() => undefined, () => undefined),
  freeNamePath,
  captureDirFor,
  HISTORY_LOG_MAX_BYTES,
  HISTORY_BLOCK_MAX_BYTES,
  HISTORY_KEEP_ENTRIES
}

