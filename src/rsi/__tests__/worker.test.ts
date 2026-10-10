import assert from "node:assert/strict"
import test from "node:test"
import { createHash } from "node:crypto"
import { execFileSync } from "node:child_process"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { externalizeEvaluationOutputs, runRsiWorker, type RsiWorkerOptions } from "../worker.js"
import { EmergencyControl } from "../../control/emergency-controller.js"
import type { FleetJobLease, FleetJobPayload } from "../postgres-queue.js"

test("RSI worker refuses to register more active slots than its serial OpenShell loop can execute", async () => {
	const queue = { artifactBackend: "s3" } as unknown as Parameters<typeof runRsiWorker>[0]["queue"]
	await assert.rejects(runRsiWorker({
		queue,
		workerId: "worker-one",
		gatewayId: "gateway-one",
		maxActive: 2,
		resourceClasses: ["LOCAL_GPU", "CPU"],
		scratchRoot: "/tmp/rsi-worker-test",
	}), /currently runs one guest at a time; configure maxActive=1/)
})

test("worker keeps large visible-test output in a content-addressed artifact", async () => {
	const full = "visible-test-output\n".repeat(450_000)
	let uploaded: Buffer | undefined
	const queue = {
		async putArtifact(content: Buffer) {
			uploaded = Buffer.from(content)
			return { sha256: createHash("sha256").update(content).digest("hex"), byteLength: content.byteLength }
		},
	} as unknown as Parameters<typeof externalizeEvaluationOutputs>[0]
	const result = await externalizeEvaluationOutputs(queue, {
		regression: { ok: false, command: "node test.js", exitCode: 1, durationMs: 10, stdout: full, stderr: full },
		visible: [],
	})
	assert.ok(uploaded)
	assert.ok(uploaded.byteLength > 16 * 1024 * 1024)
	assert.equal(createHash("sha256").update(uploaded).digest("hex"), result.outputArtifact.sha256)
	assert.equal(result.outputArtifact.bytes, uploaded.byteLength)
	assert.ok(result.evaluation.regression.stdout.length <= 2048)
	assert.ok(result.evaluation.regression.stderr.length <= 2048)
	assert.equal(result.evaluation.regression.outputArtifactSha256, result.outputArtifact.sha256)
	assert.ok(JSON.stringify(result).length < 10_000, "database result should contain only bounded previews and the artifact reference")
	const unpacked = JSON.parse(uploaded.toString("utf8")) as Array<{ stdout: string; stderr: string }>
	assert.equal(unpacked[0].stdout, full)
	assert.equal(unpacked[0].stderr, full)
})

