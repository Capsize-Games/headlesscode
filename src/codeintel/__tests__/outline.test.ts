/**
 * Unit tests for the `outline` code-intelligence tool (src/codeintel/).
 *
 * Plain assert-based script (no test framework), run via `npm test` →
 * `tsx src/codeintel/__tests__/outline.test.ts`.
 *
 * Exercises the tool end-to-end through the real executor (the same wiring a
 * session uses: IMPLEMENTED_TOOLS registration + error wrapping) against a
 * small fixture workspace with known structure, and asserts the EXACT output
 * lines — not just "didn't crash": line numbers, kinds, and signatures must
 * all match the fixture, and the kind keyword must not be duplicated in the
 * signature (`function export function add(...)` is a bug).
 */

import assert from "node:assert/strict"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"

import { createHeadlessExecutor } from "../../tools/executor.js"
import { resetCodeIntelCaches } from "../program.js"

const FIXTURE_MATH = `export interface Point {
	x: number
	y: number
}

export type PointList = Point[]

export function add(a: number, b: number): number {
	return a + b
}

export const PI = 3.14

export const DEFAULT_NAME: string = "shape"

export class Shape {
	name = "shape"
	area(): number {
		return 0
	}
}
`

const FIXTURE_TSCONFIG = JSON.stringify(
	{
		compilerOptions: {
			target: "ES2022",
			module: "ESNext",
			moduleResolution: "bundler",
			strict: true,
		},
		include: ["src"],
	},
	null,
	2,
)

async function mkFixtureWorkspace(): Promise<string> {
	const ws = await fs.mkdtemp(path.join(os.tmpdir(), "hc-ci-outline-"))
	await fs.mkdir(path.join(ws, "src"), { recursive: true })
	await fs.writeFile(path.join(ws, "tsconfig.json"), FIXTURE_TSCONFIG)
	await fs.writeFile(path.join(ws, "src", "math.ts"), FIXTURE_MATH)
	return ws
}

async function testOutlineExactStructure(): Promise<void> {
	const ws = await mkFixtureWorkspace()
	try {
		resetCodeIntelCaches()
		const executor = createHeadlessExecutor(ws)
		const result = await executor.execute("outline", { path: "src/math.ts" })

		assert.equal(result.isError, false, "outline of a TS file must succeed")
		assert.match(result.content, /^Outline of src\/math\.ts:/, "header names the file")

		const lines = result.content.split("\n").slice(1)
		const expected = [
			"1 interface Point",
			"  2 property x: number",
			"  3 property y: number",
			"6 type PointList = Point[]",
			"8 function add(a: number, b: number): number",
			"12 const PI",
			"14 const DEFAULT_NAME: string",
			"16 class Shape",
			"  17 property name = \"shape\"",
			"  18 method area(): number",
		]
		assert.deepEqual(lines, expected, "outline must match the fixture structure exactly")
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

async function testOutlineSignatureHasNoBody(): Promise<void> {
	const ws = await mkFixtureWorkspace()
	try {
		resetCodeIntelCaches()
		const executor = createHeadlessExecutor(ws)
		const result = await executor.execute("outline", { path: "src/math.ts" })

		assert.doesNotMatch(result.content, /return a \+ b/, "function bodies must not leak into signatures")
		assert.doesNotMatch(result.content, /return 0/, "method bodies must not leak into signatures")
		assert.doesNotMatch(result.content, /function export function/, "kind keyword must not be duplicated")
		assert.doesNotMatch(result.content, /class export class/, "kind keyword must not be duplicated for classes")
		assert.doesNotMatch(result.content, /interface export interface/, "kind keyword must not be duplicated for interfaces")
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

async function testOutlineMissingFile(): Promise<void> {
	const ws = await mkFixtureWorkspace()
	try {
		resetCodeIntelCaches()
		const executor = createHeadlessExecutor(ws)
		const result = await executor.execute("outline", { path: "src/nope.ts" })

		assert.equal(result.isError, true, "missing file must be an error")
		assert.match(result.content, /cannot stat/, "error names the missing file")
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

async function testOutlineUnsupportedFileType(): Promise<void> {
	const ws = await mkFixtureWorkspace()
	try {
		await fs.writeFile(path.join(ws, "notes.md"), "# hello\n")
		resetCodeIntelCaches()
		const executor = createHeadlessExecutor(ws)
		const result = await executor.execute("outline", { path: "notes.md" })

		assert.equal(result.isError, true, "non-TS file must be an error, not a guessed answer")
		assert.match(result.content, /not a supported file type/, "error is explicit about the file type")
		assert.doesNotMatch(result.content, /No declarations found/, "must NOT look like an empty outline")
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

async function testOutlinePathTraversalRejected(): Promise<void> {
	const ws = await mkFixtureWorkspace()
	try {
		resetCodeIntelCaches()
		const executor = createHeadlessExecutor(ws)
		const result = await executor.execute("outline", { path: "../outside.ts" })

		assert.equal(result.isError, true, "path escaping the workspace must be rejected")
		assert.match(result.content, /workspace/i, "error mentions the workspace boundary")
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

async function main(): Promise<void> {
	const tests: Array<[string, () => Promise<void>]> = [
		["outline returns the exact fixture structure", testOutlineExactStructure],
		["outline signatures exclude bodies and duplicate keywords", testOutlineSignatureHasNoBody],
		["outline of a missing file errors", testOutlineMissingFile],
		["outline of a non-TS file returns the not-supported error", testOutlineUnsupportedFileType],
		["outline rejects paths escaping the workspace", testOutlinePathTraversalRejected],
	]

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
	console.log(`\nAll ${tests.length} outline tests passed`)
}

main().catch((err) => {
	console.error("Test runner crashed:", err)
	process.exit(1)
})
