import assert from "node:assert/strict"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { snapshotRepositoryBrokerCapability } from "../../cloud/openshell-provider.js"
import { REPOSITORY_WORKER_BROKER_URL, repositoryWorkerCommand,
	runContainedRepositoryWorker, writeRepositoryBrokerCapability,
		writeRepositoryWorkerTask, summarizeWorkerFailure } from "../repository-worker.js"
import type { ContainedRuntimeProfile } from "../../security/profile.js"

async function withTempDir(fn: (root: string) => Promise<void> | void): Promise<void> {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "hcl-repository-worker-"))
	try { fs.chmodSync(root, 0o700); await fn(root) } finally { fs.rmSync(root,
		{ recursive: true, force: true }) }
}

const capability = Buffer.alloc(32, 7).toString("base64url")

function assertTaskWriteRejected(root: string, sourceUrl: string,
	summary: string, affectedRange: string, expected: RegExp): void {
	assert.throws(() => writeRepositoryWorkerTask(root, {
		advisoryId: "CVE-2026-1024", sourceUrl, snapshotSha256: "a".repeat(64),
		summary, affectedRange, fixedVersion: null,
		verificationCheckIds: ["security-unit-tests"],
	}, "b".repeat(40)), expected)
}

async function testWritesBoundedTask(): Promise<void> {
	await withTempDir(verifyBoundedTaskWrite)
}

function verifyBoundedTaskWrite(root: string): void {
	const digest = writeRepositoryWorkerTask(root, {
		advisoryId: "CVE-2026-1024",
		sourceUrl: "https://nvd.nist.gov/vuln/detail/CVE-2026-1024",
		snapshotSha256: "a".repeat(64), summary: "A parser boundary issue.",
		affectedRange: "before 2.4.0", fixedVersion: "2.4.0",
		verificationCheckIds: ["security-unit-tests"],
	}, "b".repeat(40))
	assertTaskContents(root, digest)
	assertTaskWriteRejected(root, "https://example.com/x", "x", "",
		/approved source set/)
	assertTaskWriteRejected(root,
		"https://nvd.nist.gov/vuln/detail/CVE-2026-1024", "x", "", /EEXIST/)
}

function assertTaskContents(root: string, digest: string): void {
	const taskPath = path.join(root, "ORCHESTRATOR_TASK.md")
	const task = fs.readFileSync(taskPath, "utf8")
	assert.equal(digest.length, 64)
	assert.match(task, /untrusted source data/)
	assert.match(task, /CVE-2026-1024/)
	assert.match(task, /security-unit-tests/)
	assert.equal(fs.statSync(taskPath).mode & 0o777, 0o600)
}

function assertBrokerCapabilityCommand(root: string): void {
	const file = writeRepositoryBrokerCapability(root, capability)
	assert.equal(fs.statSync(file).mode & 0o777, 0o600)
	assert.equal(fs.readFileSync(file, "utf8").trim(), capability)
	const command = repositoryWorkerCommand("worker-job-123")
	assert.equal(command.includes(capability), false)
	assert.equal(command.includes("repository_capability=\"$(cat /run/headlesscode/repository-broker-capability)\""), true)
	assert.equal(command.includes("export HEADLESSCODE_RSI_INFERENCE_CAPABILITY=\"$repository_capability\""), true)
	assert.equal(command.includes("OPENROUTER_BASE_URL="), false)
	assert.match(command, /--session-id 'worker-job-123'/)
	assert.match(command, /--security-profile local/)
	assert.match(command, /--published-advisory-qualification/)
	assert.match(command, /--max-tokens 4000 --max-iterations 2 --max-cost-usd 0\.008/)
	assert.equal(REPOSITORY_WORKER_BROKER_URL,
		"http://host.openshell.internal:4392")
}

function assertWorkerFailureSummaryIsBoundedAndScrubbed(): void {
	const summary = summarizeWorkerFailure(1, 529,
		"noise line\nError: EACCES opening /home/joe/private/profile with Bearer secret-value\nnext failure sk-ABCDEFGHIJKLMNOPQRSTUV1234",
		"a".repeat(64))
	assert.ok(summary.length <= 512)
	assert.match(summary, /exit=1/)
	assert.match(summary, /EACCES opening \[local-path\]/)
	assert.match(summary, /Bearer \[redacted\]/)
	assert.match(summary, /\[redacted-token\]/)
	assert.doesNotMatch(summary, /secret-value|sk-ABCDEFGHIJKLMNOPQRSTUV1234|\/home\/joe\/private/)
}

