import assert from "node:assert/strict"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { RepositoryCampaignStore,
	type RepositoryCampaignDefinition } from "../repository-campaigns.js"
import { BUILTIN_REPOSITORY_PIPELINE_ADAPTER_FACTORIES,
	bindRepositoryWorkerRegistrations, loadRepositoryWorkerRegistrations,
	type RepositoryWorkerRegistration } from "../repository-worker-registry.js"
import { CURL_CAMPAIGN_POLICY, CURL_CAMPAIGN_POLICY_SHA256,
	CURL_PRIVATE_RUNTIME_ADAPTER_ID } from "../repository-curl-runtime.js"
import { CURL_EVALUATOR_DIGEST, CURL_PRIVATE_SOURCE_REVISION,
	CURL_WORKER_DIGEST } from "../repository-curl-evaluator.js"
import { runMain, type SuiteTest } from "../../test-runner.js"

const qualified = { sourceAudited: true, workerQualified: true,
	recipeQualified: true, evaluatorQualified: true,
	modelApproved: true, dataApproved: true, accessApproved: true }
const definition: RepositoryCampaignDefinition = { id: "fixture-repo",
	name: "Fixture", repositoryId: "fixture-repo", repository: "Capsize/Fixture",
	sourceRevision: "a".repeat(40), policySha256: "d".repeat(64),
		workerProfile: "fixture-worker", recipeDigest: "b".repeat(64),
	evaluatorDigest: "c".repeat(64), model: "meta/muse-spark-1.3-contributor",
		dataAccessProfile: "sanitized-advisory-only", qualification: qualified }
const registration: RepositoryWorkerRegistration = { campaignId: definition.id,
	repositoryId: definition.repositoryId!, repository: definition.repository!,
	sourceRevision: definition.sourceRevision!,
		policySha256: definition.policySha256!,
			workerProfile: definition.workerProfile!,
	recipeDigest: definition.recipeDigest!,
		evaluatorDigest: definition.evaluatorDigest!, model: definition.model!,
			profileId: "muse-spark-contributor",
	pipelineAdapterId: "fixture-pipeline", executionKind: "live-cve",
		reservation: { micros: 10_000, tokens: 10_000 } }

async function testOwnerOnlyRegistryLoadsAndBindsOnlyExactCodeOwnedFactory(): Promise<void> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "hcl-reg-"))
	try {
		const file = path.join(root, "repository-workers.json")
		await fs.writeFile(file, JSON.stringify({ schemaVersion: 1,
			registrations: [registration] }), { mode: 0o600 })
		await fs.chmod(file, 0o600)
		const rows = await loadRepositoryWorkerRegistrations(file)
		assert.equal(rows.length, 1)
		const factories = new Map([ ["fixture-pipeline",
			(item: RepositoryWorkerRegistration) => ({
			workerProfile: item.workerProfile, recipeDigest: item.recipeDigest,
				evaluatorDigest: item.evaluatorDigest, model: item.model,
			executionKind: item.executionKind, reservation: item.reservation,
			async lookupAdvisory(): Promise<never> { throw new Error("offline registry fixture does not dispatch") },
			async prepareWorkspace(): Promise<never> { throw new Error("offline registry fixture does not dispatch") },
			async evaluate(): Promise<never> { throw new Error("offline registry fixture does not dispatch") },
			async deliverPrivate(): Promise<never> { throw new Error("offline registry fixture does not dispatch") },
		})] ])
		const workers = bindRepositoryWorkerRegistrations([definition], rows,
			factories)
		assert.equal(workers.length, 1)
		assert.throws(() => bindRepositoryWorkerRegistrations([{ ...definition,
			sourceRevision: "e".repeat(40) }], rows, factories), /does not match/)
		assert.throws(() => bindRepositoryWorkerRegistrations([definition], rows,
			new Map()), /does not match/)
	} finally { await fs.rm(root, { recursive: true, force: true }) }
}

