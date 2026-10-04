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
  const LAST_RUN_KEY = `pm-lastrun-${slug}`;
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
  let selectedEls = []; // ordered list of selected elements — multi-select via shift/cmd-click
  let anchorEl = null; // last plain- or cmd/ctrl-clicked element; shift-click ranges from here
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
    try {
      localStorage.setItem(HISTORY_KEY, JSON.stringify({ history, pointer }));
    } catch (err) {
      // A large capture can blow the localStorage quota. Undo/redo history is
      // a convenience; losing it must never throw out of pushHistory and skip
      // the saveToDisk call below it — that path is how an edit ends up on
      // screen but never in working.html.
      console.warn("[page-bender] history not persisted:", err.name);
    }
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

  // Saves used to be fire-and-forget, and that is exactly how an edit went
  // missing: an interrupted or rejected request left the change on screen and
  // in history but never in working.html, so Export — which downloads the file
  // — handed back the original text with nothing reporting a problem. Track
  // the in-flight save so Export can wait on it, and surface failures.
  let pendingSave = null;
  function saveToDisk(bodyHtml) {
    const p = fetch("/save", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ slug, bodyHtml }),
    })
      .then(async (r) => {
        if (r.ok) return true;
        let detail = `HTTP ${r.status}`;
        try { const j = await r.json(); if (j && j.error) detail = j.error; } catch {}
        throw new Error(detail);
      })
      .catch((err) => {
        console.warn("[page-bender] save failed:", err.message);
        setStatus(`save failed — ${err.message}`);
        return false;
      });
    pendingSave = p;
    return p;
  }

  // Everything currently on screen, written and confirmed on disk. Export
  // calls this first so a download can never be a stale file.
  async function flushSave() {
    if (editingEl) editingEl.blur(); // commit an in-progress inline edit first
    if (pendingSave) await pendingSave.catch(() => false);
    return saveToDisk(document.body.innerHTML);
  }

  // The page is reloaded whenever an agent writes working.html directly (a
  // /prompt run, the capture-time fidelity pass), but history lives in
  // localStorage — so after such a reload the newest history entry is the
  // PRE-agent state while the DOM shows the post-agent one. Left alone, Redo
  // is disabled (pointer is already at the end) so the on-screen state can
  // never be returned to, and one Undo click applies an older snapshot AND
  // writes it to disk, destroying the agent's work. Seeding the current DOM
  // as the newest entry makes Undo step back from it and Redo return to it.
  function reconcileHistoryWithDom() {
    const current = document.body.innerHTML;
    // handleSave strips trailing whitespace before writing, so compare the
    // same way or every reload would log a spurious "changed" entry.
    const norm = (t) => String(t).replace(/\s+$/, "");
    if (!history.length) { history = [current]; pointer = 0; saveHistoryLocal(); return; }
    if (norm(history[pointer]) === norm(current)) return;
    history = history.slice(0, pointer + 1);
    history.push(current);
    if (history.length > HISTORY_CAP) history.shift();
    pointer = history.length - 1;
    saveHistoryLocal();
  }

  // Status resets to "idle" on every load, so coming back to the tab gave no
  // sign whether the last run finished. Remember the outcome and replay it.
  function rememberLastRun(text) {
    try { localStorage.setItem(LAST_RUN_KEY, JSON.stringify({ text, at: Date.now() })); } catch {}
  }
  function restoreLastRunStatus() {
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem(LAST_RUN_KEY) || "null"); } catch {}
    if (!saved || !saved.text) return;
    const mins = Math.round((Date.now() - saved.at) / 60000);
    const ago = mins < 1 ? "just now" : mins < 60 ? `${mins}m ago` : `${Math.round(mins / 60)}h ago`;
    setStatus(`Last run: ${saved.text} · ${ago}`);
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

  // The agent used to get only describeElement()'s short text summary and
  // had to relocate the real node itself — on a large single-file capture
  // (hundreds of KB) that meant Bash/grep round-trips just to find what the
  // user already had selected. Sending the real markup lets it match the
  // node directly. Capped well above any real button/card/row (a couple KB)
  // but short of "the user fat-fingered a huge section" turning into a
  // second copy of half the page riding along in the prompt.
  const MAX_SELECTION_HTML = 6000;
  function selectionHtml(el) {
    const html = el.outerHTML || "";
    return html.length > MAX_SELECTION_HTML
      ? `${html.slice(0, MAX_SELECTION_HTML)}\n<!-- truncated: selection was ${html.length} chars, over the ${MAX_SELECTION_HTML} cap -->`
      : html;
  }

  function selectionDescriptor() {
    if (!selectedEls.length) return "";
    if (selectedEls.length === 1) return describeElement(selectedEls[0]);
    return `${selectedEls.length} elements selected`;
  }

  // Bounding box of the whole selection, used to park the action cluster —
  // not just the last-clicked element, so it doesn't jump around oddly
  // relative to a multi-element pick scattered across a table.
  function selectionUnionRect() {
    const rects = selectedEls.map((el) => el.getBoundingClientRect());
    return {
      left: Math.min(...rects.map((r) => r.left)),
      top: Math.min(...rects.map((r) => r.top)),
      right: Math.max(...rects.map((r) => r.right)),
      bottom: Math.max(...rects.map((r) => r.bottom)),
    };
  }

  // Excel-style Shift-click range: from the anchor (last plain/cmd-click) to
  // whatever's clicked now. Table cells get a real 2D block — every cell in
  // the row/column rectangle between the two corners, matching how Excel
  // extends a range across a grid (this is what makes "select a whole
  // column across several rows" a two-click gesture instead of one click
  // per cell). Anything else falls back to the contiguous run of siblings
  // between the two, or just the two endpoints if they don't share a parent.
  function computeRange(a, b) {
    const cellA = a.closest("td, th");
    const cellB = b.closest("td, th");
    if (cellA && cellB) {
      const tableA = cellA.closest("table");
      if (tableA && tableA === cellB.closest("table")) {
        const rows = [...tableA.rows];
        const rowOf = (cell) => rows.indexOf(cell.closest("tr"));
        const colOf = (cell) => [...cell.closest("tr").cells].indexOf(cell);
        const r1 = rowOf(cellA), r2 = rowOf(cellB);
        const c1 = colOf(cellA), c2 = colOf(cellB);
        const [rMin, rMax] = [Math.min(r1, r2), Math.max(r1, r2)];
        const [cMin, cMax] = [Math.min(c1, c2), Math.max(c1, c2)];
        const out = [];
        for (let ri = rMin; ri <= rMax; ri++) {
          const cells = [...rows[ri].cells];
          for (let ci = cMin; ci <= cMax && ci < cells.length; ci++) out.push(cells[ci]);
        }
        return out;
      }
    }
    if (a.parentElement && a.parentElement === b.parentElement) {
      const siblings = [...a.parentElement.children];
      const i1 = siblings.indexOf(a), i2 = siblings.indexOf(b);
      const [lo, hi] = [Math.min(i1, i2), Math.max(i1, i2)];
      return siblings.slice(lo, hi + 1);
    }
    return a === b ? [a] : [a, b];
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

  // Turning Select off used to hide only the hover preview, leaving the
  // persistent outline boxes and the chip on screen until some unrelated
  // action happened to clear them. Kept separate from setSelectMode so that
  // screenshot mode preempting select (setScreenshotMode) does NOT discard a
  // selection the user is still building.
  function exitSelectMode() {
    setSelectMode(false);
    clearSelection();
  }

  function updateSelectionChip() {
    if (selectedEls.length || pendingImage) {
      chipEl.style.display = "flex";
      chipEl.classList.toggle("pm-image", !!pendingImage);
      chipTextEl.textContent = pendingImage ? "Screenshot attached" : selectionDescriptor();
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
      const el = e.target;
      hideQuickEdit();
      // Excel-style selection: plain click sets the anchor and picks just
      // that element; Shift-click extends the range from the anchor to
      // here (table cells become a row/column block — see computeRange);
      // Cmd/Ctrl-click toggles one element in or out without disturbing
      // the rest, and becomes the new anchor for the next Shift-click.
      // Select mode stays on across all of these — it only turns off via
      // the Select button or Escape — so a Shift-click after the anchor
      // click still lands here instead of hitting the real page.
      if (e.shiftKey && anchorEl) {
        selectedEls = computeRange(anchorEl, el);
      } else if (e.metaKey || e.ctrlKey) {
        const idx = selectedEls.indexOf(el);
        if (idx === -1) selectedEls.push(el); else selectedEls.splice(idx, 1);
        anchorEl = el;
      } else {
        selectedEls = [el];
        anchorEl = el;
      }
      pendingImage = null;
      updateSelectionChip();
      updateActionCluster();
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
    palette: svgIcon('<circle cx="13.5" cy="6.5" r="1.5"/><circle cx="17.5" cy="10.5" r="1.5"/><circle cx="8.5" cy="7.5" r="1.5"/><circle cx="6.5" cy="12.5" r="1.5"/><path d="M12 2a10 10 0 0 0 0 20c.9 0 1.6-.7 1.6-1.6 0-.4-.2-.8-.4-1.1-.3-.3-.4-.7-.4-1.1 0-.9.7-1.6 1.6-1.6H16a6 6 0 0 0 6-6c0-4.9-4.5-8.6-10-8.6z"/>'),
    screens: svgIcon('<rect x="3" y="4" width="13" height="10" rx="1.5"/><path d="M8 18h11a2 2 0 0 0 2-2V8"/>'),
    plus: svgIcon('<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>', 11),
    trash: svgIcon('<path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/>', 13),
    duplicate: svgIcon('<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>', 13),
    // "row" duplicate — an existing bar with a plus beneath it, reading as
    // "add another one of these below" regardless of whether the thing
    // clicked actually stacks vertically on its own (see findRowDuplicateTarget).
    addRow: svgIcon('<rect x="3" y="4" width="18" height="6" rx="1"/><line x1="12" y1="15" x2="12" y2="21"/><line x1="9" y1="18" x2="15" y2="18"/>', 13),
    radius0: radiusIcon(0),
    radius4: radiusIcon(3),
    radius8: radiusIcon(6),
    radiusFull: radiusIcon(7.5),
  };

  // ---------- selection overlay: outline boxes + action cluster (style /
  // duplicate / delete) ----------
  //
  // Selection is shown with floating overlay boxes (like hoverBox/dragBox
  // above), never a class or attribute on the page's own elements — several
  // call sites elsewhere in this file do pushHistory(document.body.innerHTML)
  // to persist state, and anything stamped onto real content would leak
  // into the saved mock permanently.

  const selectionBoxPool = [];
  function getSelectionBox(i) {
    if (selectionBoxPool[i]) return selectionBoxPool[i];
    const box = document.createElement("div");
    box.className = "pm-sel-box";
    document.documentElement.appendChild(box);
    selectionBoxPool[i] = box;
    return box;
  }
  function renderSelectionBoxes() {
    selectionBoxPool.forEach((box) => (box.style.display = "none"));
    selectedEls.forEach((el, i) => {
      const box = getSelectionBox(i);
      const r = el.getBoundingClientRect();
      box.style.display = "block";
      box.style.left = `${r.left}px`;
      box.style.top = `${r.top}px`;
      box.style.width = `${r.width}px`;
      box.style.height = `${r.height}px`;
    });
  }
  // Selection boxes are computed from live getBoundingClientRect() at render
  // time — a scroll or resize without a re-render would leave them stale.
  window.addEventListener("scroll", () => { if (selectedEls.length) renderSelectionBoxes(); }, true);
  window.addEventListener("resize", () => { if (selectedEls.length) renderSelectionBoxes(); });

  function deleteSelection() {
    if (!selectedEls.length) return;
    selectedEls.forEach((el) => el.remove());
    clearSelection();
    pushHistory(document.body.innerHTML, { persist: true });
  }

  // Shared by both duplicate actions: clone each resolved target and drop it
  // right after the original — for scattered picks (e.g. several <tr> across
  // a table) that duplicates each in place rather than bunching all copies
  // together. The new copies become the active selection, so a follow-up
  // edit targets them.
  function duplicateElements(resolveTarget) {
    if (!selectedEls.length) return;
    const targets = [];
    selectedEls.forEach((el) => {
      const target = resolveTarget ? resolveTarget(el) : el;
      if (!targets.includes(target)) targets.push(target); // dedupe: e.g. two cells picked from the same row resolve to one row
    });
    selectedEls = targets.map((el) => {
      const clone = el.cloneNode(true);
      el.after(clone);
      return clone;
    });
    anchorEl = selectedEls[0] || null; // the originals are gone as selection targets — anchor to a clone instead
    updateSelectionChip();
    updateActionCluster();
    pushHistory(document.body.innerHTML, { persist: true });
  }

  function duplicateSelection() {
    duplicateElements();
  }

  function isHorizontalContainer(el) {
    const cs = getComputedStyle(el);
    if (cs.display === "table-row") return true; // a <tr>'s <td>/<th> children always lay out side by side
    if ((cs.display === "flex" || cs.display === "inline-flex") && !cs.flexDirection.startsWith("column")) return true;
    if (cs.display === "grid" || cs.display === "inline-grid") {
      const cols = cs.gridTemplateColumns.trim().split(/\s+/).filter(Boolean);
      if (cols.length > 1) return true;
    }
    return false;
  }

  // Plain duplicateSelection() inserts the clone as the very next DOM
  // sibling — whether that lands below or beside the original depends
  // entirely on how the parent lays things out. For a <tr> (parent stacks
  // rows vertically) that's already "down"; for a <td> (parent is the
  // horizontal <tr>) or a card in a horizontal flex/grid row, it lands
  // beside it instead. This climbs up from the clicked element past any
  // ancestor whose OWN parent lays out children horizontally, stopping at
  // the first level that stacks vertically — so "duplicate as a new row"
  // reads the same way it already does for a selected <tr>, regardless of
  // whether what got clicked was the row itself or one cell/card inside it.
  function findRowDuplicateTarget(el) {
    const tr = el.closest("tr");
    if (tr) return tr;
    let node = el;
    while (node.parentElement && node.parentElement !== document.body) {
      if (!isHorizontalContainer(node.parentElement)) return node;
      node = node.parentElement;
    }
    return node;
  }

  function duplicateSelectionAsRow() {
    duplicateElements(findRowDuplicateTarget);
  }

  // Opens collapsed by default (a small cluster parked at the selection's
  // corner, matching the mini-bubble language in DESIGN-SYSTEM.md §5.5)
  // rather than popping the full style panel open immediately on every
  // selection. Style only applies to a single element (color/radius on a
  // heterogeneous multi-selection doesn't make sense); Duplicate/Delete
  // apply to the whole selection.

  const clusterStyleBtn = document.createElement("button");
  clusterStyleBtn.className = "pm-qe-style";
  clusterStyleBtn.title = "Style this element";
  clusterStyleBtn.innerHTML = ICONS.sliders;
  const clusterDuplicateBtn = document.createElement("button");
  clusterDuplicateBtn.className = "pm-qe-duplicate";
  clusterDuplicateBtn.title = "Duplicate in place";
  clusterDuplicateBtn.innerHTML = ICONS.duplicate;
  const clusterDuplicateRowBtn = document.createElement("button");
  clusterDuplicateRowBtn.className = "pm-qe-duplicate-row";
  clusterDuplicateRowBtn.title = "Duplicate as a new row below";
  clusterDuplicateRowBtn.innerHTML = ICONS.addRow;
  const clusterDeleteBtn = document.createElement("button");
  clusterDeleteBtn.className = "pm-qe-delete";
  clusterDeleteBtn.title = "Delete selection";
  clusterDeleteBtn.innerHTML = ICONS.trash;

  const styleTrigger = document.createElement("div");
  styleTrigger.id = "pm-qe-trigger";
  styleTrigger.append(clusterStyleBtn, clusterDuplicateBtn, clusterDuplicateRowBtn, clusterDeleteBtn);
  document.documentElement.appendChild(styleTrigger);

  const quickEdit = document.createElement("div");
  quickEdit.id = "pm-quickedit";
  document.documentElement.appendChild(quickEdit);

  let qeTargetEl = null;

  clusterStyleBtn.addEventListener("click", () => {
    if (!qeTargetEl) return;
    styleTrigger.classList.remove("pm-show");
    showQuickEdit(qeTargetEl);
  });
  clusterDuplicateBtn.addEventListener("click", duplicateSelection);
  clusterDuplicateRowBtn.addEventListener("click", duplicateSelectionAsRow);
  clusterDeleteBtn.addEventListener("click", deleteSelection);

  // Delete/Backspace and Cmd/Ctrl+D act on the current selection — skipped
  // while typing in the prompt box or mid text-edit, so they don't hijack
  // normal editing keystrokes. Cmd/Ctrl+Shift+D is the row-aware duplicate
  // (same one as the addRow cluster button).
  document.addEventListener("keydown", (e) => {
    if (!selectedEls.length || editingEl || document.activeElement === instrEl) return;
    if (e.key === "Delete" || e.key === "Backspace") {
      e.preventDefault();
      deleteSelection();
    } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "d") {
      e.preventDefault();
      if (e.shiftKey) duplicateSelectionAsRow();
      else duplicateSelection();
    }
  });

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

  function updateActionCluster() {
    renderSelectionBoxes();
    if (!selectedEls.length) { hideActionCluster(); return; }
    qeTargetEl = selectedEls.length === 1 ? selectedEls[0] : null;
    clusterStyleBtn.style.display = selectedEls.length === 1 ? "flex" : "none";
    quickEdit.classList.remove("pm-open");
    const r = selectionUnionRect();
    const clusterWidth = selectedEls.length === 1 ? 126 : 96; // 3-4 buttons + gaps + padding
    styleTrigger.style.left = `${Math.min(r.right - 14, window.innerWidth - clusterWidth)}px`;
    styleTrigger.style.top = `${Math.max(4, r.top - 14)}px`;
    styleTrigger.classList.add("pm-show");
  }

  function hideActionCluster() {
    styleTrigger.classList.remove("pm-show");
    qeTargetEl = null;
  }

  // Single reset path for every "deselect everything" call site (chip-clear,
  // post-send) — folding renderSelectionBoxes() in here is what deleteSelection
  // was missing, leaving stale outline boxes on screen for removed elements.
  function clearSelection() {
    selectedEls = [];
    anchorEl = null;
    updateSelectionChip();
    renderSelectionBoxes();
    hideQuickEdit();
    hideActionCluster();
  }

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
      updateActionCluster();
    });
    quickEdit.querySelector(".pm-qe-close").addEventListener("click", () => {
      hideQuickEdit();
      hideActionCluster();
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
      .pm-titlebar { display: flex; align-items: center; gap: 6px; margin: 0 0 14px; padding-right: 120px; }
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
      .pm-export-top { position: absolute; top: 14px; right: 50px; height: 26px; padding: 0 10px; border-radius: 8px;
        display: flex; align-items: center; gap: 5px; cursor: pointer; font: 500 11px 'Plus Jakarta Sans', sans-serif;
        border: 1px solid var(--pm-border); background: rgba(255,255,255,.02); color: var(--pm-text-dim); }
      .pm-export-top:hover { background: rgba(255,61,146,.14); color: var(--pm-status); border-color: rgba(255,61,146,.3); }
      /* Stop takes this spot while a run is going. */
      .pm-card.pm-thinking .pm-export-top { display: none; }
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

      /* !important throughout: this <style> is injected straight into the
         captured page's own DOM (no Shadow DOM/iframe isolation), and that
         page's REAL stylesheet is preserved verbatim — a captured site's own
         global textarea/form reset can otherwise out-cascade a plain class
         selector here and repaint this field with the host page's own
         background/border instead of ours. */
      /* -webkit-appearance/appearance: none opts the textarea out of native
         form-control rendering entirely — without it, Chromium can still
         draw its own default focus ring (a rounded highlight-color frame)
         on top of an author "outline: none", since that ring belongs to the
         native control chrome, not the CSS outline property. */
      .pm-input { width: 100%; background: transparent !important; border: none !important; outline: none !important;
        appearance: none !important; -webkit-appearance: none !important; box-shadow: none !important;
        resize: none; max-height: 140px; color: #ffffff !important;
        font: 400 15px/1.5 'Plus Jakarta Sans', -apple-system, system-ui, sans-serif;
        padding: 2px 2px 12px; }
      .pm-input:focus, .pm-input:focus-visible { outline: none !important; box-shadow: none !important; border: none !important; }
      .pm-input::placeholder { color: var(--pm-text-mute); }
      .pm-status { font-size: 12px; color: var(--pm-text-mute); min-height: 15px; margin-bottom: 10px; line-height: 1.4; transition: color .15s ease; }
      .pm-card.pm-thinking .pm-status { color: var(--pm-status); }
      .pm-card.pm-thinking .pm-input { pointer-events: none; animation: pm-input-pulse 1.6s ease-in-out infinite; }
      .pm-card.pm-thinking.pm-typeable .pm-input { pointer-events: auto; animation: none; }
      @keyframes pm-input-pulse { 0%, 100% { opacity: .35; } 50% { opacity: .65; } }
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

      .pm-dl { display: none; position: fixed; z-index: ${Z}; top: 16px; right: 16px; width: min(360px, calc(100vw - 32px));
        max-height: calc(100vh - 32px); overflow-y: auto; box-sizing: border-box;
        font-family: 'Plus Jakarta Sans', -apple-system, system-ui, sans-serif; color: #d3c2d6;
        background: linear-gradient(180deg, #18121d, #100c14); border: 1px solid #2d2436; border-radius: 18px;
        padding: 18px 18px 14px; box-shadow: 0 30px 80px rgba(0,0,0,.6); }
      .pm-dl.pm-open { display: block; animation: pm-dl-in .35s ease-out; }
      @keyframes pm-dl-in { from { opacity: 0; transform: translateY(-6px); } to { opacity: 1; transform: none; } }
      .pm-dl h3 { margin: 0 0 2px; font-size: 15px; color: #f4eef7; font-weight: 600; }
      .pm-dl .pm-dl-sub { font-size: 11.5px; color: #8a7d93; margin: 0 0 12px; }
      .pm-dl .pm-dl-close { all: unset; position: absolute; top: 14px; right: 14px; cursor: pointer; color: #8a7d93; font-size: 16px; line-height: 1; padding: 4px; }
      .pm-dl .pm-dl-close:hover { color: #ff9fd1; }
      .pm-dl h4 { margin: 14px 0 6px; font-size: 10.5px; letter-spacing: .08em; text-transform: uppercase; color: #8a7d93; font-weight: 600; }
      .pm-dl .pm-dl-chips { display: flex; flex-wrap: wrap; gap: 6px; }
      .pm-dl .pm-dl-chip { font-size: 12px; padding: 4px 10px; border-radius: 999px; border: 1px solid rgba(255,110,199,.35); color: #f4eef7; background: rgba(255,110,199,.08); }
      .pm-dl .pm-dl-chip.pm-dim { border-color: #2d2436; background: transparent; color: #d3c2d6; }
      .pm-dl .pm-dl-swatches { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; }
      .pm-dl .pm-dl-sw { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
      .pm-dl .pm-dl-sw span:first-child { height: 30px; border-radius: 8px; border: 1px solid rgba(255,255,255,.12); }
      .pm-dl .pm-dl-sw span:last-child { font: 10px ui-monospace, Menlo, monospace; color: #8a7d93; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .pm-dl .pm-dl-type { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; padding: 3px 0; border-bottom: 1px solid rgba(45,36,54,.6); }
      .pm-dl .pm-dl-type span:first-child { color: #f4eef7; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .pm-dl .pm-dl-type span:last-child { font: 10.5px ui-monospace, Menlo, monospace; color: #8a7d93; white-space: nowrap; }
      .pm-dl .pm-dl-shapes { display: flex; flex-wrap: wrap; gap: 10px; }
      .pm-dl .pm-dl-shape { width: 46px; height: 34px; background: #2d2436; border: 1px solid #4a3b58; display: flex; align-items: flex-end; justify-content: center; }
      .pm-dl .pm-dl-shape span { font: 9.5px ui-monospace, Menlo, monospace; color: #d3c2d6; margin-bottom: -16px; }
      .pm-dl .pm-dl-shapes.pm-shadows .pm-dl-shape { background: #f4eef7; border: none; }
      .pm-dl [data-hl] { cursor: pointer; }
      .pm-dl .pm-dl-sw[data-hl]:hover span:first-child, .pm-dl .pm-dl-shape[data-hl]:hover { outline: 2px solid #ff3d92; outline-offset: 2px; }
      .pm-dl .pm-dl-type[data-hl]:hover, .pm-dl .pm-dl-line[data-hl]:hover { background: rgba(255,61,146,.10); }
      .pm-dl .pm-dl-chip[data-hl]:hover { border-color: #ff3d92; color: #f4eef7; }
      .pm-dl .pm-dl-chip b { color: #ff9fd1; font-weight: 600; margin-left: 4px; }
      .pm-dl .pm-dl-line { display: flex; align-items: center; gap: 10px; padding: 3px 4px; border-radius: 6px; font: 10.5px ui-monospace, Menlo, monospace; color: #8a7d93; }
      .pm-dl .pm-dl-line i { flex: none; width: 34px; height: 14px; border-radius: 3px; background: #f4eef7; }
      .pm-dl .pm-dl-hint { font-size: 11px; color: #8a7d93; margin: -6px 0 4px; }
      .pm-hl-layer { position: fixed; inset: 0; pointer-events: none; z-index: ${Z - 1}; }
      .pm-hl-box { position: fixed; border: 2px solid #ff3d92; background: rgba(255,61,146,.10); border-radius: 3px;
        box-shadow: 0 0 0 1px rgba(255,255,255,.6); transition: opacity .15s ease; }
      .pm-hl-box.pm-first { background: rgba(255,61,146,.22); }
      .pm-dl .pm-dl-note { font-size: 11.5px; color: #8a7d93; margin-top: 12px; line-height: 1.45; }
      .pm-bubble { position: fixed; left: 50%; bottom: 36px; transform: translateX(-50%);
        width: 46px; height: 46px; border-radius: 50%; border: none; cursor: pointer; display: none;
        align-items: center; justify-content: center; z-index: ${Z};
        background: linear-gradient(135deg, var(--pm-pink-2), var(--pm-pink-3)); color: #1c0f18;
        box-shadow: 0 10px 30px rgba(255,45,120,.45); }
      .pm-bubble.pm-show { display: flex; }
      .pm-bubble::after { content: ""; position: absolute; inset: -6px; border-radius: 50%;
        border: 1.5px solid rgba(255,110,199,.5); animation: pm-breathe 2.6s ease-in-out infinite; }

      .pm-bubble.pm-alert::after { border-color: var(--pm-pink); border-width: 3px; animation-duration: .9s; }
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
      .pm-ds { display: none; align-items: center; gap: 8px; flex-wrap: wrap; font-size: 12px; color: var(--pm-text-dim);
        margin: 0 0 12px; line-height: 1.45; }
      .pm-ds.pm-show { display: flex; }
      .pm-ds .pm-ds-dot { width: 7px; height: 7px; border-radius: 50%; background: #5fd49a; flex: none; }
      .pm-ds.pm-learning .pm-ds-dot { background: var(--pm-pink-2); animation: pm-breathe 1.4s ease-in-out infinite; }
      .pm-ds.pm-warn .pm-ds-dot { background: #ffb85c; }
      .pm-ds a { color: var(--pm-pink-2); text-decoration: none; }
      .pm-ds a:hover { text-decoration: underline; }
      .pm-ds .pm-ds-text { flex: 1 1 200px; min-width: 0; }
      .pm-gen { all: unset; cursor: pointer; font: 500 11.5px 'Plus Jakarta Sans', sans-serif; color: var(--pm-text);
        padding: 8px 12px; border-radius: 999px; border: 1px solid var(--pm-border); white-space: nowrap; flex: none; }
      .pm-gen:hover:not(:disabled) { border-color: rgba(255,61,146,.45); color: var(--pm-pink-2); }
      .pm-gen:disabled { opacity: .35; cursor: default; }
      .pm-card.pm-thinking .pm-gen { display: none; }
      .pm-actions { display: flex; align-items: center; gap: 8px; flex: none; }
      .pm-question { display: none; font-size: 13px; color: var(--pm-text); line-height: 1.45; margin: 0 0 12px;
        padding: 10px 12px; border-radius: 10px; background: rgba(255,110,199,.07); border: 1px solid rgba(255,110,199,.25);
        white-space: pre-wrap; }
      .pm-question.pm-show { display: block; }
      .pm-question a { color: var(--pm-pink-2); }
      .pm-qopts { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; white-space: normal; }
      .pm-qopts button { all: unset; cursor: pointer; font: 500 11.5px 'Plus Jakarta Sans', sans-serif; padding: 5px 10px;
        border-radius: 999px; border: 1px solid var(--pm-border); color: var(--pm-text-dim); }
      .pm-qopts button:hover { border-color: rgba(255,61,146,.45); color: var(--pm-pink-2); }
      .pm-fidelity-skip { all: unset; cursor: pointer; font: 600 11px 'Plus Jakarta Sans', sans-serif;
        color: var(--pm-text-mute); padding: 6px 8px; }
      .pm-fidelity-skip:hover { color: var(--pm-text-dim); }
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
      <button class="pm-export-top" id="pm-export" title="Export the mock: a diff for handoff, or the finished HTML">${ICONS.exportIco} Export</button>
      <button class="pm-min" id="pm-minimize" title="Minimize — keep the mock visible">${ICONS.minimize}</button>
      <button class="pm-stop-top" id="pm-stop" style="display:none;" title="Stop the in-progress AI pass (Esc) — whatever it already changed stays">${ICONS.stopSquare}</button>
      <div class="pm-titlebar">
        <p class="pm-greet">What should we change?</p>
        <span class="pm-info-wrap" tabindex="0">
          <span class="pm-info-icon">${ICONS.info}</span>
          <span class="pm-tooltip">Click text on the page to edit directly. Select an element for color/radius or prompt context — shift-click to select a range (like Excel), cmd/ctrl-click to add one at a time. Duplicate copies in place; the row icon (or Cmd/Ctrl+Shift+D) adds a new row below even if the layout would otherwise duplicate sideways.</span>
        </span>
      </div>
      <div id="pm-update-banner" class="pm-update-banner">
        <span class="pm-update-text" id="pm-update-text">Update available</span>
        <button class="pm-update-btn" id="pm-update-btn">Update</button>
      </div>
      <div id="pm-fidelity-banner" class="pm-update-banner">
        <span class="pm-update-text">${ICONS.sparkles} Enhance fidelity against the captured screenshot?</span>
        <span style="display:flex; gap:2px; flex:none;">
          <button class="pm-fidelity-skip" id="pm-fidelity-skip">Skip</button>
          <button class="pm-update-btn" id="pm-fidelity-enhance">Enhance</button>
        </span>
      </div>
      <div id="pm-ds" class="pm-ds"></div>
      <div id="pm-question" class="pm-question"></div>
      <div id="pm-chip" class="pm-chip" style="display:none;">
        <img id="pm-chip-thumb" />
        <span id="pm-chip-text"></span>
        <a id="pm-chip-clear" href="#">clear</a>
      </div>
      <textarea class="pm-input" id="pm-instruction" rows="1" placeholder="Describe a change… (Cmd/Ctrl+Enter to send)"
        spellcheck="false" autocomplete="off" autocorrect="off" autocapitalize="off"></textarea>
      <div id="pm-status" class="pm-status">idle</div>
      <div class="pm-row">
        <div class="pm-tools">
          <button class="pm-tool" id="pm-select">${ICONS.select} Select</button>
          <button class="pm-tool" id="pm-screenshot" title="Drag to highlight any area as a reference">${ICONS.areaShot} Screenshot</button>
          <button class="pm-tool" id="pm-undo" title="Undo">${ICONS.undo}</button>
          <button class="pm-tool" id="pm-redo" title="Redo">${ICONS.redo}</button>
          <button class="pm-tool" id="pm-design" title="This page's design language: what it's built with and what it measures">${ICONS.palette} Design</button>
          <button class="pm-tool" id="pm-screens" style="display:none;" title="Switch between this mock's screens">${ICONS.screens} Screens</button>
        </div>
        <div class="pm-actions">
          <button class="pm-gen" id="pm-gen" style="display:none;" title="Learn the whole product: about 15 pages and every component (takes a while)">Generate full design system</button>
        <button class="pm-send" id="pm-send" title="Send">
          <span class="pm-ar">${ICONS.arrowRight}</span><span class="pm-sp"></span>
        </button>
        </div>
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

  const screensMenu = document.createElement("div");
  screensMenu.className = "pm-export-menu";
  document.documentElement.appendChild(screensMenu);

  const designPanel = document.createElement("div");
  designPanel.className = "pm-dl";
  designPanel.setAttribute("role", "dialog");
  designPanel.setAttribute("aria-label", "Design language");
  document.documentElement.appendChild(designPanel);

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

  function formatTokenCompact(n) {
    if (n == null) return null;
    return n >= 1000 ? `${(n / 1000).toFixed(1)}K` : String(n);
  }

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
    if (cardEl.classList.contains("pm-thinking")) {
      e.preventDefault();
      cancelAgent();
    } else if (selectMode) {
      // Select mode now stays on across clicks (Shift-click ranging needs
      // the anchor click to not immediately drop out of the mode), so it
      // needs its own explicit way to bail out beyond re-clicking Select.
      e.preventDefault();
      exitSelectMode();
    }
  });

  function growInput() {
    instrEl.style.height = "auto";
    instrEl.style.height = Math.min(instrEl.scrollHeight, 140) + "px";
  }

  // The pill's dot also flags an update; only clear it for our own alerts.
  function clearAlert() {
    bubbleEl.classList.remove("pm-alert");
    if (!updateBannerEl.classList.contains("pm-show")) pillDotEl.style.display = "none";
  }
  function openCard() {
    clearAlert();
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
    clearAlert();
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

  selectBtn.addEventListener("click", () => { if (selectMode) exitSelectMode(); else setSelectMode(true); });
  screenshotBtn.addEventListener("click", () => setScreenshotMode(!screenshotMode));
  toolbar.querySelector("#pm-chip-clear").addEventListener("click", (e) => {
    e.preventDefault();
    pendingImage = null;
    clearSelection();
  });
  undoBtn.addEventListener("click", () => { if (pointer > 0) applyHistoryIndex(--pointer); });
  redoBtn.addEventListener("click", () => { if (pointer < history.length - 1) applyHistoryIndex(++pointer); });

  // The agent (and agent/pb-screens.mjs) add CSS to the page's <head>, but
  // only the body is swapped in after a run, so new styles stayed invisible
  // until a reload (4 Oct 2026: a dashboard's new cards rendered as bare
  // text). Add any head style the file now has that this page doesn't. The
  // toolbar's own head styles are left alone.
  function syncHeadStyles(doc) {
    const key = (el) => `${el.tagName}|${el.getAttribute("href") || ""}|${el.textContent.length}|${el.textContent.slice(0, 200)}`;
    const have = new Set([...document.head.querySelectorAll("style, link[rel=stylesheet]")].map(key));
    for (const el of doc.head.querySelectorAll("style, link[rel=stylesheet]")) {
      if (!have.has(key(el))) document.head.appendChild(el.cloneNode(true));
    }
  }

  async function sendPrompt() {
    const instruction = instrEl.value.trim();
    if (!instruction) return;
    hideQuestion();
    sendBtn.disabled = true;
    sendBtn.classList.add("pm-loading");
    setThinking(true);
    const t0 = Date.now();
    // A run can sit in one tool for minutes, so a bare "editing… 222s" says
    // nothing about whether anything is happening. The /prompt fetch does not
    // resolve until the whole run is over, so the only way to report the
    // current step is to ask the server, which tracks it per slug.
    let step = "starting up";
    let stepCount = 0;
    const render = () => {
      const secs = Math.round((Date.now() - t0) / 1000);
      setStatus(`${step}… ${secs}s${stepCount ? ` · step ${stepCount}` : ""}`);
    };
    render();
    const ticker = setInterval(render, 1000);
    const stepPoll = setInterval(async () => {
      let d;
      try {
        d = await fetch(`/agent-status?slug=${encodeURIComponent(slug)}`).then((r) => r.json());
      } catch {
        return; // transient hiccup — next tick retries
      }
      if (!d || d.status !== "running") return;
      if (d.step) step = d.step;
      if (d.toolCount) stepCount = d.toolCount;
      render();
    }, 2000);
    let resp;
    try {
      resp = await fetch("/prompt", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          slug, instruction,
          selection: selectedEls.length ? selectedEls.map(selectionHtml).join("\n") : "",
          images: pendingImage ? [pendingImage] : [],
          resumeSessionId: sessionId,
        }),
      }).then((r) => r.json());
    } catch (err) {
      resp = { error: err.message };
    }
    clearInterval(ticker);
    clearInterval(stepPoll);
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
      syncHeadStyles(doc);
      pushHistory(document.body.innerHTML, { persist: false }); // agent already wrote the file
      instrEl.value = "";
      pendingImage = null;
      clearSelection();
    }
    let outcome;
    if (resp.cancelled) outcome = "stopped — edits made so far are kept";
    else if (resp.error) outcome = resp.html ? `hit an error, kept partial edits: ${resp.error}` : `error: ${resp.error}`;
    else {
      const secs = resp.elapsedMs != null ? Math.round(resp.elapsedMs / 1000) : null;
      const tokens = formatTokenCompact(resp.totalTokens);
      outcome = secs != null && tokens != null ? `Done. ${secs} Sec, ${tokens} Token` : "done ✓";
    }
    if (resp.question && resp.question.question) {
      showQuestion(resp.question);
      outcome = "waiting for your answer";
      notify();
    }
    setStatus(outcome);
    rememberLastRun(outcome);
    refreshScreens();

  }
  sendBtn.addEventListener("click", sendPrompt);

  // ---------- the product's design system ----------
  // Every capture of a known product has its design system behind it: the
  // server starts a quick learn right after the capture, and this line says
  // where it stands. "Generate design system" runs the full one.
  const dsEl = toolbar.querySelector("#pm-ds");
  const genBtn = toolbar.querySelector("#pm-gen");
  const questionEl = toolbar.querySelector("#pm-question");
  const screensBtn = toolbar.querySelector("#pm-screens");
  let dsTimer = null;
  let dsWasBusy = false;

  function escapeText(t) {
    const d = document.createElement("div");
    d.textContent = t == null ? "" : String(t);
    return d.innerHTML;
  }
  function formatDay(date) {
    return new Date(`${date}T12:00:00`).toLocaleDateString(undefined, { day: "numeric", month: "short" });
  }
  function formatElapsed(ms) {
    const t = Math.round((ms || 0) / 1000);
    return t < 60 ? `${t}s` : `${Math.floor(t / 60)}m ${String(t % 60).padStart(2, "0")}s`;
  }

  // A short chime, and the pill's dot when the card is out of view.
  function notify() {
    try {
      const ctx = new AudioContext();
      [880, 1320].forEach((f, i) => {
        const o = ctx.createOscillator();
        const g = ctx.createGain();
        const at = ctx.currentTime + i * 0.16;
        o.frequency.value = f;
        g.gain.setValueAtTime(0.0001, at);
        g.gain.exponentialRampToValueAtTime(0.12, at + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, at + 0.3);
        o.connect(g).connect(ctx.destination);
        o.start(at);
        o.stop(at + 0.32);
      });
    } catch {
      /* no sound is fine */
    }
    if (!cardEl.classList.contains("pm-open")) {
      pillDotEl.style.display = "block";
      bubbleEl.classList.add("pm-alert");
    }
  }

  function renderDs(d) {
    dsEl.className = "pm-ds";
    genBtn.style.display = "none";
    if (!d || !d.ok) { dsEl.innerHTML = ""; return; }
    // No design system: the agent builds from this page's own design.
    const pageNote = d.page ? `Building from this page's own design${d.page.libraries.length ? ` (${escapeText(d.page.libraries.join(", "))})` : ""}.` : "";
    if (!d.product) {
      if (!pageNote) { dsEl.innerHTML = ""; return; }
      dsEl.innerHTML = `<span class="pm-ds-dot"></span><span class="pm-ds-text">${pageNote}</span>`;
      dsEl.classList.add("pm-show");
      return;
    }
    const label = escapeText(d.label || d.product);
    let text = "";
    if (d.generating && d.generating.status === "running") {
      dsEl.classList.add("pm-learning");
      text = `Generating the ${label} design system · ${formatElapsed(d.generating.elapsedMs)}${d.generating.step ? ` · ${escapeText(d.generating.step)}` : ""} <a href="#" data-pm-act="stop-gen">Stop</a>`;
    } else if (d.learning) {
      dsEl.classList.add("pm-learning");
      text = `Learning ${label}: ${d.learning.done} of ${d.learning.total} pages`;
    } else if (d.full) {
      text = `<a href="${escapeText(d.full.url)}" target="_blank" rel="noopener">${label} design system · ${escapeText(formatDay(d.full.date))} · ${d.full.components} components</a>`;
    } else if (d.quick) {
      text = `<a href="${escapeText(d.quick.url || "#")}" target="_blank" rel="noopener">${label} quick design system · ${d.quick.pages} pages · ${escapeText(formatDay(d.quick.date))}</a>`;
    } else if (d.copy === "sign-in") {
      dsEl.classList.add("pm-warn");
      text = `${pageNote} To learn all of ${label}, sign in to its copy once. <a href="${escapeText(d.signInUrl)}" target="_blank" rel="noopener">Sign in</a>`;
    } else if (d.copy === "none") {
      text = `${pageNote} No running ${label} copy to learn more from right now.`;
    } else if (d.learnError) {
      dsEl.classList.add("pm-warn");
      text = `Couldn't learn ${label}: ${escapeText(d.learnError)}`;
    }
    if (d.generating && d.generating.status === "failed") text += ` <span>Generating failed: ${escapeText(d.generating.error)}</span>`;
    if (d.serviceExpired && !d.full && !d.quick) text += " <span>(the environment service needs signing in again: run /mcp in Claude Code)</span>";
    if (!text) { dsEl.innerHTML = ""; return; }
    dsEl.innerHTML = `<span class="pm-ds-dot"></span><span class="pm-ds-text">${text}</span>`;
    dsEl.classList.add("pm-show");
    // Upgrades a quick learn to the full design system, so it only shows
    // when there is no full one (a full one past 30 days counts as none).
    if (!d.full && d.copy === "ok" && !(d.generating && d.generating.status === "running") && !d.learning) {
      genBtn.style.display = "";
    }
  }

  async function loadDs() {
    clearTimeout(dsTimer);
    let d = null;
    try {
      d = await fetch("/design-system/ensure", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ slug }) }).then((r) => r.json());
    } catch {
      /* server briefly away: retry below */
    }
    renderDs(d);
    const busy = !!(d && (d.learning || (d.generating && d.generating.status === "running")));
    const waitingOnUser = !!(d && d.copy === "sign-in");
    if (dsWasBusy && !busy && d && (d.full || d.quick)) notify();
    dsWasBusy = busy;
    if (busy || waitingOnUser || !d) dsTimer = setTimeout(loadDs, busy ? 3000 : 5000);
  }

  genBtn.addEventListener("click", async () => {
    genBtn.disabled = true;
    try {
      const r = await fetch("/design-system/generate", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ slug }) }).then((x) => x.json());
      if (!r.ok) setStatus(r.error || "couldn't start generating");
    } catch (err) {
      setStatus(`couldn't start generating: ${err.message}`);
    }
    genBtn.disabled = false;
    loadDs();
  });
  dsEl.addEventListener("click", async (e) => {
    const a = e.target.closest("[data-pm-act=stop-gen]");
    if (!a) return;
    e.preventDefault();
    const d = await fetch("/design-system/ensure", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ slug }) }).then((r) => r.json()).catch(() => null);
    if (d && d.generating) await fetch("/agent-cancel", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ slug: d.generating.job }) }).catch(() => {});
    loadDs();
  });
  loadDs();

  // ---------- the agent's questions ----------
  function hideQuestion() {
    questionEl.classList.remove("pm-show");
    questionEl.textContent = "";
    instrEl.placeholder = "Describe a change… (Cmd/Ctrl+Enter to send)";
  }
  function showQuestion(q) {
    questionEl.textContent = q.question;
    if (q.boardUrl) {
      const link = document.createElement("a");
      link.href = q.boardUrl;
      link.target = "_blank";
      link.rel = "noopener";
      link.textContent = "Open the concepts";
      questionEl.append("\n", link);
    }
    if (q.options && q.options.length) {
      const opts = document.createElement("div");
      opts.className = "pm-qopts";
      for (const o of q.options) {
        const b = document.createElement("button");
        b.textContent = o;
        b.addEventListener("click", () => { instrEl.value = o; growInput(); instrEl.focus(); });
        opts.appendChild(b);
      }
      questionEl.appendChild(opts);
    }
    questionEl.classList.add("pm-show");
    instrEl.placeholder = "Your answer… (Cmd/Ctrl+Enter to send)";
  }

  // ---------- screens ----------
  // A mock can hold several screens of the product, each a
  // [data-pb-screen] section inside the product's own shell; the product's
  // navigation switches between them. This menu does the same from the
  // toolbar.
  function showScreen(name) {
    document.querySelectorAll("[data-pb-screen]").forEach((sct) => { sct.hidden = sct.getAttribute("data-pb-screen") !== name; });
  }
  function refreshScreens() {
    const names = [...document.querySelectorAll("[data-pb-screen]")].map((sct) => sct.getAttribute("data-pb-screen"));
    screensBtn.style.display = names.length > 1 ? "" : "none";
    screensMenu.innerHTML = "";
    for (const name of names) {
      const b = document.createElement("button");
      b.className = "pm-export-opt";
      b.textContent = name;
      b.addEventListener("click", () => { showScreen(name); screensMenu.classList.remove("pm-open"); });
      screensMenu.appendChild(b);
    }
  }
  screensBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    const r = screensBtn.getBoundingClientRect();
    screensMenu.style.left = `${Math.max(8, r.left)}px`;
    screensMenu.style.top = `${r.top - 8}px`;
    screensMenu.style.transform = "translateY(-100%)";
    screensMenu.classList.toggle("pm-open");
  });
  document.addEventListener("click", (e) => {
    if (screensMenu.classList.contains("pm-open") && !screensMenu.contains(e.target) && !screensBtn.contains(e.target)) screensMenu.classList.remove("pm-open");
  });
  refreshScreens();

  // ---------- design language ----------
  // What this page is built with and what it measures, read from the
  // capture alone (works on any page). Opens by itself once per capture.
  const designBtn = toolbar.querySelector("#pm-design");
  let designData = null;

  // ---- what the page is made of, read from the live copy ----
  // Component kinds by the markup libraries and plain HTML leave behind.
  // Counted on the editor's own DOM (the same page, real CSS), so hovering
  // an entry can point at every instance.
  const PART_KINDS = [
    ["Buttons", "button, [role=button], input[type=button], input[type=submit], .MuiButton-root, .ant-btn, .btn"],
    ["Links", "a[href]"],
    ["Text fields", "input[type=text], input[type=search], input[type=email], input[type=number], input[type=password], input:not([type]), textarea, .MuiTextField-root, .ant-input-affix-wrapper"],
    ["Dropdowns", "select, [role=combobox], [aria-haspopup=listbox], .MuiSelect-root, .ant-select"],
    ["Checkboxes", "input[type=checkbox], [role=checkbox], .MuiCheckbox-root, .ant-checkbox-wrapper"],
    ["Radios", "input[type=radio], [role=radio], .MuiRadio-root, .ant-radio-wrapper"],
    ["Switches", "[role=switch], .MuiSwitch-root, .ant-switch"],
    ["Tables & grids", "table, [role=grid], [role=treegrid]"],
    ["Tabs", "[role=tablist], .MuiTabs-root, .ant-tabs-nav"],
    ["Pills & tags", ".MuiChip-root, .ant-tag, .badge, [class*=chip], [class*=Chip], [class*=badge], [class*=Badge], [class*=pill], [class*=Pill]"],
    ["Pagination", ".MuiPagination-root, .MuiTablePagination-root, .ant-pagination, .pagination, [aria-label*=pagination i]"],
    ["Breadcrumbs", ".MuiBreadcrumbs-root, .ant-breadcrumb, [aria-label*=breadcrumb i], [class*=breadcrumb], [class*=Breadcrumb]"],
    ["Cards & panels", ".MuiCard-root, .MuiPaper-root, .ant-card, .card, [class*=card], [class*=Card], [class*=panel], [class*=Panel]"],
    ["Avatars", ".MuiAvatar-root, .ant-avatar, [class*=avatar], [class*=Avatar]"],
    ["Menus & nav", "nav, [role=menu], [role=menubar], [role=navigation]"],
    ["Dialogs", "[role=dialog], .MuiDialog-root, .ant-modal"],
    ["Alerts", "[role=alert], [role=status], .MuiAlert-root, .ant-alert"],
    ["Progress", "[role=progressbar], progress"],
    ["Tooltips", "[role=tooltip]"],
    ["Headings", "h1, h2, h3"],
    ["Images", "img"],
    ["Icons", "svg"],
  ];
  const ours = (el) => !!el.closest("#pm-toolbar, .pm-dl, .pm-export-menu, .pm-hl-layer, .pm-qe, .pm-edit-badge");
  const shown = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return false;
    const cs = getComputedStyle(el);
    return cs.visibility !== "hidden" && cs.display !== "none" && Number(cs.opacity) > 0;
  };
  function findParts() {
    const out = [];
    for (const [kind, sel] of PART_KINDS) {
      let els;
      try { els = [...document.body.querySelectorAll(sel)]; } catch { continue; }
      els = els.filter((el) => !ours(el) && shown(el));
      // A match nested inside another match of the same kind is one part.
      const set = new Set(els);
      els = els.filter((el) => { for (let p = el.parentElement; p; p = p.parentElement) if (set.has(p)) return false; return true; });
      if (els.length) out.push({ kind, els });
    }
    return out;
  }

  // Elements by computed style, built on first hover.
  let styleIndex = null;
  function buildStyleIndex() {
    const idx = { color: new Map(), bg: new Map(), type: new Map(), radius: new Map(), border: new Map() };
    const add = (m, k, el) => { if (!k) return; if (!m.has(k)) m.set(k, []); m.get(k).push(el); };
    const all = document.body.getElementsByTagName("*");
    for (let i = 0, n = 0; i < all.length && n < 8000; i++) {
      const el = all[i];
      if (ours(el) || !shown(el)) continue;
      n++;
      const cs = getComputedStyle(el);
      const text = [...el.childNodes].some((c) => c.nodeType === 3 && c.nodeValue.trim());
      if (text) { add(idx.color, cs.color, el); add(idx.type, `${cs.fontSize} / ${cs.fontWeight}`, el); }
      if (!/^(transparent|rgba\(\s*0,\s*0,\s*0,\s*0\s*\))$/.test(cs.backgroundColor)) add(idx.bg, cs.backgroundColor, el);
      if (cs.borderTopLeftRadius !== "0px") add(idx.radius, cs.borderRadius, el);
      if (cs.borderTopStyle !== "none" && parseFloat(cs.borderTopWidth) > 0) add(idx.border, `${cs.borderTopWidth} ${cs.borderTopStyle} ${cs.borderTopColor}`, el);
    }
    return idx;
  }

  // ---- highlighting on the page ----
  const hlLayer = document.createElement("div");
  hlLayer.className = "pm-hl-layer";
  document.documentElement.appendChild(hlLayer);
  let hlEls = [];
  function drawHighlights() {
    hlLayer.innerHTML = "";
    hlEls.slice(0, 200).forEach((el, i) => {
      const r = el.getBoundingClientRect();
      if (r.bottom < 0 || r.top > innerHeight || r.width < 1) return;
      const b = document.createElement("div");
      b.className = "pm-hl-box" + (i === 0 ? " pm-first" : "");
      Object.assign(b.style, { left: `${r.left - 2}px`, top: `${r.top - 2}px`, width: `${r.width + 4}px`, height: `${r.height + 4}px` });
      hlLayer.appendChild(b);
    });
  }
  function highlight(els) { hlEls = els || []; drawHighlights(); }
  addEventListener("scroll", () => { if (hlEls.length) drawHighlights(); }, true);
  addEventListener("resize", () => { if (hlEls.length) drawHighlights(); });
  let parts = [];
  function elementsFor(key) {
    const [type, ...rest] = key.split(":");
    const value = rest.join(":");
    if (type === "part") return (parts.find((p) => p.kind === value) || { els: [] }).els;
    styleIndex = styleIndex || buildStyleIndex();
    if (type === "type") {
      const [size, weight] = value.split(" / ");
      return styleIndex.type.get(`${size} / ${weight}`) || [];
    }
    return (styleIndex[type] && styleIndex[type].get(value)) || [];
  }

  function renderDesign(d) {
    const esc = escapeText;
    const libs = d.libraries || [];
    parts = findParts();
    const hex = (v) => {
      const m = v.match(/rgba?\(\s*(\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?/);
      if (!m) return v;
      const h = "#" + [m[1], m[2], m[3]].map((n) => Number(n).toString(16).padStart(2, "0")).join("");
      return m[4] != null && Number(m[4]) < 1 ? `${h} ${Math.round(Number(m[4]) * 100)}%` : h;
    };
    const sw = (arr, type) => arr.map((c) => `<div class="pm-dl-sw" data-hl="${type}:${esc(c.value)}" title="${esc(c.value)} · used ${c.count}×"><span style="background:${esc(c.value)}"></span><span>${esc(hex(c.value))}</span></div>`).join("");
    const fam = d.fontFamilies && d.fontFamilies[0] ? d.fontFamilies[0].value : "inherit";
    const type = (d.typeScale || []).map((t) => {
      const [size, weight] = t.value.split(" / ");
      return `<div class="pm-dl-type" data-hl="type:${esc(size)} / ${esc(weight)}"><span style="font-family:${esc(fam)};font-size:${esc(size)};font-weight:${esc(weight)};line-height:1.2">The quick brown fox</span><span>${esc(size)} · ${esc(weight)}</span></div>`;
    }).join("");
    const radii = (d.radii || []).map((r) => `<div class="pm-dl-shape" data-hl="radius:${esc(r.value)}" style="border-radius:${esc(r.value)}"><span>${esc(r.value.split(" ")[0])}</span></div>`).join("");
    const borders = (d.borders || []).map((b) => `<div class="pm-dl-line" data-hl="border:${esc(b.value)}"><i style="border:${esc(b.value)};background:transparent"></i>${esc(b.value.replace(/rgba?\([^)]*\)/, (c) => hex(c)))}</div>`).join("");
    const shadows = (d.shadows || []).map((sh) => `<div class="pm-dl-shape" style="box-shadow:${esc(sh.value)}"></div>`).join("");
    const primary = libs.find((l) => !l.styling);
    designPanel.innerHTML = `
      <button class="pm-dl-close" title="Close">&times;</button>
      <h3>Design language</h3>
      <p class="pm-dl-sub">Read from this page${d.measured ? `: ${d.elementsCounted} elements measured` : ""}. Hover anything to find it on the page.</p>
      <h4>Built with</h4>
      <div class="pm-dl-chips">${primary ? "" : `<span class="pm-dl-chip">Custom components</span>`}${libs.map((l, i) => `<span class="pm-dl-chip${i || l.styling ? " pm-dim" : ""}">${esc(l.name)}${l.styling ? " (styling)" : ""}</span>`).join("")}${libs.length ? "" : `<span class="pm-dl-chip pm-dim">Hand-written CSS</span>`}</div>
      ${parts.length ? `<h4>Components on this page</h4><div class="pm-dl-chips">${parts.map((p) => `<span class="pm-dl-chip pm-dim" data-hl="part:${esc(p.kind)}">${esc(p.kind)}<b>${p.els.length}</b></span>`).join("")}</div>` : ""}
      ${d.measured ? `
      <h4>Text colours</h4><div class="pm-dl-swatches">${sw(d.textColors.slice(0, 8), "color")}</div>
      <h4>Surfaces</h4><div class="pm-dl-swatches">${sw(d.backgrounds.slice(0, 8), "bg")}</div>
      <h4>Type · ${esc(fam.split(",")[0].replace(/["']/g, ""))}</h4>${type}
      ${borders ? `<h4>Borders</h4>${borders}` : ""}
      ${radii ? `<h4>Corner radii</h4><div class="pm-dl-shapes">${radii}</div>` : ""}
      ${shadows ? `<h4 style="margin-top:22px">Shadows</h4><div class="pm-dl-shapes pm-shadows">${shadows}</div>` : ""}` : `<p class="pm-dl-note">This capture predates measuring. Capture the page again to see its colours, type and shapes.</p>`}
      <p class="pm-dl-note" style="margin-top:22px">The agent builds with these: it copies the page's own components, and builds what's missing the way ${primary ? esc(primary.name) : "the page's own markup"} would, in these colours, type and shapes.</p>`;
    designPanel.querySelector(".pm-dl-close").addEventListener("click", () => { designPanel.classList.remove("pm-open"); highlight([]); });
  }
  designPanel.addEventListener("mouseover", (e) => {
    const t = e.target.closest("[data-hl]");
    if (t) highlight(elementsFor(t.getAttribute("data-hl")));
  });
  designPanel.addEventListener("mouseleave", () => highlight([]));
  designPanel.addEventListener("click", (e) => {
    const t = e.target.closest("[data-hl]");
    if (!t) return;
    const els = elementsFor(t.getAttribute("data-hl"));
    if (!els.length) return;
    els[0].scrollIntoView({ block: "center", behavior: "smooth" });
    highlight(els);
  });

  async function loadDesign({ open, mark } = {}) {
    try {
      designData = await fetch(`/page-design?slug=${encodeURIComponent(slug)}${mark ? "&mark=1" : ""}`).then((r) => r.json());
    } catch {
      return;
    }
    if (!designData || !designData.ok) return;
    renderDesign(designData);
    if (open || (mark && designData.firstTime && (designData.measured || designData.libraries.length))) designPanel.classList.add("pm-open");
  }
  designBtn.addEventListener("click", () => {
    if (designPanel.classList.contains("pm-open")) designPanel.classList.remove("pm-open");
    else if (designData) { renderDesign(designData); designPanel.classList.add("pm-open"); } // re-read: edits change the page
    else loadDesign({ open: true });
  });
  loadDesign({ mark: true });
  instrEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) sendPrompt();
  });

  // ---------- export menu (Diff Export / HTML Export) ----------

  // Opens below the button when it sits in the top half (it lives in the
  // card's top-right corner), above it otherwise, right-aligned to it.
  function positionExportMenu() {
    const r = exportBtn.getBoundingClientRect();
    exportMenu.style.left = `${Math.max(8, r.right - 150)}px`;
    if (r.top < innerHeight / 2) {
      exportMenu.style.top = `${r.bottom + 8}px`;
      exportMenu.style.transform = "none";
    } else {
      exportMenu.style.top = `${r.top - 8}px`;
      exportMenu.style.transform = "translateY(-100%)";
    }
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
  async function doHtmlExport() {
    // Export downloads the file on disk, so anything not yet written would be
    // silently missing from it. Write the current page first and confirm it
    // landed before handing the user a file.
    setStatus("saving before export…");
    const ok = await flushSave();
    if (!ok) { setStatus("export cancelled — the page could not be saved"); return; }
    // Straight to the server's raw file (never toolbar-injected — see
    // handleExportHtml/injectToolbar in server.js) via a forced-download
    // response header, no client-side fetch/blob juggling needed. The
    // timestamp keeps a repeat export off any cached copy of an identical URL.
    const a = document.createElement("a");
    a.href = `/export-html?slug=${encodeURIComponent(slug)}&t=${Date.now()}`;
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

  // ---------- fidelity pass: opt-in trigger + background pass polling ----------
  //
  // Used to run automatically right after every capture; most captures
  // didn't need it and it was getting reflexively Stopped, so it's now only
  // ever started from here, via the one-time banner — never on page load by
  // itself, and there's no other entry point: once it's been run or
  // skipped, that's the final word for this mock, by design (no permanent
  // re-triggerable button). The pass itself still runs detached
  // server-side (see PLAN.md), so THIS page, not the extension, is what
  // waits for it and reflects progress.

  const TOAST_KEY = `pm-toast-${slug}`;
  const DRAFT_KEY = `pm-draft-${slug}`;
  const fidelityBanner = toolbar.querySelector("#pm-fidelity-banner");
  const fidelityEnhanceBtn = toolbar.querySelector("#pm-fidelity-enhance");
  const fidelitySkipBtn = toolbar.querySelector("#pm-fidelity-skip");

  function hideFidelityBanner() { fidelityBanner.classList.remove("pm-show"); }

  async function startFidelityPass() {
    hideFidelityBanner();
    let resp;
    try {
      resp = await fetch("/fidelity-start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slug }),
      }).then((r) => r.json());
    } catch (err) {
      resp = { error: err.message };
    }
    if (!resp || resp.error) { setStatus(`couldn't start fidelity check: ${resp && resp.error}`); return; }
    startAgentPoll();
  }
  fidelityEnhanceBtn.addEventListener("click", startFidelityPass);
  fidelitySkipBtn.addEventListener("click", () => {
    hideFidelityBanner();
    fetch("/fidelity-dismiss", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ slug }),
    }).catch(() => {}); // best-effort — worst case the banner just reappears next load
  });

  // The fidelity pass fixes what the capture missed and then reloads the
  // page. The composer stays usable meanwhile, so the user can write their
  // request, and the draft survives the reload (only sending waits).
  function startAgentPoll() {
    openCard();
    setThinking(true);
    cardEl.classList.add("pm-typeable");
    sendBtn.disabled = true;
    const t0 = Date.now();
    setStatus("fixing what the capture missed… 0s");
    const poll = setInterval(async () => {
      let data;
      try {
        data = await fetch(`/agent-status?slug=${encodeURIComponent(slug)}`).then((r) => r.json());
      } catch {
        return; // transient network hiccup — just try again next tick
      }
      if (!data || data.status === "running") {
        setStatus(`fixing what the capture missed… ${Math.round((Date.now() - t0) / 1000)}s`);
        return;
      }
      clearInterval(poll);
      const toast = data.status === "cancelled" ? "stopped — edits made so far are kept"
        : data.status === "failed" ? "couldn't fix what the capture missed — check server.log"
        : "fixed what the capture missed";
      sessionStorage.setItem(TOAST_KEY, toast);
      if (instrEl.value.trim()) sessionStorage.setItem(DRAFT_KEY, instrEl.value);
      location.reload(); // simplest way to resync the DOM with whatever runFidelityPass wrote to disk
    }, 2000);
  }

  loadHistory();
  reconcileHistoryWithDom();
  updateUndoRedoButtons();
  updateSelectionChip();
  // A returning tab (bfcache / restored session) can hand back the previous
  // prompt still sitting in the box; start every load with an empty composer,
  // unless a draft was saved across the fidelity pass's reload.
  instrEl.value = sessionStorage.getItem(DRAFT_KEY) || "";
  sessionStorage.removeItem(DRAFT_KEY);
  if (instrEl.value) growInput();
  restoreLastRunStatus();
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
    } else if (window.__PM_FIDELITY_SHOW_BANNER) {
      openCard();
      fidelityBanner.classList.add("pm-show");
    } else {
      // The editor's job is prompting: open ready to type, never as a
      // closed pill the user has to find first.
      openCard();
    }
  }

  const qeStyle = document.createElement("style");
  qeStyle.textContent = `
    /* ---- selection action cluster: parked at the selection's corner
       instead of any panel opening automatically (§ quick-edit, matches the
       mini-bubble language in DESIGN-SYSTEM.md §5.5). Holds Style (only
       shown for a single-element selection), Duplicate, and Delete. ---- */
    #pm-qe-trigger { all: initial; position: fixed; z-index: ${Z}; display: none;
      align-items: center; gap: 4px; padding: 4px; border-radius: 999px;
      background: rgba(24,18,29,.95); border: 1px solid #2d2436;
      box-shadow: 0 8px 22px rgba(0,0,0,.45); animation: pm-qe-pop .14s ease; }
    #pm-qe-trigger.pm-show { display: flex; }
    #pm-qe-trigger button { all: unset; box-sizing: border-box; width: 26px; height: 26px;
      border-radius: 50%; cursor: pointer; display: flex; align-items: center; justify-content: center;
      color: #1c0f18; background: linear-gradient(135deg, #ff6ec7, #ff2d78); }
    #pm-qe-trigger button:hover { filter: brightness(1.1); }
    #pm-qe-trigger .pm-qe-delete { background: linear-gradient(135deg, #ff7a7a, #dd2d3d); }
    @keyframes pm-qe-pop { from { opacity: 0; transform: scale(.5); } to { opacity: 1; transform: scale(1); } }

    /* ---- persistent selection outline(s): floating overlay boxes, never a
       class/attribute on the page's own elements (see the comment above
       selectionBoxPool) ---- */
    .pm-sel-box { position: fixed; pointer-events: none; z-index: ${Z - 2};
      border: 2px solid #ff3d92; background: rgba(255,61,146,.08); display: none; }

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
