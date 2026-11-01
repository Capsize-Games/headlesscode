import * as fs from "node:fs"
import * as path from "node:path"
import type { RepositoryPreparedWorkspace } from
	"./repository-worker-pipeline.js"
import type { CurlPrepareInput, CurlWorkspaceDependencies,
	CurlWorkspaceAuthorization, CurlWorkspaceResources,
		CandidateDigestDependencies } from "./repository-curl-workspace-types.js"
import { CURL_PRIVATE_SOURCE_REVISION, CURL_CANDIDATE_TREE_SHA,
	CURL_FIXED_ADVISORY,
		makeCurlProtectedEvaluationRequest } from "./repository-curl-evaluator.js"
import { MODEL, PROFILE_ID, MAX_JOB_MICROS,
MAX_JOB_TOKENS } from "./repository-curl-profile.js"
import { createRepositoryCampaignBudgetBinding } from
	"./repository-budget-binding.js"
import { buildLimits } from "./repository-curl-authority.js"
import { removeTaskFile, gitText, sha256 } from "./repository-curl-source.js"
import { runRepositoryWorkerThroughBroker } from "./repository-worker.js"
import { resolveContainedRuntimeProfile } from "../security/profile.js"
import type { RepositoryPipelineAdapterFactoryContext } from
	"./repository-worker-registration.js"
import type { ClaimedRepositoryJob } from "./repository-campaigns.js"
import type { VettedAdvisorySnapshot } from "./repository-worker.js"
import type { CurlRuntimeServices } from
	"./repository-curl-runtime-dependencies.js"

interface ContainedWorkerScope {
	input: CurlPrepareInput
	context: RepositoryPipelineAdapterFactoryContext
	sourceRoot: string
	worktree: string
	profile: ReturnType<typeof resolveContainedRuntimeProfile>
	taskSha256: string
	hostRuntimeEnv: NodeJS.ProcessEnv
	leaseToken: string
	limits: ReturnType<typeof buildLimits>
	apiKey: string
	bindHost: string
	binding: ReturnType<typeof createRepositoryCampaignBudgetBinding>
	runWorker: CurlRuntimeServices["runWorker"]
	started: { current: boolean }
}

interface ContainedWorkerResult {
	ok: boolean
	durationMs: number
	outputSha256: string
	actualMicros: number | null
	actualTokens: number | null
	failureDiagnostic?: string
}

type WorkerRunResult = Awaited<
	ReturnType<CurlRuntimeServices["runWorker"]>
>

export async function buildCurlPreparedWorkspace(input: CurlPrepareInput,
	dependencies: CurlWorkspaceDependencies,
		authorization: CurlWorkspaceAuthorization,
	resources: CurlWorkspaceResources): Promise<RepositoryPreparedWorkspace> {
	const { context, sourceRoot, verifyTree } = dependencies
	const { worktree, taskSha256, cleanup } = resources
	const { scope, expectedKeyIdentity } = authorization
	const binding = createRepositoryCampaignBudgetBinding({ store: context.store,
		claim: input.claim, scope, expectedKeyIdentity })
	const candidateSha256 = makeCandidateDigest({
		input, sourceRoot, worktree, taskSha256, verifyTree,
	})
	const worker = preparedWorkerScope(input, dependencies, authorization,
		resources, { binding, limits: buildLimits(input.claim) })
	return {
		worktree, taskSha256, cleanup, candidateSha256,
		runContained: (signal) => runContainedWorker(worker, signal),
	}
}

function makeCandidateDigest(
	dependencies: CandidateDigestDependencies,
): () => Promise<string> {
	const { input, sourceRoot, worktree, taskSha256, verifyTree } = dependencies
	const fileState = { removed: false }
	return async () => {
		await refreshCandidateTaskFile(worktree, taskSha256, fileState)
		const revision = await pinnedSourceRevision(sourceRoot, worktree)
		const actual = await verifyTree({
			worktree,
			revision: CURL_PRIVATE_SOURCE_REVISION,
			expectedTreeSha: CURL_CANDIDATE_TREE_SHA,
		})
		if (actual.treeSha !== CURL_CANDIDATE_TREE_SHA) {
			throw new Error("Curl source tree differs from the fixed protected profile")
		}
		return candidateDigestFor(input, revision, actual.treeSha)
	}
}

