/**
 * Direct tests for `summarizeToolArg` (src/engine/loop.ts) — the one-line
 * diagnostic summary used for BOTH the harness.log `[loop] tool result:`
 * lines and the EventFeed `tool_call` event's `args` field (loop.ts feeds
 * the same helper into both paths). read_file summaries carry the reading
 * mode + effective range so real sessions' read patterns (targeted
 * indentation reads vs. broad default slice reads) are observable.
 *
 * Plain assert-based script (no test framework), run via `npm test` →
 * `tsx src/engine/__tests__/summarize-tool-arg.test.ts`.
 */

import assert from "node:assert/strict"

import { readLimitFromEnv } from "../../tools/executor.js"
import { summarizeToolArg } from "../loop.js"

function testSliceModeWithExplicitOffsetLimit(): void {
	assert.equal(
		summarizeToolArg("read_file", { path: "src/app.ts", offset: 10, limit: 50 }),
		"src/app.ts [slice offset=10 limit=50]",
	)
}

function testSliceModeWithNoArgsShowsDefaults(): void {
	// No mode/offset/limit → slice mode with the harness's effective default
	// (offset 1, readLimitFromEnv() — 600 unless HEADLESSCODE_READ_LIMIT
	// overrides), so a default broad read is distinguishable from a targeted
	// one.
	assert.equal(
		summarizeToolArg("read_file", { path: "src/app.ts" }),
		`src/app.ts [slice offset=1 limit=${readLimitFromEnv()}]`,
	)
}

function testSliceModeWithPartialRangeArgs(): void {
	assert.equal(summarizeToolArg("read_file", { path: "src/app.ts", offset: 42 }), "src/app.ts [slice offset=42]")
	assert.equal(summarizeToolArg("read_file", { path: "src/app.ts", limit: 500 }), "src/app.ts [slice limit=500]")
}

function testSliceModeExplicit(): void {
	assert.equal(
		summarizeToolArg("read_file", { path: "src/app.ts", mode: "slice", offset: 5, limit: 25 }),
		"src/app.ts [slice offset=5 limit=25]",
	)
}

function testIndentationModeWithAnchorLine(): void {
	assert.equal(
		summarizeToolArg("read_file", {
			path: "src/engine/loop.ts",
			mode: "indentation",
			indentation: { anchor_line: 245, max_levels: 0 },
		}),
		"src/engine/loop.ts [indentation anchor=245]",
	)
}

function testIndentationModeWithoutAnchorLine(): void {
	// Indentation mode with no anchor_line (only header content returned by
	// the tool) still identifies the mode, just without an anchor.
	assert.equal(
		summarizeToolArg("read_file", { path: "src/app.ts", mode: "indentation", indentation: {} }),
		"src/app.ts [indentation]",
	)
}

function testOtherToolsUnchanged(): void {
	// Non-read_file tools keep their old one-line summary shape.
	assert.equal(summarizeToolArg("list_files", { path: "src" }), "src")
	assert.equal(summarizeToolArg("write_to_file", { path: "a.txt", content: "x" }), "a.txt")
	assert.equal(summarizeToolArg("apply_diff", { path: "a.txt", diff: "x" }), "a.txt")
	assert.equal(summarizeToolArg("execute_command", { command: "npm test" }), "npm test")
	assert.equal(summarizeToolArg("attempt_completion", { result: "done" }), undefined)
	assert.equal(summarizeToolArg("read_file", {}), undefined, "read_file without a path → undefined")
}

// ─── Runner ──────────────────────────────────────────────────────────────────

const tests: Array<[string, () => void]> = [
	["read_file slice mode with explicit offset/limit", testSliceModeWithExplicitOffsetLimit],
	["read_file slice mode with no args shows defaults", testSliceModeWithNoArgsShowsDefaults],
	["read_file slice mode with partial offset/limit", testSliceModeWithPartialRangeArgs],
	["read_file explicit mode: slice", testSliceModeExplicit],
	["read_file indentation mode with anchor_line", testIndentationModeWithAnchorLine],
	["read_file indentation mode without anchor_line", testIndentationModeWithoutAnchorLine],
	["other tools' summaries unchanged", testOtherToolsUnchanged],
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
	console.log(`\nAll ${tests.length} tests passed`)
}

main()
