---
type: design-system
name: Halo Spotlight
updated: 2026-07-12
status: reference — portable spec for re-implementation
---

# Halo Spotlight — UX/Styling Design System

A portable, technical spec for the floating AI-composer UI language designed
across several iterations (originally as a static HTML prototype, then ported
into a Chrome extension's shadow-DOM panel, then into this project's
server-rendered toolbar). Everything here is copy-paste-technical: exact
hex values, exact keyframes, exact interaction state machines. Written to be
implemented fresh in any project — a new Claude Code session with only this
file should be able to rebuild the whole thing without seeing prior code.

## 1. Concept

A floating AI composer that lives on top of an arbitrary host page (a browser
extension overlay, an injected toolbar, anything that isn't a normal app
layout). Three states, one shell:

```
[collapsed pill]  --click-->  [composer card]  --minimize-->  [corner bubble]
        ^                            |                              |
        |                        close/click-outside                |
        +----------------------------+                               |
        ^                                                             |
        +------------------------- click bubble ---------------------+
```

- **Pill**: a small glowing "ask me" affordance, bottom-center or wherever
  makes sense for the host surface. Non-intrusive by default.
- **Card**: the actual composer — greeting, attachment tray, input, status
  line, tool row, send button. Centered over the page, NOT full-screen, NOT
  blocking the page visually (see §6 on the scrim).
- **Bubble**: a minimized state for when the user wants the composer out of
  the way without losing their draft — a small circular affordance parked at
  a screen edge (not the same position as the pill), breathing gently so it
  still reads as "alive."

The design intentionally avoids two common AI-chrome failure modes: (a) a
heavy modal that blocks the page you're trying to reference while typing
about it, and (b) a spinner-only "thinking" state that gives no sense the
system is actually doing something.

## 2. Design tokens

```css
:root {
  --pink:   #ff3d92;  /* primary accent */
  --pink-2: #ff6ec7;  /* lighter accent, used in gradients/glows */
  --pink-3: #ff2d78;  /* darker accent, used in gradients */
  --ink-1:  #18121d;  /* card background, top of gradient */
  --ink-2:  #100c14;  /* card background, bottom of gradient */
  --border: #2d2436;  /* hairline borders throughout */
  --text:      #f4eef7; /* primary text on dark surfaces */
  --text-dim:  #d3c2d6; /* secondary text (tool labels) */
  --text-mute: #776b81; /* placeholders, muted status */
  --status:    #ff9fd1; /* status text, badges, "busy" tint */
}
```

Palette rationale: a single hue family (hot pink → magenta) rather than a
"safe" muted palette — deliberately vivid/modern rather than corporate-blue.
Pairs a near-black warm-neutral background (not pure `#000`, has a faint
plum/violet undertone from `--ink-1`/`--ink-2`) so the pink glows read as
light sources rather than flat color blocks.

**Do not** use a light background with this palette — it was explicitly
designed and validated as a dark-surface system. If a light-mode variant is
ever needed, it needs its own pass, not a naive color-flip.

## 3. Typography

**Font: Plus Jakarta Sans**, weights 300–500 (never 600+; this system reads
as "light and inviting," not bold/shouty — a past iteration used 600 for
headings and status text and it read as too aggressive for an assistant
tone).

Self-host it — do not load from `fonts.googleapis.com`. Two reasons: (1) if
this runs inside a browser extension or on arbitrary third-party pages, their
CSP may block external font requests; (2) it removes a network dependency
entirely. As of this writing, Google serves Plus Jakarta Sans as a **single
variable woff2 file** covering the whole weight axis (200–800), not one file
per static weight — so self-hosting is one file, not four:

```bash
# one-time: fetch the variable font file
curl -sL "https://fonts.gstatic.com/s/plusjakartasans/v12/LDIoaomQNQcsA88c7O9yZ4KMCoOg4Ko20yygg_vb.woff2" \
  -o PlusJakartaSans-Variable.woff2
```

Load it with `@font-face` directly if you're in a normal DOM:

```css
@font-face {
  font-family: 'Plus Jakarta Sans';
  src: url('/fonts/PlusJakartaSans-Variable.woff2') format('woff2');
  font-weight: 200 800;
  font-style: normal;
}
```

If the UI lives inside a **shadow DOM** (e.g. a Chrome extension content
script isolating its styles from the host page), `@font-face` inside a
`<style>` in the shadow root still works — fonts register against
`document.fonts` regardless of which shadow root declared them. Alternatively
use the FontFace API for more control over load timing:

