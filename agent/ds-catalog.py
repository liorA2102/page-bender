#!/usr/bin/env python3
"""Build catalog.html and tokens.css for a design-system folder.

    python3 agent/ds-catalog.py design-systems/<product>/<date>

Reads:
  tokens.json      written by the agent during extraction (see the skill's A3 step)
  raw/index.json   components and pages, as copied in from the captures
  raw/coverage.json  optional: checklist items marked captured / not found, with notes
Writes:
  tokens.css       every token as a CSS custom property, grouped by family
  catalog.html     a page for a person browsing the design system: a sticky sidebar
                   (sections, families, every component, a family filter), one token
                   table per family, every component rendered live from its own file
                   (real CSS), page thumbnails, and coverage

The catalog is for people only. Agents read tokens.json and raw/index.json directly.

The catalog's own chrome follows the workspace HTML standard (token contract, dark mode,
system sans, 12px floor). The components inside it are the product's, untouched: each one
is an iframe onto its packed component file, so what you see is the capture itself.

Only reads and writes inside the design-system folder.
"""

import html
import json
import os
import re
import sys


def esc(s):
    return html.escape(str(s), quote=True)


def slug(s):
    return re.sub(r"[^a-z0-9]+", "-", str(s).lower()).strip("-")


def css_name(family, group, name):
    return f"--{slug(family)}-{slug(group)}-{slug(name)}"


def write_tokens_css(ds, tokens):
    lines = [f"/* {tokens.get('product', '')} design tokens, measured {tokens.get('date', '')}.",
             "   Generated from tokens.json by agent/ds-catalog.py. Values are the product's own. */",
             ":root {"]
    for fam in tokens["families"]:
        lines.append(f"  /* {fam['name']}: {fam.get('description', '')} */")
        for group, entries in fam["tokens"].items():
            for t in entries:
                lines.append(f"  {css_name(fam['name'], group, t['name'])}: {t['value']};")
    lines.append("}")
    with open(os.path.join(ds, "tokens.css"), "w", encoding="utf-8") as f:
        f.write("\n".join(lines) + "\n")


def badge_meta(ds, comp):
    """The real element descriptor the capture recorded in its stage badge, e.g. a.AppsList-module__addBtn."""
    try:
        text = open(os.path.join(ds, comp["file"]), encoding="utf-8").read()
    except OSError:
        return ""
    m = re.search(r'pbx-section-badge-meta">([^<]*)<', text)
    if not m:
        return "full page"
    return html.unescape(m.group(1)).split(" · ", 1)[-1]


COLOR_GROUPS = {"color", "colors"}
PROSE_GROUPS = {"note", "notes"}


def token_row(group, t):
    """One table row: Token | Value | Where measured."""
    value = esc(t["value"])
    where = esc(t.get("where", ""))
    note = esc(t.get("note", ""))
    where_cell = where + (f" · {note}" if note else "")
    name = f'<span class="tn">{esc(t["name"])}</span>'
    if group in COLOR_GROUPS:
        val = f'<span class="sw" style="background:{value}"></span><code>{value}</code>'
    elif group == "type":
        fam = t.get("family", "inherit")
        spec_style = (f"font-weight:{esc(t.get('weight', 400))};font-size:{value};"
                      f"font-family:{esc(fam)}")
        name += f'<span class="spec" style="{spec_style}">{esc(t.get("sample", t["name"]))}</span>'
        parts = [t["value"], t.get("weight", ""), t.get("lineHeight", "")]
        val = (f'<code>{esc(" / ".join(str(p) for p in parts if p != ""))}</code>'
               f'<span class="sub" title="{esc(fam)}">{esc(fam)}</span>')
    elif group in PROSE_GROUPS:
        val = f'<span class="prose">{value}</span>'
    else:
        val = f"<code>{value}</code>"
    return (f'<tr><th scope="row">{name}</th><td class="tv">{val}</td>'
            f'<td class="tw">{where_cell}</td></tr>')


