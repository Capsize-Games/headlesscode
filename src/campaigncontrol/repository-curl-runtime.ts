import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { createHash, randomUUID } from "node:crypto"
import { execFile } from "node:child_process"
import { spawnSync } from "node:child_process"
import { spawn } from "node:child_process"
import { promisify } from "node:util"
import { fileURLToPath } from "node:url"
import { resolveContainedRuntimeProfile } from "../security/profile.js"
import { containedEvidenceSessionId, validateContainedSupervisorRoots } from "../security/supervisor.js"
import { startContainedEvidenceService } from "../security/contained-evidence-service.js"
import { readFleetBudgetKeyIdentity, verifyFleetBudgetCredential } from "../rsi/fleet-budget-ledger.js"
import type { FleetRepositoryBudgetScope } from "../rsi/fleet-repository-budget-ledger.js"
import { type ClaimedRepositoryJob, type RepositoryCampaignDefinition, type RepositoryCampaignStore } from "./repository-campaigns.js"
import { createRepositoryBudgetAuthorityReader } from "./repository-budget-authority.js"
import { CAMPAIGN_CONTROL_FILE } from "./paths.js"
import { createRepositoryCampaignBudgetBinding } from "./repository-budget-binding.js"
import { CURL_CANDIDATE_TREE_SHA, CURL_EVALUATOR_DIGEST, CURL_FIXED_ADVISORY, CURL_CAMPAIGN_ID,
	CURL_PRIVATE_SOURCE_REVISION, CURL_PROFILE_ID,
	CURL_WORKER_DIGEST, evaluatePinnedCurlCandidate, makeCurlProtectedEvaluationRequest } from "./repository-curl-evaluator.js"
import { CURL_PRIVATE_BOARD_CARD_ID, writePrivateCurlDeliveryReceipt, type CurlPrivateBoardTransport } from "./repository-curl-private-delivery.js"
export { writePrivateCurlDeliveryReceipt, type CurlPrivateBoardTransport } from "./repository-curl-private-delivery.js"
import type { RepositoryWorkerRegistration, RepositoryPipelineAdapterFactoryContext } from "./repository-worker-registration.js"
import type { RepositoryWorkerPipelineAdapters, RepositoryPreparedWorkspace } from "./repository-worker-pipeline.js"
import { runRepositoryWorkerThroughBroker, writeRepositoryWorkerTask, type VettedAdvisorySnapshot } from "./repository-worker.js"
import { restorePinnedWorktreeEolBytes, verifyPinnedGitWorktreeTree } from "./repository-source-tree.js"
import { writeRepositoryWorkerDiagnostic } from "./repository-worker-diagnostics.js"
import { CURL_DEBIAN_AFFECTED_RANGE, CURL_DEBIAN_FIXED_REVISION, CURL_DEBIAN_INTRODUCED_REVISION, CURL_DEBIAN_SNAPSHOT_SHA256,
	CURL_DEBIAN_SOURCE_HTML_SHA256, CURL_DEBIAN_SOURCE_URL, loadKnownCurlDebianAdvisory } from "./repository-known-advisory.js"

const execFileAsync = promisify(execFile)
const MODEL = "meta/muse-spark-1.3-contributor"
const PROFILE_ID = "muse-spark-contributor"
const REPOSITORY_ID = CURL_CAMPAIGN_ID
const REPOSITORY = "Capsize-Games/curl-maintenance"
const WORKER_PROFILE = "curl-published-advisory-v1"
export const CURL_PRIVATE_SOURCE_ROOT = path.join(os.homedir(), ".local", "share", "headlesscode", "repository-sources", "curl-maintenance")
const SOURCE_ROOT = CURL_PRIVATE_SOURCE_ROOT
const CONTAINED_RUNTIME_ROOT = path.join(os.homedir(), ".local", "state", "headlesscode", "repository-runtime")
const EVIDENCE_STORAGE_DIR = path.join(CONTAINED_RUNTIME_ROOT, "evidence-store")
const EVIDENCE_CONFIG_DIR = path.join(CONTAINED_RUNTIME_ROOT, "evidence-config")
const EVIDENCE_SOCKET_PATH = `/run/user/${typeof process.getuid === "function" ? process.getuid() : "unknown"}/hce/evidence.sock`
const PROFILE_PATH = path.join(CONTAINED_RUNTIME_ROOT, "profile", "repository-worker.yaml")
const CONTROL_STATE_DIR = path.join(CONTAINED_RUNTIME_ROOT, "control-state")
const CONTROL_SOCKET_DIR = `/run/user/${typeof process.getuid === "function" ? process.getuid() : "unknown"}/hcctl/{session}`
const OPEN_SHELL_XDG_CONFIG_HOME = "/home/joe/Projects/headlesscode/.worktrees/ux/.headlesscode/scratch/rsi-muse/xdg-user"
const OPEN_SHELL_XDG_STATE_HOME = "/home/joe/Projects/headlesscode/.worktrees/ux/.headlesscode/scratch/rsi-muse/xdg-state"
export const CURL_RUNTIME_CONFIG_PATH = path.join(CONTAINED_RUNTIME_ROOT, "runtime.json")
const MAX_LIFETIME_MICROS = 20_000
const MAX_LIFETIME_TOKENS = 108_000
const MAX_JOB_MICROS = 8_000
const MAX_JOB_TOKENS = 72_000
export const CURL_CAMPAIGN_POLICY = Object.freeze({
	schemaVersion: 1,
	campaignId: CURL_CAMPAIGN_ID,
	repositoryId: REPOSITORY_ID,
	repository: REPOSITORY,
	sourceRevision: CURL_PRIVATE_SOURCE_REVISION,
	advisory: Object.freeze({ id: CURL_FIXED_ADVISORY, sourceUrl: CURL_DEBIAN_SOURCE_URL,
		snapshotSha256: CURL_DEBIAN_SNAPSHOT_SHA256, sourceHtmlSha256: CURL_DEBIAN_SOURCE_HTML_SHA256,
		introducedRevision: CURL_DEBIAN_INTRODUCED_REVISION, fixedRevision: CURL_DEBIAN_FIXED_REVISION,
		affectedRange: CURL_DEBIAN_AFFECTED_RANGE }),
	model: MODEL,
	profileId: PROFILE_ID,
	workerProfile: WORKER_PROFILE,
	dataAccessProfile: "public-upstream-source-and-published-advisory-only",
	executionKind: "live-cve",
	jobPurpose: "qualification-only",
	recipeDigest: CURL_WORKER_DIGEST,
	evaluatorDigest: CURL_EVALUATOR_DIGEST,
	privateDelivery: "job-bound-local-receipt-and-agent-board-comment",
	privateBoardCardId: CURL_PRIVATE_BOARD_CARD_ID,
	limits: Object.freeze({ lifetimeMicros: MAX_LIFETIME_MICROS, lifetimeTokens: MAX_LIFETIME_TOKENS,
		jobMicros: MAX_JOB_MICROS, jobTokens: MAX_JOB_TOKENS, maxCalls: 2,
		maxInputTokensPerCall: 32_000, maxOutputTokensPerCall: 4_000,
		maxInputPricePerMillionUsd: 0.1, maxOutputPricePerMillionUsd: 0.2,
		maxCallSpendMicros: 4_000, maxJobSpendMicros: MAX_JOB_MICROS, maxDurationMs: 840_000 }),
})
export const CURL_CAMPAIGN_POLICY_SHA256 = sha256(JSON.stringify(CURL_CAMPAIGN_POLICY))
export const CURL_PRIVATE_RUNTIME_ADAPTER_ID = "curl-92390-private-runtime-v1"

