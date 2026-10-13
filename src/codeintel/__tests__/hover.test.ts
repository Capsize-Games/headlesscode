/**
 * Unit tests for the `type_at_position` code-intelligence tool
 * (src/codeintel/hover.ts).
 *
 * Plain assert-based script (no test framework), run via `npx tsx
 * src/codeintel/__tests__/hover.test.ts`. Calls the handler directly with
 * a fake ToolContext (executor wiring lands later).
 */

import assert from "node:assert/strict"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"

import type { ToolContext } from "../../engine/types.js"
import { typeAtPositionHandler } from "../hover.js"
import { resetCodeIntelCaches } from "../program.js"
import { runMain } from "../../test-runner.js"

// Line numbers below are 1-based and VERIFIED against the fixture text:
// lib.ts: doc=1-6, add=7, greeting=11. main.ts: import=1, sum=3, shout=5.
const FIXTURE_LIB = `/**
 * Adds two numbers together.
 *
 * @param a the first addend
 * @param b the second addend
 */
export function add(a: number, b: number): number {
	return a + b
}

export const greeting = "hello"
`

const FIXTURE_MAIN = `import { add, greeting } from "./lib.js"

const sum = add(1, 2)

const shout = greeting.toUpperCase()
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
	const ws = await fs.mkdtemp(path.join(os.tmpdir(), "hc-ci-hover-"))
	await fs.mkdir(path.join(ws, "src"), { recursive: true })
	await fs.writeFile(path.join(ws, "tsconfig.json"), FIXTURE_TSCONFIG)
	await fs.writeFile(path.join(ws, "src", "lib.ts"), FIXTURE_LIB)
	await fs.writeFile(path.join(ws, "src", "main.ts"), FIXTURE_MAIN)
	return ws
}

function ctxFor(ws: string): ToolContext {
	return { workspaceRoot: ws } as ToolContext
}

async function testInferredConstType(): Promise<void> {
	const ws = await mkFixtureWorkspace()
	try {
		resetCodeIntelCaches()
		const result = typeAtPositionHandler(
			{ path: "src/main.ts", line: 5, symbol: "greeting" },
			ctxFor(ws),
		)
		assert.equal(result.isError, false)
		assert.match(result.content, /greeting/, "hover names the symbol")
		assert.match(result.content, /hello/, "inferred literal type text appears")
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

async function testFunctionSignature(): Promise<void> {
	const ws = await mkFixtureWorkspace()
	try {
		resetCodeIntelCaches()
		const result = typeAtPositionHandler(
			{ path: "src/main.ts", line: 3, symbol: "add" },
			ctxFor(ws),
		)
		assert.equal(result.isError, false)
		const sig = /add\(a: number, b: number\): number/
		assert.match(result.content, sig, "full signature appears")
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

async function testImportSpecifierResolves(): Promise<void> {
	const ws = await mkFixtureWorkspace()
	try {
		resetCodeIntelCaches()
		// Hovering the name inside the import clause resolves through to
		// the real declaration in the other file.
		const result = typeAtPositionHandler(
			{ path: "src/main.ts", line: 1, symbol: "add" },
			ctxFor(ws),
		)
		assert.equal(result.isError, false)
		const sig = /\(a: number, b: number\): number/
		assert.match(result.content, sig, "signature via the import")
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

async function testDocsAndTags(): Promise<void> {
	const ws = await mkFixtureWorkspace()
	try {
		resetCodeIntelCaches()
		const result = typeAtPositionHandler(
			{ path: "src/lib.ts", line: 7, symbol: "add" },
			ctxFor(ws),
		)
		assert.equal(result.isError, false)
		const doc = /Adds two numbers together/
		assert.match(result.content, doc, "doc comment follows signature")
		assert.match(result.content, /@param/, "JSDoc tags are included")
		assert.match(result.content, /first addend/, "tag body text appears")
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

async function testNoIdentifierGraceful(): Promise<void> {
	const ws = await mkFixtureWorkspace()
	try {
		resetCodeIntelCaches()
		// Line 2 of main.ts is blank: no identifier, so a clear message.
		const result = typeAtPositionHandler(
			{ path: "src/main.ts", line: 2 },
			ctxFor(ws),
		)
		const msg = "no identifier is a message, not an error"
		assert.equal(result.isError, false, msg)
		const mode = "message names the failure mode"
		assert.match(result.content, /Could not resolve/, mode)
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

const tests: Array<[string, () => Promise<void>]> = [
	["inferred-type const shows its type text", testInferredConstType],
	["function use shows the full signature", testFunctionSignature],
	[
		"import specifier resolves through the import",
		testImportSpecifierResolves,
	],
	["docs and JSDoc tags follow the signature", testDocsAndTags],
	["blank spot yields the graceful message", testNoIdentifierGraceful],
]

runMain("type_at_position", tests)
