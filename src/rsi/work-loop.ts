/** Host-owned scheduling for project work and separately verified harness repairs. */
import { createHash } from "node:crypto"
import { appendFile, mkdir, writeFile } from "node:fs/promises"
import * as path from "node:path"
import type { EventRecord } from "../engine/events.js"

export interface WorkLoopTask { id: string; prompt: string }
export interface HarnessRevision { commit: string; runtimeId: string }
export interface WorkObservation {
	key: string
	kind: "error" | "bottleneck" | "missing-tool" | "improvement"
	summary: string
	evidenceRef: string
}
export interface WorkCandidate { commit: string; workspace: string }
export interface WorkPhaseResult {
	candidate?: WorkCandidate
	observations: WorkObservation[]
	/** Actual settled inference charges, including failed calls. Null means uncertain billing. */
	costUsd: number | null
}
export interface WorkVerification {
	passed: boolean
	/** Binds the host's verdict to the exact candidate, not the worker's report. */
	commit: string
	evidenceRef: string
}
export interface WorkPhaseContext {
	signal: AbortSignal
	deadlineMs: number
	remainingSpendUsd: number
	harness: Readonly<HarnessRevision>
}
export interface WorkLoopDriver {
	/** Drivers must enforce context spend/deadline limits on each inference request. */
	runTask(task: Readonly<WorkLoopTask>, attempt: number, context: WorkPhaseContext): Promise<WorkPhaseResult>
	verifyTask(task: Readonly<WorkLoopTask>, candidate: Readonly<WorkCandidate>, context: WorkPhaseContext): Promise<WorkVerification>
	/** Independently reproduce or qualify an observation before requesting a repair. */
	confirmObservation(observation: Readonly<WorkObservation>, context: WorkPhaseContext): Promise<boolean>
	repairHarness(observation: Readonly<WorkObservation>, attempt: number, context: WorkPhaseContext): Promise<WorkPhaseResult>
	/** Must run regression checks AND the observation's reproducer outside the repair worker. */
	verifyHarness(observation: Readonly<WorkObservation>, candidate: Readonly<WorkCandidate>, context: WorkPhaseContext): Promise<WorkVerification>
	/** Create/pin an immutable executable runtime; never replace the running supervisor. */
	activateHarness(candidate: Readonly<WorkCandidate>, context: WorkPhaseContext): Promise<HarnessRevision>
	/** Publish only a verified task candidate to the driver's task branch. */
	acceptTask(task: Readonly<WorkLoopTask>, candidate: Readonly<WorkCandidate>, context: WorkPhaseContext): Promise<void>
}
export interface WorkLoopConfig {
	tasks: WorkLoopTask[]
	harness: HarnessRevision
	ledgerPath: string
	maxTasks: number
	maxTaskAttempts: number
	maxRepairs: number
	maxRepairAttempts: number
	maxRuntimeMs: number
	maxSpendUsd: number
}
export interface WorkLoopSummary {
	reason: "queue-complete" | "cancelled" | "runtime-limit" | "spend-limit" | "uncertain-billing" | "task-failed" | "repair-limit" | "driver-error"
	completedTasks: string[]
	taskAttempts: number
	repairAttempts: number
	acceptedRepairs: number
	settledCostUsd: number
	harness: HarnessRevision
	error?: string
}

function validRevision(revision: HarnessRevision): boolean {
	return /^[a-f0-9]{40}$/.test(revision.commit) && typeof revision.runtimeId === "string" && revision.runtimeId.length > 0
}
function verifyVerdict(verdict: WorkVerification, candidate: WorkCandidate): boolean {
	return verdict.passed === true && verdict.commit === candidate.commit && typeof verdict.evidenceRef === "string" && verdict.evidenceRef.length > 0
}
function validObservation(value: WorkObservation): boolean {
	return ["error", "bottleneck", "missing-tool", "improvement"].includes(value.kind)
		&& [value.key, value.summary, value.evidenceRef].every((field) => typeof field === "string" && field.length > 0 && field.length <= 4096)
}
class LoopStop extends Error {
	constructor(readonly reason: WorkLoopSummary["reason"]) { super(reason) }
}

/**
 * A finite host scheduler. Drivers are trusted operator code, never candidate
 * code. They own independent tests, immutable runtime creation, and individual
 * request authorization. This ledger is a work record, not a signed evidence
 * collector or a replacement for the existing contained execution profile.
 */
