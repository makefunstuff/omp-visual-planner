import { describe, expect, test } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import type { BeginInput, BeginOutcome, StageContext } from "../src/actions.ts";
import { ActionRegistry, validateReplacement } from "../src/actions.ts";
import { type DiagramDocument, type Scope, createBlock, createDiagram, createDocument, createEdge } from "../src/model.ts";

const BRANCH = "session-1:leaf-a";

function sampleDocument() {
	const document = createDocument({ id: "doc-1", title: "Service", goal: "Ship auth" });
	const api = createBlock({ id: "api", title: "API" });
	document.root.blocks.push(api, createBlock({ id: "db", title: "Database" }));
	document.root.edges.push(createEdge({ id: "e1", from: "api", to: "db", label: "stores" }));
	api.children = createDiagram({ id: "api-inner", blocks: [createBlock({ id: "auth", title: "Auth" })] });
	return document;
}

function beginFor(
	registry: ActionRegistry,
	overrides: Partial<BeginInput> = {},
): BeginOutcome {
	const document = sampleDocument();
	return registry.begin({
		requestId: "req-1",
		kind: "enhance",
		intent: "enhance",
		scope: { kind: "block", id: "auth" },
		label: 'block "Auth"',
		branchKey: BRANCH,
		documentId: document.id,
		baseRevision: 3,
		baseDigest: "digest-a",
		prompt: "payload",
		...overrides,
	});
}

function contextFor(overrides: Partial<StageContext> = {}): StageContext {
	return { branchKey: BRANCH, documentId: "doc-1", diskDigest: "digest-a", arktype: type, ...overrides };
}

describe("request lifecycle", () => {
	test("one pending request per session", () => {
		const registry = new ActionRegistry(BRANCH);
		const document = sampleDocument();
		const first = registry.begin({
			requestId: "req-1",
			kind: "enhance",
			intent: "enhance",
			scope: { kind: "block", id: "auth" },
			label: "block",
			branchKey: BRANCH,
			documentId: document.id,
			baseRevision: 3,
			baseDigest: "digest-a",
			prompt: "payload",
		});
		expect(first.ok).toBe(true);
		const second = beginFor(registry);
		expect(second.ok).toBe(false);
		if (second.ok) throw new Error("unreachable");
		expect(second.errors[0]).toContain("req-1");
		expect(second.errors[0]).toContain("still pending");

		expect(registry.resolve("req-1", "discarded")).toBe(true);
		expect(registry.pending()).toBeUndefined();
		expect(beginFor(registry).ok).toBe(true);
	});

	test("an execution request is submitted immediately and leaves nothing pending", () => {
		const registry = new ActionRegistry(BRANCH);
		const result = beginFor(registry, { requestId: "exec-1", kind: "execute", intent: "execute", scope: { kind: "project" } });
		expect(result.ok).toBe(true);
		if (!result.ok) throw new Error("unreachable");
		expect(result.entry.state).toBe("submitted");
		expect(registry.pending()).toBeUndefined();
		// No token was issued, so nothing can be staged against it.
		expect(registry.stage("exec-1", "nope", {}, contextFor()).ok).toBe(false);
	});

	test("switching branch invalidates another branch's request", () => {
		const registry = new ActionRegistry(BRANCH);
		beginFor(registry);
		registry.adoptBranch("session-1:leaf-b");
		expect(registry.pending()).toBeUndefined();
		const entry = registry.entryFor("req-1")!;
		expect(entry.state).toBe("stale");
		expect(entry.stateReason).toContain("leaf-b");
		expect(registry.stage("req-1", "late", createBlock({ id: "auth" }), contextFor({ branchKey: "session-1:leaf-b" })).ok).toBe(
			false,
		);
	});

	test("a restored journal keeps the token but re-invalidates foreign branches", () => {
		const first = new ActionRegistry(BRANCH);
		beginFor(first);
		const journal = first.serialize();

		const second = new ActionRegistry("elsewhere");
		second.adoptBranch(BRANCH, journal);
		expect(second.pending()?.requestId).toBe("req-1");
		expect(second.entryFor("req-1")!.state).toBe("pending");

		const third = new ActionRegistry("another");
		third.adoptBranch("another", journal);
		expect(third.pending()).toBeUndefined();
		expect(third.entryFor("req-1")!.state).toBe("stale");
	});
});

