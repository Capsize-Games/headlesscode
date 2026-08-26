/**
 * Unit tests for src/cloud/provider.ts — the CloudProvider interface contract
 * + the LocalProcessProvider reference implementation.
 *
 * DOCUMENTED TEST APPROACH (spec D4): the "lighter test" that exercises the
 * interface contract with injected fakes — no real git worktrees, no real
 * subprocesses, no network. The REAL spawner/run-worker scripts are already
 * exercised end-to-end by the Phase 2/5 e2e suites (scripts/e2e-phase2/run.sh,
 * scripts/e2e-phase5/run.sh); here we verify the provider wraps them with the
 * right lifecycle + command shapes.
 *
 * Plain assert-based script (no test framework), run via `npm test` →
 * `tsx src/cloud/__tests__/provider.test.ts`.
 */

import assert from "node:assert/strict"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"

import {
	hetznerDockerProviderSketch,
	LocalProcessProvider,
	type CloudProvider,
	type CloudSessionRequest,
	type CommandResult,
	type SessionHandle,
} from "../provider.js"

async function tmpRepo(): Promise<string> {
	return fs.mkdtemp(path.join(os.tmpdir(), "headlesscode-provider-repo-"))
}

function request(repo: string, name = "w1"): CloudSessionRequest {
	return {
		repo,
		issue: { number: 27, title: "Fix the bug", body: "make it work" },
		worktreeSpec: { name, issues: [27], taskFile: `${name}-issue27.md` },
		env: { ORCHESTRATOR_MODE: "code" },
	}
}

/** Recording fake `run`: records commands, returns a scripted result. */
function fakeRun(script?: (command: string) => CommandResult) {
	const calls: Array<{ command: string; cwd: string }> = []
	const run = (command: string, cwd: string): CommandResult => {
		calls.push({ command, cwd })
		return script ? script(command) : { exitCode: 0, output: `ran: ${command}` }
	}
	return { run, calls }
}

async function testInterfaceContractWithFakeProvider(): Promise<void> {
	// The CloudProvider interface itself: a fake provider drives the exact
	// five-method lifecycle the orchestration layer will call.
	const order: string[] = []
	const fake: CloudProvider = {
		name: "fake",
		spawnWorktreeSession: async () => {
			order.push("spawn")
			return { id: "w1", provider: "fake", address: "fake://w1" }
		},
		waitReady: async () => {
			order.push("waitReady")
		},
		runHarness: async () => {
			order.push("runHarness")
			return { exitCode: 0, output: "harness output" }
		},
		collectResults: async () => {
			order.push("collect")
			return { exitCode: 0, done: true }
		},
		teardown: async () => {
			order.push("teardown")
		},
	}

	const handle = await fake.spawnWorktreeSession(request(await tmpRepo()))
	await fake.waitReady(handle)
	const ran = await fake.runHarness(handle, "run the harness")
	const results = await fake.collectResults(handle)
	await fake.teardown(handle)

	assert.deepEqual(order, ["spawn", "waitReady", "runHarness", "collect", "teardown"], "lifecycle order")
	assert.equal(handle.provider, "fake")
	assert.equal(ran.exitCode, 0)
	assert.equal(results.done, true)
}

