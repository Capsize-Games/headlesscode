/**
 * Tests for the deterministic codemap build (src/codemap/ — issues #17/#18).
 *
 * Plain assert-based script (no test framework), run via `npm test` →
 * `tsx src/codemap/__tests__/build.test.ts`. Asserts against real temp
 * fixture workspaces:
 *
 *   - TS/JS modules get import edges from the shared codeintel import graph
 *     (real tsconfig resolution, real paths);
 *   - TS/JS modules get Phase 2 call edges from the shared call graph (real
 *     checker symbol resolution) and entrypoint-rooted flows;
 *   - Python modules get edges from the AST subprocess extractor
 *     (scripts/codemap-python-extract.py);
 *   - C/C++ modules get regex `#include` edges;
 *   - the role/size heuristic tags tests, configs, entrypoints, vendor;
 *   - regeneration is fingerprint-aware: an unchanged repo writes NOTHING
 *     (second build reports changed:false), any edit/new/deleted file
 *     triggers a full regen;
 *   - artifacts land in the CENTRAL per-project store (under the
 *     $HEADLESSCODE_DATA_DIR override the test runner sets).
 */

import assert from "node:assert/strict"
import * as fs from "node:fs"
import * as fsp from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { execFileSync } from "node:child_process"

import { buildCodemap } from "../build.js"
import { codemapDir, codemapJsonPath, codemapLockPath, codemapHtmlPath, loadLock, loadCodemap } from "../lock.js"
import { resetCodeIntelCaches } from "../../codeintel/program.js"

const TSCONFIG = JSON.stringify(
	{
		compilerOptions: { target: "ES2022", module: "ESNext", moduleResolution: "bundler", strict: true },
		include: ["src"],
	},
	null,
	2,
)

/**
 * Make the fixture a REAL git repo before returning: production codemap runs
 * always target git checkouts (the file walker's git branch is authoritative
 * and does NOT exclude vendored dirs — only the non-git fallback does).
 */
function gitInit(root: string): void {
	execFileSync("git", ["init", "-q"], { cwd: root, stdio: "ignore" })
	execFileSync("git", ["add", "-A"], { cwd: root, stdio: "ignore" })
}

async function mkTsFixture(): Promise<string> {
	const ws = await fsp.mkdtemp(path.join(os.tmpdir(), "hc-codemap-ts-"))
	await fsp.mkdir(path.join(ws, "src", "vendor"), { recursive: true })
	await fsp.writeFile(path.join(ws, "tsconfig.json"), TSCONFIG)
	await fsp.writeFile(path.join(ws, "package.json"), JSON.stringify({ name: "fixture", main: "src/index.ts" }, null, 2))
	// a.ts imports AND calls into b.ts — the fixture exercises both Phase 1
	// import edges and Phase 2 call edges (issue #18).
	await fsp.writeFile(path.join(ws, "src", "a.ts"), `import { double } from "./b.js"\nexport function compute(): number { return double(21) }\n`)
	await fsp.writeFile(path.join(ws, "src", "b.ts"), `export function double(n: number): number { return n * 2 }\n`)
	await fsp.writeFile(path.join(ws, "src", "index.ts"), `import { compute } from "./a.js"\nconsole.log(compute())\n`)
	await fsp.writeFile(path.join(ws, "src", "a.test.ts"), `import { compute } from "./a.js"\nexport const t = compute()\n`)
	await fsp.writeFile(path.join(ws, "src", "vendor", "v.ts"), `export const v = 1\n`)
	gitInit(ws)
	return ws
}

async function mkPythonFixture(): Promise<string> {
	const ws = await fsp.mkdtemp(path.join(os.tmpdir(), "hc-codemap-py-"))
	await fsp.mkdir(path.join(ws, "pkg", "sub"), { recursive: true })
	await fsp.mkdir(path.join(ws, "tests"), { recursive: true })
	await fsp.writeFile(path.join(ws, "pkg", "__init__.py"), `from . import local\nfrom .sub import helper\n`)
	await fsp.writeFile(path.join(ws, "pkg", "app.py"), `import os\nfrom pkg.sub import helper\n`)
	await fsp.writeFile(path.join(ws, "pkg", "local.py"), `x = 1\n`)
	await fsp.writeFile(path.join(ws, "pkg", "sub", "__init__.py"), `y = 1\n`)
	await fsp.writeFile(path.join(ws, "pkg", "sub", "helper.py"), `def helper():\n    return 1\n`)
	await fsp.writeFile(path.join(ws, "tests", "test_app.py"), `from pkg.app import main\n`)
	gitInit(ws)
	return ws
}

