import assert from "node:assert/strict"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { runMain, type SuiteTest } from "../../test-runner.js"
import { RepositoryCampaignStore, type ClaimedRepositoryJob, type RepositoryCampaignDefinition } from "../repository-campaigns.js"
import { createRepositoryWorkerPipeline } from "../repository-worker-pipeline.js"
import { writeRepositoryWorkerDiagnostic } from "../repository-worker-diagnostics.js"
import type { VettedAdvisorySnapshot } from "../repository-worker.js"

async function testPrepareFailureIsRecordedPrivatelyAndNeverReturnedRaw(): Promise<void> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "hcl-pipeline-diagnostic-"))
	await fs.chmod(root, 0o700)
	try {
		const store = new RepositoryCampaignStore(path.join(root, "repository-campaigns.json"), [])
		const claim = { claimId: "01234567-89ab-cdef-0123-456789abcdef", epoch: 4,
			job: { id: "abcdef01-2345-6789-abcd-ef0123456789", campaignId: "curl-maintenance", advisoryId: "CVE-2026-92390" } } as ClaimedRepositoryJob
		const definition = { id: "curl-maintenance", name: "Curl", repositoryId: "curl-maintenance", repository: "Capsize-Games/curl-maintenance",
			sourceRevision: "a".repeat(40), policySha256: "b".repeat(64), workerProfile: "curl-published-advisory-v1",
			recipeDigest: "c".repeat(64), evaluatorDigest: "d".repeat(64), model: "meta/muse-spark-1.3-contributor" } as RepositoryCampaignDefinition
		const advisory: VettedAdvisorySnapshot = { advisoryId: claim.job.advisoryId, sourceUrl: "https://example.invalid/advisory",
			snapshotSha256: "e".repeat(64), summary: "bounded fixture", affectedRange: "fixture", fixedVersion: null, verificationCheckIds: [] }
		const worker = createRepositoryWorkerPipeline({ workerProfile: definition.workerProfile!, recipeDigest: definition.recipeDigest!,
			evaluatorDigest: definition.evaluatorDigest!, model: definition.model!, executionKind: "live-cve", reservation: { micros: 8000, tokens: 72000 },
			async lookupAdvisory() { return advisory },
			async prepareWorkspace() { throw new Error("OpenShell requires key sk-ABCDEFGHIJKLMNOPQRSTUV1234 at /home/joe/private/profile") },
			async evaluate() { throw new Error("not reached") }, async deliverPrivate() { throw new Error("not reached") },
			async recordFailureDiagnostic(input) { return await writeRepositoryWorkerDiagnostic(store.path, input) },
		})
		const progress: Array<Record<string, unknown>> = []
		const result = await worker.execute({ definition, claim, signal: new AbortController().signal,
			async progress(patch) { progress.push(patch as unknown as Record<string, unknown>) } })
		assert.equal(result.status, "ambiguous")
		assert.equal(result.blocker, "registered-pipeline-step-failed")
		assert.equal(result.evidenceRefs.at(-1)?.kind, "diagnostic")
		assert.equal(result.evidenceRefs.at(-1)?.label, "Private bounded failure diagnostic")
		assert.doesNotMatch(JSON.stringify(result), /sk-ABCDEFGHIJKLMNOPQRSTUV1234|\/home\/joe\/private/)
		assert.equal(progress.at(-1)?.stage, "prepare-candidate")
		const directory = path.join(root, "worker-diagnostics")
		const [file] = await fs.readdir(directory)
		assert.ok(file)
		const stored = await fs.readFile(path.join(directory, file!), "utf8")
		assert.doesNotMatch(stored, /sk-ABCDEFGHIJKLMNOPQRSTUV1234|\/home\/joe\/private/)
		assert.match(stored, /\[redacted-token\]/)
	} finally { await fs.rm(root, { recursive: true, force: true }) }
}

async function testNonzeroContainedWorkerExitRecordsBoundedDiagnostic(): Promise<void> {
	const definition = { id: "curl-maintenance", name: "Curl", repositoryId: "curl-maintenance", repository: "Capsize-Games/curl-maintenance",
		sourceRevision: "a".repeat(40), policySha256: "b".repeat(64), workerProfile: "curl-published-advisory-v1",
		recipeDigest: "c".repeat(64), evaluatorDigest: "d".repeat(64), model: "meta/muse-spark-1.3-contributor" } as RepositoryCampaignDefinition
	const claim = { claimId: "11234567-89ab-cdef-0123-456789abcdef", epoch: 5,
		job: { id: "bcdef012-3456-789a-bcde-f0123456789a", campaignId: "curl-maintenance", advisoryId: "CVE-2026-92390" } } as ClaimedRepositoryJob
	const advisory: VettedAdvisorySnapshot = { advisoryId: claim.job.advisoryId, sourceUrl: "https://example.invalid/advisory",
		snapshotSha256: "e".repeat(64), summary: "bounded fixture", affectedRange: "fixture", fixedVersion: null, verificationCheckIds: [] }
	let diagnosticMessage = ""
	const worker = createRepositoryWorkerPipeline({ workerProfile: definition.workerProfile!, recipeDigest: definition.recipeDigest!,
		evaluatorDigest: definition.evaluatorDigest!, model: definition.model!, executionKind: "live-cve", reservation: { micros: 8000, tokens: 72000 },
		async lookupAdvisory() { return advisory },
		async prepareWorkspace() { return { worktree: "/tmp/fixture", taskSha256: "f".repeat(64),
			async runContained() { return { ok: false, durationMs: 529, outputSha256: "a".repeat(64), actualMicros: null, actualTokens: null,
				failureDiagnostic: "OpenShell worker exit=2; durationMs=529; outputBytes=56; outputSha256=aaaaaaaa; headlesscode: invalid bounded task [redacted-token]" } },
			async candidateSha256() { return "f".repeat(64) } } },
		async evaluate() { throw new Error("not reached") }, async deliverPrivate() { throw new Error("not reached") },
		async recordFailureDiagnostic(input) { diagnosticMessage = input.error instanceof Error ? input.error.message : String(input.error); return { digest: "b".repeat(64) } },
	})
	const result = await worker.execute({ definition, claim, signal: new AbortController().signal, async progress() {} })
	assert.equal(result.status, "ambiguous")
	assert.equal(result.blocker, "registered-pipeline-step-failed")
	assert.ok(result.evidenceRefs.some((item) => item.kind === "diagnostic" && item.id === "b".repeat(64)))
	assert.match(diagnosticMessage, /exit=2/)
	assert.match(diagnosticMessage, /invalid bounded task/)
	assert.doesNotMatch(JSON.stringify(result), /invalid bounded task|outputBytes/)
}

const tests: readonly SuiteTest[] = [
	["prepare failure records a private redacted diagnostic and keeps API result opaque", testPrepareFailureIsRecordedPrivatelyAndNeverReturnedRaw],
	["nonzero contained-worker exit goes through the private diagnostic writer", testNonzeroContainedWorkerExitRecordsBoundedDiagnostic],
]

runMain("repository-worker-pipeline", tests)
