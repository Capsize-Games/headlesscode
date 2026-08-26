/**
 * Unit tests for the `rename_symbol` code-intelligence tool
 * (src/codeintel/rename-symbol.ts).
 *
 * Plain assert-based script (no test framework, no network), run via
 * `npm test` → `tsx src/codeintel/__tests__/rename-symbol.test.ts`.
 *
 * Fixture mirrors find-references.test.ts's pattern: a small multi-file TS
 * workspace where a symbol is used in several places (plus a lookalike
 * identifier `utilized` that a naive text replace would corrupt). Asserts
 * EXACT resulting file contents — every real site updated, the lookalike
 * untouched — and the atomicity contract: a failure on ANY site leaves NO
 * partial edits on disk.
 */

import assert from "node:assert/strict"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"

import { createHeadlessExecutor } from "../../tools/executor.js"
import { getCodeIntelCache, resetCodeIntelCaches } from "../program.js"
import { renameSymbol } from "../rename-symbol.js"

const FIXTURE_UTIL = `export function util(): number {
	return 1
}

export function helper(n: number): number {
	return n * 2
}
`

const FIXTURE_CONSUMER = `import { util, helper } from "./util.js"

export const a = util()
export const b = util() + helper(1)
// A lookalike identifier a naive text replace would corrupt:
export const utilized = util()
`

const FIXTURE_OTHER = `import { util } from "./util.js"

export const c = util()
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
	const ws = await fs.mkdtemp(path.join(os.tmpdir(), "hc-ci-rename-"))
	await fs.mkdir(path.join(ws, "src"), { recursive: true })
	await fs.writeFile(path.join(ws, "tsconfig.json"), FIXTURE_TSCONFIG)
	await fs.writeFile(path.join(ws, "src", "util.ts"), FIXTURE_UTIL)
	await fs.writeFile(path.join(ws, "src", "consumer.ts"), FIXTURE_CONSUMER)
	await fs.writeFile(path.join(ws, "src", "other.ts"), FIXTURE_OTHER)
	return ws
}

async function readAll(ws: string): Promise<Record<string, string>> {
	const out: Record<string, string> = {}
	for (const rel of ["src/util.ts", "src/consumer.ts", "src/other.ts"]) {
		out[rel] = await fs.readFile(path.join(ws, rel), "utf-8")
	}
	return out
}

async function testRenameAcrossAllSites(): Promise<void> {
	const ws = await mkFixtureWorkspace()
	try {
		resetCodeIntelCaches()
		const executor = createHeadlessExecutor(ws)
		const result = await executor.execute("rename_symbol", {
			path: "src/util.ts",
			line: 1,
			symbol: "util",
			new_name: "compute",
		})

		assert.equal(result.isError, false, `rename should succeed: ${result.content}`)
		assert.match(result.content, /Renamed 'util' → 'compute' across \d+ site\(s\):/, "result announces the rename")

		const files = await readAll(ws)
		assert.equal(files["src/util.ts"], `export function compute(): number {\n\treturn 1\n}\n\nexport function helper(n: number): number {\n\treturn n * 2\n}\n`)
		assert.equal(
			files["src/consumer.ts"],
			`import { compute, helper } from "./util.js"\n\nexport const a = compute()\nexport const b = compute() + helper(1)\n// A lookalike identifier a naive text replace would corrupt:\nexport const utilized = compute()\n`,
			"every real call site updated; import specifier updated; the lookalike 'utilized' must be untouched",
		)
		assert.equal(files["src/other.ts"], `import { compute } from "./util.js"\n\nexport const c = compute()\n`)
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

async function testInvalidNewNameLeavesEverythingUntouched(): Promise<void> {
	const ws = await mkFixtureWorkspace()
	try {
		resetCodeIntelCaches()
		const executor = createHeadlessExecutor(ws)
		const before = await readAll(ws)
		const result = await executor.execute("rename_symbol", {
			path: "src/util.ts",
			line: 1,
			symbol: "util",
			new_name: "not a valid name!",
		})

		assert.equal(result.isError, true, "an invalid identifier must fail")
		assert.match(result.content, /not a valid TypeScript identifier/, "names the reason")
		const after = await readAll(ws)
		assert.deepEqual(after, before, "nothing may change on a refused rename")
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

async function testStaleSnapshotAbortsWithNoPartialWrites(): Promise<void> {
	const ws = await mkFixtureWorkspace()
	try {
		resetCodeIntelCaches()
		// Load the program, then mutate a file on disk WITHOUT triggering a
		// cache rebuild (the intel object is passed straight to renameSymbol).
		// The identifier at the reference site must CHANGE (not just move), so
		// the stale snapshot's span no longer matches on disk.
		const intel = getCodeIntelCache(ws).get()
		await fs.writeFile(
			path.join(ws, "src", "other.ts"),
			`import { util } from "./util.js"\n\nexport const c = unrelated()\n`,
		)

		const before = await readAll(ws)
		await assert.rejects(
			renameSymbol(intel, ws, path.join(ws, "src", "util.ts"), 1, undefined, "util", "compute"),
			/changed since the reference snapshot/,
			"a span that no longer matches the old name must abort",
		)
		const after = await readAll(ws)
		assert.deepEqual(after, before, "the abort must happen BEFORE any write — no partial edits survive")
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

async function testMidWriteFailureRollsBackWrittenFiles(): Promise<void> {
	// Deterministically failing the SECOND write needs a read-only directory,
	// which root ignores — skip under root rather than flake.
	if (typeof process.getuid === "function" && process.getuid() === 0) {
		console.log("  skip mid-write rollback test (running as root; chmod 555 does not block root)")
		return
	}
	const ws = await mkFixtureWorkspace()
	try {
		resetCodeIntelCaches()
		// consumer.ts is written before other.ts (findReferences sorts by file
		// name), so making ONLY other.ts read-only fails exactly the SECOND
		// write, after the first has already landed on disk. (A read-only
		// DIRECTORY would not do this — writing an existing file depends on the
		// file's own mode, not the directory's.)
		const intel = getCodeIntelCache(ws).get()
		const before = await readAll(ws)
		const otherFile = path.join(ws, "src", "other.ts")
		await fs.chmod(otherFile, 0o444)

		try {
			await assert.rejects(
				renameSymbol(intel, ws, path.join(ws, "src", "util.ts"), 1, undefined, "util", "compute"),
				/rolled back/,
				"a mid-write failure must report the rollback",
			)
			const after = await readAll(ws)
			assert.deepEqual(after, before, "the first file's write must be rolled back — no partial rename survives")
		} finally {
			await fs.chmod(otherFile, 0o644)
		}
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

async function main(): Promise<void> {
	const tests: Array<[string, () => Promise<void>]> = [
		["renames every real site across files and leaves lookalike identifiers untouched", testRenameAcrossAllSites],
		["invalid new name is refused with nothing changed", testInvalidNewNameLeavesEverythingUntouched],
		["stale snapshot aborts before any write (no partial edits)", testStaleSnapshotAbortsWithNoPartialWrites],
		["mid-write failure rolls back the files already written", testMidWriteFailureRollsBackWrittenFiles],
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
	console.log(`\nAll ${tests.length} rename_symbol tests passed`)
}

main().catch((err) => {
	console.error("Test runner crashed:", err)
	process.exit(1)
})
