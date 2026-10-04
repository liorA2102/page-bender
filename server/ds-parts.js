// A design system's components as ready-to-use parts for the editing agent:
// each part's own markup, wrapped in the nearest ancestors its product rules
// are scoped to, plus the CSS that styles it, from the page it was captured
// on. A part can come from any page of the product, not only the one being
// edited: a product can be several style families loaded by different parts
// of the app (CMS: MUI, Ant Design, older Bootstrap pages), and a captured
// page only carries its own family's CSS. So a part from another family
// brings the rules for the classes this page doesn't already style
// (agent/pb-screens.mjs css adds them once). Without parts the agent spent
// most of a run searching the page for things to copy (4 Oct 2026); with
// parts but no CSS, Ant pagination copied into an MUI page came out as a
// bullet list.
import fs from "node:fs";
import path from "node:path";
import { elementAt } from "./outline.js";

// A part larger than this (after trimming table rows) is listed by name
// only: a full data grid or tree picker runs to 60,000+ characters.
const MAX_PART = 6000;
// How far up a part's wrappers may reach. Which ancestors are kept is
// decided by the CSS: every ancestor up to the furthest one a rule uses to
// scope the part's own classes (".ant-table-wrapper .ant-table-tbody > tr >
// td" needs the wrapper four levels up), and no further, so the page
// layout above stays out.
const MAX_WRAPPERS = 8;
// A pinned width at least this wide was a page column, not a component's size.
const COLUMN_WIDTH = 600;
// A class named by more than this share of a sheet's rules is a scope
// marker, not a component (Ant Design's css-<hash>: 16% of CMS's Ant sheet,
// against 3% for .ant-table-wrapper, which really does scope the table).
const SCOPE_SHARE = 0.08;
const isMarker = (rules, c) => (rules.freq.get(c) || 0) > rules.total * SCOPE_SHARE;
// Page layout a part never brings along: the page it lands in has its own.
const LAYOUT = /^(container(-fluid)?|app|root|layout|main|page|wrapper)$/i;
const partCache = new Map(); // ds dir -> parts
const rulesCache = new Map(); // css file -> parsed rules

// ---------- markup ----------

