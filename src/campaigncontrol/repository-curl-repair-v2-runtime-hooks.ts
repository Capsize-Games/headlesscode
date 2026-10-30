import type {
	RepositoryPreparedWorkspace,
	RepositoryVerificationReceipt,
	RepositoryWorkerPipelineAdapters,
} from "./repository-worker-pipeline.js"
import type {
	VettedAdvisorySnapshot,
} from "./repository-worker.js"
import {
	curlHistoricalRepairCandidateSha256,
} from "./repository-curl-repair.js"
import {
	evaluateCurlHistoricalRepairV2,
} from "./repository-curl-repair-v2-evaluator.js"
import {
	loadKnownCurlDebianAdvisory,
	CURL_DEBIAN_PUBLIC_BASE_REVISION,
} from "./repository-known-advisory.js"
import { CURL_FIXED_ADVISORY } from "./repository-curl-evaluator.js"
import { CURL_REPAIR_V2_CAMPAIGN_ID } from "./repository-campaign-ids.js"
import type {
	CurlRepairV2AdapterScope,
} from "./repository-curl-repair-v2-runtime-types.js"
import {
	writeRepositoryWorkerDiagnostic,
} from "./repository-worker-diagnostics.js"
import {
	deliverCurlRepairV2Privately,
} from "./repository-curl-repair-v2-runtime-delivery.js"

type AdapterMethods = Pick<RepositoryWorkerPipelineAdapters,
	"advisoryIntake" | "recordFailureDiagnostic" | "lookupAdvisory" |
	"prepareWorkspace" | "evaluate" | "deliverPrivate">
type PrepareInput = Parameters<
	RepositoryWorkerPipelineAdapters["prepareWorkspace"]
>[0]
type EvaluateInput = Parameters<
	RepositoryWorkerPipelineAdapters["evaluate"]
>[0]
type V2PreparedWorkspace = RepositoryPreparedWorkspace & {
	readonly v2WorkerReceipt?: Awaited<
		ReturnType<CurlRepairV2AdapterScope["prepare"]>
	>
}
type V2Candidate = Awaited<
	ReturnType<CurlRepairV2AdapterScope["buildCandidate"]>
>
type V2WorkerStage = Awaited<
	ReturnType<CurlRepairV2AdapterScope["prepare"]>
>
type SetWorkerReceipt = (receipt: V2WorkerStage | undefined) => void

export function createCurlRepairV2AdapterMethods(
	scope: CurlRepairV2AdapterScope,
): AdapterMethods {
	return {
		advisoryIntake: createAdvisoryIntake(scope),
		recordFailureDiagnostic: (input) => recordFailureDiagnostic(scope, input),
		lookupAdvisory: (id, definition) => lookupAdvisory(scope, id, definition.id),
		prepareWorkspace: (input) => prepareWorkspace(scope, input),
		evaluate: (input) => evaluateWorkspace(scope, input),
		deliverPrivate: (input) => deliverCurlRepairV2Privately(scope, input),
	}
}

function createAdvisoryIntake(
	scope: CurlRepairV2AdapterScope,
): NonNullable<RepositoryWorkerPipelineAdapters["advisoryIntake"]> {
	return {
		source: "debian-tracker-repair-v2-snapshot",
		publicBaseRevision: CURL_DEBIAN_PUBLIC_BASE_REVISION,
		poll: async () => loadKnownCurlDebianAdvisory(),
		verifySource: async () => scope.verifySource(scope.sourceRoot),
	}
}

async function recordFailureDiagnostic(
	scope: CurlRepairV2AdapterScope,
	input: Parameters<NonNullable<
		RepositoryWorkerPipelineAdapters["recordFailureDiagnostic"]
	>>[0],
): Promise<{ digest: string }> {
	return await writeRepositoryWorkerDiagnostic(scope.context.store.path, {
		claim: input.claim, stage: input.stage, error: input.error,
	})
}

async function lookupAdvisory(
	_scope: CurlRepairV2AdapterScope,
	advisoryId: string,
	campaignId: string,
): Promise<VettedAdvisorySnapshot> {
	if (campaignId !== CURL_REPAIR_V2_CAMPAIGN_ID ||
		advisoryId !== CURL_FIXED_ADVISORY) {
		throw new Error("Curl v2 advisory is outside the pinned profile")
	}
	return await loadKnownCurlDebianAdvisory()
}

async function prepareWorkspace(
	scope: CurlRepairV2AdapterScope,
	input: PrepareInput,
): Promise<V2PreparedWorkspace> {
	assertRepairClaim(input)
	await scope.context.store.assertClaimCurrent(input.claim)
	const candidate = await scope.buildCandidate(scope.sourceRoot)
	return createPreparedWorkspace(scope, input, candidate)
}

function assertRepairClaim(input: PrepareInput): void {
	const campaignId = input.claim.job.campaignId
	const advisoryId = input.claim.job.advisoryId
	if (!campaignId || !advisoryId ||
		input.definition.id !== CURL_REPAIR_V2_CAMPAIGN_ID ||
		campaignId !== CURL_REPAIR_V2_CAMPAIGN_ID ||
		advisoryId !== CURL_FIXED_ADVISORY ||
		input.claim.job.purpose !== "repair") {
		throw new Error("Curl v2 claimed job identity is invalid")
	}
}

