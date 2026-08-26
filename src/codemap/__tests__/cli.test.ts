/**
 * COV-5: smoke-level tests for `headlesscode codemap` (src/codemap/cli.ts) —
 * no coverage anywhere before this file (build.test.ts exercises
 * buildCodemap() directly, never the CLI's arg parsing/exit-code layer).
 * Reuses the pattern from src/orchestrator/__tests__/cli.test.ts (call the
 * exported *Main(argv) entry point in-process, assert exit code / stdout /
 * stderr) and a minimal fixture like build.test.ts's mkTsFixture.
 *
 * --watch mode is intentionally NOT exercised here (it's an infinite poll
 * loop gated on SIGINT — out of scope for a smoke test; the one-shot path
 * this file covers is what a CI/cron invocation actually uses).
 *
 * Plain assert-based script (no test framework), run via `npm test`.
 */

import assert from "node:assert/strict"
import * as fs from "node:fs"
import * as fsp from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { execFileSync } from "node:child_process"

import { codemapMain, parseCodemapArgs } from "../cli.js"
import { codemapJsonPath } from "../lock.js"
import { resetCodeIntelCaches } from "../../codeintel/program.js"

function gitInit(root: string): void {
	execFileSync("git", ["init", "-q"], { cwd: root, stdio: "ignore" })
	execFileSync("git", ["add", "-A"], { cwd: root, stdio: "ignore" })
}

async function mkTinyFixture(): Promise<string> {
	const ws = await fsp.mkdtemp(path.join(os.tmpdir(), "hc-codemap-cli-"))
	await fsp.mkdir(path.join(ws, "src"), { recursive: true })
	await fsp.writeFile(
		path.join(ws, "tsconfig.json"),
		JSON.stringify({ compilerOptions: { target: "ES2022", module: "ESNext", moduleResolution: "bundler" }, include: ["src"] }),
	)
	await fsp.writeFile(path.join(ws, "src", "index.ts"), `export const x = 1\n`)
	gitInit(ws)
	return ws
}

/** Capture stdout+stderr written during `fn()`. */
async function captureOutput(fn: () => Promise<number>): Promise<{ exit: number; stdout: string; stderr: string }> {
	const origOut = process.stdout.write.bind(process.stdout)
	const origErr = process.stderr.write.bind(process.stderr)
	let stdout = ""
	let stderr = ""
	process.stdout.write = ((chunk: unknown): boolean => {
		stdout += String(chunk)
		return true
	}) as typeof process.stdout.write
	process.stderr.write = ((chunk: unknown): boolean => {
		stderr += String(chunk)
		return true
	}) as typeof process.stderr.write
	try {
		const exit = await fn()
		return { exit, stdout, stderr }
	} finally {
		process.stdout.write = origOut
		process.stderr.write = origErr
	}
}

// ─── parseCodemapArgs ────────────────────────────────────────────────────

function testParseArgsDefaults(): void {
	const { options, error } = parseCodemapArgs([])
	assert.equal(error, undefined)
	assert.equal(options.force, false)
	assert.equal(options.watch, false)
	assert.equal(options.intervalMs, 60_000)
}

function testParseArgsFlags(): void {
	const { options, error } = parseCodemapArgs(["--workspace", "/tmp/ws", "--force", "--watch", "--interval-ms", "5000"])
	assert.equal(error, undefined)
	assert.equal(options.workspace, "/tmp/ws")
	assert.equal(options.force, true)
	assert.equal(options.watch, true)
	assert.equal(options.intervalMs, 5000)
}

function testParseArgsRejectsBadInterval(): void {
	assert.match(parseCodemapArgs(["--interval-ms", "0"]).error ?? "", /--interval-ms requires/)
	assert.match(parseCodemapArgs(["--interval-ms", "abc"]).error ?? "", /--interval-ms requires/)
}

function testParseArgsRejectsUnknownFlag(): void {
	assert.match(parseCodemapArgs(["--nope"]).error ?? "", /Unknown argument/)
}

// ─── codemapMain ─────────────────────────────────────────────────────────

async function testMainHelpExitsZero(): Promise<void> {
	const { exit, stdout } = await captureOutput(() => codemapMain(["--help"]))
	assert.equal(exit, 0)
	assert.match(stdout, /headlesscode codemap/)
}

async function testMainMissingWorkspaceExitsTwo(): Promise<void> {
	const { exit, stderr } = await captureOutput(() => codemapMain([]))
	assert.equal(exit, 2)
	assert.match(stderr, /--workspace <path> is required/)
}

async function testMainBadArgExitsTwo(): Promise<void> {
	const { exit, stderr } = await captureOutput(() => codemapMain(["--nope"]))
	assert.equal(exit, 2)
	assert.match(stderr, /Unknown argument/)
}

async function testMainOneShotRunExitsZeroAndWritesArtifacts(): Promise<void> {
	const ws = await mkTinyFixture()
	try {
		resetCodeIntelCaches()
		const { exit, stdout } = await captureOutput(() => codemapMain(["--workspace", ws]))
		assert.equal(exit, 0)
		assert.match(stdout, /codemap: regenerated/)
		assert.ok(fs.existsSync(codemapJsonPath(ws)), "codemap.json must be written by the CLI's one-shot run")

		// A second run with an unchanged fixture short-circuits (no writes,
		// different stdout message) — real exercise of the CLI-level
		// fingerprint-aware path, not just buildCodemap() directly.
		const second = await captureOutput(() => codemapMain(["--workspace", ws]))
		assert.equal(second.exit, 0)
		assert.match(second.stdout, /codemap: unchanged/)
	} finally {
		await fsp.rm(ws, { recursive: true, force: true })
	}
}

async function testMainForceAlwaysRegenerates(): Promise<void> {
	const ws = await mkTinyFixture()
	try {
		resetCodeIntelCaches()
		await captureOutput(() => codemapMain(["--workspace", ws]))
		const { exit, stdout } = await captureOutput(() => codemapMain(["--workspace", ws, "--force"]))
		assert.equal(exit, 0)
		assert.match(stdout, /codemap: regenerated/, "--force must regenerate even though nothing changed")
	} finally {
		await fsp.rm(ws, { recursive: true, force: true })
	}
}

const tests: Array<[string, () => void | Promise<void>]> = [
	["parseCodemapArgs: sane defaults", testParseArgsDefaults],
	["parseCodemapArgs: reads --workspace/--force/--watch/--interval-ms", testParseArgsFlags],
	["parseCodemapArgs: rejects a non-positive/non-numeric --interval-ms", testParseArgsRejectsBadInterval],
	["parseCodemapArgs: rejects an unknown flag", testParseArgsRejectsUnknownFlag],
	["codemapMain: --help exits 0 and prints usage", testMainHelpExitsZero],
	["codemapMain: missing --workspace exits 2", testMainMissingWorkspaceExitsTwo],
	["codemapMain: a bad arg exits 2", testMainBadArgExitsTwo],
	["codemapMain: a real one-shot run exits 0, writes codemap.json, and short-circuits on rerun", testMainOneShotRunExitsZeroAndWritesArtifacts],
	["codemapMain: --force always regenerates", testMainForceAlwaysRegenerates],
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
			console.error(err instanceof Error ? (err.stack ?? err.message) : String(err))
		}
	}
	if (failed > 0) {
		console.error(`\n${failed} test(s) failed`)
		process.exit(1)
	}
	console.log(`\nAll ${tests.length} codemap CLI tests passed`)
}

main().catch((err) => {
	console.error("Test runner crashed:", err)
	process.exit(1)
})
