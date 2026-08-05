/**
 * Unit tests for `headlesscode orchestrate stop` (src/orchestrator/cli.ts's
 * stopMain + parseStopArgs) — the operator command that stops a group's worker
 * process TREE via scripts/stop-worker.sh (issue #20) and patches the group to
 * needs-human. The stop-script runner is injected, so no real processes are
 * spawned here (the real tree-kill behavior is covered by the Phase 2 e2e
 * suite). Plain assert-based (no framework, no network), matching the repo
 * test style. Run via `npm test` ->
 * `tsx src/orchestrator/__tests__/stop-cli.test.ts`.
 */

import assert from "node:assert/strict"
import * as fs from "node:fs"
import * as fsp from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"

import { parseStopArgs, stopMain } from "../cli.js"
import { defaultState, saveStateSync, updateGroup, type OrchestratorGroup, type OrchestratorState } from "../state.js"

async function tmpRepo(): Promise<string> {
	return fsp.mkdtemp(path.join(os.tmpdir(), "headlesscode-stop-"))
}

function baseGroup(overrides: Partial<OrchestratorGroup> = {}): OrchestratorGroup {
	return {
		name: "w1",
		worktree: ".worktrees/w1",
		status: "running",
		spawned: new Date().toISOString(),
		...overrides,
	}
}

/** Write a state file with one running group (w1) + one done group (w2). */
async function repoWithState(repo: string, extra: OrchestratorGroup[] = []): Promise<string> {
	let state: OrchestratorState = defaultState("r1")
	state = updateGroup(state, "w1", baseGroup())
	state = updateGroup(state, "w2", baseGroup({ name: "w2", status: "done" }))
	for (const g of extra) {
		state = updateGroup(state, g.name, g)
	}
	const statePath = path.join(repo, ".worktrees", ".orchestrator-state.json")
	await fsp.mkdir(path.dirname(statePath), { recursive: true })
	saveStateSync(statePath, state)
	return statePath
}

interface Capture {
	out: string[]
	err: string[]
	io: {
		stdout: (t: string) => void
		stderr: (t: string) => void
		runStopWorker: (wtPath: string, graceMs: number) => { exitCode: number; output: string }
	}
}

function capture(runResult?: { exitCode: number; output: string }): Capture & { calls: Array<{ wtPath: string; graceMs: number }> } {
	const out: string[] = []
	const err: string[] = []
	const calls: Array<{ wtPath: string; graceMs: number }> = []
	const io = {
		stdout: (t: string) => out.push(t),
		stderr: (t: string) => err.push(t),
		runStopWorker: (wtPath: string, graceMs: number) => {
			calls.push({ wtPath, graceMs })
			return runResult ?? { exitCode: 0, output: "" }
		},
	}
	return { out, err, io, calls }
}

// ─── parseStopArgs ───────────────────────────────────────────────────────────

async function testParseStopArgsDefaults(): Promise<void> {
	const { options, error } = parseStopArgs(["--repo", "/tmp/repo", "--group", "w1"])
	assert.equal(error, undefined)
	assert.equal(options.repo, "/tmp/repo")
	assert.deepEqual(options.groups, ["w1"])
	assert.equal(options.graceMs, 5000, "default SIGTERM grace = 5s")
	assert.equal(options.json, false)
}

async function testParseStopArgsCustomAndErrors(): Promise<void> {
	const full = parseStopArgs(["--repo", "/tmp/repo", "--group", "w1", "--group", "w2", "--grace-ms", "250", "--json"])
	assert.equal(full.error, undefined)
	assert.deepEqual(full.options.groups, ["w1", "w2"], "repeatable --group")
	assert.equal(full.options.graceMs, 250)

	const eq = parseStopArgs(["--repo=/tmp/repo", "--group=w3", "--grace-ms=1234"])
	assert.equal(eq.error, undefined)
	assert.equal(eq.options.repo, "/tmp/repo")
	assert.equal(eq.options.groups[0], "w3")
	assert.equal(eq.options.graceMs, 1234)

	assert.ok(parseStopArgs(["--repo"]).error?.includes("Missing value"), "missing --repo value errors")
	assert.ok(parseStopArgs(["--group"]).error?.includes("Missing value"), "missing --group value errors")
	assert.ok(parseStopArgs(["--grace-ms", "abc"]).error?.includes("non-negative integer"), "non-numeric grace errors")
	assert.ok(parseStopArgs(["--grace-ms", "-5"]).error?.includes("non-negative integer"), "negative grace errors")
	assert.ok(parseStopArgs(["--nope"]).error?.includes("Unknown"), "unknown flag errors")
	assert.equal(parseStopArgs(["--help"]).options.help, true)
	assert.equal(parseStopArgs(["-h"]).options.help, true)
}