function createPreparedWorkspace(
	scope: CurlRepairV2AdapterScope,
	input: PrepareInput,
	candidate: V2Candidate,
): V2PreparedWorkspace {
	let workerReceipt: V2WorkerStage | undefined
	const setReceipt = (receipt: typeof workerReceipt): void => {
		workerReceipt = receipt
	}
	return buildWorkspaceRecord(scope, input, candidate, setReceipt,
		() => workerReceipt)
}

function buildWorkspaceRecord(
	scope: CurlRepairV2AdapterScope,
	input: PrepareInput,
	candidate: V2Candidate,
	setReceipt: SetWorkerReceipt,
	getReceipt: () => V2PreparedWorkspace["v2WorkerReceipt"],
): V2PreparedWorkspace {
	return {
		worktree: scope.sourceRoot,
		taskSha256: candidate.sourceEnvelopeSha256,
		historicalRepairCandidate: candidate,
		requiresContainedRepairWorker: true,
		runContained: (signal) => runWorker(scope, input, signal, setReceipt),
		candidateSha256: () => candidateDigest(candidate, getReceipt()),
		cleanup: async () => undefined,
		get v2WorkerReceipt(): V2PreparedWorkspace["v2WorkerReceipt"] {
			return getReceipt()
		},
	}
}

async function runWorker(
	scope: CurlRepairV2AdapterScope,
	input: PrepareInput,
	signal: AbortSignal,
	setReceipt: (
		receipt: Awaited<ReturnType<CurlRepairV2AdapterScope["prepare"]>>,
	) => void,
): Promise<Awaited<ReturnType<RepositoryPreparedWorkspace["runContained"]>>> {
	await scope.context.store.assertClaimCurrent(input.claim)
	const worker = await scope.prepare(claimIdentity(input), signal)
	setReceipt(worker)
	return {
		ok: true, durationMs: 0, outputSha256: worker.receiptFileSha256,
		actualMicros: 0, actualTokens: 0,
	}
}

function candidateDigest(
	candidate: NonNullable<V2PreparedWorkspace["historicalRepairCandidate"]>,
	workerReceipt: V2PreparedWorkspace["v2WorkerReceipt"],
): Promise<string> {
	if (!workerReceipt) throw new Error("Curl v2 candidate worker did not finish")
	return Promise.resolve(curlHistoricalRepairCandidateSha256(candidate))
}

function claimIdentity(input: PrepareInput): {
	jobId: string
	claimId: string
	epoch: number
} {
	return {
		jobId: input.claim.job.id,
		claimId: input.claim.claimId,
		epoch: input.claim.epoch,
	}
}

async function evaluateWorkspace(
	scope: CurlRepairV2AdapterScope,
	input: EvaluateInput,
): Promise<RepositoryVerificationReceipt> {
	const repair = getRepairCandidate(input)
	await scope.context.store.assertClaimCurrent(input.claim)
	const evaluator = await scope.evaluate(claimIdentity(input), input.signal)
	return await createEvaluationReceipt(scope, input, repair, evaluator)
}

function getRepairCandidate(input: EvaluateInput): {
	candidate: NonNullable<EvaluateInput["workspace"]["historicalRepairCandidate"]>
	worker: NonNullable<V2PreparedWorkspace["v2WorkerReceipt"]>
} {
	const workspace = input.workspace as V2PreparedWorkspace
	const candidate = workspace.historicalRepairCandidate
	const worker = workspace.v2WorkerReceipt
	if (!candidate || !worker || input.claim.job.purpose !== "repair" ||
		input.claim.job.campaignId !== CURL_REPAIR_V2_CAMPAIGN_ID ||
		input.definition.id !== CURL_REPAIR_V2_CAMPAIGN_ID ||
		curlHistoricalRepairCandidateSha256(candidate) !== input.candidateSha256) {
		throw new Error("Curl v2 candidate is not bound to the current claim")
	}
	return { candidate, worker }
}

async function createEvaluationReceipt(
	scope: CurlRepairV2AdapterScope,
	input: EvaluateInput,
	repair: ReturnType<typeof getRepairCandidate>,
	evaluator: Awaited<ReturnType<CurlRepairV2AdapterScope["evaluate"]>>,
	): Promise<RepositoryVerificationReceipt> {
	const receipt = await evaluateCurlHistoricalRepairV2({
		candidate: repair.candidate, ...claimIdentity(input),
		worker: repair.worker, evaluator,
		...(scope.dependencies.evaluateBase
			? { evaluateBase: scope.dependencies.evaluateBase } : {}),
	})
	return makeVerificationReceipt(repair, evaluator, receipt)
}

function makeVerificationReceipt(
	repair: ReturnType<typeof getRepairCandidate>,
	evaluator: Awaited<ReturnType<CurlRepairV2AdapterScope["evaluate"]>>,
	receipt: Awaited<ReturnType<typeof evaluateCurlHistoricalRepairV2>>,
): RepositoryVerificationReceipt {
	return {
		passed: true, evidenceSha256: receipt.evidenceSha256,
		detail: receipt.disposition,
		historicalRepairV2: {
			candidate: repair.candidate, receipt,
			worker: repair.worker, evaluator,
		},
	}
}
