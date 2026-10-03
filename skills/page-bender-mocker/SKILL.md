---
name: page-bender-mocker
description: Turn a PRD or a raw idea into a high-fidelity HTML mock of a real product, designed in that product's own visual language and dressed in its captured parts. The agent drives the product in the user's browser through Page Bender (non-prod hosts only, every write blocked), captures real pages and components, extracts a dated design system (tokens, components, page shell, coverage), then designs the mock with it and swaps in captured parts where they win. Use when the user says "mock this PRD", "mock this idea in <product>", "build a design system for <product>", "extract <product>'s design system", "capture <product>'s components", or shares a PRD or idea together with a non-prod URL. Do NOT use for editing an existing captured mock by chat (that is the Page Bender toolbar), or for prototypes that should follow the workspace HTML standard rather than a real product.
---

# Page Bender Mocker

Two jobs, run in order, and the second reuses the first:

- **A. Design system.** Explore one product on a non-prod host, capture real pages and
  components, and write a dated design-system folder.
- **B. Mock.** Build the mock of a PRD or idea from that folder.

**What a mock is for.** Its first job is to promote the feature: make the idea obvious and look
like the product at its best. It is not necessarily what gets built, though a mock the implementing
agent can follow without inventing new UI is a real bonus, delivered through the README's
implementation map rather than by forcing the page to be literal fragments.

**What "close to production" means.** The mock looks like the product at its best: its measured
colours, type and spacing, its real logo and icons, one coherent visual family per screen, and
captured parts wherever a captured part is clearly better than a drawn one (the shell nearly
always). Every value either comes from a capture or is labelled in the README. Nothing is
invented silently. Literal fidelity of every fragment is not the goal: a screen assembled from a
product's oldest parts, or from parts of different generations, is faithful piece by piece and
wrong as a whole (measured on CMS, 30 Sep 2026: judged "very poor" against a designed mock).

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
- **The agent works in background tabs** of the user's own window, in an expanded "Page Bender"
  tab group, and nothing has to stay on screen. Chrome shows "Page Bender started debugging this
  browser" while it works. If the user presses Cancel on that bar, the run stops with a clear
  error: say so and stop, do not retry.
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

Design first, then swap in captured parts. Proven on CMS (Global ABT v2, 30 Sep 2026): a designed
mock with CMS's captured sidebar, fonts, buttons and pills swapped in beat both the designed mock
alone and a mock assembled only from captured fragments.

### B1. Understand the ask before building

Read the PRD. List the screens and states it needs, and which checklist components each uses. If
it is a raw idea, propose that screen list in chat and wait for agreement before building. Settle
how much behaviour the mock needs: static screens and states are enough to judge the design;
working logic (validation, rebalancing, pickers) only when the review needs to feel it.

**Pick one family** from the design system's README: the family of the page the feature extends,
or the product's newest family for a new area. Every screen of the mock uses that one family by
default. The one exception is a concept the user picks in B1b from another library the product
already ships (on CMS: Ant Design Steps chosen for a Legacy-family page, because it shows the
off-path states on the path itself); the README names that crossing.

### B1b. Close the gaps: research concepts for what the product has never had

Check B1's component list against the design system's `coverage.md` and `components/index.md`.
Anything the feature needs that the product has no component for is a **gap** (on CMS for Global
ABT v2: the lifecycle stepper, the variant editor, the share slider, dialogs). Each gap gets
researched before it is designed, so it is solved the way the product would solve it, not
invented on the spot.

**Where to look, in this order, stopping at the first good answer:**

1. **The product itself.** Another page or family may already solve it. Drive more pages if the
   design system didn't cover them (A2's rules apply).
2. **The component libraries the product already ships.** Read them from the capture: CMS loads Ant
   Design (`ant-` classes) and MUI (`Mui` classes). A component from a library already in the
   bundle is the most on-brand answer and the easiest for an implementing agent (for example Ant's
   Steps for a stepper). Use the library's public docs for its variants and states.
3. **Established public design systems** (Material, Carbon, Atlassian, Polaris) for the standard
   way to solve a common pattern.
4. **Comparable products** for domain-specific concepts (for an experiment tool: how GrowthBook,
   Statsig or LaunchDarkly show variant splits). Public pages and docs only.

