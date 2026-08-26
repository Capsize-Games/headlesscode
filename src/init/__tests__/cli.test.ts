/**
 * End-to-end tests for the `headlesscode init` subcommand (src/init/cli.ts).
 *
 * Plain assert-based script (no test framework), run via `npm test`. Always
 * invoked with --skip-index --skip-codemap so the suite never makes real
 * embedding API calls or needs a network.
 *
 * The `project.json`-exists assertion sandboxes $HOME and removes the
 * $HEADLESSCODE_DATA_DIR override: under the override resolveProjectDataDir
 * deliberately skips the metadata write (src/project-store.ts:166 — test runs
 * must not leave real-store entries behind), so asserting the real
 * registration path requires the no-override + sandboxed-HOME setup.
 */

import assert from "node:assert/strict"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"

import { initMain, parseInitArgs } from "../cli.js"
import { projectKeyFor, resolveProjectIdentity } from "../../project-store.js"

async function mkWs(files: Record<string, string> = {}): Promise<string> {
	const ws = await fs.mkdtemp(path.join(os.tmpdir(), "hc-init-cli-"))
	for (const [rel, content] of Object.entries(files)) {
		const abs = path.join(ws, rel)
		await fs.mkdir(path.dirname(abs), { recursive: true })
		await fs.writeFile(abs, content, "utf-8")
	}
	return ws
}

function captureStdout(): { get: () => string; restore: () => void } {
	let buf = ""
	const orig = process.stdout.write.bind(process.stdout)
	process.stdout.write = ((chunk: string) => {
		buf += chunk
		return true
	}) as typeof process.stdout.write
	return { get: () => buf, restore: () => (process.stdout.write = orig) }
}

function captureStderr(): { get: () => string; restore: () => void } {
	let buf = ""
	const orig = process.stderr.write.bind(process.stderr)
	process.stderr.write = ((chunk: string) => {
		buf += chunk
		return true
	}) as typeof process.stderr.write
	return { get: () => buf, restore: () => (process.stderr.write = orig) }
}

// ─── Arg parsing ─────────────────────────────────────────────────────────────

async function testParseArgsRequiresWorkspace(): Promise<void> {
	const r = parseInitArgs([])
	assert.ok(!("error" in r), "empty args parse without an error")
	assert.equal(r.options.workspace, undefined, "no --workspace → undefined")
}

async function testParseArgsCollectsFlags(): Promise<void> {
	const r = parseInitArgs([
		"--workspace",
		"/tmp/proj",
		"--skip-index",
		"--skip-codemap",
		"--embedding-backend",
		"ollama",
	])
	assert.ok(!("error" in r))
	assert.equal(r.options.workspace, "/tmp/proj")
	assert.equal(r.options.skipIndex, true)
	assert.equal(r.options.skipCodemap, true)
	assert.equal(r.options.embeddingBackend, "ollama")
}

async function testParseArgsHelpAndUnknown(): Promise<void> {
	const help = parseInitArgs(["--help"])
	assert.ok(!("error" in help) && help.options.help, "--help sets the help flag")
	const unknown = parseInitArgs(["--bogus"])
	assert.ok(unknown.error !== undefined, "unknown flags are rejected")
	assert.match(unknown.error, /Unknown argument/)
}

// ─── Main command ────────────────────────────────────────────────────────────

async function testMissingWorkspaceIsUsageError(): Promise<void> {
	const out = captureStdout()
	const err = captureStderr()
	let code: number
	try {
		code = await initMain([])
	} finally {
		out.restore()
		err.restore()
	}
	assert.equal(code, 2, "missing --workspace must exit 2")
	assert.match(err.get(), /--workspace <path> is required/)
	assert.match(err.get(), /headlesscode init — one-command project registration/)
}

async function testNonexistentWorkspaceIsUsageError(): Promise<void> {
	const err = captureStderr()
	let code: number
	try {
		code = await initMain(["--workspace", path.join(os.tmpdir(), "hc-init-cli-nonexistent-xyz")])
	} finally {
		err.restore()
	}
	assert.equal(code, 2, "nonexistent --workspace must exit 2")
	assert.match(err.get(), /not a directory/)
}

/**
 * The motivating rts_cpp-style case: a fresh dir with a CMakeLists.txt
 * registers (project.json in the central store), is detected as cpp, gets its
 * .gitignore fixed, and skips index/codemap cleanly.
 */
