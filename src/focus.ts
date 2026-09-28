/**
 * The focus diagram: one block read as a card, with its graph drawn around it,
 * and the cursor that walks that graph. Pure and browser-safe, so the terminal
 * screen, web mode and the browser page share one implementation.
 */
import { type Block, type DiagramDocument, type EdgeDirection, eachBlock, findBlockLocation } from "./model.ts";

export interface FocusLink {
	block: Block;
	label: string;
	direction: EdgeDirection;
	/** `edge` is a sibling relationship; `uses` is a cross-level reuse link. */
	kind: FocusLinkKind;
}

/** Sibling edges keep their authored direction; a `uses` link always reads forward. */
export type FocusLinkKind = "edge" | "uses";

/** What surrounds the focused block: its parent, the links into and out of it, and its children. */
export interface FocusNeighborhood {
	parent: Block | undefined;
	inputs: FocusLink[];
	outputs: FocusLink[];
	children: Block[];
}

/** Where the highlight sits in the diagram. `center` is the focused block itself. */
export type FocusSlot = "center" | "up" | "in" | "out" | "down";

export interface FocusCursor {
	slot: FocusSlot;
	index: number;
}

export type FocusCounts = Record<Exclude<FocusSlot, "center">, number>;

export type FocusMove = "up" | "down" | "left" | "right";

export const FOCUS_CENTER: FocusCursor = { slot: "center", index: 0 };

/**
 * The graph around `blockId`. No id, or an id this document does not know, reads
 * as the whole document: its top-level blocks hang below the centre. `shown`
 * filters what the reader wants to see (grounded mode); the parent is structural,
 * so it is never filtered.
 */
export function focusNeighborhood(
	document: DiagramDocument,
	blockId: string | undefined,
	shown: (block: Block) => boolean = () => true,
): FocusNeighborhood {
	const location = blockId === undefined ? undefined : findBlockLocation(document.root, blockId);
	if (!location) {
		return { parent: undefined, inputs: [], outputs: [], children: document.root.blocks.filter(shown) };
	}
	const { block, diagram } = location;
	const id = block.id;
	const inputs: FocusLink[] = [];
	const outputs: FocusLink[] = [];
	for (const edge of diagram.edges) {
		const inbound = edge.to === id && edge.from !== id;
		if (!inbound && edge.from !== id) continue;
		const otherId = inbound ? edge.from : edge.to;
		const other = diagram.blocks.find(candidate => candidate.id === otherId);
		if (!other || !shown(other)) continue;
		if (inbound) inputs.push({ block: other, label: edge.label, direction: edge.direction, kind: "edge" });
		else outputs.push({ block: other, label: edge.label, direction: edge.direction, kind: "edge" });
	}
	// Reuse links read the way the edges do: the left side is what the block
	// needs, the right side is what needs it.
	for (const usedId of block.uses ?? []) {
		const used = findBlockLocation(document.root, usedId)?.block;
		if (used && shown(used)) inputs.push({ block: used, label: "uses", direction: "forward", kind: "uses" });
	}
	for (const { block: user } of eachBlock(document.root)) {
		if (!user.uses?.includes(id) || !shown(user)) continue;
		outputs.push({ block: user, label: "used by", direction: "forward", kind: "uses" });
	}
	return { parent: location.ancestors.at(-1), inputs, outputs, children: (block.children?.blocks ?? []).filter(shown) };
}

export function focusCounts(hood: FocusNeighborhood): FocusCounts {
	return { up: hood.parent ? 1 : 0, in: hood.inputs.length, out: hood.outputs.length, down: hood.children.length };
}

/** A cursor that no longer fits its neighbourhood falls back to the centre. */
export function normalizeFocusCursor(cursor: FocusCursor, counts: FocusCounts): FocusCursor {
	if (cursor.slot !== "center" && cursor.index >= counts[cursor.slot]) return FOCUS_CENTER;
	return cursor;
}

/**
 * The cursor after moving one step. Movement is spatial: `up` reaches the parent,
 * `left`/`right` the inputs and the outputs, `down` the children, and every slot
 * reaches back to the centre. A move with no target leaves the cursor where it is.
 */
export function moveFocusCursor(cursor: FocusCursor, move: FocusMove, counts: FocusCounts): FocusCursor {
	const current = normalizeFocusCursor(cursor, counts);
	const step = (slot: Exclude<FocusSlot, "center">, delta: -1 | 1): FocusCursor => {
		const index = current.slot === slot ? current.index + delta : 0;
		if (index < 0 || index >= counts[slot]) return current;
		return { slot, index };
	};
	switch (current.slot) {
		case "center":
			if (move === "up") return step("up", 1);
			if (move === "down") return step("down", 1);
			if (move === "left") return step("in", 1);
			return step("out", 1);
		case "in":
			if (move === "left") return current;
			if (move === "right") return FOCUS_CENTER;
			if (move === "up") return step("in", -1);
			return step("in", 1);
		case "out":
			if (move === "right") return current;
			if (move === "left") return FOCUS_CENTER;
			if (move === "up") return step("out", -1);
			return step("out", 1);
		case "down":
			if (move === "down") return current;
			if (move === "up") return FOCUS_CENTER;
			if (move === "left") return step("down", -1);
			return step("down", 1);
		case "up":
			if (move === "down") return FOCUS_CENTER;
			return current;
	}
}

/** The block the cursor points at, or none when it rests on the centre or out of range. */
export function focusTarget(hood: FocusNeighborhood, cursor: FocusCursor): Block | undefined {
	switch (cursor.slot) {
		case "center":
			return undefined;
		case "up":
			return cursor.index === 0 ? hood.parent : undefined;
		case "in":
			return hood.inputs[cursor.index]?.block;
		case "out":
			return hood.outputs[cursor.index]?.block;
		case "down":
			return hood.children[cursor.index];
	}
}
