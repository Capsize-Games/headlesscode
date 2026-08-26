/**
 * Unit tests for the headless `search_replace` tool handler
 * (src/tools/executor.ts's searchReplaceHandler). Plain assert-based script
 * (no test framework, no network), run via `npm test` ->
 * `tsx src/tools/__tests__/search_replace.test.ts`.
 *
 * The tool's core safety property: old_string must match EXACTLY once —
 * zero matches and multiple matches both fail clearly rather than guessing.
 */

import assert from "node:assert/strict"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"

import { createHeadlessExecutor } from "../executor.js"
import type { PermissionsConfig } from "../../permissions/config.js"

async function mkTmpWorkspace(prefix: string): Promise<string> {
	return fs.mkdtemp(path.join(os.tmpdir(), prefix))
}

// ─── (a) exact single match replaces correctly ───────────────────────────────

async function testExactMatchReplaces(): Promise<void> {
	const ws = await mkTmpWorkspace("hc-sr-exact-")
	try {
		const file = path.join(ws, "note.txt")
		await fs.writeFile(file, "the quick brown fox\njumps over the dog\n", "utf-8")

		const executor = createHeadlessExecutor(ws)
		const result = await executor.execute("search_replace", {
			file_path: "note.txt",
			old_string: "the dog\n",
			new_string: "the lazy dog\n",
		})

		assert.equal(result.isError, false, `exact single match should succeed: ${result.content}`)
		assert.match(result.content, /note\.txt/, "success message should name the file")
		assert.equal(await fs.readFile(file, "utf-8"), "the quick brown fox\njumps over the lazy dog\n")
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

// ─── (b) zero matches fails clearly ──────────────────────────────────────────

async function testZeroMatchesFailsClearly(): Promise<void> {
	const ws = await mkTmpWorkspace("hc-sr-zeromatch-")
	try {
		const file = path.join(ws, "note.txt")
		const original = "the quick brown fox\njumps over the dog\n"
		await fs.writeFile(file, original, "utf-8")

		const executor = createHeadlessExecutor(ws)
		const result = await executor.execute("search_replace", {
			file_path: "note.txt",
			old_string: "no such text anywhere\n",
			new_string: "replacement\n",
		})

		assert.equal(result.isError, true, "zero matches must fail")
		assert.match(result.content, /no match found/i, "error should say no match found")
		assert.equal(await fs.readFile(file, "utf-8"), original, "file must be untouched")
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

// ─── (c) multiple matches fails clearly ──────────────────────────────────────

async function testMultipleMatchesFailsClearly(): Promise<void> {
	const ws = await mkTmpWorkspace("hc-sr-multimatch-")
	try {
		const file = path.join(ws, "note.txt")
		const original = "dup\ndup\n"
		await fs.writeFile(file, original, "utf-8")

		const executor = createHeadlessExecutor(ws)
		const result = await executor.execute("search_replace", {
			file_path: "note.txt",
			old_string: "dup",
			new_string: "changed",
		})

		assert.equal(result.isError, true, "multiple matches must fail")
		assert.match(result.content, /found 2 matches/i, "error should report the exact count")
		assert.match(result.content, /ONE occurrence/i, "error should explain only one replacement is allowed")
		assert.equal(await fs.readFile(file, "utf-8"), original, "file must be untouched")
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

// ─── (d) identical old/new strings fails clearly ─────────────────────────────

async function testIdenticalStringsFail(): Promise<void> {
	const ws = await mkTmpWorkspace("hc-sr-identical-")
	try {
		const file = path.join(ws, "note.txt")
		await fs.writeFile(file, "hello\n", "utf-8")

		const executor = createHeadlessExecutor(ws)
		const result = await executor.execute("search_replace", {
			file_path: "note.txt",
			old_string: "hello",
			new_string: "hello",
		})

		assert.equal(result.isError, true, "identical old/new strings must fail")
		assert.match(result.content, /must be different/i, "error should say the strings must differ")
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

// ─── (e) empty old_string on existing file fails (no silent no-op) ───────────

async function testEmptyOldStringFailsOnExistingFile(): Promise<void> {
	const ws = await mkTmpWorkspace("hc-sr-empty-")
	try {
		const file = path.join(ws, "note.txt")
		const original = "hello\n"
		await fs.writeFile(file, original, "utf-8")

		const executor = createHeadlessExecutor(ws)
		const result = await executor.execute("search_replace", {
			file_path: "note.txt",
			old_string: "",
			new_string: "new content\n",
		})

		// Upstream SearchReplaceTool fails on empty old_string (missing param).
		assert.equal(result.isError, true, "empty old_string must fail (not a silent no-op)")
		assert.equal(await fs.readFile(file, "utf-8"), original, "file must be untouched")
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

// ─── (f) missing file fails clearly ──────────────────────────────────────────

async function testMissingFileFails(): Promise<void> {
	const ws = await mkTmpWorkspace("hc-sr-missing-")
	try {
		const executor = createHeadlessExecutor(ws)
		const result = await executor.execute("search_replace", {
			file_path: "nope.txt",
			old_string: "x",
			new_string: "y",
		})
		assert.equal(result.isError, true, "missing file must fail")
		assert.match(result.content, /file not found/i, "error should say the file is missing")
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

// ─── (g) protected files are refused (shared write-path guard) ───────────────

const PROTECTED_PERMISSIONS: PermissionsConfig = {
	allowedCommands: [],
	deniedCommands: [],
	protectedFiles: [".env", "*.pem"],
	allowProtectedWrites: false,
}

async function testProtectedFileRefused(): Promise<void> {
	const ws = await mkTmpWorkspace("hc-sr-protected-")
	try {
		const file = path.join(ws, ".env")
		const original = "API_KEY=secret\n"
		await fs.writeFile(file, original, "utf-8")

		const executor = createHeadlessExecutor(ws, { permissions: { ...PROTECTED_PERMISSIONS } })
		const result = await executor.execute("search_replace", {
			file_path: ".env",
			old_string: "API_KEY=secret\n",
			new_string: "API_KEY=leaked\n",
		})

		assert.equal(result.isError, true, "search_replace on a protected file must be refused")
		assert.match(result.content, /refusing to write protected file '\.env'/, "refusal must name the file")
		assert.match(result.content, /protected pattern '\.env'/, "refusal must name the matched pattern")
		assert.match(result.content, /allow-protected-writes/, "refusal must mention the escape hatch")
		assert.equal(await fs.readFile(file, "utf-8"), original, "protected file must be untouched")
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

// ─── (h) the escape hatch bypasses the protected-file guard ──────────────────

async function testProtectedFileEscapeHatch(): Promise<void> {
	const ws = await mkTmpWorkspace("hc-sr-protected-hatch-")
	try {
		const file = path.join(ws, ".env")
		await fs.writeFile(file, "API_KEY=secret\n", "utf-8")

		const executor = createHeadlessExecutor(ws, {
			permissions: { ...PROTECTED_PERMISSIONS, allowProtectedWrites: true },
		})
		const result = await executor.execute("search_replace", {
			file_path: ".env",
			old_string: "API_KEY=secret\n",
			new_string: "API_KEY=rotated\n",
		})

		assert.equal(result.isError, false, `the escape hatch must permit the protected edit: ${result.content}`)
		assert.equal(await fs.readFile(file, "utf-8"), "API_KEY=rotated\n")
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

// ─── Runner ──────────────────────────────────────────────────────────────────

const tests: Array<[string, () => Promise<void>]> = [
	["exact single match: replaces the one occurrence", testExactMatchReplaces],
	["zero matches: clear error, file untouched", testZeroMatchesFailsClearly],
	["multiple matches: clear error reporting the count, file untouched", testMultipleMatchesFailsClearly],
	["identical old/new strings: clear error", testIdenticalStringsFail],
	["empty old_string on existing file: clear error, no silent no-op", testEmptyOldStringFailsOnExistingFile],
	["missing file: clear error", testMissingFileFails],
	["protected file: refused via shared write-path guard", testProtectedFileRefused],
	["protected file: --allow-protected-writes escape hatch permits the edit", testProtectedFileEscapeHatch],
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
	console.log(`\nAll ${tests.length} search_replace tests passed`)
}

main().catch((err) => {
	console.error("Test runner crashed:", err)
	process.exit(1)
})
