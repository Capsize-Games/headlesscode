/**
 * LocalMemoryStore — the fully working, file-backed Phase 3 memory backend.
 *
 * Implements the `MemoryStore` contract (src/memory/types.ts) with plain
 * `node:fs` + JSONL — NO new dependencies. This is the harness-side
 * implementation until the AIRunner/UwUChat endpoints exist; a future
 * `UwUChatMemoryStore` implements the same interface over HTTP.
 *
 * Storage layout (under a single memory root dir, per-project scoped):
 *
 *   <root>/facts/<project>.jsonl      — one JSON `MemoryFact` per line
 *   <root>/sessions/<project>.jsonl   — one JSON `SessionSummary` per line
 *
 * Append-only: reads parse the whole file, writes append a line. Validation is
 * deliberately LOOSE (matching the orchestrator state-file style): malformed
 * or partially-written lines are skipped, missing files are treated as empty.
 *
 * Root dir resolution order:
 *   1. `options.dir` (constructor override — tests and the CLI pass this)
 *   2. `process.env.HEADLESSCODE_MEMORY_DIR`
 *   3. `<cwd>/.headlesscode/memory`
 *
 * Project scoping: project names are sanitized to a filesystem-safe slug and
 * every method scopes strictly to that project's file. Project A's data can
 * never be returned for project B.
 *
 * Data isolation: this store lives under the harness's own memory root and is
 * NEVER the same storage any customer tenant route touches (see the isolation
 * requirement in src/memory/types.ts and docs/memory-uwuchat-contract.md).
 */

import * as fsp from "node:fs/promises"
import * as path from "node:path"

import { cosine, createLocalEmbedder } from "./embed.js"
import { buildRollingSummary } from "./summarizer.js"
import type { Embedder, FactInput, MemoryFact, MemoryStore, RecallResult, SessionSummary } from "./types.js"

export interface LocalMemoryStoreOptions {
	/** Memory root dir. Default: $HEADLESSCODE_MEMORY_DIR else <cwd>/.headlesscode/memory. */
	dir?: string
	/** Embedder for semantic recall (default: createLocalEmbedder(256)). */
	embedder?: Embedder
}

/** Weight of exact tag/keyword matches in the recall score (weighted HIGH). */
export const KEYWORD_WEIGHT = 1.0
/** Weight of embedder cosine similarity in the recall score. */
export const SEMANTIC_WEIGHT = 0.5
/** Default number of recalled facts/summaries. */
export const DEFAULT_RECALL_LIMIT = 5

/**
 * Sanitize a project name into a filesystem-safe slug used for the JSONL
 * filename. Repo names are typically `my-repo` already; separators and other
 * unsafe characters become `_`.
 */
export function sanitizeProject(project: string): string {
	const cleaned = project
		.replace(/[^A-Za-z0-9._-]+/g, "_")
		.replace(/^[._-]+|[._-]+$/g, "")
	return cleaned || "default"
}

/** Deterministic content hash (hex) — used for idempotent fact dedupe. */
function contentHash(content: string): string {
	const bytes = Buffer.from(content, "utf-8")
	let hash = 0x811c9dc5
	for (const b of bytes) {
		hash ^= b
		hash = Math.imul(hash, 0x01000193)
	}
	return (hash >>> 0).toString(16).padStart(8, "0")
}

async function readJsonl<T>(file: string): Promise<T[]> {
	let raw: string
	try {
		raw = await fsp.readFile(file, "utf-8")
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return []
		}
		throw error
	}
	const items: T[] = []
	for (const line of raw.split("\n")) {
		const trimmed = line.trim()
		if (!trimmed) {
			continue
		}
		try {
			items.push(JSON.parse(trimmed) as T)
		} catch {
			// Loose validation: skip malformed / partially-written lines.
		}
	}
	return items
}

async function appendJsonl(file: string, record: unknown): Promise<void> {
	await fsp.mkdir(path.dirname(file), { recursive: true })
	await fsp.appendFile(file, JSON.stringify(record) + "\n", "utf-8")
}

function sortedLatest<T extends { createdAt: string }>(items: T[]): T[] {
	return [...items].sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0))
}

export class LocalMemoryStore implements MemoryStore {
	readonly dir: string
	private readonly embedder: Embedder

	constructor(options: LocalMemoryStoreOptions = {}) {
		const resolvedDir =
			options.dir ?? process.env.HEADLESSCODE_MEMORY_DIR ?? path.join(process.cwd(), ".headlesscode", "memory")
		this.dir = path.resolve(resolvedDir)
		this.embedder = options.embedder ?? createLocalEmbedder()
	}

	// ─── Path helpers (per-project scoping) ──────────────────────────────────

	private projectKey(project: string): string {
		return sanitizeProject(project)
	}

	private factsPath(projectKey: string): string {
		return path.join(this.dir, "facts", `${projectKey}.jsonl`)
	}

	private sessionsPath(projectKey: string): string {
		return path.join(this.dir, "sessions", `${projectKey}.jsonl`)
	}

