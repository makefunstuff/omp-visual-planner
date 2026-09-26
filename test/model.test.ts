import { describe, expect, test } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import {
	SCHEMA_VERSION,
	addBlock,
	addEdge,
	createBlock,
	createDiagram,
	createDocument,
	createEdge,
	cycleBlock,
	descendantIds,
	eachBlock,
	importLegacyBoard,
	incidentEdges,
	moveBlockInOrder,
	nearestBlock,
	removeBlock,
	toolSchemasFor,
	validateDiagram,
	validateDocument,
} from "../src/model.ts";

/** Two blocks in the root diagram plus a nested child diagram inside `api`. */
function fixture() {
	const document = createDocument({ title: "Service", goal: "Ship auth" });
	const api = createBlock({ id: "api", title: "API", description: "HTTP surface", x: 4, y: 4 });
	const db = createBlock({ id: "db", title: "Database", x: 30, y: 4 });
	document.root.blocks.push(api, db);
	document.root.edges.push(createEdge({ id: "e1", from: "api", to: "db", label: "stores" }));
	const auth = createBlock({ id: "auth", title: "Auth", x: 2, y: 2, evidence: "unknown" });
	const tokens = createBlock({ id: "tokens", title: "Tokens", x: 2, y: 8, evidence: "observed", sources: [{ path: "src/tokens.ts", startLine: 1, endLine: 20 }] });
	api.children = createDiagram({ id: "api-inner", blocks: [auth, tokens] });
	api.children.edges.push(createEdge({ id: "e2", from: "auth", to: "tokens" }));
	return document;
}

describe("document validation", () => {
	test("accepts a nested document and rejects structural damage", () => {
		const document = fixture();
		const valid = validateDocument(document, type);
		expect(valid.ok).toBe(true);

		const brokenShape = structuredClone(document) as unknown as Record<string, unknown>;
		brokenShape.revision = "1";
		const structural = validateDocument(brokenShape, type);
		expect(structural.ok).toBe(false);
		if (structural.ok) throw new Error("unreachable");
		expect(structural.errors[0]).toContain("revision");

		const brokenEndpoint = structuredClone(document);
		brokenEndpoint.root.edges[0]!.to = "ghost";
		const endpoint = validateDocument(brokenEndpoint, type);
		expect(endpoint.ok).toBe(false);
		if (endpoint.ok) throw new Error("unreachable");
		expect(endpoint.errors).toEqual(["edge e1 ends at unknown block ghost"]);
	});

	test("reports an unknown schema version instead of a shape mismatch", () => {
		const result = validateDocument({ ...fixture(), schemaVersion: 2 }, type);
		expect(result.ok).toBe(false);
		if (result.ok) throw new Error("unreachable");
		expect(result.errors).toEqual(["unsupported schemaVersion 2; this build reads only version 1"]);
	});

	test("rejects a self-edge by name", () => {
		const document = fixture();
		document.root.edges.push(createEdge({ id: "loop", from: "api", to: "api" }));
		const result = validateDocument(document, type);
		expect(result.ok).toBe(false);
		if (result.ok) throw new Error("unreachable");
		expect(result.errors).toEqual(["edge loop is a self-edge on block api; self-edges are not supported"]);
	});

	test("rejects `observed` without a source, naming the block", () => {
		const document = fixture();
		const db = document.root.blocks[1]!;
		db.evidence = "observed";
		const result = validateDocument(document, type);
		expect(result.ok).toBe(false);
		if (result.ok) throw new Error("unreachable");
		expect(result.errors).toEqual(['block "Database" is evidence "observed" but carries no sources']);
	});

	test("rejects duplicate ids and inverted line ranges", () => {
		const document = fixture();
		document.root.blocks.push(createBlock({ id: "api", title: "Clone" }));
		document.root.blocks[1]!.sources = [{ path: "src/db.ts", startLine: 40, endLine: 12 }];
		const result = validateDocument(document, type);
		expect(result.ok).toBe(false);
		if (result.ok) throw new Error("unreachable");
		expect(result.errors).toContain('duplicate id api (block "API" and block "Clone")');
		expect(result.errors).toContain('block "Database" source src/db.ts has endLine 12 before startLine 40');
	});

	test("schema version is pinned", () => {
		expect(SCHEMA_VERSION).toBe(1);
	});
});

