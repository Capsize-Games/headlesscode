/**
 * Wiring test for the five newer code-intelligence tools
 * (`get_diagnostics`, `type_at_position`, `call_hierarchy`,
 * `workspace_symbol`, `find_implementations`).
 *
 * Plain assert-based script (no test framework), run via `npm test` →
 * `tsx src/codeintel/__tests__/registration.test.ts`.
 *
 * The per-tool test files exercise handlers directly; THIS file proves the
 * tools are actually reachable end to end: registered on the real headless
 * executor, executable through it, and advertised in CODE_INTEL_TOOLS.
 */

import assert from "node:assert/strict"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"

import { createHeadlessExecutor } from "../../tools/executor.js"
import { resetCodeIntelCaches } from "../program.js"
import { CODE_INTEL_TOOL_NAMES } from "../tools.js"
import { runMain } from "../../test-runner.js"

// Line numbers below are 1-based and VERIFIED against the fixture text:
// Shape=1, area=2, Circle=5, Circle.area=6, double=11, quadruple=15
// (calls double twice on line 16).
const FIXTURE_OPS = `export interface Shape {
	area(): number
}

export class Circle implements Shape {
	area(): number {
		return 1
	}
}

export function double(n: number): number {
	return n * 2
}

export function quadruple(n: number): number {
	return double(double(n))
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

const NEW_TOOLS = [
	"get_diagnostics",
	"type_at_position",
	"call_hierarchy",
	"workspace_symbol",
	"find_implementations",
]

async function mkFixtureWorkspace(): Promise<string> {
	const ws = await fs.mkdtemp(path.join(os.tmpdir(), "hc-ci-reg-"))
	await fs.mkdir(path.join(ws, "src"), { recursive: true })
	await fs.writeFile(path.join(ws, "tsconfig.json"), FIXTURE_TSCONFIG)
	await fs.writeFile(path.join(ws, "src", "ops.ts"), FIXTURE_OPS)
	resetCodeIntelCaches()
	return ws
}

async function testAllRegistered(): Promise<void> {
	const ws = await mkFixtureWorkspace()
	try {
		const executor = createHeadlessExecutor(ws)
		for (const name of NEW_TOOLS) {
			assert.equal(
				executor.has(name),
				true,
				`${name} is registered`,
			)
		}
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

async function testDiagnosticsThroughExecutor(): Promise<void> {
	const ws = await mkFixtureWorkspace()
	try {
		const executor = createHeadlessExecutor(ws)
		const result = await executor.execute(
			"get_diagnostics",
			{ path: "src/ops.ts" },
		)
		assert.equal(result.isError, false)
		assert.match(result.content, /0 error\(s\) in src\/ops\.ts/)
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

async function testHoverThroughExecutor(): Promise<void> {
	const ws = await mkFixtureWorkspace()
	try {
		const executor = createHeadlessExecutor(ws)
		const result = await executor.execute(
			"type_at_position",
			{ path: "src/ops.ts", line: 16, symbol: "double" },
		)
		assert.equal(result.isError, false)
		assert.match(result.content, /double\(n: number\): number/)
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

async function testWorkspaceSymbolThroughExecutor(): Promise<void> {
	const ws = await mkFixtureWorkspace()
	try {
		const executor = createHeadlessExecutor(ws)
		const result = await executor.execute(
			"workspace_symbol",
			{ query: "quad" },
		)
		assert.equal(result.isError, false)
		assert.match(
			result.content,
			/src\/ops\.ts:15 function quadruple/,
		)
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

async function testImplementationsThroughExecutor(): Promise<void> {
	const ws = await mkFixtureWorkspace()
	try {
		const executor = createHeadlessExecutor(ws)
		const result = await executor.execute(
			"find_implementations",
			{ path: "src/ops.ts", line: 2, symbol: "area" },
		)
		assert.equal(result.isError, false)
		assert.match(result.content, /src\/ops\.ts:6:\d+ method area/)
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

async function testCallHierarchyThroughExecutor(): Promise<void> {
	const ws = await mkFixtureWorkspace()
	try {
		const executor = createHeadlessExecutor(ws)
		const result = await executor.execute(
			"call_hierarchy",
			{
				path: "src/ops.ts",
				line: 11,
				symbol: "double",
				direction: "callers",
			},
		)
		assert.equal(result.isError, false)
		assert.match(
			result.content,
			/quadruple -> src\/ops\.ts:11 double/,
		)
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

async function testAdvertisedInToolList(): Promise<void> {
	assert.equal(CODE_INTEL_TOOL_NAMES.length, 9)
	for (const name of NEW_TOOLS) {
		assert.ok(
			CODE_INTEL_TOOL_NAMES.includes(name),
			`${name} is advertised`,
		)
	}
}

const tests: Array<[string, () => Promise<void>]> = [
	["all five tools are registered", testAllRegistered],
	["get_diagnostics runs via executor", testDiagnosticsThroughExecutor],
	["type_at_position runs via executor", testHoverThroughExecutor],
	[
		"workspace_symbol runs via executor",
		testWorkspaceSymbolThroughExecutor,
	],
	[
		"find_implementations runs via executor",
		testImplementationsThroughExecutor,
	],
	["call_hierarchy runs via executor", testCallHierarchyThroughExecutor],
	["all five are in CODE_INTEL_TOOLS", testAdvertisedInToolList],
]

runMain("registration", tests)