CSS = """
:root {
  --ground: #fbfbfa; --surface: #f1f2f3; --line: #dcdfe3;
  /* --gray-dim deepened from #6b7076 (4.46:1 on --surface) so sidebar labels clear 4.5:1: 4.73 there, 5.12 on --ground. */
  --ink: #15181d; --gray: #4b5057; --gray-dim: #676c72;
  --accent: #d12052; --accent-tint: color-mix(in srgb, var(--accent) 10%, var(--ground));
  --on-accent: #ffffff;
  --chip: #ffffff; --chip-ink: #15181d; --chip-accent: color-mix(in srgb, #d12052 12%, #ffffff);
  --font: ui-sans-serif, -apple-system, "SF Pro Display", "Segoe UI", Inter, system-ui, sans-serif;
  --mono: ui-monospace, "SF Mono", Menlo, monospace;
  --t-body: 15px; --t-small: 13px; --t-h1: 30px; --t-h2: 21px; --t-h3: 17px;
  --gap-block: 40px; --gap-el: 14px; --pad: 72px; --side: 252px;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    --ground: #121417; --surface: #1b1e22; --line: #2d3137;
    --ink: #eef0f2; --gray: #b9bec5; --gray-dim: #9aa0a8; --accent: #f0487a; --on-accent: #121417;
  }
}
:root[data-theme="dark"] {
  --ground: #121417; --surface: #1b1e22; --line: #2d3137;
  --ink: #eef0f2; --gray: #b9bec5; --gray-dim: #9aa0a8; --accent: #f0487a; --on-accent: #121417;
}
* { box-sizing: border-box; }
@media (prefers-reduced-motion: no-preference) { html { scroll-behavior: smooth; } }
body { margin: 0; background: var(--ground); color: var(--ink); font: 400 var(--t-body)/1.55 var(--font);
  display: grid; grid-template-columns: var(--side) minmax(0, 1fr); }
a { color: inherit; }
:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }

/* Sidebar */
.side { position: sticky; top: 0; height: 100vh; overflow-y: auto; overscroll-behavior: contain;
  background: var(--surface); border-right: 1px solid var(--line); padding: 22px 16px 32px; }
.side-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
.brand { display: flex; flex-direction: column; text-decoration: none; }
.brand .bn { font-size: var(--t-h3); font-weight: 650; letter-spacing: -.02em; }
.menu { display: none; font: 600 var(--t-small)/1 var(--font); color: var(--ink); background: var(--ground);
  border: 1px solid var(--line); border-radius: 999px; padding: 8px 14px; cursor: pointer; }
.side-label { font-size: 12px; font-weight: 650; letter-spacing: .14em; text-transform: uppercase;
  color: var(--gray-dim); margin: 22px 0 8px; }
.filter-btns { display: flex; flex-wrap: wrap; gap: 6px; }
.filter-btns button { font: 600 var(--t-small)/1 var(--font); color: var(--ink); background: var(--ground);
  border: 1px solid var(--line); border-radius: 999px; padding: 7px 11px; cursor: pointer; }
.filter-btns button[aria-pressed="true"] { background: var(--accent); color: var(--on-accent);
  border-color: var(--accent); }
.side nav ul { list-style: none; margin: 0; padding: 0; }
.side nav > ul > li { margin-top: 2px; }
.side nav a { display: flex; justify-content: space-between; gap: 8px; text-decoration: none;
  color: var(--gray); border-left: 2px solid transparent; padding: 5px 10px; font-size: 14px; font-weight: 600; }
.side nav ul ul a { font-size: var(--t-small); font-weight: 400; padding: 3px 10px 3px 22px; }
.side nav a .n { color: var(--gray-dim); font-weight: 400; font-size: 12px; font-variant-numeric: tabular-nums; }
.side nav a.active { color: var(--ink); border-left-color: var(--accent); }
.side nav ul ul a.active { font-weight: 650; }
@media (hover: hover) and (pointer: fine) {
  .side nav a:hover { color: var(--ink); }
  .filter-btns button:hover, .menu:hover { border-color: var(--accent); }
  .filter-btns button[aria-pressed="true"]:hover { border-color: var(--ground); }
}

/* Main column */
main { padding: var(--gap-block) var(--pad) 96px; max-width: 1480px; width: 100%; margin: 0 auto; min-width: 0; }
header.top { display: flex; flex-wrap: wrap; align-items: baseline; justify-content: space-between;
  gap: var(--gap-el); border-bottom: 1px solid var(--line); padding-bottom: var(--gap-el); }
h1 { font-size: var(--t-h1); font-weight: 650; letter-spacing: -.03em; margin: 0; text-wrap: balance; }
h2 { font-size: var(--t-h2); font-weight: 650; letter-spacing: -.02em; margin: var(--gap-block) 0 var(--gap-el); }
h3 { font-size: var(--t-h3); font-weight: 650; margin: 0 0 4px; }
section[id], figure[id] { scroll-margin-top: var(--gap-el); }
.kicker { font-size: 12px; font-weight: 650; letter-spacing: .18em; text-transform: uppercase; color: var(--accent); }
.meta { color: var(--gray); font-size: var(--t-small); }
.lead { color: var(--gray); margin: 0 0 var(--gap-el); max-width: 60ch; }
code { font-family: var(--mono); font-size: 12px; color: var(--gray); overflow-wrap: anywhere; }
.scroll { overflow-x: auto; }
table { width: 100%; border-collapse: collapse; font-size: var(--t-small); }
th, td { text-align: left; vertical-align: top; padding: 9px 12px 9px 0; border-bottom: 1px solid var(--line); }
thead th { font-size: 12px; font-weight: 650; letter-spacing: .08em; text-transform: uppercase; color: var(--gray-dim); }
tbody th { font-weight: 650; }
td { color: var(--gray); }
.fam-table tbody th { white-space: nowrap; }

/* Token tables */
.fam { margin-bottom: var(--gap-block); }
.tt { table-layout: fixed; }
.tt col.c-tok { width: 32%; } .tt col.c-val { width: 30%; } .tt col.c-where { width: 38%; }
.tt tr.grp th { font-size: 12px; font-weight: 650; letter-spacing: .14em; text-transform: uppercase;
  color: var(--gray-dim); padding-top: 18px; }
.tt tbody th, .tt td { vertical-align: middle; }
.tt .tn { display: block; }
.tt .spec { display: block; color: var(--ink); line-height: 1.35; margin-top: 3px;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.tt .tv code { color: var(--ink); vertical-align: middle; }
.tt .sw { display: inline-block; vertical-align: middle; width: 22px; height: 22px; margin-right: 8px;
  border-radius: 5px; border: 1px solid var(--line); box-shadow: inset 0 0 0 1px rgba(0,0,0,.08); }
.tt .sub { display: block; font-size: 12px; color: var(--gray-dim); margin-top: 2px;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.tt .prose { color: var(--ink); }

/* Cards */
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(320px, 100%), 1fr)); gap: 16px; }
figure { margin: 0; background: var(--surface); border: 1px solid var(--line); border-radius: 12px;
  overflow: hidden; display: flex; flex-direction: column; min-width: 0; }
figure iframe { width: 100%; height: 240px; border: 0; background: #fff; display: block; resize: vertical; }
figure.page img { width: 100%; display: block; aspect-ratio: 16 / 10; object-fit: cover; object-position: top left; background: #fff; }
figcaption { display: flex; flex-direction: column; gap: 4px; padding: 11px 14px 12px; font-size: var(--t-small); min-width: 0; }
.cap-row { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 10px; }
.cap-row .cn { font-weight: 650; }
.cap-sub { display: flex; align-items: baseline; gap: 10px; color: var(--gray); min-width: 0; }
.cap-sub .src { flex: none; }
.reveal { display: flex; align-items: baseline; gap: 10px; min-width: 0; flex: 1; transition: opacity .12s; }
.reveal code { flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; overflow-wrap: normal; }
.reveal a { flex: none; margin-left: auto; color: var(--accent); font-weight: 650; text-decoration: none; }
@media (hover: hover) and (pointer: fine) {
  .reveal { opacity: 0; }
  figure.comp:hover .reveal, figure.comp:focus-within .reveal { opacity: 1; }
  .reveal a:hover { text-decoration: underline; }
}
.chip { background: var(--chip-accent); color: var(--chip-ink); border-radius: 999px; padding: 3px 9px; font-size: 12px; font-weight: 650; }
.empty { color: var(--gray); }
tr.miss th { color: var(--gray); }
.cov-table td:nth-child(2) { white-space: nowrap; }
tr.miss td:nth-child(2) { color: var(--accent); font-weight: 650; }
figure.comp.wide { grid-column: 1 / -1; }
#comp-grid { grid-auto-flow: row dense; }  /* small cards fill the hole a wide one leaves */
.hidden { display: none !important; }

@media (max-width: 1199px) { :root { --pad: 40px; } }
@media (max-width: 899px) {
  :root { --pad: 16px; }
  body { display: block; }
  .side { position: sticky; top: 0; z-index: 10; height: auto; overflow: visible; padding: 10px 16px;
    border-right: 0; border-bottom: 1px solid var(--line); }
  .brand { flex-direction: row; align-items: baseline; gap: 10px; }
  .menu { display: inline-block; }
  /* The open panel overlays the page, so opening or closing it never shifts content under an anchor jump. */
  .side-panel { display: none; position: absolute; left: 0; right: 0; top: 100%; max-height: calc(100vh - 64px);
    overflow-y: auto; padding: 0 16px 16px; background: var(--surface); border-bottom: 1px solid var(--line); }
  .side.open .side-panel { display: block; }
  section[id], figure[id] { scroll-margin-top: 72px; }
  main { padding: 24px var(--pad) 64px; }
}
@media (max-width: 600px) {
  .tt, .tt tbody { display: block; }
  .tt colgroup, .tt thead { display: none; }
  .tt tr { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); column-gap: 12px;
    border-bottom: 1px solid var(--line); padding: 8px 0; }
  .tt tr.grp { padding: 0; }
  .tt tr.grp th { grid-column: 1 / -1; }
  .tt th, .tt td { border-bottom: 0; padding: 0; }
  .tt td.tw { grid-column: 1 / -1; margin-top: 4px; }
}
"""