type WorkerRun = Awaited<ReturnType<typeof runRepositoryWorkerThroughBroker>>

interface CurlRuntimeDependencies {
	/** Test-only seam. Production always uses the compiled private source path. */
	sourceRoot?: string
	projectRoot?: string
	verifyTree?: typeof verifyPinnedGitWorktreeTree
	lookupAdvisory?: (advisoryId: string, definition: RepositoryCampaignDefinition) => Promise<VettedAdvisorySnapshot>
	runWorker?: (input: Parameters<typeof runRepositoryWorkerThroughBroker>[0]) => Promise<WorkerRun>
	evaluate?: typeof evaluatePinnedCurlCandidate
	readKeyIdentity?: typeof readFleetBudgetKeyIdentity
	readCredential?: typeof readFleetOpenRouterCredential
	resolveProfile?: typeof resolveContainedRuntimeProfile
	writeDelivery?: typeof writePrivateCurlDeliveryReceipt
	startEvidenceService?: typeof startContainedEvidenceService
	validateSupervisorRoots?: typeof validateContainedSupervisorRoots
	createWorktree?: typeof createPinnedWorktree
	removeWorktree?: typeof removeOwnedWorktree
	readBudgetAuthority?: ReturnType<typeof createRepositoryBudgetAuthorityReader>
	createBudgetAuthorityReader?: typeof createRepositoryBudgetAuthorityReader
	loadRuntimeConfig?: () => CurlRuntimeConfig
}

export interface CurlRuntimeConfig {
	schemaVersion: 1
	profilePath: string
	profileSha256: string
	evidenceStorageDir: string
	evidenceConfigDir: string
	evidenceSocketPath: string
	controlStateDir: string
	controlSocketDir: string
	brokerBindHost: "127.0.0.1"
	openshellXdgConfigHome: string
	openshellXdgStateHome: string
}

class SingleWorkerGate {
	private tail: Promise<void> = Promise.resolve()
	async acquire(): Promise<() => void> {
		let releaseTurn!: () => void
		const turn = new Promise<void>((resolve) => { releaseTurn = resolve })
		const previous = this.tail
		this.tail = previous.then(() => turn)
		await previous
		let released = false
		return () => { if (!released) { released = true; releaseTurn() } }
	}
	async run<T>(operation: () => Promise<T>): Promise<T> {
		const release = await this.acquire()
		try { return await operation() } finally { release() }
	}
}

const curlWorkerGate = new SingleWorkerGate()

/**
 * Code-owned runtime binding for the one qualified, already-fixed Curl profile.
 * It accepts no source path, command, model, scope, or delivery destination from
 * a campaign request. Provider/model work remains behind the contained profile
 * and the shared Fleet v2 claim-bound budget ledger.
 */
export function createCurlRepositoryPipelineAdapters(
	registration: RepositoryWorkerRegistration,
	definition: RepositoryCampaignDefinition,
	context: RepositoryPipelineAdapterFactoryContext,
	dependencies: CurlRuntimeDependencies = {},
): RepositoryWorkerPipelineAdapters {
	validateRegistration(registration, definition, context)
	const paths = resolveCurlRuntimePaths(dependencies)
	const services = resolveCurlRuntimeServices(definition, dependencies)
	return buildCurlPipelineAdapters({ registration, definition, context, dependencies, paths, services })
}

interface CurlRuntimePaths {
	sourceRoot: string
	projectRoot: string
}

interface CurlRuntimeServices {
	authority: ReturnType<typeof createRepositoryBudgetAuthorityReader>
	lookup: NonNullable<CurlRuntimeDependencies["lookupAdvisory"]>
	verifyTree: NonNullable<CurlRuntimeDependencies["verifyTree"]>
	resolveProfile: NonNullable<CurlRuntimeDependencies["resolveProfile"]>
	runWorker: NonNullable<CurlRuntimeDependencies["runWorker"]>
	evaluate: NonNullable<CurlRuntimeDependencies["evaluate"]>
	writeDelivery: NonNullable<CurlRuntimeDependencies["writeDelivery"]>
}

