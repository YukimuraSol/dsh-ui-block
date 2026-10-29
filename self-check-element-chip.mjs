/**
 * Assertion self-check for the ELEMENT CHIP half of dsh-ui-block (it was its own
 * plugin until 2026-10-28): the pure halves are driven as shipped code through a
 * fake ModuleLoader, so the real, merged client.js is under test.
 *
 * What it proves (plan B, the element«...» token):
 *   - a token's tag is read from its own 'HTML Element:' line, e.g. <button>;
 *   - a malformed token (bad payload, no closing guillemet, no HTML Element line,
 *     an empty tag) yields NO tag - the draft watcher then leaves it as plain text;
 *   - nextEdit finds the next un-chipped token and its span is exactly that token;
 *   - a malformed token is skipped, not fatal: a good token after it still renders;
 *   - clipboard -> detect offset folding accounts for chips already in the draft;
 *   - codec.clipboardText(ref) and codec.serialize(ref) return the token VERBATIM,
 *     so the outgoing message is byte-identical to the paste;
 *   - codec.serialize NEVER rejects and never throws (missing / non-string / empty
 *     refs all resolve);
 *   - a whole draft of tokens round-trips byte for byte through the shell's own
 *     serialize splice;
 *   - the registry is a read-only parse cache: remember / list / tagOf / pathOf;
 *   - the packaged extension's card registers into the PLUGINS DETAIL section
 *     (not the old Settings -> Plugins tab) and its subject guard renders it on
 *     dsh-ui-block's own page only.
 *
 * Run it from dsh-ui-block: node self-check-element-chip.mjs.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const here = (rel) => fileURLToPath(new URL(rel, import.meta.url));
const source = readFileSync(here('./client.js'), 'utf8');

// The guillemets are spelled with String.fromCharCode so this file itself stays
// pure ASCII and cannot be mangled by an encoding round trip.
const OPEN = String.fromCharCode(0x00ab);
const CLOSE = String.fromCharCode(0x00bb);
const token = (body) => 'element' + OPEN + body + CLOSE;

// -- load the shipped bundle through a fake ModuleLoader ---------------------
assert.ok(source.includes('window.__ModuleLoader__.load('), 'client.js must be a ModuleLoader bundle');
assert.ok(source.includes("id: 'dsh-ui-block'"), 'client.js must declare its entry id');
assert.equal(source.split('window.__ModuleLoader__.load(').length - 1, 1, 'the merged bundle registers exactly ONE entry, not two');

let captured = null;
globalThis.window = { __ModuleLoader__: { load: (entry) => { captured = entry; } } };
const reactStub = { createElement: () => null, useEffect: () => {}, Fragment: 'Fragment' };
const fakeRequire = (id) => {
  if (id === 'react') return reactStub;
  throw new Error('unexpected require: ' + id);
};
eval(source);
assert.ok(captured !== null, 'the bundle must register itself');
assert.equal(captured.id, 'dsh-ui-block', 'the merged bundle registers as dsh-ui-block');
const bundle = captured.factory(fakeRequire);
assert.equal(typeof bundle.apply, 'function', 'the merged bundle must export apply');
assert.ok(Array.isArray(bundle.inject), 'the merged bundle must export an inject list');
assert.ok(bundle.inject.indexOf('inputTriggers') >= 0, 'the element half needs inputTriggers to register its @ source');
assert.ok(bundle.inject.indexOf('uiConversation') >= 0, 'the element half needs uiConversation for the user-text rule');
const P = bundle.__pure;
assert.ok(P, 'the bundle must expose its pure halves for the check');

// -- fixtures: the A-side clipboard contract (content.js tokenFor) -------------
const BUTTON = [
  'DOM Path: div.card > button.cta',
  'Position: top=20px, left=707px, width=87px, height=32px',
  'HTML Element: <button type="button" class="mc-chip online" id="mcChip" aria-expanded="false">' +
    String.fromCharCode(0x5728, 0x7ebf) + ' 2/16</button>',
  'Styles: color=rgb(62,207,142) bg=rgba(62,207,142,0.08) font=600 15px/21.75px'
].join('\n');
const HEADING = [
  'DOM Path: main.main > section.hero > h1',
  'Position: top=165px, left=40px, width=464px, height=38px',
  'HTML Element: <h1 data-cursor-element-id="cursor-el-17">' + String.fromCharCode(0x542c) + '</h1>',
  'Styles: color=rgb(20,20,20) font=700 32px/38px'
].join('\n');
const T1 = token(BUTTON);
const T2 = token(HEADING);

// -- 1. the tag comes from the token's own HTML Element line ------------------
assert.equal(P.tokenTag(T1), '<button>', 'the first tag name of the HTML Element line is the label');
assert.equal(P.tokenTag(T2), '<h1>', 'a heading token labels as <h1>');
assert.equal(P.tokenTag(token('HTML Element: <input type="text" />')), '<input>', 'a void element labels as <input>');
assert.equal(P.tokenTag(token('HTML Element: <my-widget part="x">y</my-widget>')), '<my-widget>', 'a custom element name survives');
// An attribute value containing '>' must not confuse the tag scan (attributes are
// never parsed): the tag is the first name after '<'.
assert.equal(P.tokenTag(token('HTML Element: <a title="a>b" href="#">x</a>')), '<a>', 'a > inside an attribute value is not the tag end');
// The extension escapes literal guillemets in page content, so they never truncate.
assert.equal(P.tokenTag(token('HTML Element: <div>a\\u00abb</div>')), '<div>', 'an escaped guillemet in the content is harmless');

// -- 2. malformed tokens are REFUSED (the safe failure of plan 5.5) -----------
assert.equal(P.tokenTag(token('\u574fJSON')), null, 'a token with no HTML Element line has no tag');
assert.equal(P.tokenTag('element' + OPEN + 'HTML Element: <button>'), null, 'a missing closing guillemet is refused');
assert.equal(P.tokenTag('element' + OPEN + 'HTML Element: <button>' + CLOSE + ' trailing'), null, 'a token that is not the whole string is refused');
assert.equal(P.tokenTag(token('HTML Element: <>')), null, 'an empty tag is refused');
assert.equal(P.tokenTag(token('HTML Element: <1bad>')), null, 'a tag that does not start with a letter is refused');
assert.equal(P.tokenTag(token('HTML Element:  no angle at all')), null, 'prose after the label is refused');
assert.equal(P.tokenTag(token('')), null, 'an empty token body is refused');
assert.equal(P.tokenTag(''), null, 'an empty string is refused');
assert.equal(P.tokenTag(null), null, 'null is refused');
assert.equal(P.tokenTag(undefined), null, 'undefined is refused');
assert.equal(P.tokenTag('just some prose with element in it'), null, 'prose is refused');

// -- 3. nextEdit finds the next un-chipped token ------------------------------
const body = '\u8bf7\u628a ' + T1 + ' \u548c ' + T2 + ' \u7684\u6837\u5f0f\u7edf\u4e00\u4e0b';
const first = P.nextEdit(body, []);
assert.equal(first.tag, '<button>', 'the first token is found');
assert.equal(first.token, T1, 'the token is handed back whole');
assert.equal(body.slice(first.start, first.end), T1, 'the span is EXACTLY the token');
assert.equal(first.start, body.indexOf(T1), 'the span starts where the token starts');

// Once that token is a chip the draft carries one occurrence at its offset, and
// the clipboard projection still holds the token text there: skip it, find T2.
const second = P.nextEdit(body, [{ source: 'element', offset: first.start, length: T1.length }]);
assert.equal(second.tag, '<h1>', 'the second token is next');
assert.equal(second.token, T2, 'the second token is handed back whole');
assert.equal(body.slice(second.start, second.end), T2, 'and its span is exact too');
assert.equal(P.nextEdit(body, [
  { source: 'element', offset: first.start, length: T1.length },
  { source: 'element', offset: second.start, length: T2.length }
]), null, 'a fully chipped draft needs no more edits');
// A chip of ANOTHER source must not mask an element token.
assert.equal(P.nextEdit(T1, [{ source: 'file', offset: 0, length: T1.length }]).tag, '<button>', 'a foreign chip does not mask the token');

// -- 4. a malformed token is skipped, never fatal -----------------------------
const BAD = token('\u574fJSON');
assert.equal(P.nextEdit(BAD, []), null, 'a lone malformed token needs no edit (stays plain text)');
assert.equal(P.nextEdit('element' + OPEN + 'HTML Element: <button>', []), null, 'a token with no closing guillemet stays plain text');
const mixed = BAD + ' \u8bf7\u6539 ' + T1;
const after = P.nextEdit(mixed, []);
assert.equal(after.token, T1, 'a good token AFTER a malformed one is still decorated');
assert.equal(mixed.slice(after.start, after.end), T1, 'and its span is still exact');
assert.equal(P.nextEdit('no tokens here at all', []), null, 'plain text needs no edit');
assert.equal(P.nextEdit('', []), null, 'an empty draft needs no edit');
assert.equal(P.nextEdit(null, []), null, 'a null draft needs no edit');

// -- 5. clipboard -> detect folding, with a chip already in the draft ---------
assert.equal(P.foldDetectOffset(100, []), 100, 'no chips = identity');
assert.equal(P.foldDetectOffset(100, [{ offset: 0, length: 4 }]), 97, 'one chip before the offset shifts it by length-1');
assert.equal(P.foldDetectOffset(0, [{ offset: 0, length: 4 }]), 0, 'an offset before the chip is untouched');
assert.equal(P.foldDetectOffset(2, [{ offset: 0, length: 4 }]), null, 'an offset inside a chip has no detect twin');
assert.equal(P.foldDetectOffset(60, [{ offset: 0, length: 4 }, { offset: 20, length: 6 }]), 52, 'two chips accumulate their shift');

// -- 6. the three projections ------------------------------------------------
const registry = P.createRegistry();
registry.remember(T1);
registry.remember(T2);
const src = P.makeSource(registry);
assert.equal(src.trigger, '@', 'the source binds the @ trigger');
assert.equal(src.name, 'element', 'the source name is the serializer routing key');
assert.equal(src.lexicon, undefined, 'no lexicon hook: tokens are chipped by the paste watcher, not by @-decoration');
assert.equal(src.codec.clipboardText(T1), T1, 'the clipboard projection is the token VERBATIM');
assert.equal(src.codec.clipboardText(T2), T2, 'and so is the second one');
const pick = src.onPick({ candidate: { name: '1', value: T1 } });
assert.equal(pick.insert.label, '<button>', 'a pick inserts a <tag> labelled chip');
assert.equal(pick.insert.ref, T1, 'whose ref is the token');
assert.equal(pick.insert.clipboardText, T1, 'and whose clipboard projection is the token');
assert.equal(src.onPick({ candidate: { name: '\u574f', value: BAD } }), undefined, 'a malformed candidate is refused rather than chipped');
assert.equal(src.onPick({ candidate: {} }), undefined, 'a candidate with no value is refused');
assert.deepEqual(registry.list(), [T1, T2], 'the registry lists the tokens in first-seen order');
assert.equal(registry.tagOf(T1), '<button>', 'the registry knows the tag');
assert.equal(registry.pathOf(T1), 'div.card > button.cta', 'and the DOM path, for the menu');
assert.equal(registry.tagOf('never seen'), undefined, 'an unknown token has no tag');
registry.remember(T1);
assert.deepEqual(registry.list(), [T1, T2], 're-remembering the same token is a no-op');
registry.remember('');
registry.remember(null);
assert.deepEqual(registry.list(), [T1, T2], 'an empty token is never remembered');
assert.deepEqual(
  (await src.candidates({ sessionId: 's' }, { query: '<h' })).map((c) => c.label),
  ['<h1>'], 'the @ menu filters by the rendered label'
);
assert.equal((await src.candidates({ sessionId: 's' }, { query: '' })).length, 2, 'an empty query lists every remembered token');

// -- 7. serialize / clipboardText are the identity, and NEVER throw -----------
const one = src.codec.serialize(T1, new AbortController().signal);
assert.ok(one instanceof Promise, 'serialize returns a Promise');
assert.equal(await one, T1, 'the model form of a chip is the token, byte for byte');
assert.equal(await src.codec.serialize(T2), T2, 'serialize works with no signal argument at all');
const sig = new AbortController().signal;
const both = await Promise.all([src.codec.serialize(T1, sig), src.codec.serialize(T2, sig)]);
assert.deepEqual(both, [T1, T2], 'several chips serialize independently, in order, with no appendix');
const same = await Promise.all([src.codec.serialize(T1, sig), src.codec.serialize(T1, sig)]);
assert.deepEqual(same, [T1, T1], 'a repeated chip serializes to itself twice - there is no batch to collapse');
for (const bad of [undefined, null, '', 0, 123, {}, [], true]) {
  const out = await src.codec.serialize(bad);
  assert.equal(typeof out, 'string', 'serialize always resolves to a string');
  assert.ok(!/Error|undefined/.test(out) || out === '', 'no error text leaks for ref ' + JSON.stringify(bad));
}
assert.equal(await src.codec.serialize(undefined), '', 'an absent ref degrades to the empty string');
assert.equal(await src.codec.serialize(null), '', 'a null ref degrades to the empty string');
assert.equal(await src.codec.serialize(123), '123', 'a non-string ref is stringified, never thrown on');
assert.equal(src.codec.clipboardText(undefined), '', 'clipboardText also tolerates a missing ref');
assert.equal(src.codec.clipboardText(123), '123', 'and stringifies a non-string one');
// The unknown-ref probe must not reject: a rejected serialize blocks the whole send.
assert.equal(await src.codec.serialize('el-does-not-exist', sig), 'el-does-not-exist', 'an unknown ref is returned as-is');

// -- 8. the whole draft round-trips byte for byte through the shell's splice ---
// This is the shell's own algorithm (conversation client.js:13969-13985): collect
// every occurrence's serialize text, then splice each one over its clipboard span.
const occurrences = [];
let draft = body;
for (let guard = 0; guard < 16; guard += 1) {
  const edit = P.nextEdit(draft, occurrences);
  if (edit === null) break;
  occurrences.push({
    source: 'element',
    offset: edit.start,
    length: edit.end - edit.start,
    ref: edit.token,
    text: await src.codec.serialize(edit.token)
  });
  occurrences.sort((a, b) => a.offset - b.offset);
}
assert.equal(occurrences.length, 2, 'the watcher converges on exactly the two tokens');
let out = '';
let cursor = 0;
for (const part of occurrences) {
  out += draft.slice(cursor, part.offset) + part.text;
  cursor = part.offset + part.length;
}
out += draft.slice(cursor);
assert.equal(out, body, 'the sent text is the pasted text, byte for byte');
assert.equal(out.trim(), body, 'and trimming changes nothing here');
assert.equal(out.split(T1).length - 1, 1, 'the first token is still in the message, whole');
assert.equal(out.split(T2).length - 1, 1, 'and so is the second');
assert.equal((out.match(/HTML Element: /g) || []).length, 2, 'both HTML Element lines survive');

// -- 9. the token survives a second round trip (dsh-rewind refill) -------------
// The rewind path writes the ALREADY-SERIALIZED message text back into the
// composer. That text is just body + tokens, so the watcher re-chips the very
// same tokens and serialize() returns them unchanged: T(n) === T1, no growth.
const again = [];
for (let guard = 0; guard < 16; guard += 1) {
  const edit = P.nextEdit(out, again);
  if (edit === null) break;
  again.push({ source: 'element', offset: edit.start, length: edit.end - edit.start, text: await src.codec.serialize(edit.token) });
  again.sort((a, b) => a.offset - b.offset);
}
let out2 = '';
let c2 = 0;
for (const part of again) { out2 += out.slice(c2, part.offset) + part.text; c2 = part.offset + part.length; }
out2 += out.slice(c2);
assert.equal(out2, out, 'a round trip through the composer does not grow the text');
assert.equal(out2, body, 'and it is still the original paste');

// -- 10. the history bubble's splitter ---------------------------------------
// The SAME scan feeds the sent-message renderer, so it must agree with nextEdit
// about what a token is, and must never swallow a malformed one.
const runs = P.splitElementTokens('请把 ' + T1 + ' 和 ' + T2 + ' 的样式统一下');
assert.deepEqual(runs.map((r) => r.kind), ['text', 'chip', 'text', 'chip', 'text'], 'two tokens split into text/chip runs');
assert.equal(runs[1].label, '<button>', 'the first chip is labelled with its own tag');
assert.equal(runs[1].token, T1, 'and carries the whole token, for its tooltip');
assert.equal(runs[3].label, '<h1>', 'the second chip too');
assert.equal(runs[0].text, '请把 ', 'the prose before the first chip is untouched');
assert.equal(runs[2].text, ' 和 ', 'so is the prose between the chips');
assert.equal(runs[4].text, ' 的样式统一下', 'and the prose after the last one');
assert.equal(runs.map((r) => r.kind === 'chip' ? r.token : r.text).join(''), '请把 ' + T1 + ' 和 ' + T2 + ' 的样式统一下', 'the runs reconstruct the message byte for byte');
// A message with no token is ONE text run: the bubble then takes exactly the
// pre-existing path (projectUserText over the whole string), which is what keeps
// ordinary messages identical to the built-in renderer.
assert.deepEqual(P.splitElementTokens('just an ordinary message'), [{ kind: 'text', text: 'just an ordinary message' }], 'a token-free message is one text run');
assert.deepEqual(P.splitElementTokens(''), [{ kind: 'text', text: '' }], 'an empty message is one empty run');
assert.deepEqual(P.splitElementTokens(null), [{ kind: 'text', text: '' }], 'a null message is one empty run');
// Safe failure, same rule as nextEdit: an unparseable token stays TEXT and the
// scan continues, so it can neither become a half-rendered chip nor eat T1.
const badRuns = P.splitElementTokens('before ' + BAD + ' after ' + T1 + ' end');
assert.deepEqual(badRuns.map((r) => r.kind), ['text', 'chip', 'text'], 'a malformed token is left inside a text run');
assert.equal(badRuns[0].text, 'before ' + BAD + ' after ', 'and its raw text survives verbatim');
assert.equal(badRuns[1].token, T1, 'the good token after it is still chipped');
const split2 = P.splitElementTokens('a' + T1 + 'b');
assert.equal(split2[0].text + split2[2].text, 'ab', 'the text around a chip loses nothing');

// -- 11. the chip's tooltip body is the token's four lines ---------------------
assert.equal(P.tokenBody(T1), BUTTON, 'the tooltip shows the four lines without the guillemets');
assert.equal(P.tokenBody(T2), HEADING, 'and the same for the second token');
assert.ok(P.tokenBody(T1).indexOf('element') < 0, 'the wrapper word is not part of the tooltip');

// -- 12. the bubble's content splitter ---------------------------------------
// Mirrors ui-chat's contentParts: text is concatenated, attachments are typed,
// and anything unrecognized is kept in the rest bucket so it still renders.
const cp = P.contentParts([{ type: 'text', text: 'a' }, { type: 'image', attachment: 'img-1' }, { type: 'text', text: 'b' }, { type: 'file', attachment: { name: 'x.txt' } }, { type: 'mystery' }]);
assert.equal(cp.text, 'ab', 'text blocks concatenate in order');
assert.deepEqual(cp.attachments.map((a) => a.type), ['image', 'file'], 'images and files become attachments');
assert.deepEqual(cp.attachments[0].image, { attachment: 'img-1' }, 'an image attachment carries its durable reference');
assert.deepEqual(cp.attachments[1].file, { name: 'x.txt' }, 'a file attachment carries its own descriptor');
assert.deepEqual(cp.rest, [{ type: 'mystery' }], 'an unknown block is kept for the extra-content renderer');
// An image/file block with NO attachment reference is not an attachment (the
// shipped rule), so it must not be rendered as an empty gallery either.
const cp2 = P.contentParts([{ type: 'image' }, { type: 'file' }]);
assert.equal(cp2.attachments.length, 0, 'an attachment block without a reference is not an attachment');
assert.equal(cp2.rest.length, 2, 'it falls through to rest instead');
assert.deepEqual(P.contentParts(null), { text: '', attachments: [], rest: [] }, 'absent content is empty');
assert.deepEqual(P.contentParts([]), { text: '', attachments: [], rest: [] }, 'empty content is empty');

// -- 13. the action row's clock ----------------------------------------------
// The templates come from the chat namespace (clock.md / clock.ymd), which the
// entry reuses through the slot's locale option.
const clockT = (key, params) => key === 'clock.md' ? params.m + '/' + params.d : params.y + '-' + params.m + '-' + params.d;
const noon = new Date(2026, 9, 9, 17, 6).getTime();
assert.equal(P.formatClock(noon, clockT, noon), '17:06', 'same day shows HH:mm');
assert.equal(P.formatClock(new Date(2026, 2, 4, 9, 5).getTime(), clockT, noon), '3/4 09:05', 'earlier this year uses clock.md');
assert.equal(P.formatClock(new Date(2025, 2, 4, 9, 5).getTime(), clockT, noon), '2025-3-4 09:05', 'another year uses clock.ymd');
assert.equal(P.formatClock(new Date(2026, 9, 9, 0, 0).getTime(), clockT, noon), '00:00', 'midnight pads to 00:00');
assert.equal(P.formatClock(new Date(2026, 9, 9, 23, 59).getTime(), clockT, noon), '23:59', 'the last minute of the day is 23:59');

// -- 14. the extension card: its slot entry and its subject filter ------------
// The card used to be a global Settings -> Plugins tab; it now lives in
// 'plugins.detail.section', so it must register there and must draw nothing on
// the other detail pages it shares the slot with.
assert.equal(P.extensionEntry.name, 'plugins.detail.section', 'the card registers as a detail-page section, not a settings tab');
assert.equal(P.extensionEntry.id, 'ui-block-extension', 'the cell id is its own, so no shipped entry is replaced');
assert.equal(P.extensionSubjectMatch({ kind: 'bundle', pkg: { name: 'dsh-free-search' } }), false, "another package's detail page gets no card");
assert.equal(P.extensionSubjectMatch({ kind: 'item', id: 'dsh-ui-block' }), false, "an official plugin's page gets no card");
assert.equal(P.extensionSubjectMatch({ kind: 'row', rowId: 'dsh-ui-block' }), false, "a row's page gets no card");
assert.equal(P.extensionSubjectMatch(undefined), false, 'absent props get no card');
assert.equal(P.extensionSubjectMatch(null), false, 'a null subject gets no card');
assert.equal(P.extensionSubjectMatch({ kind: 'bundle', pkg: { name: 'dsh-ui-block', version: '0.2.2', rows: [] } }), true, "dsh-ui-block's own detail page DOES get the card");
// The guard must be the component's first statement, or the filter is decorative.
assert.ok(source.includes('function ExtensionSettingsCard(props) {\n      if (!extensionSubjectMatch('), 'the card guards on the subject before it renders anything');

console.log('dsh-ui-block element-chip self-check: all assertions passed');
