// The handoff: what a user downloads once a mock is ready to share. A zip
// with the mock as one standalone HTML file, CHANGES.md (what changed
// against the captured page), DESIGN.md (the product's design rules) and a
// README saying what it all is.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { screensIn } from "./outline.js";

const execFileP = promisify(execFile);
const IMAGE_EXT = /\.(png|jpe?g|gif|webp|svg|ico|avif)(\?|#|$)/i;
const MAX_IMAGES = 200;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

async function fetchDataUri(url) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 8000);
  try {
    const res = await fetch(url, { signal: ctl.signal, redirect: "follow" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const type = (res.headers.get("content-type") || "").split(";")[0];
    if (!/^image\//.test(type)) throw new Error(`not an image (${type || "no type"})`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > MAX_IMAGE_BYTES) throw new Error("too large");
    return `data:${type};base64,${buf.toString("base64")}`;
  } finally {
    clearTimeout(timer);
  }
}

// Images still pointed at the original site, so an exported mock opened
// without access to it (or offline) showed broken images. Fetch each once
// and put it inside the file. One that can't be fetched (behind a login
// the server doesn't have) stays a link, and is counted.
export async function embedImages(html) {
  const urls = new Set();
  for (const m of html.matchAll(/<img\b[^>]*?\ssrc="(https?:\/\/[^"]+)"/gi)) urls.add(m[1].replace(/&amp;/g, "&"));
  for (const m of html.matchAll(/url\((['"]?)(https?:\/\/[^'")]+)\1\)/gi)) if (IMAGE_EXT.test(m[2])) urls.add(m[2]);
  const list = [...urls].slice(0, MAX_IMAGES);
  const done = new Map();
  let failed = 0;
  let next = 0;
  async function worker() {
    while (next < list.length) {
      const url = list[next++];
      try { done.set(url, await fetchDataUri(url)); } catch { failed++; }
    }
  }
  await Promise.all(Array.from({ length: 6 }, worker));
  let out = html;
  for (const [url, data] of done) {
    out = out.split(`"${url.replace(/&/g, "&amp;")}"`).join(`"${data}"`).split(`"${url}"`).join(`"${data}"`).split(`(${url})`).join(`(${data})`)
      .split(`('${url}')`).join(`('${data}')`).split(`("${url}")`).join(`("${data}")`);
  }
  return { html: out, embedded: done.size, failed, found: urls.size };
}

// A mock opens on its first screen, whichever one was showing when it was
// last saved in the editor.
export function firstScreenShowing(html) {
  let n = 0;
  return html.replace(/<section(\s[^>]*)data-pb-screen="([^"]*)"([^>]*)>|<section\s+data-pb-screen="([^"]*)"([^>]*)>/g, (m) => {
    const clean = m.replace(/\shidden(="[^"]*")?/g, "");
    return n++ === 0 ? clean : clean.replace(/>$/, " hidden>");
  });
}

export async function standaloneMock(html) {
  const { html: withImages, embedded, failed, found } = await embedImages(firstScreenShowing(html));
  return { html: withImages, images: { found, embedded, failed } };
}

function readme({ meta, name, screens, images, kind }) {
  const lines = [
    `# ${name}`,
    "",
    `A prototype made with Page Bender from ${meta.url ? `\`${meta.url}\`` : "a captured page"}, captured ${String(meta.capturedAt || "").slice(0, 10)}.`,
    "",
    "## What's in this folder",
    "",
    "| File | What it is |",
    "| --- | --- |",
    "| `mock.html` | The prototype. Double-click to open it in a browser. |",
    "| `CHANGES.md` | What changed against the captured page, for whoever builds it for real. |",
    `| \`DESIGN.md\` | The product's design rules: library, tokens, components and layout (${kind}). Give it to your coding agent along with CHANGES.md. |`,
    "",
  ];
  if (screens.length > 1) {
    lines.push("## Screens", "", "The mock opens on the first screen. The product's own navigation switches between them:", "");
    for (const s of screens) lines.push(`- ${s}`);
    lines.push("");
  }
  lines.push("## Good to know", "");
  lines.push("- It's a static prototype: buttons and forms look real but don't save anything.");
  lines.push("- Fonts, styles and images are inside `mock.html`" + (images.failed ? `, except ${images.failed} image${images.failed === 1 ? "" : "s"} that still load from the original site (unreachable when this was exported).` : "."));
  lines.push("- It may contain real data from the page it was captured from. Share it the way you would share that page.");
  lines.push("");
  return lines.join("\n");
}

// Writes the four files into a temporary folder and zips them (macOS ships
// /usr/bin/zip, and Page Bender's setup is macOS only).
export async function buildHandoffZip({ dir, meta, html, changesMd, designMd, baseName }) {
  const { html: mock, images } = await standaloneMock(html);
  const screens = screensIn(mock);
  const name = meta.title || baseName;
  const kind = /learned design system/.test(designMd) ? "from the product's learned design system" : "read from the captured page";
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pb-handoff-"));
  const folder = path.join(tmp, baseName);
  fs.mkdirSync(folder);
  fs.writeFileSync(path.join(folder, "mock.html"), mock);
  fs.writeFileSync(path.join(folder, "CHANGES.md"), changesMd);
  fs.writeFileSync(path.join(folder, "DESIGN.md"), designMd);
  fs.writeFileSync(path.join(folder, "README.md"), readme({ meta, name, screens, images, kind }));
  const zipPath = path.join(tmp, `${baseName}.zip`);
  await execFileP("zip", ["-r", "-q", zipPath, baseName], { cwd: tmp });
  return { zipPath, tmp, images };
}
