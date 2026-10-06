/**
 * content-wechat.js — content script for the WeChat editor side
 *
 * Responsibility: embed the ExPub helper panel into the editor's left sidebar
 * (#js_side_article_list, in the gap between "新建内容" and "历史版本").
 * "一键导入" reads the data staged by the expubgo side's "发送至插件" button from
 * chrome.storage.local and fills in title / digest / body in order.
 *
 * New editor DOM (verified, appmsg_edit_v2):
 * - Title: a ProseMirror contenteditable (.ProseMirror[data-placeholder="请在这里输入标题"])
 * - Body: another ProseMirror (no data-placeholder, min-height ~570px)
 * - Digest: #js_description textarea (name="digest", Vue-controlled, maxlength 120)
 * Legacy UEditor selectors (#title / #digest / .edui-body-container) are kept as fallback.
 *
 * Body fill strategy (preferred → fallback):
 * - Preferred: the editor's own JSAPI (window.__MP_Editor_JSAPI__, reached through
 *   page-bridge.js in the MAIN world) — mp_editor_set_content runs through the
 *   editor's ProseMirror pipeline, so the doc stays consistent, nothing fights
 *   back, and save reads the right content
 * - Fallback: source-level DOM replacement (el.innerHTML = html, bypassing the
 *   rich-text sanitizing pipeline — raw tags such as interactive SVG land as-is)
 *   + code lock + save hook; only taken when the JSAPI is unavailable
 * - Title: source-level replacement in both cases (plain contenteditable / textarea)
 * - Digest textarea: native setter assignment + dispatch input/change (triggers Vue state sync)
 */

// ── Fill helpers ──

/** Set a textarea's value and trigger framework events (Vue/React-controlled fields need the native setter) */
function setNativeValue(el, value) {
  const setter = Object.getOwnPropertyDescriptor(
    el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype,
    'value',
  )?.set
  setter?.call(el, value)
  el.dispatchEvent(new Event('input', { bubbles: true }))
  el.dispatchEvent(new Event('change', { bubbles: true }))
}

/** Title editor: new editor = the title ProseMirror; legacy = #title textarea */
function findTitleEditor() {
  const pm = [...document.querySelectorAll('.ProseMirror[contenteditable="true"]')]
    .find(el => (el.dataset.placeholder ?? '').includes('标题'))
  return pm ?? document.querySelector('#title')
}

/** Body editor: the CDP-verified anchor = the body ProseMirror (no data-placeholder,
    class ProseMirror-hideselection); fallback = the visible contenteditable (title
    excluded) holding the most content (the body always has the most text) */
function findBodyEditor() {
  const title = findTitleEditor()
  const exact = document.querySelector('.ProseMirror:not([data-placeholder])')
  if (exact && exact !== title) return exact
  const candidates = [...document.querySelectorAll('[contenteditable="true"]')]
    .filter(el => el !== title && el.offsetParent !== null)
  if (candidates.length === 0) return null
  return candidates.sort((a, b) => (b.textContent ?? '').length - (a.textContent ?? '').length)[0]
}

/** Digest input: new editor = #js_description; legacy = #digest */
function findDigestEditor() {
  return document.querySelector('#js_description') ?? document.querySelector('#digest')
}

/** The digest may live inside a collapsed section: if the input is not found, click the "摘要" label to expand it */
async function tryExpandDigest() {
  if (findDigestEditor()) return
  const labels = [...document.querySelectorAll('label,span,div')]
  const digestLabel = labels.find(el => el.textContent?.trim() === '摘要')
  if (digestLabel) digestLabel.click()
  await new Promise(r => setTimeout(r, 300))
}

/** Clear a contenteditable's existing content (select all, then delete) */
function clearEditable(el) {
  el.focus()
  document.execCommand('selectAll', false, null)
  document.execCommand('delete', false, null)
}

/**
 * Source-level replacement: set the DOM directly (el.innerHTML = html), bypassing
 * the editor's rich-text sanitizing pipeline — same shape as "copy HTML source →
 * import via a third-party tool"; raw tags such as interactive SVG land in the
 * editor as-is. ProseMirror has a view-sync mechanism that may revert external DOM
 * changes: if the content is reverted after assignment (innerHTML unchanged),
 * automatically fall back to the paste route.
 */
