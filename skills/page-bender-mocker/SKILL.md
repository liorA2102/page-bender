---
name: page-bender-mocker
description: Turn a PRD or a raw idea into a high-fidelity HTML mock of a real product, built from that product's own captured pages. The agent drives the product in the user's browser through Page Bender (non-prod hosts only, every write blocked), captures real pages and components, extracts a dated design system (tokens, components, page shell, coverage), then builds the mock from it. Use when the user says "mock this PRD", "mock this idea in <product>", "build a design system for <product>", "extract <product>'s design system", "capture <product>'s components", or shares a PRD or idea together with a non-prod URL. Do NOT use for editing an existing captured mock by chat (that is the Page Bender toolbar), or for prototypes that should follow the workspace HTML standard rather than a real product.
---

# Page Bender Mocker

Two jobs, run in order, and the second reuses the first:

- **A. Design system.** Explore one product on a non-prod host, capture real pages and
  components, and write a dated design-system folder.
- **B. Mock.** Build the mock of a PRD or idea from that folder.

The governing rule for both: **the mock's implementation stays as close to the real production
product as possible.** Every value and component either comes from a capture, or is labelled
inferred in the README. Nothing is invented silently.

## Before anything: the tool and its limits

All browser work goes through `node <repo>/agent/pb.mjs`, where `<repo>` is the Page Bender
checkout (the folder holding `extension/` and `server/`). Run `node agent/pb.mjs help` for the
commands. Start every session with `node agent/pb.mjs health`: `workerPolling: false` means Chrome
is closed or the extension needs reloading, so stop and say so. `extensionVersion` must equal
`expectedVersion`: if it does not, the extension was edited but not reloaded, and its background
worker is running old code (injected page scripts are read fresh, so this half-updated state is
easy to miss). Ask the user to reload it in `chrome://extensions`.

Limits enforced by Page Bender itself, which this skill never tries to get around:

- **Driving works only on hosts with a whole `.non-prod.` label, over https.** A prod URL is
  refused. If the user gives a prod URL, ask for the non-prod equivalent.
- **Every POST, PUT, PATCH and DELETE from a driven tab is blocked.** A page whose own reads use
  POST will show empty data. That is expected, not a bug to work around. Say what came up empty.
- **Commit-worded buttons (Save, Delete, Create, Run, Approve, ...) are refused.** Explore by
  opening and dismissing only: `click` to open, `capture`, then `escape`.
- **The user must already be logged in** to that host in their own Chrome. A login page in the
  snapshot means stop and ask them to sign in; never type credentials.
- **The agent's Chrome window must stay visible on screen** while it works (another monitor, or
  side by side). Chrome throttles a minimized or covered window, so pages stall and screenshots
  go stale. Page Bender refuses with "the agent's Chrome window is hidden" when that happens:
  ask the user to uncover it, then retry. Tell the user this before a long run.
- **The VPN must be on** for internal hosts. "Chrome is showing its error page" usually means it
  dropped.

Captures hold real product data, so everything this skill writes stays local and is never
published or committed. Do not publish a mock as an Artifact or anywhere else: it imitates
internal product chrome.

## Inputs

1. **The product and its non-prod URL.** Required for A. If only a product name is given, ask for
   the URL.
2. **The PRD or idea.** Required for B. A GDoc link, a local file, or text in chat.
3. **Where the mock goes.** Default: the matching project's `files/mock/` under
   `pm-workspace/projects/` if one exists, otherwise ask.

**Reuse before re-extracting.** If `<repo>/design-systems/<product>/` already has a folder less
than 30 days old, use the newest one for B and only top it up with components the PRD needs and it
lacks. Otherwise run A first.

## A. Design system

### A1. Open and map the product

```bash
node agent/pb.mjs open <non-prod url>      # prints tab id + outline + screenshot path
```

Read the screenshot (the Read tool on the PNG) and the outline. The sidebar or top nav gives the
page list. Collapsed nav groups (`Configuration ▶`) are `click`ed open to reveal their routes.

### A2. Walk pages against the checklist

For each page worth visiting (start with the ones the PRD touches, then the main list pages):

1. `click` its nav item, or `navigate <url>`. The response arrives after the page has settled.
2. `styles --tab <id> --save <ds>/raw/styles-<page>.json` for the style census.
3. `capture --tab <id>` for the full page. Record the returned `originalFile`.
4. For each checklist component visible on that page, capture it on its own:
   `capture --tab <id> --ref <region-or-item ref>`. Use a region ref where one exists.
5. Open things that reveal more components (an edit icon, "New test", a dropdown, a tab), capture
   what opened, then `escape`. If a click is refused, that is the guard working. Move on.

**Checklist.** Tick each item with the page and capture it came from:

- Page shell: side or top navigation, page header (breadcrumb and title), content background
- Buttons: primary, secondary, disabled, icon-only
- Links
- Form controls: text input, search field, select or dropdown, checkbox, radio, toggle
- Table: header row, body row, row actions, pagination, empty table
- Tabs
- Card or panel
- Dialog or modal
- Tree or hierarchical picker
- Date picker
- Toast, alert or banner
- Badge or status pill
- Tooltip
- Empty state, error state, loading state

