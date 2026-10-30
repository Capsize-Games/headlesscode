import type { ClaimedRepositoryJob, RepositoryCampaignDefinition, RepositoryCampaignStep, RepositoryEvidenceRef } from "./repository-campaigns.js"
import type { RegisteredRepositoryWorker, RepositoryAdvisoryIntake, RepositoryWorkerExecutionResult } from "./repository-coordinator.js"
import type { VettedAdvisorySnapshot } from "./repository-worker.js"
import type { CurlHistoricalRepairCandidate } from "./repository-curl-repair.js"
import type { CurlHistoricalRepairReceipt } from "./repository-curl-repair-evaluator.js"
import type { CurlHistoricalRepairV2Receipt } from "./repository-curl-repair-v2-evaluator.js"
import type { CurlRepairV2StageReceipt, CurlRepairV2WorkerReceipt, CurlRepairV2EvaluatorReceipt } from "./repository-curl-repair-v2-execution.js"
import { writeRepositoryWorkerDiagnostic } from "./repository-worker-diagnostics.js"
import { CURL_REPAIR_V2_CAMPAIGN_ID } from "./repository-campaign-ids.js"

export interface RepositoryPreparedWorkspace {
	readonly worktree: string
	readonly taskSha256: string
	readonly runContained: (signal: AbortSignal) => Promise<{ ok: boolean; durationMs: number; outputSha256: string; actualMicros: number | null; actualTokens: number | null; failureDiagnostic?: string }>
	readonly candidateSha256: () => Promise<string>
	readonly historicalRepairCandidate?: CurlHistoricalRepairCandidate
	readonly requiresContainedRepairWorker?: boolean
	readonly cleanup?: () => Promise<void>
}

export interface RepositoryVerificationReceipt {
	readonly passed: boolean
	readonly evidenceSha256: string
	readonly detail: string
	readonly historicalRepair?: { readonly candidate: CurlHistoricalRepairCandidate; readonly receipt: CurlHistoricalRepairReceipt }
	readonly historicalRepairV2?: { readonly candidate: CurlHistoricalRepairCandidate; readonly receipt: CurlHistoricalRepairV2Receipt;
		readonly worker: CurlRepairV2StageReceipt<CurlRepairV2WorkerReceipt>;
		readonly evaluator: CurlRepairV2StageReceipt<CurlRepairV2EvaluatorReceipt> }
}

export interface RepositoryPrivateDeliveryReceipt {
	readonly accepted: boolean
	readonly evidenceSha256: string
	readonly boardRef?: string | null
}

/** Dependencies are owner-registered code adapters; none are derived from a job or HTTP field. */
export interface RepositoryWorkerPipelineAdapters {
	readonly workerProfile: string
	readonly recipeDigest: string
	readonly evaluatorDigest: string
	readonly model: string
	readonly executionKind: "development-checkpoint" | "live-cve"
	readonly reservation: { readonly micros: number; readonly tokens: number }
	readonly advisoryIntake?: RepositoryAdvisoryIntake
	lookupAdvisory(advisoryId: string, definition: RepositoryCampaignDefinition): Promise<VettedAdvisorySnapshot>
	prepareWorkspace(input: { definition: RepositoryCampaignDefinition; claim: ClaimedRepositoryJob; advisory: VettedAdvisorySnapshot }): Promise<RepositoryPreparedWorkspace>
	evaluate(input: { definition: RepositoryCampaignDefinition; claim: ClaimedRepositoryJob; advisory: VettedAdvisorySnapshot; workspace: RepositoryPreparedWorkspace; candidateSha256: string; signal: AbortSignal }): Promise<RepositoryVerificationReceipt>
	deliverPrivate(input: { definition: RepositoryCampaignDefinition; claim: ClaimedRepositoryJob; advisory: VettedAdvisorySnapshot; candidateSha256: string; verification: RepositoryVerificationReceipt; signal: AbortSignal }): Promise<RepositoryPrivateDeliveryReceipt>
	recordFailureDiagnostic?(input: { claim: ClaimedRepositoryJob; stage: RepositoryCampaignStep; error: unknown }): Promise<{ digest: string }>
}

function ref(kind: RepositoryEvidenceRef["kind"], label: string, digest: string): RepositoryEvidenceRef {
	if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error("repository pipeline evidence digest is invalid")
	return { id: digest, kind, label }
}

function requireDigest(value: unknown, label: string): string {
	if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) throw new Error(`${label} digest is invalid`)
	return value
}

