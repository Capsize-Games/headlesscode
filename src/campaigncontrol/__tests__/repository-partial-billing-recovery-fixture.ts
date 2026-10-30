import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import {
	reconcileClosedCurlQualificationBilling,
	type PartialBillingRecoveryDependencies,
} from "../repository-partial-billing-recovery.js"
import type { RepositoryCampaignJob } from "../repository-campaigns.js"
import {
	FleetRepositoryBudgetLedger,
	type FleetRepositoryClosedSessionProof,
} from "../../rsi/fleet-repository-budget-ledger.js"
import {
	claimId,
	definition,
	jobId,
	proof,
	scope,
} from "./repository-partial-billing-proof-fixture.js"

export type FixtureOptions = {
	activeRun?: boolean
	activeJobs?: boolean
	proof?: FleetRepositoryClosedSessionProof
	proofReads?: FleetRepositoryClosedSessionProof[]
	verifyFleetProofs?: boolean
}

export type TestFixture = {
	root: string
	dependencies: PartialBillingRecoveryDependencies
	proofCalls: () => number
	settlement: () => unknown
}
type RecoveryDependencies = PartialBillingRecoveryDependencies
type RecoveryView = {
	job: RepositoryCampaignJob
	activeJobs: RepositoryCampaignJob[]
}
type ProofReader = () => Promise<FleetRepositoryClosedSessionProof>
type DependencyInput = {
	root: string
	job: RepositoryCampaignJob
	options: FixtureOptions
	read: () => Promise<FleetRepositoryClosedSessionProof>
	state: SettlementState
	now: number
}
type FixtureInput = {
	root: string
	options: FixtureOptions
	proofCalls: number
	state: SettlementState
	now: number
}

type SettlementState = { value?: unknown }

function createProgress(now: number): Record<string, unknown> {
	return {
		executionKind: "live-cve", workerId: definition.workerProfile,
		goal: "fixed qualification", currentTask: "send requests",
		stage: "verify", completedSteps: ["intake"],
		requiredSteps: ["intake", "verify"],
		lastActionAt: now - 10_000, heartbeatAt: now - 10_000,
		leaseExpiresAt: now - 5_000, blocker: "provider-request-denied",
		nextStep: "review", evidenceRefs: [],
	}
}

function createJob(now: number): RepositoryCampaignJob {
	return {
		id: jobId, campaignId: definition.id, advisoryId: "CVE-2026-92390",
		purpose: "qualification", status: "ambiguous", claimId, epoch: 4,
		createdAt: now - 20_000, updatedAt: now - 10_000,
		month: new Date(now).toISOString().slice(0, 7),
		reservedMicros: 0, settledMicros: 8_000,
		reservedTokens: 0, settledTokens: 72_000,
		progress: createProgress(now),
	} as unknown as RepositoryCampaignJob
}

type TestLedger =
	| FleetRepositoryBudgetLedger
	| { proveClosedCurlQualificationSession: ProofReader }

function makeLedger(
	options: FixtureOptions,
	read: () => Promise<FleetRepositoryClosedSessionProof>,
): TestLedger {
	if (!options.verifyFleetProofs) {
		return { proveClosedCurlQualificationSession: read }
	}
	return new FleetRepositoryBudgetLedger({
		scope,
		expectedKeyIdentity: "a".repeat(64),
		invoke: async () => await read() as unknown as Record<string, unknown>,
	})
}

function makeStore(
	job: RepositoryCampaignJob,
	options: FixtureOptions,
	state: SettlementState,
): object {
	return {
		async recoveryView(): Promise<RecoveryView> {
			return {
				job: { ...job, progress: job.progress! },
				activeJobs: options.activeJobs ? [job] : [],
			}
		},
		async settleRecoveredClaim(...args: unknown[]): Promise<void> {
			state.value = args
		},
	}
}

function makeControlStore(options: FixtureOptions, now: number): object {
	return {
		async snapshot(): Promise<{ activeRun: unknown }> {
			const activeRun = options.activeRun
				? { id: "active", epoch: 2, startedAt: now, expiresAt: now + 60_000 }
				: null
			return { activeRun }
		},
	}
}

function makeDependencies(input: DependencyInput): RecoveryDependencies {
	const { root, job, options, read, state, now } = input
	return {
		store: makeStore(job, options, state) as never,
		controlStore: makeControlStore(options, now) as never,
		ledger: makeLedger(options, read) as never,
		definition,
		scope,
		expectedKeyIdentity: "a".repeat(64),
		storePath: path.join(root, "campaign-state.json"),
		worktreeRoot: path.join(root, "no-worktrees"),
		listRunningSandboxes: () => [],
		clock: () => now,
		withDispatchFence: runUnderFence,
	}
}

async function createTempStore(): Promise<string> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "hcl-partial-billing-"))
	await fs.chmod(root, 0o700)
	const storePath = path.join(root, "campaign-state.json")
	await fs.writeFile(storePath, "{}\n", { mode: 0o600 })
	return root
}

function makeProofReader(
	options: FixtureOptions,
	input: FixtureInput,
): ProofReader {
	return async () => {
		const result = options.proofReads?.[input.proofCalls] ??
			options.proof ?? proof
		input.proofCalls++
		return result
	}
}

async function runUnderFence<T>(operation: () => Promise<T>): Promise<T> {
	return operation()
}

export async function fixture(
	options: FixtureOptions = {},
): Promise<TestFixture> {
	const root = await createTempStore()
	const now = Date.now()
	const input: FixtureInput = { root, options, proofCalls: 0, state: {}, now }
	const job = createJob(now)
	const read = makeProofReader(options, input)
	const dependencies = makeDependencies({ ...input, job, read })
	return {
		root,
		dependencies,
		proofCalls: () => input.proofCalls,
		settlement: () => input.state.value,
	}
}

export async function cleanFixture(t: { after: (callback: () => void) => void },
	f: TestFixture): Promise<void> {
	t.after(() => fs.rm(f.root, { recursive: true, force: true }))
}

export async function runRecovery(f: TestFixture): Promise<void> {
	await reconcileClosedCurlQualificationBilling(
		jobId,
		`CONFIRM SETTLE PARTIAL QUALIFICATION ${jobId}`,
		f.dependencies,
	)
}

export async function assertPaidSettlement(
	f: TestFixture,
	expectedProofSha: string,
): Promise<void> {
	const args = f.settlement() as [unknown, Record<string, unknown>]
	assert.deepEqual(args[1], {
		status: "failed",
		actualMicros: 493,
		actualTokens: 6_064,
		proofSha256: args[1].proofSha256,
		proofKind: "billing-proof",
	})
	await assertStoredProof(f.root, expectedProofSha, args[1].proofSha256)
}

async function assertStoredProof(
	root: string,
	expectedProofSha: string,
	artifactSha: unknown,
): Promise<void> {
	const directory = path.join(root, "partial-billing-proofs")
	const files = await fs.readdir(directory)
	assert.equal(files.length, 1)
	const filename = path.join(directory, files[0]!)
	const bytes = await fs.readFile(filename)
	const record = JSON.parse(bytes.toString("utf8"))
	assert.equal(record.proof.proofSha256, expectedProofSha)
	assert.equal(artifactSha, createHash("sha256").update(bytes).digest("hex"))
}