**Stop when** every item is captured or has been looked for on the pages the product has, or after
about 15 pages, whichever comes first. Anything never found is written up as **not found**, and if
B needs it later it is built as **inferred**: closest real component, clearly labelled.

### A3. Write the design-system folder

Path: `<repo>/design-systems/<product-slug>/<YYYY-MM-DD>/`. Gitignored; keep it that way.

| File | Contents |
|---|---|
| `tokens.json` | Every token with its value, where it was measured (page and capture) and its usage count from the census. Groups: color (ground, surface, text, muted text, accent, accent-on-tint, border, divider, danger, success), type (families, the size/weight/line-height scale, body size), radius, shadow, spacing (paddings and gaps that recur), layout (nav width, header height) |
| `tokens.css` | The same as CSS custom properties on `:root`. Reuse the product's own custom property names when the census found them (`rootCustomProperties`) |
| `components/<name>.html` | One element capture per checklist item, copied from the capture's `original.html`, so each opens standalone with the product's real CSS |
| `components/index.md` | Component name, source page, source capture slug, and the real class names that style it |
| `shell.html` | The full-page capture that best represents the product's layout, used as the base for mocks |
| `assets/` | Logo and icons as real SVG or images lifted from the captures |
| `coverage.md` | The checklist: captured (with source), or not found |
| `css/` | `fonts.css` and one `rules-<hash>.css` per distinct captured sheet, written by `ds-pack.py` |
| `catalog.html` | A browsable catalog: token swatches, the type scale, and every component rendered live from its file (an iframe per component, real CSS), with its family, source page and real class names. Follows the workspace HTML standard for its own chrome; the components inside keep product fidelity |
| `README.md` | Product, host, date, pages visited, what came up empty because of the write block, and how to use the folder |

**Pack it, then build the catalog.** Once the captures are copied in and listed in
`raw/index.json`, run `python3 agent/ds-pack.py <ds>`. It moves every file's stylesheet into
`css/` (one shared `fonts.css`, plus each capture's own rules sheet, stored once per distinct
sheet) and links it, which took CMS from 263 MB to 36 MB with 0 computed-style differences.
Never merge different pages' rules into one sheet: a global reset loaded on one page breaks
another page's components. Then write `catalog.html` (see A4).

**Picking a token from the census.** The most-used value in a group is the system value. A value
used once is a one-off, not a token. Text colors are weighted by characters, so the top one is
body text. Check a token against the screenshot before trusting it (a census can be skewed by a
long table in one color).

### A4. Check it and report

Open two or three `components/*.html` files and `shell.html` in the Browser pane (they are local
files) and compare them with the screenshots. Report to the user: coverage (captured / not found),
the tokens in one short table, and anything that looked off.

## B. Mock from a PRD or idea

### B1. Understand the ask before building

Read the PRD. List the screens and states it needs, and which checklist components each uses. If
it is a raw idea, propose that screen list in chat and wait for agreement before building.

### B2. Build from real markup, not from scratch

The highest-fidelity route, and the default:

1. Start from `shell.html` (real navigation, header and CSS) and save it as the mock file.
2. Replace the content area with the new screen, **assembled from the markup in
   `components/*.html`**, keeping their real class names so the product's own stylesheet (already
   inside the shell) styles them. Change text and structure, not styling.
3. New styling goes in one small `<style>` block at the end, using only `tokens.css` values.
4. Anything the product has no component for is **inferred**: built from the nearest real one,
   and listed in the README.

Data in the mock is either real (a small sample only: a few rows, never a full dataset) or
labelled illustrative in the README.

### B3. Rules the mock follows

- **Product fidelity wins over the workspace HTML standard.** A mock of a product surface uses
  the product's measured values, even where the standard would ask otherwise (contrast, body size,
  font stack). The standard itself says it does not govern real product UI. Every such deviation is
  listed in the README, never silently corrected in the mock.
- **No commentary on the page.** No review chips, "new" markers, notes or footers. The mock shows
  only the product. Provenance goes in the README.
- **Standalone.** One HTML file that opens from disk.

### B4. README next to the mock

What the mock shows (screens and states), which design-system folder it was built from (path and
date), what is real versus illustrative, what is inferred, and the deviations from the workspace
standard. Then open the mock in the Browser pane, compare against the shell's screenshot, and share
a screenshot with the user.

## Anti-patterns

- **Re-styling a component from scratch** when its capture exists. The capture is the answer.
- **Treating an empty list as a bug.** The write block or an empty non-prod environment explains
  it. Say which, and move on.
- **Clicking harder when a click is refused.** A refusal means the button commits something.
- **Publishing or committing a capture, a design-system folder or a mock.** All local.
- **Asking the user to paste a cookie or log in through the agent.** They log in in their own
  browser; Page Bender uses that session.
