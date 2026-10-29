import { createHash, randomUUID } from "node:crypto"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
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
import { createRepositoryCampaignBudgetBinding } from "./repository-budget-binding.js"
import { CURL_CANDIDATE_TREE_SHA, CURL_EVALUATOR_DIGEST, CURL_FIXED_ADVISORY,
	CURL_PRIVATE_SOURCE_REVISION, CURL_PROFILE_ID,
	CURL_WORKER_DIGEST, evaluatePinnedCurlCandidate, makeCurlProtectedEvaluationRequest } from "./repository-curl-evaluator.js"
import type { RepositoryWorkerRegistration } from "./repository-worker-registry.js"
import type { RepositoryPipelineAdapterFactoryContext } from "./repository-worker-registry.js"
import type { RepositoryWorkerPipelineAdapters, RepositoryPreparedWorkspace } from "./repository-worker-pipeline.js"
import { runRepositoryWorkerThroughBroker, writeRepositoryWorkerTask, type VettedAdvisorySnapshot } from "./repository-worker.js"
import { verifyPinnedGitWorktreeTree } from "./repository-source-tree.js"
import { CURL_DEBIAN_AFFECTED_RANGE, CURL_DEBIAN_FIXED_REVISION, CURL_DEBIAN_INTRODUCED_REVISION, CURL_DEBIAN_SNAPSHOT_SHA256,
	CURL_DEBIAN_SOURCE_HTML_SHA256, CURL_DEBIAN_SOURCE_URL, loadKnownCurlDebianAdvisory } from "./repository-known-advisory.js"

