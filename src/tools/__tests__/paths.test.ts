/**
 * Unit tests for the path-safety leaf (src/tools/paths.ts, issue #128).
 *
 * The guard (resolveWithinWorkspace / PathTraversalError / SymlinkEscapeError)
 * moves out of src/tools/executor.ts so codeintel handlers, the browser
 * handler, and the vision tool can share it without an import cycle back
 * into the executor. These tests pin the leaf directly; the executor keeps
 * re-exporting the same names for backward compatibility.
 *
 * Plain assert-based script (no test framework), run via `npm test` →
 * `tsx src/tools/__tests__/paths.test.ts`.
 */

import assert from "node:assert/strict"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"

import {
	PathTraversalError,
	resolveWithinWorkspace,
	SymlinkEscapeError,
} from "../paths.js"
import {
	PathTraversalError as ExecutorTraversalError,
	resolveWithinWorkspace as executorResolve,
} from "../executor.js"

async function mkWorkspace(prefix: string): Promise<string> {
	return fs.mkdtemp(path.join(os.tmpdir(), prefix))
}

async function testInsidePathResolves(): Promise<void> {
	const ws = await mkWorkspace("hc-paths-")
	const got = resolveWithinWorkspace(ws, "sub/dir/file.txt")
	assert.equal(got, path.resolve(ws, "sub/dir/file.txt"))
}

async function testDotPathResolvesToRoot(): Promise<void> {
	const ws = await mkWorkspace("hc-paths-")
	assert.equal(resolveWithinWorkspace(ws, "."), path.resolve(ws))
}

async function testTraversalRefused(): Promise<void> {
	const ws = await mkWorkspace("hc-paths-")
	assert.throws(() => resolveWithinWorkspace(ws, "../outside.txt"), PathTraversalError)
	assert.throws(() => resolveWithinWorkspace(ws, "sub/../../outside.txt"), PathTraversalError)
}

async function testSymlinkEscapeRefused(): Promise<void> {
	const ws = await mkWorkspace("hc-paths-")
	const outside = await mkWorkspace("hc-paths-out-")
	await fs.writeFile(path.join(outside, "secret.txt"), "top secret\n", "utf-8")
	await fs.symlink(outside, path.join(ws, "link"))
	assert.throws(() => resolveWithinWorkspace(ws, "link/secret.txt"), SymlinkEscapeError)
}

async function testSymlinkEscapeIsATraversalError(): Promise<void> {
	const ws = await mkWorkspace("hc-paths-")
	const outside = await mkWorkspace("hc-paths-out-")
	await fs.symlink(outside, path.join(ws, "link2"))
	try {
		resolveWithinWorkspace(ws, "link2/x.txt")
		assert.fail("expected a SymlinkEscapeError")
	} catch (error) {
		assert.ok(error instanceof PathTraversalError, "a symlink escape stays catchable as PathTraversalError")
		assert.equal((error as Error).name, "SymlinkEscapeError")
	}
}

async function testExecutorReexportsTheSameGuard(): Promise<void> {
	assert.equal(ExecutorTraversalError, PathTraversalError)
	const ws = await mkWorkspace("hc-paths-")
	assert.equal(executorResolve(ws, "a.txt"), resolveWithinWorkspace(ws, "a.txt"))
	assert.throws(() => executorResolve(ws, "../escape.txt"), PathTraversalError)
}

async function main(): Promise<void> {
	const tests: Array<[string, () => Promise<void>]> = [
		["inside path resolves", testInsidePathResolves],
		["dot path resolves to root", testDotPathResolvesToRoot],
		["traversal refused", testTraversalRefused],
		["symlink escape refused", testSymlinkEscapeRefused],
		["symlink escape is a traversal error", testSymlinkEscapeIsATraversalError],
		["executor re-exports the same guard", testExecutorReexportsTheSameGuard],
	]

	let failed = 0
	for (const [name, fn] of tests) {
		try {
			await fn()
			console.log(`  ok   ${name}`)
		} catch (error) {
			failed++
			console.error(`  FAIL ${name}`)
			console.error(error instanceof Error ? (error.stack ?? error.message) : String(error))
		}
	}
	if (failed > 0) {
		console.error(`\n${failed} test(s) failed`)
		process.exit(1)
	}
	console.log(`\nAll ${tests.length} paths tests passed`)
}

main().catch((error) => {
	console.error("Test runner crashed:", error)
	process.exit(1)
})
