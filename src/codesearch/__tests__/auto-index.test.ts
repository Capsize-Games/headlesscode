/**
 * Unit tests for src/auto-index.ts — the throttled, non-fatal, skippable
 * auto-refresh of the codebase-search index (issue #58,
 * plans/auto-index-on-session-start.md).
 *
 * Plain assert-based script (no test framework, no network — the embedder is
 * a deterministic FAKE, matching how src/codesearch/__tests__/index.test.ts
 * fakes it for buildIndex), run via `npm test` → `tsx
 * src/codesearch/__tests__/auto-index.test.ts`.
 *
 * Coverage per the plan's verification list:
 *   - fresh repo, no index: the refresh fires and builds an index;
 *   - a second run within the throttle window: walk+hash pass SKIPPED (no
 *     embedder calls — call-counter proof, no network);
 *   - HEADLESSCODE_SKIP_AUTO_INDEX=1 / --skip-auto-index: no build attempt
 *     at all (not even a stale check);
 *   - a failing embedder: non-fatal — a WARN is logged, nothing throws;
 *   - missing API key on the openrouter backend: same non-fatal outcome,
 *     before any embedder call;
 *   - two concurrent builds of one repo: no torn/corrupt index (the write
 *     path is atomic — write-to-temp + rename).
 */

import assert from "node:assert/strict"
import * as fs from "node:fs"
import * as fsp from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"

import {
	AUTO_INDEX_MIN_INTERVAL_ENV,
	AUTO_INDEX_SKIP_ENV,
	refreshIndexIfDue,
	resolveAutoIndexMinIntervalMs,
} from "../../auto-index.js"
import { buildIndex, hasCodebaseIndex, indexFilePath, loadIndexMetadata, readJsonlEntries } from "../index.js"
import type { Embedder } from "../embedder.js"

/** Deterministic fake embedder with an embed-call counter (no network). */
class FakeEmbedder implements Embedder {
	model = "fake/embed"
	/** Number of embedBatch calls made (the thing the throttle must keep at 0). */
	calls = 0
	readonly dims = 8

	async embedBatch(texts: string[]): Promise<{ embeddings: number[][]; promptTokens: number; totalTokens: number }> {
		this.calls++
		return {
			embeddings: texts.map((t) => fakeVector(t, this.dims)),
			promptTokens: texts.length,
			totalTokens: texts.length,
		}
	}
}

/** Deterministic vector from a string (each char's code contributes). */
function fakeVector(text: string, dims: number): number[] {
	const v = new Array<number>(dims).fill(0)
	for (const ch of text) {
		v[ch.charCodeAt(0) % dims] += 1
	}
	return v
}

/** Fake embedder whose embedBatch always throws (the failing-embedder case). */
class ThrowingEmbedder implements Embedder {
	model = "fake/throws"

	async embedBatch(): Promise<never> {
		throw new Error("simulated embedder failure (no API key / network down)")
	}
}

/** Build a temp workspace with one source file. */
async function mkWorkspace(): Promise<string> {
	const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "hc-auto-idx-"))
	await fsp.mkdir(path.join(dir, "src"), { recursive: true })
	await fsp.writeFile(path.join(dir, "src", "a.ts"), "export function alpha() {\n  return 1\n}\n", "utf-8")
	return dir
}

/** Capture the log/warn lines passed to refreshIndexIfDue. */
function capture() {
	const lines: string[] = []
	return {
		lines,
		log: (msg: string): void => { lines.push(msg) },
		warn: (msg: string): void => { lines.push(msg) },
	}
}

