/**
 * Cross-machine issue claims stored as compare-and-swap Git refs.
 *
 * Each issue has a permanent `headlesscode-claims/issue-N` ref. The ref points
 * to a commit whose message contains the current lease record. Updates are
 * commits parented by the observed tip and use a non-forced ref update, so
 * two contenders that start from the same tip cannot both win. Refs are never
 * deleted: deleting and recreating one would create an ABA window.
 *
 * Expired active claims are quarantined, not automatically reassigned. A
 * GitHub lease cannot prove that an unreachable host stopped its worker. A
 * runner may publish `released` only after it has confirmed local teardown;
 * an operator may release a quarantined claim only after independently
 * confirming that its old worker is stopped. This trades availability for
 * preventing duplicate work when a runner is partitioned.
 */

import { randomUUID } from "node:crypto"

import { GhApiError, ghApi, type GhRequestOptions } from "./github.js"

const RECORD_PREFIX = "headlesscode-runner-claim-v1\n"
const CLAIM_TTL_MIN_MS = 30_000
const CLAIM_TTL_MAX_MS = 15 * 60_000

export interface RunnerClaim {
	version: 1
	issue: number
	epoch: number
	phase: "active" | "released"
	stage: "reserved" | "running"
	runnerId: string
	runnerAssignee?: string
	leaseNonce: string
	/** Local worktree names only; never issue text or host filesystem paths. */
	worktreeNames: string[]
	updatedAt: string
	leaseExpiresAt: string
	/** Present only for a terminal release after local teardown was confirmed. */
	releaseReason?: "completed" | "spawn-failed" | "operator-recovered"
	operatorRecovery?: {
		operator: string
		evidence: string
		observedAt: string
		expectedTip: string
	}
}

export interface ClaimSnapshot {
	claim: RunnerClaim
	commitSha: string
}

export type ClaimAcquireResult =
	| { acquired: true; claim: RunnerClaim }
	| { acquired: false; reason: "held" | "expired-quarantined"; claim: RunnerClaim }

export interface ClaimTeardownProof {
	kind: "never-spawned" | "process-groups-absent"
	observedAt: string
}

/** Operator-supplied evidence; the operator must verify terminal teardown out of band. */
export interface OperatorRecoveryEvidence {
	operator: string
	evidence: string
	terminalStateConfirmed: true
}

export interface ClaimStoreOptions {
	token: string
	owner: string
	repo: string
	runnerId: string
	runnerAssignee?: string
	baseUrl?: string
	fetchImpl?: typeof fetch
	leaseMs?: number
	now?: () => Date
	newNonce?: () => string
}

export interface ClaimSeed { worktreeNames: string[] }

/** A lost/non-fast-forward update is a normal contention result, never success. */
export class ClaimConflictError extends Error {
	constructor(message = "GitHub issue claim changed during compare-and-swap") {
		super(message)
		this.name = "ClaimConflictError"
	}
}

export class ClaimLeaseExpiredError extends Error {
	constructor(message = "Runner issue claim lease has expired; the worker must be stopped") {
		super(message)
		this.name = "ClaimLeaseExpiredError"
	}
}

export class GitHubIssueClaimStore {
	private readonly apiOptions: GhRequestOptions
	private readonly repoPath: string
	private readonly runnerId: string
	private readonly runnerAssignee?: string
	private readonly leaseMs: number
	private readonly now: () => Date
	private readonly newNonce: () => string

