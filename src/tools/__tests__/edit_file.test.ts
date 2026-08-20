/**
 * Unit tests for the headless `edit_file` tool handler
 * (src/tools/executor.ts's editFileHandler). Plain assert-based script (no
 * test framework, no network), run via `npm test` ->
 * `tsx src/tools/__tests__/edit_file.test.ts`.
 *
 * edit_file is resilient to formatting drift via a fallback chain:
 *   exact literal match → whitespace-tolerant regex → token-based regex
 * and supports file creation when old_string is "" (failing clearly if the
 * file already exists).
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

// ─── (a) exact match replaces correctly ──────────────────────────────────────

async function testExactMatchReplaces(): Promise<void> {
	const ws = await mkTmpWorkspace("hc-ef-exact-")
	try {
		const file = path.join(ws, "app.ts")
		await fs.writeFile(file, "const x = 1;\nconst y = 2;\n", "utf-8")

		const executor = createHeadlessExecutor(ws)
		const result = await executor.execute("edit_file", {
			file_path: "app.ts",
			old_string: "const x = 1;\n",
			new_string: "const x = 10;\n",
		})

		assert.equal(result.isError, false, `exact match should succeed: ${result.content}`)
		assert.equal(await fs.readFile(file, "utf-8"), "const x = 10;\nconst y = 2;\n")
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

// ─── (b) wrong occurrence count fails clearly ────────────────────────────────

async function testWrongOccurrenceCountFails(): Promise<void> {
	const ws = await mkTmpWorkspace("hc-ef-wrongcount-")
	try {
		const file = path.join(ws, "app.ts")
		const original = "const z = 1;\nconst z = 2;\n"
		await fs.writeFile(file, original, "utf-8")

		const executor = createHeadlessExecutor(ws)
		// "const z = 1;" appears exactly once, but the caller expected 2.
		const result = await executor.execute("edit_file", {
			file_path: "app.ts",
			old_string: "const z = 1;",
			new_string: "const z = 99;",
			expected_replacements: 2,
		})

		assert.equal(result.isError, true, "wrong expected count must fail")
		assert.match(result.content, /occurrence count mismatch/i, "error should say the count mismatched")
		assert.equal(await fs.readFile(file, "utf-8"), original, "file must be untouched")
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

// ─── (c) expected_replacements > 1 replaces all occurrences ──────────────────

async function testMultipleReplacements(): Promise<void> {
	const ws = await mkTmpWorkspace("hc-ef-multi-")
	try {
		const file = path.join(ws, "app.ts")
		await fs.writeFile(file, "a\nb\na\n", "utf-8")

		const executor = createHeadlessExecutor(ws)
		const result = await executor.execute("edit_file", {
			file_path: "app.ts",
			old_string: "a",
			new_string: "A",
			expected_replacements: 2,
		})

		assert.equal(result.isError, false, `expected_replacements=2 should succeed: ${result.content}`)
		assert.match(result.content, /2 replacements/, "success message should report the replacement count")
		assert.equal(await fs.readFile(file, "utf-8"), "A\nb\nA\n")
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

// ─── (c2) unsafe multi-replace insertion guard ────────────────────────────────
// Live reproduction, 2026-08-20: a local model's old_string ("estimateMessageChars",
// a bare identifier) matched a function definition plus 3 unrelated call sites.
// edit_file's own error message on the first (correctly refused) attempt
// suggested "if you intend to replace all occurrences, set expected_replacements
// to N" — the model took that literally and inserted an entire new function
// body at all 4 sites, corrupting the 3 call sites (each ended up with the new
// function spliced into the middle of a function call). This guard refuses
// that shape (expected_replacements > 1 with new_string much longer than
// old_string) instead of applying it.

async function testUnsafeMultiReplaceInsertionRefused(): Promise<void> {
	const ws = await mkTmpWorkspace("hc-ef-unsafe-multi-")
	try {
		const file = path.join(ws, "condense.ts")
		const original =
			"export function estimateMessageChars(m: Msg): number {\n  return m.content.length\n}\n\n" +
			"function a(m: Msg) {\n  return estimateMessageChars(m)\n}\n\n" +
			"function b(m: Msg) {\n  return estimateMessageChars(m)\n}\n"
		await fs.writeFile(file, original, "utf-8")

		const executor = createHeadlessExecutor(ws)
		// The model's real intent: insert a new function right after the
		// estimateMessageChars DEFINITION only. old_string is too short/generic
		// (matches the definition AND both call sites) and new_string is a large
		// insertion — exactly the shape that corrupted the 3 call sites live.
		const insertion = "\n\n" + "x".repeat(80) // well over the 40-char growth threshold
		const result = await executor.execute("edit_file", {
			file_path: "condense.ts",
			old_string: "estimateMessageChars",
			new_string: "estimateMessageChars" + insertion,
			expected_replacements: 3,
		})

		assert.equal(result.isError, true, "a large insertion applied at multiple sites must be refused")
		assert.match(result.content, /refusing expected_replacements/, "error explains the refusal")
		assert.equal(await fs.readFile(file, "utf-8"), original, "file must be untouched — no partial corruption")
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

async function testSafeMultiReplaceRenameStillWorks(): Promise<void> {
	// A genuine like-for-like rename (new_string close in length to old_string)
	// at multiple sites must NOT be blocked by the insertion guard above.
	const ws = await mkTmpWorkspace("hc-ef-safe-multi-")
	try {
		const file = path.join(ws, "app.ts")
		await fs.writeFile(file, "oldName(1)\noldName(2)\noldName(3)\n", "utf-8")

		const executor = createHeadlessExecutor(ws)
		const result = await executor.execute("edit_file", {
			file_path: "app.ts",
			old_string: "oldName",
			new_string: "newName",
			expected_replacements: 3,
		})

		assert.equal(result.isError, false, `a genuine rename across multiple sites must still succeed: ${result.content}`)
		assert.equal(await fs.readFile(file, "utf-8"), "newName(1)\nnewName(2)\nnewName(3)\n")
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

// ─── (d) whitespace-tolerant match (only strategy 2 would catch it) ──────────

async function testWhitespaceTolerantFallback(): Promise<void> {
	const ws = await mkTmpWorkspace("hc-ef-ws-")
	try {
		const file = path.join(ws, "app.ts")
		// File uses 2-space indentation.
		await fs.writeFile(file, "if (ok) {\n  run();\n}\n", "utf-8")

		const executor = createHeadlessExecutor(ws)
		// The caller's old_string uses 4-space indentation — exact match fails,
		// but the whitespace-tolerant regex (which allows any horizontal
		// whitespace run) still finds exactly one occurrence.
		const result = await executor.execute("edit_file", {
			file_path: "app.ts",
			old_string: "    run();\n",
			new_string: "    runNow();\n",
		})

		assert.equal(result.isError, false, `whitespace-tolerant fallback should succeed: ${result.content}`)
		const updated = await fs.readFile(file, "utf-8")
		assert.match(updated, /runNow\(\)/, "the replacement should be applied")
		assert.ok(updated.includes("  runNow();"), "original indentation should be preserved (2 spaces)")
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

// ─── (e) token-based match (only strategy 3 would catch it) ──────────────────

async function testTokenBasedFallback(): Promise<void> {
	const ws = await mkTmpWorkspace("hc-ef-token-")
	try {
		const file = path.join(ws, "app.ts")
		// File with extra blank line breaking the exact + whitespace-tolerant
		// match (whitespace-tolerant only tolerates runs INSIDE a whitespace
		// token; an extra newline between tokens needs the token strategy).
		await fs.writeFile(file, "const a = 1;\n\n\nconst b = 2;\n", "utf-8")

		const executor = createHeadlessExecutor(ws)
		// Caller's old_string has the two statements on adjacent lines with
		// single-space separation; the file has multiple blank lines between
		// them. Token-based matching (tokens joined by \s+) finds it.
		const result = await executor.execute("edit_file", {
			file_path: "app.ts",
			old_string: "const a = 1; const b = 2;",
			new_string: "const a = 1; const b = 22;",
		})

		assert.equal(result.isError, false, `token-based fallback should succeed: ${result.content}`)
		const updated = await fs.readFile(file, "utf-8")
		assert.match(updated, /const b = 22;/, "the token-based replacement should be applied")
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

// ─── (f) file creation with old_string "" (non-existing file) ────────────────

async function testCreateNewFile(): Promise<void> {
	const ws = await mkTmpWorkspace("hc-ef-create-")
	try {
		const executor = createHeadlessExecutor(ws)
		const result = await executor.execute("edit_file", {
			file_path: "new-file.md",
			old_string: "",
			new_string: "# New file\n\nCreated via edit_file.\n",
		})

		assert.equal(result.isError, false, `file creation should succeed: ${result.content}`)
		assert.match(result.content, /File created: new-file\.md/, "success message should say the file was created")
		assert.equal(await fs.readFile(path.join(ws, "new-file.md"), "utf-8"), "# New file\n\nCreated via edit_file.\n")
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

// ─── (g) file creation with old_string "" on an EXISTING file fails ──────────

async function testCreateExistingFileFails(): Promise<void> {
	const ws = await mkTmpWorkspace("hc-ef-create-exists-")
	try {
		const file = path.join(ws, "existing.md")
		const original = "already here\n"
		await fs.writeFile(file, original, "utf-8")

		const executor = createHeadlessExecutor(ws)
		const result = await executor.execute("edit_file", {
			file_path: "existing.md",
			old_string: "",
			new_string: "overwrite me\n",
		})

		assert.equal(result.isError, true, "creation over an existing file must fail")
		assert.match(result.content, /already exists/i, "error should say the file already exists")
		assert.match(result.content, /write_to_file/i, "error should suggest write_to_file for overwrite")
		assert.equal(await fs.readFile(file, "utf-8"), original, "existing file must be untouched")
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

// ─── (h) editing a non-existent file without creation fails clearly ─────────

async function testEditMissingFileFails(): Promise<void> {
	const ws = await mkTmpWorkspace("hc-ef-missing-")
	try {
		const executor = createHeadlessExecutor(ws)
		const result = await executor.execute("edit_file", {
			file_path: "nope.ts",
			old_string: "anything",
			new_string: "nothing",
		})
		assert.equal(result.isError, true, "editing a missing file must fail")
		assert.match(result.content, /file does not exist/i, "error should say the file is missing")
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

// ─── (i) protected files are refused (shared write-path guard) ───────────────

const PROTECTED_PERMISSIONS: PermissionsConfig = {
	allowedCommands: [],
	deniedCommands: [],
	protectedFiles: [".env", "*.pem"],
	allowProtectedWrites: false,
}

async function testProtectedFileRefused(): Promise<void> {
	const ws = await mkTmpWorkspace("hc-ef-protected-")
	try {
		const file = path.join(ws, ".env")
		const original = "API_KEY=secret\n"
		await fs.writeFile(file, original, "utf-8")

		const executor = createHeadlessExecutor(ws, { permissions: { ...PROTECTED_PERMISSIONS } })
		const result = await executor.execute("edit_file", {
			file_path: ".env",
			old_string: "API_KEY=secret\n",
			new_string: "API_KEY=leaked\n",
		})

		assert.equal(result.isError, true, "edit_file on a protected file must be refused")
		assert.match(result.content, /refusing to write protected file '\.env'/, "refusal must name the file")
		assert.match(result.content, /protected pattern '\.env'/, "refusal must name the matched pattern")
		assert.match(result.content, /allow-protected-writes/, "refusal must mention the escape hatch")
		assert.equal(await fs.readFile(file, "utf-8"), original, "protected file must be untouched")
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

// ─── (j) the escape hatch bypasses the protected-file guard ──────────────────

async function testProtectedFileEscapeHatch(): Promise<void> {
	const ws = await mkTmpWorkspace("hc-ef-protected-hatch-")
	try {
		const file = path.join(ws, ".env")
		await fs.writeFile(file, "API_KEY=secret\n", "utf-8")

		const executor = createHeadlessExecutor(ws, {
			permissions: { ...PROTECTED_PERMISSIONS, allowProtectedWrites: true },
		})
		const result = await executor.execute("edit_file", {
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
	["exact match: literal replacement applies", testExactMatchReplaces],
	["wrong occurrence count: clear error, file untouched", testWrongOccurrenceCountFails],
	["expected_replacements > 1: replaces all occurrences", testMultipleReplacements],
	["unsafe multi-replace insertion (large growth, N>1) is refused, file untouched", testUnsafeMultiReplaceInsertionRefused],
	["safe multi-replace rename (no growth, N>1) still succeeds", testSafeMultiReplaceRenameStillWorks],
	["whitespace-tolerant fallback: catches indentation drift", testWhitespaceTolerantFallback],
	["token-based fallback: catches newline drift", testTokenBasedFallback],
	["file creation: old_string '' on new file succeeds", testCreateNewFile],
	["file creation: old_string '' on existing file fails clearly", testCreateExistingFileFails],
	["editing a non-existent file: clear error", testEditMissingFileFails],
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
	console.log(`\nAll ${tests.length} edit_file tests passed`)
}

main().catch((err) => {
	console.error("Test runner crashed:", err)
	process.exit(1)
})