async function testEndToEndRegistersProjectAndDetectsCpp(): Promise<void> {
	const realHome = os.homedir()
	const realUserProfile = process.env.USERPROFILE
	const realDataDir = process.env.HEADLESSCODE_DATA_DIR
	const home = await fs.mkdtemp(path.join(os.tmpdir(), "hc-init-cli-home-"))
	const ws = await mkWs({ "CMakeLists.txt": "cmake_minimum_required(VERSION 3.16)\nproject(rts_cpp)\n" })
	try {
		// Sandbox HOME + drop the override so resolveProjectDataDir takes the
		// real registration path (which writes project.json) into the sandbox.
		process.env.HOME = home
		process.env.USERPROFILE = home
		delete process.env.HEADLESSCODE_DATA_DIR

		const out = captureStdout()
		let code: number
		try {
			code = await initMain(["--workspace", ws, "--skip-index", "--skip-codemap"])
		} finally {
			out.restore()
		}
		assert.equal(code, 0, "init with skip flags must exit 0")

		const printed = out.get()
		assert.match(printed, /Step 1\/5 — project registration/)
		assert.match(printed, /cpp/, "CMakeLists.txt fixture must be detected as cpp")
		assert.match(printed, /Step 4\/5 — codebase index/)
		assert.match(printed, /skipped by flag/, "index + codemap must report skipped by flag")
		assert.match(printed, /Summary/)

		// .gitignore was written for the target repo.
		const gitignore = await fs.readFile(path.join(ws, ".gitignore"), "utf-8")
		assert.match(gitignore, /^# headlesscode session artifacts/, "gitignore comment header present")
		assert.match(gitignore, /\/\.headlesscode\//, "gitignore excludes .headlesscode/")

		// project.json exists in the resolved central dir (real registration).
		const identity = resolveProjectIdentity(ws)
		const central = path.join(home, ".local", "share", "headlesscode", "projects", projectKeyFor(identity.keySource))
		const meta = JSON.parse(await fs.readFile(path.join(central, "project.json"), "utf-8")) as {
			path: string
			kind: string
			firstSeen: string
			lastSeen: string
			registered: boolean
		}
		assert.equal(meta.kind, "plain", "a plain non-git fixture dir registers as kind=plain")
		assert.equal(meta.path, path.resolve(ws), "project.json records the real workspace path")
		// Part B: `headlesscode init` is the ONLY call site that ever passes
		// registered:true — the field must land as true, with timestamps set.
		assert.equal(meta.registered, true, "init registers the project (registered: true)")
		assert.ok(meta.firstSeen.length > 0 && meta.lastSeen.length > 0, "first/last seen timestamps are written")
		assert.ok(
			printed.includes(central),
			"init stdout must print the resolved central data dir",
		)
	} finally {
		process.env.HOME = realHome
		if (realUserProfile === undefined) {
			delete process.env.USERPROFILE
		} else {
			process.env.USERPROFILE = realUserProfile
		}
		if (realDataDir === undefined) {
			delete process.env.HEADLESSCODE_DATA_DIR
		} else {
			process.env.HEADLESSCODE_DATA_DIR = realDataDir
		}
		await fs.rm(home, { recursive: true, force: true })
		await fs.rm(ws, { recursive: true, force: true })
	}
}

/** A repo whose .gitignore already covers .headlesscode is left untouched. */
async function testExistingGitignoreCoverageReportedAsUnchanged(): Promise<void> {
	const realDataDir = process.env.HEADLESSCODE_DATA_DIR
	const ws = await mkWs({ "CMakeLists.txt": "project(x)\n", ".gitignore": "node_modules/\n/.headlesscode/\n" })
	const data = await fs.mkdtemp(path.join(os.tmpdir(), "hc-init-cli-data-"))
	try {
		process.env.HEADLESSCODE_DATA_DIR = data
		const before = await fs.readFile(path.join(ws, ".gitignore"), "utf-8")
		const out = captureStdout()
		let code: number
		try {
			code = await initMain(["--workspace", ws, "--skip-index", "--skip-codemap"])
		} finally {
			out.restore()
		}
		assert.equal(code, 0)
		assert.match(out.get(), /already covers \.headlesscode — no change/)
		assert.equal(await fs.readFile(path.join(ws, ".gitignore"), "utf-8"), before, ".gitignore must be byte-identical")
	} finally {
		if (realDataDir === undefined) {
			delete process.env.HEADLESSCODE_DATA_DIR
		} else {
			process.env.HEADLESSCODE_DATA_DIR = realDataDir
		}
		await fs.rm(data, { recursive: true, force: true })
		await fs.rm(ws, { recursive: true, force: true })
	}
}

const tests: Array<[string, () => Promise<void>]> = [
	["parse: --workspace is required", testParseArgsRequiresWorkspace],
	["parse: flags collected", testParseArgsCollectsFlags],
	["parse: --help and unknown-arg rejection", testParseArgsHelpAndUnknown],
	["missing --workspace exits 2 with usage", testMissingWorkspaceIsUsageError],
	["nonexistent --workspace exits 2 with usage", testNonexistentWorkspaceIsUsageError],
	["end-to-end: registers project, detects cpp, writes .gitignore (skips index/codemap)", testEndToEndRegistersProjectAndDetectsCpp],
	["existing .gitignore coverage reported as unchanged, file byte-identical", testExistingGitignoreCoverageReportedAsUnchanged],
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
	console.log(`\nAll ${tests.length} init cli tests passed`)
}

main().catch((err) => {
	console.error("Test runner crashed:", err)
	process.exit(1)
})
