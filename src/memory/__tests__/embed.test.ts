/**
 * Unit tests for src/memory/embed.ts — the deterministic local embedder.
 * Plain assert-based (no framework), matching the repo test style.
 * Run via `npm test` → `tsx src/memory/__tests__/embed.test.ts`.
 */

import assert from "node:assert/strict"

import { cosine, createLocalEmbedder, similarity } from "../embed.js"

// ─── Tests ───────────────────────────────────────────────────────────────────

function testDeterminismSameInputSameVector(): void {
	const embedder = createLocalEmbedder(64)
	const v1 = embedder.embed("the quick brown fox jumps over the lazy dog")
	const v2 = embedder.embed("the quick brown fox jumps over the lazy dog")
	assert.deepEqual(v1, v2, "same input must yield the identical vector")

	// Across independent embedder instances too (no hidden state).
	const other = createLocalEmbedder(64)
	assert.deepEqual(v1, other.embed("the quick brown fox jumps over the lazy dog"))
}

function testL2Normalization(): void {
	const embedder = createLocalEmbedder(64)
	const v = embedder.embed("run the test suite and check coverage")
	const norm = Math.sqrt(v.reduce((sum, x) => sum + x * x, 0))
	assert.ok(Math.abs(norm - 1) < 1e-6, `expected L2 norm ≈ 1, got ${norm}`)
}

function testCosineIdenticalAndOrdering(): void {
	const embedder = createLocalEmbedder(256)
	// Identical texts → cosine ≈ 1.
	const same = similarity(embedder, "run the test suite before committing", "run the test suite before committing")
	assert.ok(same > 0.99, `identical texts should score ≈ 1, got ${same}`)

	// Related (shared words/bigrams) beats unrelated.
	const related = similarity(embedder, "run the test suite", "run tests in CI")
	const unrelated = similarity(embedder, "run the test suite", "deploy the database to production")
	assert.ok(
		related > unrelated,
		`related (${related}) should score above unrelated (${unrelated})`,
	)
}

function testCosineZeroVectors(): void {
	assert.equal(cosine([], []), 0)
	assert.equal(cosine([0, 0, 0], [1, 2, 3]), 0)
}

function testCosineDifferentLengths(): void {
	// Missing entries treated as 0; sharing one axis yields cos > 0.
	const a = [1, 0]
	const b = [1, 2, 3]
	assert.ok(cosine(a, b) > 0)
}

function testDimsValidation(): void {
	assert.throws(() => createLocalEmbedder(0), /positive integer/)
	assert.throws(() => createLocalEmbedder(-5), /positive integer/)
	assert.throws(() => createLocalEmbedder(3.5), /positive integer/)
}

// ─── Runner ──────────────────────────────────────────────────────────────────

const tests: Array<[string, () => void]> = [
	["determinism: same input → same vector (incl. across instances)", testDeterminismSameInputSameVector],
	["L2 normalization ≈ 1", testL2Normalization],
	["cosine: identical ≈ 1, related > unrelated", testCosineIdenticalAndOrdering],
	["cosine: zero vectors → 0", testCosineZeroVectors],
	["cosine: different lengths handled", testCosineDifferentLengths],
	["createLocalEmbedder validates dims", testDimsValidation],
]

function main(): void {
	let failed = 0
	for (const [name, fn] of tests) {
		try {
			fn()
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
	console.log(`\nAll ${tests.length} embed tests passed`)
}

main()