function replaceSource(el, html, { asText = false } = {}) {
  el.focus()
  if (asText) el.textContent = html
  else el.innerHTML = html
  // A plain Event('input') is not recognized by PM (the
  // view sync reverts it) — it must be InputEvent + inputType + change, the same
  // write principle used for importing the body
  el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertHTML', data: null }))
  el.dispatchEvent(new Event('change', { bubbles: true }))
  return true
}

// ── Editor JSAPI channel (preferred body write route) ──
// The editor page exposes an internal bridge of its own:
//   window.__MP_Editor_JSAPI__.invoke({ apiName, apiParam, sucCb, errCb })
// Calls run through the editor's ProseMirror pipeline, so the doc stays consistent —
// no view-sync offense/defense, no lock, save just reads the right content. The API is
// internal & undocumented, may change when WeChat
// updates the editor — hence the DOM+lock fallback below.
// That object lives in the page's MAIN world, invisible from this isolated-world
// script, so calls are forwarded through page-bridge.js (a separate manifest
// content_scripts entry with "world": "MAIN") via CustomEvents carrying a
// JSON-string detail (the cross-world-safe payload shape).

const MP_INVOKE_EVENT = 'expubgo-mp-invoke'
const MP_RESULT_EVENT = 'expubgo-mp-result'
let mpRequestId = 0

function invokeMpEditorApi(apiName, apiParam = {}, timeoutMs = 8000) {
  return new Promise((resolve) => {
    const requestId = `expubgo-req-${Date.now()}-${++mpRequestId}`
    let settled = false
    const finish = (result) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      document.removeEventListener(MP_RESULT_EVENT, onResult)
      resolve(result)
    }
    const onResult = (event) => {
      let data
      try { data = JSON.parse(event.detail) } catch { return }
      if (!data || data.requestId !== requestId) return
      finish(data.ok ? { ok: true, value: data.value } : { ok: false, error: data.error })
    }
    const timer = setTimeout(() => finish({ ok: false, error: `jsapi timeout: ${apiName}` }), timeoutMs)
    document.addEventListener(MP_RESULT_EVENT, onResult)
    try {
      document.dispatchEvent(new CustomEvent(MP_INVOKE_EVENT, {
        detail: JSON.stringify({ requestId, apiName, apiParam }),
      }))
    } catch (err) {
      finish({ ok: false, error: String(err?.message || err) })
    }
  })
}

/** Probe the official editor API: true only when the bridge + JSAPI are live and
    the new editor reports ready ({isReady, isNew}). Short timeout on purpose —
    a miss (bridge missing, old editor, page busy) just means "take the fallback
    route" instead of stalling the click. */
async function editorJsapiReady() {
  const probe = await invokeMpEditorApi('mp_editor_get_isready', {}, 3000)
  if (!probe.ok) return false
  const value = probe.value || {}
  return value.isReady !== false && value.isNew !== false
}

// ── Source replacement engine — the FALLBACK route (offense/defense
//    architecture, finalized via CDP testing) ──
// Takes over only when the editor JSAPI above is unavailable (old editor, bridge
// missing, page not refreshed after an extension reload). A single direct write
// is always reverted by ProseMirror's view sync (InputEvent makes no difference);
// the save pipeline reads the PM doc.
// The working approach = a three-part combo:
//   1) Write: innerHTML direct write + InputEvent('input',{inputType:'insertHTML'}) + change
//   2) Code-lock observer: watch the root's parent (the root itself gets swapped out
//      wholesale by PM) and re-write the target source after the platform refreshes
//      (a multi-stage 0–3000ms rewrite cascade — PM repaints arrive in asynchronous waves)
//   3) Save hook: capture-phase interception of "保存/发表/预览" clicks and Cmd/Ctrl+S;
//      rewrite once more before letting them through, so the save request reads exactly
//      our source (the decisive step that makes the save effective)

const strictLock = {
  enabled: false,      // armed? (stays true from import/clear until the save)
  canonicalHtml: null, // the target source (clear = an empty shell section)
  applying: false,     // self-write in progress; the observer ignores it
  lastApplyAt: 0,      // last write time — defines the post-write observation silence window (applying is already reset once the observer's async callback fires, so the time window is the backstop)
  writeCount: 0,       // rewrite count — a fuse against infinite loops (PM normalizes the DOM string on every pass; strict comparison would loop the offense/defense forever)
  observer: null,
  observedParent: null,
  saveHooked: false,
  timers: [],
  debounceTimer: 0,
}

