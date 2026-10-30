import assert from "node:assert/strict"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { createHash } from "node:crypto"
import { runMain, type SuiteTest } from "../../test-runner.js"
import { writeRepositoryWorkerDiagnostic } from "../repository-worker-diagnostics.js"
import type { ClaimedRepositoryJob } from "../repository-campaigns.js"

const claim = { claimId: "01234567-89ab-cdef-0123-456789abcdef", epoch: 4,
	job: { id: "abcdef01-2345-6789-abcd-ef0123456789", campaignId: "curl-maintenance", advisoryId: "CVE-2026-92390" } } as ClaimedRepositoryJob

async function withPrivateRoot(run: (root: string, storePath: string) => Promise<void>): Promise<void> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "hcl-worker-diagnostic-"))
	await fs.chmod(root, 0o700)
	try { await run(root, path.join(root, "repository-campaigns.json")) }
	finally { await fs.rm(root, { recursive: true, force: true }) }
}

async function testDiagnosticIsBoundedPrivateAndRedacted(): Promise<void> {
	await withPrivateRoot(async (root, storePath) => {
		const result = await writeRepositoryWorkerDiagnostic(storePath, { claim, stage: "prepare-candidate",
			error: new Error("credential Bearer abcdefghijklmnopqrst sk-ABCDEFGHIJKLMNOPQRSTUV1234 at /home/joe/private/config.json") , observedAt: 1234 })
		assert.match(result.digest, /^[a-f0-9]{64}$/)
		const directory = path.join(root, "worker-diagnostics")
		const entries = await fs.readdir(directory)
		assert.equal(entries.length, 1)
		const file = path.join(directory, entries[0]!)
		const stat = await fs.stat(file)
		assert.equal(stat.mode & 0o777, 0o600)
		const bytes = await fs.readFile(file)
		assert.equal(createHash("sha256").update(bytes).digest("hex"), result.digest)
		const record = JSON.parse(bytes.toString("utf8")) as Record<string, unknown>
		assert.equal(record.stage, "prepare-candidate")
		assert.equal(record.observedAt, 1234)
		assert.equal(record.message, "credential Bearer [redacted] [redacted-token] at [local-path]")
		assert.doesNotMatch(bytes.toString("utf8"), /abcdefghijklmnopqrst|sk-ABCDEFGHIJKLMNOPQRSTUV1234|\/home\/joe/)
		assert.ok(stat.size < 4 * 1024)
	})
}

async function testFirstDiagnosticForClaimIsPreserved(): Promise<void> {
	await withPrivateRoot(async (_root, storePath) => {
		const first = await writeRepositoryWorkerDiagnostic(storePath, { claim, stage: "prepare-candidate", error: new Error("first bounded failure"), observedAt: 1 })
		const second = await writeRepositoryWorkerDiagnostic(storePath, { claim, stage: "verify", error: new Error("later failure"), observedAt: 2 })
		assert.deepEqual(second, first)
	})
}

async function testDiagnosticRejectsPublicDirectoryAndInvalidClaim(): Promise<void> {
	await withPrivateRoot(async (root, storePath) => {
		const publicRoot = path.join(root, "public")
		await fs.mkdir(publicRoot, { mode: 0o755 })
		await fs.chmod(publicRoot, 0o755)
		await assert.rejects(writeRepositoryWorkerDiagnostic(path.join(publicRoot, "store.json"), { claim, stage: "prepare-candidate", error: new Error("x") }), /parent is not private/)
		await assert.rejects(writeRepositoryWorkerDiagnostic(storePath, { claim: { ...claim, claimId: "bad" }, stage: "prepare-candidate", error: new Error("x") }), /identity is invalid/)
	})
}

const tests: readonly SuiteTest[] = [
	["failure diagnostic is bounded, owner-only and redacts secret-shaped values", testDiagnosticIsBoundedPrivateAndRedacted],
	["first diagnostic for a claim is immutable", testFirstDiagnosticForClaimIsPreserved],
	["diagnostic writer rejects public storage and invalid claim identity", testDiagnosticRejectsPublicDirectoryAndInvalidClaim],
]

runMain("repository-worker-diagnostics", tests)