	// ─── MemoryStore implementation ──────────────────────────────────────────

	async listFacts(project: string): Promise<MemoryFact[]> {
		return readJsonl<MemoryFact>(this.factsPath(this.projectKey(project)))
	}

	async addFact(project: string, factInput: FactInput): Promise<MemoryFact> {
		const projectKey = this.projectKey(project)
		const file = this.factsPath(projectKey)
		const existing = await readJsonl<MemoryFact>(file)
		// Idempotent: dedupe by content within the project (content-hash key).
		const duplicate = existing.find((f) => f.content === factInput.content)
		if (duplicate) {
			return duplicate
		}
		const fact: MemoryFact = {
			id: `fact_${contentHash(factInput.content)}`,
			project: projectKey,
			kind: factInput.kind,
			content: factInput.content,
			tags: [...new Set([...(factInput.tags ?? []), factInput.kind])],
			source: factInput.source,
			createdAt: new Date().toISOString(),
		}
		await appendJsonl(file, fact)
		return fact
	}

	async queryRecall(project: string, query: string, limit = DEFAULT_RECALL_LIMIT): Promise<RecallResult> {
		const projectKey = this.projectKey(project)
		const [facts, sessions] = await Promise.all([readJsonl<MemoryFact>(this.factsPath(projectKey)), readJsonl<SessionSummary>(this.sessionsPath(projectKey))])
		if (facts.length === 0 && sessions.length === 0) {
			return { facts: [], summaries: [] }
		}

		const queryVec = this.embedder.embed(query)
		const tokens = keywordTokens(query)

		const scoreFact = (fact: MemoryFact): number => {
			const keyword = keywordScore(fact.content, fact.tags, tokens)
			const semantic = cosine(queryVec, this.embedder.embed(`${fact.kind} ${fact.content} ${fact.tags.join(" ")}`))
			return keyword * KEYWORD_WEIGHT + semantic * SEMANTIC_WEIGHT
		}
		const scoreSummary = (s: SessionSummary): number => {
			const keyword = keywordScore(`${s.task} ${s.summary}`, [], tokens)
			const semantic = cosine(queryVec, this.embedder.embed(`${s.task} ${s.summary} ${s.mode ?? ""}`))
			return keyword * KEYWORD_WEIGHT + semantic * SEMANTIC_WEIGHT
		}

		const scoredFacts = facts.map((f) => ({ ...f, score: scoreFact(f) }))
		const scoredSummaries = sessions.map((s) => ({ ...s, score: scoreSummary(s) }))

		// Deterministic ordering: score desc, then createdAt desc.
		scoredFacts.sort((a, b) => byScoreThenNewest(a, b))
		scoredSummaries.sort((a, b) => byScoreThenNewest(a, b))

		return {
			facts: scoredFacts.slice(0, limit),
			summaries: scoredSummaries.slice(0, limit),
		}
	}

	async recordSession(project: string, summary: SessionSummary): Promise<void> {
		const projectKey = this.projectKey(project)
		const file = this.sessionsPath(projectKey)
		const existing = await readJsonl<SessionSummary>(file)
		if (existing.some((s) => s.id === summary.id)) {
			// Idempotent by id: never double-record the same session.
			return
		}
		const record: SessionSummary = {
			...summary,
			project: projectKey,
			id: summary.id || `session_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
			facts: summary.facts.map((f) => ({ ...f, project: projectKey })),
		}
		await appendJsonl(file, record)
	}

	async listSessions(project: string): Promise<SessionSummary[]> {
		return readJsonl<SessionSummary>(this.sessionsPath(this.projectKey(project)))
	}

	async summarize(project: string, options: { maxEntries?: number } = {}): Promise<string> {
		const sessions = await this.listSessions(project)
		return buildRollingSummary(sessions, options.maxEntries)
	}
}

// ─── Recall scoring helpers ──────────────────────────────────────────────────

/** Deterministic ordering: score desc, then createdAt desc. */
function byScoreThenNewest<T extends { score?: number; createdAt: string }>(a: T, b: T): number {
	const scoreDiff = (b.score ?? 0) - (a.score ?? 0)
	if (scoreDiff !== 0) {
		return scoreDiff
	}
	return a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0
}

/** Lowercased alphanumeric tokens from the query (deduped, capped at 10). */
function keywordTokens(query: string): string[] {
	const raw = query.toLowerCase().match(/[a-z0-9]+/g) ?? []
	return [...new Set(raw)].filter((t) => t.length > 1).slice(0, 10)
}

/**
 * Exact tag/content keyword match score (weighted HIGH per the contract):
 * +0.4 per query token found in the content, +0.3 per token found in tags.
 */
function keywordScore(content: string, tags: string[], tokens: string[]): number {
	const text = content.toLowerCase()
	const tagText = tags.join(" ").toLowerCase()
	let score = 0
	for (const token of tokens) {
		if (text.includes(token)) {
			score += 0.4
		}
		if (tagText.includes(token)) {
			score += 0.3
		}
	}
	return score
}

