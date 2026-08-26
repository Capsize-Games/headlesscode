/**
 * Unit tests for the symlink-escape layer of the path-safety guard
 * (src/tools/executor.ts — resolveWithinWorkspace / SymlinkEscapeError,
 * issue #64).
 *
 * The lexical `../` containment check has long been covered by the other
 * suites' traversal tests; this file targets the NEW second layer: every
 * `fsp` call in the file tools follows symlinks, so a path that stays inside
 * the workspace lexically but resolves outside it through a symlink must be
 * refused for reads AND writes (including the protected-files bypass — a
 * symlink to ~/.ssh would otherwise let an agent write to id_rsa behind the
 * pattern guard).
 *
 * Plain assert-based script (no test framework), run via
 * `npm test` -> `tsx src/tools/__tests__/path-safety.test.ts`.
 */

import assert from "node:assert/strict"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"

import {
	createHeadlessExecutor,
	createLocalExploreExecutor,
	resolveWithinWorkspace,
	SymlinkEscapeError,
	PathTraversalError,
} from "../executor.js"

async function mkTmpWorkspace(prefix: string): Promise<string> {
	return fs.mkdtemp(path.join(os.tmpdir(), prefix))
}

/** Create a directory OUTSIDE the workspace with a sentinel file in it. */
async function mkOutsideDir(ws: string, prefix: string): Promise<{ outside: string; secret: string }> {
	const outside = await fs.mkdtemp(path.join(os.tmpdir(), prefix))
	const secret = path.join(outside, "secret.txt")
	await fs.writeFile(secret, "top secret\n", "utf-8")
	return { outside, secret }
}

async function exists(p: string): Promise<boolean> {
	try {
		await fs.access(p)
		return true
	} catch {
		return false
	}
}

// ─── (a) read through an escaping symlink is refused ─────────────────────────