// ─── stopMain ────────────────────────────────────────────────────────────────

async function testStopRunningGroupPatchesNeedsHuman(): Promise<void> {
	const repo = await tmpRepo()
	await repoWithState(repo)
	const { out, err, io, calls } = capture({ exitCode: 0, output: "stop-worker: harness worker (group 42) of wt confirmed gone\n" })
	const code = await stopMain(["--repo", repo, "--group", "w1"], io)
	assert.equal(code, 0, `expected exit 0, got ${code}`)
	assert.equal(calls.length, 1, "stop script called exactly once")
	assert.ok(calls[0].wtPath.endsWith(path.join(".worktrees", "w1")), `stop script got the group's worktree: ${calls[0].wtPath}`)
	assert.equal(calls[0].graceMs, 5000, "default grace forwarded")
	assert.ok(err.join("").length === 0, "no stderr on success")
	assert.ok(out.join("").includes("w1: worker tree stopped; group marked needs-human"), "progress line printed")

	const state = JSON.parse(await fsp.readFile(path.join(repo, ".worktrees", ".orchestrator-state.json"), "utf-8")) as OrchestratorState
	const w1 = state.groups.find((g) => g.name === "w1")
	assert.equal(w1?.status, "needs-human")
	assert.ok(w1?.stopped_at !== undefined, "stopped_at recorded")
	assert.ok(typeof w1?.last_activity === "object" && w1.last_activity !== null, "last_activity is an object")
}

async function testStopRunnerFailureLeavesGroupAlone(): Promise<void> {
	const repo = await tmpRepo()
	await repoWithState(repo)
	const { err, io, calls } = capture({ exitCode: 1, output: "stop-worker: ERROR: harness worker group 42 survived SIGKILL" })
	const code = await stopMain(["--repo", repo, "--group", "w1"], io)
	assert.equal(code, 1, "runner failure => exit 1")
	assert.equal(calls.length, 1)
	assert.ok(err.join("").includes("stop-worker.sh failed"), "failure surfaced on stderr")
	const state = JSON.parse(await fsp.readFile(path.join(repo, ".worktrees", ".orchestrator-state.json"), "utf-8")) as OrchestratorState
	assert.equal(state.groups.find((g) => g.name === "w1")?.status, "running", "group left as-is on failure")
	assert.equal(state.groups.find((g) => g.name === "w1")?.stopped_at, undefined, "no stopped_at on failure")
}

async function testStopUnknownGroupValidatedBeforeStopping(): Promise<void> {
	const repo = await tmpRepo()
	await repoWithState(repo)
	const { io, calls } = capture()
	const code = await stopMain(["--repo", repo, "--group", "w1", "--group", "nope"], io)
	assert.equal(code, 1)
	assert.equal(calls.length, 0, "NOTHING stopped when any requested group is unknown")
}

async function testStopAlreadyTerminalGroupUntouched(): Promise<void> {
	const repo = await tmpRepo()
	await repoWithState(repo)
	const { io, calls, out } = capture()
	const code = await stopMain(["--repo", repo, "--group", "w2"], io)
	assert.equal(code, 0, "already-terminal group is not a failure")
	assert.equal(calls.length, 0, "stop script NOT called for a terminal group")
	assert.ok(out.join("").includes("already done — nothing to stop"), "explicit no-op line")
	const state = JSON.parse(await fsp.readFile(path.join(repo, ".worktrees", ".orchestrator-state.json"), "utf-8")) as OrchestratorState
	assert.equal(state.groups.find((g) => g.name === "w2")?.status, "done", "done group stays done")
	assert.equal(state.groups.find((g) => g.name === "w2")?.stopped_at, undefined)
}

