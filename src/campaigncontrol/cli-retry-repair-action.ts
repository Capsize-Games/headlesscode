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
	buildCurlHistoricalRepairCandidate,
	curlHistoricalRepairCandidateSha256,
	CURL_REPAIR_CAMPAIGN_ID,
	CURL_REPAIR_PROFILE_ID,
	verifyCurlHistoricalRepairSourcePin,
} from "./repository-curl-repair.js"
import {
	evaluateCurlHistoricalRepairCandidate,
} from "./repository-curl-repair-evaluator.js"
import {
	CAMPAIGN_CONTROL_FILE,
	REPOSITORY_CAMPAIGN_REGISTRY_FILE,
	REPOSITORY_CAMPAIGN_STATE_FILE,
} from "./paths.js"

type Definitions = Awaited<ReturnType<typeof loadRepositoryCampaignDefinitions>>
type AuthorityReader = ReturnType<typeof createRepositoryBudgetAuthorityReader>
type BudgetAuthority = Awaited<ReturnType<AuthorityReader>>
type Context = {
	definition: RepositoryCampaignDefinition
	store: RepositoryCampaignStore
	readAuthority: AuthorityReader
}
type Candidate = Awaited<ReturnType<typeof buildCurlHistoricalRepairCandidate>>
type Receipt = Awaited<ReturnType<typeof evaluateCurlHistoricalRepairCandidate>>
type RecoveryView = Awaited<ReturnType<RepositoryCampaignStore["recoveryView"]>>

function printFailure(error: unknown): void {
	const fallback = "historical Curl retry failed closed"
	const message = error instanceof Error ? error.message : fallback
	process.stderr.write(`headlesscode campaign: ${message}\n`)
}

function printReceipt(
	parentId: string,
	child: { id: string; status: string },
	evidence: string,
): void {
	process.stdout.write(`${JSON.stringify({
		retry: "verified-historical-curl-delivery",
		parentJobId: parentId,
		childJobId: child.id,
		jobId: child.id,
		evidenceSha256: evidence,
		state: child.status,
	})}\n`)
}

function createStore(	definitions: Definitions, reader: AuthorityReader,
): RepositoryCampaignStore {
	return new RepositoryCampaignStore(
		REPOSITORY_CAMPAIGN_STATE_FILE,
		definitions,
		reader,
	)
}

async function loadContext(): Promise<Context> {
	const definitions: Definitions = await loadRepositoryCampaignDefinitions(
		REPOSITORY_CAMPAIGN_REGISTRY_FILE,
	)
	const definition = definitions.find(
		(item) => item.id === CURL_REPAIR_CAMPAIGN_ID,
	)
	if (!definition || definition.workerProfile !== CURL_REPAIR_PROFILE_ID) {
		throw new Error(
			"historical Curl retry requires its exact owner-registered repair profile",
		)
	}
	const readAuthority = createRepositoryBudgetAuthorityReader(
		definitions,
		CAMPAIGN_CONTROL_FILE,
	)
	const store = createStore(definitions, readAuthority)
	return { definition, store, readAuthority }
}

function hasLiveClaimWindow(authority: BudgetAuthority): boolean {
	return authority.mode === "fleet-v2-budget-only" &&
		authority.available === false && authority.snapshotOnly === true &&
		!!authority.runId && Number.isSafeInteger(authority.runExpiresAtMs) &&
		authority.runExpiresAtMs! > Date.now()
}

function hasSnapshotProvisioning(authority: BudgetAuthority): boolean {
	return authority.mode === "fleet-v2-readonly" &&
		authority.available === false && authority.snapshotOnly === true &&
		authority.runId === null && authority.runExpiresAtMs === null
}

function matchesRepairScope(
	authority: BudgetAuthority,
	definition: RepositoryCampaignDefinition,
): boolean {
	return authority.repositoryCampaignId === definition.id &&
		authority.repositoryId === definition.repositoryId &&
		authority.repository === definition.repository &&
		authority.sourceRevision === definition.sourceRevision &&
		authority.policySha256 === definition.policySha256
}

function assertRetryAuthority(
	authority: BudgetAuthority,
	definition: RepositoryCampaignDefinition,
): void {
	const window = hasLiveClaimWindow(authority) ||
		hasSnapshotProvisioning(authority)
	const noModel = authority.model === "none" &&
		authority.profileId === "no-model"
	const enabled = authority.globalEnabled === true &&
		authority.canAdmit === true &&
		authority.repositoryEnabled === true
	if (!(window && noModel && enabled &&
		matchesRepairScope(authority, definition))) {
		throw new Error(
			"fresh enabled Fleet Curl budget provisioning authority is unavailable",
		)
	}
}

async function loadRetryTarget(	context: Context, jobId: string,
): Promise<RecoveryView> {
	await verifyCurlHistoricalRepairSourcePin()
	const view = await context.store.recoveryView(jobId)
	if (!view.job || view.activeJobs.length) {
		throw new Error("retry target is unavailable or another Curl job is active")
	}
	return view
}

async function buildRetryEvidence(
	jobId: string,
): Promise<{ candidate: Candidate; receipt: Receipt }> {
	const candidate = await buildCurlHistoricalRepairCandidate()
	const receipt = await evaluateCurlHistoricalRepairCandidate({
		candidate,
		jobId,
	})
	if (receipt.disposition !== "historical-fix-qualified") {
		throw new Error(
			"historical Curl retry requires protected regression evidence",
		)
	}
	return { candidate, receipt }
}

async function enqueueRetry(
	context: Context,
	view: RecoveryView,
	candidate: Candidate,
	receipt: Receipt,
): Promise<void> {
	const parent = view.job!
	const child = await context.store.enqueueVerifiedHistoricalRepairRetry(
		parent.id,
		`CONFIRM RETRY HISTORICAL CURL DELIVERY ${parent.id}`,
		{
			candidateSha256: curlHistoricalRepairCandidateSha256(candidate),
			verificationSha256: receipt.evidenceSha256,
		},
	)
	printReceipt(parent.id, child, receipt.evidenceSha256)
}

function validArguments(positional: string[]): boolean {
	const id = positional[1]
	const uuid = new RegExp(
		"^([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-" +
		"[89ab][0-9a-f]{3}-[0-9a-f]{12})$", "i",
	)
	return positional.length === 3 && positional[0] === CURL_REPAIR_CAMPAIGN_ID &&
		!!id && uuid.test(id) && positional[2] === `--confirm-retry-repair=${id}`
}

export async function runRetryRepair(positional: string[]): Promise<number> {
	if (!validArguments(positional)) return 2
	try {
		const context = await loadContext()
		const authority = await context.readAuthority(CURL_REPAIR_CAMPAIGN_ID)
		assertRetryAuthority(authority, context.definition)
		const view = await loadRetryTarget(context, positional[1]!)
		const evidence = await buildRetryEvidence(view.job!.id)
		await enqueueRetry(context, view, evidence.candidate, evidence.receipt)
		return 0
	} catch (error) {
		printFailure(error)
		return 1
	}
}
