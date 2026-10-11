import assert from "node:assert/strict"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import { randomUUID } from "node:crypto"
import { spawn } from "node:child_process"

import { parseHeadlessCodeJobBody } from "../../agent-executor.js"
import { Logger } from "../../engine/logger.js"
import { watchIssues, type WatcherConfig, type SpawnBatch, type SpawnResult } from "../watch.js"
import type { GhClient, GitHubIssue, GitHubPullRequestSummary } from "../github.js"
import { loadWatcherState } from "../state.js"

const scratchRoot = path.resolve(".headlesscode/scratch/headlesscode-job-tests")

function jobIssue(overrides: Partial<GitHubIssue> = {}): GitHubIssue {
	return {
		number: 6701,
		title: "Synthetic queued job",
		body: "## Task\nFix the synthetic parser.\n## Executor\nloop\n## Submitted-by\nfixture-user",
		labels: ["needs-agent", "headlesscode-job"],
		html_url: "https://github.com/capsize/headlesscode/issues/6701",
		...overrides,
	}
}

interface JobHarness {
	repoRoot: string
	stateFile: string
	issue: GitHubIssue
	spawned: SpawnBatch[]
	events: string[]
	comments: string[]
	prs: GitHubPullRequestSummary[]
	closed: boolean
	spawnOutcome?: SpawnResult
	gh: GhClient
}

async function harness(issue = jobIssue()): Promise<JobHarness> {
	await fs.mkdir(scratchRoot, { recursive: true })
	const repoRoot = path.join(scratchRoot, randomUUID())
	await fs.mkdir(path.join(repoRoot, ".worktrees"), { recursive: true })
	const result: JobHarness = {
		repoRoot,
		stateFile: path.join(repoRoot, ".worktrees", ".watcher-state.json"),
		issue,
		spawned: [],
		events: [],
		comments: [],
		prs: [],
		closed: false,
		gh: undefined as unknown as GhClient,
	}
	result.gh = {
		listIssues: async () => result.closed ? [] : [result.issue],
		getIssue: async () => result.issue,
		addLabel: async (_owner, _repo, _number, label) => {
			result.events.push(`add:${label}`)
			result.issue.labels = [...new Set([...result.issue.labels, label])]
		},
		removeLabel: async (_owner, _repo, _number, label) => {
			result.events.push(`remove:${label}`)
			result.issue.labels = result.issue.labels.filter((value) => value !== label)
		},
		closeIssue: async () => { result.events.push("close"); result.closed = true },
		createIssueComment: async (_owner, _repo, _number, body) => { result.events.push("comment"); result.comments.push(body) },
		listIssueComments: async () => [...result.comments],
		listPullRequestsForHead: async (_owner, _repo, branch) => result.prs.filter((pr) => pr.branch === branch),
	}
	return result
}

async function run(h: JobHarness, runOnce = true): Promise<Awaited<ReturnType<typeof watchIssues>>> {
	const config: WatcherConfig = {
		owner: "capsize",
		repo: "headlesscode",
		targetLabel: "needs-agent",
		token: "synthetic-token",
		stateFile: h.stateFile,
		repoRoot: h.repoRoot,
		runOnce,
		pollIntervalMs: 1,
		logger: new Logger({ level: "silent" }),
		gh: h.gh,
		spawn: async (batch) => { h.spawned.push(batch); return h.spawnOutcome ?? { ok: true, status: 0 } },
	}
	return watchIssues(config)
}

