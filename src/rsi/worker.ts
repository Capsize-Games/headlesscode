import { createHash } from "node:crypto"
import { execFileSync } from "node:child_process"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { openshellPreflight } from "../cloud/openshell-preflight.js"
import { PostgresRsiJobQueue, fleetQueuePolicy, requiredFleetJobLeaseMs, type FleetJobLease, type FleetJobPayload } from "./postgres-queue.js"
import { runOpenShellEvaluation, runOpenShellModelJob, runOpenShellMutation } from "./openshell.js"
import type { CandidateRecord, ComputePolicy, EvaluationSummary, MutationHypothesis, MutationKind, RsiConfig, RsiRoleConfig, TrialResult } from "./types.js"
import { startOpenRouterBroker, RSI_OPENROUTER_MODEL, type OpenRouterBrokerReceipt, type OpenRouterBrokerOptions } from "./inference-broker.js"
import { effectiveWorkerHarnessMode, workerHarnessCliPath, validWorkerHarnessRuntimeIdentity } from "./worker-harness.js"
import { mutationSnapshotProtectedPathViolations } from "./sandbox.js"

const EVALUATION_PREVIEW_CHARS = 2048

export async function externalizeEvaluationOutputs(
	queue: PostgresRsiJobQueue,
	evaluation: Pick<EvaluationSummary, "regression" | "typecheck" | "visible">,
): Promise<{ evaluation: Pick<EvaluationSummary, "regression" | "typecheck" | "visible">; outputArtifact: { sha256: string; bytes: number } }> {
	const trials = [evaluation.regression, ...(evaluation.typecheck ? [evaluation.typecheck] : []), ...evaluation.visible]
	const rawOutputs = Buffer.from(JSON.stringify(trials.map((trial) => ({
		command: trial.command,
		stdout: trial.stdout,
		stderr: trial.stderr,
	}))))
	const artifact = await queue.putArtifact(rawOutputs)
	const compact = (trial: TrialResult): TrialResult => ({
		...trial,
		command: trial.command.slice(0, 512),
		stdout: trial.stdout.slice(0, EVALUATION_PREVIEW_CHARS),
		stderr: trial.stderr.slice(0, EVALUATION_PREVIEW_CHARS),
		outputArtifactSha256: artifact.sha256,
		outputArtifactBytes: artifact.byteLength,
	})
	return {
		evaluation: { regression: compact(evaluation.regression), ...(evaluation.typecheck ? { typecheck: compact(evaluation.typecheck) } : {}), visible: evaluation.visible.map(compact) },
		outputArtifact: { sha256: artifact.sha256, bytes: artifact.byteLength },
	}
}

export interface RsiWorkerOptions {
	queue: PostgresRsiJobQueue
	workerId: string
	gatewayId: string
	hostname?: string
	maxActive: number
	resourceClasses: Array<"LOCAL_GPU" | "CPU" | "REMOTE_API" | "TRAINING_GPU">
	scratchRoot: string
	pollMs?: number
	maxJobs?: number
	signal?: AbortSignal
	runMutation?: typeof runOpenShellMutation
	runEvaluation?: typeof runOpenShellEvaluation
	runModelJob?: typeof runOpenShellModelJob
	createInferenceBroker?: typeof startOpenRouterBroker
}

function parsePositiveInteger(value: string | undefined, fallback: number, name: string): number {
	if (value === undefined || value.trim() === "") return fallback
	const parsed = Number(value)
	if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`${name} must be a positive integer`)
	return parsed
}

function taskConfig(payload: FleetJobPayload, root: string, queue: PostgresRsiJobQueue): RsiConfig {
	const roles: RsiRoleConfig = { worker: { provider: payload.provider ?? "ollama", model: payload.model } }
	return {
		repoRoot: root,
		model: payload.model,
		population: 1,
		generations: 1,
		maxConcurrent: queue.policy.maxInFlight,
		mutationTask: payload.task,
		regressionCommand: payload.regressionCommand ?? "true",
		evalCommands: payload.evalCommands ?? [],
		hiddenEvalCommands: [],
		archiveDir: path.join(root, ".headlesscode", "rsi-worker"),
		worktreeDir: path.join(root, ".worktrees"),
		baseRef: payload.snapshotCommit,
		seed: `fleet-${payload.candidate.id}`,
		dryRun: false,
		keepWorktrees: true,
		maxIterations: payload.maxIterations,
		protectedPaths: payload.protectedPaths,
		commandTimeoutMs: payload.timeoutMs,
		computePolicy: (payload.candidate.computePolicy as ComputePolicy | undefined) ?? "single",
		mutationKind: payload.candidate.mutationKind as MutationKind | undefined,
		hypothesis: payload.candidate.hypothesis as MutationHypothesis | undefined,
		roles,
		...(payload.workerHarness ? {
			workerHarnessMode: payload.workerHarness.runMode,
			workerHarnessPairId: payload.workerHarness.pairId,
			workerHarnessRuntime: payload.workerHarness.runtime,
			workerHarnessParentCommit: payload.workerHarness.parentCommit,
			workerHarnessSnapshotTreeDigest: payload.workerHarness.snapshotTreeDigest,
		} : {}),
	}
}