```js
const face = new FontFace(
  'Plus Jakarta Sans',
  `url(${fontUrl})`,
  { weight: '200 800', style: 'normal' }
);
face.load().then((loaded) => document.fonts.add(loaded))
  .catch(() => {/* falls back to the system stack below, harmlessly */});
```

Always fall back gracefully:
`font-family: 'Plus Jakarta Sans', -apple-system, system-ui, sans-serif;`

Type scale used:
| Role | Size | Weight |
|---|---|---|
| Card greeting ("What should we change?") | 20px | 400 |
| Composer input text | 15–17px | 400 |
| Tool button labels | 11–11.5px | 500 |
| Status line | 12–12.5px | 400–500 |
| Pill label | 14.5px | 400 |
| Hover/edit badges, history dropdown items | 11–12px | 500 |

## 4. Icon system

Inline SVG, Lucide-style (stroke-based line icons, NOT filled/solid icons,
NOT an icon font, NOT emoji). Every icon shares the same wrapper so they
inherit color and swap cleanly:

```js
const svgIcon = (inner, size = 16) =>
  `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none"
    stroke="currentColor" stroke-width="2" stroke-linecap="round"
    stroke-linejoin="round">${inner}</svg>`;

const ICONS = {
  select: svgIcon('<circle cx="12" cy="12" r="9"/><line x1="22" y1="12" x2="18" y2="12"/><line x1="6" y1="12" x2="2" y2="12"/><line x1="12" y1="6" x2="12" y2="2"/><line x1="12" y1="22" x2="12" y2="18"/>'),
  highlight: svgIcon('<path d="M3 7V5a2 2 0 0 1 2-2h2"/><path d="M17 3h2a2 2 0 0 1 2 2v2"/><path d="M21 17v2a2 2 0 0 1-2 2h-2"/><path d="M7 21H5a2 2 0 0 1-2-2v-2"/>'),
  undo: svgIcon('<path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 5.5 5.5v0a5.5 5.5 0 0 1-5.5 5.5H11"/>'),
  redo: svgIcon('<path d="m15 14 5-5-5-5"/><path d="M20 9H9.5A5.5 5.5 0 0 0 4 14.5v0A5.5 5.5 0 0 0 9.5 20H13"/>'),
  export: svgIcon('<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>'),
  sparkles: svgIcon('<path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z"/><path d="M20 3v4"/><path d="M22 5h-4"/><path d="M4 17v2"/><path d="M5 18H3"/>', 15),
  arrowRight: svgIcon('<path d="M5 12h14"/><path d="m12 5 7 7-7 7"/>'),
  minimize: svgIcon('<path d="M4 14h6v6"/><path d="M20 10h-6V4"/><path d="m14 10 7-7"/><path d="m3 21 7-7"/>', 14),
  close: svgIcon('<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>', 13),
  edit: svgIcon('<path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/><path d="m15 5 4 4"/>', 12),
};
```

`sparkles` is the brand mark (used on the pill and the minimized bubble —
the "AI is here" signifier). `edit` is used only on the inline-text-edit
badge. Never use a filled/solid icon style anywhere in this system — the
whole visual language is thin-stroke line icons.

## 5. Components — exact specs

All measurements assume the card sits inside a positioning root with
`z-index` high enough to sit above host-page content. Adjust the actual
`z-index` integer to your context; keep the *relative* layering (scrim below
card, dropdown/badges above card) intact.

### 5.1 Collapsed pill

```css
.pill {
  display: flex; align-items: center; gap: 10px;
  padding: 12px 20px; border-radius: 999px; cursor: pointer; position: relative;
  background: rgba(20,14,22,.9); border: 1px solid var(--border);
  backdrop-filter: blur(14px); box-shadow: 0 10px 40px rgba(0,0,0,.45);
  transition: opacity .2s ease;
}
.pill.hidden { opacity: 0; pointer-events: none; position: absolute; }
.pill .halo {
  position: absolute; inset: -18px; border-radius: 999px; z-index: -1;
  background: radial-gradient(circle, rgba(255,45,120,.4), transparent 70%);
  filter: blur(6px);
  animation: breathe 3.4s ease-in-out infinite;
}
@keyframes breathe {
  0%, 100% { opacity: .5; transform: scale(1); }
  50%      { opacity: 1;  transform: scale(1.08); }
}
```
Label copy is a short, warm call-to-action (e.g. "Let's Page Bend" in the
original — brand it to your product name/verb). Icon: `sparkles`.

