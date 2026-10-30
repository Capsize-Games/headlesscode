import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { CURL_CAMPAIGN_POLICY, CURL_CAMPAIGN_POLICY_SHA256,
	CURL_PRIVATE_RUNTIME_ADAPTER_ID,
	CURL_RUNTIME_CONFIG_PATH, createCurlRepositoryPipelineAdapters,
		validateCurlRuntimeConfig,
			writePrivateCurlDeliveryReceipt } from "../repository-curl-runtime.js"
import { CURL_CANDIDATE_TREE_SHA, CURL_EVALUATOR_DIGEST, CURL_FIXED_ADVISORY,
	CURL_PRIVATE_SOURCE_REVISION,
	CURL_WORKER_DIGEST } from "../repository-curl-evaluator.js"
import { RepositoryCampaignStore,
	type ClaimedRepositoryJob, type RepositoryCampaignDefinition } from "../repository-campaigns.js"
import { CAMPAIGN_CONTROL_FILE } from "../paths.js"
import type { ContainedRuntimeProfile } from "../../security/profile.js"
import type { ContainedEvidenceService } from "../../security/contained-evidence-service.js"
import type { FleetRepositoryBudgetSnapshot } from "../../rsi/fleet-repository-budget-ledger.js"
import type { OpenRouterBrokerReceipt } from "../../rsi/inference-broker.js"
import type { RepositoryWorkerRegistration } from "../repository-worker-registry.js"
import { runMain, type SuiteTest } from "../../test-runner.js"

const approved = { sourceAudited: true, workerQualified: true,
	recipeQualified: true, evaluatorQualified: true,
	modelApproved: true, dataApproved: true, accessApproved: true }
const definition: RepositoryCampaignDefinition = {
	id: "curl-maintenance", name: "Curl published advisory",
		repositoryId: "curl-maintenance",
			repository: "Capsize-Games/curl-maintenance",
	sourceRevision: CURL_PRIVATE_SOURCE_REVISION,
		policySha256: CURL_CAMPAIGN_POLICY_SHA256,
	workerProfile: "curl-published-advisory-v1",
		recipeDigest: CURL_WORKER_DIGEST, evaluatorDigest: CURL_EVALUATOR_DIGEST,
	model: "meta/muse-spark-1.3-contributor",
		dataAccessProfile: "public-upstream-source-and-published-advisory-only",
			qualification: approved,
}
const registration: RepositoryWorkerRegistration = {
	campaignId: definition.id, repositoryId: definition.repositoryId!,
		repository: definition.repository!,
			sourceRevision: definition.sourceRevision!,
	policySha256: definition.policySha256!,
		workerProfile: definition.workerProfile!,
			recipeDigest: definition.recipeDigest!,
	evaluatorDigest: definition.evaluatorDigest!, model: definition.model!,
		profileId: "muse-spark-contributor",
	pipelineAdapterId: CURL_PRIVATE_RUNTIME_ADAPTER_ID,
		executionKind: "live-cve", reservation: { micros: 8_000, tokens: 72_000 },
}

function rejectAdapter(
	value: RepositoryWorkerRegistration,
	definitionValue: RepositoryCampaignDefinition,
	store: RepositoryCampaignStore,
): void {
	assert.throws(() => createCurlRepositoryPipelineAdapters(value, definitionValue, { store }), /compiled owner-qualified profile/)
}

function rejectRuntimeConfig(base: object, change: object, expected: RegExp): void {
	assert.throws(() => validateCurlRuntimeConfig({ ...base, ...change }), expected)
}