	constructor(options: ClaimStoreOptions) {
		if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(options.owner)) throw new Error("claim store: invalid GitHub owner")
		if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(options.repo)) throw new Error("claim store: invalid GitHub repository")
		if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(options.runnerId)) throw new Error("claim store: runnerId must be a stable, non-secret identifier")
		const leaseMs = options.leaseMs ?? 120_000
		if (!Number.isInteger(leaseMs) || leaseMs < CLAIM_TTL_MIN_MS || leaseMs > CLAIM_TTL_MAX_MS) {
			throw new Error(`claim store: leaseMs must be ${CLAIM_TTL_MIN_MS}..${CLAIM_TTL_MAX_MS}`)
		}
		this.apiOptions = {
			token: options.token,
			...(options.baseUrl ? { baseUrl: options.baseUrl } : {}),
			...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
		}
		this.repoPath = `/repos/${encodeURIComponent(options.owner)}/${encodeURIComponent(options.repo)}`
		this.runnerId = options.runnerId
		if (options.runnerAssignee !== undefined && !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(options.runnerAssignee)) {
			throw new Error("claim store: runnerAssignee must be a GitHub login")
		}
		this.runnerAssignee = options.runnerAssignee
		this.leaseMs = leaseMs
		this.now = options.now ?? (() => new Date())
		this.newNonce = options.newNonce ?? randomUUID
	}

	async read(issue: number): Promise<ClaimSnapshot | undefined> {
		validateIssue(issue)
		const refPath = claimRefPath(issue)
		let ref: unknown
		try {
			ref = await ghApi(`${this.repoPath}/git/ref/${refPath}`, this.apiOptions)
		} catch (error) {
			if (error instanceof GhApiError && error.status === 404) return undefined
			throw error
		}
		const sha = objectSha(ref, "claim ref")
		const commit = await ghApi(`${this.repoPath}/git/commits/${encodeURIComponent(sha)}`, this.apiOptions)
		const record = parseClaimRecord(commit, issue)
		return { claim: record, commitSha: sha }
	}

	/** Read every permanent issue claim ref; failures are fail-closed for capacity. */
	async listActiveClaims(runnerId?: string): Promise<ClaimSnapshot[]> {
		if (runnerId !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(runnerId)) throw new Error("claim store: invalid runnerId")
		const response = await ghApi(`${this.repoPath}/git/matching-refs/heads/headlesscode-claims/issue-`, this.apiOptions)
		if (!Array.isArray(response) || response.length > 1000) throw new Error("claim store: malformed or over-limit matching-refs response")
		const issueNumbers = new Set<number>()
		for (const entry of response) {
			if (!entry || typeof entry !== "object" || typeof (entry as { ref?: unknown }).ref !== "string") {
				throw new Error("claim store: malformed matching ref")
			}
			const match = /^refs\/heads\/headlesscode-claims\/issue-([1-9][0-9]{0,14})$/.exec((entry as { ref: string }).ref)
			if (!match) throw new Error("claim store: unsupported ref under claim prefix")
			issueNumbers.add(Number(match[1]))
		}
		const snapshots: ClaimSnapshot[] = []
		for (const issue of issueNumbers) {
			const snapshot = await this.read(issue)
			if (snapshot?.claim.phase === "active" && (runnerId === undefined || snapshot.claim.runnerId === runnerId)) snapshots.push(snapshot)
		}
		return snapshots
	}

	/**
	 * Acquire only an absent or explicitly released claim. An expired active
	 * claim stays quarantined until its former runner confirms teardown.
	 */
	async acquire(issue: number, seed: ClaimSeed): Promise<ClaimAcquireResult> {
		validateIssue(issue)
		validateSeed(seed)
		const current = await this.read(issue)
		if (current?.claim.phase === "active") {
			const expired = Date.parse(current.claim.leaseExpiresAt) <= this.now().getTime()
			return {
				acquired: false,
				reason: expired ? "expired-quarantined" : "held",
				claim: current.claim,
			}
		}

		const now = this.now()
		const previousEpoch = current?.claim.epoch ?? 0
		const claim = this.makeClaim(issue, previousEpoch + 1, now, "active", this.newNonce(), seed.worktreeNames)
		if (!current) {
			const base = await this.defaultBranchTree()
			const commitSha = await this.createCommit(claim, base.treeSha, [base.commitSha])
			try {
				await ghApi(`${this.repoPath}/git/refs`, {
					...this.apiOptions,
					method: "POST",
					body: { ref: `refs/${claimRefPath(issue)}`, sha: commitSha },
				})
			} catch (error) {
				if (isContention(error)) {
					const winner = await this.read(issue)
					if (winner?.claim.phase === "active") {
						return { acquired: false, reason: Date.parse(winner.claim.leaseExpiresAt) <= this.now().getTime() ? "expired-quarantined" : "held", claim: winner.claim }
					}
					throw new ClaimConflictError("Another runner changed the issue claim first")
				}
				throw error
			}
			const committed = await this.verifyCommitted(claim, commitSha)
			try {
				await this.setAssignee(issue, true)
			} catch (error) {
				// Assignment is a visible indicator, but the ref remains authoritative.
				// This claim has not dispatched a worker, so try to unwind safely.
				try {
					await this.release(issue, committed.claim, { kind: "never-spawned", observedAt: this.now().toISOString() }, "spawn-failed")
				} catch { /* retain the active ref as a safe quarantine */ }
				throw error
			}
			return { acquired: true, claim: committed.claim }
		}

		try {
			const committed = await this.advance(current, claim)
			try {
				await this.setAssignee(issue, true)
			} catch (error) {
				try {
					await this.release(issue, committed.claim, { kind: "never-spawned", observedAt: this.now().toISOString() }, "spawn-failed")
				} catch { /* retain the active ref as a safe quarantine */ }
				throw error
			}
			return { acquired: true, claim: committed.claim }
		} catch (error) {
			if (error instanceof ClaimConflictError) {
				const winner = await this.read(issue)
				if (winner?.claim.phase === "active") {
					return { acquired: false, reason: Date.parse(winner.claim.leaseExpiresAt) <= this.now().getTime() ? "expired-quarantined" : "held", claim: winner.claim }
				}
			}
			throw error
		}
	}

	/** Renew before expiry; a lease that reached its deadline cannot revive. */
	async verifyActive(issue: number, expected: Pick<RunnerClaim, "runnerId" | "leaseNonce" | "epoch">): Promise<RunnerClaim> {
		const current = await this.requireOwnedActive(issue, expected)
		if (Date.parse(current.claim.leaseExpiresAt) <= this.now().getTime()) throw new ClaimLeaseExpiredError()
		return current.claim
	}

	async renew(issue: number, expected: Pick<RunnerClaim, "runnerId" | "leaseNonce" | "epoch">): Promise<RunnerClaim> {
		const current = await this.requireOwnedActive(issue, expected)
		const now = this.now()
		if (Date.parse(current.claim.leaseExpiresAt) <= now.getTime()) throw new ClaimLeaseExpiredError()
		return (await this.advance(current, this.makeClaim(issue, current.claim.epoch, now, "active", current.claim.leaseNonce, current.claim.worktreeNames, current.claim.stage))).claim
	}

	async markRunning(issue: number, expected: Pick<RunnerClaim, "runnerId" | "leaseNonce" | "epoch">): Promise<RunnerClaim> {
		const current = await this.requireOwnedActive(issue, expected)
		const now = this.now()
		if (Date.parse(current.claim.leaseExpiresAt) <= now.getTime()) throw new ClaimLeaseExpiredError()
		return (await this.advance(current, this.makeClaim(issue, current.claim.epoch, now, "active", current.claim.leaseNonce, current.claim.worktreeNames, "running"))).claim
	}

	/**
	 * Release only after the caller proves there is no worker process left.
	 * Network/API failure leaves the claim active and therefore quarantined.
	 */
	async release(
		issue: number,
		expected: Pick<RunnerClaim, "runnerId" | "leaseNonce" | "epoch">,
		proof: ClaimTeardownProof,
		reason: RunnerClaim["releaseReason"] = "completed",
	): Promise<RunnerClaim> {
		const current = await this.requireOwnedActive(issue, expected)
		if (!isTeardownProof(proof) || (proof.kind === "never-spawned" && current.claim.stage !== "reserved")) {
			throw new Error("claim release requires confirmed worker teardown")
		}
		const now = this.now()
		const claim = this.makeClaim(issue, current.claim.epoch, now, "released", current.claim.leaseNonce, current.claim.worktreeNames, current.claim.stage)
		claim.leaseExpiresAt = now.toISOString()
		claim.releaseReason = reason
		// Keep the issue assignee as a visible indicator while active. If its
		// removal fails, leave the authoritative ref active and quarantine it.
		await this.setAssignee(issue, false, current.claim.runnerAssignee)
		return (await this.advance(current, claim)).claim
	}

	/**
	 * Manually release an expired quarantined claim after an operator has
	 * independently verified the old worker and guest resources are stopped.
	 * The exact tip/nonce/epoch fence the recovery against concurrent renewal.
	 */
	async recoverExpired(issue: number, expected: Pick<RunnerClaim, "runnerId" | "leaseNonce" | "epoch"> & { tip: string }, evidence: OperatorRecoveryEvidence): Promise<RunnerClaim> {
		validateIssue(issue)
		if (!evidence || evidence.terminalStateConfirmed !== true ||
			!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(evidence.operator) ||
			typeof evidence.evidence !== "string" || evidence.evidence.trim().length < 12 || evidence.evidence.length > 1000 ||
			/[\u0000-\u001f\u007f\u001b]/.test(evidence.evidence) ||
			typeof expected.tip !== "string" || !/^[a-f0-9]{40,64}$/.test(expected.tip)) {
			throw new Error("claim recovery requires an operator login, bounded teardown evidence, explicit terminal-state confirmation, and exact expected tip")
		}
		const current = await this.requireOwnedActiveForRecovery(issue, expected)
		if (current.commitSha !== expected.tip) throw new ClaimConflictError("Claim tip changed; inspect the new claim before recovery")
		const now = this.now()
		if (Date.parse(current.claim.leaseExpiresAt) > now.getTime()) throw new Error("claim recovery is only allowed after lease expiry")
		await this.setAssignee(issue, false, current.claim.runnerAssignee)
		const released: RunnerClaim = {
			...current.claim,
			phase: "released",
			updatedAt: now.toISOString(),
			leaseExpiresAt: now.toISOString(),
			releaseReason: "operator-recovered",
			operatorRecovery: {
				operator: evidence.operator,
				evidence: evidence.evidence.trim(),
				observedAt: now.toISOString(),
				expectedTip: expected.tip,
			},
		}
		return (await this.advance(current, released)).claim
	}

	private async requireOwnedActive(
		issue: number,
		expected: Pick<RunnerClaim, "runnerId" | "leaseNonce" | "epoch">,
	): Promise<ClaimSnapshot> {
		validateIssue(issue)
		const current = await this.read(issue)
		if (
			!current || current.claim.phase !== "active" || current.claim.runnerId !== expected.runnerId ||
			current.claim.leaseNonce !== expected.leaseNonce || current.claim.epoch !== expected.epoch
		) throw new ClaimConflictError("This runner no longer owns the issue claim")
		if (current.claim.runnerId !== this.runnerId) throw new ClaimConflictError("Claim runnerId does not match this claim store")
		return current
	}

	private async requireOwnedActiveForRecovery(
		issue: number,
		expected: Pick<RunnerClaim, "runnerId" | "leaseNonce" | "epoch">,
	): Promise<ClaimSnapshot> {
		const current = await this.read(issue)
		if (!current || current.claim.phase !== "active" || current.claim.runnerId !== expected.runnerId ||
			current.claim.leaseNonce !== expected.leaseNonce || current.claim.epoch !== expected.epoch) {
			throw new ClaimConflictError("The claim identity changed; inspect the current claim before recovery")
		}
		return current
	}

	private makeClaim(
		issue: number,
		epoch: number,
		now: Date,
		phase: RunnerClaim["phase"],
		nonce: string,
		worktreeNames: string[],
		stage: RunnerClaim["stage"] = "reserved",
	): RunnerClaim {
		if (!/^[A-Za-z0-9-]{16,64}$/.test(nonce)) throw new Error("claim store: nonce generator returned an invalid nonce")
		return {
			version: 1,
			issue,
			epoch,
			phase,
			stage,
			runnerId: this.runnerId,
			leaseNonce: nonce,
			...(this.runnerAssignee ? { runnerAssignee: this.runnerAssignee } : {}),
			worktreeNames,
			updatedAt: now.toISOString(),
			leaseExpiresAt: new Date(now.getTime() + (phase === "active" ? this.leaseMs : 0)).toISOString(),
		}
	}

	private async advance(current: ClaimSnapshot, claim: RunnerClaim): Promise<ClaimSnapshot> {
		const commitSha = await this.createCommit(claim, await this.treeForCommit(current.commitSha), [current.commitSha])
		try {
			await ghApi(`${this.repoPath}/git/refs/${claimRefPath(claim.issue)}`, {
				...this.apiOptions,
				method: "PATCH",
				body: { sha: commitSha, force: false },
			})
		} catch (error) {
			if (isContention(error)) throw new ClaimConflictError()
			throw error
		}
		return this.verifyCommitted(claim, commitSha)
	}

	private async verifyCommitted(expected: RunnerClaim, commitSha: string): Promise<ClaimSnapshot> {
		const actual = await this.read(expected.issue)
		if (!actual || actual.commitSha !== commitSha || !sameClaim(actual.claim, expected)) {
			throw new ClaimConflictError("Claim update was superseded before it could be verified")
		}
		return actual
	}

	private async createCommit(claim: RunnerClaim, treeSha: string, parents: string[]): Promise<string> {
		const result = await ghApi(`${this.repoPath}/git/commits`, {
			...this.apiOptions,
			method: "POST",
			body: {
				message: `${RECORD_PREFIX}${JSON.stringify(claim)}`,
				tree: treeSha,
				parents,
			},
		})
		return objectSha(result, "claim commit")
	}

	private async treeForCommit(sha: string): Promise<string> {
		const commit = await ghApi(`${this.repoPath}/git/commits/${encodeURIComponent(sha)}`, this.apiOptions)
		return nestedSha(commit, "tree", "claim commit tree")
	}

	private async setAssignee(issue: number, assigned: boolean, login = this.runnerAssignee): Promise<void> {
		if (!login) return
		await ghApi(`${this.repoPath}/issues/${issue}/assignees`, {
			...this.apiOptions,
			method: assigned ? "POST" : "DELETE",
			body: { assignees: [login] },
		})
	}

	private async defaultBranchTree(): Promise<{ commitSha: string; treeSha: string }> {
		const repo = await ghApi(this.repoPath, this.apiOptions)
		const branch = (repo as { default_branch?: unknown } | undefined)?.default_branch
		if (typeof branch !== "string" || !branch || branch.includes("..")) {
			throw new Error("claim store: GitHub repository has no valid default branch")
		}
		const ref = await ghApi(`${this.repoPath}/git/ref/heads/${encodeURIComponent(branch)}`, this.apiOptions)
		const commitSha = objectSha(ref, "default branch ref")
		return { commitSha, treeSha: await this.treeForCommit(commitSha) }
	}
}

