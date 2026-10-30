import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import type { ActiveCampaignRun } from "../store.js"
import {
	RepositoryCampaignStore, type RepositoryBudgetAuthority,
	type RepositoryCampaignDefinition, type RepositoryCampaignJob,
	type RepositoryAdvisoryIntakeRecord,
} from "../repository-campaigns.js"

export function digest(char: string): string {
	return char.repeat(64)
}

export const qualification = {
	sourceAudited: true,
	workerQualified: true,
	recipeQualified: true,
	evaluatorQualified: true,
	modelApproved: true,
	dataApproved: true,
	accessApproved: true,
}

export const definition: RepositoryCampaignDefinition = {
	id: "fixture-repo",
	name: "Offline Fixture",
	repositoryId: "fixture-repo",
	repository: "Capsize/Fixture",
	sourceRevision: "a".repeat(40),
	policySha256: digest("9"),
	workerProfile: "fixture-profile",
	recipeDigest: digest("b"),
	evaluatorDigest: digest("c"),
	model: "fixture-model",
	dataAccessProfile: "fixture-data",
	qualification,
}

export type CoordinatorStatusSnapshot = {
	jobs: RepositoryCampaignJob[]
	intakeRecords: RepositoryAdvisoryIntakeRecord[]
}

export function readStatus(
	value: Record<string, unknown>,
): CoordinatorStatusSnapshot {
	return value as unknown as CoordinatorStatusSnapshot
}

export const emptyLifetime = {
	settledMicros: 0,
	reservedMicros: 0,
	ambiguousMicros: 0,
	settledTokens: 0,
	reservedTokens: 0,
	ambiguousTokens: 0,
}

export const monthlyBudget = {
	month: new Date().toISOString().slice(0, 7),
	limitMicros: 5_000_000,
	settledMicros: 0,
	reservedMicros: 0,
	ambiguousMicros: 0,
}

export const campaignLifetimeBudget = {
	limitMicros: 20_000,
	limitTokens: 108_000,
	...emptyLifetime,
}

export function syntheticAuthority(): RepositoryBudgetAuthority {
	return {
		mode: "synthetic-test",
		available: true,
		limitMicros: 100_000,
		limitTokens: 100_000,
		committedMicros: 0,
		committedTokens: 0,
	}
}

function liveRunScope(run: ActiveCampaignRun): {
	controlEpoch: number
	runId: string
	runExpiresAtMs: number
} {
	return {
		controlEpoch: run.epoch,
		runId: run.id,
		runExpiresAtMs: run.expiresAt,
	}
}

function liveRepositoryScope(): {
	repositoryCampaignId: string
	repositoryId: string
	repository: string
	sourceRevision: string
	policySha256: string
	model: string
} {
	return {
		repositoryCampaignId: definition.id,
		repositoryId: definition.repositoryId!,
		repository: definition.repository!,
		sourceRevision: definition.sourceRevision!,
		policySha256: definition.policySha256!,
		model: definition.model!,
	}
}

function liveLifetime(): {
	monthly: typeof monthlyBudget
	campaignLifetime: typeof campaignLifetimeBudget
	legacyLifetime: typeof emptyLifetime
} {
	return {
		monthly: monthlyBudget,
		campaignLifetime: campaignLifetimeBudget,
		legacyLifetime: emptyLifetime,
	}
}

export function liveAuthority(
	run: ActiveCampaignRun,
): RepositoryBudgetAuthority {
	return {
		mode: "fleet-v2" as const, available: true,
		limitMicros: 20_000, limitTokens: 108_000,
		committedMicros: 0, committedTokens: 0, asOfMs: Date.now(),
		campaignId: "fleet-security-watch", globalEnabled: true,
		canAdmit: true, profileId: "fixture-profile",
		repositoryEnabled: true, repositoryEpoch: 1,
		...liveRunScope(run), ...liveRepositoryScope(), ...liveLifetime(),
		repositoryLifetime: {
			limitMicros: 20_000, limitTokens: 20_000,
			...emptyLifetime,
		},
	}
}

export async function waitForTerminal(
	store: RepositoryCampaignStore,
	advisoryId?: string,
): Promise<RepositoryCampaignJob> {
	for (let i = 0; i < 300; i++) {
		const jobs = readStatus(await store.status()).jobs
		const job = advisoryId ?
			jobs.find((item) => item.advisoryId === advisoryId) :
			jobs[0]
		if (job && job.status !== "queued" && job.status !== "running") {
			return job
		}
		await new Promise<void>((resolve) => setTimeout(resolve, 10))
	}
	throw new Error("repository worker did not reach a terminal state")
}

export async function fixtureRoot(prefix: string): Promise<string> {
	return fs.mkdtemp(path.join(os.tmpdir(), prefix))
}

export async function removeRoot(root: string): Promise<void> {
	await fs.rm(root, { recursive: true, force: true })
}

export interface Gate {
	promise: Promise<void>
	resolve(): void
}

export function gate(): Gate {
	let resolve!: () => void
	const promise = new Promise<void>((done) => { resolve = done })
	return { promise, resolve }
}

export async function openBudgetedStore(
	root: string,
	authority: () => RepositoryBudgetAuthority,
	micros: number,
	tokens: number,
): Promise<RepositoryCampaignStore> {
	const store = new RepositoryCampaignStore(
		path.join(root, "state.json"), [definition], authority)
	await store.setCampaignBudget(definition.id, micros, tokens)
	await store.start(definition.id)
	return store
}

export async function awaitLeaseFinish(events: string[]): Promise<void> {
	for (let i = 0; i < 20 && !events.includes("finish:succeeded"); i++) {
		await new Promise<void>((resolve) => setTimeout(resolve, 10))
	}
}

export async function openEnqueuedStore(
	root: string,
	authority: () => RepositoryBudgetAuthority,
	advisoryId: string,
	micros: number,
	tokens: number,
): Promise<RepositoryCampaignStore> {
	const store = await openBudgetedStore(root, authority, micros, tokens)
	await store.enqueue(definition.id, advisoryId)
	return store
}
