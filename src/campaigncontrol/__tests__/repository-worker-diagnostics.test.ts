import assert from "node:assert/strict"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { createHash } from "node:crypto"
import { runMain, type SuiteTest } from "../../test-runner.js"
import {
	writeRepositoryWorkerDiagnostic,
} from "../repository-worker-diagnostics.js"
import type { ClaimedRepositoryJob } from "../repository-campaigns.js"

const claim = { claimId: "01234567-89ab-cdef-0123-456789abcdef", epoch: 4,
	job: {
		id: "abcdef01-2345-6789-abcd-ef0123456789",
		campaignId: "curl-maintenance",
		advisoryId: "CVE-2026-92390",
	} } as ClaimedRepositoryJob

async function withPrivateRoot(
	run: (root: string, storePath: string) => Promise<void>,
): Promise<void> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "hcl-worker-diagnostic-"))
	await fs.chmod(root, 0o700)
	try { await run(root, path.join(root, "repository-campaigns.json")) }
	finally { await fs.rm(root, { recursive: true, force: true }) }
}

async function testDiagnosticIsBoundedPrivateAndRedacted(): Promise<void> {
	await withPrivateRoot(checkDiagnosticBoundedPrivateRedacted)
}

async function checkDiagnosticBoundedPrivateRedacted(
	root: string,
	storePath: string,
): Promise<void> {
		const result = await writeRepositoryWorkerDiagnostic(
			storePath, { claim, stage: "prepare-candidate",
			error: new Error("credential Bearer abcdefghijklmnopqrst "
				+ "sk-ABCDEFGHIJKLMNOPQRSTUV1234 at "
				+ "/home/joe/private/config.json") , observedAt: 1234 })
		assert.match(result.digest, /^[a-f0-9]{64}$/)
	const { bytes, size } = await readDiagnosticEntry(root)
	assertDiagnosticDigest(bytes, result.digest)
	const record = JSON.parse(bytes.toString("utf8")) as Record<string, unknown>
	assertDiagnosticRecord(record, bytes, size)
}

async function readDiagnosticEntry(
	root: string,
): Promise<{ bytes: Buffer; size: number }> {
		const directory = path.join(root, "worker-diagnostics")
		const entries = await fs.readdir(directory)
		assert.equal(entries.length, 1)
		const file = path.join(directory, entries[0]!)
		const stat = await fs.stat(file)
		assert.equal(stat.mode & 0o777, 0o600)
		const bytes = await fs.readFile(file)
	return { bytes, size: stat.size }
}

function assertDiagnosticDigest(bytes: Buffer, digest: string): void {
	assert.equal(createHash("sha256").update(bytes).digest("hex"), digest)
}

function assertDiagnosticRecord(
	record: Record<string, unknown>,
	bytes: Buffer,
	size: number,
): void {
		assert.equal(record.stage, "prepare-candidate")
		assert.equal(record.observedAt, 1234)
		assert.equal(
			record.message,
			"credential Bearer [redacted] [redacted-token] at [local-path]",
		)
	assertDiagnosticRedactsSecrets(bytes)
		assert.ok(size < 4 * 1024)

function assertDiagnosticRedactsSecrets(bytes: Buffer): void {
		assert.doesNotMatch(bytes.toString("utf8"), /abcdefghijklmnopqrst/)
		assert.doesNotMatch(bytes.toString("utf8"), /sk-ABCDEFGHIJKLMNOPQRSTUV1234/)
		assert.doesNotMatch(bytes.toString("utf8"), /\/home\/joe/)
}
}

type DiagnosticWriteResult = Awaited<
	ReturnType<typeof writeRepositoryWorkerDiagnostic>
>

async function writeFirstDiagnostic(
	storePath: string,
): Promise<DiagnosticWriteResult> {
		const first = await writeRepositoryWorkerDiagnostic(
			storePath,
			{
				claim,
				stage: "prepare-candidate",
				error: new Error("first bounded failure"),
				observedAt: 1,
			},
		)
	return first
}

async function testFirstDiagnosticForClaimIsPreserved(): Promise<void> {
	await withPrivateRoot(async (_root, storePath): Promise<void> => {
		const first = await writeFirstDiagnostic(storePath)
		const second = await writeRepositoryWorkerDiagnostic(
			storePath,
			{
				claim,
				stage: "verify",
				error: new Error("later failure"),
				observedAt: 2,
			},
		)
		assert.deepEqual(second, first)
	})
}

async function testDiagnosticRejectsPublicDirAndInvalidClaim(): Promise<void> {
	await withPrivateRoot(rejectPublicDirectoryAndInvalidClaim)
}

async function rejectPublicDirectoryAndInvalidClaim(
	root: string,
	storePath: string,
): Promise<void> {
	await rejectPublicDiagnosticDirectory(root)
	await rejectInvalidClaimIdentity(storePath)
}

async function rejectPublicDiagnosticDirectory(
	root: string,
): Promise<void> {
		const publicRoot = path.join(root, "public")
		await fs.mkdir(publicRoot, { mode: 0o755 })
		await fs.chmod(publicRoot, 0o755)
		await assert.rejects(
			writeRepositoryWorkerDiagnostic(
				path.join(publicRoot, "store.json"),
				{
					claim,
					stage: "prepare-candidate",
					error: new Error("x"),
				},
			),
			/parent is not private/,
		)
}

async function rejectInvalidClaimIdentity(
	storePath: string,
): Promise<void> {
		await assert.rejects(
			writeRepositoryWorkerDiagnostic(
				storePath,
				{
					claim: { ...claim,
					claimId: "bad" },
					stage: "prepare-candidate",
					error: new Error("x"),
				},
			),
			/identity is invalid/,
		)
}

const tests: readonly SuiteTest[] = [
	[
		"failure diagnostic is bounded, owner-only and redacts secrets",
		testDiagnosticIsBoundedPrivateAndRedacted,
	],
	[
		"first diagnostic for a claim is immutable",
		testFirstDiagnosticForClaimIsPreserved,
	],
	[
		"diagnostic writer rejects public storage and invalid claim identity",
		testDiagnosticRejectsPublicDirAndInvalidClaim,
	],
]

runMain("repository-worker-diagnostics", tests)
