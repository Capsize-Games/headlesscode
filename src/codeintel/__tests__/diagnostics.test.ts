/**
 * Unit tests for the `get_diagnostics` code-intelligence tool
 * (src/codeintel/diagnostics.ts).
 *
 * Plain assert-based script (no test framework), run via `npx tsx
 * src/codeintel/__tests__/diagnostics.test.ts`.
 *
 * Calls getDiagnosticsHandler directly with a fake ToolContext
 * ({ workspaceRoot }); executor wiring lands later.
 */

import assert from "node:assert/strict"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"

import type { ToolContext } from "../../engine/types.js"
import { resetCodeIntelCaches } from "../program.js"
import { getDiagnosticsHandler } from "../diagnostics.js"

// Line numbers below are 1-based and VERIFIED against the fixture text:
// bad.ts line 1 holds the type error (TS2322); the unterminated
// line 2 yields TS1109 (2:17) plus TS1005 reported at 3:1 (EOF).
const FIXTURE_BAD = `const n: number = "nope"
const broken = (
`

const FIXTURE_CLEAN = `export const ok = 1
`

const FIXTURE_TSCONFIG = JSON.stringify({
	compilerOptions: { target: "ES2022", module: "ESNext", moduleResolution: "bundler", strict: true },
	include: ["**/*.ts"],
}, null, 2)

function fakeContext(workspaceRoot: string): ToolContext {
	return { workspaceRoot } as ToolContext
}

async function mkFixtureWorkspace(): Promise<string> {
	const ws = await fs.mkdtemp(path.join(os.tmpdir(), "hc-ci-diag-"))
	await fs.writeFile(path.join(ws, "tsconfig.json"), FIXTURE_TSCONFIG)
	await fs.writeFile(path.join(ws, "bad.ts"), FIXTURE_BAD)
	await fs.writeFile(path.join(ws, "clean.ts"), FIXTURE_CLEAN)
	await fs.writeFile(path.join(ws, "notes.md"), "# hi\n")
	return ws
}

async function testTypeAndSyntaxErrors(): Promise<void> {
	const ws = await mkFixtureWorkspace()
	try {
		resetCodeIntelCaches()
		const ctx = fakeContext(ws)
		const result = getDiagnosticsHandler({ path: "bad.ts" }, ctx)
		assert.equal(result.isError, false)
		assert.match(result.content, /bad\.ts:1:\d+ TS2322/)
		assert.match(result.content, /bad\.ts:2:\d+ TS1109/)
		assert.match(result.content, /bad\.ts:3:\d+ TS1005/)
		assert.match(result.content, /\d+ error\(s\) in bad\.ts/)
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

async function testCleanFile(): Promise<void> {
	const ws = await mkFixtureWorkspace()
	try {
		resetCodeIntelCaches()
		const ctx = fakeContext(ws)
		const result = getDiagnosticsHandler({ path: "clean.ts" }, ctx)
		assert.equal(result.isError, false)
		assert.match(result.content, /0 error\(s\) in clean\.ts/)
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

async function testMissingFile(): Promise<void> {
	const ws = await mkFixtureWorkspace()
	try {
		resetCodeIntelCaches()
		const ctx = fakeContext(ws)
		assert.throws(
			() => getDiagnosticsHandler({ path: "nope.ts" }, ctx),
			/cannot stat/,
		)
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

async function testNonTsFile(): Promise<void> {
	const ws = await mkFixtureWorkspace()
	try {
		resetCodeIntelCaches()
		const ctx = fakeContext(ws)
		assert.throws(
			() => getDiagnosticsHandler({ path: "notes.md" }, ctx),
			/not a supported file type/,
		)
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

async function testNewFileAndEditedExtraFileSemanticDiagnostics(): Promise<void> {
	const ws = await mkFixtureWorkspace()
	try {
		resetCodeIntelCaches()
		const ctx = fakeContext(ws)
		getDiagnosticsHandler({ path: "clean.ts" }, ctx)
		await fs.writeFile(path.join(ws, "created.ts"), 'export const created: number = "wrong"\n')
		assert.match(getDiagnosticsHandler({ path: "created.ts" }, ctx).content, /created\.ts:1:\d+ TS2322/,
			"a file created after cache load still receives semantic checks")
		await fs.writeFile(path.join(ws, "created.ts"), 'export const created: number = 42\n')
		assert.match(getDiagnosticsHandler({ path: "created.ts" }, ctx).content, /0 error\(s\) in created\.ts/,
			"editing the extra file updates the checked contents")
	} finally { await fs.rm(ws, { recursive: true, force: true }) }
}

/** Log one test failure with its stack (or string form). */
function reportFailure(name: string, error: unknown): void {
	const detail = error instanceof Error
		? (error.stack ?? error.message)
		: String(error)
	console.error(`  FAIL ${name}`)
	console.error(detail)
}

async function runTests(
	tests: Array<[string, () => Promise<void>]>,
): Promise<void> {
	let failed = 0
	for (const [name, fn] of tests) {
		try {
			await fn()
			console.log(`  ok   ${name}`)
		} catch (error) {
			failed += 1
			reportFailure(name, error)
		}
	}
	if (failed > 0) {
		console.error(`\n${failed} test(s) failed`)
		process.exit(1)
	}
	console.log(`\nAll ${tests.length} get_diagnostics tests passed`)
}

async function main(): Promise<void> {
	const tests: Array<[string, () => Promise<void>]> = [
		["type + syntax errors report codes and lines", testTypeAndSyntaxErrors],
		["clean file reports 0 errors", testCleanFile],
		["new and edited files receive semantic diagnostics", testNewFileAndEditedExtraFileSemanticDiagnostics],
		["missing file throws cannot-stat", testMissingFile],
		["non-TS file throws not-supported", testNonTsFile],
	]
	await runTests(tests)
}

main().catch((error: unknown) => {
	console.error("Test runner crashed:", error)
	process.exit(1)
})
