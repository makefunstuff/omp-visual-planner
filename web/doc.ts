/**
 * Pure reads over the document the server sent: which diagram is on screen,
 * which block is focused, where a block sits on the map, what cites what.
 */
import type { Block, Diagram, DiagramDocument, SourceRef } from "../src/model.ts";
import type { WebState } from "../src/web.ts";

// One map cell is SX x SY world pixels, and a node covers the cells the terminal
// card does (cardWidth x 4) minus a gutter: a layout that does not overlap in the
// terminal does not overlap here. A selected node grows over its neighbours.
export const SX = 11;
export const SY = 26;
export const CARD_ROWS = 4;
export const GUTTER = 8;

export interface Box {
	x: number;
	y: number;
	w: number;
	h: number;
}

/** Same as `cardWidth` in ui.ts: border, a space, the title, a space, border. */
export function cardCols(title: string): number {
	return Math.max(12, Math.min(32, [...title].length + 4));
}

export function rectOf(block: Block): Box {
	return { x: block.position.x * SX, y: block.position.y * SY, w: cardCols(block.title) * SX - GUTTER, h: CARD_ROWS * SY - GUTTER };
}

/** The diagram the navigation stack points at. */
export function currentDiagram(state: WebState): Diagram | null {
	if (!state.document) return null;
	let diagram = state.document.root;
	for (const id of state.stack.slice(1)) {
		const owner = diagram.blocks.find(block => block.children?.id === id);
		if (!owner?.children) break;
		diagram = owner.children;
	}
	return diagram;
}

/** The focused block when it is in the diagram on screen. */
export function selectedBlock(state: WebState): Block | null {
	const diagram = currentDiagram(state);
	return diagram && state.selected ? (diagram.blocks.find(block => block.id === state.selected) ?? null) : null;
}

function* blocksOf(diagram: Diagram): Generator<Block> {
	for (const block of diagram.blocks) {
		yield block;
		if (block.children) yield* blocksOf(block.children);
	}
}

/** The block with this id anywhere in the tree. */
export function findBlock(document: DiagramDocument | undefined, id: string | null | undefined): Block | null {
	if (!document || !id) return null;
	for (const block of blocksOf(document.root)) if (block.id === id) return block;
	return null;
}

/** The block whose children diagram is `diagramId`. */
export function ownerOfDiagram(document: DiagramDocument, diagramId: string): Block | null {
	for (const block of blocksOf(document.root)) if (block.children?.id === diagramId) return block;
	return null;
}

/** Every block in the tree, depth-first: the outline's order. */
export function allBlocks(document: DiagramDocument): Block[] {
	return [...blocksOf(document.root)];
}

/** `path:10-40`, `path:12` or `path`. */
export function rangeText(source: SourceRef): string {
	if (!source.startLine) return source.path;
	const end = source.endLine && source.endLine !== source.startLine ? `-${source.endLine}` : "";
	return `${source.path}:${source.startLine}${end}`;
}

/** A block's first citation, with how many more it has. */
export function citationOf(block: Block): string {
	const source = block.sources[0];
	if (!source) return "";
	return rangeText(source) + (block.sources.length > 1 ? ` +${block.sources.length - 1}` : "");
}

/** How many blocks reuse each block id: the outline's ×N mark. */
export function usedCounts(document: DiagramDocument): Map<string, number> {
	const counts = new Map<string, number>();
	for (const block of blocksOf(document.root)) for (const id of block.uses ?? []) counts.set(id, (counts.get(id) ?? 0) + 1);
	return counts;
}

/** Every source in the document: path -> the blocks that cite it and where. */
export function citations(document: DiagramDocument | undefined): Map<string, { block: Block; source: SourceRef }[]> {
	const byPath = new Map<string, { block: Block; source: SourceRef }[]>();
	if (!document) return byPath;
	for (const block of blocksOf(document.root)) {
		for (const source of block.sources) {
			const list = byPath.get(source.path);
			if (list) list.push({ block, source });
			else byPath.set(source.path, [{ block, source }]);
		}
	}
	return byPath;
}

/** The states of a block's citations that are not fresh, from the last check. */
export function driftStates(state: WebState, blockId: string): string[] {
	return state.drift ? state.drift.citations.filter(check => check.blockId === blockId).map(check => check.state) : [];
}

/** The last check's verdict on one citation, when it is not fresh and still names this ref. */
export function citationCheck(state: WebState, blockId: string, index: number, source: SourceRef) {
	const check = state.drift?.citations.find(candidate => candidate.blockId === blockId && candidate.index === index);
	if (!check) return null;
	const same = check.source.path === source.path && check.source.startLine === source.startLine && check.source.endLine === source.endLine;
	return same ? check : null;
}

/** How many blocks outside `block`'s subtree use something inside it: the links a delete cuts. */
export function usersCut(document: DiagramDocument, block: Block): number {
	const doomed = new Set([...blocksOf({ id: "", blocks: [block], edges: [] })].map(candidate => candidate.id));
	return allBlocks(document).filter(candidate => !doomed.has(candidate.id) && (candidate.uses ?? []).some(id => doomed.has(id))).length;
}
