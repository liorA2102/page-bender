#!/usr/bin/env node
// Page Bender agent CLI: a thin, dependency-free wrapper over the local
// server's /agent/* routes, so an agent session drives the browser with short
// commands instead of hand-built HTTP calls.
//
//   node agent/pb.mjs health
//   node agent/pb.mjs open <url>                  -> new driven tab, prints its outline
//   node agent/pb.mjs snapshot  --tab <id>
//   node agent/pb.mjs click <ref> --tab <id>      (also: hover <ref>)
//   node agent/pb.mjs escape    --tab <id>        (closes a dialog or menu)
//   node agent/pb.mjs scroll [dy] --tab <id>
//   node agent/pb.mjs navigate <url> --tab <id>   (also: back)
//   node agent/pb.mjs styles    --tab <id>        -> style census JSON (design tokens)
//   node agent/pb.mjs capture   --tab <id> [--ref <n> | --selector <css>] [--no-ancestors]
//   node agent/pb.mjs close     --tab <id>
//   node agent/pb.mjs fetch <url>... [--out <file-or-dir>]   (GET with the browser's login)
//
// --json prints the raw response instead of the compact outline. Every
// response is also written to --save <file> when given. Exit code 0 on
// success, 2 when Page Bender refused or failed (message on stderr).
//
// Driving is limited to non-prod hosts, and every write request from a driven
// tab is blocked, by the extension and server themselves; this file adds no
// rules of its own.

import fs from "node:fs";
import path from "node:path";

const SERVER = process.env.PAGE_BENDER_SERVER || "http://127.0.0.1:8790";

function parseArgs(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) flags[key] = true;
      else { flags[key] = next; i++; }
    } else positional.push(a);
  }
  return { cmd: positional[0], args: positional.slice(1), flags };
}

async function call(route, body) {
  const init = body === undefined
    ? { headers: { "X-Page-Bender-Agent": "1" } }
    : { method: "POST", headers: { "X-Page-Bender-Agent": "1", "Content-Type": "application/json" }, body: JSON.stringify(body) };
  let res;
  try {
    res = await fetch(`${SERVER}${route}`, init);
  } catch (err) {
    fail(`Page Bender server unreachable at ${SERVER} (${err.message}). Is the launchd service running?`);
  }
  const data = await res.json().catch(() => ({ ok: false, error: `non-JSON response (HTTP ${res.status})` }));
  return { status: res.status, data };
}

function fail(msg) {
  process.stderr.write(`${msg}\n`);
  process.exit(2);
}

// One line per element, the shape an agent can scan quickly.
function printOutline(d) {
  const lines = [`tab ${d.tabId}  ${d.url}`, `title: ${d.title}${d.dialogOpen ? "  [dialog open]" : ""}`];
  if (d.settled) lines.push(`settled in ${d.settled.settledMs}ms${d.settled.timedOut ? " (TIMED OUT, page may still be loading)" : ""}`);
  if (d.step && d.step.clicked) lines.push(`clicked: ${d.step.clicked}`);
  if (d.screenshotFile) lines.push(`screenshot: ${d.screenshotFile}`);
  if (d.screenshotError) lines.push(`screenshot failed: ${d.screenshotError}`);
  lines.push("regions:");
  for (const r of d.regions || []) lines.push(`  [${r.ref}] ${r.tag}${r.role ? `(${r.role})` : ""} ${r.box.join("x")} ${(r.text || "").slice(0, 50)}`);
  lines.push("items:");
  for (const i of d.items || []) {
    const tags = [i.kind === "custom" ? "custom" : null, i.disabled ? "disabled" : null, i.inDialog ? "in-dialog" : null].filter(Boolean).join(",");
    lines.push(`  [${i.ref}] ${i.tag}${i.type ? `:${i.type}` : ""}${tags ? ` {${tags}}` : ""} ${i.text || ""}`);
  }
  console.log(lines.join("\n"));
}

async function main() {
  const { cmd, args, flags } = parseArgs(process.argv.slice(2));
  const tabId = flags.tab != null ? Number(flags.tab) : undefined;
  let out;

  if (!cmd || cmd === "help") {
    console.log(fs.readFileSync(new URL(import.meta.url), "utf8").split("\n").filter((l) => l.startsWith("//")).slice(0, 22).map((l) => l.slice(3)).join("\n"));
    return;
  }
  if (cmd === "health") {
    out = await call("/agent/health");
  } else if (cmd === "open") {
    out = await call("/agent/drive", { action: "open", url: args[0], timeoutMs: 90000 });
  } else if (["snapshot", "escape", "back", "close", "styles"].includes(cmd)) {
    out = await call("/agent/drive", { action: cmd, tabId });
  } else if (cmd === "click" || cmd === "hover") {
    out = await call("/agent/drive", { action: cmd, tabId, ref: Number(args[0]) });
  } else if (cmd === "scroll") {
    out = await call("/agent/drive", { action: "scroll", tabId, dy: args[0] ? Number(args[0]) : null });
  } else if (cmd === "navigate") {
    out = await call("/agent/drive", { action: "navigate", tabId, url: args[0], timeoutMs: 90000 });
  } else if (cmd === "capture") {
    out = await call("/agent/capture", {
      tabId,
      selector: typeof flags.selector === "string" ? flags.selector : undefined,
      ref: flags.ref != null ? Number(flags.ref) : undefined,
      // On by default for agent captures; --no-ancestors gives the plain
      // section capture the toolbar makes.
      keepAncestors: !flags["no-ancestors"],
    });
  } else if (cmd === "fetch") {
    out = await call("/agent/fetch", { urls: args });
  } else {
    fail(`unknown command "${cmd}" (try: node agent/pb.mjs help)`);
  }

  const { data } = out;
  if (flags.save) fs.writeFileSync(flags.save, JSON.stringify(data, null, 2));

  if (cmd === "fetch" && data.results && flags.out) {
    // One URL to a file, several to a directory named by the URL's last segment.
    if (data.results.length === 1 && !fs.existsSync(flags.out)) {
      fs.writeFileSync(flags.out, data.results[0].body || "");
      console.log(`${data.results[0].status} ${(data.results[0].body || "").length} bytes -> ${flags.out}`);
    } else {
      fs.mkdirSync(flags.out, { recursive: true });
      data.results.forEach((r, i) => {
        const name = (r.url.replace(/[?#].*$/, "").replace(/\/+$/, "").split("/").pop() || `item${i + 1}`).replace(/[^a-zA-Z0-9._-]/g, "_");
        if (r.ok) fs.writeFileSync(path.join(flags.out, name), r.body || "");
        console.log(`${r.status ?? "-"} ${r.ok ? "saved" : `FAILED ${r.error}`}  ${r.url}`);
      });
    }
  } else if (flags.json || !["open", "snapshot", "click", "hover", "escape", "scroll", "navigate", "back"].includes(cmd) || !data.ok) {
    console.log(JSON.stringify(cmd === "fetch" && !flags.json ? { ...data, results: (data.results || []).map(({ body, ...r }) => ({ ...r, bytes: (body || "").length })) } : data, null, 2));
  } else {
    printOutline(data);
  }
  if (data.ok === false) process.exit(2);
}

main();
