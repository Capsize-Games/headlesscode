import {
	RepositoryCampaignStore,
	loadRepositoryCampaignDefinitions,
} from "./repository-campaigns.js"
import {
	createRepositoryBudgetAuthorityReader,
} from "./repository-budget-authority.js"
import {
	loadRepositoryWorkerRegistrations,
} from "./repository-worker-registry.js"
import {
	loadKnownCurlDebianAdvisory,
} from "./repository-known-advisory.js"
import {
	buildCurlHistoricalRepairCandidate,
	verifyCurlHistoricalRepairSourcePin,
} from "./repository-curl-repair.js"
import {
	CURL_REPAIR_V2_CAMPAIGN_ID,
} from "./repository-campaign-ids.js"
import {
	CURL_REPAIR_V2_PROFILE_ID,
	CURL_REPAIR_V2_ADAPTER_ID,
} from "./repository-curl-repair-v2-profile.js"
import {
	CAMPAIGN_CONTROL_FILE,
	REPOSITORY_CAMPAIGN_REGISTRY_FILE,
	REPOSITORY_CAMPAIGN_STATE_FILE,
	REPOSITORY_WORKER_REGISTRY_FILE,
} from "./paths.js"

type Definitions = Awaited<ReturnType<typeof loadRepositoryCampaignDefinitions>>
type Definition = Definitions[number]
type Context = { definition: Definition; store: RepositoryCampaignStore }
type Candidate = Awaited<ReturnType<typeof buildCurlHistoricalRepairCandidate>>
type JobReceipt = { id: string; advisoryId: string }
type State = {
	campaigns: Array<Record<string, unknown>>
	jobs: Array<Record<string, unknown>>
}

function printJson(value: unknown): void {
	process.stdout.write(`${JSON.stringify(value)}\n`)
}

function printFailure(error: unknown): void {
	const fallback = "v2 known repair could not be queued"
	const message = error instanceof Error ? error.message : fallback
	process.stderr.write(`headlesscode campaign: ${message}\n`)
}

async function assertAdapterRegistered(): Promise<void> {
	const registrations = await loadRepositoryWorkerRegistrations(
		REPOSITORY_WORKER_REGISTRY_FILE,
	)
	const found = registrations.some((row) =>
		row.campaignId === CURL_REPAIR_V2_CAMPAIGN_ID &&
		row.pipelineAdapterId === CURL_REPAIR_V2_ADAPTER_ID)
	if (!found) throw new Error("v2 repair adapter is not owner-registered")
}

async function loadContext(): Promise<Context> {
	const definitions = await loadRepositoryCampaignDefinitions(
		REPOSITORY_CAMPAIGN_REGISTRY_FILE,
	)
	const definition = definitions.find(
		(item) => item.id === CURL_REPAIR_V2_CAMPAIGN_ID,
	)
	if (!definition || definition.workerProfile !== CURL_REPAIR_V2_PROFILE_ID) {
		throw new Error("v2 repair profile is not owner-registered")
	}
	await assertAdapterRegistered()
	const authority = createRepositoryBudgetAuthorityReader(
		definitions, CAMPAIGN_CONTROL_FILE,
	)
	const store = new RepositoryCampaignStore(
		REPOSITORY_CAMPAIGN_STATE_FILE, definitions, authority,
	)
	return { definition, store }
}

async function requireReady(context: Context): Promise<State> {
	const state = await context.store.status() as State
	const campaign = state.campaigns.find(
		(item) => item.id === CURL_REPAIR_V2_CAMPAIGN_ID,
	)
	if (!campaign || campaign.enabled !== true || campaign.readiness !== "ready") {
		throw new Error("v2 repair requires fresh registered prerequisites")
	}
	const exists = state.jobs.some((job) =>
		job.campaignId === CURL_REPAIR_V2_CAMPAIGN_ID &&
		job.purpose === "repair")
	if (exists) throw new Error("the v2 known advisory repair already has a job")
	return state
}

function printReceipt(candidate: Candidate, job: JobReceipt): void {
	printJson({ purpose: "repair", profileId: CURL_REPAIR_V2_PROFILE_ID,
		campaignId: CURL_REPAIR_V2_CAMPAIGN_ID, jobId: job.id,
		advisoryId: job.advisoryId, sourceRevision: candidate.sourceRevision,
		candidateRevision: candidate.candidateRevision,
		candidateTreeSha: candidate.candidateTreeSha,
		patchSha256: candidate.patchSha256, state: "queued" })
}

async function enqueueRepair(context: Context): Promise<void> {
	const advisory = await loadKnownCurlDebianAdvisory()
	await verifyCurlHistoricalRepairSourcePin()
	const candidate = await buildCurlHistoricalRepairCandidate()
	const job = await context.store.enqueueKnownRepairV2({
		campaignId: CURL_REPAIR_V2_CAMPAIGN_ID,
		advisoryId: advisory.advisoryId,
		publicBaseRevision: advisory.publicBaseRevision,
		snapshotSha256: advisory.snapshotSha256,
		sourceUrl: advisory.sourceUrl,
		sourceContentSha256: advisory.sourceHtmlSha256,
		affectedRange: advisory.affectedRange,
	})
	printReceipt(candidate, job)
}

export async function runRepairKnownV2(positional: string[]): Promise<number> {
	if (positional.length !== 3 || positional[0] !== CURL_REPAIR_V2_CAMPAIGN_ID ||
		positional[1] !== "CVE-2026-92390" ||
		positional[2] !== "--purpose=repair") return 2
	try {
		const context = await loadContext()
		await requireReady(context)
		await enqueueRepair(context)
		return 0
	} catch (error) {
		printFailure(error)
		return 1
	}
}