### 5.2 Composer card

```css
.card {
  display: none; width: min(560px, 88vw); position: relative;
  background: linear-gradient(180deg, var(--ink-1), var(--ink-2));
  border: 1px solid var(--border); border-radius: 22px; padding: 22px 24px 18px;
  box-shadow: 0 30px 80px rgba(0,0,0,.65);
}
.card.open { display: block; }
```

Top-right of the card: two small icon buttons, 26×26px, `border-radius: 8px`,
`border: 1px solid var(--border)`, `background: rgba(255,255,255,.03)`,
hover state `background: rgba(255,61,146,.14); color: var(--status);`:
- **Minimize** (icon `minimize`) at `right: 46px`
- **Close/exit** (icon `close`) at `right: 16px`

Greeting text directly below: `<p>` at 20px/400 weight, `margin: 0 0 14px`.

### 5.3 Ambient glow ("halo2") — READ THE GOTCHA BELOW BEFORE IMPLEMENTING

```css
.card .halo2 {
  position: absolute; inset: -5px; z-index: -1; border-radius: 26px;
  background:
    radial-gradient(circle at 28% 30%, rgba(255,110,199,.55), transparent 55%),
    radial-gradient(circle at 76% 74%, rgba(255,45,120,.5), transparent 55%);
  filter: blur(9px);
  animation: wobble 5s ease-in-out infinite;
  opacity: .6; transition: opacity .2s ease;
}
.card.thinking .halo2 { opacity: 1; animation-duration: 2.4s; }
@keyframes wobble {
  0%, 100%  { border-radius: 26px;                     transform: scale(1); }
  25%       { border-radius: 32px 20px 28px 24px;       transform: scale(1.012); }
  50%       { border-radius: 20px 30px 22px 32px;       transform: scale(0.99); }
  75%       { border-radius: 30px 24px 34px 20px;       transform: scale(1.008); }
}
```

**Gotcha, confirmed by hands-on testing — do not rotate this glow.** An
earlier version animated this exact glow with `transform: rotate(360deg)`
(a conic-gradient sweeping around, like a rotating searchlight). This looked
wrong in two ways: (1) aesthetically it read like "calling batman," not a
calm ambient glow; (2) it was a **real, measurable bug**: rotating a WIDE,
SHORT rectangle causes its axis-aligned bounding box to balloon at diagonal
angles (a 560×200 box rotated 45° has a bounding box near its diagonal,
~600px in BOTH dimensions). Measured via `getBoundingClientRect()` during the
animation: the element's rect swelled from 574×217 to 606×470 at the worst
angle — meaning the glow visibly swept up into unrelated parts of the page
above the card, not just around it. **Fix implemented here:** never rotate
the box itself. Instead animate `scale()` (uniform, doesn't create the
diagonal-bounding-box problem) plus `border-radius` corner values (creates
organic "wobble"/breathing motion without any rotation at all). If you want a
literal rotating conic-gradient sweep for some other reason, animate the
gradient's `from <angle>` via a registered CSS custom property
(`@property --angle { syntax: '<angle>'; ... }` + animate the property, not
`transform: rotate()` on the element) so the box itself never physically
rotates.

### 5.4 Scrim (dim layer behind the card)

```css
.scrim {
  position: fixed; inset: 0; z-index: <below card, above host page>;
  background: rgba(10,8,6,0); pointer-events: none;
  transition: background .35s ease;
}
.scrim.on { background: rgba(10,8,6,.14); }
```

**Deliberately very light (14% black) and NEVER `backdrop-filter: blur()`.**
Earlier iteration used a heavier dim (45%) plus a 2px blur — direct user
feedback: "the user wants to see the page he's thinking about while writing
the prompt." The scrim's only job is to make the card pop slightly; it must
never obscure the host page's content. `pointer-events: none` always — see
§7.2 for how "click outside closes the card" is handled WITHOUT the scrim
intercepting clicks (a blocking scrim was tried first and caused a real
interaction bug, described there).

### 5.5 Minimized bubble

