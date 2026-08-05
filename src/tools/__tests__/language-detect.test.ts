/**
 * Tests for the workspace-language detector (src/tools/language-detect.ts):
 * marker-file + bounded extension-frequency detection used to gate the
 * TS-only tools (codeintel + run_tests) to TS/JS workspaces. Plain
 * assert-based, run via `npm test` -> `tsx src/tools/__tests__/language-detect.test.ts`.
 */

import assert from "node:assert/strict"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"

import { detectWorkspaceLanguages, isTypeScriptWorkspace } from "../language-detect.js"
import { createHeadlessExecutor, createReadOnlyHeadlessExecutor } from "../executor.js"

async function mkTmp(prefix: string): Promise<string> {
	return fs.mkdtemp(path.join(os.tmpdir(), prefix))
}

async function testTypeScriptByMarker(): Promise<void> {
	const ws = await mkTmp("hc-lang-tsmarker-")
	try {
		await fs.writeFile(path.join(ws, "package.json"), '{ "name": "x" }\n')
		const langs = detectWorkspaceLanguages(ws)
		assert.ok(langs.has("typescript"), "package.json alone implies typescript")
		assert.ok(isTypeScriptWorkspace(ws), "isTypeScriptWorkspace follows")
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

async function testTypeScriptByExtension(): Promise<void> {
	const ws = await mkTmp("hc-lang-tsext-")
	try {
		await fs.mkdir(path.join(ws, "src"))
		await fs.writeFile(path.join(ws, "src", "app.ts"), "export const a = 1\n")
		const langs = detectWorkspaceLanguages(ws)
		assert.ok(langs.has("typescript"), ".ts extension implies typescript with no marker files")
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

async function testPythonProject(): Promise<void> {
	const ws = await mkTmp("hc-lang-py-")
	try {
		await fs.writeFile(path.join(ws, "pyproject.toml"), "[project]\n")
		await fs.mkdir(path.join(ws, "pkg"))
		await fs.writeFile(path.join(ws, "pkg", "mod.py"), "def f():\n    return 1\n")
		const langs = detectWorkspaceLanguages(ws)
		assert.ok(langs.has("python"), "pyproject.toml + .py imply python")
		assert.ok(!langs.has("typescript"), "python project is NOT typescript (no TS-only tools)")
		assert.ok(!isTypeScriptWorkspace(ws), "isTypeScriptWorkspace false for python")
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

async function testCppProject(): Promise<void> {
	const ws = await mkTmp("hc-lang-cpp-")
	try {
		await fs.mkdir(path.join(ws, "src"))
		await fs.writeFile(path.join(ws, "CMakeLists.txt"), "cmake_minimum_required(VERSION 3.16)\n")
		await fs.writeFile(path.join(ws, "src", "main.cpp"), "int main() { return 0; }\n")
		await fs.writeFile(path.join(ws, "src", "engine.h"), "#pragma once\n")
		const langs = detectWorkspaceLanguages(ws)
		assert.ok(langs.has("cpp"), "CMakeLists.txt + .cpp imply cpp")
		assert.ok(!isTypeScriptWorkspace(ws), "C++ workspace is not typescript")
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

async function testPlainCFilesDoNotImplyCpp(): Promise<void> {
	const ws = await mkTmp("hc-lang-c-")
	try {
		await fs.writeFile(path.join(ws, "main.c"), "int main() { return 0; }\n")
		await fs.writeFile(path.join(ws, "util.h"), "#pragma once\n")
		const langs = detectWorkspaceLanguages(ws)
		assert.ok(!langs.has("cpp"), "bare .c/.h must not be labeled C++ (plain C is common)")
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

async function testEmptyAndMissingWorkspaces(): Promise<void> {
	const ws = await mkTmp("hc-lang-empty-")
	try {
		assert.equal(detectWorkspaceLanguages(ws).size, 0, "empty dir detects nothing")
		assert.equal(detectWorkspaceLanguages(path.join(ws, "does-not-exist")).size, 0, "missing dir is the empty set, never throws")
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

async function testNodeModulesSkipped(): Promise<void> {
	const ws = await mkTmp("hc-lang-skip-")
	try {
		// A node_modules full of .ts would otherwise make a non-TS workspace
		// look like a TS project.
		await fs.mkdir(path.join(ws, "node_modules", "dep"), { recursive: true })
		await fs.writeFile(path.join(ws, "node_modules", "dep", "index.ts"), "export const x = 1\n")
		await fs.writeFile(path.join(ws, "README.md"), "# not code\n")
		const langs = detectWorkspaceLanguages(ws)
		assert.equal(langs.size, 0, "node_modules .ts files are not counted, and README.md is not code")
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

async function testExecutorGatesTsToolsByWorkspaceLanguage(): Promise<void> {
	// Python workspace: the TS-only tools must NOT be registered (and would
	// not be advertised — loop.ts gates advertisement on executor.has).
	const py = await mkTmp("hc-lang-exec-py-")
	try {
		await fs.writeFile(path.join(py, "pyproject.toml"), "[project]\n")
		await fs.writeFile(path.join(py, "mod.py"), "def f():\n    return 1\n")
		const execPy = createHeadlessExecutor(py)
		for (const name of ["outline", "go_to_definition", "find_references", "import_graph", "rename_symbol", "run_tests"]) {
			assert.equal(execPy.has(name), false, `${name} must not be registered on a Python workspace`)
		}
		const readPy = createReadOnlyHeadlessExecutor(py)
		assert.equal(readPy.has("outline"), false, "read-only executor also omits TS-only tools on Python")
		assert.ok(readPy.has("execute_command"), "language-generic tools stay registered")
	} finally {
		await fs.rm(py, { recursive: true, force: true })
	}

	// TS workspace: the same tools ARE registered.
	const ts = await mkTmp("hc-lang-exec-ts-")
	try {
		await fs.writeFile(path.join(ts, "package.json"), '{ "name": "x" }\n')
		await fs.mkdir(path.join(ts, "src"))
		await fs.writeFile(path.join(ts, "src", "app.ts"), "export const a = 1\n")
		const execTs = createHeadlessExecutor(ts)
		for (const name of ["outline", "go_to_definition", "find_references", "import_graph", "rename_symbol", "run_tests"]) {
			assert.equal(execTs.has(name), true, `${name} must be registered on a TS workspace`)
		}
		const readTs = createReadOnlyHeadlessExecutor(ts)
		assert.equal(readTs.has("outline"), true, "read-only executor keeps the read-only codeintel tools on TS")
		assert.equal(readTs.has("rename_symbol"), false, "read-only executor still never registers the edit tool")
	} finally {
		await fs.rm(ts, { recursive: true, force: true })
	}
}

const tests: Array<[string, () => Promise<void>]> = [
	["TS by marker file (package.json)", testTypeScriptByMarker],
	["TS by extension (.ts) with no markers", testTypeScriptByExtension],
	["Python project (pyproject.toml + .py) is not TS", testPythonProject],
	["C++ project (CMakeLists.txt + .cpp/.h) is not TS", testCppProject],
	["bare .c/.h files do not imply C++", testPlainCFilesDoNotImplyCpp],
	["empty + missing workspaces detect nothing", testEmptyAndMissingWorkspaces],
	["node_modules content is skipped", testNodeModulesSkipped],
	["executor registers TS-only tools iff the workspace is TS/JS", testExecutorGatesTsToolsByWorkspaceLanguage],
]

async function main(): Promise<void> {
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
	console.log(`\nAll ${tests.length} language-detect tests passed`)
}

main().catch((err) => {
	console.error("Test runner crashed:", err)
	process.exit(1)
})
