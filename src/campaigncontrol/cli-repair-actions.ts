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
		if (positional.length !== 3 || positional[0] !== CURL_REPAIR_CAMPAIGN_ID || positional[1] !== CURL_FIXED_ADVISORY || positional[2] !== "--purpose=repair") return 2
		try {
			const definitions = await loadRepositoryCampaignDefinitions(REPOSITORY_CAMPAIGN_REGISTRY_FILE)
			const definition = definitions.find((item) => item.id === CURL_REPAIR_CAMPAIGN_ID)
			if (!definition) throw new Error("known repair campaign is not owner-registered")
			const readAuthority = createRepositoryBudgetAuthorityReader(definitions, CAMPAIGN_CONTROL_FILE)
			const repositoryStore = new RepositoryCampaignStore(REPOSITORY_CAMPAIGN_STATE_FILE, definitions, readAuthority)
			const registrations = await loadRepositoryWorkerRegistrations(REPOSITORY_WORKER_REGISTRY_FILE)
			const workers = bindRepositoryWorkerRegistrations(definitions, registrations, BUILTIN_REPOSITORY_PIPELINE_ADAPTER_FACTORIES, { store: repositoryStore })
			if (definition.workerProfile !== CURL_REPAIR_PROFILE_ID || workers.filter((worker) => worker.workerProfile === definition.workerProfile && worker.executionKind === "live-cve").length !== 1) {
				throw new Error("known repair requires its exact owner-registered live worker")
			}
			const advisory = await loadKnownCurlDebianAdvisory()
			const candidate = await buildCurlHistoricalRepairCandidate()
			const proof = await evaluateCurlHistoricalRepairCandidate({ candidate, jobId: "known-repair-preflight" })
			if (proof.disposition !== "historical-fix-qualified") throw new Error("known repair requires protected historical regression evidence")
			const state = await repositoryStore.status() as { campaigns: Array<Record<string, unknown>>; jobs: Array<Record<string, unknown>> }
			const campaign = state.campaigns.find((item) => item.id === CURL_REPAIR_CAMPAIGN_ID)
			if (!campaign || campaign.enabled !== true || campaign.readiness !== "ready") throw new Error("known repair requires a started campaign with fresh registered prerequisites")
			if (state.jobs.some((job) => job.campaignId === CURL_REPAIR_CAMPAIGN_ID && job.advisoryId === CURL_FIXED_ADVISORY && job.purpose === "repair")) {
				throw new Error("known advisory repair already has a job")
			}
			const job = await repositoryStore.enqueueKnownRepair({ campaignId: CURL_REPAIR_CAMPAIGN_ID, advisoryId: advisory.advisoryId,
				publicBaseRevision: advisory.publicBaseRevision, snapshotSha256: advisory.snapshotSha256,
				sourceUrl: advisory.sourceUrl, sourceContentSha256: advisory.sourceHtmlSha256, affectedRange: advisory.affectedRange })
			process.stdout.write(`${JSON.stringify({ purpose: "repair", profileId: candidate.profileId, campaignId: CURL_REPAIR_CAMPAIGN_ID,
				jobId: job.id, advisoryId: job.advisoryId, sourceRevision: candidate.sourceRevision,
				candidateRevision: candidate.candidateRevision, candidateTreeSha: candidate.candidateTreeSha,
				patchSha256: candidate.patchSha256, scope: proof.scope, proofMode: proof.proofMode, state: "queued" })}\n`)
			return 0
		} catch (error) {
			process.stderr.write(`headlesscode campaign: ${error instanceof Error ? error.message : "known repair could not be queued"}\n`)
			return 1
		}
	}
	if (action === "repair-known-v2") {
		const v2 = await import("./cli-repair-v2-action.js")
		return v2.runRepairKnownV2(positional)
	}
	if (action === "retry-repair") {
		if (positional.length !== 3 || positional[0] !== CURL_REPAIR_CAMPAIGN_ID ||
			!/^([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i.test(positional[1]!) ||
			positional[2] !== `--confirm-retry-repair=${positional[1]}`) return 2
		try {
			const definitions = await loadRepositoryCampaignDefinitions(REPOSITORY_CAMPAIGN_REGISTRY_FILE)
			const definition = definitions.find((item) => item.id === CURL_REPAIR_CAMPAIGN_ID)
			if (!definition || definition.workerProfile !== CURL_REPAIR_PROFILE_ID) throw new Error("historical Curl retry requires its exact owner-registered repair profile")
			const readAuthority = createRepositoryBudgetAuthorityReader(definitions, CAMPAIGN_CONTROL_FILE)
			const repositoryStore = new RepositoryCampaignStore(REPOSITORY_CAMPAIGN_STATE_FILE, definitions, readAuthority)
			const authority = await readAuthority(CURL_REPAIR_CAMPAIGN_ID)
			const liveClaimWindow = authority.mode === "fleet-v2-budget-only" && authority.available === false && authority.snapshotOnly === true &&
				!!authority.runId && Number.isSafeInteger(authority.runExpiresAtMs) && authority.runExpiresAtMs! > Date.now()
			const snapshotProvisioning = authority.mode === "fleet-v2-readonly" && authority.available === false && authority.snapshotOnly === true &&
				authority.runId === null && authority.runExpiresAtMs === null
			if (!((liveClaimWindow || snapshotProvisioning) && authority.model === "none" && authority.profileId === "no-model" && authority.repositoryCampaignId === definition.id &&
				authority.repositoryId === definition.repositoryId && authority.repository === definition.repository &&
				authority.sourceRevision === definition.sourceRevision && authority.policySha256 === definition.policySha256 &&
				authority.globalEnabled === true && authority.canAdmit === true && authority.repositoryEnabled === true)) {
				throw new Error("fresh enabled Fleet Curl budget provisioning authority is unavailable")
			}
			await verifyCurlHistoricalRepairSourcePin()
			const view = await repositoryStore.recoveryView(positional[1]!)
			if (!view.job || view.activeJobs.length) throw new Error("retry target is unavailable or another Curl job is active")
			const candidate = await buildCurlHistoricalRepairCandidate()
			const receipt = await evaluateCurlHistoricalRepairCandidate({ candidate, jobId: view.job.id })
			if (receipt.disposition !== "historical-fix-qualified") throw new Error("historical Curl retry requires protected regression evidence")
			const child = await repositoryStore.enqueueVerifiedHistoricalRepairRetry(view.job.id,
				`CONFIRM RETRY HISTORICAL CURL DELIVERY ${view.job.id}`, {
					candidateSha256: curlHistoricalRepairCandidateSha256(candidate), verificationSha256: receipt.evidenceSha256,
				})
			process.stdout.write(`${JSON.stringify({ retry: "verified-historical-curl-delivery", parentJobId: view.job.id,
				childJobId: child.id, jobId: child.id, evidenceSha256: receipt.evidenceSha256, state: child.status })}\n`)
			return 0
		} catch (error) {
			process.stderr.write(`headlesscode campaign: ${error instanceof Error ? error.message : "historical Curl retry failed closed"}\n`)
			return 1
		}
	}
	return undefined
}
