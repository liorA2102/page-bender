#!/usr/bin/env python3
"""Pack a design-system folder: shared fonts, one stylesheet per distinct capture sheet.

    python3 agent/ds-pack.py design-systems/<product>/<date>

Every Page Bender capture carries the product's whole stylesheet (several MB, fonts
embedded), so twenty component captures repeat the same CSS twenty times. This step moves
that CSS out of the files and links it instead:

- `css/fonts.css`: every `@font-face` rule from every capture, each distinct rule once. Apps
  often repeat the same rule hundreds of times, and where a font face sits has no effect on
  the cascade, so one shared file is safe.
- `css/rules-<hash>.css`: each capture's remaining rules, **exactly as captured, in its own
  order**. Captures that had the same sheet (components taken on the same page) share one
  file.

It deliberately does not merge different pages' rules into one sheet. Tried first on CMS and
measured wrong: a global reset loaded only on one page (`.MuiButtonBase-root { border: 0 }`)
landed after another page's button rule and stripped its border. A union of every page's CSS
is a state no real page was ever in.

It only reads the captures listed in `raw/index.json` (written during extraction) and writes
inside the design-system folder. It never touches the extension, the server or anything under
`mocks/`, where the original captures stay as they were.

Component files keep their captured markup exactly. Page Bender's stage styling (dark
backdrop, badge, halo) is switched off with a few overrides rather than removed, so the
capture's own rules for hoisted dropdowns and tooltips keep working.
"""

import hashlib
import json
import os
import re
import sys

STYLE_RE = re.compile(r"<style([^>]*)>(.*?)</style>", re.S)

# Turns the capture stage into a plain surface. Appended after the stage styles, so it wins.
STAGE_OVERRIDES = """
.pbx-section-stage { background: #fff !important; padding: 24px !important; min-height: 0 !important;
  align-items: flex-start !important; font-family: -apple-system, system-ui, sans-serif; }
.pbx-section-badge, .pbx-section-halo { display: none !important; }
.pbx-section-frame { box-shadow: none !important; border-radius: 0 !important; }
"""


def top_rules(css):
    """Split CSS into top-level rules by brace depth, respecting strings and comments."""
    out, depth, start, i, n, quote = [], 0, 0, 0, len(css), None
    while i < n:
        c = css[i]
        if quote:
            if c == "\\":
                i += 2
                continue
            if c == quote:
                quote = None
        elif c in "\"'":
            quote = c
        elif c == "/" and css.startswith("/*", i):
            j = css.find("*/", i + 2)
            i = j + 2 if j >= 0 else n
            continue
        elif c == "{":
            depth += 1
        elif c == "}":
            depth -= 1
            if depth == 0:
                out.append(css[start:i + 1].strip())
                start = i + 1
        elif c == ";" and depth == 0:
            out.append(css[start:i + 1].strip())
            start = i + 1
        i += 1
    tail = css[start:].strip()
    if tail:
        out.append(tail)
    return [r for r in out if r]


def split_head(html):
    """(head, body) of a capture; the product stylesheet is the head's first <style>."""
    cut = html.find("<body")
    return html[:cut], html[cut:]


def product_sheet(html):
    head, _ = split_head(html)
    m = STYLE_RE.search(head)
    return m.group(2) if m else ""


def split_fonts(sheet):
    """(font-face rules, other rules) of one sheet, both in their original order."""
    rules = top_rules(sheet)
    return [r for r in rules if r.startswith("@font-face")], [r for r in rules if not r.startswith("@font-face")]


def relink(html, hrefs, is_component):
    head, body = split_head(html)
    first = True

    def swap(m):
        nonlocal first
        if first:
            first = False
            return "".join(f'<link rel="stylesheet" href="{h}">' for h in hrefs)
        return m.group(0)

    head = STYLE_RE.sub(swap, head, count=0)
    if is_component:
        # Page Bender's own panel font is not needed once the stage is switched off.
        head = re.sub(r"@font-face\s*\{\s*font-family:\s*'PBX Chrome Sans'[^}]*\}", "", head)
        head = head.replace("</head>", f"<style>{STAGE_OVERRIDES}</style>\n</head>", 1)
    if '<meta name="viewport"' not in head:
        head = head.replace('<meta charset="utf-8">', '<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">', 1)
    return head + body


def main():
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    ds = sys.argv[1].rstrip("/")
    index = json.load(open(os.path.join(ds, "raw", "index.json")))
    targets = [(c["file"], True) for c in index["components"]] + [(p["file"], False) for p in index["pages"]]
    targets.append(("shell.html", False))

    sources = {}
    for rel, _ in targets:
        path = os.path.join(ds, rel)
        html = open(path, encoding="utf-8").read()
        if 'rel="stylesheet" href="' in html.split("<body", 1)[0] and "css/fonts.css" in html:
            sys.exit(f"{rel} is already packed; re-copy the captures before packing again")
        sources[rel] = html

    os.makedirs(os.path.join(ds, "css"), exist_ok=True)
    fonts, font_seen = [], set()
    sheet_of = {}
    written = {}
    total_faces = 0
    for rel, html in sources.items():
        faces, rules = split_fonts(product_sheet(html))
        total_faces += len(faces)
        for r in faces:
            if r not in font_seen:
                font_seen.add(r)
                fonts.append(r)
        text = "\n".join(rules)
        key = hashlib.sha1(text.encode()).hexdigest()[:10]
        sheet_of[rel] = f"rules-{key}.css"
        if key not in written:
            written[key] = len(text)
            with open(os.path.join(ds, "css", f"rules-{key}.css"), "w", encoding="utf-8") as f:
                f.write(text)
    fonts_text = "\n".join(fonts)
    with open(os.path.join(ds, "css", "fonts.css"), "w", encoding="utf-8") as f:
        f.write(fonts_text)

    before = sum(len(h) for h in sources.values())
    after = len(fonts_text) + sum(written.values())
    for rel, is_component in targets:
        up = "../" * rel.count("/")
        out = relink(sources[rel], [f"{up}css/fonts.css", f"{up}css/{sheet_of[rel]}"], is_component)
        with open(os.path.join(ds, rel), "w", encoding="utf-8") as f:
            f.write(out)
        after += len(out)

    stats = {"distinctRuleSheets": len(written), "fontFacesTotal": total_faces, "fontFacesKept": len(fonts),
             "sheetOf": sheet_of}
    stats.update({"files": len(targets), "bytesBefore": before, "bytesAfter": after})
    with open(os.path.join(ds, "raw", "pack.json"), "w") as f:
        json.dump(stats, f, indent=1)
    print(json.dumps(stats, indent=1))


if __name__ == "__main__":
    main()