function resolveCurlRuntimePaths(dependencies: CurlRuntimeDependencies): CurlRuntimePaths {
	return {
		sourceRoot: path.resolve(dependencies.sourceRoot ?? SOURCE_ROOT),
		projectRoot: path.resolve(dependencies.projectRoot ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")),
	}
}

function resolveCurlRuntimeServices(definition: RepositoryCampaignDefinition,
	dependencies: CurlRuntimeDependencies): CurlRuntimeServices {
	const createReader = dependencies.createBudgetAuthorityReader ?? createRepositoryBudgetAuthorityReader
	const authority = dependencies.readBudgetAuthority ?? createReader([definition], CAMPAIGN_CONTROL_FILE)
	const lookup = dependencies.lookupAdvisory ?? (async (advisoryId: string,
		currentDefinition: RepositoryCampaignDefinition) => {
		if (currentDefinition.id !== CURL_CAMPAIGN_ID || advisoryId !== CURL_FIXED_ADVISORY) {
			throw new Error("Curl advisory is outside the fixed qualification scope")
		}
		return await loadKnownCurlDebianAdvisory()
	})
	return {
		authority,
		lookup,
		verifyTree: dependencies.verifyTree ?? verifyPinnedGitWorktreeTree,
		resolveProfile: dependencies.resolveProfile ?? resolveContainedRuntimeProfile,
		runWorker: dependencies.runWorker ?? runRepositoryWorkerThroughBroker,
		evaluate: dependencies.evaluate ?? evaluatePinnedCurlCandidate,
		writeDelivery: dependencies.writeDelivery ?? writePrivateCurlDeliveryReceipt,
	}
}

interface CurlPipelineAdapterBuildInput {
	registration: RepositoryWorkerRegistration
	definition: RepositoryCampaignDefinition
	context: RepositoryPipelineAdapterFactoryContext
	dependencies: CurlRuntimeDependencies
	paths: CurlRuntimePaths
	services: CurlRuntimeServices
}

function buildCurlPipelineAdapters(input: CurlPipelineAdapterBuildInput): RepositoryWorkerPipelineAdapters {
	const { registration, definition, context, dependencies, paths, services } = input
	const { sourceRoot, projectRoot } = paths
	const { authority, lookup, verifyTree, resolveProfile, runWorker, evaluate, writeDelivery } = services
	return {
		workerProfile: registration.workerProfile,
		recipeDigest: registration.recipeDigest,
		evaluatorDigest: registration.evaluatorDigest,
		model: registration.model,
		executionKind: "live-cve",
		reservation: { ...registration.reservation },
		async recordFailureDiagnostic(input) {
			return await writeRepositoryWorkerDiagnostic(context.store.path, { claim: input.claim, stage: input.stage, error: input.error })
		},
		async lookupAdvisory(advisoryId, currentDefinition) {
			if (currentDefinition.id !== definition.id || advisoryId !== CURL_FIXED_ADVISORY) throw new Error("Curl advisory identity does not match the registered profile")
			const advisory = await lookup(advisoryId, currentDefinition)
			validateAdvisory(advisory)
			return advisory
		},
		async prepareWorkspace(input) {
			return await prepareCurlWorkspace(input, {
				definition, context, dependencies, sourceRoot, projectRoot,
				authority, verifyTree, resolveProfile, runWorker,
			})
		},
		async evaluate(input) {
			if (input.definition.id !== definition.id || input.claim.job.campaignId !== definition.id || input.advisory.advisoryId !== CURL_FIXED_ADVISORY) {
				throw new Error("Curl evaluation identity does not match the registered profile")
			}
			const candidateSha256 = await (input.workspace as RepositoryPreparedWorkspace & { candidateSha256(): Promise<string> }).candidateSha256()
			if (candidateSha256 !== input.candidateSha256) throw new Error("Curl candidate digest changed before protected evaluation")
			const request = makeCurlProtectedEvaluationRequest({ campaignId: definition.id, jobId: input.claim.job.id,
				advisoryId: input.advisory.advisoryId, candidateRevision: CURL_PRIVATE_SOURCE_REVISION,
				candidateTreeSha: CURL_CANDIDATE_TREE_SHA })
			if (request.candidateSha256 !== input.candidateSha256) throw new Error("Curl protected candidate digest is not source-bound")
			const result = await evaluate(request)
			return { passed: result.accepted && result.disposition === "already-fixed", evidenceSha256: result.evidenceSha256, detail: result.reasonCode }
		},
		async deliverPrivate(input) {
			if (input.definition.id !== definition.id || input.claim.job.campaignId !== definition.id || input.advisory.advisoryId !== CURL_FIXED_ADVISORY ||
				!input.verification.passed || !/^[a-f0-9]{64}$/.test(input.verification.evidenceSha256)) {
				throw new Error("Curl private delivery is not bound to a verified fixed-profile result")
			}
			const request = makeCurlProtectedEvaluationRequest({ campaignId: definition.id, jobId: input.claim.job.id,
				advisoryId: input.advisory.advisoryId, candidateRevision: CURL_PRIVATE_SOURCE_REVISION,
				candidateTreeSha: CURL_CANDIDATE_TREE_SHA })
			if (request.candidateSha256 !== input.candidateSha256) throw new Error("Curl private delivery digest is not source-bound")
			await context.store.assertClaimCurrent(input.claim)
			return await writeDelivery(context.store.path, { campaignId: definition.id, jobId: input.claim.job.id,
				claimId: input.claim.claimId, epoch: input.claim.epoch, advisoryId: input.advisory.advisoryId,
				candidateSha256: input.candidateSha256, verificationSha256: input.verification.evidenceSha256,
				disposition: "already-fixed", sourceRevision: CURL_PRIVATE_SOURCE_REVISION, sourceTreeSha256: CURL_CANDIDATE_TREE_SHA })
		},
	}
}

type CurlPrepareInput = Parameters<RepositoryWorkerPipelineAdapters["prepareWorkspace"]>[0]

interface CurlWorkspaceDependencies {
	definition: RepositoryCampaignDefinition
	context: RepositoryPipelineAdapterFactoryContext
	dependencies: CurlRuntimeDependencies
	sourceRoot: string
	projectRoot: string
	authority: CurlRuntimeServices["authority"]
	verifyTree: CurlRuntimeServices["verifyTree"]
	resolveProfile: CurlRuntimeServices["resolveProfile"]
	runWorker: CurlRuntimeServices["runWorker"]
}

interface CurlWorkspaceAuthorization {
	scope: FleetRepositoryBudgetScope
	apiKey: string
	expectedKeyIdentity: string
	runtimeConfig: CurlRuntimeConfig
	hostRuntimeEnv: NodeJS.ProcessEnv
	bindHost: string
	leaseToken: string
}

interface CurlWorkspaceResources {
	worktree: string
	profile: ReturnType<typeof resolveContainedRuntimeProfile>
	taskSha256: string
	cleanup: () => Promise<void>
}

async function prepareCurlWorkspace(input: CurlPrepareInput,
	dependencies: CurlWorkspaceDependencies): Promise<RepositoryPreparedWorkspace> {
	assertQualificationInput(input, dependencies.definition)
	await dependencies.context.store.assertClaimCurrent(input.claim)
	const authorization = await authorizeCurlWorkspace(input, dependencies)
	const releaseGate = await curlWorkerGate.acquire()
	const resources = await prepareCurlWorkspaceResources(input, dependencies, authorization, releaseGate)
	try {
		return await buildCurlPreparedWorkspace(input, dependencies, authorization, resources)
	} catch (error) {
		await resources.cleanup().catch(() => undefined)
		throw error
	}
}

function assertQualificationInput(input: CurlPrepareInput,
	definition: RepositoryCampaignDefinition): void {
	if (input.definition.id !== definition.id || input.claim.job.campaignId !== definition.id ||
		input.claim.job.advisoryId !== CURL_FIXED_ADVISORY || input.claim.job.purpose !== "qualification") {
		throw new Error("Curl job identity does not match the registered profile")
	}
}

async function authorizeCurlWorkspace(input: CurlPrepareInput,
	dependencies: CurlWorkspaceDependencies): Promise<CurlWorkspaceAuthorization> {
	const { definition, context, dependencies: runtime, authority } = dependencies
	const budget = await authority(definition.id)
	if (!isFreshLiveAuthority(budget, definition)) {
		throw new Error("Curl execution requires a fresh active Fleet v2 repository budget")
	}
	const scope = makeRepositoryBudgetScope(definition, budget.repositoryEpoch!)
	const credential = await (runtime.readCredential ?? readFleetOpenRouterCredential)()
	const expectedKeyIdentity = await (runtime.readKeyIdentity ?? readFleetBudgetKeyIdentity)()
	assertWorkerCredential(credential, expectedKeyIdentity)
	const runtimeConfig = (runtime.loadRuntimeConfig ?? readCurlRuntimeConfig)()
	const hostRuntimeEnv = buildContainedHostEnvironment(runtimeConfig)
	const leaseToken = input.claim.claimId
	if (!/^[0-9a-f-]{36}$/.test(leaseToken)) throw new Error("repository claim token is invalid")
	return { scope, apiKey: credential.apiKey, expectedKeyIdentity, runtimeConfig,
		hostRuntimeEnv, bindHost: runtimeConfig.brokerBindHost, leaseToken }
}

function makeRepositoryBudgetScope(definition: RepositoryCampaignDefinition,
	repositoryEpoch: number): FleetRepositoryBudgetScope {
	return {
		repositoryCampaignId: definition.id,
		repositoryId: definition.repositoryId!, repository: definition.repository!,
		sourceRevision: CURL_PRIVATE_SOURCE_REVISION, policySha256: CURL_CAMPAIGN_POLICY_SHA256,
		model: MODEL, profileId: PROFILE_ID, repositoryEpoch,
	}
}

function assertWorkerCredential(credential: { apiKey: string; keyIdentity: string },
	expectedKeyIdentity: string): void {
	if (!/^[a-f0-9]{64}$/.test(expectedKeyIdentity) ||
		credential.keyIdentity !== expectedKeyIdentity || sha256(credential.apiKey) !== expectedKeyIdentity) {
		throw new Error("selected host credential does not match Fleet v2 identity")
	}
}

async function prepareCurlWorkspaceResources(input: CurlPrepareInput,
	dependencies: CurlWorkspaceDependencies, authorization: CurlWorkspaceAuthorization,
	releaseWorkerGate: () => void): Promise<CurlWorkspaceResources> {
	const { sourceRoot, projectRoot, dependencies: runtime, resolveProfile, verifyTree } = dependencies
	const { runtimeConfig, hostRuntimeEnv } = authorization
	let worktree: string | undefined
	let evidenceService: Awaited<ReturnType<typeof startContainedEvidenceService>> | undefined
	let profile: ReturnType<typeof resolveContainedRuntimeProfile>
	let taskSha256: string
	let cleaned = false
	const cleanup = async (): Promise<void> => {
		if (cleaned) return
		cleaned = true
		let firstError: unknown
		try { await evidenceService?.close() } catch (error) { firstError = error }
		try {
			if (worktree) await (runtime.removeWorktree ?? removeOwnedWorktree)(sourceRoot, worktree)
		} catch (error) { firstError ??= error }
		finally { releaseWorkerGate() }
		if (firstError) throw firstError
	}
	try {
		worktree = await (runtime.createWorktree ?? createPinnedWorktree)(sourceRoot)
		if (!runtime.createWorktree) {
			await restorePinnedWorktreeEolBytes({ worktree, revision: CURL_PRIVATE_SOURCE_REVISION,
				expectedTreeSha: CURL_CANDIDATE_TREE_SHA })
		}
		const sessionId = containedEvidenceSessionId(path.basename(worktree))
		evidenceService = await (runtime.startEvidenceService ?? startContainedEvidenceService)({
			storageDir: runtimeConfig.evidenceStorageDir, socketPath: runtimeConfig.evidenceSocketPath,
			configDirectory: runtimeConfig.evidenceConfigDir, sessionIds: [sessionId], repoRoot: sourceRoot,
		})
		profile = resolveProfile({ repoRoot: projectRoot, purpose: "repository-worker", env: hostRuntimeEnv,
			probe: (args, timeoutMs) => probeOpenShell(args, timeoutMs, hostRuntimeEnv) })
		assertCollectorProfile(evidenceService, profile)
		const validateRoots = runtime.validateSupervisorRoots ?? validateContainedSupervisorRoots
		validateRoots(profile, sourceRoot, hostRuntimeEnv)
		if (profile.evidenceSocketPath !== runtimeConfig.evidenceSocketPath) {
			throw new Error("reviewed contained profile uses an unexpected evidence socket")
		}
		await verifyTree({ worktree, revision: CURL_PRIVATE_SOURCE_REVISION,
			expectedTreeSha: CURL_CANDIDATE_TREE_SHA })
		taskSha256 = writeRepositoryWorkerTask(worktree, input.advisory,
			CURL_PRIVATE_SOURCE_REVISION, { purpose: "qualification" })
	} catch (error) {
		await cleanup().catch(() => undefined)
		throw error
	}
	return { worktree, profile, taskSha256, cleanup }
}

function assertCollectorProfile(evidenceService: Awaited<ReturnType<typeof startContainedEvidenceService>>,
	profile: ReturnType<typeof resolveContainedRuntimeProfile>): void {
	if (evidenceService.collector.publicKey.keyId !== profile.evidencePublicKeyFingerprint) {
		throw new Error("active contained evidence collector identity differs from the reviewed profile")
	}
}

async function buildCurlPreparedWorkspace(input: CurlPrepareInput,
	dependencies: CurlWorkspaceDependencies, authorization: CurlWorkspaceAuthorization,
	resources: CurlWorkspaceResources): Promise<RepositoryPreparedWorkspace> {
	const { context, sourceRoot, verifyTree, runWorker } = dependencies
	const { worktree, taskSha256, profile, cleanup } = resources
	const { scope, expectedKeyIdentity, leaseToken, apiKey, bindHost, hostRuntimeEnv } = authorization
	const binding = createRepositoryCampaignBudgetBinding({ store: context.store,
		claim: input.claim, scope, expectedKeyIdentity })
	const limits = buildLimits(input.claim)
	let taskRemoved = false
	let workerStarted = false
	const candidateSha256 = makeCandidateDigest({ input, sourceRoot, worktree, taskSha256,
		verifyTree, isRemoved: () => taskRemoved, setRemoved: (removed) => { taskRemoved = removed } })
	return {
		worktree, taskSha256, cleanup, candidateSha256,
		runContained: async () => await runContainedWorker({
			input, context, sourceRoot, worktree, profile, taskSha256, hostRuntimeEnv,
			leaseToken, limits, apiKey, bindHost, binding, runWorker,
			isStarted: () => workerStarted, setStarted: () => { workerStarted = true },
		}),
	}
}


interface CandidateDigestDependencies {
	input: CurlPrepareInput
	sourceRoot: string
	worktree: string
	taskSha256: string
	verifyTree: CurlWorkspaceDependencies["verifyTree"]
	isRemoved: () => boolean
	setRemoved: (value: boolean) => void
}

function makeCandidateDigest(dependencies: CandidateDigestDependencies): () => Promise<string> {
	const { input, sourceRoot, worktree, taskSha256, verifyTree, isRemoved, setRemoved } = dependencies
	return async () => {
		if (!isRemoved()) {
			await removeTaskFile(worktree, taskSha256)
			setRemoved(true)
		} else {
			await assertTaskFileAbsent(worktree)
		}
		const revision = await gitText(sourceRoot, ["-C", worktree, "rev-parse", "HEAD"])
		if (revision !== CURL_PRIVATE_SOURCE_REVISION) throw new Error("Curl source revision changed during contained execution")
		const actual = await verifyTree({ worktree, revision: CURL_PRIVATE_SOURCE_REVISION,
			expectedTreeSha: CURL_CANDIDATE_TREE_SHA })
		if (actual.treeSha !== CURL_CANDIDATE_TREE_SHA) {
			throw new Error("Curl source tree differs from the fixed protected profile")
		}
		const request = makeCurlProtectedEvaluationRequest({ campaignId: input.definition.id,
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
}): Promise<{ ok: boolean; durationMs: number; outputSha256: string; actualMicros: number | null; actualTokens: number | null }> {
	if (input.isStarted()) throw new Error("Curl qualification worker session may run only once")
	input.setStarted()
	await input.context.store.assertClaimCurrent(input.input.claim)
	const result = await input.runWorker({
		launch: { repoRoot: input.sourceRoot, worktree: input.worktree, profile: input.profile,
			model: MODEL, taskSha256: input.taskSha256, hostRuntimeEnv: input.hostRuntimeEnv,
			importResults: false },
		capabilityDirectory: path.dirname(input.context.store.path), jobId: input.input.claim.job.id,
		leaseToken: input.leaseToken, profileId: PROFILE_ID, limits: input.limits,
		apiKey: input.apiKey, bindHost: input.bindHost, ledger: input.binding,
	})
	return { ok: result.ok, durationMs: result.durationMs, outputSha256: result.outputSha256,
		actualMicros: result.actualMicros, actualTokens: result.actualTokens }
}

function validateRegistration(registration: RepositoryWorkerRegistration, definition: RepositoryCampaignDefinition,
	context: RepositoryPipelineAdapterFactoryContext): void {
	if (!context?.store) throw new Error("Curl runtime registration is outside the compiled owner-qualified profile")
	assertCampaignIdentity(registration, definition)
	assertSourceProfile(registration, definition)
	assertRecipeIdentity(registration, definition)
	assertExecutionCaps(registration, definition)
}

function assertCampaignIdentity(registration: RepositoryWorkerRegistration,
	definition: RepositoryCampaignDefinition): void {
	if (registration.campaignId !== CURL_CAMPAIGN_ID || definition.id !== CURL_CAMPAIGN_ID ||
		registration.repositoryId !== REPOSITORY_ID || definition.repositoryId !== REPOSITORY_ID ||
		registration.repository !== REPOSITORY || definition.repository !== REPOSITORY) {
		throw new Error("Curl runtime registration is outside the compiled owner-qualified profile")
	}
}

function assertSourceProfile(registration: RepositoryWorkerRegistration,
	definition: RepositoryCampaignDefinition): void {
	if (registration.sourceRevision !== CURL_PRIVATE_SOURCE_REVISION ||
		definition.sourceRevision !== CURL_PRIVATE_SOURCE_REVISION ||
		registration.workerProfile !== WORKER_PROFILE || definition.workerProfile !== WORKER_PROFILE ||
		registration.profileId !== PROFILE_ID || definition.dataAccessProfile !== "public-upstream-source-and-published-advisory-only") {
		throw new Error("Curl runtime registration is outside the compiled owner-qualified profile")
	}
}

function assertRecipeIdentity(registration: RepositoryWorkerRegistration,
	definition: RepositoryCampaignDefinition): void {
	if (registration.recipeDigest !== CURL_WORKER_DIGEST || definition.recipeDigest !== CURL_WORKER_DIGEST ||
		registration.evaluatorDigest !== CURL_EVALUATOR_DIGEST || definition.evaluatorDigest !== CURL_EVALUATOR_DIGEST ||
		registration.policySha256 !== CURL_CAMPAIGN_POLICY_SHA256 ||
		definition.policySha256 !== CURL_CAMPAIGN_POLICY_SHA256) {
		throw new Error("Curl runtime registration is outside the compiled owner-qualified profile")
	}
}

function assertExecutionCaps(registration: RepositoryWorkerRegistration,
	definition: RepositoryCampaignDefinition): void {
	if (registration.model !== MODEL || definition.model !== MODEL ||
		registration.pipelineAdapterId !== "curl-92390-private-runtime-v1" || registration.executionKind !== "live-cve" ||
		registration.reservation.micros !== MAX_JOB_MICROS ||
		registration.reservation.tokens !== MAX_JOB_TOKENS || !definition.repositoryId || !definition.repository) {
		throw new Error("Curl runtime registration is outside the compiled owner-qualified profile")
	}
}

/** Read the configured host key only after Fleet's existing owner/identity validator succeeds. */
async function readFleetOpenRouterCredential(): Promise<{ apiKey: string; keyIdentity: string }> {
	const configPath = path.join(os.homedir(), ".local", "state", "fleet-security-watch", "automation", "campaign", "config.json")
	if (!await verifyFleetBudgetCredential(configPath)) throw new Error("verified Fleet campaign credential is unavailable")
	const configHandle = await fs.promises.open(configPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
	try {
		const keyReference = await readFleetKeyReference(configHandle)
		return await readFleetCredentialFile(keyReference)
	} finally {
		await configHandle.close().catch(() => undefined)
	}
}

interface FleetKeyReference {
	credentialPath: string
	keyIdentity: string
}

async function readFleetKeyReference(handle: fs.promises.FileHandle): Promise<FleetKeyReference> {
	await assertPrivateFleetCampaignConfig(handle)
	const value: unknown = JSON.parse(await handle.readFile("utf8"))
	return parseFleetKeyReference(value)
}

async function assertPrivateFleetCampaignConfig(handle: fs.promises.FileHandle): Promise<void> {
	const info = await handle.stat()
	if (!info.isFile() || info.nlink !== 1 || (info.mode & 0o077) !== 0 ||
		(typeof process.getuid === "function" && info.uid !== process.getuid()) || info.size > 32 * 1024) {
		throw new Error("verified Fleet campaign configuration is not private")
	}
}

function parseFleetKeyReference(value: unknown): FleetKeyReference {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("verified Fleet campaign configuration is invalid")
	}
	const config = value as Record<string, unknown>
	if (typeof config.credential_file !== "string" || !path.isAbsolute(config.credential_file) ||
		typeof config.key_identity !== "string" || !/^[a-f0-9]{64}$/.test(config.key_identity)) {
		throw new Error("verified Fleet campaign key reference is invalid")
	}
	return { credentialPath: path.resolve(config.credential_file), keyIdentity: config.key_identity }
}

async function readFleetCredentialFile(reference: FleetKeyReference): Promise<{ apiKey: string; keyIdentity: string }> {
	await assertTrustedCredentialParent(path.dirname(reference.credentialPath))
	const handle = await fs.promises.open(reference.credentialPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
	try {
		await assertPrivateCredentialFile(handle)
		const apiKey = (await handle.readFile()).toString("utf8").trim()
		const keyIdentity = sha256(apiKey)
		if (apiKey.length < 16 || /[\r\n\0]/.test(apiKey) || keyIdentity !== reference.keyIdentity) {
			throw new Error("Fleet credential identity check failed")
		}
		return { apiKey, keyIdentity }
	} finally {
		await handle.close().catch(() => undefined)
	}
}

async function assertTrustedCredentialParent(parentPath: string): Promise<void> {
	const parent = await fs.promises.lstat(parentPath)
	if (!parent.isDirectory() || parent.isSymbolicLink() || (parent.mode & 0o022) !== 0 ||
		(typeof process.getuid === "function" && parent.uid !== process.getuid()) ||
		await fs.promises.realpath(parentPath) !== parentPath) {
		throw new Error("Fleet credential directory is not a trusted owner path")
	}
}

async function assertPrivateCredentialFile(handle: fs.promises.FileHandle): Promise<void> {
	const info = await handle.stat()
	if (!info.isFile() || info.nlink !== 1 || (info.mode & 0o077) !== 0 || info.size < 1 ||
		info.size > 4096 || (typeof process.getuid === "function" && info.uid !== process.getuid())) {
		throw new Error("Fleet credential file is not a private regular file")
	}
}

function readCurlRuntimeConfig(): CurlRuntimeConfig {
	const absolute = path.resolve(CURL_RUNTIME_CONFIG_PATH)
	assertOwnerOnlyDirectory(CONTAINED_RUNTIME_ROOT)
	assertNoSymlinkAncestors(path.dirname(absolute))
	const handle = openRuntimeConfigFile(absolute)
	try {
		return validateCurlRuntimeConfig(parseRuntimeConfig(handle))
	} finally { fs.closeSync(handle) }
}

function openRuntimeConfigFile(absolute: string): number {
	const before = fs.lstatSync(absolute)
	assertPrivateRuntimeConfigStat(before)
	const handle = fs.openSync(absolute, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
	try {
		assertRuntimeConfigUnchanged(before, fs.fstatSync(handle))
		return handle
	} catch (error) {
		fs.closeSync(handle)
		throw error
	}
}

function assertPrivateRuntimeConfigStat(info: fs.Stats): void {
	if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 ||
		(info.mode & 0o077) !== 0 || info.size < 1 || info.size > 16 * 1024 ||
		(typeof process.getuid === "function" && info.uid !== process.getuid())) {
		throw new Error("private Curl runtime configuration must be an owner-only regular file")
	}
}

function assertRuntimeConfigUnchanged(before: fs.Stats, after: fs.Stats): void {
	if (before.dev !== after.dev || before.ino !== after.ino || !after.isFile() ||
		after.nlink !== 1 || (after.mode & 0o077) !== 0 || after.size > 16 * 1024) {
		throw new Error("private Curl runtime configuration changed while being opened")
	}
}

function parseRuntimeConfig(handle: number): unknown {
	try {
		return JSON.parse(fs.readFileSync(handle, "utf8"))
	} catch {
		throw new Error("private Curl runtime configuration is invalid JSON")
	}
}

export function validateCurlRuntimeConfig(value: unknown): CurlRuntimeConfig {
	const config = runtimeConfigObject(value)
	const expected = expectedRuntimeConfig()
	assertConfiguredPaths(config, expected)
	assertRuntimeProfileDigest(config.profileSha256)
	expected.profileSha256 = config.profileSha256 as string
	assertOwnerOnlyDirectory(config.openshellXdgConfigHome as string)
	assertOwnerOnlyDirectory(config.openshellXdgStateHome as string)
	return expected
}

function runtimeConfigObject(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("private Curl runtime configuration must be an object")
	}
	const config = value as Record<string, unknown>
	const keys = ["schemaVersion", "profilePath", "profileSha256", "evidenceStorageDir", "evidenceConfigDir", "evidenceSocketPath",
		"controlStateDir", "controlSocketDir", "brokerBindHost", "openshellXdgConfigHome", "openshellXdgStateHome"]
	if (!hasExactKeys(config, keys)) {
		throw new Error("private Curl runtime configuration contains unknown or missing fields")
	}
	return config
}

function hasExactKeys(value: Record<string, unknown>, keys: string[]): boolean {
	const actual = Object.keys(value)
	return actual.length === keys.length && actual.every((key) => keys.includes(key))
}

function expectedRuntimeConfig(): CurlRuntimeConfig {
	return {
		schemaVersion: 1, profilePath: PROFILE_PATH, profileSha256: "",
		evidenceStorageDir: EVIDENCE_STORAGE_DIR, evidenceConfigDir: EVIDENCE_CONFIG_DIR, evidenceSocketPath: EVIDENCE_SOCKET_PATH,
		controlStateDir: CONTROL_STATE_DIR, controlSocketDir: CONTROL_SOCKET_DIR, brokerBindHost: "127.0.0.1",
		openshellXdgConfigHome: OPEN_SHELL_XDG_CONFIG_HOME, openshellXdgStateHome: OPEN_SHELL_XDG_STATE_HOME,
	}

}

function assertConfiguredPaths(config: Record<string, unknown>, expected: CurlRuntimeConfig): void {
	const keys = Object.keys(expected) as (keyof CurlRuntimeConfig)[]
	for (const key of keys) {
		if (key === "profileSha256") continue
		if (config[key] !== expected[key]) {
			throw new Error(`private Curl runtime configuration ${key} differs from the code-owned profile`)
		}
	}
}

function assertRuntimeProfileDigest(value: unknown): asserts value is string {
	if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) {
		throw new Error("private Curl runtime profile digest is invalid")
	}
}

function buildContainedHostEnvironment(config: CurlRuntimeConfig): NodeJS.ProcessEnv {
	return {
		XDG_CONFIG_HOME: config.openshellXdgConfigHome, XDG_STATE_HOME: config.openshellXdgStateHome,
		HEADLESSCODE_CONTAINED_PROFILE: config.profilePath, HEADLESSCODE_CONTAINED_PROFILE_SHA256: config.profileSha256,
		HEADLESSCODE_CONTAINED_EVIDENCE_CONFIG_DIR: config.evidenceConfigDir,
		HEADLESSCODE_CONTROL_STATE_DIR: config.controlStateDir, HEADLESSCODE_CONTROL_SOCKET_DIR: config.controlSocketDir,
		HEADLESSCODE_OPENSHELL_SCRATCH_ROOT: path.join(os.homedir(), ".local", "share", "headlesscode", "openshell-sessions"),
		HEADLESSCODE_RSI_BROKER_BIND_HOST: config.brokerBindHost,
	}
}

function probeOpenShell(args: string[], timeoutMs: number, env: NodeJS.ProcessEnv) {
	const result = spawnSync("openshell", args, { env: { HOME: os.homedir(), PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin", ...env },
		encoding: "utf8", timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 })
	return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "", ...(result.error ? { error: result.error } : {}) }
}

function assertOwnerOnlyDirectory(value: string): void {
	assertNoSymlinkAncestors(value)
	const resolved = path.resolve(value)
	const stat = fs.lstatSync(resolved)
	if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 ||
		(typeof process.getuid === "function" && stat.uid !== process.getuid()) || fs.realpathSync(resolved) !== resolved) {
		throw new Error("private OpenShell XDG directory must be an owner-only real directory")
	}
}

function assertNoSymlinkAncestors(value: string): void {
	let cursor = path.resolve(value)
	while (cursor !== path.dirname(cursor)) {
		try { if (fs.lstatSync(cursor).isSymbolicLink()) throw new Error("private Curl runtime path contains a symbolic link") }
		catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error }
		cursor = path.dirname(cursor)
	}
}