async function mkCppFixture(): Promise<string> {
	const ws = await fsp.mkdtemp(path.join(os.tmpdir(), "hc-codemap-cpp-"))
	await fsp.writeFile(path.join(ws, "main.cpp"), `#include "util.h"\n#include <vector>\nint main() { return 0; }\n`)
	await fsp.writeFile(path.join(ws, "util.h"), `#pragma once\n#include "util_internal.h"\n`)
	await fsp.writeFile(path.join(ws, "util_internal.h"), `#pragma once\n`)
	gitInit(ws)
	return ws
}

async function testTypeScriptEdgesAndRoles(): Promise<void> {
	const ws = await mkTsFixture()
	try {
		resetCodeIntelCaches()
		const result = await buildCodemap({ workspaceRoot: ws })

		assert.equal(result.changed, true)
		const paths = result.modules.map((m) => m.path)
		for (const p of ["src/a.ts", "src/b.ts", "src/index.ts", "src/a.test.ts", "src/vendor/v.ts", "package.json", "tsconfig.json"]) {
			assert.ok(paths.includes(p), `module ${p} must be inventoried (got ${paths.join(", ")})`)
		}

		const byPath = new Map(result.modules.map((m) => [m.path, m]))
		assert.equal(byPath.get("src/a.test.ts")?.role, "test", "*.test.ts is a test module")
		assert.equal(byPath.get("src/index.ts")?.role, "entrypoint", "src/index.ts is an entrypoint")
		assert.equal(byPath.get("package.json")?.role, "config", "package.json is config")
		assert.equal(byPath.get("tsconfig.json")?.role, "config", "tsconfig.json is config")
		assert.equal(byPath.get("src/vendor/v.ts")?.role, "vendor", "vendor/ path segment is vendor")

		const aEdges = result.edges.filter((e) => e.from === "src/a.ts")
		assert.ok(
			aEdges.some((e) => e.to === "src/b.ts" && e.kind === "import" && e.specifier === "./b.js"),
			`a.ts must import b.ts via the resolved graph:\n${JSON.stringify(aEdges)}`,
		)
		const indexEdges = result.edges.filter((e) => e.from === "src/index.ts")
		assert.ok(indexEdges.some((e) => e.to === "src/a.ts"), "index.ts imports a.ts")

		// Artifacts live in the central store under the codemap/ dir.
		const dir = codemapDir(ws)
		assert.ok(path.dirname(codemapJsonPath(ws)) === dir, "codemap.json lives in the central codemap/ dir")
		assert.ok(fs.existsSync(codemapJsonPath(ws)), "codemap.json written")
		assert.ok(fs.existsSync(codemapLockPath(ws)), "codemap.lock written")
		assert.ok(fs.existsSync(codemapHtmlPath(ws)), "codemap.html written")

		const lock = loadLock(ws)
		assert.ok(lock !== undefined)
		assert.equal(lock!.fingerprints["src/a.ts"], byPath.get("src/a.ts")?.hash, "lock fingerprints match module hashes")
		assert.equal(lock!.codemapFingerprint, result.fingerprint, "lock records the codemap fingerprint")
	} finally {
		await fsp.rm(ws, { recursive: true, force: true })
	}
}

