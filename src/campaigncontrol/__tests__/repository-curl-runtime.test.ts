import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { execFileSync } from "node:child_process"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { CURL_CAMPAIGN_POLICY, CURL_CAMPAIGN_POLICY_SHA256, CURL_PRIVATE_RUNTIME_ADAPTER_ID,
	CURL_RUNTIME_CONFIG_PATH, createCurlRepositoryPipelineAdapters, validateCurlRuntimeConfig, writePrivateCurlDeliveryReceipt } from "../repository-curl-runtime.js"
import { CURL_CANDIDATE_TREE_SHA, CURL_EVALUATOR_DIGEST, CURL_FIXED_ADVISORY, CURL_PRIVATE_SOURCE_REVISION,
	CURL_WORKER_DIGEST } from "../repository-curl-evaluator.js"
import { verifyPinnedGitWorktreeTree } from "../repository-source-tree.js"
import { RepositoryCampaignStore, type RepositoryCampaignDefinition } from "../repository-campaigns.js"
import type { RepositoryWorkerRegistration } from "../repository-worker-registry.js"
import { runMain, type SuiteTest } from "../../test-runner.js"

const approved = { sourceAudited: true, workerQualified: true, recipeQualified: true, evaluatorQualified: true,
	modelApproved: true, dataApproved: true, accessApproved: true }
const definition: RepositoryCampaignDefinition = {
	id: "curl-maintenance", name: "Curl published advisory", repositoryId: "curl-maintenance", repository: "Capsize-Games/curl-maintenance",
	sourceRevision: CURL_PRIVATE_SOURCE_REVISION, policySha256: CURL_CAMPAIGN_POLICY_SHA256,
	workerProfile: "curl-published-advisory-v1", recipeDigest: CURL_WORKER_DIGEST, evaluatorDigest: CURL_EVALUATOR_DIGEST,
	model: "meta/muse-spark-1.3-contributor", dataAccessProfile: "public-upstream-source-and-published-advisory-only", qualification: approved,
}
const registration: RepositoryWorkerRegistration = {
	campaignId: definition.id, repositoryId: definition.repositoryId!, repository: definition.repository!, sourceRevision: definition.sourceRevision!,
	policySha256: definition.policySha256!, workerProfile: definition.workerProfile!, recipeDigest: definition.recipeDigest!,
	evaluatorDigest: definition.evaluatorDigest!, model: definition.model!, profileId: "muse-spark-contributor",
	pipelineAdapterId: CURL_PRIVATE_RUNTIME_ADAPTER_ID, executionKind: "live-cve", reservation: { micros: 8_000, tokens: 72_000 },
}

async function testFactoryBindsOnlyTheCompiledOwnerPolicy(): Promise<void> {
	assert.equal(CURL_CAMPAIGN_POLICY_SHA256.length, 64)
	assert.equal(CURL_CAMPAIGN_POLICY.sourceRevision, CURL_PRIVATE_SOURCE_REVISION)
	assert.equal(CURL_CAMPAIGN_POLICY.evaluatorDigest, CURL_EVALUATOR_DIGEST)
	assert.equal(CURL_CAMPAIGN_POLICY.limits.lifetimeMicros, 20_000)
	assert.equal(CURL_CAMPAIGN_POLICY.limits.lifetimeTokens, 108_000)
	assert.equal(CURL_CAMPAIGN_POLICY.limits.jobMicros, 8_000)
	assert.equal(CURL_CAMPAIGN_POLICY.limits.jobTokens, 72_000)
	const store = { path: path.join(os.tmpdir(), "curl-campaign-test.json") } as RepositoryCampaignStore
	const adapters = createCurlRepositoryPipelineAdapters(registration, definition, { store })
	assert.equal(adapters.workerProfile, definition.workerProfile)
	assert.equal(adapters.executionKind, "live-cve")
	assert.deepEqual(adapters.reservation, registration.reservation)
	assert.throws(() => createCurlRepositoryPipelineAdapters({ ...registration, repository: "attacker/repo" }, definition, { store }), /compiled owner-qualified profile/)
	assert.throws(() => createCurlRepositoryPipelineAdapters({ ...registration, profileId: "other-profile" }, definition, { store }), /compiled owner-qualified profile/)
	assert.throws(() => createCurlRepositoryPipelineAdapters({ ...registration, policySha256: "f".repeat(64) }, definition, { store }), /compiled owner-qualified profile/)
	assert.throws(() => createCurlRepositoryPipelineAdapters(registration, { ...definition, dataAccessProfile: "broad-host-access" }, { store }), /compiled owner-qualified profile/)
}