describe("graph operations", () => {
	test("nested deletion removes the subtree and its incident edges only", () => {
		const document = fixture();
		expect(descendantIds(document.root.blocks[0]!)).toEqual(["api", "auth", "tokens"]);
		expect(removeBlock(document.root, "api")).toBe(true);
		expect(document.root.blocks.map(b => b.id)).toEqual(["db"]);
		expect(document.root.edges).toEqual([]);
		expect(validateDocument(document, type).ok).toBe(true);
	});

	test("deleting a leaf keeps sibling relationships intact", () => {
		const document = fixture();
		expect(removeBlock(document.root, "auth")).toBe(true);
		expect(document.root.blocks.map(b => b.id)).toEqual(["api", "db"]);
		expect(document.root.edges.map(e => e.id)).toEqual(["e1"]);
		expect(document.root.blocks[0]!.children!.edges).toEqual([]);
		expect(validateDocument(document, type).ok).toBe(true);
	});

	test("ids stay stable across moves and renames", () => {
		const document = fixture();
		const api = document.root.blocks[0]!;
		const before = api.id;
		api.position = { x: 12, y: 9 };
		api.title = "Gateway";
		const moved = document.root.blocks.find(b => b.id === before);
		expect(moved?.title).toBe("Gateway");
		expect(document.root.edges[0]!.from).toBe(before);
	});

	test("addBlock and addEdge refuse unknown targets", () => {
		const document = fixture();
		expect(addBlock(document.root, "missing", createBlock())).toBe(false);
		expect(addEdge(document.root, "api-inner", createEdge({ from: "auth", to: "ghost" }))).toBe(false);
		expect(addEdge(document.root, "api-inner", createEdge({ from: "auth", to: "tokens" }))).toBe(true);
		expect(document.root.blocks[0]!.children!.edges).toHaveLength(2);
	});

	test("incident edges report the owning diagram", () => {
		const document = fixture();
		const found = incidentEdges(document.root, "api");
		expect(found.map(f => f.edge.id)).toEqual(["e1"]);
		expect(found[0]!.diagram).toBe(document.root);
		expect(incidentEdges(document.root, "auth").map(f => f.edge.id)).toEqual(["e2"]);
	});

	test("directional selection follows the vector it is asked for", () => {
		const document = fixture();
		expect(nearestBlock(document.root, "api", "l")).toBe("db");
		expect(nearestBlock(document.root, "db", "h")).toBe("api");
		expect(nearestBlock(document.root, "api", "k")).toBeUndefined();
	});

	test("cycle traversal wraps deterministically", () => {
		const document = fixture();
		expect(cycleBlock(document.root, undefined)).toBe("api");
		expect(cycleBlock(document.root, "db")).toBe("api");
		expect(cycleBlock(document.root, "api", -1)).toBe("db");
	});

	test("authored order: move swaps neighbours and refuses at either end", () => {
		const document = fixture();
		expect(moveBlockInOrder(document.root, "api", -1)).toBe(false);
		expect(moveBlockInOrder(document.root, "db", 1)).toBe(false);
		expect(moveBlockInOrder(document.root, "api", 1)).toBe(true);
		expect(document.root.blocks.map(b => b.id)).toEqual(["db", "api"]);
		expect(moveBlockInOrder(document.root, "tokens", -1)).toBe(true);
		expect(document.root.blocks[1]!.children!.blocks.map(b => b.id)).toEqual(["tokens", "auth"]);
		expect(moveBlockInOrder(document.root, "ghost", 1)).toBe(false);
	});

	test("addBlock inserts after an anchor and appends without one", () => {
		const document = fixture();
		expect(addBlock(document.root, document.root.id, createBlock({ id: "mid" }), "api")).toBe(true);
		expect(addBlock(document.root, document.root.id, createBlock({ id: "end" }))).toBe(true);
		expect(document.root.blocks.map(b => b.id)).toEqual(["api", "mid", "db", "end"]);
	});
});

