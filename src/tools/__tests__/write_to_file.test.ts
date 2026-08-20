/**
 * Unit tests for the headless `write_to_file` tool handler
 * (src/tools/executor.ts's writeToFileHandler). Plain assert-based script (no
 * test framework, no network), run via `npm test` ->
 * `tsx src/tools/__tests__/write_to_file.test.ts`.
 *
 * Covers the guardLargeOverwrites gate (see ToolContext.guardLargeOverwrites,
 * src/engine/types.ts, and loop.ts's HeadlessSessionConfig.guardLargeOverwrites
 * doc comment): write_to_file refuses to overwrite an existing file that
 * already has substantial content when the gate is on, nudging toward
 * edit_file/search_replace, while creating a brand-new file (or overwriting a
 * trivially small one) is never affected — and the gate is a no-op entirely
 * when off (the default, and always the case for cloud sessions).
 */

import assert from "node:assert/strict"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"

import { createHeadlessExecutor } from "../executor.js"

async function mkTmpWorkspace(prefix: string): Promise<string> {
	return fs.mkdtemp(path.join(os.tmpdir(), prefix))
}

// ─── (a) new file: unaffected regardless of the gate ─────────────────────────

async function testNewFileAlwaysSucceeds(): Promise<void> {
	const ws = await mkTmpWorkspace("hc-wtf-newfile-")
	try {
		const executor = createHeadlessExecutor(ws, { guardLargeOverwrites: true })
		const result = await executor.execute("write_to_file", {
			path: "fresh.ts",
			content: "export const x = 1;\n",
		})

		assert.equal(result.isError, false, `new-file write should succeed: ${result.content}`)
		assert.equal(await fs.readFile(path.join(ws, "fresh.ts"), "utf-8"), "export const x = 1;\n")
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

// ─── (b) existing file with substantial content: refused when gated ─────────

async function testSubstantialOverwriteRefusedWhenGated(): Promise<void> {
	const ws = await mkTmpWorkspace("hc-wtf-refuse-")
	try {
		const file = path.join(ws, "existing.ts")
		const original = "export function keepMe() {\n\treturn 1;\n}\n".repeat(20)
		await fs.writeFile(file, original, "utf-8")

		const executor = createHeadlessExecutor(ws, { guardLargeOverwrites: true })
		const result = await executor.execute("write_to_file", {
			path: "existing.ts",
			content: "export function replaced() { return 2; }\n",
		})

		assert.equal(result.isError, true, "overwriting a substantial existing file must be refused")
		assert.match(result.content, /refusing to overwrite/i)
		assert.match(result.content, /edit_file/i, "error should nudge toward edit_file")
		assert.equal(await fs.readFile(file, "utf-8"), original, "file must be untouched")
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

// ─── (c) same file, gate off: succeeds (matches today's ungated behavior) ────

async function testSubstantialOverwriteSucceedsWhenUngated(): Promise<void> {
	const ws = await mkTmpWorkspace("hc-wtf-ungated-")
	try {
		const file = path.join(ws, "existing.ts")
		const original = "export function keepMe() {\n\treturn 1;\n}\n".repeat(20)
		await fs.writeFile(file, original, "utf-8")

		const executor = createHeadlessExecutor(ws) // guardLargeOverwrites left off
		const result = await executor.execute("write_to_file", {
			path: "existing.ts",
			content: "export function replaced() { return 2; }\n",
		})

		assert.equal(result.isError, false, `ungated overwrite should succeed: ${result.content}`)
		assert.equal(await fs.readFile(file, "utf-8"), "export function replaced() { return 2; }\n")
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

// ─── (d) existing but trivially small file: unaffected even when gated ──────

async function testTrivialExistingFileUnaffected(): Promise<void> {
	const ws = await mkTmpWorkspace("hc-wtf-trivial-")
	try {
		const file = path.join(ws, "stub.ts")
		await fs.writeFile(file, "export {}\n", "utf-8")

		const executor = createHeadlessExecutor(ws, { guardLargeOverwrites: true })
		const result = await executor.execute("write_to_file", {
			path: "stub.ts",
			content: "export const real = true;\n",
		})

		assert.equal(result.isError, false, `trivial existing file should be overwritable: ${result.content}`)
		assert.equal(await fs.readFile(file, "utf-8"), "export const real = true;\n")
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

// ─── Runner ──────────────────────────────────────────────────────────────────

const tests: Array<[string, () => Promise<void>]> = [
	["new file: write_to_file always succeeds, gate or no gate", testNewFileAlwaysSucceeds],
	["existing substantial file: refused when guardLargeOverwrites is on", testSubstantialOverwriteRefusedWhenGated],
	["existing substantial file: succeeds when the gate is off", testSubstantialOverwriteSucceedsWhenUngated],
	["existing trivial file: unaffected even when the gate is on", testTrivialExistingFileUnaffected],
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
	console.log(`\nAll ${tests.length} write_to_file tests passed`)
}

main().catch((err) => {
	console.error("Test runner crashed:", err)
	process.exit(1)
})
