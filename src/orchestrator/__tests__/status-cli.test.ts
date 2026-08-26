/**
 * Unit tests for `headlesscode orchestrate status` (src/orchestrator/cli.ts's
 * statusMain + src/orchestrator/status.ts) — the read-side status/wait
 * command external callers use instead of hand-rolled poll loops over
 * .orchestrator-state.json. Plain assert-based (no framework, no network)
 * matching the repo test style. Run via `npm test`.
 */

import assert from "node:assert/strict"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"

import { parseStatusArgs, statusMain } from "../cli.js"
import { reconcileGroups, waitForTerminalState } from "../status.js"
import {
	defaultState,
	loadStateSync,
	saveStateSync,
	updateGroup,
	type OrchestratorGroup,
	type OrchestratorState,
} from "../state.js"

async function tmpRepo(): Promise<string> {
	return fs.mkdtemp(path.join(os.tmpdir(), "headlesscode-status-"))
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

/** A 3-group fixture: one done, one failed, one running, plus round totals. */
function mixedState(): OrchestratorState {
	let state = defaultState("r1")
	state = updateGroup(state, "w-done", baseGroup({ name: "w-done", status: "done", last_activity: "merged to master" }))
	state = updateGroup(state, "w-fail", baseGroup({ name: "w-fail", status: "failed", exit_code: 7 }))
	state = updateGroup(state, "w-run", baseGroup({ name: "w-run", status: "running" }))
	state.totalUsage = { costUsd: 0.042, inputTokens: 1000, outputTokens: 500, iterations: 3 }
	// Issue #118: per-batch aggregate sits alongside the cumulative total.
	state.batchUsage = { costUsd: 0.021, inputTokens: 500, outputTokens: 250, iterations: 1 }
	return state
}

interface Capture {
	out: string[]
	err: string[]
	io: { stdout: (t: string) => void; stderr: (t: string) => void }
}

function capture(): Capture {
	const out: string[] = []
	const err: string[] = []
	return {
		out,
		err,
		io: {
			stdout: (t: string) => out.push(t),
			stderr: (t: string) => err.push(t),
		},
	}
}

// ─── parseStatusArgs ─────────────────────────────────────────────────────────

async function testParseStatusArgsDefaults(): Promise<void> {
	const { options, error } = parseStatusArgs(["--repo", "/tmp/repo"])
	assert.equal(error, undefined)
	assert.equal(options.repo, "/tmp/repo")
	assert.equal(options.json, false)
	assert.equal(options.wait, false)
	assert.equal(options.timeoutMs, 2 * 60 * 60 * 1000, "default timeout = 2h (watcher stall guard)")
	assert.equal(options.pollIntervalMs, 5000, "default poll = 5s (watcher write cadence)")
}

async function testParseStatusArgsCustomAndErrors(): Promise<void> {
	const full = parseStatusArgs(["--repo", "/tmp/repo", "--wait", "--json", "--timeout-ms", "60000", "--poll-interval-ms", "250"])
	assert.equal(full.error, undefined)
	assert.equal(full.options.wait, true)
	assert.equal(full.options.json, true)
	assert.equal(full.options.timeoutMs, 60000)
	assert.equal(full.options.pollIntervalMs, 250)

	// `--flag=value` form works too.
	const eq = parseStatusArgs(["--repo=/tmp/repo", "--timeout-ms=1234"])
	assert.equal(eq.error, undefined)
	assert.equal(eq.options.repo, "/tmp/repo")
	assert.equal(eq.options.timeoutMs, 1234)

	assert.ok(parseStatusArgs(["--repo"]).error?.includes("Missing value"), "missing --repo value errors")
	assert.ok(parseStatusArgs(["--timeout-ms", "abc"]).error?.includes("positive integer"), "non-numeric timeout errors")
	assert.ok(parseStatusArgs(["--timeout-ms", "0"]).error?.includes("positive integer"), "zero timeout errors")
	assert.ok(parseStatusArgs(["--nope"]).error?.includes("Unknown"), "unknown flag errors")
	assert.equal(parseStatusArgs(["--help"]).options.help, true)
}

async function testParseStatusArgsOnGroupTerminal(): Promise<void> {
	const ok = parseStatusArgs(["--repo", "/tmp/repo", "--wait", "--on-group-terminal", "echo"])
	assert.equal(ok.error, undefined)
	assert.equal(ok.options.onGroupTerminal, "echo")

	// The whole next arg is the command (no shell parsing later, so a
	// multi-word command like "echo GOT:" is kept intact).
	const multiWord = parseStatusArgs(["--repo", "/tmp/repo", "--on-group-terminal", "echo GOT:"])
	assert.equal(multiWord.error, undefined)
	assert.equal(multiWord.options.onGroupTerminal, "echo GOT:")

	const eq = parseStatusArgs(["--repo=/tmp/repo", "--on-group-terminal=echo"])
	assert.equal(eq.error, undefined)
	assert.equal(eq.options.onGroupTerminal, "echo", "--flag=value form works")

	const missing = parseStatusArgs(["--repo", "/tmp/repo", "--on-group-terminal"])
	assert.ok(
		missing.error?.includes("Missing value for --on-group-terminal"),
		"missing value errors (got: " + String(missing.error) + ")",
	)
}

// ─── One-shot status ─────────────────────────────────────────────────────────

async function testOneShotPrintsHumanSummary(): Promise<void> {
	const repo = await tmpRepo()
	try {
		saveStateSync(path.join(repo, ".worktrees", ".orchestrator-state.json"), mixedState())
		const cap = capture()
		const code = await statusMain(["--repo", repo], cap.io)

		const text = cap.out.join("")
		assert.equal(code, 1, "failed group present -> exit 1")
		assert.ok(text.includes("── Orchestrator status ──"), "header line")
		assert.ok(text.includes(`repo:       ${path.resolve(repo)}`), "repo line")
		assert.ok(text.includes("state file:"), "state file line")
		assert.ok(text.includes("batch:      r1"), "batch line")
		assert.ok(text.includes("total usage: $0.0420"), "round totals line")
		assert.ok(text.includes("batch usage: $0.0210"), "issue #118 batch totals line")
		assert.ok(text.includes("w-done"), "done group row")
		assert.ok(text.includes("w-fail"), "failed group row")
		assert.ok(text.includes("w-run"), "group row present")
		// The fixture's w-run has no worktree on disk, so reconciliation must
		// surface it as "orphaned" — distinctly, not as a silent "done".
		assert.ok(text.includes("orphaned"), "orphaned status rendered for the worktree-less running group")
		assert.ok(text.includes("3 groups: 1 done · 1 failed · 0 needs-human · 0 blocked · 0 running/spawned · 1 orphaned"), "counts line")
		assert.ok(text.includes("reconciled: w-run (stale status patched from worktree markers)"), "reconciliation is surfaced in text")
		assert.equal(cap.err.join(""), "", "no stderr on a healthy read")
	} finally {
		await fs.rm(repo, { recursive: true, force: true })
	}
}

async function testOneShotAllDoneExitsZero(): Promise<void> {
	const repo = await tmpRepo()
	try {
		let state = defaultState("r1")
		state = updateGroup(state, "w-done", baseGroup({ name: "w-done", status: "done" }))
		saveStateSync(path.join(repo, ".worktrees", ".orchestrator-state.json"), state)
		const cap = capture()
		const code = await statusMain(["--repo", repo], cap.io)
		assert.equal(code, 0, "all done -> exit 0")
		assert.ok(cap.out.join("").includes("1 group: 1 done · 0 failed"), "singular counts line")
	} finally {
		await fs.rm(repo, { recursive: true, force: true })
	}
}

async function testOneShotJsonShape(): Promise<void> {
	const repo = await tmpRepo()
	try {
		saveStateSync(path.join(repo, ".worktrees", ".orchestrator-state.json"), mixedState())
		const cap = capture()
		const code = await statusMain(["--repo", repo, "--json"], cap.io)

		assert.equal(code, 1, "failed group present -> exit 1 even in --json mode")
		const parsed = JSON.parse(cap.out.join("")) as OrchestratorState & { reconciled?: string[] }
		assert.equal(parsed.batch, "r1")
		assert.equal(parsed.groups.length, 3)
		assert.deepEqual(
			parsed.groups.map((g) => g.status).sort(),
			["done", "failed", "orphaned"],
			"--json passes the reconciled groups through (the worktree-less running group is orphaned)",
		)
		assert.deepEqual(parsed.reconciled, ["w-run"], "--json notes the group this call reconciled")
		assert.ok(parsed.totalUsage && parsed.totalUsage.costUsd === 0.042, "round totals preserved")
		assert.ok(parsed.batchUsage && parsed.batchUsage.costUsd === 0.021, "issue #118 batch totals preserved")
	} finally {
		await fs.rm(repo, { recursive: true, force: true })
	}
}

async function testOneShotInvalidStateFileExitsOne(): Promise<void> {
	const repo = await tmpRepo()
	try {
		const statePath = path.join(repo, ".worktrees", ".orchestrator-state.json")
		await fs.mkdir(path.dirname(statePath), { recursive: true })
		await fs.writeFile(statePath, "this is not json", "utf8")
		const cap = capture()
		const code = await statusMain(["--repo", repo], cap.io)
		assert.equal(code, 1, "unreadable state file -> exit 1")
		assert.ok(cap.err.join("").includes("cannot read state file"), "clear error on stderr")
	} finally {
		await fs.rm(repo, { recursive: true, force: true })
	}
}

async function testOneShotMissingRepoArgIsUsageError(): Promise<void> {
	const cap = capture()
	const code = await statusMain([], cap.io)
	assert.equal(code, 2, "missing --repo -> usage error exit 2")
	assert.ok(cap.err.join("").includes("--repo <path> is required"), "usage error message")

	const bad = capture()
	const code2 = await statusMain(["--repo", "/tmp/x", "--bogus"], bad.io)
	assert.equal(code2, 2, "unknown flag -> usage error exit 2")
}

// ─── waitForTerminalState (unit: fake state reader) ──────────────────────────

async function testWaitReturnsWhenAllGroupsDone(): Promise<void> {
	let calls = 0
	const readState = (): OrchestratorState => {
		calls++
		if (calls < 3) {
			return updateGroup(defaultState("r1"), "w1", baseGroup({ status: "running" }))
		}
		return updateGroup(defaultState("r1"), "w1", baseGroup({ status: "done" }))
	}
	const result = await waitForTerminalState("", { pollIntervalMs: 5, timeoutMs: 5000, readState })

	assert.equal(result.allDone, true)
	assert.equal(result.timedOut, false)
	assert.equal(result.state.groups[0].status, "done")
	// Floor of one poll interval (5ms): with a ms-resolution clock the expected
	// ~10ms of real time (2 polls x 5ms) can truncate to 9ms and flake; the
	// `calls >= 3` assertion below already proves it polled past the first read.
	assert.ok(result.elapsedMs >= 5, `waited for the transition, got ${result.elapsedMs}ms`)
	assert.ok(calls >= 3, `polled until terminal, got ${calls} reads`)
}

async function testWaitTerminalButFailedIsNotAllDone(): Promise<void> {
	const readState = (): OrchestratorState =>
		updateGroup(defaultState("r1"), "w1", baseGroup({ name: "w1", status: "failed" }))
	const result = await waitForTerminalState("", { pollIntervalMs: 5, timeoutMs: 5000, readState })

	assert.equal(result.allDone, false, "failed is terminal but NOT done")
	assert.equal(result.timedOut, false)
	assert.equal(result.state.groups[0].status, "failed")
}

async function testWaitBlockedIsNotTerminalAndTimesOut(): Promise<void> {
	// A "blocked" group is a decision-escalation wait state: --wait must keep
	// waiting (not exit early), so a never-unblocked round times out instead.
	const readState = (): OrchestratorState =>
		updateGroup(defaultState("r1"), "w1", baseGroup({ status: "blocked" }))
	const result = await waitForTerminalState("", { pollIntervalMs: 5, timeoutMs: 60, readState })

	assert.equal(result.timedOut, true, "blocked is NOT terminal -> wait times out")
	assert.equal(result.allDone, false)
	assert.equal(result.state.groups[0].status, "blocked")
	assert.ok(result.elapsedMs >= 60, `respected the timeout, got ${result.elapsedMs}ms`)
}

async function testWaitEmptyStateReturnsImmediately(): Promise<void> {
	// An empty state file (round not started / wrong path) is nothing to wait
	// for — return immediately rather than hang until the timeout.
	const result = await waitForTerminalState("", { pollIntervalMs: 5, timeoutMs: 60000, readState: () => defaultState("r1") })
	assert.equal(result.timedOut, false)
	assert.equal(result.allDone, false)
	assert.equal(result.state.groups.length, 0)
	assert.ok(result.elapsedMs < 1000, `returned promptly, got ${result.elapsedMs}ms`)
}

// ─── onGroupTerminal (Bug 2: per-group terminal notifications) ────────────────

async function testWaitOnGroupTerminalFiresOnGenuineTransition(): Promise<void> {
	let calls = 0
	const fired: Array<{ name: string; status: string }> = []
	const readState = (): OrchestratorState => {
		calls++
		if (calls < 3) {
			return updateGroup(defaultState("r1"), "w1", baseGroup({ status: "running" }))
		}
		return updateGroup(defaultState("r1"), "w1", baseGroup({ status: "failed" }))
	}
	const result = await waitForTerminalState("", {
		pollIntervalMs: 5,
		timeoutMs: 5000,
		readState,
		onGroupTerminal: (group) => {
			fired.push({ name: group.name, status: group.status })
		},
	})

	assert.deepEqual(fired, [{ name: "w1", status: "failed" }], "fires exactly once, with name + terminal status")
	assert.equal(result.allDone, false, "failed is terminal but not done")
}

async function testWaitOnGroupTerminalSkipsAlreadyTerminalGroups(): Promise<void> {
	const fired: string[] = []
	const readState = (): OrchestratorState =>
		updateGroup(defaultState("r1"), "w1", baseGroup({ name: "w1", status: "done" }))
	const result = await waitForTerminalState("", {
		pollIntervalMs: 5,
		timeoutMs: 5000,
		readState,
		onGroupTerminal: (group) => {
			fired.push(`${group.name}:${group.status}`)
		},
	})

	assert.equal(result.allDone, true)
	assert.deepEqual(fired, [], "groups already terminal when the wait started never fire")
}

async function testWaitOnGroupTerminalSkipsReconciliationOnlyChanges(): Promise<void> {
	const repo = await tmpRepo()
	try {
		const statePath = path.join(repo, ".worktrees", ".orchestrator-state.json")
		// The worker ALREADY finished before the wait started: the state file
		// still says "running", but ground truth (the worktree's .harness.done
		// marker + non-zero .harness.exit) says failed. The FIRST reconciliation
		// patches it to terminal BEFORE lastSeenStatus is seeded — the group
		// was always terminal, just stale in the file, so no genuine
		// transition exists and the callback must NOT fire.
		await fs.mkdir(path.join(repo, ".worktrees", "w1", ".harness.done"), { recursive: true })
		await fs.writeFile(path.join(repo, ".worktrees", "w1", ".harness.exit"), "3", "utf8")
		saveStateSync(statePath, updateGroup(defaultState("r1"), "w1", baseGroup({ status: "running" })))

		const fired: string[] = []
		await waitForTerminalState(statePath, {
			pollIntervalMs: 5,
			timeoutMs: 5000,
			reconcile: (state) => {
				const r = reconcileGroups(state, repo)
				if (r.reconciled.length > 0) {
					saveStateSync(statePath, r.state)
				}
				return r
			},
			onGroupTerminal: (group) => {
				fired.push(`${group.name}:${group.status}`)
			},
		})
		assert.deepEqual(fired, [], "reconciliation-only changes (stale running -> failed) never fire")
	} finally {
		await fs.rm(repo, { recursive: true, force: true })
	}
}

// ─── statusMain --wait (end-to-end via the real state file) ─────────────────

async function testWaitAgainstRealFileTransitionsToDone(): Promise<void> {
	const repo = await tmpRepo()
	try {
		const statePath = path.join(repo, ".worktrees", ".orchestrator-state.json")
		// The worktree must EXIST so reconciliation keeps the group genuinely
		// running (a missing worktree would reconcile it to "orphaned"
		// instantly and the wait would not be waiting at all).
		await fs.mkdir(path.join(repo, ".worktrees", "w1"), { recursive: true })
		saveStateSync(statePath, updateGroup(defaultState("r1"), "w1", baseGroup({ status: "running" })))

		const cap = capture()
		const waitPromise = statusMain(["--repo", repo, "--wait", "--timeout-ms", "5000", "--poll-interval-ms", "25"], cap.io)

		// Transition the state file partway through the wait (the watcher
		// would do this; here the test plays the writer).
		await new Promise((resolve) => setTimeout(resolve, 150))
		saveStateSync(statePath, updateGroup(defaultState("r1"), "w1", baseGroup({ status: "done" })))

		const code = await waitPromise
		const text = cap.out.join("")

		assert.equal(code, 0, "clean finish -> exit 0")
		assert.ok(text.includes("(waited"), "duration is reported")
		assert.ok(text.includes("verdict: 1/1 groups done, 0 failed"), "one-line verdict")
	} finally {
		await fs.rm(repo, { recursive: true, force: true })
	}
}

async function testWaitTimesOutWithClearVerdict(): Promise<void> {
	const repo = await tmpRepo()
	try {
		// Two groups: one done, one running forever. The running group's
		// worktree must EXIST (no .harness.done) so reconciliation leaves it
		// running and the wait actually times out. baseGroup's default
		// worktree is ".worktrees/w1", so pin it explicitly.
		const statePath = path.join(repo, ".worktrees", ".orchestrator-state.json")
		let state = updateGroup(defaultState("r1"), "w-done", baseGroup({ name: "w-done", status: "done" }))
		state = updateGroup(
			state,
			"w-run",
			baseGroup({ name: "w-run", status: "running", worktree: ".worktrees/w-run" }),
		)
		saveStateSync(statePath, state)
		await fs.mkdir(path.join(repo, ".worktrees", "w-run"), { recursive: true })

		const cap = capture()
		const code = await statusMain(["--repo", repo, "--wait", "--timeout-ms", "100", "--poll-interval-ms", "15"], cap.io)

		assert.equal(code, 1, "timeout -> exit 1")
		assert.ok(cap.out.join("").includes("verdict: timed out after 1 of 2 groups done"), "timeout verdict names progress")
	} finally {
		await fs.rm(repo, { recursive: true, force: true })
	}
}

async function testWaitJsonCarriesVerdictFields(): Promise<void> {
	const repo = await tmpRepo()
	try {
		const statePath = path.join(repo, ".worktrees", ".orchestrator-state.json")
		saveStateSync(statePath, updateGroup(defaultState("r1"), "w1", baseGroup({ status: "done" })))

		const cap = capture()
		const code = await statusMain(["--repo", repo, "--wait", "--json", "--timeout-ms", "1000"], cap.io)

		assert.equal(code, 0, "all done -> exit 0")
		const parsed = JSON.parse(cap.out.join("")) as Record<string, unknown> & { allDone: boolean; timedOut: boolean; verdict: string }
		assert.equal(parsed.allDone, true, "top-level allDone flag")
		assert.equal(parsed.timedOut, false, "top-level timedOut flag")
		assert.equal(parsed.verdict, "1/1 groups done, 0 failed", "top-level verdict line")
		assert.ok(Array.isArray(parsed.groups), "state shape preserved alongside the verdict fields")
	} finally {
		await fs.rm(repo, { recursive: true, force: true })
	}
}

async function testWaitOnGroupTerminalHookSpawnsCommand(): Promise<void> {
	const repo = await tmpRepo()
	try {
		const statePath = path.join(repo, ".worktrees", ".orchestrator-state.json")
		// Worktree must EXIST so reconciliation keeps the group genuinely
		// running while the wait polls (a missing worktree would reconcile it
		// to orphaned instantly and no live transition would ever be observed).
		await fs.mkdir(path.join(repo, ".worktrees", "w1"), { recursive: true })
		saveStateSync(statePath, updateGroup(defaultState("r1"), "w1", baseGroup({ status: "running" })))

		// The hook: a tiny script that records its two positional args (group
		// name + terminal status) to a log file.
		const hookLog = path.join(repo, "hook-args.log")
		const hook = path.join(repo, "hook.sh")
		await fs.writeFile(hook, `#!/bin/sh\nprintf '%s %s\\n' "$1" "$2" >> "${hookLog}"\n`, "utf-8")
		await fs.chmod(hook, 0o755)

		const cap = capture()
		const waitPromise = statusMain(
			["--repo", repo, "--wait", "--timeout-ms", "5000", "--poll-interval-ms", "25", "--on-group-terminal", hook],
			cap.io,
		)

		// Transition the state file partway through the wait (the watcher
		// would do this; here the test plays the writer).
		await new Promise((resolve) => setTimeout(resolve, 150))
		saveStateSync(statePath, updateGroup(defaultState("r1"), "w1", baseGroup({ status: "done" })))

		const code = await waitPromise
		assert.equal(code, 0, "clean finish -> exit 0")
		const log = await fs.readFile(hookLog, "utf-8")
		assert.ok(log.trim() === "w1 done", `hook received <group-name> <status>, got: ${JSON.stringify(log)}`)
	} finally {
		await fs.rm(repo, { recursive: true, force: true })
	}
}

// ─── Read-side reconciliation (one-shot + --wait) ────────────────────────────

/**
	* Create `<repo>/.worktrees/<name>`; when `exitCode` is given also drop the
	* `.harness.done` marker dir + `.harness.exit` file the watcher/run-worker.sh
	* would have left behind. No exitCode → worktree exists with NO marker (a
	* genuinely still-running worker).
	*/
async function makeWorktree(repo: string, name: string, exitCode?: number): Promise<void> {
	const wt = path.join(repo, ".worktrees", name)
	await fs.mkdir(wt, { recursive: true })
	if (exitCode === undefined) {
		return
	}
	// Order matters: run-worker.sh writes .harness.exit FIRST, then creates
	// the .harness.done marker dir (the done marker is the atomic last write
	// — see scripts/run-worker.sh:222-223). Reverse the order and a reader
	// can observe done-without-exit, which reconciles to "failed".
	await fs.writeFile(path.join(wt, ".harness.exit"), String(exitCode), "utf8")
	await fs.mkdir(path.join(wt, ".harness.done"), { recursive: true })
}

async function testOneShotReconcilesDoneFromMarkersAndPersists(): Promise<void> {
	const repo = await tmpRepo()
	try {
		const statePath = path.join(repo, ".worktrees", ".orchestrator-state.json")
		saveStateSync(statePath, updateGroup(defaultState("r1"), "w1", baseGroup({ status: "running" })))
		await makeWorktree(repo, "w1", 0)

		const cap = capture()
		const code = await statusMain(["--repo", repo], cap.io)

		assert.equal(code, 0, "reconciled to done -> exit 0")
		assert.ok(cap.out.join("").includes("w1"), "group row present")
		// The patch must be persisted back to the state file, not just
		// applied to the in-memory copy.
		const onDisk = loadStateSync(statePath)
		assert.equal(onDisk.groups[0].status, "done", "state file updated to done")
		assert.equal(onDisk.groups[0].exit_code, 0, "exit_code recorded in the state file")
	} finally {
		await fs.rm(repo, { recursive: true, force: true })
	}
}

async function testOneShotReconcilesFailedFromNonZeroExit(): Promise<void> {
	const repo = await tmpRepo()
	try {
		const statePath = path.join(repo, ".worktrees", ".orchestrator-state.json")
		saveStateSync(statePath, updateGroup(defaultState("r1"), "w1", baseGroup({ status: "running" })))
		await makeWorktree(repo, "w1", 3)

		const cap = capture()
		const code = await statusMain(["--repo", repo], cap.io)

		assert.equal(code, 1, "reconciled to failed -> exit 1")
		const onDisk = loadStateSync(statePath)
		assert.equal(onDisk.groups[0].status, "failed", "state file updated to failed")
		assert.equal(onDisk.groups[0].exit_code, 3, "non-zero exit_code recorded")
	} finally {
		await fs.rm(repo, { recursive: true, force: true })
	}
}

async function testOneShotReconcilesOrphanedDistinctly(): Promise<void> {
	const repo = await tmpRepo()
	try {
		const statePath = path.join(repo, ".worktrees", ".orchestrator-state.json")
		saveStateSync(statePath, updateGroup(defaultState("r1"), "w1", baseGroup({ status: "running" })))
		// No worktree dir at all → nothing to wait for, outcome unknowable.

		const cap = capture()
		const code = await statusMain(["--repo", repo], cap.io)

		assert.equal(code, 1, "orphaned is a needs-attention outcome -> exit 1")
		const text = cap.out.join("")
		assert.ok(text.includes("orphaned"), "text renders the orphaned status")
		assert.ok(text.includes("1 group: 0 done · 0 failed · 0 needs-human · 0 blocked · 0 running/spawned · 1 orphaned"), "counts line keeps orphaned distinct from done")
		assert.ok(!/1 group: 1 done/.test(text), "orphaned is never reported as done")

		const onDisk = loadStateSync(statePath)
		assert.equal(onDisk.groups[0].status, "orphaned", "state file updated to orphaned")

		// --json on a FRESH stale state: distinct status + reconciled list.
		saveStateSync(statePath, updateGroup(defaultState("r1"), "w1", baseGroup({ status: "running" })))
		const capJson = capture()
		await statusMain(["--repo", repo, "--json"], capJson.io)
		const parsed = JSON.parse(capJson.out.join("")) as OrchestratorState & { reconciled?: string[] }
		assert.equal(parsed.groups[0].status, "orphaned", "json status is orphaned, not done")
		assert.deepEqual(parsed.reconciled, ["w1"], "json notes the group this call reconciled")
	} finally {
		await fs.rm(repo, { recursive: true, force: true })
	}
}

async function testOneShotLeavesRunningGroupWithLiveWorktreeAlone(): Promise<void> {
	const repo = await tmpRepo()
	try {
		const statePath = path.join(repo, ".worktrees", ".orchestrator-state.json")
		saveStateSync(statePath, updateGroup(defaultState("r1"), "w1", baseGroup({ status: "running" })))
		// Worktree exists but has NO .harness.done marker → genuinely running.
		await makeWorktree(repo, "w1")

		const cap = capture()
		const code = await statusMain(["--repo", repo], cap.io)

		assert.equal(code, 0, "running-only state -> exit 0")
		assert.ok(cap.out.join("").includes("1 running/spawned"), "group still reported running")
		const onDisk = loadStateSync(statePath)
		assert.equal(onDisk.groups[0].status, "running", "reconciliation must not touch a live worktree")
	} finally {
		await fs.rm(repo, { recursive: true, force: true })
	}
}

async function testWaitReconcilesStaleGroupPromptly(): Promise<void> {
	const repo = await tmpRepo()
	try {
		const statePath = path.join(repo, ".worktrees", ".orchestrator-state.json")
		let state = updateGroup(defaultState("r1"), "w1", baseGroup({ status: "running" }))
		state = updateGroup(state, "w2", baseGroup({ name: "w2", status: "done" }))
		saveStateSync(statePath, state)
		// w1 is stale-but-reconcilable: its worktree still exists with a real
		// .harness.done marker, it's just that nobody updated the state file.
		await makeWorktree(repo, "w1", 0)

		const t0 = Date.now()
		const cap = capture()
		const code = await statusMain(
			["--repo", repo, "--wait", "--json", "--timeout-ms", "5000", "--poll-interval-ms", "50"],
			cap.io,
		)
		const elapsed = Date.now() - t0

		assert.equal(code, 0, "reconciled to done + all done -> exit 0")
		const parsed = JSON.parse(cap.out.join("")) as OrchestratorState & {
			allDone: boolean
			timedOut: boolean
			verdict: string
			reconciled?: string[]
		}
		assert.equal(parsed.allDone, true)
		assert.equal(parsed.timedOut, false)
		assert.equal(parsed.verdict, "2/2 groups done, 0 failed")
		assert.deepEqual(parsed.reconciled, ["w1"], "wait reports the reconciled group")
		assert.ok(elapsed < 2000, `returned promptly instead of waiting the timeout (${elapsed}ms)`)

		// Issue #116: with NO live watcher (no heartbeat file), the wait is
		// the only writer and its reconcile patch must still persist.
		const onDisk = loadStateSync(statePath)
		assert.equal(onDisk.groups[0].status, "done", "wait persisted the reconcile with no live watcher")
	} finally {
		await fs.rm(repo, { recursive: true, force: true })
	}
}

/**
 * Issue #116: `status --wait` running CONCURRENTLY with a live orchestrate
 * round used to persist its read-side reconciliation, pre-empting the
 * watcher (which then short-circuited the group and silently skipped log
 * analysis + the automated review). With the watcher's heartbeat present,
 * the wait must reconcile IN MEMORY only — the shared state file must keep
 * saying "running" so the watcher still owns the done transition.
 */
async function testWaitDoesNotPersistReconcileWhenWatcherHeartbeatFresh(): Promise<void> {
	const repo = await tmpRepo()
	try {
		const statePath = path.join(repo, ".worktrees", ".orchestrator-state.json")
		saveStateSync(statePath, updateGroup(defaultState("r1"), "w1", baseGroup({ status: "running" })))
		await makeWorktree(repo, "w1", 0)
		// A live watcher owns the state: its heartbeat file is fresh.
		await fs.writeFile(`${statePath}.watcher`, "99999", "utf8")

		const cap = capture()
		const code = await statusMain(
			["--repo", repo, "--wait", "--json", "--timeout-ms", "5000", "--poll-interval-ms", "25"],
			cap.io,
		)

		assert.equal(code, 0, "in-memory reconcile to done -> all done -> exit 0")
		const parsed = JSON.parse(cap.out.join("")) as OrchestratorState & { reconciled?: string[] }
		assert.equal(parsed.groups[0].status, "done", "the wait's REPORTED state reflects the in-memory reconcile")
		assert.deepEqual(parsed.reconciled, ["w1"], "wait still reports the group it reconciled")
		// The persisted file must be untouched — the watcher owns the done
		// transition and must still observe the group as running.
		const onDisk = loadStateSync(statePath)
		assert.equal(onDisk.groups[0].status, "running", "no persist while a live watcher owns the state")
	} finally {
		await fs.rm(repo, { recursive: true, force: true })
	}
}

/** A STALE heartbeat means the watcher is gone — the wait may persist again. */
async function testWaitPersistsWhenWatcherHeartbeatStale(): Promise<void> {
	const repo = await tmpRepo()
	try {
		const statePath = path.join(repo, ".worktrees", ".orchestrator-state.json")
		saveStateSync(statePath, updateGroup(defaultState("r1"), "w1", baseGroup({ status: "running" })))
		await makeWorktree(repo, "w1", 0)
		// A heartbeat from 10 minutes ago: the watcher is dead; the wait is
		// the only writer and must patch the stale entry back.
		const stale = new Date(Date.now() - 10 * 60 * 1000)
		await fs.writeFile(`${statePath}.watcher`, "99999", "utf8")
		const { utimes } = await import("node:fs/promises")
		await utimes(`${statePath}.watcher`, stale, stale)

		const cap = capture()
		const code = await statusMain(
			["--repo", repo, "--wait", "--json", "--timeout-ms", "5000", "--poll-interval-ms", "25"],
			cap.io,
		)

		assert.equal(code, 0, "all done -> exit 0")
		const onDisk = loadStateSync(statePath)
		assert.equal(onDisk.groups[0].status, "done", "stale watcher heartbeat -> wait persists the reconcile")
	} finally {
		await fs.rm(repo, { recursive: true, force: true })
	}
}

/**
 * Issue #116 (rework cycle 1): a watcher-less --wait with a worker that
 * finishes MID-wait must still persist the reconciled done transition. The
 * first #116 fix made the wait write its own heartbeat (<statePath>.watcher
 * = its own PID) on every poll, and liveWatcher() treated ANY fresh
 * heartbeat as a live watcher — so from the second poll onward the wait
 * believed a watcher owned the state, skipped saveStateSync, exited 0
 * reporting "done", and left the on-disk state stuck on "running" forever
 * (no watcher existed to ever persist it). A fresh heartbeat only counts
 * when it carries a DIFFERENT process's PID.
 */
async function testWaitPersistsMidWaitReconcileWithNoWatcher(): Promise<void> {
	const repo = await tmpRepo()
	try {
		const statePath = path.join(repo, ".worktrees", ".orchestrator-state.json")
		// Genuinely running at wait-start: worktree exists, NO .harness.done
		// marker yet (a missing worktree would reconcile to orphaned instantly).
		await fs.mkdir(path.join(repo, ".worktrees", "w1"), { recursive: true })
		saveStateSync(statePath, updateGroup(defaultState("r1"), "w1", baseGroup({ status: "running" })))

		const cap = capture()
		const waitPromise = statusMain(
			["--repo", repo, "--wait", "--json", "--timeout-ms", "5000", "--poll-interval-ms", "25"],
			cap.io,
		)

		// Let the wait poll a few times — with the regression, its own
		// heartbeat is now fresh and it would wrongly see a "live watcher".
		await new Promise((resolve) => setTimeout(resolve, 150))
		// The worker finishes mid-wait: drop the real completion markers.
		// Exit first, then the done marker (run-worker.sh order).
		await fs.writeFile(path.join(repo, ".worktrees", "w1", ".harness.exit"), "0", "utf8")
		await fs.mkdir(path.join(repo, ".worktrees", "w1", ".harness.done"), { recursive: true })

		const code = await waitPromise
		assert.equal(code, 0, "worker finished mid-wait -> exit 0")
		const parsed = JSON.parse(cap.out.join("")) as OrchestratorState & { allDone: boolean; timedOut: boolean }
		assert.equal(parsed.allDone, true, "wait reports all done")
		assert.equal(parsed.timedOut, false, "wait did not time out")
		// The on-disk state MUST be done: with no watcher, the wait is the
		// only writer, and a watcher-less round depends on this persist.
		const onDisk = loadStateSync(statePath)
		assert.equal(onDisk.groups[0].status, "done", "mid-wait reconcile persisted with no live watcher")
	} finally {
		await fs.rm(repo, { recursive: true, force: true })
	}
}

/**
 * Issue #116 (rework cycle 2): the exact repro that reopened the bug. A
 * fresh heartbeat from a DIFFERENT process (PID 99999 = live watcher) is
 * present when the wait starts, and the worker finishes MID-wait (markers
 * dropped after the wait's first poll). The cycle-1 fix reintroduced the
 * bug by having the wait stamp its own PID into the shared heartbeat file
 * every poll: from the second poll onward the wait read its OWN PID,
 * concluded "no live watcher", and persisted the done reconcile on disk —
 * the watcher's next poll then short-circuited the group and silently
 * skipped log analysis + review. The wait must NEVER write the heartbeat
 * file: the live watcher's fresh heartbeat (different PID) must keep the
 * on-disk state on "running" so the watcher still owns the done transition.
 *
 * Staleness is judged against the WATCHER's heartbeat cadence
 * (DEFAULT_POLL_INTERVAL_MS = 5s), not the wait's own poll interval — a
 * fast-polling wait must not declare a live watcher dead between the
 * watcher's own refreshes.
 */
async function testWaitMidWaitReconcileWithLiveWatcherDoesNotPersist(): Promise<void> {
	const repo = await tmpRepo()
	try {
		const statePath = path.join(repo, ".worktrees", ".orchestrator-state.json")
		// Genuinely running at wait-start: worktree exists, NO .harness.done
		// marker yet (a missing worktree would reconcile to orphaned instantly).
		await fs.mkdir(path.join(repo, ".worktrees", "w1"), { recursive: true })
		saveStateSync(statePath, updateGroup(defaultState("r1"), "w1", baseGroup({ status: "running" })))
		// A live watcher owns the state: its heartbeat is fresh AND carries a
		// DIFFERENT PID. The wait must leave this file untouched.
		await fs.writeFile(`${statePath}.watcher`, "99999", "utf8")

		const cap = capture()
		const waitPromise = statusMain(
			["--repo", repo, "--wait", "--json", "--timeout-ms", "5000", "--poll-interval-ms", "25"],
			cap.io,
		)

		// Let the wait poll a few times first — with the cycle-1 regression
		// its own heartbeat had already clobbered the live watcher's by now.
		await new Promise((resolve) => setTimeout(resolve, 150))
		// The worker finishes mid-wait: drop the real completion markers.
		// Exit first, then the done marker (run-worker.sh order).
		await fs.writeFile(path.join(repo, ".worktrees", "w1", ".harness.exit"), "0", "utf8")
		await fs.mkdir(path.join(repo, ".worktrees", "w1", ".harness.done"), { recursive: true })

		const code = await waitPromise
		assert.equal(code, 0, "worker finished mid-wait -> exit 0")
		const parsed = JSON.parse(cap.out.join("")) as OrchestratorState & { allDone: boolean; timedOut: boolean }
		assert.equal(parsed.allDone, true, "wait reports all done (in-memory reconcile)")
		assert.equal(parsed.timedOut, false, "wait did not time out")
		// The on-disk state MUST stay running: the live watcher owns the done
		// transition and must still observe the group as running so its log
		// analysis + automated review fire.
		const onDisk = loadStateSync(statePath)
		assert.equal(onDisk.groups[0].status, "running", "no persist while a live watcher owns the state")
		// The live watcher's heartbeat must be untouched by the wait.
		const heartbeatPid = await fs.readFile(`${statePath}.watcher`, "utf8")
		assert.equal(heartbeatPid, "99999", "wait never writes the shared watcher heartbeat file")
	} finally {
		await fs.rm(repo, { recursive: true, force: true })
	}
}

async function testWaitTreatsOrphanedAsTerminal(): Promise<void> {
	const repo = await tmpRepo()
	try {
		const statePath = path.join(repo, ".worktrees", ".orchestrator-state.json")
		saveStateSync(statePath, updateGroup(defaultState("r1"), "w1", baseGroup({ status: "running" })))
		// No worktree → reconciled to orphaned on the first poll → terminal.

		const t0 = Date.now()
		const cap = capture()
		const code = await statusMain(
			["--repo", repo, "--wait", "--timeout-ms", "5000", "--poll-interval-ms", "50"],
			cap.io,
		)
		const elapsed = Date.now() - t0

		assert.equal(code, 1, "orphaned is terminal but NOT done -> exit 1")
		const text = cap.out.join("")
		assert.ok(text.includes("verdict: all 1 group terminal, but 1 orphaned"), "verdict names the orphaned group")
		assert.ok(!text.includes("timed out"), "did not wait out the full timeout")
		assert.ok(elapsed < 2000, `returned promptly instead of waiting the timeout (${elapsed}ms)`)
	} finally {
		await fs.rm(repo, { recursive: true, force: true })
	}
}

// ─── Runner ──────────────────────────────────────────────────────────────────

const tests: Array<[string, () => Promise<void>]> = [
	["parseStatusArgs: defaults", testParseStatusArgsDefaults],
	["parseStatusArgs: custom values, =form, error cases", testParseStatusArgsCustomAndErrors],
	["one-shot prints the human summary and exits 1 on a failed group", testOneShotPrintsHumanSummary],
	["one-shot all-done exits 0", testOneShotAllDoneExitsZero],
	["one-shot --json passes the raw state through", testOneShotJsonShape],
	["one-shot invalid state file exits 1 with a clear error", testOneShotInvalidStateFileExitsOne],
	["one-shot missing --repo / unknown flag are usage errors (exit 2)", testOneShotMissingRepoArgIsUsageError],
	["wait returns once every group is done, not before", testWaitReturnsWhenAllGroupsDone],
	["wait: terminal-but-failed is not allDone", testWaitTerminalButFailedIsNotAllDone],
	["wait: blocked is NOT terminal and times out", testWaitBlockedIsNotTerminalAndTimesOut],
	["wait: empty state returns immediately", testWaitEmptyStateReturnsImmediately],
	["wait against the real state file transitions to done", testWaitAgainstRealFileTransitionsToDone],
	["wait times out with a clear verdict and exit 1", testWaitTimesOutWithClearVerdict],
	["wait --json carries allDone/timedOut/verdict fields", testWaitJsonCarriesVerdictFields],
	["one-shot reconciles done from .harness markers and persists", testOneShotReconcilesDoneFromMarkersAndPersists],
	["one-shot reconciles failed from a non-zero .harness.exit", testOneShotReconcilesFailedFromNonZeroExit],
	["one-shot reconciles orphaned and renders it distinctly (text + json)", testOneShotReconcilesOrphanedDistinctly],
	["one-shot leaves a running group with a live worktree alone", testOneShotLeavesRunningGroupWithLiveWorktreeAlone],
	["wait reconciles a stale-but-reconcilable group promptly (and persists without a watcher)", testWaitReconcilesStaleGroupPromptly],
	["wait does NOT persist reconcile while a watcher heartbeat is fresh (issue #116)", testWaitDoesNotPersistReconcileWhenWatcherHeartbeatFresh],
	["wait persists reconcile again once the watcher heartbeat is stale", testWaitPersistsWhenWatcherHeartbeatStale],
	["wait persists a mid-wait reconcile with no watcher (issue #116 rework)", testWaitPersistsMidWaitReconcileWithNoWatcher],
	["wait never persists mid-wait reconcile with a live watcher (issue #116 rework 2)", testWaitMidWaitReconcileWithLiveWatcherDoesNotPersist],
	["wait treats orphaned as terminal and returns promptly", testWaitTreatsOrphanedAsTerminal],
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
	console.log(`\nAll ${tests.length} status-cli tests passed`)
}

main().catch((err) => {
	console.error("Test runner crashed:", err)
	process.exit(1)
})