const tests: Array<[string, () => Promise<void>]> = [
	["nonzero worker output is summarized with bounded redaction", async () => assertWorkerFailureSummaryIsBoundedAndScrubbed()],
	["stores the per-job broker capability in a private file, never command or environment text", async () => withTempDir(assertBrokerCapabilityCommand)],
	["fixed worker command matches the immutable OpenShell image contract",
		async () => {
		const image = fs.readFileSync(path.join(process.cwd(),
			"docker/OpenShell.Dockerfile"), "utf8")
		assert.match(image, /WORKDIR \/opt\/headlesscode/)
		assert.match(image, /RUN npm ci/)
		assert.match(image, /COPY src \.\/src/)
		assert.match(image, /RUN test -r \/opt\/headlesscode\/src\/cli\.ts/)
		assert.match(image, /test ! -w \/opt\/headlesscode\/src\/memory/)
	}],
	["rejects malformed capabilities and non-private directories",
		async () => withTempDir((root) => {
		assert.throws(() => writeRepositoryBrokerCapability(root, "bad"), /malformed/)
		const permissive = path.join(root, "permissive"); fs.mkdirSync(permissive,
			{ mode: 0o755 }); fs.chmodSync(permissive, 0o755)
		assert.throws(() => writeRepositoryBrokerCapability(permissive,
			capability), /owner-only/)
	})],
	["writes only bounded, source-linked advisory facts and returns an immutable task digest", testWritesBoundedTask],
	["qualification task explicitly forbids edits, commands, and tests",
		async () => withTempDir((root) => {
		writeRepositoryWorkerTask(root, { advisoryId: "CVE-2026-1024",
			sourceUrl: "https://nvd.nist.gov/vuln/detail/CVE-2026-1024",
			snapshotSha256: "a".repeat(64), summary: "A parser boundary issue.",
				affectedRange: "before 2.4.0", fixedVersion: "2.4.0",
			verificationCheckIds: ["security-unit-tests"] }, "b".repeat(40),
				{ purpose: "qualification" })
		const task = fs.readFileSync(path.join(root, "ORCHESTRATOR_TASK.md"), "utf8")
		assert.match(task, /qualification-only review/)
		assert.match(task, /Do not edit files, create commits, run commands or tests/)
		assert.match(task, /protected fixed-profile verification separately/)
		assert.doesNotMatch(task, /prepare a minimal candidate/)
	})],
	["snapshots a broker capability read-only and rejects unprotected or malformed sources", async () => withTempDir((root) => {
		const source = writeRepositoryBrokerCapability(root, capability)
		const protectedDir = path.join(root,
			"protected"); fs.mkdirSync(protectedDir,
				{ mode: 0o700 }); fs.chmodSync(protectedDir, 0o700)
		const destination = path.join(protectedDir, "mounted-token")
		snapshotRepositoryBrokerCapability(source, destination, [protectedDir])
		assert.equal(fs.statSync(destination).mode & 0o777, 0o400)
		assert.equal(fs.readFileSync(destination, "utf8").trim(), capability)
		assert.throws(() => snapshotRepositoryBrokerCapability(source,
			path.join(protectedDir, "rejected"), [root]), /outside the worktree/)
	})],
	["refuses a normal credential-bearing worker profile before launch",
		async () => withTempDir(async (root) => {
		const profile = { purpose: "worker",
			providers: ["headlesscode-openrouter"],
				inferenceEndpoint: { host: "openrouter.ai",
					port: 443 } } as unknown as ContainedRuntimeProfile
		await assert.rejects(runContainedRepositoryWorker({ repoRoot: root,
			worktree: root, profile, model: "fixture/model",
				capabilityFile: path.join(root, "cap"), taskSha256: "a".repeat(64) }),
					/fixed profile/)
	})],
]

for (const [name, run] of tests) {
	await run()
	console.log(`  ok   ${name}`)
}
console.log(`All ${tests.length} repository-worker tests passed`)
