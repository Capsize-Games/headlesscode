import assert from "node:assert/strict"
import test from "node:test"
import { createHash } from "node:crypto"
import { execFileSync } from "node:child_process"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { externalizeEvaluationOutputs, runRsiWorker, type RsiWorkerOptions } from "../worker.js"
import { rsiMutationGuestEnvironment } from "../openshell.js"
import { RSI_MUSE_OPENROUTER_MODEL, type OpenRouterBrokerLimits, type OpenRouterBrokerReceipt } from "../inference-broker.js"
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

test("fleet Muse mutation forwards its profile into the real guest environment gate", async () => {
	const scratchParent = path.join(process.cwd(), ".headlesscode", "scratch")
	fs.mkdirSync(scratchParent, { recursive: true })
	const root = fs.mkdtempSync(path.join(scratchParent, "rsi-worker-muse-profile-"))
	const previousApiKey = process.env.HEADLESSCODE_OPENROUTER_API_KEY
	const previousBindHost = process.env.HEADLESSCODE_RSI_BROKER_BIND_HOST
	process.env.HEADLESSCODE_OPENROUTER_API_KEY = "synthetic-test-key"
	process.env.HEADLESSCODE_RSI_BROKER_BIND_HOST = "127.0.0.1"
	const repo = path.join(root, "snapshot")
	const snapshotPath = path.join(root, "snapshot.bundle")
	const workerScratch = path.join(root, "worker-scratch")
	const digest = (content: Buffer) => createHash("sha256").update(content).digest("hex")
	let completeResult: Record<string, unknown> | undefined
	let failReason: string | undefined
	let queueStatus: "leased" | "completed" | "failed" = "leased"
	let claimed = false
	let capturedEnvironment: Record<string, string> | undefined
	let capturedProfile: string | undefined
	try {
		fs.mkdirSync(repo)
		execFileSync("git", ["init", "--quiet", "--initial-branch=main"], { cwd: repo })
		execFileSync("git", ["config", "user.name", "Synthetic Test"], { cwd: repo })
		execFileSync("git", ["config", "user.email", "synthetic@example.invalid"], { cwd: repo })
		fs.writeFileSync(path.join(repo, "app.ts"), "export const value = 1\n")
		execFileSync("git", ["add", "app.ts"], { cwd: repo })
		execFileSync("git", ["commit", "--quiet", "-m", "synthetic sanitized snapshot"], { cwd: repo })
		const snapshotCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim()
		execFileSync("git", ["bundle", "create", snapshotPath, "HEAD"], { cwd: repo })
		const snapshot = fs.readFileSync(snapshotPath)
		const snapshotSha256 = digest(snapshot)
		const limits: OpenRouterBrokerLimits = {
			campaignId: "synthetic-muse-campaign", maxCalls: 1, maxInputTokensPerCall: 1_000, maxOutputTokensPerCall: 100,
			maxTotalTokens: 1_100, maxDurationMs: 60_000, maxRequestBytes: 16_384, maxResponseBytes: 16_384,
			maxInputPricePerMillionUsd: 1, maxOutputPricePerMillionUsd: 1, maxCallSpendUsd: 0.01, maxJobSpendUsd: 0.01, maxCampaignSpendUsd: 0.01,
		}
		const payload: FleetJobPayload = {
			schemaVersion: 1, snapshotSha256, snapshotBytes: snapshot.byteLength, snapshotCommit,
			task: "make a synthetic one-line change", model: RSI_MUSE_OPENROUTER_MODEL, provider: "openrouter", openRouterProfile: "muse-spark-contributor",
			inferenceLimits: limits, maxIterations: 1, timeoutMs: 1_000, protectedPaths: [],
			candidate: { id: "muse-profile-worker-test", generation: 0 },
		}
		const job = {
			jobId: "worker-muse-profile-job", idempotencyKey: "muse-profile-test", runId: "synthetic-run", candidateId: "muse-profile-worker-test",
			jobKind: "mutation" as const, resourceClass: "CPU" as const, concurrencyKey: "openrouter:muse", artifactSha256: snapshotSha256,
			payload, status: "leased" as const, attempts: 1, maxAttempts: 1, leaseDurationMs: 300_000,
			createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
		}
		const lease = { job, token: "synthetic-lease", workerId: "muse-profile-test-worker" } as FleetJobLease
		const queue = {
			artifactBackend: "s3", policy: { queueName: "synthetic-muse", maxInFlight: 1, leaseMs: 60_000 },
			async migrate() {}, async registerWorker() {}, async heartbeatWorker() {}, async stopWorker() {}, async close() {},
			async claim() { if (claimed) return undefined; claimed = true; return lease },
			async getArtifact(sha256: string) { assert.equal(sha256, snapshotSha256); return snapshot },
			async putArtifact(content: Buffer) { return { sha256: digest(content), byteLength: content.byteLength } },
			async heartbeat() { return true },
			async getJob() { return { ...job, status: queueStatus } },
			async complete(_lease: unknown, result: Record<string, unknown>) { completeResult = result; queueStatus = "completed"; return { accepted: true } },
			async fail(_lease: unknown, reason: string) { failReason = reason; queueStatus = "failed"; return true },
		} as unknown as RsiWorkerOptions["queue"]
		const brokerReceipt: OpenRouterBrokerReceipt = {
			provider: "openrouter", endpointProvider: "meta", jobId: job.jobId, campaignId: limits.campaignId,
			model: RSI_MUSE_OPENROUTER_MODEL, profileId: "muse-spark-contributor", returnedModels: [], returnedProviders: [],
			calls: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0, costUsd: 0, accounting: "supervisor-enforced",
			qualified: true, callReceipts: [], denials: [],
		}
		const worker = runRsiWorker({
			queue, workerId: "muse-profile-test-worker", gatewayId: "muse-profile-test-gateway", maxActive: 1,
			resourceClasses: ["CPU"], scratchRoot: workerScratch, maxJobs: 1,
			createInferenceBroker: async (options) => {
				capturedProfile = options.profileId
				assert.equal(options.model, RSI_MUSE_OPENROUTER_MODEL)
				assert.equal(Math.min(options.limits.maxInputTokensPerCall, options.limits.maxRequestBytes) - 128, 872)
				return {
					localBaseUrl: "http://127.0.0.1:43123", guestBaseUrl: "http://host.openshell.internal:43123", capability: "opaque-synthetic-capability", port: 43123, maxPromptBytes: 872,
					async receipt() { return brokerReceipt }, async close() {},
				}
			},
			runMutation: async (candidate, config, _provider, _image, broker) => {
				assert.ok(broker)
				capturedEnvironment = rsiMutationGuestEnvironment(config, candidate, broker)
				fs.writeFileSync(path.join(candidate.worktree, "app.ts"), "export const value = 2\n")
				execFileSync("git", ["add", "app.ts"], { cwd: candidate.worktree })
				execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--quiet", "-m", "synthetic mutation"], { cwd: candidate.worktree })
				return { ok: true }
			},
		})
		await worker
		assert.equal(failReason, undefined)
		assert.equal(queueStatus, "completed")
		assert.equal(capturedProfile, "muse-spark-contributor", "supervisor-created broker remains pinned to Muse")
		assert.equal(capturedEnvironment?.HEADLESSCODE_CODE_MODE_BACKEND, "openrouter")
		assert.equal(capturedEnvironment?.HEADLESSCODE_CODE_MODE_MODEL, RSI_MUSE_OPENROUTER_MODEL)
		assert.equal(capturedEnvironment?.HEADLESSCODE_RSI_INFERENCE_CAPABILITY, "opaque-synthetic-capability")
		assert.equal(capturedEnvironment?.HEADLESSCODE_OPENROUTER_MAX_PROMPT_BYTES, "872")
		const receipt = completeResult?.inferenceReceipt as OpenRouterBrokerReceipt | undefined
		assert.equal(receipt?.profileId, "muse-spark-contributor", "worker publishes the profile-bound receipt")
		assert.ok(capturedEnvironment)
		const candidate = { id: "muse-env-negative-test", model: RSI_MUSE_OPENROUTER_MODEL } as Parameters<typeof rsiMutationGuestEnvironment>[1]
		const validConfig = {
			repoRoot: root, model: RSI_MUSE_OPENROUTER_MODEL, maxIterations: 1, commandTimeoutMs: 1_000,
			roles: { worker: { provider: "openrouter" as const, model: RSI_MUSE_OPENROUTER_MODEL, openRouterProfile: "muse-spark-contributor" as const } },
		} as Parameters<typeof rsiMutationGuestEnvironment>[0]
		const brokerAccess = { guestBaseUrl: "http://host.openshell.internal:43123", capability: "opaque", port: 43123, maxPromptBytes: 872 }
		assert.throws(() => rsiMutationGuestEnvironment({ ...validConfig, roles: { worker: { provider: "openrouter", model: RSI_MUSE_OPENROUTER_MODEL } } }, candidate, brokerAccess), /explicit profile identity/)
		assert.throws(() => rsiMutationGuestEnvironment({ ...validConfig, roles: { worker: { provider: "openrouter", model: RSI_MUSE_OPENROUTER_MODEL, openRouterProfile: "deepseek-deepinfra-fp8" } } }, candidate, brokerAccess), /identity is not admitted/)
	} finally {
		if (previousApiKey === undefined) delete process.env.HEADLESSCODE_OPENROUTER_API_KEY
		else process.env.HEADLESSCODE_OPENROUTER_API_KEY = previousApiKey
		if (previousBindHost === undefined) delete process.env.HEADLESSCODE_RSI_BROKER_BIND_HOST
		else process.env.HEADLESSCODE_RSI_BROKER_BIND_HOST = previousBindHost
		fs.rmSync(root, { recursive: true, force: true })
	}
})

test("emergency stop cancels an active lease and aborts its OpenShell operation", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "headlesscode-worker-stop-test-"))
	const repo = path.join(root, "repo")
	const snapshotPath = path.join(root, "snapshot.bundle")
	const stateDirectory = path.join(root, "control")
	const socketDirectoryFd = fs.openSync(root, "r")
	const socketDirectory = process.platform === "linux" && Buffer.byteLength(path.join(root, `${"x".repeat(20)}.sock`)) >= 108
		? `/proc/self/fd/${socketDirectoryFd}` : root
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
		fs.closeSync(socketDirectoryFd)
		fs.rmSync(root, { recursive: true, force: true })
	}
})