function classesOf(tag) {
  return ((tag.match(/class="([^"]*)"/) || [, ""])[1]).split(/\s+/).filter((c) => c && !/^pbx-/.test(c));
}

function partOf(html, rules) {
  const frame = html.indexOf('class="pbx-section-frame"');
  if (frame < 0) return null;
  const ancestors = [];
  const re = /<([a-zA-Z][\w-]*)(?=[\s>])[^>]*>/g;
  re.lastIndex = frame;
  let m;
  while ((m = re.exec(html))) {
    if (/pbx-section-(frame|halo)"/.test(m[0])) continue;
    const cls = (m[0].match(/class="([^"]*)"/) || [, ""])[1];
    if (/\bpbx-ancestor\b/.test(cls)) {
      // Kept without inline styles: those pin the live page's sizes.
      ancestors.push({ tag: m[1], open: m[0].replace(/\sstyle="[^"]*"/, "").replace(/\s?pbx-ancestor\b/, "").replace(/\sclass=""/, "") });
      continue;
    }
    const el = elementAt(html, m.index);
    if (!el) return null;
    const depth = scopingDepth(ancestors, html.slice(el.start, el.closeEnd), rules);
    const near = depth ? ancestors.slice(-depth) : []; // slice(-0) would keep them all
    const own = cleanPart(html.slice(el.start, el.closeEnd));
    const markup = near.map((a) => a.open.replace(/\shref="https?:\/\/[^"]*"/g, ' href="#"')).join("") + own + near.slice().reverse().map((a) => `</${a.tag}>`).join("");
    return { markup, chain: ancestors.map((a) => classesOf(a.open)[0] || a.tag) };
  }
  return null;
}

// How many of the nearest ancestors the part's CSS uses for scoping: the
// furthest ancestor whose class appears in a rule together with a class of
// the part itself.
function scopingDepth(ancestors, inner, rules) {
  if (!rules) return Math.min(3, ancestors.length);
  const own = new Set([...inner.matchAll(/class="([^"]*)"/g)].flatMap((m) => m[1].split(/\s+/)).filter((c) => c && !isMarker(rules, c)));
  const all = [];
  for (const r of rules) {
    if (r.kind === "rule") all.push(r.classes);
    if (r.kind === "group") r.inner.forEach((x) => all.push(x.classes));
  }
  let depth = 0;
  for (let k = 1; k <= Math.min(MAX_WRAPPERS, ancestors.length); k++) {
    const open = ancestors[ancestors.length - k].open;
    const id = (open.match(/\sid="([^"]*)"/) || [, ""])[1];
    if (LAYOUT.test(id) || classesOf(open).some((c) => LAYOUT.test(c))) break;
    const cls = classesOf(open).filter((c) => !isMarker(rules, c));
    if (cls.length && all.some((set) => cls.some((c) => set.has(c)) && [...set].some((c) => own.has(c)))) depth = k;
  }
  return depth;
}

// Ready-to-copy markup of one element: table rows trimmed, its pinned size
// adjusted (a form control's box is fixed; a button's, link's or pill's
// follows its text, so a 72px pin for "Add" would clip new text; a pin as
// wide as a page column becomes 100%), and links never leading back to the
// page it came from.
export function cleanPart(markup) {
  let own = trimGridRows(trimRows(markup));
  const control = /^<(input|select|textarea)\b|<input\b|role="(combobox|listbox|textbox)"/i.test(own);
  own = own.replace(/^(<[^>]*\sstyle=")([^"]*)/, (m, head, style) => head + style.split(";").map((d) => {
    const w = d.match(/^\s*width\s*:\s*([\d.]+)px/i);
    if (w) return Number(w[1]) >= COLUMN_WIDTH ? " width: 100%" : control ? d : null;
    return /^\s*(height|min-height|max-height|max-width|min-width)\s*:/i.test(d) ? null : d;
  }).filter((d) => d !== null).join(";"));
  return own.replace(/\shref="https?:\/\/[^"]*"/g, ' href="#"');
}

// The same for grids built from divs (MUI's DataGrid: role="rowgroup"
// holding role="row" elements): keep two rows of each row group.
function trimGridRows(markup) {
  let out = markup;
  let from = 0;
  for (;;) {
    const g = out.slice(from).search(/<[a-zA-Z][\w-]*(?=[\s>])[^>]*role="rowgroup"[^>]*>/);
    if (g < 0) return out;
    const group = elementAt(out, from + g);
    if (!group) return out;
    const inner = out.slice(group.openEnd, group.closeStart);
    const rows = [];
    const re = /<[a-zA-Z][\w-]*(?=[\s>])[^>]*role="row"[^>]*>/g;
    let m;
    while ((m = re.exec(inner))) {
      const row = elementAt(out, group.openEnd + m.index);
      if (!row) break;
      rows.push(row);
      re.lastIndex = row.closeEnd - group.openEnd;
    }
    if (rows.length > 2) {
      out = out.slice(0, rows[1].closeEnd) + "<!-- more rows like these -->" + out.slice(rows[rows.length - 1].closeEnd);
    }
    from = group.start + 1;
  }
}

// A table's markup is mostly repeated rows: keep the header and two rows,
// which is all an agent needs to build another one.
function trimRows(markup) {
  return markup.replace(/(<tbody[^>]*>)([\s\S]*?)(<\/tbody>)/gi, (all, open, body, close) => {
    const rows = [];
    const re = /<tr(?=[\s>])/gi;
    let m;
    while ((m = re.exec(body))) rows.push(m.index);
    if (rows.length <= 2) return all;
    return open + body.slice(0, rows[2]) + "<!-- more rows like these -->" + close;
  });
}

export function designSystemParts(dsDir, components) {
  if (partCache.has(dsDir)) return partCache.get(dsDir);
  const parts = [];
  for (const c of components || []) {
    let html;
    try { html = fs.readFileSync(path.join(dsDir, c.file), "utf8"); } catch { continue; }
    const rulesFile = [...html.matchAll(/<link rel="stylesheet" href="([^"]*rules-[^"]+\.css)">/g)].map((x) => path.resolve(path.dirname(path.join(dsDir, c.file)), x[1]))[0] || null;
    const p = partOf(html, rulesFile ? parsedRules(rulesFile) : null);
    if (!p) continue;
    parts.push({ name: c.name, family: c.family || null, page: c.page || null, file: c.file, chain: p.chain, rulesFile, markup: p.markup.length <= MAX_PART ? p.markup : null, size: p.markup.length });
  }
  partCache.set(dsDir, parts);
  return parts;
}

// ---------- CSS ----------

// Top-level rules by brace depth, respecting strings and comments (same as
// agent/ds-mock-kit.py's top_rules).
function topRules(css) {
  const out = [];
  let depth = 0;
  let start = 0;
  let quote = null;
  for (let i = 0; i < css.length; i++) {
    const c = css[i];
    if (quote) {
      if (c === "\\") { i++; continue; }
      if (c === quote) quote = null;
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (c === "/" && css[i + 1] === "*") {
      const j = css.indexOf("*/", i + 2);
      i = j >= 0 ? j + 1 : css.length;
    } else if (c === "{") {
      depth++;
    } else if (c === "}") {
      depth--;
      if (depth === 0) { out.push(css.slice(start, i + 1).trim()); start = i + 1; }
    } else if (c === ";" && depth === 0) {
      out.push(css.slice(start, i + 1).trim());
      start = i + 1;
    }
  }
  const tail = css.slice(start).trim();
  if (tail) out.push(tail);
  return out.filter(Boolean);
}

const selectorClasses = (sel) => new Set([...sel.replace(/\\/g, "").matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)].map((m) => m[1]));

function parsedRules(file) {
  if (rulesCache.has(file)) return rulesCache.get(file);
  let css = "";
  try { css = fs.readFileSync(file, "utf8"); } catch {}
  const rules = topRules(css).map((text) => {
    if (/^@(font-face|import|charset)/.test(text)) return null;
    const km = text.match(/^@(?:-webkit-)?keyframes\s+([\w-]+)/);
    if (km) return { kind: "keyframes", name: km[1], text };
    if (/^@(media|supports|layer)/.test(text)) {
      const brace = text.indexOf("{");
      const inner = topRules(text.slice(brace + 1, text.lastIndexOf("}"))).filter((r) => r.includes("{")).map((r) => ({ text: r, classes: selectorClasses(r.slice(0, r.indexOf("{"))) }));
      return { kind: "group", head: text.slice(0, brace).trim(), inner };
    }
    if (!text.includes("{")) return null;
    return { kind: "rule", text, classes: selectorClasses(text.slice(0, text.indexOf("{"))) };
  }).filter(Boolean);
  // How many rules name each class. A class named by hundreds of rules is a
  // scope marker (Ant Design's css-<hash> on every one of its rules), not a
  // component: matching on it would pull in the whole library.
  const freq = new Map();
  const count = (set) => set.forEach((c) => freq.set(c, (freq.get(c) || 0) + 1));
  for (const r of rules) {
    if (r.kind === "rule") count(r.classes);
    if (r.kind === "group") r.inner.forEach((x) => count(x.classes));
  }
  rules.freq = freq;
  rules.total = [...freq.values()].length ? rules.filter((r) => r.kind === "rule").length + rules.filter((r) => r.kind === "group").reduce((a, r) => a + r.inner.length, 0) : 0;
  rulesCache.set(file, rules);
  return rules;
}

// The set of class names a page's own stylesheets name: what it already
// styles. A Set, not the CSS text: a substring test called ".ant-table"
// styled because the page had an ".ant-table-..." rule.
export function pageStyles(html) {
  let css = "";
  for (const m of html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)) css += m[1];
  const set = new Set();
  for (const m of css.replace(/\\/g, "").matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)) set.add(m[1]);
  return set;
}

// The rules a piece of markup needs on a page, from one captured sheet:
// those naming a class the markup uses that the page's own CSS doesn't
// already style. Rules naming only classes the page styles are left out, so
// new markup never restyles the page around it (and another page's global
// resets, which name no class, never come along).
export function cssFor(markup, rulesFile, pageCss) {
  if (!markup || !rulesFile) return [];
  const rules = parsedRules(rulesFile);
  const used = new Set([...markup.matchAll(/class="([^"]*)"/g)].flatMap((m) => m[1].split(/\s+/)).filter((c) => c && !/^pbx-/.test(c)));
  const missing = new Set([...used].filter((c) => !pageCss.has(c) && !isMarker(rules, c)));
  if (!missing.size) return [];
  const hits = (classes) => [...classes].some((c) => missing.has(c));
  const kept = [];
  for (const r of rules) {
    if (r.kind === "rule" && hits(r.classes)) kept.push(r.text);
    if (r.kind === "group") {
      const sub = r.inner.filter((x) => hits(x.classes));
      if (sub.length) kept.push(`${r.head} {\n${sub.map((x) => x.text).join("\n")}\n}`);
    }
  }
  const names = new Set([...kept.join("\n").matchAll(/animation(?:-name)?\s*:\s*([\w-]+)/g)].map((m) => m[1]));
  for (const r of rules) if (r.kind === "keyframes" && names.has(r.name)) kept.push(r.text);
  return kept;
}

export function partCss(part, pageCss) {
  return cssFor(part.markup, part.rulesFile, pageCss).join("\n");
}

// The CSS new markup needs, from every captured sheet one of its parts came
// from: found from the markup itself, so whoever wrote it needn't say which
// parts it used. Each rule once.
export function cssForMarkup(markup, parts, pageCss) {
  const files = new Set(parts.filter((pt) => pt.rulesFile && pt.markup).map((pt) => pt.rulesFile));
  const seen = new Set();
  const out = [];
  for (const f of files) for (const r of cssFor(markup, f, pageCss)) if (!seen.has(r)) { seen.add(r); out.push(r); }
  return out.join("\n");
}