function claimRefPath(issue: number): string {
	return `heads/headlesscode-claims/issue-${issue}`
}

function validateIssue(issue: number): void {
	if (!Number.isSafeInteger(issue) || issue <= 0) throw new Error("claim store: issue must be a positive integer")
}

function isContention(error: unknown): boolean {
	return error instanceof GhApiError && (error.status === 409 || error.status === 422)
}

function objectSha(value: unknown, context: string): string {
	if (!value || typeof value !== "object") throw new Error(`${context}: malformed GitHub response`)
	const object = value as { object?: unknown; sha?: unknown }
	const objectShaValue = object.object && typeof object.object === "object" ? (object.object as { sha?: unknown }).sha : undefined
	const sha = object.sha ?? objectShaValue
	if (typeof sha !== "string" || !/^[a-f0-9]{40,64}$/.test(sha)) throw new Error(`${context}: malformed object SHA`)
	return sha
}

function nestedSha(value: unknown, key: string, context: string): string {
	if (!value || typeof value !== "object") throw new Error(`${context}: malformed GitHub response`)
	const nested = (value as Record<string, unknown>)[key]
	if (!nested || typeof nested !== "object") throw new Error(`${context}: missing ${key}`)
	const sha = (nested as { sha?: unknown }).sha
	if (typeof sha !== "string" || !/^[a-f0-9]{40,64}$/.test(sha)) throw new Error(`${context}: malformed object SHA`)
	return sha
}