function candidateFromPayload(payload: FleetJobPayload, root: string): CandidateRecord {
	const descriptor = payload.candidate
	const id = String(descriptor.id ?? "")
	if (!/^[A-Za-z0-9._-]{1,100}$/.test(id) || !Number.isInteger(descriptor.generation)) throw new Error("fleet job candidate descriptor is malformed")
	return {
		id,
		generation: Number(descriptor.generation),
		parent: typeof descriptor.parent === "string" ? descriptor.parent : "baseline",
		branch: `rsi-worker-${id}`,
		worktree: root,
		baseCommit: payload.snapshotCommit,
		status: "mutating",
		model: payload.model,
		modelProvider: `openshell-${payload.provider ?? "ollama"}`,
		mutation: payload.task,
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
		commits: [],
		changedFiles: [],
		protectedPathViolations: [],
		...(descriptor.mutationKind ? { mutationKind: descriptor.mutationKind as MutationKind } : {}),
		...(descriptor.hypothesis ? { hypothesis: descriptor.hypothesis as MutationHypothesis } : {}),
		...(descriptor.modelCandidateId ? { modelCandidateId: String(descriptor.modelCandidateId) } : {}),
	}
}

function verifySanitizedBundle(root: string, expectedCommit: string, jobKind: FleetJobLease["job"]["jobKind"], protectedPaths: string[] = []): void {
	const actual = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim()
	if (actual !== expectedCommit) throw new Error("fleet snapshot commit did not match the queued digest-bound commit")
	const count = execFileSync("git", ["rev-list", "--count", "--all"], { cwd: root, encoding: "utf8" }).trim()
	if (count !== "1") throw new Error("fleet snapshot must contain exactly one commit")
	const entries = execFileSync("git", ["ls-tree", "-r", "-z", "--full-tree", "HEAD"], { cwd: root, encoding: "buffer" }).toString("utf8").split("\0").filter(Boolean)
	for (const entry of entries) {
		const tab = entry.indexOf("\t")
		if (tab < 0) throw new Error("fleet snapshot contains malformed Git tree metadata")
		const [mode] = entry.slice(0, tab).split(" ")
		const relativePath = entry.slice(tab + 1).replaceAll("\\", "/")
		if (mode !== "100644" && mode !== "100755") throw new Error("fleet snapshot contains a symlink, submodule or special file")
		if (jobKind === "mutation" && mutationSnapshotProtectedPathViolations([relativePath], protectedPaths).length > 0) throw new Error(`fleet mutation snapshot contains a protected path: ${relativePath}`)
		if (relativePath === ".env" || relativePath.startsWith(".env.") || relativePath.startsWith("src/rsi/") || relativePath.startsWith(".headlesscode/") || relativePath.startsWith("scripts/eval-suite/") || (jobKind === "mutation" && (relativePath.startsWith("fixtures/rsi-curriculum/") || relativePath.startsWith("fixtures/rsi-benchmark/") || relativePath.startsWith("scripts/") || relativePath.startsWith("tests/") || relativePath.startsWith("test/") || relativePath.includes("/__tests__/") || /(?:^|\/)\D[^/]*\.(?:test|spec)\.[^/]+$/.test(relativePath)))) {
			throw new Error(`fleet snapshot contains protected evaluator or credential material: ${relativePath}`)
		}
		if ((jobKind === "training" || jobKind === "model-evaluation") && !relativePath.startsWith(".headlesscode-rsi-model/")) {
			// Model jobs may include ordinary application source, but reject any accidental
			// local checkpoint/result files or repository history in the transfer bundle.
			if (/^(?:\.rsi-base-model|\.headlesscode-rsi-model-output)(?:\/|$)/.test(relativePath)) throw new Error("model job snapshot contains a local model or prior result artifact")
		}
	}
}