JS = """
(() => {
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const desktop = window.matchMedia("(min-width: 900px)");

  // Size each component frame to its content where the browser allows it (served over http).
  // Opened from disk, frames are cross-origin and keep their default height; drag to resize.
  function fitHeight(f) {
    try {
      // The body's own box, not the document's scroll height, which never
      // reports less than the frame's current height.
      const h = Math.ceil(f.contentDocument.body.getBoundingClientRect().height);
      if (h) f.style.height = Math.min(Math.max(h, 90), 720) + "px";
    } catch (e) { /* file:// origin, keep the default */ }
  }
  $$("figure.comp iframe").forEach((f) => {
    f.addEventListener("load", () => {
      try {
        // Wide components (tables, grids, headers) get the full row, so they
        // render at the width they had in the product instead of being squeezed.
        // The capture pins the element's real product width inline, so that is
        // the width to test, not the stage frame, which shrinks to the card.
        const root = f.contentDocument.querySelector(".pbx-section-frame > *");
        const w = root ? parseFloat(root.style.width) || root.scrollWidth : 0;
        if (w > f.clientWidth - 48) f.closest("figure").classList.add("wide");
      } catch (e) { /* file:// origin, keep the default */ }
      fitHeight(f);
      // Widening reflows the content, so measure again once layout settles.
      requestAnimationFrame(() => fitHeight(f));
    });
  });

  // Family filter: components, token tables and their sidebar links together.
  const buttons = $$(".filter-btns button");
  const compEmpty = $("#comp-empty");
  const compCount = $("#comp-count");
  function applyFilter(f) {
    buttons.forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.f === f)));
    $$("[data-family]").forEach((el) => el.classList.toggle("hidden", !!f && el.dataset.family !== f));
    const shown = $$("figure.comp:not(.hidden)").length;
    if (compEmpty) compEmpty.classList.toggle("hidden", shown > 0);
    if (compCount) compCount.textContent = shown;
    update();
  }
  buttons.forEach((b) => b.addEventListener("click", () => applyFilter(b.dataset.f)));

  // Current-section highlight. The observer's root is the top quarter of the
  // viewport, so it fires whenever a section edge crosses that line; each firing
  // re-reads positions and picks the last visible section whose top is above it.
  const links = new Map();
  $$(".side nav a[href^='#']").forEach((a) => links.set(a.getAttribute("href").slice(1), a));
  const tops = $$("main section.sec");
  const subs = $$("main section.fam, main figure.comp");
  const side = $(".side");
  // Cards share rows, so a later card only wins when it starts lower: the first
  // card of the current row is the current one, not the last.
  function pick(list, line) {
    let cur = null, curTop = -Infinity;
    for (const el of list) {
      if (el.classList.contains("hidden")) continue;
      const t = el.getBoundingClientRect().top;
      if (t <= line && t > curTop + 1) { cur = el; curTop = t; }
    }
    return cur;
  }
  function keepInView(a) {
    if (!desktop.matches || !side) return;
    const r = a.getBoundingClientRect(), s = side.getBoundingClientRect();
    if (r.top < s.top + 24 || r.bottom > s.bottom - 24) side.scrollTop += r.top - s.top - s.height / 2;
  }
  function update() {
    const line = window.innerHeight * 0.25;
    const atBottom = window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 4;
    const top = atBottom ? tops[tops.length - 1] : (pick(tops, line) || tops[0]);
    let sub = pick(subs, line);
    if (sub && !(top && top.contains(sub))) sub = null;
    links.forEach((a) => a.classList.remove("active"));
    if (top && links.get(top.id)) links.get(top.id).classList.add("active");
    if (sub && links.get(sub.id)) { links.get(sub.id).classList.add("active"); keepInView(links.get(sub.id)); }
    else if (top && links.get(top.id)) keepInView(links.get(top.id));
  }
  // Observer callbacks are already batched per frame, so update runs directly.
  const schedule = () => update();
  if ("IntersectionObserver" in window) {
    const band = new IntersectionObserver(schedule, { rootMargin: "0px 0px -75% 0px", threshold: 0 });
    [...tops, ...subs].forEach((el) => band.observe(el));
    const end = $("#end");
    if (end) new IntersectionObserver(schedule).observe(end);
  } else {
    window.addEventListener("scroll", schedule, { passive: true });
  }
  window.addEventListener("resize", schedule);
  update();

  // Narrow screens: the sidebar is a top bar with a menu toggle.
  const menu = $(".menu");
  if (menu && side) {
    menu.addEventListener("click", () => {
      const open = side.classList.toggle("open");
      menu.setAttribute("aria-expanded", String(open));
    });
    $$(".side nav a").forEach((a) => a.addEventListener("click", () => {
      if (desktop.matches) return;
      side.classList.remove("open");
      menu.setAttribute("aria-expanded", "false");
    }));
  }
})();
"""


