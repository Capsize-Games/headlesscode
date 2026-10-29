import assert from "node:assert/strict"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { RepositoryCampaignStore, type RepositoryCampaignDefinition } from "../repository-campaigns.js"
import { bindRepositoryWorkerRegistrations, loadRepositoryWorkerRegistrations, type RepositoryWorkerRegistration } from "../repository-worker-registry.js"
import { runMain, type SuiteTest } from "../../test-runner.js"

const qualified = { sourceAudited: true, workerQualified: true, recipeQualified: true, evaluatorQualified: true,
	modelApproved: true, dataApproved: true, accessApproved: true }
const definition: RepositoryCampaignDefinition = { id: "fixture-repo", name: "Fixture", repositoryId: "fixture-repo", repository: "Capsize/Fixture",
	sourceRevision: "a".repeat(40), policySha256: "d".repeat(64), workerProfile: "fixture-worker", recipeDigest: "b".repeat(64),
	evaluatorDigest: "c".repeat(64), model: "meta/muse-spark-1.3-contributor", dataAccessProfile: "sanitized-advisory-only", qualification: qualified }
const registration: RepositoryWorkerRegistration = { campaignId: definition.id, repositoryId: definition.repositoryId!, repository: definition.repository!,
	sourceRevision: definition.sourceRevision!, policySha256: definition.policySha256!, workerProfile: definition.workerProfile!,
	recipeDigest: definition.recipeDigest!, evaluatorDigest: definition.evaluatorDigest!, model: definition.model!, profileId: "muse-spark-contributor",
	pipelineAdapterId: "fixture-pipeline", executionKind: "live-cve", reservation: { micros: 10_000, tokens: 10_000 } }

async function testOwnerOnlyRegistryLoadsAndBindsOnlyExactCodeOwnedFactory(): Promise<void> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "hcl-reg-"))
	try {
		const file = path.join(root, "repository-workers.json")
		await fs.writeFile(file, JSON.stringify({ schemaVersion: 1, registrations: [registration] }), { mode: 0o600 })
		await fs.chmod(file, 0o600)
		const rows = await loadRepositoryWorkerRegistrations(file)
		assert.equal(rows.length, 1)
		const factories = new Map([ ["fixture-pipeline", (item: RepositoryWorkerRegistration) => ({
			workerProfile: item.workerProfile, recipeDigest: item.recipeDigest, evaluatorDigest: item.evaluatorDigest, model: item.model,
			executionKind: item.executionKind, reservation: item.reservation,
			async lookupAdvisory() { throw new Error("offline registry fixture does not dispatch") },
			async prepareWorkspace() { throw new Error("offline registry fixture does not dispatch") },
			async evaluate() { throw new Error("offline registry fixture does not dispatch") },
			async deliverPrivate() { throw new Error("offline registry fixture does not dispatch") },
		})] ])
		const workers = bindRepositoryWorkerRegistrations([definition], rows, factories)
		assert.equal(workers.length, 1)
		assert.throws(() => bindRepositoryWorkerRegistrations([{ ...definition, sourceRevision: "e".repeat(40) }], rows, factories), /does not match/)
		assert.throws(() => bindRepositoryWorkerRegistrations([definition], rows, new Map()), /does not match/)
	} finally { await fs.rm(root, { recursive: true, force: true }) }
}

async function testRegistryRejectsWeakPermissionsAndBrowserExecutableFields(): Promise<void> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "hcl-reg-"))
	try {
		const file = path.join(root, "repository-workers.json")
		await fs.writeFile(file, JSON.stringify({ schemaVersion: 1, registrations: [registration] }), { mode: 0o600 })
		await fs.chmod(file, 0o644)
		await assert.rejects(() => loadRepositoryWorkerRegistrations(file), /owner-only/)
		await fs.chmod(file, 0o600)
		await fs.writeFile(file, JSON.stringify({ schemaVersion: 1, registrations: [{ ...registration, command: "touch /tmp/owned" }] }), { mode: 0o600 })
		await assert.rejects(() => loadRepositoryWorkerRegistrations(file), /invalid/)
		assert.deepEqual(await loadRepositoryWorkerRegistrations(path.join(root, "missing.json")), [])
	} finally { await fs.rm(root, { recursive: true, force: true }) }
}

const tests: readonly SuiteTest[] = [
	["private worker registry binds exact campaign identity to code-owned pipeline factories", testOwnerOnlyRegistryLoadsAndBindsOnlyExactCodeOwnedFactory],
	["worker registry rejects weak permissions, unknown command fields, and absent configuration stays empty", testRegistryRejectsWeakPermissionsAndBrowserExecutableFields],
]

await runMain("repository-worker-registry", tests)