```css
.mini-bubble {
  position: fixed; right: 22px; top: 50%; transform: translateY(-50%);
  width: 46px; height: 46px; border-radius: 50%; border: none; cursor: pointer;
  display: none; align-items: center; justify-content: center;
  background: linear-gradient(135deg, var(--pink-2), var(--pink-3)); color: #1c0f18;
  box-shadow: 0 10px 30px rgba(255,45,120,.45);
}
.mini-bubble.show { display: flex; }
.mini-bubble::after {
  content: ""; position: absolute; inset: -6px; border-radius: 50%;
  border: 1.5px solid rgba(255,110,199,.5);
  animation: breathe 2.6s ease-in-out infinite; /* reuse the pill's @keyframes breathe */
}
```
Positioned at the vertical-center of the right edge — deliberately NOT the
same position as the collapsed pill (bottom-center), so the two "parked"
states are visually distinct and the user always knows which one they're
looking at.

### 5.6 Attachment tray + thumbnails

```css
.tray { display: flex; gap: 10px; margin-bottom: 12px; flex-wrap: wrap; }
.thumb {
  position: relative; width: 68px; height: 52px; border-radius: 10px;
  overflow: hidden; border: 1px solid var(--border);
  box-shadow: 0 6px 16px rgba(0,0,0,.35); flex: none;
}
.thumb img { width: 100%; height: 100%; object-fit: cover; display: block; }
.thumb button { /* remove "×" */
  position: absolute; top: 3px; right: 3px; width: 15px; height: 15px;
  border-radius: 50%; background: rgba(0,0,0,.6); color: #fff; border: none;
  font-size: 9px; cursor: pointer; padding: 0; line-height: 1;
}
.thumb .tag { /* small corner marker distinguishing e.g. "captured" vs "pasted" attachments */
  position: absolute; bottom: 3px; left: 3px; width: 15px; height: 15px;
  border-radius: 50%; background: rgba(24,18,29,.85); color: var(--status);
  display: flex; align-items: center; justify-content: center;
}
.thumb .tag svg { width: 9px; height: 9px; }
```
Only attachments with a distinguishing origin (e.g. a screen-region capture
vs. a plain pasted image) get the `.tag` corner marker; a plain pasted image
thumbnail has no tag.

### 5.7 Input + status line

```css
.input {
  width: 100%; background: transparent; border: none; outline: none; resize: none;
  max-height: 160px; color: var(--text);
  font: 400 17px/1.5 'Plus Jakarta Sans', -apple-system, system-ui, sans-serif;
  padding: 0 0 14px;
}
.input::placeholder { color: var(--text-mute); }

.status {
  font-size: 12.5px; color: var(--text-mute); min-height: 16px; margin-bottom: 10px;
  line-height: 1.4; word-wrap: break-word;
}
.card.thinking .status { color: var(--status); }
.card.thinking .input { opacity: .4; pointer-events: none; }
.card.thinking .tools .tool { opacity: .35; pointer-events: none; }
```
The status line is a general-purpose feedback channel (idle state, errors,
progress, confirmations) — not decorative. It must always be visible and
legible; don't hide it by default the way some early prototypes did (opacity
0 unless "thinking") — a real implementation has far more status messages
than just the AI-thinking phase.

### 5.8 Tool row + send button

```css
.tools { display: flex; gap: 6px; flex-wrap: wrap; }
.tool {
  border: 1px solid var(--border); background: rgba(255,255,255,.02);
  color: var(--text-dim); font: 500 11.5px 'Plus Jakarta Sans', sans-serif;
  padding: 6px 11px; border-radius: 999px; cursor: pointer;
  display: flex; align-items: center; gap: 5px;
}
.tool:hover { background: rgba(255,61,146,.1); }
.tool.on { /* active/toggled-on state — MUST be wired in JS, easy to forget */
  background: linear-gradient(135deg, var(--pink), var(--pink-3));
  color: #1c0f18; border-color: transparent;
}
.tool:disabled { opacity: .35; cursor: default; }

.send {
  width: 40px; height: 40px; border-radius: 50%; border: none; cursor: pointer;
  background: linear-gradient(135deg, var(--pink-2), var(--pink-3)); color: #1c0f18;
  display: flex; align-items: center; justify-content: center;
  box-shadow: 0 8px 20px rgba(255,45,120,.4); flex: none;
}
.send .sp { /* spinner, shown while sending */
  display: none; width: 14px; height: 14px; border-radius: 50%;
  border: 2px solid rgba(28,15,24,.35); border-top-color: #1c0f18;
  animation: spin .7s linear infinite;
}
.send.loading .ar { display: none; } .send.loading .sp { display: block; }
@keyframes spin { to { transform: rotate(360deg); } }
```

