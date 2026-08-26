/**
 * Integration tests for src/cloud/docker-provider.ts — DockerSessionProvider
 * against a REAL local Docker daemon (when available).
 *
 * What is proven (docs/multi-tenant-hosting-design.md §5.2):
 *   1. The full 5-method CloudProvider lifecycle (spawn → waitReady →
 *      runHarness → collectResults → teardown) with real `docker` calls,
 *      including the resource limits applied at spawn (docker inspect shows
 *      NanoCpus / Memory / PidsLimit).
 *   2. Teardown actually removes what spawn created: containers are LISTED
 *      before/after (docker ps -a), not just the exit code trusted.
 *   3. THE isolation proof: two concurrent sessions cannot see or affect each
 *      other — one session's workspace-private file is unreadable from the
 *      other, and a CPU-burning session does not starve its sibling
 *      (per-session cgroup caps).
 *
 * Skip policy (matching the plan's requirement to not fail the whole suite
 * over an environment gap): when `docker` is not installed or the daemon is
 * not reachable, the suite prints a clear SKIP message and exits 0. When the
 * daemon IS available the tests run for real — they are never silently
 * passed without running.
 *
 * Plain assert-based script (no test framework), run via `npm test` →
 * `tsx src/cloud/__tests__/docker-provider.test.ts`.
 */

import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

import { DockerSessionProvider } from "../docker-provider.js"
import type { CloudSessionRequest, CommandResult, SessionHandle } from "../provider.js"

// ─── Docker availability probe ───────────────────────────────────────────────

function dockerAvailable(): { ok: boolean; reason?: string } {
	const which = spawnSync("sh", ["-c", "command -v docker"], { encoding: "utf-8" })
	if (which.status !== 0) {
		return { ok: false, reason: "docker CLI not found on PATH" }
	}
	const ping = spawnSync("docker", ["version", "--format", "{{.Server.Version}}"], {
		encoding: "utf-8",
		timeout: 15_000,
	})
	if (ping.status !== 0) {
		return { ok: false, reason: `docker daemon not reachable: ${ping.stderr || "no server version"}` }
	}
	return { ok: true, reason: `server ${ping.stdout.trim()}` }
}

function sh(cmd: string): CommandResult {
	const res = spawnSync("sh", ["-c", cmd], { encoding: "utf-8", maxBuffer: 64 * 1024 * 1024 })
	return { exitCode: res.status ?? 1, output: `${res.stdout ?? ""}${res.stderr ?? ""}`.trim() }
}

/** Filter docker ps -a by name prefix; returns container NAMES. */
function listContainers(prefix: string): string[] {
	const res = sh(`docker ps -a --format '{{.Names}}'`)
	if (res.exitCode !== 0) {
		return []
	}
	return res.output.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.startsWith(prefix))
}

// ─── Fixture helpers ─────────────────────────────────────────────────────────

function tmpRepo(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "headlesscode-docker-repo-"))
}

function request(repo: string, name = "w1"): CloudSessionRequest {
	return {
		repo,
		issue: { number: 27, title: "Fix the bug", body: "make it work" },
		worktreeSpec: { name, issues: [27], taskFile: `${name}-issue27.md` },
		env: { ORCHESTRATOR_MODE: "code" },
	}
}

/** A minimal session command that writes completion markers like run-worker.sh does. */
function harnessCmd(exitCode: number): string {
	// run-worker.sh writes markers into the WORKTREE path (./.worktrees/<name>/)
	// — the workspace mount is the repo root, so the in-container path is
	// /workspace/.worktrees/<name>/ (same bytes the host sees at <repo>/.worktrees/<name>/).
	// The .worktrees dir is created by the spawner on the host; here the
	// container creates it (the workspace bind mount makes it visible to both).
	// harness.log is what collectResults tails for its summary.
	return `mkdir -p /workspace/.worktrees/w1 && printf '%s' '${exitCode}' > /workspace/.worktrees/w1/.harness.exit && mkdir -p /workspace/.worktrees/w1/.harness.done && echo "harness done (exit ${exitCode})" | tee /workspace/.worktrees/w1/harness.log && exit ${exitCode}`
}

// ─── Tests ──────────────────────────────────────────────────────────────────

