/**
 * Unit tests for the `go_to_definition` code-intelligence tool
 * (src/codeintel/).
 *
 * Plain assert-based script (no test framework), run via `npm test` →
 * `tsx src/codeintel/__tests__/go-to-definition.test.ts`.
 *
 * Exercises the tool end-to-end through the real executor. Covers the three
 * hard cases from the spec against small fixtures:
 *   - definition in a `.d.ts` reached through a tsconfig `paths` alias
 *     (returned as its real location, never refused)
 *   - a symbol with no resolvable definition (`any`-typed access) — a clear
 *     "could not resolve" result, not a crash
 *   - multiple candidate definitions (an overloaded function) — ALL returned
 * Plus exact-position resolution (line + character), not just "didn't crash".
 */

import assert from "node:assert/strict"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"

import { createHeadlessExecutor } from "../../tools/executor.js"
import { resetCodeIntelCaches } from "../program.js"

// Line numbers below are 1-based and VERIFIED against the fixture text:
// add=6, PI=10, first overload=18, second overload=19, loose=24,
// unresolvableValue=26. consumer.ts: sum=5, s1=7, w=10, bad=12.
const FIXTURE_MATH = `export interface Point {
	x: number
	y: number
}

export function add(a: number, b: number): number {
	return a + b
}

export const PI = 3.14

export class Shape {
	area(): number {
		return 0
	}
}

export function overloaded(value: string): string
export function overloaded(value: number): number
export function overloaded(value: string | number): string | number {
	return value
}

export const loose: any = 42

export const unresolvableValue = loose.notReal
`

const FIXTURE_TYPES_DTS = `export interface Widget {
	id: string
}

export declare function makeWidget(id: string): Widget
`

// consumer.ts line 5: `const sum = add(1, 2) + PI`
//   1-based columns: add spans 13-15, PI spans 25-26.
const FIXTURE_CONSUMER = `import { add, PI, overloaded, loose } from "./math.js"
import type { Widget } from "@lib/types"
import { makeWidget } from "@lib/types"

const sum = add(1, 2) + PI

const s1: string = overloaded("x")
const s2: number = overloaded(1)

const w: Widget = makeWidget("w1")

const bad = loose.notReal
`

const FIXTURE_TSCONFIG = JSON.stringify(
	{
		compilerOptions: {
			target: "ES2022",
			module: "ESNext",
			moduleResolution: "bundler",
			strict: true,
			paths: {
				"@lib/types": ["./src/types/index.d.ts"],
			},
		},
		include: ["src"],
	},
	null,
	2,
)

async function mkFixtureWorkspace(): Promise<string> {
	const ws = await fs.mkdtemp(path.join(os.tmpdir(), "hc-ci-g2d-"))
	await fs.mkdir(path.join(ws, "src", "types"), { recursive: true })
	await fs.writeFile(path.join(ws, "tsconfig.json"), FIXTURE_TSCONFIG)
	await fs.writeFile(path.join(ws, "src", "math.ts"), FIXTURE_MATH)
	await fs.writeFile(path.join(ws, "src", "types", "index.d.ts"), FIXTURE_TYPES_DTS)
	await fs.writeFile(path.join(ws, "src", "consumer.ts"), FIXTURE_CONSUMER)
	return ws
}

