/**
 * Unit tests for the `batch` meta-tool (src/tools/batch.ts).
 *
 * Plain assert-based script (no test framework), run via `npm test` →
 * `tsx src/tools/__tests__/batch.test.ts`.
 *
 * Exercises batch end to end through the real headless executor: fan-out
 * reads, edit/read order semantics, per-section refusals, batch-level
 * errors, stop_on_error skipping, and output truncation.
 */

import assert from "node:assert/strict"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"

import { createHeadlessExecutor } from "../executor.js"
import type { ToolExecutor } from "../executor.js"

async function mkFixtureWorkspace(): Promise<string> {
	const ws = await fs.mkdtemp(path.join(os.tmpdir(), "hc-batch-"))
	await fs.writeFile(path.join(ws, "a.txt"), "alpha\n")
	await fs.writeFile(path.join(ws, "b.txt"), "beta\n")
	await fs.writeFile(path.join(ws, "target.txt"), "v1\n")
	await fs.writeFile(path.join(ws, "big.txt"), "x".repeat(25000))
	return ws
}

function callsOf(...entries: Array<[string, Record<string, unknown>]>): {
	calls: Array<{ tool: string; args: Record<string, unknown> }>
} {
	return {
		calls: entries.map(([tool, args]) => ({ tool, args })),
	}
}

