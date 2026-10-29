// dsh-element-picker background worker.
// No WebSocket, no bridge, no storage. Clicking the toolbar icon injects content.js
// into the active tab and puts it into picker mode. activeTab (granted by that same
// click) is enough for chrome.scripting.executeScript, so no host_permissions needed.

const CONTENT_FILES = ['content.js']

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  if (!tab || tab.id === undefined) throw new Error('No active tab.')
  if (tab.url && !/^(https?|file):/.test(tab.url)) throw new Error('Cannot pick on this page: ' + tab.url)
  return tab
}

async function pick() {
  const tab = await activeTab()
  // allFrames: a picked element often lives in an iframe (the 珍珠滞留 table does), and a
  // top-frame-only content script cannot see it, cannot freeze it, and cannot label it.
  // content.js guards on __dshElementPickerInstalled, so re-injection is idempotent.
  await chrome.scripting.executeScript({ target: { tabId: tab.id, allFrames: true }, files: CONTENT_FILES })
  // Every frame starts listening; the frame that holds the selection paints its own toolbar.
  await chrome.tabs.sendMessage(tab.id, { type: 'dsh-picker-start' })
}

function reportError(error) {
  const message = error && error.message ? error.message : String(error)
  console.warn('[dsh-element-picker]', message)
  try { chrome.action.setBadgeText({ text: '!' }); chrome.action.setBadgeBackgroundColor({ color: '#b91c1c' }) } catch {}
  setTimeout(() => { try { chrome.action.setBadgeText({ text: '' }) } catch {} }, 2500)
}

chrome.action.onClicked.addListener(tab => {
  void pick().catch(reportError)
})

// Test hook: the headless harness cannot synthesize a toolbar-icon click, so it calls
// this to exercise the exact same handler body the listener above invokes.
globalThis.__dshPickerPick = () => pick().catch(reportError)
