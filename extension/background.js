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
// current tab.
chrome.action.onClicked.addListener((tab) => {
  chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content.js"] });
});