**Implementation gotcha:** `.tool.on` is trivial to define in CSS and then
forget to actually toggle in JS — verified this exact miss during review (a
tool mode that visually has no "active" indicator even though the mode is
genuinely engaged). Every stateful tool button (anything that toggles a mode
on/off — a select tool, a region-drag tool, etc.) needs its
`classList.toggle('on', isActive)` wired at BOTH the start and every exit
path (including Escape-cancel and any external code path that force-cancels
the mode).

### 5.9 Long-press secondary menu (e.g. undo/redo history)

```css
.history-menu {
  position: absolute; z-index: 60; display: none; flex-direction: column; gap: 2px;
  min-width: 210px; max-width: 300px; padding: 6px; border-radius: 12px;
  background: var(--ink-1); border: 1px solid var(--border);
  box-shadow: 0 16px 40px rgba(0,0,0,.5);
  transform: translateY(calc(-100% - 10px)); /* anchors ABOVE the triggering button */
}
.history-menu.open { display: flex; }
.history-item {
  all: unset; box-sizing: border-box; width: 100%; padding: 7px 10px; border-radius: 8px;
  font: 400 12px 'Plus Jakarta Sans', sans-serif; color: #e8dbe9; cursor: pointer;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.history-item:hover { background: rgba(255,61,146,.14); color: var(--status); }
.history-empty { padding: 7px 10px; font: 400 12px 'Plus Jakarta Sans', sans-serif; color: var(--text-mute); }
```
See §7.4 for the long-press interaction pattern this pairs with.

### 5.10 Text-editing affordance (double-click-to-edit pattern)

```css
.editable-active {
  outline: 2px dashed var(--pink); outline-offset: 3px; border-radius: 4px;
  background: rgba(255,61,146,.06); cursor: text;
}
.edit-badge {
  position: absolute /* or fixed, depending on positioning context */; z-index: 51;
  pointer-events: none; display: flex; align-items: center; gap: 4px;
  padding: 3px 8px; border-radius: 6px; font-size: 11px;
  font-family: 'Plus Jakarta Sans', sans-serif;
  background: #18121d; color: var(--status);
}
@keyframes saved-flash {
  0%   { box-shadow: 0 0 0 0 rgba(255,61,146,.55); }
  100% { box-shadow: 0 0 0 8px rgba(255,61,146,0); }
}
.saved-flash { animation: saved-flash .5s ease-out; border-radius: 4px; }
```
Badge text is literally "editing" with the `edit` (pencil) icon. Positioned
above the element being edited (`top: elementRect.top - 24px`). On commit,
apply `.saved-flash` briefly (500ms) instead of the outline color — a
distinct, lighter pulse from any other "content changed" indicator elsewhere
in the app (don't reuse a shared "flash" if one already exists for e.g.
undo/redo confirmation; this one specifically means "text edit saved").

### 5.11 Region-select drag marquee (e.g. a "highlight this area" tool)

```css
.selection-box {
  position: fixed; border: 1.5px dashed var(--pink);
  background: rgba(255,61,146,.12); border-radius: 3px; pointer-events: none;
}
.selection-size-badge {
  position: fixed; padding: 3px 8px; border-radius: 6px; font-size: 11px;
  font-family: 'Plus Jakarta Sans', sans-serif;
  background: #18121d; color: var(--status); pointer-events: none;
}
```
Size badge shows live `${width} × ${height}` in CSS px, positioned just above
the top-left of the drag rectangle. See §7.5 for the interaction and a real
gotcha around doing this drag on top of an arbitrary host page.

## 6. Hover/select outline + label badge (e.g. an element-picker tool)

```css
.hover-outline {
  position: fixed; pointer-events: none; z-index: <above host page>;
  border: 1.5px solid var(--pink); background: rgba(255,61,146,.08);
  box-shadow: 0 0 24px rgba(255,61,146,.28); border-radius: 4px;
}
.hover-badge {
  position: fixed; pointer-events: none; z-index: <above outline>;
  padding: 3px 8px; border-radius: 6px; font-size: 11px;
  font-family: 'Plus Jakarta Sans', sans-serif;
  background: #18121d; color: var(--status);
}
```
Badge text convention: `tagname.firstClass` (e.g. `div.card`, `td`) — cheap,
readable identification of what's under the cursor without needing a full
selector engine.

