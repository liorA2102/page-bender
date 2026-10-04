#!/usr/bin/env node
// Adds screens to a captured page, so the editing agent doesn't have to find
// the page's main content area in a file of 100,000-character lines.
//
//   node agent/pb-screens.mjs outline <file>
//   node agent/pb-screens.mjs add <file> <Name> [--current <Name of the existing page>]
//   node agent/pb-screens.mjs link <file> "<nav label>" <Name>
//   node agent/pb-screens.mjs css <file> <design-system folder> <part> [<part>...]
//   node agent/pb-screens.mjs screen <file> <design-system folder, or -> <Name> <markup file>
//        [--current <Name of the existing page>] [--nav "<label>" | --nav-after "<label>"]
//
// add: the first time, wraps the main content area's existing content as a
// screen (--current names it), then adds an empty, hidden screen <Name> and
// prints the unique comment to replace with that screen's markup.
// link: makes the navigation item showing <nav label> switch to <Name>, with
// an inline onclick (scripts added by edits never run; inline handlers do).
// css: adds, once, the CSS a design-system part needs on this page (the
// rules for its classes this page doesn't style yet), so a part from
// another page of the product looks right here.
// screen: everything a new screen needs, in one step. Adds <Name> with the
// markup from <markup file> (written from the design system's parts), adds
// the CSS for every part that markup uses (found from its classes, so
// nothing depends on remembering to ask), and makes the navigation reach
// it: --nav wires an existing item, --nav-after adds a new item in the same
// style after the one showing that label.
import fs from "node:fs";
import path from "node:path";
import { elementAt, findLandmark, pageHeader, pageOutline, screensIn } from "../server/outline.js";
import { cssForMarkup, designSystemParts, partCss, pageStyles } from "../server/ds-parts.js";

const [cmd, file, ...rest] = process.argv.slice(2);
const flag = (name) => {
  const i = rest.indexOf(`--${name}`);
  return i >= 0 ? rest.splice(i, 2)[1] : null;
};
const fail = (msg) => { process.stderr.write(`${msg}\n`); process.exit(2); };
if (!cmd || !file) fail("usage: pb-screens.mjs outline|add|link <file> ...");
let html = fs.readFileSync(file, "utf8");
const attr = (s) => String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;");
const switchTo = (name) => `document.querySelectorAll('[data-pb-screen]').forEach(function(s){s.hidden=s.getAttribute('data-pb-screen')!==${JSON.stringify(name).replace(/"/g, "'")}})`;

// The navigation item showing <label>: the nearest clickable element that
// opens before the label, inside the marked navigation.
function navItem(src, label) {
  const nav = findLandmark(src, "nav");
  if (!nav) fail("this capture has no marked navigation");
  const region = src.slice(nav.openEnd, nav.closeStart);
  const at = region.search(new RegExp(`>\\s*${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*<`));
  if (at < 0) fail(`no navigation item shows "${label}"`);
  const opens = [...region.slice(0, at + 1).matchAll(/<(a|button|li|div)(?=[\s>])[^>]*>/gi)];
  const target = opens.reverse().find((m) => /^<(a|button|li)/i.test(m[0]) || /role="(button|menuitem|link)"|class="[^"]*(item|link|nav)/i.test(m[0])) || opens[0];
  if (!target) fail(`couldn't find the element around "${label}"`);
  return elementAt(src, nav.openEnd + target.index);
}