async function testStopMissingStateFileErrors(): Promise<void> {
	const repo = await tmpRepo()
	// No .worktrees/.orchestrator-state.json written.
	const { err, io } = capture()
	const code = await stopMain(["--repo", repo, "--group", "w1"], io)
	assert.equal(code, 1)
	assert.ok(err.join("").includes("no orchestrator state file"), "missing state file surfaced")
}

async function testStopJsonOutput(): Promise<void> {
	const repo = await tmpRepo()
	await repoWithState(repo)
	const { out, io } = capture({ exitCode: 0, output: "" })
	const code = await stopMain(["--repo", repo, "--group", "w1", "--json"], io)
	assert.equal(code, 0)
	const parsed = JSON.parse(out.join("")) as { stopped: string[]; results: Array<{ name: string; stopped: boolean }> }
	assert.deepEqual(parsed.stopped, ["w1"])
	assert.equal(parsed.results[0].stopped, true)
}

async function testStopMultipleGroupsOneFails(): Promise<void> {
	const repo = await tmpRepo()
	await repoWithState(repo)
	// w1 succeeds, w3 fails.
	await updateStateWith(repo, baseGroup({ name: "w3", status: "running" }))
	const { io, calls } = capture({ exitCode: 0, output: "" })
	let call = 0
	const failingIo = {
		...io,
		runStopWorker: () => {
			call++
			return { exitCode: call === 2 ? 1 : 0, output: `call ${call}` }
		},
	}
	const code = await stopMain(["--repo", repo, "--group", "w1", "--group", "w3"], failingIo)
	assert.equal(code, 1, "one failing group => exit 1")
	assert.equal(call, 2, "both groups attempted")
	const state = JSON.parse(await fsp.readFile(path.join(repo, ".worktrees", ".orchestrator-state.json"), "utf-8")) as OrchestratorState
	assert.equal(state.groups.find((g) => g.name === "w1")?.status, "needs-human", "successful group patched")
	assert.equal(state.groups.find((g) => g.name === "w3")?.status, "running", "failed group left alone")
}

/** Merge a group into the on-disk state (test helper). */
async function updateStateWith(repo: string, group: OrchestratorGroup): Promise<void> {
	const statePath = path.join(repo, ".worktrees", ".orchestrator-state.json")
	const state = JSON.parse(fs.readFileSync(statePath, "utf-8")) as OrchestratorState
	saveStateSync(statePath, updateGroup(state, group.name, group))
}

async function testStopUsageErrors(): Promise<void> {
	const repo = await tmpRepo()
	const missingRepo = await stopMain(["--group", "w1"], capture().io)
	assert.equal(missingRepo, 2, "missing --repo is a usage error")
	const missingGroup = await stopMain(["--repo", repo], capture().io)
	assert.equal(missingGroup, 2, "missing --group is a usage error")
	const unknownFlag = await stopMain(["--repo", repo, "--group", "w1", "--nope"], capture().io)
	assert.equal(unknownFlag, 2, "unknown flag is a usage error")
	const help = await stopMain(["--repo", repo, "--help"], { stdout: () => {}, stderr: () => {} })
	assert.equal(help, 0, "--help exits 0")
}

// ─── Registration ────────────────────────────────────────────────────────────

const tests: Array<[string, () => Promise<void>]> = [
	["parse: defaults (grace 5000, no json)", testParseStopArgsDefaults],
	["parse: custom flags, --flag=value forms, and error paths", testParseStopArgsCustomAndErrors],
	["stop: running group -> needs-human + stopped_at (exit 0)", testStopRunningGroupPatchesNeedsHuman],
	["stop: runner failure -> group left as-is, exit 1", testStopRunnerFailureLeavesGroupAlone],
	["stop: unknown group validated before anything is stopped", testStopUnknownGroupValidatedBeforeStopping],
	["stop: already-terminal group untouched (exit 0)", testStopAlreadyTerminalGroupUntouched],
	["stop: missing state file -> exit 1", testStopMissingStateFileErrors],
	["stop: --json carries stopped + results", testStopJsonOutput],
	["stop: multiple groups, one fails -> exit 1, only the good one patched", testStopMultipleGroupsOneFails],
	["stop: usage errors exit 2, --help exits 0", testStopUsageErrors],
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
	console.log(`\nAll ${tests.length} stop-cli tests passed`)
}

main().catch((err) => {
	console.error("Test runner crashed:", err)
	process.exit(1)
})