type RepositoryAuthoritySnapshot = Awaited<ReturnType<ReturnType<typeof createRepositoryBudgetAuthorityReader>>>

function isFreshLiveAuthority(value: RepositoryAuthoritySnapshot,
	definition: RepositoryCampaignDefinition): boolean {
	return hasLiveRunAuthority(value) && hasFreshAuthorityTime(value) &&
		matchesRepositoryAuthority(value, definition) && hasAuthorizedBudgetLimits(value)
}

function hasLiveRunAuthority(value: RepositoryAuthoritySnapshot): boolean {
	return value.mode === "fleet-v2" && value.available === true && value.canAdmit === true &&
		value.globalEnabled === true && value.campaignId === "fleet-security-watch" &&
		value.repositoryEnabled === true && hasCurrentRunIdentity(value) && hasPositiveEpochs(value)
}

function hasCurrentRunIdentity(value: RepositoryAuthoritySnapshot): boolean {
	return value.runId !== null && typeof value.runId === "string" && Number.isSafeInteger(value.controlEpoch)
}

function hasPositiveEpochs(value: RepositoryAuthoritySnapshot): boolean {
	return Number.isSafeInteger(value.repositoryEpoch) && value.repositoryEpoch! > 0
}

function hasFreshAuthorityTime(value: RepositoryAuthoritySnapshot): boolean {
	if (typeof value.asOfMs !== "number") return false
	const ageMs = Date.now() - value.asOfMs
	return ageMs >= 0 && ageMs <= 30_000
}