export function verifyWorkerHarnessPayload(payload: FleetJobPayload, root: string): void {
	const identity = payload.workerHarness
	if (!identity) return
	const candidate = payload.candidate as { generation?: unknown; baseCommit?: unknown }
	const generation = candidate.generation
	if ((identity.runMode !== "fixed-control" && identity.runMode !== "self-hosted")
		|| !Number.isSafeInteger(generation) || Number(generation) < 0
		|| identity.mode !== effectiveWorkerHarnessMode(identity.runMode, Number(generation))
		|| typeof candidate.baseCommit !== "string" || identity.parentCommit !== candidate.baseCommit
		|| !/^[a-f0-9]{40}$/.test(identity.parentCommit)
		|| !/^[a-f0-9]{64}$/.test(identity.snapshotTreeDigest)
		|| !validWorkerHarnessRuntimeIdentity(identity.runtime)
		|| identity.executedCliPath !== workerHarnessCliPath(identity.mode)) throw new Error("fleet worker harness identity is malformed or does not match its generation/mode")
	const actualTreeDigest = createHash("sha256").update(execFileSync("git", ["ls-tree", "-r", "-z", "--full-tree", "HEAD"], { cwd: root, encoding: "buffer" })).digest("hex")
	if (actualTreeDigest !== identity.snapshotTreeDigest) throw new Error("fleet worker harness snapshot tree differs from the frozen job identity")
}

