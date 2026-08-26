/**
 * Phase 3 memory subsystem — shared types + contracts.
 *
 * This module defines the harness's memory model: knowledge facts about a
 * codebase (conventions, past decisions, things that didn't work), rolling
 * session summaries, and the two abstractions the rest of the system depends
 * on:
 *
 *   - `MemoryStore` — the persistence/recall contract. `LocalMemoryStore`
 *     (src/memory/local.ts) is the fully working local implementation; a
 *     future `UwUChatMemoryStore` (src/memory/uwuchat.ts) implements the SAME
 *     interface against authenticated, per-project-scoped REST endpoints on
 *     the AIRunner/UwUChat side (see docs/memory-uwuchat-contract.md).
 *   - `Embedder` — the local-embedding abstraction, so a real local embedding
 *     model can be swapped in behind the same interface later. Phase 3 ships
 *     `createLocalEmbedder()` (src/memory/embed.ts), a zero-dependency,
 *     deterministic lexical-hash stand-in.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * DATA ISOLATION — HARD REQUIREMENT
 *
 * The harness memory is knowledge about the harness's OWN codebase work
 * ("facts about a codebase and its past decisions"), NOT tenant/user data.
 * It MUST live in a schema/storage namespace dedicated to the harness and
 * MUST NEVER be reachable through any customer tenant route, and customer
 * tenant data MUST NEVER be written into it. Every record is scoped by
 * `project` (a repo name — not a tenant, not a user). Implementations must:
 *
 *   1. Use a dedicated store (a dedicated memory root dir for the local
 *      backend; a dedicated schema/service for the UwUChat backend) that is
 *      never the same table/store any customer-facing route reads or writes.
 *   2. Never route harness memory through a customer tenant path, and never
 *      allow tenant-scoped queries to reach this store.
 *   3. Never mix FHE/encryption/tenant-ownership semantics into this data —
 *      it is an internal dev tool's knowledge, not customer data.
 *
 * See docs/memory-uwuchat-contract.md for the full isolation guarantee.
 * ═══════════════════════════════════════════════════════════════════════════
 */

/** A persisted knowledge fact about a project. */
export interface MemoryFact {
	/** Stable unique id (deterministic from content for local backend). */
	id: string
	/** Project scope (repo name). Memory is per-project, never per-tenant. */
	project: string
	/**
	 * Fact category.
	 * - `convention` — rules/always-do patterns ("always run tests first")
	 * - `decision`   — recorded past decisions ("we chose X over Y because …")
	 * - `failure`    — things that DIDN'T work ("never use X — it breaks Y")
	 * - `knowledge`  — general facts about the codebase
	 */
	kind: "convention" | "decision" | "failure" | "knowledge"
	content: string
	tags: string[]
	/** Provenance, e.g. `session:<summary-id>` or a manual note. */
	source?: string
	/** ISO timestamp. */
	createdAt: string
}

/** Input for adding a fact (the store generates `id`/`project`/`createdAt`). */
export interface FactInput {
	kind: MemoryFact["kind"]
	content: string
	tags?: string[]
	source?: string
}

/** A rolling record of one completed harness session (AgentMemory equivalent). */
export interface SessionSummary {
	id: string
	project: string
	task: string
	mode?: string
	/** outcome of the session: completed vs. bounded failure. */
	outcome: "success" | "failure"
	/** The session's final answer text (or the failure reason). */
	summary: string
	/** Facts extracted from this session (deterministic heuristics). */
	facts: MemoryFact[]
	filesTouched: string[]
	commandsRun: string[]
	createdAt: string
}

/** A fact annotated with a relevance score from `queryRecall`. */
export interface ScoredFact extends MemoryFact {
	/** Small relevance score (higher = more relevant). Absent = unscored. */
	score?: number
}

/** A session summary annotated with a relevance score from `queryRecall`. */
export interface ScoredSessionSummary extends SessionSummary {
	/** Small relevance score (higher = more relevant). Absent = unscored. */
	score?: number
}

/** Result of a recall query: top relevant facts + session summaries. */
export interface RecallResult {
	facts: ScoredFact[]
	summaries: ScoredSessionSummary[]
}

/**
 * The memory persistence contract — the UwUChat-backable boundary.
 *
 * Every method is project-scoped: callers pass the project (repo) name and
 * implementations MUST guarantee that project A's data is never returned for
 * project B. All methods are async (the future UwUChat backend is HTTP).
 *
 * A future `UwUChatMemoryStore` implements this EXACT interface against
 * authenticated, per-project-scoped REST endpoints on the AIRunner/UwUChat
 * side (endpoint contract documented in docs/memory-uwuchat-contract.md);
 * `LocalMemoryStore` implements it today with plain fs + JSONL.
 */
export interface MemoryStore {
	/** All facts stored for a project (append order). */
	listFacts(project: string): Promise<MemoryFact[]>
	/** Add a fact; MUST be idempotent (dedupe by content within a project). */
	addFact(project: string, factInput: FactInput): Promise<MemoryFact>
	/**
	 * Semantic recall over facts + session summaries for a project.
	 * Returns the top-`limit` most relevant facts and summaries, each with a
	 * small relevance score, ordered deterministically (score desc, then
	 * createdAt desc). Must work with an empty store (returns empty results).
	 */
	queryRecall(project: string, query: string, limit?: number): Promise<RecallResult>
	/** Persist a completed session summary for a project. */
	recordSession(project: string, summary: SessionSummary): Promise<void>
	/** All session summaries stored for a project (append order). */
	listSessions(project: string): Promise<SessionSummary[]>
	/**
	 * Optional: a compact rolling recap (markdown) of the last N sessions for
	 * a project, so a session can carry context forward WITHOUT keeping the
	 * full raw history. Implementations that provide it can be used directly
	 * by the loop; otherwise the loop derives one from `queryRecall`.
	 */
	summarize?(project: string, options?: { maxEntries?: number }): Promise<string>
}

/**
 * The local embedding abstraction.
 *
 * Phase 3 ships `createLocalEmbedder()` (a deterministic, dependency-free
 * lexical-hash stand-in). A real local embedding model can be swapped in
 * behind this same interface later without touching any caller.
 */
export interface Embedder {
	/** Embed a text into a fixed-dimension L2-normalized vector. */
	embed(text: string): number[]
}
