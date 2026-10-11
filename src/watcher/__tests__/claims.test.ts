/** CPU-only tests for GitHub-ref claim CAS and fail-closed recovery semantics. */

import assert from "node:assert/strict"
import * as fs from "node:fs/promises"
import * as path from "node:path"

import { Logger } from "../../engine/logger.js"
import {
	ClaimConflictError,
	ClaimLeaseExpiredError,
	GitHubIssueClaimStore,
} from "../claims.js"
import { watchIssues } from "../watch.js"
import type { GitHubIssue } from "../github.js"

interface FakeInit { method?: string; body?: string }
interface FakeCommit { sha: string; message: string; tree: { sha: string }; parents: Array<{ sha: string }> }

function claimApi(): { fetch: typeof fetch; commits: Map<string, FakeCommit>; refs: Map<string, string>; failAssignment: { value: boolean } } {
	const defaultSha = "a".repeat(40)
	const treeSha = "b".repeat(40)
	const commits = new Map<string, FakeCommit>([[defaultSha, {
		sha: defaultSha, message: "base", tree: { sha: treeSha }, parents: [],
	}]])
	const refs = new Map<string, string>([["heads/main", defaultSha]])
	let serial = 0
	const failAssignment = { value: false }
	const fake = async (input: unknown, init?: unknown): Promise<Response> => {
		const url = new URL(typeof input === "string" ? input : String((input as { url?: unknown }).url ?? ""))
		const method = (init as FakeInit | undefined)?.method ?? "GET"
		const body = JSON.parse((init as FakeInit | undefined)?.body ?? "null") as Record<string, unknown> | null
		const prefix = "/repos/owner/repo/"
		const route = url.pathname.startsWith(prefix) ? url.pathname.slice(prefix.length) : ""
		const reply = (status: number, value?: unknown): Response => new Response(value === undefined ? null : JSON.stringify(value), { status })

		if (method === "GET" && route === "") return reply(200, { default_branch: "main" })
		if (method === "GET" && route === "git/ref/heads/main") return reply(200, { object: { sha: defaultSha, type: "commit" } })
		if (method === "GET" && route === "git/matching-refs/heads/headlesscode-claims/issue-") {
			return reply(200, [...refs.entries()].filter(([name]) => name.startsWith("heads/headlesscode-claims/issue-")).map(([name, sha]) => ({
				ref: `refs/${name}`, object: { sha, type: "commit" },
			})))
		}
		if (method === "GET" && route.startsWith("git/ref/")) {
			const refName = route.slice("git/ref/".length)
			const sha = refs.get(refName)
			return sha ? reply(200, { object: { sha, type: "commit" } }) : reply(404, { message: "Not Found" })
		}
		if (method === "GET" && route.startsWith("git/commits/")) {
			const commit = commits.get(route.slice("git/commits/".length))
			return commit ? reply(200, commit) : reply(404, { message: "Not Found" })
		}
		if (method === "POST" && route === "git/commits") {
			const sha = (++serial).toString(16).padStart(40, "0")
			const commit: FakeCommit = {
				sha,
				message: String(body?.message ?? ""),
				tree: { sha: String(body?.tree ?? "") },
				parents: Array.isArray(body?.parents) ? (body!.parents as string[]).map((parent) => ({ sha: parent })) : [],
			}
			commits.set(sha, commit)
			return reply(201, { sha })
		}
		if ((method === "POST" || method === "DELETE") && /^issues\/[0-9]+\/assignees$/.test(route)) {
			if (method === "POST" && failAssignment.value) return reply(403, { message: "synthetic assignment denied" })
			return reply(201, { assignees: [] })
		}
		if (method === "POST" && route === "git/refs") {
			const refName = String(body?.ref ?? "").replace(/^refs\//, "")
			if (refs.has(refName)) return reply(422, { message: "Reference already exists" })
			refs.set(refName, String(body?.sha ?? ""))
			return reply(201, { ref: `refs/${refName}`, object: { sha: body?.sha } })
		}
		if (method === "PATCH" && route.startsWith("git/refs/")) {
			const refName = route.slice("git/refs/".length)
			const current = refs.get(refName)
			const nextSha = String(body?.sha ?? "")
			const nextCommit = commits.get(nextSha)
			if (!current || !nextCommit || !nextCommit.parents.some((parent) => parent.sha === current)) {
				return reply(422, { message: "Update is not a fast-forward" })
			}
			refs.set(refName, nextSha)
			return reply(200, { ref: `refs/${refName}`, object: { sha: nextSha } })
		}
		return reply(404, { message: `Unexpected fake route ${method} ${route}` })
	}
	return { fetch: fake as typeof fetch, commits, refs, failAssignment }
}

function store(
	api: ReturnType<typeof claimApi>,
	runnerId: string,
	now: () => Date,
	nonce: string,
): GitHubIssueClaimStore {
	return new GitHubIssueClaimStore({
		token: "synthetic-test-token",
		owner: "owner",
		repo: "repo",
		runnerId,
		baseUrl: "https://api.example.test",
		fetchImpl: api.fetch,
		leaseMs: 30_000,
		runnerAssignee: runnerId === "workstation" ? "synthetic-bot" : undefined,
		now,
		newNonce: () => nonce,
	})
}

async function testClaimLifecycleAndExpiredQuarantine(): Promise<void> {
	const api = claimApi()
	let now = new Date("2026-10-11T12:00:00.000Z")
	const runnerA = store(api, "workstation", () => now, "nonce-A-0123456789")
	const runnerB = store(api, "node", () => now, "nonce-B-0123456789")

	const first = await runnerA.acquire(41, { worktreeNames: ["w1"] })
	assert.equal(first.acquired, true)
	if (!first.acquired) throw new Error("expected claim acquisition")
	assert.equal(first.claim.epoch, 1)
	assert.equal(first.claim.runnerId, "workstation")
	assert.equal(first.claim.stage, "reserved")
	const listed = await runnerA.listActiveClaims()
	assert.equal(listed.length, 1, "active claim is durable and counts against runner capacity")

	const busy = await runnerB.acquire(41, { worktreeNames: ["w2"] })
	assert.equal(busy.acquired, false)
	assert.equal(busy.reason, "held")
	await assert.rejects(runnerB.renew(41, first.claim), ClaimConflictError)

	now = new Date("2026-10-11T12:00:31.000Z")
	const expired = await runnerB.acquire(41, { worktreeNames: ["w2"] })
	assert.equal(expired.acquired, false)
	assert.equal(expired.reason, "expired-quarantined")
	await assert.rejects(runnerA.verifyActive(41, first.claim), ClaimLeaseExpiredError)
	await assert.rejects(runnerA.renew(41, first.claim), ClaimLeaseExpiredError)

	await assert.rejects(runnerA.release(41, first.claim, { kind: "never-spawned", observedAt: "not-a-date" }))
	const released = await runnerA.release(41, first.claim, {
		kind: "process-groups-absent",
		observedAt: now.toISOString(),
	}, "completed")
	assert.equal(released.phase, "released")
	const next = await runnerB.acquire(41, { worktreeNames: ["w2"] })
	assert.equal(next.acquired, true)
	if (!next.acquired) throw new Error("expected reacquired claim")
	const running = await runnerB.markRunning(41, next.claim)
	await assert.rejects(runnerB.release(41, running, { kind: "never-spawned", observedAt: now.toISOString() }))
	assert.ok(api.refs.has("heads/headlesscode-claims/issue-41"), "claim refs remain; release never deletes a ref")

	now = new Date("2026-10-11T12:00:32.000Z")
	const afterRelease = await runnerB.release(41, running, { kind: "process-groups-absent", observedAt: now.toISOString() }, "completed")
	assert.equal(afterRelease.phase, "released")
	const third = await runnerB.acquire(41, { worktreeNames: ["w2"] })
	assert.equal(third.acquired, true)
	if (third.acquired) assert.equal(third.claim.epoch, 3)
}

async function testAssignmentFailureDoesNotLeaveUnownedActiveClaim(): Promise<void> {
	const api = claimApi()
	api.failAssignment.value = true
	const runner = store(api, "workstation", () => new Date("2026-10-11T12:00:00.000Z"), "nonce-assignment-0123")
	await assert.rejects(runner.acquire(88, { worktreeNames: ["w1"] }), /synthetic assignment denied/)
	assert.equal((await runner.read(88))?.claim.phase, "released", "failed visible assignment safely releases its never-spawned claim")
}

async function testExpiredClaimNeedsExplicitFencedOperatorRecovery(): Promise<void> {
	const api = claimApi()
	let now = new Date("2026-10-11T12:00:00.000Z")
	const oldRunner = store(api, "old-node", () => now, "nonce-old-node-012345")
	const operator = store(api, "operator-workstation", () => now, "nonce-operator-01234")
	const acquired = await oldRunner.acquire(91, { worktreeNames: ["w7"] })
	assert.equal(acquired.acquired, true)
	if (!acquired.acquired) throw new Error("expected initial claim")
	const tip = (await oldRunner.read(91))!.commitSha
	now = new Date("2026-10-11T12:02:01.000Z")
	const evidence = {
		operator: "owner",
		evidence: "Host power state checked; worker and guest resources are absent.",
		terminalStateConfirmed: true as const,
	}
	await assert.rejects(operator.recoverExpired(91, { ...acquired.claim, tip: "0".repeat(40) }, evidence), ClaimConflictError)
	await assert.rejects(operator.recoverExpired(91, { ...acquired.claim, tip }, { ...evidence, terminalStateConfirmed: false as true }), /terminal-state confirmation/)
	const recovered = await operator.recoverExpired(91, { ...acquired.claim, tip }, evidence)
	assert.equal(recovered.phase, "released")
	assert.equal(recovered.releaseReason, "operator-recovered")
	assert.equal(recovered.operatorRecovery?.operator, "owner")
	assert.equal(recovered.operatorRecovery?.evidence, evidence.evidence)
	const nextRunner = store(api, "new-node", () => now, "nonce-new-node-012345")
	const next = await nextRunner.acquire(91, { worktreeNames: ["w8"] })
	assert.equal(next.acquired, true)
	if (next.acquired) assert.equal(next.claim.epoch, 2)
}

async function testInitialClaimsRaceWithOnlyOneWinner(): Promise<void> {
	const api = claimApi()
	const now = () => new Date("2026-10-11T12:00:00.000Z")
	const left = store(api, "workstation", now, "nonce-left-0123456789")
	const right = store(api, "node", now, "nonce-right-0123456789")
	const outcomes = await Promise.allSettled([
		left.acquire(52, { worktreeNames: ["w1"] }),
		right.acquire(52, { worktreeNames: ["w1"] }),
	])
	const values = outcomes.map((outcome) => {
		if (outcome.status === "rejected") {
			assert.ok(outcome.reason instanceof ClaimConflictError)
			return undefined
		}
		return outcome.value
	})
	assert.equal(values.filter((value) => value?.acquired).length, 1, "atomic create-ref admits exactly one initial owner")
	assert.equal(values.filter((value) => value && !value.acquired).length, 1, "loser observes the winning owner as held")
}

async function testRefUpdateUsesParentAndNoForce(): Promise<void> {
	const api = claimApi()
	const now = () => new Date("2026-10-11T12:00:00.000Z")
	const runner = store(api, "runner-1", now, "nonce-test-0123456789")
	const created = await runner.acquire(63, { worktreeNames: ["w1", "w2"] })
	assert.equal(created.acquired, true)
	if (!created.acquired) return
	await runner.renew(63, created.claim)
	const commits = [...api.commits.values()].filter((commit) => commit.message.startsWith("headlesscode-runner-claim-v1\n"))
	assert.equal(commits.length, 2)
	assert.deepEqual(commits[1]!.parents.map((parent) => parent.sha), [commits[0]!.sha])
}

async function testWatcherClaimSurvivesUntilConfirmedCompletion(): Promise<void> {
	const api = claimApi()
	const now = () => new Date("2026-10-11T12:00:00.000Z")
	const claims = store(api, "workstation", now, "nonce-watch-0123456789")
	const controller = new AbortController()
	const scratch = path.join(process.cwd(), ".headlesscode", "scratch", "node-pool-32-claims-test")
	await fs.mkdir(scratch, { recursive: true, mode: 0o700 })
	const repoRoot = await fs.mkdtemp(path.join(scratch, "repo-"))
	const stateFile = path.join(repoRoot, ".worktrees", ".watcher-state.json")
	const issue: GitHubIssue = { number: 74, title: "synthetic claim integration", labels: ["needs-agent"] }
	const result = await watchIssues({
		owner: "owner", repo: "repo", targetLabel: "needs-agent", token: "test-token",
		repoRoot, stateFile, runOnce: false, pollIntervalMs: 10, maxConcurrentSessions: 1,
		runnerId: "workstation", runnerAssignee: "synthetic-bot", claimStore: claims,
		gh: {
			listIssues: async () => [issue],
			getIssue: async () => issue,
			addLabel: async () => undefined,
		},
		spawn: async (batch) => {
			for (const spec of batch.specs) {
				const worktree = path.join(repoRoot, ".worktrees", spec.name)
				await fs.mkdir(path.join(worktree, ".harness.done"), { recursive: true })
				const absentPgid = 2_147_483_647
				assert.throws(() => process.kill(-absentPgid, 0), (error: NodeJS.ErrnoException) => error.code === "ESRCH")
				await fs.writeFile(path.join(worktree, ".harness.pgid"), `${absentPgid}\n`)
			}
			return { ok: true, status: 0 }
		},
		onBatch: () => controller.abort(),
		signal: controller.signal,
		logger: new Logger({ level: "silent" }),
	})
	assert.equal(result.spawned, 1)
	const finalClaim = await claims.read(issue.number)
	assert.equal(finalClaim?.claim.phase, "released", "completion releases only after marker and process-group absence are confirmed")
	assert.equal((await claims.listActiveClaims("workstation")).length, 0)
	await fs.rm(repoRoot, { recursive: true, force: true })
}

async function testMarkerOnlyClaimStaysQuarantinedAndCountsEveryWorktree(): Promise<void> {
	const api = claimApi()
	const now = () => new Date("2026-10-11T12:00:00.000Z")
	const claims = store(api, "workstation", now, "nonce-capacity-0123456789")
	const fanout = await claims.acquire(75, { worktreeNames: ["w1", "w2"] })
	assert.equal(fanout.acquired, true)
	if (!fanout.acquired) throw new Error("expected fan-out claim")
	await claims.markRunning(75, fanout.claim)
	const markerOnly = await claims.acquire(76, { worktreeNames: ["w3"] })
	assert.equal(markerOnly.acquired, true)
	if (!markerOnly.acquired) throw new Error("expected marker-only claim")
	await claims.markRunning(76, markerOnly.claim)

	const scratch = path.join(process.cwd(), ".headlesscode", "scratch", "node-pool-32-claims-test")
	await fs.mkdir(scratch, { recursive: true, mode: 0o700 })
	const repoRoot = await fs.mkdtemp(path.join(scratch, "capacity-"))
	for (const name of ["w1", "w2"]) {
		const worktree = path.join(repoRoot, ".worktrees", name)
		await fs.mkdir(worktree, { recursive: true })
		// The test process itself is a harmless live-PID sentinel. Teardown is
		// bypassed below after the single sweep so no signal is sent to it.
		await fs.writeFile(path.join(worktree, ".harness.pid"), `${process.pid}\n`)
	}
	const markerWorktree = path.join(repoRoot, ".worktrees", "w3")
	await fs.mkdir(path.join(markerWorktree, ".harness.done"), { recursive: true })

	const controller = new AbortController()
	const listActive = claims.listActiveClaims.bind(claims)
	let claimReads = 0
	claims.listActiveClaims = async () => ++claimReads === 1 ? listActive() : []
	let spawnCalls = 0
	const issue: GitHubIssue = { number: 77, title: "synthetic capacity issue", labels: ["needs-agent"] }
	const result = await watchIssues({
		owner: "owner", repo: "repo", targetLabel: "needs-agent", token: "test-token",
		repoRoot,
		stateFile: path.join(repoRoot, ".worktrees", ".watcher-state.json"),
		runOnce: false, pollIntervalMs: 1, maxConcurrentSessions: 3,
		runnerId: "workstation", runnerAssignee: "synthetic-bot", claimStore: claims,
		gh: {
			listIssues: async () => { controller.abort(); return [issue] },
			getIssue: async () => issue,
			addLabel: async () => undefined,
		},
		spawn: async () => { spawnCalls++; return { ok: true, status: 0 } },
		signal: controller.signal,
		logger: new Logger({ level: "silent" }),
	})
	assert.equal(result.spawned, 0, "three active worktrees fill capacity even though they belong to two issue claims")
	assert.equal(spawnCalls, 0)
	assert.equal(result.sweeps[0]?.deferred, 1)
	assert.equal((await claims.read(76))?.claim.phase, "active", "a done marker without PID/PGID absence proof remains held")
	await fs.rm(repoRoot, { recursive: true, force: true })
}

await testClaimLifecycleAndExpiredQuarantine()
await testAssignmentFailureDoesNotLeaveUnownedActiveClaim()
await testExpiredClaimNeedsExplicitFencedOperatorRecovery()
await testInitialClaimsRaceWithOnlyOneWinner()
await testRefUpdateUsesParentAndNoForce()
await testWatcherClaimSurvivesUntilConfirmedCompletion()
await testMarkerOnlyClaimStaysQuarantinedAndCountsEveryWorktree()
process.stdout.write("watcher claims tests passed\n")
