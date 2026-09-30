#!/usr/bin/env python3
"""Helpers for building a mock from a packed design-system folder (mode B of the skill).

Imported by a mock's own build script, which holds the screens' content:

    import importlib.util, sys
    spec = importlib.util.spec_from_file_location("kit", "<repo>/agent/ds-mock-kit.py")
    kit = importlib.util.module_from_spec(spec); spec.loader.exec_module(kit)
    k = kit.Kit("<repo>/design-systems/cms/2026-09-29")
    frag = k.fragment("components/page-form.html", "//div[contains(@class,'generalSetup-module__dataRow')]")
    k.write_mock(out_path, shell="shell.html", replace_xpath="//div[contains(@class,'GlobalABTest_content')]",
                 content_html="...", borrowed=[frag], extra_css="...", script="...", title="...")

What it guarantees, so a mock stays as close to the product as the captures are:

- The shell's own stylesheet is inlined whole, exactly as captured, with the shared fonts.
- A fragment borrowed from another capture brings only the rules from *its* capture's
  stylesheet whose selectors name one of the fragment's own classes (inside @media blocks too),
  minus rules the shell already has. Global rules (element selectors, resets) are never
  borrowed: measured on CMS, one page's `.MuiButtonBase-root { border: 0 }` broke another page's
  buttons when whole sheets were merged.
- Page Bender's `.pbx-ancestor` wrappers keep working (`display: contents`), so rules scoped to a
  container still match.
- The output is one standalone HTML file.

Reads only the design-system folder; writes only the mock file it is given.
"""

import json
import os
import re

import lxml.html
from lxml import etree

STYLE_RE = re.compile(r"<style[^>]*>(.*?)</style>", re.S)
LINK_RE = re.compile(r'<link rel="stylesheet" href="([^"]+)">')


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


def selector_names_class(selector, classes):
    names = set(re.findall(r"\.(-?[_a-zA-Z][\w-]*)", selector.replace("\\", "")))
    return bool(names & classes)


def rules_naming(css, classes):
    """Top-level rules (and filtered @media / @supports blocks) whose selectors name a class."""
    kept = []
    for rule in top_rules(css):
        if rule.startswith("@font-face") or rule.startswith("@import") or rule.startswith("@charset"):
            continue
        if rule.startswith("@keyframes") or rule.startswith("@-webkit-keyframes"):
            continue  # animations are pulled in separately, by name, below
        if rule.startswith("@media") or rule.startswith("@supports") or rule.startswith("@layer"):
            head, inner = rule.split("{", 1)
            inner = inner.rsplit("}", 1)[0]
            sub = [r for r in top_rules(inner) if "{" in r and selector_names_class(r.split("{", 1)[0], classes)]
            if sub:
                kept.append(head.strip() + " {\n" + "\n".join(sub) + "\n}")
            continue
        if "{" in rule and selector_names_class(rule.split("{", 1)[0], classes):
            kept.append(rule)
    # Animations the kept rules refer to, by name.
    names = set(re.findall(r"animation(?:-name)?\s*:\s*([\w-]+)", "\n".join(kept)))
    if names:
        for rule in top_rules(css):
            m = re.match(r"@(?:-webkit-)?keyframes\s+([\w-]+)", rule)
            if m and m.group(1) in names:
                kept.append(rule)
    return kept


class Fragment:
    def __init__(self, html, classes, source):
        self.html = html
        self.classes = classes
        self.source = source  # the design-system-relative file it came from


class Kit:
    def __init__(self, ds):
        self.ds = ds.rstrip("/")
        self.pack = json.load(open(os.path.join(self.ds, "raw", "pack.json")))
        self._docs = {}

    # ---------- reading captures ----------
    def _text(self, rel):
        return open(os.path.join(self.ds, rel), encoding="utf-8").read()

    def doc(self, rel):
        if rel not in self._docs:
            self._docs[rel] = lxml.html.document_fromstring(self._text(rel))
        return self._docs[rel]

    def sheet_of(self, rel):
        return self._text(os.path.join("css", self.pack["sheetOf"][rel]))

    def fragment(self, rel, xpath, index=0):
        """Real markup of one element in a capture, with every class it and its subtree use."""
        found = self.doc(rel).xpath(xpath)
        if not found:
            raise ValueError(f"no match for {xpath} in {rel}")
        el = found[index]
        classes = set()
        for node in el.iter():
            if isinstance(node.tag, str):
                classes.update((node.get("class") or "").split())
        # Ancestors' classes too: rules scoped to a container ("inside .x, style .y") need them.
        for anc in el.iterancestors():
            classes.update((anc.get("class") or "").split())
        html = etree.tostring(el, encoding="unicode", method="html")
        return Fragment(html, classes, rel)

    def fonts(self):
        return self._text(os.path.join("css", "fonts.css"))

    # ---------- writing the mock ----------
    def write_mock(self, out_path, shell, replace_xpath, content_html, borrowed=(), extra_css="",
                   script="", title=None, edits=()):
        """One standalone file: shell markup with its content area replaced, CSS inlined.

        edits: (xpath, callable(element)) pairs applied to the shell before writing, for the
        header's breadcrumb, title and buttons.
        """
        shell_doc = lxml.html.document_fromstring(self._text(shell))
        target = shell_doc.xpath(replace_xpath)
        if not target:
            raise ValueError(f"shell has no {replace_xpath}")
        target = target[0]
        for child in list(target):
            target.remove(child)
        target.text = None
        for node in lxml.html.fragments_fromstring(content_html):
            if isinstance(node, str):
                target.text = (target.text or "") + node
            else:
                target.append(node)
        for xp, fn in edits:
            for el in shell_doc.xpath(xp):
                fn(el)
        head = shell_doc.find("head")
        for link in head.findall("link"):
            head.remove(link)
        if title:
            t = head.find("title")
            if t is not None:
                t.text = title

        shell_sheet = self.sheet_of(shell)
        shell_rules = set(top_rules(shell_sheet))
        borrowed_css, report = [], []
        for frag in borrowed:
            rules = [r for r in rules_naming(self.sheet_of(frag.source), frag.classes) if r not in shell_rules]
            for r in rules:
                shell_rules.add(r)
            borrowed_css.extend(rules)
            report.append((frag.source, len(rules)))

        css_blocks = [
            ("fonts", self.fonts()),
            ("product stylesheet, as captured with the shell", shell_sheet),
            ("rules borrowed for fragments from other captures", "\n".join(borrowed_css)),
            ("Page Bender wrappers", ".pbx-ancestor { display: contents !important; }"),
            ("mock layout, tokens only", extra_css),
        ]
        for label, css in css_blocks:
            if css:
                style = etree.SubElement(head, "style")
                style.set("data-part", label)
                style.text = "\n" + css + "\n"
        if script:
            body = shell_doc.find("body")
            s = etree.SubElement(body, "script")
            s.text = "\n" + script + "\n"
        html = "<!doctype html>\n" + etree.tostring(shell_doc, encoding="unicode", method="html")
        if '<meta name="viewport"' not in html:
            html = html.replace("<head>", '<head>\n<meta name="viewport" content="width=device-width, initial-scale=1">', 1)
        with open(out_path, "w", encoding="utf-8") as f:
            f.write(html)
        return {"bytes": len(html), "borrowed": report}
