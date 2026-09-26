/**
 * The web-mode page: a focused building-block workspace with an optional
 * coordinate map. A static string: no session data is interpolated here;
 * everything arrives through `/api/state` and is rendered with textContent.
 * Labels, verbs and statuses come from `state.flow` (the same `flow.ts` the
 * terminal overlay uses). Styling follows the OpenCode DESIGN.md tokens.
 */
export const WEB_PAGE = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>visual planner</title>
<style>
/* OpenCode DESIGN.md: one monospace face, cream canvas and near-black ink, 1px hairlines,
   4px radius on controls and 0 on containers, no shadows, ASCII markers, blue only for state. */
:root {
  --bg: #fdfcfc; --soft: #f8f7f7; --card: #f1eeee; --line: rgba(15,0,0,0.12); --line-strong: #646262;
  --text: #201d1d; --body: #424245; --muted: #646262; --faint: #9a9898;
  --ink: #201d1d; --ink-deep: #0f0000; --on-ink: #fdfcfc;
  --accent: #007aff; --accent-soft: rgba(0,122,255,0.08);
  --ok: #30d158; --warn: #cc7f08; --bad: #d70015;
  --mono: "Berkeley Mono", "JetBrains Mono", "IBM Plex Mono", ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #201d1d; --soft: #302c2c; --card: #302c2c; --line: rgba(253,252,252,0.12); --line-strong: #646262;
    --text: #fdfcfc; --body: #d9d6d6; --muted: #9a9898; --faint: #6e6e73;
    --ink: #fdfcfc; --ink-deep: #f1eeee; --on-ink: #201d1d;
    --accent-soft: rgba(0,122,255,0.16); --warn: #ff9f0a; --bad: #ff3b30;
  }
}
* { box-sizing: border-box; }
[hidden] { display: none !important; }
html, body { margin: 0; height: 100%; overflow: hidden; background: var(--bg); color: var(--text); font: 13px/1.5 var(--mono); }
button { font: 500 13px/1.8 var(--mono); color: var(--text); background: var(--bg); border: 1px solid var(--line-strong); border-radius: 4px; padding: 0 10px; cursor: pointer; }
button:active:not(:disabled) { background: var(--card); }
button:disabled { color: var(--faint); background: var(--card); border-color: var(--line); cursor: default; }
button.primary { background: var(--ink); border-color: var(--ink); color: var(--on-ink); }
button.danger { color: var(--bad); }
button.ghost { border-color: transparent; background: transparent; }
input, textarea, select { font: 13px/1.5 var(--mono); color: var(--text); background: var(--soft); border: 1px solid var(--line); border-radius: 4px; padding: 3px 6px; width: 100%; }
input:focus, textarea:focus, select:focus { outline: none; background: var(--bg); border-color: var(--ink); }
textarea { resize: none; overflow: hidden; min-height: 2.9em; }

/* The canvas is the page. */
.viewport { position: fixed; inset: 0; overflow: hidden; cursor: default;
  background-image: radial-gradient(var(--line) 1px, transparent 1px); }
.viewport.panning { cursor: grabbing; }
.world { position: absolute; left: 0; top: 0; transform-origin: 0 0; }
svg.edges { position: absolute; left: 0; top: 0; width: 1px; height: 1px; overflow: visible; }
.edge-line { stroke: var(--line-strong); stroke-width: 1.25; fill: none; }
.edge-hit { stroke: transparent; stroke-width: 14; fill: none; cursor: pointer; }
.edge.selected .edge-line { stroke: var(--accent); stroke-width: 2; }
.edge-label { fill: var(--muted); font: 12px var(--mono); pointer-events: none; }
.edge-label-bg { fill: var(--bg); }
.wire { stroke: var(--accent); stroke-width: 1.5; fill: none; stroke-dasharray: 4 3; }

/* Work at the level of a building block; the coordinate map is optional. */
.workspace { position: fixed; inset: 56px 0 0; display: grid; grid-template-columns: minmax(210px, 25%) 1fr; background: var(--bg); }
.workspace .rail { border-right: 1px solid var(--line); overflow: auto; padding: 18px 10px 56px; }
.rail .label, .block-page .label { color: var(--muted); font-size: 11px; text-transform: uppercase; letter-spacing: .08em; }
.rail .row { display: flex; align-items: center; width: 100%; gap: 8px; text-align: left; border: 0; border-radius: 0; padding: 5px 8px; background: transparent; }
.rail .row.current { color: var(--accent); background: var(--accent-soft); }
.rail .row .name { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; flex: 1; }
.rail .actions { display: flex; gap: 6px; margin: 18px 8px; flex-wrap: wrap; }
.block-page { overflow: auto; padding: 30px clamp(22px, 5vw, 88px) 90px; }
.block-page h1 .text { font-size: 24px; font-weight: 700; line-height: 1.3; background: transparent; border: 0; padding: 0; }
.block-page .content { max-width: 850px; margin: 0 auto; }
.block-page h1 { font-size: 24px; line-height: 1.3; margin: 8px 0 4px; }
.block-page h2 { font-size: 13px; margin: 0 0 6px; }
.block-page section { margin-top: 24px; border-top: 1px solid var(--line); padding-top: 14px; }
.block-page .subtle { color: var(--muted); }
.block-page .actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 20px; }
.block-page .fields { display: grid; grid-template-columns: 1fr 1fr; gap: 14px 24px; }
.block-page .fields .wide { grid-column: 1 / -1; }
.block-page .fields .text { font-size: 13px; }
.block-page .fields .md { font-size: 13px; }
.block-page .relation { display: flex; gap: 8px; align-items: baseline; margin: 5px 0; }
.block-page .relation button { border: 0; background: transparent; padding: 0; text-align: left; }
.block-page .status { display: flex; gap: 4px; margin-top: 12px; }
.block-page .status button.active { color: var(--on-ink); background: var(--ink); }
.block-page .sources button { display: block; border: 0; padding: 2px 0; background: transparent; color: var(--accent); text-align: left; }
@media (max-width: 680px) {
  .workspace { inset: 92px 0 0; grid-template-columns: 1fr; }
  .workspace .rail { max-height: 24vh; border-right: 0; border-bottom: 1px solid var(--line); }
  .block-page { padding: 18px 20px 80px; }
  .block-page .fields { grid-template-columns: 1fr; }
}
.workspace.walk { grid-template-columns: 1fr; }
.workspace.walk .rail { display: none; }
.walk { max-width: 720px; margin: 0 auto; }
.walk h1 { margin-bottom: 6px; }
.walk .note { color: var(--body); margin: 8px 0 18px; }
.walk .cite { color: var(--accent); margin: 0 0 18px; }
.walk.dim, .move.dim { color: var(--faint); }
.walk .moves { margin-top: 18px; }
.move { display: flex; gap: 10px; width: 100%; border: 0; background: transparent; padding: 4px 0; text-align: left; }
.move .where { color: var(--faint); flex: none; width: 7ch; }
.dump { margin-top: 28px; }

