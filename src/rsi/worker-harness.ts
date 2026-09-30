import { createHash } from "node:crypto"
import type { RsiConfig, WorkerHarnessMode, WorkerHarnessRuntimeIdentity } from "./types.js"

export function effectiveWorkerHarnessMode(runMode: WorkerHarnessMode, generation: number): WorkerHarnessMode {
	return runMode === "self-hosted" && generation > 0 ? "self-hosted" : "fixed-control"
}

export function workerHarnessCliPath(mode: WorkerHarnessMode): string {
	return mode === "self-hosted" ? "/workspace/src/cli.ts" : "/opt/headlesscode/src/cli.ts"
}

export function workerHarnessRuntimeIdentityFromEnvironment(env: NodeJS.ProcessEnv = process.env): WorkerHarnessRuntimeIdentity {
	const imageName = env.HEADLESSCODE_RSI_WORKER_IMAGE?.trim() || "headlesscode-openshell-rsi:local"
	const imageDigest = env.HEADLESSCODE_RSI_RUNTIME_IMAGE_DIGEST?.trim() ?? ""
	const harnessCommit = env.HEADLESSCODE_RSI_RUNTIME_HARNESS_COMMIT?.trim() ?? ""
	const dependencyLockDigest = env.HEADLESSCODE_RSI_DEPENDENCY_LOCK_DIGEST?.trim() ?? ""
	if (!/^[A-Za-z0-9._:/-]{1,200}$/.test(imageName)) throw new Error("HEADLESSCODE_RSI_WORKER_IMAGE is malformed")
	if (!/^sha256:[a-f0-9]{64}$/.test(imageDigest)) throw new Error("HEADLESSCODE_RSI_RUNTIME_IMAGE_DIGEST must be a Docker sha256 image ID")
	if (!/^[a-f0-9]{40}$/.test(harnessCommit)) throw new Error("HEADLESSCODE_RSI_RUNTIME_HARNESS_COMMIT must be a full commit SHA")
	if (!/^[a-f0-9]{64}$/.test(dependencyLockDigest)) throw new Error("HEADLESSCODE_RSI_DEPENDENCY_LOCK_DIGEST must be a SHA-256 digest")
	return { imageName, imageDigest, harnessCommit, dependencyLockDigest }
}

export function validWorkerHarnessRuntimeIdentity(identity: WorkerHarnessRuntimeIdentity): boolean {
	return /^[A-Za-z0-9._:/-]{1,200}$/.test(identity.imageName)
		&& /^sha256:[a-f0-9]{64}$/.test(identity.imageDigest)
		&& /^[a-f0-9]{40}$/.test(identity.harnessCommit)
		&& /^[a-f0-9]{64}$/.test(identity.dependencyLockDigest)
}

export function workerHarnessConfigDigest(config: RsiConfig, identity: {
	baseCommit: string
	model: string
	provider: string
	proofProtocolDigest: string
}): string {
	const comparable = {
		schemaVersion: 1,
		baseCommit: identity.baseCommit,
		mutationTask: config.mutationTask,
		model: identity.model,
		provider: identity.provider,
		seed: config.seed,
		population: config.population,
		generations: config.generations,
		maxIterations: config.maxIterations,
		maxTokens: config.maxTokens ?? null,
		timeoutMs: config.commandTimeoutMs,
		maxConcurrent: config.maxConcurrent,
		computePolicy: config.computePolicy ?? "single",
		mutationKind: config.mutationKind ?? "corrective",
		regressionCommand: config.regressionCommand,
		evalCommands: [...config.evalCommands],
		protectedPaths: [...config.protectedPaths].sort(),
		proofProtocolDigest: identity.proofProtocolDigest,
	}
	return createHash("sha256").update(JSON.stringify(comparable)).digest("hex")
}
