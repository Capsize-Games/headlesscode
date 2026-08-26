/**
 * Unit tests for src/memory/local.ts — LocalMemoryStore (JSONL file backend).
 * Plain assert-based (no framework), matching the repo test style.
 * Run via `npm test` → `tsx src/memory/__tests__/local.test.ts`.
 */

import assert from "node:assert/strict"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"

import { LocalMemoryStore, sanitizeProject } from "../local.js"
import type { SessionSummary } from "../types.js"

async function tmpDir(prefix: string): Promise<string> {
	return fs.mkdtemp(path.join(os.tmpdir(), prefix))
}

function fakeSession(overrides: Partial<SessionSummary> = {}): SessionSummary {
	return {
		id: `summary_${Math.random().toString(36).slice(2)}`,
		project: "proj",
		task: "run the tests",
		mode: "code",
		outcome: "success",
		summary: "Done: the test suite passes.",
		facts: [],
		filesTouched: ["src/a.ts"],
		commandsRun: ["npm test"],
		createdAt: new Date().toISOString(),
		...overrides,
	}
}

// ─── Tests ───────────────────────────────────────────────────────────────────

async function testAddListFactRoundTrip(): Promise<void> {
	const dir = await tmpDir("headlesscode-mem-")
	try {
		const store = new LocalMemoryStore({ dir })
		const fact = await store.addFact("my-repo", {
			kind: "convention",
			content: "always run tests before pushing",
			tags: ["testing"],
			source: "manual",
		})
		assert.ok(fact.id.startsWith("fact_"), "fact gets a deterministic id")
		assert.equal(fact.project, "my-repo")
		assert.equal(fact.kind, "convention")
		assert.ok(fact.createdAt, "fact gets a createdAt timestamp")

		const facts = await store.listFacts("my-repo")
		assert.equal(facts.length, 1)
		assert.equal(facts[0].content, "always run tests before pushing")
		assert.ok(facts[0].tags.includes("convention"), "kind is auto-added to tags")
		// JSONL on disk under facts/<project>.jsonl.
		const raw = await fs.readFile(path.join(dir, "facts", "my-repo.jsonl"), "utf-8")
		assert.equal(raw.trimEnd().split("\n").length, 1, "exactly one JSONL line")
	} finally {
		await fs.rm(dir, { recursive: true, force: true })
	}
}

async function testIdempotentAddFactDedupe(): Promise<void> {
	const dir = await tmpDir("headlesscode-mem-")
	try {
		const store = new LocalMemoryStore({ dir })
		const first = await store.addFact("proj", { kind: "knowledge", content: "the config lives in src/config.ts" })
		const second = await store.addFact("proj", { kind: "knowledge", content: "the config lives in src/config.ts" })
		assert.equal(first.id, second.id, "re-adding the same content returns the same fact")
		const facts = await store.listFacts("proj")
		assert.equal(facts.length, 1, "duplicate content is not appended")
	} finally {
		await fs.rm(dir, { recursive: true, force: true })
	}
}

async function testRecordListSessionRoundTrip(): Promise<void> {
	const dir = await tmpDir("headlesscode-mem-")
	try {
		const store = new LocalMemoryStore({ dir })
		const session = fakeSession({ id: "summary_fixed", filesTouched: ["a.ts", "b.ts"], commandsRun: ["npm test"] })
		await store.recordSession("proj", session)

		const sessions = await store.listSessions("proj")
		assert.equal(sessions.length, 1)
		assert.equal(sessions[0].id, "summary_fixed")
		assert.equal(sessions[0].outcome, "success")
		assert.deepEqual(sessions[0].filesTouched, ["a.ts", "b.ts"])

		// recordSession is idempotent by id.
		await store.recordSession("proj", session)
		assert.equal((await store.listSessions("proj")).length, 1)
	} finally {
		await fs.rm(dir, { recursive: true, force: true })
	}
}

async function testQueryRecallRelevance(): Promise<void> {
	const dir = await tmpDir("headlesscode-mem-")
	try {
		const store = new LocalMemoryStore({ dir })
		await store.addFact("proj", { kind: "failure", content: "never use the old scheduler — it breaks the queue" })
		await store.addFact("proj", { kind: "knowledge", content: "deploy the database with flyway migrations" })

		const recall = await store.queryRecall("proj", "scheduler queue broke", 5)
		assert.ok(recall.facts.length >= 2, "both facts returned (top-N over store)")
		assert.ok(
			recall.facts[0].content.includes("scheduler"),
			`fact mentioning the task keyword ranks first, got: ${recall.facts[0].content}`,
		)
		const scores = recall.facts.map((f) => f.score ?? 0)
		assert.ok(scores[0] > scores[1], `relevant fact scored higher (${scores[0]} vs ${scores[1]})`)
		// Score is a small number and deterministic ordering is stable.
		assert.ok(scores.every((s) => Number.isFinite(s)))
	} finally {
		await fs.rm(dir, { recursive: true, force: true })
	}
}