const LOCK_SILENCE_MS = 800   // post-write silence window: observer hits inside it are ignored outright
const LOCK_MAX_WRITES = 20    // fuse: exceeding the cumulative rewrite limit while armed disarms the lock with a warning

/**
 * Semantic satisfaction check: PM normalizes the DOM on every pass (attributes /
 * whitespace / auto-closed tags), so string equality never holds — a strict
 * comparison would loop the offense/defense forever (the root cause of users having
 * to click many times). Instead judge "has the target state been substantially
 * reached":
 * - Empty-shell target (clear): satisfied once the visible text is very short
 * - Content target (import): satisfied once the current HTML contains a signature
 *   slice of canonical, or its length is close
 */
function lockSatisfied(currentHtml) {
  const c = strictLock.canonicalHtml ?? ''
  if (currentHtml === c) return true
  const textLen = (s) => s.replace(/<[^>]+>/g, '').replace(/\s|\u00a0|<br\/?>/gi, '').length
  if (textLen(c) === 0) {
    // Empty-shell target: sufficiently empty is fine (PM normalization may yield an
    // equivalent form such as <p><br></p>)
    return textLen(currentHtml) < 20
  }
  // Content target: contains a signature slice (from canonical's middle, avoiding the
  // head which is most easily rewritten)
  const probe = c.length > 200 ? c.slice(80, 160) : c.slice(0, Math.min(60, c.length))
  if (probe && currentHtml.includes(probe)) return true
  return Math.abs(currentHtml.length - c.length) < Math.max(300, c.length * 0.05)
}

function applyHtmlToRoot(html) {
  const root = findBodyEditor()
  if (!root) return false
  strictLock.applying = true
  strictLock.lastApplyAt = Date.now()
  strictLock.writeCount += 1
  try {
    // Do NOT focus: focusing triggers PM's selection/focus sync → an immediate
    // repaint reverts what was just written (the root cause of "one click fails, two
    // clicks work" — the second click lands in the quiet period after PM's repaint)
    root.innerHTML = html
    root.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertHTML', data: null }))
    root.dispatchEvent(new Event('change', { bubbles: true }))
  } finally {
    strictLock.applying = false
  }
  if (strictLock.writeCount > LOCK_MAX_WRITES) {
    console.warn('[expubgo] 代码锁熔断（回写超限，可能存在规范化抖动）——已停锁，保存前将不再自动重写')
    disarmStrictLock()
  }
  return true
}

/** Arm the code lock: write the target source and start watching for platform refreshes */
function armStrictLock(html) {
  disarmStrictLock()
  strictLock.enabled = true
  strictLock.canonicalHtml = html
  strictLock.writeCount = 0
  // Immediate + dense top-up writes: PM repaints in multiple waves (focus /
  // transaction / idle each bring one); top up once after each wave
  for (const delay of [0, 200, 500, 1000, 1800, 3000]) {
    strictLock.timers.push(setTimeout(() => {
      if (!strictLock.enabled) return
      applyHtmlToRoot(strictLock.canonicalHtml)
    }, delay))
  }
  ensureLockObserver()
  ensureSaveHook()
}

function ensureLockObserver() {
  const root = findBodyEditor()
  const parent = root?.parentElement
  if (!root || !parent) return
  if (strictLock.observer && strictLock.observedParent === parent) return
  if (strictLock.observer) strictLock.observer.disconnect()
  strictLock.observedParent = parent
  strictLock.observer = new MutationObserver(() => {
    if (!strictLock.enabled || strictLock.applying) return
    // Silence window: ignore observer echoes of our own just-finished write
    if (Date.now() - strictLock.lastApplyAt < LOCK_SILENCE_MS) return
    const current = findBodyEditor()
    if (!current) return
    // Semantically satisfied: the target state is substantially reached
    // (PM-normalized forms count too) — no rewrite
    if (lockSatisfied(current.innerHTML)) return
    // Debounced rewrite (600ms): a burst of triggers schedules only one
    clearTimeout(strictLock.debounceTimer)
    strictLock.debounceTimer = setTimeout(() => {
      if (!strictLock.enabled) return
      applyHtmlToRoot(strictLock.canonicalHtml)
    }, 600)
  })
  // Observe only the parent (subtree still covers the root's interior; the root
  // itself gets swapped out wholesale by PM, so only the parent can see that)
  strictLock.observer.observe(parent, { childList: true, subtree: true })
}