async function testFreshRepoBuildsIndexAndIsDetectable(): Promise<void> {
	const store = await fsp.mkdtemp(path.join(os.tmpdir(), "hc-auto-idx-store-"))
	const ws = await mkWorkspace()
	process.env.HEADLESSCODE_DATA_DIR = store
	try {
		const embedder = new FakeEmbedder()
		const { log, lines } = capture()
		const result = await refreshIndexIfDue(ws, { embedder, backend: "ollama", log, warn: log, minIntervalMs: 0 })

		assert.equal(result.outcome, "refreshed", "a fresh repo with no index must refresh")
		assert.ok(result.build && result.build.filesScanned >= 1, "the build scanned the workspace")
		assert.ok(embedder.calls >= 1, "the first build must call the embedder")
		assert.ok(await hasCodebaseIndex(ws), "a usable index now exists")
		assert.ok(fs.statSync(indexFilePath(ws)).size > 0, "index file is non-empty")
		assert.ok(lines.some((l) => l.includes("[auto-index] refreshed")), `logs the refresh, got: ${lines.join(" | ")}`)
		assert.ok(lines.some((l) => l.includes("estimated cost")), `prints the cost line (cost-visible), got: ${lines.join(" | ")}`)
		const meta = loadIndexMetadata(ws)
		assert.ok(meta && meta.lastBuiltAt !== undefined, "metadata records lastBuiltAt (the throttle key)")
		assert.ok(meta && meta.backend === "ollama", "metadata records the backend used")
	} finally {
		delete process.env.HEADLESSCODE_DATA_DIR
		await fsp.rm(store, { recursive: true, force: true })
		await fsp.rm(ws, { recursive: true, force: true })
	}
}

async function testSecondRunWithinThrottleWindowSkipsBuild(): Promise<void> {
	const store = await fsp.mkdtemp(path.join(os.tmpdir(), "hc-auto-idx-store2-"))
	const ws = await mkWorkspace()
	process.env.HEADLESSCODE_DATA_DIR = store
	try {
		const embedder = new FakeEmbedder()
		await refreshIndexIfDue(ws, { embedder, backend: "ollama", log: () => {}, warn: () => {}, minIntervalMs: 0 })
		const callsAfterFirst = embedder.calls
		assert.ok(callsAfterFirst >= 1)

		// Second run within a LONG throttle window (60s): walk+hash skipped.
		const { lines, log, warn } = capture()
		const second = await refreshIndexIfDue(ws, { embedder, backend: "ollama", log, warn, minIntervalMs: 60_000 })

		assert.equal(second.outcome, "throttled", "a second run inside the window must be throttled")
		assert.equal(embedder.calls, callsAfterFirst, "NO embedder calls on the throttled run (walk+hash skipped entirely)")
		assert.ok(lines.some((l) => l.includes("[auto-index] skip:")), `logs the skip at INFO, got: ${lines.join(" | ")}`)

		// Third run with throttling disabled (0): refreshes again — and a
		// CHANGED chunk forces a real re-embed (the proof it re-walked; an
		// unchanged rebuild would legitimately embed nothing).
		await fsp.appendFile(path.join(ws, "src", "a.ts"), "export function beta() {\n  return 2\n}\n", "utf-8")
		const third = await refreshIndexIfDue(ws, { embedder, backend: "ollama", log: () => {}, warn: () => {}, minIntervalMs: 0 })
		assert.equal(third.outcome, "refreshed", "minIntervalMs 0 = never throttled")
		assert.ok(third.build && third.build.filesScanned >= 1, "the un-throttled run re-walks the workspace")
		assert.ok(embedder.calls > callsAfterFirst, "the un-throttled run re-embeds the changed chunk")
	} finally {
		delete process.env.HEADLESSCODE_DATA_DIR
		await fsp.rm(store, { recursive: true, force: true })
		await fsp.rm(ws, { recursive: true, force: true })
	}
}

async function testThrottleEnvVarIsRespected(): Promise<void> {
	const env = { [AUTO_INDEX_SKIP_ENV]: "1" }
	// Explicit min-interval override wins.
	assert.equal(resolveAutoIndexMinIntervalMs({ [AUTO_INDEX_MIN_INTERVAL_ENV]: "5000" }, undefined), 5000)
	// Env var wins over the default.
	assert.equal(resolveAutoIndexMinIntervalMs({ [AUTO_INDEX_MIN_INTERVAL_ENV]: "120000" }, undefined), 120000)
	// Invalid/unset falls back to the default.
	assert.equal(resolveAutoIndexMinIntervalMs({}, undefined), 15 * 60 * 1000)
	assert.equal(resolveAutoIndexMinIntervalMs({ [AUTO_INDEX_MIN_INTERVAL_ENV]: "abc" }, undefined), 15 * 60 * 1000)
	// Explicit 0 = never throttled.
	assert.equal(resolveAutoIndexMinIntervalMs(env, 0), 0)
}

