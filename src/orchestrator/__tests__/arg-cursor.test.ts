/**
 * Unit tests for src/orchestrator/arg-cursor.ts — the shared argv cursor
 * that deduplicates the eq/flag/inlineValue/next() preamble copy-pasted
 * across the seven orchestrator subcommand parsers (issue #127).
 *
 * Plain assert-based (no framework), run via `npm test`.
 */

import assert from "node:assert/strict"

import { createArgCursor } from "../arg-cursor.js"

function cursor(argv: string[], i: number): {
	flag: string
	inline: string | undefined
	value: string | undefined
} {
	let index = i
	const c = createArgCursor(argv, i, () => {
		index++
	})
	const value = c.next()
	return { flag: c.flag, inline: c.inlineValue, value }
}

function testSpacedValueConsumesNext(): void {
	const seen = cursor(["--repo", "mydir"], 0)
	assert.equal(seen.flag, "--repo")
	assert.equal(seen.inline, undefined)
	assert.equal(seen.value, "mydir")
}

function testInlineValueBeatsNext(): void {
	const seen = cursor(["--repo=mydir", "other"], 0)
	assert.equal(seen.flag, "--repo")
	assert.equal(seen.inline, "mydir")
	assert.equal(seen.value, "mydir")
}

function testNextRejectsFlagLikeValue(): void {
	// Matches the per-parser next(): a following "--..." is not a value.
	const seen = cursor(["--repo", "--json"], 0)
	assert.equal(seen.value, undefined)
}

function testNextAtEndIsUndefined(): void {
	const seen = cursor(["--repo"], 0)
	assert.equal(seen.value, undefined)
}

function testNextAdvancesIndex(): void {
	let index = 0
	const argv = ["--repo", "mydir", "--json"]
	const c = createArgCursor(argv, 0, () => {
		index++
	})
	assert.equal(c.next(), "mydir")
	assert.equal(index, 1, "consuming next advances the parser index")
	const c2 = createArgCursor(argv, index, () => {
		index++
	})
	// Index now points at the consumed value; a fresh cursor there sees it.
	assert.equal(c2.arg, "mydir")
}

function testNextRawAcceptsDashedValue(): void {
	// --deploy-args legitimately starts with "--"; nextRaw bypasses the guard.
	let index = 3
	const argv = ["x", "y", "z", "--deploy-args", "--local"]
	const c = createArgCursor(argv, 3, () => {
		index++
	})
	assert.equal(c.nextRaw(), "--local")
	assert.equal(index, 4)
}

const tests: Array<[string, () => void | Promise<void>]> = [
	["spaced value is consumed as next", testSpacedValueConsumesNext],
	["inline --flag=value beats next", testInlineValueBeatsNext],
	["flag-like next is not a value", testNextRejectsFlagLikeValue],
	["missing next is undefined", testNextAtEndIsUndefined],
	["consuming next advances the parser index", testNextAdvancesIndex],
	["nextRaw accepts dashed values", testNextRawAcceptsDashedValue],
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
	console.log(`\nAll ${tests.length} arg-cursor tests passed`)
}

main().catch((err) => {
	console.error("Test runner crashed:", err)
	process.exit(1)
})