function matchesRepositoryAuthority(value: RepositoryAuthoritySnapshot,
	definition: RepositoryCampaignDefinition): boolean {
	return value.repositoryCampaignId === definition.id && value.repositoryId === definition.repositoryId &&
		value.repository === definition.repository && value.sourceRevision === CURL_PRIVATE_SOURCE_REVISION &&
		value.policySha256 === CURL_CAMPAIGN_POLICY_SHA256 && value.model === MODEL &&
		value.profileId === PROFILE_ID
}

function hasAuthorizedBudgetLimits(value: RepositoryAuthoritySnapshot): boolean {
	const repositoryLimits = value.repositoryLifetime
	return value.monthly?.limitMicros !== undefined &&
		value.campaignLifetime?.limitMicros === MAX_LIFETIME_MICROS &&
		value.campaignLifetime.limitTokens === MAX_LIFETIME_TOKENS &&
		repositoryLimits !== undefined && Number.isSafeInteger(repositoryLimits.limitMicros) &&
		repositoryLimits.limitMicros >= MAX_JOB_MICROS && repositoryLimits.limitMicros <= MAX_LIFETIME_MICROS &&
		Number.isSafeInteger(repositoryLimits.limitTokens) && repositoryLimits.limitTokens >= MAX_JOB_TOKENS &&
		repositoryLimits.limitTokens <= MAX_LIFETIME_TOKENS
}

