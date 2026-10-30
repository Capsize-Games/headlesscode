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
import { CURL_REPAIR_V2_CAMPAIGN_ID } from "./repository-campaign-ids.js"
import { CURL_REPAIR_V2_PROFILE_ID, CURL_REPAIR_V2_ADAPTER_ID } from "./repository-curl-repair-v2-profile.js"
import { readFleetBudgetKeyIdentity } from "../rsi/fleet-budget-ledger.js"
import { FleetRepositoryBudgetLedger } from "../rsi/fleet-repository-budget-ledger.js"
import { recoverAmbiguousPrepareWithNoCallProof, verifyRecoveredNoCallArtifact } from "./repository-no-call-recovery.js"
import { reconcileClosedCurlQualificationBilling } from "./repository-partial-billing-recovery.js"

export async function handleAction(action: string, positional: string[]): Promise<number | undefined> {
	if (action === "recover-no-call") {
		if (positional.length !== 3 || positional[0] !== CURL_CAMPAIGN_ID ||
			!/^([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i.test(positional[1]!) ||
			positional[2] !== `--confirm-no-call-proof=${positional[1]}`) return 2
		try {
			const definitions = await loadRepositoryCampaignDefinitions(REPOSITORY_CAMPAIGN_REGISTRY_FILE)
			const definition = definitions.find((item) => item.id === CURL_CAMPAIGN_ID)
			if (!definition) throw new Error("no-call recovery requires the owner-registered Curl qualification")
			const readAuthority = createRepositoryBudgetAuthorityReader(definitions, CAMPAIGN_CONTROL_FILE)
			const authority = await readAuthority(CURL_CAMPAIGN_ID)
			if (!((authority.mode === "fleet-v2" || authority.mode === "fleet-v2-readonly") &&
				authority.repositoryCampaignId === definition.id && authority.repositoryId === definition.repositoryId &&
				authority.repository === definition.repository && authority.sourceRevision === definition.sourceRevision &&
				authority.policySha256 === definition.policySha256 && authority.model === definition.model &&
				authority.profileId === "muse-spark-contributor" && Number.isSafeInteger(authority.repositoryEpoch))) {
				throw new Error("fresh Fleet Curl scope is unavailable for no-call recovery")
			}
			const scope = { repositoryCampaignId: definition.id, repositoryId: definition.repositoryId!, repository: definition.repository!,
				sourceRevision: definition.sourceRevision!, policySha256: definition.policySha256!, model: definition.model as "meta/muse-spark-1.3-contributor",
				profileId: "muse-spark-contributor" as const, repositoryEpoch: authority.repositoryEpoch! }
			const expectedKeyIdentity = await readFleetBudgetKeyIdentity()
			const ledger = new FleetRepositoryBudgetLedger({ expectedKeyIdentity, scope })
			const repositoryStore = new RepositoryCampaignStore(REPOSITORY_CAMPAIGN_STATE_FILE, definitions, readAuthority)
			const result = await recoverAmbiguousPrepareWithNoCallProof(positional[1]!, `CONFIRM RECOVER NO-CALL ${positional[1]}`, {
				store: repositoryStore, controlStore: new CampaignControlStore(CAMPAIGN_CONTROL_FILE), ledger, definition, scope,
				expectedKeyIdentity, storePath: REPOSITORY_CAMPAIGN_STATE_FILE,
			})
			process.stdout.write(`${JSON.stringify({ recovery: "no-call-proof", ...result })}\n`)
			return 0
		} catch (error) {
			process.stderr.write(`headlesscode campaign: ${error instanceof Error ? error.message : "no-call recovery failed closed"}\n`)
			return 1
		}
	}
	if (action === "reconcile-paid-qualification") {
		if (positional.length !== 3 || positional[0] !== CURL_CAMPAIGN_ID ||
			!/^([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i.test(positional[1]!) ||
			positional[2] !== `--confirm-partial-billing=${positional[1]}`) return 2
		try {
			const definitions = await loadRepositoryCampaignDefinitions(REPOSITORY_CAMPAIGN_REGISTRY_FILE)
			const definition = definitions.find((item) => item.id === CURL_CAMPAIGN_ID)
			if (!definition) throw new Error("billing reconciliation requires the owner-registered Curl qualification")
			const readAuthority = createRepositoryBudgetAuthorityReader(definitions, CAMPAIGN_CONTROL_FILE)
			const authority = await readAuthority(CURL_CAMPAIGN_ID)
			if (!((authority.mode === "fleet-v2" || authority.mode === "fleet-v2-readonly") && authority.repositoryCampaignId === definition.id &&
				authority.repositoryId === definition.repositoryId && authority.repository === definition.repository &&
				authority.sourceRevision === definition.sourceRevision && authority.policySha256 === definition.policySha256 &&
				authority.model === definition.model && authority.profileId === "muse-spark-contributor" && Number.isSafeInteger(authority.repositoryEpoch))) {
				throw new Error("fresh Fleet Curl scope is unavailable for billing reconciliation")
			}
			const scope = { repositoryCampaignId: definition.id, repositoryId: definition.repositoryId!, repository: definition.repository!,
				sourceRevision: definition.sourceRevision!, policySha256: definition.policySha256!, model: definition.model as "meta/muse-spark-1.3-contributor",
				profileId: "muse-spark-contributor" as const, repositoryEpoch: authority.repositoryEpoch! }
			const expectedKeyIdentity = await readFleetBudgetKeyIdentity()
			const ledger = new FleetRepositoryBudgetLedger({ expectedKeyIdentity, scope })
			const repositoryStore = new RepositoryCampaignStore(REPOSITORY_CAMPAIGN_STATE_FILE, definitions, readAuthority)
			const result = await reconcileClosedCurlQualificationBilling(positional[1]!, `CONFIRM SETTLE PARTIAL QUALIFICATION ${positional[1]}`, {
				store: repositoryStore, controlStore: new CampaignControlStore(CAMPAIGN_CONTROL_FILE), ledger, definition, scope,
				expectedKeyIdentity, storePath: REPOSITORY_CAMPAIGN_STATE_FILE,
			})
			process.stdout.write(`${JSON.stringify({ reconciliation: "closed-session-billing-proof", qualification: "unqualified", ...result })}\n`)
			return 0
		} catch (error) {
			process.stderr.write(`headlesscode campaign: ${error instanceof Error ? error.message : "partial billing reconciliation failed closed"}\n`)
			return 1
		}
	}
	if (action === "retry-no-call") {
		if (positional.length !== 3 || positional[0] !== CURL_CAMPAIGN_ID ||
			!/^([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i.test(positional[1]!) ||
			positional[2] !== `--confirm-retry-no-call=${positional[1]}`) return 2
		try {
			const definitions = await loadRepositoryCampaignDefinitions(REPOSITORY_CAMPAIGN_REGISTRY_FILE)
			const definition = definitions.find((item) => item.id === CURL_CAMPAIGN_ID)
			if (!definition) throw new Error("no-call retry requires the owner-registered Curl qualification")
			const readAuthority = createRepositoryBudgetAuthorityReader(definitions, CAMPAIGN_CONTROL_FILE)
			const repositoryStore = new RepositoryCampaignStore(REPOSITORY_CAMPAIGN_STATE_FILE, definitions, readAuthority)
			const authority = await readAuthority(CURL_CAMPAIGN_ID)
			const liveDispatchReady = authority.mode === "fleet-v2" && authority.available && !!authority.runId &&
				!!authority.runExpiresAtMs && authority.runExpiresAtMs > Date.now()
			const snapshotProvisioningReady = authority.mode === "fleet-v2-readonly" && authority.snapshotOnly === true && !authority.available
			if ((!liveDispatchReady && !snapshotProvisioningReady) || authority.globalEnabled !== true || authority.canAdmit !== true ||
				authority.repositoryEnabled !== true || authority.repositoryCampaignId !== definition.id || authority.repositoryId !== definition.repositoryId ||
				authority.repository !== definition.repository || authority.sourceRevision !== definition.sourceRevision || authority.policySha256 !== definition.policySha256 ||
				authority.model !== definition.model || authority.profileId !== "muse-spark-contributor") {
				throw new Error("fresh enabled Fleet Curl provisioning authority is unavailable")
			}
			const view = await repositoryStore.recoveryView(positional[1]!)
			if (!view.job || view.activeJobs.length) throw new Error("retry target is unavailable or another Curl job is active")
			const keyIdentity = await readFleetBudgetKeyIdentity()
			const scope = { repositoryCampaignId: definition.id, repositoryId: definition.repositoryId!, repository: definition.repository!,
				sourceRevision: definition.sourceRevision!, policySha256: definition.policySha256!, model: definition.model as "meta/muse-spark-1.3-contributor",
				profileId: "muse-spark-contributor" as const, repositoryEpoch: authority.repositoryEpoch! }
			const proofSha256 = await verifyRecoveredNoCallArtifact(view.job, REPOSITORY_CAMPAIGN_STATE_FILE, scope, keyIdentity)
			const child = await repositoryStore.enqueueVerifiedNoCallRetry(view.job.id, `CONFIRM RETRY NO-CALL ${view.job.id}`)
			process.stdout.write(`${JSON.stringify({ retry: "explicit-no-call", campaignId: CURL_CAMPAIGN_ID,
				parentJobId: view.job.id, childJobId: child.id, jobId: child.id, proofSha256, state: child.status })}\n`)
			return 0
		} catch (error) {
			process.stderr.write(`headlesscode campaign: ${error instanceof Error ? error.message : "no-call retry failed closed"}\n`)
			return 1
		}
	}
	return undefined
}