async function testSkipFlagAndEnvPreventAnyAttempt(): Promise<void> {
	const store = await fsp.mkdtemp(path.join(os.tmpdir(), "hc-auto-idx-store3-"))
	const ws = await mkWorkspace()
	process.env.HEADLESSCODE_DATA_DIR = store
	try {
		// --skip-auto-index (options.skip): no build, not even a stale check.
		const embedder = new FakeEmbedder()
		const { lines, log, warn } = capture()
		const skipped = await refreshIndexIfDue(ws, { skip: true, embedder, backend: "ollama", log, warn })

		assert.equal(skipped.outcome, "disabled", "--skip-auto-index disables the refresh")
		assert.equal(embedder.calls, 0, "no embedder call on the skipped run")
		assert.equal(await hasCodebaseIndex(ws), false, "no index is built when skipped")
		assert.ok(lines.some((l) => l.includes("[auto-index] skipped")), `logs the skip, got: ${lines.join(" | ")}`)

		// $HEADLESSCODE_SKIP_AUTO_INDEX=1: same result via env.
		const viaEnv = await refreshIndexIfDue(ws, { env: { [AUTO_INDEX_SKIP_ENV]: "1" }, embedder, backend: "ollama", log, warn })
		assert.equal(viaEnv.outcome, "disabled", "the env var disables the refresh too")
		assert.equal(embedder.calls, 0, "the env-skipped run also makes no embedder calls")
	} finally {
		delete process.env.HEADLESSCODE_DATA_DIR
		await fsp.rm(store, { recursive: true, force: true })
		await fsp.rm(ws, { recursive: true, force: true })
	}
}

async function testFailingEmbedderIsNonFatal(): Promise<void> {
	const store = await fsp.mkdtemp(path.join(os.tmpdir(), "hc-auto-idx-store4-"))
	const ws = await mkWorkspace()
	process.env.HEADLESSCODE_DATA_DIR = store
	try {
		const { lines, log, warn } = capture()
		const result = await refreshIndexIfDue(ws, { embedder: new ThrowingEmbedder(), backend: "ollama", log, warn })

		assert.equal(result.outcome, "error", "a failing embedder yields an error outcome, not a throw")
		assert.ok(lines.some((l) => l.includes("simulated embedder failure")), `WARN carries the real error, got: ${lines.join(" | ")}`)
		// No index was written — and crucially the caller (round/session) was
		// NOT blocked: refreshIndexIfDue resolved normally.
		assert.equal(await hasCodebaseIndex(ws), false, "no partial index on a failed build")
	} finally {
		delete process.env.HEADLESSCODE_DATA_DIR
		await fsp.rm(store, { recursive: true, force: true })
		await fsp.rm(ws, { recursive: true, force: true })
	}
}

async function testInvalidBackendEnvIsNonFatal(): Promise<void> {
	// A bad $HEADLESSCODE_EMBEDDING_BACKEND value must be a WARN, never a
	// throw — resolveEmbeddingBackend sits inside the try in refreshIndexIfDue.
	const store = await fsp.mkdtemp(path.join(os.tmpdir(), "hc-auto-idx-store7-"))
	const ws = await mkWorkspace()
	process.env.HEADLESSCODE_DATA_DIR = store
	try {
		const embedder = new FakeEmbedder()
		const { lines, log, warn } = capture()
		const result = await refreshIndexIfDue(ws, {
			env: { HEADLESSCODE_EMBEDDING_BACKEND: "bogus" },
			embedder,
			log,
			warn,
			minIntervalMs: 0,
		})

		assert.equal(result.outcome, "error", "an invalid backend yields an error outcome, never a throw")
		assert.equal(embedder.calls, 0, "the embedder is never called")
		assert.ok(
			lines.some((l) => l.includes("Invalid embedding backend")),
			`the WARN carries the real error, got: ${lines.join(" | ")}`,
		)
	} finally {
		delete process.env.HEADLESSCODE_DATA_DIR
		await fsp.rm(store, { recursive: true, force: true })
		await fsp.rm(ws, { recursive: true, force: true })
	}
}

