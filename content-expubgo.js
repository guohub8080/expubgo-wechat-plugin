/**
 * content-expubgo.js — content script for the expubgo side
 *
 * Responsibility: forwarder. Listens for the article data (title / subtitle /
 * body HTML / articleId) posted by the "发送至插件" button in the expubgo page,
 * writes it to chrome.storage.local as pendingInject, and leaves it for
 * content-wechat.js on the WeChat editor side to consume.
 *
 * Integration protocol (v2):
 * - The entry button is built into the expubgo shell (the "发送至插件" row of the
 *   ButtonTable action panel); this script no longer injects its own button —
 *   data comes first-hand from the shell (local and network articles alike), and
 *   the body HTML is the same source as the shell's "复制富文本" (network articles
 *   go through the iframe relay)
 * - Message: window.postMessage({ type: 'expubgo-plugin-inject', reqId, payload }, same-origin)
 * - Ack: window.postMessage({ type: 'expubgo-plugin-inject-ack', reqId, ok, error }, same-origin)
 * - Hello probe (detection channel, decoupled from the data path): the shell used to
 *   detect the plugin by sending an empty-payload inject and reading its validation-failure
 *   ack as "installed" — fragile (any future tightening of inject validation, e.g. silently
 *   ignoring payload-less messages, would break detection) and semantically inverted.
 *   Probe: window.postMessage({ type: 'expubgo-plugin-hello', reqId }, same-origin)
 *   Reply: window.postMessage({ type: 'expubgo-plugin-hello-ack', reqId,
 *            protocolVersion: 2, extVersion }, same-origin)
 *   protocolVersion mirrors the inject protocol version above — bump both together.
 *   extVersion is '' when this instance is orphaned (extension reloaded, page not
 *   refreshed): the reply still goes out so "installed but stale" is distinguishable
 *   from "not installed".
 *
 * Runs on localhost, the *.pages.dev / *.vercel.app / *.netlify.app mirrors, and
 * file:// pages (an exported single-page HTML). file:// needs the extension's
 * "Allow access to file URLs" toggle enabled in chrome://extensions, and its
 * origin serializes as either "file://" or the opaque "null" — isSelfMessage
 * below accepts both so the exported page can still talk to the plugin.
 *
 * Stale-instance self-check after an extension reload: reloading the extension
 * does not re-inject into already-open pages, and the old instance's chrome.*
 * bindings all die ("Extension context invalidated"). Check chrome.runtime.id
 * before handling each message; when disconnected, ack ok:false prompting a page
 * refresh instead of throwing an Uncaught Error.
 */

/**
 * Same-origin message guard. The hard check is e.source === window (the exact
 * window this script lives in); origin is belt-and-braces on top of it.
 */
function isSelfMessage(e) {
  if (e.source !== window) return false
  if (e.origin === window.location.origin) return true
  return window.location.protocol === 'file:' && (e.origin === 'file://' || e.origin === 'null')
}

window.addEventListener('message', (e) => {
  if (!isSelfMessage(e)) return
  const data = e.data
  if (!data || data.type !== 'expubgo-plugin-inject' || !data.payload) return

  const ack = (ok, error) => {
    try {
      window.postMessage({ type: 'expubgo-plugin-inject-ack', reqId: data.reqId, ok, error }, window.location.origin)
    } catch { /* page is unloading or a similar edge case — best effort */ }
  }

  const payload = data.payload
  if (typeof payload.html !== 'string' || payload.html === '') {
    ack(false, 'payload 缺少 html')
    return
  }

  // Extension reloaded/disabled: this instance is orphaned; prompt a refresh so the new script takes over
  if (!chrome.runtime?.id) {
    ack(false, '扩展已重载，请刷新本页面（F5）让新版本 content script 生效')
    return
  }

  try {
    chrome.storage.local.set({
      pendingInject: {
        title: payload.title ?? '',
        subtitle: payload.subtitle ?? '',
        html: payload.html,
        articleId: payload.articleId ?? '',
        source: 'expubgo',
        timestamp: payload.timestamp ?? Date.now(),
      },
    }, () => ack(true))
  } catch (err) {
    ack(false, `写入 storage 失败：${err.message}`)
  }
})

// Hello probe handler — presence + version negotiation, zero side effects (never
// touches storage). Kept as a separate listener so the data channel above stays
// untouched; a probe must not depend on the inject validation path in any way.
window.addEventListener('message', (e) => {
  if (!isSelfMessage(e)) return
  const data = e.data
  if (!data || data.type !== 'expubgo-plugin-hello') return

  // Orphaned after an extension reload: chrome.runtime bindings are dead, the
  // manifest is unreachable — extVersion stays '' (see header) instead of throwing
  const extVersion = chrome.runtime?.id ? chrome.runtime.getManifest().version : ''
  try {
    window.postMessage({
      type: 'expubgo-plugin-hello-ack',
      reqId: data.reqId,
      protocolVersion: 2,
      extVersion,
    }, window.location.origin)
  } catch { /* page is unloading or a similar edge case — best effort */ }
})