async function testLocalProcessProviderDryRunLifecycle(): Promise<void> {
	const repo = await tmpRepo()
	try {
		const { run, calls } = fakeRun()
		const provider = new LocalProcessProvider({ dryRun: true, run })

		// spawnWorktreeSession: task files NOT written in dry-run; command has
		// the expected triple + TARGET_REPO env.
		const handle = await provider.spawnWorktreeSession(request(repo))
		assert.equal(handle.id, "w1")
		assert.equal(handle.provider, "local")
		assert.equal(handle.address, path.join(repo, ".worktrees", "w1"))
		assert.equal(calls.length, 1)
		assert.match(calls[0].command, /spawn-parallel-worktrees\.sh w1:0:plans\/parallel-tasks\/w1-issue27\.md/)
		assert.equal(calls[0].cwd, repo)
		await assert.rejects(
			() => fs.access(path.join(repo, "plans", "parallel-tasks", "w1-issue27.md")),
			(err) => (err as NodeJS.ErrnoException).code === "ENOENT",
			"dry-run skips task files",
		)

		// waitReady: resolves immediately in dry-run (no poll).
		await provider.waitReady(handle)

		// runHarness: dry-run returns exit 0 with the command echoed.
		const ran = await provider.runHarness(handle, "bash run-worker.sh")
		assert.equal(ran.exitCode, 0)
		assert.match(ran.output, /\[dry-run\] bash run-worker\.sh/)

		// collectResults: tolerant on a non-existent worktree dir.
		const results = await provider.collectResults(handle)
		assert.equal(results.done, false)
		assert.equal(results.exitCode, undefined)

		// teardown: dry-run no-op (no git invocation recorded).
		const before = calls.length
		await provider.teardown(handle)
		assert.equal(calls.length, before, "dry-run teardown does not invoke git")
	} finally {
		await fs.rm(repo, { recursive: true, force: true })
	}
}

async function testLocalProcessProviderRealCommandsWithFakes(): Promise<void> {
	const repo = await tmpRepo()
	try {
		// Not dry-run, but `run` is injected so no real subprocess runs.
		const { run, calls } = fakeRun()
		const provider = new LocalProcessProvider({
			run,
			waitForReady: async () => {
				/* fake readiness: always ready */
			},
		})

		const handle = await provider.spawnWorktreeSession(request(repo, "w2"))
		// Non-dry-run writes the task file (same builder as the watcher).
		const task = path.join(repo, "plans", "parallel-tasks", "w2-issue27.md")
		const content = await fs.readFile(task, "utf-8")
		assert.match(content, /GitHub issues assigned to this worktree: #27/)

		await provider.waitReady(handle) // injected -> resolves
		assert.equal(calls.length, 1, "no filesystem poll because waitForReady was injected")

		// runHarness with an explicit command (run-worker via the script).
		const runCmd = `bash ${path.join("scripts", "run-worker.sh")} '${handle.address}' ORCHESTRATOR_TASK.md --mode code`
		const ran = await provider.runHarness(handle, runCmd)
		assert.equal(ran.exitCode, 0)
		assert.equal(calls.length, 2)

		// collectResults reads real files -> tolerant on missing markers.
		const results = await provider.collectResults(handle)
		assert.equal(results.done, false)
		assert.equal(results.worktree, handle.address)

		// teardown runs `git worktree remove --force`.
		await provider.teardown(handle)
		const teardownCall = calls[calls.length - 1]
		assert.match(teardownCall.command, /git worktree remove .*--force/)
	} finally {
		await fs.rm(repo, { recursive: true, force: true })
	}
}

async function testHetznerSketchIsDocumentedNotImplemented(): Promise<void> {
	assert.equal(hetznerDockerProviderSketch.implemented, false, "no live Hetzner implementation")
	// Superseded by the real DockerSessionProvider (src/cloud/docker-provider.ts).
	assert.match(hetznerDockerProviderSketch.reason, /superseded by DockerSessionProvider/)
	assert.equal(hetznerDockerProviderSketch.name, "hetzner-docker")
}

// ─── Runner ──────────────────────────────────────────────────────────────────

const tests: Array<[string, () => Promise<void>]> = [
	["CloudProvider contract: fake provider drives the 5-method lifecycle in order", testInterfaceContractWithFakeProvider],
	["LocalProcessProvider dry-run: spawn/wait/run/collect/teardown with no side effects", testLocalProcessProviderDryRunLifecycle],
	["LocalProcessProvider with injected fakes: task files + command shapes + teardown", testLocalProcessProviderRealCommandsWithFakes],
	["HetznerDockerProvider is a documented sketch (not implemented)", testHetznerSketchIsDocumentedNotImplemented],
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
	console.log(`\nAll ${tests.length} provider tests passed`)
}

main().catch((err) => {
	console.error("Test runner crashed:", err)
	process.exit(1)
})
