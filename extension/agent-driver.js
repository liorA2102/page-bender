// Page Bender — agent driver.
//
// Lets an agent look at and move around a page so it can find more
// components to capture. Injected by background.js into the top frame of a
// tab the agent is driving, in the extension's isolated world: it sees the
// page's DOM but not the page's scripts, and the page cannot see it.
// background.js only ever injects it into a tab on a non-prod host (see
// isNonProdHost there); this file does not re-check that.
//
// Elements are handed to the agent as numbered refs held in memory here, not
// as attributes written onto the DOM, so nothing the driver does can leak into
// a capture of the same page.
//
// Clicking is guarded twice. The real guard lives in background.js: every
// write request (POST, PUT, PATCH, DELETE) from a driven tab is blocked, so
// even a wrong click cannot save anything. This file adds a second, cheaper
// one: it refuses to click anything that reads as a commit action, and it
// swallows form submits, so the page does not even try.
(() => {
  if (window.__pbDriver) return;

  // Whole words only, matched on the element's visible text, aria-label,
  // title and value. "New test" or "Add filter" opens something and is fine;
  // "Save" or "Delete" inside the dialog it opens is not.
  const COMMIT_WORDS = /\b(save|submit|apply|approve|reject|decline|delete|remove|confirm|publish|send|archive|deactivate|activate|disable|enable|launch|deploy|revoke|grant|reset|yes|ok|accept|update|create|import|upload|duplicate|clone|sync|run|start|stop|pause|resume|assign|unassign)\b/i;

  const INTERACTIVE = [
    "a[href]", "button", "input:not([type=hidden])", "select", "textarea", "summary",
    "[role=button]", "[role=link]", "[role=tab]", "[role=menuitem]", "[role=option]",
    "[role=checkbox]", "[role=switch]", "[role=combobox]", "[role=treeitem]", "[onclick]",
  ].join(",");
  // Structural regions worth capturing on their own as components.
  const REGIONS = [
    "nav", "header", "aside", "form", "table", "[role=dialog]", "dialog[open]", ".modal.show", ".modal.in",
    "[role=tablist]", "[role=grid]", "[role=alert]", "[role=status]", "[role=menu]", "[role=listbox]",
  ].join(",");

  let refs = [];

  // Swallow any form submit while the driver is loaded. Capture phase on the
  // document, so it runs before the page's own handlers.
  document.addEventListener("submit", (e) => { e.preventDefault(); e.stopImmediatePropagation(); }, true);

  function isVisible(el) {
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return false;
    const cs = getComputedStyle(el);
    return cs.visibility !== "hidden" && cs.display !== "none" && Number(cs.opacity) > 0;
  }

  function label(el) {
    const text = (el.getAttribute("aria-label") || el.innerText || el.value || el.getAttribute("title") || el.getAttribute("placeholder") || "")
      .replace(/\s+/g, " ").trim();
    return text.slice(0, 80);
  }

  function describe(el, kind) {
    const r = el.getBoundingClientRect();
    refs.push(el);
    return {
      ref: refs.length - 1,
      kind,
      tag: el.tagName.toLowerCase(),
      role: el.getAttribute("role") || undefined,
      type: el.getAttribute("type") || undefined,
      text: label(el) || undefined,
      disabled: el.disabled || el.getAttribute("aria-disabled") === "true" || undefined,
      inDialog: !!el.closest("[role=dialog], dialog, .modal") || undefined,
      box: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)],
    };
  }

  // Custom controls (a styled div with a click handler, like CMS's "System"
  // dropdown) match none of INTERACTIVE. The one signal they reliably share
  // is cursor: pointer, so the outermost element showing it counts too. Only
  // the outermost: its children inherit the cursor and would each show up as
  // a duplicate.
  function pointerControls(seen) {
    const found = [];
    const all = document.body ? document.body.getElementsByTagName("*") : [];
    for (let i = 0; i < all.length && i < 8000 && found.length < 80; i++) {
      const el = all[i];
      if (seen.has(el) || el.closest(INTERACTIVE)) continue;
      if (getComputedStyle(el).cursor !== "pointer") continue;
      const parent = el.parentElement;
      if (parent && getComputedStyle(parent).cursor === "pointer") continue;
      if (!isVisible(el) || !label(el)) continue;
      found.push(el);
    }
    return found;
  }

  // Resolves once the page has gone quiet: no DOM changes for quietMs and no
  // visible loading indicator. A fixed delay was not enough: CMS answered
  // "Loading…" for 5-8s after a route change. Gives up after timeoutMs and
  // says so, rather than hanging the drive.
  const LOADING = /^\s*loading\b/i;
  function loadingVisible() {
    if (document.querySelector("[aria-busy=true]")) return true;
    const candidates = document.querySelectorAll(".spinner, .loading, .loader, [class*=spinner], [class*=loading]");
    for (const el of candidates) if (isVisible(el)) return true;
    // Progress bars and skeletons animate in CSS alone, so the page goes
    // "quiet" while they still run (CMS's Material UI grids load this way).
    // An indeterminate progress bar has no aria-valuenow; a toast's countdown
    // bar is not loading.
    const busy = document.querySelectorAll("[role=progressbar]:not([aria-valuenow]), [class*=Indeterminate], [class*=indeterminate], [class*=skeleton], [class*=Skeleton], .ant-spin-spinning");
    for (const el of busy) if (!el.closest("[class*=Toastify], [class*=toast]") && isVisible(el)) return true;
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(), i = 0; n && i < 5000; n = walker.nextNode(), i++) {
      if (LOADING.test(n.nodeValue) && n.parentElement && isVisible(n.parentElement)) return true;
    }
    return false;
  }

  // opts may arrive as null (callDriver passes null for "no argument"), which
  // a destructuring default does not cover.
  function settle(opts) {
    const { quietMs = 700, timeoutMs = 15000 } = opts || {};
    return new Promise((resolveSettle) => {
      const started = Date.now();
      let lastChange = Date.now();
      const obs = new MutationObserver(() => { lastChange = Date.now(); });
      obs.observe(document.documentElement, { childList: true, subtree: true, attributes: true, characterData: true });
      // The timeout is checked first and the loading check is guarded: if
      // that check ever threw, the promise would never resolve and the whole
      // drive would hang with no error anywhere.
      const tick = setInterval(() => {
        const waited = Date.now() - started;
        let loading = false;
        let checkError = null;
        try {
          loading = Date.now() - lastChange >= quietMs ? loadingVisible() : true;
        } catch (err) {
          checkError = err.message;
        }
        if (waited >= timeoutMs || checkError || !loading) {
          clearInterval(tick);
          obs.disconnect();
          resolveSettle({ settledMs: waited, timedOut: waited >= timeoutMs, ...(checkError ? { checkError } : {}) });
        }
      }, 150);
    });
  }

  // A compact outline of what is on screen: regions (capture candidates) and
  // interactive elements (things to open). Refs reset on every snapshot.
  function snapshot() {
    refs = [];
    const regions = Array.from(document.querySelectorAll(REGIONS)).filter(isVisible).slice(0, 60).map((el) => describe(el, "region"));
    const seen = new Set();
    const items = [];
    for (const el of document.querySelectorAll(INTERACTIVE)) {
      if (items.length >= 250) break;
      if (seen.has(el) || !isVisible(el)) continue;
      seen.add(el);
      items.push(describe(el, "interactive"));
    }
    for (const el of pointerControls(seen)) items.push(describe(el, "custom"));
    return {
      ok: true,
      url: location.href,
      title: document.title,
      viewport: [innerWidth, innerHeight],
      dialogOpen: regions.some((r) => r.inDialog || r.role === "dialog" || r.tag === "dialog"),
      regions,
      items,
    };
  }

  function resolve(ref) {
    const el = refs[ref];
    if (!el) return { error: `unknown ref ${ref}: take a new snapshot, refs reset on every one` };
    if (!el.isConnected) return { error: `ref ${ref} is no longer on the page: take a new snapshot` };
    return { el };
  }

  function click(ref) {
    const { el, error } = resolve(ref);
    if (error) return { ok: false, error };
    const target = el.closest("button, a, [role=button], [role=menuitem], [role=tab], input, summary") || el;
    const text = label(target);
    if (target.matches("[type=submit], input[type=reset]")) {
      return { ok: false, refused: true, error: `refused: ref ${ref} is a submit button ("${text}")` };
    }
    if (COMMIT_WORDS.test(text)) {
      return { ok: false, refused: true, error: `refused: "${text}" reads as a commit action. Open and cancel only` };
    }
    target.scrollIntoView({ block: "center", inline: "center" });
    target.click();
    return { ok: true, clicked: text };
  }

  function hover(ref) {
    const { el, error } = resolve(ref);
    if (error) return { ok: false, error };
    el.scrollIntoView({ block: "center", inline: "center" });
    for (const type of ["pointerover", "pointerenter", "mouseover", "mouseenter", "mousemove"]) {
      el.dispatchEvent(new MouseEvent(type, { bubbles: type !== "mouseenter" && type !== "pointerenter", cancelable: true, view: window }));
    }
    return { ok: true };
  }

  // Closes whatever the explorer just opened. Escape first; many dropdowns
  // ignore it (CMS's customer picker does) and close on a click outside them
  // instead, so that follows, aimed at <body> itself, which is not a control
  // and so activates nothing.
  function escape() {
    const target = document.activeElement || document.body;
    for (const type of ["keydown", "keyup"]) {
      target.dispatchEvent(new KeyboardEvent(type, { key: "Escape", code: "Escape", keyCode: 27, which: 27, bubbles: true, cancelable: true }));
    }
    const at = { bubbles: true, cancelable: true, view: window, clientX: innerWidth - 5, clientY: innerHeight - 5 };
    for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]) {
      const Ctor = type.startsWith("pointer") ? PointerEvent : MouseEvent;
      document.body.dispatchEvent(new Ctor(type, at));
    }
    return { ok: true };
  }

  function scroll(dy) {
    window.scrollBy(0, Number(dy) || innerHeight * 0.8);
    return { ok: true, scrollY: Math.round(scrollY) };
  }

  // ---------- style census ----------
  // What the page actually paints, counted across visible elements: the raw
  // material for design tokens. Counting real usage (not reading stylesheet
  // text) keeps dead CSS out, and the counts show which value is the system
  // and which is a one-off. Custom properties declared on :root come along as
  // declared, since they are often the product's own token names.
  function bump(map, key, n = 1) {
    if (key == null || key === "") return;
    map.set(key, (map.get(key) || 0) + n);
  }

  function top(map, limit = 30) {
    return Array.from(map, ([value, count]) => ({ value, count })).sort((a, b) => b.count - a.count).slice(0, limit);
  }

  const TRANSPARENT = /^(transparent|rgba\(\s*0,\s*0,\s*0,\s*0\s*\))$/;

  function rootCustomProperties() {
    const out = {};
    const cs = getComputedStyle(document.documentElement);
    for (let i = 0; i < cs.length; i++) {
      const name = cs[i];
      if (name.startsWith("--")) out[name] = cs.getPropertyValue(name).trim();
    }
    return out;
  }

  function styles() {
    const text = new Map(), bg = new Map(), border = new Map(), family = new Map(), size = new Map();
    const weight = new Map(), radius = new Map(), shadow = new Map(), padding = new Map(), gap = new Map();
    // Type pairs (size/weight/line-height) weighted by characters, so body
    // text outranks a single large heading, which is what "body size" means.
    const typeScale = new Map();
    let counted = 0;
    const all = document.body ? document.body.getElementsByTagName("*") : [];
    for (let i = 0; i < all.length && counted < 6000; i++) {
      const el = all[i];
      if (!isVisible(el)) continue;
      counted++;
      const cs = getComputedStyle(el);
      const ownText = Array.from(el.childNodes).filter((n) => n.nodeType === 3).map((n) => n.nodeValue.trim()).join("");
      if (ownText) {
        bump(text, cs.color, ownText.length);
        bump(family, cs.fontFamily, ownText.length);
        bump(size, cs.fontSize, ownText.length);
        bump(weight, cs.fontWeight, ownText.length);
        bump(typeScale, `${cs.fontSize} / ${cs.fontWeight} / ${cs.lineHeight}`, ownText.length);
      }
      if (!TRANSPARENT.test(cs.backgroundColor)) bump(bg, cs.backgroundColor);
      if (cs.borderTopStyle !== "none" && parseFloat(cs.borderTopWidth) > 0) bump(border, `${cs.borderTopWidth} ${cs.borderTopStyle} ${cs.borderTopColor}`);
      if (cs.borderTopLeftRadius !== "0px") bump(radius, cs.borderRadius);
      if (cs.boxShadow !== "none") bump(shadow, cs.boxShadow);
      if (cs.padding !== "0px") bump(padding, cs.padding);
      if (cs.display.includes("flex") || cs.display.includes("grid")) {
        if (cs.gap && cs.gap !== "normal" && cs.gap !== "0px") bump(gap, cs.gap);
      }
    }
    return {
      ok: true,
      url: location.href,
      elementsCounted: counted,
      rootCustomProperties: rootCustomProperties(),
      body: (() => { const cs = getComputedStyle(document.body); return { background: cs.backgroundColor, color: cs.color, fontFamily: cs.fontFamily, fontSize: cs.fontSize }; })(),
      textColors: top(text),
      backgrounds: top(bg),
      borders: top(border, 20),
      fontFamilies: top(family, 10),
      fontSizes: top(size, 20),
      fontWeights: top(weight, 10),
      typeScale: top(typeScale, 20),
      radii: top(radius, 15),
      shadows: top(shadow, 10),
      paddings: top(padding, 20),
      gaps: top(gap, 15),
    };
  }

  // Lets a capture job name an element by snapshot ref instead of a selector.
  function element(ref) {
    return resolve(ref).el || null;
  }

  window.__pbDriver = { snapshot, click, hover, escape, scroll, element, settle, styles };
})();
