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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function runJob(job) {
  let result;
  try {
    result = await chrome.runtime.sendMessage({ type: "PM_AGENT_JOB", job });
  } catch (err) {
    result = { ok: false, error: `service worker unreachable: ${err.message}` };
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
        res = await fetch(`${SERVER}/agent/next`, { headers: HEADERS });
      } catch {
        // Server not running (or restarting after an update). Back off and
        // retry rather than exit, so it recovers by itself.
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
