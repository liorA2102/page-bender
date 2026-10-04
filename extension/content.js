// Page Bender — content script.
//
// One job only: bake the live page's computed styles into a static HTML
// string, once, and hand it to the background script. Everything after
// capture (editing, selecting, screenshotting, undo/redo, diffing) happens
// on the mock page itself (see server/public/mock-toolbar.js), not here —
// this script never needs to run again after the mock tab opens.
(() => {
  if (window.__pageMockInjected) {
    window.__pageMockToggle && window.__pageMockToggle();
    return;
  }
  window.__pageMockInjected = true;

  // background.js injects this file into every frame (allFrames: true), not
  // just the top one — needed so a same-tab <iframe> can bake ITSELF when
  // asked (see requestFrameBake below). Only the top frame gets the visible
  // pill/section-select UI; a sub-frame instance stays invisible and only
  // ever responds to a bake request from its parent.
  const isTopFrame = window.top === window.self;

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  // Used by captureBakedHtml's section-capture badge (runs in every frame)
  // AND by the top-frame-only pill/select-button icons further down — has
  // to live out here, not inside the isTopFrame block, or captureBakedHtml
  // can't see it (a block-scoped const isn't visible outside its block no
  // matter what order things execute in).
  const svgIcon = (inner, size = 15) =>
    `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${inner}</svg>`;

  function absolutize(url, base = location.href) {
    try { return new URL(url, base).href; } catch { return url; }
  }

  // Rewrites every url(...) in captured CSS text to an absolute URL, EXCEPT
  // a bare "#id" fragment — that points at an element inside THIS document
  // (SVG paint servers: gradients/patterns/clip-paths via
  // fill/stroke:url(#id)), not an external resource. Absolutizing it into
  // "https://original-site.com/page#id" breaks it once the mock is opened
  // from a different origin/path (observed live: a chart's stroke
  // referenced its gradient this way, so the line rendered with axes but no
  // visible stroke at all). `base` defaults to the document's own URL, but a
  // stylesheet fetched from elsewhere (see captureRealStylesheets below)
  // must resolve its relative url()s against ITS OWN url instead.
  function absolutizeCssUrls(css, base = location.href) {
    return css.replace(/url\((['"]?)([^'")]+)\1\)/g, (m, q, u) => (u.startsWith("#") ? m : `url(${q}${absolutize(u, base)}${q})`));
  }

  // ---------- real stylesheet capture ----------
  // Copies each accessible stylesheet's actual rule text — real selectors,
  // real specificity, media queries, keyframes, :hover/:focus/:active — as a
  // single consolidated <style> block, instead of walking the DOM and
  // baking one computed-style snapshot per element. The old per-element
  // approach froze numbers (e.g. a flex child's width) that were only ever
  // correct because a live layout engine was actively deriving them from
  // real CSS; freeze them out of that context and they can stop adding up.
  // Keeping the real rules means the browser's own layout engine re-derives
  // everything correctly when the frozen file is reopened — nothing to get
  // wrong, no AI repair pass needed for structure. :hover/:focus and
  // ::before/::after content also come along for free this way, instead of
  // needing hand-rolled onmouseenter replay or fake DOM-node materialization.
  // Document order is preserved (cascade is order-dependent for equal-
  // specificity rules) since document.styleSheets already exposes sheets in
  // that order.
  async function captureRealStylesheets() {
    const blocks = [];
    const externalHrefs = [];
    for (const sheet of document.styleSheets) {
      // Inline <style> tags: read the author's own raw text instead of
      // reconstructing it from sheet.cssRules[i].cssText. Verified live:
      // Chromium's CSSOM cssText serializer silently corrupts any rule that
      // combines a `background: <value with var(...)>` shorthand with an
      // explicit background-clip override (the standard gradient-text-fill
      // trick) — every background-* longhand (image, position, size,
      // repeat, attachment, origin, color) comes back as an EMPTY string,
      // leaving only background-clip/color intact. That's a real Chromium
      // cssText bug, not something specific to any one captured site — the
      // author's own textContent never goes through that reconstruction, so
      // it can't hit it. Relative url()s in that raw text still need
      // resolving by hand (cssRules.cssText did this resolution for free as
      // a side effect of CSSOM serialization; raw textContent does not).
      if (!sheet.href && sheet.ownerNode && sheet.ownerNode.textContent) {
        blocks.push(absolutizeCssUrls(sheet.ownerNode.textContent));
        continue;
      }
      // External stylesheets: same cssText bug can hit these too, so always
      // fetch the real file rather than trust CSSOM reconstruction — not
      // just for the cross-origin case (below) where cssRules access throws
      // outright. Deferred to a second pass so document order among THESE
      // is preserved relative to each other; already not fully preserved
      // relative to inline sheets, which is an accepted pre-existing gap.
      if (sheet.href) {
        externalHrefs.push(sheet.href);
        continue;
      }
      // Last resort: a CSSOM-only sheet (e.g. a constructed/adopted
      // stylesheet) with no backing <style> tag or file to read raw text
      // from — cssRules.cssText is the only source available at all.
      let cssRules;
      try {
        cssRules = sheet.cssRules;
      } catch {
        continue;
      }
      const text = Array.from(cssRules).map((r) => r.cssText).join("\n");
      if (text) blocks.push(text);
    }
    let skippedSheets = 0;
    for (const href of externalHrefs) {
      try {
        const resp = await send({ type: "PM_FETCH_TEXT", url: href });
        if (!resp || !resp.ok) throw new Error((resp && resp.error) || "fetch failed");
        // Resolved against the STYLESHEET's own url, not the document's —
        // this text never went through the browser's own relative-url
        // resolution the way an in-DOM stylesheet's cssRules would have.
        blocks.push(absolutizeCssUrls(resp.text, href));
      } catch (err) {
        // A same-origin fetch failing here (unlike the cross-origin case
        // this path used to be limited to) means the file itself is
        // unreachable (deleted, network hiccup) — not a permissions issue.
        console.warn("[Page Bender] could not fetch stylesheet", href, err);
        skippedSheets++;
      }
    }
    return { css: blocks.join("\n"), skippedSheets };
  }

  // Real @font-face files, not just the resolved font-family NAME — the
  // mock's own document never had the custom font registered, so text would
  // silently fall back to a system font otherwise. Patches just the src
  // url(...) of each @font-face block already present in the captured CSS
  // text with a fetched, base64-embedded data URI — every other declared
  // property (weight, style, stretch, unicode-range, ...) is preserved
  // verbatim since the real rule text is never reconstructed, only patched.
  //
  // Observed live on CMS: its stylesheets repeat the same @font-face rules
  // dozens of times, all pointing at font files the site itself 404s on.
  // Fetching every copy one after another, with no timeout, kept the button
  // on "Capturing…" long enough to look hung. So each distinct url is
  // fetched at most once (success or failure is shared by every rule that
  // names it), fetches are time-boxed, and a rule's src list is tried in
  // format order (woff2 first, legacy .eot last) until one url loads.
  const FONT_FETCH_TIMEOUT_MS = 8000;
  const FONT_FETCH_CONCURRENCY = 6;
  function fontFormatRank(url) {
    if (/\.woff2($|[?#])/.test(url)) return 0;
    if (/\.woff($|[?#])/.test(url)) return 1;
    if (/\.(ttf|otf)($|[?#])/.test(url)) return 2;
    if (/\.eot($|[?#])/.test(url)) return 4;
    return 3;
  }
  async function fetchFontDataUri(url) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), FONT_FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(url, { signal: ctrl.signal });
      // A same-origin fetch to a font that actually needs the site's auth
      // cookie can come back 401/403 rather than throwing.
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = await res.arrayBuffer();
      let binary = "";
      const bytes = new Uint8Array(buf);
      for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
      const mime = /\.woff2($|\?)/.test(url) ? "font/woff2" : /\.woff($|\?)/.test(url) ? "font/woff" : /\.(ttf|otf)($|\?)/.test(url) ? "font/ttf" : "application/octet-stream";
      return `data:${mime};base64,${btoa(binary)}`;
    } catch (err) {
      if (err && err.name === "AbortError") throw new Error(`timed out after ${FONT_FETCH_TIMEOUT_MS}ms`);
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }
  async function embedFontFaces(css) {
    const blocks = css.match(/@font-face\s*\{[^}]*\}/g) || [];
    // Per block: its url() tokens, absolutized, in the order to try them.
    const plans = blocks.map((block) => {
      const tokens = Array.from(block.matchAll(/url\((['"]?)([^'")]+)\1\)/g))
        .filter((m) => !/^data:/i.test(m[2]))
        .map((m) => ({ token: m[0], url: absolutize(m[2]) }));
      tokens.sort((a, b) => fontFormatRank(a.url) - fontFormatRank(b.url));
      return { block, tokens };
    });

    // One fetch per distinct url, shared by every block that names it.
    const cache = new Map();
    const attempt = (url) => {
      if (!cache.has(url)) cache.set(url, fetchFontDataUri(url).then((dataUri) => ({ dataUri }), (err) => ({ error: String(err && err.message ? err.message : err) })));
      return cache.get(url);
    };

    // Resolve each block's first loadable url, a few blocks at a time.
    const outcomes = new Array(plans.length);
    let next = 0;
    async function worker() {
      while (next < plans.length) {
        const i = next++;
        const { tokens } = plans[i];
        let tried = [];
        for (const t of tokens) {
          const r = await attempt(t.url);
          if (r.dataUri) { outcomes[i] = { token: t.token, dataUri: r.dataUri }; break; }
          tried.push({ url: t.url, error: r.error });
        }
        if (!outcomes[i]) outcomes[i] = { tried };
      }
    }
    await Promise.all(Array.from({ length: FONT_FETCH_CONCURRENCY }, worker));

    let result = css;
    let embedded = 0;
    const failedUrls = new Map();
    const failedFamilies = new Set();
    plans.forEach(({ block, tokens }, i) => {
      if (!tokens.length) return;
      const o = outcomes[i];
      if (o.dataUri) {
        result = result.replace(block, block.replace(o.token, `url(${o.dataUri})`));
        embedded++;
      } else {
        for (const f of o.tried) failedUrls.set(f.url, f.error);
        const fam = block.match(/font-family\s*:\s*([^;}]+)/i);
        if (fam) failedFamilies.add(fam[1].trim().replace(/^['"]|['"]$/g, "").toLowerCase());
      }
    });
    // One line per distinct missing file, not one per duplicated rule.
    const failures = Array.from(failedUrls, ([url, error]) => ({ url, error }));
    if (failures.length) {
      console.warn(`[Page Bender] ${failures.length} font file(s) could not be embedded (the text falls back to a system font):`, failures);
    }
    // A font the capture couldn't embed is only a real gap if the live page
    // actually rendered it: CMS 404s some of its own fonts, so live and
    // capture already match there. document.fonts says which faces loaded.
    const loaded = new Set();
    try {
      document.fonts.forEach((f) => { if (f.status === "loaded") loaded.add(f.family.replace(/^['"]|['"]$/g, "").toLowerCase()); });
    } catch { /* older browsers: treat none as rendered */ }
    const renderedMissing = [...failedFamilies].filter((f) => loaded.has(f));
    return { css: result, diagnostics: { rulesFound: blocks.length, embedded, failures, renderedMissing } };
  }

  // Same base64-embed idea as embedFontFaces, but for our OWN bundled font
  // (used only by the section-capture stage chrome below) — fetched once
  // via chrome.runtime.getURL rather than parsed out of captured CSS, and
  // cached, since every section capture needs the exact same file.
  let ownFontDataUri;
  async function embedOwnFont() {
    if (ownFontDataUri !== undefined) return ownFontDataUri;
    try {
      const res = await fetch(chrome.runtime.getURL("fonts/PlusJakartaSans-Variable.woff2"));
      const buf = await res.arrayBuffer();
      let binary = "";
      const bytes = new Uint8Array(buf);
      for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
      ownFontDataUri = `data:font/woff2;base64,${btoa(binary)}`;
    } catch (err) {
      console.warn("[Page Bender] could not embed section-stage font:", err);
      ownFontDataUri = null;
    }
    return ownFontDataUri;
  }

  // ---------- cross-frame iframe baking ----------
  // An <iframe>'s rendered content lives in a separate document bakeNode's
  // DOM walk can never reach, cross-origin or not — same-origin policy
  // blocks contentDocument access, and even a same-origin iframe is still a
  // different document tree entirely. The actual fix: content.js is
  // injected into every frame of the tab, not just the top one (see
  // background.js), and frames talk to each other via postMessage, which —
  // unlike direct DOM/CSSOM access — was designed from day one to work
  // across origins. Each frame bakes ITSELF the exact same way the top
  // frame bakes the whole page, then hands the resulting HTML back up to
  // whichever frame asked, recursively (an iframe-within-an-iframe replies
  // to its own parent the same way). Observed live on AppsFlyer's login
  // screen: the marketing panel beside the form is a same-tab,
  // different-origin <iframe> pointing at a real page — it already renders
  // fine live (network- and origin-dependent), it just wasn't part of the
  // frozen/offline snapshot before this.
  let bakeRequestSeq = 0;
  const pendingBakeRequests = new Map(); // requestId -> resolve(html|null)

  window.addEventListener("message", (e) => {
    const data = e.data;
    if (!data || typeof data !== "object") return;
    if (data.type === "PBX_BAKE_REQUEST") {
      // A parent frame wants OUR document baked — always root at OUR
      // document.body, this has nothing to do with the top frame's own
      // section-select state.
      captureBakedHtml(document.body)
        .then(({ html }) => e.source.postMessage({ type: "PBX_BAKE_RESPONSE", requestId: data.requestId, html }, "*"))
        .catch((err) => e.source.postMessage({ type: "PBX_BAKE_RESPONSE", requestId: data.requestId, error: String((err && err.message) || err) }, "*"));
      return;
    }
    if (data.type === "PBX_BAKE_RESPONSE") {
      const resolve = pendingBakeRequests.get(data.requestId);
      if (!resolve) return;
      pendingBakeRequests.delete(data.requestId);
      resolve(data.error ? null : data.html);
    }
  });

  // Resolves to the iframe's own baked HTML, or null on timeout/failure —
  // bakeNode leaves the iframe's live `src` in place either way, so a
  // failed/slow bake just falls back to the same live-iframe behavior this
  // had before any of this existed.
  function requestFrameBake(iframeEl, timeoutMs = 6000) {
    return new Promise((resolve) => {
      const win = iframeEl.contentWindow;
      if (!win) { resolve(null); return; }
      const requestId = `pbx-${Date.now()}-${bakeRequestSeq++}`;
      const timer = setTimeout(() => { pendingBakeRequests.delete(requestId); resolve(null); }, timeoutMs);
      pendingBakeRequests.set(requestId, (html) => { clearTimeout(timer); resolve(html); });
      win.postMessage({ type: "PBX_BAKE_REQUEST", requestId }, "*");
    });
  }

  // Section captures wrap the baked content in a clipped, rounded "stage"
  // frame (see captureBakedHtml) — fine for ordinary in-flow content, but a
  // tooltip/dropdown/menu/modal that's a real descendant of the captured
  // element and already renders PAST that element's own edge on the live
  // page (almost always via position:fixed/absolute) would otherwise get
  // silently clipped at the frame's edge instead of appearing as the
  // floating top layer it actually is. Measured on the LIVE tree, before any
  // cloning, since that's the only place real viewport rects exist. Only the
  // outermost overflowing element is kept — a nested overflowing descendant
  // rides along inside its already-hoisted ancestor's own clone, so hoisting
  // it separately too would just duplicate it.
  // Content that runs past the root's edge but that the live page itself
  // clips inside a scrolling or overflow-hidden container is not a floating
  // layer, just the part of a scroll area that is out of view. Observed on
  // CMS: a virtualised data grid positions its rows absolutely inside its
  // scroller, so they extend past the grid's edge; they were hoisted out of
  // the grid, lost the grid's row rules, and stacked as plain text. An
  // absolutely positioned element is clipped by an overflow ancestor only
  // when that ancestor is, or contains, its containing block (offsetParent),
  // so a dropdown whose containing block sits outside the overflow box still
  // escapes it live, and is still hoisted. Fixed elements are never clipped
  // this way and are always hoisted.
  function clippedOnLivePage(el, root, position) {
    if (position === "fixed") return false;
    const containingBlock = el.offsetParent;
    if (!containingBlock) return false;
    for (let anc = el.parentElement; anc; anc = anc.parentElement) {
      const cs = getComputedStyle(anc);
      const clips = cs.overflowX !== "visible" || cs.overflowY !== "visible";
      if (clips && (anc === containingBlock || anc.contains(containingBlock))) return true;
      if (anc === root) break;
    }
    return false;
  }

  function findHoistTargets(root) {
    const rootRect = root.getBoundingClientRect();
    const candidates = [];
    for (const el of root.querySelectorAll("*")) {
      const position = getComputedStyle(el).position;
      if (position !== "fixed" && position !== "absolute") continue;
      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) continue; // not actually rendered (e.g. a closed dropdown)
      const overflows = r.left < rootRect.left || r.top < rootRect.top || r.right > rootRect.right || r.bottom > rootRect.bottom;
      if (overflows && !clippedOnLivePage(el, root, position)) candidates.push({ el, rect: r });
    }
    return candidates.filter(({ el }) => !candidates.some(({ el: other }) => other !== el && other.contains(el)));
  }

  function bakeNode(node, iframeBakes, hoistCtx) {
    if (node.nodeType === Node.TEXT_NODE) return node.cloneNode(true);
    if (node.nodeType !== Node.ELEMENT_NODE) return null;

    const tag = node.tagName.toLowerCase();
    if (tag === "script" || tag === "noscript" || tag === "template" || tag === "link" || tag === "style") return null;

    if (tag === "canvas") {
      // Real classes/attributes are copied onto the replacement <img> so
      // real CSS still applies — one known gap: a tag-qualified selector
      // like "canvas.chart" stops matching once the tag becomes "img".
      // Accepted as a rare edge case rather than solved for.
      try {
        const dataUrl = node.toDataURL("image/png");
        const img = document.createElement("img");
        for (const attr of node.attributes) img.setAttribute(attr.name, attr.value);
        img.setAttribute("src", dataUrl);
        return img;
      } catch {
        // Tainted canvas — fall through to a normal empty clone.
      }
    }

    const clone = node.cloneNode(false);
    // A pre-authored inline "style" attribute (e.g. a React inline style
    // prop) is real content now, not something competing with a synthetic
    // class — keep it, just absolutize any url() inside like any other CSS.
    if (clone.hasAttribute && clone.hasAttribute("style")) {
      clone.setAttribute("style", absolutizeCssUrls(clone.getAttribute("style")));
    }
    for (const attr of ["src", "href", "poster"]) {
      if (clone.hasAttribute && clone.hasAttribute(attr)) clone.setAttribute(attr, absolutize(clone.getAttribute(attr)));
    }
    // `src` above is left in place as a live fallback — `srcdoc` still wins
    // when both are present, so a frame we got a real bake back for renders
    // frozen/offline, and one we didn't (timeout, no contentWindow, cap hit)
    // just keeps behaving exactly like it always did.
    if (tag === "iframe" && iframeBakes && iframeBakes.has(node)) {
      clone.setAttribute("srcdoc", iframeBakes.get(node));
    }

    if (tag === "input" || tag === "textarea") {
      if (node.checked !== undefined && (node.type === "checkbox" || node.type === "radio")) {
        clone.toggleAttribute("checked", node.checked);
      } else if ("value" in node) {
        clone.setAttribute("value", node.value);
      }
      if (tag === "textarea") {
        clone.textContent = node.value;
        return clone;
      }
      return clone;
    }
    if (tag === "option") clone.toggleAttribute("selected", node.selected);

    // Only ever hoist the outermost match — once inside a hoisted subtree,
    // descendants bake normally into that clone regardless of their own
    // position/overflow (see findHoistTargets).
    const shouldHoist = !!(hoistCtx && !hoistCtx.insideHoisted && hoistCtx.hoistMap.has(node));
    const childCtx = shouldHoist ? { ...hoistCtx, insideHoisted: true } : hoistCtx;

    for (const child of node.childNodes) {
      const baked = bakeNode(child, iframeBakes, childCtx);
      if (baked) clone.appendChild(baked);
    }

    if (shouldHoist) {
      // Neutralize the clone's OWN positioning — it was real coordinates
      // relative to the live page's viewport, meaningless in the staged
      // frame's different layout. Inline style wins over any class rule
      // (short of !important), so this reliably overrides it while every
      // other captured style (color, font, shadow, border-radius, ...)
      // still applies untouched. The actual placement is done by the
      // .pbx-section-overlay wrapper captureBakedHtml puts around this
      // clone, sized and positioned from the same live rect measured here.
      clone.style.position = "static";
      clone.style.top = clone.style.left = clone.style.right = clone.style.bottom = "auto";
      clone.style.transform = "none";
      hoistCtx.hoisted.push({ clone, rect: hoistCtx.hoistMap.get(node) });
      return null;
    }
    return clone;
  }

  // root defaults to the whole page; passing any other element captures
  // just that section instead. bakeNode() already works on any node — the
  // only wrinkle is that a full-page capture bakes document.body itself
  // (so the clone IS a real <body> tag already), while a section capture
  // bakes some other element, which needs a real <body> wrapper added
  // around it so the saved file has the same structure either way (server.js
  // save/diff logic looks for a literal <body>...</body>). For a section
  // capture, that synthetic body is ALSO the one safe place to add the
  // "displayed on a stage" presentation (centered, framed, titled) — it's
  // not real captured content, just scaffolding we ourselves created, so
  // dressing it up doesn't touch anything mock-toolbar.js's undo/diff/save
  // logic treats as "the real page" (that's still exactly the one <div>
  // holding the untouched baked clone, unchanged from before).
  // opts.keepAncestors is for agent captures only (see __pbAgentCapture):
  // the manual section capture never passes it, so its output is unchanged.
  // Landmarks for the editing agent. A captured page is one large file whose
  // body sits on a few very long lines, and an agent asked to add a screen
  // used to spend most of a 12-minute run just finding the navigation and
  // the main content area (4 Oct 2026). The live page knows its layout, so
  // the capture marks them (data-pb-landmark) and the server writes an
  // outline from the marks. Generic: semantic tags first, then geometry.
  function visibleBox(el) {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return r.width > 1 && r.height > 1 && cs.display !== "none" && cs.visibility !== "hidden" ? r : null;
  }
  function largest(els) {
    let best = null;
    let bestArea = 0;
    for (const el of els) {
      const r = visibleBox(el);
      if (r && r.width * r.height > bestArea) { best = el; bestArea = r.width * r.height; }
    }
    return best;
  }
  function findLandmarks() {
    const W = innerWidth;
    const H = innerHeight;
    const host = document.getElementById("pm-host");
    const ours = (el) => !el || (host && host.contains(el));
    // Navigation: a semantic nav or aside, else the tallest narrow column
    // hugging the left edge.
    let nav = largest([...document.querySelectorAll("nav, [role=navigation], aside")].filter((el) => !ours(el)));
    if (!nav) {
      let el = document.elementFromPoint(20, H / 2);
      while (el && el.parentElement && el.parentElement !== document.body) {
        const pr = el.parentElement.getBoundingClientRect();
        if (pr.width > W * 0.35) break;
        el = el.parentElement;
      }
      const r = el && visibleBox(el);
      if (r && r.width < W * 0.35 && r.height > H * 0.6) nav = el;
    }
    // Header: a semantic header or banner spanning most of the width.
    const header = largest([...document.querySelectorAll("header, [role=banner]")].filter((el) => {
      const r = visibleBox(el);
      return r && !ours(el) && r.top < 120 && r.width > W * 0.5 && !(nav && el.contains(nav));
    }));
    // Main content: a semantic main, else the largest block that holds the
    // middle of the area right of the navigation and doesn't contain it.
    let main = largest([...document.querySelectorAll("main, [role=main]")].filter((el) => !ours(el)));
    if (!main) {
      const navRight = nav ? nav.getBoundingClientRect().right : 0;
      const top = header ? header.getBoundingClientRect().bottom : 0;
      let el = document.elementFromPoint((navRight + W) / 2, (top + H) / 2);
      while (el && el.parentElement && el.parentElement !== document.body && el.parentElement !== document.documentElement) {
        if (nav && el.parentElement.contains(nav)) break;
        el = el.parentElement;
      }
      if (el && !ours(el) && el !== document.body && !(nav && el.contains(nav))) main = el;
    }
    return { nav, header, main };
  }

  async function captureBakedHtml(root = document.body, opts = {}) {
    // Full-page captures only: a section has no shell to describe.
    const marked = [];
    if (root === document.body) {
      try {
        for (const [role, el] of Object.entries(findLandmarks())) {
          if (el && !el.hasAttribute("data-pb-landmark")) { el.setAttribute("data-pb-landmark", role); marked.push(el); }
        }
      } catch {
        /* landmarks are a help for the agent, never a reason to fail a capture */
      }
    }
    try {
      return await captureBakedHtmlInner(root, opts);
    } finally {
      for (const el of marked) el.removeAttribute("data-pb-landmark");
    }
  }

  async function captureBakedHtmlInner(root, opts) {
    const iframeEls = root.tagName && root.tagName.toLowerCase() === "iframe"
      ? [root]
      : Array.from(root.querySelectorAll ? root.querySelectorAll("iframe") : []);
    const iframeBakePairs = await Promise.all(iframeEls.map(async (el) => [el, await requestFrameBake(el)]));
    const iframeBakes = new Map(iframeBakePairs.filter(([, html]) => html));

    // Only section captures get the clipped stage frame (see below) that
    // hoisting exists to escape — a full-page capture has nothing to hoist
    // out OF.
    const hoistCtx = root !== document.body
      ? { hoistMap: new Map(findHoistTargets(root).map(({ el, rect }) => [el, rect])), hoisted: [], insideHoisted: false }
      : null;
    const baked = bakeNode(root, iframeBakes, hoistCtx);
    let bodyEl = baked;
    let stageCss = "";
    if (root !== document.body) {
      // A section capture clones ONLY the picked element — whatever parent
      // grid/flex container was actually giving it its real width (a
      // percentage, a flex-basis, a grid track share) never comes along.
      // Observed live on AppsFlyer's login page: the form's column was
      // "50% of a 2000px row" via MuiGrid2's grid-xs-6 class, but with no
      // parent grid row in the staged output for that percentage to resolve
      // against, it collapsed to a narrow, mobile-looking width instead.
      // Pinning the ACTUAL observed width as an inline style — measured
      // from the live element before it's cloned out of that context —
      // wins over any percentage/flex-basis class rule regardless of
      // specificity, so the staged card always reproduces the real,
      // desktop-observed size. General fix: this has nothing to do with
      // AppsFlyer, MUI, or any particular layout system — it's true of any
      // element whose size depends on an ancestor this capture mode
      // deliberately excludes.
      const rect = root.getBoundingClientRect();
      baked.style.width = `${Math.round(rect.width)}px`;
      // Same "missing ancestor" problem again, for inherited text styles.
      // Typography usually comes down from <body> or a layout wrapper, and
      // the stage frame below sets its own panel font on its <body>, so a
      // captured element that inherits its font rendered in Page Bender's
      // font instead of the product's. Observed on CMS: the Apps "Add"
      // button inherits Open Sans and came out in PBX Chrome Sans. Pinning
      // the live computed values on the root restores them, and its children
      // inherit from it as they did on the real page. Only a value that
      // matches the parent's (so is inherited) is pinned: a value the
      // element sets itself comes back from its own CSS rules, and pinning
      // it inline would override its :hover and :focus variants.
      const liveCs = getComputedStyle(root);
      const parentCs = root.parentElement ? getComputedStyle(root.parentElement) : null;
      for (const prop of ["font-family", "font-size", "font-weight", "font-style", "line-height", "letter-spacing", "color", "text-transform"]) {
        const value = liveCs.getPropertyValue(prop);
        const inherited = !parentCs || parentCs.getPropertyValue(prop) === value;
        if (inherited && !baked.style.getPropertyValue(prop)) baked.style.setProperty(prop, value);
      }
      // Same "missing ancestor" problem as the width fix above, but for
      // background color instead of layout: plenty of components (this
      // table included) don't paint their own background at all — they're
      // transparent and rely on some ancestor (often all the way up at
      // <body>) to actually provide the color behind them. A section
      // capture discards every real ancestor, so the frame below used to
      // just hardcode white, assuming most captured components are opaque.
      // Observed live on Intercom's All Messages table: its dark-mode text
      // color WAS correct (near-white, matching the real dark background
      // this table normally sits on), but with no real ancestor left to
      // supply that dark background, our own hardcoded white frame showed
      // through instead — near-white text on white, nearly invisible.
      // Walking up from the real (unbaked) element to find whichever
      // ancestor actually paints a non-transparent background reproduces
      // the true backdrop regardless of whether the real page is light or
      // dark themed.
      const effectiveBg = (() => {
        let node = root;
        while (node) {
          const bg = getComputedStyle(node).backgroundColor;
          if (bg && bg !== "transparent" && bg !== "rgba(0, 0, 0, 0)") return bg;
          node = node.parentElement;
        }
        return "#fff";
      })();
      const descriptor = root.tagName.toLowerCase() + (root.classList[0] ? `.${root.classList[0]}` : "");
      const fontUri = await embedOwnFont();
      const fontFace = fontUri
        ? `@font-face { font-family: 'PBX Chrome Sans'; src: url(${fontUri}) format('woff2'); font-weight: 200 800; font-style: normal; }`
        : "";
      bodyEl = document.createElement("body");
      bodyEl.className = "pbx-section-stage";
      bodyEl.innerHTML = `
        <div class="pbx-section-badge">
          ${svgIcon('<path d="M8 9 12 4l4 5"/><path d="M12 4v10"/><path d="M12 14 7 20"/><path d="M12 14l5 6"/>', 15)}
          <div class="pbx-section-badge-text">
            <span class="pbx-section-badge-title">Captured section</span>
            <span class="pbx-section-badge-meta">${escapeHtml(document.title || location.hostname)} · ${escapeHtml(descriptor)}</span>
          </div>
        </div>
        <div class="pbx-section-frame-wrap"><div class="pbx-section-halo"></div><div class="pbx-section-frame"></div></div>
      `;
      // A section capture keeps only the picked element, so any product
      // rule written against a wrapper above it ("links inside the customers
      // table area are teal", "grid rows inside the grid root lay out as
      // flex rows") stopped matching: on CMS the data grid's rows stacked and
      // table links fell back to blue. With keepAncestors, the element is
      // re-nested inside empty copies of its real ancestors (same tag, id,
      // classes and attributes, none of their other children), so those
      // rules match again. display: contents on the copies (see stageCss)
      // keeps them from adding any box, padding or background of their own,
      // while inheritance and selector matching still pass through them.
      let frameChild = baked;
      if (opts.keepAncestors) {
        for (let anc = root.parentElement; anc && anc !== document.body && anc !== document.documentElement; anc = anc.parentElement) {
          const copy = document.createElement(anc.tagName.toLowerCase());
          for (const attr of anc.attributes) {
            if (attr.name === "style" || attr.name.startsWith("on")) continue;
            copy.setAttribute(attr.name, attr.value);
          }
          copy.classList.add("pbx-ancestor");
          copy.appendChild(frameChild);
          frameChild = copy;
        }
      }
      bodyEl.querySelector(".pbx-section-frame").appendChild(frameChild);
      // Re-attach each hoisted tooltip/dropdown/modal as its own overlay,
      // positioned from the SAME live rect measured in findHoistTargets —
      // relative to `rect` (the captured element's own rect) because that's
      // exactly what .pbx-section-frame-wrap's top-left now corresponds to.
      const frameWrap = bodyEl.querySelector(".pbx-section-frame-wrap");
      for (const { clone, rect: r } of hoistCtx.hoisted) {
        const overlay = document.createElement("div");
        overlay.className = "pbx-section-overlay";
        overlay.style.left = `${Math.round(r.left - rect.left)}px`;
        overlay.style.top = `${Math.round(r.top - rect.top)}px`;
        overlay.style.width = `${Math.round(r.width)}px`;
        overlay.style.height = `${Math.round(r.height)}px`;
        overlay.appendChild(clone);
        frameWrap.appendChild(overlay);
      }
      // A dark museum-canvas backdrop with the composer's own signature
      // pink halo bloom behind a plain white mat — same "specimen on
      // display" idea as the toolbar's card, applied to whatever section
      // got captured, so it never opens looking stranded at the top-left
      // of an otherwise blank page. Own font alias (not the real "Plus
      // Jakarta Sans" family name) so this can't collide with an
      // @font-face the captured site declares for its own real content.
      stageCss = `
        ${fontFace}
        /* flex-start, not center — dead-centering in the full 100vh looked
           fine in isolation, but the composer bar is anchored to the
           bottom on top of this, so a vertically-centered frame reads as
           pulled down toward it, wasting the whole top of the viewport.
           A deliberate top offset (not flush against the edge either —
           some breathing room still reads as "placed", not "stuck") uses
           that space instead, and the generous bottom padding keeps the
           frame clear of the composer regardless of viewport height. */
        .pbx-section-stage { margin: 0; min-height: 100vh; box-sizing: border-box;
          display: flex; flex-direction: column; align-items: center; justify-content: flex-start;
          gap: 22px; padding: max(64px, 9vh) 24px 160px;
          background:
            radial-gradient(ellipse 60% 50% at 24% 18%, rgba(255,110,199,.12), transparent 60%),
            radial-gradient(ellipse 60% 55% at 80% 82%, rgba(255,45,120,.10), transparent 60%),
            #100c14;
          font-family: 'PBX Chrome Sans', -apple-system, system-ui, sans-serif; }
        .pbx-section-badge { display: inline-flex; align-items: center; gap: 10px; padding: 9px 16px;
          border-radius: 14px; background: rgba(255,255,255,.05); border: 1px solid #2d2436;
          backdrop-filter: blur(10px); max-width: min(600px, calc(100vw - 48px)); }
        .pbx-section-badge svg { color: #ff6ec7; flex: none; }
        .pbx-section-badge-text { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
        .pbx-section-badge-title { font-size: 13px; font-weight: 600; color: #f4eef7; }
        .pbx-section-badge-meta { font-size: 11px; color: #776b81; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .pbx-section-frame-wrap { position: relative; max-width: min(1200px, calc(100vw - 48px)); }
        .pbx-section-halo { position: absolute; inset: -28px; z-index: -1; border-radius: 32px;
          background: radial-gradient(circle at 28% 30%, rgba(255,110,199,.55), transparent 55%),
                      radial-gradient(circle at 76% 74%, rgba(255,45,120,.5), transparent 55%);
          filter: blur(40px); opacity: .75; }
        .pbx-section-frame { position: relative; border-radius: 20px; overflow: hidden; background: ${effectiveBg};
          box-shadow: 0 30px 90px rgba(0,0,0,.55), 0 0 0 1px rgba(255,255,255,.06); }
        /* Elements hoisted out of the clipped frame below (findHoistTargets) —
           a tooltip/dropdown/modal that already rendered past the captured
           element's own edge on the live page. Positioned to land in exactly
           the same spot relative to the frame, but as a sibling that isn't
           subject to the frame's overflow:hidden, so it reads as a top layer
           instead of getting silently clipped at the card's rounded edge. */
        .pbx-section-overlay { position: absolute; z-index: 2; }
      `;
    }
    const container = document.createElement("div");
    container.appendChild(bodyEl);
    const bodyHtml = container.innerHTML;

    const { css: rawCss, skippedSheets } = await captureRealStylesheets();
    const absolutizedCss = absolutizeCssUrls(rawCss);
    const { css: finalCss, diagnostics: fontDiag } = await embedFontFaces(absolutizedCss);
    const styleBlock = finalCss ? `<style>${finalCss}</style>\n` : "";
    if (stageCss && opts.keepAncestors) stageCss += "\n.pbx-ancestor { display: contents !important; }\n";
    const stageStyleBlock = stageCss ? `<style>${stageCss}</style>\n` : "";
    const fontDiagnostics = { ...fontDiag, sheetsSkippedCrossOrigin: skippedSheets };
    // documentElement's own attributes (class, lang, dir, data-*, ...) — NOT
    // covered by bakeNode, which only ever walks document.body downward.
    // Observed live on Intercom: theme (light/dark) is a `class="dark"` on
    // <html>, with the captured CSS defining its whole color system as
    // custom properties scoped under that class vs :root's light defaults.
    // A bare <html> tag here means .dark matches nothing, so every color
    // variable silently falls back to its light value — the CSS and markup
    // both come through intact, only the one attribute that selects between
    // them was ever missing.
    const htmlAttrs = Array.from(document.documentElement.attributes)
      .map((a) => ` ${a.name}="${escapeHtml(a.value)}"`)
      .join("");
    const html = `<!doctype html>\n<html${htmlAttrs}>\n<head>\n<meta charset="utf-8">\n<title>${escapeHtml(document.title)}</title>\n${styleBlock}${stageStyleBlock}</head>\n${bodyHtml}\n</html>\n`;
    return { html, fontDiagnostics };
  }

  // A hung background.js handler (e.g. a cross-origin fetch that never
  // settles — see PM_FETCH_TEXT) used to hang this forever with no timeout
  // at all, which silently hung the whole capture flow with it (nothing
  // downstream ever got a chance to time out on its own). This is also why
  // an EXTENSION RELOAD while the tab was already open used to fail
  // silently: re-clicking the pill re-runs content.js, but
  // window.__pageMockInjected is already true from the pre-reload instance,
  // so the click just re-triggers that STALE instance — whose
  // chrome.runtime.sendMessage calls now throw "Extension context
  // invalidated" — and with no timeout AND no catch anywhere upstream (see
  // runCapture), that error had nowhere to go. A full page refresh after
  // reloading the extension is still required either way; this just makes
  // it fail loud instead of hanging silently.
  function send(msg, timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${msg.type} timed out after ${timeoutMs}ms`)), timeoutMs);
      try {
        chrome.runtime.sendMessage(msg, (resp) => {
          clearTimeout(timer);
          resolve(resp);
        });
      } catch (err) {
        clearTimeout(timer);
        reject(err);
      }
    });
  }

  if (isTopFrame) {
  // Ported from mock-toolbar.js's identical helper — crops a full-viewport
  // screenshot down to one element's bounding box, DPR-aware, so a section
  // capture's fidelity pass compares against just that section rather than
  // the whole page (also makes the pass meaningfully faster, since there's
  // less surface to check).
  function cropToSelection(dataUrl, rect) {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        const dpr = window.devicePixelRatio || 1;
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.round(rect.width * dpr));
        canvas.height = Math.max(1, Math.round(rect.height * dpr));
        const ctx = canvas.getContext("2d");
        ctx.drawImage(
          img,
          Math.round(rect.left * dpr), Math.round(rect.top * dpr),
          canvas.width, canvas.height,
          0, 0, canvas.width, canvas.height
        );
        resolve(canvas.toDataURL("image/png"));
      };
      img.src = dataUrl;
    });
  }

  // ---------- self-hosted panel font ----------
  // This runs on arbitrary third-party pages whose CSP may block third-party
  // font/style requests — a plain <link> to fonts.googleapis.com or even our
  // own local server would be unreliable here (unlike mock-toolbar.js, which
  // runs on a page WE serve). Bundling the font file inside the extension
  // and loading it via chrome.runtime.getURL + FontFace sidesteps that
  // entirely — it's an extension-owned resource, not a third-party request.
  let fontLoadPromise = null;
  function ensurePanelFont() {
    if (fontLoadPromise) return fontLoadPromise;
    try {
      const url = chrome.runtime.getURL("fonts/PlusJakartaSans-Variable.woff2");
      const face = new FontFace("Plus Jakarta Sans", `url(${url})`, { weight: "200 800", style: "normal" });
      fontLoadPromise = face.load().then((loaded) => { document.fonts.add(loaded); })
        .catch((err) => console.warn("[Page Bender] font failed to load, using system sans fallback:", err));
    } catch (err) {
      fontLoadPromise = Promise.resolve();
    }
    return fontLoadPromise;
  }
  ensurePanelFont();

  // Same "bend" logo mark (two legs merging into a single upward arrow,
  // from the extension icon) mock-toolbar.js uses on its pill/bubble —
  // used here too so the pre-capture pill matches post-capture branding.
  const BEND = svgIcon('<path d="M8 9 12 4l4 5"/><path d="M12 4v10"/><path d="M12 14 7 20"/><path d="M12 14l5 6"/>', 20);
  // Same select icon mock-toolbar.js uses for its own select-mode, for
  // visual consistency between the two capture-time and edit-time tools.
  const SELECT_ICON = svgIcon('<circle cx="12" cy="12" r="9"/><line x1="22" y1="12" x2="18" y2="12"/><line x1="6" y1="12" x2="2" y2="12"/><line x1="12" y1="6" x2="12" y2="2"/><line x1="12" y1="22" x2="12" y2="18"/>', 18);

  // Style-isolated shadow root — this panel sits on top of an arbitrary
  // host page whose own CSS could otherwise bleed in (or ours leak out).
  const host = document.createElement("div");
  host.id = "pm-host";
  const shadow = host.attachShadow({ mode: "open" });
  shadow.innerHTML = `
    <style>
      :host { all: initial; }
      * { box-sizing: border-box; font-family: 'Plus Jakarta Sans', -apple-system, system-ui, sans-serif; }
      .pm-pill-row { position: fixed; left: 50%; bottom: 36px; transform: translateX(-50%);
        z-index: 2147483647; display: flex; align-items: center; gap: 10px; }
      .pm-pill { display: flex; align-items: center; gap: 10px; padding: 12px 20px;
        border-radius: 999px; cursor: pointer; position: relative;
        background: rgba(20,14,22,.9); border: 1px solid #2d2436; color: #f4eef7;
        backdrop-filter: blur(14px); box-shadow: 0 10px 40px rgba(0,0,0,.45); }
      .pm-pill:hover { background: rgba(28,18,30,.95); }
      .pm-pill:disabled, .pm-pill.pm-busy { opacity: .7; cursor: default; }
      .pm-halo { position: absolute; inset: -18px; border-radius: 999px; z-index: -1;
        background: radial-gradient(circle, rgba(255,45,120,.4), transparent 70%); filter: blur(6px);
        animation: pm-breathe 3.4s ease-in-out infinite; }
      @keyframes pm-breathe { 0%,100% { opacity: .5; transform: scale(1); } 50% { opacity: 1; transform: scale(1.08); } }
      .pm-pill.pm-busy .pm-halo { animation-duration: 1.2s; }
      .pm-sparkle { display: flex; color: #ff6ec7; }
      .pm-label { font-size: 14.5px; font-weight: 400; white-space: nowrap; }
      .pm-section-btn { width: 46px; height: 46px; border-radius: 50%; flex: none; cursor: pointer;
        display: flex; align-items: center; justify-content: center;
        background: rgba(20,14,22,.9); border: 1px solid #2d2436; color: #f4eef7;
        backdrop-filter: blur(14px); box-shadow: 0 10px 40px rgba(0,0,0,.45); }
      .pm-section-btn:hover { background: rgba(28,18,30,.95); }
      .pm-section-btn.pm-on { background: linear-gradient(135deg, #ff3d92, #ff2d78); color: #1c0f18; border-color: transparent; }
      .pm-status { position: fixed; left: 50%; bottom: 92px; transform: translateX(-50%);
        z-index: 2147483647; font-size: 12px; color: #ff9fd1; background: rgba(20,14,22,.9);
        border: 1px solid #2d2436; border-radius: 999px; padding: 6px 14px; display: none;
        white-space: nowrap; backdrop-filter: blur(10px); }
      .pm-status.pm-show { display: block; }
      .pm-hoverbox { position: fixed; pointer-events: none; z-index: 2147483646;
        border: 2px dashed #ff3d92; background: rgba(255,61,146,.08); display: none; }
      .pm-hoverbadge { position: fixed; pointer-events: none; z-index: 2147483646; display: none;
        padding: 3px 8px; border-radius: 6px; font-size: 11px; background: #18121d; color: #ff9fd1; }
    </style>
    <div class="pm-pill-row">
      <button class="pm-pill" id="pm-capture">
        <div class="pm-halo"></div>
        <span class="pm-sparkle">${BEND}</span>
        <span class="pm-label">Let's Page Bend</span>
      </button>
      <button class="pm-section-btn" id="pm-section" title="Capture just a section — click, then hover and click an element on the page">${SELECT_ICON}</button>
    </div>
    <div class="pm-status" id="pm-status"></div>
    <div class="pm-hoverbox" id="pm-hoverbox"></div>
    <div class="pm-hoverbadge" id="pm-hoverbadge"></div>
  `;
  document.documentElement.appendChild(host);

  // A page opening a modal typically appends its own position:fixed
  // backdrop/dialog LATER in the document than our host (which injects
  // once, on page load) — with both competing for the same max z-index,
  // later-in-document-order wins the stacking tie, so the modal ends up on
  // top and swallows clicks meant for our pill. What actually matters for
  // that tie is staying the LAST node in the whole document (a fixed-
  // position element still escapes to the root stacking context however
  // deep it's nested), so this needs subtree:true — most real modals are
  // appended inside <body>, not as a new direct child of <html>, and a
  // documentElement-only childList observer would miss that mutation
  // entirely. appendChild() on an already-attached node just moves it — a
  // no-op if already last, harmless otherwise.
  new MutationObserver(() => {
    if (document.documentElement.lastElementChild !== host) {
      document.documentElement.appendChild(host);
    }
  }).observe(document.documentElement, { childList: true, subtree: true });

  const captureBtn = shadow.querySelector("#pm-capture");
  const sectionBtn = shadow.querySelector("#pm-section");
  const labelEl = shadow.querySelector(".pm-label");
  const statusEl = shadow.querySelector("#pm-status");
  const hoverBox = shadow.querySelector("#pm-hoverbox");
  const hoverBadge = shadow.querySelector("#pm-hoverbadge");

  function setStatus(text, show) {
    statusEl.textContent = text;
    statusEl.classList.toggle("pm-show", !!show);
  }

  // Shared by the main pill (full page) and section-select (one element).
  // No multi-minute status ticker here anymore: /capture now writes the raw
  // bake and responds immediately, running its fidelity pass detached
  // server-side (see PLAN.md) — this call resolves in ~1-2s regardless of
  // how long that pass takes, so the mock tab opens right away and the
  // enhancement, if any, is tracked/shown on the mock page itself instead.
  // The part of a capture both entry points share: bake, screenshot, hand to
  // the server. Returns the server's response ({ ok, slug, previewUrl } or
  // { ok: false, error }) plus whether a screenshot made it, and leaves every
  // bit of UI to the caller.
  async function bakeAndSend(root, opts = {}) {
    const { html, fontDiagnostics } = await captureBakedHtml(root, opts);

    // A real screenshot of the current viewport, sent alongside the baked
    // HTML — the server runs a one-time AI vision pass comparing the two
    // and fixing whatever the mechanical bake still gets wrong (pseudo-
    // element edge cases, fonts that couldn't be fetched, anything else).
    const shot = await send({ type: "PM_CAPTURE_SCREENSHOT" });
    let screenshot = shot && shot.ok ? shot.dataUrl : null;
    if (screenshot && root !== document.body) {
      screenshot = await cropToSelection(screenshot, root.getBoundingClientRect());
    }

    const resp = await send({ type: "PM_CAPTURE", html, title: document.title, url: location.href, screenshot, fontDiagnostics });
    return { resp, screenshot };
  }

  async function runCapture(root) {
    captureBtn.disabled = true;
    sectionBtn.disabled = true;
    captureBtn.classList.add("pm-busy");
    // The button's own label says it; the status line above stays for the
    // result or an error (it used to repeat "capturing…" in small pink text).
    labelEl.textContent = "Capturing…";
    setStatus("", false);
    // Everything below used to run with nothing catching a rejection —
    // any throw (a hung/failed cross-frame iframe bake, a background.js
    // message that never got a response, an "Extension context invalidated"
    // error from re-clicking after reloading the extension without
    // refreshing the tab, ...) left the button stuck on "Capturing…"
    // forever with zero visible error. Wrapping the whole thing means any
    // failure mode at least surfaces as a real error in the status pill.
    try {
      const { resp, screenshot } = await bakeAndSend(root);
      if (!resp || !resp.ok) {
        labelEl.textContent = "Let's Page Bend";
        setStatus(`capture failed: ${resp && resp.error}`, true);
        return;
      }
      await send({ type: "PM_OPEN_PREVIEW", slug: resp.slug, url: resp.previewUrl });
      labelEl.textContent = "Let's Page Bend";
      setStatus(screenshot ? "captured — mock open in a new tab, enhancing fidelity there" : "captured — mock open in a new tab", true);
    } catch (err) {
      labelEl.textContent = "Let's Page Bend";
      setStatus(`capture failed: ${(err && err.message) || err}`, true);
    } finally {
      captureBtn.disabled = false;
      sectionBtn.disabled = false;
      captureBtn.classList.remove("pm-busy");
    }
    setTimeout(() => setStatus("", false), 4000);
  }

  captureBtn.addEventListener("click", () => runCapture(document.body));

  // ---------- section-select mode (hover-highlight, click to arm an
  // element, click it again to confirm — capture only fires on that second,
  // deliberate click. Observed live on Intercom's Knowledge Hub: select mode
  // was left on and the very next click anywhere on the page (landing on the
  // table's header row) fired an immediate capture of that tiny element
  // instead of the intended full page, with no way to tell beforehand what
  // was about to be captured. Requiring a second click on the SAME target
  // turns that stray first click into a harmless "aim" instead.
  //
  // Separately (observed live on Intercom's All Messages table): a single
  // click can't reliably tell "the row" from "the row's wrapper's padding"
  // from "the whole content column" — elementFromPoint just returns whatever
  // is topmost at that pixel, and generous padding/gap/margin on a wrapper
  // is hit-tested to the WRAPPER, not whatever child it visually surrounds.
  // This has nothing to do with any one site or CSS methodology (Tailwind's
  // atomic classes just make it worse, since the badge's tag+first-class
  // label carries no semantic hint either way — "div.h-full" looks the same
  // whether it's a tiny icon wrapper or the entire page). Two general,
  // page-agnostic fixes below: the armed outline now shows live pixel
  // dimensions so an oversized pick is obvious before confirming, and
  // ArrowUp/ArrowDown walk the armed target up/down the ancestor chain so a
  // wrong pick can be corrected without needing a pixel-perfect re-click.
  // ----------
  let sectionSelectMode = false;
  // Stack of elements from the original click (index 0) up through however
  // many ancestors ArrowUp has climbed — armedStack[armedStack.length - 1]
  // is always the current armed target; ArrowDown pops back down.
  let armedStack = [];

  function setSectionSelectMode(on) {
    sectionSelectMode = on;
    armedStack = [];
    sectionBtn.classList.toggle("pm-on", on);
    hoverBox.style.display = "none";
    hoverBadge.style.display = "none";
    document.documentElement.style.cursor = on ? "crosshair" : "";
  }

  // Shared by both the free-following hover box and the frozen "armed"
  // outline — same visual, just driven by a different element/label. Always
  // appends live pixel dimensions: a class name or tag alone can't tell you
  // how much you're about to grab, but "412×1866" makes an oversized pick
  // obvious at a glance, on any page, regardless of how it's styled.
  function paintHoverAt(el, label) {
    const r = el.getBoundingClientRect();
    hoverBox.style.display = "block";
    hoverBox.style.left = `${r.left}px`;
    hoverBox.style.top = `${r.top}px`;
    hoverBox.style.width = `${r.width}px`;
    hoverBox.style.height = `${r.height}px`;
    hoverBadge.textContent = `${label} · ${Math.round(r.width)}×${Math.round(r.height)}`;
    hoverBadge.style.display = "block";
    hoverBadge.style.left = `${r.left}px`;
    hoverBadge.style.top = `${Math.max(0, r.top - 24)}px`;
  }

  // Small element-type tab (e.g. "td") on the frame — matches the original
  // Page Bender project's select tool.
  function describeSectionTarget(el) {
    const cls = el.classList[0] ? `.${el.classList[0]}` : "";
    return el.tagName.toLowerCase() + cls;
  }

  function paintArmed() {
    const el = armedStack[armedStack.length - 1];
    const hint = armedStack.length > 1 ? "↑/↓ to resize, click again to capture, Esc to cancel" : "click again to capture, ↑ for parent, Esc to cancel";
    paintHoverAt(el, `${describeSectionTarget(el)} — ${hint}`);
  }

  function onSectionMouseMove(e) {
    if (!sectionSelectMode || armedStack.length) return; // frozen on the armed target until confirmed or cancelled
    // Shadow DOM event retargeting means a listener OUTSIDE the shadow tree
    // (this one, on `document`) sees e.target as `host` itself for anything
    // happening inside our own panel — so this one check covers the whole
    // panel, not just individual elements within it.
    if (host.contains(e.target)) { hoverBox.style.display = "none"; hoverBadge.style.display = "none"; return; }
    paintHoverAt(e.target, describeSectionTarget(e.target));
  }

  function onSectionClick(e) {
    if (!sectionSelectMode) return;
    if (host.contains(e.target)) return; // let the toggle-off click through normally
    e.preventDefault();
    e.stopPropagation();
    const el = e.target;
    if (armedStack.length && armedStack[armedStack.length - 1] === el) {
      // second click on the same (possibly resized) target — confirmed
      const target = armedStack[armedStack.length - 1];
      setSectionSelectMode(false);
      runCapture(target);
      return;
    }
    // first click, or a click on a different element while one was already
    // armed — (re-)aim fresh, nothing captured yet
    armedStack = [el];
    paintArmed();
  }

  function onSectionKeydown(e) {
    if (!sectionSelectMode) return;
    if (e.key === "Escape") { setSectionSelectMode(false); return; }
    if (!armedStack.length) return;
    if (e.key === "ArrowUp") {
      // Climb to the parent — bounded at <body> so this can't walk past it
      // into <html>, which is never a meaningful thing to capture as a
      // "section" (that's just a full-page capture via the main pill).
      const current = armedStack[armedStack.length - 1];
      const parent = current.parentElement;
      if (parent && current !== document.body) {
        e.preventDefault();
        armedStack.push(parent);
        paintArmed();
      }
    } else if (e.key === "ArrowDown") {
      // Back down to wherever we climbed from — no-op at the original pick.
      if (armedStack.length > 1) {
        e.preventDefault();
        armedStack.pop();
        paintArmed();
      }
    }
  }

  document.addEventListener("mousemove", onSectionMouseMove, true);
  document.addEventListener("click", onSectionClick, true);
  document.addEventListener("keydown", onSectionKeydown, true);
  sectionBtn.addEventListener("click", () => setSectionSelectMode(!sectionSelectMode));

  window.__pageMockToggle = () => {
    host.style.display = host.style.display === "none" ? "block" : "none";
  };

  // ---------- agent capture ----------
  // Entry point for a capture an agent asked for through the local server
  // (POST /agent/capture), not a click. background.js calls this via
  // chrome.scripting.executeScript, which runs in this same isolated world,
  // so it can see this function where the page's own scripts cannot. When
  // background.js injected this file for an agent job, it set
  // __pbAgentMode first, so the pill never appears on a page nobody opened
  // it on. Either way the panel is hidden while the screenshot is taken, or
  // the pill would land in the image the fidelity pass compares against.
  // No preview tab is opened: the caller gets the paths back instead.
  if (window.__pbAgentMode) host.style.display = "none";
  // keepAncestors defaults on here: component extraction wants the element
  // styled exactly as it sits in the product (see captureBakedHtml).
  window.__pbAgentCapture = async (selector, ref, { keepAncestors = true } = {}) => {
    let root = document.body;
    if (ref != null) {
      // A ref from the agent driver's last snapshot (agent-driver.js).
      root = window.__pbDriver && window.__pbDriver.element(ref);
      if (!root) return { ok: false, error: `ref ${ref} not found: take a new snapshot` };
    } else if (selector) {
      try {
        root = document.querySelector(selector);
      } catch (err) {
        return { ok: false, error: `invalid selector: ${err.message}` };
      }
      if (!root) return { ok: false, error: `no element matches selector: ${selector}` };
    }
    const prevDisplay = host.style.display;
    host.style.display = "none";
    // Two frames, so the hidden panel is actually off the painted page
    // before captureVisibleTab reads the pixels.
    // Capped by a timer, because Chrome stops delivering animation frames to
    // a window that is hidden or covered, which is where an agent's window
    // often sits: a bare double-rAF there never resolved and hung the whole
    // capture.
    await new Promise((r) => {
      requestAnimationFrame(() => requestAnimationFrame(r));
      setTimeout(r, 150);
    });
    try {
      const { resp, screenshot } = await bakeAndSend(root, { keepAncestors });
      if (!resp || !resp.ok) return { ok: false, error: (resp && resp.error) || "capture failed" };
      return { ok: true, slug: resp.slug, previewUrl: resp.previewUrl, screenshot: !!screenshot, title: document.title, url: location.href };
    } catch (err) {
      return { ok: false, error: (err && err.message) || String(err) };
    } finally {
      if (!window.__pbAgentMode) host.style.display = prevDisplay;
    }
  };
  }
})();
