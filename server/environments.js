// Finding a running one-click copy of a product for the agent to explore.
//
// Page Bender never creates, wakes, extends or deletes an environment: it
// only picks one that is already up. The list comes from the team's one-click
// environment service, reached through a short Agent SDK run that uses that
// service's MCP server from the user's own Claude Code setup, so it reuses the
// sign-in Claude Code already holds and no token lives here.
//
// Everything that names an internal host or service lives in
// environments.local.json (gitignored; see environments.example.json),
// because this repo is public.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { query } from "@anthropic-ai/claude-agent-sdk";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_FILE = path.join(__dirname, "environments.local.json");
const CACHE_FILE = path.join(__dirname, "environments.cache.local.json");
const CHOICE_FILE = path.join(__dirname, "environments.choice.local.json");

// Stale-while-revalidate: a request older than this returns the cached list
// at once and refreshes behind it, so nobody waits on an agent run.
const LIST_MAX_AGE_MS = 5 * 60 * 1000;
const MIN_TIME_LEFT_MS = 2 * 60 * 60 * 1000;
const ANSWER_TIMEOUT_MS = 6000;

// Built-in tools the list run must not reach for. allowedTools only
// pre-approves tools; it does not restrict them, and an unrestricted run
// wandered into the shell and a sub-agent. Tool search is switched off for
// the run (see fetchListFromService), so the list tool is loaded up front.
const DENIED_TOOLS = [
  "Bash", "BashOutput", "KillShell", "Agent", "Task", "Read", "Write", "Edit", "Glob", "Grep",
  "WebFetch", "WebSearch", "NotebookEdit", "TodoWrite", "Skill", "RemoteTrigger",
  "CronCreate", "CronDelete", "CronList", "ScheduleWakeup", "SendMessage", "Monitor",
];

export function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
  } catch {
    return null;
  }
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJson(file, value) {
  fs.writeFileSync(file, JSON.stringify(value, null, 2), "utf8");
}

// "cms-{env}.example.com" -> "cms-navy.example.com", and back.
function hostFor(product, env) {
  return product.envHost.replace("{env}", env);
}

function envFromHost(product, host) {
  const [before, after] = product.envHost.split("{env}");
  const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = new RegExp(`^${escape(before)}([a-z][a-z0-9-]*)${escape(after)}$`).exec(host.toLowerCase());
  return m ? m[1] : null;
}

// Which product a page belongs to, and whether it is already a one-click copy.
export function identifyPage(config, pageUrl) {
  let host;
  try {
    host = new URL(pageUrl).hostname.toLowerCase();
  } catch {
    return null;
  }
  for (const [key, product] of Object.entries(config.products || {})) {
    const env = envFromHost(product, host);
    if (env) return { product: key, env };
    if (product.prodHostPattern && new RegExp(product.prodHostPattern).test(host)) return { product: key, env: null };
  }
  return null;
}

// The service's dates are "YYYYMMDDHHmm" in local time.
function parseServiceDate(s) {
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})$/.exec(String(s || ""));
  return m ? new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]).getTime() : null;
}

// ---- The environment list, cached ----

let listCache = readJson(CACHE_FILE, { refreshedAt: 0, environments: [], status: "never", error: null });
let refreshing = null;

// How long to wait for the service's MCP server to connect before giving up.
const CONNECT_TIMEOUT_MS = 30000;

async function fetchListFromService(listTool) {
  let toolUseId = null;
  let payload = null;
  let toolError = null;
  let resultText = null;
  // The prompt is held back until the service's MCP server has connected:
  // sent straight away, the model can call the tool before it exists.
  const serverName = listTool.split("__")[1];
  let release;
  const connected = new Promise((resolve) => { release = resolve; });
  async function* prompt() {
    if (!(await connected)) return;
    yield {
      type: "user",
      message: { role: "user", content: `Call ${listTool} once with no arguments. Do nothing else, then reply "done".` },
      parent_tool_use_id: null,
    };
  }
  const q = query({
    prompt: prompt(),
    options: {
      model: "claude-haiku-4-5-20251001",
      maxTurns: 4,
      allowedTools: [listTool],
      disallowedTools: DENIED_TOOLS,
      env: { ...process.env, ENABLE_TOOL_SEARCH: "false" },
      stderr: (data) => console.error(`[environments-stderr] ${data}`),
    },
  });
  const deadline = Date.now() + CONNECT_TIMEOUT_MS;
  let status = "pending";
  while (Date.now() < deadline) {
    const servers = await q.mcpServerStatus().catch(() => []);
    status = servers.find((srv) => srv.name === serverName)?.status || "missing";
    if (status !== "pending") break;
    await new Promise((r) => setTimeout(r, 500));
  }
  if (status !== "connected") {
    release(false);
    try { q.close(); } catch {}
    return {
      ok: false,
      authExpired: status === "needs-auth",
      error: status === "needs-auth"
        ? `the ${serverName} MCP server needs signing in again (run /mcp in Claude Code)`
        : `the ${serverName} MCP server is ${status}`,
    };
  }
  release(true);
  try {
    for await (const msg of q) {
      if (msg.type === "assistant") {
        for (const c of msg.message.content || []) {
          if (c.type === "tool_use" && c.name === listTool) toolUseId = c.id;
        }
      }
      if (msg.type === "user") {
        for (const c of msg.message.content || []) {
          if (c.type !== "tool_result" || c.tool_use_id !== toolUseId) continue;
          const text = Array.isArray(c.content) ? c.content.map((p) => p.text || "").join("") : String(c.content || "");
          if (c.is_error) toolError = text;
          else payload = text;
        }
        // The raw tool result is all we need; the model's reply is not.
        if (payload || toolError) break;
      }
      if (msg.type === "result") resultText = msg.result || msg.subtype;
    }
  } finally {
    try { q.close(); } catch {}
  }
  const failure = toolError || (!payload ? resultText || "the environment service returned nothing" : null);
  if (failure) {
    const authExpired = /sign in|authenticat|oauth/i.test(failure);
    return { ok: false, authExpired, error: failure.slice(0, 300) };
  }
  const parsed = JSON.parse(payload);
  return { ok: true, environments: parsed.environments || [] };
}