async function testPlainFunctionDefinition(): Promise<void> {
	const ws = await mkFixtureWorkspace()
	try {
		resetCodeIntelCaches()
		const executor = createHeadlessExecutor(ws)
		const result = await executor.execute("go_to_definition", { path: "src/consumer.ts", line: 5, symbol: "add" })

		assert.equal(result.isError, false)
		assert.match(result.content, /^src\/math\.ts:6:\d+ function add/, "resolves to the real function declaration")
		assert.match(result.content, /function add\(a: number, b: number\): number/, "snippet shows the definition line")
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

async function testCharacterDisambiguation(): Promise<void> {
	const ws = await mkFixtureWorkspace()
	try {
		resetCodeIntelCaches()
		const executor = createHeadlessExecutor(ws)
		// Line 5 has THREE identifiers (sum, add, PI); character must pick the
		// right one: 14 → add (spans 13-15), 25 → PI (spans 25-26).
		const addDef = await executor.execute("go_to_definition", { path: "src/consumer.ts", line: 5, character: 14 })
		assert.match(addDef.content, /^src\/math\.ts:6:\d+ function add/, "character 14 selects add")

		const piDef = await executor.execute("go_to_definition", { path: "src/consumer.ts", line: 5, character: 25 })
		assert.match(piDef.content, /^src\/math\.ts:10:\d+ const PI/, "character 25 selects PI, not add")
		assert.doesNotMatch(piDef.content, /function add/, "the two characters must resolve differently")
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

async function testDefinitionInDtsThroughPathsAlias(): Promise<void> {
	const ws = await mkFixtureWorkspace()
	try {
		resetCodeIntelCaches()
		const executor = createHeadlessExecutor(ws)
		// `Widget` is imported from "@lib/types" — a tsconfig paths alias into
		// src/types/index.d.ts. The definition lives OUTSIDE src/math.ts but
		// must be returned as its real location, never refused.
		const widgetDef = await executor.execute("go_to_definition", { path: "src/consumer.ts", line: 2, symbol: "Widget" })
		assert.equal(widgetDef.isError, false)
		assert.match(widgetDef.content, /src\/types\/index\.d\.ts:1:\d+ interface Widget/, "paths alias resolves to the real .d.ts")

		const makeWidgetDef = await executor.execute("go_to_definition", { path: "src/consumer.ts", line: 3, symbol: "makeWidget" })
		assert.equal(makeWidgetDef.isError, false)
		assert.match(makeWidgetDef.content, /src\/types\/index\.d\.ts:5:\d+ function makeWidget/, "declare function in .d.ts resolves")
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

async function testOverloadReturnsAllDefinitions(): Promise<void> {
	const ws = await mkFixtureWorkspace()
	try {
		resetCodeIntelCaches()
		const executor = createHeadlessExecutor(ws)
		// Line 7 calls the overloaded function. ALL definitions must come back,
		// never one silently picked.
		const result = await executor.execute("go_to_definition", { path: "src/consumer.ts", line: 7, symbol: "overloaded" })
		assert.equal(result.isError, false)
		assert.match(result.content, /^src\/math\.ts:18:\d+ function overloaded/m, "first overload signature")
		assert.match(result.content, /^src\/math\.ts:19:\d+ function overloaded/m, "second overload signature")
		const lines = result.content.split("\n")
		assert.ok(lines.length >= 3, `expected all overloads, got:\n${result.content}`)
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

async function testUnresolvableSymbol(): Promise<void> {
	const ws = await mkFixtureWorkspace()
	try {
		resetCodeIntelCaches()
		const executor = createHeadlessExecutor(ws)
		// `loose` is `any`, so `notReal` has no resolvable definition.
		const result = await executor.execute("go_to_definition", { path: "src/consumer.ts", line: 12, symbol: "notReal" })
		assert.equal(result.isError, false, "unresolvable is a clear message, not an error")
		assert.match(result.content, /Could not resolve/, "message names the failure mode")
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

async function testNonTsFile(): Promise<void> {
	const ws = await mkFixtureWorkspace()
	try {
		await fs.writeFile(path.join(ws, "notes.md"), "# hi\n")
		resetCodeIntelCaches()
		const executor = createHeadlessExecutor(ws)
		const result = await executor.execute("go_to_definition", { path: "notes.md", line: 1, symbol: "hi" })
		assert.equal(result.isError, true)
		assert.match(result.content, /not a supported file type/, "explicit not-supported result, never a crash")
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

async function testMissingFile(): Promise<void> {
	const ws = await mkFixtureWorkspace()
	try {
		resetCodeIntelCaches()
		const executor = createHeadlessExecutor(ws)
		const result = await executor.execute("go_to_definition", { path: "src/nope.ts", line: 1, symbol: "x" })
		assert.equal(result.isError, true)
		assert.match(result.content, /cannot stat/, "missing file errors clearly")
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

async function main(): Promise<void> {
	const tests: Array<[string, () => Promise<void>]> = [
		["plain function resolves to its declaration", testPlainFunctionDefinition],
		["character disambiguates symbols on one line", testCharacterDisambiguation],
		["definition in a .d.ts via tsconfig paths alias resolves", testDefinitionInDtsThroughPathsAlias],
		["overloaded function returns ALL definitions", testOverloadReturnsAllDefinitions],
		["unresolvable (any-typed) symbol gets a clear message", testUnresolvableSymbol],
		["non-TS file returns the not-supported result", testNonTsFile],
		["missing file errors clearly", testMissingFile],
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
	console.log(`\nAll ${tests.length} go_to_definition tests passed`)
}

main().catch((err) => {
	console.error("Test runner crashed:", err)
	process.exit(1)
})