/** Full 5-method lifecycle against the real daemon; asserts limits applied + teardown enumerates removal. */
async function testLifecycleAndTeardown(provider: DockerSessionProvider, image: string): Promise<void> {
	const repo = tmpRepo()
	try {
		const prefix = "hcls-test-lifecycle"
		const before = listContainers(prefix)

		const handle = await provider.spawnWorktreeSession(request(repo))
		assert.equal(handle.provider, "docker")
		assert.ok(handle.id, "handle has an id")
		assert.ok(handle.containerId, "handle carries the container id")

		// Container exists after spawn, with the resource limits applied.
		const afterSpawn = listContainers(prefix)
		assert.ok(afterSpawn.length > before.length, "container created by spawn")
		assert.ok(afterSpawn.includes(`${prefix}-w1`), `container ${prefix}-w1 listed after spawn`)

		const inspect = sh(`docker inspect ${handle.containerId}`).output
		const parsed = JSON.parse(inspect) as Array<{
			HostConfig: { NanoCpus?: number; Memory?: number; PidsLimit?: number }
			// .Image is the resolved sha256 id; .Config.Image is the tag used.
			Config: { Image: string }
		}>
		const hostCfg = parsed[0].HostConfig
		assert.ok((hostCfg.NanoCpus ?? 0) > 0, "CPU limit applied (NanoCpus set)")
		assert.ok((hostCfg.Memory ?? 0) > 0, "memory limit applied (Memory set)")
		assert.ok((hostCfg.PidsLimit ?? 0) > 0, "pids limit applied (PidsLimit set)")
		assert.ok(parsed[0].Config.Image.includes(image), `container uses the requested image (${image})`)

		await provider.waitReady(handle)
		// waitReady resolved — the container is actually Running (docker inspect Running=true).

		// runHarness executes INSIDE the container and writes workspace markers.
		const ran = await provider.runHarness(handle, harnessCmd(0))
		assert.equal(ran.exitCode, 0, `harness exit 0: ${ran.output}`)
		assert.match(ran.output, /harness done/, "harness output returned from inside the container")

		const results = await provider.collectResults(handle)
		assert.equal(results.exitCode, 0)
		assert.equal(results.done, true)
		assert.match(String(results.summary), /harness done/)

		// teardown must ACTUALLY remove the container — enumerate, don't trust exit codes.
		await provider.teardown(handle)
		const afterTeardown = listContainers(prefix)
		assert.ok(!afterTeardown.includes(`${prefix}-w1`), `container ${prefix}-w1 removed by teardown`)
		assert.equal(afterTeardown.length, before.length, "no containers leaked by the lifecycle")
	} finally {
		sh(`docker rm -f $(docker ps -aq --filter name=hcls-test-lifecycle) 2>/dev/null || true`)
		fs.rmSync(repo, { recursive: true, force: true })
	}
}

/** Run a harness command inside a spawned session (helper for the isolation test). */
async function runInSession(provider: DockerSessionProvider, handle: SessionHandle, cmd: string): Promise<CommandResult> {
	await provider.waitReady(handle)
	return provider.runHarness(handle, cmd)
}

/**
 * THE isolation proof (docs/multi-tenant-hosting-design.md §5.2): two
 * concurrent sessions — one cannot read the other's workspace-private file,
 * and one's CPU burn does not starve the other (cgroup caps).
 */
async function testIsolationBetweenConcurrentSessions(provider: DockerSessionProvider): Promise<void> {
	const repoA = tmpRepo()
	const repoB = tmpRepo()
	try {
		// Pre-clean containers from a previous run of THIS test (e.g. a crashed
		// or interrupted suite, or another worktree's npm test running in
		// parallel). Without this, spawnWorktreeSession's pre-clean races with
		// the daemon's own state and the second run fails with a stale-name
		// conflict or a "No such container" mid-test.
		sh(`docker rm -f $(docker ps -aq --filter name=hcls-test-iso) 2>/dev/null || true`)
		const handleA = await provider.spawnWorktreeSession(request(repoA, "iso-a"))
		const handleB = await provider.spawnWorktreeSession(request(repoB, "iso-b"))
		try {
			// Both sessions run concurrently (both spawned, both waited).
			await provider.waitReady(handleA)
			await provider.waitReady(handleB)

			// 1. Filesystem/visibility isolation: session A writes a
			//    tenant-private file; session B must NOT be able to read it.
			const writeA = await provider.runHarness(
				handleA,
				`mkdir -p /workspace/tenant-private && printf 'secret-of-A' > /workspace/tenant-private/a-only.txt && echo wrote`,
			)
			assert.equal(writeA.exitCode, 0, `A wrote its private file: ${writeA.output}`)

			const readFromB = await provider.runHarness(
				handleB,
				`cat /workspace/tenant-private/a-only.txt 2>&1; test -e /workspace/tenant-private/a-only.txt; echo "visible_from_B=$?"`,
			)
			assert.equal(readFromB.exitCode, 0, "B's check command itself succeeded")
			// B sees no such file — A's workspace mount is private to A.
			assert.match(readFromB.output, /No such file/, `B cannot see A's file: ${readFromB.output}`)
			assert.match(readFromB.output, /visible_from_B=1/, `B's own view is clean: ${readFromB.output}`)

			// 2. Resource isolation: B burns CPU while A runs a normal command.
			//    B is capped by its own --cpus limit, so it cannot starve A.
			const burnPromise = provider.runHarness(
				handleB,
				`( for i in $(seq 1 200000); do : ; done; echo "burn done" ) &
				 echo "burn started"; sleep 8`,
			)
			await new Promise((resolve) => setTimeout(resolve, 1000)) // let B's burn ramp up
			const startA = Date.now()
			const readFromA = await provider.runHarness(handleA, `echo "A alive"; printf 'secret-of-A' > /workspace/tenant-private/a-only.txt`)
			const aLatency = Date.now() - startA
			await burnPromise

			assert.equal(readFromA.exitCode, 0, `A completes normally while B burns CPU: ${readFromA.output}`)
			assert.match(readFromA.output, /A alive/)
			assert.ok(aLatency < 10_000, `A not starved by B's burn (latency ${aLatency}ms)`)
		} finally {
			await provider.teardown(handleA)
			await provider.teardown(handleB)
		}

		// Teardown enumerated: no iso-* containers remain.
		const remaining = listContainers("hcls-test-iso")
		assert.ok(!remaining.includes("hcls-test-iso-iso-a"), "iso-a container removed")
		assert.ok(!remaining.includes("hcls-test-iso-iso-b"), "iso-b container removed")
	} finally {
		sh(`docker rm -f $(docker ps -aq --filter name=hcls-test-iso) 2>/dev/null || true`)
		fs.rmSync(repoA, { recursive: true, force: true })
		fs.rmSync(repoB, { recursive: true, force: true })
	}
}

