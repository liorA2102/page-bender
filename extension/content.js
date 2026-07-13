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

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  function absolutize(url) {
    try { return new URL(url, location.href).href; } catch { return url; }
  }

  // Rewrites every url(...) in captured CSS text to an absolute URL, EXCEPT
  // a bare "#id" fragment — that points at an element inside THIS document
  // (SVG paint servers: gradients/patterns/clip-paths via
  // fill/stroke:url(#id)), not an external resource. Absolutizing it into
  // "https://original-site.com/page#id" breaks it once the mock is opened
  // from a different origin/path (observed live: a chart's stroke
  // referenced its gradient this way, so the line rendered with axes but no
  // visible stroke at all).
  function absolutizeCssUrls(css) {
    return css.replace(/url\((['"]?)([^'")]+)\1\)/g, (m, q, u) => (u.startsWith("#") ? m : `url(${q}${absolutize(u)}${q})`));
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
  function captureRealStylesheets() {
    const blocks = [];
    let skippedSheets = 0;
    for (const sheet of document.styleSheets) {
      let cssRules;
      try {
        cssRules = sheet.cssRules;
      } catch {
        // Cross-origin stylesheet with no permissive CORS header — the
        // browser blocks JS from reading its rules at all, no workaround
        // from content-script code. Same hard boundary as font embedding.
        skippedSheets++;
        continue;
      }
      const text = Array.from(cssRules).map((r) => r.cssText).join("\n");
      if (text) blocks.push(text);
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
  async function embedFontFaces(css) {
    const blocks = css.match(/@font-face\s*\{[^}]*\}/g) || [];
    let embedded = 0;
    const failures = [];
    let result = css;
    for (const block of blocks) {
      const urlMatch = block.match(/url\((['"]?)([^'")]+)\1\)/);
      if (!urlMatch) continue;
      const url = absolutize(urlMatch[2]);
      try {
        const res = await fetch(url);
        // A same-origin fetch to a font that actually needs the site's auth
        // cookie can come back 401/403 rather than throwing.
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const buf = await res.arrayBuffer();
        let binary = "";
        const bytes = new Uint8Array(buf);
        for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
        const b64 = btoa(binary);
        const mime = /\.woff2($|\?)/.test(url) ? "font/woff2" : /\.woff($|\?)/.test(url) ? "font/woff" : /\.(ttf|otf)($|\?)/.test(url) ? "font/ttf" : "application/octet-stream";
        result = result.replace(block, block.replace(urlMatch[0], `url(data:${mime};base64,${b64})`));
        embedded++;
      } catch (err) {
        console.warn("[Page Bender] could not embed font", url, err);
        failures.push({ url, error: String(err && err.message ? err.message : err) });
      }
    }
    return { css: result, diagnostics: { rulesFound: blocks.length, embedded, failures } };
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

  function bakeNode(node) {
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

    for (const child of node.childNodes) {
      const baked = bakeNode(child);
      if (baked) clone.appendChild(baked);
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
  async function captureBakedHtml(root = document.body) {
    const baked = bakeNode(root);
    let bodyEl = baked;
    let stageCss = "";
    if (root !== document.body) {
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
      bodyEl.querySelector(".pbx-section-frame").appendChild(baked);
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
        .pbx-section-frame { position: relative; border-radius: 20px; overflow: hidden; background: #fff;
          box-shadow: 0 30px 90px rgba(0,0,0,.55), 0 0 0 1px rgba(255,255,255,.06); }
      `;
    }
    const container = document.createElement("div");
    container.appendChild(bodyEl);
    const bodyHtml = container.innerHTML;

    const { css: rawCss, skippedSheets } = captureRealStylesheets();
    const absolutizedCss = absolutizeCssUrls(rawCss);
    const { css: finalCss, diagnostics: fontDiag } = await embedFontFaces(absolutizedCss);
    const styleBlock = finalCss ? `<style>${finalCss}</style>\n` : "";
    const stageStyleBlock = stageCss ? `<style>${stageCss}</style>\n` : "";
    const fontDiagnostics = { ...fontDiag, sheetsSkippedCrossOrigin: skippedSheets };
    const html = `<!doctype html>\n<html>\n<head>\n<meta charset="utf-8">\n<title>${escapeHtml(document.title)}</title>\n${styleBlock}${stageStyleBlock}</head>\n${bodyHtml}\n</html>\n`;
    return { html, fontDiagnostics };
  }

  function send(msg) {
    return new Promise((resolve) => chrome.runtime.sendMessage(msg, (resp) => resolve(resp)));
  }

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

  const svgIcon = (inner, size = 15) =>
    `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${inner}</svg>`;
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
  async function runCapture(root) {
    captureBtn.disabled = true;
    sectionBtn.disabled = true;
    captureBtn.classList.add("pm-busy");
    labelEl.textContent = "Capturing…";
    setStatus("capturing…", true);
    const { html, fontDiagnostics } = await captureBakedHtml(root);

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
    captureBtn.disabled = false;
    sectionBtn.disabled = false;
    captureBtn.classList.remove("pm-busy");
    if (!resp || !resp.ok) {
      labelEl.textContent = "Let's Page Bend";
      setStatus(`capture failed: ${resp && resp.error}`, true);
      return;
    }
    await send({ type: "PM_OPEN_PREVIEW", slug: resp.slug, url: resp.previewUrl });
    labelEl.textContent = "Let's Page Bend";
    setStatus(screenshot ? "captured — mock open in a new tab, enhancing fidelity there" : "captured — mock open in a new tab", true);
    setTimeout(() => setStatus("", false), 4000);
  }

  captureBtn.addEventListener("click", () => runCapture(document.body));

  // ---------- section-select mode (hover-highlight, click to capture just
  // that element instead of the whole page) — same interaction pattern as
  // mock-toolbar.js's own select-mode, applied here at capture time instead
  // of edit time. ----------
  let sectionSelectMode = false;

  function setSectionSelectMode(on) {
    sectionSelectMode = on;
    sectionBtn.classList.toggle("pm-on", on);
    hoverBox.style.display = "none";
    hoverBadge.style.display = "none";
    document.documentElement.style.cursor = on ? "crosshair" : "";
  }

  function onSectionMouseMove(e) {
    if (!sectionSelectMode) return;
    // Shadow DOM event retargeting means a listener OUTSIDE the shadow tree
    // (this one, on `document`) sees e.target as `host` itself for anything
    // happening inside our own panel — so this one check covers the whole
    // panel, not just individual elements within it.
    if (host.contains(e.target)) { hoverBox.style.display = "none"; hoverBadge.style.display = "none"; return; }
    const r = e.target.getBoundingClientRect();
    hoverBox.style.display = "block";
    hoverBox.style.left = `${r.left}px`;
    hoverBox.style.top = `${r.top}px`;
    hoverBox.style.width = `${r.width}px`;
    hoverBox.style.height = `${r.height}px`;
    // Small element-type tab (e.g. "td") on the frame — matches the
    // original Page Bender project's select tool.
    const cls = e.target.classList[0] ? `.${e.target.classList[0]}` : "";
    hoverBadge.textContent = e.target.tagName.toLowerCase() + cls;
    hoverBadge.style.display = "block";
    hoverBadge.style.left = `${r.left}px`;
    hoverBadge.style.top = `${Math.max(0, r.top - 24)}px`;
  }

  function onSectionClick(e) {
    if (!sectionSelectMode) return;
    if (host.contains(e.target)) return; // let the toggle-off click through normally
    e.preventDefault();
    e.stopPropagation();
    const el = e.target;
    setSectionSelectMode(false);
    runCapture(el);
  }

  document.addEventListener("mousemove", onSectionMouseMove, true);
  document.addEventListener("click", onSectionClick, true);
  sectionBtn.addEventListener("click", () => setSectionSelectMode(!sectionSelectMode));

  window.__pageMockToggle = () => {
    host.style.display = host.style.display === "none" ? "block" : "none";
  };
})();
