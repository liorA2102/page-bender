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
      if (msg.type === "PM_AGENT_JOB") {
        // From offscreen.js: a capture an agent asked for. No tab involved as
        // the sender, so this is dispatched on the job's own target.
        sendResponse(await (msg.job.kind === "drive" ? runAgentDrive(msg.job) : runAgentCapture(msg.job)));
        return;
      }
      if (msg.type === "PM_AGENT_KICK") {
        // Meant for offscreen.js, which listens for it too. Nothing to do
        // here, and no reply, so the offscreen side is not left waiting.
        return;
      }
      sendResponse({ ok: false, error: `unknown message type ${msg.type}` });
    } catch (err) {
      sendResponse({ ok: false, error: err.message });
    }
  })();
  return msg.type !== "PM_AGENT_KICK";
});

// ---------- agent capture ----------
// The tab is named by id when the agent knows it (Claude in Chrome reports
// real tab ids), otherwise by a URL substring, newest matching tab first.
// Ambiguity fails loudly instead of capturing the wrong page.
async function resolveAgentTab(job) {
  if (job.tabId != null) {
    try {
      return await chrome.tabs.get(Number(job.tabId));
    } catch {
      throw new Error(`no tab with id ${job.tabId}`);
    }
  }
  if (job.urlContains) {
    const tabs = (await chrome.tabs.query({})).filter((t) => t.url && t.url.includes(job.urlContains));
    if (!tabs.length) throw new Error(`no open tab whose URL contains "${job.urlContains}"`);
    if (tabs.length > 1) {
      throw new Error(`${tabs.length} tabs match "${job.urlContains}", pass tabId instead: ${tabs.map((t) => `${t.id} ${t.url}`).join(" | ")}`);
    }
    return tabs[0];
  }
  throw new Error("job names no tab: pass tabId or urlContains");
}

async function runAgentCapture(job) {
  try {
    const tab = await resolveAgentTab(job);
    // A tab the agent is driving stays inside the non-prod allowlist for
    // captures too, not only for navigation and clicks.
    if (await isDrivenTab(tab.id)) assertDriveHost(tab.url);
    // captureVisibleTab reads whatever tab is showing in that window, so the
    // target has to be the active one. Window focus is not needed and is
    // left alone, so this does not pull Chrome in front of the user.
    if (!tab.active) {
      await chrome.tabs.update(tab.id, { active: true });
      await new Promise((r) => setTimeout(r, 400));
    }
    const [{ result: injected }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => !!window.__pageMockInjected,
    });
    if (!injected) {
      // Flag first, so content.js keeps its pill hidden on a page the user
      // never activated it on.
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: () => { window.__pbAgentMode = true; } });
      await chrome.scripting.executeScript({ target: { tabId: tab.id, allFrames: true }, files: ["content.js"] });
    }
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: (selector, ref) => (window.__pbAgentCapture
        ? window.__pbAgentCapture(selector, ref)
        : { ok: false, error: "Page Bender on this tab predates agent capture: reload the tab and retry" }),
      args: [job.selector || null, job.ref ?? null],
    });
    return result || { ok: false, error: "capture returned nothing" };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// ---------- agent driving ----------
// Lets an agent navigate and click, so it can find more components to capture
// than anyone opened by hand. Deliberately narrow, because it acts inside the
// user's own logged-in session:
//
// 1. Non-prod hosts only. Every drive action checks the tab's current URL
//    with isNonProdHost, before acting and again after, so a redirect off
//    non-prod (an SSO bounce, a link to prod) stops it. The server keeps its
//    own copy of this rule and checks it too.
// 2. No writes. Each driven tab gets a declarativeNetRequest session rule
//    that blocks every POST, PUT, PATCH and DELETE from it, so a wrong click
//    cannot save, approve or delete anything. The rule id is the tab id,
//    which is also how a driven tab is recognised, so this survives the
//    service worker being restarted.
// 3. Its own window. Driven tabs open in a separate, unfocused window, never
//    in the user's own tabs.
//
// agent-driver.js adds a softer third layer inside the page (refuses
// commit-looking buttons, swallows form submits).
// A host is drivable when "non-prod" is one whole dot-separated label of its
// name, never the last one (app.non-prod.example.com passes;
// non-prod-x.com, xnon-prod.com and prod hosts do not). https only.
const DRIVE_HOST_RULE = "any https host with a whole .non-prod. label";
const WRITE_METHODS = ["post", "put", "patch", "delete"];

