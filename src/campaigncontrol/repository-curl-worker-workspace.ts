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

export async function buildCurlPreparedWorkspace(input: CurlPrepareInput,
	dependencies: CurlWorkspaceDependencies,
		authorization: CurlWorkspaceAuthorization,
	resources: CurlWorkspaceResources): Promise<RepositoryPreparedWorkspace> {
	const { context, sourceRoot, verifyTree, runWorker } = dependencies
	const { worktree, taskSha256, profile, cleanup } = resources
	const { scope, expectedKeyIdentity, leaseToken, apiKey, bindHost,
		hostRuntimeEnv } = authorization
	const binding = createRepositoryCampaignBudgetBinding({ store: context.store,
		claim: input.claim, scope, expectedKeyIdentity })
	const limits = buildLimits(input.claim)
	let taskRemoved = false
	let workerStarted = false
	const candidateSha256 = makeCandidateDigest({ input, sourceRoot, worktree,
		taskSha256,
		verifyTree, isRemoved: () => taskRemoved,
			setRemoved: (removed) => { taskRemoved = removed } })
	return {
		worktree, taskSha256, cleanup, candidateSha256,
		runContained: async () => await runContainedWorker({
			input, context, sourceRoot, worktree, profile, taskSha256, hostRuntimeEnv,
			leaseToken, limits, apiKey, bindHost, binding, runWorker,
			isStarted: () => workerStarted, setStarted: () => { workerStarted = true },
		}),
	}
}


function makeCandidateDigest(dependencies: CandidateDigestDependencies): ()
	=> Promise<string> {
	const { input, sourceRoot, worktree, taskSha256, verifyTree, isRemoved,
		setRemoved } = dependencies
	return async () => {
		if (!isRemoved()) {
			await removeTaskFile(worktree, taskSha256)
			setRemoved(true)
		} else {
			await assertTaskFileAbsent(worktree)
		}
		const revision = await gitText(sourceRoot, ["-C", worktree, "rev-parse",
			"HEAD"])
		if (revision !== CURL_PRIVATE_SOURCE_REVISION) throw new
			Error("Curl source revision changed during contained execution")
		const actual = await verifyTree({ worktree,
			revision: CURL_PRIVATE_SOURCE_REVISION,
			expectedTreeSha: CURL_CANDIDATE_TREE_SHA })
		if (actual.treeSha !== CURL_CANDIDATE_TREE_SHA) {
			throw new Error("Curl source tree differs from the fixed protected profile")
		}
		const request = makeCurlProtectedEvaluationRequest({ campaignId:
			input.definition.id,
			jobId: input.claim.job.id, advisoryId: input.advisory.advisoryId,
			candidateRevision: revision, candidateTreeSha: actual.treeSha })
		return request.candidateSha256
	}
}

async function assertTaskFileAbsent(worktree: string): Promise<void> {
	try {
		await fs.promises.lstat(path.join(worktree, "ORCHESTRATOR_TASK.md"))
		throw new Error("Curl worker task file unexpectedly reappeared")
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
	}
}

async function runContainedWorker(input: {
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
	isStarted: () => boolean
	setStarted: () => void
}): Promise<{ ok: boolean; durationMs: number; outputSha256: string;
	actualMicros: number | null; actualTokens: number | null;
		failureDiagnostic?: string }> {
	if (input.isStarted()) throw new
		Error("Curl qualification worker session may run only once")
	input.setStarted()
	await input.context.store.assertClaimCurrent(input.input.claim)
	const result = await input.runWorker({
		launch: { repoRoot: input.sourceRoot, worktree: input.worktree,
			profile: input.profile,
			model: MODEL, taskSha256: input.taskSha256,
				hostRuntimeEnv: input.hostRuntimeEnv,
			importResults: false },
		capabilityDirectory: path.dirname(input.context.store.path),
			jobId: input.input.claim.job.id,
		leaseToken: input.leaseToken, profileId: PROFILE_ID, limits: input.limits,
		apiKey: input.apiKey, bindHost: input.bindHost, ledger: input.binding,
	})
	return { ok: result.ok, durationMs: result.durationMs,
		outputSha256: result.outputSha256,
		actualMicros: result.actualMicros, actualTokens: result.actualTokens,
		...(result.failureDiagnostic ? { failureDiagnostic:
			result.failureDiagnostic } : {}) }
}