## 7. Interaction patterns (state machines + gotchas)

### 7.1 Pill → Card → Bubble state machine

```js
function openCard()    { card.classList.add('open'); pill.classList.add('hidden'); scrim.classList.add('on'); input.focus(); }
function closeCard()   { card.classList.remove('open'); pill.classList.remove('hidden'); scrim.classList.remove('on'); }
function minimizeCard(){ card.classList.remove('open'); scrim.classList.remove('on'); bubble.classList.add('show'); }
function restoreCard() { bubble.classList.remove('show'); card.classList.add('open'); scrim.classList.add('on'); input.focus(); }
```
Minimize does **not** clear the input value or attachment list — that state
lives in the DOM/JS model regardless of which shell state is visible, so
restoring picks the conversation back up exactly where it was left.

### 7.2 Click-outside-to-close — the scrim must NOT intercept clicks

Do not make the scrim `pointer-events: auto` to detect "click outside." That
was tried and creates a real bug: a drag interaction (region-select, element
picking) that starts and ends inside the card's screen area will have its
mousedown swallowed by the blocking scrim, breaking the drag. Instead, keep
the scrim `pointer-events: none` always, and detect "outside click" with a
plain document-level listener:

```js
document.addEventListener('click', (e) => {
  if (!card.classList.contains('open')) return;
  if (someModeIsActive()) return; // don't close mid-drag/mid-pick
  if (card.contains(e.target) || pill.contains(e.target) || bubble.contains(e.target)) return;
  closeCard();
});
```

**Two follow-on gotchas found by hands-on testing, both real bugs:**

1. **Trailing synthetic click after a drag.** Any mousedown→mouseup drag
   interaction (a region-select drag, a long-press) makes the browser fire a
   plain `click` event on whatever's under the pointer immediately
   afterward. If that lands on the "click outside closes the card" listener
   right after the drag finishes (e.g. right after capturing a highlighted
   region), it dismisses the card as an unwanted side effect. Fix: a
   one-shot suppression flag set exactly when such a drag ends, consumed by
   the very next click:
   ```js
   let suppressNextClick = false;
   // ...inside the drag's mouseup handler, right when it finishes successfully:
   suppressNextClick = true;
   // ...inside the outside-click listener, as the very first check:
   if (suppressNextClick) { suppressNextClick = false; return; }
   ```
