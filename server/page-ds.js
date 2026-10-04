// A page's own design language, for when there is no design system to
// build from: a product Page Bender doesn't know, or no running copy to
// learn from. The captured page already carries its real CSS and real
// components, and its class names say which library it is built on. So the
// editing agent copies what the page has and builds what it lacks the way
// that library builds it, in the page's measured colours, type and radii.
import { elementAt, findLandmark } from "./outline.js";
import { cleanPart } from "./ds-parts.js";

// Component libraries, recognised by the class names they leave in the
// DOM. `min` is how many matches it takes, so a stray class doesn't count.
const LIBRARIES = [
  { name: "Material UI (MUI)", re: /\bMui[A-Z][A-Za-z]*-root\b/g, min: 3 },
  { name: "Ant Design", re: /\bant-[a-z][\w-]*/g, min: 5 },
  { name: "Bootstrap", re: /\b(btn-(primary|secondary|outline-[a-z]+)|col-(xs|sm|md|lg|xl)-\d+|navbar-expand[\w-]*|form-control|card-body)\b/g, min: 3 },
  { name: "Tailwind CSS", re: /\b(px|py|mx|my|mt|mb|pt|pb)-\d+\b|\btext-(xs|sm|base|lg|xl)\b|\b(bg|text|border)-[a-z]+-\d{2,3}\b|\brounded-(sm|md|lg|xl|full)\b/g, min: 30 },
  { name: "Chakra UI", re: /\bchakra-[a-z][\w-]*/g, min: 3 },
  { name: "Mantine", re: /\bmantine-[A-Za-z][\w-]*/g, min: 3 },
  { name: "Radix / shadcn", re: /data-radix-[a-z-]+|\bdata-state="(open|closed|active|inactive)"/g, min: 3 },
  { name: "Salesforce Lightning (SLDS)", re: /\bslds-[a-z][\w-]*/g, min: 5 },
  { name: "Carbon", re: /\b(cds|bx)--[a-z][\w-]*/g, min: 5 },
  { name: "Shopify Polaris", re: /\bPolaris-[A-Z][\w-]*/g, min: 3 },
  { name: "Fluent UI", re: /\b(fui-[A-Z][\w-]*|ms-[A-Z][a-z]+(-[a-z]+)?)\b/g, min: 5 },
  { name: "Vuetify", re: /\bv-(btn|card|list|data-table|text-field)\b/g, min: 3 },
  { name: "Material Components (MDC)", re: /\bmdc-[a-z][\w-]*/g, min: 5 },
  { name: "Semantic UI", re: /\bui (button|segment|menu|table|label)\b/g, min: 3 },
  { name: "styled-components", re: /\bsc-[a-zA-Z]{5,}\b/g, min: 10, styling: true },
];

export function detectLibraries(html) {
  const body = html.slice(Math.max(0, html.search(/<body[\s>]/i)));
  // Component libraries first, then styling tools (styled-components says
  // how CSS is written, not which components the page is built from).
  return LIBRARIES.map((lib) => ({ name: lib.name, count: (body.match(lib.re) || []).length, min: lib.min, styling: !!lib.styling }))
    .filter((l) => l.count >= l.min)
    .sort((a, b) => a.styling - b.styling || b.count - a.count)
    .map(({ name, count, styling }) => ({ name, count, styling }));
}

