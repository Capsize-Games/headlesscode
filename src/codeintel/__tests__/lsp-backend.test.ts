/**
 * Verification tests for the LSP-backed code-intelligence backend (issue #59):
 * a REAL Python fixture workspace (not a mock) proves find_references /
 * go_to_definition / outline / rename_symbol work through the bundled pyright
 * language server, and a mixed TS+Python workspace proves per-file backend
 * dispatch — one session calls find_references on a `.ts` file and then on a
 * `.py` file and gets the RIGHT backend's answer for each.
 *
 * Also covers the plan's fail-closed requirements: a workspace whose detected
 * language has no configured backend (Rust) gets none of the six tools, and a
 * broken language-server binary means the tools simply aren't registered —
 * session unaffected, never a hard failure.
 *
 * Plain assert-based script (no test framework), run via `npm test` → `tsx
 * src/codeintel/__tests__/lsp-backend.test.ts`.
 *
 * NOTE: these tests spawn a real `pyright-langserver` child process (the
 * bundled dependency). Each executor owns its server and `executor.dispose()`
 * kills it; the child is also unref'd so a forgotten dispose can never hang
 * the test run.
 */

import assert from "node:assert/strict"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"

import { createHeadlessExecutor } from "../../tools/executor.js"
import { resetCodeIntelCaches } from "../program.js"
import { CodeIntelService } from "../service.js"
import type { LanguageServerSpec } from "../lsp/registry.js"

/** A broken server registry: the binary path does not exist. */
const BROKEN_PYRIGHT: Record<string, LanguageServerSpec> = {
	python: { command: "/nonexistent/pyright-langserver", args: ["--stdio"], rootMarkers: [] },
}

const PY_UTIL = `def add(a: int, b: int) -> int:
    return a + b

def helper(x: int) -> int:
    return x * 2
`

const PY_MAIN = `from util import add, helper

def run() -> int:
    total = add(1, 2)
    doubled = helper(total)
    return doubled
`

/** A python-only fixture: util.py defines `add`, main.py imports + calls it. */
async function mkPythonWorkspace(): Promise<string> {
	const ws = await fs.mkdtemp(path.join(os.tmpdir(), "hc-ci-lsp-py-"))
	await fs.writeFile(path.join(ws, "util.py"), PY_UTIL)
	await fs.writeFile(path.join(ws, "main.py"), PY_MAIN)
	return ws
}

const TS_UTIL = `export function util(): number {
	return 1
}
`
const TS_USAGES = `import * as m from "./util.js"

const v = m.util()
`

/** A mixed workspace: one .ts pair (tsconfig + util/usages) AND one .py pair. */
async function mkMixedWorkspace(): Promise<string> {
	const ws = await fs.mkdtemp(path.join(os.tmpdir(), "hc-ci-lsp-mixed-"))
	await fs.writeFile(
		path.join(ws, "tsconfig.json"),
		JSON.stringify({ compilerOptions: { target: "ES2022", module: "ESNext", moduleResolution: "bundler", strict: true }, include: ["src"] }, null, 2),
	)
	await fs.mkdir(path.join(ws, "src"))
	await fs.writeFile(path.join(ws, "src", "util.ts"), TS_UTIL)
	await fs.writeFile(path.join(ws, "src", "usages.ts"), TS_USAGES)
	await fs.writeFile(path.join(ws, "pyutil.py"), "def add(a: int, b: int) -> int:\n    return a + b\n")
	await fs.writeFile(path.join(ws, "pymain.py"), "from pyutil import add\n\nx = add(1, 2)\n")
	return ws
}

/** A rust-only workspace: detected, but no backend is configured for it. */
async function mkRustWorkspace(): Promise<string> {
	const ws = await fs.mkdtemp(path.join(os.tmpdir(), "hc-ci-lsp-rust-"))
	await fs.writeFile(path.join(ws, "Cargo.toml"), "[package]\nname = \"x\"\nversion = \"0.1.0\"\n")
	await fs.mkdir(path.join(ws, "src"))
	await fs.writeFile(path.join(ws, "src", "main.rs"), "fn main() {}\n")
	return ws
}

// ─── Python backend, real pyright round-trip ─────────────────────────────────

