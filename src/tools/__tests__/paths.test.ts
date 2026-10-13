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

import { PathTraversalError } from "../path-traversal-error.js"
import { SymlinkEscapeError } from "../symlink-escape-error.js"
import { resolveWithinWorkspace } from "../paths.js"
import {
	PathTraversalError as ExecutorTraversalError,
	resolveWithinWorkspace as executorResolve,
} from "../executor.js"
import { runMain } from "../../test-runner.js"

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
	const resolve = (p: string): string => resolveWithinWorkspace(ws, p)
	assert.throws(() => resolve("../outside.txt"), PathTraversalError)
	assert.throws(() => resolve("sub/../../outside.txt"), PathTraversalError)
}

async function testSymlinkEscapeRefused(): Promise<void> {
	const ws = await mkWorkspace("hc-paths-")
	const outside = await mkWorkspace("hc-paths-out-")
	await fs.writeFile(path.join(outside, "secret.txt"), "top secret\n", "utf-8")
	await fs.symlink(outside, path.join(ws, "link"))
	const evil = (): string => resolveWithinWorkspace(ws, "link/secret.txt")
	assert.throws(evil, SymlinkEscapeError)
}

async function testSymlinkEscapeIsATraversalError(): Promise<void> {
	const ws = await mkWorkspace("hc-paths-")
	const outside = await mkWorkspace("hc-paths-out-")
	await fs.symlink(outside, path.join(ws, "link2"))
	try {
		resolveWithinWorkspace(ws, "link2/x.txt")
		assert.fail("expected a SymlinkEscapeError")
	} catch (error) {
		const catchable = error instanceof PathTraversalError
		assert.ok(catchable, "escape stays catchable as traversal")
		assert.equal((error as Error).name, "SymlinkEscapeError")
	}
}

async function testExecutorReexportsTheSameGuard(): Promise<void> {
	assert.equal(ExecutorTraversalError, PathTraversalError)
	const ws = await mkWorkspace("hc-paths-")
	assert.equal(executorResolve(ws, "a.txt"), resolveWithinWorkspace(ws, "a.txt"))
	assert.throws(() => executorResolve(ws, "../escape.txt"), PathTraversalError)
}

const tests: Array<[string, () => Promise<void>]> = [
	["inside path resolves", testInsidePathResolves],
	["dot path resolves to root", testDotPathResolvesToRoot],
	["traversal refused", testTraversalRefused],
	["symlink escape refused", testSymlinkEscapeRefused],
	["escape is a traversal error", testSymlinkEscapeIsATraversalError],
	["executor re-exports guard", testExecutorReexportsTheSameGuard],
]

runMain("paths", tests)
