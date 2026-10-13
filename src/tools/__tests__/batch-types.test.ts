/**
 * Unit tests for the batch leaf types (src/tools/batch-types.ts, issue #128).
 *
 * BatchSection/BatchExecutor move out of src/tools/batch.ts so the formatter
 * (batch-format.ts) and the executor can share them without a cycle:
 * batch-format no longer imports batch, and batch no longer imports the
 * executor — batchHandler takes the minimal BatchExecutor interface instead
 * of the concrete ToolExecutor.
 *
 * Plain assert-based script (no test framework), run via `npm test` →
 * `tsx src/tools/__tests__/batch-types.test.ts`.
 */

import assert from "node:assert/strict"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"

import { batchHandler } from "../batch.js"
import type { BatchExecutor, BatchSection } from "../batch-types.js"
import { assembleSections, formatSummary } from "../batch-format.js"
import { createHeadlessExecutor } from "../executor.js"
import type { ToolContext } from "../../engine/types.js"

interface ExecResult {
	content: string
	isError: boolean
}

function fakeExecutor(map: Record<string, ExecResult>): BatchExecutor {
	return {
		has: (name: string): boolean => name in map,
		execute: async (name: string): Promise<ExecResult> =>
			map[name] ?? { content: `[Error] Unknown tool: ${name}`, isError: true },
	}
}

function batchContext(workspaceRoot: string): ToolContext {
	return { workspaceRoot } as unknown as ToolContext
}

async function testBatchHandlerRunsAgainstTheInterface(): Promise<void> {
	const tools = { read_file: { content: "hello", isError: false } }
	const executor = fakeExecutor(tools)
	const result = await batchHandler(
		executor,
		{ calls: [{ tool: "read_file", args: { path: "a.txt" } }] },
		batchContext(os.tmpdir()),
	)
	assert.equal(result.isError, false)
	assert.match(result.content, /\[1\/1\] read_file — ok/)
	assert.match(result.content, /1 sub-calls: 1 ok, 0 error\(s\)/)
}

async function testUnknownToolIsASectionError(): Promise<void> {
	const executor = fakeExecutor({})
	const result = await batchHandler(
		executor,
		{ calls: [{ tool: "nope", args: {} }] },
		batchContext(os.tmpdir()),
	)
	assert.equal(result.isError, true)
	assert.match(result.content, /not available on this executor/)
}

async function testLeafSectionsFlowThroughTheFormatter(): Promise<void> {
	const sections: BatchSection[] = [
		{ tool: "read_file", ok: true, skipped: false, content: "alpha" },
		{ tool: "nope", ok: false, skipped: false, content: "[Error] missing" },
	]
	const body = assembleSections(sections.length, sections)
	assert.match(body, /\[1\/2\] read_file — ok/)
	assert.match(body, /\[2\/2\] nope — error/)
	const summary = formatSummary(sections.length, sections)
	assert.equal(summary, "2 sub-calls: 1 ok, 1 error(s)")
}

async function testToolExecutorSatisfiesTheInterface(): Promise<void> {
	const ws = await fs.mkdtemp(path.join(os.tmpdir(), "hc-batch-types-"))
	const executor = createHeadlessExecutor(ws)
	const asInterface: BatchExecutor = executor
	assert.equal(asInterface.has("read_file"), true)
	assert.equal(asInterface.has("no-such-tool"), false)
}

async function runOne(name: string, fn: () => Promise<void>): Promise<boolean> {
	try {
		await fn()
		console.log(`  ok   ${name}`)
		return true
	} catch (error) {
		console.error(`  FAIL ${name}`)
		if (error instanceof Error) console.error(error.stack ?? error)
		else console.error(String(error))
		return false
	}
}

async function main(): Promise<void> {
	const tests: Array<[string, () => Promise<void>]> = [
		["runs against the interface", testBatchHandlerRunsAgainstTheInterface],
		["unknown tool is a section error", testUnknownToolIsASectionError],
		["sections flow through", testLeafSectionsFlowThroughTheFormatter],
		["executor satisfies interface", testToolExecutorSatisfiesTheInterface],
	]
	let failed = 0
	for (const [name, fn] of tests) {
		if (!(await runOne(name, fn))) failed++
	}
	if (failed > 0) {
		console.error(`\n${failed} test(s) failed`)
		process.exit(1)
	}
	console.log(`\nAll ${tests.length} batch-types tests passed`)
}

main().catch((error) => {
	console.error("Test runner crashed:", error)
	process.exit(1)
})
