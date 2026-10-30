import * as path from "node:path"
import type { CurlPrepareInput, CurlWorkspaceDependencies,
	CurlWorkspaceAuthorization, CurlWorkspaceResources } from
		"./repository-curl-workspace-types.js"
import { CURL_PRIVATE_SOURCE_REVISION, CURL_CANDIDATE_TREE_SHA } from
	"./repository-curl-evaluator.js"
import { resolveContainedRuntimeProfile } from "../security/profile.js"
import { containedEvidenceSessionId, validateContainedSupervisorRoots } from
	"../security/supervisor.js"
import { startContainedEvidenceService } from
	"../security/contained-evidence-service.js"
import { restorePinnedWorktreeEolBytes, type verifyPinnedGitWorktreeTree }
	from "./repository-source-tree.js"
import { removeOwnedWorktree, createPinnedWorktree } from
	"./repository-curl-source.js"
import { probeOpenShell } from "./repository-curl-runtime-config.js"
import { writeRepositoryWorkerTask, type VettedAdvisorySnapshot } from
	"./repository-worker.js"

interface CurlWorkspaceProvisionState {
	worktree?: string
	evidenceService?: Awaited<ReturnType<typeof startContainedEvidenceService>>
	profile?: ReturnType<typeof resolveContainedRuntimeProfile>
	taskSha256?: string
	cleaned: boolean
}


export async function prepareCurlWorkspaceResources(
	input: CurlPrepareInput,
	dependencies: CurlWorkspaceDependencies,
	authorization: CurlWorkspaceAuthorization,
	releaseWorkerGate: () => void,
): Promise<CurlWorkspaceResources> {
	const state: CurlWorkspaceProvisionState = { cleaned: false }
	const cleanup = makeWorkspaceCleanup(state, dependencies, releaseWorkerGate)
	try {
		await provisionWorkspace(state, input, dependencies, authorization)
	} catch (error) {
		await cleanup().catch(() => undefined)
		throw error
	}
	if (!state.worktree || !state.profile || !state.taskSha256) {
		throw new Error("contained Curl workspace setup is incomplete")
	}
	return { worktree: state.worktree, profile: state.profile,
		taskSha256: state.taskSha256, cleanup }
}

function makeWorkspaceCleanup(
	state: CurlWorkspaceProvisionState,
	dependencies: CurlWorkspaceDependencies,
	releaseWorkerGate: () => void,
): () => Promise<void> {
	return async () => {
		if (state.cleaned) return
		state.cleaned = true
		try { await closeWorkspaceResources(state, dependencies) }
		finally { releaseWorkerGate() }
	}
}

async function closeWorkspaceResources(
	state: CurlWorkspaceProvisionState,
	dependencies: CurlWorkspaceDependencies,
): Promise<void> {
	let firstError: unknown
	try { await state.evidenceService?.close() } catch (error) { firstError =
		error }
	try {
		if (state.worktree) {
			const remove = dependencies.dependencies.removeWorktree ??
				removeOwnedWorktree
			await remove(dependencies.sourceRoot, state.worktree)
		}
	} catch (error) { firstError ??= error }
	if (firstError) throw firstError
}

async function provisionWorkspace(
	state: CurlWorkspaceProvisionState,
	input: CurlPrepareInput,
	dependencies: CurlWorkspaceDependencies,
	authorization: CurlWorkspaceAuthorization,
): Promise<void> {
	state.worktree = await createWorkspaceWorktree(dependencies)
	state.evidenceService = await startWorkspaceEvidence(state, dependencies,
		authorization)
	state.profile = resolveWorkspaceProfile(dependencies, authorization)
	await verifyWorkspaceTree(state, dependencies, authorization)
	state.taskSha256 = writeRepositoryWorkerTask(state.worktree, input.advisory,
		CURL_PRIVATE_SOURCE_REVISION, { purpose: "qualification" })
}

async function createWorkspaceWorktree(
	dependencies: CurlWorkspaceDependencies,
): Promise<string> {
	const create = dependencies.dependencies.createWorktree ?? createPinnedWorktree
	const worktree = await create(dependencies.sourceRoot)
	if (!dependencies.dependencies.createWorktree) {
		await restorePinnedWorktreeEolBytes({ worktree,
			revision: CURL_PRIVATE_SOURCE_REVISION,
			expectedTreeSha: CURL_CANDIDATE_TREE_SHA })
	}
	return worktree
}

async function startWorkspaceEvidence(
	state: CurlWorkspaceProvisionState,
	dependencies: CurlWorkspaceDependencies,
	authorization: CurlWorkspaceAuthorization,
): Promise<Awaited<ReturnType<typeof startContainedEvidenceService>>> {
	const session = containedEvidenceSessionId(path.basename(state.worktree!))
	const config = authorization.runtimeConfig
	const start = dependencies.dependencies.startEvidenceService ??
		startContainedEvidenceService
	return await start({ storageDir: config.evidenceStorageDir,
		socketPath: config.evidenceSocketPath, configDirectory:
			config.evidenceConfigDir,
		sessionIds: [session], repoRoot: dependencies.sourceRoot })
}

function resolveWorkspaceProfile(
	dependencies: CurlWorkspaceDependencies,
	authorization: CurlWorkspaceAuthorization,
): ReturnType<typeof resolveContainedRuntimeProfile> {
	return dependencies.resolveProfile({ repoRoot: dependencies.projectRoot,
		purpose: "repository-worker", env: authorization.hostRuntimeEnv,
		probe: (args, timeoutMs) => probeOpenShell(args, timeoutMs,
			authorization.hostRuntimeEnv) })
}

async function verifyWorkspaceTree(
	state: CurlWorkspaceProvisionState,
	dependencies: CurlWorkspaceDependencies,
	authorization: CurlWorkspaceAuthorization,
): Promise<void> {
	assertCollectorProfile(state.evidenceService!, state.profile!)
	const validate = dependencies.dependencies.validateSupervisorRoots ??
		validateContainedSupervisorRoots
	validate(state.profile!, dependencies.sourceRoot, authorization.hostRuntimeEnv)
	if (state.profile!.evidenceSocketPath !==
		authorization.runtimeConfig.evidenceSocketPath) {
		throw new
			Error("reviewed contained profile uses an unexpected evidence socket")
	}
	await dependencies.verifyTree({ worktree: state.worktree!,
		revision: CURL_PRIVATE_SOURCE_REVISION,
		expectedTreeSha: CURL_CANDIDATE_TREE_SHA })
}

function assertCollectorProfile(evidenceService: Awaited<ReturnType<typeof
	startContainedEvidenceService>>,
	profile: ReturnType<typeof resolveContainedRuntimeProfile>): void {
	if (evidenceService.collector.publicKey.keyId !==
		profile.evidencePublicKeyFingerprint) {
		throw new
			Error("active contained evidence collector identity differs from " +
				"the reviewed profile")
	}
}
