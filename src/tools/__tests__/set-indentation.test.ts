/**
 * Unit tests for the `set_indentation` tool handler
 * (src/tools/executor.ts's setIndentationHandler, issue #141). Plain
 * assert-based script (no test framework, no network), run via `npm test`
 * -> `tsx src/tools/__tests__/set-indentation.test.ts`.
 *
 * set_indentation exists so a pure indentation/whitespace-only fix never
 * needs a model to type out two near-identical multi-line strings (the
 * edit_file shape that reliably failed local models — see #141) — it takes
 * a plain line number and a plain tab count instead.
 */

import assert from "node:assert/strict"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"

import { createHeadlessExecutor, createReadOnlyHeadlessExecutor } from "../executor.js"

async function mkTmpWorkspace(prefix: string): Promise<string> {
	return fs.mkdtemp(path.join(os.tmpdir(), prefix))
}

async function testSetsIndentationCorrectly(): Promise<void> {
	const ws = await mkTmpWorkspace("hc-si-basic-")
	try {
		const file = path.join(ws, "app.ts")
		await fs.writeFile(file, "function f() {\nconst x = 1\n}\n", "utf-8")

		const executor = createHeadlessExecutor(ws)
		const result = await executor.execute("set_indentation", { path: "app.ts", line: 2, tabs: 1 })

		assert.equal(result.isError, false, `expected success: ${result.content}`)
		assert.equal(await fs.readFile(file, "utf-8"), "function f() {\n\tconst x = 1\n}\n")
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

async function testChangesExistingIndentationNotAdds(): Promise<void> {
	const ws = await mkTmpWorkspace("hc-si-existing-")
	try {
		const file = path.join(ws, "app.ts")
		await fs.writeFile(file, "if (x) {\nreturn 1\n}\n", "utf-8")
		// pre-indent line 2 with 1 tab, then ask for 3 — must REPLACE, not append.
		await fs.writeFile(file, "if (x) {\n\treturn 1\n}\n", "utf-8")

		const executor = createHeadlessExecutor(ws)
		const result = await executor.execute("set_indentation", { path: "app.ts", line: 2, tabs: 3 })

		assert.equal(result.isError, false, `expected success: ${result.content}`)
		assert.equal(await fs.readFile(file, "utf-8"), "if (x) {\n\t\t\treturn 1\n}\n")
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

async function testZeroTabsStripsIndentation(): Promise<void> {
	const ws = await mkTmpWorkspace("hc-si-zero-")
	try {
		const file = path.join(ws, "app.ts")
		await fs.writeFile(file, "if (x) {\n\t\t\treturn 1\n}\n", "utf-8")

		const executor = createHeadlessExecutor(ws)
		const result = await executor.execute("set_indentation", { path: "app.ts", line: 2, tabs: 0 })

		assert.equal(result.isError, false, `expected success: ${result.content}`)
		assert.equal(await fs.readFile(file, "utf-8"), "if (x) {\nreturn 1\n}\n")
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

async function testOnlyTouchesTheTargetLine(): Promise<void> {
	const ws = await mkTmpWorkspace("hc-si-scoped-")
	try {
		const file = path.join(ws, "app.ts")
		await fs.writeFile(file, "line one\nline two\nline three\n", "utf-8")

		const executor = createHeadlessExecutor(ws)
		const result = await executor.execute("set_indentation", { path: "app.ts", line: 2, tabs: 2 })

		assert.equal(result.isError, false, `expected success: ${result.content}`)
		assert.equal(await fs.readFile(file, "utf-8"), "line one\n\t\tline two\nline three\n")
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

async function testOutOfRangeLineFails(): Promise<void> {
	const ws = await mkTmpWorkspace("hc-si-oob-")
	try {
		const file = path.join(ws, "app.ts")
		await fs.writeFile(file, "one\ntwo\n", "utf-8")

		const executor = createHeadlessExecutor(ws)
		const result = await executor.execute("set_indentation", { path: "app.ts", line: 99, tabs: 1 })

		assert.equal(result.isError, true, "out-of-range line must fail")
		assert.match(result.content, /does not exist/i)
		assert.equal(await fs.readFile(file, "utf-8"), "one\ntwo\n", "file must be untouched")
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

async function testAlreadyCorrectIndentationFailsClearly(): Promise<void> {
	const ws = await mkTmpWorkspace("hc-si-noop-")
	try {
		const file = path.join(ws, "app.ts")
		await fs.writeFile(file, "if (x) {\n\t\treturn 1\n}\n", "utf-8")

		const executor = createHeadlessExecutor(ws)
		const result = await executor.execute("set_indentation", { path: "app.ts", line: 2, tabs: 2 })

		assert.equal(result.isError, true, "a no-op request must fail clearly, not silently succeed")
		assert.match(result.content, /already has exactly/i)
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

async function testPreservesLineEndingStyle(): Promise<void> {
	const ws = await mkTmpWorkspace("hc-si-crlf-")
	try {
		const file = path.join(ws, "app.ts")
		await fs.writeFile(file, "function f() {\r\nconst x = 1\r\n}\r\n", "utf-8")

		const executor = createHeadlessExecutor(ws)
		const result = await executor.execute("set_indentation", { path: "app.ts", line: 2, tabs: 1 })

		assert.equal(result.isError, false, `expected success: ${result.content}`)
		assert.equal(await fs.readFile(file, "utf-8"), "function f() {\r\n\tconst x = 1\r\n}\r\n")
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

async function testNotAvailableOnReadOnlyExecutor(): Promise<void> {
	const ws = await mkTmpWorkspace("hc-si-readonly-")
	try {
		await fs.writeFile(path.join(ws, "app.ts"), "one\ntwo\n", "utf-8")
		const executor = createReadOnlyHeadlessExecutor(ws)
		assert.equal(executor.has("set_indentation"), false, "read-only reviewer/QA executors must not register set_indentation")
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

// ─── Runner ──────────────────────────────────────────────────────────────────

const tests: Array<[string, () => Promise<void>]> = [
	["sets a line's indentation to the exact requested tab count", testSetsIndentationCorrectly],
	["replaces existing indentation rather than appending to it", testChangesExistingIndentationNotAdds],
	["tabs: 0 strips all leading indentation", testZeroTabsStripsIndentation],
	["only the target line is modified, all others untouched", testOnlyTouchesTheTargetLine],
	["an out-of-range line number fails clearly, file untouched", testOutOfRangeLineFails],
	["a no-op request (already correct) fails clearly instead of silently succeeding", testAlreadyCorrectIndentationFailsClearly],
	["CRLF line endings are preserved", testPreservesLineEndingStyle],
	["not registered on the read-only reviewer/QA executor", testNotAvailableOnReadOnlyExecutor],
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
			console.error(err instanceof Error ? (err.stack ?? err.message) : String(err))
		}
	}
	if (failed > 0) {
		console.error(`\n${failed} test(s) failed`)
		process.exit(1)
	}
	console.log(`\nAll ${tests.length} set_indentation tests passed`)
}

main().catch((err) => {
	console.error("Test runner crashed:", err)
	process.exit(1)
})
