/**
 * page-bridge.js — MAIN-world bridge to the WeChat editor's internal JSAPI
 *
 * Runs in the page's main world (a manifest content_scripts entry with
 * "world": "MAIN", document_start) because content scripts live in an isolated
 * world and cannot see page JS globals such as window.__MP_Editor_JSAPI__ —
 * the editor's own internal bridge:
 *
 *   window.__MP_Editor_JSAPI__.invoke({ apiName, apiParam, sucCb, errCb })
 *
 * This file is the only extension code with direct access; it forwards a fixed
 * allowlist of editor calls for content-wechat.js via CustomEvents. The event
 * detail is a JSON string — the cross-world-safe payload shape. MAIN-world
 * scripts get no chrome.* APIs: pure DOM/JS only.
 *
 * Protocol:
 * - request:  document event "expubgo-mp-invoke",  detail = JSON { requestId, apiName, apiParam }
 * - response: document event "expubgo-mp-result", detail = JSON { requestId, ok, value?, error? }
 *
 * The JSAPI is internal and undocumented (may change when WeChat updates the
 * editor) — callers must treat every call as fallible and keep a DOM fallback.
 */

const BRIDGE_INSTALLED_FLAG = '__EXPUBGO_MP_BRIDGE_INSTALLED__'
const INVOKE_EVENT = 'expubgo-mp-invoke'
const RESULT_EVENT = 'expubgo-mp-result'
const ALLOWED_APIS = new Set([
  'mp_editor_get_isready',
  'mp_editor_get_content',
  'mp_editor_set_content',
])

if (!window[BRIDGE_INSTALLED_FLAG]) {
  window[BRIDGE_INSTALLED_FLAG] = true

  document.addEventListener(INVOKE_EVENT, (event) => {
    let request
    try {
      request = JSON.parse(event.detail)
    } catch {
      return
    }
    const { requestId, apiName } = request || {}
    const reply = (payload) => {
      try {
        document.dispatchEvent(new CustomEvent(RESULT_EVENT, {
          detail: JSON.stringify({ requestId, ...payload }),
        }))
      } catch { /* page tearing down — best effort */ }
    }
    if (!ALLOWED_APIS.has(apiName)) {
      reply({ ok: false, error: `api not allowed: ${apiName}` })
      return
    }
    const jsapi = window.__MP_Editor_JSAPI__
    if (!jsapi || typeof jsapi.invoke !== 'function') {
      reply({ ok: false, error: '__MP_Editor_JSAPI__ unavailable' })
      return
    }
    try {
      jsapi.invoke({
        apiName,
        apiParam: request.apiParam || {},
        sucCb: (value) => reply({ ok: true, value: value ?? null }),
        errCb: (err) => reply({
          ok: false,
          error: String(err?.errMsg || err?.message || err || 'jsapi error'),
        }),
      })
    } catch (err) {
      reply({ ok: false, error: String(err?.message || err) })
    }
  })
}
