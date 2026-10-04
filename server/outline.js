// The page outline: where a captured page's navigation, header and main
// content area sit in its file. The capture marks them on the live page
// (data-pb-landmark, see content.js); this finds the marks again in the
// current file, since every edit moves the offsets. The editing agent starts
// from the outline instead of searching a file whose body is a few lines of
// 100,000+ characters, and agent/pb-screens.mjs uses it to add screens.

const ROLES = ["nav", "header", "main"];

// The element whose opening tag carries data-pb-landmark="<role>": its
// opening tag's span and its matching closing tag's offset.
export function findLandmark(html, role) {
  const mark = html.indexOf(`data-pb-landmark="${role}"`);
  if (mark < 0) return null;
  const el = elementAt(html, html.lastIndexOf("<", mark));
  return el && { role, ...el };
}

// The element whose opening tag starts at `start`: its tag, where the
// opening tag ends, and its matching closing tag.
export function elementAt(html, start) {
  const openEnd = html.indexOf(">", start) + 1;
  const tag = (html.slice(start + 1).match(/^[a-zA-Z][\w-]*/) || [""])[0].toLowerCase();
  if (!tag || openEnd <= 0) return null;
  if (html[openEnd - 2] === "/" || /^(img|input|br|hr|meta|link|source|area|col|embed|wbr)$/.test(tag)) {
    return { tag, start, openEnd, closeStart: openEnd, closeEnd: openEnd };
  }
  // Matching close: count nested same-name tags after the opening tag.
  const re = new RegExp(`<(/?)${tag}(?=[\\s>/])[^>]*>`, "gi");
  re.lastIndex = openEnd;
  let depth = 1;
  let m;
  while ((m = re.exec(html))) {
    if (m[1]) depth--;
    else if (!m[0].endsWith("/>")) depth++;
    if (depth === 0) return { tag, start, openEnd, closeStart: m.index, closeEnd: m.index + m[0].length };
  }
  return null;
}

function lineOf(html, offset) {
  let line = 1;
  for (let i = html.indexOf("\n"); i >= 0 && i < offset; i = html.indexOf("\n", i + 1)) line++;
  return line;
}

// Short visible labels inside a span, for the navigation's items.
function labelsIn(html, from, to) {
  const out = [];
  const re = />\s*([^<>]{2,40}?)\s*</g;
  re.lastIndex = from;
  let m;
  while ((m = re.exec(html)) && m.index < to && out.length < 40) {
    const t = m[1].replace(/&amp;/g, "&").trim();
    if (/[a-z]/i.test(t) && !/^[{}<>]/.test(t) && !out.includes(t)) out.push(t);
  }
  return out;
}

export function pageOutline(html) {
  const found = ROLES.map((r) => findLandmark(html, r)).filter(Boolean);
  if (!found.length) return null;
  return found.map((l) => ({
    role: l.role,
    tag: l.tag,
    line: lineOf(html, l.start),
    offset: l.start,
    length: l.closeEnd - l.start,
    openTag: html.slice(l.start, Math.min(l.openEnd, l.start + 240)),
    labels: l.role === "nav" ? labelsIn(html, l.openEnd, l.closeStart) : undefined,
  }));
}

export function screensIn(html) {
  return [...html.matchAll(/data-pb-screen="([^"]*)"/g)].map((m) => m[1]);
}

// This page's own header (breadcrumb, title, actions): the first element
// in the main content area whose class says header and that holds the
// page's <h1>. Offered to the agent as a part, since it already sits right
// in this shell: a header borrowed from another page can lay its actions
// out differently (seen on CMS, 4 Oct 2026).
export function pageHeader(html) {
  const main = findLandmark(html, "main");
  if (!main) return null;
  const re = /<([a-zA-Z][\w-]*)(?=[\s>])[^>]*class="[^"]*header[^"]*"[^>]*>/gi;
  re.lastIndex = main.openEnd;
  let m;
  while ((m = re.exec(html)) && m.index < main.closeStart) {
    const el = elementAt(html, m.index);
    if (!el) continue;
    const markup = html.slice(el.start, el.closeEnd);
    if (/<h1[\s>]/i.test(markup) && markup.length <= 6000) return markup.replace(/\shref="https?:\/\/[^"]*"/g, ' href="#"');
  }
  return null;
}