export async function runWorkLoop(config: WorkLoopConfig, driver: WorkLoopDriver, signal?: AbortSignal): Promise<WorkLoopSummary> {
	for (const key of ["maxTasks", "maxTaskAttempts", "maxRepairs", "maxRepairAttempts", "maxRuntimeMs"] as const) {
		if (!Number.isSafeInteger(config[key]) || config[key] < 1) throw new Error(`${key} must be a positive safe integer`)
	}
	if (!Number.isFinite(config.maxSpendUsd) || config.maxSpendUsd <= 0) throw new Error("maxSpendUsd must be finite and positive")
	if (config.maxRuntimeMs > 2_147_483_647) throw new Error("maxRuntimeMs exceeds the supported timer range")
	if (!validRevision(config.harness)) throw new Error("harness requires a full commit SHA and immutable runtime ID")
	if (!path.isAbsolute(config.ledgerPath)) throw new Error("ledgerPath must be an absolute supervisor-owned path")
	if (config.tasks.length > config.maxTasks) throw new Error("task queue exceeds maxTasks")
	if (new Set(config.tasks.map((task) => task.id)).size !== config.tasks.length || config.tasks.some((task) => !task.id || !task.prompt)) throw new Error("tasks require unique nonempty IDs and prompts")
	// Copy configuration before passing anything to a driver: a repair cannot
	// replace the queued objectives or raise scheduling limits through aliases.
	const tasks = config.tasks.map((task) => Object.freeze({ ...task }))
	const limits = { ...config }
	await mkdir(path.dirname(limits.ledgerPath), { recursive: true, mode: 0o700 })
	// Exclusive creation prevents concurrent schedulers and accidental reuse of
	// a prior ledger whose sequence and hash chain belong to another run.
	await writeFile(limits.ledgerPath, "", { flag: "wx", mode: 0o600 })
	const deadlineMs = Date.now() + limits.maxRuntimeMs
	const abort = new AbortController()
	const onAbort = () => abort.abort(signal?.reason)
	if (signal?.aborted) onAbort()
	else signal?.addEventListener("abort", onAbort, { once: true })
	const timer = setTimeout(() => abort.abort(new Error("work loop deadline exceeded")), limits.maxRuntimeMs)
	const summary: WorkLoopSummary = { reason: "queue-complete", completedTasks: [], taskAttempts: 0, repairAttempts: 0, acceptedRepairs: 0, settledCostUsd: 0, harness: { ...config.harness } }
	let sequence = 0
	let previousHash = ""
	const seen = new Set<string>()
	const record = async (type: string, fields: Record<string, unknown> = {}) => {
		const payload = { sequence: ++sequence, at: new Date().toISOString(), type, previousHash, ...fields }
		const hash = createHash("sha256").update(JSON.stringify(payload)).digest("hex")
		await appendFile(limits.ledgerPath, JSON.stringify({ ...payload, hash }) + "\n", { mode: 0o600 })
		previousHash = hash
	}
	const check = () => {
		if (signal?.aborted) throw new LoopStop("cancelled")
		if (Date.now() >= deadlineMs || abort.signal.aborted) throw new LoopStop("runtime-limit")
		if (summary.settledCostUsd >= limits.maxSpendUsd) throw new LoopStop("spend-limit")
	}
	const context = (): WorkPhaseContext => {
		check()
		return { signal: abort.signal, deadlineMs, remainingSpendUsd: limits.maxSpendUsd - summary.settledCostUsd, harness: Object.freeze({ ...summary.harness }) }
	}
	const settle = async (phase: string, result: WorkPhaseResult) => {
		if (result.costUsd === null || !Number.isFinite(result.costUsd) || result.costUsd < 0) {
			await record("billing-uncertain", { phase })
			throw new LoopStop("uncertain-billing")
		}
		summary.settledCostUsd += result.costUsd
		await record("phase-settled", { phase, costUsd: result.costUsd, settledCostUsd: summary.settledCostUsd, candidate: result.candidate ?? null })
		if (summary.settledCostUsd > limits.maxSpendUsd) throw new LoopStop("spend-limit")
		if (!Array.isArray(result.observations) || result.observations.some((observation) => !validObservation(observation))) throw new Error("driver returned malformed observations")
		if (result.candidate && (!/^[a-f0-9]{40}$/.test(result.candidate.commit) || !path.isAbsolute(result.candidate.workspace))) throw new Error("driver returned malformed candidate identity")
	}
	try {
		await record("loop-start", { harness: summary.harness, taskIds: tasks.map((task) => task.id), limits: { maxSpendUsd: limits.maxSpendUsd, maxRuntimeMs: limits.maxRuntimeMs, maxTaskAttempts: limits.maxTaskAttempts, maxRepairs: limits.maxRepairs, maxRepairAttempts: limits.maxRepairAttempts } })
		for (const task of tasks) {
			let accepted = false
			for (let attempt = 1; attempt <= limits.maxTaskAttempts && !accepted; attempt++) {
				check()
				await record("task-start", { taskId: task.id, attempt, harness: summary.harness })
				summary.taskAttempts++
				const result = await driver.runTask(task, attempt, context())
				await settle("task", result)
				check()
				if (result.candidate) {
					const candidate = Object.freeze({ ...result.candidate })
					const verdict = await driver.verifyTask(task, candidate, context())
					await record("task-verified", { taskId: task.id, attempt, verdict })
					if (verifyVerdict(verdict, candidate)) {
						await driver.acceptTask(task, candidate, context())
						check()
						accepted = true
						summary.completedTasks.push(task.id)
						await record("task-accepted", { taskId: task.id, candidate })
					}
				}
				// Snapshot observations too: candidate/driver mutation cannot rewrite
				// the evidence that a later verification receives.
				for (const observation of result.observations.map((item) => Object.freeze({ ...item }))) {
					if (seen.has(observation.key)) continue
					seen.add(observation.key)
					await record("observation", { taskId: task.id, observation })
					if (!await driver.confirmObservation(observation, context())) {
						await record("observation-unconfirmed", { key: observation.key })
						continue
					}
					let promoted = false
					for (let repairAttempt = 1; repairAttempt <= limits.maxRepairAttempts && !promoted; repairAttempt++) {
						if (summary.repairAttempts >= limits.maxRepairs) throw new LoopStop("repair-limit")
						await record("repair-start", { observation, attempt: repairAttempt, harness: summary.harness })
						summary.repairAttempts++
						const repair = await driver.repairHarness(observation, repairAttempt, context())
						await settle("repair", repair)
						check()
						if (!repair.candidate) continue
						const candidate = Object.freeze({ ...repair.candidate })
						const verdict = await driver.verifyHarness(observation, candidate, context())
						await record("repair-verified", { key: observation.key, verdict })
						if (!verifyVerdict(verdict, candidate)) continue
						const revision = await driver.activateHarness(candidate, context())
						check()
						if (!validRevision(revision) || revision.commit !== candidate.commit) throw new Error("activated harness does not match verified candidate")
						summary.harness = { ...revision }
						summary.acceptedRepairs++
						promoted = true
						await record("repair-activated", { key: observation.key, harness: summary.harness })
					}
				}
			}
			if (!accepted) throw new LoopStop("task-failed")
		}
	} catch (error) {
		summary.reason = signal?.aborted ? "cancelled" : Date.now() >= deadlineMs ? "runtime-limit" : error instanceof LoopStop ? error.reason : "driver-error"
		if (!(error instanceof LoopStop)) summary.error = error instanceof Error ? error.message : String(error)
	} finally {
		clearTimeout(timer)
		signal?.removeEventListener("abort", onAbort)
		abort.abort()
	}
	await record("loop-stop", { summary })
	return summary
}

