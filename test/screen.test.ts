import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionUIContext } from "@oh-my-pi/pi-coding-agent";
import { visibleWidth } from "@oh-my-pi/pi-tui";
import { loadThemeSync } from "@oh-my-pi/pi-tui/theme/loader";
import { type } from "@oh-my-pi/omptype";
import { ActionRegistry, type BeginInput } from "../src/actions.ts";
import type { CodeIntel } from "../src/code-intel.ts";
import { stampMissing } from "../src/drift.ts";
import { createBlock, createDiagram, createDocument, createEdge } from "../src/model.ts";
import type { RelatedOutcome, RelatedRanker } from "../src/relevance.ts";
import { DocumentStore, serializeDocument } from "../src/store.ts";
import { DiagramScreen, type ScreenLink, type SharedFocus, layoutFor } from "../src/ui.ts";

const theme = loadThemeSync("dark");
const directories: string[] = [];

afterEach(async () => {
	await Promise.all(directories.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

/** Only `setEditorText` is observable; the screen owns every other interaction. */
const uiStub = { setEditorText: () => {} } as unknown as ExtensionUIContext;

interface Harness {
	screen: DiagramScreen;
	store: DocumentStore;
	/** What the other surface reads. */
	shared: SharedFocus;
	/** Another surface moved focus (or changed the session) — `undefined` clears focus. */
	external(selected: string | undefined): void;
	listeners: Set<unknown>;
	tui: { stopped: number };
	registry: ActionRegistry;
	result(): unknown;
}

/**
 * Opens the fixture through a real file so the store reports it clean, the way
 * a document behaves outside a just-accepted proposal.
 */
async function harness(
	options: {
		width: number;
		rows: number;
		document?: ReturnType<typeof fixture>;
		view?: "outline" | "canvas";
		editor?: (text: string, name: string) => Promise<string | null>;
		rankRelated?: RelatedRanker;
		/** The workspace citations resolve against; defaults to a path nothing reads. */
		cwd?: string;
		codeIntel?: CodeIntel;
		isIdle?: () => boolean;
	} = {
		width: 120,
		rows: 24,
	},
): Promise<Harness> {
	const document = options.document ?? fixture();
	const directory = await mkdtemp(join(tmpdir(), "omp-visual-planner-screen-"));
	directories.push(directory);
	const path = join(directory, "architecture.json");
	await writeFile(path, serializeDocument(document), "utf8");
	const store = new DocumentStore(type);
	const opened = await store.open(path);
	if (!opened.ok) throw new Error(String(opened.errors));
	const registry = new ActionRegistry("session:leaf");
	let rows = options.rows;
	let result: unknown;
	const tui = {
		terminal: {
			get columns() {
				return options.width;
			},
			get rows() {
				return rows;
			},
		},
		requestRender: () => {},
		// The overlay hands the terminal to an external editor between these two.
		stopped: 0,
		stop() {
			this.stopped += 1;
		},
		start: () => {},
	};
	// Stands in for the session the extension shares between the overlay and web mode.
	const shared: SharedFocus = { selected: undefined, stack: [] };
	const listeners = new Set<(focus: SharedFocus) => void>();
	const link: ScreenLink = {
		publish: (selected, stack) => Object.assign(shared, { selected, stack }),
		subscribe: listener => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
	};
	const external = (selected: string | undefined) => {
		shared.selected = selected;
		for (const listener of listeners) listener({ ...shared });
	};
	const screen = new DiagramScreen(
		{
			tui: tui as never,
			theme,
			ui: uiStub,
			store,
			registry,
			arktype: type,
			cwd: options.cwd ?? "/tmp/planner",
			branchKey: "session:leaf",
			documentPathHint: "/tmp/planner/.omp-visual-planner/architecture.json",
			hasUI: true,
			isIdle: options.isIdle ?? (() => true),
			hasPendingMessages: () => false,
			link,
			externalEditor: options.editor,
			rankRelated: options.rankRelated,
			codeIntel: options.codeIntel,
		},
		value => {
			result = value;
		},
	);
	// The outline is the default surface; canvas tests switch to the map once.
	if (options.view === "canvas") screen.handleInput("v");
	return { screen, store, registry, shared, external, listeners, tui, result: () => result };
}

/**
 * root: api (left), db (right) -> "stores", worker below (unknown)
 * api.children: auth
 */
function fixture() {
	const document = createDocument({ id: "doc-1", title: "Service", goal: "Ship auth" });
	const api = createBlock({ id: "api", title: "API", description: "HTTP surface", x: 2, y: 2 });
	const db = createBlock({ id: "db", title: "Database", x: 30, y: 2 });
	const worker = createBlock({ id: "worker", title: "Worker", x: 2, y: 20, evidence: "unknown" });
	document.root.blocks.push(api, db, worker);
	document.root.edges.push(createEdge({ id: "e1", from: "api", to: "db", label: "stores", fromPort: "east", toPort: "west" }));
	api.children = createDiagram({ id: "api-inner", blocks: [createBlock({ id: "auth", title: "Auth", description: "tokens" })] });
	return document;
}

function plain(lines: readonly string[]): string[] {
	return lines.map(line => line.replaceAll(/\u001b\[[0-9;]*m/g, ""));
}

/** The rows inside the dialog whose title rule contains `marker`. */
function dialogRows(lines: readonly string[], marker: string): string[] {
	const start = lines.findIndex(line => line.includes(marker));
	if (start === -1) return [];
	const rows: string[] = [];
	for (let index = start + 1; index < lines.length; index += 1) {
		const line = lines[index]!;
		if (line.includes("╰")) break;
		rows.push(line);
	}
	return rows;
}

describe("overlay geometry", () => {
	test("every rendered line is exactly the requested width", async () => {
		for (const width of [40, 60, 80, 100, 120, 160]) {
			for (const rows of [10, 24, 36, 60]) {
				const lines = (await harness({ width, rows })).screen.render(width);
				expect(lines.length).toBe(rows);
				for (const line of lines) expect(visibleWidth(line)).toBe(width);
			}
		}
	});

	test("a tiny terminal shows the size warning and stays usable", async () => {
		const lines = plain((await harness({ width: 30, rows: 24 })).screen.render(30));
		expect(lines[0]).toContain("omp-visual-planner");
		expect(lines.join("\n")).toContain("terminal is 30x24");
		expect(lines.join("\n")).toContain("needs 40x10 to draw");
		expect(lines.join("\n")).toContain("[Esc] close");
		for (const line of lines) expect(visibleWidth(line)).toBe(30);
	});

	test("narrow terminals stack the panes instead of splitting them", async () => {
		const h = await harness({ width: 80, rows: 24 });
		const lines = plain(h.screen.render(80));
		// One pane only: the inspector header must not be present until it has focus.
		expect(lines.join("\n")).not.toContain("nothing selected");
		expect(lines.join("\n")).toContain("API");
	});

	test("a wide terminal splits 34 columns of inspector off the canvas", async () => {
		const layout = layoutFor(120, 36);
		const lines = plain((await harness({ width: 120, rows: 36, view: "canvas" })).screen.render(120));
		expect(lines[0]).toContain("omp-visual-planner — Service");
		// The breadcrumb is only the path: the keys live in the status line.
		expect(lines[1]).toContain("Service");
		// The inspector's vertical edges sit exactly at the reserved columns.
		const inspectorStart = layout.canvasWidth + 2;
		expect(lines[3]![inspectorStart]).toBe("│");
		expect(lines[3]![119]).toBe("│");
	});
});

describe("canvas rendering", () => {
	const canvas = { width: 120, rows: 24, view: "canvas" } as const;
	test("draws a bordered card per block with its title and description", async () => {
		const lines = plain((await harness(canvas)).screen.render(120));
		const joined = lines.join("\n");
		// A plan card carries its status on the top border.
		expect(joined).toMatch(/┌○─{9}┐/);
		expect(joined).toContain("│ API");
		expect(joined).toContain("HTTP surface");
		expect(joined).toContain("Database");
	});

	test("keeps an off-screen block off the canvas", async () => {
		const lines = plain((await harness(canvas)).screen.render(120));
		// `worker` is unknown and sits below the fold at 24 rows, so pan to it.
		const joined = lines.join("\n");
		expect(joined).toContain("API");
		expect(joined).not.toContain("Worker");
	});

	test("draws an orthogonal relationship with an arrowhead and its label", async () => {
		const lines = plain((await harness(canvas)).screen.render(120));
		const joined = lines.join("\n");
		expect(joined).toContain("─");
		expect(joined).toContain("stores");
		const arrow = lines.find(line => line.includes(">"));
		expect(arrow).toBeDefined();
	});

	test("the status strip reports the current diagram's block and unknown counts", async () => {
		const lines = plain((await harness(canvas)).screen.render(120));
		expect(lines[lines.length - 2]!).toContain("map · 3 blocks · 1 unknown");
	});

	test("a relationship label is drawn in free space and never over a card", async () => {
		const apart = fixture();
		apart.root.blocks[1]!.position = { x: 60, y: 2 };
		const lines = plain((await harness({ ...canvas, document: apart })).screen.render(120));
		const joined = lines.join("\n");
		expect(joined).toContain("stores");
		// The card borders survive: the label only used free cells.
		expect(joined).toMatch(/┌.─{9}┐/);

		// Two cells apart leaves no room, and the label is omitted rather than
		// overwriting the neighbouring card.
		const cramped = plain((await harness(canvas)).screen.render(120)).join("\n");
		expect(cramped).toContain("Database");
		expect(cramped.match(/┌.─{9}┐/g)?.length).toBe(2);
	});

	test("a dirty document must be saved before starting a new one", async () => {
		const h = await harness(canvas);
		h.screen.render(120);
		h.screen.handleInput("o");
		h.screen.handleInput("a");
		h.screen.render(120);
		// Refine, Break down, Replan, Execute, Uses…, Draft…, then Discover…
		for (let step = 0; step < 6; step += 1) h.screen.handleInput("j");
		h.screen.handleInput("\r");
		h.screen.render(120);
		h.screen.handleInput("\r");
		const lines = plain(h.screen.render(120));
		expect(lines.join("\n")).toContain("save this document (s) before starting a new one");
		expect(h.store.require().root.blocks).toHaveLength(4);
	});

	test("a cold start lets discovery proceed instead of demanding a save", async () => {
		const directory = await mkdtemp(join(tmpdir(), "omp-visual-planner-cold-"));
		directories.push(directory);
		const store = new DocumentStore(type);
		const screen = new DiagramScreen(
			{
				tui: { terminal: { columns: 120, rows: 24 }, requestRender: () => {} } as never,
				theme,
				ui: uiStub,
				store,
				registry: new ActionRegistry("session:leaf"),
				arktype: type,
				cwd: directory,
				branchKey: "session:leaf",
				documentPathHint: join(directory, ".omp-visual-planner", "architecture.json"),
				hasUI: true,
				isIdle: () => true,
				hasPendingMessages: () => false,
			},
			() => {},
			{ action: "discover", target: "fixture" },
		);
		const lines = plain(screen.render(120));
		expect(lines.join("\n")).toContain("codebase path to map");
		expect(lines.join("\n")).not.toContain("save this document");
	});

	test("a cold start with nothing on disk still renders the empty state", async () => {
		const directory = await mkdtemp(join(tmpdir(), "omp-visual-planner-cold-"));
		directories.push(directory);
		const store = new DocumentStore(type);
		const screen = new DiagramScreen(
			{
				tui: { terminal: { columns: 120, rows: 24 }, requestRender: () => {} } as never,
				theme,
				ui: uiStub,
				store,
				registry: new ActionRegistry("session:leaf"),
				arktype: type,
				cwd: directory,
				branchKey: "session:leaf",
				documentPathHint: join(directory, ".omp-visual-planner", "architecture.json"),
				hasUI: true,
				isIdle: () => true,
				hasPendingMessages: () => false,
			},
			() => {},
		);
		const lines = plain(screen.render(120));
		expect(lines.join("\n")).toContain("nothing planned yet");
		expect(lines.join("\n")).toContain("o add a block   a draft, discover or change");
		for (const line of lines) expect(visibleWidth(line)).toBe(120);
	});

	test("the empty state is worded for the document's purpose", async () => {
		const empty = createDocument({ id: "doc-2", title: "Empty", purpose: "brainstorm" });
		const joined = plain((await harness({ width: 120, rows: 24, document: empty })).screen.render(120)).join("\n");
		expect(joined).toContain("empty mind map");
		expect(joined).toContain("o add an idea   a seed from a prompt");
		const canvasEmpty = plain(
			(await harness({ width: 120, rows: 24, document: createDocument({ id: "doc-3" }), view: "canvas" })).screen.render(120),
		).join("\n");
		expect(canvasEmpty).toContain("No blocks in this subsystem yet.");
	});

	test("a walk draws the focused block with inputs left, outputs right and children below; arrows walk it", async () => {
		const map = fixture();
		map.purpose = "explore";
		const h = await harness({ width: 140, rows: 30, document: map });
		const lines = plain(h.screen.render(140));
		const row = lines.find(line => line.includes("───▶") && line.includes("Database"));
		expect(row).toBeDefined();
		// The wire sits between the card and the block the card links to; the
		// outline pane lists "Database" too, so compare against its last occurrence.
		expect(row!.indexOf("───▶")).toBeLessThan(row!.lastIndexOf("Database"));
		const joined = lines.join("\n");
		expect(joined).toContain("inside · 1");
		expect(joined).toContain("Auth");

		h.screen.handleInput("\x1b[C");
		h.screen.handleInput("\r");
		expect(h.shared.selected).toBe("db");
		h.screen.handleInput("\x1b[D");
		h.screen.handleInput("\r");
		expect(h.shared.selected).toBe("api");
		h.screen.handleInput("\x1b[B");
		h.screen.handleInput("\r");
		expect(h.shared.selected).toBe("auth");
		h.screen.handleInput("\x1b[A");
		h.screen.handleInput("\r");
		expect(h.shared.selected).toBe("api");
		h.screen.handleInput("\x1b[C");
		h.screen.handleInput("\x1b");
		expect(h.result()).toBeUndefined();
		h.screen.handleInput("\r");
		expect(h.shared.selected).toBe("api");
		expect(plain(h.screen.render(140)).join("\n")).toContain("› ");
	});

	test("U links the focused block to a reusable one and the walk draws a dashed wire", async () => {
		const map = fixture();
		map.purpose = "explore";
		const h = await harness({ width: 140, rows: 30, document: map });
		h.screen.handleInput("j");
		expect(h.shared.selected).toBe("auth");
		h.screen.handleInput("U");
		h.screen.render(140);
		h.screen.handleInput("\r");
		expect(h.store.require().root.blocks[0]!.children!.blocks[0]!.uses).toEqual(["db"]);

		h.screen.handleInput("\x1b");
		const lines = plain(h.screen.render(140));
		expect(lines.join("\n")).toContain("×1");
		const wire = lines.find(line => line.includes("┄┄┄▶"));
		expect(wire).toBeDefined();
		// The wire sits between the card and what it uses; the outline lists the
		// same title, so compare against its last occurrence.
		expect(wire!.lastIndexOf("Database")).toBeLessThan(wire!.indexOf("┄┄┄▶"));
	});

	test("M lifts the focused block to a shared level and its former parent starts using it", async () => {
		const map = fixture();
		map.purpose = "explore";
		const h = await harness({ width: 140, rows: 30, document: map });
		h.screen.handleInput("j");
		h.screen.handleInput("M");
		h.screen.render(140);
		h.screen.handleInput("\r");
		const root = h.store.require().root;
		expect(root.blocks.map(block => block.id)).toEqual(["api", "auth", "db", "worker"]);
		expect(root.blocks[0]!.uses).toEqual(["auth"]);
		expect(h.shared.selected).toBe("auth");
	});

	test("the walk is exactly the terminal width at every size", async () => {
		for (const width of [60, 80, 100, 120, 160]) {
			for (const rows of [16, 30]) {
				const map = fixture();
				map.purpose = "explore";
				map.root.blocks[0]!.children!.blocks[0]!.uses = ["db"];
				const screen = (await harness({ width, rows, document: map })).screen;
				for (const line of screen.render(width)) expect(visibleWidth(line)).toBe(width);
			}
		}
	});

	test("brainstorm and unexplored blocks walk; a settled explore block keeps the page", async () => {
		const ideas = createDocument({ id: "ideas", title: "Ideas", purpose: "brainstorm" });
		ideas.root.blocks.push(createBlock({ id: "spark", title: "Spark", description: "a loose idea" }));
		const brainstorm = plain((await harness({ width: 120, rows: 24, document: ideas })).screen.render(120));
		expect(brainstorm.at(-2)).toContain("walk");
		expect(brainstorm.join("\n")).toContain("Spark");
		expect(brainstorm.join("\n")).toContain("O dumps a line onto it");

		const map = fixture();
		map.purpose = "explore";
		map.root.blocks[0]!.sources = [{ path: "src/flow.ts", startLine: 10, endLine: 12 }];
		const walking = plain((await harness({ width: 120, rows: 24, document: map })).screen.render(120));
		expect(walking.at(-2)).toContain("walk");
		expect(walking.join("\n")).toContain("src/flow.ts:10-12");
		expect(walking.at(-2)).toContain("g grounded");

		map.root.blocks[0]!.status = "settled";
		const page = plain((await harness({ width: 120, rows: 24, document: map })).screen.render(120));
		expect(page.at(-2)).not.toContain("walk");
		expect(page.join("\n")).toContain("notes");
	});

	test("Enter on a walked idea opens its editable page", async () => {
		const ideas = createDocument({ id: "ideas", title: "Ideas", purpose: "brainstorm" });
		ideas.root.blocks.push(createBlock({ id: "spark", title: "Spark" }));
		const h = await harness({ width: 120, rows: 24, document: ideas });
		h.screen.render(120);
		h.screen.handleInput("\r");
		h.screen.handleInput("j");
		h.screen.handleInput("\r");
		for (const key of "a loose idea") h.screen.handleInput(key);
		h.screen.handleInput("\r");
		expect(h.store.require().root.blocks[0]!.description).toBe("a loose idea");
	});

	test("a page shows its surface and Enter on the surface row cycles it", async () => {
		const ideas = createDocument({ id: "ideas", title: "Ideas", purpose: "brainstorm" });
		ideas.root.blocks.push(createBlock({ id: "home", title: "Home", surface: "page" }));
		const h = await harness({ width: 120, rows: 24, document: ideas });
		expect(plain(h.screen.render(120)).join("\n")).toContain("[page]");
		h.screen.handleInput("\r");
		h.screen.handleInput("j");
		h.screen.handleInput("j");
		h.screen.handleInput("\r");
		expect(h.store.require().root.blocks[0]!.surface).toBe("component");
		h.screen.handleInput("\r");
		expect(h.store.require().root.blocks[0]!.surface).toBeUndefined();
	});

	test("discovering from the terminal highlights the cited source", async () => {
		const directory = await mkdtemp(join(tmpdir(), "omp-visual-planner-cite-"));
		directories.push(directory);
		const file = join(directory, "note.ts");
		await writeFile(file, "export const token = 1;\n");
		const map = createDocument({ id: "map", title: "Map", purpose: "explore" });
		map.root.blocks.push(
			createBlock({
				id: "note",
				title: "Note",
				sources: [{ path: file, startLine: 1, endLine: 1 }],
			}),
		);
		const opened = await harness({ width: 120, rows: 24, document: map });
		opened.screen.render(120);
		await new Promise(resolve => setTimeout(resolve, 80));
		const raw = opened.screen.render(120).join("\n");
		expect(raw).toMatch(/\u001b\[[0-9;]*mexport/);
		opened.screen.handleInput("enter");
		const source = opened.screen.render(120).join("\n");
		expect(source).toMatch(/\u001b\[[0-9;]*mexport/);
		expect(source).toContain("token");
	});

	test("a cited file indented with tabs never reaches the terminal as tabs", async () => {
		const directory = await mkdtemp(join(tmpdir(), "omp-visual-planner-tabs-"));
		directories.push(directory);
		const file = join(directory, "tabs.ts");
		await writeFile(file, "export function f() {\n\tif (x) {\n\t\treturn 1;\n\t}\n}\n");
		const map = createDocument({ id: "map", title: "Map", purpose: "explore" });
		map.root.blocks.push(createBlock({ id: "f", title: "F", sources: [{ path: file, startLine: 1, endLine: 5 }] }));
		const opened = await harness({ width: 120, rows: 24, document: map });
		// The citation and the source view load asynchronously and ask for a redraw when read.
		const tui = opened.tui as unknown as { requestRender: () => void };
		const redrawn = () => {
			const { promise, resolve } = Promise.withResolvers<void>();
			tui.requestRender = resolve;
			return promise;
		};
		const read = redrawn();
		opened.screen.render(120);
		await read;
		// A tab jumps to the terminal's next tab stop while the layout counted three columns.
		const walk = opened.screen.render(120);
		expect(plain(walk).join("\n")).toContain("return 1;");
		for (const line of walk) expect(line).not.toContain("\t");
		// Enter redraws at once; the file read redraws again when it lands.
		opened.screen.handleInput("\r");
		await redrawn();
		const source = opened.screen.render(120);
		expect(plain(source).join("\n")).toContain("source:");
		for (const line of source) expect(line).not.toContain("\t");
	});

	test("a code fence on the page is syntax-highlighted", async () => {
		const document = fixture();
		document.root.blocks[0]!.description = "```ts\nexport const n = 1;\n```";
		const raw = (await harness({ width: 120, rows: 30, document })).screen.render(120).join("\n");
		expect(raw).toMatch(/\u001b\[[0-9;]*mexport/);
	});
});

describe("interaction", () => {
	const canvas = { width: 120, rows: 24, view: "canvas" } as const;
	test("a block is added, selected, and the diagram re-renders", async () => {
		const h = await harness(canvas);
		h.screen.render(120);
		h.screen.handleInput("o");
		const lines = plain(h.screen.render(120));
		expect(lines.join("\n")).toContain("added a block");
		expect(h.store.require().root.blocks).toHaveLength(4);
		expect(lines.join("\n")).toContain("New block");
	});

	test("undo and redo walk the edit history", async () => {
		const h = await harness(canvas);
		h.screen.render(120);
		h.screen.handleInput("o");
		h.screen.handleInput("u");
		expect(plain(h.screen.render(120))[22]).toContain("undone");
		h.screen.handleInput("\x12");
		expect(plain(h.screen.render(120))[22]).toContain("redone");
	});

	test("descending into a block and ascending restores the breadcrumb", async () => {
		const h = await harness(canvas);
		h.screen.render(120);
		h.screen.handleInput("\r");
		const inside = plain(h.screen.render(120));
		expect(inside[1]).toContain("API");
		expect(inside.join("\n")).toContain("Auth");
		h.screen.handleInput("\x7f");
		const back = plain(h.screen.render(120));
		expect(back[1]).not.toContain("API");
	});

	test("moving a block changes its stored position", async () => {
		const h = await harness(canvas);
		h.screen.render(120);
		for (let step = 0; step < 3; step += 1) h.screen.handleInput("L");
		const lines = plain(h.screen.render(120));
		expect(lines.join("\n")).toContain("moved API");
		expect(h.store.require().revision).toBe(3);
	});

	test("a pending link commits with Enter even from the inspector pane", async () => {
		const h = await harness(canvas);
		h.screen.render(120);
		h.screen.handleInput("i");
		h.screen.handleInput("e");
		h.screen.render(120);
		h.screen.handleInput("\r");
		const lines = plain(h.screen.render(120));
		expect(lines.join("\n")).toContain("added a relationship");
		expect(lines.join("\n")).toContain("relationship ");
		expect(lines.join("\n")).toContain("label:");
	});

	test("escape cancels a pending link instead of closing the planner", async () => {
		const h = await harness(canvas);
		h.screen.render(120);
		h.screen.handleInput("e");
		expect(plain(h.screen.render(120)).join("\n")).toContain("linking from API");
		h.screen.handleInput("\x1b");
		const lines = plain(h.screen.render(120));
		expect(lines.join("\n")).toContain("link cancelled");
		expect(h.result()).toBeUndefined();
		// A second escape really does close.
		h.screen.handleInput("\x1b");
		expect(h.result()).toEqual({ kind: "closed" });
	});

	test("escape on a clean document closes the overlay", async () => {
		const h = await harness();
		h.screen.render(120);
		h.screen.handleInput("\x1b");
		expect(h.result()).toEqual({ kind: "closed" });
	});

	test("escape on a dirty document asks before discarding", async () => {
		const h = await harness(canvas);
		h.screen.render(120);
		h.screen.handleInput("o");
		h.screen.handleInput("\x1b");
		expect(h.result()).toBeUndefined();
		const lines = plain(h.screen.render(120));
		expect(lines.join("\n")).toContain("unsaved changes");
		expect(lines.join("\n")).toContain("› Save");
		// Cancel keeps the overlay and the edit.
		h.screen.handleInput("j");
		h.screen.handleInput("j");
		h.screen.handleInput("\r");
		expect(h.result()).toBeUndefined();
		expect(h.store.require().root.blocks).toHaveLength(4);
	});

	test("opening the planner with a staged proposal lands on the review", async () => {
		const document = fixture();
		const directory = await mkdtemp(join(tmpdir(), "omp-visual-planner-review-"));
		directories.push(directory);
		const path = join(directory, "architecture.json");
		await writeFile(path, serializeDocument(document), "utf8");
		const store = new DocumentStore(type);
		await store.open(path);
		const registry = new ActionRegistry("session:leaf");
		registry.begin({
			requestId: "req-1",
			kind: "enhance",
			intent: "enhance",
			scope: { kind: "block", id: "api" },
			label: 'block "API"',
			branchKey: "session:leaf",
			documentId: document.id,
			baseRevision: 0,
			baseDigest: undefined,
			prompt: "payload",
		});
		const staged = registry.stage(
			"req-1",
			"refined the API block",
			createBlock({ id: "api", title: "API v2", description: "HTTP surface" }),
			{ branchKey: "session:leaf", documentId: document.id, diskDigest: undefined, arktype: type },
		);
		expect(staged.ok).toBe(true);

		const screen = new DiagramScreen(
			{
				tui: { terminal: { columns: 120, rows: 24 }, requestRender: () => {} } as never,
				theme,
				ui: uiStub,
				store,
				registry,
				arktype: type,
				cwd: directory,
				branchKey: "session:leaf",
				documentPathHint: path,
				hasUI: true,
				isIdle: () => true,
				hasPendingMessages: () => false,
			},
			() => {},
		);
		const lines = plain(screen.render(120));
		expect(lines.join("\n")).toContain("review proposal");
		expect(lines.join("\n")).toContain("refined the API block");
		expect(lines.join("\n")).toContain("Enter accept");
		// Escape leaves the review and returns to the diagram.
		screen.handleInput("\x1b");
		const after = plain(screen.render(120));
		expect(after.join("\n")).not.toContain("review proposal");
		expect(after.join("\n")).toContain("API");
		for (const line of after) expect(visibleWidth(line)).toBe(120);
	});

	test("a staged prune that drops settled work is shown as an error and never applied", async () => {
		const document = fixture();
		document.root.blocks[0]!.status = "settled";
		const directory = await mkdtemp(join(tmpdir(), "omp-visual-planner-prune-"));
		directories.push(directory);
		const path = join(directory, "architecture.json");
		await writeFile(path, serializeDocument(document), "utf8");
		const store = new DocumentStore(type);
		await store.open(path);
		const registry = new ActionRegistry("session:leaf");
		registry.begin({
			requestId: "req-2",
			kind: "prune",
			intent: "prune",
			scope: { kind: "project" },
			label: 'project "Service"',
			branchKey: "session:leaf",
			documentId: document.id,
			baseRevision: 0,
			baseDigest: undefined,
			prompt: "payload",
		});
		const replacement = structuredClone(document);
		replacement.root.blocks = replacement.root.blocks.filter(block => block.id !== "api");
		replacement.root.edges = [];
		// A client that did not hand the document to staging still gets the guard here.
		const staged = registry.stage("req-2", "pruned the plan", replacement, {
			branchKey: "session:leaf",
			documentId: document.id,
			diskDigest: undefined,
			arktype: type,
		});
		expect(staged.ok).toBe(true);

		const screen = new DiagramScreen(
			{
				tui: { terminal: { columns: 120, rows: 24 }, requestRender: () => {} } as never,
				theme,
				ui: uiStub,
				store,
				registry,
				arktype: type,
				cwd: directory,
				branchKey: "session:leaf",
				documentPathHint: path,
				hasUI: true,
				isIdle: () => true,
				hasPendingMessages: () => false,
			},
			() => {},
		);
		expect(plain(screen.render(120)).join("\n")).toContain("settled work");
		screen.handleInput("\r");
		expect(plain(screen.render(120)).join("\n")).toContain("settled work");
		expect(store.require().root.blocks.map(block => block.id)).toEqual(["api", "db", "worker"]);
		expect(registry.active()[0]?.state).toBe("staged");
	});

	test("a modal is drawn over the diagram, not instead of it", async () => {
		// Tall enough that the action menu cannot cover every card.
		const h = await harness({ ...canvas, rows: 34 });
		h.screen.render(120);
		h.screen.handleInput("a");
		const lines = plain(h.screen.render(120));
		const joined = lines.join("\n");
		// the dialog is present...
		expect(joined).toContain('Refine "API"');
		// ...and so are the cards it is floating over
		expect(joined).toContain("API");
		expect(joined).toContain("Database");
		expect(joined).toContain("HTTP surface");
		for (const line of lines) expect(visibleWidth(line)).toBe(120);
	});

	test("help lists the bindings in this document's words and closes again", async () => {
		const h = await harness({ width: 120, rows: 60 });
		h.screen.render(120);
		h.screen.handleInput("?");
		const sheet = plain(h.screen.render(120)).join("\n");
		expect(sheet).toContain("step the status: todo → planned → done");
		expect(sheet).toContain("Break down the focused block");
		h.screen.handleInput("\r");
		expect(plain(h.screen.render(120)).join("\n")).not.toContain("step the status");
		expect(h.result()).toBeUndefined();
	});

	test("the preview shows the payload head, scrolls, and returns without a request", async () => {
		const h = await harness();
		h.screen.render(120);
		h.screen.handleInput("p");
		const preview = plain(h.screen.render(120));
		expect(preview.join("\n")).toContain("preview — block \"API\"");
		expect(preview.join("\n")).toContain("# Visual planner request");
		expect(preview.join("\n")).toContain("## Task");
		for (let step = 0; step < 60; step += 1) h.screen.handleInput("j");
		expect(plain(h.screen.render(120)).join("\n")).toContain("visual_planner_propose");
		// Escape returns to the diagram without a request.
		h.screen.handleInput("\x1b");
		expect(h.result()).toBeUndefined();
		expect(plain(h.screen.render(120)).join("\n")).not.toContain("## Proposal token");
	});

	test("submitting a preview hands back the request token and never says completed", async () => {
		const h = await harness();
		h.screen.render(120);
		h.screen.handleInput("p");
		h.screen.render(120);
		h.screen.handleInput("\r");
		const result = h.result() as { kind: string; request: BeginInput; prompt: string };
		expect(result.kind).toBe("submit");
		expect(result.request.kind).toBe("enhance");
		expect(result.request.requestId).toBeString();
		expect(result.prompt).toContain(result.request.requestId);
		expect(result.prompt).toContain("stages a proposal for review");
		expect(result.prompt).not.toContain("completed successfully");
	});

	test("two marked blocks run as one batch from the action menu", async () => {
		const h = await harness();
		h.screen.render(120);
		h.screen.handleInput("m"); // API
		h.screen.handleInput("j");
		h.screen.handleInput("j"); // Database
		h.screen.handleInput("m");
		expect(plain(h.screen.render(120)).join("\n")).toContain('marked "Database" · 2 marked — a runs them in parallel');
		h.screen.handleInput("a");
		expect(plain(h.screen.render(120)).join("\n")).toContain("› Refine 2 marked blocks in parallel");
		h.screen.handleInput("\r");
		expect(plain(h.screen.render(120)).join("\n")).toContain("batch preview — Refine × 2 blocks");
		h.screen.handleInput("\r");
		const result = h.result() as { kind: string; batch: { requests: BeginInput[]; prompt: string } };
		expect(result.kind).toBe("submit-batch");
		expect(result.batch.requests.map(request => request.scope.id)).toEqual(["api", "db"]);
		for (const request of result.batch.requests) expect(result.batch.prompt).toContain(`requestId: ${request.requestId}`);
	});

	test("staged batch proposals are reviewed one after another", async () => {
		const h = await harness();
		const member = (id: string): BeginInput => ({
			requestId: `req-${id}`,
			kind: "enhance",
			intent: "enhance",
			scope: { kind: "block", id },
			label: `block "${id}"`,
			branchKey: "session:leaf",
			documentId: "doc-1",
			baseRevision: 0,
			baseDigest: h.store.diskDigest,
			prompt: "",
			batchId: "batch-1",
		});
		expect(h.registry.beginBatch([member("api"), member("db")]).ok).toBe(true);
		for (const [id, title] of [["api", "API v2"], ["db", "Database v2"]] as const) {
			const staged = h.registry.stage(`req-${id}`, `rename ${id}`, createBlock({ id, title }), {
				branchKey: "session:leaf",
				documentId: "doc-1",
				diskDigest: h.store.diskDigest,
				document: h.store.require(),
				arktype: type,
			});
			expect(staged.ok).toBe(true);
		}
		h.screen.render(120);
		expect(plain(h.screen.render(120)).join("\n")).toContain("◆ 2 proposals ready — R reviews");
		h.screen.handleInput("R");
		expect(plain(h.screen.render(120)).join("\n")).toContain("review proposal · 1 of 2");
		h.screen.handleInput("\r");
		await new Promise(resolve => setTimeout(resolve, 0));
		const next = plain(h.screen.render(120)).join("\n");
		expect(next).toContain("review proposal");
		expect(next).not.toContain("1 of 2");
		expect(next).toContain('block "db"');
	});

	/** A ranker that stays pending until the test resolves it, recording its signal. */
	function deferredRanker(): { rank: RelatedRanker; signals: AbortSignal[]; resolve: (outcome: RelatedOutcome) => void } {
		const signals: AbortSignal[] = [];
		let settle: ((outcome: RelatedOutcome) => void) | undefined;
		return {
			signals,
			resolve: outcome => settle?.(outcome),
			rank: (_document, _scope, signal) => {
				signals.push(signal);
				return new Promise<RelatedOutcome>(resolve => {
					settle = resolve;
				});
			},
		};
	}

	const ranked: RelatedOutcome = {
		ok: true,
		context: { judge: "test/jev", ranked: [{ id: "worker", probability: 0.93 }] },
		asked: 1,
		elapsedMs: 12,
		cost: 0.00001,
	};

	test("a previewed request ranks related context before it may submit", async () => {
		const ranker = deferredRanker();
		const h = await harness({ width: 120, rows: 24, rankRelated: ranker.rank });
		h.screen.render(120);
		h.screen.handleInput("t");
		expect(plain(h.screen.render(120)).join("\n")).toContain("ranking related context…");
		// What is previewed is what is sent: Enter waits rather than submitting without the ranking.
		h.screen.handleInput("\r");
		expect(h.result()).toBeUndefined();
		expect(plain(h.screen.render(120)).join("\n")).toContain("still ranking related context");
		ranker.resolve(ranked);
		await new Promise(resolve => setTimeout(resolve, 0));
		expect(plain(h.screen.render(120)).join("\n")).toContain("related context: 1 of 1 blocks");
		h.screen.handleInput("\r");
		const result = h.result() as { prompt: string };
		expect(result.prompt).toContain("## Related context");
		expect(result.prompt).toContain("[worker] Service > Worker (p=0.93)");
	});

	test("closing a preview aborts the ranking in flight", async () => {
		const ranker = deferredRanker();
		const h = await harness({ width: 120, rows: 24, rankRelated: ranker.rank });
		h.screen.render(120);
		h.screen.handleInput("t");
		h.screen.handleInput("\x1b");
		expect(ranker.signals[0]?.aborted).toBe(true);
		ranker.resolve(ranked);
		await new Promise(resolve => setTimeout(resolve, 0));
		expect(h.result()).toBeUndefined();
	});

	test("a dirty document must be saved before a request starts", async () => {
		const h = await harness(canvas);
		h.screen.render(120);
		h.screen.handleInput("o");
		h.screen.handleInput("p");
		h.screen.render(120);
		h.screen.handleInput("\r");
		expect(h.result()).toBeUndefined();
		expect(plain(h.screen.render(120)).join("\n")).toContain("Save the authored document before submitting?");
	});
});

describe("inspector field editor", () => {
	/** A distinctive title, so a prefill assertion cannot pass on a card's label. */
	function named(value: string): ReturnType<typeof fixture> {
		const document = fixture();
		document.root.blocks[0]!.title = value;
		return document;
	}

	test("the title field opens prefilled, replaces it, and commits on Enter", async () => {
		const h = await harness({ width: 120, rows: 24, document: named("Zeta"), view: "canvas" });
		h.screen.render(120);
		h.screen.handleInput("i");
		h.screen.handleInput("\r");
		const editing = plain(h.screen.render(120));
		expect(editing.join("\n")).toContain("title — Enter accepts, Esc cancels");
		expect(editing.join("\n")).toContain("Zeta");

		// Replace the prefill the way a user would: clear the line, then type.
		h.screen.handleInput("\x15");
		expect(dialogRows(plain(h.screen.render(120)), "Enter accepts").join("\n")).not.toContain("Zeta");
		for (const key of ["G", "a", "t", "e", "w", "a", "y"]) h.screen.handleInput(key);
		expect(dialogRows(plain(h.screen.render(120)), "Enter accepts").join("\n")).toContain("Gateway");

		h.screen.handleInput("\r");
		const lines = plain(h.screen.render(120));
		expect(lines.join("\n")).toContain("updated title");
		expect(lines.join("\n")).toContain("Gateway");
		expect(lines.join("\n")).not.toContain("title — Enter accepts");
		expect(h.store.require().revision).toBe(1);
	});

	test("escape cancels a field edit and keeps the authored value", async () => {
		const h = await harness({ width: 120, rows: 24, document: named("Zeta"), view: "canvas" });
		h.screen.render(120);
		h.screen.handleInput("i");
		h.screen.handleInput("\r");
		h.screen.render(120);
		h.screen.handleInput("\x15");
		h.screen.handleInput("zzz");
		h.screen.handleInput("\x1b");
		const lines = plain(h.screen.render(120));
		expect(lines.join("\n")).toContain("edit cancelled");
		expect(h.store.require().root.blocks[0]!.title).toBe("Zeta");
		expect(dialogRows(lines, "Enter accepts").join("\n")).not.toContain("zzz");
	});

	test("source pane scrolls through the entire file without closing on navigation", async () => {
		const directory = await mkdtemp(join(tmpdir(), "omp-planner-source-"));
		directories.push(directory);
		const path = join(directory, "example.ts");
		await writeFile(path, Array.from({ length: 520 }, (_, index) => `// line-${String(index + 1).padStart(3, "0")}`).join("\n"));
		const document = fixture();
		document.purpose = "explore";
		document.root.blocks[0]!.status = "settled";
		document.root.blocks[0]!.sources = [{ path, startLine: 200, endLine: 200 }];
		const h = await harness({ width: 120, rows: 24, document });
		h.screen.handleInput("\r"); // page
		for (let index = 0; index < 3; index += 1) h.screen.handleInput("j");
		h.screen.handleInput("\r"); // source reference
		for (let attempt = 0; attempt < 100 && !plain(h.screen.render(120)).join("\n").includes("source:"); attempt += 1)
			await Bun.sleep(5);
		const rows = () => dialogRows(plain(h.screen.render(120)), "source:");
		expect(rows().join("\n")).toContain("line-200");
		const first = rows()[0];
		expect(plain(h.screen.render(120)).join("\n")).toContain("· line 200");
		h.screen.handleInput("j");
		expect(plain(h.screen.render(120)).join("\n")).toContain("· line 201");
		expect(rows().find(row => row.includes("line-201"))).toContain("› ");
		h.screen.handleInput("\x1b[6~");
		expect(rows()[0]).not.toBe(first);
		const paged = rows()[0];
		h.screen.handleInput("\x1b[5~");
		expect(plain(h.screen.render(120)).join("\n")).toContain("· line 201");
		expect(rows()[0]).not.toBe(paged);
		h.screen.handleInput("G");
		expect(rows().join("\n")).toContain("line-520");
		h.screen.handleInput("g");
		expect(rows().join("\n")).toContain("line-001");
		h.screen.handleInput("\x1b");
		expect(plain(h.screen.render(120)).join("\n")).not.toContain("source:");
	});
});

describe("outline", () => {
	/** The rendered outline row carrying the focus marker. */
	function focusedRow(lines: string[]): string | undefined {
		return lines.find(line => /│ › /.test(line));
	}

	test("opens on the first block with its subtree expanded", async () => {
		const h = await harness();
		const lines = plain(h.screen.render(120));
		expect(focusedRow(lines)).toContain("› ▾ ○ API");
		expect(lines.join("\n")).toContain("    ○ Auth");
		expect(lines[0]).toContain("· plan");
	});

	test("j walks depth-first into the nested block", async () => {
		const h = await harness();
		h.screen.render(120);
		h.screen.handleInput("j");
		expect(focusedRow(plain(h.screen.render(120)))).toContain("Auth");
	});

	test("space settles the focused block and the progress follows", async () => {
		const h = await harness();
		h.screen.render(120);
		expect(plain(h.screen.render(120)).at(-2)).toContain("0/4 planned");
		h.screen.handleInput(" ");
		const lines = plain(h.screen.render(120));
		expect(lines.at(-2)).toContain("1/4 planned");
		expect(lines.at(-2)).toContain('"API" is now planned');
		expect(focusedRow(lines)).toContain("◐ API");
	});

	test("o adds a named sibling right after the focused block", async () => {
		const h = await harness();
		h.screen.render(120);
		h.screen.handleInput("o");
		expect(plain(h.screen.render(120)).join("\n")).toContain("title — Enter accepts");
		for (const key of "Cache") h.screen.handleInput(key);
		h.screen.handleInput("\r");
		expect(h.store.require().root.blocks.map(block => block.title)).toEqual(["API", "Cache", "Database", "Worker"]);
		expect(focusedRow(plain(h.screen.render(120)))).toContain("Cache");
	});

	test("O adds a child inside the focused block", async () => {
		const h = await harness();
		h.screen.render(120);
		h.screen.handleInput("j");
		h.screen.handleInput("O");
		for (const key of "Tokens") h.screen.handleInput(key);
		h.screen.handleInput("\r");
		const auth = h.store.require().root.blocks[0]!.children!.blocks[0]!;
		expect(auth.children!.blocks.map(block => block.title)).toEqual(["Tokens"]);
		expect(focusedRow(plain(h.screen.render(120)))).toContain("      ○ Tokens");
	});

	test("r previews the purpose's refine request for the focused block", async () => {
		const h = await harness();
		h.screen.render(120);
		h.screen.handleInput("r");
		const joined = plain(h.screen.render(120)).join("\n");
		expect(joined).toContain('preview — block "API"');
		expect(joined).toContain("Refine this block's authored text");
	});

	test("t offers a replan of the focused block and submits it without touching the document", async () => {
		const h = await harness();
		const before = serializeDocument(h.store.require());
		expect(plain(h.screen.render(120)).join("\n")).toContain("t replan");
		h.screen.handleInput("t");
		const preview = plain(h.screen.render(120)).join("\n");
		expect(preview).toContain('preview — block "API"');
		expect(preview).toContain("Replan this block and the blocks inside it");
		h.screen.handleInput("\r");
		const result = h.result() as { kind: string; request: BeginInput; prompt: string };
		expect(result.kind).toBe("submit");
		expect(result.request).toMatchObject({ kind: "replan", intent: "replan", scope: { kind: "block", id: "api" } });
		expect(result.prompt).toContain(`requestId: ${result.request.requestId}`);
		expect(serializeDocument(h.store.require())).toBe(before);
	});

	test("the action menu offers project replan and prune against the whole document", async () => {
		for (const [steps, label, kind] of [
			[8, "Replan the document…", "replan"],
			[9, "Prune unnecessary blocks…", "prune"],
		] as const) {
			const h = await harness();
			const before = serializeDocument(h.store.require());
			h.screen.render(120);
			h.screen.handleInput("a");
			expect(plain(h.screen.render(120)).join("\n")).toContain(label);
			for (let step = 0; step < steps; step += 1) h.screen.handleInput("j");
			h.screen.handleInput("\r");
			const preview = plain(h.screen.render(120)).join("\n");
			expect(preview).toContain('preview — project "Service"');
			expect(preview).toContain(kind === "prune" ? "Prune this plan" : "Replan this document against the goal above");
			h.screen.handleInput("\r");
			const result = h.result() as { kind: string; request: BeginInput };
			expect(result.kind).toBe("submit");
			expect(result.request).toMatchObject({ kind, intent: kind, scope: { kind: "project" } });
			expect(serializeDocument(h.store.require())).toBe(before);
		}
	});

	test("a verb the purpose does not offer says so", async () => {
		const document = fixture();
		document.purpose = "brainstorm";
		const h = await harness({ width: 120, rows: 24, document });
		h.screen.render(120);
		h.screen.handleInput("X");
		expect(plain(h.screen.render(120)).at(-2)).toContain("no X action for a brainstorm document");
	});

	test("every line is exactly the width, outline and page alike", async () => {
		for (const width of [60, 100, 160]) {
			const h = await harness({ width, rows: 24 });
			for (const line of h.screen.render(width)) expect(visibleWidth(line)).toBe(width);
			h.screen.handleInput("\r");
			for (const line of h.screen.render(width)) expect(visibleWidth(line)).toBe(width);
		}
	});
});

describe("shared focus with web mode", () => {
	function focusedRow(lines: string[]): string | undefined {
		return lines.find(line => /│ › /.test(line));
	}

	test("moving in the outline publishes focus with the path that holds it", async () => {
		const h = await harness();
		expect(h.shared.selected).toBe("api");
		h.screen.handleInput("j");
		expect(h.shared.selected).toBe("auth");
		expect(h.shared.stack).toHaveLength(2);
		expect(h.shared.stack.at(-1)).toBe("api-inner");
	});

	test("focus moved elsewhere is followed, and a clear clears it", async () => {
		const h = await harness();
		h.screen.render(120);
		h.external("worker");
		expect(focusedRow(plain(h.screen.render(120)))).toContain("Worker");
		h.external(undefined);
		expect(focusedRow(plain(h.screen.render(120)))).toBeUndefined();
	});

	test("an open dialog keeps its block: outside focus does not move under it", async () => {
		const h = await harness();
		h.screen.render(120);
		h.screen.handleInput("\r");
		h.screen.handleInput("\r");
		expect(plain(h.screen.render(120)).join("\n")).toContain("title — Enter accepts");
		h.external("worker");
		h.screen.handleInput("\x15");
		for (const key of "Gateway") h.screen.handleInput(key);
		h.screen.handleInput("\r");
		expect(h.store.require().root.blocks.map(block => block.title)).toEqual(["Gateway", "Database", "Worker"]);
	});

	test("closing the planner stops listening", async () => {
		const h = await harness();
		expect(h.listeners.size).toBe(1);
		h.screen.handleInput("\x1b");
		expect(h.listeners.size).toBe(0);
	});
});

describe("editing a block in the user's editor", () => {
	/**
	 * An editor stub whose result the test can await. After it resolves the
	 * screen still fingerprints the block's citations, so tests wait for the edit.
	 */
	function stubEditor(change: (text: string) => string | null) {
		const calls: { text: string; done: Promise<string | null> }[] = [];
		const editor = (text: string) => {
			const done = Promise.resolve(change(text));
			calls.push({ text, done });
			return done;
		};
		return { editor, calls };
	}

	test("E hands the block over as markdown and applies the saved file as one edit", async () => {
		const stub = stubEditor(text =>
			text.replace("# API", "# Gateway").replace("HTTP surface", "HTTP surface\n\n```ts\napp.get('/health')\n```"),
		);
		const h = await harness({ width: 120, rows: 24, editor: stub.editor });
		h.screen.render(120);
		const revision = h.store.require().revision;
		h.screen.handleInput("E");
		await stub.calls[0]!.done;
		for (let attempt = 0; attempt < 100 && h.store.require().revision === revision; attempt += 1) await Bun.sleep(5);
		expect(stub.calls[0]!.text).toContain("# API");
		expect(h.tui.stopped).toBe(1);
		const api = h.store.require().root.blocks[0]!;
		expect(api.title).toBe("Gateway");
		expect(api.description).toContain("```ts\napp.get('/health')\n```");
		expect(h.store.require().revision).toBe(revision + 1);
		expect(plain(h.screen.render(120)).at(-2)).toContain('updated "Gateway" from your editor');
	});

	test("quitting the editor without saving changes nothing", async () => {
		const stub = stubEditor(() => null);
		const h = await harness({ width: 120, rows: 24, editor: stub.editor });
		h.screen.render(120);
		h.screen.handleInput("E");
		await stub.calls[0]!.done;
		expect(h.store.require().revision).toBe(0);
		expect(plain(h.screen.render(120)).at(-2)).toContain("editor exited without saving");
	});

	test("with no $VISUAL or $EDITOR it says how to set one", async () => {
		const h = await harness();
		h.screen.render(120);
		h.screen.handleInput("E");
		expect(h.tui.stopped).toBe(0);
		expect(plain(h.screen.render(120)).at(-2)).toContain("set $VISUAL or $EDITOR");
	});
});

describe("progress while the agent works", () => {
	test("the status strip and the block's outline row show the running request", async () => {
		const h = await harness();
		h.screen.render(120);
		expect(plain(h.screen.render(120)).at(-2)).not.toContain("agent working");
		h.registry.begin({
			requestId: "req-9",
			kind: "enhance",
			intent: "enhance",
			scope: { kind: "block", id: "api" },
			label: 'block "API"',
			branchKey: "session:leaf",
			documentId: "doc-1",
			baseRevision: 0,
			baseDigest: undefined,
			prompt: "",
		});
		const lines = plain(h.screen.render(120));
		expect(lines.at(-2)).toMatch(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] agent working 0:0\d/);
		expect(lines.find(line => /│ › ▾ ○ API/.test(line))).toMatch(/API [⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/);
		h.registry.resolve("req-9", "discarded");
		expect(plain(h.screen.render(120)).at(-2)).not.toContain("agent working");
		h.screen.dispose();
	});

	test("a request the idle agent left without a proposal stops spinning and says so", async () => {
		let idle = false;
		const h = await harness({ width: 120, rows: 24, isIdle: () => idle });
		h.screen.render(120);
		const began = h.registry.begin({
			requestId: "req-10",
			kind: "enhance",
			intent: "enhance",
			scope: { kind: "block", id: "api" },
			label: 'block "API"',
			branchKey: "session:leaf",
			documentId: "doc-1",
			baseRevision: 0,
			baseDigest: undefined,
			prompt: "",
		});
		if (!began.ok) throw new Error(began.errors.join("; "));
		// Submitted a while ago, e.g. a stage the tool refused.
		began.entry.createdAt = new Date(Date.now() - 60_000).toISOString();
		expect(plain(h.screen.render(120)).at(-2)).toContain("agent working 1:0");
		idle = true;
		const lines = plain(h.screen.render(120));
		expect(lines.at(-2)).toContain("! 1 request without a proposal — a discards");
		expect(lines.at(-2)).not.toContain("agent working");
		expect(lines.find(line => /│ › ▾ ○ API/.test(line))).toContain("API ! no proposal");
		h.screen.dispose();
	});
});

/** A workspace with `src/app.ts` and the fixture's API block citing its first three lines. */
async function citedWorkspace(stamp: boolean) {
	const cwd = await mkdtemp(join(tmpdir(), "omp-visual-planner-cwd-"));
	directories.push(cwd);
	await mkdir(join(cwd, "src"));
	await writeFile(join(cwd, "src", "app.ts"), "const one = 1;\nconst two = 2;\nconst three = 3;\nconst four = 4;\nconst five = 5;\n");
	const source = { path: "src/app.ts", startLine: 1, endLine: 3 };
	const document = fixture();
	document.root.blocks[0]!.sources = stamp ? await stampMissing(cwd, [source]) : [source];
	return { cwd, document };
}

async function until(check: () => boolean): Promise<void> {
	for (let attempt = 0; attempt < 200 && !check(); attempt += 1) await Bun.sleep(5);
}

function allBlocks(root: ReturnType<typeof fixture>["root"]): ReturnType<typeof createBlock>[] {
	return root.blocks.flatMap(block => [block, ...(block.children ? allBlocks(block.children) : [])]);
}

describe("drift in the terminal", () => {
	test("D lists a changed citation and Enter on Sync previews the block's Sync request", async () => {
		const { cwd, document } = await citedWorkspace(true);
		await writeFile(join(cwd, "src", "app.ts"), "const one = 1;\nconst TWO = 2;\nconst three = 3;\n");
		const h = await harness({ width: 120, rows: 30, document, cwd });
		h.screen.render(120);
		h.screen.handleInput("D");
		const text = () => plain(h.screen.render(120)).join("\n");
		await until(() => text().includes("drift —"));
		expect(text()).toContain("drift — 1 changed");
		expect(text()).toContain('Sync "API"');
		h.screen.handleInput("\r");
		expect(text()).toContain('preview — block "API"');
		expect(text()).toContain("intent: sync");
	});
});

describe("source view line actions", () => {
	/** Opens the page, moves to the block's citation (k wraps to "add", k again to it) and opens it. */
	async function openCitation(h: Harness): Promise<() => string> {
		const text = () => plain(h.screen.render(120)).join("\n");
		h.screen.render(120);
		h.screen.handleInput("\r");
		h.screen.handleInput("k");
		h.screen.handleInput("k");
		h.screen.handleInput("\r");
		await until(() => text().includes("source: src/app.ts"));
		return text;
	}

	test("a selected range becomes a change block under the focused one, previewed as Refine", async () => {
		const { cwd, document } = await citedWorkspace(false);
		const h = await harness({ width: 120, rows: 30, document, cwd });
		const text = await openCitation(h);
		expect(text()).toContain("· line 1");
		for (const key of ["j", "v", "j"]) h.screen.handleInput(key);
		expect(text()).toContain("· 2-3 selected");
		h.screen.handleInput("c");
		h.screen.handleInput("retry");
		h.screen.handleInput("\r");
		await until(() => text().includes("preview — block"));
		expect(text()).toContain("Refine this block's authored text");
		const added = allBlocks(h.store.require().root).find(block => block.title === "retry");
		expect(added?.sources.map(source => [source.path, source.startLine, source.endLine])).toEqual([["src/app.ts", 2, 3]]);
		expect(added?.sources[0]!.digest).toBeString();
	});

	test("a question on the cursor line becomes a Q: block previewed as Ask", async () => {
		const { cwd, document } = await citedWorkspace(false);
		const h = await harness({ width: 120, rows: 30, document, cwd });
		const text = await openCitation(h);
		h.screen.handleInput("a");
		h.screen.handleInput("why one?");
		h.screen.handleInput("\r");
		await until(() => text().includes("preview — block"));
		expect(text()).toContain("intent: clarify");
		expect(allBlocks(h.store.require().root).some(block => block.title === "Q: why one?")).toBe(true);
	});

	test("s picks an identifier and says when no language server is available", async () => {
		const { cwd, document } = await citedWorkspace(false);
		const h = await harness({ width: 120, rows: 30, document, cwd });
		const text = await openCitation(h);
		h.screen.handleInput("s");
		expect(text()).toContain("symbol on line 1");
		h.screen.handleInput("j");
		h.screen.handleInput("\r");
		await until(() => text().includes("language servers are not available in this session"));
		expect(text()).toContain("language servers are not available in this session");
	});
});
