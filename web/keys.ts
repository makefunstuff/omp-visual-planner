/**
 * The page's keyboard: the same keys the terminal answers to, where the page
 * has the same surface. Dialogs take Escape and Enter first; typing keeps its keys.
 */
import { moveFocusCursor, FOCUS_CENTER, type FocusMove } from "../src/focus.ts";
import {
	app,
	cursorNow,
	cursorTarget,
	fit,
	flash,
	focus,
	focusCountsOf,
	focusLists,
	op,
	openDrift,
	openFile,
	openPreview,
	removeBlock,
	shown,
	stepStatus,
	submitPreview,
	toggleFiles,
	toggleMap,
	toggleMark,
	toggleSurface,
	walking,
} from "./app.svelte.ts";
import { allBlocks, selectedBlock } from "./doc.ts";

/** The block a new "o"/"O" lands on is renamed straight away on the map. */
function renameOnMap(result: { ok: boolean }): void {
	if (result.ok && app.surface === "map") app.editTitleOf = app.state?.selected ?? null;
}

export function onKeydown(event: KeyboardEvent, toggleKeys: () => void): void {
	const target = event.target as HTMLElement | null;
	const typing = !!target && ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName);
	const mod = event.metaKey || event.ctrlKey;
	const modal = app.modal;
	if (mod && event.key.toLowerCase() === "s") {
		event.preventDefault();
		void op({ op: "save" });
		return;
	}
	if (event.key === "Escape" && modal) {
		// A question asked over another dialog returns to it.
		app.modal = modal.kind === "confirm" ? modal.back : null;
		return;
	}
	if (event.key === "Escape" && app.purposeOpen) {
		app.purposeOpen = false;
		return;
	}
	if (event.key === "Escape" && app.viewer && !typing) {
		app.viewer = null;
		return;
	}
	if (event.key === "Enter" && modal?.kind === "preview" && !typing) {
		event.preventDefault();
		void submitPreview(modal.preview);
		return;
	}
	if (event.key === "/" && !typing) {
		event.preventDefault();
		toggleFiles(true);
		requestAnimationFrame(() => document.querySelector<HTMLInputElement>("#files input")?.focus());
		return;
	}
	if (event.key === "?" && !typing) {
		event.preventDefault();
		if (modal?.kind === "keys" || !modal) toggleKeys();
		return;
	}
	if (typing || modal) return;
	if (mod && event.key.toLowerCase() === "z") {
		event.preventDefault();
		void op({ op: event.shiftKey ? "redo" : "undo" });
		return;
	}
	const state = app.state;
	if (mod || !state?.document || !state.flow) return;
	const block = selectedBlock(state);
	const verb = state.flow.verbs.find(candidate => candidate.key === event.key);
	if (verb) {
		event.preventDefault();
		if (block) void openPreview(verb.id, block.id);
		return;
	}
	switch (event.key) {
		case "ArrowLeft":
		case "ArrowRight":
		case "ArrowUp":
		case "ArrowDown": {
			if (!walking()) return;
			event.preventDefault();
			const hood = focusLists();
			const move = event.key.slice(5).toLowerCase() as FocusMove;
			app.focusCursor = { for: state.selected, ...moveFocusCursor(cursorNow(hood), move, focusCountsOf(hood)) };
			return;
		}
		case "Escape":
			if (walking() && cursorNow(focusLists()).slot !== "center") {
				app.focusCursor = { for: state.selected, ...FOCUS_CENTER };
				return;
			}
			if (app.surface === "map" || app.surface === "screens") {
				app.surface = "page";
				return;
			}
			if (app.selectedEdge) {
				app.selectedEdge = null;
				return;
			}
			if (block) void focus(null);
			else if (state.stack.length > 1) void op({ op: "navigate", diagramId: state.stack.at(-2) });
			return;
		case "Enter": {
			if (app.surface === "map" && block) {
				void op({ op: "enter", id: block.id });
				return;
			}
			if (!walking()) return;
			const hood = focusLists();
			const next = cursorTarget(cursorNow(hood), hood);
			if (next) void focus(next.id);
			else if (block?.sources[0]) void openFile(block.sources[0].path, block.sources[0].startLine);
			else if (block) app.editBodyOf = block.id;
			return;
		}
		case " ":
			event.preventDefault();
			if (block) stepStatus(block);
			return;
		case "n":
			if (state.flow.nextOpen) void focus(state.flow.nextOpen, true);
			return;
		case "j":
		case "k": {
			// Depth-first, the order of the outline beside the page; grounded skips what it hides.
			const ids = allBlocks(state.document).filter(shown).map(item => item.id);
			if (!ids.length) return;
			const index = state.selected ? ids.indexOf(state.selected) : -1;
			const down = event.key === "j";
			const next = index === -1 ? (down ? 0 : ids.length - 1) : (index + (down ? 1 : ids.length - 1)) % ids.length;
			void focus(ids[next]!, true);
			return;
		}
		case "v":
			toggleMap();
			return;
		case "S":
			toggleSurface("screens");
			return;
		case "D":
			void openDrift();
			return;
		case "m":
			if (state.selected) toggleMark(state.selected);
			else flash("select a block first", true);
			return;
		case "U":
			if (block) app.modal = { kind: "uses", id: block.id };
			return;
		case "M":
			if (block && state.flow.extractTargets.length) app.modal = { kind: "extract", id: block.id };
			return;
		case "g":
			if (state.document.purpose === "explore") app.grounded = !app.grounded;
			return;
		case "o":
			if (walking() && state.document.purpose === "brainstorm") {
				// Focus without typing the "o" into it.
				event.preventDefault();
				document.querySelector<HTMLInputElement>("#dump")?.focus();
				return;
			}
			void op(block ? { op: "addBlock", afterId: block.id } : { op: "addBlock" }).then(renameOnMap);
			return;
		case "O":
			if (block) void op({ op: "addBlock", parentId: block.id }).then(renameOnMap);
			return;
		case "T":
			if (app.surface === "map") void op({ op: "tidy" }).then(fit);
			return;
		case "F":
		case "f":
			if (app.surface === "map") fit();
			return;
		case "F2":
			if (block && app.surface === "map") app.editTitleOf = block.id;
			return;
		case "Delete":
		case "Backspace":
			if (app.selectedEdge) {
				const id = app.selectedEdge;
				app.selectedEdge = null;
				void op({ op: "removeEdge", id });
				return;
			}
			if (block) removeBlock(block);
			else if (state.stack.length > 1 && event.key === "Backspace") void op({ op: "navigate", diagramId: state.stack.at(-2) });
			return;
	}
}
