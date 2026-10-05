/**
 * Unit tests for the `workspace_symbol` code-intelligence tool
 * (src/codeintel/workspace-symbol.ts).
 *
 * Plain assert-based script (no test framework), run via `npm test` →
 * `tsx src/codeintel/__tests__/workspace-symbol.test.ts`.
 *
 * Calls the handler directly with a fake ToolContext (executor wiring
 * lands later). Covers: a query matching a function and a class across
 * two files, case-insensitive matching, the no-matches message, limit
 * truncation, and the blank-query error.
 */

import assert from "node:assert/strict"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"

import type { ToolContext } from "../../engine/types.js"
import { resetCodeIntelCaches } from "../program.js"
import { workspaceSymbolHandler } from "../workspace-symbol.js"

// Line numbers below are 1-based and VERIFIED against the fixture text:
// alpha.ts: fetchUser=1, UserCache=5. beta.ts: UserProfile=1, userCount=5.
// The UserCache constructor (lines 6-8) is unnamed, so it never matches.
const FIXTURE_ALPHA = `export function fetchUser(id: string): string {
	return id
}

export class UserCache {
	constructor(id: string) {
		void id
	}
	get(id: string): string {
		return id
	}
}
`

const FIXTURE_BETA = `export interface UserProfile {
	name: string
}

export const userCount = 0
`

function makeCtx(workspaceRoot: string): ToolContext {
	return {
		workspaceRoot,
		permissions: {
			allowedCommands: [],
			deniedCommands: [],
			protectedFiles: [],
			allowProtectedWrites: false,
		},
	}
}

async function mkFixtureWorkspace(): Promise<string> {
	const ws = await fs.mkdtemp(path.join(os.tmpdir(), "hc-ci-wssym-"))
	await fs.mkdir(path.join(ws, "src"), { recursive: true })
	await fs.writeFile(path.join(ws, "src", "alpha.ts"), FIXTURE_ALPHA)
	await fs.writeFile(path.join(ws, "src", "beta.ts"), FIXTURE_BETA)
	return ws
}

function testFunctionAndClassAcrossTwoFiles(ctx: ToolContext): void {
	const result = workspaceSymbolHandler({ query: "user" }, ctx)
	assert.equal(result.isError, false)
	const lines = result.content.split("\n")
	assert.deepEqual(lines, [
		"src/alpha.ts:1 function fetchUser",
		"src/alpha.ts:5 class UserCache",
		"src/beta.ts:1 interface UserProfile",
		"src/beta.ts:5 const userCount",
	])
	assert.doesNotMatch(result.content, /constructor/)
}

function testCaseInsensitiveMatch(ctx: ToolContext): void {
	const result = workspaceSymbolHandler({ query: "FETCHUSER" }, ctx)
	assert.equal(result.isError, false)
	assert.match(result.content, /src\/alpha\.ts:1 function fetchUser/)
}

function testNoMatchesIsNotAnError(ctx: ToolContext): void {
	const result = workspaceSymbolHandler({ query: "zzzznothing" }, ctx)
	assert.equal(result.isError, false, "no matches is a message, not an error")
	assert.match(result.content, /No symbols matching "zzzznothing"/)
}

function testLimitTruncates(ctx: ToolContext): void {
	const result = workspaceSymbolHandler({ query: "user", limit: 1 }, ctx)
	assert.equal(result.isError, false)
	const lines = result.content.split("\n")
	assert.deepEqual(lines, [
		"src/alpha.ts:1 function fetchUser",
		"... truncated, 3 more",
	])
}

function testUnnamedConstructorAddsNoMatch(ctx: ToolContext): void {
	const result = workspaceSymbolHandler({ query: "cache" }, ctx)
	assert.equal(result.isError, false)
	assert.deepEqual(result.content.split("\n"), [
		"src/alpha.ts:5 class UserCache",
	])
	assert.doesNotMatch(result.content, /constructor/)
}

function testBlankQueryIsAnError(ctx: ToolContext): void {
	const result = workspaceSymbolHandler({ query: "   " }, ctx)
	assert.equal(result.isError, true)
	assert.match(result.content, /'query' must be a non-empty string/)
}

async function main(): Promise<void> {
	const ws = await mkFixtureWorkspace()
	try {
		resetCodeIntelCaches()
		const ctx = makeCtx(ws)
		const tests: Array<[string, (ctx: ToolContext) => void]> = [
			["function and class across two files", testFunctionAndClassAcrossTwoFiles],
			["query matches case-insensitively", testCaseInsensitiveMatch],
			["no matches yields a message, not an error", testNoMatchesIsNotAnError],
			["limit=1 truncates with the truncation note", testLimitTruncates],
			["unnamed constructor adds no match", testUnnamedConstructorAddsNoMatch],
			["blank query is a handler error", testBlankQueryIsAnError],
		]

		let failed = 0
		for (const [name, fn] of tests) {
			try {
				fn(ctx)
				console.log(`  ok   ${name}`)
			} catch (err) {
				failed++
				console.error(`  FAIL ${name}`)
				const stack = err instanceof Error ? err.stack ?? err.message : String(err)
				console.error(stack)
			}
		}
		if (failed > 0) {
			console.error(`\n${failed} test(s) failed`)
			process.exit(1)
		}
		console.log(`\nAll ${tests.length} workspace_symbol tests passed`)
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

main().catch((err) => {
	console.error("Test runner crashed:", err)
	process.exit(1)
})
