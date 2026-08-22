/**
 * Unit tests for embedding-backend selection and index-backend metadata.
 *
 * Plain assert-based script (no test framework, no network), run via
 * `npm test` → `tsx src/codesearch/__tests__/backend-selection.test.ts`.
 *
 * Covers:
 *   - HEADLESSCODE_EMBEDDING_BACKEND env var (and --embedding-backend value)
 *     actually switches which embedder createEmbedder returns.
 *   - The build records the backend on every entry AND in the sibling
 *     metadata file, and re-indexing with the SAME backend skips unchanged
 *     chunks while a backend switch forces a full re-embed.
 *   - The codebase_search handler refuses a backend mismatch with a clear
 *     error instead of comparing different-dimension vectors (dimension
 *     incompatibility between local qwen3-embedding:8b = 4096 and cloud
 *     qwen/qwen3-embedding-4b = 2560 is the reason the refusal exists).
 */

import assert from "node:assert/strict"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"

import {
	createEmbedder,
	DEFAULT_EMBEDDING_BACKEND,
	EMBEDDING_BACKEND_ENV,
	resolveEmbeddingBackend,
	type Embedder,
} from "../embedder.js"
import { buildIndex, indexMetadataFilePath, loadIndex, loadIndexMetadata } from "../index.js"
import { AirunnerEmbedder } from "../airunner-embedder.js"
import { OllamaEmbedder } from "../ollama-embedder.js"
import { OpenRouterEmbedder } from "../embedder.js"
import { createHeadlessExecutor } from "../../tools/executor.js"

async function mkTmpWorkspace(prefix: string): Promise<string> {
	return fs.mkdtemp(path.join(os.tmpdir(), prefix))
}

/** Deterministic 8-dim vector per text (backend-agnostic fake). */
function fakeVector(text: string): number[] {
	const v = new Array<number>(8).fill(0)
	for (const ch of text) {
		v[ch.charCodeAt(0) % 8] += 1
	}
	return v
}

/** Fake embedder that reports its backend by name, for selection assertions. */
class TaggedEmbedder implements Embedder {
	constructor(
		readonly model: string,
		readonly tag: string,
	) {}
	async embedBatch(texts: string[]): Promise<{ embeddings: number[][]; promptTokens: number; totalTokens: number }> {
		return {
			embeddings: texts.map(fakeVector),
			promptTokens: texts.length,
			totalTokens: texts.length,
		}
	}
}

async function testEnvVarSwitchesEmbedder(): Promise<void> {
	// Default: openrouter.
	const env: NodeJS.ProcessEnv = {}
	assert.equal(resolveEmbeddingBackend(env), "openrouter")
	assert.equal(DEFAULT_EMBEDDING_BACKEND, "openrouter", "default must stay openrouter (opt-in Ollama/AIRunner)")

	// Env var → ollama.
	const ollamaEnv: NodeJS.ProcessEnv = { [EMBEDDING_BACKEND_ENV]: "ollama" }
	assert.equal(resolveEmbeddingBackend(ollamaEnv), "ollama")
	assert.ok(createEmbedder("ollama", {}, ollamaEnv) instanceof OllamaEmbedder, "ollama backend constructs OllamaEmbedder")

	// Env var → airunner.
	const airunnerEnv: NodeJS.ProcessEnv = { [EMBEDDING_BACKEND_ENV]: "airunner" }
	assert.equal(resolveEmbeddingBackend(airunnerEnv), "airunner")
	assert.ok(
		createEmbedder("airunner", {}, airunnerEnv) instanceof AirunnerEmbedder,
		"airunner backend constructs AirunnerEmbedder",
	)

	// Flag (explicit override) beats env.
	const flagEnv: NodeJS.ProcessEnv = { [EMBEDDING_BACKEND_ENV]: "ollama" }
	assert.equal(resolveEmbeddingBackend(flagEnv, "openrouter"), "openrouter", "--embedding-backend overrides the env var")
	assert.ok(
		createEmbedder("openrouter", {}, flagEnv) instanceof OpenRouterEmbedder,
		"openrouter backend constructs OpenRouterEmbedder even when env says ollama",
	)

	// Invalid value → clear error.
	assert.throws(() => resolveEmbeddingBackend({ [EMBEDDING_BACKEND_ENV]: "banana" }), /Invalid embedding backend/)
}