async function testAllReadsBatch(): Promise<void> {
	const ws = await mkFixtureWorkspace()
	try {
		const executor = createHeadlessExecutor(ws)
		const result = await executor.execute(
			"batch",
			callsOf(
				["read_file", { path: "a.txt" }],
				["read_file", { path: "b.txt" }],
				["list_files", { path: "." }],
			),
		)
		assert.equal(result.isError, false)
		assert.match(result.content, /\[1\/3\] read_file — ok/)
		assert.match(result.content, /\[2\/3\] read_file — ok/)
		assert.match(result.content, /\[3\/3\] list_files — ok/)
		assert.match(result.content, /alpha/)
		assert.match(result.content, /beta/)
		assert.match(
			result.content,
			/3 sub-calls: 3 ok, 0 error\(s\)/,
		)
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

async function testEditThenReadSeesNewContent(): Promise<void> {
	const ws = await mkFixtureWorkspace()
	try {
		const executor = createHeadlessExecutor(ws)
		const result = await executor.execute(
			"batch",
			callsOf(
				["write_to_file", { path: "target.txt", content: "v2\n" }],
				["read_file", { path: "target.txt" }],
			),
		)
		assert.equal(result.isError, false)
		assert.match(result.content, /2 sub-calls: 2 ok, 0 error\(s\)/)
		const readSection = result.content.split("[2/2]")[1] ?? ""
		assert.match(readSection, /v2/, "read runs after the edit")
		assert.doesNotMatch(readSection, /v1/, "no stale pre-edit content")
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

async function testRefusedToolsArePerSectionErrors(): Promise<void> {
	const ws = await mkFixtureWorkspace()
	try {
		const executor = createHeadlessExecutor(ws)
		const result = await executor.execute(
			"batch",
			callsOf(
				["attempt_completion", { result: "done" }],
				["new_task", { task: "x" }],
				["batch", { calls: [] }],
				["read_file", { path: "a.txt" }],
			),
		)
		assert.equal(result.isError, false, "partial success is not an error")
		assert.match(result.content, /\[1\/4\] attempt_completion — error/)
		assert.match(result.content, /cannot run inside batch/)
		assert.match(result.content, /\[4\/4\] read_file — ok/)
		assert.match(result.content, /alpha/, "sibling still runs")
		assert.match(
			result.content,
			/4 sub-calls: 1 ok, 3 error\(s\)/,
		)
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

async function testUnknownToolIsAPerSectionError(): Promise<void> {
	const ws = await mkFixtureWorkspace()
	try {
		const executor = createHeadlessExecutor(ws)
		const result = await executor.execute(
			"batch",
			callsOf(["no_such_tool", {}]),
		)
		assert.equal(result.isError, true, "zero successes is an error")
		assert.match(result.content, /not available on this executor/)
		assert.match(
			result.content,
			/1 sub-calls: 0 ok, 1 error\(s\)/,
		)
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

async function testOverCapIsABatchLevelError(): Promise<void> {
	const ws = await mkFixtureWorkspace()
	try {
		const executor = createHeadlessExecutor(ws)
		const many = Array.from({ length: 11 }, () =>
			({ tool: "read_file", args: { path: "a.txt" } }),
		)
		const result = await executor.execute("batch", { calls: many })
		assert.equal(result.isError, true)
		assert.match(result.content, /at most 10 sub-calls/)
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

async function testEmptyCallsIsABatchLevelError(): Promise<void> {
	const ws = await mkFixtureWorkspace()
	try {
		const executor = createHeadlessExecutor(ws)
		const result = await executor.execute("batch", { calls: [] })
		assert.equal(result.isError, true)
		assert.match(result.content, /non-empty array/)
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

async function testStopOnErrorSkipsSerialRemainder(): Promise<void> {
	const ws = await mkFixtureWorkspace()
	try {
		const executor: ToolExecutor = createHeadlessExecutor(ws)
		const result = await executor.execute("batch", {
			...callsOf(
				["read_file", { path: "missing.txt" }],
				["write_to_file", { path: "skipped.txt", content: "x" }],
			),
			stop_on_error: true,
		})
		assert.equal(result.isError, true, "zero successes is an error")
		assert.match(result.content, /\[1\/2\] read_file — error/)
		assert.match(result.content, /\[2\/2\] write_to_file — skipped/)
		assert.match(result.content, /1 skipped/)
		assert.equal(
			await exists(path.join(ws, "skipped.txt")),
			false,
			"skipped write never runs",
		)
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

async function testSectionTruncation(): Promise<void> {
	const ws = await mkFixtureWorkspace()
	try {
		const executor = createHeadlessExecutor(ws)
		const result = await executor.execute(
			"batch",
			callsOf(["read_file", { path: "big.txt" }]),
		)
		assert.equal(result.isError, false)
		assert.match(result.content, /truncated to 20000/)
		assert.match(
			result.content,
			/1 sub-calls: 1 ok, 0 error\(s\)/,
		)
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

async function exists(p: string): Promise<boolean> {
	try {
		await fs.stat(p)
		return true
	} catch {
		return false
	}
}

async function main(): Promise<void> {
	const tests: Array<[string, () => Promise<void>]> = [
		["all-reads batch returns all sections", testAllReadsBatch],
		["edit-then-read sees new content", testEditThenReadSeesNewContent],
		[
			"refused tools are per-section errors",
			testRefusedToolsArePerSectionErrors,
		],
		["unknown tool is a per-section error", testUnknownToolIsAPerSectionError],
		["11 sub-calls is a batch-level error", testOverCapIsABatchLevelError],
		["empty calls is a batch-level error", testEmptyCallsIsABatchLevelError],
		[
			"stop_on_error skips the serial remainder",
			testStopOnErrorSkipsSerialRemainder,
		],
		["oversized section is truncated", testSectionTruncation],
	]

	let failed = 0
	for (const [name, fn] of tests) {
		try {
			await fn()
			console.log(`  ok   ${name}`)
		} catch (err) {
			failed++
			console.error(`  FAIL ${name}`)
			const detail = err instanceof Error
				? (err.stack ?? err.message)
				: String(err)
			console.error(detail)
		}
	}
	if (failed > 0) {
		console.error(`\n${failed} test(s) failed`)
		process.exit(1)
	}
	console.log(`\nAll ${tests.length} batch tests passed`)
}

main().catch((err) => {
	console.error("Test runner crashed:", err)
	process.exit(1)
})