function parseClaimRecord(commit: unknown, issue: number): RunnerClaim {
	if (!commit || typeof commit !== "object" || typeof (commit as { message?: unknown }).message !== "string") {
		throw new Error("claim store: claim ref does not point to a supported claim commit")
	}
	const message = (commit as { message: string }).message
	if (!message.startsWith(RECORD_PREFIX)) throw new Error("claim store: unsupported metadata at issue claim ref")
	let raw: unknown
	try { raw = JSON.parse(message.slice(RECORD_PREFIX.length)) } catch { throw new Error("claim store: malformed issue claim metadata") }
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("claim store: malformed issue claim metadata")
	const value = raw as Record<string, unknown>
	if (
		value.version !== 1 || value.issue !== issue || !Number.isSafeInteger(value.epoch) || Number(value.epoch) < 1 ||
		(value.phase !== "active" && value.phase !== "released") || (value.stage !== "reserved" && value.stage !== "running") ||
		typeof value.runnerId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value.runnerId) ||
		(value.runnerAssignee !== undefined && (typeof value.runnerAssignee !== "string" || !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(value.runnerAssignee))) ||
		typeof value.leaseNonce !== "string" || !/^[A-Za-z0-9-]{16,64}$/.test(value.leaseNonce) ||
		!Array.isArray(value.worktreeNames) || value.worktreeNames.length > 16 || value.worktreeNames.some((name) => typeof name !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name)) ||
		typeof value.updatedAt !== "string" || !Number.isFinite(Date.parse(value.updatedAt)) ||
		typeof value.leaseExpiresAt !== "string" || !Number.isFinite(Date.parse(value.leaseExpiresAt))
	) throw new Error("claim store: invalid issue claim metadata fields")
	if (value.phase === "released" && value.releaseReason !== "completed" && value.releaseReason !== "spawn-failed" && value.releaseReason !== "operator-recovered") {
		throw new Error("claim store: released claim has no valid teardown reason")
	}
	if (value.operatorRecovery !== undefined) {
		const recovery = value.operatorRecovery && typeof value.operatorRecovery === "object"
			? value.operatorRecovery as Record<string, unknown>
			: undefined
		if (!recovery || typeof recovery !== "object" ||
			typeof recovery.operator !== "string" || !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(recovery.operator) ||
			typeof recovery.evidence !== "string" || recovery.evidence.length < 12 || recovery.evidence.length > 1000 || /[\u0000-\u001f\u007f\u001b]/.test(recovery.evidence) ||
			typeof recovery.observedAt !== "string" || !Number.isFinite(Date.parse(recovery.observedAt)) ||
			typeof recovery.expectedTip !== "string" || !/^[a-f0-9]{40,64}$/.test(recovery.expectedTip) || value.releaseReason !== "operator-recovered" || value.phase !== "released") {
			throw new Error("claim store: invalid operator recovery evidence")
		}
	}
	if (value.releaseReason === "operator-recovered" && value.operatorRecovery === undefined) {
		throw new Error("claim store: operator-recovered claim is missing its audit evidence")
	}
	return value as unknown as RunnerClaim
}

function isTeardownProof(proof: ClaimTeardownProof): boolean {
	return !!proof && (proof.kind === "never-spawned" || proof.kind === "process-groups-absent") &&
		typeof proof.observedAt === "string" && Number.isFinite(Date.parse(proof.observedAt))
}

function validateSeed(seed: ClaimSeed): void {
	if (!seed || !Array.isArray(seed.worktreeNames) || seed.worktreeNames.length < 1 || seed.worktreeNames.length > 16 ||
		seed.worktreeNames.some((name) => typeof name !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name)) ||
		new Set(seed.worktreeNames).size !== seed.worktreeNames.length) {
		throw new Error("claim store: worktreeNames must be 1..16 unique safe names")
	}
}

function sameClaim(left: RunnerClaim, right: RunnerClaim): boolean {
	return JSON.stringify(left) === JSON.stringify(right)
}
