---
type: plan
updated: 2026-07-13
---

# Page Bender — status and plan

Personal project (rebranded from "Page Mock" back to "Page Bender" on
2026-07-12 — the directory is still `extension/page-mock/`, only the
user-facing name changed). Chrome extension + local Node server. Capture a
live page once into a standalone HTML mock, prototype on it with Claude
(full tool access), export a diff for handoff. This is a from-scratch
rewrite, not the same project as the archived `page-bender` at
`extension/_archive/page-bender/` (kept for reference, not to be reused for
code) — it just reclaims the same name now that this version has proven
itself.

## Working and verified (don't re-litigate)

- **Capture pipeline** (`extension/content.js`): clones the live DOM once
  (real classes, real attributes, real inline styles kept as-is) and copies
  the page's REAL stylesheets verbatim into one consolidated `<style>` block
  — not a per-element computed-style bake. `<script>` stripped (inert, no
  live JS/auth dependency once frozen). Fonts embedded as base64 by patching
  `@font-face` `src: url()` in place. Canvas still snapshotted via
  `toDataURL` (the one thing that has to be baked — live pixels have no CSS
  representation). See "Real-CSS capture rewrite" below for why and what
  this replaced.
- **Server** (`server/server.js`): `/capture`, `/prompt`, `/diff`, `/save`,
  `/agent-status`, `/agent-cancel`, `/export-html`. Full tool access (Bash
  included) for the editing agent — explicit user decision, accepted risk,
  don't reintroduce sandboxing. `/prompt` always returns whatever's on disk
  even when the agent run fails or hits its turn cap (previously only a
  deliberate Stop did this — a real maxTurns failure used to silently
  strand genuine edits that had already landed). Default budget raised
  30→60 after a real feature request needed the room (see "Manual /prompt
  reliability" below).
- **Async capture, background fidelity pass, kill switch**: `/capture`
  responds in ~1-2s (mechanical bake only); the AI fidelity pass runs
  detached, tracked per-slug in `activeQueries` (`server.js`). The mock
  toolbar (`mock-toolbar.js`) polls `/agent-status` and shows a "Stop"
  button (`/agent-cancel` → `query.close()`, confirmed real via the SDK's
  `sdk.d.ts`) covering both the background pass and a manual `/prompt` call.
  Killing keeps whatever already landed on disk — no rollback. This is what
  fixed the Chrome MV3 service-worker ~5-minute cap killing `/capture`
  mid-request and surfacing as a false "capture failed: undefined" even on
  runs that succeeded server-side.
- **Section capture**: a second capture-time control (hover-highlight,
  click-to-capture — same interaction pattern as the toolbar's own
  select-mode) captures just one element instead of the whole page,
  screenshot cropped to match (`cropToSelection`, ported into `content.js`).
- **Always-on local server** via launchd (`com.aura.pagemock`, installed by
  `server/install.command`): plain `RunAtLoad + KeepAlive`, not socket
  activation (tried once, caused a real crash-loop from `fd:3` `ENOTTY`,
  abandoned — don't retry without a very good reason).
- **Mock page toolbar** (`server/public/mock-toolbar.js`): Halo Spotlight
  branding (pink glow, pill→card→minimized-bubble, matches old project's
  look by request), click-to-edit text, select-mode (with an element-type
  tab on the hover frame, e.g. "span.Kpi_value__xebBy" — matches the
  original Page Bender's select tool), screenshot-to-prompt, paste-an-image
  reference (same `pendingImage` pipeline the screenshot button fills, just
  a second way to fill it), color/radius quick-edit panel, 5-slot undo/redo,
  pure-white prompt text, Export button (see below).
- **Export menu**: replaces the old single "Diff" button. "Diff Export"
  (unchanged) or "HTML Export" — the latter via a new `/export-html`
  endpoint serving the raw, un-injected `working.html` as a direct download.
  Every class name in the diff/export is now a real one (no more `pf-sN`
  noise to tell the summarizer to ignore). Both options verified end to end
  (2026-07-13): Diff Export produces an accurate changelog (it even caught a
  real inconsistency an edit left behind — a `data-test-id` attribute that
  no longer matched which card was actually selected); HTML Export's
  response has the correct `Content-Disposition` header, zero toolbar
  contamination, and a fully valid document.
- **Extension panel stays on top of page modals**: a MutationObserver
  (`content.js`) re-appends the extension's host element to stay the last
  node in the document whenever the live page adds new content after it
  (`subtree: true` — most modals append inside `<body>`, not as a new
  direct child of `<html>`) — otherwise a same-z-index modal opened after
  our panel already injected wins the stacking tie by document order and
  swallows clicks meant for it.

**Two CSS gotchas hit building the Export popover, worth remembering if
another floating panel gets added to `mock-toolbar.js`:** (1) `#pm-toolbar`
has both `position: fixed` AND a `transform` (translateX) — any transform on
an ancestor creates a new containing block for `position: fixed`
descendants, so a floating element placed INSIDE `#pm-toolbar`'s own markup
gets its "fixed" positioning resolved relative to `#pm-toolbar`'s box, not
the viewport, silently breaking viewport-relative positioning math. Fix:
append floating panels directly to `document.documentElement` instead, same
as `hoverBox`/`quickEdit`/`editBadge` already do. (2) `#pm-toolbar`'s own
`--pm-*` CSS custom properties are scoped to that element and only inherited
by its descendants — a panel moved outside its subtree for reason (1) can no
longer resolve `var(--pm-ink-1)` etc., silently invalidating the whole
declaration (e.g. `background` computes to `none`). Fix: literal hex values
for anything living outside `#pm-toolbar`, same as `.pm-editable-active`/
`.pm-edit-badge` already do.

## Real-CSS capture rewrite (2026-07-12) — the actual fix

The original capture baked one computed-style snapshot per element into a
generated `pf-sN` class. That was a *translation* of the page, not a copy —
a container's baked width and its children's baked widths were frozen as
independent numbers the moment that happened, so they could stop adding up
(the "structural fidelity" bug class chased for most of this doc's earlier
history). It also needed hand-rolled reconstructions of things real CSS
already does for free — `:hover`/`:focus` replayed via `onmouseenter`
handlers, `::before`/`::after` materialized as fake DOM nodes — each a
separate source of bugs, and collectively the reason a slow AI "fidelity
pass" was ever load-bearing.

Rewrite: keep the real DOM (already true) AND keep the real CSS as real CSS
— copy every accessible stylesheet's actual rule text into one `<style>`
block, absolutize `url()`s (skipping bare `#id` fragments — those are
in-document SVG paint-server references, not external resources, a bug
already hit once and fixed), patch `@font-face` `src` with fetched base64.
The browser's own layout engine then re-derives structure/sizing against
real rules when the file is reopened — the whole baked-width-vs-live-flex-
parent bug class stops being possible *by construction*, not by a repair
pass catching it after the fact.

**Validated same-day, two real captures of a live production dashboard:**
- Run 1: 336s, 38 tool calls. **Zero structural/layout defects found.** One
  real, correctly-diagnosed gap: the page's `Inter` body font is served from
  a cross-origin CDN stylesheet the capture can't read (known, accepted
  blind spot — same hard browser boundary as any cross-origin font/style
  read). Agent fetched the real Inter files and embedded them directly.
- Run 2 (same page, moments later): 267s, 33 tool calls. **Zero defects
  found at all** — this time judged the sans-serif fallback close enough to
  the screenshot and correctly left it alone.

Both runs: no invented fixes, no false positives, nothing outside the one
known font-embedding blind spot. This is the result the earlier "fidelity
pass" work in this doc was trying to reach and couldn't, because it was
repairing a bug class the capture mechanism kept reintroducing every run.

`DIAGNOSTIC_SYSTEM_PROMPT` (`server.js`) rescoped accordingly: no longer
describes the baked-width failure mode (can't happen anymore), now scoped to
what can still slip through — cross-origin stylesheet/font blind spots,
canvas/live-pixel edge cases. Dead code from the earlier two-phase
structural/visual split (`STRUCTURE_SYSTEM_PROMPT`/`FIDELITY_SYSTEM_PROMPT`)
removed — that split was solving a problem this rewrite made obsolete.

**Known accepted gaps, unchanged:** cross-origin stylesheets/fonts with no
permissive CORS header are unreadable from a content script — hard browser
security boundary, no workaround. Tag-qualified CSS selectors targeting
`canvas` specifically (e.g. `canvas.chart`) stop matching once a captured
canvas becomes an `<img>` — accepted as a rare edge case, not solved for.

## Fidelity-pass speed tuning (2026-07-12, later same day)

Even with zero structural bugs, the two validation runs above still took
4.5-5.5 minutes each. Looking at the actual tool-call sequences (30+
individual Bash calls — curling each icon URL, checking each CSS variable
one at a time, decoding images) showed why: `DIAGNOSTIC_SYSTEM_PROMPT` still
said "take as many turns as needed, thoroughness over speed" — a framing
left over from when subtle structural bugs genuinely needed careful
verification. Once those bugs were eliminated by construction, that
instruction was pure cost with no remaining benefit, and nobody had gone
back to check.

Rewrote the prompt to bias toward a fast, decisive glance and dropped
`maxTurns` from 150 to 25. Result: the "nothing wrong" case went from
267-336s/30+ tool calls down to **24-70s/2-9 tool calls**, same correct
verdict.

Font handling needed a second pass specifically, in three iterations:
1. First attempt over-prescribed the fix mechanism ("fetch one variable
   font file, not per-weight") — this was over-fit to the one failure mode
   observed (a real run had hit the 25-turn ceiling doing a slow per-weight
   Google Fonts scrape) and doesn't generalize.
2. Generalized to "fix it the way you'd fix anything else in this file" —
   trust, not a prescribed technique, matching how `QUALITY_SYSTEM_PROMPT`
   already treats every other kind of edit. Validated directly: asked via
   a manual `/prompt` call (no font-specific instructions at all) to embed
   Inter, it froze on its own an even better single combined Google Fonts
   request (covering all weights *and* the one italic instance actually
   used) — better than what had been prescribed, in 166s/20 tool calls.
   This incidentally validated the `/prompt` editing loop itself too, not
   just capture fidelity (see prior "open follow-up" below).
3. Turned out the real inconsistency wasn't the fix — it was *detection*.
   Across runs, whether a font gap was even noticed at all varied (one run
   found it and fixed it, one judged the fallback "close enough," one
   didn't check at all and reported "no mismatch" off 2 tool calls). Made
   the font check itself mandatory (an explicit required grep every run,
   not something caught incidentally while glancing at the screenshot) and
   made "close enough" no longer an acceptable exit for a genuine gap.
   Final validated result: 147.5s/17 tool calls — correctly found and fixed
   Inter (used ~144 times, essentially the whole page) while correctly
   leaving Roboto alone (one minor widget reference, not a primary
   typeface) rather than over-fixing something that doesn't matter.

## Manual /prompt reliability + first real feature test (2026-07-13)

The editing loop (`/prompt`, not the capture-time fidelity pass) got its
first real exercise: "add campaign historical actions (played, paused) on
the timeline, as in the reference [image]." It legitimately needed to
reverse-engineer an existing recharts SVG's structure/conventions before
editing with confidence — much more investigation than a mechanical
font-embed fix — and ran out of the *default* 30-turn budget (separate
from the diagnostic pass's own tuned budget) with 2 real edits already on
disk, one of them a malformed tag that would have broken everything below
the chart.

Two reliability fixes came out of that:
- **`handlePrompt`'s failure path now always reads and returns the current
  file**, alongside `err.pfSessionId` (so a follow-up can resume the exact
  same session) — previously a genuine `maxTurns` failure returned only an
  error, silently stranding whatever had already landed on disk. The
  client (`sendPrompt()` in `mock-toolbar.js`) now applies `resp.html`
  whenever present, regardless of whether there's also an error, and shows
  "hit an error, kept partial edits: ..." instead of discarding the DOM
  update.
- **Default `maxTurns` raised 30→60** for manual edits. A starting point,
  not a tuned number — nowhere near the diagnostic pass's old 150 that got
  walked back for being excessive; revisit once there's more real usage
  data on what typical feature work costs.

**Resumed the exact failed session** (using the newly-preserved session ID)
with the higher budget rather than starting fresh: 186.5s/20 tool calls,
and it finished — *and* caught its own earlier mistake. Because it
remembered what it had just done, it diffed div-open/close counts, found
the malformed tag from its first attempt, fixed it, and confirmed 284/284
balanced across the whole file. It then installed Playwright itself to
render the file in real headless Chromium and visually confirm the markers
sit on the curve and the hover tooltips work — not just a code read. This
is the concrete case for resumability: a fresh session facing the same
half-edited file would have had to rediscover the breakage from scratch, or
worse, never noticed it.

**A second, separate bug then surfaced from real use**: the timeline
markers looked right at the window width they were authored at, but were
visibly wrong at other widths — worth understanding since it's a general
lesson about static positioning in a *responsive* capture, not specific to
this one feature. Root cause: the chart's SVG has a fixed `viewBox` (its
native coordinate system) but renders at `width: 100%` of a container whose
aspect ratio changes with the window. When that rendered aspect ratio no
longer matches the viewBox's native ratio, the browser's default SVG
scaling (`preserveAspectRatio="xMidYMid meet"`) shrinks the actual chart
content uniformly and letterboxes it — and that letterbox offset isn't a
fixed proportion of the container, so no static CSS value (px *or* %) can
express it. A first attempt (converting the marker's `left` from px to %)
fixed the horizontal case but missed this entirely, since it only
manifests when the container's aspect ratio itself shifts.

Real fix: a small inline `<script>` (runs on load and on `resize`) that
reads the chart SVG's `getScreenCTM()` — a standard browser API giving the
exact current transform from the chart's own coordinate space to real
screen pixels — and repositions each marker from its stored native
coordinates (`data-svg-x`/`data-svg-y`) every time. This is correct at any
window size because it asks the browser for the actual current transform
instead of assuming one. Verified at two different window widths (900px
and 1280px) after the fix — both correct. **General lesson: anything
placed on top of a responsive SVG chart in a capture needs to reposition
itself the same way this did, not rely on a value frozen at whatever
width the edit happened to be made at.**

## Real cost, and a self-inflicted 2x error correcting it (2026-07-13)

Asked how many tokens/dollars the capture-time fidelity pass actually costs.
The server never logged this, so it got hand-computed from raw SDK
transcript JSONL files by summing each `assistant` message's `usage` field
across the conversation — and came out roughly **2x too high** (e.g.
reported $1.13 for an 18-tool-call run that actually cost $0.58). Root
cause: the transcript logs two JSONL lines per logical turn (a streaming
update and a final event), both carrying an identical copy of that turn's
`usage` — summing every line double-counts every turn. Caught by
deduplicating on message `id` and recomputing; real numbers for three actual
runs today: 2 tool calls ≈ $0.13, 8 tool calls ≈ $0.31, 18 tool calls ≈
$0.58.

**What actually drives the cost**: prompt caching itself is the discount,
not the expense — without it, this would cost ~10x more. The real driver is
turn COUNT: every turn resends the entire conversation so far (system
prompt + every prior tool call/result), so total cost is roughly the *sum*
of context size across all turns, which grows worse than linearly as turns
increase (checked the actual per-turn context size for the 18-call run: a
smooth `28,513 → 66,166` climb, no single wasteful command — just ordinary
growth repeated 18 times). This is also why today's earlier turn-count
tightening (the "fast decisive glance" rewrite, the mandatory-but-narrow
font check) was a cost win, not just a speed win — same underlying lever.

**Fixed properly this time**: `runAgentTurn` (`server.js`) now reads
`total_cost_usd`/`usage`/`num_turns` straight from the SDK's own `result`
message type instead of ever hand-summing per-turn usage again — confirmed
via `sdk.d.ts` that this field exists on both `SDKResultSuccess` *and*
`SDKResultError` (subtype `error_max_turns` included), and that the SDK
yields it as a normal stream message *before* replacing a maxTurns/error
exit with a bare string exception — so cost is now visible in `server.log`
even for failed/timed-out runs, not just successful ones. Also added an
explicit "consolidate your Bash calls into one script instead of several
sequential greps" instruction to `DIAGNOSTIC_SYSTEM_PROMPT`, directly
targeting turn count as the cost lever this section identifies.

## Standard to hold this to

User's framing, worth re-reading before declaring anything "done": a model
given only a screenshot (no DOM/CSS) already reaches ~75–85% fidelity some of
the time. DOM/CSS access is only worth its complexity if it (1) pushes
fidelity *above* that baseline, not just matches it, and (2) preserves real
markup for the diff/handoff export, which vision-only reconstruction could
never provide. Judge results against both, not just "does it look okay."

The real-CSS rewrite is a stronger claim on (1) than the old approach ever
delivered (structural bugs eliminated by construction, not just repaired
after the fact), and a stronger claim on (2) too (every class is now a real
class, not a mix of real + `pf-sN` noise) — but still worth re-validating on
a page with heavier third-party/cross-origin CSS than the dashboard tested so far
before calling the font/stylesheet blind spot "rare" rather than "common."

## Open follow-ups

- The `/prompt` editing loop has now been exercised for real (the timeline
  markers feature above) — genuinely complex, multi-step, needed the
  turn-budget and partial-progress-on-failure fixes to actually complete.
  Worth continuing to watch whether 60 turns holds up as a reasonable
  default across a wider range of feature requests, or needs another look.
- Font-embedding blind spot could, in principle, shrink further (e.g.
  fetching a cross-origin stylesheet's raw text directly rather than via
  `cssRules`, where CORS allows it) — not pursued now; the mandatory-check
  + freestyle-fix behavior above has handled it cleanly and efficiently
  every time it's fired since.
- The "close enough, leave it" escape hatch was removed specifically for
  fonts (they matter too much to wave off) but nothing else in
  `DIAGNOSTIC_SYSTEM_PROMPT` was revisited with the same lens — worth
  watching whether other categories of visual gap need the same
  mandatory-check treatment once one is actually observed being missed,
  rather than pre-emptively hardening things that haven't caused a problem.
- Not a fully self-contained file yet: fonts and canvas-rendered charts are
  base64-embedded, but real `<img src>` and CSS `url(...)` background-images
  are only absolutized (content.js's `absolutize()`), not fetched+embedded —
  so an exported HTML file still needs the original site reachable to show
  real photos/logos. Same base64-embed treatment `embedFontFaces` already
  does for fonts would close this gap if true offline/single-file portability
  ever becomes a real requirement (came up explaining the tool's "one file,
  not a folder" pitch to colleagues — not urgent today, since the file itself
  never depends on a companion asset folder either way).
