/**
 * Unit tests for the `find_references` code-intelligence tool
 * (src/codeintel/).
 *
 * Plain assert-based script (no test framework), run via `npm test` →
 * `tsx src/codeintel/__tests__/find-references.test.ts`.
 *
 * Asserts EXACT results (not just "didn't crash"): a known usage count for a
 * symbol with few usages, and — critically — that a symbol with MANY usages
 * is capped at MAX_REFERENCES with the "N more references not shown" note,
 * so one query can never dump hundreds of lines into the model's context.
 *
 * Usages are written as `m.util()` (namespace import) deliberately: a NAMED
 * import specifier (`import { util }`) is itself counted by the language
 * service as a reference, which would make the counts depend on import style.
 */

import assert from "node:assert/strict"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"

import { createHeadlessExecutor } from "../../tools/executor.js"
import { resetCodeIntelCaches } from "../program.js"
import { MAX_REFERENCES } from "../find-references.js"

const FIXTURE_UTIL = `export function util(): number {
	return 1
}

export function helper(n: number): number {
	return n * 2
}
`

/** A consumer with `usageCount` call sites of `util` plus one `helper` use. */
function makeUsages(usageCount: number): string {
	const lines: string[] = [`import * as m from "./util.js"`, ""]
	for (let i = 0; i < usageCount; i++) {
		lines.push(`const v${i} = m.util()`)
	}
	lines.push(`const h = m.helper(1)`, "")
	return lines.join("\n")
}

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

async function mkFixtureWorkspace(usageCount: number): Promise<string> {
	const ws = await fs.mkdtemp(path.join(os.tmpdir(), "hc-ci-refs-"))
	await fs.mkdir(path.join(ws, "src"), { recursive: true })
	await fs.writeFile(path.join(ws, "tsconfig.json"), FIXTURE_TSCONFIG)
	await fs.writeFile(path.join(ws, "src", "util.ts"), FIXTURE_UTIL)
	await fs.writeFile(path.join(ws, "src", "usages.ts"), makeUsages(usageCount))
	return ws
}

async function testExactReferenceSites(): Promise<void> {
	const ws = await mkFixtureWorkspace(3)
	try {
		resetCodeIntelCaches()
		const executor = createHeadlessExecutor(ws)
		const result = await executor.execute("find_references", { path: "src/util.ts", line: 1, symbol: "util" })

		assert.equal(result.isError, false)
		const lines = result.content.split("\n")
		// Declaration (util.ts:1, a write) + 3 call sites in usages.ts.
		// Sorted by file name first: "src/usages.ts" < "src/util.ts".
		assert.equal(lines.length, 4, `expected declaration + 3 usages, got:\n${result.content}`)
		assert.match(lines[0]!, /^src\/usages\.ts:3 — const v0 = m\.util\(\)$/, "first usage site, compact file:line + snippet")
		assert.match(lines[1]!, /^src\/usages\.ts:4 — const v1 = m\.util\(\)$/, "second usage site")
		assert.match(lines[2]!, /^src\/usages\.ts:5 — const v2 = m\.util\(\)$/, "third usage site")
		assert.match(lines[3]!, /^src\/util\.ts:1 \(write\) — export function util\(\)/, "declaration site is included and marked (write)")
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

async function testCapOnManyUsages(): Promise<void> {
	const many = MAX_REFERENCES + 25 // 75 call sites — well past the cap
	const ws = await mkFixtureWorkspace(many)
	try {
		resetCodeIntelCaches()
		const executor = createHeadlessExecutor(ws)
		const result = await executor.execute("find_references", { path: "src/util.ts", line: 1, symbol: "util" })

		assert.equal(result.isError, false)
		const lines = result.content.split("\n")
		// MAX_REFERENCES shown + 1 overflow trailer line. Never the full set.
		assert.equal(lines.length, MAX_REFERENCES + 1, `output must be capped at MAX_REFERENCES lines, got ${lines.length}`)
		const trailer = lines[lines.length - 1]!
		assert.match(trailer, /^…\d+ more reference\(s\) not shown — narrow your search/, "cap is announced, not silent")
		const overflow = many + 1 - MAX_REFERENCES // declaration included in the total
		assert.match(trailer, new RegExp(`^…${overflow} more reference`), "overflow count is exact")
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

async function testNoReferences(): Promise<void> {
	const ws = await mkFixtureWorkspace(1)
	try {
		resetCodeIntelCaches()
		// `loose.notReal` — `loose` is any, so there are no real references.
		const fixture = `import * as m from "./util.js"\n\nexport const loose: any = 42\nexport const bad = loose.notReal\n`
		await fs.writeFile(path.join(ws, "src", "any.ts"), fixture)
		const executor = createHeadlessExecutor(ws)
		const result = await executor.execute("find_references", { path: "src/any.ts", line: 4, symbol: "notReal" })

		assert.equal(result.isError, false)
		assert.match(result.content, /No references found/, "no-reference is a clear message, not a crash")
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

async function testNonTsFile(): Promise<void> {
	const ws = await mkFixtureWorkspace(1)
	try {
		await fs.writeFile(path.join(ws, "data.csv"), "a,b\n1,2\n")
		resetCodeIntelCaches()
		const executor = createHeadlessExecutor(ws)
		const result = await executor.execute("find_references", { path: "data.csv", line: 1, symbol: "a" })
		assert.equal(result.isError, true)
		assert.match(result.content, /not a supported file type/, "explicit not-supported result")
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

async function main(): Promise<void> {
	const tests: Array<[string, () => Promise<void>]> = [
		["returns exact reference sites for a symbol with few usages", testExactReferenceSites],
		["caps output on a symbol with many usages and announces the overflow", testCapOnManyUsages],
		["no-resolvable-references gets a clear message", testNoReferences],
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
	console.log(`\nAll ${tests.length} find_references tests passed`)
}

main().catch((err) => {
	console.error("Test runner crashed:", err)
	process.exit(1)
})