async function testFactoryBindsOnlyTheCompiledOwnerPolicy(): Promise<void> {
	assert.equal(CURL_CAMPAIGN_POLICY_SHA256.length, 64)
	assert.equal(CURL_CAMPAIGN_POLICY.sourceRevision, CURL_PRIVATE_SOURCE_REVISION)
	assert.equal(CURL_CAMPAIGN_POLICY.evaluatorDigest, CURL_EVALUATOR_DIGEST)
	assert.equal(CURL_CAMPAIGN_POLICY.limits.lifetimeMicros, 20_000)
	assert.equal(CURL_CAMPAIGN_POLICY.limits.lifetimeTokens, 108_000)
	assert.equal(CURL_CAMPAIGN_POLICY.limits.jobMicros, 8_000)
	assert.equal(CURL_CAMPAIGN_POLICY.limits.jobTokens, 72_000)
	const store = { path: path.join(os.tmpdir(),
		"curl-campaign-test.json") } as RepositoryCampaignStore
	let authorityPath = ""
	const adapters = createCurlRepositoryPipelineAdapters(registration,
		definition, { store }, { createBudgetAuthorityReader(_definitions, controlPath) {
			authorityPath = controlPath ?? ""
			return async () => { throw new Error("test authority reader is not invoked") }
		} })
	assert.equal(authorityPath, CAMPAIGN_CONTROL_FILE)
	assert.notEqual(authorityPath, store.path, "the Fleet reader must never parse repository-campaign state as control state")
	assert.equal(adapters.workerProfile, definition.workerProfile)
	assert.equal(adapters.executionKind, "live-cve")
	assert.deepEqual(adapters.reservation, registration.reservation)
	rejectAdapter({ ...registration, repository: "attacker/repo" }, definition, store)
	rejectAdapter({ ...registration, profileId: "other-profile" }, definition, store)
	rejectAdapter({ ...registration, policySha256: "f".repeat(64) }, definition, store)
	rejectAdapter(registration, { ...definition, dataAccessProfile: "broad-host-access" }, store)
}

async function testRuntimeConfigHasOneFixedOwnerSchema(): Promise<void> {
	assert.match(CURL_RUNTIME_CONFIG_PATH,
		/\.local\/state\/headlesscode\/repository-runtime\/runtime\.json$/)
	const base = { schemaVersion: 1,
		profilePath: "/home/joe/.local/state/headlesscode/repository-runtime/profile/repository-worker.yaml",
		profileSha256: "bf8c90c394400e1df6cfbe4063666c918aabf613ab8246006f7757b1355ee358",
		evidenceStorageDir: "/home/joe/.local/state/headlesscode/repository-runtime/evidence-store",
		evidenceConfigDir: "/home/joe/.local/state/headlesscode/repository-runtime/evidence-config",
		evidenceSocketPath: "/home/joe/.local/state/headlesscode/repository-runtime/evidence-socket/evidence.sock",
		controlStateDir: "/home/joe/.local/state/headlesscode/repository-runtime/control-state",
		controlSocketDir: "/run/user/1000/hcctl/{session}",
			brokerBindHost: "127.0.0.1",
		openshellXdgConfigHome: "/home/joe/Projects/headlesscode/.worktrees/ux/.headlesscode/scratch/rsi-muse/xdg-user",
		openshellXdgStateHome: "/home/joe/Projects/headlesscode/.worktrees/ux/.headlesscode/scratch/rsi-muse/xdg-state" }
	rejectRuntimeConfig(base, { arbitraryPath: "/tmp" }, /unknown or missing fields/)
	rejectRuntimeConfig(base, { brokerBindHost: "0.0.0.0" }, /brokerBindHost differs/)
	rejectRuntimeConfig(base, { schemaVersion: 2 }, /schemaVersion differs/)
}

async function testPrivateDeliveryOutboxReconcilesLostBoardAckAndDeduplicates(): Promise<void> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "hcl-curl-delivery-"))
	try {
		await fs.chmod(root, 0o700)
		let marker = ""
		let writes = 0
		const board = {
			async hasMarker(value: string): Promise<boolean> { return marker === value },
			async addComment(text: string): Promise<void> {
				writes += 1
				const match = text.match(/\[(hc-repository-result-v1:[a-f0-9]{64})\]/)
				assert.ok(match)
				marker = match![1]!
				if (writes === 1) throw new Error("simulated lost response after committed comment")
			},
		}
		const input = { campaignId: "curl-maintenance",
			jobId: "00000000-0000-4000-8000-000000000001",
			claimId: "00000000-0000-4000-8000-000000000002", epoch: 4,
				advisoryId: CURL_FIXED_ADVISORY,
			candidateSha256: "a".repeat(64), verificationSha256: "b".repeat(64),
				disposition: "already-fixed" as const,
			sourceRevision: CURL_PRIVATE_SOURCE_REVISION,
				sourceTreeSha256: CURL_CANDIDATE_TREE_SHA }
		const storePath = path.join(root, "repository-campaigns.json")
		const first = await writePrivateCurlDeliveryReceipt(storePath, input, board)
		const second = await writePrivateCurlDeliveryReceipt(storePath, input, board)
		assert.equal(first.accepted, true)
		assert.equal(second.evidenceSha256, first.evidenceSha256)
		assert.equal(first.boardRef, second.boardRef)
		assert.equal(writes, 1)
		const directory = path.join(root, "repository-delivery")
		const files = await fs.readdir(directory)
		assert.equal(files.filter((name) => name.endsWith(".json")).length, 1)
		const receipt = JSON.parse(await fs.readFile(path.join(directory,
			files.find((name) => name.endsWith(".json"))!), "utf8"))
		assert.equal(receipt.deliveryStatus, "delivered")
		assert.equal(receipt.boardRef, first.boardRef)
		assert.match(receipt.boardRef,
			/^http:\/\/127\.0\.0\.1:8078\/api\/cards\/1c25cecf-e5e8-4b68-b6fd-5d6ad25426d7#hc-repository-result-v1:[a-f0-9]{64}$/)
	} finally { await fs.rm(root, { recursive: true, force: true }) }
}

