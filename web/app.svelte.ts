/**
 * The page's state. The server owns the tree and only reads it; this module
 * holds what is this tab's own: the selection, collapsed boxes, the full-size
 * preview, and whether the server answers.
 */
import { SvelteSet } from "svelte/reactivity";
import { findNode } from "../src/layout.ts";
import type { PlanTree, Status, TreeNode } from "../src/tree.ts";

export const app = $state<{
	tree: PlanTree | null;
	error: string | null;
	/** The selected node's path. */
	selected: string | null;
	/** The HTML shown full size, or null. */
	fullSize: string | null;
	offline: boolean;
	updatedAt: string;
}>({ tree: null, error: null, selected: null, fullSize: null, offline: false, updatedAt: "" });

/** Paths of collapsed boxes. */
export const collapsed = new SvelteSet<string>();

/** Set by the canvas once it is mounted: fit everything, or one box. */
export const canvas: { fit: (path?: string) => void } = { fit: () => {} };

export const GLYPHS: Record<Status, string> = { open: "○", settled: "◐", done: "●" };

export function allNodes(node: TreeNode): TreeNode[] {
	return [node, ...node.children.flatMap(allNodes)];
}

export async function poll(): Promise<void> {
	try {
		const url = `/api/tree${app.tree ? `?since=${encodeURIComponent(app.tree.version)}` : ""}`;
		const response = await fetch(url);
		app.offline = response.status !== 200 && response.status !== 204 && response.status !== 404;
		if (response.status === 200) {
			const tree = (await response.json()) as PlanTree;
			app.tree = tree;
			app.error = null;
			app.updatedAt = new Date().toLocaleTimeString("en-GB", { hour12: false });
			if (app.selected !== null && !findNode(tree.root, app.selected)) app.selected = null;
		} else if (response.status === 404) {
			app.tree = null;
			app.selected = null;
			app.error = ((await response.json()) as { error?: string }).error ?? "no plan tree";
		}
	} catch {
		app.offline = true;
	}
	setTimeout(poll, 1000);
}