describe("proposal staging", () => {
	test("unknown tokens are named explicitly", () => {
		const registry = new ActionRegistry(BRANCH);
		beginFor(registry);
		const result = registry.stage("req-999", "s", createBlock({ id: "auth" }), contextFor());
		expect(result.ok).toBe(false);
		if (result.ok) throw new Error("unreachable");
		expect(result.errors).toEqual([
			"unknown requestId req-999; no request with that token is registered",
		]);
	});

	test("a stale base revision is refused", () => {
		const registry = new ActionRegistry(BRANCH);
		const document = sampleDocument();
		registry.begin({
			requestId: "req-1",
			kind: "enhance",
			intent: "enhance",
			scope: { kind: "block", id: "auth" },
			label: "block",
			branchKey: BRANCH,
			documentId: document.id,
			baseRevision: 3,
			baseDigest: "digest-a",
			prompt: "payload",
		});
		const staged = registry.stage("req-1", "refine", createBlock({ id: "auth", title: "Auth v2" }), contextFor({ documentId: document.id }));
		expect(staged.ok).toBe(true);

		const moved = registry.checkApplicable("req-1", {
			revision: 4,
			digest: "digest-a",
			documentId: document.id,
			branchKey: BRANCH,
		});
		expect(moved.ok).toBe(false);
		if (moved.ok) throw new Error("unreachable");
		expect(moved.errors[0]).toContain("revision 3 to 4");
		expect(moved.errors[0]).toContain("regenerate");
	});

	test("a changed on-disk digest is refused", () => {
		const registry = new ActionRegistry(BRANCH);
		const document = sampleDocument();
		registry.begin({
			requestId: "req-1",
			kind: "enhance",
			intent: "enhance",
			scope: { kind: "block", id: "auth" },
			label: "block",
			branchKey: BRANCH,
			documentId: document.id,
			baseRevision: 3,
			baseDigest: "digest-a",
			prompt: "payload",
		});
		expect(registry.stage("req-1", "refine", createBlock({ id: "auth" }), contextFor({ documentId: document.id })).ok).toBe(true);
		const check = registry.checkApplicable("req-1", {
			revision: 3,
			digest: "digest-b",
			documentId: document.id,
			branchKey: BRANCH,
		});
		expect(check.ok).toBe(false);
		if (check.ok) throw new Error("unreachable");
		expect(check.errors).toEqual([
			"the project file changed on disk while the request ran; regenerate instead of merging",
		]);
	});

	test("a proposal arriving after the file changed on disk is refused", () => {
		const registry = new ActionRegistry(BRANCH);
		const document = sampleDocument();
		registry.begin({
			requestId: "req-1",
			kind: "enhance",
			intent: "enhance",
			scope: { kind: "block", id: "auth" },
			label: "block",
			branchKey: BRANCH,
			documentId: document.id,
			baseRevision: 3,
			baseDigest: "digest-a",
			prompt: "payload",
		});
		const context = contextFor({ documentId: document.id, diskDigest: "digest-b" });
		const result = registry.stage("req-1", "refine", createBlock({ id: "auth" }), context);
		expect(result.ok).toBe(false);
		if (result.ok) throw new Error("unreachable");
		expect(result.errors).toEqual([
			"the project file changed on disk while this request was in flight; regenerate instead of staging",
		]);
		expect(registry.entryFor("req-1")!.state).toBe("pending");
		expect(registry.stage("req-1", "refine", createBlock({ id: "auth" }), contextFor({ documentId: document.id })).ok).toBe(
			true,
		);
	});

	test("a wrong document or branch is refused", () => {
		const registry = new ActionRegistry(BRANCH);
		beginFor(registry);
		const other = registry.stage("req-1", "s", createBlock({ id: "auth" }), contextFor({ documentId: "someone-else" }));
		expect(other.ok).toBe(false);
		if (other.ok) throw new Error("unreachable");
		expect(other.errors[0]).toContain("belongs to document");

		const foreign = registry.stage("req-1", "s", createBlock({ id: "auth" }), contextFor({ branchKey: "other-branch" }));
		expect(foreign.ok).toBe(false);
		if (foreign.ok) throw new Error("unreachable");
		expect(foreign.errors[0]).toContain("another branch");
	});

	test("a project request cannot be satisfied by a block, and vice versa", () => {
		const project = { scope: { kind: "project" } as const, documentId: "doc-1" };
		const blockReplacement = createBlock({ id: "auth" });
		const blockResult = validateReplacement(project, blockReplacement, type);
		expect(blockResult.ok).toBe(false);
		if (blockResult.ok) throw new Error("unreachable");
		expect(blockResult.errors[0]).toContain("needs a block-scope request");

		const blockRequest = { scope: { kind: "block", id: "auth" } as const, documentId: "doc-1" };
		const documentResult = validateReplacement(blockRequest, { ...sampleDocument(), id: "doc-1" }, type);
		expect(documentResult.ok).toBe(false);
		if (documentResult.ok) throw new Error("unreachable");
		expect(documentResult.errors[0]).toContain("only valid for a project-scope request");
	});

	test("the replacement must keep the requested id", () => {
		const request = { scope: { kind: "block", id: "auth" } as const, documentId: "doc-1" };
		const wrongId = validateReplacement(request, createBlock({ id: "tokens" }), type);
		expect(wrongId.ok).toBe(false);
		if (wrongId.ok) throw new Error("unreachable");
		expect(wrongId.errors).toEqual(["replacement block id tokens does not match the requested auth"]);

		const sameId = validateReplacement(request, createBlock({ id: "auth", title: "Auth v2" }), type);
		expect(sameId.ok).toBe(true);
	});

	test("a document replacement must keep the document id", () => {
		const request = { scope: { kind: "project" } as const, documentId: "doc-1" };
		const mismatched = validateReplacement(request, { ...sampleDocument(), id: "doc-2" }, type);
		expect(mismatched.ok).toBe(false);
		if (mismatched.ok) throw new Error("unreachable");
		expect(mismatched.errors).toEqual(["replacement document id doc-2 does not match doc-1"]);
	});

	test("a structurally invalid replacement is reported, not staged", () => {
		const request = { scope: { kind: "block", id: "auth" } as const, documentId: "doc-1" };
		const block = createBlock({ id: "auth", evidence: "observed" });
		const result = validateReplacement(request, block, type);
		expect(result.ok).toBe(false);
		if (result.ok) throw new Error("unreachable");
		expect(result.errors).toEqual(['block "New block" is evidence "observed" but carries no sources']);
	});

	test("a second proposal for the same request is refused", () => {
		const registry = new ActionRegistry(BRANCH);
		const document = sampleDocument();
		registry.begin({
			requestId: "req-1",
			kind: "enhance",
			intent: "enhance",
			scope: { kind: "block", id: "auth" },
			label: "block",
			branchKey: BRANCH,
			documentId: document.id,
			baseRevision: 3,
			baseDigest: undefined,
			prompt: "payload",
		});
		const context = contextFor({ documentId: document.id });
		expect(registry.stage("req-1", "first", createBlock({ id: "auth", title: "One" }), context).ok).toBe(true);
		const again = registry.stage("req-1", "second", createBlock({ id: "auth", title: "Two" }), context);
		expect(again.ok).toBe(false);
		if (again.ok) throw new Error("unreachable");
		expect(again.errors[0]).toContain("is staged, not awaiting a proposal");
	});

	test("an empty summary is refused", () => {
		const registry = new ActionRegistry(BRANCH);
		beginFor(registry);
		const result = registry.stage("req-1", "   ", createBlock({ id: "auth" }), contextFor());
		expect(result.ok).toBe(false);
		if (result.ok) throw new Error("unreachable");
		expect(result.errors).toEqual(["summary must describe the change"]);
	});

	test("a staged proposal survives journal serialization", () => {
		const registry = new ActionRegistry(BRANCH);
		beginFor(registry);
		registry.stage("req-1", "refine auth", createBlock({ id: "auth", title: "Auth v2" }), contextFor());
		registry.resolve("req-1", "accepted");

		const restored = new ActionRegistry(BRANCH);
		restored.adoptBranch(BRANCH, registry.serialize());
		const entry = restored.entryFor("req-1")!;
		expect(entry.state).toBe("accepted");
		expect(entry.proposal?.summary).toBe("refine auth");
		expect(restored.pending()).toBeUndefined();
	});
});

