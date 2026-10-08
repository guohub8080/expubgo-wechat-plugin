/**
 * background.js — ExPubGo WeChat helper service worker
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * PURPOSE — transparency note, worth reading in full
 * ─────────────────────────────────────────────────────────────────────────────
 * EVERYTHING in this file exists for one user-facing reason: making article
 * images visible in the WeChat Official Account editor PREVIEW. It is preview
 * convenience support for the user's own article-editing workflow — nothing
 * else, and the ONLY thing this worker does.
 *
 * Context: the user writes articles in expubgo (their own publishing tool) and
 * imports them into the WeChat editor (mp.weixin.qq.com) via this extension.
 * Article images are hosted on WeChat's own image CDN — mmbiz.qpic.cn (article
 * images) / mmbiz.qlogo.cn (avatars) — which hotlink-protects them: a request
 * without the editor page's own Referer is served a placeholder image, so the
 * imported article's images appear broken inside the very editor they are
 * destined for. To restore that preview, this worker registers
 * declarativeNetRequest session rules attaching
 * Referer: https://mp.weixin.qq.com/ — byte-for-byte the header the WeChat
 * editor page itself sends — to those image requests. Equivalent to the old
 * interceptor rule set:referer=https://mp.weixin.qq.com/.
 *
 * Deliberately conservative, easily verified scope (check live in
 * chrome://extensions → service worker → console →
 * chrome.declarativeNetRequest.getSessionRules()):
 * - SESSION rules only — temporary by design: they live for the current
 *   browsing session, never persist across browser restarts, and are
 *   re-registered fresh (remove-then-add, idempotent) on onInstalled/onStartup.
 * - Only resourceType 'image' requests to WeChat's own two image hosts
 *   (mmbiz.qpic.cn / mmbiz.qlogo.cn) — nothing else.
 * - Only when the request is initiated from this project's own pages
 *   (INITIATOR_ALLOWLIST below: local dev + the author's publishing-tool
 *   deployments) — never browser-wide.
 * - No request is blocked, redirected, or inspected; these rules collect,
 *   store, and transmit nothing; no remote code is involved.
 * ─────────────────────────────────────────────────────────────────────────────
 */

const INITIATOR_ALLOWLIST = [
  'localhost',                // local dev (expubgo dev preview, pub:serve source, etc.)
  'mp.weixin.qq.com',        // the WeChat editor itself (domain-level match covers all paths; images inside imported content also need the Referer)
  'guohub.top',               // all subdomains (assets.guohub.top etc.); dev.guohub.top tunnel also routes local 6768
  'github.io',                // EVERY GitHub Pages site (platform-wide, like the three hosts below); expubgo mirror lives at guohub8080.github.io/expubgo/
  'pages.dev',                // EVERY Cloudflare Pages site (platform-wide; subdomains included by domain matching)
  'vercel.app',               // every Vercel deployment; custom Vercel domains cannot be enumerated — add them individually if used
  'netlify.app',              // every Netlify site (platform-wide)
  // 127.0.0.1 已删：initiatorDomains 只认域名，IP 永远不匹配（死条目）
]

// ─────────────────────────────────────────────────────────────────────────────
// NETWORK FORWARDING RULES — WeChat editor PREVIEW SUPPORT ONLY (see file
// header for the full story).
//
// Temporary session rules that set the WeChat editor's own Referer on image
// requests, so articles imported into the editor preview with their images
// intact instead of hotlink-protected placeholders. They rewrite exactly one
// request header on exactly two image hosts — no blocking, no redirects, no
// traffic inspection, nothing stored or sent anywhere.
// ─────────────────────────────────────────────────────────────────────────────

// modifyHeaders 的正确形状：action.requestHeaders[]，每项 { header, operation: 'set', value }。
// 没有 setRequestHeaders 这个属性——曾写错导致规则从未注册成功（updateSessionRules 报
// Unexpected property，getSessionRules 恒为 []，Referer 从未被改写）。
const REFERER_RULES = [
  {
    id: 1,
    priority: 1,
    condition: {
      requestDomains: ['mmbiz.qpic.cn'],
      initiatorDomains: INITIATOR_ALLOWLIST,
      resourceTypes: ['image'],
    },
    action: {
      type: 'modifyHeaders',
      requestHeaders: [
        { header: 'Referer', operation: 'set', value: 'https://mp.weixin.qq.com/' },
      ],
    },
  },
  {
    id: 2,
    priority: 1,
    condition: {
      requestDomains: ['mmbiz.qlogo.cn'],
      initiatorDomains: INITIATOR_ALLOWLIST,
      resourceTypes: ['image'],
    },
    action: {
      type: 'modifyHeaders',
      requestHeaders: [
        { header: 'Referer', operation: 'set', value: 'https://mp.weixin.qq.com/' },
      ],
    },
  },
]

async function setupRefererRules() {
  try {
    await chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds: REFERER_RULES.map(r => r.id),
      addRules: REFERER_RULES,
    })
    console.log('[expubgo-helper] 防盗链 Referer 规则已注册（qpic/qlogo 图片）')
  } catch (err) {
    console.error('[expubgo-helper] 规则注册失败:', err)
  }
}

chrome.runtime.onInstalled.addListener(setupRefererRules)
chrome.runtime.onStartup.addListener(setupRefererRules)
setupRefererRules()