function buildLimits(claim: ClaimedRepositoryJob) {
	const micros = claim.job.reservedMicros
	const tokens = claim.job.reservedTokens
	if (!Number.isSafeInteger(micros) || micros !== MAX_JOB_MICROS || !Number.isSafeInteger(tokens) || tokens !== MAX_JOB_TOKENS) {
		throw new Error("Curl job reservation is outside the fixed Fleet worker ceiling")
	}
	return { campaignId: "fleet-security-watch", maxCalls: 2,
		maxInputTokensPerCall: 32_000, maxOutputTokensPerCall: 4_000, maxTotalTokens: tokens,
		maxDurationMs: 300_000, maxRequestBytes: 32_768, maxResponseBytes: 65_536,
		maxInputPricePerMillionUsd: 0.1, maxOutputPricePerMillionUsd: 0.2,
		maxCallSpendUsd: 0.004, maxJobSpendUsd: micros / 1_000_000,
		maxCampaignSpendUsd: 0.02 }
}

async function createPinnedWorktree(repoRoot: string): Promise<string> {
	const realRepo = await fs.promises.realpath(repoRoot)
	const repoStat = await fs.promises.lstat(realRepo)
	if (!repoStat.isDirectory() || repoStat.isSymbolicLink()) throw new Error("fixed private Curl source is unavailable")
	const worktreeRoot = path.join(realRepo, ".worktrees")
	await fs.promises.mkdir(worktreeRoot, { recursive: true, mode: 0o700 })
	const rootStat = await fs.promises.lstat(worktreeRoot)
	if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || (rootStat.mode & 0o077) !== 0 ||
		(typeof process.getuid === "function" && rootStat.uid !== process.getuid())) throw new Error("Curl private worktree root must be owner-only")
	const id = randomUUID()
	const name = `curl-campaign-${id}`
	const worktree = path.join(worktreeRoot, name)
	await gitText(realRepo, ["-C", realRepo, "worktree", "add", "-b", `headlesscode/${name}`, worktree, CURL_PRIVATE_SOURCE_REVISION])
	return worktree
}

