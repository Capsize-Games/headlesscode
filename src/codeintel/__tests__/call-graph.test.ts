/**
 * Unit tests for the call-graph extraction (src/codeintel/call-graph.ts —
 * Phase 2 of the codemap, issue #18).
 *
 * Plain assert-based script (no test framework), run via `npm test` →
 * `tsx src/codeintel/__tests__/call-graph.test.ts`.
 *
 * A small fixture with real cross-file calls — a plain imported function, a
 * constructor call, a method call on an instance, and a same-file call — to
 * prove call targets resolve to the callee's DEFINING file via the real TS
 * checker (never text matching), and that the graph is cached per program.
 */

import assert from "node:assert/strict"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"

import { getCallGraph } from "../call-graph.js"
import { getCodeIntelCache, resetCodeIntelCaches } from "../program.js"

const FIXTURE_A = `import { greet, Greeter } from "./b.js"

export function run(): string {
  const g = new Greeter("hi")
  return greet(g.name()) + local()
}

function local(): string {
  return "!"
}
`

const FIXTURE_B = `export function greet(name: string): string {
  return "hello " + name
}

export class Greeter {
  constructor(private prefix: string) {}
  name(): string {
    return this.prefix
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
	const ws = await fs.mkdtemp(path.join(os.tmpdir(), "hc-ci-call-"))
	await fs.mkdir(path.join(ws, "src"), { recursive: true })
	await fs.writeFile(path.join(ws, "tsconfig.json"), FIXTURE_TSCONFIG)
	await fs.writeFile(path.join(ws, "src", "a.ts"), FIXTURE_A)
	await fs.writeFile(path.join(ws, "src", "b.ts"), FIXTURE_B)
	return ws
}

async function testCallTargetsResolveToDefiningFile(): Promise<void> {
	const ws = await mkFixtureWorkspace()
	try {
		resetCodeIntelCaches()
		const intel = getCodeIntelCache(ws).get()
		const graph = getCallGraph(intel)

		const a = path.join(ws, "src", "a.ts")
		const b = path.join(ws, "src", "b.ts")
		const aCalls = graph.get(a)
		assert.ok(aCalls !== undefined, "a.ts must have call sites")

		const callees = aCalls!.map((c) => c.callee)
		assert.ok(callees.includes("greet"), `imported function call is recorded:\n${callees.join(", ")}`)
		assert.ok(callees.includes("Greeter"), `constructor call is recorded:\n${callees.join(", ")}`)
		assert.ok(callees.includes("g.name"), `instance method call is recorded:\n${callees.join(", ")}`)
		assert.ok(callees.includes("local"), `same-file call is recorded:\n${callees.join(", ")}`)

		// Every call lands on the callee's real defining file.
		for (const c of aCalls!) {
			assert.ok(c.resolvedFile !== undefined, `${c.callee} must resolve to a declaration`)
			if (c.callee === "local") {
				assert.equal(c.resolvedFile, a, "same-file call resolves to the same file")
			} else {
				assert.equal(c.resolvedFile, b, `${c.callee} resolves to its defining file b.ts`)
			}
		}

		// The graph is cached alongside the program (same object, no rescan).
		assert.equal(getCallGraph(intel), graph, "call graph is cached per program")
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

async function main(): Promise<void> {
	const tests: Array<[string, () => Promise<void>]> = [
		["call targets resolve to their defining file via the TS checker", testCallTargetsResolveToDefiningFile],
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
	console.log(`\nAll ${tests.length} call-graph tests passed`)
}

main().catch((err) => {
	console.error("Test runner crashed:", err)
	process.exit(1)
})
