import {
	RepositoryCampaignStore,
	loadRepositoryCampaignDefinitions,
} from "./repository-campaigns.js"
import type {
	RepositoryCampaignDefinition,
} from "./repository-campaigns.js"
import {
	createRepositoryBudgetAuthorityReader,
} from "./repository-budget-authority.js"
import {
	bindRepositoryWorkerRegistrations,
	BUILTIN_REPOSITORY_PIPELINE_ADAPTER_FACTORIES,
	loadRepositoryWorkerRegistrations,
} from "./repository-worker-registry.js"
import {
	loadKnownCurlDebianAdvisory,
} from "./repository-known-advisory.js"
import {
	buildCurlHistoricalRepairCandidate,
	CURL_REPAIR_CAMPAIGN_ID,
	CURL_REPAIR_PROFILE_ID,
} from "./repository-curl-repair.js"
import {
	evaluateCurlHistoricalRepairCandidate,
} from "./repository-curl-repair-evaluator.js"
import { CURL_FIXED_ADVISORY } from "./repository-curl-evaluator.js"
import {
	CAMPAIGN_CONTROL_FILE,
	REPOSITORY_CAMPAIGN_REGISTRY_FILE,
	REPOSITORY_CAMPAIGN_STATE_FILE,
	REPOSITORY_WORKER_REGISTRY_FILE,
} from "./paths.js"

type Definitions = Awaited<ReturnType<typeof loadRepositoryCampaignDefinitions>>
type Context = {
	definitions: Definitions
	definition: RepositoryCampaignDefinition
	store: RepositoryCampaignStore
}
type Candidate = Awaited<ReturnType<typeof buildCurlHistoricalRepairCandidate>>
type Proof = Awaited<ReturnType<typeof evaluateCurlHistoricalRepairCandidate>>
type Advisory = Awaited<ReturnType<typeof loadKnownCurlDebianAdvisory>>
type Evidence = { advisory: Advisory; candidate: Candidate; proof: Proof }
type QueuedJob = { id: string; advisoryId: string }
type CampaignState = {
	campaigns: Array<Record<string, unknown>>
	jobs: Array<Record<string, unknown>>
}

function reportFailure(error: unknown): void {
	const fallback = "known repair could not be queued"
	const message = error instanceof Error ? error.message : fallback
	process.stderr.write(`headlesscode campaign: ${message}\n`)
}

function queuedReceipt(	evidence: Evidence, job: QueuedJob,
): Record<string, unknown> {
	const { candidate, proof } = evidence
	return {
		purpose: "repair", profileId: candidate.profileId,
		campaignId: CURL_REPAIR_CAMPAIGN_ID, jobId: job.id,
		advisoryId: job.advisoryId, sourceRevision: candidate.sourceRevision,
		candidateRevision: candidate.candidateRevision,
		candidateTreeSha: candidate.candidateTreeSha,
		patchSha256: candidate.patchSha256, scope: proof.scope,
		proofMode: proof.proofMode, state: "queued",
	}
}

function writeQueuedReceipt(	evidence: Evidence, job: QueuedJob,
): void {
	process.stdout.write(`${JSON.stringify(queuedReceipt(evidence, job))}\n`)
}

function createStore(definitions: Definitions): RepositoryCampaignStore {
	const authority = createRepositoryBudgetAuthorityReader(
		definitions, CAMPAIGN_CONTROL_FILE,
	)
	return new RepositoryCampaignStore(
		REPOSITORY_CAMPAIGN_STATE_FILE,
		definitions,
		authority,
	)
}

async function loadContext(): Promise<Context> {
	const definitions: Definitions = await loadRepositoryCampaignDefinitions(
		REPOSITORY_CAMPAIGN_REGISTRY_FILE,
	)
	const definition = definitions.find(
		(item) => item.id === CURL_REPAIR_CAMPAIGN_ID,
	)
	if (!definition) throw new Error(
		"known repair campaign is not owner-registered",
	)
	const store = createStore(definitions)
	await requireLiveWorker({ definitions, definition, store })
	return { definitions, definition, store }
}

function assertExactWorker(	profile: string | null | undefined, count: number,
): void {
	if (profile === CURL_REPAIR_PROFILE_ID && count === 1) return
	throw new Error("known repair requires its exact owner-registered live worker")
}

async function requireLiveWorker(context: Context): Promise<void> {
	const registrations = await loadRepositoryWorkerRegistrations(
		REPOSITORY_WORKER_REGISTRY_FILE,
	)
	const workers = bindRepositoryWorkerRegistrations(
		context.definitions,
		registrations,
		BUILTIN_REPOSITORY_PIPELINE_ADAPTER_FACTORIES,
		{ store: context.store },
	)
	const matches = workers.filter((worker) =>
		worker.workerProfile === context.definition.workerProfile &&
		worker.executionKind === "live-cve",
	)
	assertExactWorker(context.definition.workerProfile, matches.length)
}

async function buildEvidence(): Promise<Evidence> {
	const advisory = await loadKnownCurlDebianAdvisory()
	const candidate = await buildCurlHistoricalRepairCandidate()
	const proof = await evaluateCurlHistoricalRepairCandidate({
		candidate,
		jobId: "known-repair-preflight",
	})
	if (proof.disposition !== "historical-fix-qualified") {
		throw new Error(
			"known repair requires protected historical regression evidence",
		)
	}
	return { advisory, candidate, proof }
}

async function requireReady(context: Context): Promise<CampaignState> {
	const state = await context.store.status() as CampaignState
	const campaign = state.campaigns.find(
		(item) => item.id === CURL_REPAIR_CAMPAIGN_ID,
	)
	if (!campaign || campaign.enabled !== true || campaign.readiness !== "ready") {
		throw new Error(
			"known repair requires a started campaign with fresh registered " +
			"prerequisites",
		)
	}
	const exists = state.jobs.some((job) =>
		job.campaignId === CURL_REPAIR_CAMPAIGN_ID &&
		job.advisoryId === CURL_FIXED_ADVISORY && job.purpose === "repair",
	)
	if (exists) throw new Error("known advisory repair already has a job")
	return state
}

async function enqueueRepair(	context: Context, evidence: Evidence,
): Promise<void> {
	const advisory = evidence.advisory
	const job = await context.store.enqueueKnownRepair({
		campaignId: CURL_REPAIR_CAMPAIGN_ID,
		advisoryId: advisory.advisoryId,
		publicBaseRevision: advisory.publicBaseRevision,
		snapshotSha256: advisory.snapshotSha256,
		sourceUrl: advisory.sourceUrl,
		sourceContentSha256: advisory.sourceHtmlSha256,
		affectedRange: advisory.affectedRange,
	})
	writeQueuedReceipt(evidence, job)
}

export async function runRepairKnown(positional: string[]): Promise<number> {
	if (!validArguments(positional)) return 2
	try {
		const context = await loadContext()
		const evidence = await buildEvidence()
		await requireReady(context)
		await enqueueRepair(context, evidence)
		return 0
	} catch (error) {
		reportFailure(error)
		return 1
	}
}

function validArguments(positional: string[]): boolean {
	return positional.length === 3 && positional[0] === CURL_REPAIR_CAMPAIGN_ID &&
		positional[1] === CURL_FIXED_ADVISORY && positional[2] === "--purpose=repair"
}