/**
 * Compose the production intake, contained worker, protected evaluator and
 * private delivery adapters into the coordinator contract. Calls are strictly
 * ordered; evaluator and delivery never receive an unverified HTTP command.
 */
export function createRepositoryWorkerPipeline(adapters: RepositoryWorkerPipelineAdapters): RegisteredRepositoryWorker {
	if (!adapters || !/^[a-z0-9][a-z0-9-]{1,62}$/.test(adapters.workerProfile) || !/^[a-f0-9]{64}$/.test(adapters.recipeDigest) ||
		!/^[a-f0-9]{64}$/.test(adapters.evaluatorDigest) || !adapters.model || adapters.model.length > 160 ||
		!Number.isSafeInteger(adapters.reservation?.micros) || adapters.reservation.micros < 1 ||
		!Number.isSafeInteger(adapters.reservation?.tokens) || adapters.reservation.tokens < 1 ||
		![adapters.lookupAdvisory, adapters.prepareWorkspace, adapters.evaluate, adapters.deliverPrivate].every((fn) => typeof fn === "function")) {
		throw new Error("repository worker pipeline registration is invalid")
	}
	return {
		workerProfile: adapters.workerProfile, recipeDigest: adapters.recipeDigest, evaluatorDigest: adapters.evaluatorDigest,
		model: adapters.model, executionKind: adapters.executionKind, reservation: { ...adapters.reservation },
		...(adapters.advisoryIntake ? { advisoryIntake: adapters.advisoryIntake } : {}),
		async execute({ definition, claim, signal, progress }): Promise<RepositoryWorkerExecutionResult> {
			let evidenceRefs: RepositoryEvidenceRef[] = []
			let completedSteps: RepositoryCampaignStep[] = []
			let currentStage: RepositoryCampaignStep = "intake"
			let actualMicros: number | null = null
			let actualTokens: number | null = null
			let currentTask = "Load the registered advisory snapshot"
			try {
				if (signal.aborted) throw new Error("worker stopped before intake")
				const advisory = await adapters.lookupAdvisory(claim.job.advisoryId, definition)
				if (advisory.advisoryId !== claim.job.advisoryId) throw new Error("intake returned a different advisory identity")
				const intakeDigest = requireDigest(advisory.snapshotSha256, "advisory snapshot")
				evidenceRefs = [ref("intake", "Vetted advisory snapshot", intakeDigest)]
				completedSteps = ["intake", "deduplicate"]
				currentStage = "investigate"
				await progress({ stage: "investigate", currentTask: "Check the advisory against the registered source", completedSteps, evidenceRefs })

				if (signal.aborted) throw new Error("worker stopped before contained execution")
				currentTask = "Prepare the bounded isolated workspace"
				currentStage = "prepare-candidate"
				await progress({ stage: currentStage, currentTask, completedSteps, evidenceRefs })
				const workspace = await adapters.prepareWorkspace({ definition, claim, advisory })
				if (!/^[a-f0-9]{64}$/.test(workspace.taskSha256) || typeof workspace.candidateSha256 !== "function" ||
					(claim.job.purpose === "repair" ? !workspace.historicalRepairCandidate ||
						(workspace.requiresContainedRepairWorker && typeof workspace.runContained !== "function") :
						typeof workspace.runContained !== "function")) throw new Error("prepared workspace is invalid")
				try {
				completedSteps = ["intake", "deduplicate", "investigate", "prepare-candidate"]
					currentStage = "verify"
				if (claim.job.purpose === "repair" && !workspace.requiresContainedRepairWorker) {
					actualMicros = 0
					actualTokens = 0
					await progress({ stage: "prepare-candidate", currentTask: "Materialize the pinned historical repair patch", completedSteps, evidenceRefs })
				} else {
					if (signal.aborted) throw signal.reason ?? new Error("worker stopped before contained execution")
					const task = claim.job.purpose === "repair" ? "Prepare the pinned repair in the isolated worker" : "Run the registered contained worker"
					await progress({ stage: "prepare-candidate", currentTask: task, completedSteps, evidenceRefs })
					if (signal.aborted) throw signal.reason ?? new Error("worker stopped before contained execution")
					const worker = await workspace.runContained(signal)
					actualMicros = worker.actualMicros
					actualTokens = worker.actualTokens
					if (!worker.ok) throw new Error(worker.failureDiagnostic ?? "OpenShell worker returned a nonzero exit; no bounded output detail was captured")
				}
				const candidateSha256 = requireDigest(await workspace.candidateSha256(), "candidate")
				evidenceRefs.push(ref("candidate", "Candidate source digest", candidateSha256))
				await progress({ stage: "verify", currentTask: "Run the protected registered evaluator", completedSteps, evidenceRefs })
				if (signal.aborted) throw new Error("worker stopped before protected evaluation")
				const verification = await adapters.evaluate({ definition, claim, advisory, workspace, candidateSha256, signal })
				const verificationDigest = requireDigest(verification.evidenceSha256, "verification receipt")
				evidenceRefs.push(ref("test-receipt", "Protected verification receipt", verificationDigest))
				completedSteps = [...completedSteps, "verify"]
				if (!verification.passed) return { status: "failed", stage: "verify", accounting: actualMicros === null || actualTokens === null ? "ambiguous" : "measured",
					actualMicros, actualTokens, completedSteps, evidenceRefs, currentTask: "Protected verification rejected the candidate",
					blocker: "protected-evaluator-rejected-candidate", nextStep: "review the protected verification receipt" }
				currentStage = "deliver"
				currentTask = "Record the verified result through private delivery"
				await progress({ stage: currentStage, currentTask, completedSteps, evidenceRefs })
				if (signal.aborted) throw new Error("worker stopped before private delivery")
				const delivery = await adapters.deliverPrivate({ definition, claim, advisory, candidateSha256, verification, signal })
				const deliveryDigest = requireDigest(delivery.evidenceSha256, "private delivery receipt")
				if (!delivery.accepted) return { status: "failed", stage: "deliver", accounting: actualMicros === null || actualTokens === null ? "ambiguous" : "measured",
					actualMicros, actualTokens, completedSteps, evidenceRefs: [...evidenceRefs, ref("delivery", "Private delivery attempt", deliveryDigest)],
					currentTask: "Private delivery did not accept the verified result", blocker: "private-delivery-not-accepted", nextStep: "reconcile the private delivery receipt" }
				if (delivery.boardRef !== undefined && delivery.boardRef !== null &&
					(typeof delivery.boardRef !== "string" || delivery.boardRef.length > 256 ||
					!validPrivateBoardRef(delivery.boardRef, claim.job.campaignId === CURL_REPAIR_V2_CAMPAIGN_ID))) {
					throw new Error("private Board reference is invalid")
				}
				evidenceRefs.push(ref("delivery", "Private delivery receipt", deliveryDigest))
				completedSteps = [...completedSteps, "deliver"]
				if (actualMicros === null || actualTokens === null) return { status: "ambiguous", stage: "deliver", accounting: "ambiguous",
					actualMicros, actualTokens, completedSteps, evidenceRefs, boardRef: delivery.boardRef ?? null, currentTask: "Private delivery completed but usage reconciliation is pending",
					blocker: "usage-reconciliation-pending", nextStep: "reconcile the broker receipt before retry" }
				return { status: "succeeded", stage: "deliver", accounting: "measured",
					actualMicros, actualTokens, completedSteps, evidenceRefs, boardRef: delivery.boardRef ?? null, currentTask: "Private delivery receipt recorded", blocker: null, nextStep: null }
				} finally {
					await workspace.cleanup?.()
				}
			} catch (error) {
				if (adapters.recordFailureDiagnostic) {
					try {
						const diagnostic = await adapters.recordFailureDiagnostic({ claim, stage: currentStage, error })
						evidenceRefs = [...evidenceRefs, ref("diagnostic", "Private bounded failure diagnostic", diagnostic.digest)]
					} catch { /* Failure details stay absent rather than falling back to API-visible raw text. */ }
				}
				return { status: actualMicros === null || actualTokens === null ? "ambiguous" : "failed", stage: currentStage,
					accounting: actualMicros === null || actualTokens === null ? "ambiguous" : "measured", actualMicros, actualTokens,
					completedSteps, evidenceRefs, currentTask, blocker: "registered-pipeline-step-failed", nextStep: "review the private bounded diagnostic before any recovery" }
			}
		},
	}
}

function validPrivateBoardRef(value: string, v2: boolean): boolean {
	const marker = v2 ? "v2" : "v1"
	const prefix = "http://127.0.0.1:8078/api/cards/"
	const card = "1c25cecf-e5e8-4b68-b6fd-5d6ad25426d7"
	const suffix = `#hc-repository-result-${marker}:`
	return value.startsWith(prefix + card + suffix) &&
		/^[a-f0-9]{64}$/.test(value.slice((prefix + card + suffix).length))
}