async function removeOwnedWorktree(repoRoot: string, worktree: string): Promise<void> {
	const root = path.resolve(repoRoot)
	const candidate = path.resolve(worktree)
	if (path.dirname(candidate) !== path.join(root, ".worktrees") || !path.basename(candidate).startsWith("curl-campaign-")) {
		throw new Error("refusing to remove an unowned Curl worktree")
	}
	await gitText(root, ["-C", root, "worktree", "remove", "--force", candidate])
	await gitText(root, ["-C", root, "branch", "-D", `headlesscode/${path.basename(candidate)}`])
}

async function removeTaskFile(worktree: string, expectedSha256: string): Promise<void> {
	const target = path.join(worktree, "ORCHESTRATOR_TASK.md")
	const info = await fs.promises.lstat(target)
	if (!info.isFile() || info.isSymbolicLink() || sha256(await fs.promises.readFile(target)) !== expectedSha256) {
		throw new Error("Curl worker task file identity changed")
	}
	await fs.promises.unlink(target)
}

async function gitText(cwd: string, args: string[]): Promise<string> {
	const { stdout } = await execFileAsync("git", args, { cwd, timeout: 30_000, maxBuffer: 64 * 1024 })
	if (typeof stdout !== "string" || stdout.length > 4096) throw new Error("fixed Curl Git operation returned an invalid response")
	return stdout.trim()
}