async function refreshCandidateTaskFile(
	worktree: string,
	taskSha256: string,
	fileState: { removed: boolean },
): Promise<void> {
	if (!fileState.removed) {
		await removeTaskFile(worktree, taskSha256)
		fileState.removed = true
	} else {
		await assertTaskFileAbsent(worktree)
	}
}

async function pinnedSourceRevision(
	sourceRoot: string,
	worktree: string,
): Promise<string> {
	const revision = await gitText(sourceRoot, ["-C", worktree, "rev-parse",
		"HEAD"])
	if (revision !== CURL_PRIVATE_SOURCE_REVISION) {
		throw new Error("Curl source revision changed during contained execution")
	}
	return revision
}

function candidateDigestFor(
	input: CurlPrepareInput,
	revision: string,
	treeSha: string,
): string {
	const request = makeCurlProtectedEvaluationRequest({
		campaignId: input.definition.id,
		jobId: input.claim.job.id,
		advisoryId: input.advisory.advisoryId,
		candidateRevision: revision,
		candidateTreeSha: treeSha,
	})
	return request.candidateSha256
}

async function assertTaskFileAbsent(worktree: string): Promise<void> {
	try {
		await fs.promises.lstat(path.join(worktree, "ORCHESTRATOR_TASK.md"))
		throw new Error("Curl worker task file unexpectedly reappeared")
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
	}
}

function preparedWorkerScope(
	input: CurlPrepareInput,
	dependencies: CurlWorkspaceDependencies,
	authorization: CurlWorkspaceAuthorization,
	resources: CurlWorkspaceResources,
	provision: {
		binding: ReturnType<typeof createRepositoryCampaignBudgetBinding>
		limits: ReturnType<typeof buildLimits>
	},
): ContainedWorkerScope {
	const { context, sourceRoot, runWorker } = dependencies
	const { worktree, taskSha256, profile } = resources
	const { leaseToken, apiKey, bindHost, hostRuntimeEnv } = authorization
	return {
		input, context, sourceRoot, worktree, profile, taskSha256,
		hostRuntimeEnv, leaseToken, apiKey, bindHost, runWorker,
		binding: provision.binding, limits: provision.limits,
		started: { current: false },
	}
}

async function runContainedWorker(
	scope: ContainedWorkerScope,
	signal: AbortSignal,
): Promise<ContainedWorkerResult> {
	await guardWorkerDispatch(scope, signal)
	const result = await launchContainedWorker(scope, signal)
	return summarizeWorkerResult(result)
}

async function guardWorkerDispatch(
	scope: ContainedWorkerScope,
	signal: AbortSignal,
): Promise<void> {
	if (scope.started.current) {
		throw new Error("Curl qualification worker session may run only once")
	}
	scope.started.current = true
	throwIfAborted(signal, "Curl qualification worker stopped before dispatch")
	await scope.context.store.assertClaimCurrent(scope.input.claim)
	throwIfAborted(signal, "Curl qualification worker stopped before dispatch")
}

function throwIfAborted(signal: AbortSignal, message: string): void {
	if (signal.aborted) throw signal.reason ?? new Error(message)
}

async function launchContainedWorker(
	scope: ContainedWorkerScope,
	signal: AbortSignal,
): Promise<WorkerRunResult> {
	return scope.runWorker({
		launch: workerLaunchConfig(scope, signal),
		capabilityDirectory: path.dirname(scope.context.store.path),
		jobId: scope.input.claim.job.id,
		leaseToken: scope.leaseToken,
		profileId: PROFILE_ID,
		limits: scope.limits,
		apiKey: scope.apiKey,
		bindHost: scope.bindHost,
		ledger: scope.binding,
	})
}

function workerLaunchConfig(
	scope: ContainedWorkerScope,
	signal: AbortSignal,
): Parameters<CurlRuntimeServices["runWorker"]>[0]["launch"] {
	return {
		repoRoot: scope.sourceRoot,
		worktree: scope.worktree,
		profile: scope.profile,
		model: MODEL,
		taskSha256: scope.taskSha256,
		signal,
		hostRuntimeEnv: scope.hostRuntimeEnv,
		importResults: false,
	}
}

function summarizeWorkerResult(
	result: WorkerRunResult,
): ContainedWorkerResult {
	return {
		ok: result.ok,
		durationMs: result.durationMs,
		outputSha256: result.outputSha256,
		actualMicros: result.actualMicros,
		actualTokens: result.actualTokens,
		...(result.failureDiagnostic ? {
			failureDiagnostic: result.failureDiagnostic,
		} : {}),
	}
}