async function executeLease(lease: FleetJobLease, options: RsiWorkerOptions): Promise<void> {
	const payload = lease.job.payload
	if (payload.schemaVersion !== 1 || payload.snapshotSha256 !== lease.job.artifactSha256 || !Number.isSafeInteger(payload.snapshotBytes) || payload.snapshotBytes < 1) {
		await options.queue.fail(lease, "malformed or unbound fleet snapshot payload")
		return
	}
	const requiredLeaseMs = requiredFleetJobLeaseMs(lease.job.jobKind, payload.timeoutMs, payload.evalCommands?.length ?? 0)
	if (lease.job.leaseDurationMs < requiredLeaseMs) {
		await options.queue.fail(lease, `job lease ${lease.job.leaseDurationMs}ms is below its OpenShell worst-case budget ${requiredLeaseMs}ms`)
		return
	}
	const root = await fs.mkdtemp(path.join(options.scratchRoot, `${lease.job.jobId}-${lease.job.attempts}-`))
	const bundlePath = path.join(root, "snapshot.bundle")
	const repoRoot = path.join(root, "repo")
	let failureResult: Record<string, unknown> | undefined
	try {
		const bundle = await options.queue.getArtifact(payload.snapshotSha256)
		if (bundle.byteLength !== payload.snapshotBytes) throw new Error("fleet snapshot artifact length differed from queued metadata")
		await fs.writeFile(bundlePath, bundle, { mode: 0o600, flag: "wx" })
		const verifyRoot = path.join(root, "verify.git")
		execFileSync("git", ["init", "--bare", "--quiet", verifyRoot], { cwd: root, stdio: "pipe" })
		execFileSync("git", ["bundle", "verify", bundlePath], { cwd: verifyRoot, stdio: "pipe" })
		execFileSync("git", ["clone", "--quiet", "--no-hardlinks", bundlePath, repoRoot], { cwd: root, stdio: "pipe" })
		verifySanitizedBundle(repoRoot, payload.snapshotCommit, lease.job.jobKind, payload.protectedPaths)
		if (lease.job.jobKind === "mutation") verifyWorkerHarnessPayload(payload, repoRoot)
		const candidate = candidateFromPayload(payload, repoRoot)
		const config = taskConfig(payload, repoRoot, options.queue)
		const started = Date.now()
		let result: Record<string, unknown>
		if (lease.job.jobKind === "mutation") {
			let broker: Awaited<ReturnType<typeof startOpenRouterBroker>> | undefined
			let receipt: OpenRouterBrokerReceipt | undefined
			let mutation
			try {
				if ((payload.provider ?? "ollama") === "openrouter") {
					if (payload.model !== RSI_OPENROUTER_MODEL || !payload.inferenceLimits) throw new Error("OpenRouter fleet job is missing the pinned model or explicit spend and token ceilings")
					const apiKey = process.env.HEADLESSCODE_OPENROUTER_API_KEY?.trim()
					const bindHost = process.env.HEADLESSCODE_RSI_BROKER_BIND_HOST?.trim()
					if (!apiKey || !bindHost) throw new Error("OpenRouter fleet worker requires the host API key and explicit RSI broker interface address")
					const brokerOptions: OpenRouterBrokerOptions = {
						jobId: lease.job.jobId, leaseToken: lease.token, model: RSI_OPENROUTER_MODEL, limits: payload.inferenceLimits,
						apiKey, bindHost, ledger: options.queue,
					}
					broker = await (options.createInferenceBroker ?? startOpenRouterBroker)(brokerOptions)
				}
				mutation = await (options.runMutation ?? runOpenShellMutation)(candidate, config, undefined, undefined, broker)
				if (broker) receipt = await broker.receipt()
			} finally {
				if (broker && (payload.provider ?? "ollama") === "openrouter") {
					const receipt = await broker.receipt().catch(() => undefined)
					if (receipt) failureResult = { ok: false, provider: "openrouter", model: payload.model, inferenceAudit: { accounting: "incomplete", jobId: lease.job.jobId, denials: receipt.denials } }
				}
				await broker?.close().catch(() => undefined)
			}
			if (!mutation.ok) throw new Error(mutation.error ?? mutation.result?.stderr ?? "OpenShell mutation failed")
			if (payload.workerHarness && (!mutation.workerHarnessExecution
				|| mutation.workerHarnessExecution.mode !== payload.workerHarness.mode
				|| mutation.workerHarnessExecution.parentCommit !== payload.workerHarness.parentCommit
				|| mutation.workerHarnessExecution.snapshotTreeDigest !== payload.workerHarness.snapshotTreeDigest
				|| mutation.workerHarnessExecution.executedCliPath !== payload.workerHarness.executedCliPath
				|| JSON.stringify(mutation.workerHarnessExecution.runtime) !== JSON.stringify(payload.workerHarness.runtime))) {
				throw new Error("OpenShell mutation result does not match its frozen worker harness identity")
			}
			if ((payload.provider ?? "ollama") === "openrouter" && (!receipt?.qualified || receipt.model !== payload.model || receipt.provider !== "openrouter")) throw new Error("OpenRouter mutation did not produce a qualified, model-bound broker receipt")
			const patch = execFileSync("git", ["diff", "--binary", "--no-ext-diff", "--no-renames", `${candidate.baseCommit}...HEAD`], { cwd: repoRoot, encoding: "buffer", maxBuffer: options.queue.policy.maxInFlight * 1024 * 1024 * 16 })
			if (patch.byteLength === 0) throw new Error("OpenShell mutation produced no patch")
			const artifact = await options.queue.putArtifact(patch)
			result = { ok: true, provider: payload.provider ?? "ollama", model: payload.model, ...(receipt ? { inferenceReceipt: receipt } : {}), ...(mutation.workerHarnessExecution ? { workerHarnessExecution: mutation.workerHarnessExecution } : {}), patchSha256: artifact.sha256, patchBytes: artifact.byteLength, durationMs: Date.now() - started }
		} else if (lease.job.jobKind === "evaluation") {
			const evaluation = await (options.runEvaluation ?? runOpenShellEvaluation)(candidate, config)
			const externalized = await externalizeEvaluationOutputs(options.queue, evaluation)
			result = { ok: true, ...externalized, durationMs: Date.now() - started }
		} else {
			const modelTask = payload.modelTask
			if (!modelTask || (lease.job.jobKind === "training") !== (modelTask.kind === "qlora-train")) throw new Error("fleet model job kind and payload do not match")
			const model = await (options.runModelJob ?? runOpenShellModelJob)(candidate, config, modelTask)
			const outputArtifact = await options.queue.putArtifact(Buffer.from(JSON.stringify(model.result)))
			const modelResult: Record<string, unknown> = { ...model.result, outputArtifactSha256: outputArtifact.sha256, outputArtifactBytes: outputArtifact.byteLength }
			if (lease.job.jobKind === "training" && model.result.status === "completed") {
				if (!model.adapterArchive) throw new Error("completed QLoRA job did not return its adapter archive")
				const adapterArtifact = await options.queue.putArtifact(model.adapterArchive)
				modelResult.adapterArtifactSha256 = adapterArtifact.sha256
				modelResult.adapterArtifactBytes = adapterArtifact.byteLength
			}
			result = { ok: model.result.status === "completed", modelResult, durationMs: Date.now() - started }
		}
		const completion = await options.queue.complete(lease, result)
		if (!completion.accepted) throw new Error("OpenShell result was fenced because this worker no longer owns the lease")
	} catch (error) {
		await options.queue.fail(lease, error instanceof Error ? error.message : String(error), failureResult)
	} finally {
		await fs.rm(root, { recursive: true, force: true })
	}
}