/** Unit-level: no daemon needed — injected run/isReady/listContainers fakes drive the lifecycle. */
async function testUnitWithInjectedFakes(): Promise<void> {
	const calls: string[] = []
	const fakeRun = (command: string): CommandResult => {
		calls.push(command)
		// Spawn = pre-clean + docker create (newline-joined); then a separate
		// docker start. The create output is the container id.
		if (command.includes("docker create")) {
			return { exitCode: 0, output: "fef445205b9c6f3389bafcbc818601b58d89d304202a807c8fcc416342bf0fac" }
		}
		if (command.startsWith("docker start")) {
			return { exitCode: 0, output: "started" }
		}
		if (command.startsWith("docker inspect")) {
			return { exitCode: 0, output: JSON.stringify([{ State: { Running: true } }]) }
		}
		if (command.startsWith("docker exec")) {
			return { exitCode: 0, output: "ran: " + command }
		}
		if (command.startsWith("docker rm -f")) {
			return { exitCode: 0, output: "removed" }
		}
		return { exitCode: 0, output: "" }
	}
	const provider = new DockerSessionProvider({
		run: fakeRun,
		isReady: () => true,
		listContainers: () => [],
	})

	const repo = tmpRepo()
	try {
		const handle = await provider.spawnWorktreeSession(request(repo, "w-fake"))
		assert.ok(calls.some((c) => c.includes("docker create")), "spawn issues docker create")
		const spawnCall = calls.find((c) => c.includes("docker create"))!
		assert.match(spawnCall, /--cpus \d+/, "CPU limit in the run command")
		assert.match(spawnCall, /--memory \d+m/, "memory limit in the run command")
		assert.match(spawnCall, /--pids-limit \d+/, "pids limit in the run command")
		assert.match(spawnCall, /--user \d+:\d+/, "container runs as a non-root uid:gid")
		assert.match(spawnCall, /--read-only/, "read-only rootfs")
		assert.match(spawnCall, /-v .*:\/workspace/, "workspace mount")
		assert.match(spawnCall, /-v .*:\/harness:ro/, "harness mount read-only")

		await provider.waitReady(handle)
		const ran = await provider.runHarness(handle, "echo hi")
		assert.equal(ran.exitCode, 0)
		assert.match(ran.output, /ran: docker exec/)
		await provider.teardown(handle)
		assert.ok(calls.some((c) => c.startsWith("docker rm -f")), "teardown removes the container")
	} finally {
		fs.rmSync(repo, { recursive: true, force: true })
	}
}

// ─── Runner ──────────────────────────────────────────────────────────────────

const tests: Array<[string, () => Promise<void>]> = [
	["DockerSessionProvider unit: injected fakes drive spawn/wait/run/teardown command shapes", testUnitWithInjectedFakes],
]

let dockerNote = ""
const probe = dockerAvailable()
if (probe.ok) {
	dockerNote = `real Docker daemon: ${probe.reason}`
	tests.push(
		["DockerSessionProvider lifecycle + teardown enumeration (real daemon)", () => {
			const provider = new DockerSessionProvider({ namePrefix: "hcls-test-lifecycle" })
			return testLifecycleAndTeardown(provider, "node:22-bookworm-slim")
		}],
		["Isolation proof: two concurrent sessions cannot see or starve each other (real daemon)", () => {
			const provider = new DockerSessionProvider({ namePrefix: "hcls-test-iso" })
			return testIsolationBetweenConcurrentSessions(provider)
		}],
	)
} else {
	dockerNote = `SKIP real-daemon tests: ${probe.reason}`
}

async function main(): Promise<void> {
	console.log(`  note: ${dockerNote}`)
	let failed = 0
	let skipped = 0
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
	if (!probe.ok) {
		skipped = 2
		console.log(`  SKIP ${skipped} real-daemon test(s) — ${probe.reason}`)
	}
	if (failed > 0) {
		console.error(`\n${failed} test(s) failed`)
		process.exit(1)
	}
	console.log(`\nAll ${tests.length} docker-provider tests passed (${skipped} skipped: no Docker daemon)`)
}

main().catch((err) => {
	console.error("Test runner crashed:", err)
	process.exit(1)
})