async function testQueryRecallEmptyStore(): Promise<void> {
	const dir = await tmpDir("headlesscode-mem-")
	try {
		const store = new LocalMemoryStore({ dir })
		const recall = await store.queryRecall("empty-project", "anything at all")
		assert.deepEqual(recall.facts, [])
		assert.deepEqual(recall.summaries, [])
	} finally {
		await fs.rm(dir, { recursive: true, force: true })
	}
}

async function testPerProjectIsolation(): Promise<void> {
	const dir = await tmpDir("headlesscode-mem-")
	try {
		const store = new LocalMemoryStore({ dir })
		await store.addFact("project-a", { kind: "decision", content: "project A decided to use React" })
		await store.recordSession("project-a", fakeSession({ id: "s-a" }))

		const factsA = await store.listFacts("project-a")
		const factsB = await store.listFacts("project-b")
		assert.equal(factsA.length, 1)
		assert.equal(factsB.length, 0, "project B sees no facts from project A")

		const recallB = await store.queryRecall("project-b", "React decision")
		assert.equal(recallB.facts.length, 0, "recall for project B never returns project A facts")
		assert.equal(recallB.summaries.length, 0)
		assert.equal((await store.listSessions("project-b")).length, 0)
	} finally {
		await fs.rm(dir, { recursive: true, force: true })
	}
}

async function testSummarizeRolling(): Promise<void> {
	const dir = await tmpDir("headlesscode-mem-")
	try {
		const store = new LocalMemoryStore({ dir })
		// Distinct createdAt per session: buildRollingSummary sorts by
		// createdAt desc, so identical millisecond timestamps would make the
		// "last 2" selection nondeterministic (sessions written in the same
		// ms keep file order under the stable sort).
		for (let i = 0; i < 3; i++) {
			await store.recordSession(
				"proj",
				fakeSession({
					id: `s${i}`,
					outcome: i % 2 === 0 ? "success" : "failure",
					createdAt: new Date(Date.now() + i).toISOString(),
				}),
			)
		}
		const recap = await store.summarize("proj", { maxEntries: 2 })
		assert.match(recap, /Rolling session recap/)
		const headings = recap.split("\n").filter((l) => l.startsWith("**") && l.includes("outcome:"))
		assert.equal(headings.length, 2, "maxEntries caps the recap")
		assert.match(recap, /outcome: failure/)
	} finally {
		await fs.rm(dir, { recursive: true, force: true })
	}
}

async function testSanitizeProject(): Promise<void> {
	assert.equal(sanitizeProject("my-repo"), "my-repo")
	assert.equal(sanitizeProject("../evil/path"), "evil_path")
	assert.equal(sanitizeProject(""), "default")
}

// ─── Runner ──────────────────────────────────────────────────────────────────

const tests: Array<[string, () => Promise<void>]> = [
	["addFact/listFacts round-trip (JSONL on disk)", testAddListFactRoundTrip],
	["addFact idempotent dedupe by content", testIdempotentAddFactDedupe],
	["recordSession/listSessions round-trip + idempotent by id", testRecordListSessionRoundTrip],
	["queryRecall ranks keyword-relevant fact first", testQueryRecallRelevance],
	["queryRecall works on an empty store", testQueryRecallEmptyStore],
	["per-project isolation (A never leaks into B)", testPerProjectIsolation],
	["summarize returns a capped rolling recap", testSummarizeRolling],
	["sanitizeProject produces filesystem-safe slugs", testSanitizeProject],
]

async function main(): Promise<void> {
	let failed = 0
	for (const [name, fn] of tests) {
		try {
			await fn()
			console.log(`  ok   ${name}`)
		} catch (err) {
			failed++
			console.error(`  FAIL ${name}`)
			console.error(err instanceof Error ? err.stack ?? err.message : String(err))
		}
	}
	if (failed > 0) {
		console.error(`\n${failed} test(s) failed`)
		process.exit(1)
	}
	console.log(`\nAll ${tests.length} local store tests passed`)
}

main().catch((err) => {
	console.error("Test runner crashed:", err)
	process.exit(1)
})