async function markGroupComplete(h: JobHarness, exitCode: number, log = "synthetic worker finished\n"): Promise<string> {
	const state = await loadWatcherState(h.stateFile)
	const entry = state.processed[String(h.issue.number)]
	const group = entry?.groups?.[0]
	assert.ok(group, "spawn wrote a worktree group")
	assert.match(entry?.jobAttempt ?? "", /^[a-f0-9-]{36}$/, "job attempt is persisted")
	const worktree = path.join(h.repoRoot, ".worktrees", group.name)
	await fs.mkdir(path.join(worktree, ".harness.done"), { recursive: true })
	await fs.writeFile(path.join(worktree, ".harness.exit"), String(exitCode))
	await fs.writeFile(path.join(worktree, "harness.log"), log)
	const receiptDir = path.join(h.repoRoot, ".worktrees", ".headlesscode-job-runs", entry!.jobAttempt!)
	await fs.mkdir(receiptDir, { recursive: true, mode: 0o700 })
	const pid = 2_147_483_647 // Deliberately absent, so the supervisor sees verified teardown.
	await fs.writeFile(path.join(receiptDir, `${group.name}.launch`), JSON.stringify({
		version: 1, attemptId: entry!.jobAttempt, group: group.name, pid, pgid: pid, startTicks: "1",
	}))
	await fs.writeFile(path.join(receiptDir, `${group.name}.complete`), JSON.stringify({
		version: 1, attemptId: entry!.jobAttempt, group: group.name, pid, pgid: pid, startTicks: "1", exitCode,
	}))
	return group.name
}

async function testForgedWorktreeMarkersCannotFinishLiveWorker(): Promise<void> {
	const h = await harness()
	await run(h)
	const groupName = await markGroupComplete(h, 0)
	const state = await loadWatcherState(h.stateFile)
	const receiptDir = path.join(h.repoRoot, ".worktrees", ".headlesscode-job-runs", state.processed[String(h.issue.number)]!.jobAttempt!)
	const child = spawn("bash", ["-c", "exec sleep 30"], { detached: true, stdio: "ignore" })
	try {
		assert.ok(child.pid)
		let stat = ""
		for (let attempt = 0; attempt < 50; attempt++) {
			try { stat = await fs.readFile(`/proc/${child.pid}/stat`, "utf8"); break } catch { await new Promise((resolve) => setTimeout(resolve, 10)) }
		}
		const close = stat.lastIndexOf(")")
		const fields = stat.slice(close + 1).trim().split(/\s+/)
		const pgid = Number(fields[2])
		const session = Number(fields[3])
		const startTicks = fields[19]
		assert.equal(pgid, child.pid, "fixture worker leads a detached process group")
		assert.equal(session, child.pid)
		const liveIdentity = { version: 1, attemptId: state.processed[String(h.issue.number)]!.jobAttempt, group: groupName, pid: child.pid, pgid, startTicks }
		await fs.writeFile(path.join(receiptDir, `${groupName}.launch`), JSON.stringify(liveIdentity))
		await fs.writeFile(path.join(receiptDir, `${groupName}.complete`), JSON.stringify({ ...liveIdentity, exitCode: 0 }))
		await run(h)
		const stillActive = await loadWatcherState(h.stateFile)
		assert.equal(stillActive.processed[String(h.issue.number)]?.status, "spawned")
		assert.equal(h.closed, false, "worker-controlled markers cannot close an issue while its process group is live")
	} finally {
		if (child.pid) {
			try { process.kill(-child.pid, "SIGKILL") } catch { /* fixture already exited */ }
		}
	}
	await run(h)
	assert.equal((await loadWatcherState(h.stateFile)).processed[String(h.issue.number)]?.status, "done", "valid attempt receipt completes only after group teardown")
}

async function testOpenShellTeardownMarkerKeepsFailedJobActive(): Promise<void> {
	const h = await harness()
	await run(h)
	const groupName = await markGroupComplete(h, 1, "OpenShell teardown failed\n")
	const worktree = path.join(h.repoRoot, ".worktrees", groupName)
	const marker = path.join(worktree, ".harness.openshell-sandbox")
	await fs.writeFile(marker, "synthetic-unverified-sandbox\n")
	await run(h)
	const quarantined = await loadWatcherState(h.stateFile)
	assert.equal(quarantined.processed[String(h.issue.number)]?.status, "spawned", "failed guest deletion remains active while its teardown marker exists")
	assert.ok(h.issue.labels.includes("headlesscode:running"), "watcher does not publish a terminal failed label before guest absence is verified")
	assert.equal(h.comments.length, 0, "no terminal failure summary is posted while the sandbox marker remains")
	await fs.rm(marker)
	await run(h)
	assert.equal((await loadWatcherState(h.stateFile)).processed[String(h.issue.number)]?.status, "failed", "verified provider cleanup permits the supervisor's captured failure status")
	assert.ok(h.issue.labels.includes("headlesscode:failed"))
	assert.match(h.comments[0] ?? "", /exit 1/)
}

