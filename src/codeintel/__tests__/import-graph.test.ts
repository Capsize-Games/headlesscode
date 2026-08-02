/**
 * Unit tests for the `import_graph` code-intelligence tool (src/codeintel/).
 *
 * Plain assert-based script (no test framework), run via `npm test` →
 * `tsx src/codeintel/__tests__/import-graph.test.ts`.
 *
 * A small fixture with a real import chain (including a CYCLE — a.ts ↔ b.ts —
 * a type-only import, a re-export, and an unresolvable specifier) to assert
 * exact edges: what a file imports RESOLVED to real paths, and what imports
 * it. Also proves reverse lookups reuse the cached program (no per-call
 * rebuild), via the real program load counter — mirroring how caching behavior
 * is proven elsewhere in this project.
 */

import assert from "node:assert/strict"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"

import { createHeadlessExecutor } from "../../tools/executor.js"
import { getCodeIntelCache, resetCodeIntelCaches } from "../program.js"

const FIXTURE_A = `import { b1 } from "./b.js"
import type { c1 } from "./c.js"
import fs from "node:fs"

export const a1 = 1
`

const FIXTURE_B = `export { c1 } from "./c.js"
import { a1 } from "./a.js"

export const b1 = 2
`

const FIXTURE_C = `export const c1 = 1
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
	const ws = await fs.mkdtemp(path.join(os.tmpdir(), "hc-ci-graph-"))
	await fs.mkdir(path.join(ws, "src"), { recursive: true })
	await fs.writeFile(path.join(ws, "tsconfig.json"), FIXTURE_TSCONFIG)
	await fs.writeFile(path.join(ws, "src", "a.ts"), FIXTURE_A)
	await fs.writeFile(path.join(ws, "src", "b.ts"), FIXTURE_B)
	await fs.writeFile(path.join(ws, "src", "c.ts"), FIXTURE_C)
	return ws
}

async function testImportsResolvedToRealPaths(): Promise<void> {
	const ws = await mkFixtureWorkspace()
	try {
		resetCodeIntelCaches()
		const executor = createHeadlessExecutor(ws)
		const result = await executor.execute("import_graph", { path: "src/a.ts" })

		assert.equal(result.isError, false)
		const lines = result.content.split("\n")

		assert.match(lines[0]!, /^imports \(3\):/, "a.ts has 3 import edges")
		assert.ok(lines.some((l) => l === "  import ./b.js -> src/b.ts"), `b.js must resolve to a real path:\n${result.content}`)
		assert.ok(lines.some((l) => l === "  import type ./c.js -> src/c.ts"), "type-only import resolves and is marked type")
		assert.ok(lines.some((l) => l === "  import node:fs -> (unresolved: node:fs)"), "unresolvable specifier is flagged, not guessed")

		assert.match(lines.find((l) => l.startsWith("imported by"))!, /^imported by \(1\):/, "the cycle means b.ts imports a.ts")
		assert.ok(lines.some((l) => l === "  src/b.ts"), "b.ts is the importer")
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

async function testReverseLookupIncludingReExportAndTypeImport(): Promise<void> {
	const ws = await mkFixtureWorkspace()
	try {
		resetCodeIntelCaches()
		const executor = createHeadlessExecutor(ws)
		const result = await executor.execute("import_graph", { path: "src/c.ts" })

		assert.equal(result.isError, false)
		const lines = result.content.split("\n")

		assert.match(lines[0]!, /^imports \(0\):/, "c.ts imports nothing")
		assert.ok(lines.some((l) => l === "  (none)"), "empty imports section is explicit")
		assert.match(
			lines.find((l) => l.startsWith("imported by"))!,
			/^imported by \(2\):/,
			"a.ts (type import) and b.ts (re-export) both import c.ts",
		)
		assert.ok(lines.some((l) => l === "  src/a.ts"), "type-only import counts as an importer")
		assert.ok(lines.some((l) => l === "  src/b.ts"), "re-export counts as an importer")
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

async function testProgramCacheReusedAcrossCalls(): Promise<void> {
	const ws = await mkFixtureWorkspace()
	try {
		resetCodeIntelCaches()
		const executor = createHeadlessExecutor(ws)
		const cache = getCodeIntelCache(ws)

		await executor.execute("import_graph", { path: "src/a.ts" })
		assert.equal(cache.programLoadCount, 1, "first call loads the program")
		await executor.execute("import_graph", { path: "src/b.ts" })
		assert.equal(cache.programLoadCount, 1, "second call must reuse the cached program, not rebuild")

		// Now invalidate for real: a covered file changes → next call rebuilds.
		await new Promise((r) => setTimeout(r, 5))
		await fs.writeFile(path.join(ws, "src", "a.ts"), `${FIXTURE_A}\nexport const a2 = 2\n`)
		await executor.execute("import_graph", { path: "src/a.ts" })
		assert.equal(cache.programLoadCount, 2, "a changed covered file must trigger exactly one rebuild")

		const after = await executor.execute("import_graph", { path: "src/a.ts" })
		assert.equal(cache.programLoadCount, 2, "subsequent calls reuse the rebuilt program")
		assert.match(after.content, /^imports \(3\):/, "rebuilt program still serves correct answers")
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

async function testNonTsFile(): Promise<void> {
	const ws = await mkFixtureWorkspace()
	try {
		await fs.writeFile(path.join(ws, "README.md"), "# fixture\n")
		resetCodeIntelCaches()
		const executor = createHeadlessExecutor(ws)
		const result = await executor.execute("import_graph", { path: "README.md" })
		assert.equal(result.isError, true)
		assert.match(result.content, /not a supported file type/, "explicit not-supported result")
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

async function main(): Promise<void> {
	const tests: Array<[string, () => Promise<void>]> = [
		["imports resolve to real file paths (incl. type-only and unresolved)", testImportsResolvedToRealPaths],
		["reverse lookup sees type imports and re-exports", testReverseLookupIncludingReExportAndTypeImport],
		["program cache is reused across calls and invalidated on file change", testProgramCacheReusedAcrossCalls],
		["non-TS file returns the not-supported result", testNonTsFile],
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
	console.log(`\nAll ${tests.length} import_graph tests passed`)
}

main().catch((err) => {
	console.error("Test runner crashed:", err)
	process.exit(1)
})