test("emergency stop cancels an active lease and aborts its OpenShell operation", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "headlesscode-worker-stop-test-"))
	const repo = path.join(root, "repo")
	const snapshotPath = path.join(root, "snapshot.bundle")
	const stateDirectory = path.join(root, "control")
	const socketDirectory = path.join(process.cwd(), ".headlesscode", "c")
	const id = "worker-stop-candidate"
	const control = await EmergencyControl.start({ identity: "worker-stop-test", stateDirectory, socketDirectory, graceMs: 2_000 })
	const createDir = (directory: string) => fs.mkdirSync(directory, { recursive: true })
	createDir(repo)
	execFileSync("git", ["init", "-q", "-b", "main", repo])
	execFileSync("git", ["-C", repo, "config", "user.name", "Test"])
	execFileSync("git", ["-C", repo, "config", "user.email", "test@example.invalid"])
	fs.writeFileSync(path.join(repo, "src.ts"), "export const value = 1\n")
	execFileSync("git", ["-C", repo, "add", "src.ts"])
	execFileSync("git", ["-C", repo, "commit", "-qm", "snapshot"])
	const commit = execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim()
	execFileSync("git", ["-C", repo, "bundle", "create", snapshotPath, "HEAD"])
	const snapshot = fs.readFileSync(snapshotPath)
	const snapshotSha256 = createHash("sha256").update(snapshot).digest("hex")
	const payload: FleetJobPayload = {
		schemaVersion: 1, snapshotSha256, snapshotBytes: snapshot.byteLength, snapshotCommit: commit,
		task: "modify one value", model: "mock/model", maxIterations: 1, timeoutMs: 100,
		protectedPaths: [], candidate: { id, generation: 0 },
	}
	const job = { jobId: "active-job", idempotencyKey: "key", runId: "run", candidateId: id, jobKind: "mutation" as const, resourceClass: "CPU" as const, artifactSha256: snapshotSha256, payload, status: "leased" as const, attempts: 1, maxAttempts: 1, leaseOwner: "worker-stop-test", leaseToken: "lease-token", leaseExpiresAt: new Date(Date.now() + 300_000).toISOString(), leaseDurationMs: 300_000, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }
	const lease = { job, token: "lease-token", workerId: "worker-stop-test", attempt: 1 } as FleetJobLease
	let startedResolve!: () => void
	const started = new Promise<void>((resolve) => { startedResolve = resolve })
	let queueStatus: "leased" | "cancelled" = "leased"
	let completeCalls = 0
	let failCalls = 0
	let failReason = ""
	let observedAbort = false
	let claimed = false
	const queue = {
		artifactBackend: "s3", policy: { queueName: "stop-test", maxInFlight: 1, leaseMs: 60_000 },
		async migrate() {}, async registerWorker() {}, async heartbeatWorker() {}, async stopWorker() {}, async close() {},
		async claim() { if (claimed) return undefined; claimed = true; return lease },
		async getArtifact() { return snapshot },
		async cancel(jobId: string) { assert.equal(jobId, job.jobId); queueStatus = "cancelled"; return true },
		async getJob() { return { ...job, status: queueStatus } },
		async heartbeat() { return queueStatus === "leased" },
		async complete() { completeCalls += 1; return { accepted: false } },
		async fail(_lease: unknown, reason: string) { failCalls += 1; failReason = reason; return true },
	} as unknown as RsiWorkerOptions["queue"]
	try {
		const worker = runRsiWorker({
			queue, workerId: "worker-stop-test", gatewayId: "gateway-test", maxActive: 1, resourceClasses: ["CPU"], scratchRoot: path.join(root, "worker-scratch"), pollMs: 5, maxJobs: 1,
			emergencyControl: control,
			runMutation: async (...args: Parameters<NonNullable<RsiWorkerOptions["runMutation"]>>) => {
				const signal = args[5]
				startedResolve()
				if (!signal) return { ok: false, error: "missing abort signal" }
				await new Promise<void>((resolve) => {
					const timer = setTimeout(resolve, 5_000)
					if (signal.aborted) { observedAbort = true; clearTimeout(timer); resolve(); return }
					signal.addEventListener("abort", () => { observedAbort = true; clearTimeout(timer); resolve() }, { once: true })
				})
				return { ok: false, error: observedAbort ? "aborted" : "ordinary timeout" }
			},
		})
		let startTimer: NodeJS.Timeout | undefined
		await Promise.race([started, new Promise<never>((_resolve, reject) => { startTimer = setTimeout(() => reject(new Error(`active worker fixture did not start (failures=${failCalls}, reason=${failReason})`)), 5_000) })])
		if (startTimer) clearTimeout(startTimer)
		const result = await control.command("stop", "cancel active test lease")
		assert.equal(result.record.state, "stopped")
		await worker
		assert.equal(queueStatus, "cancelled")
		assert.equal(observedAbort, true, "the active OpenShell operation receives the supervisor abort signal")
		assert.equal(completeCalls, 0, "a cancelled worker never completes its lease")
		assert.equal(failCalls, 0, "abort is not rewritten as an ordinary task failure")
		assert.deepEqual(result.record.resources, [])
	} finally {
		await control.close()
		fs.rmSync(root, { recursive: true, force: true })
	}
})
