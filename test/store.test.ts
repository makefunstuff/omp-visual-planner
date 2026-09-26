import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type } from "@oh-my-pi/omptype";
import { createBlock, createDiagram, createDocument, createEdge, validateDocument } from "../src/model.ts";
import {
	DocumentStore,
	applyReplacement,
	defaultDiscoveryPath,
	defaultDocumentPath,
	digestOfText,
	displayPath,
	serializeDocument,
	slugify,
} from "../src/store.ts";

const directories: string[] = [];

async function workspace(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "omp-visual-planner-"));
	directories.push(dir);
	return dir;
}

afterEach(async () => {
	await Promise.all(directories.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

function sample() {
	const document = createDocument({ title: "Service", goal: "Ship auth" });
	const api = createBlock({ id: "api", title: "API", x: 4, y: 4, expectedOutput: "REST surface" });
	const db = createBlock({ id: "db", title: "Database", x: 30, y: 4 });
	document.root.blocks.push(api, db);
	document.root.edges.push(
		createEdge({ id: "e1", from: "api", to: "db", label: "stores", fromPort: "east", toPort: "west" }),
	);
	api.acceptanceCriteria.push("401 on missing token");
	const auth = createBlock({ id: "auth", title: "Auth", x: 2, y: 2 });
	api.children = createDiagram({ id: "api-inner", blocks: [auth] });
	return document;
}

describe("paths and slugs", () => {
	test("slugify collapses runs and trims dashes", () => {
		expect(slugify("My Repo (v2)")).toBe("my-repo-v2");
		expect(slugify("///")).toBe("repo");
		expect(slugify("a")).toBe("a");
	});

	test("default paths are anchored to the project directory", () => {
		expect(defaultDocumentPath("/work/app")).toBe("/work/app/.omp-visual-planner/architecture.json");
		expect(defaultDiscoveryPath("/work/app", ".")).toBe("/work/app/.omp-visual-planner/discovery/app.json");
		expect(defaultDiscoveryPath("/work/app", "/srv/thing/")).toBe("/work/app/.omp-visual-planner/discovery/thing.json");
	});

	test("displayPath prefers a relative path inside the workspace", () => {
		expect(displayPath("/work/app/.omp-visual-planner/architecture.json", "/work/app")).toBe(
			".omp-visual-planner/architecture.json",
		);
		expect(displayPath("/elsewhere/x.json", "/work/app")).toBe("/elsewhere/x.json");
	});
});

describe("save and reload", () => {
	test("round-trips hierarchy, ids, criteria and relationship settings exactly", async () => {
		const dir = await workspace();
		const path = defaultDocumentPath(dir);
		const store = new DocumentStore(type);
		store.adopt(sample(), path);
		const saved = await store.save();
		expect(saved.ok).toBe(true);

		const text = await readFile(path, "utf8");
		expect(text.endsWith("}\n")).toBe(true);
		expect(text).toBe(serializeDocument(store.require()));

		const reopened = new DocumentStore(type);
		const opened = await reopened.open(path);
		expect(opened.ok).toBe(true);
		expect(serializeDocument(reopened.require())).toBe(text);
		const document = reopened.require();
		expect(document.root.blocks[0]!.children!.blocks[0]!.id).toBe("auth");
		expect(document.root.blocks[0]!.acceptanceCriteria).toEqual(["401 on missing token"]);
		expect(document.root.edges[0]!.fromPort).toBe("east");
		expect(document.root.edges[0]!.toPort).toBe("west");
		expect(document.root.edges[0]!.label).toBe("stores");
		expect(reopened.dirty).toBe(false);
	});

	test("leaves no temporary file behind", async () => {
		const dir = await workspace();
		const store = new DocumentStore(type);
		store.adopt(sample(), defaultDocumentPath(dir));
		await store.save();
		const entries = await readdir(join(dir, ".omp-visual-planner"));
		expect(entries).toEqual(["architecture.json"]);
	});

	test("refuses to overwrite a file changed on disk", async () => {
		const dir = await workspace();
		const path = defaultDocumentPath(dir);
		const store = new DocumentStore(type);
		store.adopt(sample(), path);
		await store.save();

		const external = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
		external.title = "Edited elsewhere";
		await writeFile(path, `${JSON.stringify(external, null, 2)}\n`, "utf8");

		expect(await store.currentDiskDigest()).not.toBe(store.diskDigest);
		const refused = await store.save();
		expect(refused.ok).toBe(false);
		if (refused.ok) throw new Error("unreachable");
		expect(refused.kind).toBe("conflict");
		// Authored state is untouched, and the conflict keeps being reported.
		expect(store.require().title).toBe("Service");
		expect(store.dirty).toBe(false);
		expect((await store.save()).ok).toBe(false);

		// Saving somewhere else is always allowed and keeps the authored state.
		const alternative = join(dir, "copy.json");
		expect((await store.saveAs(alternative)).ok).toBe(true);
		expect(JSON.parse(await readFile(alternative, "utf8")).title).toBe("Service");
	});

	test("reports a missing file without clearing current state", async () => {
		const dir = await workspace();
		const store = new DocumentStore(type);
		store.adopt(sample(), join(dir, "architecture.json"));
		const result = await store.open(join(dir, "nope.json"));
		expect(result.ok).toBe(false);
		if (result.ok) throw new Error("unreachable");
		expect(result.kind).toBe("missing");
		expect(result.errors).toEqual([`no file at ${join(dir, "nope.json")}`]);
		expect(store.require().title).toBe("Service");
	});

	test("reports malformed JSON and invalid documents without touching state", async () => {
		const dir = await workspace();
		const store = new DocumentStore(type);
		store.adopt(sample(), join(dir, "architecture.json"));

		const broken = join(dir, "broken.json");
		await writeFile(broken, "{ not json", "utf8");
		const malformed = await store.open(broken);
		expect(malformed.ok).toBe(false);
		if (malformed.ok) throw new Error("unreachable");
		expect(malformed.errors[0]).toContain("is not valid JSON");

		const invalid = join(dir, "invalid.json");
		await writeFile(invalid, JSON.stringify({ ...sample(), schemaVersion: 7 }), "utf8");
		const rejected = await store.open(invalid);
		expect(rejected.ok).toBe(false);
		if (rejected.ok) throw new Error("unreachable");
		expect(rejected.errors).toEqual(["unsupported schemaVersion 7; this build reads only version 1"]);
		expect(store.require().title).toBe("Service");
	});
});

describe("legacy import", () => {
	test("imports a boxes/edges board and never overwrites the legacy file", async () => {
		const dir = await workspace();
		const legacyPath = join(dir, "demo.json");
		const legacy = { boxes: [{ x: 0, y: 0, text: "auth\nlogin" }, { x: 20, y: 0, text: "db" }], edges: [{ from: 0, to: 1 }] };
		await writeFile(legacyPath, JSON.stringify(legacy), "utf8");

		const store = new DocumentStore(type);
		const result = await store.open(legacyPath);
		expect(result.ok).toBe(true);
		if (!result.ok) throw new Error("unreachable");
		expect(result.kind).toBe("legacy-import");
		expect(store.importNotice).toContain("2 block(s)");
		expect(store.path).toBeUndefined();
		expect(store.require().root.blocks[0]!.title).toBe("auth");

		// A bare save is refused: the legacy file is never overwritten.
		const refused = await store.save();
		expect(refused.ok).toBe(false);
		if (refused.ok) throw new Error("unreachable");
		expect(refused.kind).toBe("no-path");
		expect(JSON.parse(await readFile(legacyPath, "utf8"))).toEqual(legacy);

		const chosen = defaultDocumentPath(dir);
		expect((await store.saveAs(chosen)).ok).toBe(true);
		expect(JSON.parse(await readFile(legacyPath, "utf8"))).toEqual(legacy);
	});
});

describe("editing history", () => {
	test("one transaction is one revision and one undo step", async () => {
		const dir = await workspace();
		const store = new DocumentStore(type);
		store.newDocument({ title: "Draft" }, defaultDocumentPath(dir));
		const start = store.require().revision;

		store.transact(document => {
			document.root.blocks.push(createBlock({ id: "a", title: "A" }));
			document.root.blocks.push(createBlock({ id: "b", title: "B" }));
		});
		expect(store.require().revision).toBe(start + 1);
		expect(store.require().root.blocks).toHaveLength(2);

		expect(store.undo()).toBe(true);
		expect(store.require().root.blocks).toHaveLength(0);
		expect(store.canRedo).toBe(true);
		expect(store.redo()).toBe(true);
		expect(store.require().root.blocks.map(b => b.id)).toEqual(["a", "b"]);
		expect(store.canRedo).toBe(false);
	});

	test("a transaction that would break an invariant changes nothing", () => {
		const store = new DocumentStore(type);
		store.newDocument({ title: "Draft" }, "/tmp/architecture.json");
		expect(() =>
			store.transact(document => {
				document.root.blocks.push(createBlock({ id: "a", title: "A", evidence: "observed" }));
			}),
		).toThrow(/evidence "observed" but carries no sources/);
		expect(store.require().root.blocks).toHaveLength(0);
		expect(store.require().revision).toBe(0);
	});

	test("rejects a transaction that would produce an invalid document", () => {
		const store = new DocumentStore(type);
		store.newDocument({ title: "Draft" }, "/tmp/architecture.json");
		expect(() =>
			store.transact(document => {
				document.root.edges.push(createEdge({ id: "bad", from: "x", to: "y" }));
			}),
		).toThrow(/invalid document/);
		expect(store.require().root.edges).toHaveLength(0);
		expect(store.require().revision).toBe(0);
	});
});

describe("proposal application", () => {
	test("a document replacement keeps the document id and bumps the revision once", () => {
		const store = new DocumentStore(type);
		const document = sample();
		store.adopt(document, "/tmp/architecture.json");
		const id = store.require().id;
		const replacement = { ...sample(), id, title: "Service v2" };
		store.transact(current => applyReplacement(current, replacement, undefined));
		expect(store.require().id).toBe(id);
		expect(store.require().title).toBe("Service v2");
		expect(store.require().revision).toBe(1);
		expect(store.dirty).toBe(true);
	});

	test("a block replacement keeps the block id", () => {
		const store = new DocumentStore(type);
		store.adopt(sample(), "/tmp/architecture.json");
		const replacement = createBlock({ id: "api", title: "Gateway v2", x: 7, y: 7 });
		store.transact(current => applyReplacement(current, replacement, "api"));
		expect(store.require().root.blocks[0]!.title).toBe("Gateway v2");
		expect(store.require().root.blocks[0]!.position).toEqual({ x: 7, y: 7 });
		expect(validateDocument(store.require(), type).ok).toBe(true);
	});

	test("a nested diagram replacement is installed on the owning block", () => {
		const store = new DocumentStore(type);
		store.adopt(sample(), "/tmp/architecture.json");
		const replacement = createDiagram({
			id: "api-inner",
			blocks: [createBlock({ id: "auth2", title: "Auth v2" })],
		});
		store.transact(current => applyReplacement(current, replacement, "api-inner"));
		expect(store.require().root.blocks[0]!.children!.blocks[0]!.id).toBe("auth2");
		expect(validateDocument(store.require(), type).ok).toBe(true);
	});

	test("an unknown target is an explicit error", () => {
		const store = new DocumentStore(type);
		store.adopt(sample(), "/tmp/architecture.json");
		expect(() => store.transact(current => applyReplacement(current, createBlock({ id: "ghost" }), "ghost"))).toThrow(
			/no block ghost/,
		);
	});
});

describe("digest helper", () => {
	test("digest is stable and content-addressed", () => {
		expect(digestOfText("a")).toBe(digestOfText("a"));
		expect(digestOfText("a")).not.toBe(digestOfText("b"));
		expect(digestOfText("{}\n")).toHaveLength(64);
	});
});
