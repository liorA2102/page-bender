# Page Bender

Freeze a live page into a standalone, editable HTML mock. Then prototype on
it with Claude — new layouts, new copy, new components — without touching
the real app. Export a clean diff or the finished HTML when you're done.

A Chrome extension (capture + in-page toolbar) plus a local Node server
(the Claude Agent SDK session that does the editing).

## How it works

1. **Capture** — click the extension on any live page. It clones the real
   DOM and copies the page's real CSS/fonts into one file. No auth, no live
   JS — the frozen copy has no dependency on the original site once made.
2. **Prototype** — describe a change in plain language in the mock's
   toolbar. Claude edits the markup directly, in place.
3. **Export** — pull a diff for handoff, or download the finished HTML on
   its own.

## Requirements

- macOS
- [Node.js](https://nodejs.org)
- Google Chrome
- [Claude Code](https://docs.claude.com/en/docs/claude-code) installed and
  logged in — the server runs the editing agent through your own login, no
  separate API key needed

## Setup

```
git clone https://github.com/liorA2102/page-bender.git
cd page-bender/server
./setup.command
```

`setup.command` installs the server as a background (launchd) agent so
it's always running, checks that Node and the Claude Code CLI are present,
and opens Chrome + Finder to the extension folder for the last step:

1. In the `chrome://extensions` tab that opens, turn on **Developer Mode**
   (top-right).
2. Click **Load unpacked**.
3. Pick the folder that's already highlighted in Finder.

### Updating

```
git pull
./server/setup.command
```

### Uninstalling

```
./server/uninstall.command
```
(then remove the extension from `chrome://extensions` manually)

## Before you install

The server runs the editing agent with full tool access, including shell
commands, and no sandbox — a deliberate trade-off for how capable the
editing feels, not an oversight. Only install this on a machine you're
comfortable with that.

## Status

Actively developed — see [PLAN.md](PLAN.md) for the running design log.