const execFileAsync = promisify(execFile)
const MODEL = "meta/muse-spark-1.3-contributor"
const PROFILE_ID = "muse-spark-contributor"
const CAMPAIGN_ID = "curl-maintenance"
const REPOSITORY_ID = "curl-maintenance"
const REPOSITORY = "Capsize-Games/curl-maintenance"
const WORKER_PROFILE = "curl-published-advisory-v1"
const SOURCE_ROOT = path.join(os.homedir(), ".local", "share", "headlesscode", "repository-sources", "curl-maintenance")
const CONTAINED_RUNTIME_ROOT = path.join(os.homedir(), ".local", "state", "headlesscode", "repository-runtime")
const EVIDENCE_STORAGE_DIR = path.join(CONTAINED_RUNTIME_ROOT, "evidence-store")
const EVIDENCE_CONFIG_DIR = path.join(CONTAINED_RUNTIME_ROOT, "evidence-config")
const EVIDENCE_SOCKET_PATH = `/run/user/${typeof process.getuid === "function" ? process.getuid() : "unknown"}/hc-cve-evidence.sock`
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
const DELIVERY_SCHEMA = 1
const BOARD_CARD_ID = "1c25cecf-e5e8-4b68-b6fd-5d6ad25426d7"
const BOARD_CLI_PATH = "/home/joe/Projects/agent-board/cli/agent-board.mjs"
const BOARD_API_URL = "http://127.0.0.1:8078/api"
const BOARD_AUTHOR = "HeadlessCode"
export const CURL_CAMPAIGN_POLICY = Object.freeze({
	schemaVersion: 1,
	campaignId: CAMPAIGN_ID,
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
	privateBoardCardId: BOARD_CARD_ID,
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

export interface CurlPrivateBoardTransport {
	hasMarker(marker: string, lock: fs.promises.FileHandle): Promise<boolean>
	addComment(comment: string, lock: fs.promises.FileHandle): Promise<void>
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
	const sourceRoot = path.resolve(dependencies.sourceRoot ?? SOURCE_ROOT)
	const projectRoot = path.resolve(dependencies.projectRoot ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../.."))
	const authority = dependencies.readBudgetAuthority ?? createRepositoryBudgetAuthorityReader([definition], context.store.path)
	const lookup = dependencies.lookupAdvisory ?? (async (advisoryId: string, currentDefinition: RepositoryCampaignDefinition) => {
		if (currentDefinition.id !== CAMPAIGN_ID || advisoryId !== CURL_FIXED_ADVISORY) throw new Error("Curl advisory is outside the fixed qualification scope")
		return await loadKnownCurlDebianAdvisory()
	})
	const verifyTree = dependencies.verifyTree ?? verifyPinnedGitWorktreeTree
	const resolveProfile = dependencies.resolveProfile ?? resolveContainedRuntimeProfile
	const runWorker = dependencies.runWorker ?? runRepositoryWorkerThroughBroker
	const evaluate = dependencies.evaluate ?? evaluatePinnedCurlCandidate
	const writeDelivery = dependencies.writeDelivery ?? writePrivateCurlDeliveryReceipt

	return {
		workerProfile: registration.workerProfile,
		recipeDigest: registration.recipeDigest,
		evaluatorDigest: registration.evaluatorDigest,
		model: registration.model,
		executionKind: "live-cve",
		reservation: { ...registration.reservation },
		async lookupAdvisory(advisoryId, currentDefinition) {
			if (currentDefinition.id !== definition.id || advisoryId !== CURL_FIXED_ADVISORY) throw new Error("Curl advisory identity does not match the registered profile")
			const advisory = await lookup(advisoryId, currentDefinition)
			validateAdvisory(advisory)
			return advisory
		},
		async prepareWorkspace(input) {
			if (input.definition.id !== definition.id || input.claim.job.campaignId !== definition.id || input.claim.job.advisoryId !== CURL_FIXED_ADVISORY ||
				input.claim.job.purpose !== "qualification") {
				throw new Error("Curl job identity does not match the registered profile")
			}
			await context.store.assertClaimCurrent(input.claim)
			const budget = await authority(definition.id)
			if (!isFreshLiveAuthority(budget, definition)) throw new Error("Curl execution requires a fresh active Fleet v2 repository budget")
			const scope: FleetRepositoryBudgetScope = {
				repositoryCampaignId: definition.id,
				repositoryId: definition.repositoryId!,
				repository: definition.repository!,
				sourceRevision: CURL_PRIVATE_SOURCE_REVISION,
				policySha256: CURL_CAMPAIGN_POLICY_SHA256,
				model: MODEL,
				profileId: PROFILE_ID,
				repositoryEpoch: budget.repositoryEpoch!,
			}
			const credential = await (dependencies.readCredential ?? readFleetOpenRouterCredential)()
			const apiKey = credential.apiKey
			const expectedKeyIdentity = await (dependencies.readKeyIdentity ?? readFleetBudgetKeyIdentity)()
			if (!/^[a-f0-9]{64}$/.test(expectedKeyIdentity) || credential.keyIdentity !== expectedKeyIdentity || sha256(apiKey) !== expectedKeyIdentity) throw new Error("selected host credential does not match Fleet v2 identity")
			const runtimeConfig = (dependencies.loadRuntimeConfig ?? readCurlRuntimeConfig)()
			const hostRuntimeEnv = buildContainedHostEnvironment(runtimeConfig)
			const bindHost = runtimeConfig.brokerBindHost
			const leaseToken = input.claim.claimId
			if (!/^[0-9a-f-]{36}$/.test(leaseToken)) throw new Error("repository claim token is invalid")
			const releaseWorkerGate = await curlWorkerGate.acquire()
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
				try { if (worktree) await (dependencies.removeWorktree ?? removeOwnedWorktree)(sourceRoot, worktree) }
				catch (error) { firstError ??= error }
				finally { releaseWorkerGate() }
				if (firstError) throw firstError
			}
			try {
				worktree = await (dependencies.createWorktree ?? createPinnedWorktree)(sourceRoot)
				const sessionId = containedEvidenceSessionId(path.basename(worktree))
				evidenceService = await (dependencies.startEvidenceService ?? startContainedEvidenceService)({ storageDir: runtimeConfig.evidenceStorageDir,
					socketPath: runtimeConfig.evidenceSocketPath, configDirectory: runtimeConfig.evidenceConfigDir, sessionIds: [sessionId], repoRoot: sourceRoot })
				profile = resolveProfile({ repoRoot: projectRoot, purpose: "repository-worker", env: hostRuntimeEnv,
					probe: (args, timeoutMs) => probeOpenShell(args, timeoutMs, hostRuntimeEnv) })
				if (evidenceService.collector.publicKey.keyId !== profile.evidencePublicKeyFingerprint) {
					throw new Error("active contained evidence collector identity differs from the reviewed profile")
				}
				(dependencies.validateSupervisorRoots ?? validateContainedSupervisorRoots)(profile, sourceRoot, hostRuntimeEnv)
				if (profile.evidenceSocketPath !== runtimeConfig.evidenceSocketPath) throw new Error("reviewed contained profile uses an unexpected evidence socket")
				await verifyTree({ worktree, revision: CURL_PRIVATE_SOURCE_REVISION, expectedTreeSha: CURL_CANDIDATE_TREE_SHA })
				taskSha256 = writeRepositoryWorkerTask(worktree, input.advisory, CURL_PRIVATE_SOURCE_REVISION, { purpose: "qualification" })
			} catch (error) {
				await cleanup().catch(() => undefined)
				throw error
			}

			let binding: ReturnType<typeof createRepositoryCampaignBudgetBinding>
			let limits: ReturnType<typeof buildLimits>
			try {
				binding = createRepositoryCampaignBudgetBinding({ store: context.store, claim: input.claim, scope, expectedKeyIdentity })
				limits = buildLimits(input.claim)
			} catch (error) { await cleanup().catch(() => undefined); throw error }
			let taskRemoved = false
			let workerStarted = false
			const verifyActualCandidate = async (): Promise<string> => {
				if (!taskRemoved) { await removeTaskFile(worktree, taskSha256!); taskRemoved = true }
				else {
					try { await fs.promises.lstat(path.join(worktree, "ORCHESTRATOR_TASK.md")); throw new Error("Curl worker task file unexpectedly reappeared") }
					catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error }
				}
				const revision = await gitText(sourceRoot, ["-C", worktree, "rev-parse", "HEAD"])
				if (revision !== CURL_PRIVATE_SOURCE_REVISION) throw new Error("Curl source revision changed during contained execution")
				const actual = await verifyTree({ worktree, revision: CURL_PRIVATE_SOURCE_REVISION, expectedTreeSha: CURL_CANDIDATE_TREE_SHA })
				if (actual.treeSha !== CURL_CANDIDATE_TREE_SHA) throw new Error("Curl source tree differs from the fixed protected profile")
				const protectedRequest = makeCurlProtectedEvaluationRequest({ campaignId: definition.id, jobId: input.claim.job.id,
					advisoryId: input.advisory.advisoryId, candidateRevision: revision, candidateTreeSha: actual.treeSha })
				return protectedRequest.candidateSha256
			}

			const prepared: RepositoryPreparedWorkspace = {
				worktree,
				taskSha256,
				async runContained() {
					if (workerStarted) throw new Error("Curl qualification worker session may run only once")
					workerStarted = true
					await context.store.assertClaimCurrent(input.claim)
				const workerResult = await runWorker({ launch: { repoRoot: sourceRoot, worktree, profile, model: MODEL, taskSha256, hostRuntimeEnv },
						capabilityDirectory: path.dirname(context.store.path), jobId: input.claim.job.id, leaseToken, profileId: PROFILE_ID,
						limits, apiKey, bindHost, ledger: binding })
					return { ok: workerResult.ok, durationMs: workerResult.durationMs, outputSha256: workerResult.outputSha256,
						actualMicros: workerResult.actualMicros, actualTokens: workerResult.actualTokens }
				},
				candidateSha256: verifyActualCandidate,
				cleanup,
			}
			return prepared
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

function validateRegistration(registration: RepositoryWorkerRegistration, definition: RepositoryCampaignDefinition,
	context: RepositoryPipelineAdapterFactoryContext): void {
	if (!context?.store || registration.campaignId !== CAMPAIGN_ID || definition.id !== CAMPAIGN_ID ||
		registration.repositoryId !== REPOSITORY_ID || definition.repositoryId !== REPOSITORY_ID || registration.repository !== REPOSITORY || definition.repository !== REPOSITORY ||
		registration.sourceRevision !== CURL_PRIVATE_SOURCE_REVISION ||
		definition.sourceRevision !== CURL_PRIVATE_SOURCE_REVISION || registration.workerProfile !== WORKER_PROFILE || definition.workerProfile !== WORKER_PROFILE ||
		registration.recipeDigest !== CURL_WORKER_DIGEST || definition.recipeDigest !== CURL_WORKER_DIGEST ||
		registration.evaluatorDigest !== CURL_EVALUATOR_DIGEST || definition.evaluatorDigest !== CURL_EVALUATOR_DIGEST ||
		registration.policySha256 !== CURL_CAMPAIGN_POLICY_SHA256 || definition.policySha256 !== CURL_CAMPAIGN_POLICY_SHA256 ||
		registration.model !== MODEL || definition.model !== MODEL || registration.profileId !== PROFILE_ID ||
		registration.profileId !== PROFILE_ID || registration.pipelineAdapterId !== "curl-92390-private-runtime-v1" ||
		definition.dataAccessProfile !== "public-upstream-source-and-published-advisory-only" || registration.executionKind !== "live-cve" ||
		registration.reservation.micros !== MAX_JOB_MICROS || registration.reservation.tokens !== MAX_JOB_TOKENS ||
		!definition.repositoryId || !definition.repository) {
		throw new Error("Curl runtime registration is outside the compiled owner-qualified profile")
	}
}

/** Read the configured host key only after Fleet's existing owner/identity validator succeeds. */
async function readFleetOpenRouterCredential(): Promise<{ apiKey: string; keyIdentity: string }> {
	const configPath = path.join(os.homedir(), ".local", "state", "fleet-security-watch", "automation", "campaign", "config.json")
	if (!await verifyFleetBudgetCredential(configPath)) throw new Error("verified Fleet campaign credential is unavailable")
	const configHandle = await fs.promises.open(configPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
	let credentialHandle: fs.promises.FileHandle | undefined
	try {
		const info = await configHandle.stat()
		if (!info.isFile() || info.nlink !== 1 || (info.mode & 0o077) !== 0 ||
			(typeof process.getuid === "function" && info.uid !== process.getuid()) || info.size > 32 * 1024) {
			throw new Error("verified Fleet campaign configuration is not private")
		}
		const value: unknown = JSON.parse(await configHandle.readFile("utf8"))
		if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("verified Fleet campaign configuration is invalid")
		const config = value as Record<string, unknown>
		if (typeof config.credential_file !== "string" || !path.isAbsolute(config.credential_file) ||
			typeof config.key_identity !== "string" || !/^[a-f0-9]{64}$/.test(config.key_identity)) throw new Error("verified Fleet campaign key reference is invalid")
		const credentialPath = path.resolve(config.credential_file)
		const parentPath = path.dirname(credentialPath)
		const parent = await fs.promises.lstat(parentPath)
		if (!parent.isDirectory() || parent.isSymbolicLink() || (parent.mode & 0o022) !== 0 ||
			(typeof process.getuid === "function" && parent.uid !== process.getuid()) || await fs.promises.realpath(parentPath) !== parentPath) {
			throw new Error("Fleet credential directory is not a trusted owner path")
		}
		credentialHandle = await fs.promises.open(credentialPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
		const keyInfo = await credentialHandle.stat()
		if (!keyInfo.isFile() || keyInfo.nlink !== 1 || (keyInfo.mode & 0o077) !== 0 || keyInfo.size < 1 || keyInfo.size > 4096 ||
			(typeof process.getuid === "function" && keyInfo.uid !== process.getuid())) throw new Error("Fleet credential file is not a private regular file")
		const apiKey = (await credentialHandle.readFile()).toString("utf8").trim()
		const keyIdentity = sha256(apiKey)
		if (apiKey.length < 16 || /[\r\n\0]/.test(apiKey) || keyIdentity !== config.key_identity) throw new Error("Fleet credential identity check failed")
		return { apiKey, keyIdentity }
	} finally {
		await configHandle.close().catch(() => undefined)
		await credentialHandle?.close().catch(() => undefined)
	}
}

function readCurlRuntimeConfig(): CurlRuntimeConfig {
	const absolute = path.resolve(CURL_RUNTIME_CONFIG_PATH)
	assertOwnerOnlyDirectory(CONTAINED_RUNTIME_ROOT)
	assertNoSymlinkAncestors(path.dirname(absolute))
	const before = fs.lstatSync(absolute)
	if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || (before.mode & 0o077) !== 0 || before.size < 1 || before.size > 16 * 1024 ||
		(typeof process.getuid === "function" && before.uid !== process.getuid())) throw new Error("private Curl runtime configuration must be an owner-only regular file")
	const handle = fs.openSync(absolute, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
	try {
		const after = fs.fstatSync(handle)
		if (before.dev !== after.dev || before.ino !== after.ino || !after.isFile() || after.nlink !== 1 || (after.mode & 0o077) !== 0 || after.size > 16 * 1024) {
			throw new Error("private Curl runtime configuration changed while being opened")
		}
		let parsed: unknown
		try { parsed = JSON.parse(fs.readFileSync(handle, "utf8")) } catch { throw new Error("private Curl runtime configuration is invalid JSON") }
		return validateCurlRuntimeConfig(parsed)
	} finally { fs.closeSync(handle) }
}

export function validateCurlRuntimeConfig(value: unknown): CurlRuntimeConfig {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("private Curl runtime configuration must be an object")
	const config = value as Record<string, unknown>
	const keys = ["schemaVersion", "profilePath", "profileSha256", "evidenceStorageDir", "evidenceConfigDir", "evidenceSocketPath",
		"controlStateDir", "controlSocketDir", "brokerBindHost", "openshellXdgConfigHome", "openshellXdgStateHome"]
	if (Object.keys(config).length !== keys.length || Object.keys(config).some((key) => !keys.includes(key))) throw new Error("private Curl runtime configuration contains unknown or missing fields")
	const expected: CurlRuntimeConfig = {
		schemaVersion: 1, profilePath: PROFILE_PATH, profileSha256: "",
		evidenceStorageDir: EVIDENCE_STORAGE_DIR, evidenceConfigDir: EVIDENCE_CONFIG_DIR, evidenceSocketPath: EVIDENCE_SOCKET_PATH,
		controlStateDir: CONTROL_STATE_DIR, controlSocketDir: CONTROL_SOCKET_DIR, brokerBindHost: "127.0.0.1",
		openshellXdgConfigHome: OPEN_SHELL_XDG_CONFIG_HOME, openshellXdgStateHome: OPEN_SHELL_XDG_STATE_HOME,
	}
	for (const key of keys) {
		if (key === "profileSha256") continue
		if (config[key] !== expected[key as keyof CurlRuntimeConfig]) throw new Error(`private Curl runtime configuration ${key} differs from the code-owned profile`)
	}
	if (typeof config.profileSha256 !== "string" || !/^[a-f0-9]{64}$/.test(config.profileSha256)) throw new Error("private Curl runtime profile digest is invalid")
	expected.profileSha256 = config.profileSha256
	assertOwnerOnlyDirectory(config.openshellXdgConfigHome as string)
	assertOwnerOnlyDirectory(config.openshellXdgStateHome as string)
	return expected
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

function isFreshLiveAuthority(value: Awaited<ReturnType<ReturnType<typeof createRepositoryBudgetAuthorityReader>>>, definition: RepositoryCampaignDefinition): boolean {
	return value.mode === "fleet-v2" && value.available === true && value.canAdmit === true && value.globalEnabled === true &&
		value.campaignId === "fleet-security-watch" && typeof value.asOfMs === "number" && Date.now() - value.asOfMs >= 0 && Date.now() - value.asOfMs <= 30_000 &&
		value.repositoryCampaignId === definition.id && value.repositoryId === definition.repositoryId && value.repository === definition.repository &&
		value.sourceRevision === CURL_PRIVATE_SOURCE_REVISION && value.policySha256 === CURL_CAMPAIGN_POLICY_SHA256 && value.model === MODEL &&
		value.profileId === PROFILE_ID && value.repositoryEnabled === true && Number.isSafeInteger(value.repositoryEpoch) && value.repositoryEpoch! > 0 &&
		value.runId !== null && typeof value.runId === "string" && Number.isSafeInteger(value.controlEpoch) &&
		value.monthly?.limitMicros !== undefined && value.campaignLifetime?.limitMicros === MAX_LIFETIME_MICROS && value.campaignLifetime.limitTokens === MAX_LIFETIME_TOKENS &&
		value.repositoryLifetime?.limitMicros === MAX_LIFETIME_MICROS && value.repositoryLifetime.limitTokens === MAX_LIFETIME_TOKENS
}

function buildLimits(claim: ClaimedRepositoryJob) {
	const micros = claim.job.reservedMicros
	const tokens = claim.job.reservedTokens
	if (!Number.isSafeInteger(micros) || micros !== MAX_JOB_MICROS || !Number.isSafeInteger(tokens) || tokens !== MAX_JOB_TOKENS) {
		throw new Error("Curl job reservation is outside the fixed Fleet worker ceiling")
	}
	return { campaignId: "fleet-security-watch", maxCalls: 2,
		maxInputTokensPerCall: 32_000, maxOutputTokensPerCall: 4_000, maxTotalTokens: tokens,
		maxDurationMs: 840_000, maxRequestBytes: 32_768, maxResponseBytes: 65_536,
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
	if (!value || value.advisoryId !== CURL_FIXED_ADVISORY || value.sourceUrl !== `https://security-tracker.debian.org/tracker/${CURL_FIXED_ADVISORY}` ||
		! /^[a-f0-9]{64}$/.test(value.snapshotSha256) || typeof value.summary !== "string" || value.summary.length > 1200 ||
		typeof value.affectedRange !== "string" || value.affectedRange.length > 400 || value.fixedVersion !== null ||
		!Array.isArray(value.verificationCheckIds) || value.verificationCheckIds.length !== 1 || value.verificationCheckIds[0] !== CURL_PROFILE_ID) {
		throw new Error("vetted Debian advisory metadata is outside the fixed Curl profile")
	}
}

interface PrivateDeliveryRecord {
	schemaVersion: 1
	campaignId: string
	advisoryId: string
	candidateSha256: string
	verificationSha256: string
	disposition: "already-fixed"
	sourceRevision: string
	sourceTreeSha256: string
	evaluatorDigest: string
	firstJobId: string
	firstClaimId: string
	firstEpoch: number
	dedupKey: string
	evidenceSha256: string
	deliveryStatus: "pending" | "delivered"
	boardRef: string | null
}

export async function writePrivateCurlDeliveryReceipt(storePath: string, input: { campaignId: string; jobId: string; claimId: string; epoch: number;
	advisoryId: string; candidateSha256: string; verificationSha256: string; disposition: "already-fixed"; sourceRevision: string; sourceTreeSha256: string },
	board: CurlPrivateBoardTransport = fixedBoardTransport()): Promise<{ accepted: boolean; evidenceSha256: string; boardRef: string }> {
	if (input.campaignId !== CAMPAIGN_ID || !/^[0-9a-f-]{36}$/.test(input.jobId) ||
		!/^[0-9a-f-]{36}$/.test(input.claimId) || !Number.isSafeInteger(input.epoch) || input.epoch < 1 || input.advisoryId !== CURL_FIXED_ADVISORY ||
		![input.candidateSha256, input.verificationSha256].every((item) => /^[a-f0-9]{64}$/.test(item)) ||
		input.disposition !== "already-fixed" || input.sourceRevision !== CURL_PRIVATE_SOURCE_REVISION || input.sourceTreeSha256 !== CURL_CANDIDATE_TREE_SHA) {
		throw new Error("private Curl delivery record is invalid")
	}
	const directory = path.join(path.dirname(path.resolve(storePath)), "repository-delivery")
	await fs.promises.mkdir(directory, { recursive: true, mode: 0o700 })
	const dirInfo = await fs.promises.lstat(directory)
	if (!dirInfo.isDirectory() || dirInfo.isSymbolicLink() || (dirInfo.mode & 0o077) !== 0 ||
		(typeof process.getuid === "function" && dirInfo.uid !== process.getuid())) throw new Error("private delivery directory must be owner-only")
	const identity = { campaignId: input.campaignId, advisoryId: input.advisoryId, sourceRevision: input.sourceRevision,
		sourceTreeSha256: input.sourceTreeSha256, candidateSha256: input.candidateSha256, verificationSha256: input.verificationSha256,
		evaluatorDigest: CURL_EVALUATOR_DIGEST, disposition: input.disposition }
	const dedupKey = sha256(canonical(identity))
	const evidenceSha256 = sha256(canonical({ ...identity, firstJobId: input.jobId, firstClaimId: input.claimId, firstEpoch: input.epoch }))
	const target = path.join(directory, `${dedupKey}.json`)
	const lockPath = path.join(directory, `${dedupKey}.lock`)
	const lock = await fs.promises.open(lockPath, fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_NOFOLLOW, 0o600)
	try {
		const lockInfo = await lock.stat()
		if (!lockInfo.isFile() || lockInfo.nlink !== 1 || (lockInfo.mode & 0o077) !== 0 ||
			(typeof process.getuid === "function" && lockInfo.uid !== process.getuid())) throw new Error("private Curl delivery lock is not an owner-only regular file")
		await acquirePrivateDeliveryLock(lock)
		let record: PrivateDeliveryRecord
		try {
			const info = await fs.promises.lstat(target)
			if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) !== 0) throw new Error("private Curl delivery receipt has unsafe permissions")
			const parsed: unknown = JSON.parse(await fs.promises.readFile(target, "utf8"))
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("private Curl delivery receipt is invalid")
		const prior = parsed as PrivateDeliveryRecord
		if (prior.schemaVersion !== DELIVERY_SCHEMA || prior.dedupKey !== dedupKey ||
			prior.campaignId !== identity.campaignId || prior.advisoryId !== identity.advisoryId ||
			prior.sourceRevision !== identity.sourceRevision || prior.sourceTreeSha256 !== identity.sourceTreeSha256 ||
			prior.candidateSha256 !== identity.candidateSha256 || prior.verificationSha256 !== identity.verificationSha256 ||
			prior.evaluatorDigest !== identity.evaluatorDigest || prior.disposition !== identity.disposition ||
			! /^[a-f0-9]{64}$/.test(prior.evidenceSha256) || !/^[0-9a-f-]{36}$/.test(prior.firstJobId) ||
			!/^[0-9a-f-]{36}$/.test(prior.firstClaimId) || !Number.isSafeInteger(prior.firstEpoch) ||
				!(prior.deliveryStatus === "pending" || prior.deliveryStatus === "delivered") ||
			(prior.boardRef !== null && prior.boardRef !== `${BOARD_API_URL}/cards/${BOARD_CARD_ID}#hc-repository-result-v1:${dedupKey}`)) {
			throw new Error("private Curl delivery receipt conflicts with prior evidence")
		}
			record = prior
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
			record = { schemaVersion: DELIVERY_SCHEMA, ...identity, firstJobId: input.jobId, firstClaimId: input.claimId,
				firstEpoch: input.epoch, dedupKey, evidenceSha256, deliveryStatus: "pending", boardRef: null }
			await persistReceipt(target, record)
		}
		if (record.deliveryStatus !== "delivered" || !record.boardRef) {
			const marker = `hc-repository-result-v1:${dedupKey}`
			const comment = `[${marker}] ${CURL_FIXED_ADVISORY}: already-fixed in ${CURL_PRIVATE_SOURCE_REVISION} (tree ${CURL_CANDIDATE_TREE_SHA}); candidate ${input.candidateSha256}; protected evidence ${input.verificationSha256}; evaluator ${CURL_EVALUATOR_DIGEST}. Job ${record.firstJobId}, claim ${record.firstClaimId}, epoch ${record.firstEpoch}. No public PR was created.`
			await ensureBoardComment(marker, comment, board, lock)
			record = { ...record, deliveryStatus: "delivered", boardRef: `${BOARD_API_URL}/cards/${BOARD_CARD_ID}#${marker}` }
			await persistReceipt(target, record)
		}
		return { accepted: true, evidenceSha256: record.evidenceSha256, boardRef: record.boardRef! }
	} finally {
		await lock.close()
	}
}

async function persistReceipt(target: string, record: PrivateDeliveryRecord): Promise<void> {
	const temp = `${target}.${randomUUID()}.tmp`
	const bytes = Buffer.from(`${JSON.stringify(record)}\n`)
	const fd = await fs.promises.open(temp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600)
	try { await fd.chmod(0o600); await fd.writeFile(bytes); await fd.sync() } finally { await fd.close() }
	await fs.promises.rename(temp, target)
}

async function ensureBoardComment(marker: string, comment: string, board: CurlPrivateBoardTransport, lock: fs.promises.FileHandle): Promise<void> {
	const find = async (): Promise<boolean> => {
		return await board.hasMarker(marker, lock)
	}
	if (await find()) return
	try { await board.addComment(comment, lock) }
	catch {
		if (await find()) return
		try { await board.addComment(comment, lock) }
		catch { if (await find()) return; throw new Error("private board delivery is pending reconciliation") }
	}
	if (!await find()) throw new Error("private board comment was not verified after delivery")
}

function fixedBoardTransport(): CurlPrivateBoardTransport {
	return {
		async hasMarker(marker, lock) {
		let cursor: string | undefined
		for (let page = 0; page < 10; page++) {
			const args = [BOARD_CLI_PATH, "card", BOARD_CARD_ID, "--json", "--visao", "historico", "--limite", "200", "--url", BOARD_API_URL,
				...(cursor ? ["--cursor", cursor] : [])]
				const parsed = parseCliJson(await runBoardCli(args, lock))
			const events = Array.isArray(parsed.eventos) ? parsed.eventos : []
			if (events.some((item) => item && typeof item === "object" && String((item as Record<string, unknown>).detalhe ?? "").includes(marker))) return true
			const next = parsed.proximo_cursor
			if (!next) return false
			if (typeof next !== "string" || next.length > 512) throw new Error("private board history cursor is invalid")
			cursor = next
		}
		throw new Error("private board history exceeds the bounded delivery reconciliation window")
		},
		async addComment(comment, lock) {
			const args = [BOARD_CLI_PATH, "comentar", BOARD_CARD_ID, comment, "--autor", BOARD_AUTHOR, "--url", BOARD_API_URL]
			await runBoardCli(args, lock)
		},
	}
}

async function runBoardCli(args: string[], lock: fs.promises.FileHandle): Promise<string> {
	return await new Promise((resolve, reject) => {
		const child = spawn(process.execPath, args, { cwd: path.dirname(BOARD_CLI_PATH), shell: false, detached: process.platform !== "win32",
			stdio: ["ignore", "pipe", "ignore", lock.fd], env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: os.homedir(),
				...(process.env.AGENT_BOARD_KEY ? { AGENT_BOARD_KEY: process.env.AGENT_BOARD_KEY } : {}),
				AGENT_BOARD_URL: BOARD_API_URL, AGENT_BOARD_AUTHOR: BOARD_AUTHOR } })
		let output = "", bytes = 0, settled = false
		const finish = (error?: Error, code?: number | null) => { if (settled) return; settled = true; clearTimeout(timer); error ? reject(error) : code === 0 ? resolve(output) : reject(new Error("private board CLI failed")) }
		const timer = setTimeout(() => { try { if (child.pid) process.kill(-child.pid, "SIGTERM") } catch { /* process already exited */ }; finish(new Error("private board CLI timed out")) }, 20_000)
		timer.unref()
		child.stdout?.on("data", (chunk: Buffer) => { bytes += chunk.length; if (bytes > 64 * 1024) { try { if (child.pid) process.kill(-child.pid, "SIGKILL") } catch { /* process already exited */ }; finish(new Error("private board response exceeds its bound")); return }; output += chunk.toString("utf8") })
		child.once("error", () => finish(new Error("private board CLI could not start")))
		child.once("close", (code) => finish(undefined, code))
	})
}

async function acquirePrivateDeliveryLock(lock: fs.promises.FileHandle): Promise<void> {
	await new Promise<void>((resolve, reject) => {
		const child = spawn("/usr/bin/flock", ["-n", "-x", "3"], { shell: false, stdio: ["ignore", "ignore", "ignore", lock.fd] })
		let settled = false
		child.once("error", () => { if (!settled) { settled = true; reject(new Error("private Curl delivery lock helper could not start")) } })
		child.once("close", (code) => {
			if (settled) return
			settled = true
			if (code === 0) resolve()
			else reject(new Error("private Curl delivery is pending another reconciler"))
		})
	})
}

function parseCliJson(value: string): Record<string, unknown> {
	let parsed: unknown
	try { parsed = JSON.parse(value) } catch { throw new Error("private board response is invalid JSON") }
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("private board response has an invalid shape")
	return parsed as Record<string, unknown>
}

function canonical(value: Record<string, unknown>): string {
	return JSON.stringify(Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))))
}

function sha256(value: string | Buffer): string { return createHash("sha256").update(value).digest("hex") }
