/**
 * The plan tree as nested boxes: children inside their parent's box, in rows,
 * in directory order. Pure and browser-safe (types only from tree.ts).
 */
import type { Status, TreeNode } from "./tree.ts";

export const LEAF_W = 220;
export const LEAF_H = 56;
export const PAD = 14;
/** A parent's header band: its own title row, above its children. */
export const HEAD = 36;
export const GAP = 14;
export const MAX_COLS = 4;

export interface Box {
	path: string;
	title: string;
	status: Status;
	x: number;
	y: number;
	w: number;
	h: number;
	depth: number;
	childCount: number;
	collapsed: boolean;
	designed: boolean;
	problems: number;
}

export interface Wire {
	from: string;
	to: string;
	label: string;
	x1: number;
	y1: number;
	x2: number;
	y2: number;
}

export interface Layout {
	boxes: Box[];
	wires: Wire[];
	width: number;
	height: number;
}

interface Sized {
	node: TreeNode;
	w: number;
	h: number;
	/** Empty when drawn as a leaf. */
	rows: Sized[][];
}

function size(node: TreeNode, collapsed: ReadonlySet<string>): Sized {
	if (node.children.length === 0 || collapsed.has(node.path)) return { node, w: LEAF_W, h: LEAF_H, rows: [] };
	const children = node.children.map(child => size(child, collapsed));
	const cols = Math.min(MAX_COLS, Math.ceil(Math.sqrt(children.length)));
	const rows: Sized[][] = [];
	for (let i = 0; i < children.length; i += cols) rows.push(children.slice(i, i + cols));
	let widest = 0;
	let height = 0;
	for (const row of rows) {
		widest = Math.max(widest, row.reduce((sum, child) => sum + child.w, 0) + GAP * (row.length - 1));
		height += Math.max(...row.map(child => child.h));
	}
	height += GAP * (rows.length - 1);
	return { node, w: Math.max(LEAF_W, widest + 2 * PAD), h: HEAD + height + PAD, rows };
}

function place(sized: Sized, x: number, y: number, depth: number, collapsed: ReadonlySet<string>, boxes: Box[]): void {
	const { node } = sized;
	boxes.push({
		path: node.path,
		title: node.title,
		status: node.status,
		x,
		y,
		w: sized.w,
		h: sized.h,
		depth,
		childCount: node.children.length,
		collapsed: node.children.length > 0 && collapsed.has(node.path),
		designed: node.design !== undefined,
		problems: node.problems.length,
	});
	let rowY = y + HEAD;
	for (const row of sized.rows) {
		let childX = x + PAD;
		for (const child of row) {
			place(child, childX, rowY, depth + 1, collapsed, boxes);
			childX += child.w + GAP;
		}
		rowY += Math.max(...row.map(child => child.h)) + GAP;
	}
}

/** Where the segment from the box's centre towards (tx, ty) leaves the box. */
function border(box: Box, tx: number, ty: number): { x: number; y: number } {
	const cx = box.x + box.w / 2;
	const cy = box.y + box.h / 2;
	const dx = tx - cx;
	const dy = ty - cy;
	if (dx === 0 && dy === 0) return { x: cx, y: cy };
	const t = Math.min(dx === 0 ? Infinity : box.w / 2 / Math.abs(dx), dy === 0 ? Infinity : box.h / 2 / Math.abs(dy));
	return { x: cx + dx * t, y: cy + dy * t };
}

function contains(outer: string, inner: string): boolean {
	return outer === "" ? inner !== "" : inner.startsWith(`${outer}/`);
}

/** The node at `path`, walking only the branch that can hold it. */
export function findNode(node: TreeNode, path: string): TreeNode | undefined {
	if (node.path === path) return node;
	for (const child of node.children) {
		if (path === child.path || path.startsWith(`${child.path}/`)) return findNode(child, path);
	}
	return undefined;
}

export function layoutTree(root: TreeNode, collapsed: ReadonlySet<string>): Layout {
	const sized = size(root, collapsed);
	const boxes: Box[] = [];
	place(sized, 0, 0, 0, collapsed, boxes);
	const byPath = new Map(boxes.map(box => [box.path, box]));

	// Every node, hidden ones too, maps to the box that shows it.
	const visible = new Map<string, string>();
	const all: TreeNode[] = [];
	const map = (node: TreeNode, shownAs: string | undefined): void => {
		const shown = shownAs ?? node.path;
		visible.set(node.path, shown);
		all.push(node);
		const hides = shownAs === undefined && node.children.length > 0 && collapsed.has(node.path);
		for (const child of node.children) map(child, hides ? node.path : shownAs);
	};
	map(root, undefined);

	const wires: Wire[] = [];
	const seen = new Set<string>();
	for (const node of all) {
		const from = visible.get(node.path)!;
		for (const arrow of node.arrows) {
			const to = visible.get(arrow.to);
			if (to === undefined || to === from) continue;
			const key = `${from}\n${to}\n${arrow.label}`;
			if (seen.has(key)) continue;
			seen.add(key);
			const a = byPath.get(from)!;
			const b = byPath.get(to)!;
			let start: { x: number; y: number };
			let end: { x: number; y: number };
			if (contains(from, to) || contains(to, from)) {
				const [outer, inner] = contains(from, to) ? [a, b] : [b, a];
				const header = { x: outer.x + outer.w / 2, y: outer.y + HEAD };
				const top = { x: inner.x + inner.w / 2, y: inner.y };
				[start, end] = outer === a ? [header, top] : [top, header];
			} else {
				start = border(a, b.x + b.w / 2, b.y + b.h / 2);
				end = border(b, a.x + a.w / 2, a.y + a.h / 2);
			}
			wires.push({ from, to, label: arrow.label, x1: start.x, y1: start.y, x2: end.x, y2: end.y });
		}
	}
	return { boxes, wires, width: sized.w, height: sized.h };
}
