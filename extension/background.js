// Page Bender — background service worker.
//
// Two distinct jobs, from two distinct callers:
// 1. Relay for content.js (running on the live third-party page being
//    captured) — its fetch() would be attributed to THAT page's origin, not
//    chrome-extension://, so it can't call the local server directly.
// 2. Screenshot capture for the mock page itself. The mock page is a normal
//    webpage served by our own local server (same-origin with it, so it
//    calls /prompt, /diff, /save directly, no relay needed) — but capturing
//    tab pixels is an extension-only capability, so that one call comes in
//    via `externally_connectable` (see manifest.json) as an EXTERNAL
//    message, not a content-script message — a different Chrome API
//    (onMessageExternal) than the one content.js uses (onMessage).

const SERVER = "http://127.0.0.1:8790";

async function postJson(pathName, body) {
  const res = await fetch(`${SERVER}${pathName}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `server returned ${res.status}`);
  return data;
}

// From content.js on the live page being captured.
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      if (msg.type === "PM_CAPTURE") {
        const data = await postJson("/capture", { html: msg.html, title: msg.title, url: msg.url, screenshot: msg.screenshot, fontDiagnostics: msg.fontDiagnostics });
        sendResponse({ ok: true, ...data });
        return;
      }
      if (msg.type === "PM_OPEN_PREVIEW") {
        await chrome.tabs.create({ url: msg.url, active: true });
        sendResponse({ ok: true });
        return;
      }
      if (msg.type === "PM_CAPTURE_SCREENSHOT") {
        // Same capability as the mock page's PM_SCREENSHOT below, just
        // reached via the internal (content-script) message channel instead
        // of the external one — content.js runs on the LIVE page being
        // captured, not the mock page, so it never needs externally_connectable.
        if (!sender.tab) throw new Error("no source tab for screenshot request");
        const dataUrl = await chrome.tabs.captureVisibleTab(sender.tab.windowId, { format: "png" });
        sendResponse({ ok: true, dataUrl });
        return;
      }
      if (msg.type === "PM_FETCH_TEXT") {
        // Relay for a cross-origin stylesheet content.js's own fetch() can't
        // read the body of (page-context fetch is bound by the SAME CORS
        // policy that already blocks document.styleSheets[i].cssRules for
        // it). A fetch from THIS context — the extension's background
        // service worker — is a different, less restrictive privilege
        // boundary: Chrome grants it cross-origin response bodies for any
        // host covered by host_permissions ("<all_urls>" here), no CORS
        // header from the server required. Bounded with its own timeout —
        // this used to be a bare fetch with nothing capping it, so a CDN
        // that silently drops the connection instead of erroring (rather
        // than a clean failure) hung the ENTIRE capture indefinitely, with
        // no timeout anywhere upstream either to catch it.
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 8000);
        let res;
        try {
          res = await fetch(msg.url, { signal: controller.signal });
        } finally {
          clearTimeout(timer);
        }
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const text = await res.text();
        sendResponse({ ok: true, text });
        return;
      }
      sendResponse({ ok: false, error: `unknown message type ${msg.type}` });
    } catch (err) {
      sendResponse({ ok: false, error: err.message });
    }
  })();
  return true;
});

// From the mock page itself (a plain webpage matched by
// externally_connectable, not a content script).
chrome.runtime.onMessageExternal.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      if (msg.type === "PM_SCREENSHOT") {
        if (!sender.tab) throw new Error("no source tab for screenshot request");
        const dataUrl = await chrome.tabs.captureVisibleTab(sender.tab.windowId, { format: "png" });
        sendResponse({ ok: true, dataUrl });
        return;
      }
      sendResponse({ ok: false, error: `unknown external message type ${msg.type}` });
    } catch (err) {
      sendResponse({ ok: false, error: err.message });
    }
  })();
  return true;
});

// Toolbar icon click activates (or toggles) the Capture button on the
// current tab. allFrames:true also injects into every same-tab <iframe> —
// content.js checks window.top === window.self and only builds the visible
// pill/section-select UI in the actual top frame; every other frame just
// sits there silently able to bake itself on request (see content.js's
// PBX_BAKE_REQUEST handling), which is what lets a captured page freeze an
// iframe's content instead of leaving it as a live, network-dependent embed.
chrome.action.onClicked.addListener((tab) => {
  chrome.scripting.executeScript({ target: { tabId: tab.id, allFrames: true }, files: ["content.js"] });
});

// Passive update indicator: the server (always running via launchd) is the
// one place that can actually check GitHub and git-pull, so this just polls
// its /version-check endpoint and reflects the result as a badge dot. The
// actual one-click update lives in mock-toolbar.js instead of here, since
// that's a real UI surface with room for an "Update" button — a badge click
// here is already spoken for (it activates capture on the current tab, see
// above), so it stays a passive signal, not a second entry point.
const VERSION_CHECK_ALARM = "pm-version-check";
const VERSION_CHECK_PERIOD_MIN = 30;

async function checkForUpdate() {
  try {
    const res = await fetch(`${SERVER}/version-check`);
    const data = await res.json();
    await chrome.action.setBadgeText({ text: data.updateAvailable ? "!" : "" });
    if (data.updateAvailable) await chrome.action.setBadgeBackgroundColor({ color: "#ff3d92" });
  } catch {
    // Server not running / unreachable — leave the badge as it was; the next
    // alarm retries rather than flipping it off on a transient blip.
  }
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create(VERSION_CHECK_ALARM, { periodInMinutes: VERSION_CHECK_PERIOD_MIN });
  checkForUpdate();
});
chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create(VERSION_CHECK_ALARM, { periodInMinutes: VERSION_CHECK_PERIOD_MIN });
  checkForUpdate();
});
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === VERSION_CHECK_ALARM) checkForUpdate();
});
