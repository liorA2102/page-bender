// Quick learn: a lightweight design system, made without an agent.
//
// When the card opens on a product with no fresh design system, Page Bender
// walks a few pages around the one the user is on (it, then its first nav
// neighbours), records each page's style census and a full-page capture, and
// packs them into design-systems/<product>/<date>-quick/, the same folder
// shape a full design system has (pages/, raw/index.json, css/). The mock run
// then reads tokens from the census itself and captures any component it
// needs. Measured on CMS (3 Oct 2026): about 56 s for 5 pages, scripted.
//
// It drives the browser through the server's own /agent/* routes, exactly as
// the CLI does, so every rule there (non-prod only, writes blocked) applies.
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileP = promisify(execFile);
const PAGES = 5;
// Nav entries that only open or close a group, never a page.
const NOT_A_PAGE = /[▶▼▲◀‹›]|^(system|settings|logout|log out|sign out|welcome\b)/i;

const runs = new Map(); // product -> state

export function quickLearnState(product) {
  return runs.get(product) || null;
}

function nameify(s) {
  return String(s || "page").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "page";
}

function inside(box, region) {
  const [x, y, w, h] = box;
  const [rx, ry, rw, rh] = region;
  const cx = x + w / 2;
  const cy = y + h / 2;
  return cx >= rx && cx <= rx + rw && cy >= ry && cy <= ry + rh;
}

// The page's own navigation, in order: interactive items inside the first
// nav region (or, failing that, in a narrow left column).
function navItems(snap) {
  const nav = (snap.regions || []).find((r) => r.tag === "nav" || r.role === "navigation");
  return (snap.items || []).filter((it) => {
    const text = (it.text || "").trim();
    if (text.length < 2 || NOT_A_PAGE.test(text)) return false;
    if (!["button", "a"].includes(it.tag) && it.kind !== "custom") return false;
    if (nav) return inside(it.box, nav.box);
    return it.box[0] < 260;
  });
}

// Starts a quick learn for a product unless one is running or already done
// today. `call(route, body)` reaches the server's own agent routes.
export function startQuickLearn({ product, host, pageUrl, repoRoot, mocksDir, call, workerReady }) {
  const current = runs.get(product);
  if (current && current.status === "running") return current;
  const date = new Date().toISOString().slice(0, 10);
  const dsDir = path.join(repoRoot, "design-systems", product, `${date}-quick`);
  if (current && current.status === "done" && current.dsDir === dsDir) return current;

  const state = { product, status: "running", done: 0, total: PAGES, step: "opening the product", dsDir, startedAt: Date.now(), error: null, pages: [] };
  state.promise = learn(state, { host, pageUrl, mocksDir, repoRoot, call, workerReady })
    .then(() => {
      state.status = "done";
      state.step = null;
      state.finishedAt = Date.now();
      console.log(`[quick-learn] ${product}: ${state.pages.length} pages in ${Math.round((state.finishedAt - state.startedAt) / 1000)} s -> ${dsDir}`);
    })
    .catch((err) => {
      state.status = "failed";
      state.error = err.message;
      console.error(`[quick-learn] ${product} failed: ${err.message}`);
    });
  runs.set(product, state);
  return state;
}

async function learn(state, { host, pageUrl, mocksDir, repoRoot, call, workerReady }) {
  const { dsDir } = state;
  // Right after a server restart the extension has not polled yet.
  for (let i = 0; workerReady && !workerReady() && i < 30; i++) await new Promise((r) => setTimeout(r, 1000));
  fs.rmSync(dsDir, { recursive: true, force: true });
  fs.mkdirSync(path.join(dsDir, "pages"), { recursive: true });
  fs.mkdirSync(path.join(dsDir, "raw"), { recursive: true });

  const startUrl = pageUrl && new URL(pageUrl).host === host ? pageUrl : `https://${host}/`;
  let snap = await call("/agent/drive", { action: "open", url: startUrl, timeoutMs: 90000 });
  const tabId = snap.tabId;
  try {
    // The page can answer before its navigation has rendered: look again.
    for (let i = 0; i < 3 && navItems(snap).length < 2; i++) {
      await new Promise((r) => setTimeout(r, 1500));
      snap = { ...(await call("/agent/drive", { action: "snapshot", tabId })), tabId };
    }
    const neighbours = navItems(snap).map((it) => it.text.trim());
    const startTitle = (snap.url || "").split("#")[1] || "start";
    const plan = [null, ...neighbours.slice(0, PAGES - 1)];
    state.total = plan.length;
    for (const label of plan) {
      if (label) {
        state.step = `opening ${label}`;
        // Refs reset on every snapshot, so find the item again on this page.
        const fresh = await call("/agent/drive", { action: "snapshot", tabId });
        const item = navItems(fresh).find((it) => it.text.trim() === label);
        if (!item) continue;
        snap = await call("/agent/drive", { action: "click", tabId, ref: item.ref });
      }
      const name = label || startTitle;
      const slug = nameify(name);
      state.step = `learning ${label || "this page"}`;
      const styles = await call("/agent/drive", { action: "styles", tabId });
      fs.writeFileSync(path.join(dsDir, "raw", `styles-${slug}.json`), JSON.stringify(styles, null, 1));
      const cap = await call("/agent/capture", { tabId, timeoutMs: 120000 });
      const captureSlug = cap.slug;
      fs.copyFileSync(path.join(mocksDir, captureSlug, "original.html"), path.join(dsDir, "pages", `${slug}.html`));
      if (snap.screenshotFile && fs.existsSync(snap.screenshotFile)) fs.copyFileSync(snap.screenshotFile, path.join(dsDir, "pages", `${slug}.png`));
      state.pages.push({ page: label || "Start page", slug, url: (snap.url || "").replace(/^https:\/\/[^/]+/, ""), capture: captureSlug, file: `pages/${slug}.html`, screenshot: `pages/${slug}.png`, settledMs: snap.settled?.settledMs ?? null });
      state.done = state.pages.length;
    }
  } finally {
    await call("/agent/drive", { action: "close", tabId }).catch(() => {});
  }

  state.step = "packing";
  if (!state.pages.length) throw new Error("no page could be captured");
  fs.writeFileSync(path.join(dsDir, "raw", "index.json"), JSON.stringify({ components: [], pages: state.pages }, null, 1));
  // The page the user started from stands in for the product's layout.
  fs.copyFileSync(path.join(dsDir, state.pages[0].file), path.join(dsDir, "shell.html"));
  await execFileP("python3", [path.join(repoRoot, "agent", "ds-pack.py"), dsDir], { timeout: 120000 });
  fs.writeFileSync(
    path.join(dsDir, "README.md"),
    `# ${state.product}: quick learn, ${new Date().toISOString().slice(0, 10)}\n\n` +
      `A lightweight design system made by Page Bender's quick learn, without an agent: ` +
      `${state.pages.length} pages from https://${host}/, each with its style census ` +
      `(raw/styles-<page>.json) and a full-page capture (pages/<page>.html, CSS packed into css/).\n\n` +
      `There are no extracted tokens and no component captures yet. A mock run reads the tokens it ` +
      `needs from the census and captures the components it needs. "Generate design system" makes ` +
      `the full one.\n\nPages: ${state.pages.map((p) => p.page).join(", ")}.\n`
  );
}