async function testPythonEdges(): Promise<void> {
	const ws = await mkPythonFixture()
	try {
		const result = await buildCodemap({ workspaceRoot: ws })
		const pyModules = result.modules.filter((m) => m.language === "python")
		assert.ok(pyModules.length >= 5, `expected >=5 python modules, got ${pyModules.length}`)

		assert.equal(pyModules.find((m) => m.path === "tests/test_app.py")?.role, "test", "test_*.py is a test module")

		const app = result.edges.filter((e) => e.from === "pkg/app.py")
		assert.ok(
			app.some((e) => e.to === "pkg/sub/helper.py" && e.specifier === "pkg.sub.helper"),
			`pkg/app.py must resolve pkg.sub.helper to pkg/sub/helper.py:\n${JSON.stringify(app)}`,
		)
		const init = result.edges.filter((e) => e.from === "pkg/__init__.py")
		assert.ok(init.some((e) => e.to === "pkg/local.py" && e.specifier === "local"), "relative from . import local resolves")
		assert.ok(init.some((e) => e.to === "pkg/sub/helper.py" && e.specifier === "sub.helper"), "from .sub import helper resolves")

		const appExternals = result.externalDeps["pkg/app.py"] ?? []
		assert.ok(appExternals.includes("os"), "import os is an external dep (specifier preserved)")
	} finally {
		await fsp.rm(ws, { recursive: true, force: true })
	}
}

async function testCppIncludeEdges(): Promise<void> {
	const ws = await mkCppFixture()
	try {
		const result = await buildCodemap({ workspaceRoot: ws })
		const edges = result.edges.filter((e) => e.kind === "include")
		assert.ok(
			edges.some((e) => e.from === "main.cpp" && e.to === "util.h" && e.specifier === "util.h"),
			`quoted include resolves relative to the file dir:\n${JSON.stringify(edges)}`,
		)
		assert.ok(
			edges.some((e) => e.from === "util.h" && e.to === "util_internal.h"),
			"header-to-header include edge",
		)
		const mainExternals = result.externalDeps["main.cpp"] ?? []
		assert.ok(mainExternals.includes("vector"), "<vector> is an external/system include")
	} finally {
		await fsp.rm(ws, { recursive: true, force: true })
	}
}

async function testFingerprintAwareRegeneration(): Promise<void> {
	const ws = await mkTsFixture()
	try {
		resetCodeIntelCaches()
		const first = await buildCodemap({ workspaceRoot: ws })
		assert.equal(first.changed, true)
		const jsonPath = codemapJsonPath(ws)
		const firstMtime = (await fsp.stat(jsonPath)).mtimeMs

		// Unchanged repo → second build writes nothing.
		await new Promise((r) => setTimeout(r, 5))
		const second = await buildCodemap({ workspaceRoot: ws })
		assert.equal(second.changed, false, "unchanged repo must short-circuit with no writes")
		assert.equal(second.fingerprint, first.fingerprint, "fingerprint is stable across identical builds")
		assert.equal((await fsp.stat(jsonPath)).mtimeMs, firstMtime, "codemap.json must not be rewritten")

		// An edited file changes the fingerprint and triggers a regen.
		await new Promise((r) => setTimeout(r, 5))
		await fsp.writeFile(path.join(ws, "src", "a.ts"), `import { double } from "./b.js"\nexport const a = double(21)\n`)
		const third = await buildCodemap({ workspaceRoot: ws })
		assert.equal(third.changed, true, "an edited module must trigger regeneration")
		assert.notEqual(third.fingerprint, first.fingerprint, "fingerprint must change when content changes")

		// A new file triggers a regen; a deleted file does too.
		await fsp.writeFile(path.join(ws, "src", "c.ts"), `export const c = 3\n`)
		assert.equal((await buildCodemap({ workspaceRoot: ws })).changed, true, "new file triggers regeneration")
		await fsp.rm(path.join(ws, "src", "c.ts"))
		assert.equal((await buildCodemap({ workspaceRoot: ws })).changed, true, "deleted file triggers regeneration")
	} finally {
		await fsp.rm(ws, { recursive: true, force: true })
	}
}