def build(ds):
    tokens = json.load(open(os.path.join(ds, "tokens.json"), encoding="utf-8"))
    index = json.load(open(os.path.join(ds, "raw", "index.json"), encoding="utf-8"))
    cov_path = os.path.join(ds, "raw", "coverage.json")
    coverage = json.load(open(cov_path, encoding="utf-8")) if os.path.exists(cov_path) else []
    write_tokens_css(ds, tokens)

    product = tokens.get("product", "Product")
    fam_names = {f["key"]: f["name"] for f in tokens["families"]}

    fam_rows = "".join(
        f'<tr><th scope="row">{esc(f["name"])}</th><td>{esc(f.get("description", ""))}</td><td>{esc(", ".join(f.get("pages", [])))}</td></tr>'
        for f in tokens["families"])

    # One compact table per family: group header rows, then Token | Value | Where measured.
    token_sections = []
    for f in tokens["families"]:
        bodies = []
        for group, entries in f["tokens"].items():
            rows = "".join(token_row(group, t) for t in entries)
            bodies.append(f'<tbody><tr class="grp"><th colspan="3" scope="colgroup">{esc(group)}</th></tr>{rows}</tbody>')
        token_sections.append(
            f'<section class="fam" id="fam-{esc(f["key"])}" data-family="{esc(f["key"])}">'
            f'<h3>{esc(f["name"])}</h3><p class="lead">{esc(f.get("description", ""))}</p>'
            f'<table class="tt"><colgroup><col class="c-tok"><col class="c-val"><col class="c-where"></colgroup>'
            f'<thead><tr><th scope="col">Token</th><th scope="col">Value</th><th scope="col">Where measured</th></tr></thead>'
            f'{"".join(bodies)}</table></section>')

    comp_cards, comp_links, seen = [], [], set()
    for c in index["components"]:
        fam_key = c.get("family", "")
        fam = fam_names.get(fam_key, fam_key)
        cid = "comp-" + (slug(c["name"]) or "item")
        n = 2
        while cid in seen:
            cid = f"comp-{slug(c['name'])}-{n}"
            n += 1
        seen.add(cid)
        meta = badge_meta(ds, c)
        comp_cards.append(
            f'<figure class="comp" id="{cid}" data-family="{esc(fam_key)}">'
            f'<iframe loading="lazy" src="{esc(c["file"])}" title="{esc(c["name"])}"></iframe>'
            f'<figcaption><div class="cap-row"><span class="cn">{esc(c["name"])}</span><span class="chip">{esc(fam)}</span></div>'
            f'<div class="cap-sub"><span class="src">{esc(c["page"])}</span>'
            f'<span class="reveal"><code title="{esc(meta)}">{esc(meta)}</code>'
            f'<a href="{esc(c["file"])}" aria-label="Open {esc(c["name"])} on its own">open</a></span></div>'
            f'</figcaption></figure>')
        comp_links.append(f'<li data-family="{esc(fam_key)}"><a href="#{cid}">{esc(c["name"])}</a></li>')

    fam_links = "".join(
        f'<li data-family="{esc(f["key"])}"><a href="#fam-{esc(f["key"])}">{esc(f["name"])}</a></li>'
        for f in tokens["families"])

    page_cards = "".join(
        f'<figure class="page"><a href="{esc(p["file"])}"><img loading="lazy" src="{esc(p["screenshot"])}" alt="{esc(p["page"])} screenshot"></a>'
        f'<figcaption><div class="cap-row"><span class="cn">{esc(p["page"])}</span><span class="chip">{esc(fam_names.get(p.get("family"), p.get("family", "")))}</span></div>'
        f'<div class="cap-sub"><code>{esc(p.get("url", ""))}</code></div></figcaption></figure>'
        for p in index["pages"])

    cov_rows = "".join(
        f'<tr class="{"ok" if c.get("status") == "captured" else "miss"}"><th scope="row">{esc(c["item"])}</th>'
        f'<td>{esc(c.get("status", ""))}</td><td>{esc(c.get("source", ""))}</td><td>{esc(c.get("note", ""))}</td></tr>'
        for c in coverage)
    captured = sum(1 for c in coverage if c.get("status") == "captured")

    filters = "".join(f'<button type="button" data-f="{esc(f["key"])}" aria-pressed="false">{esc(f["name"])}</button>'
                      for f in tokens["families"])

    n_comp, n_page = len(index["components"]), len(index["pages"])
    coverage_link = f'<li><a href="#coverage">Coverage <span class="n">{captured}/{len(coverage)}</span></a></li>' if coverage else ""
    coverage_sec = (
        f'<section class="sec" id="coverage"><h2>Coverage</h2><div class="scroll"><table class="cov-table">'
        f'<thead><tr><th scope="col">Checklist item</th><th scope="col">Status</th><th scope="col">Source</th><th scope="col">Note</th></tr></thead>'
        f'<tbody>{cov_rows}</tbody></table></div></section>') if coverage else ""

    page = f"""<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{esc(product)} Design System</title>
<style>{CSS}</style>
<aside class="side" aria-label="Catalog navigation">
  <div class="side-head">
    <a class="brand" href="#top"><span class="kicker">Design system</span><span class="bn">{esc(product)}</span></a>
    <button class="menu" type="button" aria-expanded="false" aria-controls="side-panel">Menu</button>
  </div>
  <div class="side-panel" id="side-panel">
    <div class="side-label" id="filter-label">Family</div>
    <div class="filter-btns" role="group" aria-labelledby="filter-label"><button type="button" data-f="" aria-pressed="true">All</button>{filters}</div>
    <div class="side-label">Contents</div>
    <nav aria-label="Sections"><ul>
      <li><a href="#families">Families</a></li>
      <li><a href="#tokens">Tokens</a><ul>{fam_links}</ul></li>
      <li><a href="#components">Components <span class="n" id="comp-count">{n_comp}</span></a><ul>{"".join(comp_links)}</ul></li>
      <li><a href="#pages">Pages <span class="n">{n_page}</span></a></li>
      {coverage_link}
    </ul></nav>
  </div>
</aside>
<main id="top">
<header class="top">
  <div><div class="kicker">Design system</div><h1>{esc(product)}</h1></div>
  <div class="meta">{esc(tokens.get("host", ""))} · measured {esc(tokens.get("date", ""))} · {n_comp} components · {n_page} pages{f" · {captured}/{len(coverage)} checklist items" if coverage else ""}</div>
</header>

<section class="sec" id="families">
<h2>Families</h2>
<p class="lead">{esc(tokens.get("familiesNote", ""))}</p>
<div class="scroll"><table class="fam-table"><thead><tr><th scope="col">Family</th><th scope="col">What it is</th><th scope="col">Pages</th></tr></thead><tbody>{fam_rows}</tbody></table></div>
</section>

<section class="sec" id="tokens">
<h2>Tokens</h2>
<p class="lead">Measured on the live product: the style census counts what each page actually paints. Also in <code>tokens.css</code>.</p>
{"".join(token_sections)}
</section>

<section class="sec" id="components">
<h2>Components</h2>
<p class="lead">Each one is its own Page Bender capture, rendered live against the product's real stylesheet. Drag a frame's corner to see more of it.</p>
<div class="grid" id="comp-grid">{"".join(comp_cards)}</div>
<p class="empty hidden" id="comp-empty">No components captured for this family.</p>
</section>

<section class="sec" id="pages">
<h2>Pages</h2>
<div class="grid">{page_cards}</div>
</section>
{coverage_sec}
<div id="end" aria-hidden="true"></div>
</main>
<script>{JS}</script>
"""
    with open(os.path.join(ds, "catalog.html"), "w", encoding="utf-8") as f:
        f.write(page)
    print(f"catalog.html: {n_comp} components, {n_page} pages, {len(coverage)} coverage items")


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    build(sys.argv[1].rstrip("/"))