describe("settled work survives a replan or a prune", () => {
	/** `api` with its child `auth` settled by the human. */
	function worktree(): DiagramDocument {
		const document = sampleDocument();
		document.root.blocks[0]!.children!.blocks[0]!.status = "settled";
		return document;
	}

	function begin(
		registry: ActionRegistry,
		document: DiagramDocument,
		kind: "replan" | "prune" | "enhance",
		scope: Scope,
	): void {
		const began = registry.begin({
			requestId: "req-1",
			kind,
			intent: kind,
			scope,
			label: "request",
			branchKey: BRANCH,
			documentId: document.id,
			baseRevision: 3,
			baseDigest: "digest-a",
			prompt: "payload",
		});
		expect(began.ok).toBe(true);
	}

	test("a prune that drops the settled block is refused, one that drops open work is not", () => {
		const registry = new ActionRegistry(BRANCH);
		const document = worktree();
		begin(registry, document, "prune", { kind: "project" });
		const context = contextFor({ document });

		const droppingAuth = structuredClone(document);
		droppingAuth.root.blocks[0]!.children = null;
		const refused = registry.stage("req-1", "pruned", droppingAuth, context);
		expect(refused.ok).toBe(false);
		if (refused.ok) throw new Error("unreachable");
		expect(refused.errors[0]).toContain('"Auth" (auth)');
		expect(refused.errors[0]).toContain("settled work");
		expect(registry.entryFor("req-1")!.state).toBe("pending");

		// `db` is open, so a prune may remove it — with the relationship that pointed at it.
		const droppingDb = structuredClone(document);
		droppingDb.root.blocks = droppingDb.root.blocks.filter(block => block.id !== "db");
		droppingDb.root.edges = [];
		expect(registry.stage("req-1", "pruned", droppingDb, context).ok).toBe(true);
	});

	test("a block replan may not drop the settled blocks inside it", () => {
		const registry = new ActionRegistry(BRANCH);
		const document = worktree();
		begin(registry, document, "replan", { kind: "block", id: "api" });
		const context = contextFor({ document });

		const replaced = createBlock({
			id: "api",
			title: "API",
			children: createDiagram({ id: "api-inner", blocks: [createBlock({ id: "rate-limit", title: "Rate limit" })] }),
		});
		const refused = registry.stage("req-1", "replanned", replaced, context);
		expect(refused.ok).toBe(false);
		if (refused.ok) throw new Error("unreachable");
		expect(refused.errors[0]).toContain("auth");

		// The id is what matters: a settled block that moves inside the replanned
		// subtree is still kept.
		const rehomed = createBlock({
			id: "api",
			title: "API",
			children: createDiagram({
				id: "api-inner",
				blocks: [
					createBlock({
						id: "gateway",
						title: "Gateway",
						children: createDiagram({ blocks: [createBlock({ id: "auth", title: "Auth", status: "open" })] }),
					}),
				],
			}),
		});
		expect(registry.stage("req-1", "replanned", rehomed, context).ok).toBe(true);
	});

	test("a proposal that cannot see the document keeps the old rules", () => {
		const registry = new ActionRegistry(BRANCH);
		const document = worktree();
		begin(registry, document, "prune", { kind: "project" });
		const droppingAuth = structuredClone(document);
		droppingAuth.root.blocks[0]!.children = null;
		expect(registry.stage("req-1", "pruned", droppingAuth, contextFor({ documentId: document.id })).ok).toBe(true);
	});

	test("the other kinds still restructure a settled block freely", () => {
		const registry = new ActionRegistry(BRANCH);
		const document = worktree();
		begin(registry, document, "enhance", { kind: "block", id: "auth" });
		const rewritten = createBlock({ id: "auth", title: "Auth v2", status: "open" });
		expect(registry.stage("req-1", "refined", rewritten, contextFor({ document })).ok).toBe(true);
	});
});