function isNonProdHost(hostname) {
  const labels = hostname.toLowerCase().split(".");
  return labels.slice(0, -1).includes("non-prod");
}

function assertDriveHost(rawUrl) {
  let u;
  try {
    u = new URL(rawUrl);
  } catch {
    throw new Error(`not a URL: ${rawUrl}`);
  }
  if (u.protocol !== "https:" || !isNonProdHost(u.hostname)) {
    throw new Error(`refused: ${u.hostname || rawUrl} is not a non-prod host (${DRIVE_HOST_RULE})`);
  }
}

async function drivenTabIds() {
  const rules = await chrome.declarativeNetRequest.getSessionRules();
  return rules.map((r) => r.id);
}

async function isDrivenTab(tabId) {
  return (await drivenTabIds()).includes(tabId);
}

async function blockWrites(tabId) {
  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [tabId],
    addRules: [{
      id: tabId,
      priority: 1,
      action: { type: "block" },
      condition: { tabIds: [tabId], requestMethods: WRITE_METHODS },
    }],
  });
}

chrome.tabs.onRemoved.addListener((tabId) => {
  chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [tabId] }).catch(() => {});
});

function waitForTabLoad(tabId, timeoutMs = 20000) {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      resolve();
    };
    const onUpdated = (id, info) => { if (id === tabId && info.status === "complete") done(); };
    const timer = setTimeout(done, timeoutMs);
    chrome.tabs.onUpdated.addListener(onUpdated);
    // Checked after a beat, not at once: straight after tabs.update the tab
    // can still report "complete" for the page it is leaving.
    setTimeout(() => {
      chrome.tabs.get(tabId).then((t) => { if (t.status === "complete") done(); }).catch(done);
    }, 500);
  });
}

// A short beat after each action so its effects have started (a route change,
// a dialog opening) before snapshotTab waits for the page to go quiet.
const settle = (ms = 300) => new Promise((r) => setTimeout(r, ms));

async function openDriveTab(url) {
  assertDriveHost(url);
  // Reuse the agent window if one already exists, so repeated opens do not
  // scatter windows around the user's screen.
  const existing = await drivenTabIds();
  let windowId = null;
  for (const id of existing) {
    try {
      windowId = (await chrome.tabs.get(id)).windowId;
      break;
    } catch {
      /* stale rule for a closed tab, handled by onRemoved */
    }
  }
  let tab;
  if (windowId != null) {
    tab = await chrome.tabs.create({ windowId, url: "about:blank", active: true });
  } else {
    const win = await chrome.windows.create({ url: "about:blank", focused: false, width: 1440, height: 900 });
    tab = win.tabs[0];
  }
  // The write block goes on before the first request to the real host.
  await blockWrites(tab.id);
  await chrome.tabs.update(tab.id, { url });
  return tab.id;
}

async function requireDrivenTab(tabId) {
  if (tabId == null) throw new Error("pass tabId (from an open action)");
  const id = Number(tabId);
  if (!(await isDrivenTab(id))) throw new Error(`tab ${id} is not an agent-driven tab: open one with action "open"`);
  const tab = await chrome.tabs.get(id);
  assertDriveHost(tab.url);
  return tab;
}

async function injectDriver(tabId) {
  await chrome.scripting.executeScript({ target: { tabId }, files: ["agent-driver.js"] });
}