async function testContainedCollectorStartsBeforeProfileAndClosesWithWorkspace(): Promise<void> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "hcl-curl-session-"))
	const events: string[] = []
	const sessionId = "curl-campaign-00000000-0000-4000-8000-000000000010"
	const claim = { claimId: "00000000-0000-4000-8000-000000000011", epoch: 2,
		job: {
		id: "00000000-0000-4000-8000-000000000012", campaignId: "curl-maintenance",
			advisoryId: CURL_FIXED_ADVISORY,
		purpose: "qualification", reservedMicros: 8_000, reservedTokens: 72_000,
	} } as unknown as ClaimedRepositoryJob
	const store = { path: path.join(root, "store.json"),
		async assertClaimCurrent(): Promise<void> { events.push("assert-claim") } } as unknown as RepositoryCampaignStore
	const asOfMs = Date.now()
	const authority = { mode: "fleet-v2", available: true, canAdmit: true,
		globalEnabled: true, campaignId: "fleet-security-watch",
		asOfMs, repositoryCampaignId: "curl-maintenance",
			repositoryId: "curl-maintenance",
				repository: "Capsize-Games/curl-maintenance",
		sourceRevision: CURL_PRIVATE_SOURCE_REVISION,
			policySha256: CURL_CAMPAIGN_POLICY_SHA256,
				model: "meta/muse-spark-1.3-contributor",
		profileId: "muse-spark-contributor", repositoryEnabled: true,
			repositoryEpoch: 3, runId: "fleet-run", controlEpoch: 9,
		monthly: { limitMicros: 1_000_000 },
			campaignLifetime: { limitMicros: 20_000, limitTokens: 108_000 },
		repositoryLifetime: { limitMicros: 18_000, limitTokens: 90_000 }
	} as unknown as FleetRepositoryBudgetSnapshot
	const key = "A".repeat(43)
	const keyIdentity = createHash("sha256").update(key).digest("hex")
	const profile = { evidenceSocketPath: "/home/joe/.local/state/headlesscode/repository-runtime/evidence-socket/evidence.sock",
		evidencePublicKeyFingerprint: "sha256:collector-test" } as unknown as ContainedRuntimeProfile
	const worktree = path.join(root, sessionId)
	await fs.mkdir(worktree)
	const runtimeConfig = { schemaVersion: 1,
		profilePath: "/home/joe/.local/state/headlesscode/repository-runtime/profile/repository-worker.yaml",
		profileSha256: "bf8c90c394400e1df6cfbe4063666c918aabf613ab8246006f7757b1355ee358",
		evidenceStorageDir: "/home/joe/.local/state/headlesscode/repository-runtime/evidence-store",
		evidenceConfigDir: "/home/joe/.local/state/headlesscode/repository-runtime/evidence-config",
		evidenceSocketPath: "/home/joe/.local/state/headlesscode/repository-runtime/evidence-socket/evidence.sock",
		controlStateDir: "/home/joe/.local/state/headlesscode/repository-runtime/control-state",
		controlSocketDir: "/run/user/1000/hcctl/{session}",
			brokerBindHost: "127.0.0.1",
		openshellXdgConfigHome: "/home/joe/Projects/headlesscode/.worktrees/ux/.headlesscode/scratch/rsi-muse/xdg-user",
		openshellXdgStateHome: "/home/joe/Projects/headlesscode/.worktrees/ux/.headlesscode/scratch/rsi-muse/xdg-state" } as const
	const advisory = { advisoryId: CURL_FIXED_ADVISORY,
		sourceUrl: `https://security-tracker.debian.org/tracker/${CURL_FIXED_ADVISORY}`, snapshotSha256: "d".repeat(64),
		summary: "fixed facts", affectedRange: "source range", fixedVersion: null,
		verificationCheckIds: ["muse-spark-contributor"] }
	try {
		for (const caps of [{ limitMicros: 0, limitTokens: 0 }, { limitMicros: 20_001, limitTokens: 108_001 }]) {
			const blocked = createCurlRepositoryPipelineAdapters(registration, definition, { store }, {
				readBudgetAuthority: async () => ({ ...authority, repositoryLifetime: { ...authority.repositoryLifetime!, ...caps } }),
			})
			await assert.rejects(blocked.prepareWorkspace({ definition, claim, advisory }), /fresh active Fleet v2 repository budget/)
		}
		const adapters = createCurlRepositoryPipelineAdapters(registration,
			definition, { store }, {
			projectRoot: root, sourceRoot: root, loadRuntimeConfig: () => runtimeConfig,
			readBudgetAuthority: async () => authority,
			readCredential: async () => ({ apiKey: key, keyIdentity }),
				readKeyIdentity: async () => keyIdentity,
			createWorktree: async () => worktree,
			removeWorktree: async (_source,
				target) => { events.push("remove-worktree"); await fs.rm(target,
					{ recursive: true, force: true }) },
			startEvidenceService: async (options) => {
				events.push(`start-evidence:${options.sessionIds[0]}`)
				assert.equal(options.socketPath, profile.evidenceSocketPath)
				return { collector: { publicKey: { keyId: profile.evidencePublicKeyFingerprint } } as unknown as ContainedEvidenceService["collector"], sessions: options.sessionIds, configDirectory: runtimeConfig.evidenceConfigDir, async close(): Promise<void> { events.push("close-evidence") } }
			},
			resolveProfile: () => { events.push("resolve-profile"); return profile },
			validateSupervisorRoots: () => { events.push("validate-supervisor") },
			verifyTree: async () => ({ treeSha: CURL_CANDIDATE_TREE_SHA, fileCount: 1, totalBytes: 1 }),
			runWorker: async (input) => { events.push("run-worker");
				assert.equal(input.launch.hostRuntimeEnv?.XDG_CONFIG_HOME, runtimeConfig.openshellXdgConfigHome)
				assert.equal(input.launch.hostRuntimeEnv?.XDG_STATE_HOME, runtimeConfig.openshellXdgStateHome)
				assert.equal(input.launch.hostRuntimeEnv?.OPENROUTER_API_KEY, undefined)
				assert.equal(input.launch.importResults, false)
				assert.equal(input.limits.maxDurationMs, 300_000, "the v2 bridge's hard 300-second grant cap must be respected")
				return { ok: true, exitCode: 0, durationMs: 1, outputSha256: "c".repeat(64),
				receipt: {} as unknown as OpenRouterBrokerReceipt, actualMicros: 0, actualTokens: 0 } },
		})
		const prepared = await adapters.prepareWorkspace({ definition, claim, advisory })
		assert.ok(events.indexOf(`start-evidence:${sessionId}`) >= 0)
		assert.ok(events.indexOf("start-evidence:" + sessionId) < events.indexOf("resolve-profile"))
		assert.ok(events.indexOf("resolve-profile") < events.indexOf("validate-supervisor"))
		const result = await prepared.runContained(new AbortController().signal)
		assert.equal(result.actualMicros, 0)
		await prepared.cleanup?.()
		assert.deepEqual(events.slice(-3), ["run-worker", "close-evidence", "remove-worktree"])
	} finally { await fs.rm(root, { recursive: true, force: true }) }
}

const tests: readonly SuiteTest[] = [
	["Curl factory binds only the compiled campaign, repository, model, source, policy, and caps", testFactoryBindsOnlyTheCompiledOwnerPolicy],
	["runtime config rejects extra fields, schema changes, and non-loopback binds", testRuntimeConfigHasOneFixedOwnerSchema],
	["private delivery reconciles a lost board acknowledgement and reuses one immutable receipt", testPrivateDeliveryOutboxReconcilesLostBoardAckAndDeduplicates],
	["contained collector starts before profile resolution and closes with the private worker workspace", testContainedCollectorStartsBeforeProfileAndClosesWithWorkspace],
]

await runMain("repository-curl-runtime", tests)
