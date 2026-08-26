/**
 * Unit tests for src/orchestrator/analyze-cli.ts — the ad-hoc
 * `headlesscode analyze-worktree` subcommand. Plain assert-based, no
 * network. Run via `npm test`.
 */

import assert from "node:assert/strict"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"

import { appendEvent, type EventRecord } from "../../engine/events.js"
import { analyzeCliMain, parseAnalyzeArgs } from "../analyze-cli.js"

// ─── Helpers ─────────────────────────────────────────────────────────────────

function captureStdout(): { get: () => string; restore: () => void } {
	let buf = ""
	const orig = process.stdout.write.bind(process.stdout)
	process.stdout.write = ((chunk: string) => {
		buf += chunk
		return true
	}) as typeof process.stdout.write
	return {
		get: () => buf,
		restore: () => {
			process.stdout.write = orig
		},
	}
}

function captureStderr(): { get: () => string; restore: () => void } {
	let buf = ""
	const orig = process.stderr.write.bind(process.stderr)
	process.stderr.write = ((chunk: string) => {
		buf += chunk
		return true
	}) as typeof process.stderr.write
	return {
		get: () => buf,
		restore: () => {
			process.stderr.write = orig
		},
	}
}

// ─── Tests ───────────────────────────────────────────────────────────────────

async function testParseArgsRequiresWorktree(): Promise<void> {
	const result = parseAnalyzeArgs([])
	assert.ok("error" in result)
	assert.match((result as { error: string }).error, /--worktree is required/)
}

async function testParseArgsHelp(): Promise<void> {
	const result = parseAnalyzeArgs(["--help"])
	assert.deepEqual(result, { help: true })
}

async function testParseArgsUnknownFlag(): Promise<void> {
	const result = parseAnalyzeArgs(["--worktree", "/tmp/x", "--bogus"])
	assert.ok("error" in result)
	assert.match((result as { error: string }).error, /unknown argument/)
}

async function testParseArgsInvalidStallMinutes(): Promise<void> {
	const result = parseAnalyzeArgs(["--worktree", "/tmp/x", "--stall-minutes", "not-a-number"])
	assert.ok("error" in result)
	assert.match((result as { error: string }).error, /--stall-minutes/)
}

async function testParseArgsFull(): Promise<void> {
	const result = parseAnalyzeArgs(["--worktree", "/tmp/x", "--json", "--stall-minutes", "5", "--repeat-threshold", "2"])
	assert.deepEqual(result, { worktree: "/tmp/x", json: true, stallMinutes: 5, repeatThreshold: 2 })
}

async function testMainReportsMissingEventsDir(): Promise<void> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "analyze-cli-test-"))
	const err = captureStderr()
	let code: number
	try {
		code = await analyzeCliMain(["--worktree", dir])
	} finally {
		err.restore()
	}
	assert.equal(code, 1)
	assert.match(err.get(), /no \.headlesscode\/events feed found/)
}

async function testMainHumanReadableReport(): Promise<void> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "analyze-cli-test-"))
	const record: EventRecord = {
		ts: new Date().toISOString(),
		sessionId: "s1",
		type: "tool_call",
		tool: "read_file",
		iteration: 1,
		args: "a.ts",
	}
	await appendEvent(dir, "s1", record)

	const out = captureStdout()
	let code: number
	try {
		code = await analyzeCliMain(["--worktree", dir])
	} finally {
		out.restore()
	}
	assert.equal(code, 0)
	assert.match(out.get(), /Sessions: 1/)
	assert.match(out.get(), /read_file=1/)
}

async function testMainJsonOutput(): Promise<void> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "analyze-cli-test-"))
	const record: EventRecord = {
		ts: new Date().toISOString(),
		sessionId: "s1",
		type: "tool_call",
		tool: "read_file",
		iteration: 1,
		args: "a.ts",
	}
	await appendEvent(dir, "s1", record)

	const out = captureStdout()
	let code: number
	try {
		code = await analyzeCliMain(["--worktree", dir, "--json"])
	} finally {
		out.restore()
	}
	assert.equal(code, 0)
	const parsed = JSON.parse(out.get())
	assert.equal(parsed.toolCallCounts.read_file, 1)
}

// ─── Runner ──────────────────────────────────────────────────────────────────

const tests: [string, () => Promise<void>][] = [
	["parseAnalyzeArgs requires --worktree", testParseArgsRequiresWorktree],
	["parseAnalyzeArgs --help", testParseArgsHelp],
	["parseAnalyzeArgs rejects unknown flag", testParseArgsUnknownFlag],
	["parseAnalyzeArgs rejects invalid --stall-minutes", testParseArgsInvalidStallMinutes],
	["parseAnalyzeArgs full option set", testParseArgsFull],
	["main reports missing events dir (exit 1)", testMainReportsMissingEventsDir],
	["main prints human-readable report (exit 0)", testMainHumanReadableReport],
	["main --json prints raw analysis", testMainJsonOutput],
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
	console.log(`\nAll ${tests.length} analyze-cli tests passed`)
}

main().catch((err) => {
	console.error("Test runner crashed:", err)
	process.exit(1)
})