async function callDriver(tabId, method, arg) {
  await injectDriver(tabId);
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId },
    func: (m, a) => window.__pbDriver[m](a),
    args: [method, arg ?? null],
  });
  // A throw inside the page comes back as an undefined result, not an
  // error, which once let a broken settle pass silently. Make it loud.
  if (result === undefined) throw new Error(`driver "${method}" failed inside the page (check the driven tab's console)`);
  return result;
}

async function snapshotTab(tab) {
  if (!tab.active) {
    await chrome.tabs.update(tab.id, { active: true });
    await settle(400);
  }
  // Wait for the page itself to go quiet (agent-driver.js settle) before
  // reading it. A fixed delay answered while CMS still showed "Loading…".
  const settled = await callDriver(tab.id, "settle");
  const outline = { ...(await callDriver(tab.id, "snapshot")), settled };
  let screenshot = null;
  try {
    screenshot = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
  } catch (err) {
    outline.screenshotError = err.message;
  }
  return { ...outline, screenshot, tabId: tab.id };
}

async function runAgentDrive(job) {
  try {
    const { action } = job;
    if (action === "open") {
      const tabId = await openDriveTab(job.url);
      await waitForTabLoad(tabId);
      await settle();
      return snapshotTab(await requireDrivenTab(tabId));
    }
    if (action === "hosts") return { ok: true, rule: DRIVE_HOST_RULE };
    const tab = await requireDrivenTab(job.tabId);
    let step = { ok: true };
    if (action === "navigate") {
      assertDriveHost(job.url);
      await chrome.tabs.update(tab.id, { url: job.url });
      await waitForTabLoad(tab.id);
      await settle();
    } else if (action === "back") {
      await chrome.tabs.goBack(tab.id);
      await waitForTabLoad(tab.id);
      await settle();
    } else if (action === "click" || action === "hover") {
      if (job.ref == null) throw new Error(`${action} needs a ref from the last snapshot`);
      step = await callDriver(tab.id, action, job.ref);
      if (!step.ok) return step;
      await settle();
    } else if (action === "escape") {
      step = await callDriver(tab.id, "escape");
      await settle();
    } else if (action === "scroll") {
      step = await callDriver(tab.id, "scroll", job.dy);
      await settle();
    } else if (action === "close") {
      await chrome.tabs.remove(tab.id);
      return { ok: true, closed: tab.id };
    } else if (action !== "snapshot") {
      throw new Error(`unknown drive action "${action}"`);
    }
    // Every action answers with a fresh snapshot, re-checked against the
    // allowlist, so the agent always sees where it ended up.
    const after = await requireDrivenTab(tab.id);
    return { ...(await snapshotTab(after)), step };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// Keeps the offscreen poll loop (offscreen.js) alive. Re-checked on every
// service-worker wake and once a minute, because Chrome can close an
// offscreen document on its own, and nothing else would notice.
const OFFSCREEN_URL = "offscreen.html";
async function ensureAgentWorker() {
  try {
    const existing = await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"] });
    if (existing.length) {
      chrome.runtime.sendMessage({ type: "PM_AGENT_KICK" }).catch(() => {});
      return;
    }
    await chrome.offscreen.createDocument({
      url: OFFSCREEN_URL,
      reasons: ["WORKERS"],
      justification: "Keeps a poll loop open against the local Page Bender server so an agent can request a capture.",
    });
  } catch (err) {
    // "Only a single offscreen document" is a harmless race with another wake.
    if (!String(err && err.message).includes("single offscreen")) {
      console.warn("[Page Bender] agent worker unavailable:", err && err.message);
    }
  }
}

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
const AGENT_WORKER_ALARM = "pm-agent-worker";
chrome.alarms.create(AGENT_WORKER_ALARM, { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === VERSION_CHECK_ALARM) checkForUpdate();
  if (alarm.name === AGENT_WORKER_ALARM) ensureAgentWorker();
});
ensureAgentWorker();