async function testPythonFindReferences(): Promise<void> {
	const ws = await mkPythonWorkspace()
	try {
		resetCodeIntelCaches()
		const executor = createHeadlessExecutor(ws)
		try {
			// `add` on main.py line 4 (1-based): declaration (util.py:1),
			// import (main.py:1), and the call (main.py:4).
			const result = await executor.execute("find_references", { path: "main.py", line: 4, symbol: "add" })
			assert.equal(result.isError, false, `expected success, got: ${result.content}`)
			const lines = result.content.split("\n")
			assert.equal(lines.length, 3, `expected declaration + import + call, got:\n${result.content}`)
			assert.match(lines[0]!, /^main\.py:1 — from util import add, helper$/, "import site")
			assert.match(lines[1]!, /^main\.py:4 — total = add\(1, 2\)$/, "call site")
			assert.match(lines[2]!, /^util\.py:1 — def add\(a: int, b: int\) -> int:$/, "declaration site")
		} finally {
			executor.dispose()
		}
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

async function testPythonGoToDefinition(): Promise<void> {
	const ws = await mkPythonWorkspace()
	try {
		resetCodeIntelCaches()
		const executor = createHeadlessExecutor(ws)
		try {
			const result = await executor.execute("go_to_definition", { path: "main.py", line: 4, symbol: "add" })
			assert.equal(result.isError, false, `expected success, got: ${result.content}`)
			assert.match(result.content, /^util\.py:1:5 definition add — def add\(a: int, b: int\) -> int:$/, "definition resolved to util.py:1")
		} finally {
			executor.dispose()
		}
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

async function testPythonOutline(): Promise<void> {
	const ws = await mkPythonWorkspace()
	try {
		resetCodeIntelCaches()
		const executor = createHeadlessExecutor(ws)
		try {
			const result = await executor.execute("outline", { path: "util.py" })
			assert.equal(result.isError, false, `expected success, got: ${result.content}`)
			assert.match(result.content, /^Outline of util\.py:\n/)
			// pyright returns hierarchical DocumentSymbols (nested params at
			// depth 1); detail is empty, so signatures are the names only.
			assert.match(result.content, /1 function add/, "function outline entry")
			assert.match(result.content, /4 function helper/, "second function entry")
			assert.match(result.content, /\n  1 var a\n/, "nested parameter outlined at depth 1")
			assert.match(result.content, /\n  4 var x$/, "nested parameter of the second function")
		} finally {
			executor.dispose()
		}
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

async function testPythonRenameSymbol(): Promise<void> {
	const ws = await mkPythonWorkspace()
	try {
		resetCodeIntelCaches()
		const executor = createHeadlessExecutor(ws)
		try {
			const result = await executor.execute("rename_symbol", { path: "main.py", line: 4, symbol: "add", new_name: "add2" })
			assert.equal(result.isError, false, `expected success, got: ${result.content}`)
			assert.match(result.content, /^Renamed 'add' → 'add2' across 3 site\(s\):\n/, "rename result header")
			// The rename must have actually edited both files, atomically.
			const util = await fs.readFile(path.join(ws, "util.py"), "utf-8")
			assert.match(util, /^def add2\(a: int, b: int\) -> int:$/m, "definition renamed in util.py")
			const main = await fs.readFile(path.join(ws, "main.py"), "utf-8")
			assert.match(main, /^from util import add2, helper$/m, "import renamed in main.py")
			assert.match(main, /total = add2\(1, 2\)/, "call renamed in main.py")
		} finally {
			executor.dispose()
		}
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

// ─── Mixed workspace: per-file dispatch in ONE session ───────────────────────

async function testMixedWorkspacePerFileDispatch(): Promise<void> {
	const ws = await mkMixedWorkspace()
	try {
		resetCodeIntelCaches()
		const executor = createHeadlessExecutor(ws)
		try {
			// .ts file → the TypeScript backend's answer (declaration + 1 usage).
			const tsResult = await executor.execute("find_references", { path: "src/util.ts", line: 1, symbol: "util" })
			assert.equal(tsResult.isError, false, `TS find_references failed: ${tsResult.content}`)
			const tsLines = tsResult.content.split("\n")
			assert.equal(tsLines.length, 2, `expected TS declaration + usage, got:\n${tsResult.content}`)
			assert.match(tsLines[0]!, /^src\/usages\.ts:3 — const v = m\.util\(\)$/, "TS usage site")
			assert.match(tsLines[1]!, /^src\/util\.ts:1 \(write\) — export function util\(\)/, "TS declaration site")

			// .py file in the SAME session → the pyright backend's answer.
			const pyResult = await executor.execute("find_references", { path: "pymain.py", line: 3, symbol: "add" })
			assert.equal(pyResult.isError, false, `python find_references failed: ${pyResult.content}`)
			const pyLines = pyResult.content.split("\n")
			assert.equal(pyLines.length, 3, `expected python declaration + import + call, got:\n${pyResult.content}`)
			assert.match(pyLines[0]!, /^pymain\.py:1 — from pyutil import add$/, "python import site")
			assert.match(pyLines[1]!, /^pymain\.py:3 — x = add\(1, 2\)$/, "python call site")
			assert.match(pyLines[2]!, /^pyutil\.py:1 — def add\(a: int, b: int\) -> int:$/, "python declaration site")

			// And go_to_definition on the .ts file still resolves via TS.
			const tsDef = await executor.execute("go_to_definition", { path: "src/usages.ts", line: 3, symbol: "util" })
			assert.equal(tsDef.isError, false, `TS go_to_definition failed: ${tsDef.content}`)
			// The TS checker may annotate the container (here the module path).
			assert.match(
				tsDef.content,
				/^src\/util\.ts:1:\d+ function util( \(in .*?\))? — export function util\(\): number \{$/,
				"TS definition resolved",
			)
		} finally {
			executor.dispose()
		}
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

async function testMixedWorkspaceImportGraphGap(): Promise<void> {
	const ws = await mkMixedWorkspace()
	try {
		resetCodeIntelCaches()
		const executor = createHeadlessExecutor(ws)
		try {
			// import_graph IS registered (a TypeScript backend exists)…
			assert.equal(executor.has("import_graph"), true, "mixed workspace keeps import_graph (TS backend)")
			// …works on .ts…
			const tsGraph = await executor.execute("import_graph", { path: "src/usages.ts" })
			assert.equal(tsGraph.isError, false, `TS import_graph failed: ${tsGraph.content}`)
			assert.match(tsGraph.content, /import \.\/util\.js -> src\/util\.ts/, "TS import edge resolved")
			// …and on .py gives the explicit not-supported error, never a
			// silent wrong answer.
			const pyGraph = await executor.execute("import_graph", { path: "pymain.py" })
			assert.equal(pyGraph.isError, true, "python import_graph must error, not fake an answer")
			assert.match(pyGraph.content, /not supported for this language yet/, "clear not-supported gap message")
		} finally {
			executor.dispose()
		}
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

// ─── No backend / broken server: fail closed, never a hard failure ───────────

async function testWorkspaceWithNoConfiguredBackend(): Promise<void> {
	const ws = await mkRustWorkspace()
	try {
		resetCodeIntelCaches()
		const executor = createHeadlessExecutor(ws)
		try {
			// Rust is detected but no backend is configured: the six tools
			// simply aren't registered — exactly like the old TS-only gate
			// behaved for non-TS workspaces.
			assert.equal(executor.has("outline"), false)
			assert.equal(executor.has("go_to_definition"), false)
			assert.equal(executor.has("find_references"), false)
			assert.equal(executor.has("import_graph"), false)
			assert.equal(executor.has("rename_symbol"), false)
			// The core tools still work — the session is completely normal.
			const read = await executor.execute("read_file", { path: "src/main.rs" })
			assert.equal(read.isError, false)
		} finally {
			executor.dispose()
		}
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

async function testBrokenServerBinaryFailsClosed(): Promise<void> {
	const ws = await mkPythonWorkspace()
	try {
		resetCodeIntelCaches()
		// A python workspace whose server binary does not exist: the executor
		// must not register the tools (availability is decided synchronously
		// at creation), log a WARN, and never crash the session.
		const executor = createHeadlessExecutor(ws, { codeIntelServerRegistry: BROKEN_PYRIGHT })
		try {
			assert.equal(executor.has("outline"), false, "outline not registered when the python server is missing")
			assert.equal(executor.has("find_references"), false)
			assert.equal(executor.has("rename_symbol"), false)
			const read = await executor.execute("read_file", { path: "main.py" })
			assert.equal(read.isError, false, "core tools unaffected by the broken server")
		} finally {
			executor.dispose()
		}

		// Service-level: resolveBackend on a .py file returns undefined (fail
		// closed) rather than throwing, and an unknown extension too.
		const service = new CodeIntelService(ws, { serverRegistry: BROKEN_PYRIGHT })
		try {
			assert.equal(service.isBackendAvailable("python"), false, "python backend unavailable with a broken binary")
			const backend = await service.resolveBackend(path.join(ws, "main.py"))
			assert.equal(backend, undefined, "resolveBackend fails closed")
			const unknown = await service.resolveBackend(path.join(ws, "whatever.rs"))
			assert.equal(unknown, undefined, "no backend for an unknown extension")
		} finally {
			await service.dispose()
		}
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

async function main(): Promise<void> {
	const tests: Array<[string, () => Promise<void>]> = [
		["python fixture: find_references returns real sites via pyright", testPythonFindReferences],
		["python fixture: go_to_definition resolves to the real definition", testPythonGoToDefinition],
		["python fixture: outline lists the declarations", testPythonOutline],
		["python fixture: rename_symbol edits every site atomically", testPythonRenameSymbol],
		["mixed workspace: find_references dispatches per file (TS then Python, one session)", testMixedWorkspacePerFileDispatch],
		["mixed workspace: import_graph works on .ts and errors clearly on .py", testMixedWorkspaceImportGraphGap],
		["workspace with no configured backend: the six tools are not registered", testWorkspaceWithNoConfiguredBackend],
		["broken server binary: tools not registered, session unaffected", testBrokenServerBinaryFailsClosed],
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
	console.log(`\nAll ${tests.length} lsp-backend tests passed`)
}

main().catch((err) => {
	console.error("Test runner crashed:", err)
	process.exit(1)
})