async function testBuildRecordsBackendAndReindexBackendSwitch(): Promise<void> {
	const ws = await mkTmpWorkspace("hc-be-")
	try {
		await fs.mkdir(path.join(ws, "src"), { recursive: true })
		await fs.writeFile(path.join(ws, "src", "a.ts"), "export function alpha() {\n  return 1\n}\n")

		// First build with the openrouter backend.
		const openrouter = new TaggedEmbedder("qwen/qwen3-embedding-4b", "openrouter")
		const first = await buildIndex(openrouter, ws, undefined, "openrouter")
		assert.equal(first.backend, "openrouter")
		assert.ok(first.totalChunks >= 1)

		// Every entry carries the backend that built it.
		const entries = loadIndex(ws)
		assert.ok(entries.length >= 1)
		for (const e of entries) {
			assert.equal(e.backend, "openrouter", "each entry records its backend")
		}

		// Metadata sibling records backend + model.
		const meta = loadIndexMetadata(ws)
		assert.ok(meta, "metadata file written")
		assert.equal(meta!.backend, "openrouter")
		assert.equal(meta!.model, "qwen/qwen3-embedding-4b")

		// Rebuild with the SAME backend: unchanged chunks are skipped (the
		// incremental cost-control path still works).
		const second = await buildIndex(openrouter, ws, undefined, "openrouter")
		assert.equal(second.chunksEmbedded, 0, "unchanged + same backend → no re-embed")

		// Rebuild with the OTHER backend: the stored openrouter vectors are
		// NOT reusable (different dimension space) → everything re-embeds.
		const ollama = new TaggedEmbedder("qwen3-embedding:8b", "ollama")
		const third = await buildIndex(ollama, ws, undefined, "ollama")
		assert.equal(third.backend, "ollama")
		assert.ok(third.chunksEmbedded >= 1, "backend switch must re-embed every chunk (dimensions differ)")
		const metaAfter = loadIndexMetadata(ws)
		assert.equal(metaAfter!.backend, "ollama")
		for (const e of loadIndex(ws)) {
			assert.equal(e.backend, "ollama", "entry backend updated on the switch")
		}

		// And the metadata file exists on disk.
		await fs.access(indexMetadataFilePath(ws))
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

async function testAirunnerIndexMetadataRoundTrips(): Promise<void> {
	const ws = await mkTmpWorkspace("hc-be-airunner-")
	try {
		await fs.mkdir(path.join(ws, "src"), { recursive: true })
		await fs.writeFile(path.join(ws, "src", "a.ts"), "export function alpha() {\n  return 1\n}\n")

		// Build with the airunner backend.
		const airunner = new TaggedEmbedder("intfloat/e5-large", "airunner")
		const first = await buildIndex(airunner, ws, undefined, "airunner")
		assert.equal(first.backend, "airunner")

		// Every entry records the airunner backend (regression guard for the
		// old hardcoded binary ternary that would silently map it to
		// openrouter on read).
		for (const e of loadIndex(ws)) {
			assert.equal(e.backend, "airunner", "each entry records its airunner backend")
		}

		// The metadata sibling must round-trip "airunner" — NOT be misread as
		// "openrouter" (the exact bug loadIndexMetadata used to have).
		const meta = loadIndexMetadata(ws)
		assert.ok(meta, "metadata file written")
		assert.equal(meta!.backend, "airunner", "metadata round-trips the airunner backend")
		assert.equal(meta!.model, "intfloat/e5-large")

		// Rebuild with the SAME backend: unchanged chunks are skipped.
		const second = await buildIndex(airunner, ws, undefined, "airunner")
		assert.equal(second.chunksEmbedded, 0, "unchanged + same backend → no re-embed")

		// Rebuild with a DIFFERENT backend: stored airunner vectors are NOT
		// reusable → everything re-embeds.
		const ollama = new TaggedEmbedder("qwen3-embedding:8b", "ollama")
		const third = await buildIndex(ollama, ws, undefined, "ollama")
		assert.ok(third.chunksEmbedded >= 1, "backend switch must re-embed every chunk")
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

async function testLegacyEntriesDefaultToOpenrouter(): Promise<void> {
	const ws = await mkTmpWorkspace("hc-be-legacy-")
	try {
		await fs.mkdir(path.join(ws, ".headlesscode", "codesearch"), { recursive: true })
		// A pre-Ollama index entry has no `backend` field — it must be read as
		// openrouter (the only backend that existed then).
		await fs.writeFile(
			path.join(ws, ".headlesscode", "codesearch", "index.jsonl"),
			JSON.stringify({ file: "src/a.ts", startLine: 1, endLine: 2, embedding: [1, 2, 3], hash: "abc" }) + "\n",
			"utf-8",
		)
		const entries = loadIndex(ws)
		assert.equal(entries.length, 1)
		assert.equal(entries[0].backend, "openrouter", "legacy entry defaults to openrouter")
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

async function testHandlerRefusesBackendMismatch(): Promise<void> {
	const ws = await mkTmpWorkspace("hc-be-query-")
	try {
		await fs.mkdir(path.join(ws, "src"), { recursive: true })
		await fs.writeFile(path.join(ws, "src", "a.ts"), "export function alpha() {\n  return 1\n}\n")

		// Build an ollama-backed index (via buildIndex, no network).
		const ollama = new TaggedEmbedder("qwen3-embedding:8b", "ollama")
		await buildIndex(ollama, ws, undefined, "ollama")

		// A query with HEADLESSCODE_EMBEDDING_BACKEND=openrouter against an
		// ollama-built index must be REFUSED with a clear error (the vectors
		// are different dimensions — 4096 vs 2560 — so searching would
		// silently produce garbage).
		const executor = createHeadlessExecutor(ws)
		const oldEnv = process.env[EMBEDDING_BACKEND_ENV]
		process.env[EMBEDDING_BACKEND_ENV] = "openrouter"
		try {
			const result = await executor.execute("codebase_search", { query: "alpha", path: null })
			assert.equal(result.isError, true, "backend mismatch must be an error, not a silent garbage search")
			assert.match(result.content, /index was built with backend "ollama"/)
			assert.match(result.content, /rebuild the index/, "error gives the rebuild path")
			assert.match(result.content, /--embedding-backend openrouter/, "error names the exact flag")
		} finally {
			if (oldEnv === undefined) {
				delete process.env[EMBEDDING_BACKEND_ENV]
			} else {
				process.env[EMBEDDING_BACKEND_ENV] = oldEnv
			}
		}
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

const tests: Array<[string, () => Promise<void>]> = [
	["HEADLESSCODE_EMBEDDING_BACKEND env/flag switches the embedder (default stays openrouter)", testEnvVarSwitchesEmbedder],
	["build records backend per-entry + in metadata; same-backend reindex skips, switch re-embeds", testBuildRecordsBackendAndReindexBackendSwitch],
	["airunner index metadata round-trips the airunner backend (not openrouter)", testAirunnerIndexMetadataRoundTrips],
	["legacy pre-Ollama entries default to openrouter", testLegacyEntriesDefaultToOpenrouter],
	["codebase_search refuses a backend mismatch with a rebuild instruction", testHandlerRefusesBackendMismatch],
]

async function main(): Promise<void> {
	// Redirect the central store so buildIndex/loadIndex never touch the real
	// home directory's store (and legacy-migration moves stay inside the sandbox).
	const storeTmp = await fs.mkdtemp(path.join(os.tmpdir(), "hc-be-store-"))
	process.env.HEADLESSCODE_DATA_DIR = storeTmp
	let failed = 0
	try {
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
	} finally {
		delete process.env.HEADLESSCODE_DATA_DIR
		await fs.rm(storeTmp, { recursive: true, force: true })
	}
	if (failed > 0) {
		console.error(`\n${failed} test(s) failed`)
		process.exit(1)
	}
	console.log(`\nAll ${tests.length} backend-selection tests passed`)
}

main().catch((err) => {
	console.error("Test runner crashed:", err)
	process.exit(1)
})
