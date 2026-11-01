import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { constants } from "node:fs"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { pathToFileURL } from "node:url"
import {
	createRepositoryCampaignBudgetBinding,
} from "../repository-budget-binding.js"
import { RepositoryCampaignStore, type RepositoryBudgetAuthority,
	type RepositoryCampaignDefinition,
	type RepositoryCampaignJob } from "../repository-campaigns.js"
import { CampaignControlStore } from "../store.js"
import { requiredFleetTestRoot } from "./fleet-test-source.js"
import type { OpenRouterBrokerGrant, OpenRouterCallReservation,
	OpenRouterCallSettlement,
	OpenRouterBrokerLimits } from "../../rsi/inference-broker.js"
import type { FleetRepositoryBudgetScope }
	from "../../rsi/fleet-repository-budget-ledger.js"

export const MODEL = "meta/muse-spark-1.3-contributor"
export const PROFILE = "muse-spark-contributor"
export const fakeKey = "offline-repository-budget-fixture-key"
export const keyIdentity = createHash("sha256").update(fakeKey).digest("hex")
const sourceA = "1".repeat(40), sourceB = "2".repeat(40)
const policyA = "a".repeat(64), policyB = "b".repeat(64)

const fleetRoot = requiredFleetTestRoot()

export function authorityBridgeUrl(): string {
	return pathToFileURL(path.join(fleetRoot,
		"operations/campaign_budget_authority.py")).href
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

export const definitions: RepositoryCampaignDefinition[] = [
	{
		id: "repo-a",
		name: "Repository A",
		repositoryId: "fixture-a",
		repository: "Capsize-Games/fixture-a",
		sourceRevision: sourceA,
		policySha256: policyA,
		workerProfile: "fixture-worker",
		recipeDigest: "c".repeat(64),
		evaluatorDigest: "d".repeat(64),
		model: MODEL,
		dataAccessProfile: "fixture-data",
		qualification,
	},
	{
		id: "repo-b",
		name: "Repository B",
		repositoryId: "fixture-b",
		repository: "Capsize-Games/fixture-b",
		sourceRevision: sourceB,
		policySha256: policyB,
		workerProfile: "fixture-worker",
		recipeDigest: "e".repeat(64),
		evaluatorDigest: "f".repeat(64),
		model: MODEL,
		dataAccessProfile: "fixture-data",
		qualification,
	},
]

export function scope(
	id: "repo-a" | "repo-b",
	epoch = 1,
): FleetRepositoryBudgetScope {
	const revision = id === "repo-a" ? sourceA : sourceB
	const policy = id === "repo-a" ? policyA : policyB
	const repository = id === "repo-a" ? "fixture-a" : "fixture-b"
	return {
		repositoryCampaignId: id,
		repositoryId: repository,
		repository: `Capsize-Games/${repository}`,
		sourceRevision: revision,
		policySha256: policy,
		model: MODEL,
		profileId: PROFILE,
		repositoryEpoch: epoch,
	}
}

export function limits(
	maxJobSpendUsd = 0.01,
	maxTotalTokens = 10_000,
): OpenRouterBrokerLimits {
	return {
		campaignId: "fleet-security-watch",
		maxCalls: 3,
		maxInputTokensPerCall: 4_000,
		maxOutputTokensPerCall: 1_000,
		maxTotalTokens,
		maxDurationMs: 60_000,
		maxRequestBytes: 16_384,
		maxResponseBytes: 32_768,
		maxInputPricePerMillionUsd: 1,
		maxOutputPricePerMillionUsd: 2,
		maxCallSpendUsd: 0.01,
		maxJobSpendUsd,
		maxCampaignSpendUsd: 0.02,
	}
}

export function grant(
	jobId: string,
	maxJobSpendUsd = 0.01,
	maxTotalTokens = 10_000,
): OpenRouterBrokerGrant {
	return {
		jobId,
		leaseToken: "synthetic-lease",
		capability: "synthetic-capability",
		model: MODEL,
		profileId: PROFILE,
		apiKeyIdentity: keyIdentity,
		limits: limits(maxJobSpendUsd, maxTotalTokens),
	}
}

export function reservation(callId: string): OpenRouterCallReservation {
	return {
		callId,
		requestSha256: "9".repeat(64),
		reservedUsd: 0.01,
		reservedTokens: 5_000,
		startedAt: new Date().toISOString(),
	}
}

export function settlement(
	callId: string,
): OpenRouterCallSettlement & { callId: string } {
	return {
		callId,
		state: "complete",
		qualified: true,
		returnedModel: MODEL,
		returnedProvider: "meta",
		providerRequestId: "fixture-provider-receipt",
		promptTokens: 12,
		completionTokens: 7,
		costUsd: 0.0001,
		responseSha256: "8".repeat(64),
		completedAt: new Date().toISOString(),
	}
}

export function deferred<T>(): {
	promise: Promise<T>
	resolve(value: T): void
} {
	let resolve!: (value: T) => void
	const promise = new Promise<T>((done) => { resolve = done })
	return { promise, resolve }
}

export interface Fixture {
	root: string
	home: string
	store: RepositoryCampaignStore
	controlStore: CampaignControlStore
	claims: {
		"repo-a": NonNullable<
			Awaited<ReturnType<RepositoryCampaignStore["claimNext"]>>>
		"repo-b": NonNullable<
			Awaited<ReturnType<RepositoryCampaignStore["claimNext"]>>>
	}
	bindings: Record<"repo-a" | "repo-b",
		ReturnType<typeof createRepositoryCampaignBudgetBinding>>
	grants: Record<"repo-a" | "repo-b", OpenRouterBrokerGrant>
	setFault(value?: string): void
	setMonth(value?: string): void
	invoke(message: Record<string, unknown>): Promise<Record<string, unknown>>
	requestStartHandoff(message: Record<string, unknown>,
		onAdmitted: (reply: Record<string,
			unknown>) => void | Promise<void>): Promise<void>
	tryDispatchLock(): boolean
	crashNextHandoff(): void
	setControl(value: {
		globalEnabled?: boolean
		globalEpoch?: number
		repoAEnabled?: boolean
		repoAEpoch?: number
		repoBEnabled?: boolean
		repoBEpoch?: number
	}): Promise<void>
	cleanup(): Promise<void>
}

export type CampaignBudgetStatus = {
	budget: {
		ambiguousMicros: number
		settledMicros: number
		settledTokens: number
		reservedMicros: number
		authority: string
		available: boolean
		provisioningAvailable: boolean
	}
	campaigns: Array<{ enabled: boolean; readiness: string }>
	jobs: Array<RepositoryCampaignJob & {
		settledMicros: number
		settledTokens: number
	}>
}

export function readCampaignBudgetStatus(
	value: Record<string, unknown>,
): CampaignBudgetStatus {
	return value as unknown as CampaignBudgetStatus
}

export async function privateDir(directory: string): Promise<void> {
	await fs.mkdir(directory, { recursive: true, mode: 0o700 })
	await fs.chmod(directory, 0o700)
}

export interface BridgeFlags {
	fault?: string
	month?: string
	crashHandoff: boolean
}

export function bridgeBaseEnvironment(
	home: string,
): Record<string, string> {
	return {
		HOME: home,
		PATH: process.env.PATH ?? "/usr/bin:/bin",
		PYTHONPATH: fleetRoot,
		PYTHONNOUSERSITE: "1",
	}
}