export async function runRsiWorker(options: RsiWorkerOptions): Promise<void> {
	if (options.queue.artifactBackend !== "s3") throw new Error("fleet RSI workers require a shared S3-compatible artifact store; file storage is same-host development only")
	if (!/^[A-Za-z0-9._-]{1,64}$/.test(options.workerId) || !/^[A-Za-z0-9._-]{1,64}$/.test(options.gatewayId)) throw new Error("worker and gateway IDs must be simple configured identifiers")
	if (options.maxActive !== 1) throw new Error("each RSI OpenShell worker process currently runs one guest at a time; configure maxActive=1")
	await fs.mkdir(options.scratchRoot, { recursive: true, mode: 0o700 })
	await options.queue.migrate()
	await options.queue.registerWorker({
		workerId: options.workerId,
		gatewayId: options.gatewayId,
		hostname: options.hostname ?? os.hostname(),
		maxActive: options.maxActive,
		resourceClasses: options.resourceClasses,
	})
	let processed = 0
	while (!options.signal?.aborted && (options.maxJobs === undefined || processed < options.maxJobs)) {
		await options.queue.heartbeatWorker(options.workerId)
		const lease = await options.queue.claim(options.workerId)
		if (!lease) {
			await delay(options.pollMs ?? 1000, undefined, { signal: options.signal }).catch(() => undefined)
			continue
		}
		const heartbeat = setInterval(() => {
			void options.queue.heartbeat(lease).catch(() => false)
			void options.queue.heartbeatWorker(options.workerId).catch(() => false)
		}, Math.max(1000, Math.floor(options.queue.policy.leaseMs / 3)))
		try { await executeLease(lease, options) } finally { clearInterval(heartbeat) }
		processed += 1
	}
	await options.queue.stopWorker(options.workerId)
}

export async function rsiWorkerMain(env: NodeJS.ProcessEnv = process.env): Promise<number> {
	const workerId = env.HEADLESSCODE_RSI_WORKER_ID?.trim()
	const gatewayId = env.HEADLESSCODE_RSI_GATEWAY_ID?.trim()
	if (!workerId || !gatewayId) throw new Error("HEADLESSCODE_RSI_WORKER_ID and HEADLESSCODE_RSI_GATEWAY_ID are required")
	const queueName = env.HEADLESSCODE_RSI_QUEUE_NAME?.trim() || "rsi-default"
	const maxInFlight = parsePositiveInteger(env.HEADLESSCODE_RSI_MAX_IN_FLIGHT, 1, "HEADLESSCODE_RSI_MAX_IN_FLIGHT")
	const policy = fleetQueuePolicy(queueName, maxInFlight, env)
	const queue = PostgresRsiJobQueue.fromEnvironment(policy, env)
	const maxActive = parsePositiveInteger(env.HEADLESSCODE_RSI_WORKER_MAX_ACTIVE, 1, "HEADLESSCODE_RSI_WORKER_MAX_ACTIVE")
	const resourceClasses = (env.HEADLESSCODE_RSI_WORKER_RESOURCE_CLASSES ?? "LOCAL_GPU,CPU").split(",").map((entry) => entry.trim()).filter(Boolean) as RsiWorkerOptions["resourceClasses"]
	if (resourceClasses.some((value) => !["LOCAL_GPU", "CPU", "REMOTE_API", "TRAINING_GPU"].includes(value))) throw new Error("HEADLESSCODE_RSI_WORKER_RESOURCE_CLASSES contains an unsupported class")
	process.env.OPENSHELL_GATEWAY = gatewayId
	const preflight = openshellPreflight({ requireOpenRouterCredential: false })
	if (preflight) throw new Error(preflight)
	const controller = new AbortController()
	const stop = () => controller.abort()
	process.once("SIGINT", stop)
	process.once("SIGTERM", stop)
	try {
		await runRsiWorker({
			queue,
			workerId,
			gatewayId,
			maxActive,
			resourceClasses,
			scratchRoot: path.resolve(env.HEADLESSCODE_RSI_WORKER_SCRATCH_DIR ?? path.join(os.tmpdir(), "headlesscode-rsi-worker")),
			pollMs: parsePositiveInteger(env.HEADLESSCODE_RSI_WORKER_POLL_MS, 1000, "HEADLESSCODE_RSI_WORKER_POLL_MS"),
			signal: controller.signal,
		})
		return 0
	} finally {
		process.removeListener("SIGINT", stop)
		process.removeListener("SIGTERM", stop)
		await queue.close()
	}
}