function ensureSaveHook() {
  if (strictLock.saveHooked) return
  strictLock.saveHooked = true
  const onSaveIntent = (event) => {
    if (!strictLock.enabled) return
    const control = event.target?.closest?.("button, a, [role='button']")
    if (!control) return
    const label = String(control.textContent || '').replace(/\s+/g, '')
    if (!/^(保存|保存为草稿|保存草稿|发布|发表)$/.test(label)) return
    // Rewrite first before letting it through, so the save request reads the target source
    strictLock.writeCount = 0 // reset the fuse count ahead of the save
    applyHtmlToRoot(strictLock.canonicalHtml)
  }
  const onSaveShortcut = (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's' && strictLock.enabled) {
      strictLock.writeCount = 0
      applyHtmlToRoot(strictLock.canonicalHtml)
    }
  }
  document.addEventListener('click', onSaveIntent, true)
  document.addEventListener('keydown', onSaveShortcut, true)
}

/** Disarm the lock: released after a successful save / explicit user intervention,
    and ALWAYS before a new body write — a stale canonical from an earlier import
    would otherwise revert the new content through the observer. */
function disarmStrictLock() {
  strictLock.enabled = false
  strictLock.canonicalHtml = null
  for (const t of strictLock.timers) clearTimeout(t)
  strictLock.timers = []
  clearTimeout(strictLock.debounceTimer)
}

// ── Body operations: JSAPI first, DOM+lock fallback ──

const sleep = (ms) => new Promise(r => setTimeout(r, ms))

/** Wait for the editor to finish its chunked async initialization before acting
    (writes made mid-load get drowned by chunks still pouring in — verified
    pitfall). Signal: the body element's visible text length settling across two
    consecutive reads; gives up after ~3s. */
async function waitForStableDoc() {
  let prev = findBodyEditor()?.textContent?.length ?? -1
  for (let i = 0; i < 10; i++) {
    await sleep(300)
    const cur = findBodyEditor()?.textContent?.length ?? -1
    if (cur === prev) return true
    prev = cur
  }
  return false
}

/** Clear the body: preferred = editor JSAPI set_content with a minimal empty
    paragraph (through the editor's own pipeline, doc instantly consistent);
    fallback = lock + empty shell section on the DOM route. */
async function clearBody() {
  disarmStrictLock()
  if (await editorJsapiReady()) {
    const result = await invokeMpEditorApi('mp_editor_set_content', { content: '<p><br/></p>' }, 8000)
    if (result.ok) return 'jsapi'
  }
  armStrictLock('<section><br/></section>')
  return 'lock'
}

/** Write the body: preferred = editor JSAPI set_content (full replacement through
    the editor's own pipeline — no offense/defense at all); fallback = arm the code
    lock (direct writes + top-ups + save hook) on the DOM route. */
async function writeBody(html) {
  disarmStrictLock()
  if (await editorJsapiReady()) {
    const result = await invokeMpEditorApi('mp_editor_set_content', { content: html }, 8000)
    if (result.ok) return 'jsapi'
  }
  armStrictLock(html)
  return 'lock'
}

// ── Sidebar-embedded panel (js_side_article_list: the gap between "新建内容" and
//    "历史版本") ──
// Fully hand-drawn with inline styles; no WeChat class is reused (reuse gets
// polluted by its contextual styles); the look aligns with the sidebar cards.

const EXPUB_PANEL_ID = 'expubgo-side-panel'