export function refreshList() {
  if (refreshing) return refreshing;
  const startedAt = Date.now();
  const listTool = readConfig()?.listTool;
  if (!listTool) return Promise.resolve({ ...listCache, status: "error", error: "no listTool in environments.local.json" });
  refreshing = fetchListFromService(listTool)
    .catch((err) => ({ ok: false, authExpired: /sign in|authenticat|oauth/i.test(err.message), error: err.message.slice(0, 300) }))
    .then((r) => {
      // A failed refresh keeps the last good list and says why.
      listCache = r.ok
        ? { refreshedAt: Date.now(), environments: r.environments, status: "ok", error: null }
        : { ...listCache, status: r.authExpired ? "auth-expired" : "error", error: r.error, failedAt: Date.now() };
      writeJson(CACHE_FILE, listCache);
      console.log(`[environments] refresh ${r.ok ? `ok, ${r.environments.length} environments` : `failed: ${r.error}`} in ${Date.now() - startedAt}ms`);
      return listCache;
    })
    .finally(() => { refreshing = null; });
  return refreshing;
}

// Returns the cached list at once, refreshing behind it when stale. Only the
// very first call ever (no list at all) waits for the service.
async function currentList({ force = false } = {}) {
  const stale = Date.now() - listCache.refreshedAt > LIST_MAX_AGE_MS;
  if (!listCache.refreshedAt || force) return refreshList();
  if (stale) refreshList();
  return listCache;
}

// ---- Picking one ----

async function answers(host) {
  try {
    const r = await fetch(`https://${host}/`, { redirect: "manual", signal: AbortSignal.timeout(ANSWER_TIMEOUT_MS) });
    return r.status < 500;
  } catch {
    return false;
  }
}

function describe(config, product, e) {
  const p = e.parameters || {};
  const owner = String(p.owner || "").split(",")[0].split("@")[0];
  return {
    env: e.environment,
    host: hostFor(product, e.environment),
    owner,
    team: p.team || null,
    baseline: p.baseline || null,
    expiresAt: parseServiceDate(p.expiryDate),
    mine: !!config.me && owner === config.me,
    myTeam: !!config.team && p.team === config.team,
  };
}

function rank(a, b) {
  if (a.mine !== b.mine) return a.mine ? -1 : 1;
  if (a.myTeam !== b.myTeam) return a.myTeam ? -1 : 1;
  return (b.expiresAt || 0) - (a.expiresAt || 0);
}

// Whether the user's browser is signed in to that copy: one authenticated
// read through the extension. The product's auth wall answers 401 (or 403)
// before routing, so those mean signed out and any other real answer means
// past the wall: a missing route answers 404 only once signed in. null means
// no answer at all, with the reason.
async function checkSignIn(product, host, fetchThroughBrowser) {
  const r = await fetchThroughBrowser(`https://${host}${product.authProbePath || "/"}`);
  if (!r || r.workerDown) return { signedIn: null, signInCheck: r && r.workerDown ? "worker-down" : "no-answer" };
  if (r.status === 401 || r.status === 403) return { signedIn: false };
  if (r.status > 0) return { signedIn: true };
  return { signedIn: null, signInCheck: "no-answer" };
}

export async function findEnvironment({ productKey, pageUrl, force, fetchThroughBrowser }) {
  const config = readConfig();
  if (!config) return { ok: false, error: "Finding a copy isn't set up: copy server/environments.example.json to environments.local.json and fill it in." };

  const page = pageUrl ? identifyPage(config, pageUrl) : null;
  const key = productKey || page?.product;
  const product = key && config.products?.[key];
  if (!product) return { ok: false, error: pageUrl ? "This page isn't a product Page Bender knows yet." : "Unknown product." };

  // Already on a copy: use it, no lookup.
  if (page?.env) {
    const host = hostFor(product, page.env);
    return {
      ok: true, product: key, label: product.label, source: "current-page",
      pick: { env: page.env, host, ...(await checkSignIn(product, host, fetchThroughBrowser)) },
      candidates: [],
    };
  }

  const list = await currentList({ force });
  const now = Date.now();
  const described = list.environments
    .filter((e) => e.status === "ready")
    .filter((e) => !(e.parameters && e.parameters.pool)) // CI pools live one day and clear their data
    .map((e) => describe(config, product, e))
    .filter((c) => !c.expiresAt || c.expiresAt - now > MIN_TIME_LEFT_MS);

  const alive = await Promise.all(described.map(async (c) => ((await answers(c.host)) ? c : null)));
  const candidates = alive.filter(Boolean).sort(rank);

  // The remembered choice wins while it is still usable.
  const remembered = readJson(CHOICE_FILE, {})[key];
  const pick = candidates.find((c) => c.env === remembered) || candidates[0] || null;
  if (pick) Object.assign(pick, await checkSignIn(product, pick.host, fetchThroughBrowser));

  return {
    ok: true, product: key, label: product.label, source: "service",
    service: { status: list.status, refreshedAt: list.refreshedAt || null, error: list.error || null },
    pick,
    candidates: candidates.map(({ mine, myTeam, ...c }) => ({ ...c, mine, myTeam })),
  };
}

export function rememberChoice(productKey, env) {
  const choices = readJson(CHOICE_FILE, {});
  choices[productKey] = env;
  writeJson(CHOICE_FILE, choices);
}