.node { position: absolute; background: var(--bg); border: 1px solid var(--line-strong); user-select: none; }
.node.selected { border-color: var(--accent); outline: 1px solid var(--accent); z-index: 3; }
.node.target { border-color: var(--accent); }
.node .head { display: flex; align-items: flex-start; gap: 6px; padding: 5px 10px 2px; cursor: grab; }
.node .glyph { color: var(--accent); cursor: pointer; flex: none; }
.node .title { font-weight: 700; flex: 1; min-width: 0; overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; line-height: 1.25; white-space: normal; }
.node .title-edit { font-weight: 700; padding: 0 4px; }
.node .badge { flex: none; color: var(--faint); } .node .badge.unknown { color: var(--warn); } .node .badge.observed { color: var(--ok); }
.node .mark { flex: none; color: var(--accent); }
.node .inside { flex: none; color: var(--muted); cursor: pointer; }
.node .inside:hover { color: var(--accent); }
.node .desc { margin: 0 10px; color: var(--body); font-size: 12px; line-height: 18px; max-height: 18px; display: -webkit-box; -webkit-line-clamp: 1; -webkit-box-orient: vertical; overflow: hidden; }
.node .desc.none { color: var(--faint); }
.node .port { position: absolute; top: 11px; width: 9px; height: 9px; background: var(--bg); border: 1px solid var(--line-strong); cursor: crosshair; }
.node .port.in { left: -5px; } .node .port.out { right: -5px; }
.node .port:hover, .node.selected .port { border-color: var(--accent); }
/* A selected node is still just text: no boxes, no labels — a faint placeholder when empty. */
.node .body { padding: 0 10px 8px; cursor: default; user-select: text; }
.text { display: block; width: 100%; margin: 0; padding: 1px 0; border: none; border-radius: 0; background: transparent; color: var(--body); font: 12px/1.5 var(--mono); resize: none; overflow: hidden; min-height: 0; }
.text:hover { background: var(--soft); }
.text:focus { background: transparent; outline: none; box-shadow: inset 0 -1px 0 var(--accent); }
.text::placeholder { color: var(--faint); }
.line { display: flex; gap: 6px; align-items: baseline; }
.line > .lead { flex: none; color: var(--faint); font-size: 12px; }
/* The body is markdown: paragraphs, lists, headings and code panels. Click it to edit the raw text. */
.md { color: var(--body); font-size: 12px; line-height: 1.5; cursor: text; padding: 1px 0; }
.md:hover { background: var(--soft); }
.md p { margin: 0 0 4px; }
.md .h { font-weight: 700; color: var(--text); margin: 4px 0 2px; }
.md ul { margin: 0 0 4px; padding: 0; list-style: none; }
.md li::before { content: "- "; color: var(--faint); }
.md li.task::before { content: none; }
.md .box { color: var(--faint); }
.md code { background: var(--card); border-radius: 3px; padding: 0 3px; font-size: 11.5px; }
.md .code { position: relative; margin: 4px 0 6px; background: var(--card); border-radius: 4px; }
.md .code pre { margin: 0; padding: 4px 8px 6px; font: 11.5px/1.45 var(--mono); color: var(--text); overflow-x: auto; white-space: pre; }
.md .code .lang { display: block; padding: 3px 8px 0; font-size: 10px; line-height: 1.4; color: var(--faint); }
.node .has-code { flex: none; color: var(--muted); font-size: 11px; }
.node .srcs { margin: 2px 0 0; padding: 0; list-style: none; font-size: 12px; color: var(--muted); }
.node .srcs li::before { content: "[>] "; color: var(--faint); }
.node .state { flex: none; color: var(--muted); font-size: 11px; }
.node .badge { cursor: pointer; }
/* Actions float above the selected node in one row; they never become part of the node. */
.toolbar { position: absolute; left: -1px; bottom: calc(100% + 6px); display: flex; gap: 2px; white-space: nowrap; background: var(--ink); padding: 2px; border-radius: 4px; }
.toolbar button { font-size: 12px; line-height: 1.7; padding: 0 8px; border: none; background: transparent; color: var(--on-ink); }
.toolbar button:hover { background: rgba(127,127,127,0.25); }
.toolbar button.danger { color: #ff6961; }
.toolbar kbd { font: 11px var(--mono); opacity: .55; margin-left: 5px; }
.toolbar .sep { width: 1px; margin: 3px 2px; background: rgba(127,127,127,0.4); }

.edge-edit { position: absolute; display: flex; gap: 4px; transform: translate(-50%, -50%); z-index: 4; }
.edge-edit input { width: 22ch; }

/* Heads-up chrome floats over the canvas; it is not a separate page. */
.hud { position: fixed; display: flex; align-items: center; gap: 8px; background: var(--bg); border: 1px solid var(--line); padding: 4px 8px; z-index: 6; }
.hud.tl { left: 12px; top: 12px; max-width: calc(100% - 420px); }
.hud.tr { right: 12px; top: 12px; }
.hud.bl { left: 12px; bottom: 12px; border: none; background: transparent; color: var(--faint); font-size: 12px; padding: 0; }
.hud .doc { border: 1px solid transparent; background: transparent; font-weight: 700; width: 22ch; padding: 1px 4px; }
.hud .doc:hover { border-color: var(--line); }
.hud select { width: auto; padding: 0 6px; }
.hud .muted { color: var(--muted); white-space: nowrap; }
.hud .dirty { color: var(--warn); font-weight: 700; display: none; } .hud .dirty.on { display: inline; }
.hud .crumbs { display: flex; gap: 6px; white-space: nowrap; overflow: hidden; }
.hud .crumbs a { color: var(--muted); cursor: pointer; text-decoration: underline; }
.hud .crumbs a.here { color: var(--text); text-decoration: none; cursor: default; }
.hud .chip { font-size: 11px; color: var(--on-ink); background: var(--ink); border-radius: 4px; padding: 0 6px; white-space: nowrap; }
.hud .zoom { color: var(--muted); min-width: 5ch; text-align: right; }
@media (max-width: 680px) {
  .hud.tl { left: 8px; right: 8px; top: 8px; max-width: none; }
  .hud.tr { left: 8px; right: 8px; top: 44px; overflow-x: auto; white-space: nowrap; }
  .hud.tr button { flex: none; }
  .hud .doc { width: min(45vw, 22ch); }
  .hud.tl .muted { display: none; }
  .hud.tr .chip { display: none; }
  .hud.bl.hint { display: none; }
}
/* Progress: a click waiting on the server, and the agent working on a request. */
.spin { display: inline-block; width: 1ch; color: var(--accent); }
.activity { display: flex; align-items: center; gap: 6px; color: var(--muted); white-space: nowrap; max-width: 46ch; overflow: hidden; }
.activity .what { overflow: hidden; text-overflow: ellipsis; }
.activity .elapsed { color: var(--faint); }
.activity button { font-size: 12px; line-height: 1.6; padding: 0 6px; }
button.pending { cursor: progress; opacity: .75; }
body.busy, body.busy * { cursor: progress; }
.node.working { border-style: dashed; border-color: var(--accent); }
.start .working { display: flex; align-items: center; gap: 8px; color: var(--muted); }
.start .working .spin { font-size: 16px; }
.message { color: var(--muted); } .message.error { color: var(--bad); }

.start { position: fixed; left: 50%; top: 50%; transform: translate(-50%, -50%); width: min(520px, calc(100% - 32px)); display: flex; flex-direction: column; gap: 8px; z-index: 5; }
.start h1 { font-size: 20px; margin: 0; }
.start .hint { color: var(--faint); font-size: 12px; }
.start .row { display: flex; gap: 8px; flex-wrap: wrap; }
.start .row select { width: auto; }

.review { position: fixed; right: 12px; bottom: 12px; width: min(540px, calc(100% - 24px)); max-height: 50%; overflow: auto;
  background: var(--bg); border: 1px solid var(--ink); padding: 10px 14px; z-index: 7; }
.review h3 { margin: 0 0 2px; font-size: 13px; }
.review .summary { color: var(--body); margin-bottom: 6px; }
.review ul { list-style: none; margin: 0 0 10px; padding: 0; font-size: 12px; }
.review li.add { color: var(--ok); } .review li.del { color: var(--bad); } .review li.mod { color: var(--warn); }
.review .error { color: var(--bad); margin-bottom: 6px; }
.review .row { display: flex; gap: 8px; align-items: center; }
.review .hint { color: var(--faint); font-size: 12px; }

/* The workspace: a file tree on the left, a read-only viewer on the right. Both float over the canvas. */
.drawer { position: fixed; top: 56px; bottom: 12px; background: var(--bg); border: 1px solid var(--line); display: flex; flex-direction: column; z-index: 6; }
.drawer.files { left: 12px; width: 300px; }
.drawer.viewer { right: 12px; width: min(860px, 58vw); z-index: 8; }
.drawer .bar .meta { color: var(--faint); font-size: 12px; white-space: nowrap; }
.drawer .bar { display: flex; align-items: center; gap: 6px; padding: 6px 8px; border-bottom: 1px solid var(--line); }
.drawer .bar .name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 700; }
.drawer .bar button { font-size: 12px; line-height: 1.6; padding: 0 6px; }
.drawer .scroll { flex: 1; overflow: auto; }
.tree .item { display: flex; gap: 6px; padding: 0 8px; white-space: nowrap; cursor: pointer; font-size: 12px; line-height: 1.8; color: var(--body); }
.tree .item:hover { background: var(--soft); }
.tree .item.dir { color: var(--muted); }
.tree .item.open { background: var(--accent-soft); color: var(--text); }
.tree .item.mine .fname { color: var(--accent); }
.tree .item .fname { overflow: hidden; text-overflow: ellipsis; }
.tree .item .cites { margin-left: auto; color: var(--faint); }
.tree .note { padding: 6px 8px; color: var(--faint); font-size: 12px; }
.viewer .who { display: flex; gap: 6px; flex-wrap: wrap; padding: 6px 8px; border-bottom: 1px solid var(--line); font-size: 12px; }
.viewer .who button { font-size: 12px; line-height: 1.6; padding: 0 6px; }
.viewer .who .none { color: var(--faint); }
.viewer table { border-collapse: collapse; width: 100%; font: 12px/1.5 var(--mono); tab-size: 4; }
.viewer td.n { width: 1%; padding: 0 8px 0 6px; text-align: right; color: var(--faint); user-select: none; cursor: pointer; }
.viewer td.t { white-space: pre; padding-right: 12px; color: var(--body); }
/* Syntax colors: the design's semantic ramp as highlight stand-ins, as its TUI mockup uses them. */
:root { --syn-keyword: #007aff; --syn-string: #248a3d; --syn-number: #d70015; --syn-type: #b25000; }
@media (prefers-color-scheme: dark) { :root { --syn-keyword: #0a84ff; --syn-string: #30d158; --syn-number: #ff6961; --syn-type: #ff9f0a; } }
.tk-keyword { color: var(--syn-keyword); }
.tk-string { color: var(--syn-string); }
.tk-number { color: var(--syn-number); }
.tk-type { color: var(--syn-type); }
.tk-function { color: var(--text); font-weight: 700; }
.tk-comment { color: var(--faint); }
.tk-operator, .tk-punctuation { color: var(--muted); }
.tk-variable { color: var(--text); }
.viewer tr.cited td { background: rgba(127,127,127,0.12); }
.viewer tr.mine td { background: var(--accent-soft); }
.viewer tr.mine td.n { color: var(--accent); }
.viewer tr.sel td { background: rgba(0,122,255,0.28); }
.node .srcs li { cursor: pointer; }
.node .srcs li:hover { color: var(--accent); }

.modal-back { position: fixed; inset: 0; background: rgba(15,0,0,0.35); display: flex; align-items: center; justify-content: center; z-index: 10; }
.modal { width: min(900px, calc(100% - 48px)); max-height: calc(100% - 64px); display: flex; flex-direction: column; background: var(--bg); border: 1px solid var(--ink); padding: 14px; gap: 10px; }
.modal h3 { margin: 0; font-size: 13px; }
.modal pre { flex: 1; overflow: auto; margin: 0; padding: 12px 14px; background: var(--card); border-radius: 4px; font: 12px/1.5 var(--mono); white-space: pre-wrap; }
.modal .note .text { font-size: 13px; color: var(--text); }
.modal .row { display: flex; gap: 8px; align-items: center; }
.modal .hint { color: var(--faint); font-size: 12px; }
.offline { position: fixed; inset: auto 0 0 0; background: var(--bad); color: #fdfcfc; text-align: center; padding: 4px; font-weight: 700; display: none; z-index: 20; }
.offline.on { display: block; }
</style>
</head>
<body>
<div class="workspace" id="workspace"><nav class="rail" id="rail" aria-label="Building blocks"></nav><main class="block-page" id="blockPage"></main></div>
<div class="viewport" id="viewport" hidden>
  <div class="world" id="world"><svg class="edges" id="edges"></svg></div>
</div>
<header class="hud tl">
  <input class="doc" id="docTitle" title="Document title" spellcheck="false">
  <select id="purpose" title="What this document is for"></select>
  <span class="muted" id="progress"></span>
  <span class="dirty" id="dirty" title="unsaved edits">*</span>
  <span class="crumbs" id="crumbs"></span>
</header>
<div class="hud tr">
  <button class="ghost" id="undo" title="Undo (⌘Z)">Undo</button>
  <button class="ghost" id="redo" title="Redo (⇧⌘Z)">Redo</button>
  <button class="ghost" id="filesToggle" title="Files in this workspace (/)">Files</button>
  <button class="ghost" id="mapToggle" title="Toggle between block page and map">Map</button>
  <button class="ghost" id="tidy" title="Lay this level out on the grid (T)" hidden>Tidy</button>
  <button class="ghost" id="fit" title="Fit to screen (F)" hidden>Fit</button>
  <span class="activity" id="activity" hidden></span>
  <span class="zoom" id="zoom"></span>
  <button class="primary" id="save" title="Save (⌘S)">Save</button>
  <span class="chip" id="session"></span>
</div>
<div class="hud bl"><span class="message" id="message"></span></div>
<div class="start" id="start" hidden></div>
<section class="review" id="review" hidden></section>
<aside class="drawer files" id="files" hidden></aside>
<aside class="drawer viewer" id="viewer" hidden></aside>
<div class="modal-back" id="modal" hidden></div>
<div class="offline" id="offline">disconnected from the OMP session — run /diagram web again</div>
<script>
"use strict";
// One map cell is SX x SY world pixels, and a node covers the cells the terminal
// card does (cardWidth x 4) minus a gutter: a layout that does not overlap in the
// terminal does not overlap here. A selected node grows over its neighbours.
const SX = 11, SY = 26, CARD_ROWS = 4, GUTTER = 8;
const PURPOSES = ["brainstorm", "plan", "explore"];
const HINT = "walk the focused block · dump a line onto it · grounded hides uncited blocks · Map opens coordinates";
let grounded = false;
function cardCols(title) { return Math.max(12, Math.min(32, [...title].length + 2)); }

let state = null, message = "", messageIsError = false, opCount = 0;
let selectedEdge = null, preview = null, gesture = null, editTitleOf = null, editBodyOf = null, centerOn = null;
let surface = "page";
const views = new Map(); // diagram id -> map pan and zoom, not document content
const insights = new Map(); // only inspected anchors; never index the whole workspace
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

// ---------------------------------------------------------------- server
const BUSY_WORDS = { save: "saving", submit: "sending to the agent", accept: "applying", preview: "composing", tidy: "tidying", undo: "undoing", redo: "redoing" };
let inFlight = 0, inFlightWord = "";
/** Every write goes through here. Resolves to { ok, status, data } and never throws. */
async function op(body) {
  // The button that was clicked shows it is working until the answer lands.
  const button = document.activeElement && document.activeElement.tagName === "BUTTON" ? document.activeElement : null;
  if (button) { button.classList.add("pending"); button.disabled = true; button.prepend(el("span", { class: "spin" }), " "); }
  inFlight += 1;
  inFlightWord = BUSY_WORDS[body.op] || "working";
  document.body.classList.add("busy");
  renderActivity();
  let response;
  try {
    opCount += 1;
    response = await fetch("/api/op", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  } catch {
    $("offline").classList.add("on");
    response = null;
  } finally {
    inFlight -= 1;
    if (inFlight === 0) document.body.classList.remove("busy");
    if (button && button.isConnected) { button.classList.remove("pending"); button.disabled = false; const spin = button.querySelector(".spin"); if (spin) { spin.nextSibling && spin.nextSibling.remove(); spin.remove(); } }
  }
  if (!response) { renderActivity(); return { ok: false, status: 0, data: {} }; }
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
      if (issuedAt === opCount) {
        const followFocus = state && next.selected !== state.selected;
        state = next;
        if (followFocus && next.selected) centerOn = next.selected;
        render();
      }
    }
  } catch { $("offline").classList.add("on"); }
  setTimeout(poll, 500);
}

// ---------------------------------------------------------------- document
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
function selectedBlock() {
  const diagram = currentDiagram();
  return diagram && state.selected ? diagram.blocks.find(block => block.id === state.selected) || null : null;
}
function rectOf(block) {
  return { x: block.position.x * SX, y: block.position.y * SY, w: cardCols(block.title) * SX - GUTTER, h: CARD_ROWS * SY - GUTTER };
}
function view() {
  const diagram = currentDiagram();
  const key = diagram ? diagram.id : "-";
  if (!views.has(key)) views.set(key, { x: 60, y: 90, k: 1 });
  return views.get(key);
}
function toWorld(clientX, clientY) { const v = view(); return { x: (clientX - v.x) / v.k, y: (clientY - v.y) / v.k }; }
function applyView() {
  const v = view();
  $("world").style.transform = "translate(" + v.x + "px," + v.y + "px) scale(" + v.k + ")";
  const grid = 16 * v.k;
  $("viewport").style.backgroundSize = grid + "px " + grid + "px";
  $("viewport").style.backgroundPosition = v.x + "px " + v.y + "px";
  $("zoom").textContent = Math.round(v.k * 100) + "%";
}
function editing() {
  const active = document.activeElement;
  return !!active && (active.tagName === "INPUT" || active.tagName === "TEXTAREA" || active.tagName === "SELECT") && $("world").contains(active);
}

// ---------------------------------------------------------------- render
function render() {
  if (!state) return;
  renderHud();
  renderReview();
  renderFiles();
  renderViewer();
  renderStart();
  $("workspace").hidden = surface !== "page";
  $("workspace").classList.toggle("walk", walking());
  $("mapToggle").textContent = surface === "map" ? "Block page" : "Map";
  $("zoom").hidden = surface !== "map";
  $("tidy").hidden = $("fit").hidden = surface !== "map";
  if (surface === "page") {
    const active = document.activeElement;
    if (walking()) renderWalk();
    else if (!($("workspace").contains(active) && ["INPUT", "TEXTAREA", "SELECT"].includes(active.tagName))) renderWorkspace();
  } else if (!editing() && !gesture) renderCanvas();
  if (surface === "map") applyView();
}
/** Brainstorm is always a walk. Explore walks until a block is settled; plan stays a page. */
function walking() {
  const doc = state && state.document;
  if (!doc || surface === "map") return false;
  if (doc.purpose === "brainstorm") return true;
  if (doc.purpose !== "explore") return false;
  const block = selectedBlock();
  return !block || block.status === "open";
}
function citationOf(block) {
  const source = block.sources && block.sources[0];
  if (!source) return "";
  const end = source.endLine && source.endLine !== source.startLine ? "-" + source.endLine : "";
  const range = source.startLine ? ":" + source.startLine + end : "";
  return source.path + range + (block.sources.length > 1 ? " +" + (block.sources.length - 1) : "");
}
function shown(block) { return !grounded || block.evidence === "observed"; }
function parentBlock(id) {
  let parent = null;
  const walk = (diagram, owner) => {
    for (const block of diagram.blocks) {
      if (block.id === id) parent = owner;
      if (block.children) walk(block.children, block);
    }
  };
  if (state.document) walk(state.document.root, null);
  return parent;
}
function owningDiagram(id) {
  let found = null;
  const walk = diagram => {
    for (const block of diagram.blocks) {
      if (block.id === id) found = diagram;
      else if (block.children) walk(block.children);
    }
  };
  if (state.document) walk(state.document.root);
  return found;
}
function walkMoves(block) {
  const inside = (block ? block.children?.blocks ?? [] : state.document.root.blocks).filter(shown);
  const next = [];
  const diagram = block ? owningDiagram(block.id) : null;
  if (block && diagram) {
    for (const edge of diagram.edges) {
      const otherId = edge.from === block.id ? edge.to : edge.to === block.id ? edge.from : null;
      if (!otherId) continue;
      const other = diagram.blocks.find(candidate => candidate.id === otherId);
      if (other && shown(other)) next.push({ block: other, label: edge.label, inbound: edge.to === block.id });
    }
  }
  return { inside, next };
}
function moveButton(block, where, label) {
  const cite = citationOf(block);
  return el("button", { class: "move" + (block.evidence === "observed" || state.document.purpose !== "explore" ? "" : " dim"), onclick: () => op({ op: "focus", id: block.id }) },
    el("span", { class: "where", text: where }),
    el("span", { text: block.title || "(untitled)" }),
    label ? el("span", { class: "subtle", text: label }) : null,
    cite ? el("span", { class: "cite", text: cite }) : null);
}
function renderWalk() {
  const doc = state.document, page = $("blockPage");
  const active = document.activeElement;
  if (active && page.contains(active) && (active.tagName === "INPUT" || active.tagName === "TEXTAREA") && !(active.id === "dump" && active.value === "")) return;
  $("rail").replaceChildren();
  page.replaceChildren();
  const block = selectedBlock();
  const card = el("div", { class: "walk" + (block && doc.purpose === "explore" && block.evidence !== "observed" ? " dim" : "") });
  const bar = el("div", { class: "actions" });
  if (doc.purpose === "explore") bar.append(el("button", { class: grounded ? "primary" : "", text: grounded ? "grounded" : "all claims", title: "Hide blocks the model did not cite", onclick: () => { grounded = !grounded; renderWalk(); } }));
  if (block && doc.purpose === "explore") bar.append(el("button", { text: "mark explored", onclick: () => op({ op: "setStatus", id: block.id, status: "settled" }) }));
  card.append(el("div", { class: "label", text: doc.purpose + " / walk" }), bar);
  if (!block) {
    card.append(el("h1", { text: doc.title }), el("p", { class: "note", text: doc.goal || "Dump the first idea." }));
  } else {
    const patch = fields => op({ op: "patchBlock", id: block.id, fields });
    card.append(el("h1", null, inlineText(block.title, "Name this idea", value => { if (value.trim()) patch({ title: value.trim() }); })));
    const cite = citationOf(block);
    if (cite) card.append(el("button", { class: "cite", text: cite, title: "Open the cited range", onclick: () => openFile(block.sources[0].path, block.sources[0].startLine) }));
    else if (doc.purpose === "explore") card.append(el("p", { class: "subtle", text: block.evidence === "observed" ? "observed, no range" : block.evidence + " — not grounded in a citation" }));
    card.append(el("div", { class: "note" }, inlineText(block.description, "One line about it", value => patch({ description: value }))));
  }
  const moves = walkMoves(block);
  const list = el("div", { class: "moves" });
  const parent = block ? parentBlock(block.id) : null;
  if (parent) list.append(moveButton(parent, "up", ""));
  for (const child of moves.inside) list.append(moveButton(child, "inside", ""));
  for (const step of moves.next) list.append(moveButton(step.block, step.inbound ? "from" : "next", step.label));
  if (!list.childElementCount) list.append(el("p", { class: "subtle", text: grounded ? "Nothing cited from here. Turn grounded off to see the guesses." : "Nothing connected yet." }));
  card.append(list);
  if (doc.purpose === "brainstorm") {
    const input = el("input", { id: "dump", class: "dump", placeholder: block ? "Dump a line onto this idea" : "Dump the first idea", spellcheck: "false" });
    input.addEventListener("keydown", event => {
      if (event.key !== "Enter") return;
      event.preventDefault();
      const title = input.value.trim();
      if (!title) return;
      input.value = "";
      op(block ? { op: "addBlock", parentId: block.id, title } : { op: "addBlock", title });
    });
    card.append(input);
  } else if (block) {
    card.append(el("div", { class: "actions" }, ...state.flow.verbs.map(verb => el("button", { text: verb.label + " →", onclick: () => openPreview(verb.id, block.id) }))));
  }
  page.append(card);
}
/** The document is authored as decisions and outcomes; the map only visualizes them. */
function renderWorkspace() {
  const doc = state.document, rail = $("rail"), page = $("blockPage");
  const railScroll = rail.scrollTop, pageScroll = page.scrollTop;
  rail.replaceChildren();
  page.replaceChildren();
  if (!doc) return;
  rail.append(el("div", { class: "label", style: "padding:0 8px 12px", text: "Building blocks · " + state.flow.progress }));
  const walk = (diagram, depth) => {
    for (const block of diagram.blocks) {
      const status = state.flow.status ? state.flow.status.glyphs[block.status] + " " : "";
      rail.append(el("button", {
        class: "row" + (block.id === state.selected ? " current" : ""),
        style: "padding-left:" + (8 + depth * 18) + "px",
        onclick: () => op({ op: "focus", id: block.id }),
      }, el("span", { text: status }), el("span", { class: "name", text: block.title || "(untitled)" }),
      block.children?.blocks.length ? el("span", { class: "subtle", text: String(block.children.blocks.length) }) : null));
      if (block.children) walk(block.children, depth + 1);
    }
  };
  walk(doc.root, 0);
  rail.append(el("div", { class: "actions" },
    el("button", { text: "+ block", onclick: () => op(state.selected ? { op: "addBlock", afterId: state.selected } : { op: "addBlock" }) }),
    state.flow.nextOpen ? el("button", { text: "next open", onclick: () => op({ op: "focus", id: state.flow.nextOpen }) }) : null,
    el("button", { text: "project", onclick: () => op({ op: "focus", id: null }) })));
  const content = el("div", { class: "content" });
  page.append(content);
  const block = selectedBlock();
  if (!block) {
    content.append(el("div", { class: "label", text: doc.purpose + " / project" }),
      el("h1", { text: doc.title }), el("p", { class: "subtle", text: doc.goal || "Select a building block or add one." }),
      el("div", { class: "actions" },
        el("button", { text: "Replan project…", onclick: () => openPreview("replan") }),
        el("button", { text: "Prune excess…", onclick: () => openPreview("prune") }),
        el("button", { text: "+ block", onclick: () => op({ op: "addBlock" }) })));
    rail.scrollTop = railScroll; page.scrollTop = pageScroll;
    return;
  }
  const patch = fields => op({ op: "patchBlock", id: block.id, fields });
  content.append(el("div", { class: "label", text: state.breadcrumb.map(c => c.title).join(" › ") }),
    el("h1", null, inlineText(block.title, "Block title", value => { if (value.trim()) patch({ title: value.trim() }); })),
    state.flow.status ? el("div", { class: "status" }, ...state.flow.status.cycle.map(status =>
      el("button", { class: block.status === status ? "active" : "", text: state.flow.status.labels[status],
        onclick: () => op({ op: "setStatus", id: block.id, status }) }))) : null);
  const fields = el("div", { class: "fields" });
  for (const { field, label } of state.flow.fields) {
    if (field === "title" || field === "sources" || field === "enhance" || field === "execute") continue;
    const cell = el("div", { class: field === "description" ? "wide" : "" }, el("div", { class: "label", text: label }));
    if (field === "description") {
      if (block.description.trim() && editBodyOf !== block.id) {
        const view = markdown(block.description);
        view.addEventListener("click", () => { editBodyOf = block.id; renderWorkspace(); });
        cell.append(view);
      } else {
        const input = inlineText(block.description, "What is this building block for?", value => patch({ description: value }), () => { editBodyOf = null; });
        cell.append(input);
        if (editBodyOf === block.id) requestAnimationFrame(() => input.focus());
      }
    } else if (field === "criteria") cell.append(checklist(block.acceptanceCriteria, "Acceptance criterion", value => patch({ acceptanceCriteria: value })));
    else if (field === "evidence") {
      const select = el("select", { onchange: () => patch({ evidence: select.value }) },
        ...["unknown", "inferred", "observed"].map(value => el("option", { value, text: value, selected: value === block.evidence })));
      cell.append(select);
    } else if (field === "expectedOutput") cell.append(inlineText(block.expectedOutput, "What does it produce?", value => patch({ expectedOutput: value })));
    fields.append(cell);
  }
  content.append(el("section", null, fields));
  const actions = el("div", { class: "actions" },
    ...state.flow.verbs.map(verb => el("button", { class: verb.id === "replan" ? "primary" : "", text: verb.label + " →", onclick: () => openPreview(verb.id, block.id) })),
    el("button", { text: "+ inside", onclick: () => op({ op: "addBlock", parentId: block.id }) }),
    el("button", { class: "danger", text: "Delete block", onclick: () => removeBlock(block) }));
  content.append(actions);
  const diagram = currentDiagram();
  const relations = diagram.edges.filter(edge => edge.from === block.id || edge.to === block.id);
  const section = el("section", null, el("h2", { text: "Relationships" }));
  for (const edge of relations) {
    const outbound = edge.from === block.id, other = diagram.blocks.find(candidate => candidate.id === (outbound ? edge.to : edge.from));
    section.append(el("div", { class: "relation" }, el("span", { class: "subtle", text: outbound ? "output →" : "input ←" }),
      el("button", { text: (other?.title || "?") + (edge.label ? " · " + edge.label : ""), onclick: () => other && op({ op: "focus", id: other.id }) })));
  }
  if (!relations.length) section.append(el("p", { class: "subtle", text: "No relationships yet. Connect blocks in Map when a dependency matters." }));
  content.append(section);
  if (block.children?.blocks.length) content.append(el("section", null, el("h2", { text: "Inside" }),
    ...block.children.blocks.map(child => el("div", { class: "relation" },
      el("button", { text: child.title || "(untitled)", onclick: () => op({ op: "focus", id: child.id }) })))));
  if (block.sources.length) {
    const sources = el("section", { class: "sources" }, el("h2", { text: "Code evidence" }));
    for (const source of block.sources) {
      const line = source.startLine || 1, key = source.path + ":" + line, insight = insights.get(key);
      sources.append(el("div", { class: "relation" },
        el("button", { text: source.path + (source.startLine ? ":" + source.startLine + (source.endLine ? "-" + source.endLine : "") : ""),
          onclick: () => openFile(source.path, source.startLine), title: "Open source in the file viewer" }),
        el("button", { text: "inspect syntax", onclick: () => inspectAnchor(source.path, line) })));
      if (insight) sources.append(el("div", { class: "subtle", text: insight.error || (
        (insight.range ? "syntax block " + insight.range.startLine + "–" + insight.range.endLine + " · " : "") +
        (insight.symbols?.map(node => node.kind).join(" › ") || "no enclosing syntax nodes") + " · " + insight.limitation) }));
    }
    content.append(sources);
  }
  rail.scrollTop = railScroll; page.scrollTop = pageScroll;
}

async function inspectAnchor(path, line) {
  const response = await fetch("/api/insight?path=" + encodeURIComponent(path) + "&line=" + line).catch(() => null);
  const result = response ? await response.json().catch(() => ({ error: "could not read source insight" })) : { error: "offline" };
  insights.set(path + ":" + line, result);
  renderWorkspace();
}

// ---------------------------------------------------------------- progress
const SPIN = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏";
function spinner() { return el("span", { class: "spin", text: SPIN[0] }); }
function elapsed(since) { return el("span", { class: "elapsed", "data-since": since, text: clock(since) }); }
function clock(since) {
  const seconds = Math.max(0, Math.floor((Date.now() - Date.parse(since)) / 1000));
  return Math.floor(seconds / 60) + ":" + String(seconds % 60).padStart(2, "0");
}
function discardButton(requestId) {
  return el("button", { class: "ghost", text: "discard", title: "Stop waiting; a late proposal for it will be refused", onclick: () => op({ op: "discard", requestId }) });
}
/** The HUD's one line of progress: a click in flight, else the agent's request and how long it has run. */
function renderActivity() {
  const host = $("activity");
  host.replaceChildren();
  const pending = state && state.pending;
  if (inFlight > 0) host.append(spinner(), el("span", { class: "what", text: inFlightWord + "…" }));
  else if (pending && pending.state === "pending") {
    host.append(spinner(), el("span", { class: "what", text: "agent working: " + pending.label, title: pending.label }), elapsed(pending.since), discardButton(pending.requestId));
  } else if (pending && pending.state === "staged") host.append(el("span", { class: "what", text: "◆ proposal ready to review" }));
  host.hidden = host.childElementCount === 0;
}
// One ticker animates every spinner and elapsed clock on the page.
let frame = 0;
setInterval(() => {
  frame = (frame + 1) % SPIN.length;
  for (const node of document.querySelectorAll(".spin")) node.textContent = SPIN[frame];
  for (const node of document.querySelectorAll(".elapsed")) node.textContent = clock(node.getAttribute("data-since"));
}, 100);

// ---------------------------------------------------------------- workspace files
let filesOpen = null, files = null, filesTruncated = false, filesFilter = "", viewer = null;
const openDirs = new Set([""]);
async function loadFiles() {
  const response = await fetch("/api/files").catch(() => null);
  if (!response || !response.ok) { flash("could not list the workspace files", true); render(); return; }
  const data = await response.json();
  const first = files === null;
  files = data.files; filesTruncated = data.truncated;
  // A small workspace opens fully expanded; a large one starts at its top level.
  if (first && files.length <= 150) {
    for (const path of files) { const parts = path.split("/"); for (let i = 1; i < parts.length; i += 1) openDirs.add(parts.slice(0, i).join("/") + "/"); }
  }
  render();
}
/** Every source in the document: path -> the blocks that cite it and where. */
function citations() {
  const byPath = new Map();
  const walk = diagram => {
    for (const block of diagram.blocks) {
      for (const source of block.sources) {
        if (!byPath.has(source.path)) byPath.set(source.path, []);
        byPath.get(source.path).push({ block, source });
      }
      if (block.children) walk(block.children);
    }
  };
  if (state && state.document) walk(state.document.root);
  return byPath;
}
function renderFiles() {
  const host = $("files");
  // Explore documents are about a codebase: the tree starts open there.
  if (filesOpen === null && state.document) { filesOpen = state.document.purpose === "explore" && !walking(); if (filesOpen) loadFiles(); }
  host.hidden = !filesOpen || !state.document;
  if (host.hidden || host.contains(document.activeElement)) return;
  host.replaceChildren();
  const cites = citations();
  const focused = selectedBlock();
  const mine = new Set(focused ? focused.sources.map(s => s.path) : []);
  const filter = el("input", { type: "text", placeholder: "filter files… (/)", spellcheck: "false" });
  filter.value = filesFilter;
  filter.addEventListener("input", () => { filesFilter = filter.value; renderTree(); });
  filter.addEventListener("keydown", event => { if (event.key === "Escape") filter.blur(); });
  const list = el("div", { class: "scroll tree" });
  host.append(el("div", { class: "bar" }, el("span", { class: "name", text: "files" }),
    el("button", { class: "ghost", text: "↻", title: "Reload the file list", onclick: loadFiles }),
    el("button", { class: "ghost", text: "×", title: "Close (/ reopens)", onclick: () => { filesOpen = false; render(); } })),
    el("div", { class: "bar" }, filter), list);
  const fileRow = (path, label, depth) => {
    const count = (cites.get(path) || []).length;
    return el("div", { class: "item" + (viewer && viewer.path === path ? " open" : "") + (mine.has(path) ? " mine" : ""), style: "padding-left:" + (8 + depth * 14) + "px", title: path, onclick: () => openFile(path) },
      el("span", { class: "fname", text: label }), count ? el("span", { class: "cites", text: "·" + count, title: count + " block(s) anchored here" }) : null);
  };
  function renderTree() {
    list.replaceChildren();
    if (!files) { list.append(el("div", { class: "note", text: "loading…" })); return; }
    const query = filesFilter.trim().toLowerCase();
    if (query) {
      const hits = files.filter(path => path.toLowerCase().includes(query)).slice(0, 300);
      for (const path of hits) list.append(fileRow(path, path, 0));
      if (hits.length === 0) list.append(el("div", { class: "note", text: "no file matches" }));
      return;
    }
    const tree = { dirs: new Map(), files: [] };
    for (const path of files) {
      const parts = path.split("/");
      let node = tree;
      for (const part of parts.slice(0, -1)) {
        if (!node.dirs.has(part)) node.dirs.set(part, { dirs: new Map(), files: [] });
        node = node.dirs.get(part);
      }
      node.files.push(path);
    }
    const draw = (node, prefix, depth) => {
      for (const [name, child] of node.dirs) {
        const key = prefix + name + "/";
        const open = openDirs.has(key);
        list.append(el("div", { class: "item dir", style: "padding-left:" + (8 + depth * 14) + "px", onclick: () => { if (open) openDirs.delete(key); else openDirs.add(key); renderTree(); } },
          el("span", { text: (open ? "[-] " : "[+] ") + name + "/" })));
        if (open) draw(child, key, depth + 1);
      }
      for (const path of node.files) list.append(fileRow(path, path.slice(prefix.length), depth));
    };
    draw(tree, "", 0);
    if (filesTruncated) list.append(el("div", { class: "note", text: "…the list stops at 5000 files; filter to find the rest" }));
  }
  renderTree();
}
async function openFile(path, line) {
  const response = await fetch("/api/file?path=" + encodeURIComponent(path)).catch(() => null);
  const data = response ? await response.json().catch(() => ({})) : {};
  if (!response || !response.ok) { flash(data.error || "could not open " + path, true); render(); return; }
  // Reveal the file in the tree, too.
  const parts = path.split("/");
  for (let i = 1; i < parts.length; i += 1) openDirs.add(parts.slice(0, i).join("/") + "/");
  viewer = { path: data.path, lines: data.lines, tokens: data.tokens, truncated: data.truncated, line: line || null, selection: null, wide: viewer ? viewer.wide : false };
  // The viewer takes the right side: keep the focused block in what is left.
  if (state.selected) centerOn = state.selected;
  render();
}
function renderViewer() {
  const host = $("viewer");
  host.hidden = !viewer;
  if (!viewer) return;
  // Wide: everything right of the file tree, for reading the whole file.
  const files = $("files");
  host.style.left = viewer.wide ? (files.hidden ? 12 : files.getBoundingClientRect().right + 12) + "px" : "";
  host.style.width = viewer.wide ? "auto" : "";
  const current = viewer;
  const cites = citations().get(current.path) || [];
  const focused = selectedBlock();
  const ranges = cites.map(({ block, source }) => ({ mine: focused && block.id === focused.id, a: source.startLine || 0, b: source.endLine || source.startLine || 0 }));
  const sel = current.selection;
  const scroll = host.querySelector(".scroll");
  const keepTop = scroll ? scroll.scrollTop : 0;
  host.replaceChildren();
  const range = sel ? ":" + Math.min(sel.a, sel.b) + "-" + Math.max(sel.a, sel.b) : "";
  host.append(el("div", { class: "bar" },
    el("span", { class: "name", text: current.path, title: current.path }),
    focused ? el("button", { class: "primary", title: "Anchor the focused block to this file" + (sel ? " range" : ""), text: "anchor “" + focused.title + "” → " + current.path.split("/").pop() + range,
      onclick: () => op(sel ? { op: "addSource", id: focused.id, path: current.path, startLine: Math.min(sel.a, sel.b), endLine: Math.max(sel.a, sel.b) } : { op: "addSource", id: focused.id, path: current.path }) }) : null,
    el("span", { class: "meta", text: current.lines.length + " lines" + (current.tokens ? "" : " · plain text") }),
    el("button", { class: "ghost", text: current.wide ? "⤡" : "⤢", title: current.wide ? "Narrow the viewer" : "Widen the viewer over the canvas", onclick: () => { current.wide = !current.wide; renderViewer(); } }),
    el("button", { class: "ghost", text: "×", title: "Close (Esc)", onclick: () => { viewer = null; renderViewer(); } })));
  host.append(el("div", { class: "who" }, ...(cites.length === 0
    ? [el("span", { class: "none", text: "no block anchors here yet" + (focused ? " — click a line number (shift-click extends) to pick a range" : "") })]
    : cites.map(({ block, source }) => el("button", { title: "Go to this block", onclick: () => { centerOn = block.id; op({ op: "focus", id: block.id }); if (source.startLine) { current.line = source.startLine; } } },
        block.title + (source.startLine ? " :" + source.startLine + (source.endLine && source.endLine !== source.startLine ? "-" + source.endLine : "") : ""))))));
  const table = el("table");
  current.lines.forEach((text, index) => {
    const n = index + 1;
    const hit = ranges.filter(r => r.a && n >= r.a && n <= r.b);
    const selected = sel && n >= Math.min(sel.a, sel.b) && n <= Math.max(sel.a, sel.b);
    const row = el("tr", { class: selected ? "sel" : hit.some(r => r.mine) ? "mine" : hit.length ? "cited" : "", "data-n": n },
      el("td", { class: "n", text: String(n), onclick: event => {
        current.selection = event.shiftKey && current.selection ? { a: current.selection.a, b: n } : { a: n, b: n };
        renderViewer();
      } }),
      el("td", { class: "t" }, ...(current.tokens && current.tokens[index]
        ? current.tokens[index].map(([kind, part]) => kind ? el("span", { class: "tk-" + kind, text: part }) : part)
        : [text])));
    table.append(row);
  });
  const body = el("div", { class: "scroll" }, table);
  if (current.truncated) body.append(el("div", { class: "note", text: "…showing the first 5000 lines" }));
  host.append(body);
  const target = current.line || (ranges.find(r => r.mine && r.a) || {}).a;
  if (target) {
    current.line = null;
    requestAnimationFrame(() => { const row = body.querySelector('tr[data-n="' + target + '"]'); if (row) row.scrollIntoView({ block: "center" }); });
  } else body.scrollTop = keepTop;
}

function renderHud() {
  renderActivity();
  const doc = state.document;
  const title = $("docTitle");
  if (document.activeElement !== title) title.value = doc ? doc.title : "";
  title.disabled = !doc;
  const purpose = $("purpose");
  purpose.hidden = !doc;
  if (doc && purpose.value !== doc.purpose) purpose.value = doc.purpose;
  $("progress").textContent = state.flow ? state.flow.progress : "";
  $("dirty").classList.toggle("on", state.dirty);
  $("session").textContent = "web · " + state.sessionId.slice(0, 8);
  $("message").textContent = message || HINT;
  $("message").parentElement.classList.toggle("hint", !message);
  $("message").classList.toggle("error", messageIsError);
  $("undo").disabled = !state.canUndo;
  $("redo").disabled = !state.canRedo;
  $("save").disabled = !doc || !state.dirty;
  $("tidy").disabled = !doc;
  $("fit").disabled = !doc;
  const crumbs = $("crumbs");
  crumbs.replaceChildren();
  if (state.breadcrumb.length > 1) state.breadcrumb.forEach((crumb, index) => {
    if (index > 0) crumbs.append(el("span", { class: "muted", text: "›" }));
    const here = index === state.breadcrumb.length - 1;
    crumbs.append(el("a", { class: here ? "here" : "", text: crumb.title, onclick: here ? null : () => op({ op: "navigate", diagramId: crumb.diagramId }) }));
  });
}

function renderStart() {
  const host = $("start");
  const doc = state.document;
  const diagram = currentDiagram();
  const emptyRoot = doc && doc.root.blocks.length === 0;
  host.hidden = walking() || (!!doc && !emptyRoot && (surface === "page" || !!diagram?.blocks.length));
  // Only a field being typed in is protected from a redraw; a clicked button is not.
  const typing = document.activeElement && document.activeElement.tagName === "INPUT" && host.contains(document.activeElement);
  if (host.hidden || typing) return;
  host.replaceChildren();
  const pending = state.pending;
  if (emptyRoot && pending && !pending.blockId) {
    const drafting = pending.kind === "draft";
    host.append(el("h1", { text: doc.title }));
    if (pending.state === "pending") {
      host.append(
        el("div", { class: "working" }, spinner(), el("span", { text: drafting ? "The agent is drafting this plan" : "The agent is mapping the codebase" }), elapsed(pending.since)),
        el("div", { class: "hint", text: "Follow it in the terminal. Its proposal appears here for review when it is done." }),
        el("div", { class: "row" }, discardButton(pending.requestId)));
    } else {
      host.append(el("div", { class: "hint", text: "The proposal is ready — review it bottom right." }));
    }
    return;
  }
  if (!doc) {
    const title = el("input", { type: "text", placeholder: "title" });
    const purpose = el("select", null, ...PURPOSES.map(value => el("option", { value, text: value, selected: value === "plan" })));
    host.append(el("h1", { text: "New document" }), title,
      el("div", { class: "row" }, purpose, el("button", { class: "primary", text: "Create", onclick: () => op({ op: "newDocument", title: title.value.trim() || undefined, purpose: purpose.value }) })));
    return;
  }
  if (emptyRoot) {
    const input = el("input", { type: "text", placeholder: "what is this about? (or a path to map)" });
    const actions = state.flow.projectActions.map(action => el("button", { class: action.kind === "draft" ? "primary" : "", text: action.label, onclick: () => startProject(action.kind, input.value) }));
    host.append(el("h1", { text: doc.title }), input, el("div", { class: "row" }, ...actions,
      el("button", { text: "+ first block", onclick: () => op({ op: "addBlock" }) })),
      el("div", { class: "hint", text: "Start with the outcome you want, then work on one block at a time." }));
    return;
  }
  host.append(el("div", { class: "hint", style: "pointer-events:none", text: "Nothing inside yet — add a child block or return to the project." }));
}

/** Borderless, self-sizing text that commits when it loses focus; onDone runs first, before any redraw. */
function inlineText(value, placeholder, commit, onDone) {
  const input = el("textarea", { class: "text", rows: 1, placeholder, spellcheck: "false" });
  input.value = value;
  const fit = () => { input.style.height = "auto"; input.style.height = input.scrollHeight + "px"; };
  input.addEventListener("input", fit);
  requestAnimationFrame(fit);
  input.addEventListener("keydown", event => { if (event.key === "Escape") { input.value = value; input.blur(); } });
  input.addEventListener("blur", () => { if (onDone) onDone(); if (input.value !== value) commit(input.value); else render(); });
  return input;
}

/** Acceptance as a checklist: one "[ ]" line per criterion, Enter adds the next, empty lines drop out. */
function checklist(items, placeholder, commit) {
  const box = el("div");
  const addLine = (text, after) => {
    const input = el("textarea", { class: "text", rows: 1, placeholder, spellcheck: "false" });
    input.value = text;
    const fit = () => { input.style.height = "auto"; input.style.height = input.scrollHeight + "px"; };
    input.addEventListener("input", fit);
    requestAnimationFrame(fit);
    input.addEventListener("keydown", event => {
      if (event.key === "Enter") { event.preventDefault(); addLine("", row).querySelector("textarea").focus(); }
      if (event.key === "Backspace" && input.value === "" && box.children.length > 1) {
        event.preventDefault();
        const previous = row.previousElementSibling;
        row.remove();
        if (previous) previous.querySelector("textarea").focus();
      }
    });
    const row = el("div", { class: "line" }, el("span", { class: "lead", text: "[ ]" }), input);
    if (after) after.after(row); else box.append(row);
    return row;
  };
  for (const item of items.length ? items : [""]) addLine(item);
  box.addEventListener("focusout", event => {
    if (box.contains(event.relatedTarget)) return;
    const next = [...box.querySelectorAll("textarea")].map(input => input.value.trim()).filter(Boolean);
    if (next.join("\n") !== items.join("\n")) commit(next.join("\n")); else render();
  });
  return box;
}

// ---------------------------------------------------------------- markdown
// Built as DOM, never as an HTML string: authored text can never become markup.
const TICKS = "\u0060\u0060\u0060";
const FENCE = /^\s*(\u0060\u0060\u0060|~~~)\s*([\w+-]*)/;
const ITEM = /^\s*(?:[-*+]|\d+[.)])\s+(?:\[([ xX])\]\s+)?(.*)$/;
function inline(text) {
  const out = document.createDocumentFragment();
  for (const part of text.split(/(\u0060[^\u0060]+\u0060|\*\*[^*]+\*\*)/)) {
    if (!part) continue;
    if (part.length > 2 && part.startsWith("\u0060") && part.endsWith("\u0060")) out.append(el("code", { text: part.slice(1, -1) }));
    else if (part.length > 4 && part.startsWith("**") && part.endsWith("**")) out.append(el("strong", { text: part.slice(2, -2) }));
    else out.append(part);
  }
  return out;
}
function markdown(text) {
  const root = el("div", { class: "md", title: "Click to edit" });
  const lines = text.split("\n");
  let para = [];
  const flush = () => { if (para.length) root.append(el("p", null, inline(para.join(" ")))); para = []; };
  for (let i = 0; i < lines.length; ) {
    const line = lines[i];
    const fence = FENCE.exec(line);
    if (fence) {
      flush();
      const body = [];
      for (i += 1; i < lines.length && !lines[i].trim().startsWith(fence[1]); i += 1) body.push(lines[i]);
      i += 1;
      root.append(el("div", { class: "code" }, fence[2] ? el("span", { class: "lang", text: fence[2] }) : null, el("pre", { text: body.join("\n") })));
      continue;
    }
    const heading = /^#{1,6}\s+(.*)$/.exec(line);
    if (heading) { flush(); root.append(el("div", { class: "h" }, inline(heading[1]))); i += 1; continue; }
    if (ITEM.test(line)) {
      flush();
      const list = el("ul");
      for (let m = ITEM.exec(lines[i]); m && i < lines.length; i += 1, m = i < lines.length ? ITEM.exec(lines[i]) : null) {
        list.append(el("li", { class: m[1] === undefined ? "" : "task" }, m[1] === undefined ? null : el("span", { class: "box", text: m[1].trim() ? "[x] " : "[ ] " }), inline(m[2])));
      }
      root.append(list);
      continue;
    }
    if (!line.trim()) { flush(); i += 1; continue; }
    para.push(line.trim());
    i += 1;
  }
  flush();
  return root;
}
/** The collapsed node's two lines: the prose, without code or markup. */
function summary(text) {
  const kept = [];
  let fenced = false;
  for (const line of text.split("\n")) {
    if (FENCE.test(line)) { fenced = !fenced; continue; }
    if (!fenced) kept.push(line.replace(/^\s*(?:#{1,6}|[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?/, "").replace(/\u0060/g, ""));
  }
  return kept.join(" ").replace(/\s+/g, " ").trim();
}
function hasCode(text) { return text.includes(TICKS) || /^\s*~~~/m.test(text); }

/** The selected node's content: the fields the purpose shows, as plain editable text. */
function nodeBody(block) {
  const flow = state.flow;
  const patch = fields => op({ op: "patchBlock", id: block.id, fields });
  const body = el("div", { class: "body" });
  for (const { field, label } of flow.fields) {
    if (field === "description") {
      if (block.description.trim() && editBodyOf !== block.id) {
        const view = markdown(block.description);
        view.addEventListener("click", () => { editBodyOf = block.id; renderCanvas(); applyView(); });
        body.append(view);
      } else {
        const input = inlineText(block.description, label + "… (markdown: " + TICKS + " for code)", value => patch({ description: value }), () => { editBodyOf = null; });
        if (editBodyOf === block.id) requestAnimationFrame(() => input.focus());
        body.append(input);
      }
    }
    else if (field === "expectedOutput") body.append(el("div", { class: "line" }, el("span", { class: "lead", text: "→" }), inlineText(block.expectedOutput, label + "…", value => patch({ expectedOutput: value }))));
    else if (field === "criteria") body.append(checklist(block.acceptanceCriteria, label + "…", value => patch({ acceptanceCriteria: value })));
    else if (field === "sources" && block.sources.length > 0) {
      body.append(el("ul", { class: "srcs", title: label }, ...block.sources.map(s => el("li", {
        text: s.path + (s.startLine ? ":" + s.startLine + (s.endLine ? "-" + s.endLine : "") : ""),
        title: "Open in the file viewer",
        onclick: () => openFile(s.path, s.startLine),
      }))));
    }
    // title is edited in the head; evidence and status are marks in the head;
    // agent notes live with the request they steer, in the preview.
  }
  return body;
}

function toolbar(block) {
  const flow = state.flow;
  return el("div", { class: "toolbar" },
    ...flow.verbs.map(verb => el("button", { title: verb.label + " (" + verb.key + ")", onclick: () => openPreview(verb.id, block.id) }, verb.label, el("kbd", { text: verb.key }))),
    el("span", { class: "sep" }),
    el("button", { title: "Add a block inside (O)", onclick: () => op({ op: "addBlock", parentId: block.id }) }, "+ inside", el("kbd", { text: "O" })),
    el("button", { class: "danger", title: "Delete (⌫)", text: "delete", onclick: () => removeBlock(block) }));
}

function renderCanvas() {
  const world = $("world"), edges = $("edges");
  for (const node of [...world.querySelectorAll(".node, .edge-edit")]) node.remove();
  edges.replaceChildren();
  const diagram = currentDiagram();
  if (!diagram) return;
  const flow = state.flow, doc = state.document;
  const pendingBlock = state.pending ? state.pending.blockId : undefined;
  const nodes = new Map();
  for (const block of diagram.blocks) {
    const r = rectOf(block), selected = block.id === state.selected;
    const kids = block.children ? block.children.blocks.length : 0;
    const glyph = flow.status ? flow.status.glyphs[block.status] : "";
    const title = editTitleOf === block.id
      ? el("input", { class: "title-edit", type: "text", spellcheck: "false" })
      : el("span", { class: "title", text: block.title || "(untitled)", title: "Double-click to rename" });
    const working = pendingBlock === block.id && state.pending.state === "pending";
    const node = el("div", { class: "node" + (selected ? " selected" : "") + (working ? " working" : ""), "data-id": block.id },
      el("div", { class: "head" },
        glyph ? el("span", { class: "glyph", text: glyph, title: flow.status.labels[block.status] + " — click to step" }) : null,
        title,
        doc.purpose === "brainstorm" ? null
          : block.evidence === "observed" ? el("span", { class: "badge observed", text: "*", title: "evidence: observed — click to step" })
          : block.evidence === "unknown" ? el("span", { class: "badge unknown", text: "?", title: "evidence: unknown — click to step" })
          : selected ? el("span", { class: "badge", text: "~", title: "evidence: inferred — click to step" }) : null,
        pendingBlock === block.id ? (working ? el("span", { class: "mark", title: "the agent is working on this block" }, spinner(), " ", elapsed(state.pending.since)) : el("span", { class: "mark", text: "◆", title: "proposal ready to review" })) : null,
        selected && flow.status ? el("span", { class: "state", text: flow.status.labels[block.status] }) : null,
        !selected && hasCode(block.description) ? el("span", { class: "has-code", text: "{}", title: "contains code" }) : null,
        el("span", { class: "inside", text: "[" + kids + "]", title: kids > 0 ? "Open the " + kids + " block(s) inside (Enter)" : "Open inside (Enter)" })),
      selected ? null : el("div", { class: "desc" + (block.description ? "" : " none"), text: summary(block.description) || "—" }),
      el("div", { class: "port in", title: "input" }),
      el("div", { class: "port out", title: "drag to link" }),
      selected ? nodeBody(block) : null,
      selected ? toolbar(block) : null);
    node.style.left = r.x + "px";
    node.style.top = r.y + "px";
    node.style.width = (selected ? Math.max(r.w, hasCode(block.description) ? 440 : 300) : r.w) + "px";
    if (!selected) node.style.height = r.h + "px";
    world.append(node);
    nodes.set(block.id, node);
    if (editTitleOf === block.id) {
      title.value = block.title;
      const commit = () => {
        const value = title.value.trim();
        editTitleOf = null;
        if (value && value !== block.title) op({ op: "patchBlock", id: block.id, fields: { title: value } }); else render();
      };
      title.addEventListener("keydown", event => { if (event.key === "Enter") title.blur(); if (event.key === "Escape") { title.value = block.title; title.blur(); } });
      title.addEventListener("blur", commit);
      requestAnimationFrame(() => { title.focus(); title.select(); });
    }
  }
  drawEdges(diagram, nodes);
  if (centerOn) {
    const target = diagram.blocks.find(block => block.id === centerOn);
    centerOn = null;
    if (target) {
      const r = rectOf(target), v = view();
      const area = freeArea();
      v.x = area.left + area.width / 2 - (r.x + r.w / 2) * v.k;
      v.y = area.top + area.height / 2 - (r.y + r.h / 2) * v.k;
    }
  }
}

function nodeBox(node) {
  return { x: parseFloat(node.style.left) || 0, y: parseFloat(node.style.top) || 0, w: node.offsetWidth || 120, h: node.offsetHeight || 80 };
}
const OPPOSITE_SIDE = { east: "west", west: "east", north: "south", south: "north" };
function facingSides(from, to) {
  const dx = (to.x + to.w / 2) - (from.x + from.w / 2);
  const dy = (to.y + to.h / 2) - (from.y + from.h / 2);
  return Math.abs(dx) >= Math.abs(dy) ? (dx >= 0 ? ["east", "west"] : ["west", "east"]) : (dy >= 0 ? ["south", "north"] : ["north", "south"]);
}
function edgeSides(edge, from, to) {
  const out = edge.fromPort && edge.fromPort !== "auto" ? edge.fromPort : null;
  const into = edge.toPort && edge.toPort !== "auto" ? edge.toPort : null;
  if (out && into) return [out, into];
  if (out) return [out, OPPOSITE_SIDE[out]];
  if (into) return [OPPOSITE_SIDE[into], into];
  return facingSides(from, to);
}
function sidePoint(box, side, slot, count) {
  const t = (slot + 1) / (count + 1);
  const x0 = box.x + 12, x1 = box.x + box.w - 12, y0 = box.y + 12, y1 = box.y + box.h - 12;
  if (side === "east") return { x: box.x + box.w, y: y0 + (y1 - y0) * t };
  if (side === "west") return { x: box.x, y: y0 + (y1 - y0) * t };
  if (side === "south") return { x: x0 + (x1 - x0) * t, y: box.y + box.h };
  return { x: x0 + (x1 - x0) * t, y: box.y };
}
function edgePoints(from, to, out, into, outSlot, outCount, inSlot, inCount) {
  const start = sidePoint(from, out, outSlot, outCount);
  const end = sidePoint(to, into, inSlot, inCount);
  const stub = 18;
  const step = { east: [stub, 0], west: [-stub, 0], south: [0, stub], north: [0, -stub] };
  const leave = { x: start.x + step[out][0], y: start.y + step[out][1] };
  const arrive = { x: end.x + step[into][0], y: end.y + step[into][1] };
  const elbow = out === "east" || out === "west" ? { x: arrive.x, y: leave.y } : { x: leave.x, y: arrive.y };
  const points = [start, leave];
  if (elbow.x !== leave.x || elbow.y !== leave.y) points.push(elbow);
  if (arrive.x !== points[points.length - 1].x || arrive.y !== points[points.length - 1].y) points.push(arrive);
  points.push(end);
  return points;
}
function edgePath(points) {
  return points.map((point, index) => (index ? "L" : "M") + point.x + "," + point.y).join(" ");
}
function labelPoint(points) {
  let best = null, length = 48;
  for (let index = points.length - 1; index >= 1; index -= 1) {
    const span = Math.hypot(points[index].x - points[index - 1].x, points[index].y - points[index - 1].y);
    if (span >= length) {
      best = { x: (points[index].x + points[index - 1].x) / 2, y: (points[index].y + points[index - 1].y) / 2 - 8 };
      break;
    }
  }
  if (best) return best;
  const last = points[points.length - 1], prev = points[points.length - 2];
  return { x: (last.x + prev.x) / 2, y: (last.y + prev.y) / 2 - 8 };
}
function drawEdges(diagram, nodes) {
  const edges = $("edges");
  const defs = svg("defs");
  for (const [id, color] of [["arrow", "#646262"], ["arrow-on", "#007aff"]]) {
    const marker = svg("marker", { id, viewBox: "0 0 10 10", refX: 9, refY: 5, markerWidth: 7, markerHeight: 7, orient: "auto-start-reverse" });
    marker.append(svg("path", { d: "M0,0 L10,5 L0,10 z", fill: color }));
    defs.append(marker);
  }
  edges.append(defs);
  const rects = [...nodes.values()].map(node => ({ x: parseFloat(node.style.left), y: parseFloat(node.style.top), w: node.offsetWidth, h: node.offsetHeight }));
  const boxes = new Map([...nodes].map(([id, node]) => [id, nodeBox(node)]));
  const routed = diagram.edges.flatMap(edge => {
    const from = boxes.get(edge.from), to = boxes.get(edge.to);
    if (!from || !to) return [];
    const [out, into] = edgeSides(edge, from, to);
    return [{ edge, from, to, out, into }];
  });
  const slots = new Map();
  for (const route of routed) {
    for (const [id, side] of [[route.edge.from, route.out], [route.edge.to, route.into]]) {
      const key = id + ":" + side;
      if (!slots.has(key)) slots.set(key, []);
      slots.get(key).push(route.edge.id);
    }
  }
  const labels = [];
  for (const route of routed) {
    const edge = route.edge;
    const outSlots = slots.get(edge.from + ":" + route.out), inSlots = slots.get(edge.to + ":" + route.into);
    const points = edgePoints(route.from, route.to, route.out, route.into, outSlots.indexOf(edge.id), outSlots.length, inSlots.indexOf(edge.id), inSlots.length);
    const d = edgePath(points);
    const on = edge.id === selectedEdge;
    const group = svg("g", { class: "edge" + (on ? " selected" : "") });
    const line = svg("path", { class: "edge-line", d });
    const marker = "url(#" + (on ? "arrow-on" : "arrow") + ")";
    if (edge.direction !== "none") line.setAttribute("marker-end", marker);
    if (edge.direction === "both") line.setAttribute("marker-start", marker);
    const hit = svg("path", { class: "edge-hit", d });
    hit.addEventListener("pointerdown", event => event.stopPropagation());
    hit.addEventListener("click", event => { event.stopPropagation(); selectedEdge = edge.id; renderCanvas(); applyView(); });
    group.append(line, hit);
    const mid = labelPoint(points);
    if (edge.label && !on) {
      const text = svg("text", { class: "edge-label", x: mid.x, y: mid.y + 4, "text-anchor": "middle" });
      text.textContent = edge.label;
      const bg = svg("rect", { class: "edge-label-bg" });
      group.append(bg, text);
      requestAnimationFrame(() => {
        try {
          const box = text.getBBox();
          // Like the terminal: a label goes in free space or not at all; the wire keeps it as a tooltip.
          const hitsCard = rects.some(r => box.x < r.x + r.w && r.x < box.x + box.width && box.y < r.y + r.h && r.y < box.y + box.height);
          const hitsLabel = labels.some(r => box.x < r.x + r.width && r.x < box.x + box.width && box.y < r.y + r.height && r.y < box.y + box.height);
          if (hitsCard || hitsLabel) { text.remove(); bg.remove(); const tip = svg("title"); tip.textContent = edge.label; hit.append(tip); return; }
          labels.push(box);
          bg.setAttribute("x", box.x - 4); bg.setAttribute("y", box.y - 1); bg.setAttribute("width", box.width + 8); bg.setAttribute("height", box.height + 2);
        } catch {}
      });
    }
    edges.append(group);
    if (on) {
      const input = el("input", { type: "text", placeholder: "label", spellcheck: "false" });
      input.value = edge.label;
      const box = el("div", { class: "edge-edit" }, input,
        el("button", { class: "danger", text: "×", title: "Delete relationship", onclick: () => { selectedEdge = null; op({ op: "removeEdge", id: edge.id }); } }));
      box.style.left = mid.x + "px";
      box.style.top = mid.y + "px";
      box.addEventListener("pointerdown", event => event.stopPropagation());
      input.addEventListener("keydown", event => { if (event.key === "Enter" || event.key === "Escape") input.blur(); });
      input.addEventListener("blur", () => {
        if (input.value !== edge.label) op({ op: "patchEdge", id: edge.id, label: input.value.trim() });
      });
      $("world").append(box);
    }
  }
}

function renderReview() {
  const host = $("review"), review = state.review;
  host.hidden = !review;
  if (!review) return;
  const diff = review.diff, items = [];
  if (diff.titleChanged) items.push(["mod", "title: " + diff.titleChanged.from + " → " + diff.titleChanged.to]);
  if (diff.goalChanged) items.push(["mod", "goal: " + diff.goalChanged.from + " → " + diff.goalChanged.to]);
  for (const e of diff.added) items.push(["add", "[+] " + e.title]);
  for (const e of diff.removed) items.push(["del", "[-] " + e.title]);
  for (const e of diff.modified) items.push(["mod", "[~] " + e.title + ": " + e.fields.join(", ")]);
  for (const e of diff.edgesAdded) items.push(["add", "[+] " + e]);
  for (const e of diff.edgesRemoved) items.push(["del", "[-] " + e]);
  for (const e of diff.edgesModified) items.push(["mod", "[~] " + e]);
  host.replaceChildren(
    el("h3", { text: "Proposal · " + review.label }),
    el("div", { class: "summary", text: review.summary }),
    review.error ? el("div", { class: "error", text: review.error }) : null,
    review.error ? null : el("ul", null, ...(items.length ? items.map(([kind, text]) => el("li", { class: kind, text })) : [el("li", { text: "structurally identical to the document" })])),
    el("div", { class: "row" },
      review.error ? null : el("button", { class: "primary", text: "Accept", onclick: () => op({ op: "accept", requestId: review.requestId }) }),
      el("button", { class: "danger", text: "Reject", onclick: () => op({ op: "reject", requestId: review.requestId }) }),
      el("span", { class: "hint", text: review.error ? "" : "accepted edits stay unsaved until Save" })));
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
  // The block's standing note for this verb lives here, next to the request it steers.
  const noteField = current.verb === "refine" ? "enhance" : current.verb === "execute" ? "execute" : null;
  const spec = noteField ? state.flow.fields.find(entry => entry.field === noteField) : null;
  const block = (currentDiagram() || { blocks: [] }).blocks.find(candidate => candidate.id === current.id);
  const note = spec && block ? inlineText(block.actions[noteField], spec.label + " for the agent (kept on the block)…", async value => {
    await op({ op: "patchBlock", id: current.id, fields: { [noteField]: value } });
    openPreview(current.verb, current.id);
  }) : null;
  host.append(el("div", { class: "modal", role: "dialog", "aria-label": "request preview" },
    el("h3", { text: "Preview — " + current.label + " (" + current.size + " chars)" }),
    note ? el("div", { class: "note" }, note) : null,
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
function startProject(kind, text) {
  if (kind === "prune" || kind === "replan") { openPreview(kind); return; }
  if (kind === "draft") {
    if (!text.trim()) { flash("a draft needs a goal: type what this is about", true); render(); return; }
    op({ op: "submit", start: { kind: "draft", goal: text, purpose: state.document.purpose === "brainstorm" ? "brainstorm" : "plan" } });
    return;
  }
  op({ op: "submit", start: { kind: "discover", target: text.trim() || "." } });
}

// ---------------------------------------------------------------- editing
async function addAt(world) {
  const result = await op({ op: "addBlock", x: Math.max(0, Math.round(world.x / SX) - 6), y: Math.max(0, Math.round(world.y / SY) - 1) });
  if (result.ok) { editTitleOf = state.selected; renderCanvas(); }
}
function removeBlock(block) {
  if (confirm("Delete " + block.title + " and everything inside it?")) op({ op: "removeBlock", id: block.id });
}
function stepStatus(block) {
  const flow = state.flow;
  if (!flow.status) { flash("brainstorm ideas have no status", true); render(); return; }
  const cycle = flow.status.cycle, index = cycle.indexOf(block.status);
  op({ op: "setStatus", id: block.id, status: index === -1 ? cycle[0] : cycle[(index + 1) % cycle.length] });
}
/** The part of the window the canvas can use: between the open drawers, below the top bar. */
function freeArea() {
  const files = $("files"), viewerPane = $("viewer");
  const left = files.hidden ? 0 : files.getBoundingClientRect().right;
  const right = viewerPane.hidden ? window.innerWidth : viewerPane.getBoundingClientRect().left;
  const top = 56, bottom = 32;
  return { left, top, width: Math.max(200, right - left), height: Math.max(160, window.innerHeight - top - bottom) };
}
function fit() {
  const diagram = currentDiagram();
  if (!diagram || diagram.blocks.length === 0) return;
  const rects = diagram.blocks.map(rectOf);
  const minX = Math.min(...rects.map(r => r.x)), minY = Math.min(...rects.map(r => r.y));
  const maxX = Math.max(...rects.map(r => r.x + r.w)), maxY = Math.max(...rects.map(r => r.y + r.h));
  const area = freeArea(), v = view();
  const spanX = Math.max(1, maxX - minX), spanY = Math.max(1, maxY - minY);
  v.k = Math.min(1.25, Math.max(1, area.width - 48) / spanX, Math.max(1, area.height - 48) / spanY);
  v.x = area.left + (area.width - (maxX - minX) * v.k) / 2 - minX * v.k;
  v.y = area.top + (area.height - (maxY - minY) * v.k) / 2 - minY * v.k;
  applyView();
}

// ---------------------------------------------------------------- gestures
// One pointer gesture at a time: pan the canvas, move a node, or pull a wire.
$("viewport").addEventListener("pointerdown", event => {
  if (event.button !== 0 || !state || !state.document) return;
  const target = event.target;
  if (target.closest("input, textarea, select, button, .edge-edit")) return;
  const nodeEl = target.closest(".node");
  const v = view();
  if (target.classList.contains("port") && target.classList.contains("out")) {
    const from = nodeEl.getAttribute("data-id");
    const start = portPoint(nodeEl, "out");
    const wire = svg("path", { class: "wire", d: curve(start, start) });
    $("edges").append(wire);
    gesture = { kind: "wire", from, start, wire };
  } else if (nodeEl) {
    if (target.closest(".md, .srcs") || target.classList.contains("glyph") || target.classList.contains("inside") || target.classList.contains("badge")) return;
    gesture = { kind: "move", id: nodeEl.getAttribute("data-id"), node: nodeEl, sx: event.clientX, sy: event.clientY, left: parseFloat(nodeEl.style.left), top: parseFloat(nodeEl.style.top), moved: false };
  } else {
    gesture = { kind: "pan", sx: event.clientX, sy: event.clientY, x: v.x, y: v.y, moved: false };
    $("viewport").classList.add("panning");
  }
  $("viewport").setPointerCapture(event.pointerId);
});
$("viewport").addEventListener("pointermove", event => {
  if (!gesture) return;
  const v = view();
  if (gesture.kind === "pan") {
    v.x = gesture.x + event.clientX - gesture.sx; v.y = gesture.y + event.clientY - gesture.sy;
    gesture.moved = gesture.moved || Math.abs(event.clientX - gesture.sx) + Math.abs(event.clientY - gesture.sy) > 3;
    applyView();
  } else if (gesture.kind === "move") {
    const dx = (event.clientX - gesture.sx) / v.k, dy = (event.clientY - gesture.sy) / v.k;
    if (Math.abs(dx) + Math.abs(dy) > 3) gesture.moved = true;
    gesture.node.style.left = gesture.left + dx + "px";
    gesture.node.style.top = gesture.top + dy + "px";
  } else if (gesture.kind === "wire") {
    const end = toWorld(event.clientX, event.clientY);
    gesture.wire.setAttribute("d", curve(gesture.start, end));
    for (const node of document.querySelectorAll(".node.target")) node.classList.remove("target");
    const over = document.elementFromPoint(event.clientX, event.clientY);
    const hovered = over && over.closest(".node");
    if (hovered && hovered.getAttribute("data-id") !== gesture.from) hovered.classList.add("target");
  }
});
$("viewport").addEventListener("pointerup", async event => {
  const done = gesture;
  gesture = null;
  $("viewport").classList.remove("panning");
  if (!done) return;
  if (done.kind === "pan") {
    if (!done.moved) { selectedEdge = null; if (state.selected) await op({ op: "focus", id: null }); else render(); }
    return;
  }
  if (done.kind === "wire") {
    done.wire.remove();
    for (const node of document.querySelectorAll(".node.target")) node.classList.remove("target");
    const over = document.elementFromPoint(event.clientX, event.clientY);
    const hovered = over && over.closest(".node");
    const to = hovered && hovered.getAttribute("data-id");
    if (to && to !== done.from) {
      const result = await op({ op: "addEdge", from: done.from, to, label: "" });
      const diagram = currentDiagram();
      const edge = result.ok && diagram ? diagram.edges.at(-1) : null;
      if (edge) { selectedEdge = edge.id; renderCanvas(); applyView(); const input = document.querySelector(".edge-edit input"); if (input) input.focus(); }
    } else render();
    return;
  }
  selectedEdge = null;
  if (done.moved) {
    await op({ op: "moveBlock", id: done.id, x: Math.max(0, Math.round(parseFloat(done.node.style.left) / SX)), y: Math.max(0, Math.round(parseFloat(done.node.style.top) / SY)) });
  }
  if (state.selected !== done.id) await op({ op: "focus", id: done.id });
  else if (!done.moved) render();
});
$("viewport").addEventListener("click", event => {
  const block = (() => { const node = event.target.closest && event.target.closest(".node"); if (!node) return null; const diagram = currentDiagram(); return diagram.blocks.find(b => b.id === node.getAttribute("data-id")); })();
  if (!block) return;
  if (event.target.classList.contains("glyph")) stepStatus(block);
  else if (event.target.classList.contains("inside")) op({ op: "enter", id: block.id });
  else if (event.target.classList.contains("badge")) {
    const order = ["observed", "inferred", "unknown"];
    op({ op: "patchBlock", id: block.id, fields: { evidence: order[(order.indexOf(block.evidence) + 1) % order.length] } });
  }
});
$("viewport").addEventListener("dblclick", event => {
  // Pointer capture retargets click events to the viewport, so hit-test by position.
  const hit = document.elementFromPoint(event.clientX, event.clientY);
  if (!state || !state.document || !hit || hit.closest("input, textarea, select, button, .edge-edit, .body, .hud, .start, .review")) return;
  const nodeEl = hit.closest(".node");
  if (nodeEl) {
    if (hit.classList.contains("title")) { editTitleOf = nodeEl.getAttribute("data-id"); renderCanvas(); applyView(); }
    return;
  }
  addAt(toWorld(event.clientX, event.clientY));
});
$("viewport").addEventListener("wheel", event => {
  event.preventDefault();
  const v = view();
  if (event.ctrlKey || event.metaKey) {
    // Pinch or ctrl-wheel zooms about the pointer.
    const before = toWorld(event.clientX, event.clientY);
    v.k = Math.max(0.3, Math.min(2, v.k * Math.exp(-event.deltaY * 0.01)));
    v.x = event.clientX - before.x * v.k;
    v.y = event.clientY - before.y * v.k;
  } else {
    v.x -= event.deltaX; v.y -= event.deltaY;
  }
  applyView();
}, { passive: false });

// ---------------------------------------------------------------- chrome and keys
$("undo").addEventListener("click", () => op({ op: "undo" }));
$("redo").addEventListener("click", () => op({ op: "redo" }));
$("save").addEventListener("click", () => op({ op: "save" }));
$("tidy").addEventListener("click", async () => { await op({ op: "tidy" }); fit(); });
$("fit").addEventListener("click", fit);
$("mapToggle").addEventListener("click", () => { surface = surface === "map" ? "page" : "map"; render(); if (surface === "map") fit(); });
$("filesToggle").addEventListener("click", () => { filesOpen = !filesOpen; if (filesOpen) loadFiles(); render(); });
for (const value of PURPOSES) $("purpose").append(el("option", { value, text: value }));
$("purpose").addEventListener("change", () => op({ op: "setPurpose", purpose: $("purpose").value }));
$("docTitle").addEventListener("keydown", event => { if (event.key === "Enter" || event.key === "Escape") event.target.blur(); });
$("docTitle").addEventListener("change", () => { const title = $("docTitle").value.trim(); if (title) op({ op: "patchDocument", title }); });
window.addEventListener("resize", () => state && render());
document.addEventListener("keydown", event => {
  const target = event.target;
  const typing = target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT");
  const mod = event.metaKey || event.ctrlKey;
  if (mod && event.key.toLowerCase() === "s") { event.preventDefault(); op({ op: "save" }); return; }
  if (event.key === "Escape" && preview) { closeModal(); return; }
  if (event.key === "Escape" && viewer && !typing) { viewer = null; renderViewer(); return; }
  if (event.key === "/" && !typing) { event.preventDefault(); filesOpen = true; loadFiles(); render(); requestAnimationFrame(() => { const input = document.querySelector("#files input"); if (input) input.focus(); }); return; }
  if (typing || preview) return;
  if (mod && event.key.toLowerCase() === "z") { event.preventDefault(); op({ op: event.shiftKey ? "redo" : "undo" }); return; }
  if (mod || !state || !state.document) return;
  const block = selectedBlock();
  const verb = state.flow.verbs.find(candidate => candidate.key === event.key);
  if (verb) { event.preventDefault(); if (block) openPreview(verb.id, block.id); return; }
  switch (event.key) {
    case "Escape":
      if (surface === "map") { surface = "page"; render(); return; }
      if (selectedEdge) { selectedEdge = null; render(); return; }
      if (block) { op({ op: "focus", id: null }); return; }
      if (state.stack.length > 1) op({ op: "navigate", diagramId: state.stack[state.stack.length - 2] });
      return;
    case "Enter": if (surface === "map" && block) op({ op: "enter", id: block.id }); return;
    case " ": event.preventDefault(); if (block) stepStatus(block); return;
    case "n": if (state.flow.nextOpen) { centerOn = state.flow.nextOpen; op({ op: "focus", id: state.flow.nextOpen }); } return;
    case "j": case "k": {
      const moves = walking() ? (block ? [...walkMoves(block).inside, ...walkMoves(block).next.map(step => step.block)] : state.document.root.blocks.filter(shown)) : null;
      const ids = moves ? moves.map(item => item.id) : [];
      if (!moves) {
        const walk = diagram => { for (const item of diagram.blocks) { ids.push(item.id); if (item.children) walk(item.children); } };
        walk(state.document.root);
      }
      if (ids.length) {
        const index = Math.max(0, ids.indexOf(state.selected));
        op({ op: "focus", id: ids[(index + (event.key === "j" ? 1 : ids.length - 1)) % ids.length] });
      }
      return;
    }
    case "g": if (state.document.purpose === "explore") { grounded = !grounded; render(); } return;
    case "o": if (walking() && state.document.purpose === "brainstorm") { const dump = document.querySelector("#dump"); if (dump) dump.focus(); return; } op(block ? { op: "addBlock", afterId: block.id } : { op: "addBlock" }).then(r => { if (r.ok && surface === "map") { editTitleOf = state.selected; renderCanvas(); } }); return;
    case "O": if (block) op({ op: "addBlock", parentId: block.id }).then(r => { if (r.ok && surface === "map") { editTitleOf = state.selected; renderCanvas(); } }); return;
    case "T": if (surface === "map") op({ op: "tidy" }).then(fit); return;
    case "F": case "f": if (surface === "map") fit(); return;
    case "F2": if (block) { editTitleOf = block.id; renderCanvas(); } return;
    case "Delete": case "Backspace":
      if (selectedEdge) { const id = selectedEdge; selectedEdge = null; op({ op: "removeEdge", id }); return; }
      if (block) removeBlock(block);
      else if (state.stack.length > 1 && event.key === "Backspace") op({ op: "navigate", diagramId: state.stack[state.stack.length - 2] });
      return;
  }
});
poll();
</script>
</body>
</html>
`;