2. **The first half of a double-click.** If double-click-to-edit (§5.10) is
   also in play, the FIRST click of that double-click is indistinguishable,
   at click-time, from an ordinary single click — so an "outside click
   closes the card" listener would close the card before the second click
   even fires. Fix: don't close for clicks on any directly-editable leaf
   element (no element children — i.e. a text node's containing element):
   ```js
   if (e.target.nodeType === 1 && !panel.contains(e.target) && e.target.children.length === 0) return;
   ```

### 7.3 Shadow DOM event-target retargeting (if the UI lives in a shadow root)

If this system is implemented inside an `attachShadow({mode: 'open'})` panel
(common for browser extensions isolating their styles from the host page),
**any `document`-level (or otherwise outside-the-shadow-tree) listener that
reads `e.target` will see it retargeted to the shadow HOST element**, not the
actual element the user clicked — this is standard, spec-required shadow DOM
behavior, true for open AND closed roots. Concretely: a document-level click
listener checking `myCard.contains(e.target)` will be wrong for every click
that originated inside the shadow tree, because `e.target` collapses to the
shadow host (an ancestor of `myCard`, not a descendant — `.contains()` is
false). **Fix: use `e.composedPath()[0]` instead of `e.target`** in any
document/window-level listener that needs to know which specific element
inside an open shadow root was actually clicked — `composedPath()` is not
retargeted the way `e.target` is, for open shadow roots. (For CLOSED shadow
roots, `composedPath()` also truncates at the boundary for listeners
outside the tree — there's no equivalent fix; don't use a closed shadow root
if this pattern is needed from outside it.)

This bug is easy to introduce silently: it doesn't throw, it just makes
every click inside the panel misbehave as if it were "outside" — e.g. every
click on the send button or a tool button incorrectly triggering
close-the-card. Test explicitly for this if porting to a shadow-DOM context.

### 7.4 Long-press to open a secondary menu, without double-firing the normal click

```js
let longPressFired = false;
function wireLongPress(button, onLongPress) {
  let timer = null;
  button.addEventListener('mousedown', () => {
    longPressFired = false;
    clearTimeout(timer);
    timer = setTimeout(() => { longPressFired = true; onLongPress(); }, 450);
  });
  ['mouseup', 'mouseleave'].forEach((evt) =>
    button.addEventListener(evt, () => clearTimeout(timer))
  );
}
// in the button's normal click handler:
button.addEventListener('click', () => {
  if (longPressFired) { longPressFired = false; return; } // menu already opened; skip the normal action
  normalAction();
});
```
450ms threshold read well in testing — long enough that a normal click never
false-triggers it, short enough that a deliberate hold doesn't feel laggy.
Every `mousedown` re-zeroes the flag, so it can never leak stale-true across
separate interactions.

### 7.5 Region-select drag — do the drag on your OWN overlay, never the host page

If this pattern involves letting the user drag-select a rectangular region of
an arbitrary host page (e.g. "highlight this area for context"), **do not
attach the drag's mousedown/mousemove/mouseup listeners to the host page's
own elements or to `document` with the expectation that the host page won't
interfere.** An earlier attempt did exactly that and — direct quote from that
project's own postmortem — "fought the page's own mouse/drag handlers and was
unreliable." The robust fix: create your own full-viewport, top-most,
plain `position: fixed; inset: 0` overlay element for the DURATION of the
drag only, and attach the drag listeners to THAT overlay, not to the host
page or `document`:

```js
const overlay = document.createElement('div');
Object.assign(overlay.style, {
  position: 'fixed', inset: '0', zIndex: <very high>, cursor: 'crosshair', background: 'transparent',
});
document.body.appendChild(overlay);
overlay.addEventListener('mousedown', onDown);
overlay.addEventListener('mousemove', onMove);
overlay.addEventListener('mouseup', onUp);
// on completion: overlay.remove();
```
Because the overlay is the actual top-most hit-tested element for the whole
viewport, the host page never receives a single one of these events — there
is nothing to "fight." Also register a capture-phase `Escape` keydown on
`document` to cancel the drag and remove the overlay.

If the end result of the drag needs to actually capture pixels (e.g. a
screenshot of the selected region) and your own UI (the card, a minimized
bubble, etc.) is visible anywhere on screen, remember to hide your OWN UI
(e.g. `panelRoot.style.display = 'none'`) and wait at least one paint cycle
(`await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))`)
before capturing, then restore it — otherwise your own chrome ends up baked
into the captured image.

### 7.6 "Thinking"/busy visual state

```js
function setBusy(isBusy) {
  card.classList.toggle('thinking', isBusy);      // dims input+tools, intensifies halo2 (see §5.3)
  sendButton.classList.toggle('loading', isBusy); // swaps arrow icon for spinner (see §5.8)
  sendButton.disabled = isBusy;
}
```
Pair this with a real, honest status message — cycling status phrases that
reflect actual progress (even coarse-grained: "reading the page…",
"applying the change…") read as far more trustworthy than a generic
"Loading…" or a bare spinner with no text.

## 8. Summary of hard-won rules (read this if short on time)

1. Dark surface only; don't attempt a light-mode flip without a real pass.
2. Weights 300–500 only. Never 600+ — it reads as shouty, not inviting.
3. Self-host the font. One variable woff2 file, not per-weight static files.
4. Never rotate the ambient glow — animate `scale()` + `border-radius`
   wobble instead, or a CSS custom property angle if a literal rotating
   gradient sweep is truly wanted. Rotating the box itself blows up its
   bounding box at diagonal angles and visibly bleeds outside the component.
5. Scrim is always `pointer-events: none` and always very light (≤15%
   black), never blurred. Detect "click outside" with a plain document
   listener, not a blocking scrim.
6. If in a shadow DOM: use `e.composedPath()[0]`, not `e.target`, in any
   listener registered outside the shadow tree.
7. Any drag interaction over an arbitrary host page needs its own top-most
   overlay element — never attach directly to the host page's DOM.
8. Every stateful toggle button needs its active-class wired at every exit
   path, not just the happy path — this is the single easiest thing to
   silently leave half-done.
9. The status line is a real, always-visible feedback channel — not a
   decorative element that only appears during the AI-thinking phase.