async function testStaleAttemptAndUnknownIdentityStayRunning(): Promise<void> {
	const h = await harness()
	await run(h)
	await markGroupComplete(h, 0)
	const state = await loadWatcherState(h.stateFile)
	const entry = state.processed[String(h.issue.number)]!
	const group = entry.groups![0]!
	const receiptDir = path.join(h.repoRoot, ".worktrees", ".headlesscode-job-runs", entry.jobAttempt!)
	const completionPath = path.join(receiptDir, `${group.name}.complete`)
	const launch = JSON.parse(await fs.readFile(path.join(receiptDir, `${group.name}.launch`), "utf8")) as Record<string, unknown>
	await fs.writeFile(completionPath, JSON.stringify({ ...launch, attemptId: randomUUID(), exitCode: 0 }))
	await run(h)
	assert.equal((await loadWatcherState(h.stateFile)).processed[String(h.issue.number)]?.status, "spawned", "a receipt from another attempt is ignored")
	await fs.writeFile(completionPath, JSON.stringify({ ...launch, exitCode: 0 }))
	await fs.writeFile(path.join(receiptDir, `${group.name}.launch`), JSON.stringify({
		version: 1, attemptId: entry.jobAttempt, group: group.name, pid: "unknown", pgid: 2_147_483_647, startTicks: "bad",
	}))
	await run(h)
	assert.equal((await loadWatcherState(h.stateFile)).processed[String(h.issue.number)]?.status, "spawned", "malformed or unknown process identity is quarantined")
	const reused = spawn("bash", ["-c", "exec sleep 30"], { detached: true, stdio: "ignore" })
	try {
		assert.ok(reused.pid)
		let raw = ""
		for (let attempt = 0; attempt < 50; attempt++) {
			try { raw = await fs.readFile(`/proc/${reused.pid}/stat`, "utf8"); break } catch { await new Promise((resolve) => setTimeout(resolve, 10)) }
		}
		const statFields = raw.slice(raw.lastIndexOf(")") + 1).trim().split(/\s+/)
		const reusedIdentity = { version: 1, attemptId: entry.jobAttempt, group: group.name, pid: reused.pid, pgid: Number(statFields[2]), startTicks: String(Number(statFields[19]) + 1) }
		await fs.writeFile(path.join(receiptDir, `${group.name}.launch`), JSON.stringify(reusedIdentity))
		await fs.writeFile(completionPath, JSON.stringify({ ...reusedIdentity, exitCode: 0 }))
		await run(h)
		assert.equal((await loadWatcherState(h.stateFile)).processed[String(h.issue.number)]?.status, "spawned", "a reused PID does not prove the captured process group is gone")
	} finally {
		if (reused.pid) {
			try { process.kill(-reused.pid, "SIGKILL") } catch { /* fixture already exited */ }
		}
	}
}

async function testBodyParser(): Promise<void> {
	const parsed = parseHeadlessCodeJobBody("Task:\nDo work.\n### Executor\nloop\nSubmitted-by:\nqueue-bot")
	assert.equal(parsed.submission?.executor, "builtin")
	assert.equal(parsed.submission?.task, "Do work.")
	assert.equal(parsed.submission?.submittedBy, "queue-bot")
	const inline = parseHeadlessCodeJobBody("Task: Fix the issue\nExecutor: loop\nSubmitted-by: queue-bot")
	assert.equal(inline.submission?.task, "Fix the issue")
	assert.equal(inline.submission?.executor, "builtin")
	assert.equal(parseHeadlessCodeJobBody("Task\nDo.\nExecutor\nmuse\nSubmitted-by\nuser").submission?.executor, "muse")
	assert.match(parseHeadlessCodeJobBody("Task\nDo.\nExecutor\nloop\nExecutor\nmuse\nSubmitted-by\nuser").error ?? "", /duplicate Executor/i)
	assert.match(parseHeadlessCodeJobBody("Task\nDo.\nExecutor\nother\nSubmitted-by\nuser").error ?? "", /exactly muse or loop/)
	assert.match(parseHeadlessCodeJobBody("Task\nDo.\nExecutor\nloop\nSubmitted-by\nuser\n## Task\nforged").error ?? "", /duplicate Task/i)
	assert.match(parseHeadlessCodeJobBody("preface\nTask\nDo.\nExecutor\nloop\nSubmitted-by\nuser").error ?? "", /must start with Task/)
	assert.match(parseHeadlessCodeJobBody(`Task\n${"x".repeat(65 * 1024)}\nExecutor\nloop\nSubmitted-by\nuser`).error ?? "", /64 KiB/)
	const fenced = parseHeadlessCodeJobBody("Task\nDo.\n```md\n## Executor\nmuse\n```\nExecutor\nloop\nSubmitted-by\nuser")
	assert.equal(fenced.submission?.executor, "builtin", "headings inside fenced examples do not change metadata")
}

