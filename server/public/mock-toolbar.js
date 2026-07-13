// Page Bender — mock-page toolbar.
//
// Injected (at HTTP-serve time only, by server.js — never written to
// working.html on disk) into the mock page itself. Runs same-origin with the
// local server, so /prompt, /diff, /save are plain fetch() calls, no
// extension relay needed. The one thing that DOES need the extension
// (capturing tab pixels for a screenshot) goes through
// chrome.runtime.sendMessage, enabled by `externally_connectable` in the
// extension's manifest.
//
// Visual design ("Halo Spotlight" — pink glow, pill -> composer card ->
// minimized bubble, dimmed/glowing "thinking" state) reproduces the branding
// from the earlier Page Bender project by explicit request — the colors,
// shell states, and font are the same; everything else here is a fresh
// implementation, not copied code.
(() => {
  if (document.currentScript) document.currentScript.remove();

  const slug = window.__PM_SLUG;
  const HISTORY_KEY = `pm-history-${slug}`;
  const HISTORY_CAP = 5;
  // A webpage calling chrome.runtime.sendMessage via externally_connectable
  // has no way to read its own "target extension" implicitly (unlike
  // background.js/content.js, which run inside the extension and can omit
  // it) — Chrome requires the extension ID as an explicit first argument
  // from a webpage context, or the call throws synchronously. Loaded
  // unpacked from a fixed path, so the ID stays stable across reloads; if
  // this extension is ever reinstalled/moved, grab the new ID from
  // chrome://extensions and update this constant.
  const EXTENSION_ID = "nepaeffdlkbpoonjpnagomchcfglfana";

  let history = [];
  let pointer = -1;
  let selectMode = false;
  let selection = null; // { el, descriptor, rect }
  let pendingImage = null; // cropped screenshot data URL, cleared after send
  let editingEl = null;
  let editingOriginalText = "";
  let sessionId = null;

  // ---------- self-hosted font ----------
  // Same file as Page Bender's, but no chrome-extension:// URL needed here —
  // this page is served by our own server, so a plain same-origin @font-face
  // works with no CSP concerns to route around.
  const fontStyle = document.createElement("style");
  fontStyle.textContent = `@font-face { font-family: 'Plus Jakarta Sans'; src: url(/fonts/PlusJakartaSans-Variable.woff2) format('woff2'); font-weight: 200 800; font-style: normal; }`;
  document.head.appendChild(fontStyle);

  // ---------- history (undo/redo, capped at 5) ----------

  function loadHistory() {
    try {
      const saved = JSON.parse(localStorage.getItem(HISTORY_KEY) || "null");
      if (saved && Array.isArray(saved.history) && saved.history.length) {
        history = saved.history;
        pointer = saved.pointer;
        return;
      }
    } catch {}
    history = [document.body.innerHTML];
    pointer = 0;
  }

  function saveHistoryLocal() {
    localStorage.setItem(HISTORY_KEY, JSON.stringify({ history, pointer }));
  }

  function pushHistory(bodyHtml, { persist }) {
    history = history.slice(0, pointer + 1);
    history.push(bodyHtml);
    if (history.length > HISTORY_CAP) history.shift();
    pointer = history.length - 1;
    saveHistoryLocal();
    updateUndoRedoButtons();
    if (persist) saveToDisk(bodyHtml);
  }

  function applyHistoryIndex(index) {
    document.body.innerHTML = history[index];
    saveToDisk(history[index]);
    saveHistoryLocal();
    updateUndoRedoButtons();
  }

  function saveToDisk(bodyHtml) {
    fetch("/save", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ slug, bodyHtml }),
    }).catch((err) => console.warn("[page-bender] save failed:", err.message));
  }

  function updateUndoRedoButtons() {
    undoBtn.disabled = pointer <= 0;
    redoBtn.disabled = pointer >= history.length - 1;
  }

  // ---------- click-to-edit text ----------

  const NEVER_EDITABLE = new Set(["input", "textarea", "select", "option", "svg", "img", "br", "hr", "canvas"]);

  function isTextLeaf(el) {
    if (!el || el.nodeType !== 1) return false;
    if (NEVER_EDITABLE.has(el.tagName.toLowerCase())) return false;
    if (!el.childNodes.length) return false;
    return [...el.childNodes].every((n) => n.nodeType === Node.TEXT_NODE);
  }

  function findEditableAncestor(el) {
    while (el && el !== document.body) {
      if (isTextLeaf(el)) return el;
      el = el.parentElement;
    }
    return null;
  }

  // floating "editing" badge (§5.10) — created once, positioned above
  // whichever element is currently being edited.
  const editBadge = document.createElement("div");
  editBadge.className = "pm-edit-badge";
  editBadge.style.display = "none";
  document.documentElement.appendChild(editBadge);

  function positionEditBadge(el) {
    const r = el.getBoundingClientRect();
    editBadge.style.left = `${Math.max(4, r.left)}px`;
    editBadge.style.top = `${Math.max(4, r.top - 24)}px`;
  }

  function beginEdit(el) {
    editingEl = el;
    editingOriginalText = el.textContent;
    el.contentEditable = "true";
    el.classList.add("pm-editable-active");
    el.focus();
    const range = document.createRange();
    range.selectNodeContents(el);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    editBadge.innerHTML = `${ICONS.edit} editing`;
    positionEditBadge(el);
    editBadge.style.display = "flex";
    el.addEventListener("keydown", onEditKeydown);
    el.addEventListener("blur", onEditBlur);
  }

  function onEditKeydown(e) {
    if (e.key === "Enter") { e.preventDefault(); editingEl.blur(); }
    else if (e.key === "Escape") { e.preventDefault(); editingEl.textContent = editingOriginalText; editingEl.blur(); }
  }

  function onEditBlur() {
    const el = editingEl;
    el.removeEventListener("keydown", onEditKeydown);
    el.removeEventListener("blur", onEditBlur);
    el.removeAttribute("contenteditable");
    el.classList.remove("pm-editable-active");
    editBadge.style.display = "none";
    editingEl = null;
    if (el.textContent !== editingOriginalText) {
      pushHistory(document.body.innerHTML, { persist: true });
      el.classList.add("pm-saved-flash");
      setTimeout(() => el.classList.remove("pm-saved-flash"), 500);
    }
  }

  // ---------- select mode (context for prompts + screenshot + quick edit) ----------

  const hoverBox = document.createElement("div");
  hoverBox.style.cssText = "position:fixed;pointer-events:none;z-index:2147483645;border:2px solid #ff3d92;background:rgba(255,61,146,0.08);display:none;";
  document.documentElement.appendChild(hoverBox);

  // Small element-type tab on the hover frame — matches the original Page
  // Bender project's select tool (tagName + first real class, e.g. "td" or
  // "div.Card_root__x2z"), positioned just above the outline.
  const hoverBadge = document.createElement("div");
  hoverBadge.style.cssText = "position:fixed;pointer-events:none;z-index:2147483646;display:none;padding:3px 8px;border-radius:6px;font-size:11px;font-family:'Plus Jakarta Sans',-apple-system,system-ui,sans-serif;background:#18121d;color:#ff9fd1;";
  document.documentElement.appendChild(hoverBadge);

  function describeElement(el) {
    const tag = el.tagName.toLowerCase();
    const id = el.id ? `#${el.id}` : "";
    const classes = el.classList.length ? `.${[...el.classList].join(".")}` : "";
    const text = (el.textContent || "").trim().replace(/\s+/g, " ").slice(0, 60);
    return `<${tag}${id}${classes}>${text ? ` — "${text}"` : ""}`;
  }

  function onMouseMove(e) {
    if (!selectMode) return;
    const el = e.target;
    if (toolbar.contains(el) || quickEdit.contains(el) || styleTrigger.contains(el)) {
      hoverBox.style.display = "none";
      hoverBadge.style.display = "none";
      return;
    }
    const r = el.getBoundingClientRect();
    hoverBox.style.display = "block";
    hoverBox.style.left = `${r.left}px`;
    hoverBox.style.top = `${r.top}px`;
    hoverBox.style.width = `${r.width}px`;
    hoverBox.style.height = `${r.height}px`;
    const cls = el.classList[0] ? `.${el.classList[0]}` : "";
    hoverBadge.textContent = el.tagName.toLowerCase() + cls;
    hoverBadge.style.display = "block";
    hoverBadge.style.left = `${r.left}px`;
    hoverBadge.style.top = `${Math.max(0, r.top - 24)}px`;
  }

  function setSelectMode(on) {
    selectMode = on;
    if (on) setScreenshotMode(false); // mutually exclusive drag/click modes
    selectBtn.classList.toggle("pm-on", on);
    hoverBox.style.display = "none";
    hoverBadge.style.display = "none";
  }

  function updateSelectionChip() {
    if (selection || pendingImage) {
      chipEl.style.display = "flex";
      chipEl.classList.toggle("pm-image", !!pendingImage);
      chipTextEl.textContent = selection ? selection.descriptor : "Screenshot attached";
      chipThumbEl.style.display = pendingImage ? "block" : "none";
      if (pendingImage) chipThumbEl.src = pendingImage;
    } else {
      chipEl.style.display = "none";
      chipEl.classList.remove("pm-image");
    }
  }

  document.body.addEventListener("click", (e) => {
    if (selectMode) {
      e.preventDefault();
      e.stopPropagation();
      selection = { el: e.target, descriptor: describeElement(e.target), rect: e.target.getBoundingClientRect() };
      pendingImage = null;
      setSelectMode(false);
      updateSelectionChip();
      showStyleTrigger(selection.el);
      return;
    }
  });
  document.body.addEventListener("dblclick", (e) => {
    if (selectMode || editingEl) return;
    const el = findEditableAncestor(e.target);
    if (el) { e.preventDefault(); beginEdit(el); }
  });
  document.addEventListener("mousemove", onMouseMove, true);

  // ---------- area screenshot (drag to draw ANY rectangle, independent of
  // Select — highlight whatever region you actually want as a reference,
  // not just one existing DOM element's exact bounding box) ----------

  let screenshotMode = false;
  let dragStart = null;
  // The drag gesture's mouseup is immediately followed by a synthetic
  // "click" event targeting the host page (not the toolbar) — without this,
  // the click-outside-to-close listener below sees that as a click outside
  // the card and closes it before the capture's result (chip/status) is
  // ever visible.
  let ignoreNextOutsideClick = false;

  const dragBox = document.createElement("div");
  dragBox.style.cssText = "position:fixed;pointer-events:none;z-index:2147483645;border:2px dashed #ff3d92;background:rgba(255,61,146,0.08);display:none;";
  document.documentElement.appendChild(dragBox);

  function setScreenshotMode(on) {
    screenshotMode = on;
    if (on) setSelectMode(false); // mutually exclusive drag/click modes
    screenshotBtn.classList.toggle("pm-on", on);
    document.documentElement.style.cursor = on ? "crosshair" : "";
    if (!on) { dragBox.style.display = "none"; dragStart = null; }
  }

  function updateDragBox(x1, y1, x2, y2) {
    dragBox.style.display = "block";
    dragBox.style.left = `${Math.min(x1, x2)}px`;
    dragBox.style.top = `${Math.min(y1, y2)}px`;
    dragBox.style.width = `${Math.abs(x2 - x1)}px`;
    dragBox.style.height = `${Math.abs(y2 - y1)}px`;
  }

  document.addEventListener("mousedown", (e) => {
    if (!screenshotMode) return;
    if (toolbar.contains(e.target) || quickEdit.contains(e.target) || styleTrigger.contains(e.target)) return;
    e.preventDefault();
    e.stopPropagation();
    ignoreNextOutsideClick = true;
    dragStart = { x: e.clientX, y: e.clientY };
    updateDragBox(dragStart.x, dragStart.y, dragStart.x, dragStart.y);
  }, true);
  document.addEventListener("mousemove", (e) => {
    if (!screenshotMode || !dragStart) return;
    updateDragBox(dragStart.x, dragStart.y, e.clientX, e.clientY);
  }, true);
  document.addEventListener("mouseup", (e) => {
    if (!screenshotMode || !dragStart) return;
    e.preventDefault();
    e.stopPropagation();
    const rect = dragBox.getBoundingClientRect();
    setScreenshotMode(false);
    if (rect.width < 6 || rect.height < 6) return; // no real drag — treat as a cancel, not an empty capture
    captureAreaScreenshot(rect);
  }, true);

  function captureAreaScreenshot(rect) {
    if (typeof chrome === "undefined" || !chrome.runtime || !chrome.runtime.sendMessage) {
      setStatus("screenshot needs the Page Bender extension active in this tab");
      return;
    }
    setStatus("capturing screenshot…");
    console.log("[page-bender] area screenshot: sending PM_SCREENSHOT", rect);
    // A dead/stale extension message channel (e.g. the extension was
    // reloaded since this tab loaded) can leave sendMessage's callback never
    // firing at all, with no visible error — hangs silently on "capturing
    // screenshot…" forever. A hard timeout turns that into a clear error
    // instead of an indefinite stall.
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      console.error("[page-bender] area screenshot: PM_SCREENSHOT callback never fired within 8s — extension message channel likely dead (try reloading the tab)");
      setStatus("screenshot timed out — try reloading this tab (extension connection may be stale)");
    }, 8000);
    // sendMessage itself can throw SYNCHRONOUSLY (not just fail to call
    // back) — e.g. "Extension context invalidated." if the extension was
    // reloaded/updated after this tab's chrome.runtime reference was
    // created. An uncaught throw here would skip both the timeout cleanup
    // and any status update, leaving the UI stuck on "capturing
    // screenshot…" forever with no visible explanation.
    try {
      chrome.runtime.sendMessage(
        EXTENSION_ID,
        { type: "PM_SCREENSHOT" },
        (resp) => {
          if (settled) return; // timeout already fired first
          settled = true;
          clearTimeout(timeout);
          if (chrome.runtime.lastError) {
            console.error("[page-bender] area screenshot: chrome.runtime.lastError:", chrome.runtime.lastError.message);
          }
          console.log("[page-bender] area screenshot: PM_SCREENSHOT response", resp);
          if (!resp || !resp.ok) {
            setStatus(`screenshot failed: ${(resp && resp.error) || (chrome.runtime.lastError && chrome.runtime.lastError.message) || "no response"}`);
            return;
          }
          cropToSelection(resp.dataUrl, rect).then((cropped) => {
            pendingImage = cropped;
            updateSelectionChip();
            setStatus("screenshot attached — describe the change and send");
          }).catch((err) => {
            console.error("[page-bender] area screenshot: cropToSelection failed:", err);
            setStatus(`screenshot crop failed: ${err.message}`);
          });
        }
      );
    } catch (err) {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      console.error("[page-bender] area screenshot: sendMessage threw:", err.message);
      setStatus("extension was reloaded — reload this tab, then try the screenshot again");
    }
  }

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

  // ---------- color palette extraction (preset swatches) ----------

  function extractPalette() {
    const counts = new Map();
    const bump = (val) => {
      if (!val) return;
      if (val === "transparent" || /rgba?\([^)]*,\s*0\s*\)$/.test(val)) return;
      counts.set(val, (counts.get(val) || 0) + 1);
    };
    document.body.querySelectorAll("*").forEach((el) => {
      const cs = getComputedStyle(el);
      bump(cs.color);
      bump(cs.backgroundColor);
    });
    return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([c]) => c);
  }

  // ---------- icons (Lucide-style, stroke = currentColor) ----------
  // Defined here (rather than down near the toolbar shell markup that's the
  // main consumer) because the quick-edit trigger bubble below references
  // ICONS.sliders at top-level script-execution time, not lazily inside an
  // event handler like every other ICONS usage in this file — so it needs
  // ICONS to already exist, not just be hoisted as a `const` (TDZ).

  const svgIcon = (inner, size = 16) =>
    `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${inner}</svg>`;
  // one shared shape (a square whose corner radius varies) reads as a clear
  // "corner radius" glyph at a glance, so the four quick-edit presets are
  // generated from it instead of four unrelated one-off icons.
  const radiusIcon = (rx) => svgIcon(`<rect x="4.5" y="4.5" width="15" height="15" rx="${rx}"/>`, 14);
  const ICONS = {
    sparkles: svgIcon('<path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z"/>', 15),
    select: svgIcon('<circle cx="12" cy="12" r="9"/><line x1="22" y1="12" x2="18" y2="12"/><line x1="6" y1="12" x2="2" y2="12"/><line x1="12" y1="6" x2="12" y2="2"/><line x1="12" y1="22" x2="12" y2="18"/>'),
    areaShot: svgIcon('<rect x="3" y="3" width="18" height="18" rx="2" stroke-dasharray="4 3"/>'),
    undo: svgIcon('<path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 5.5 5.5v0a5.5 5.5 0 0 1-5.5 5.5H11"/>'),
    redo: svgIcon('<path d="m15 14 5-5-5-5"/><path d="M20 9H9.5A5.5 5.5 0 0 0 4 14.5v0A5.5 5.5 0 0 0 9.5 20H13"/>'),
    exportIco: svgIcon('<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>'),
    arrowRight: svgIcon('<path d="M5 12h14"/><path d="m12 5 7 7-7 7"/>'),
    minimize: svgIcon('<path d="M4 14h6v6"/><path d="M20 10h-6V4"/><path d="m14 10 7-7"/><path d="m3 21 7-7"/>', 14),
    close: svgIcon('<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>', 13),
    stopSquare: svgIcon('<rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" stroke="none"/>', 12),
    // The extension's own logo mark: two legs merging into a single
    // upward arrow (the "bend" in Page Bender) — used on the minimized
    // bubble instead of the generic sparkle, so the restore button reads
    // as our icon rather than a stock glyph.
    bend: svgIcon('<path d="M8 9 12 4l4 5"/><path d="M12 4v10"/><path d="M12 14 7 20"/><path d="M12 14l5 6"/>', 20),
    info: svgIcon('<circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/>', 13),
    edit: svgIcon('<path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/><path d="m15 5 4 4"/>', 12),
    sliders: svgIcon('<line x1="4" y1="21" x2="4" y2="14"/><line x1="4" y1="10" x2="4" y2="3"/><line x1="12" y1="21" x2="12" y2="12"/><line x1="12" y1="8" x2="12" y2="3"/><line x1="20" y1="21" x2="20" y2="16"/><line x1="20" y1="12" x2="20" y2="3"/><line x1="1" y1="14" x2="7" y2="14"/><line x1="9" y1="8" x2="15" y2="8"/><line x1="17" y1="16" x2="23" y2="16"/>', 15),
    plus: svgIcon('<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>', 11),
    radius0: radiusIcon(0),
    radius4: radiusIcon(3),
    radius8: radiusIcon(6),
    radiusFull: radiusIcon(7.5),
  };

  // ---------- quick edit: minimized trigger + full panel (color + radius) ----------
  //
  // Opens collapsed by default (a small trigger bubble parked at the
  // selected element's corner, matching the mini-bubble language in
  // DESIGN-SYSTEM.md §5.5) rather than popping the full panel open
  // immediately on every selection — the panel only appears once the user
  // deliberately asks for it. "Minimize" on the panel returns to the
  // trigger (context kept); "Close" dismisses both (see the two reset call
  // sites — chip-clear and post-prompt — which call both hide fns).

  const styleTrigger = document.createElement("button");
  styleTrigger.id = "pm-qe-trigger";
  styleTrigger.title = "Style this element";
  styleTrigger.innerHTML = `<span class="pm-qe-trigger-halo"></span>${ICONS.sliders}`;
  document.documentElement.appendChild(styleTrigger);

  const quickEdit = document.createElement("div");
  quickEdit.id = "pm-quickedit";
  document.documentElement.appendChild(quickEdit);

  let qeTargetEl = null;

  function swatchRow(target, current) {
    const palette = extractPalette();
    const norm = (c) => {
      const p = document.createElement("p");
      p.style.color = c;
      document.body.appendChild(p);
      const v = getComputedStyle(p).color;
      p.remove();
      return v;
    };
    const currentNorm = norm(current);
    const swatches = palette.map((c) =>
      `<button class="pm-qe-swatch${norm(c) === currentNorm ? " pm-qe-active" : ""}" data-target="${target}" data-color="${c}" style="background:${c};" title="${c}"></button>`
    ).join("");
    return `
      <div class="pm-qe-row">
        <span class="pm-qe-label">${target === "backgroundColor" ? "Fill" : "Text"}</span>
        <div class="pm-qe-swatches">
          ${swatches}
          <button class="pm-qe-add" data-target="${target}" title="Custom color">${ICONS.plus}</button>
          <input type="color" class="pm-qe-custom" data-target="${target}" tabindex="-1" />
        </div>
      </div>`;
  }

  function showStyleTrigger(el) {
    qeTargetEl = el;
    quickEdit.classList.remove("pm-open");
    const r = el.getBoundingClientRect();
    styleTrigger.style.left = `${Math.min(r.right - 14, window.innerWidth - 36)}px`;
    styleTrigger.style.top = `${Math.max(4, r.top - 14)}px`;
    styleTrigger.classList.add("pm-show");
  }

  function hideStyleTrigger() {
    styleTrigger.classList.remove("pm-show");
    qeTargetEl = null;
  }

  styleTrigger.addEventListener("click", () => {
    if (!qeTargetEl) return;
    styleTrigger.classList.remove("pm-show");
    showQuickEdit(qeTargetEl);
  });

  function showQuickEdit(el) {
    qeTargetEl = el;
    const rect = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    const radius = parseInt(cs.borderTopLeftRadius, 10) || 0;
    const cls = el.classList[0] ? `.${el.classList[0]}` : "";
    quickEdit.innerHTML = `
      <div class="pm-qe-head">
        <span class="pm-qe-tag" title="${el.tagName.toLowerCase()}${cls}">${el.tagName.toLowerCase()}${cls}</span>
        <div class="pm-qe-headBtns">
          <button class="pm-qe-min" title="Minimize">${ICONS.minimize}</button>
          <button class="pm-qe-close" title="Close">${ICONS.close}</button>
        </div>
      </div>
      ${swatchRow("backgroundColor", cs.backgroundColor)}
      ${swatchRow("color", cs.color)}
      <div class="pm-qe-row pm-qe-radius-row">
        <span class="pm-qe-label">Radius</span>
        <div class="pm-qe-radius-presets">
          <button data-radius="0" title="Square">${ICONS.radius0}</button>
          <button data-radius="6" title="Small">${ICONS.radius4}</button>
          <button data-radius="16" title="Medium">${ICONS.radius8}</button>
          <button data-radius="999" title="Pill">${ICONS.radiusFull}</button>
        </div>
      </div>
      <div class="pm-qe-row pm-qe-radius-fine">
        <input type="range" class="pm-qe-radius-slider" min="0" max="48" value="${Math.min(radius, 48)}" />
        <span class="pm-qe-radius-value"><input type="number" class="pm-qe-radius-input" min="0" max="999" value="${radius}" />px</span>
      </div>
    `;
    quickEdit.classList.add("pm-open"); // must be visible (display != none) before positionQuickEdit measures its own height
    positionQuickEdit(rect);

    function setActiveSwatch(target, btn) {
      quickEdit.querySelectorAll(`.pm-qe-swatch[data-target="${target}"]`).forEach((b) => b.classList.remove("pm-qe-active"));
      if (btn) btn.classList.add("pm-qe-active");
    }

    quickEdit.querySelectorAll(".pm-qe-swatch").forEach((btn) => {
      btn.addEventListener("click", () => {
        el.style[btn.dataset.target] = btn.dataset.color;
        setActiveSwatch(btn.dataset.target, btn);
        pushHistory(document.body.innerHTML, { persist: true });
      });
    });
    quickEdit.querySelectorAll(".pm-qe-add").forEach((btn) => {
      btn.addEventListener("click", () => {
        quickEdit.querySelector(`.pm-qe-custom[data-target="${btn.dataset.target}"]`).click();
      });
    });
    quickEdit.querySelectorAll(".pm-qe-custom").forEach((input) => {
      input.addEventListener("input", () => {
        el.style[input.dataset.target] = input.value;
        setActiveSwatch(input.dataset.target, null);
      });
      input.addEventListener("change", () => pushHistory(document.body.innerHTML, { persist: true }));
    });

    const slider = quickEdit.querySelector(".pm-qe-radius-slider");
    const numInput = quickEdit.querySelector(".pm-qe-radius-input");
    const setRadius = (px, commit) => {
      el.style.borderRadius = `${px}px`;
      slider.value = Math.min(px, 48);
      numInput.value = px;
      quickEdit.querySelectorAll(".pm-qe-radius-presets button").forEach((b) =>
        b.classList.toggle("pm-on", Number(b.dataset.radius) === px || (b.dataset.radius === "999" && px >= 999)));
      if (commit) pushHistory(document.body.innerHTML, { persist: true });
    };
    slider.addEventListener("input", () => setRadius(Number(slider.value), false));
    slider.addEventListener("change", () => setRadius(Number(slider.value), true));
    numInput.addEventListener("change", () => setRadius(Math.max(0, Number(numInput.value) || 0), true));
    quickEdit.querySelectorAll(".pm-qe-radius-presets button").forEach((btn) => {
      btn.addEventListener("click", () => setRadius(Number(btn.dataset.radius), true));
    });
    setRadius(radius, false);

    quickEdit.querySelector(".pm-qe-min").addEventListener("click", () => {
      hideQuickEdit();
      showStyleTrigger(el);
    });
    quickEdit.querySelector(".pm-qe-close").addEventListener("click", () => {
      hideQuickEdit();
      hideStyleTrigger();
    });
  }

  function positionQuickEdit(rect) {
    quickEdit.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - 292))}px`;
    quickEdit.style.transform = "none"; // top is computed in absolute terms below, no anchor trick needed

    // Measured AFTER the panel is already display:flex (its
    // getBoundingClientRect is all-zero while pm-open hasn't been added).
    const panelHeight = quickEdit.getBoundingClientRect().height;
    // The toolbar (pill/card/bubble) is fixed at the bottom of the viewport
    // and shares this panel's z-index, so whichever is later in the DOM
    // wins paint order on overlap — never let this panel's bottom edge
    // cross into its footprint, regardless of where the selection sits.
    const safeBottom = toolbar.getBoundingClientRect().top - 12;

    const below = rect.bottom + 8;
    const above = rect.top - 8 - panelHeight;
    let top;
    if (below >= 8 && below + panelHeight <= safeBottom) {
      top = below; // fits below the selection, clear of the toolbar
    } else if (above >= 8 && above + panelHeight <= safeBottom) {
      top = above; // fits above the selection, clear of the toolbar
    } else {
      top = Math.max(8, safeBottom - panelHeight); // neither side clears the toolbar — pin just above it
    }
    quickEdit.style.top = `${top}px`;
  }

  function hideQuickEdit() {
    quickEdit.classList.remove("pm-open");
  }

  // ---------- toolbar shell (pill -> composer card -> minimized bubble) ----------

  const Z = 2147483647;
  const toolbar = document.createElement("div");
  toolbar.id = "pm-toolbar";
  toolbar.innerHTML = `
    <style>
      #pm-toolbar {
        --pm-pink: #ff3d92; --pm-pink-2: #ff6ec7; --pm-pink-3: #ff2d78;
        --pm-ink-1: #18121d; --pm-ink-2: #100c14; --pm-border: #2d2436;
        --pm-text: #f4eef7; --pm-text-dim: #d3c2d6; --pm-text-mute: #776b81;
        --pm-status: #ff9fd1;
        position: fixed; left: 50%; bottom: 36px; transform: translateX(-50%);
        z-index: ${Z}; font-family: 'Plus Jakarta Sans', -apple-system, system-ui, sans-serif;
        font-weight: 400; color: var(--pm-text);
      }
      #pm-toolbar * { box-sizing: border-box; font-family: inherit; }
      #pm-scrim { position: fixed; inset: 0; z-index: ${Z - 1};
        background: rgba(10,8,6,0); pointer-events: none; transition: background .35s ease; }
      #pm-scrim.pm-on { background: rgba(10,8,6,.14); }

      .pm-pill { display: flex; align-items: center; gap: 10px; padding: 12px 20px;
        border-radius: 999px; cursor: pointer; position: relative;
        background: rgba(20,14,22,.9); border: 1px solid var(--pm-border);
        backdrop-filter: blur(14px); box-shadow: 0 10px 40px rgba(0,0,0,.45);
        transition: opacity .2s ease; }
      .pm-pill.pm-hidden { opacity: 0; pointer-events: none; position: absolute; }
      .pm-pill .pm-halo { position: absolute; inset: -18px; border-radius: 999px; z-index: -1;
        background: radial-gradient(circle, rgba(255,45,120,.4), transparent 70%); filter: blur(6px);
        animation: pm-breathe 3.4s ease-in-out infinite; }
      @keyframes pm-breathe { 0%,100% { opacity: .5; transform: scale(1); } 50% { opacity: 1; transform: scale(1.08); } }
      .pm-pill .pm-sparkle { display: flex; color: var(--pm-pink-2); }
      .pm-pill .pm-label { font-size: 14.5px; }

      .pm-card { display: none; width: min(480px, 92vw); position: relative;
        background: linear-gradient(180deg, var(--pm-ink-1), var(--pm-ink-2));
        border: 1px solid var(--pm-border); border-radius: 22px; padding: 20px 22px 16px;
        box-shadow: 0 30px 80px rgba(0,0,0,.65); }
      .pm-card.pm-open { display: block; }
      .pm-card .pm-halo2 { position: absolute; inset: -5px; z-index: -1; border-radius: 34px;
        background: radial-gradient(circle at 28% 30%, rgba(255,110,199,.55), transparent 55%),
                    radial-gradient(circle at 76% 74%, rgba(255,45,120,.5), transparent 55%);
        filter: blur(9px); animation: pm-wobble 5s ease-in-out infinite; opacity: .6; transition: opacity .2s ease; }
      .pm-card.pm-thinking .pm-halo2 { opacity: 1; animation-duration: 2.4s; }
      /* The halo sits 5px outside the card's own 22px-radius corner
         (position:absolute; inset:-5px), so its radius needs to clear
         ~27px to stay rounded to match. A prior pass raised the floor to
         28px — technically above the threshold, but only by 1px, so
         sub-pixel rounding still let a squared-off sliver of the halo
         poke past the card's rounded edge (the "pointy grey" corner).
         Keeping every keyframe at 34px+ (matching the resting radius,
         same as the halo's own base radius above) leaves a real margin
         instead of a razor's edge. */
      @keyframes pm-wobble {
        0%, 100% { border-radius: 34px; transform: scale(1); }
        25% { border-radius: 44px 36px 42px 38px; transform: scale(1.012); }
        50% { border-radius: 36px 44px 38px 46px; transform: scale(0.99); }
        75% { border-radius: 44px 38px 46px 36px; transform: scale(1.008); }
      }
      .pm-titlebar { display: flex; align-items: center; gap: 6px; margin: 0 0 14px; }
      .pm-greet { font-size: 18px; margin: 0; }
      .pm-info-wrap { position: relative; display: inline-flex; }
      .pm-info-icon { width: 17px; height: 17px; border-radius: 50%; border: 1px solid var(--pm-border);
        background: rgba(255,255,255,.04); color: var(--pm-text-mute); cursor: help;
        display: flex; align-items: center; justify-content: center; }
      .pm-info-icon:hover { background: rgba(255,61,146,.14); color: var(--pm-status); border-color: rgba(255,61,146,.3); }
      .pm-tooltip { position: absolute; left: 0; bottom: calc(100% + 8px); width: 220px; z-index: 5;
        background: var(--pm-ink-1); border: 1px solid var(--pm-border); border-radius: 10px;
        padding: 9px 11px; font-size: 11px; line-height: 1.45; color: var(--pm-text-dim);
        box-shadow: 0 16px 40px rgba(0,0,0,.5); opacity: 0; transform: translateY(4px);
        pointer-events: none; transition: opacity .15s ease, transform .15s ease; }
      .pm-info-wrap:hover .pm-tooltip, .pm-info-wrap:focus-within .pm-tooltip { opacity: 1; transform: translateY(0); }
      .pm-min { position: absolute; top: 14px; right: 16px; width: 26px; height: 26px; border-radius: 8px;
        border: 1px solid var(--pm-border); background: rgba(255,255,255,.03); color: var(--pm-text-dim);
        cursor: pointer; display: flex; align-items: center; justify-content: center; }
      .pm-min:hover { background: rgba(255,61,146,.14); color: var(--pm-status); border-color: rgba(255,61,146,.3); }
      /* Icon-only square, same footprint as .pm-min, sitting just to its
         left — hidden by default (inline style="display:none"), shown
         only while .pm-thinking via setThinking()'s stopBtn.style.display
         toggle (kept as-is; only the button's markup/position moved here
         from the bottom row). */
      .pm-stop-top { position: absolute; top: 14px; right: 50px; width: 26px; height: 26px; border-radius: 8px;
        border: 1px solid rgba(255,80,80,.35); background: rgba(255,255,255,.03); color: #ff9494;
        cursor: pointer; align-items: center; justify-content: center; }
      .pm-stop-top:hover { background: rgba(255,60,60,.16); border-color: rgba(255,80,80,.5); }

      .pm-chip { font-size: 11px; background: rgba(255,255,255,.03); border: 1px solid var(--pm-border);
        border-radius: 8px; padding: 6px 8px; display: flex; align-items: center; gap: 6px; margin-bottom: 10px; }
      .pm-chip img { width: 28px; height: 20px; object-fit: cover; border-radius: 3px; display: none; }
      .pm-chip span { flex: 1; color: var(--pm-text-dim); }
      .pm-chip a { color: var(--pm-status); text-decoration: none; }
      /* Image-attached state: a real, sized preview (like an image pasted
         into any chat composer) instead of the tiny 28x20 cropped sliver
         used for the text-only element-selection chip above. Checkerboard
         backdrop so a transparent-background crop still reads as an actual
         picture rather than empty space. */
      .pm-chip.pm-image { align-items: flex-start; padding: 8px; }
      .pm-chip.pm-image img {
        width: auto; max-width: 160px; height: 72px; object-fit: contain;
        border-radius: 6px; border: 1px solid var(--pm-border); padding: 3px;
        background-color: #100c14;
        background-image:
          linear-gradient(45deg, rgba(255,255,255,.06) 25%, transparent 25%),
          linear-gradient(-45deg, rgba(255,255,255,.06) 25%, transparent 25%),
          linear-gradient(45deg, transparent 75%, rgba(255,255,255,.06) 75%),
          linear-gradient(-45deg, transparent 75%, rgba(255,255,255,.06) 75%);
        background-size: 12px 12px;
        background-position: 0 0, 0 6px, 6px -6px, -6px 0;
      }
      .pm-chip.pm-image span { align-self: center; }

      .pm-input { width: 100%; background: transparent; border: none; outline: none; resize: none;
        max-height: 140px; color: #ffffff; font: 400 15px/1.5 'Plus Jakarta Sans', -apple-system, system-ui, sans-serif;
        padding: 0 0 12px; }
      .pm-input::placeholder { color: var(--pm-text-mute); }
      .pm-status { font-size: 12px; color: var(--pm-text-mute); min-height: 15px; margin-bottom: 10px; line-height: 1.4; transition: color .15s ease; }
      .pm-card.pm-thinking .pm-status { color: var(--pm-status); }
      .pm-card.pm-thinking .pm-input { opacity: .4; pointer-events: none; }
      /* Hidden outright, not just dimmed — every tool in this row is
         already pointer-events:none while thinking (nothing to click), and
         showing all 5 of them dimmed with no visible scrollbar
         (scrollbar-width:none, no affordance that there was more to scroll
         to) just looked clipped/broken. Stop now lives in the titlebar
         (.pm-stop-top), not this row, so there's nothing left worth
         showing here while thinking. */
      .pm-card.pm-thinking .pm-tools { display: none; }

      .pm-row { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
      .pm-tools { display: flex; gap: 6px; flex-wrap: nowrap; overflow-x: auto; scrollbar-width: none; min-width: 0; }
      .pm-tools::-webkit-scrollbar { display: none; }
      .pm-tool { border: 1px solid var(--pm-border); background: rgba(255,255,255,.02); color: var(--pm-text-dim);
        font: 500 11px 'Plus Jakarta Sans', sans-serif; padding: 6px 10px; border-radius: 999px; cursor: pointer;
        display: flex; align-items: center; gap: 5px; }
      .pm-tool:hover { background: rgba(255,61,146,.1); }
      .pm-tool.pm-on { background: linear-gradient(135deg, var(--pm-pink), var(--pm-pink-3)); color: #1c0f18; border-color: transparent; }
      .pm-tool:disabled { opacity: .35; cursor: default; }
      .pm-send { width: 38px; height: 38px; border-radius: 50%; border: none; cursor: pointer;
        background: linear-gradient(135deg, var(--pm-pink-2), var(--pm-pink-3)); color: #1c0f18;
        display: flex; align-items: center; justify-content: center; box-shadow: 0 8px 20px rgba(255,45,120,.4); flex: none; }
      .pm-send .pm-sp { display: none; width: 14px; height: 14px; border-radius: 50%;
        border: 2px solid rgba(28,15,24,.35); border-top-color: #1c0f18; animation: pm-spin .7s linear infinite; }
      .pm-send.pm-loading .pm-ar { display: none; } .pm-send.pm-loading .pm-sp { display: block; }
      @keyframes pm-spin { to { transform: rotate(360deg); } }

      /* Literal hex values AND an explicit font-family, not #pm-toolbar's
         --pm-* custom properties / inherited font — this menu lives outside
         #pm-toolbar's subtree (see the appendChild note below), so it can't
         inherit variables OR font-family scoped there (and buttons don't
         inherit font from an ancestor by default anyway — UA stylesheet).
         Same reasoning, same fix, as .pm-editable-active/.pm-edit-badge
         further down. */
      .pm-export-menu { display: none; position: fixed; z-index: ${Z}; flex-direction: column; gap: 2px;
        font-family: 'Plus Jakarta Sans', -apple-system, system-ui, sans-serif;
        background: linear-gradient(180deg, #18121d, #100c14);
        border: 1px solid #2d2436; border-radius: 12px; padding: 6px;
        min-width: 150px; box-shadow: 0 20px 50px rgba(0,0,0,.55); }
      .pm-export-menu.pm-open { display: flex; }
      .pm-export-opt { all: unset; box-sizing: border-box; width: 100%; cursor: pointer;
        font-family: inherit; padding: 8px 10px; border-radius: 8px; font-size: 12.5px; color: #d3c2d6; }
      .pm-export-opt:hover { background: rgba(255,61,146,.12); color: #f4eef7; }

      .pm-bubble { position: fixed; left: 50%; bottom: 36px; transform: translateX(-50%);
        width: 46px; height: 46px; border-radius: 50%; border: none; cursor: pointer; display: none;
        align-items: center; justify-content: center; z-index: ${Z};
        background: linear-gradient(135deg, var(--pm-pink-2), var(--pm-pink-3)); color: #1c0f18;
        box-shadow: 0 10px 30px rgba(255,45,120,.45); }
      .pm-bubble.pm-show { display: flex; }
      .pm-bubble::after { content: ""; position: absolute; inset: -6px; border-radius: 50%;
        border: 1.5px solid rgba(255,110,199,.5); animation: pm-breathe 2.6s ease-in-out infinite; }

      .pm-pill-dot { width: 8px; height: 8px; border-radius: 50%; flex: none;
        background: var(--pm-pink); box-shadow: 0 0 0 2px rgba(20,14,22,.9);
        animation: pm-breathe 2s ease-in-out infinite; }
      .pm-update-banner { display: none; align-items: center; justify-content: space-between; gap: 10px;
        background: rgba(255,61,146,.1); border: 1px solid rgba(255,61,146,.3); border-radius: 10px;
        padding: 8px 8px 8px 12px; margin-bottom: 12px; font-size: 12px; color: var(--pm-text-dim); }
      .pm-update-banner.pm-show { display: flex; }
      .pm-update-banner .pm-update-text { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .pm-update-btn { all: unset; flex: none; cursor: pointer; font: 600 11px 'Plus Jakarta Sans', sans-serif;
        color: #1c0f18; background: linear-gradient(135deg, var(--pm-pink), var(--pm-pink-3));
        padding: 6px 11px; border-radius: 999px; }
      .pm-update-btn:disabled { opacity: .55; cursor: default; }
    </style>
    <div id="pm-scrim"></div>
    <div class="pm-pill" id="pm-pill-open">
      <div class="pm-halo"></div>
      <span class="pm-sparkle">${ICONS.bend}</span>
      <span class="pm-label">Page Bender</span>
      <span id="pm-pill-dot" class="pm-pill-dot" style="display:none;"></span>
    </div>
    <div class="pm-card">
      <div class="pm-halo2"></div>
      <button class="pm-min" id="pm-minimize" title="Minimize — keep the mock visible">${ICONS.minimize}</button>
      <button class="pm-stop-top" id="pm-stop" style="display:none;" title="Stop the in-progress AI pass (Esc) — whatever it already changed stays">${ICONS.stopSquare}</button>
      <div class="pm-titlebar">
        <p class="pm-greet">What should we change?</p>
        <span class="pm-info-wrap" tabindex="0">
          <span class="pm-info-icon">${ICONS.info}</span>
          <span class="pm-tooltip">Click text on the page to edit directly. Select an element for color/radius or prompt context.</span>
        </span>
      </div>
      <div id="pm-update-banner" class="pm-update-banner">
        <span class="pm-update-text" id="pm-update-text">Update available</span>
        <button class="pm-update-btn" id="pm-update-btn">Update</button>
      </div>
      <div id="pm-chip" class="pm-chip" style="display:none;">
        <img id="pm-chip-thumb" />
        <span id="pm-chip-text"></span>
        <a id="pm-chip-clear" href="#">clear</a>
      </div>
      <textarea class="pm-input" id="pm-instruction" rows="1" placeholder="Describe a change… (Cmd/Ctrl+Enter to send)"></textarea>
      <div id="pm-status" class="pm-status">idle</div>
      <div class="pm-row">
        <div class="pm-tools">
          <button class="pm-tool" id="pm-select">${ICONS.select} Select</button>
          <button class="pm-tool" id="pm-screenshot" title="Drag to highlight any area as a reference">${ICONS.areaShot} Screenshot</button>
          <button class="pm-tool" id="pm-undo" title="Undo">${ICONS.undo}</button>
          <button class="pm-tool" id="pm-redo" title="Redo">${ICONS.redo}</button>
          <button class="pm-tool" id="pm-export">${ICONS.exportIco} Export</button>
        </div>
        <button class="pm-send" id="pm-send" title="Send">
          <span class="pm-ar">${ICONS.arrowRight}</span><span class="pm-sp"></span>
        </button>
      </div>
    </div>
    <button class="pm-bubble" id="pm-restore" title="Restore Page Bender">${ICONS.bend}</button>
  `;
  document.documentElement.appendChild(toolbar);

  // A plain child of #pm-toolbar would have its "position:fixed" resolved
  // relative to #pm-toolbar's own box, not the viewport — #pm-toolbar has a
  // transform (translateX), and ANY transform on an ancestor creates a new
  // containing block for fixed descendants (CSS spec). Appended to
  // documentElement instead, same as hoverBox/quickEdit/editBadge below, so
  // viewport-relative positioning math actually means what it says.
  const exportMenu = document.createElement("div");
  exportMenu.id = "pm-export-menu";
  exportMenu.className = "pm-export-menu";
  exportMenu.innerHTML = `
    <button class="pm-export-opt" data-kind="diff">Diff Export</button>
    <button class="pm-export-opt" data-kind="html">HTML Export</button>
  `;
  document.documentElement.appendChild(exportMenu);

  const cardEl = toolbar.querySelector(".pm-card");
  const pillEl = toolbar.querySelector(".pm-pill");
  const bubbleEl = toolbar.querySelector(".pm-bubble");
  const scrimEl = toolbar.querySelector("#pm-scrim");
  const undoBtn = toolbar.querySelector("#pm-undo");
  const redoBtn = toolbar.querySelector("#pm-redo");
  const selectBtn = toolbar.querySelector("#pm-select");
  const screenshotBtn = toolbar.querySelector("#pm-screenshot");
  const exportBtn = toolbar.querySelector("#pm-export");
  const stopBtn = toolbar.querySelector("#pm-stop");
  const chipEl = toolbar.querySelector("#pm-chip");
  const chipTextEl = toolbar.querySelector("#pm-chip-text");
  const chipThumbEl = toolbar.querySelector("#pm-chip-thumb");
  const instrEl = toolbar.querySelector("#pm-instruction");
  const sendBtn = toolbar.querySelector("#pm-send");
  const statusEl = toolbar.querySelector("#pm-status");
  const pillDotEl = toolbar.querySelector("#pm-pill-dot");
  const updateBannerEl = toolbar.querySelector("#pm-update-banner");
  const updateTextEl = toolbar.querySelector("#pm-update-text");
  const updateBtn = toolbar.querySelector("#pm-update-btn");

  function setStatus(text) { statusEl.textContent = text; }

  // Polls the server's /version-check (it's the one piece that's always
  // running, via launchd, and has git access to actually know) rather than
  // comparing anything client-side. A miss (server briefly down, GitHub
  // unreachable) just leaves the last-known state alone — see
  // refreshVersionCache's comment in server.js for the same call on that end.
  async function checkForUpdate() {
    try {
      const data = await fetch("/version-check").then((r) => r.json());
      if (!data.updateAvailable) return;
      pillDotEl.style.display = "block";
      updateBannerEl.classList.add("pm-show");
      updateTextEl.textContent = data.latestMessage ? `Update available — ${data.latestMessage}` : "Update available";
    } catch {
      // server unreachable this round — next poll retries
    }
  }

  // Waits for the server to come back up after /update triggers its
  // git-pull-then-exit (launchd's KeepAlive relaunches it — see server.js);
  // there's no separate "restart" signal to wait on beyond the port
  // answering again.
  async function waitForServerRestart() {
    await new Promise((r) => setTimeout(r, 800));
    for (let i = 0; i < 30; i++) {
      try {
        const res = await fetch("/version-check");
        if (res.ok) return;
      } catch {
        // still down/restarting — keep polling
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
  }

  updateBtn.addEventListener("click", async () => {
    updateBtn.disabled = true;
    updateBtn.textContent = "Updating…";
    updateTextEl.textContent = "Pulling latest…";
    try {
      const resp = await fetch("/update", { method: "POST" }).then((r) => r.json());
      if (!resp.ok) throw new Error(resp.error || "update failed");
    } catch (err) {
      updateTextEl.textContent = `Update failed: ${err.message}`;
      updateBtn.disabled = false;
      updateBtn.textContent = "Retry";
      return;
    }
    updateTextEl.textContent = "Restarting…";
    await waitForServerRestart();
    location.reload();
  });

  // Shared by a manual send (sendPrompt) and the background capture-time
  // fidelity pass (startAgentPoll) — one visual "busy" state, one Stop
  // button, instead of two separate implementations of the same idea.
  function setThinking(on) {
    cardEl.classList.toggle("pm-thinking", on);
    stopBtn.style.display = on ? "inline-flex" : "none";
  }

  function cancelAgent() {
    stopBtn.disabled = true;
    fetch("/agent-cancel", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ slug }),
    }).catch((err) => console.warn("[page-bender] cancel failed:", err.message))
      .finally(() => { stopBtn.disabled = false; });
  }
  stopBtn.addEventListener("click", cancelAgent);

  // Escape stops the in-progress AI pass instead of doing nothing/leaking
  // to the host page — same action as the titlebar stop square, just from
  // the keyboard, so the user can bail out and start a new prompt without
  // reaching for the mouse. Only while actually thinking: an Escape typed
  // for any other reason (e.g. dismissing something unrelated on the page)
  // shouldn't cancel a request that isn't running.
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (!cardEl.classList.contains("pm-thinking")) return;
    e.preventDefault();
    cancelAgent();
  });

  function growInput() {
    instrEl.style.height = "auto";
    instrEl.style.height = Math.min(instrEl.scrollHeight, 140) + "px";
  }

  function openCard() {
    cardEl.classList.add("pm-open");
    pillEl.classList.add("pm-hidden");
    scrimEl.classList.add("pm-on");
    growInput();
    instrEl.focus();
  }
  function closeCard() {
    cardEl.classList.remove("pm-open");
    pillEl.classList.remove("pm-hidden");
    bubbleEl.classList.remove("pm-show");
    scrimEl.classList.remove("pm-on");
  }
  function minimizeCard() {
    cardEl.classList.remove("pm-open");
    scrimEl.classList.remove("pm-on");
    bubbleEl.classList.add("pm-show");
  }
  function restoreCard() {
    bubbleEl.classList.remove("pm-show");
    cardEl.classList.add("pm-open");
    scrimEl.classList.add("pm-on");
    growInput();
    instrEl.focus();
  }

  toolbar.querySelector("#pm-pill-open").addEventListener("click", openCard);
  toolbar.querySelector("#pm-minimize").addEventListener("click", minimizeCard);
  toolbar.querySelector("#pm-restore").addEventListener("click", restoreCard);
  instrEl.addEventListener("input", growInput);

  // Paste a reference image straight from the clipboard (e.g. a screenshot
  // copied from elsewhere) — feeds the SAME pendingImage slot the
  // Screenshot button already fills, so it rides the existing attach/send
  // pipeline unchanged; just a second way to fill it in.
  instrEl.addEventListener("paste", (e) => {
    const items = e.clipboardData && e.clipboardData.items;
    if (!items) return;
    for (const item of items) {
      if (!item.type.startsWith("image/")) continue;
      e.preventDefault();
      const file = item.getAsFile();
      const reader = new FileReader();
      reader.onload = () => {
        pendingImage = reader.result;
        updateSelectionChip();
        setStatus("image pasted — describe the change and send");
      };
      reader.readAsDataURL(file);
      return;
    }
  });

  // click-outside-to-close (§7.2). The scrim stays pointer-events:none, so
  // "outside" is detected with a plain document listener instead of a
  // blocking layer (that broke drag/select interactions in an earlier pass).
  document.addEventListener("click", (e) => {
    if (ignoreNextOutsideClick) { ignoreNextOutsideClick = false; return; } // the click synthesized right after a screenshot-drag mouseup
    if (!cardEl.classList.contains("pm-open")) return;
    if (selectMode) return; // don't close mid-select — that click is handled above
    if (cardEl.contains(e.target) || pillEl.contains(e.target) || bubbleEl.contains(e.target)) return;
    // don't close on the first half of a double-click-to-edit (§7.2 gotcha #2)
    if (e.target.nodeType === 1 && e.target.children.length === 0) return;
    closeCard();
  });

  selectBtn.addEventListener("click", () => setSelectMode(!selectMode));
  screenshotBtn.addEventListener("click", () => setScreenshotMode(!screenshotMode));
  toolbar.querySelector("#pm-chip-clear").addEventListener("click", (e) => {
    e.preventDefault();
    selection = null;
    pendingImage = null;
    updateSelectionChip();
    hideQuickEdit();
    hideStyleTrigger();
  });
  undoBtn.addEventListener("click", () => { if (pointer > 0) applyHistoryIndex(--pointer); });
  redoBtn.addEventListener("click", () => { if (pointer < history.length - 1) applyHistoryIndex(++pointer); });

  async function sendPrompt() {
    const instruction = instrEl.value.trim();
    if (!instruction) return;
    sendBtn.disabled = true;
    sendBtn.classList.add("pm-loading");
    setThinking(true);
    const t0 = Date.now();
    setStatus("editing… 0s");
    const ticker = setInterval(() => setStatus(`editing… ${Math.round((Date.now() - t0) / 1000)}s`), 1000);
    let resp;
    try {
      resp = await fetch("/prompt", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          slug, instruction,
          selection: selection ? selection.descriptor : "",
          images: pendingImage ? [pendingImage] : [],
          resumeSessionId: sessionId,
        }),
      }).then((r) => r.json());
    } catch (err) {
      resp = { error: err.message };
    }
    clearInterval(ticker);
    sendBtn.disabled = false;
    sendBtn.classList.remove("pm-loading");
    setThinking(false);
    if (!resp) { setStatus("error: no response"); return; }
    // Apply whatever html came back FIRST, regardless of error/cancelled —
    // the server now always returns the current file state, even on a
    // maxTurns failure, so partial progress (real edits that landed before
    // it ran out of room) is never silently stranded on disk.
    if (resp.html) {
      sessionId = resp.sessionId || sessionId;
      const doc = new DOMParser().parseFromString(resp.html, "text/html");
      document.body.innerHTML = doc.body.innerHTML;
      pushHistory(document.body.innerHTML, { persist: false }); // agent already wrote the file
      instrEl.value = "";
      selection = null;
      pendingImage = null;
      updateSelectionChip();
      hideQuickEdit();
      hideStyleTrigger();
    }
    if (resp.cancelled) setStatus("stopped — edits made so far are kept");
    else if (resp.error) setStatus(resp.html ? `hit an error, kept partial edits: ${resp.error}` : `error: ${resp.error}`);
    else setStatus("done ✓");
  }
  sendBtn.addEventListener("click", sendPrompt);
  instrEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) sendPrompt();
  });

  // ---------- export menu (Diff Export / HTML Export) ----------

  function positionExportMenu() {
    const r = exportBtn.getBoundingClientRect();
    exportMenu.style.left = `${Math.max(8, r.left)}px`;
    exportMenu.style.top = `${r.top - 8}px`;
    exportMenu.style.transform = "translateY(-100%)";
  }
  function toggleExportMenu(on) {
    if (on) positionExportMenu();
    exportMenu.classList.toggle("pm-open", on);
  }
  exportBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    toggleExportMenu(!exportMenu.classList.contains("pm-open"));
  });
  document.addEventListener("click", (e) => {
    if (!exportMenu.classList.contains("pm-open")) return;
    if (exportMenu.contains(e.target) || exportBtn.contains(e.target)) return;
    toggleExportMenu(false);
  });

  async function doDiffExport() {
    setStatus("building diff…");
    const resp = await fetch("/diff", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ slug }),
    }).then((r) => r.json()).catch((err) => ({ error: err.message }));
    if (!resp || resp.error) { setStatus(`diff failed: ${resp && resp.error}`); return; }
    const blob = new Blob([resp.markdown], { type: "text/markdown" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${resp.filename || slug}-changes.md`;
    a.click();
    setStatus("diff downloaded");
  }
  function doHtmlExport() {
    // Straight to the server's raw file (never toolbar-injected — see
    // handleExportHtml/injectToolbar in server.js) via a forced-download
    // response header, no client-side fetch/blob juggling needed.
    const a = document.createElement("a");
    a.href = `/export-html?slug=${encodeURIComponent(slug)}`;
    a.click();
    setStatus("html downloaded");
  }
  exportMenu.querySelectorAll(".pm-export-opt").forEach((btn) => {
    btn.addEventListener("click", () => {
      toggleExportMenu(false);
      if (btn.dataset.kind === "diff") doDiffExport();
      else doHtmlExport();
    });
  });

  // ---------- background pass polling (the capture-time fidelity pass runs
  // detached server-side now — see PLAN.md — so THIS page, not the
  // extension, is what waits for it and reflects progress) ----------

  const TOAST_KEY = `pm-toast-${slug}`;

  function startAgentPoll() {
    openCard();
    setThinking(true);
    const t0 = Date.now();
    setStatus("enhancing fidelity against a screenshot… 0s");
    const poll = setInterval(async () => {
      let data;
      try {
        data = await fetch(`/agent-status?slug=${encodeURIComponent(slug)}`).then((r) => r.json());
      } catch {
        return; // transient network hiccup — just try again next tick
      }
      if (!data || data.status === "running") {
        setStatus(`enhancing fidelity against a screenshot… ${Math.round((Date.now() - t0) / 1000)}s`);
        return;
      }
      clearInterval(poll);
      const toast = data.status === "cancelled" ? "stopped — edits made so far are kept"
        : data.status === "failed" ? "fidelity pass failed — check server.log"
        : "fidelity pass complete";
      sessionStorage.setItem(TOAST_KEY, toast);
      location.reload(); // simplest way to resync the DOM with whatever runFidelityPass wrote to disk
    }, 2000);
  }

  loadHistory();
  updateUndoRedoButtons();
  updateSelectionChip();
  checkForUpdate();
  setInterval(checkForUpdate, 15 * 60 * 1000);
  if (window.__PM_AGENT_PENDING) {
    startAgentPoll();
  } else {
    const toast = sessionStorage.getItem(TOAST_KEY);
    if (toast) {
      sessionStorage.removeItem(TOAST_KEY);
      openCard();
      setStatus(toast);
    }
  }

  const qeStyle = document.createElement("style");
  qeStyle.textContent = `
    /* ---- minimized trigger bubble: parked at the selected element's
       corner instead of the panel opening automatically (§ quick-edit,
       matches the mini-bubble language in DESIGN-SYSTEM.md §5.5) ---- */
    #pm-qe-trigger { all: initial; position: fixed; z-index: ${Z}; display: none;
      width: 28px; height: 28px; border-radius: 50%; border: none; cursor: pointer;
      align-items: center; justify-content: center;
      background: linear-gradient(135deg, #ff6ec7, #ff2d78); color: #1c0f18;
      box-shadow: 0 8px 22px rgba(255,45,120,.5); }
    #pm-qe-trigger.pm-show { display: flex; animation: pm-qe-pop .14s ease; }
    #pm-qe-trigger svg { position: relative; }
    #pm-qe-trigger .pm-qe-trigger-halo {
      position: absolute; inset: -6px; border-radius: 50%; z-index: -1;
      border: 1.5px solid rgba(255,110,199,.5);
      animation: pm-qe-breathe 2.6s ease-in-out infinite;
    }
    @keyframes pm-qe-pop { from { opacity: 0; transform: scale(.5); } to { opacity: 1; transform: scale(1); } }
    @keyframes pm-qe-breathe { 0%, 100% { opacity: .5; transform: scale(1); } 50% { opacity: 1; transform: scale(1.12); } }

    /* ---- full panel ---- */
    #pm-quickedit { all: initial; position: fixed; z-index: ${Z}; display: none;
      font-family: 'Plus Jakarta Sans', -apple-system, system-ui, sans-serif;
      background: linear-gradient(180deg, #18121d, #100c14); border: 1px solid #2d2436;
      border-radius: 16px; padding: 14px; width: 272px; box-shadow: 0 20px 50px rgba(0,0,0,.55);
      color: #f4eef7; }
    #pm-quickedit.pm-open { display: flex; flex-direction: column; animation: pm-qe-fade .14s ease; }
    @keyframes pm-qe-fade { from { opacity: 0; } to { opacity: 1; } }
    #pm-quickedit * { box-sizing: border-box; font-family: inherit; }

    #pm-quickedit .pm-qe-head { display: flex; align-items: center; gap: 8px; margin-bottom: 12px; }
    #pm-quickedit .pm-qe-tag { font-size: 11px; color: #ff9fd1; background: rgba(255,61,146,.1);
      border: 1px solid rgba(255,61,146,.25); border-radius: 6px; padding: 3px 7px; flex: 1;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
    #pm-quickedit .pm-qe-headBtns { display: flex; gap: 4px; flex: none; }
    #pm-quickedit .pm-qe-min, #pm-quickedit .pm-qe-close {
      width: 22px; height: 22px; border-radius: 7px; border: 1px solid #2d2436;
      background: rgba(255,255,255,.03); color: #d3c2d6; cursor: pointer;
      display: flex; align-items: center; justify-content: center; padding: 0; }
    #pm-quickedit .pm-qe-min:hover, #pm-quickedit .pm-qe-close:hover { background: rgba(255,61,146,.14); color: #ff9fd1; }

    #pm-quickedit .pm-qe-row { display: flex; align-items: center; gap: 8px; margin-bottom: 10px; }
    #pm-quickedit .pm-qe-label { font-size: 11px; color: #776b81; width: 34px; flex: none; }
    #pm-quickedit .pm-qe-swatches { display: flex; align-items: center; gap: 5px; flex-wrap: wrap; flex: 1; }
    #pm-quickedit .pm-qe-swatch { width: 20px; height: 20px; border-radius: 6px;
      border: 1px solid rgba(255,255,255,.15); cursor: pointer; padding: 0;
      transition: transform .1s ease, border-color .1s ease; }
    #pm-quickedit .pm-qe-swatch:hover { transform: scale(1.12); }
    #pm-quickedit .pm-qe-swatch.pm-qe-active { border: 2px solid #ff3d92; box-shadow: 0 0 0 1px rgba(255,61,146,.35); }
    #pm-quickedit .pm-qe-add { width: 20px; height: 20px; border-radius: 6px; flex: none;
      border: 1px dashed #3a2f42; background: none; color: #776b81; cursor: pointer;
      display: flex; align-items: center; justify-content: center; padding: 0; }
    #pm-quickedit .pm-qe-add:hover { border-color: #ff3d92; color: #ff9fd1; }
    #pm-quickedit .pm-qe-custom { position: absolute; width: 1px; height: 1px; opacity: 0; pointer-events: none; }

    #pm-quickedit .pm-qe-radius-presets { display: flex; gap: 2px; background: rgba(255,255,255,.03);
      border: 1px solid #2d2436; border-radius: 999px; padding: 2px; flex: 1; }
    #pm-quickedit .pm-qe-radius-presets button { flex: 1; background: none; border: none; color: #776b81;
      border-radius: 999px; height: 24px; cursor: pointer; display: flex; align-items: center; justify-content: center; padding: 0; }
    #pm-quickedit .pm-qe-radius-presets button:hover { color: #f4eef7; }
    #pm-quickedit .pm-qe-radius-presets button.pm-on {
      background: linear-gradient(135deg, #ff3d92, #ff2d78); color: #1c0f18; }
    #pm-quickedit .pm-qe-radius-fine { margin-bottom: 2px; }
    #pm-quickedit .pm-qe-radius-slider { flex: 1; appearance: none; -webkit-appearance: none;
      height: 3px; border-radius: 999px; background: #2d2436; outline: none; cursor: pointer; }
    #pm-quickedit .pm-qe-radius-slider::-webkit-slider-thumb { -webkit-appearance: none;
      width: 13px; height: 13px; border-radius: 50%; background: #ff3d92; cursor: pointer;
      box-shadow: 0 0 0 3px rgba(255,61,146,.2); }
    #pm-quickedit .pm-qe-radius-slider::-moz-range-thumb { width: 13px; height: 13px; border: none;
      border-radius: 50%; background: #ff3d92; cursor: pointer; box-shadow: 0 0 0 3px rgba(255,61,146,.2); }
    #pm-quickedit .pm-qe-radius-value { font-size: 11px; color: #776b81; flex: none;
      display: flex; align-items: center; gap: 2px; }
    #pm-quickedit .pm-qe-radius-input { all: unset; width: 26px; text-align: right; color: #d3c2d6;
      font-size: 11px; font-family: inherit; background: rgba(255,255,255,.03); border: 1px solid #2d2436;
      border-radius: 5px; padding: 2px 3px; }
    #pm-quickedit .pm-qe-radius-input:focus { border-color: #ff3d92; color: #f4eef7; }
    #pm-quickedit .pm-qe-radius-input::-webkit-inner-spin-button { appearance: none; margin: 0; }

    /* text-edit affordance (§5.10) — applied to host-page elements, so
       literal hex values are used instead of #pm-toolbar-scoped vars. */
    .pm-editable-active {
      outline: 2px dashed #ff3d92; outline-offset: 3px; border-radius: 4px;
      background: rgba(255,61,146,.06); cursor: text;
    }
    .pm-edit-badge {
      position: fixed; z-index: ${Z}; pointer-events: none;
      display: flex; align-items: center; gap: 4px; padding: 3px 8px; border-radius: 6px;
      font-size: 11px; font-family: 'Plus Jakarta Sans', -apple-system, system-ui, sans-serif;
      background: #18121d; color: #ff9fd1;
    }
    @keyframes pm-saved-flash {
      0%   { box-shadow: 0 0 0 0 rgba(255,61,146,.55); }
      100% { box-shadow: 0 0 0 8px rgba(255,61,146,0); }
    }
    .pm-saved-flash { animation: pm-saved-flash .5s ease-out; border-radius: 4px; }
  `;
  document.head.appendChild(qeStyle);
})();
