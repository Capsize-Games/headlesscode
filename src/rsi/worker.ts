import { createHash } from "node:crypto"
import { execFileSync } from "node:child_process"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { openshellPreflight } from "../cloud/openshell-preflight.js"
import { PostgresRsiJobQueue, fleetQueuePolicy, requiredFleetJobLeaseMs, type FleetJobLease, type FleetJobPayload } from "./postgres-queue.js"
import { OpenShellMutationPreflightError, runOpenShellEvaluation, runOpenShellModelJob, runOpenShellMutation } from "./openshell.js"
import type { CandidateRecord, ComputePolicy, EvaluationSummary, MutationHypothesis, MutationKind, RsiConfig, RsiRoleConfig, TrialResult } from "./types.js"
import { startOpenRouterBroker, openRouterProfileForModel, RSI_DEFAULT_OPENROUTER_PROFILE_ID, type OpenRouterBrokerReceipt, type OpenRouterBrokerOptions } from "./inference-broker.js"
import { effectiveWorkerHarnessMode, workerHarnessCliPath, validWorkerHarnessRuntimeIdentity } from "./worker-harness.js"
import { mutationSnapshotProtectedPathViolations } from "./sandbox.js"
import type { EmergencyControl } from "../control/emergency-controller.js"
import { EmergencyControl as EmergencyControlRuntime } from "../control/emergency-controller.js"
import { OpenShellSessionProvider } from "../cloud/openshell-provider.js"
import { DEFAULT_RSI_ARTIFACT_LIMIT } from "./artifact-store.js"

const EVALUATION_PREVIEW_CHARS = 2048
const MUTATION_FAILURE_ARTIFACT_MAX_BYTES = DEFAULT_RSI_ARTIFACT_LIMIT
const MUTATION_FAILURE_PREVIEW_CHARS = 2048

function diagnosticTailPreview(value: string): { text: string; truncated: boolean } {
	if (value.length <= MUTATION_FAILURE_PREVIEW_CHARS) return { text: value, truncated: false }
	return {
		text: `[earlier output omitted; showing final ${MUTATION_FAILURE_PREVIEW_CHARS} characters]\n${value.slice(-MUTATION_FAILURE_PREVIEW_CHARS)}`,
		truncated: true,
	}
}

function jsonStringByteLength(value: string): number {
	let bytes = 2 // surrounding quotes
	for (let index = 0; index < value.length; index += 1) {
		const code = value.charCodeAt(index)
		if (code === 0x22 || code === 0x5c) bytes += 2
		else if (code <= 0x1f) bytes += code === 0x08 || code === 0x09 || code === 0x0a || code === 0x0c || code === 0x0d ? 2 : 6
		else if (code >= 0xd800 && code <= 0xdbff) {
			const next = value.charCodeAt(index + 1)
			if (next >= 0xdc00 && next <= 0xdfff) { bytes += 4; index += 1 }
			else bytes += 6
		} else if (code >= 0xdc00 && code <= 0xdfff) bytes += 6
		else if (code <= 0x7f) bytes += 1
		else if (code <= 0x7ff) bytes += 2
		else bytes += 3
	}
	return bytes
}

function mutationFailureArtifact(trial: TrialResult): Buffer {
	const result = {
		ok: trial.ok,
		command: "",
		exitCode: trial.exitCode,
		durationMs: trial.durationMs,
		...(trial.timedOut !== undefined ? { timedOut: trial.timedOut } : {}),
		...(trial.outputArtifactSha256 !== undefined ? { outputArtifactSha256: trial.outputArtifactSha256 } : {}),
		...(trial.outputArtifactBytes !== undefined ? { outputArtifactBytes: trial.outputArtifactBytes } : {}),
		stdout: "",
		stderr: "",
	}
	const emptyOutputBytes = Buffer.byteLength(JSON.stringify({ schemaVersion: 1, result }))
	const serializedBytes = emptyOutputBytes - 6 + jsonStringByteLength(trial.command) + jsonStringByteLength(trial.stdout) + jsonStringByteLength(trial.stderr)
	if (serializedBytes > MUTATION_FAILURE_ARTIFACT_MAX_BYTES) throw new Error(`failed OpenShell mutation output exceeds the ${MUTATION_FAILURE_ARTIFACT_MAX_BYTES} byte artifact limit`)
	const bytes = Buffer.from(JSON.stringify({ schemaVersion: 1, result: { ...result, command: trial.command, stdout: trial.stdout, stderr: trial.stderr } }))
	if (bytes.byteLength > MUTATION_FAILURE_ARTIFACT_MAX_BYTES) throw new Error(`failed OpenShell mutation output exceeds the ${MUTATION_FAILURE_ARTIFACT_MAX_BYTES} byte artifact limit`)
	return bytes
}

