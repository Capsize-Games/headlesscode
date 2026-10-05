/**
 * Unit tests for the `find_implementations` code-intelligence tool
 * (src/codeintel/implementations.ts).
 *
 * Plain assert-based script (no test framework), run via `npm test` →
 * `tsx src/codeintel/__tests__/implementations.test.ts`.
 *
 * Calls findImplementationsHandler directly with a fake ToolContext
 * (executor wiring lands separately). Covers interface members,
 * subclass overrides, the no-implementations message, symbol-arg
 * disambiguation, and the non-TS refusal.
 */

import assert from "node:assert/strict"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"

import type { ToolContext } from "../../engine/types.js"
import { resetCodeIntelCaches } from "../program.js"
import { findImplementationsHandler } from "../implementations.js"

// Line numbers below are 1-based and VERIFIED against the fixture text:
// Shape=1, area=2, Circle=5, Circle.area=6, Square=11, Square.area=12,
// Base=17, Base.greet=18, Child=23, Child.greet=24, helper=29.
const FIXTURE_SHAPES = `export interface Shape {
	area(): number
}

export class Circle implements Shape {
	area(): number {
		return 1
	}
}

export class Square implements Shape {
	area(): number {
		return 4
	}
}

export class Base {
	greet(): string {
		return "hi"
	}
}

export class Child extends Base {
	override greet(): string {
		return "yo"
	}
}

export function helper(value: number): number {
	return value
}
`

function fakeCtx(workspaceRoot: string): ToolContext {
	return { workspaceRoot } as unknown as ToolContext
}

async function mkFixtureWorkspace(): Promise<string> {
	const ws = await fs.mkdtemp(path.join(os.tmpdir(), "hc-ci-impl-"))
	await fs.mkdir(path.join(ws, "src"), { recursive: true })
	await fs.writeFile(path.join(ws, "src", "shapes.ts"), FIXTURE_SHAPES)
	return ws
}

async function testInterfaceMethodImplementations(): Promise<void> {
	const ws = await mkFixtureWorkspace()
	try {
		resetCodeIntelCaches()
		const ctx = fakeCtx(ws)
		const result = findImplementationsHandler(
			{ path: "src/shapes.ts", line: 2, symbol: "area" },
			ctx,
		)
		assert.equal(result.isError, false)
		assert.match(
			result.content,
			/^src\/shapes\.ts:6:\d+ method area/m,
			"Circle.area implementation is returned",
		)
		assert.match(
			result.content,
			/^src\/shapes\.ts:12:\d+ method area/m,
			"Square.area implementation is returned",
		)
		assert.match(
			result.content,
			/— area\(\): number/,
			"go_to_definition-style snippet",
		)
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

async function testSubclassOverride(): Promise<void> {
	const ws = await mkFixtureWorkspace()
	try {
		resetCodeIntelCaches()
		const ctx = fakeCtx(ws)
		const result = findImplementationsHandler(
			{ path: "src/shapes.ts", line: 18, symbol: "greet" },
			ctx,
		)
		assert.equal(result.isError, false)
		assert.match(
			result.content,
			/^src\/shapes\.ts:24:\d+ method greet/m,
			"Child.greet override is returned for Base.greet",
		)
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

async function testNoImplementationsMessage(): Promise<void> {
	const ws = await mkFixtureWorkspace()
	try {
		resetCodeIntelCaches()
		const ctx = fakeCtx(ws)
		// Line 4 is blank: no identifier there, so zero implementations —
		// a clear message, not an error and not a crash.
		const result = findImplementationsHandler(
			{ path: "src/shapes.ts", line: 4 },
			ctx,
		)
		assert.equal(result.isError, false, "no crash, no error flag")
		assert.match(
			result.content,
			/No implementations found/,
			"graceful message when nothing implements the spot",
		)
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

async function testSymbolArgDisambiguation(): Promise<void> {
	const ws = await mkFixtureWorkspace()
	try {
		resetCodeIntelCaches()
		const ctx = fakeCtx(ws)
		// Line 5 holds TWO identifiers (Circle, Shape); the symbol arg
		// must pick which one implementations are resolved for.
		const shapeResult = findImplementationsHandler(
			{ path: "src/shapes.ts", line: 5, symbol: "Shape" },
			ctx,
		)
		assert.match(
			shapeResult.content,
			/src\/shapes\.ts:5:\d+ class Circle/,
			"Shape resolves to the Circle implementor",
		)
		assert.match(
			shapeResult.content,
			/src\/shapes\.ts:11:\d+ class Square/,
			"Shape resolves to the Square implementor",
		)

		const circleResult = findImplementationsHandler(
			{ path: "src/shapes.ts", line: 5, symbol: "Circle" },
			ctx,
		)
		assert.equal(circleResult.isError, false)
		assert.doesNotMatch(
			circleResult.content,
			/Square/,
			"Circle resolves differently from Shape on the same line",
		)
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

async function testNonTsFile(): Promise<void> {
	const ws = await mkFixtureWorkspace()
	try {
		await fs.writeFile(path.join(ws, "notes.md"), "# hi\n")
		resetCodeIntelCaches()
		const ctx = fakeCtx(ws)
		assert.throws(
			() => findImplementationsHandler({ path: "notes.md", line: 1 }, ctx),
			/not a supported file type/,
			"explicit not-supported refusal, never a guessed answer",
		)
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

async function main(): Promise<void> {
	const tests: Array<[string, () => Promise<void>]> = [
		["interface method finds class methods", testInterfaceMethodImplementations],
		["base method finds the subclass override", testSubclassOverride],
		["empty spot gets the graceful message", testNoImplementationsMessage],
		["symbol arg disambiguates one line", testSymbolArgDisambiguation],
		["non-TS file is refused, not guessed", testNonTsFile],
	]

	let failed = 0
	for (const [name, fn] of tests) {
		try {
			await fn()
			console.log(`  ok   ${name}`)
		} catch (err) {
			failed++
			console.error(`  FAIL ${name}`)
			const detail = err instanceof Error ? err.stack ?? err.message : String(err)
			console.error(detail)
		}
	}
	if (failed > 0) {
		console.error(`\n${failed} test(s) failed`)
		process.exit(1)
	}
	console.log(`\nAll ${tests.length} find_implementations tests passed`)
}

main().catch((err) => {
	console.error("Test runner crashed:", err)
	process.exit(1)
})