function createSidePanel() {
  const panel = document.createElement('div')
  panel.id = EXPUB_PANEL_ID
  // all:unset first cuts off WeChat's global style bleed, then write our own styles
  // item by item (hardcoded, depending on no WeChat class)
  panel.style.all = 'unset'
  panel.style.display = 'block'
  panel.style.boxSizing = 'border-box'
  panel.style.margin = '12px 0 0'
  panel.style.background = '#fff'
  panel.style.border = '1px solid #e7e7eb'
  panel.style.borderRadius = '4px'
  panel.style.padding = '14px'
  panel.style.fontFamily = '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif'
  panel.style.fontSize = '12px'
  panel.style.color = '#333'

  // Header row: icon (expubgo logo) + ExPubGo微信助手
  const header = document.createElement('div')
  header.style.cssText = `display:flex;align-items:center;gap:6px;font-weight:600;font-size:13px;color:#333;margin-bottom:4px;`
  header.innerHTML = `
    <svg width="16" height="16" viewBox="0 0 595.3 596.1" xmlns="http://www.w3.org/2000/svg" style="flex-shrink:0;">
      <path fill="#fff" d="M297.6,20.3L51.6,162.3v284.1l246,142,246-142V162.3L297.6,20.3Z"/>
      <path fill="#1976D2" d="M106.3,225.4v189.4l164,94.7v-189.4l-164-94.7ZM243,51.8l54.7-31.6,246,142v31.6l-218.7,126.3v189.4s164-94.7,164-94.7v-63.1l-109.3,63.1v-63.1l164-94.7v189.4s-246,142-246,142L51.6,446.4V162.3l27.3-15.8,218.7,126.3,164-94.7L243,51.8Z"/>
      <polygon fill="#4DD0E1" points="79 146.5 297.6 20.3 297.6 272.8 79 146.5"/>
    </svg>
    ExPubGo微信助手
  `

  // Status area (staged article info / import result)
  const status = document.createElement('div')
  status.style.cssText = `color:#1976D2;font-size:12px;line-height:1.6;margin-bottom:12px;min-height:32px;word-break:break-all;`
  status.textContent = '读取暂存数据…'

  // Button row: three at the bottom right — 清空编辑器 / 取消暂存 (white, secondary)
  // + 一键导入 (primary); the primary button is grey/disabled while there is no data
  const btnRow = document.createElement('div')
  btnRow.style.cssText = `display:flex;justify-content:flex-end;align-items:center;gap:8px;`

  const mkSecondaryBtn = (text) => {
    const b = document.createElement('button')
    b.type = 'button'
    b.textContent = text
    b.style.cssText = `
      display:inline-flex;align-items:center;justify-content:center;
      height:36px;padding:0 18px;
      border:1px solid #dcdcdc;border-radius:4px;
      background:#fff;color:#666;font-size:13px;font-weight:500;
      cursor:pointer;font-family:inherit;line-height:1;
      transition:border-color .2s,color .2s;
    `
    b.onmouseenter = () => { b.style.borderColor = '#07c160'; b.style.color = '#07c160' }
    b.onmouseleave = () => { b.style.borderColor = '#dcdcdc'; b.style.color = '#666' }
    return b
  }
  const btnClear = mkSecondaryBtn('清空编辑器')
  btnClear.style.marginRight = 'auto' // auto margin pins it left while the row stays right-aligned
  const btnCancel = mkSecondaryBtn('取消暂存')

  const btn = document.createElement('button')
  btn.type = 'button'
  btn.textContent = '一键导入'
  btn.style.cssText = `
    display:inline-flex;align-items:center;justify-content:center;
    height:36px;padding:0 18px;
    border:none;border-radius:4px;
    background:#e7e7eb;color:#aaa;font-size:13px;font-weight:500;
    cursor:not-allowed;font-family:inherit;line-height:1;
    transition:background .2s;
  `
  btn.disabled = true
  btn.onmouseenter = () => { if (!btn.disabled) btn.style.background = '#06ad56' }
  btn.onmouseleave = () => { if (!btn.disabled) btn.style.background = '#07c160' }
  btnRow.appendChild(btnClear)
  btnRow.appendChild(btnCancel)
  btnRow.appendChild(btn)

  panel.appendChild(header)
  panel.appendChild(status)
  panel.appendChild(btnRow)
  return { panel, status, btn, btnClear, btnCancel }
}

/** Toggle button availability: staged data present = WeChat green, clickable; none = grey disabled */
function setBtnEnabled(btn, enabled) {
  btn.disabled = !enabled
  if (enabled) {
    btn.style.background = '#07c160'
    btn.style.color = '#fff'
    btn.style.cursor = 'pointer'
  } else {
    btn.style.background = '#e7e7eb'
    btn.style.color = '#aaa'
    btn.style.cursor = 'not-allowed'
  }
}