async function testRuntimeConfigHasOneFixedOwnerSchema(): Promise<void> {
	assert.match(CURL_RUNTIME_CONFIG_PATH, /\.local\/state\/headlesscode\/repository-runtime\/runtime\.json$/)
	const base = { schemaVersion: 1, profilePath: "/home/joe/.local/state/headlesscode/repository-runtime/profile/repository-worker.yaml",
		profileSha256: "bf8c90c394400e1df6cfbe4063666c918aabf613ab8246006f7757b1355ee358",
		evidenceStorageDir: "/home/joe/.local/state/headlesscode/repository-runtime/evidence-store",
		evidenceConfigDir: "/home/joe/.local/state/headlesscode/repository-runtime/evidence-config",
		evidenceSocketPath: "/run/user/1000/hc-cve-evidence.sock",
		controlStateDir: "/home/joe/.local/state/headlesscode/repository-runtime/control-state",
		controlSocketDir: "/run/user/1000/hcctl/{session}", brokerBindHost: "127.0.0.1",
		openshellXdgConfigHome: "/home/joe/Projects/headlesscode/.worktrees/ux/.headlesscode/scratch/rsi-muse/xdg-user",
		openshellXdgStateHome: "/home/joe/Projects/headlesscode/.worktrees/ux/.headlesscode/scratch/rsi-muse/xdg-state" }
	assert.throws(() => validateCurlRuntimeConfig({ ...base, arbitraryPath: "/tmp" }), /unknown or missing fields/)
	assert.throws(() => validateCurlRuntimeConfig({ ...base, brokerBindHost: "0.0.0.0" }), /brokerBindHost differs/)
	assert.throws(() => validateCurlRuntimeConfig({ ...base, schemaVersion: 2 }), /schemaVersion differs/)
}

async function testPinnedSourceVerifierChecksActualBytesEvenWhenGitIndexHidesChanges(): Promise<void> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "hcl-source-tree-"))
	try {
		execFileSync("git", ["init", "-q", root])
		execFileSync("git", ["-C", root, "config", "user.email", "fixture@example.invalid"])
		execFileSync("git", ["-C", root, "config", "user.name", "Fixture"])
		await fs.writeFile(path.join(root, "tracked.txt"), "pinned source\n")
		execFileSync("git", ["-C", root, "add", "tracked.txt"])
		execFileSync("git", ["-C", root, "commit", "-qm", "fixture"])
		const revision = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim()
		const tree = execFileSync("git", ["-C", root, "rev-parse", "HEAD^{tree}"], { encoding: "utf8" }).trim()
		assert.equal((await verifyPinnedGitWorktreeTree({ worktree: root, revision, expectedTreeSha: tree })).treeSha, tree)
		execFileSync("git", ["-C", root, "update-index", "--assume-unchanged", "tracked.txt"])
		await fs.writeFile(path.join(root, "tracked.txt"), "changed bytes with unchanged index bit\n")
		await assert.rejects(() => verifyPinnedGitWorktreeTree({ worktree: root, revision, expectedTreeSha: tree }), /bytes differ/)
		await fs.writeFile(path.join(root, "tracked.txt"), "pinned source\n")
		await fs.writeFile(path.join(root, "unexpected.txt"), "not part of the pinned tree\n")
		await assert.rejects(() => verifyPinnedGitWorktreeTree({ worktree: root, revision, expectedTreeSha: tree }), /unexpected file/)
	} finally { await fs.rm(root, { recursive: true, force: true }) }
}

