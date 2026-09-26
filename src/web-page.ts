/**
 * The web-mode page. A static string: no session data is interpolated here —
 * everything arrives through `/api/state` and is rendered with `textContent`.
 * Labels, verbs and statuses come from `state.flow`, computed by the same
 * `flow.ts` the terminal overlay uses; the page never hardcodes them.
 */
export const WEB_PAGE = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>visual planner</title>
<style>
:root {
  --bg: #111316; --panel: #171a1e; --raised: #1d2126; --line: #2a2f36; --line-strong: #3a414a;
  --text: #e3e6ea; --muted: #8b939d; --faint: #5d656f;
  --accent: #7aa2f7; --accent-soft: rgba(122,162,247,.14);
  --ok: #8fcf8f; --warn: #e0b36a; --bad: #e27d7d;
  --mono: ui-monospace, "SF Mono", Menlo, monospace;
  --sans: -apple-system, BlinkMacSystemFont, "Inter", "Segoe UI", sans-serif;
}
* { box-sizing: border-box; }
[hidden] { display: none !important; }
html, body { margin: 0; height: 100%; background: var(--bg); color: var(--text); font: 13px/1.45 var(--sans); }
button { font: inherit; color: var(--text); background: var(--raised); border: 1px solid var(--line); border-radius: 6px; padding: 4px 10px; cursor: pointer; }
button:hover:not(:disabled) { border-color: var(--line-strong); }
button:disabled { color: var(--faint); cursor: default; }
button.primary { background: var(--accent); border-color: var(--accent); color: #0d1117; font-weight: 600; }
button.danger { color: var(--bad); }
button.on { border-color: var(--accent); color: var(--accent); }
input, textarea, select { font: inherit; color: var(--text); background: var(--bg); border: 1px solid var(--line); border-radius: 6px; padding: 6px 8px; width: 100%; }
input:focus, textarea:focus, select:focus { outline: none; border-color: var(--accent); }
textarea { resize: vertical; min-height: 64px; }

.app { display: grid; grid-template-rows: 44px 1fr; grid-template-columns: minmax(280px, 38%) 1fr; height: 100vh; }
.top { grid-column: 1 / 3; display: flex; align-items: center; gap: 10px; padding: 0 14px; border-bottom: 1px solid var(--line); background: var(--panel); min-width: 0; }
.top .title { font-weight: 600; cursor: text; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 28ch; }
.top select { width: auto; padding: 2px 6px; }
.top .progress { color: var(--muted); white-space: nowrap; }
.top .path { color: var(--faint); font-family: var(--mono); font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.top .dirty { width: 7px; height: 7px; border-radius: 50%; background: var(--warn); display: none; flex: none; }
.top .dirty.on { display: inline-block; }
.top .spacer { flex: 1; }
.top .message { color: var(--muted); max-width: 42ch; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.top .message.error { color: var(--bad); }
.top .chip { font-family: var(--mono); font-size: 11px; color: var(--faint); border: 1px solid var(--line); border-radius: 4px; padding: 1px 6px; white-space: nowrap; }

.outline { grid-column: 1 / 2; display: flex; flex-direction: column; border-right: 1px solid var(--line); background: var(--panel); min-height: 0; }
.tree { flex: 1; overflow: auto; padding: 8px 0; }
.node { display: flex; align-items: center; gap: 6px; padding: 3px 10px; cursor: pointer; white-space: nowrap; }
.node:hover { background: var(--raised); }
.node.focused { background: var(--accent-soft); box-shadow: inset 2px 0 0 var(--accent); }
.node .twisty { width: 16px; flex: none; color: var(--muted); text-align: center; }
.node .twisty.leaf { visibility: hidden; }
.node .glyph { width: 12px; flex: none; color: var(--accent); }
.node .name { overflow: hidden; text-overflow: ellipsis; }
.node.focused .name { font-weight: 600; }
.node .badge { color: var(--faint); font-family: var(--mono); }
.node .badge.unknown { color: var(--warn); } .node .badge.observed { color: var(--ok); }
.node .mark { color: var(--accent); }
.node .acts { margin-left: auto; display: none; gap: 2px; }
.node:hover .acts { display: flex; }
.node .acts button { padding: 0 6px; font-size: 11px; }
.outline .foot { display: flex; gap: 6px; padding: 8px 10px; border-top: 1px solid var(--line); }
.outline .empty-tree { padding: 18px 14px; color: var(--muted); }

.main { grid-column: 2 / 3; position: relative; min-height: 0; display: flex; flex-direction: column; }
.page { flex: 1; overflow: auto; padding: 18px 24px 40px; max-width: 820px; }
.page .crumb { color: var(--faint); font-size: 12px; margin-bottom: 4px; }
.page h1 { font-size: 20px; margin: 0 0 10px; }
.seg { display: inline-flex; border: 1px solid var(--line); border-radius: 6px; overflow: hidden; margin-bottom: 16px; }
.seg button { border: none; border-radius: 0; background: transparent; padding: 3px 12px; }
.seg button + button { border-left: 1px solid var(--line); }
.seg button.on { background: var(--accent-soft); color: var(--accent); }
.field { margin-bottom: 14px; }
.field > label { display: block; color: var(--muted); font-size: 12px; margin-bottom: 4px; }
.sources { font-family: var(--mono); font-size: 12px; color: var(--muted); margin: 0; padding-left: 16px; }
.none { color: var(--faint); }
.row { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; }
.row select, .row input { width: auto; flex: 1; min-width: 100px; }
.section { margin: 18px 0 8px; color: var(--muted); font-size: 12px; text-transform: uppercase; letter-spacing: .06em; }
.chips { display: flex; gap: 6px; flex-wrap: wrap; }
.chips button { padding: 2px 8px; }
.rels { list-style: none; margin: 0 0 8px; padding: 0; }
.rels li { display: flex; gap: 8px; align-items: center; padding: 2px 0; }
.rels li button { padding: 0 6px; font-size: 11px; }
.verbs { display: flex; gap: 8px; margin-top: 20px; padding-top: 14px; border-top: 1px solid var(--line); flex-wrap: wrap; }
.verbs kbd, .keys kbd { font-family: var(--mono); font-size: 11px; border: 1px solid var(--line); border-radius: 3px; padding: 0 4px; color: var(--muted); margin-left: 6px; }
.verbs button.primary kbd { color: #0d1117; border-color: rgba(13,17,23,.35); }
.hint { color: var(--faint); font-size: 12px; }
.keys { color: var(--faint); font-size: 12px; line-height: 1.9; margin-top: 18px; }

.map { flex: 1; display: flex; flex-direction: column; min-height: 0; }
.crumbs { display: flex; align-items: center; gap: 6px; padding: 6px 14px; border-bottom: 1px solid var(--line); color: var(--muted); }
.crumbs a { color: var(--muted); cursor: pointer; }
.crumbs a:hover { color: var(--text); }
.crumbs a.here { color: var(--text); cursor: default; }
.crumbs .sep { color: var(--faint); }
.crumbs .tools { margin-left: auto; display: flex; gap: 6px; }
.crumbs .tools button { padding: 2px 8px; font-size: 12px; }
.canvas-wrap { flex: 1; position: relative; overflow: auto;
  background-image: radial-gradient(var(--line) 1px, transparent 1px); background-size: 20px 20px; }
.canvas { position: relative; }
svg.edges { position: absolute; left: 0; top: 0; overflow: visible; }
.edge-line { stroke: var(--line-strong); stroke-width: 1.5; fill: none; }
.edge-hit { stroke: transparent; stroke-width: 12; fill: none; cursor: pointer; }
.edge.selected .edge-line { stroke: var(--accent); }
.edge-label { fill: var(--muted); font: 11px var(--sans); }
.edge-label-bg { fill: var(--bg); }
.card { position: absolute; width: 208px; min-height: 64px; padding: 9px 11px; background: var(--panel); border: 1px solid var(--line);
  border-radius: 8px; cursor: grab; user-select: none; box-shadow: 0 1px 0 rgba(0,0,0,.25); }
.card:hover { border-color: var(--line-strong); }
.card.selected { border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft); }
.card.link-source { border-color: var(--warn); }
.card.dragging { cursor: grabbing; opacity: .9; }
.card .head { display: flex; align-items: baseline; gap: 6px; }
.card .name { font-weight: 600; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.card .desc { color: var(--muted); font-size: 12px; margin-top: 3px; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.card .meta { display: flex; gap: 8px; margin-top: 6px; font-size: 11px; color: var(--faint); }
.nested { cursor: pointer; }
.nested:hover { color: var(--accent); }
.empty { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 10px; color: var(--muted); pointer-events: none; }
.banner { position: absolute; left: 50%; top: 12px; transform: translateX(-50%); background: var(--raised); border: 1px solid var(--line); border-radius: 6px; padding: 4px 10px; color: var(--muted); z-index: 4; }

.review { position: absolute; right: 16px; bottom: 16px; width: min(560px, calc(100% - 32px)); max-height: 60%; overflow: auto;
  background: var(--raised); border: 1px solid var(--accent); border-radius: 10px; padding: 14px; box-shadow: 0 10px 30px rgba(0,0,0,.45); z-index: 5; }
.review h3 { margin: 0 0 4px; font-size: 13px; }
.review .summary { color: var(--muted); margin-bottom: 10px; }
.review ul { list-style: none; margin: 0 0 12px; padding: 0; font-family: var(--mono); font-size: 12px; }
.review li { padding: 1px 0; }
.review li.add { color: var(--ok); } .review li.del { color: var(--bad); } .review li.mod { color: var(--warn); }
.review .error { color: var(--bad); margin-bottom: 10px; }

.modal-back { position: fixed; inset: 0; background: rgba(0,0,0,.55); display: flex; align-items: center; justify-content: center; z-index: 10; }
.modal { width: min(900px, calc(100% - 48px)); max-height: calc(100% - 64px); display: flex; flex-direction: column; background: var(--raised); border: 1px solid var(--line-strong); border-radius: 10px; padding: 14px; gap: 10px; }
.modal h3 { margin: 0; font-size: 14px; }
.modal pre { flex: 1; overflow: auto; margin: 0; padding: 10px; background: var(--bg); border: 1px solid var(--line); border-radius: 6px; font: 12px/1.5 var(--mono); white-space: pre-wrap; }

.newdoc { max-width: 420px; margin: 60px auto; display: flex; flex-direction: column; gap: 10px; }
.offline { position: fixed; inset: auto 0 0 0; background: var(--bad); color: #111; text-align: center; padding: 4px; font-weight: 600; display: none; }
.offline.on { display: block; }
</style>
</head>
<body>
<div class="app">
  <header class="top">
    <span class="title" id="docTitle" title="Click to rename">visual planner</span>
    <select id="purpose" title="What this document is for"></select>
    <span class="progress" id="progress"></span>
    <span class="dirty" id="dirty" title="unsaved edits"></span>
    <span class="path" id="path"></span>
    <span class="spacer"></span>
    <span class="message" id="message"></span>
    <button id="undo" title="Undo (⌘Z)">Undo</button>
    <button id="redo" title="Redo (⇧⌘Z)">Redo</button>
    <button id="save" class="primary" title="Save (⌘S)">Save</button>
    <button id="viewToggle" title="Switch between outline and map">Map</button>
    <span class="chip" id="session"></span>
  </header>
  <aside class="outline">
    <div class="tree" id="tree"></div>
    <div class="foot">
      <button id="addBlock" title="Add a block after the focused one (o)">+ Block</button>
      <button id="nextOpen" title="Go to the next open block (n)">Next open</button>
    </div>
  </aside>
  <main class="main" id="main">
    <section class="page" id="page"></section>
    <section class="map" id="map" hidden>
      <nav class="crumbs">
        <span id="crumbs"></span>
        <span class="tools"><button id="link" title="Link two blocks (L)">Link</button></span>
      </nav>
      <div class="canvas-wrap" id="wrap">
        <div class="canvas" id="canvas"><svg class="edges" id="edges"></svg></div>
        <div class="empty" id="empty" hidden></div>
        <div class="banner" id="banner" hidden></div>
      </div>
    </section>
    <section class="review" id="review" hidden></section>
  </main>
</div>
<div class="modal-back" id="modal" hidden></div>
<div class="offline" id="offline">disconnected from the OMP session — run /diagram web again</div>
<script>
"use strict";
const SX = 8, SY = 20, CARD_W = 208, PAD = 40;
const PURPOSES = ["brainstorm", "plan", "explore"];
let state = null, message = "", messageIsError = false, view = "outline", opCount = 0;
let linkFrom = null, linkMode = false, selectedEdge = null, drag = null, preview = null;
const collapsed = new Set();
const $ = id => document.getElementById(id);
function el(tag, props, ...children) {
  const node = document.createElement(tag);
  if (props) for (const [key, value] of Object.entries(props)) {
    if (key === "class") node.className = value;
    else if (key === "text") node.textContent = value;
    else if (key.startsWith("on")) { if (value) node.addEventListener(key.slice(2), value); }
    else if (value !== undefined && value !== null && value !== false) node.setAttribute(key, value === true ? "" : String(value));
  }
  for (const child of children) if (child !== null && child !== undefined) node.append(child);
  return node;
}
function svg(tag, attrs) {
  const node = document.createElementNS("http://www.w3.org/2000/svg", tag);
  for (const [key, value] of Object.entries(attrs || {})) node.setAttribute(key, String(value));
  return node;
}

/** Every write goes through here. Resolves to { ok, status, data } and never throws. */
async function op(body) {
  let response;
  try {
    opCount += 1;
    response = await fetch("/api/op", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  } catch { $("offline").classList.add("on"); return { ok: false, status: 0, data: {} }; }
  const data = await response.json().catch(() => ({}));
  opCount += 1;
  if (data.state) state = data.state;
  if (!response.ok && !data.needsSave) flash(data.error || ("request failed: " + response.status), true);
  else if (data.message) flash(data.message, false);
  render();
  return { ok: response.ok, status: response.status, data };
}
function flash(text, isError) { message = text; messageIsError = isError; }

async function poll() {
  try {
    const url = "/api/state" + (state ? "?since=" + encodeURIComponent(state.version) : "");
    const issuedAt = opCount;
    const response = await fetch(url);
    $("offline").classList.toggle("on", !response.ok && response.status !== 204);
    // A poll issued before an op may answer after it: its state is older, so drop it.
    if (response.status === 200 && issuedAt === opCount) {
      const next = await response.json();
      if (issuedAt !== opCount) { setTimeout(poll, 1000); return; }
      const focused = document.activeElement;
      const editing = focused && (focused.tagName === "INPUT" || focused.tagName === "TEXTAREA" || focused.tagName === "SELECT") && $("page").contains(focused);
      state = next;
      // Never rebuild the page under the cursor; the outline and map are safe to redraw.
      render(editing);
    }
  } catch { $("offline").classList.add("on"); }
  setTimeout(poll, 1000);
}

// ---------------------------------------------------------------- document walk
function locate(id) {
  if (!state || !state.document || !id) return null;
  const walk = (diagram, ancestors) => {
    for (const block of diagram.blocks) {
      if (block.id === id) return { block, diagram, ancestors };
      if (block.children) { const found = walk(block.children, ancestors.concat([block])); if (found) return found; }
    }
    return null;
  };
  return walk(state.document.root, []);
}
function visibleRows() {
  const rows = [];
  const walk = (diagram, depth, parentId) => {
    for (const block of diagram.blocks) {
      const kids = block.children ? block.children.blocks.length : 0;
      rows.push({ block, depth, parentId, hasChildren: kids > 0, collapsed: kids > 0 && collapsed.has(block.id) });
      if (kids > 0 && !collapsed.has(block.id)) walk(block.children, depth + 1, block.id);
    }
  };
  if (state && state.document) walk(state.document.root, 0, null);
  return rows;
}
function currentDiagram() {
  if (!state || !state.document) return null;
  let diagram = state.document.root;
  for (const id of state.stack.slice(1)) {
    const owner = diagram.blocks.find(block => block.children && block.children.id === id);
    if (!owner) break;
    diagram = owner.children;
  }
  return diagram;
}
function focused() { const found = locate(state && state.selected); return found ? found.block : null; }
function focus(id) { return op({ op: "focus", id }); }

// ---------------------------------------------------------------- render
function render(keepPage) {
  if (!state) return;
  const doc = state.document;
  $("docTitle").textContent = doc ? doc.title : "visual planner";
  document.title = (doc ? doc.title + " — " : "") + "visual planner";
  const purpose = $("purpose");
  purpose.hidden = !doc;
  if (doc && purpose.value !== doc.purpose) purpose.value = doc.purpose;
  $("progress").textContent = state.flow ? state.flow.progress : "";
  $("dirty").classList.toggle("on", state.dirty);
  $("path").textContent = state.path || "";
  $("session").textContent = "web · " + state.sessionId.slice(0, 8);
  $("message").textContent = message;
  $("message").classList.toggle("error", messageIsError);
  $("undo").disabled = !state.canUndo;
  $("redo").disabled = !state.canRedo;
  $("save").disabled = !doc || !state.dirty;
  $("addBlock").disabled = !doc;
  $("nextOpen").disabled = !doc || !state.flow || !state.flow.nextOpen;
  $("viewToggle").textContent = view === "map" ? "Outline" : "Map";
  $("viewToggle").disabled = !doc;
  $("page").hidden = view === "map";
  $("map").hidden = view !== "map";
  renderOutline();
  if (view === "map") { renderCrumbs(); renderCanvas(); }
  else if (!keepPage) renderPage();
  renderReview();
}

function renderOutline() {
  const tree = $("tree");
  tree.replaceChildren();
  const doc = state.document;
  if (!doc) { tree.append(el("div", { class: "empty-tree", text: "No document yet." })); return; }
  const rows = visibleRows();
  if (rows.length === 0) {
    const copy = doc.purpose === "brainstorm" ? "Empty mind map — add an idea, or seed one from a prompt."
      : doc.purpose === "explore" ? "Nothing mapped yet — map a codebase from the page."
      : "Nothing planned yet — add a block, or draft or discover from the page.";
    tree.append(el("div", { class: "empty-tree", text: copy }));
    return;
  }
  const flow = state.flow;
  const pendingBlock = state.pending ? state.pending.blockId : undefined;
  for (const row of rows) {
    const block = row.block;
    const glyph = flow.status ? flow.status.glyphs[block.status] : "";
    const badge = doc.purpose === "brainstorm" ? null
      : block.evidence === "observed" ? el("span", { class: "badge observed", text: "*", title: "observed" })
      : block.evidence === "unknown" ? el("span", { class: "badge unknown", text: "?", title: "unknown" }) : null;
    const mark = pendingBlock === block.id
      ? el("span", { class: "mark", text: state.pending.state === "staged" ? "◆" : "⋯", title: state.pending.state === "staged" ? "proposal staged" : "request pending" })
      : null;
    const node = el("div", { class: "node" + (block.id === state.selected ? " focused" : ""), style: "padding-left:" + (10 + row.depth * 16) + "px", "data-id": block.id, onclick: () => focus(block.id) },
      el("span", { class: "twisty" + (row.hasChildren ? "" : " leaf"), text: row.collapsed ? "▸" : "▾", onclick: event => {
        event.stopPropagation();
        if (collapsed.has(block.id)) collapsed.delete(block.id); else collapsed.add(block.id);
        render(true);
      } }),
      glyph ? el("span", { class: "glyph", text: glyph }) : null,
      el("span", { class: "name", text: block.title || "(untitled)" }),
      badge, mark,
      el("span", { class: "acts" },
        el("button", { text: "↑", title: "Move up", onclick: event => { event.stopPropagation(); op({ op: "reorder", id: block.id, delta: -1 }); } }),
        el("button", { text: "↓", title: "Move down", onclick: event => { event.stopPropagation(); op({ op: "reorder", id: block.id, delta: 1 }); } }),
        el("button", { text: "+", title: "Add a block inside", onclick: event => { event.stopPropagation(); addChild(block.id); } })));
    tree.append(node);
  }
  const current = tree.querySelector(".node.focused");
  if (current) current.scrollIntoView({ block: "nearest" });
}

function field(label, control) { return el("div", { class: "field" }, el("label", { text: label }), control); }
function textInput(value, onCommit, multiline) {
  const input = el(multiline ? "textarea" : "input", multiline ? { rows: 3 } : { type: "text" });
  input.value = value;
  input.addEventListener("change", () => { if (input.value !== value) onCommit(input.value); });
  if (!multiline) input.addEventListener("keydown", event => { if (event.key === "Enter") input.blur(); });
  return input;
}
function sourceText(source) {
  return source.path + (source.startLine ? ":" + source.startLine + (source.endLine ? "-" + source.endLine : "") : "");
}

function renderPage() {
  const page = $("page");
  page.replaceChildren();
  const doc = state.document;
  if (!doc) { page.append(newDocumentPanel()); return; }
  const found = locate(state.selected);
  if (!found) { page.append(...documentPage(doc)); return; }
  const block = found.block, flow = state.flow;
  const patch = fields => op({ op: "patchBlock", id: block.id, fields });
  page.append(el("div", { class: "crumb", text: [doc.title].concat(found.ancestors.map(a => a.title)).join(" › ") }), el("h1", { text: block.title || "(untitled)" }));
  if (flow.status) {
    const seg = el("div", { class: "seg", role: "group", "aria-label": "status" });
    for (const status of flow.status.cycle) {
      const on = flow.status.labels[status] === flow.status.labels[block.status];
      seg.append(el("button", { class: on ? "on" : "", text: flow.status.labels[status], onclick: () => op({ op: "setStatus", id: block.id, status }) }));
    }
    page.append(seg);
  }
  for (const { field: name, label } of flow.fields) {
    if (name === "title") page.append(field(label, textInput(block.title, value => patch({ title: value }))));
    else if (name === "description") page.append(field(label, textInput(block.description, value => patch({ description: value }), true)));
    else if (name === "expectedOutput") page.append(field(label, textInput(block.expectedOutput, value => patch({ expectedOutput: value }), true)));
    else if (name === "criteria") page.append(field(label + " (one per line)", textInput(block.acceptanceCriteria.join("\n"), value => patch({ acceptanceCriteria: value }), true)));
    else if (name === "enhance") page.append(field(label, textInput(block.actions.enhance, value => patch({ enhance: value }), true)));
    else if (name === "execute") page.append(field(label, textInput(block.actions.execute, value => patch({ execute: value }), true)));
    else if (name === "evidence") {
      const select = el("select", null, ...["observed", "inferred", "unknown"].map(value => el("option", { value, text: value, selected: value === block.evidence })));
      select.addEventListener("change", () => patch({ evidence: select.value }));
      page.append(field(label, select));
    } else if (name === "sources") {
      page.append(field(label, block.sources.length === 0 ? el("div", { class: "none", text: "—" })
        : el("ul", { class: "sources" }, ...block.sources.map(source => el("li", { text: sourceText(source) })))));
    }
  }
  const kids = block.children ? block.children.blocks : [];
  const breakdown = flow.verbs.find(verb => verb.id === "breakdown");
  page.append(el("div", { class: "section", text: "Inside (" + kids.length + ")" }));
  page.append(kids.length === 0
    ? el("div", { class: "hint", text: "Nothing yet — add one" + (breakdown ? ", or ask the agent to " + breakdown.label.toLowerCase() : "") + "." })
    : el("div", { class: "chips" }, ...kids.map(kid => el("button", { text: kid.title || "(untitled)", onclick: () => focus(kid.id) }))));
  page.append(el("div", { class: "row", style: "margin-top:6px" }, el("button", { text: "+ Add inside", onclick: () => addChild(block.id) })));

  page.append(el("div", { class: "section", text: "Relationships" }));
  const diagram = found.diagram;
  const name = id => { const other = diagram.blocks.find(candidate => candidate.id === id); return other ? other.title : "?"; };
  const edges = diagram.edges.filter(edge => edge.from === block.id || edge.to === block.id);
  if (edges.length > 0) {
    page.append(el("ul", { class: "rels" }, ...edges.map(edge => el("li", null,
      el("span", { text: (edge.from === block.id ? "→ " + name(edge.to) : "← " + name(edge.from)) + (edge.label ? " \u201c" + edge.label + "\u201d" : "") }),
      el("button", { class: "danger", text: "×", title: "Delete relationship", onclick: () => op({ op: "removeEdge", id: edge.id }) })))));
  }
  const others = diagram.blocks.filter(candidate => candidate.id !== block.id);
  if (others.length > 0) {
    const target = el("select", null, ...others.map(other => el("option", { value: other.id, text: other.title || "(untitled)" })));
    const label = el("input", { type: "text", placeholder: "label (optional)" });
    page.append(el("div", { class: "row" }, el("span", { class: "hint", text: "link to" }), target, label,
      el("button", { text: "Add", onclick: () => op({ op: "addEdge", from: block.id, to: target.value, label: label.value.trim() }) })));
  } else {
    page.append(el("div", { class: "hint", text: "Add a sibling block to link to." }));
  }

  page.append(el("div", { class: "verbs" }, ...flow.verbs.map(verb =>
    el("button", { class: verb.id === "refine" ? "primary" : "", onclick: () => openPreview(verb.id, block.id) }, verb.label, el("kbd", { text: verb.key }))),
    el("span", { class: "spacer", style: "flex:1" }),
    el("button", { class: "danger", text: "Delete", onclick: () => { if (confirm("Delete " + block.title + " and everything inside it?")) op({ op: "removeBlock", id: block.id }); } })));
  page.append(el("div", { class: "keys", text: "j/k move · " + (flow.status ? "space status · n next open" : "n next idea") + " · o add · O add inside · Esc closes dialogs" }));
}

function documentPage(doc) {
  const flow = state.flow;
  return [
    el("h1", { text: doc.title }),
    field("Title", textInput(doc.title, value => op({ op: "patchDocument", title: value }))),
    field("Goal", textInput(doc.goal, value => op({ op: "patchDocument", goal: value }), true)),
    el("div", { class: "section", text: flow.progress }),
    el("div", { class: "row" }, ...flow.projectActions.map(action => el("button", { class: "primary", text: action.label, onclick: () => startProject(action.kind) }))),
    el("p", { class: "hint", text: "Pick a block in the outline to work on it, or add one with + Block." }),
  ];
}

function newDocumentPanel() {
  const title = el("input", { type: "text", placeholder: "title" });
  const purpose = el("select", null, ...PURPOSES.map(value => el("option", { value, text: value, selected: value === "plan" })));
  return el("div", { class: "newdoc" },
    el("h1", { text: "No planner document is open" }),
    field("Title", title), field("Purpose", purpose),
    el("button", { class: "primary", text: "New document", onclick: () => op({ op: "newDocument", title: title.value.trim() || undefined, purpose: purpose.value }) }));
}

function renderReview() {
  const host = $("review"), review = state.review;
  host.hidden = !review;
  if (!review) return;
  const diff = review.diff, items = [];
  if (diff.titleChanged) items.push(["mod", "title: " + diff.titleChanged.from + " → " + diff.titleChanged.to]);
  if (diff.goalChanged) items.push(["mod", "goal: " + diff.goalChanged.from + " → " + diff.goalChanged.to]);
  for (const e of diff.added) items.push(["add", "+ " + e.title + "  (" + e.path + ")"]);
  for (const e of diff.removed) items.push(["del", "− " + e.title + "  (" + e.path + ")"]);
  for (const e of diff.modified) items.push(["mod", "~ " + e.title + ": " + e.fields.join(", ")]);
  for (const e of diff.edgesAdded) items.push(["add", "+ " + e]);
  for (const e of diff.edgesRemoved) items.push(["del", "− " + e]);
  for (const e of diff.edgesModified) items.push(["mod", "~ " + e]);
  host.replaceChildren(
    el("h3", { text: "Proposal · " + review.label }),
    el("div", { class: "summary", text: review.summary }),
    review.error ? el("div", { class: "error", text: review.error }) : null,
    review.error ? null : el("ul", null, ...(items.length ? items.map(([kind, text]) => el("li", { class: kind, text })) : [el("li", { text: "structurally identical to the document" })])),
    el("div", { class: "row" },
      review.error ? null : el("button", { class: "primary", text: "Accept", onclick: () => op({ op: "accept", requestId: review.requestId }) }),
      el("button", { class: "danger", text: "Reject", onclick: () => op({ op: "reject", requestId: review.requestId }) }),
      el("span", { class: "hint", text: review.error ? "" : "Accepted edits stay unsaved until you press Save." })));
}

// ---------------------------------------------------------------- requests
async function openPreview(verb, id) {
  const result = await op({ op: "preview", verb, id });
  if (!result.ok || !result.data.preview) return;
  preview = { verb, id, ...result.data.preview };
  renderModal();
}
function closeModal() { preview = null; renderModal(); }
function renderModal() {
  const host = $("modal");
  host.hidden = !preview;
  host.replaceChildren();
  if (!preview) return;
  const current = preview;
  host.append(el("div", { class: "modal", role: "dialog", "aria-label": "request preview" },
    el("h3", { text: "Preview — " + current.label + " (" + current.size + " chars)" }),
    el("pre", { text: current.text }),
    el("div", { class: "row" },
      el("button", { class: "primary", text: "Submit", onclick: () => submitVerb(current.verb, current.id) }),
      el("button", { text: "Cancel", onclick: closeModal }),
      el("span", { class: "hint", text: "Submitting sends this prompt to the OMP session; its proposal comes back here for review." }))));
}
async function submitVerb(verb, id) {
  let result = await op({ op: "submit", verb, id });
  if (result.status === 409 && result.data.needsSave) {
    if (!confirm("Save and submit?")) { flash("not submitted: the document has unsaved edits", true); render(); return; }
    result = await op({ op: "submit", verb, id, saveFirst: true });
  }
  if (result.ok) closeModal();
}
function startProject(kind) {
  if (kind === "draft") {
    const goal = prompt("What is this about? (becomes the goal)");
    if (!goal || !goal.trim()) return;
    op({ op: "submit", start: { kind: "draft", goal, purpose: state.document.purpose === "brainstorm" ? "brainstorm" : "plan" } });
    return;
  }
  const target = prompt("Codebase path to map", ".");
  if (target === null) return;
  op({ op: "submit", start: { kind: "discover", target: target.trim() || "." } });
}

// ---------------------------------------------------------------- outline editing
function addSibling() {
  if (!state || !state.document) return;
  op(state.selected ? { op: "addBlock", afterId: state.selected } : { op: "addBlock" });
}
function addChild(id) {
  if (!id) { flash("select a block first", true); render(); return; }
  collapsed.delete(id);
  op({ op: "addBlock", parentId: id });
}
function stepStatus() {
  const block = focused(), flow = state.flow;
  if (!block) return;
  if (!flow.status) { flash("brainstorm ideas have no status", true); render(); return; }
  const cycle = flow.status.cycle, index = cycle.indexOf(block.status);
  op({ op: "setStatus", id: block.id, status: index === -1 ? cycle[0] : cycle[(index + 1) % cycle.length] });
}
function moveFocus(step) {
  const rows = visibleRows();
  if (rows.length === 0) return;
  const index = rows.findIndex(row => row.block.id === state.selected);
  const next = index === -1 ? rows[0] : rows[index + step];
  if (next) focus(next.block.id);
}

// ---------------------------------------------------------------- map view
function renderCrumbs() {
  const host = $("crumbs");
  host.replaceChildren();
  state.breadcrumb.forEach((crumb, index) => {
    if (index > 0) host.append(el("span", { class: "sep", text: "›" }));
    const here = index === state.breadcrumb.length - 1;
    host.append(el("a", { class: here ? "here" : "", text: crumb.title, onclick: here ? null : () => op({ op: "navigate", diagramId: crumb.diagramId }) }));
  });
  $("link").classList.toggle("on", linkMode);
}
function cardRect(block) {
  const node = document.querySelector('.card[data-id="' + CSS.escape(block.id) + '"]');
  const left = block.position.x * SX + PAD, top = block.position.y * SY + PAD;
  return { left, top, width: CARD_W, height: node ? node.offsetHeight : 64 };
}
function borderPoint(rect, toward) {
  const cx = rect.left + rect.width / 2, cy = rect.top + rect.height / 2;
  const dx = toward.x - cx, dy = toward.y - cy;
  if (dx === 0 && dy === 0) return { x: cx, y: cy };
  const scale = Math.min(Math.abs((rect.width / 2) / (dx || 1e-9)), Math.abs((rect.height / 2) / (dy || 1e-9)));
  return { x: cx + dx * scale, y: cy + dy * scale };
}
function renderCanvas() {
  // A redraw mid-drag would detach the card under the pointer.
  if (drag) return;
  const canvas = $("canvas"), edges = $("edges"), empty = $("empty");
  for (const node of [...canvas.querySelectorAll(".card")]) node.remove();
  edges.replaceChildren();
  const diagram = currentDiagram();
  if (!diagram) return;
  empty.hidden = diagram.blocks.length > 0;
  if (diagram.blocks.length === 0) {
    empty.replaceChildren(el("div", { text: "This diagram is empty." }), el("div", { class: "hint", text: "Double-click the canvas to add a block." }));
  }
  const glyphs = state.flow.status ? state.flow.status.glyphs : null;
  let maxX = 0, maxY = 0;
  for (const block of diagram.blocks) {
    const nested = block.children ? block.children.blocks.length : 0;
    const card = el("div", { class: "card" + (block.id === state.selected ? " selected" : "") + (block.id === linkFrom ? " link-source" : ""), "data-id": block.id },
      el("div", { class: "head" },
        glyphs ? el("span", { text: glyphs[block.status] }) : null,
        el("span", { class: "name", text: block.title })),
      block.description ? el("div", { class: "desc", text: block.description }) : null,
      el("div", { class: "meta" },
        el("span", { class: "nested", text: nested > 0 ? "▸ " + nested + " inside" : "▸ open", title: "Enter this subsystem (double-click)",
          onclick: event => { event.stopPropagation(); op({ op: "enter", id: block.id }); } }),
        block.evidence === "inferred" ? null : el("span", { text: block.evidence })));
    const left = block.position.x * SX + PAD, top = block.position.y * SY + PAD;
    card.style.left = left + "px";
    card.style.top = top + "px";
    card.addEventListener("pointerdown", event => startDrag(event, block, card));
    card.addEventListener("click", event => event.stopPropagation());
    card.addEventListener("dblclick", event => { event.stopPropagation(); op({ op: "enter", id: block.id }); });
    canvas.append(card);
    maxX = Math.max(maxX, left + CARD_W);
    maxY = Math.max(maxY, top + card.offsetHeight);
  }
  const wrap = $("wrap");
  canvas.style.width = Math.max(wrap.clientWidth, maxX + PAD * 4) + "px";
  canvas.style.height = Math.max(wrap.clientHeight, maxY + PAD * 4) + "px";
  edges.setAttribute("width", canvas.style.width);
  edges.setAttribute("height", canvas.style.height);
  const defs = svg("defs");
  for (const [id, color] of [["arrow", "#3a414a"], ["arrow-on", "#7aa2f7"]]) {
    const marker = svg("marker", { id, viewBox: "0 0 10 10", refX: 9, refY: 5, markerWidth: 7, markerHeight: 7, orient: "auto-start-reverse" });
    marker.append(svg("path", { d: "M0,0 L10,5 L0,10 z", fill: color }));
    defs.append(marker);
  }
  edges.append(defs);
  const byId = new Map(diagram.blocks.map(block => [block.id, block]));
  for (const edge of diagram.edges) {
    const from = byId.get(edge.from), to = byId.get(edge.to);
    if (!from || !to) continue;
    const a = cardRect(from), b = cardRect(to);
    const ca = { x: a.left + a.width / 2, y: a.top + a.height / 2 }, cb = { x: b.left + b.width / 2, y: b.top + b.height / 2 };
    const p = borderPoint(a, cb), q = borderPoint(b, ca);
    const on = edge.id === selectedEdge;
    const group = svg("g", { class: "edge" + (on ? " selected" : "") });
    const d = "M" + p.x + "," + p.y + " L" + q.x + "," + q.y;
    const line = svg("path", { class: "edge-line", d });
    const marker = "url(#" + (on ? "arrow-on" : "arrow") + ")";
    if (edge.direction !== "none") line.setAttribute("marker-end", marker);
    if (edge.direction === "both") line.setAttribute("marker-start", marker);
    const hit = svg("path", { class: "edge-hit", d });
    hit.addEventListener("click", event => { event.stopPropagation(); selectedEdge = edge.id; linkMode = false; linkFrom = null; render(); });
    group.append(line, hit);
    if (edge.label) {
      const mx = (p.x + q.x) / 2, my = (p.y + q.y) / 2;
      const text = svg("text", { class: "edge-label", x: mx, y: my + 4, "text-anchor": "middle" });
      text.textContent = edge.label;
      const bg = svg("rect", { class: "edge-label-bg", rx: 3 });
      group.append(bg, text);
      requestAnimationFrame(() => { try { const box = text.getBBox(); bg.setAttribute("x", box.x - 4); bg.setAttribute("y", box.y - 1); bg.setAttribute("width", box.width + 8); bg.setAttribute("height", box.height + 2); } catch {} });
    }
    edges.append(group);
  }
  const banner = $("banner");
  banner.hidden = !linkMode;
  banner.textContent = linkFrom ? "Link: now click the target block (Esc cancels)" : "Link: click the source block (Esc cancels)";
}
function startDrag(event, block, card) {
  if (event.button !== 0) return;
  event.stopPropagation();
  if (linkMode) {
    if (!linkFrom) { linkFrom = block.id; render(); return; }
    const from = linkFrom;
    linkFrom = null; linkMode = false;
    if (from !== block.id) op({ op: "addEdge", from, to: block.id, label: "" }); else render();
    return;
  }
  selectedEdge = null;
  drag = { block, card, startX: event.clientX, startY: event.clientY, left: parseFloat(card.style.left), top: parseFloat(card.style.top), moved: false };
  card.setPointerCapture(event.pointerId);
  card.classList.add("dragging");
}
document.addEventListener("pointermove", event => {
  if (!drag) return;
  const dx = event.clientX - drag.startX, dy = event.clientY - drag.startY;
  if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
  drag.card.style.left = Math.max(PAD, drag.left + dx) + "px";
  drag.card.style.top = Math.max(PAD, drag.top + dy) + "px";
});
document.addEventListener("pointerup", () => {
  if (!drag) return;
  const { block, card, moved } = drag;
  drag = null;
  card.classList.remove("dragging");
  const x = Math.round((parseFloat(card.style.left) - PAD) / SX), y = Math.round((parseFloat(card.style.top) - PAD) / SY);
  (async () => {
    if (moved) await op({ op: "moveBlock", id: block.id, x, y });
    if (state.selected !== block.id) await focus(block.id);
    else render();
  })();
});

// ---------------------------------------------------------------- wiring
$("undo").addEventListener("click", () => op({ op: "undo" }));
$("redo").addEventListener("click", () => op({ op: "redo" }));
$("save").addEventListener("click", () => op({ op: "save" }));
$("addBlock").addEventListener("click", addSibling);
$("nextOpen").addEventListener("click", () => { if (state && state.flow && state.flow.nextOpen) focus(state.flow.nextOpen); });
$("viewToggle").addEventListener("click", () => { view = view === "map" ? "outline" : "map"; linkMode = false; linkFrom = null; render(); });
$("link").addEventListener("click", () => { linkMode = !linkMode; linkFrom = null; render(); });
for (const value of PURPOSES) $("purpose").append(el("option", { value, text: value }));
$("purpose").addEventListener("change", () => op({ op: "setPurpose", purpose: $("purpose").value }));
$("docTitle").addEventListener("click", () => {
  if (!state || !state.document) return;
  const title = prompt("Document title", state.document.title);
  if (title && title.trim()) op({ op: "patchDocument", title });
});
$("canvas").addEventListener("click", () => {
  if (!state) return;
  if (linkMode) { linkMode = false; linkFrom = null; }
  selectedEdge = null;
  if (state.selected) focus(null); else render();
});
$("canvas").addEventListener("dblclick", event => {
  const box = $("canvas").getBoundingClientRect();
  op({ op: "addBlock", x: Math.max(0, Math.round((event.clientX - box.left - PAD - CARD_W / 2) / SX)), y: Math.max(0, Math.round((event.clientY - box.top - PAD - 20) / SY)) });
});
document.addEventListener("keydown", event => {
  const target = event.target;
  const typing = target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT");
  const mod = event.metaKey || event.ctrlKey;
  if (mod && event.key.toLowerCase() === "s") { event.preventDefault(); op({ op: "save" }); return; }
  if (event.key === "Escape") {
    if (preview) { closeModal(); return; }
    if (typing) { target.blur(); return; }
    if (linkMode) { linkMode = false; linkFrom = null; render(); return; }
    if (view === "map") { view = "outline"; render(); return; }
    return;
  }
  if (typing || preview) return;
  if (mod && event.key.toLowerCase() === "z") { event.preventDefault(); op({ op: event.shiftKey ? "redo" : "undo" }); return; }
  if (mod || !state || !state.document) return;
  const block = focused();
  const verb = state.flow.verbs.find(candidate => candidate.key === event.key);
  if (verb) { event.preventDefault(); if (block) openPreview(verb.id, block.id); return; }
  switch (event.key) {
    case "j": case "ArrowDown": event.preventDefault(); moveFocus(1); return;
    case "k": case "ArrowUp": event.preventDefault(); moveFocus(-1); return;
    case " ": event.preventDefault(); stepStatus(); return;
    case "n": if (state.flow.nextOpen) focus(state.flow.nextOpen); return;
    case "o": addSibling(); return;
    case "O": addChild(state.selected); return;
    case "l": case "L": if (view === "map") { linkMode = !linkMode; linkFrom = null; render(); } return;
    case "Delete": case "Backspace":
      if (selectedEdge) { const id = selectedEdge; selectedEdge = null; op({ op: "removeEdge", id }); return; }
      if (block && confirm("Delete " + block.title + " and everything inside it?")) op({ op: "removeBlock", id: block.id });
      return;
  }
});
window.addEventListener("resize", () => state && view === "map" && renderCanvas());
poll();
</script>
</body>
</html>
`;
