import { campaignUsage, isCampaignAction } from "./campaign-usage.js"
import * as fs from "node:fs"
import { CampaignControlStore, MAX_MONTHLY_BUDGET_MICROS } from "./store.js"
import { loadCampaignAdapterConfig, readCampaignBudgetReport, runCampaignTick, runFleetAdapterUnderLock, verifyCampaignDispatchLock } from "./runner.js"
import { mutateCampaignControlLocked } from "./authority.js"
import { CAMPAIGN_ADAPTER_FILE, CAMPAIGN_CONTROL_FILE, REPOSITORY_CAMPAIGN_REGISTRY_FILE, REPOSITORY_CAMPAIGN_STATE_FILE, REPOSITORY_WORKER_REGISTRY_FILE } from "./paths.js"
import { readCampaignRsiStatus } from "./rsi.js"
import * as os from "node:os"
import * as path from "node:path"
import { RepositoryCampaignStore, loadRepositoryCampaignDefinitions } from "./repository-campaigns.js"
import { createRepositoryBudgetAuthorityReader } from "./repository-budget-authority.js"
import { bindRepositoryWorkerRegistrations, BUILTIN_REPOSITORY_PIPELINE_ADAPTER_FACTORIES, loadRepositoryWorkerRegistrations } from "./repository-worker-registry.js"
import { loadKnownCurlDebianAdvisory } from "./repository-known-advisory.js"
import { CURL_CAMPAIGN_ID, CURL_CANDIDATE_TREE_SHA, CURL_FIXED_ADVISORY, CURL_PRIVATE_SOURCE_REVISION,
	evaluatePinnedCurlCandidate, makeCurlProtectedEvaluationRequest } from "./repository-curl-evaluator.js"
import { buildCurlHistoricalRepairCandidate, curlHistoricalRepairCandidateSha256,
	CURL_REPAIR_CAMPAIGN_ID, CURL_REPAIR_PROFILE_ID, verifyCurlHistoricalRepairSourcePin } from "./repository-curl-repair.js"
import { evaluateCurlHistoricalRepairCandidate } from "./repository-curl-repair-evaluator.js"
import { readFleetBudgetKeyIdentity } from "../rsi/fleet-budget-ledger.js"
import { FleetRepositoryBudgetLedger } from "../rsi/fleet-repository-budget-ledger.js"
import { recoverAmbiguousPrepareWithNoCallProof, verifyRecoveredNoCallArtifact } from "./repository-no-call-recovery.js"
import { reconcileClosedCurlQualificationBilling } from "./repository-partial-billing-recovery.js"

export async function handleAction(action: string, positional: string[]): Promise<number | undefined> {
	if (action === "qualify-known") {
		if (positional.length !== 3 || positional[0] !== CURL_CAMPAIGN_ID || positional[1] !== CURL_FIXED_ADVISORY || positional[2] !== "--purpose=qualification") return 2
		try {
		const definitions = await loadRepositoryCampaignDefinitions(REPOSITORY_CAMPAIGN_REGISTRY_FILE)
		const definition = definitions.find((item) => item.id === CURL_CAMPAIGN_ID)
		if (!definition) throw new Error("known qualification campaign is not owner-registered")
		const readAuthority = createRepositoryBudgetAuthorityReader(definitions, CAMPAIGN_CONTROL_FILE)
		const repositoryStore = new RepositoryCampaignStore(REPOSITORY_CAMPAIGN_STATE_FILE, definitions, readAuthority)
		const registrations = await loadRepositoryWorkerRegistrations(REPOSITORY_WORKER_REGISTRY_FILE)
		const workers = bindRepositoryWorkerRegistrations(definitions, registrations, BUILTIN_REPOSITORY_PIPELINE_ADAPTER_FACTORIES, { store: repositoryStore })
		if (workers.filter((worker) => worker.workerProfile === definition.workerProfile && worker.executionKind === "live-cve").length !== 1) {
			throw new Error("known qualification requires its exact owner-registered live worker")
		}
		const advisory = await loadKnownCurlDebianAdvisory()
		const fixedProof = await evaluatePinnedCurlCandidate(makeCurlProtectedEvaluationRequest({ campaignId: CURL_CAMPAIGN_ID,
			jobId: "known-qualification-preflight", advisoryId: CURL_FIXED_ADVISORY,
			candidateRevision: CURL_PRIVATE_SOURCE_REVISION, candidateTreeSha: CURL_CANDIDATE_TREE_SHA }))
		if (!fixedProof.accepted || fixedProof.disposition !== "already-fixed" || fixedProof.reasonCode !== "fixed-proof-verified") {
			throw new Error("known qualification requires the pinned already-fixed proof")
		}
		const state = await repositoryStore.status() as { campaigns: Array<Record<string, unknown>>; jobs: Array<Record<string, unknown>> }
		const campaign = state.campaigns.find((item) => item.id === CURL_CAMPAIGN_ID)
		if (!campaign || campaign.enabled !== true || campaign.readiness !== "ready") throw new Error("known qualification requires a started campaign with fresh registered prerequisites")
		if (state.jobs.some((job) => job.campaignId === CURL_CAMPAIGN_ID && job.advisoryId === CURL_FIXED_ADVISORY)) {
			throw new Error("known advisory qualification already has a job")
		}
		const job = await repositoryStore.enqueueKnownQualification({ campaignId: CURL_CAMPAIGN_ID, advisoryId: advisory.advisoryId,
			publicBaseRevision: advisory.publicBaseRevision, snapshotSha256: advisory.snapshotSha256, sourceUrl: advisory.sourceUrl,
			sourceContentSha256: advisory.sourceHtmlSha256, affectedRange: advisory.affectedRange })
		process.stdout.write(`${JSON.stringify({ purpose: "qualification", campaignId: CURL_CAMPAIGN_ID, jobId: job.id,
			advisoryId: job.advisoryId, source: "debian-tracker-snapshot", snapshotSha256: advisory.snapshotSha256,
			sourceHtmlSha256: advisory.sourceHtmlSha256, sourceUrl: advisory.sourceUrl, state: "queued" })}\n`)
		return 0
		} catch (error) {
			process.stderr.write(`headlesscode campaign: ${error instanceof Error ? error.message : "known qualification could not be queued"}\n`)
			return 1
		}
	}
	if (action === "repair-known") {
		const repair = await import("./cli-repair-action.js")
		return repair.runRepairKnown(positional)
	}
	if (action === "repair-known-v2") {
		const v2 = await import("./cli-repair-v2-action.js")
		return v2.runRepairKnownV2(positional)
	}
	if (action === "retry-repair") {
		const retry = await import("./cli-retry-repair-action.js")
		return retry.runRetryRepair(positional)
	}
	return undefined
}