// How the navigation marks the item for the page being shown. Products
// rarely say "active": CMS's styled components swap a generated class
// ("sc-dItHI jGeDuB" against "sc-dItHI eSHsTI"). So: among nav items sharing
// a base class, the one item whose classes differ from all the others is
// the current one, and the differing classes are the highlight.
function navStates(src) {
  const nav = findLandmark(src, "nav");
  if (!nav) return null;
  const items = [...src.slice(nav.openEnd, nav.closeStart).matchAll(/<(a|button|li)(?=[\s>])[^>]*class="([^"]*)"[^>]*>/gi)]
    .map((m) => ({ start: nav.openEnd + m.index, cls: m[2].split(/\s+/).filter(Boolean) }));
  const groups = new Map();
  for (const it of items) {
    const base = it.cls[0];
    if (!base) continue;
    if (!groups.has(base)) groups.set(base, []);
    groups.get(base).push(it);
  }
  for (const [base, list] of groups) {
    if (list.length < 3) continue;
    const count = new Map();
    for (const it of list) count.set(it.cls.join(" "), (count.get(it.cls.join(" ")) || 0) + 1);
    const [normal] = [...count.entries()].sort((a, b) => b[1] - a[1])[0];
    const odd = list.filter((it) => it.cls.join(" ") !== normal);
    if (odd.length !== 1 || count.get(normal) < list.length - 1) continue;
    const norm = normal.split(" ");
    return {
      base,
      active: odd[0].cls.filter((c) => !norm.includes(c)),
      normal: norm.filter((c) => !odd[0].cls.includes(c)),
      currentStart: odd[0].start,
    };
  }
  return null;
}

function wire(src, el, name, states = navStates(src)) {
  let script = switchTo(name);
  if (states && states.active.length && src.slice(el.start, el.openEnd).includes(states.base)) {
    const q = (list) => list.map((c) => `'${c}'`).join(",");
    script += `;document.querySelectorAll('.${states.base}').forEach(function(n){n.classList.remove(${q(states.active)});n.classList.add(${q(states.normal)})});this.classList.remove(${q(states.normal)});this.classList.add(${q(states.active)})`;
  }
  const open = src.slice(el.start, el.openEnd).replace(/\sonclick="[^"]*"/i, "");
  return src.slice(0, el.start) + open.replace(/>$/, ` onclick="${script}">`) + src.slice(el.openEnd);
}

// The first time screens are added, the page's own nav item (the current
// one) learns to switch back to the original screen.
function wireCurrent(src, current) {
  const states = navStates(src);
  if (!states || !current) return src;
  const el = elementAt(src, states.currentStart);
  return el ? wire(src, el, current, states) : src;
}

// The existing page's name, from its own title: an agent's guess named the
// App Feeds page "A/B Testing" in one run of three (4 Oct 2026).
function pageName(src, given) {
  const header = pageHeader(src);
  const titles = header ? [...header.matchAll(/<h1[^>]*>([\s\S]*?)<\/h1>/gi)].map((m) => m[1].replace(/<[^>]*>/g, "").replace(/&amp;/g, "&").trim()).filter(Boolean) : [];
  return titles[0] || given || "Home";
}

function wrapExisting(src, current) {
  if (screensIn(src).length) return src;
  const main = findLandmark(src, "main");
  if (!main) fail("this capture has no marked main content area: recapture it, or place the screen by hand");
  return src.slice(0, main.openEnd) + `<section data-pb-screen="${attr(current || "Home")}">` + src.slice(main.openEnd, main.closeStart) + "</section>" + src.slice(main.closeStart);
}