async function testCallEdgesAndEntrypointFlows(): Promise<void> {
	const ws = await mkTsFixture()
	try {
		resetCodeIntelCaches()
		const result = await buildCodemap({ workspaceRoot: ws })

		const callEdges = result.edges.filter((e) => e.kind === "call")
		assert.ok(
			callEdges.some((e) => e.from === "src/a.ts" && e.to === "src/b.ts" && e.specifier.includes("double")),
			`a.ts must have a call edge to double() in b.ts:\n${JSON.stringify(callEdges)}`,
		)
		assert.ok(
			callEdges.some((e) => e.from === "src/index.ts" && e.to === "src/a.ts" && e.specifier.includes("compute")),
			`index.ts must have a call edge to compute() in a.ts:\n${JSON.stringify(callEdges)}`,
		)
		for (const e of callEdges) {
			assert.notEqual(e.from, e.to, "call edges must never be self-loops")
		}

		// Entrypoint-rooted flows: index.ts (entrypoint) reaches a.ts + b.ts
		// along import and call edges — surfaced, not ranked (issue #18).
		const flow = result.flows["src/index.ts"]
		assert.ok(flow !== undefined, "the entrypoint module must have a flow")
		assert.deepEqual(flow, ["src/a.ts", "src/b.ts"], `entrypoint flow reaches its import/call graph:\n${JSON.stringify(flow)}`)

		const entrypointPaths = result.modules.filter((m) => m.role === "entrypoint").map((m) => m.path)
		assert.deepEqual(Object.keys(result.flows).sort(), entrypointPaths.sort(), "flows are keyed by entrypoint modules only")
	} finally {
		await fsp.rm(ws, { recursive: true, force: true })
	}
}

async function testHtmlIsSelfContained(): Promise<void> {
	const ws = await mkTsFixture()
	try {
		resetCodeIntelCaches()
		await buildCodemap({ workspaceRoot: ws })
		const html = await fsp.readFile(codemapHtmlPath(ws), "utf-8")

		assert.ok(html.includes("<!DOCTYPE html>"), "html is a full document")
		assert.ok(html.includes("<svg"), "contains an svg graph")
		assert.ok(html.includes("CODEMAP = "), "embeds the codemap JSON")
		assert.ok(html.includes('id="search"'), "has a search box")
		assert.ok(html.includes("edge.call"), "call edges have a distinct style in the visualizer")
		assert.ok(html.includes("flow from this entrypoint"), "entrypoint detail panel renders its flow")
		// No external RESOURCE references (the SVG namespace URI is a string
		// constant, not a fetch): no script src, no stylesheet link, no CSS
		// url()/import.
		assert.ok(!/<script[^>]+src=/.test(html), "no external script src")
		assert.ok(!/<link[^>]+rel=["']stylesheet["']/.test(html), "no stylesheet link")
		assert.ok(!/@import\s+url?\(/.test(html) && !/url\(\s*["']?https?:/.test(html), "no external CSS urls")
		assert.ok(html.includes("codemap — "), "title carries the project name")
		assert.ok(html.includes(path.basename(ws)), "title carries this project's name")
		// The embedded JSON must be valid and parse to the same fingerprint.
		const m = html.match(/const CODEMAP = (\{.*?\});\n/s)
		assert.ok(m !== null, "embedded JSON object found")
		const embedded = JSON.parse(m![1]!)
		assert.equal(embedded.fingerprint, (await loadCodemap(ws))!.fingerprint, "embedded JSON matches codemap.json")
	} finally {
		await fsp.rm(ws, { recursive: true, force: true })
	}
}

async function main(): Promise<void> {
	const tests: Array<[string, () => Promise<void>]> = [
		["TS/JS modules get resolved import edges + correct roles", testTypeScriptEdgesAndRoles],
		["Python modules get AST-subprocess import edges", testPythonEdges],
		["C/C++ modules get regex include edges", testCppIncludeEdges],
		["TS/JS call edges resolve cross-module calls + entrypoint flows", testCallEdgesAndEntrypointFlows],
		["regeneration is fingerprint-aware (no writes when unchanged)", testFingerprintAwareRegeneration],
		["html visualizer is self-contained and embeds the map", testHtmlIsSelfContained],
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
	console.log(`\nAll ${tests.length} codemap build tests passed`)
}

main().catch((err) => {
	console.error("Test runner crashed:", err)
	process.exit(1)
})