/** Findings are triggers for independent confirmation, never proof of a harness defect. */
export function workObservationsFromEvents(events: readonly EventRecord[], evidenceRef: string, slowToolMs = 60_000): WorkObservation[] {
	if (!evidenceRef || !Number.isFinite(slowToolMs) || slowToolMs <= 0) throw new Error("observations require an evidence reference and positive timing threshold")
	const observations = new Map<string, WorkObservation>()
	const starts = new Map<string, number>()
	for (const event of events) {
		const tool = typeof event.tool === "string" ? event.tool : "unknown"
		const callKey = typeof event.callId === "string" ? `${event.sessionId}:${event.callId}` : undefined
		if (event.type === "tool_call" && callKey) starts.set(callKey, Date.parse(event.ts))
		if (event.type !== "tool_result") continue
		const result = typeof event.result === "string" ? event.result.slice(0, 1000) : ""
		const missing = event.isError === true && /unknown tool|tool .*not (?:found|available)|unsupported tool/i.test(result)
		const started = callKey ? starts.get(callKey) : undefined
		if (callKey) starts.delete(callKey)
		const elapsed = started === undefined ? NaN : Date.parse(event.ts) - started
		const kind = event.isError === true ? missing ? "missing-tool" : "error" : elapsed >= slowToolMs ? "bottleneck" : undefined
		if (!kind) continue
		const summary = kind === "bottleneck" ? `${tool} took ${elapsed}ms (threshold ${slowToolMs}ms)` : `${tool}: ${result || "tool failed without diagnostic text"}`
		const key = createHash("sha256").update(JSON.stringify([kind, tool, kind === "bottleneck" ? slowToolMs : result])).digest("hex")
		observations.set(key, { key, kind, summary, evidenceRef })
	}
	return [...observations.values()]
}