if (cmd === "outline") {
  process.stdout.write(JSON.stringify({ outline: pageOutline(html), screens: screensIn(html) }, null, 1) + "\n");
} else if (cmd === "add") {
  const current = pageName(html, flag("current"));
  const [name] = rest;
  if (!name) fail("pass the new screen's name");
  if (screensIn(html).includes(name)) fail(`a screen named "${name}" already exists`);
  html = wrapExisting(html, current);
  const main = findLandmark(html, "main");
  const anchor = `<!-- pb: build the ${name} screen here -->`;
  html = html.slice(0, main.closeStart) + `<section data-pb-screen="${attr(name)}" hidden>${anchor}</section>` + html.slice(main.closeStart);
  fs.writeFileSync(file, html);
  process.stdout.write(`Added screen "${name}". Replace this exact, unique text with its markup:\n${anchor}\n`);
} else if (cmd === "link") {
  const [label, name] = rest;
  if (!label || !name) fail('usage: link <file> "<nav label>" <Name>');
  html = wire(html, navItem(html, label), name);
  fs.writeFileSync(file, html);
  process.stdout.write(`"${label}" now switches to "${name}".\n`);
} else if (cmd === "css") {
  const [dsDir, ...names] = rest;
  if (!dsDir || !names.length) fail("usage: css <file> <design-system folder> <part> [<part>...]");
  const index = JSON.parse(fs.readFileSync(path.join(dsDir, "raw", "index.json"), "utf8"));
  const parts = designSystemParts(dsDir, index.components);
  for (const name of names) {
    const part = parts.find((pt) => pt.name === name);
    if (!part) fail(`no part named "${name}"`);
    if (html.includes(`data-pb-part="${name}"`)) { process.stdout.write(`${name}: already added\n`); continue; }
    const css = partCss(part, pageStyles(html));
    if (!css) { process.stdout.write(`${name}: this page already styles it\n`); continue; }
    const block = `<style data-pb-part="${attr(name)}">\n${css}\n</style>`;
    const at = html.search(/<\/head>/i);
    html = at >= 0 ? html.slice(0, at) + block + html.slice(at) : block + html;
    process.stdout.write(`${name}: added ${css.length} characters of its CSS\n`);
  }
  fs.writeFileSync(file, html);
} else if (cmd === "screen") {
  const current = pageName(html, flag("current"));
  const navLabel = flag("nav");
  const navAfter = flag("nav-after");
  const [dsDir, name, markupFile] = rest;
  if (!dsDir || !name || !markupFile) fail("usage: screen <file> <design-system folder> <Name> <markup file> [--current <page>] [--nav <label> | --nav-after <label>]");
  if (screensIn(html).includes(name)) fail(`a screen named "${name}" already exists: edit it in place`);
  const markup = fs.readFileSync(markupFile, "utf8");
  const first = !screensIn(html).length;
  // "-": no design system, only this page's own parts, which it styles already.
  const css = dsDir === "-" ? "" : cssForMarkup(markup, designSystemParts(dsDir, JSON.parse(fs.readFileSync(path.join(dsDir, "raw", "index.json"), "utf8")).components), pageStyles(html));
  html = wrapExisting(html, current);
  if (first) html = wireCurrent(html, current || "Home");
  const main = findLandmark(html, "main");
  html = html.slice(0, main.closeStart) + `<section data-pb-screen="${attr(name)}" hidden>${markup}</section>` + html.slice(main.closeStart);
  if (css) {
    const block = `<style data-pb-screen-css="${attr(name)}">\n${css}\n</style>`;
    const at = html.search(/<\/head>/i);
    html = at >= 0 ? html.slice(0, at) + block + html.slice(at) : block + html;
  }
  let navNote = "no navigation item wired (pass --nav or --nav-after)";
  if (navLabel) {
    html = wire(html, navItem(html, navLabel), name);
    navNote = `"${navLabel}" switches to it`;
  } else if (navAfter) {
    const item = navItem(html, navAfter);
    const esc = navAfter.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const copy = html.slice(item.start, item.closeEnd)
      .replace(new RegExp(`>\\s*${esc}\\s*<`), `>${name.replace(/</g, "&lt;")}<`)
      .replace(/\s(id|data-qa-id|aria-current)="[^"]*"/g, "")
      .replace(/class="([^"]*)"/g, (m, c) => `class="${c.split(/\s+/).filter((x) => !/^(active|selected|current)$|--active|-active$|Mui-selected/.test(x)).join(" ")}"`);
    html = html.slice(0, item.closeEnd) + copy + html.slice(item.closeEnd);
    html = wire(html, elementAt(html, item.closeEnd), name);
    navNote = `new "${name}" item after "${navAfter}" switches to it`;
  }
  fs.writeFileSync(file, html);
  process.stdout.write(`Screen "${name}" added (${markup.length} characters), ${css.length} characters of CSS for the parts it uses, ${navNote}.\n`);
} else {
  fail(`unknown command "${cmd}"`);
}
