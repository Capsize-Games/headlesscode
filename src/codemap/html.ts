/**
 * Self-contained interactive HTML visualizer for the codemap.
 *
 * Produces ONE html file with inline CSS + vanilla JS and the codemap JSON
 * embedded — no external CDN, no server required: the acceptance criteria
 * say the map must open standalone in a browser with working
 * click-to-highlight and search. Layout is deterministic (BFS layers from
 * root modules, order within a layer by path), so the same repo always
 * renders the same picture.
 *
 * The inline JS deliberately avoids the browser's `</script>` sequence via
 * JSON escaping, keeps all state in plain module-scope variables, and is
 * dependency-free.
 */

import type { Codemap } from "./types.js"

/** Escape the embedded JSON so it can never terminate the <script> tag. */
function safeJson(value: Codemap): string {
	return JSON.stringify(value).replace(/</g, "\\u003c")
}

export function renderCodemapHtml(codemap: Codemap): string {
	const json = safeJson(codemap)
	return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>codemap — ${codemap.project}</title>
<style>
:root { color-scheme: dark; }
* { box-sizing: border-box; }
body {
  margin: 0; background: #0f1115; color: #d6d9df;
  font: 13px/1.45 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  height: 100vh; display: flex; flex-direction: column; overflow: hidden;
}
header {
  display: flex; align-items: center; gap: 14px; flex-wrap: wrap;
  padding: 10px 16px; background: #161a22; border-bottom: 1px solid #232936;
}
header h1 { font-size: 15px; margin: 0; color: #eef1f6; font-weight: 600; }
header .meta { color: #8b93a3; font-size: 12px; }
#search {
  flex: 1; min-width: 200px; max-width: 420px; background: #0f1115;
  color: #d6d9df; border: 1px solid #2c3442; border-radius: 6px;
  padding: 6px 10px; outline: none; font-size: 12px;
}
#search:focus { border-color: #5b8def; }
button {
  background: #1d2430; color: #d6d9df; border: 1px solid #2c3442;
  border-radius: 6px; padding: 5px 10px; cursor: pointer; font-size: 12px;
}
button:hover { background: #242d3d; }
.legend { display: flex; gap: 12px; align-items: center; flex-wrap: wrap; font-size: 11px; color: #aab2c0; }
.legend .swatch { display: inline-block; width: 9px; height: 9px; border-radius: 50%; margin-right: 4px; vertical-align: -1px; }
main { flex: 1; display: flex; min-height: 0; }
#graph { flex: 1; position: relative; min-width: 0; }
#graph svg { width: 100%; height: 100%; display: block; cursor: grab; }
#graph svg.dragging { cursor: grabbing; }
#hint {
  position: absolute; left: 14px; bottom: 10px; color: #6b7280; font-size: 11px;
  pointer-events: none; user-select: none;
}
.node { cursor: pointer; }
.node circle { stroke: #0f1115; stroke-width: 1.5; }
.node text { fill: #9aa3b2; font-size: 10px; pointer-events: none; }
.node.dim text { fill: #4a5261; }
.node.dim circle { opacity: 0.25; }
.node.highlight circle { stroke: #fff; stroke-width: 2; }
.edge { stroke: #3b4352; stroke-width: 1; }
.edge.include { stroke: #6b4f2a; }
.edge.call { stroke: #4fd08e; stroke-dasharray: 5 4; }
.edge.dim { opacity: 0.08; }
.edge.highlight { stroke: #5b8def; stroke-width: 1.6; }
.edge.highlight.include { stroke: #e2a14f; }
.edge.highlight.call { stroke: #4fd08e; }
#detail {
  width: 300px; border-left: 1px solid #232936; background: #141821;
  display: none; flex-direction: column; overflow-y: auto; flex-shrink: 0;
}
#detail.open { display: flex; }
#detail h2 { font-size: 12px; margin: 0; padding: 12px 14px 8px; color: #eef1f6; border-bottom: 1px solid #232936; position: sticky; top: 0; background: #141821; }
#detail .close { float: right; cursor: pointer; color: #8b93a3; }
#detail .body { padding: 12px 14px; }
#detail .kv { display: flex; gap: 8px; margin: 3px 0; }
#detail .kv .k { color: #8b93a3; width: 84px; flex-shrink: 0; }
#detail .kv .v { color: #d6d9df; word-break: break-all; }
#detail h3 { font-size: 11px; text-transform: uppercase; letter-spacing: .04em; color: #8b93a3; margin: 14px 0 6px; }
#detail ul { margin: 0; padding-left: 2px; list-style: none; }
#detail li { padding: 2px 0; }
#detail li a { color: #5b8def; cursor: pointer; text-decoration: none; }
#detail li a:hover { text-decoration: underline; }
#detail .empty { color: #6b7280; font-style: italic; }
.badge { display: inline-block; padding: 1px 7px; border-radius: 9px; font-size: 10px; color: #0f1115; }
</style>
</head>
<body>
<header>
  <h1>codemap — <span id="project"></span></h1>
  <span class="meta" id="meta"></span>
  <input id="search" type="search" placeholder="Filter modules by path… (e.g. engine/loop)">
  <button id="btnFit" title="Reset zoom &amp; pan">⌂ fit</button>
  <button id="btnZoomIn" title="Zoom in">+</button>
  <button id="btnZoomOut" title="Zoom out">−</button>
  <span class="legend">
    <span><span class="swatch" style="background:#5b8def"></span>source</span>
    <span><span class="swatch" style="background:#46c17b"></span>test</span>
    <span><span class="swatch" style="background:#22d3ee"></span>entrypoint</span>
    <span><span class="swatch" style="background:#f5a524"></span>config</span>
    <span><span class="swatch" style="background:#a78bfa"></span>vendor</span>
    <span><span class="swatch" style="background:#6b7280"></span>generated</span>
    <span><span class="swatch" style="background:#5b8def; width:0; height:0"></span><span style="color:#6b7280">— import</span></span>
    <span><span class="swatch" style="background:#e2a14f; width:0; height:0"></span><span style="color:#8b6b3a">— include</span></span>
    <span><span class="swatch" style="background:#4fd08e; width:0; height:0"></span><span style="color:#7fbf9a">-- call</span></span>
  </span>
</header>
<main>
  <div id="graph">
    <svg id="svg"></svg>
    <div id="hint">scroll to zoom · drag to pan · click a node to highlight its imports, calls and importers</div>
  </div>
  <aside id="detail">
    <h2><span id="detailTitle">Module</span><span class="close" id="detailClose">✕</span></h2>
    <div class="body" id="detailBody"></div>
  </aside>
</main>
<script>
"use strict";
const CODEMAP = ${json};

const ROLE_COLORS = {
  source: "#5b8def", test: "#46c17b", entrypoint: "#22d3ee",
  config: "#f5a524", vendor: "#a78bfa", generated: "#6b7280"
};
function edgeClass(kind) {
  return kind === "include" ? "edge include" : kind === "call" ? "edge call" : "edge";
}

// ── deterministic layout: BFS layers from root modules ─────────────────────
function layout(codemap) {
  const modules = codemap.modules;
  const byPath = new Map(modules.map((m, i) => [m.path, i]));
  const out = modules.map(() => []);
  const inc = modules.map(() => 0);
  for (const e of codemap.edges) {
    const fi = byPath.get(e.from);
    const ti = byPath.get(e.to);
    if (fi === undefined || ti === undefined) continue;
    out[fi].push(ti);
    inc[ti]++;
  }
  const layer = modules.map(() => -1);
  const queue = [];
  modules.forEach((m, i) => { if (inc[i] === 0) { layer[i] = 0; queue.push(i); } });
  let maxLayer = 0;
  let head = 0;
  while (head < queue.length) {
    const i = queue[head++];
    maxLayer = Math.max(maxLayer, layer[i]);
    for (const j of out[i]) {
      if (layer[j] === -1) { layer[j] = layer[i] + 1; queue.push(j); }
    }
  }
  // Anything unreachable from roots (a pure cycle) sits at the deepest layer.
  modules.forEach((m, i) => { if (layer[i] === -1) layer[i] = maxLayer + 1; });
  maxLayer = Math.max(...layer);

  const perLayer = new Map();
  modules.forEach((m, i) => {
    const l = layer[i];
    if (!perLayer.has(l)) perLayer.set(l, []);
    perLayer.get(l).push(i);
  });
  // Fixed logical canvas width: spreading every layer across its own width
  // makes the widest layer set the canvas size, which fit() then shrinks to
  // sub-pixel dots — a "blank" graph. A fixed width keeps the initial fit
  // legible; over-dense layers simply overlap and the zoom/search reveal
  // them (deliberate v1 tradeoff).
  const W = 2400;
  const ROW = 110;
  const H = (maxLayer + 1) * ROW + 80;
  const positions = modules.map(() => ({ x: 0, y: 0 }));
  for (const [l, arr] of perLayer) {
    const span = W - 120;
    const step = arr.length > 1 ? span / (arr.length - 1) : 0;
    arr.forEach((i, k) => {
      positions[i] = { x: 60 + k * step, y: 60 + l * ROW };
    });
  }
  return { W, H, positions, layer };
}

// ── render ─────────────────────────────────────────────────────────────────
const svg = document.getElementById("svg");
const NS = "http://www.w3.org/2000/svg";
const { W, H, positions, layer } = layout(CODEMAP);
svg.setAttribute("viewBox", "0 0 " + W + " " + H);
const viewport = document.createElementNS(NS, "g");
viewport.setAttribute("id", "viewport");
svg.appendChild(viewport);

const byPath = new Map(CODEMAP.modules.map((m, i) => [m.path, i]));
const nodeEls = [];
const labelEls = [];
const edgeEls = [];
const incoming = CODEMAP.modules.map(() => []);
const outgoing = CODEMAP.modules.map(() => []);
const importIn = CODEMAP.modules.map(() => []);
const importOut = CODEMAP.modules.map(() => []);
const callIn = CODEMAP.modules.map(() => []);
const callOut = CODEMAP.modules.map(() => []);

for (const e of CODEMAP.edges) {
  const fi = byPath.get(e.from);
  const ti = byPath.get(e.to);
  if (fi === undefined || ti === undefined) continue;
  outgoing[fi].push(ti);
  incoming[ti].push(fi);
  if (e.kind === "call") {
    callOut[fi].push(ti);
    callIn[ti].push(fi);
  } else {
    importOut[fi].push(ti);
    importIn[ti].push(fi);
  }
}

// edges first (under nodes)
for (const e of CODEMAP.edges) {
  const fi = byPath.get(e.from);
  const ti = byPath.get(e.to);
  if (fi === undefined || ti === undefined) continue;
  const a = positions[fi];
  const b = positions[ti];
  const line = document.createElementNS(NS, "line");
  line.setAttribute("x1", a.x); line.setAttribute("y1", a.y);
  line.setAttribute("x2", b.x); line.setAttribute("y2", b.y);
  line.setAttribute("class", edgeClass(e.kind));
  line.setAttribute("data-kind", e.kind);
  line.setAttribute("data-from", e.from);
  line.setAttribute("data-to", e.to);
  viewport.appendChild(line);
  edgeEls.push(line);
}

// nodes
CODEMAP.modules.forEach((m, i) => {
  const g = document.createElementNS(NS, "g");
  g.setAttribute("class", "node");
  g.setAttribute("data-path", m.path);
  g.setAttribute("transform", "translate(" + positions[i].x + "," + positions[i].y + ")");
  const circle = document.createElementNS(NS, "circle");
  circle.setAttribute("r", 7);
  circle.setAttribute("fill", ROLE_COLORS[m.role] || "#5b8def");
  const label = document.createElementNS(NS, "text");
  label.setAttribute("x", 10);
  label.setAttribute("y", 3);
  label.textContent = m.path.split("/").pop() || m.path;
  const title = document.createElementNS(NS, "title");
  title.textContent = m.path + "  [" + m.role + "]";
  g.appendChild(circle);
  g.appendChild(label);
  g.appendChild(title);
  g.addEventListener("click", (ev) => { ev.stopPropagation(); selectNode(i); });
  viewport.appendChild(g);
  nodeEls.push(g);
  labelEls.push(label);
});

// ── zoom / pan ─────────────────────────────────────────────────────────────
let k = 1, tx = 0, ty = 0, dragging = false, lastX = 0, lastY = 0;
// Labels only pay for themselves when zoomed in far enough to read them;
// below that they are pure clutter (esp. on 2k+ node repos).
const LABEL_MIN_SCALE = 0.5;
function applyTransform() {
  viewport.setAttribute("transform", "translate(" + tx + "," + ty + ") scale(" + k + ")");
  const show = k >= LABEL_MIN_SCALE;
  labelEls.forEach((el) => { el.style.display = show ? "" : "none"; });
}
function fit() {
  const rect = svg.getBoundingClientRect();
  k = Math.min(rect.width / W, rect.height / H);
  // Fit-to-tiny is worse than no fit: never shrink below legibility.
  k = Math.max(0.4, Math.min(k, 1));
  tx = (rect.width - W * k) / 2;
  ty = (rect.height - H * k) / 2;
  applyTransform();
}
svg.addEventListener("wheel", (ev) => {
  ev.preventDefault();
  const rect = svg.getBoundingClientRect();
  const mx = ev.clientX - rect.left, my = ev.clientY - rect.top;
  const factor = ev.deltaY < 0 ? 1.15 : 1 / 1.15;
  const nk = Math.max(0.02, Math.min(k * factor, 8));
  tx = mx - ((mx - tx) * nk) / k;
  ty = my - ((my - ty) * nk) / k;
  k = nk;
  applyTransform();
}, { passive: false });
svg.addEventListener("mousedown", (ev) => {
  if (ev.button !== 0) return;
  dragging = true; lastX = ev.clientX; lastY = ev.clientY;
  svg.classList.add("dragging");
});
window.addEventListener("mousemove", (ev) => {
  if (!dragging) return;
  tx += ev.clientX - lastX; ty += ev.clientY - lastY;
  lastX = ev.clientX; lastY = ev.clientY;
  applyTransform();
});
window.addEventListener("mouseup", () => { dragging = false; svg.classList.remove("dragging"); });
document.getElementById("btnFit").addEventListener("click", fit);
document.getElementById("btnZoomIn").addEventListener("click", () => {
  k = Math.min(k * 1.3, 8); applyTransform();
});
document.getElementById("btnZoomOut").addEventListener("click", () => {
  k = Math.max(k / 1.3, 0.02); applyTransform();
});
fit();

// ── selection / highlight ──────────────────────────────────────────────────
const detail = document.getElementById("detail");
function clearHighlight() {
  edgeEls.forEach((el) => el.setAttribute("class", edgeClass(el.getAttribute("data-kind"))));
  nodeEls.forEach((el) => el.classList.remove("dim", "highlight"));
}
function selectNode(i) {
  clearHighlight();
  const path = CODEMAP.modules[i].path;
  const connected = new Set([i]);
  for (const j of incoming[i]) connected.add(j);
  for (const j of outgoing[i]) connected.add(j);
  edgeEls.forEach((el) => {
    const f = byPath.get(el.getAttribute("data-from"));
    const t = byPath.get(el.getAttribute("data-to"));
    const active = (f === i && connected.has(t)) || (t === i && connected.has(f));
    if (active) {
      el.classList.add("highlight");
    } else {
      el.classList.add("dim");
    }
  });
  nodeEls.forEach((el, j) => {
    const p = el.getAttribute("data-path");
    if (j === i) { el.classList.add("highlight"); return; }
    if (connected.has(j)) { el.classList.add("highlight"); }
    else { el.classList.add("dim"); }
  });
  showDetail(i);
}
function showDetail(i) {
  const m = CODEMAP.modules[i];
  document.getElementById("detailTitle").textContent = m.path.split("/").pop();
  const color = ROLE_COLORS[m.role] || "#5b8def";
  const ext = (CODEMAP.externalDeps && CODEMAP.externalDeps[m.path]) || [];
  let html = "";
  html += '<div class="kv"><span class="k">path</span><span class="v">' + escapeHtml(m.path) + "</span></div>";
  html += '<div class="kv"><span class="k">role</span><span class="v"><span class="badge" style="background:' + color + '">' + m.role + "</span></span></div>";
  html += '<div class="kv"><span class="k">language</span><span class="v">' + m.language + "</span></div>";
  html += '<div class="kv"><span class="k">size</span><span class="v">' + m.sizeBytes + " bytes · " + m.lineCount + " lines</span></div>";
  html += '<div class="kv"><span class="k">layer</span><span class="v">' + layer[i] + "</span></div>";
  if (ext.length) {
    html += '<h3>external deps (' + ext.length + ")</h3><ul>";
    html += ext.slice(0, 40).map((s) => "<li>" + escapeHtml(s) + "</li>").join("");
    if (ext.length > 40) html += "<li>…</li>";
    html += "</ul>";
  }
  html += "<h3>imports (" + importOut[i].length + ")</h3><ul>";
  html += importOut[i].length
    ? importOut[i].map((p) => '<li><a data-jump="' + CODEMAP.modules[p].path + '">' + escapeHtml(CODEMAP.modules[p].path) + "</a></li>").join("")
    : '<li class="empty">none</li>';
  html += "</ul>";
  html += "<h3>imported by (" + importIn[i].length + ")</h3><ul>";
  html += importIn[i].length
    ? importIn[i].map((p) => '<li><a data-jump="' + CODEMAP.modules[p].path + '">' + escapeHtml(CODEMAP.modules[p].path) + "</a></li>").join("")
    : '<li class="empty">none</li>';
  html += "</ul>";
  html += "<h3>calls (" + callOut[i].length + ")</h3><ul>";
  html += callOut[i].length
    ? callOut[i].map((p) => '<li><a data-jump="' + CODEMAP.modules[p].path + '">' + escapeHtml(CODEMAP.modules[p].path) + "</a></li>").join("")
    : '<li class="empty">none</li>';
  html += "</ul>";
  html += "<h3>called by (" + callIn[i].length + ")</h3><ul>";
  html += callIn[i].length
    ? callIn[i].map((p) => '<li><a data-jump="' + CODEMAP.modules[p].path + '">' + escapeHtml(CODEMAP.modules[p].path) + "</a></li>").join("")
    : '<li class="empty">none</li>';
  html += "</ul>";
  const flows = (CODEMAP.flows && CODEMAP.flows[m.path]) || [];
  if (m.role === "entrypoint" && flows.length) {
    html += "<h3>flow from this entrypoint (" + flows.length + ")</h3><ul>";
    html += flows.slice(0, 40).map((p) => '<li><a data-jump="' + p + '">' + escapeHtml(p) + "</a></li>").join("");
    if (flows.length > 40) html += "<li>…</li>";
    html += "</ul>";
  }
  document.getElementById("detailBody").innerHTML = html;
  detail.classList.add("open");
  detail.querySelectorAll("a[data-jump]").forEach((a) => {
    a.addEventListener("click", () => {
      const target = a.getAttribute("data-jump");
      const j = byPath.get(target);
      if (j !== undefined) selectNode(j);
    });
  });
}
function escapeHtml(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
document.getElementById("detailClose").addEventListener("click", () => {
  detail.classList.remove("open");
  clearHighlight();
});
svg.addEventListener("click", () => {
  detail.classList.remove("open");
  clearHighlight();
});

// ── search / filter ────────────────────────────────────────────────────────
const search = document.getElementById("search");
let lastQuery = "";
function applyFilter() {
  const q = search.value.trim().toLowerCase();
  if (q === lastQuery) return;
  lastQuery = q;
  const visible = new Set();
  CODEMAP.modules.forEach((m, i) => {
    if (!q || m.path.toLowerCase().includes(q)) visible.add(i);
  });
  nodeEls.forEach((el, i) => {
    el.style.display = visible.has(i) ? "" : "none";
  });
  edgeEls.forEach((el) => {
    const f = byPath.get(el.getAttribute("data-from"));
    const t = byPath.get(el.getAttribute("data-to"));
    el.style.display = visible.has(f) && visible.has(t) ? "" : "none";
  });
}
search.addEventListener("input", applyFilter);
applyFilter();

// ── header meta ────────────────────────────────────────────────────────────
document.getElementById("project").textContent = CODEMAP.project;
const edgeCount = CODEMAP.edges.length;
document.getElementById("meta").textContent =
  CODEMAP.modules.length + " modules · " + edgeCount + " edges · fp " + CODEMAP.fingerprint.slice(0, 12) + " · " + CODEMAP.generatedAt;
</script>
</body>
</html>
`
}