async function refreshStatus(status, btn) {
  const { pendingInject } = await chrome.storage.local.get('pendingInject')
  if (pendingInject) {
    const age = Math.floor((Date.now() - pendingInject.timestamp) / 1000)
    const ageStr = age < 60 ? `${age}秒前` : `${Math.floor(age / 60)}分钟前`
    status.innerHTML = `<span style="display:inline-block;margin-top:6px;padding:2px 10px;border-radius:999px;background:#1565C0;color:#fff;font-size:12px;font-weight:500;line-height:1.4;vertical-align:1px;">就绪</span> <strong style="color:#1565C0;font-size:13px;">${pendingInject.title?.slice(0, 16)}</strong><span style="display:block;color:#aaa;font-size:11px;margin-top:6px;">${ageStr}前已暂存至插件</span>`
    if (btn) setBtnEnabled(btn, true)
  } else {
    status.textContent = '暂无暂存数据'
    if (btn) setBtnEnabled(btn, false)
  }
}



/** Clear the editor: wipe title, body, and digest (description) — body via the same
    JSAPI-first engine as import, title/digest via the same DOM primitives */
async function doClearEditor(status) {
  try {
    // Acting while chunked editor initialization is still unsettled gets drowned by
    // the chunks still pouring in (verified pitfall)
    if (!(await waitForStableDoc())) {
      status.textContent = '编辑器仍在初始化（内容分片加载中），稍等几秒再点'
      status.style.color = '#C62828'
      return
    }
    const cleared = []
    // 1. Body first: JSAPI set_content lands in one step through the editor's own
    //    pipeline (fallback: lock + empty shell on the DOM route)
    await clearBody()
    cleared.push('正文')
    // 2. Title (the same source-replacement primitive)
    const titleEl = findTitleEditor()
    if (titleEl) {
      if (titleEl.tagName === 'TEXTAREA') setNativeValue(titleEl, '')
      else replaceSource(titleEl, '', { asText: true })
      cleared.push('标题')
    }
    // 3. Digest (may live inside a collapsed section; the expand-and-wait goes last)
    await tryExpandDigest()
    const digestEl = findDigestEditor()
    if (digestEl) {
      setNativeValue(digestEl, '')
      cleared.push('摘要')
    }
    status.innerHTML = `已清空：${cleared.join('、') || '无可清区域'}`
    status.style.color = '#1976D2'
    // Restore the status area's regular display (staged capsule / "no data") after 3s
    setTimeout(() => refreshStatus(status, null), 3000)
  } catch (err) {
    console.error('[expubgo-clear]', err)
    status.textContent = `清空失败：${err.message}`
    status.style.color = '#C62828'
  }
}

/** Cancel staging: clears only the plugin-internal pendingInject; the editor's current content stays untouched */
async function doCancelPending(status, btn) {
  try {
    await chrome.storage.local.remove('pendingInject')
    // Let the button/status settle first (the storage event also triggers one
    // refresh), then write the operation feedback text
    await refreshStatus(status, btn)
    status.textContent = '已取消暂存（编辑器内容未动）'
    status.style.color = '#1976D2'
    // Restore the status area's regular display (staged capsule / "no data") after 3s
    setTimeout(() => refreshStatus(status, null), 3000)
  } catch (err) {
    console.error('[expubgo-cancel]', err)
    status.textContent = `取消失败：${err.message}`
    status.style.color = '#C62828'
  }
}