async function testPrivateDeliveryOutboxReconcilesLostBoardAckAndDeduplicates(): Promise<void> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "hcl-curl-delivery-"))
	try {
		await fs.chmod(root, 0o700)
		let marker = ""
		let writes = 0
		const board = {
			async hasMarker(value: string) { return marker === value },
			async addComment(text: string) {
				writes += 1
				const match = text.match(/\[(hc-repository-result-v1:[a-f0-9]{64})\]/)
				assert.ok(match)
				marker = match![1]!
				if (writes === 1) throw new Error("simulated lost response after committed comment")
			},
		}
		const input = { campaignId: "curl-maintenance", jobId: "00000000-0000-4000-8000-000000000001",
			claimId: "00000000-0000-4000-8000-000000000002", epoch: 4, advisoryId: CURL_FIXED_ADVISORY,
			candidateSha256: "a".repeat(64), verificationSha256: "b".repeat(64), disposition: "already-fixed" as const,
			sourceRevision: CURL_PRIVATE_SOURCE_REVISION, sourceTreeSha256: CURL_CANDIDATE_TREE_SHA }
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
		const receipt = JSON.parse(await fs.readFile(path.join(directory, files.find((name) => name.endsWith(".json"))!), "utf8"))
		assert.equal(receipt.deliveryStatus, "delivered")
		assert.equal(receipt.boardRef, first.boardRef)
		assert.match(receipt.boardRef, /^http:\/\/127\.0\.0\.1:8078\/api\/cards\/1c25cecf-e5e8-4b68-b6fd-5d6ad25426d7#hc-repository-result-v1:[a-f0-9]{64}$/)
	} finally { await fs.rm(root, { recursive: true, force: true }) }
}

async function testContainedCollectorStartsBeforeProfileAndClosesWithWorkspace(): Promise<void> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "hcl-curl-session-"))
	const events: string[] = []
	const sessionId = "curl-campaign-00000000-0000-4000-8000-000000000010"
	const claim = { claimId: "00000000-0000-4000-8000-000000000011", epoch: 2, job: {
		id: "00000000-0000-4000-8000-000000000012", campaignId: "curl-maintenance", advisoryId: CURL_FIXED_ADVISORY,
		purpose: "qualification", reservedMicros: 8_000, reservedTokens: 72_000,
	} } as any
	const store = { path: path.join(root, "store.json"), async assertClaimCurrent() { events.push("assert-claim") } } as unknown as RepositoryCampaignStore
	const asOfMs = Date.now()
	const authority = { mode: "fleet-v2", available: true, canAdmit: true, globalEnabled: true, campaignId: "fleet-security-watch",
		asOfMs, repositoryCampaignId: "curl-maintenance", repositoryId: "curl-maintenance", repository: "Capsize-Games/curl-maintenance",
		sourceRevision: CURL_PRIVATE_SOURCE_REVISION, policySha256: CURL_CAMPAIGN_POLICY_SHA256, model: "meta/muse-spark-1.3-contributor",
		profileId: "muse-spark-contributor", repositoryEnabled: true, repositoryEpoch: 3, runId: "fleet-run", controlEpoch: 9,
		monthly: { limitMicros: 1_000_000 }, campaignLifetime: { limitMicros: 20_000, limitTokens: 108_000 },
		repositoryLifetime: { limitMicros: 20_000, limitTokens: 108_000 } } as any
	const key = "A".repeat(43)
	const keyIdentity = createHash("sha256").update(key).digest("hex")
	const profile = { evidenceSocketPath: "/run/user/1000/hc-cve-evidence.sock",
		evidencePublicKeyFingerprint: "sha256:collector-test" } as any
	const worktree = path.join(root, sessionId)
	await fs.mkdir(worktree)
	const runtimeConfig = { schemaVersion: 1, profilePath: "/home/joe/.local/state/headlesscode/repository-runtime/profile/repository-worker.yaml",
		profileSha256: "bf8c90c394400e1df6cfbe4063666c918aabf613ab8246006f7757b1355ee358",
		evidenceStorageDir: "/home/joe/.local/state/headlesscode/repository-runtime/evidence-store",
		evidenceConfigDir: "/home/joe/.local/state/headlesscode/repository-runtime/evidence-config",
		evidenceSocketPath: "/run/user/1000/hc-cve-evidence.sock",
		controlStateDir: "/home/joe/.local/state/headlesscode/repository-runtime/control-state",
		controlSocketDir: "/run/user/1000/hcctl/{session}", brokerBindHost: "127.0.0.1",
		openshellXdgConfigHome: "/home/joe/Projects/headlesscode/.worktrees/ux/.headlesscode/scratch/rsi-muse/xdg-user",
		openshellXdgStateHome: "/home/joe/Projects/headlesscode/.worktrees/ux/.headlesscode/scratch/rsi-muse/xdg-state" } as const
	try {
		const adapters = createCurlRepositoryPipelineAdapters(registration, definition, { store }, {
			projectRoot: root, sourceRoot: root, loadRuntimeConfig: () => runtimeConfig,
			readBudgetAuthority: async () => authority,
			readCredential: async () => ({ apiKey: key, keyIdentity }), readKeyIdentity: async () => keyIdentity,
			createWorktree: async () => worktree,
			removeWorktree: async (_source, target) => { events.push("remove-worktree"); await fs.rm(target, { recursive: true, force: true }) },
			startEvidenceService: async (options) => {
				events.push(`start-evidence:${options.sessionIds[0]}`)
				assert.equal(options.socketPath, profile.evidenceSocketPath)
				return { collector: { publicKey: { keyId: profile.evidencePublicKeyFingerprint } }, async close() { events.push("close-evidence") } } as any
			},
			resolveProfile: () => { events.push("resolve-profile"); return profile },
			validateSupervisorRoots: () => { events.push("validate-supervisor") },
			verifyTree: async () => ({ treeSha: CURL_CANDIDATE_TREE_SHA, fileCount: 1, totalBytes: 1 }),
			runWorker: async (input) => { events.push("run-worker");
				assert.equal(input.launch.hostRuntimeEnv?.XDG_CONFIG_HOME, runtimeConfig.openshellXdgConfigHome)
				assert.equal(input.launch.hostRuntimeEnv?.XDG_STATE_HOME, runtimeConfig.openshellXdgStateHome)
				assert.equal(input.launch.hostRuntimeEnv?.OPENROUTER_API_KEY, undefined)
				return { ok: true, exitCode: 0, durationMs: 1, outputSha256: "c".repeat(64),
				receipt: {} as any, actualMicros: 0, actualTokens: 0 } },
		})
		const prepared = await adapters.prepareWorkspace({ definition, claim, advisory: { advisoryId: CURL_FIXED_ADVISORY,
			sourceUrl: `https://security-tracker.debian.org/tracker/${CURL_FIXED_ADVISORY}`, snapshotSha256: "d".repeat(64),
			summary: "fixed facts", affectedRange: "source range", fixedVersion: null, verificationCheckIds: ["muse-spark-contributor"] } })
		assert.ok(events.indexOf(`start-evidence:${sessionId}`) >= 0)
		assert.ok(events.indexOf("start-evidence:" + sessionId) < events.indexOf("resolve-profile"))
		assert.ok(events.indexOf("resolve-profile") < events.indexOf("validate-supervisor"))
		const result = await prepared.runContained()
		assert.equal(result.actualMicros, 0)
		await prepared.cleanup?.()
		assert.deepEqual(events.slice(-3), ["run-worker", "close-evidence", "remove-worktree"])
	} finally { await fs.rm(root, { recursive: true, force: true }) }
}