// The page's own components, one example of each kind, from the main
// content area when the capture marked one. They are already styled on this
// page, so they can be copied as they are.
const KINDS = [
  { kind: "primary button", re: /<(button|a)(?=[\s>])[^>]*class="[^"]*(MuiButton-contained|ant-btn-primary|btn-primary|primary)[^"]*"[^>]*>/i },
  { kind: "button", re: /<button(?=[\s>])[^>]*class="[^"]*"[^>]*>/i },
  { kind: "text field", re: /<(div|span)(?=[\s>])[^>]*class="[^"]*(MuiTextField-root|ant-input-affix-wrapper|ant-input-group-wrapper|form-group)[^"]*"[^>]*>|<input(?=[\s>])[^>]*type="(text|search|email)"[^>]*>/i },
  { kind: "select", re: /<(div)(?=[\s>])[^>]*class="[^"]*(MuiFormControl-root|ant-select)[^"]*"[^>]*>|<select(?=[\s>])[^>]*>/i },
  { kind: "table", re: /<table(?=[\s>])[^>]*>|<div(?=[\s>])[^>]*class="[^"]*MuiDataGrid-root[^"]*"[^>]*>|<div(?=[\s>])[^>]*role="grid"[^>]*>/i },
  { kind: "status pill / tag", re: /<(span|div)(?=[\s>])[^>]*class="[^"]*(MuiChip-root|ant-tag|badge|chip|pill|tag|status)[^"]*"[^>]*>/i },
  { kind: "tabs", re: /<(div|ul|nav)(?=[\s>])[^>]*role="tablist"[^>]*>/i },
  { kind: "card", re: /<(div|section)(?=[\s>])[^>]*class="[^"]*(MuiCard-root|MuiPaper-root|ant-card|card|panel)[^"]*"[^>]*>/i },
  { kind: "checkbox / switch", re: /<(span|label)(?=[\s>])[^>]*class="[^"]*(MuiSwitch-root|MuiCheckbox-root|ant-switch|ant-checkbox-wrapper|form-check|switch)[^"]*"[^>]*>|<input(?=[\s>])[^>]*type="checkbox"[^>]*>/i },
  { kind: "radio", re: /<(span|label)(?=[\s>])[^>]*class="[^"]*(MuiRadio-root|ant-radio-wrapper)[^"]*"[^>]*>|<input(?=[\s>])[^>]*type="radio"[^>]*>/i },
  { kind: "pagination", re: /<(div|nav|ul)(?=[\s>])[^>]*class="[^"]*(MuiTablePagination-root|MuiPagination-root|ant-pagination|pagination)[^"]*"[^>]*>/i },
  { kind: "breadcrumbs", re: /<(div|nav|ol)(?=[\s>])[^>]*class="[^"]*(MuiBreadcrumbs-root|ant-breadcrumb|breadcrumb)[^"]*"[^>]*>/i },
];
const MAX_PAGE_PART = 12000;

export function pageParts(html) {
  const main = findLandmark(html, "main");
  const from = main ? main.openEnd : Math.max(0, html.search(/<body[\s>]/i));
  const to = main ? main.closeStart : html.length;
  const region = html.slice(from, to);
  const parts = [];
  for (const k of KINDS) {
    const m = region.match(k.re);
    if (!m) continue;
    const el = elementAt(html, from + m.index);
    if (!el) continue;
    const markup = cleanPart(html.slice(el.start, el.closeEnd));
    if (markup.length > MAX_PAGE_PART || parts.some((p) => p.markup === markup)) continue;
    parts.push({ kind: k.kind, markup });
  }
  return parts;
}

// The measured values worth handing over, from the census taken on the
// live page at capture (agent-driver.js styles()).
export function tokenSummary(census) {
  if (!census || !census.ok) return null;
  const list = (arr, n) => (arr || []).slice(0, n).map((x) => (Array.isArray(x) ? `${x[0]} (${x[1]})` : x.value ? `${x.value} (${x.count})` : String(x))).join(", ");
  const vars = census.rootCustomProperties ? Object.entries(census.rootCustomProperties).slice(0, 40).map(([k, v]) => `${k}: ${v}`).join("; ") : "";
  return [
    `body: ${census.body ? `${census.body.fontFamily}, ${census.body.fontSize}, text ${census.body.color} on ${census.body.background}` : "?"}`,
    `text colours (by characters): ${list(census.textColors, 6)}`,
    `backgrounds: ${list(census.backgrounds, 6)}`,
    `borders: ${list(census.borders, 4)}`,
    `font families: ${list(census.fontFamilies, 3)}`,
    `type scale (size / weight / line height): ${list(census.typeScale, 6)}`,
    `radii: ${list(census.radii, 5)}`,
    `shadows: ${list(census.shadows, 3)}`,
    `paddings: ${list(census.paddings, 5)}`,
    `gaps: ${list(census.gaps, 4)}`,
    vars && `root CSS variables: ${vars}`,
  ].filter(Boolean).join("\n");
}