**Propose two or three concepts per gap, then let the user pick.** Each concept states: a name,
where it comes from (with a link), why it fits this product and this feature, and an
implementation note (for example "Ant Steps, already in CMS's bundle"). How to present them:

- **In chat, by default:** a short list per gap.
- **As a concept board when the gap is visual,** meaning its choice turns on layout or
  interaction shape rather than wording: steppers and progress, editors and multi-part controls,
  sliders and allocation controls, dialogs and drawers, charts and timelines, tables with unusual
  structure. A gap about wording or rules (an empty-state message, a validation rule, a label)
  stays in chat.

A **concept board** is one local HTML page next to the mock (`concepts-<gap>.html`): each concept
sketched side by side, in the product's visual language (its tokens, its fonts), with the name,
source and implementation note under each. Its own chrome follows the workspace HTML standard; the
sketches keep product fidelity. Local only, like the mock.

**Record the outcome** in the mock's folder as `concepts.md`: every gap, the concepts offered, the
one chosen and why. The README's inferred list then points to it, and B5's implementation map uses
the chosen concept's implementation note.

### B2. Design the screens in the product's visual language

Compose each screen with real design judgment (use the `frontend-design` skill when it is
available), working from:

- `tokens.json` for the chosen family: colours, type scale, radii, shadows, spacing. Declare them
  as custom properties once and read only those.
- The product's layout conventions, measured from `shell.html` and the pages: sidebar width,
  header band, content ground, card surfaces, table density.
- The real logo and icons from `assets/` or the captures, never redrawn.

Structure and hierarchy are the agent's to design; values are the product's to dictate. A screen
that needs something the product has never had (a stepper, a variant editor) is designed in the
product's language and listed as **inferred** in the README.

### B3. Swap in captured parts where they are a clear win

After the screens are designed, replace drawn parts with captured ones only where the captured
part is clearly better and belongs to the chosen family. On CMS that was:

- **The shell:** the real sidebar markup, with only the rules naming its classes
  (`ds-mock-kit.py`: `fragment()` then `rules_naming()`). Nearly always a win.
- **Fonts:** embed only the faces the mock uses, from `css/fonts.css`.
- **Buttons and status pills:** their measured values (or real markup when it fits the design).
- Anything else only if it is the same family and at least as good as the designed version.

Never mix families on one screen, and never pick a part just because it was captured. Lessons from
composing with captures: put a fragment back inside the product's own containers (its rules are
scoped to them); a captured dropdown's content lives in the capture's `.pbx-section-overlay`; read
the product's markup before templating it (CMS puts `data-qa-id` before `class`, and draws
breadcrumb separators with `a:after`), and key text replacements on stable attributes such as
`data-qa-id`, not on class names.

### B4. Rules the mock follows

- **Product fidelity wins over the workspace HTML standard** on a product surface: the product's
  fonts, sizes, colours and contrast, even where the standard would ask otherwise. Every such
  deviation is listed in the README, never silently corrected.
- **No commentary on the page.** No review chips, "new" markers, notes or footers. A thin strip of
  mock controls (switch screen, state or theme) is fine; explanation is not.
- **Data:** a small real sample, or labelled illustrative in the README. Never a data point the
  product doesn't hold.
- **Standalone.** One HTML file that opens from disk.

### B5. README next to the mock

What the mock shows (screens, states, how to reach them), which design-system folder and family it
was built from, what is real versus illustrative, what is inferred, the deviations from the
workspace standard, and an **implementation map**: each part of the mock against the real product
component it corresponds to (source page, capture, real class names), so an implementing agent can
reach for the product's own component instead of inventing one.

### B6. Check it and share

Open it in the Browser pane over http (`python3 -m http.server`), step through every screen and
state, in light and dark if the mock has both, and compare against the shell's screenshot. Share a
screenshot with the user and ask for a verdict before calling it done.

## Anti-patterns

- **Assembling a screen from literal fragments** of whatever was captured, especially the
  product's oldest screens or several generations at once. Design the screen; swap in parts.
- **Redrawing the shell, logo or icons** when captures of them exist. Those are always swapped in.
- **Treating an empty list as a bug.** The write block or an empty non-prod environment explains
  it. Say which, and move on.
- **Clicking harder when a click is refused.** A refusal means the button commits something.
- **Publishing or committing a capture, a design-system folder or a mock.** All local.
- **Asking the user to paste a cookie or log in through the agent.** They log in in their own
  browser; Page Bender uses that session.