/** Persist a bounded failed guest result and return its content-addressed identity. */
export async function externalizeMutationFailureOutput(
	queue: PostgresRsiJobQueue,
	trial: TrialResult,
	failureResult: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
	const bytes = mutationFailureArtifact(trial)
	const artifact = await queue.putArtifact(bytes)
	const stdoutPreview = diagnosticTailPreview(trial.stdout)
	const stderrPreview = diagnosticTailPreview(trial.stderr)
	return {
		...failureResult,
		mutationResult: {
			ok: trial.ok,
			command: trial.command.slice(0, 512),
			exitCode: trial.exitCode,
			durationMs: trial.durationMs,
			...(trial.timedOut !== undefined ? { timedOut: trial.timedOut } : {}),
			stdout: stdoutPreview.text,
			stderr: stderrPreview.text,
			stdoutPreviewTruncated: stdoutPreview.truncated,
			stderrPreviewTruncated: stderrPreview.truncated,
			stdoutTruncated: stdoutPreview.truncated,
			stderrTruncated: stderrPreview.truncated,
			outputArtifactSha256: artifact.sha256,
			outputArtifactBytes: artifact.byteLength,
		},
		failureOutputArtifact: { sha256: artifact.sha256, bytes: artifact.byteLength },
	}
}

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
	emergencyControl?: Pick<EmergencyControl, "identity" | "stateDirectoryPath" | "signal" | "state" | "assertRunning" | "waitUntilRunning" | "registerCleanup" | "registerResource" | "releaseResource">
}

function parsePositiveInteger(value: string | undefined, fallback: number, name: string): number {
	if (value === undefined || value.trim() === "") return fallback
	const parsed = Number(value)
	if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`${name} must be a positive integer`)
	return parsed
}