async function testMissingApiKeyOnOpenRouterIsNonFatalAndCallsNoEmbedder(): Promise<void> {
	const store = await fsp.mkdtemp(path.join(os.tmpdir(), "hc-auto-idx-store5-"))
	const ws = await mkWorkspace()
	process.env.HEADLESSCODE_DATA_DIR = store
	try {
		const embedder = new FakeEmbedder()
		const { lines, log, warn } = capture()
		const result = await refreshIndexIfDue(ws, {
			// Default backend = openrouter; env has NO API key.
			env: {},
			embedder,
			log,
			warn,
			minIntervalMs: 0,
		})

		assert.equal(result.outcome, "error", "no API key → error outcome (never a throw, never a build)")
		assert.equal(embedder.calls, 0, "the embedder is never called when the key pre-check fails")
		assert.ok(
			lines.some((l) => l.includes("HEADLESSCODE_OPENROUTER_API_KEY is not set")),
			`the WARN explains the missing key, got: ${lines.join(" | ")}`,
		)
		assert.equal(await hasCodebaseIndex(ws), false, "no index built without a key")
	} finally {
		delete process.env.HEADLESSCODE_DATA_DIR
		await fsp.rm(store, { recursive: true, force: true })
		await fsp.rm(ws, { recursive: true, force: true })
	}
}

/**
 * Two concurrent builds of ONE repo must never leave a torn/corrupt index at
 * the final path (issue #15's coexistence scenario — the plan's verification
 * point 5). The write path is atomic (write-to-temp + rename), so the outcome
 * is last-writer-wins with the file always complete.
 */
async function testConcurrentBuildsDoNotCorruptIndex(): Promise<void> {
	const store = await fsp.mkdtemp(path.join(os.tmpdir(), "hc-auto-idx-store6-"))
	const ws = await mkWorkspace()
	process.env.HEADLESSCODE_DATA_DIR = store
	try {
		const slow = async (embedder: Embedder): Promise<void> => {
			// Stagger the two builds slightly so they genuinely interleave.
			await new Promise((r) => setTimeout(r, 20))
			await buildIndex(embedder, ws)
		}
		await Promise.all([slow(new FakeEmbedder()), slow(new FakeEmbedder())])

		// The final index must be complete and parseable (no torn JSONL lines).
		const entries = readJsonlEntries(indexFilePath(ws))
		assert.ok(entries.length >= 1, "the surviving index has entries")
		for (const e of entries) {
			assert.ok(Array.isArray(e.embedding) && e.embedding.length === 8, "each entry is a valid parsed index line")
		}
		// No leftover temp files from the atomic write path.
		const dir = path.dirname(indexFilePath(ws))
		const leftovers = (await fsp.readdir(dir)).filter((f) => f.includes(".tmp-"))
		assert.deepEqual(leftovers, [], "no temp files left behind by atomic writes")
	} finally {
		delete process.env.HEADLESSCODE_DATA_DIR
		await fsp.rm(store, { recursive: true, force: true })
		await fsp.rm(ws, { recursive: true, force: true })
	}
}

const tests: Array<[string, () => Promise<void>]> = [
	["fresh repo with no index: refresh fires, index built + detectable", testFreshRepoBuildsIndexAndIsDetectable],
	["second run within throttle window: walk+hash SKIPPED (no embed calls)", testSecondRunWithinThrottleWindowSkipsBuild],
	["throttle min-interval resolution (env + override)", testThrottleEnvVarIsRespected],
	["--skip-auto-index / HEADLESSCODE_SKIP_AUTO_INDEX=1: no build attempt at all", testSkipFlagAndEnvPreventAnyAttempt],
	["failing embedder: non-fatal WARN, nothing throws", testFailingEmbedderIsNonFatal],
	["missing API key (openrouter): non-fatal WARN, no embedder call", testMissingApiKeyOnOpenRouterIsNonFatalAndCallsNoEmbedder],
	["invalid HEADLESSCODE_EMBEDDING_BACKEND value: non-fatal WARN, no embedder call", testInvalidBackendEnvIsNonFatal],
	["two concurrent builds: no torn/corrupt index (atomic write)", testConcurrentBuildsDoNotCorruptIndex],
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
	console.log(`\nAll ${tests.length} auto-index tests passed`)
}

main().catch((err) => {
	console.error("Test runner crashed:", err)
	process.exit(1)
})
