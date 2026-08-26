/**
 * Unit tests for the headless `apply_diff` tool handler
 * (src/tools/executor.ts's applyDiffHandler), which drives the vendored
 * MultiSearchReplaceDiffStrategy. Plain assert-based script (no test
 * framework, no network), run via `npm test` ->
 * `tsx src/tools/__tests__/apply_diff.test.ts`.
 *
 * The diff block syntax is exactly what the model is told to produce (see the
 * vendored apply_diff schema): <<<<<<< SEARCH, optional :start_line:N,
 * -------, search content, =======, replacement content, >>>>>>> REPLACE.
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

function diffBlock(search: string, replace: string, startLine?: number): string {
	const start = startLine !== undefined ? `:start_line:${startLine}\n` : ""
	return `<<<<<<< SEARCH\n${start}-------\n${search}=======\n${replace}>>>>>>> REPLACE`
}

// ─── (a) single block applies cleanly ────────────────────────────────────────

async function testSingleBlockAppliesCleanly(): Promise<void> {
	const ws = await mkTmpWorkspace("hc-applydiff-single-")
	try {
		const file = path.join(ws, "greeting.txt")
		await fs.writeFile(file, "hello world\nfoo bar\n", "utf-8")

		const executor = createHeadlessExecutor(ws)
		const result = await executor.execute("apply_diff", {
			path: "greeting.txt",
			diff: diffBlock("hello world\n", "hello brave new world\n"),
		})

		assert.equal(result.isError, false, `single-block apply_diff should succeed: ${result.content}`)
		assert.match(result.content, /greeting\.txt/, "success message should name the file")
		assert.equal(await fs.readFile(file, "utf-8"), "hello brave new world\nfoo bar\n")
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

// ─── (b) multiple blocks in one call ────────────────────────────────────────

async function testMultipleBlocksInOneCall(): Promise<void> {
	const ws = await mkTmpWorkspace("hc-applydiff-multi-")
	try {
		const file = path.join(ws, "config.txt")
		await fs.writeFile(file, "alpha = 1\nbeta = 2\ngamma = 3\n", "utf-8")

		const executor = createHeadlessExecutor(ws)
		const result = await executor.execute("apply_diff", {
			path: "config.txt",
			diff:
				diffBlock("alpha = 1\n", "alpha = 10\n") +
				"\n" +
				diffBlock("gamma = 3\n", "gamma = 30\n"),
		})

		assert.equal(result.isError, false, `multi-block apply_diff should succeed: ${result.content}`)
		assert.equal(await fs.readFile(file, "utf-8"), "alpha = 10\nbeta = 2\ngamma = 30\n")
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

// ─── (c) :start_line: disambiguates a duplicated search string ──────────────

async function testStartLineDisambiguatesDuplicateSearch(): Promise<void> {
	const ws = await mkTmpWorkspace("hc-applydiff-startline-")
	try {
		const file = path.join(ws, "dup.txt")
		// "target" appears twice; only the second one should be edited.
		await fs.writeFile(file, "one\ntarget\nkeep me\ntarget\nend\n", "utf-8")

		const executor = createHeadlessExecutor(ws)
		const result = await executor.execute("apply_diff", {
			path: "dup.txt",
			diff: diffBlock("target\n", "TARGET-EDITED\n", 4),
		})

		assert.equal(result.isError, false, `start_line-disambiguated apply_diff should succeed: ${result.content}`)
		assert.equal(await fs.readFile(file, "utf-8"), "one\ntarget\nkeep me\nTARGET-EDITED\nend\n")
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

// ─── (d) a non-matching block errors clearly and leaves the file untouched ──

async function testNonMatchingBlockErrorsAndLeavesFileUntouched(): Promise<void> {
	const ws = await mkTmpWorkspace("hc-applydiff-nomatch-")
	try {
		const file = path.join(ws, "stable.txt")
		const original = "line1\nline2\nline3\n"
		await fs.writeFile(file, original, "utf-8")

		const executor = createHeadlessExecutor(ws)
		const result = await executor.execute("apply_diff", {
			path: "stable.txt",
			diff: diffBlock("completely different content\n", "nope\n"),
		})

		assert.equal(result.isError, true, "a non-matching search must return an error")
		assert.match(result.content, /unable to apply diff/i, "error should say the diff could not be applied")
		assert.match(result.content, /similar/i, "error should include similarity/threshold guidance")
		assert.equal(await fs.readFile(file, "utf-8"), original, "file must be untouched on failure")
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

// ─── (e) fuzzy/whitespace-tolerant matching tolerates minor drift ────────────

async function testFuzzyWhitespaceTolerantMatch(): Promise<void> {
	const ws = await mkTmpWorkspace("hc-applydiff-fuzzy-")
	try {
		const file = path.join(ws, "code.ts")
		// Real file with 4-space indentation.
		await fs.writeFile(
			file,
			"function greet() {\n    const message = 'hi';\n    return message;\n}\n",
			"utf-8",
		)

		const executor = createHeadlessExecutor(ws)
		// The model's SEARCH block uses 2-space indentation while the real file
		// uses 4-space indentation — pure whitespace drift. A literal string
		// match would fail; the strategy's normalizeString (which collapses and
		// trims whitespace) makes the similarity 1.0, so the default exact
		// threshold still matches. This is the whitespace-tolerance path the
		// spec demands proof of.
		const result = await executor.execute("apply_diff", {
			path: "code.ts",
			diff: diffBlock("  const message = 'hi';\n", "  const message = 'hello';\n"),
		})

		assert.equal(result.isError, false, `fuzzy-tolerant apply_diff should succeed: ${result.content}`)
		const updated = await fs.readFile(file, "utf-8")
		assert.match(updated, /'hello'/, "the replacement text should be present")
		assert.ok(updated.includes("    const message = 'hello';"), "indentation should follow the matched lines")
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

// ─── (f) file that does not exist errors clearly ─────────────────────────────

async function testMissingFileErrorsClearly(): Promise<void> {
	const ws = await mkTmpWorkspace("hc-applydiff-missing-")
	try {
		const executor = createHeadlessExecutor(ws)
		const result = await executor.execute("apply_diff", {
			path: "no-such-file.txt",
			diff: diffBlock("anything\n", "nothing\n"),
		})
		assert.equal(result.isError, true, "apply_diff on a missing file must error")
		assert.match(result.content, /does not exist/i, "error should mention the file is missing")
		assert.match(result.content, /write_to_file/i, "error should suggest write_to_file for creation")
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
	const ws = await mkTmpWorkspace("hc-applydiff-protected-")
	try {
		const file = path.join(ws, ".env")
		const original = "API_KEY=secret\n"
		await fs.writeFile(file, original, "utf-8")

		const executor = createHeadlessExecutor(ws, { permissions: { ...PROTECTED_PERMISSIONS } })
		const result = await executor.execute("apply_diff", {
			path: ".env",
			diff: diffBlock("API_KEY=secret\n", "API_KEY=leaked\n"),
		})

		assert.equal(result.isError, true, "apply_diff to a protected file must be refused")
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
	const ws = await mkTmpWorkspace("hc-applydiff-protected-hatch-")
	try {
		const file = path.join(ws, ".env")
		await fs.writeFile(file, "API_KEY=secret\n", "utf-8")

		const executor = createHeadlessExecutor(ws, {
			permissions: { ...PROTECTED_PERMISSIONS, allowProtectedWrites: true },
		})
		const result = await executor.execute("apply_diff", {
			path: ".env",
			diff: diffBlock("API_KEY=secret\n", "API_KEY=rotated\n"),
		})

		assert.equal(result.isError, false, `the escape hatch must permit the protected edit: ${result.content}`)
		assert.equal(await fs.readFile(file, "utf-8"), "API_KEY=rotated\n")
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

// ─── Runner ──────────────────────────────────────────────────────────────────

const tests: Array<[string, () => Promise<void>]> = [
	["single block: applies cleanly", testSingleBlockAppliesCleanly],
	["multiple blocks: all applied in one call", testMultipleBlocksInOneCall],
	["start_line: disambiguates a duplicated search string", testStartLineDisambiguatesDuplicateSearch],
	["no match: clear error and file untouched", testNonMatchingBlockErrorsAndLeavesFileUntouched],
	["fuzzy: whitespace/quote drift still matches", testFuzzyWhitespaceTolerantMatch],
	["missing file: clear error suggesting write_to_file", testMissingFileErrorsClearly],
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
	console.log(`\nAll ${tests.length} apply_diff tests passed`)
}

main().catch((err) => {
	console.error("Test runner crashed:", err)
	process.exit(1)
})
