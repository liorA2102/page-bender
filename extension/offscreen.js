// Page Bender — agent-capture poll loop.
//
// An agent (a Claude session driving Chrome) cannot click the toolbar icon,
// so it asks the local server instead: POST /agent/capture queues a job, and
// this loop claims it with a long-poll on GET /agent/next. The capture itself
// needs chrome.scripting and chrome.tabs, which an offscreen document does
// not have, so the job is handed to the service worker as a runtime message
// (which also wakes it if it was asleep) and the result is posted back.
//
// Why here and not in background.js: MV3 kills an idle service worker within
// ~30s, and a loop living there leaves a queued job unclaimed until something
// else happens to wake it. An offscreen document is an ordinary extension
// page and is not torn down. Same arrangement as the Aura Bridge extension,
// where it has been verified to survive idling.

const SERVER = "http://127.0.0.1:8790";
// Custom header on every call. A webpage cannot send it cross-origin without a
// CORS preflight, and the server never approves one for a web origin, so no
// site you happen to have open can claim or answer these jobs.
const HEADERS = { "X-Page-Bender-Agent": "1" };
let running = false;
// Longer than any single drive or capture should take (a settle caps at 15s,
// a page load at 20s), shorter than the server's own wait.
const SW_JOB_CEILING_MS = 100000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// An offscreen document gets only part of chrome.runtime, and calling
// getManifest() inside the poll once threw on every attempt, which the loop
// read as "server unreachable" and retried forever: the worker never polled.
// Read the packaged manifest.json instead, once, and never let this stop
// polling.
let versionPromise = null;
function extensionVersion() {
  if (!versionPromise) {
    versionPromise = fetch(chrome.runtime.getURL("manifest.json"))
      .then((r) => r.json())
      .then((m) => String(m.version || "unknown"))
      .catch(() => "unknown");
  }
  return versionPromise;
}

// ---------- authenticated reads ----------
// Reads URLs with the user's own browser login, for data an agent needs but
// cannot reach from the shell (internal hosts authenticate with HttpOnly
// session cookies). Runs here, not in the service worker: an offscreen
// document's fetch carries the session cookie, verified by the separate Aura
// Bridge extension this mirrors. It is independent of Aura Bridge, which
// keeps working on its own.
//
// Read only: GET, https, no custom headers. Two locks decide which hosts: the
// server checks names from a local, gitignored file, and this side checks the
// SHA-256 of the host name against the fingerprints below, so the public repo
// never names an internal host. Any whole "non-prod" host label is allowed
// too, the same rule the drive actions follow. Adding a host means adding its
// name to server/fetch-hosts.local.json AND its fingerprint here
// (printf %s <host> | shasum -a 256).
const FETCH_HOST_FINGERPRINTS = new Set([
  "fe9fad0ae109fff7982f2d7044e6091808ba1d89a8bd3a8c317b72107af7ae1f",
  "86a0bbcf4324bf4e19867bf784ee35c64a327beb0f4bfd656064cff6710afeae",
  "b63662e2393d2ee7c8bd5c6779a644088e035c21f00d12e9a9a576107c0816d0",
  "b699177b8ebd4586fb1a20835cbf3687d95401f128a86dd641321007df834b75",
]);
const FETCH_TIMEOUT_MS = 30000; // per URL, so one stalled request cannot strand a batch
const FETCH_GAP_MS = 80; // between URLs in a batch, to be polite to the host

async function sha256Hex(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
}

async function fetchHostAllowed(rawUrl) {
  let u;
  try {
    u = new URL(rawUrl);
  } catch {
    return false;
  }
  if (u.protocol !== "https:") return false;
  const host = u.hostname.toLowerCase();
  if (host.split(".").slice(0, -1).includes("non-prod")) return true;
  return FETCH_HOST_FINGERPRINTS.has(await sha256Hex(host));
}

// Never throws and never hangs: one bad URL in a batch must not lose the rest.
async function fetchOne(url) {
  if (!(await fetchHostAllowed(url))) return { url, ok: false, error: "blocked by the extension's host check" };
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS);
  try {
    const r = await fetch(url, { method: "GET", credentials: "include", redirect: "follow", signal: ctl.signal });
    const body = await r.text();
    return { url, ok: r.ok, status: r.status, contentType: r.headers.get("content-type"), body, ...(r.ok ? {} : { error: `HTTP ${r.status}` }) };
  } catch (err) {
    const why = err && err.name === "AbortError"
      ? `timed out after ${FETCH_TIMEOUT_MS / 1000}s (VPN down, or the host is not answering)`
      : `fetch failed: ${err.message}`;
    return { url, ok: false, error: why };
  } finally {
    clearTimeout(timer);
  }
}

async function runFetchJob(job) {
  const results = [];
  const urls = job.urls || [];
  for (let i = 0; i < urls.length; i++) {
    results.push(await fetchOne(urls[i]));
    if (i < urls.length - 1) await sleep(FETCH_GAP_MS);
  }
  return { ok: true, results };
}

async function runJob(job) {
  let result;
  try {
    // The service worker is given a hard ceiling. Without one, a single job
    // that never answered left this loop waiting forever, so the worker
    // stopped polling and every later request timed out too.
    result = job.kind === "fetch"
      ? await runFetchJob(job)
      : await Promise.race([
        chrome.runtime.sendMessage({ type: "PM_AGENT_JOB", job }),
        sleep(SW_JOB_CEILING_MS).then(() => ({ ok: false, error: `service worker gave no answer within ${SW_JOB_CEILING_MS / 1000}s` })),
      ]);
  } catch (err) {
    result = { ok: false, error: `${job.kind === "fetch" ? "fetch job crashed" : "service worker unreachable"}: ${err.message}` };
  }
  await fetch(`${SERVER}/agent/result`, {
    method: "POST",
    headers: { ...HEADERS, "Content-Type": "application/json" },
    body: JSON.stringify({ id: job.id, ...(result || { ok: false, error: "empty result from service worker" }) }),
  });
}

async function loop() {
  if (running) return;
  running = true;
  try {
    for (;;) {
      let res;
      try {
        // The running version rides along, so /agent/health can say which
        // build is actually loaded; "is the reload in effect?" was otherwise
        // a guess.
        res = await fetch(`${SERVER}/agent/next`, { headers: { ...HEADERS, "X-Page-Bender-Version": await extensionVersion() } });
      } catch (err) {
        // Server not running (or restarting after an update). Back off and
        // retry rather than exit, so it recovers by itself. Logged, because
        // a bug here once looked exactly like a server that was down.
        console.warn("[Page Bender] agent poll failed:", err && err.message);
        await sleep(5000);
        continue;
      }
      if (res.status === 200) {
        const job = await res.json().catch(() => null);
        if (job && job.id) await runJob(job).catch(() => {});
        continue;
      }
      if (res.status !== 204) await sleep(5000);
    }
  } finally {
    running = false;
  }
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === "PM_AGENT_KICK") loop();
});

loop();