async function testDeliveryFlockPersistsOnParentDescriptorUntilClosed(): Promise<void> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "hcl-curl-flock-"))
	const lockPath = path.join(root, "dedup.lock")
	const parent = await fs.open(lockPath, "w+")
	const acquire = (fd: number) => execFileSync("/usr/bin/flock", ["-n", "-x", "3"], {
		stdio: ["ignore", "ignore", "ignore", fd],
	})
	const contend = () => execFileSync("/usr/bin/flock", ["-n", "-x", lockPath, "/usr/bin/true"])
	try {
		acquire(parent.fd)
		assert.throws(() => contend(), /flock|status 1|exit code 1/i)
		await parent.close()
		contend()
	} finally {
		await parent.close().catch(() => undefined)
		await fs.rm(root, { recursive: true, force: true })
	}
}

const tests: readonly SuiteTest[] = [
	["Curl factory binds only the compiled campaign, repository, model, source, policy, and caps", testFactoryBindsOnlyTheCompiledOwnerPolicy],
	["runtime config rejects extra fields, schema changes, and non-loopback binds", testRuntimeConfigHasOneFixedOwnerSchema],
	["pinned source verification detects changed bytes despite assume-unchanged and rejects untracked files", testPinnedSourceVerifierChecksActualBytesEvenWhenGitIndexHidesChanges],
	["private delivery reconciles a lost board acknowledgement and reuses one immutable receipt", testPrivateDeliveryOutboxReconcilesLostBoardAckAndDeduplicates],
	["contained collector starts before profile resolution and closes with the private worker workspace", testContainedCollectorStartsBeforeProfileAndClosesWithWorkspace],
	["delivery flock remains held by the parent descriptor until the transaction closes it", testDeliveryFlockPersistsOnParentDescriptorUntilClosed],
]

await runMain("repository-curl-runtime", tests)