function taskConfig(payload: FleetJobPayload, root: string, queue: PostgresRsiJobQueue): RsiConfig {
	const roles: RsiRoleConfig = { worker: { provider: payload.provider ?? "ollama", model: payload.model, ...(payload.openRouterProfile ? { openRouterProfile: payload.openRouterProfile } : {}) } }
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

async function executeLease(lease: FleetJobLease, options: RsiWorkerOptions, signal: AbortSignal): Promise<void> {
	const ensureActive = () => {
		if (signal.aborted) throw signal.reason ?? new Error("fleet job cancelled")
		options.emergencyControl?.assertRunning()
	}
	ensureActive()
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
		ensureActive()
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
					const profile = openRouterProfileForModel(payload.model, payload.openRouterProfile)
					if (profile.id !== RSI_DEFAULT_OPENROUTER_PROFILE_ID && payload.openRouterProfile !== profile.id) throw new Error("OpenRouter fleet job lacks its explicit supervisor profile identity")
					if (!payload.inferenceLimits) throw new Error("OpenRouter fleet job is missing the explicit spend and token ceilings")
					const apiKey = process.env.HEADLESSCODE_OPENROUTER_API_KEY?.trim()
					const bindHost = process.env.HEADLESSCODE_RSI_BROKER_BIND_HOST?.trim()
					if (!apiKey || !bindHost) throw new Error("OpenRouter fleet worker requires the host API key and explicit RSI broker interface address")
					const brokerOptions: OpenRouterBrokerOptions = {
						jobId: lease.job.jobId, leaseToken: lease.token, model: profile.model, ...(profile.id !== RSI_DEFAULT_OPENROUTER_PROFILE_ID ? { profileId: profile.id } : {}), limits: payload.inferenceLimits,
						apiKey, bindHost, ledger: options.queue,
					}
					broker = await (options.createInferenceBroker ?? startOpenRouterBroker)(brokerOptions)
				}
				try {
					mutation = await (options.runMutation ?? runOpenShellMutation)(candidate, config, undefined, undefined, broker, signal, options.emergencyControl)
				} catch (error) {
					if (!(error instanceof OpenShellMutationPreflightError)) throw error
					mutation = { ok: false, result: error.result, error: error.message }
				}
				if (broker) receipt = await broker.receipt()
			} finally {
				if (broker && (payload.provider ?? "ollama") === "openrouter") {
					const receipt = await broker.receipt().catch(() => undefined)
					if (receipt) failureResult = { ok: false, provider: "openrouter", model: payload.model, inferenceAudit: { accounting: "incomplete", jobId: lease.job.jobId, denials: receipt.denials } }
				}
				await broker?.close().catch(() => undefined)
			}
			if (!mutation.ok) {
				const diagnostic = mutation.error ?? mutation.result?.stderr ?? "OpenShell mutation failed"
				if (mutation.result) {
					try {
						failureResult = await externalizeMutationFailureOutput(options.queue, mutation.result, failureResult)
					} catch (error) {
						const persistenceError = error instanceof Error ? error.message : String(error)
						throw new Error(`${diagnostic}\nFailed to persist full OpenShell mutation output: ${persistenceError}`)
					}
				}
				throw new Error(diagnostic)
			}
			if (payload.workerHarness && (!mutation.workerHarnessExecution
				|| mutation.workerHarnessExecution.mode !== payload.workerHarness.mode
				|| mutation.workerHarnessExecution.parentCommit !== payload.workerHarness.parentCommit
				|| mutation.workerHarnessExecution.snapshotTreeDigest !== payload.workerHarness.snapshotTreeDigest
				|| mutation.workerHarnessExecution.executedCliPath !== payload.workerHarness.executedCliPath
				|| JSON.stringify(mutation.workerHarnessExecution.runtime) !== JSON.stringify(payload.workerHarness.runtime))) {
				throw new Error("OpenShell mutation result does not match its frozen worker harness identity")
			}
			if ((payload.provider ?? "ollama") === "openrouter") {
				const profile = openRouterProfileForModel(payload.model, payload.openRouterProfile)
				const profileIdMatches = profile.id === RSI_DEFAULT_OPENROUTER_PROFILE_ID ? receipt?.profileId === undefined || receipt.profileId === profile.id : receipt?.profileId === profile.id
				if (!receipt?.qualified || receipt.model !== payload.model || !profileIdMatches || receipt.endpointProvider !== profile.endpointProvider || receipt.provider !== "openrouter") throw new Error("OpenRouter mutation did not produce a qualified, profile-bound broker receipt")
			}
			const patch = execFileSync("git", ["diff", "--binary", "--no-ext-diff", "--no-renames", `${candidate.baseCommit}...HEAD`], { cwd: repoRoot, encoding: "buffer", maxBuffer: options.queue.policy.maxInFlight * 1024 * 1024 * 16 })
			if (patch.byteLength === 0) throw new Error("OpenShell mutation produced no patch")
			const artifact = await options.queue.putArtifact(patch)
			result = { ok: true, provider: payload.provider ?? "ollama", model: payload.model, ...(receipt ? { inferenceReceipt: receipt } : {}), ...(mutation.workerHarnessExecution ? { workerHarnessExecution: mutation.workerHarnessExecution } : {}), patchSha256: artifact.sha256, patchBytes: artifact.byteLength, durationMs: Date.now() - started }
		} else if (lease.job.jobKind === "evaluation") {
			const evaluation = await (options.runEvaluation ?? runOpenShellEvaluation)(candidate, config, signal, options.emergencyControl)
			const externalized = await externalizeEvaluationOutputs(options.queue, evaluation)
			result = { ok: true, ...externalized, durationMs: Date.now() - started }
		} else {
			const modelTask = payload.modelTask
			if (!modelTask || (lease.job.jobKind === "training") !== (modelTask.kind === "qlora-train")) throw new Error("fleet model job kind and payload do not match")
			const model = await (options.runModelJob ?? runOpenShellModelJob)(candidate, config, modelTask, undefined, signal, options.emergencyControl)
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
		ensureActive()
		const completion = await options.queue.complete(lease, result)
		if (!completion.accepted) throw new Error("OpenShell result was fenced because this worker no longer owns the lease")
	} catch (error) {
		if (!signal.aborted) await options.queue.fail(lease, error instanceof Error ? error.message : String(error), failureResult)
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
		if (options.emergencyControl?.state === "paused" || options.emergencyControl?.state === "pause-requested") {
			if (!await options.emergencyControl.waitUntilRunning(options.signal)) break
		}
		if (options.emergencyControl && options.emergencyControl.state !== "running") break
		options.emergencyControl?.assertRunning()
		await options.queue.heartbeatWorker(options.workerId)
		const lease = await options.queue.claim(options.workerId)
		if (!lease) {
			const idleSignals = [options.signal, options.emergencyControl?.signal].filter((value): value is AbortSignal => value !== undefined)
			const idleSignal = idleSignals.length === 0 ? undefined : idleSignals.length === 1 ? idleSignals[0] : AbortSignal.any(idleSignals)
			await delay(options.pollMs ?? 1000, undefined, { signal: idleSignal }).catch(() => undefined)
			continue
		}
		const leaseController = new AbortController()
		const leaseSignals = [options.signal, options.emergencyControl?.signal, leaseController.signal].filter((value): value is AbortSignal => value !== undefined)
		const leaseSignal = leaseSignals.length === 1 ? leaseSignals[0]! : AbortSignal.any(leaseSignals)
		const jobResource = `rsi-job:${lease.job.jobId}`
		let unregisterCleanup: (() => void) | undefined
		try {
			unregisterCleanup = options.emergencyControl?.registerCleanup(`rsi-job-${lease.job.jobId}`, async () => {
			const cancelled = await options.queue.cancel(lease.job.jobId, "supervisor emergency stop")
			if (!cancelled) {
				const record = await options.queue.getJob(lease.job.jobId)
				if (record?.status !== "cancelled") throw new Error("active RSI job could not be cancelled in the queue")
			}
			leaseController.abort(new Error("supervisor emergency stop"))
		}, jobResource)
			await options.emergencyControl?.registerResource(jobResource)
		} catch (error) {
			await options.queue.cancel(lease.job.jobId, "worker stopped before lease execution").catch(() => false)
			unregisterCleanup?.()
			leaseController.abort(error instanceof Error ? error : new Error(String(error)))
			continue
		}
		const heartbeat = setInterval(() => {
			void options.queue.heartbeat(lease).then((valid) => { if (!valid) leaseController.abort(new Error("RSI lease was cancelled or fenced")) }).catch(() => leaseController.abort(new Error("RSI lease heartbeat failed")))
			void options.queue.heartbeatWorker(options.workerId).catch(() => false)
		}, Math.max(1000, Math.min(5000, Math.floor(options.queue.policy.leaseMs / 3))))
		try { await executeLease(lease, options, leaseSignal) } finally {
			clearInterval(heartbeat)
			const current = await options.queue.getJob(lease.job.jobId).catch(() => undefined)
			if (current && ["completed", "failed", "cancelled"].includes(current.status)) {
				unregisterCleanup?.()
				await options.emergencyControl?.releaseResource(jobResource)
			}
		}
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
	const emergencyControl = await EmergencyControlRuntime.start({
		identity: workerId,
		stateDirectory: env.HEADLESSCODE_CONTROL_DIR,
		socketDirectory: env.HEADLESSCODE_CONTROL_SOCKET_DIR,
		operatorId: `uid:${typeof process.getuid === "function" ? process.getuid() : "unknown"}`,
	})
	if (emergencyControl.state === "failed-to-stop" && emergencyControl.snapshot.resources.length > 0) {
		const recoveryProvider = new OpenShellSessionProvider({ emergencyControl })
		for (const resource of emergencyControl.snapshot.resources) {
			if (resource.startsWith("openshell:")) {
				const sandbox = resource.slice("openshell:".length)
				emergencyControl.registerCleanup(`recover-${sandbox}`, async () => { await recoveryProvider.stopSandbox(sandbox) }, resource)
			} else if (resource.startsWith("rsi-job:")) {
				const jobId = resource.slice("rsi-job:".length)
				emergencyControl.registerCleanup(`recover-${jobId}`, async () => {
					const cancelled = await queue.cancel(jobId, "restart recovery after supervisor stop")
					const record = await queue.getJob(jobId)
					if (!cancelled && record?.status !== "cancelled" && record?.status !== "failed" && record?.status !== "completed") {
						throw new Error("stale RSI job could not be fenced during restart recovery")
					}
				}, resource)
			}
		}
		await emergencyControl.command("stop", "restart recovery")
	}
	const controller = new AbortController()
	let stopPromise: Promise<unknown> | undefined
	const stop = (signal: string) => {
		controller.abort(new Error(`received ${signal}`))
		stopPromise ??= emergencyControl.command("stop", `received ${signal}`).catch(() => undefined)
	}
	const onSigint = () => stop("SIGINT")
	const onSigterm = () => stop("SIGTERM")
	process.once("SIGINT", onSigint)
	process.once("SIGTERM", onSigterm)
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
				emergencyControl,
		})
		if (stopPromise) await stopPromise
		if (emergencyControl.state === "failed-to-stop" && emergencyControl.hasCleanupHandlers) await emergencyControl.waitForStopped()
		if (emergencyControl.state === "running") await emergencyControl.command("stop", "RSI worker exited")
		return 0
	} finally {
		process.removeListener("SIGINT", onSigint)
		process.removeListener("SIGTERM", onSigterm)
		await emergencyControl.close()
		await queue.close()
	}
}