async function doImport(btn, status) {
  const original = btn.textContent
  try {
    btn.textContent = '导入中…'
    btn.disabled = true

    const { pendingInject } = await chrome.storage.local.get('pendingInject')
    if (!pendingInject) {
      status.textContent = '没有暂存数据：请先在 expubgo 点「发送至插件」'
      status.style.color = '#C62828'
      btn.textContent = original
      btn.disabled = false
      return
    }

    const { title, subtitle, html } = pendingInject
    const filled = []
    const missed = []

    // Initialization stability check (acting mid-chunk-load gets drowned out)
    if (!(await waitForStableDoc())) {
      status.textContent = '编辑器仍在初始化（内容分片加载中），稍等几秒再点'
      status.style.color = '#C62828'
      btn.textContent = original
      btn.disabled = false
      return
    }

    // 1. Body first: JSAPI set_content = full replacement through the editor's own
    //    pipeline (fallback: direct write + code lock on the DOM route)
    if (html) {
      await writeBody(html)
      filled.push('正文')
    } else {
      missed.push('正文')
    }

    // 2. Title (ProseMirror or legacy #title) — the same source-replacement primitive
    const titleEl = findTitleEditor()
    if (titleEl && title) {
      if (titleEl.tagName === 'TEXTAREA') {
        setNativeValue(titleEl, title)
      } else {
        replaceSource(titleEl, title, { asText: true })
      }
      filled.push('标题')
    } else {
      missed.push('标题')
    }

    // 3. Digest (#js_description or legacy #digest; may live inside a collapsed
    //    section, the expand-and-wait goes last)
    await tryExpandDigest()
    const digestEl = findDigestEditor()
    if (digestEl && subtitle) {
      setNativeValue(digestEl, subtitle.slice(0, 120))
      filled.push('摘要')
    } else if (subtitle) {
      missed.push('摘要')
    }

    // Staging is kept: no auto-clear — the article can be re-imported/compared; the
    // "取消暂存" button is the explicit clear

    const missedTip = missed.length ? `<br><span style="color:#C62828;">未填充：${missed.join('、')}</span>` : ''
    status.innerHTML = `已导入${filled.join('、')}${missedTip}`
    status.style.color = '#2E7D32'
    btn.textContent = '✓ 已导入'
    btn.style.background = '#2E7D32'

    setTimeout(() => {
      btn.textContent = original
      btn.disabled = false
      refreshStatus(status, btn)
    }, 3000)
  } catch (err) {
    console.error('[expubgo-import]', err)
    status.textContent = `导入失败：${err.message}`
    status.style.color = '#C62828'
    btn.textContent = original
    btn.disabled = false
  }
}

/** Insert the panel: sidebar js_side_article_list, in the gap between "新建内容"
    (#add_appmsg_container) and "历史版本" (remain_modify_count / js_editor_history_bar) */
let panelRefs = null // { status, btn } — refresh directly on storage changes without DOM queries

function mountPanel() {
  const sideList = document.querySelector('#js_side_article_list')
  if (!sideList) return
  if (document.getElementById(EXPUB_PANEL_ID)) return
  const { panel, status, btn, btnClear, btnCancel } = createSidePanel()
  // Insertion anchor: before remain_modify_count (the spacer above the history
  // section); if not found, append to the sidebar's end
  const anchor = sideList.querySelector('.remain_modify_count') ?? sideList.querySelector('#js_editor_history_bar')?.parentElement
  if (anchor && anchor.parentElement === sideList) {
    sideList.insertBefore(panel, anchor)
  } else {
    sideList.appendChild(panel)
  }
  btn.onclick = () => doImport(btn, status)
  btnClear.onclick = () => doClearEditor(status)
  btnCancel.onclick = () => doCancelPending(status, btn)
  panelRefs = { panel, status, btn }
  refreshStatus(status, btn)
}

/**
 * Live sync on storage changes: the moment the expubgo side's "发送至插件" writes
 * pendingInject, this page (the editor) senses it with no refresh — the panel
 * status refreshes automatically plus a border highlight pulse; after consumption
 * (remove) the status falls back to "none".
 */
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes.pendingInject) return
  if (!panelRefs || !document.getElementById(EXPUB_PANEL_ID)) return
  const { panel, status, btn } = panelRefs
  refreshStatus(status, btn)
  if (changes.pendingInject.newValue) {
    // New data arrived: flash the border green twice
    panel.style.transition = 'box-shadow .4s'
    panel.style.boxShadow = '0 0 0 3px rgba(7, 193, 96, .55)'
    setTimeout(() => (panel.style.boxShadow = '0 0 0 3px rgba(7, 193, 96, .2)'), 400)
    setTimeout(() => (panel.style.boxShadow = '0 0 0 3px rgba(7, 193, 96, .55)'), 800)
    setTimeout(() => (panel.style.boxShadow = 'none'), 1200)
  }
})

// ── Startup: the WeChat page renders asynchronously; keep observing so the panel
//    mounts when the container appears and remounts after a re-render removes it ──

const mountObserver = new MutationObserver(() => mountPanel())
mountObserver.observe(document.body, { childList: true, subtree: true })
mountPanel()