async function testRegistryRejectsWeakPermissionsAndBrowserExecutableFields(): Promise<void> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "hcl-reg-"))
	try {
		const file = path.join(root, "repository-workers.json")
		await fs.writeFile(file, JSON.stringify({ schemaVersion: 1,
			registrations: [registration] }), { mode: 0o600 })
		await fs.chmod(file, 0o644)
		await assert.rejects(() => loadRepositoryWorkerRegistrations(file),
			/owner-only/)
		await fs.chmod(file, 0o600)
		await fs.writeFile(file, JSON.stringify({ schemaVersion: 1,
			registrations: [{ ...registration, command: "touch /tmp/owned" }] }),
				{ mode: 0o600 })
		await assert.rejects(() => loadRepositoryWorkerRegistrations(file), /invalid/)
		assert.deepEqual(await loadRepositoryWorkerRegistrations(path.join(root,
			"missing.json")), [])
	} finally { await fs.rm(root, { recursive: true, force: true }) }
}

async function testBuiltInCurlAdapterReceivesItsPinnedPublicAdvisoryIntake(): Promise<void> {
	const policy = CURL_CAMPAIGN_POLICY
	const approved = { sourceAudited: true, workerQualified: true,
		recipeQualified: true, evaluatorQualified: true,
		modelApproved: true, dataApproved: true, accessApproved: true }
	const exactDefinition: RepositoryCampaignDefinition = {
		id: policy.campaignId, name: "Curl published advisory",
		repositoryId: policy.repositoryId, repository: policy.repository,
		sourceRevision: CURL_PRIVATE_SOURCE_REVISION,
		policySha256: CURL_CAMPAIGN_POLICY_SHA256,
		workerProfile: policy.workerProfile, recipeDigest: CURL_WORKER_DIGEST,
		evaluatorDigest: CURL_EVALUATOR_DIGEST, model: policy.model,
		dataAccessProfile: policy.dataAccessProfile, qualification: approved,
	}
	const exactRegistration: RepositoryWorkerRegistration = {
		campaignId: exactDefinition.id,
		repositoryId: exactDefinition.repositoryId!,
		repository: exactDefinition.repository!,
		sourceRevision: exactDefinition.sourceRevision!,
		policySha256: exactDefinition.policySha256!,
		workerProfile: exactDefinition.workerProfile!,
		recipeDigest: exactDefinition.recipeDigest!,
		evaluatorDigest: exactDefinition.evaluatorDigest!,
		model: exactDefinition.model!, profileId: policy.profileId,
		pipelineAdapterId: CURL_PRIVATE_RUNTIME_ADAPTER_ID,
		executionKind: "live-cve",
		reservation: { micros: 8_000, tokens: 72_000 },
	}
	const root = await fs.mkdtemp(
		path.join(os.tmpdir(), "hcl-curl-intake-registration-"),
	)
	try {
		const store = new RepositoryCampaignStore(
			path.join(root, "state.json"), [exactDefinition],
		)
		const [worker] = bindRepositoryWorkerRegistrations(
			[exactDefinition], [exactRegistration],
			BUILTIN_REPOSITORY_PIPELINE_ADAPTER_FACTORIES, { store },
		)
		assert.ok(worker?.advisoryIntake,
			"the built-in Curl worker must have an intake poller")
		assert.equal(worker.advisoryIntake.publicBaseRevision,
			"ce57339379d82d29637b4752979e54128b6b2348")
		assert.deepEqual(worker.advisoryIntake.supportedAdvisoryIds, [],
			"the read-only qualification worker must not claim OSV candidates as repair work")
		const observation = await store.observePublishedAdvisory({ campaignId: exactDefinition.id,
			publicBaseRevision: worker.advisoryIntake.publicBaseRevision, advisoryId: "CVE-2026-92390",
			snapshotSha256: "e".repeat(64), eligible: false })
		assert.equal(observation.queued, false)
		assert.equal(observation.record.disposition, "unsupported-profile")
		assert.equal(((await store.status()) as { jobs: unknown[] }).jobs.length, 0)
	} finally { await fs.rm(root, { recursive: true, force: true }) }
}

const tests: readonly SuiteTest[] = [
	["private worker registry binds exact campaign identity to code-owned pipeline factories", testOwnerOnlyRegistryLoadsAndBindsOnlyExactCodeOwnedFactory],
	["worker registry rejects weak permissions, unknown command fields, and absent configuration stays empty", testRegistryRejectsWeakPermissionsAndBrowserExecutableFields],
	["the compiled Curl adapter is wired to its pinned published-advisory intake",
		testBuiltInCurlAdapterReceivesItsPinnedPublicAdvisoryIntake],
]

await runMain("repository-worker-registry", tests)