async function testReadThroughEscapingSymlinkRefused(): Promise<void> {
	const ws = await mkTmpWorkspace("hc-symlink-read-")
	try {
		const { secret } = await mkOutsideDir(ws, "hc-symlink-outside-")
		await fs.symlink(path.dirname(secret), path.join(ws, "escape"))

		const executor = createHeadlessExecutor(ws)
		const result = await executor.execute("read_file", { path: "escape/secret.txt" })
		assert.equal(result.isError, true, "reading through an escaping symlink must be refused")
		assert.match(result.content, /symlink/i, `must name symlink as the reason, got: ${result.content}`)
		assert.match(result.content, /[Ee]scapes the workspace/, `must mention the boundary, got: ${result.content}`)
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

// ─── (b) write through an escaping symlink is refused (protected-file bypass) ─

async function testWriteThroughEscapingSymlinkRefused(): Promise<void> {
	const ws = await mkTmpWorkspace("hc-symlink-write-")
	try {
		const outside = await fs.mkdtemp(path.join(os.tmpdir(), "hc-symlink-outside-"))
		try {
			// A symlink DIRECTLY to a protected file: lexically `link` (no match
			// against `*.key`/`.env`), but writing through it would clobber
			// outside/id_rsa — the pattern guard would never see it.
			await fs.writeFile(path.join(outside, "id_rsa"), "original key\n", "utf-8")
			await fs.symlink(path.join(outside, "id_rsa"), path.join(ws, "link"))

			const executor = createHeadlessExecutor(ws)
			const result = await executor.execute("write_to_file", { path: "link", content: "pwned" })
			assert.equal(result.isError, true, "writing through an escaping symlink must be refused")
			assert.match(result.content, /symlink/i, `must name symlink as the reason, got: ${result.content}`)

			// The outside file must be untouched.
			const untouched = await fs.readFile(path.join(outside, "id_rsa"), "utf-8")
			assert.equal(untouched, "original key\n", "the outside file must not have been written")
		} finally {
			await fs.rm(outside, { recursive: true, force: true })
		}
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

// ─── (c) every file tool goes through the guard ──────────────────────────────

async function testAllFileToolsRefuseEscapingSymlink(): Promise<void> {
	const ws = await mkTmpWorkspace("hc-symlink-tools-")
	try {
		const { outside, secret } = await mkOutsideDir(ws, "hc-symlink-outside-")
		await fs.writeFile(path.join(ws, "target.txt"), "hello\n", "utf-8")
		await fs.symlink(path.dirname(secret), path.join(ws, "escape"))

		const executor = createHeadlessExecutor(ws)
		const cases: Array<[string, Record<string, unknown>]> = [
			["read_file", { path: "escape/secret.txt" }],
			["apply_diff", { path: "escape/secret.txt", diff: "irrelevant" }],
			["search_replace", { file_path: "escape/secret.txt", old_string: "x", new_string: "y" }],
			["edit_file", { file_path: "escape/secret.txt", old_string: "x", new_string: "y" }],
			["list_files", { path: "escape" }],
			["describe_image", { path: "escape/secret.txt" }],
		]
		for (const [name, args] of cases) {
			const result = await executor.execute(name, args)
			assert.equal(result.isError, true, `${name} through an escaping symlink must be refused`)
			assert.match(result.content, /symlink/i, `${name} must name symlink as the reason, got: ${result.content}`)
		}

		// execute_command's `cwd` resolves through the same guard.
		const cwdResult = await executor.execute("execute_command", { command: "pwd", cwd: "escape" })
		assert.equal(cwdResult.isError, true, "execute_command cwd through an escaping symlink must be refused")
		assert.match(cwdResult.content, /symlink/i, `cwd refusal must name symlink, got: ${cwdResult.content}`)
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

// ─── (c2) execute_command redirects are subject to the same boundary (issue #122) ─

async function testExecuteCommandRedirectsRefuseOutsideWorkspace(): Promise<void> {
	const ws = await mkTmpWorkspace("hc-symlink-redir-")
	try {
		const { outside, secret } = await mkOutsideDir(ws, "hc-symlink-outside-")
		// A redirect target outside the workspace — the exact class of scratch
		// write (e.g. `cat > /tmp/foo.md`) that previously slipped through the
		// command-string allow/deny gate while every file tool refused it.
		const outsideTarget = path.join(outside, "leak.txt")

		const executor = createHeadlessExecutor(ws)
		const result = await executor.execute("execute_command", {
			command: `echo hi > ${outsideTarget}`,
			timeout: 10,
		})
		assert.equal(result.isError, true, "an execute_command redirect outside the workspace must be refused")
		assert.match(result.content, /outside the workspace/, `must name the boundary, got: ${result.content}`)
		// The refusal happens BEFORE spawn — nothing was written.
		assert.equal(await exists(outsideTarget), false, "the outside file must not have been created")
		assert.equal(await exists(secret), true, "the outside dir's sentinel must survive untouched")

		// The same redirect INSIDE the workspace runs fine.
		const ok = await executor.execute("execute_command", {
			command: `echo hi > leak.txt`,
			timeout: 10,
		})
		assert.equal(ok.isError, false, "an inside-workspace redirect must run")
		assert.equal(await fs.readFile(path.join(ws, "leak.txt"), "utf-8"), "hi\n", "the inside file must be written")
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

// ─── (d) read-only executors (reviewer/QA/local explore) get the same guard ──

async function testReadOnlyExecutorsRefuseEscapingSymlink(): Promise<void> {
	const ws = await mkTmpWorkspace("hc-symlink-readonly-")
	try {
		const { outside, secret } = await mkOutsideDir(ws, "hc-symlink-outside-")
		await fs.symlink(path.dirname(secret), path.join(ws, "escape"))

		const explore = createLocalExploreExecutor(ws)
		const result = await explore.execute("read_file", { path: "escape/secret.txt" })
		assert.equal(result.isError, true, "local-explore read through an escaping symlink must be refused")
		assert.match(result.content, /symlink/i, `must name symlink, got: ${result.content}`)
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

// ─── (e) symlinks that STAY inside the workspace keep working ────────────────

async function testInternalSymlinkStillAllowed(): Promise<void> {
	const ws = await mkTmpWorkspace("hc-symlink-internal-")
	try {
		await fs.mkdir(path.join(ws, "real"), { recursive: true })
		await fs.writeFile(path.join(ws, "real", "data.txt"), "inside\n", "utf-8")
		await fs.symlink(path.join(ws, "real"), path.join(ws, "alias"))

		const executor = createHeadlessExecutor(ws)
		const read = await executor.execute("read_file", { path: "alias/data.txt" })
		assert.equal(read.isError, false, "an internal symlink must keep working")
		assert.match(read.content, /inside/, "content must come from the internal target")

		const write = await executor.execute("write_to_file", { path: "alias/new.txt", content: "created\n" })
		assert.equal(write.isError, false, "writing through an internal symlink must keep working")
		assert.equal(await fs.readFile(path.join(ws, "real", "new.txt"), "utf-8"), "created\n")
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

// ─── (f) dangling symlink whose DESTINATION is outside is refused ────────────

async function testDanglingEscapingSymlinkRefused(): Promise<void> {
	const ws = await mkTmpWorkspace("hc-symlink-dangling-")
	try {
		const outside = await fs.mkdtemp(path.join(os.tmpdir(), "hc-symlink-outside-"))
		try {
			// Points at a not-yet-existing path OUTSIDE the workspace: a write
			// through it would create that file outside.
			await fs.symlink(path.join(outside, "new.txt"), path.join(ws, "dangling"))

			const executor = createHeadlessExecutor(ws)
			const result = await executor.execute("write_to_file", { path: "dangling", content: "escape\n" })
			assert.equal(result.isError, true, "writing through a dangling escaping symlink must be refused")
			assert.match(result.content, /symlink/i, `must name symlink, got: ${result.content}`)
		} finally {
			await fs.rm(outside, { recursive: true, force: true })
		}
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

// ─── (g) a dangling symlink INSIDE the workspace stays writable ──────────────

async function testDanglingInternalSymlinkWritable(): Promise<void> {
	const ws = await mkTmpWorkspace("hc-symlink-dangling-internal-")
	try {
		await fs.symlink(path.join(ws, "not-yet.txt"), path.join(ws, "dangling"))

		const executor = createHeadlessExecutor(ws)
		const result = await executor.execute("write_to_file", { path: "dangling", content: "created\n" })
		assert.equal(result.isError, false, "writing through a dangling INTERNAL symlink must keep working")
		assert.equal(await fs.readFile(path.join(ws, "not-yet.txt"), "utf-8"), "created\n")
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

// ─── (h) unit-level: error types and messages ────────────────────────────────

async function testUnitErrorTypes(): Promise<void> {
	// Prefix deliberately free of the word "symlink": the error messages embed
	// the workspace path, and the lexical-traversal assertion below checks the
	// message has no symlink wording — a prefix containing it would false-hit.
	const ws = await mkTmpWorkspace("hc-pathunit-")
	try {
		const { outside, secret } = await mkOutsideDir(ws, "hc-symlink-outside-")
		await fs.symlink(path.dirname(secret), path.join(ws, "escape"))

		// Escaping symlink -> SymlinkEscapeError (a PathTraversalError).
		assert.throws(
			() => resolveWithinWorkspace(ws, "escape/secret.txt"),
			(err) => {
				assert.ok(err instanceof SymlinkEscapeError, "escaping symlink must throw SymlinkEscapeError")
				assert.ok(err instanceof PathTraversalError, "SymlinkEscapeError must extend PathTraversalError")
				assert.match(err.message, /symlink/i, "message names symlink")
				assert.match(err.message, /secret\.txt/, "message names the requested path")
				return true
			},
		)

		// Plain lexical traversal still throws the base class with its
		// original message (no symlink involved).
		assert.throws(
			() => resolveWithinWorkspace(ws, "../outside"),
			(err) => {
				assert.ok(err instanceof PathTraversalError, "lexical traversal must throw PathTraversalError")
				assert.ok(!(err instanceof SymlinkEscapeError), "lexical traversal must NOT be a symlink error")
				assert.doesNotMatch(err.message, /symlink/i, "plain traversal message has no symlink wording")
				return true
			},
		)

		// The escaping symlink ITSELF is refused too — its real location is
		// outside, so even listing it (`list_files` on "escape") must not
		// reach the outside directory.
		assert.throws(
			() => resolveWithinWorkspace(ws, "escape"),
			(err) => err instanceof SymlinkEscapeError,
			"the escaping symlink path itself must be refused",
		)

		// The root itself and genuinely internal paths resolve fine.
		assert.equal(resolveWithinWorkspace(ws, "."), ws)
		assert.equal(resolveWithinWorkspace(ws, "escape" + "/.."), ws)
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

// ─── Runner ──────────────────────────────────────────────────────────────────

const tests: Array<[string, () => Promise<void>]> = [
	["read through an escaping symlink is refused", testReadThroughEscapingSymlinkRefused],
	["write through an escaping symlink is refused (protected-file bypass)", testWriteThroughEscapingSymlinkRefused],
	["every file tool refuses an escaping symlink (read/write/list/describe/cwd)", testAllFileToolsRefuseEscapingSymlink],
	["execute_command redirects outside the workspace are refused before spawn; inside redirects run", testExecuteCommandRedirectsRefuseOutsideWorkspace],
	["read-only executors get the same symlink guard", testReadOnlyExecutorsRefuseEscapingSymlink],
	["symlinks that stay inside the workspace keep working", testInternalSymlinkStillAllowed],
	["dangling symlink escaping the workspace is refused", testDanglingEscapingSymlinkRefused],
	["dangling symlink inside the workspace stays writable", testDanglingInternalSymlinkWritable],
	["unit: SymlinkEscapeError vs PathTraversalError", testUnitErrorTypes],
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
		console.error(`path-safety: ${failed} of ${tests.length} tests failed`)
		process.exit(1)
	}
	console.log(`All ${tests.length} tests passed`)
}

await main()
