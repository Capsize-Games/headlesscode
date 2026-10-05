/**
 * Unit tests for the `call_hierarchy` code-intelligence tool
 * (src/codeintel/call-hierarchy.ts).
 *
 * Plain assert-based script (no test framework), run via `npm test` →
 * `tsx src/codeintel/__tests__/call-hierarchy.test.ts`.
 *
 * Calls callHierarchyHandler directly with a fake ToolContext (executor
 * wiring lands later). Covers: a direct caller, a direct callee,
 * direction=both, max_depth pruning, and tolerance of an any-typed call.
 */

import assert from "node:assert/strict"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"

import type { ToolContext } from "../../engine/types.js"
import { resetCodeIntelCaches } from "../program.js"
import { callHierarchyHandler } from "../call-hierarchy.js"

// Line numbers below are 1-based and VERIFIED against the fixture text:
// leaf=1, mid=5 (calls leaf on 6 and 7), top=10 (calls mid on 11),
// loose=14, shaky=16 (any-typed call on 17).
const FIXTURE_MAIN = `export function leaf(): number {
	return 1
}

export function mid(): number {
	const a = leaf()
	return a + leaf()
}

export function top(): number {
	return mid()
}

export const loose: any = 42

export function shaky(): unknown {
	return loose.whatever(1)
}
`

function ctxFor(ws: string): ToolContext {
	return { workspaceRoot: ws } as unknown as ToolContext
}

async function mkFixtureWorkspace(): Promise<string> {
	const ws = await fs.mkdtemp(path.join(os.tmpdir(), "hc-ci-ch-"))
	await fs.mkdir(path.join(ws, "src"), { recursive: true })
	await fs.writeFile(path.join(ws, "src", "main.ts"), FIXTURE_MAIN)
	resetCodeIntelCaches()
	return ws
}

async function testDirectCallerFound(): Promise<void> {
	const ws = await mkFixtureWorkspace()
	try {
		const ctx = ctxFor(ws)
		const result = callHierarchyHandler(
			{ path: "src/main.ts", line: 5, symbol: "mid", direction: "callers" },
			ctx,
		)
		assert.equal(result.isError, false)
		assert.match(result.content, /Call hierarchy for mid \(src\/main\.ts:5\):/)
		assert.match(result.content, /src\/main\.ts:11 top -> src\/main\.ts:5 mid/)
		const msg = "callers direction omits the callees side"
		assert.doesNotMatch(result.content, /Callees:/, msg)
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

async function testCallerViaCallSite(): Promise<void> {
	const ws = await mkFixtureWorkspace()
	try {
		const ctx = ctxFor(ws)
		const result = callHierarchyHandler(
			{ path: "src/main.ts", line: 11, symbol: "mid", direction: "callers" },
			ctx,
		)
		assert.equal(result.isError, false)
		assert.match(result.content, /src\/main\.ts:11 top -> src\/main\.ts:5 mid/)
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

async function testDirectCalleesFound(): Promise<void> {
	const ws = await mkFixtureWorkspace()
	try {
		const ctx = ctxFor(ws)
		const result = callHierarchyHandler(
			{ path: "src/main.ts", line: 5, symbol: "mid", direction: "callees" },
			ctx,
		)
		assert.equal(result.isError, false)
		assert.match(result.content, /src\/main\.ts:6 mid -> src\/main\.ts:1 leaf/)
		assert.match(result.content, /src\/main\.ts:7 mid -> src\/main\.ts:1 leaf/)
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

async function testBothDirectionsDefault(): Promise<void> {
	const ws = await mkFixtureWorkspace()
	try {
		const ctx = ctxFor(ws)
		const args = { path: "src/main.ts", line: 5, symbol: "mid" }
		const result = callHierarchyHandler(args, ctx)
		assert.equal(result.isError, false)
		assert.match(result.content, /Callers:/)
		assert.match(result.content, /Callees:/)
		assert.match(result.content, /src\/main\.ts:11 top -> src\/main\.ts:5 mid/)
		assert.match(result.content, /src\/main\.ts:6 mid -> src\/main\.ts:1 leaf/)
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

async function testMaxDepthPrunesDeeperEdges(): Promise<void> {
	const ws = await mkFixtureWorkspace()
	try {
		const ctx = ctxFor(ws)
		const deep = callHierarchyHandler(
			{ path: "src/main.ts", line: 1, symbol: "leaf", direction: "callers" },
			ctx,
		)
		const midLeaf = /mid -> src\/main\.ts:1 leaf/
		assert.match(deep.content, midLeaf, "default reaches mid->leaf")
		const topMid = /top -> src\/main\.ts:5 mid/
		assert.match(deep.content, topMid, "default reaches top->mid")
		const shallow = callHierarchyHandler(
			{
				path: "src/main.ts",
				line: 1,
				symbol: "leaf",
				direction: "callers",
				max_depth: 1,
			},
			ctx,
		)
		assert.match(shallow.content, midLeaf, "depth 1 keeps direct callers")
		const msg = "depth 1 excludes depth-2 edges"
		assert.doesNotMatch(shallow.content, /top -> /, msg)
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

async function testAnyTypedCallTolerated(): Promise<void> {
	const ws = await mkFixtureWorkspace()
	try {
		const ctx = ctxFor(ws)
		const result = callHierarchyHandler(
			{ path: "src/main.ts", line: 16, symbol: "shaky", direction: "callees" },
			ctx,
		)
		assert.equal(result.isError, false, "any-typed call sites must not crash")
		const none = /Callees:\n\(none\)/
		const msg = "unresolved call is skipped, not guessed"
		assert.match(result.content, none, msg)
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

async function testNonTsFile(): Promise<void> {
	const ws = await mkFixtureWorkspace()
	try {
		await fs.writeFile(path.join(ws, "notes.md"), "# hi\n")
		const ctx = ctxFor(ws)
		assert.throws(
			() => callHierarchyHandler({ path: "notes.md", line: 1 }, ctx),
			/not a supported file type/,
			"explicit not-supported result, never a crash",
		)
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

async function main(): Promise<void> {
	const tests: Array<[string, () => Promise<void>]> = [
		["direct caller found from a definition", testDirectCallerFound],
		["caller lookup works from a call site", testCallerViaCallSite],
		["direct callees found", testDirectCalleesFound],
		["default direction returns both sides", testBothDirectionsDefault],
		["max_depth=1 excludes depth-2 edges", testMaxDepthPrunesDeeperEdges],
		["any-typed call is tolerated", testAnyTypedCallTolerated],
		["non-TS file returns the not-supported result", testNonTsFile],
	]

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
	console.log(`\nAll ${tests.length} call_hierarchy tests passed`)
}

main().catch((err) => {
	console.error("Test runner crashed:", err)
	process.exit(1)
})