function validateAdvisory(value: VettedAdvisorySnapshot): void {
	assertFixedAdvisoryIdentity(value)
	assertAdvisoryMetadataBounds(value)
	assertAdvisoryProfile(value)
}

function assertFixedAdvisoryIdentity(value: VettedAdvisorySnapshot): void {
	if (!value || value.advisoryId !== CURL_FIXED_ADVISORY ||
		value.sourceUrl !== `https://security-tracker.debian.org/tracker/${CURL_FIXED_ADVISORY}`) {
		throw new Error("vetted Debian advisory metadata is outside the fixed Curl profile")
	}
}

function assertAdvisoryMetadataBounds(value: VettedAdvisorySnapshot): void {
	if (!/^[a-f0-9]{64}$/.test(value.snapshotSha256) || typeof value.summary !== "string" ||
		value.summary.length > 1200 || typeof value.affectedRange !== "string" ||
		value.affectedRange.length > 400 || value.fixedVersion !== null) {
		throw new Error("vetted Debian advisory metadata is outside the fixed Curl profile")
	}
}

function assertAdvisoryProfile(value: VettedAdvisorySnapshot): void {
	if (!Array.isArray(value.verificationCheckIds) || value.verificationCheckIds.length !== 1 ||
		value.verificationCheckIds[0] !== CURL_PROFILE_ID) {
		throw new Error("vetted Debian advisory metadata is outside the fixed Curl profile")
	}
}

function sha256(value: string | Buffer): string {
	return createHash("sha256").update(value).digest("hex")
}