describe("version-1 files without purpose or status", () => {
	test("load as a plan whose blocks are all open", () => {
		const legacy = JSON.parse(JSON.stringify(fixture())) as Record<string, unknown>;
		delete legacy.purpose;
		const strip = (diagram: { blocks: Record<string, unknown>[] }): void => {
			for (const block of diagram.blocks) {
				delete block.status;
				if (block.children) strip(block.children as { blocks: Record<string, unknown>[] });
			}
		};
		strip(legacy.root as { blocks: Record<string, unknown>[] });
		const result = validateDocument(legacy, type);
		if (!result.ok) throw new Error(result.errors.join("; "));
		expect(result.document.purpose).toBe("plan");
		expect([...eachBlock(result.document.root)].map(l => l.block.status)).toEqual(["open", "open", "open", "open"]);
	});
});

describe("every block is reachable exactly once", () => {
	test("traversal enumerates the nested tree with ancestors", () => {
		const document = fixture();
		const seen = [...eachBlock(document.root)].map(l => `${l.ancestors.length}:${l.block.id}`);
		expect(seen).toEqual(["0:api", "1:auth", "1:tokens", "0:db"]);
	});
});

describe("legacy board import", () => {
	test("converts boxes and edges, splitting title from description", () => {
		const result = importLegacyBoard({
			boxes: [
				{ x: 0, y: 0, text: "auth\nlogin and tokens" },
				{ x: 20, y: 0, text: "db" },
			],
			edges: [{ from: 0, to: 1 }],
		});
		expect(result.ok).toBe(true);
		if (!result.ok) throw new Error("unreachable");
		expect(result.document.root.blocks[0]!.title).toBe("auth");
		expect(result.document.root.blocks[0]!.description).toBe("login and tokens");
		expect(result.document.root.blocks[1]!.description).toBe("");
		expect(result.document.root.blocks[1]!.title).toBe("db");
		expect(result.document.root.edges).toHaveLength(1);
		expect(validateDocument(result.document, type).ok).toBe(true);
		expect(result.summary).toContain("2 block(s)");
	});

	test("names an out-of-range endpoint instead of importing a broken edge", () => {
		const result = importLegacyBoard({ boxes: [{ x: 0, y: 0, text: "a" }], edges: [{ from: 0, to: 3 }] });
		expect(result.ok).toBe(false);
		if (result.ok) throw new Error("unreachable");
		expect(result.errors).toEqual(["edge 0 references box index out of range (0 -> 3)"]);
	});

	test("refuses a document that already carries a schemaVersion", () => {
		const result = importLegacyBoard({ schemaVersion: 1, boxes: [], edges: [] });
		expect(result.ok).toBe(false);
		if (result.ok) throw new Error("unreachable");
		expect(result.errors).toEqual(["this file already carries a schemaVersion; open it as a project document"]);
	});
});

describe("tool parameter schemas", () => {
	test("read scope is optional and validated", () => {
		const schemas = toolSchemasFor(type);
		expect(schemas.read({}) instanceof type.errors).toBe(false);
		expect(schemas.read({ scope: { kind: "block", id: "api" } }) instanceof type.errors).toBe(false);
		expect(schemas.read({ scope: { kind: "sideways" } }) instanceof type.errors).toBe(true);
	});

	test("propose accepts each replacement shape", () => {
		const schemas = toolSchemasFor(type);
		const document = fixture();
		const base = { requestId: "r1", baseRevision: 3, summary: "draft" };
		expect(schemas.propose({ ...base, replacement: document }) instanceof type.errors).toBe(false);
		expect(schemas.propose({ ...base, replacement: document.root }) instanceof type.errors).toBe(false);
		expect(schemas.propose({ ...base, replacement: document.root.blocks[0]! }) instanceof type.errors).toBe(false);
		expect(schemas.propose({ ...base, replacement: { nope: true } }) instanceof type.errors).toBe(true);
	});
});
