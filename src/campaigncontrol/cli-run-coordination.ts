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
	if (action === "_adapter-tick") {
		if (positional.length) return 2
		const store = new CampaignControlStore(CAMPAIGN_CONTROL_FILE)
		await verifyCampaignDispatchLock(CAMPAIGN_CONTROL_FILE)
		const adapter = await loadCampaignAdapterConfig(CAMPAIGN_ADAPTER_FILE)
		await store.updateBudgetProjection(await readCampaignBudgetReport(adapter))
		const result = await runFleetAdapterUnderLock(store, adapter)
		await store.updateBudgetProjection(await readCampaignBudgetReport(adapter))
		process.stdout.write(JSON.stringify(result) + "\n")
		return result.status === "succeeded" ? 0 : 1
	}
	if (action === "_repository-run-begin") {
		if (positional.length !== 1 || !/^\d{4,8}$/.test(positional[0]!)) return 2
		await verifyCampaignDispatchLock(CAMPAIGN_CONTROL_FILE)
		const timeoutMs = Number(positional[0])
		if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 60_000 || timeoutMs > 30 * 60_000) return 2
		const runStore = new CampaignControlStore(CAMPAIGN_CONTROL_FILE)
		const state = await runStore.snapshot()
		if (!state.enabled || !state.canAdmit) {
			process.stdout.write(JSON.stringify({ run: null }) + "\n")
			return 0
		}
		const run = await runStore.beginAdmittedRunIfIdle(new Date(), timeoutMs, state.epoch)
		process.stdout.write(JSON.stringify({ run: run ?? null }) + "\n")
		return 0
	}
	if (action === "_repository-run-finish") {
		if (positional.length !== 2 || !/^[0-9a-f-]{36}$/.test(positional[0]!) || !["succeeded", "failed"].includes(positional[1]!)) return 2
		await verifyCampaignDispatchLock(CAMPAIGN_CONTROL_FILE)
		const run = await new CampaignControlStore(CAMPAIGN_CONTROL_FILE).finishRun(positional[0]!, positional[1]! as "succeeded" | "failed", "repository-worker coordinator finished")
		process.stdout.write(JSON.stringify({ run }) + "\n")
		return 0
	}
	if (action === "_repository-lock-hold") {
		if (positional.length) return 2
		await verifyCampaignDispatchLock(CAMPAIGN_CONTROL_FILE)
		process.stdout.write("LOCKED\n")
		await new Promise<void>((resolve) => {
			process.stdin.once("data", () => resolve())
			process.stdin.once("end", () => resolve())
			process.stdin.resume()
		})
		return 0
	}
	return undefined
}
