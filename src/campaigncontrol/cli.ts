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

function parseBudget(dollars: string): number | undefined {
	if (!/^(?:0|[1-9]\d*)(?:\.\d{1,6})?$/.test(dollars)) return undefined
	const [whole, fraction = ""] = dollars.split(".")
	const micros = Number(whole) * 1_000_000 + Number(fraction.padEnd(6, "0"))
	return Number.isSafeInteger(micros) && micros <= MAX_MONTHLY_BUDGET_MICROS ? micros : undefined
}

function usage(): string {
	return campaignUsage()
}

export async function campaignMain(args: string[]): Promise<number> {
	const [action, ...rest] = args
	if (!action || !isCampaignAction(action)) {
		process.stderr.write(`${usage()}\n`)
		return 2
	}
	const json = rest.includes("--json")
	const positional = rest.filter((arg) => arg !== "--json")
	if (action === "serve") {
		if (positional.length) return 2
		const { startCampaignControlServer } = await import("./server.js")
		await startCampaignControlServer({ staticRoot: path.join(os.homedir(), "Projects/capsize-web/apps/fleet-campaign-control/dist"),
			repositoryCampaignRegistryPath: REPOSITORY_CAMPAIGN_REGISTRY_FILE, repositoryCampaignStatePath: REPOSITORY_CAMPAIGN_STATE_FILE,
			repositoryWorkerRegistryPath: REPOSITORY_WORKER_REGISTRY_FILE, enableRepositoryCoordinator: true })
		process.stdout.write(JSON.stringify({ status: "listening", url: "http://127.0.0.1:4391/" }) + "\n")
		return 0
	}
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
		if (positional.length !== 3 || positional[0] !== CURL_REPAIR_V2_CAMPAIGN_ID ||
			positional[1] !== CURL_FIXED_ADVISORY || positional[2] !== "--purpose=repair") return 2
		try {
			const definitions = await loadRepositoryCampaignDefinitions(REPOSITORY_CAMPAIGN_REGISTRY_FILE)
			const definition = definitions.find((item) => item.id === CURL_REPAIR_V2_CAMPAIGN_ID)
			if (!definition || definition.workerProfile !== CURL_REPAIR_V2_PROFILE_ID) throw new Error("v2 repair profile is not owner-registered")
			const registrations = await loadRepositoryWorkerRegistrations(REPOSITORY_WORKER_REGISTRY_FILE)
			if (!registrations.some((row) => row.campaignId === CURL_REPAIR_V2_CAMPAIGN_ID && row.pipelineAdapterId === CURL_REPAIR_V2_ADAPTER_ID)) {
				throw new Error("v2 repair adapter is not owner-registered")
			}
			const readAuthority = createRepositoryBudgetAuthorityReader(definitions, CAMPAIGN_CONTROL_FILE)
			const repositoryStore = new RepositoryCampaignStore(REPOSITORY_CAMPAIGN_STATE_FILE, definitions, readAuthority)
			const state = await repositoryStore.status() as { campaigns: Array<Record<string, unknown>>; jobs: Array<Record<string, unknown>> }
			const campaign = state.campaigns.find((item) => item.id === CURL_REPAIR_V2_CAMPAIGN_ID)
			if (!campaign || campaign.enabled !== true || campaign.readiness !== "ready") throw new Error("v2 repair requires fresh registered prerequisites")
			if (state.jobs.some((job) => job.campaignId === CURL_REPAIR_V2_CAMPAIGN_ID && job.purpose === "repair")) {
				throw new Error("the v2 known advisory repair already has a job")
			}
			const advisory = await loadKnownCurlDebianAdvisory()
			await verifyCurlHistoricalRepairSourcePin()
			const candidate = await buildCurlHistoricalRepairCandidate()
			const job = await repositoryStore.enqueueKnownRepairV2({ campaignId: CURL_REPAIR_V2_CAMPAIGN_ID,
				advisoryId: advisory.advisoryId, publicBaseRevision: advisory.publicBaseRevision,
				snapshotSha256: advisory.snapshotSha256, sourceUrl: advisory.sourceUrl,
				sourceContentSha256: advisory.sourceHtmlSha256, affectedRange: advisory.affectedRange })
			process.stdout.write(`${JSON.stringify({ purpose: "repair", profileId: CURL_REPAIR_V2_PROFILE_ID,
				campaignId: CURL_REPAIR_V2_CAMPAIGN_ID, jobId: job.id, advisoryId: job.advisoryId,
				sourceRevision: candidate.sourceRevision, candidateRevision: candidate.candidateRevision,
				candidateTreeSha: candidate.candidateTreeSha, patchSha256: candidate.patchSha256, state: "queued" })}\n`)
			return 0
		} catch (error) {
			process.stderr.write(`headlesscode campaign: ${error instanceof Error ? error.message : "v2 known repair could not be queued"}\n`)
			return 1
		}
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
	if (action === "_apply") {
		if (positional.length < 1 || positional.length > 2) return 2
		const store = new CampaignControlStore(CAMPAIGN_CONTROL_FILE)
		await verifyCampaignDispatchLock(CAMPAIGN_CONTROL_FILE)
		if (positional[0] === "on" || positional[0] === "off") {
			if (positional.length !== 1) return 2
			if (positional[0] === "on") {
				const adapter = await loadCampaignAdapterConfig(CAMPAIGN_ADAPTER_FILE)
				await store.updateBudgetProjection(await readCampaignBudgetReport(adapter))
			}
			process.stdout.write(`${JSON.stringify(await store.setEnabled(positional[0] === "on"), null, 2)}\n`)
			return 0
		}
		if (positional[0] === "budget" && positional.length === 2) {
			const micros = parseBudget(positional[1]!)
			if (micros === undefined) return 2
			const adapter = await loadCampaignAdapterConfig(CAMPAIGN_ADAPTER_FILE)
			const projection = await readCampaignBudgetReport(adapter)
			await store.updateBudgetProjection(projection)
			const committed = projection.settledMicros + projection.reservedMicros + projection.ambiguousMicros
			if (micros < committed) throw new Error("budget cannot be lowered below settled, reserved, or ambiguous monthly spend")
			process.stdout.write(`${JSON.stringify(await store.setBudgetLimit(micros), null, 2)}\n`)
			return 0
		}
		return 2
	}
	if (action === "rsi") {
		if (positional.length) return 2
		process.stdout.write(JSON.stringify(await readCampaignRsiStatus(), null, json ? 0 : 2) + "\n")
		return 0
	}
	if (action === "status" && positional.length || (action === "on" || action === "off") && positional.length ||
		(action === "tick" && positional.length) || (action === "budget" && (positional.length !== 2 || positional[0] !== "--usd"))) {
		process.stderr.write(`${usage()}\n`)
		return 2
	}
	const store = new CampaignControlStore(CAMPAIGN_CONTROL_FILE)
	try {
		if (action === "on" || action === "off") {
			const control = await mutateCampaignControlLocked(action)
			process.stdout.write(JSON.stringify(control, null, json ? 0 : 2) + "\n")
			return 0
		}
		if (action === "budget") {
			const micros = parseBudget(positional[1]!)
			if (micros === undefined) {
				process.stderr.write("budget must be a decimal USD amount from $0 to $5.00 (up to six decimal places)\n")
				return 2
			}
			const control = await mutateCampaignControlLocked("budget", micros)
			process.stdout.write(JSON.stringify(control, null, json ? 0 : 2) + "\n")
			return 0
		}
		if (action === "tick") {
			const adapter = await loadCampaignAdapterConfig(CAMPAIGN_ADAPTER_FILE)
			const result = await runCampaignTick(store, adapter)
			process.stdout.write(`${JSON.stringify({ ...result, control: await store.snapshot() }, null, json ? 0 : 2)}\n`)
			return result.status === "failed" ? 1 : 0
		}
		if (fs.existsSync(CAMPAIGN_ADAPTER_FILE)) {
			const adapter = await loadCampaignAdapterConfig(CAMPAIGN_ADAPTER_FILE)
			await store.updateBudgetProjection(await readCampaignBudgetReport(adapter))
		}
		process.stdout.write(`${JSON.stringify(await store.status(), null, json ? 0 : 2)}\n`)
		return 0
	} catch (error) {
		process.stderr.write(`headlesscode campaign: ${error instanceof Error ? error.message : "operation failed"}\n`)
		return 1
	}
}