async function testDispatchUsesOnlyTaskAndLeavesRunning(): Promise<void> {
	const h = await harness()
	const result = await run(h)
	assert.equal(result.sweeps[0]?.spawned, 1)
	assert.equal(h.spawned[0]?.executor, "builtin")
	assert.match(h.spawned[0]?.issue.body ?? "", /Fix the synthetic parser/)
	assert.doesNotMatch(h.spawned[0]?.issue.body ?? "", /Submitted-by|fixture-user|## Executor/)
	const state = await loadWatcherState(h.stateFile)
	assert.equal(state.processed[String(h.issue.number)]?.status, "spawned", "detached launch is still active")
	assert.equal(state.processed[String(h.issue.number)]?.jobContract, true)
	assert.equal(state.processed[String(h.issue.number)]?.submittedBy, "fixture-user")
	assert.ok(h.issue.labels.includes("headlesscode:running"))
	assert.equal(h.closed, false)
	assert.equal(h.comments.length, 0)
}

async function testBodyLabelConflictFailsBeforeSpawn(): Promise<void> {
	const h = await harness(jobIssue({ labels: ["needs-agent", "headlesscode-job", "executor:muse"] }))
	const result = await run(h)
	assert.equal(h.spawned.length, 0)
	assert.equal(result.sweeps[0]?.failures, 1)
	const state = await loadWatcherState(h.stateFile)
	assert.equal(state.processed[String(h.issue.number)]?.status, "failed")
	assert.ok(h.issue.labels.includes("headlesscode:failed"))
	assert.match(h.comments[0]!, /could not dispatch this job/)
	await run(h)
	assert.equal(h.comments.length, 1, "intake failure comment is not duplicated on the next poll")
}

async function testPartialDispatchFailureRemainsRunning(): Promise<void> {
	const h = await harness()
	h.spawnOutcome = { ok: false, command: "bash worker-spawner", status: 1, error: "one worker launch uncertain" }
	await run(h)
	const state = await loadWatcherState(h.stateFile)
	assert.equal(state.processed[String(h.issue.number)]?.status, "spawned")
	assert.ok(h.issue.labels.includes("headlesscode:running"))
	assert.ok(!h.issue.labels.includes("headlesscode:failed"))
	assert.equal(h.comments.length, 0)
}

async function testLaterSuccessAddsVerifiedResultAndClosesOnce(): Promise<void> {
	const h = await harness()
	await run(h)
	const groupName = await markGroupComplete(h, 0, "all checks passed\nBearer abcdefg\n@someone\n")
	const branch = `issues/${groupName}-2026-10-11`
	await fs.writeFile(path.join(h.repoRoot, ".worktrees", ".orchestrator-state.json"), JSON.stringify({ groups: [{ name: groupName, branch }] }))
	h.prs = [
		{ number: 68, url: "https://github.com/capsize/headlesscode/pull/68", branch, baseRepository: "capsize/headlesscode", headRepository: "capsize/headlesscode" },
		{ number: 99, url: "https://evil.example/capsize/headlesscode/pull/99", branch, baseRepository: "capsize/headlesscode", headRepository: "capsize/headlesscode" },
		{ number: 100, url: "https://github.com/capsize/headlesscode/pull/101", branch, baseRepository: "capsize/headlesscode", headRepository: "capsize/headlesscode" },
	]
	h.events = []
	const result = await run(h)
	assert.equal(result.sweeps[0]?.failures, 0)
	const state = await loadWatcherState(h.stateFile)
	assert.equal(state.processed[String(h.issue.number)]?.status, "done")
	assert.equal(h.closed, true)
	assert.equal(h.comments.length, 1)
	assert.ok(h.comments[0]!.includes("#68"))
	assert.doesNotMatch(h.comments[0]!, /#99/)
	assert.doesNotMatch(h.comments[0]!, /#100/)
	assert.match(h.comments[0]!, /Pull request lookup:/)
	assert.doesNotMatch(h.comments[0]!, /Bearer abcdefg/)
	assert.doesNotMatch(h.comments[0]!, /@someone/)
	assert.ok(h.events.indexOf("comment") < h.events.indexOf("close"))
	const eventCount = h.events.length
	await run(h)
	assert.equal(h.comments.length, 1, "result comment marker prevents retries from duplicating comments")
	assert.equal(h.events.length, eventCount)
}

async function testFailedMarkerLeavesIssueOpen(): Promise<void> {
	const h = await harness()
	await run(h)
	await markGroupComplete(h, 7, "test command failed\n")
	await run(h)
	const state = await loadWatcherState(h.stateFile)
	assert.equal(state.processed[String(h.issue.number)]?.status, "failed")
	assert.ok(h.issue.labels.includes("headlesscode:failed"))
	assert.equal(h.closed, false)
	assert.match(h.comments[0]!, /failed \(.+: exit 7\)/)
	assert.match(h.comments[0]!, /does not close failed job issues/)
	await run(h)
	assert.equal(h.comments.length, 1, "terminal failure comment is not duplicated on the next poll")
}

async function testSuccessfulCompletionExplicitlyReportsNoPullRequest(): Promise<void> {
	const h = await harness()
	await run(h)
	const groupName = await markGroupComplete(h, 0)
	const branch = `issues/${groupName}-2026-10-11`
	await fs.writeFile(path.join(h.repoRoot, ".worktrees", ".orchestrator-state.json"), JSON.stringify({ groups: [{ name: groupName, branch }] }))
	await run(h)
	assert.equal(h.closed, true)
	assert.match(h.comments[0]!, /No pull request was found for the generated worker branches/)
}

async function testWorktreeMarkersAreDiagnosticOnly(): Promise<void> {
	const h = await harness()
	await run(h)
	const groupName = await markGroupComplete(h, 0)
	await fs.writeFile(path.join(h.repoRoot, ".worktrees", groupName, ".harness.exit"), "0\n999")
	await run(h)
	const state = await loadWatcherState(h.stateFile)
	assert.equal(state.processed[String(h.issue.number)]?.status, "done", "the external supervisor receipt, not worker-tree markers, determines completion")
	assert.equal(h.closed, true)
	assert.equal(h.comments.length, 1)
}

const tests: Array<[string, () => Promise<void>]> = [
	["headlesscode-job: bounded body parser", testBodyParser],
	["headlesscode-job: task-only dispatch and running status", testDispatchUsesOnlyTaskAndLeavesRunning],
	["headlesscode-job: executor conflict fails closed", testBodyLabelConflictFailsBeforeSpawn],
	["headlesscode-job: uncertain partial dispatch remains running", testPartialDispatchFailureRemainsRunning],
	["headlesscode-job: later success reports verified PR and closes", testLaterSuccessAddsVerifiedResultAndClosesOnce],
	["headlesscode-job: failed marker leaves issue open", testFailedMarkerLeavesIssueOpen],
	["headlesscode-job: no PR is reported explicitly", testSuccessfulCompletionExplicitlyReportsNoPullRequest],
	["headlesscode-job: worker-tree markers are diagnostic only", testWorktreeMarkersAreDiagnosticOnly],
	["headlesscode-job: OpenShell teardown marker keeps failed job active", testOpenShellTeardownMarkerKeepsFailedJobActive],
	["headlesscode-job: forged worktree markers cannot finish a live process group", testForgedWorktreeMarkersCannotFinishLiveWorker],
	["headlesscode-job: stale attempt and unknown identity remain active", testStaleAttemptAndUnknownIdentityStayRunning],
]

try {
	for (const [name, test] of tests) {
		await test()
		console.log(`  ✓ ${name}`)
	}
} finally {
	await fs.rm(scratchRoot, { recursive: true, force: true })
}
