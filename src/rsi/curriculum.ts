import * as fs from "node:fs/promises"
import * as path from "node:path"
import { readArchive, writeArchive } from "./archive.js"
import type { CandidateRecord, CurriculumTask, RsiArchive } from "./types.js"
import completionDiscipline from "../../fixtures/rsi-curriculum/completion-discipline.json"
import regressionRecovery from "../../fixtures/rsi-curriculum/regression-recovery.json"
import toolEfficiency from "../../fixtures/rsi-curriculum/tool-efficiency.json"
import generalization from "../../fixtures/rsi-curriculum/generalization.json"

interface CurriculumFixture {
	id: string
	description: string
	command: string
	capability: string
	task: string
}

const FIXTURE_MANIFESTS = { "completion-discipline": completionDiscipline, "regression-recovery": regressionRecovery, "tool-efficiency": toolEfficiency, generalization }
const FIXTURES: Record<string, CurriculumFixture> = Object.fromEntries(Object.entries(FIXTURE_MANIFESTS).map(([id, fixture]) => {
	if (fixture.id !== id || typeof fixture.task !== "string" || !fixture.task || typeof fixture.capability !== "string" || !fixture.capability || typeof fixture.description !== "string" || !fixture.description) throw new Error(`curriculum fixture manifest ${id} is missing registered task metadata`)
	return [id, { id, description: fixture.description, command: `node fixtures/rsi-curriculum/validate.mjs --fixture ${id}`, capability: fixture.capability, task: fixture.task }]
}))

const FAILURE_TASKS: Record<string, { difficulty: CurriculumTask["difficulty"]; fixtureId: string }> = {
	"iteration-cap": {
		difficulty: 3,
		fixtureId: "completion-discipline",
	},
	"regression-failure": {
		difficulty: 3,
		fixtureId: "regression-recovery",
	},
	"timeout": {
		difficulty: 4,
		fixtureId: "tool-efficiency",
	},
	"evaluation-failure": {
		difficulty: 4,
		fixtureId: "generalization",
	},
}

function candidateFailure(candidate: CandidateRecord): string | undefined {
	if (candidate.failure?.includes("Max iterations")) return "iteration-cap"
	if (candidate.result?.timedOut) return "timeout"
	if (candidate.result && !candidate.result.ok) return "evaluation-failure"
	return candidate.fitness?.hardGates.regressionPass === false ? "regression-failure" : undefined
}

export function generateCurriculumProposals(archive: RsiArchive, now = new Date().toISOString()): CurriculumTask[] {
	const grouped = new Map<string, CandidateRecord[]>()
	for (const candidate of archive.candidates) {
		const failure = candidateFailure(candidate)
		if (!failure) continue
		const entries = grouped.get(failure) ?? []
		entries.push(candidate)
		grouped.set(failure, entries)
	}
	return [...grouped.entries()].flatMap(([failureClass, candidates]) => {
		const definition = FAILURE_TASKS[failureClass] ?? FAILURE_TASKS["evaluation-failure"]
		const fixture = FIXTURES[definition.fixtureId]!
		const existing = archive.curriculumTasks.find((task) => task.id === `curriculum-${failureClass}` && task.fixtureId === fixture.id && task.task === fixture.task)
		return [{
			id: `curriculum-${failureClass}`,
			task: fixture.task,
			difficulty: definition.difficulty,
			capability: fixture.capability,
			groundTruthCommand: fixture.command,
			fixtureId: fixture.id,
			fixtureDescription: fixture.description,
			provenance: { sourceCandidateIds: candidates.map((candidate) => candidate.id), failureClass, generatedAt: now },
			validated: existing?.validated ?? false,
			...(existing?.validation ? { validation: existing.validation } : {}),
			...(existing?.promotedAt ? { promotedAt: existing.promotedAt } : {}),
		}]
	})
}

export function validateCurriculumTask(task: CurriculumTask): boolean {
	if (!task || typeof task !== "object") return false
	if (typeof task.fixtureId !== "string" || typeof task.task !== "string" || typeof task.capability !== "string" || typeof task.groundTruthCommand !== "string" || typeof task.fixtureDescription !== "string") return false
	const provenance = task.provenance as unknown
	if (!provenance || typeof provenance !== "object") return false
	const candidateIds = (provenance as { sourceCandidateIds?: unknown }).sourceCandidateIds
	if (!Array.isArray(candidateIds) || candidateIds.length === 0 || candidateIds.some((id) => typeof id !== "string" || id.length === 0)) return false
	const fixture = FIXTURES[task.fixtureId]
	return Boolean(fixture && task.task === fixture.task && task.capability === fixture.capability && task.groundTruthCommand === fixture.command && task.fixtureDescription === fixture.description)
}

export interface CurriculumReplayResult {
	ok: boolean
	exitCode: number | null
	outputSha256?: string
	failure?: string
}

export async function validateCurriculumProposals(
	tasks: CurriculumTask[],
	baseCommit: string,
	runReplay: (task: CurriculumTask, attempt: 1 | 2, idempotencyKey: string) => Promise<CurriculumReplayResult>,
	now = new Date().toISOString(),
): Promise<CurriculumTask[]> {
	return Promise.all(tasks.map(async (task) => {
		const replays: NonNullable<CurriculumTask["validation"]>["replays"] = []
		let reason = ""
		if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/i.test(baseCommit)) reason = "clean base commit is missing or malformed"
		else if (!validateCurriculumTask(task)) reason = "proposal does not resolve to an exact registered fixture and command"
		if (!reason) {
			for (const attempt of [1, 2] as const) {
				const idempotencyKey = `curriculum:${task.id}:replay:${attempt}`
				try {
					const result = await runReplay(task, attempt, idempotencyKey)
					replays.push({
						idempotencyKey,
						ok: result.ok,
						exitCode: result.exitCode,
						...(result.outputSha256 ? { outputSha256: result.outputSha256 } : {}),
						...(result.failure ? { failure: result.failure.slice(0, 1000) } : {}),
					})
					if (!result.ok || result.exitCode !== 0 || !/^[a-f0-9]{64}$/i.test(result.outputSha256 ?? "")) {
						reason = result.failure ?? `fixture replay ${attempt} did not produce a successful output artifact`
						break
					}
				} catch (error) {
					reason = error instanceof Error ? error.message.slice(0, 1000) : String(error).slice(0, 1000)
					break
				}
			}
		}
		const first = replays[0]
		const second = replays[1]
		const reproducible = Boolean(!reason && first?.ok && second?.ok && first.exitCode === second.exitCode && first.outputSha256 === second.outputSha256)
		if (!reason && !reproducible) reason = "two successful clean replays did not produce the same output digest"
		return {
			...task,
			validated: reproducible,
			validation: { baseCommit, command: task.groundTruthCommand, validatedAt: now, replays, reproducible, reason: reason || "two clean OpenShell replays passed reference tests, rejected a known mutant, and had identical output digests" },
		}
	}))
}

export function promoteValidatedCurriculumTask(task: CurriculumTask, promotedAt = new Date().toISOString()): CurriculumTask {
	const validation = task.validation
	const replays = Array.isArray(validation?.replays) ? validation.replays : []
	const digest = replays[0]?.outputSha256
	const evidenceValid = validateCurriculumTask(task)
		&& task.validated === true
		&& validation?.reproducible === true
		&& /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/i.test(validation.baseCommit)
		&& validation.command === task.groundTruthCommand
		&& replays.length === 2
		&& replays.every((replay, index) => replay.ok === true && replay.exitCode === 0 && replay.idempotencyKey === `curriculum:${task.id}:replay:${index + 1}` && /^[a-f0-9]{64}$/i.test(replay.outputSha256 ?? "") && replay.outputSha256 === digest)
	if (!evidenceValid) throw new Error(`curriculum task ${task.id} cannot be promoted without valid reproducible fixture evidence`)
	return { ...task, promotedAt }
}

export async function promoteArchivedCurriculumTask(archiveDir: string, taskId: string, promotedAt = new Date().toISOString()): Promise<CurriculumTask> {
	const archive = await readArchive(archiveDir)
	const task = archive.curriculumTasks.find((entry) => entry.id === taskId)
	if (!task) throw new Error(`curriculum task ${taskId} was not found in the archive`)
	const promoted = promoteValidatedCurriculumTask(task, promotedAt)
	archive.curriculumTasks = archive.curriculumTasks.map((entry) => entry.id === taskId ? promoted : entry)
	for (const run of [...archive.runs, ...archive.activeRuns]) run.curriculumTasks = (run.curriculumTasks ?? []).map((entry) => entry.id === taskId ? promoted : entry)
	const reportPaths = [...new Set([...archive.runs, ...archive.activeRuns].flatMap((run) => run.curriculumTasks?.some((entry) => entry.id === taskId) ? run.reports : []))]
	const backups = new Map<string, string>()
	for (const reportPath of reportPaths) backups.set(reportPath, await fs.readFile(reportPath, "utf8"))
	try {
		for (const reportPath of reportPaths) await fs.writeFile(reportPath, `${backups.get(reportPath)}\nCurriculum task ${taskId} was explicitly promoted at ${promotedAt}.\n`, "utf8")
		await writeArchive(archiveDir, archive)
	} catch (error) {
		const rollbackFailures: string[] = []
		for (const [reportPath, content] of backups) {
			try { await fs.writeFile(reportPath, content, "utf8") }
			catch (rollbackError) { rollbackFailures.push(`${reportPath}: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`) }
		}
		if (rollbackFailures.length) throw new Error(`promotion failed: ${error instanceof Error ? error.message : String(error)}; report rollback failed: ${rollbackFailures.join("; ")}`)
		throw error
	}
	return promoted
}

export async function writeCurriculumProposals(tasks: CurriculumTask[], outputDir: string): Promise<string> {
	await fs.mkdir(outputDir, { recursive: true })
	const outputPath = path.join(outputDir, "proposals.json")
	await fs.writeFile(outputPath, `${JSON.stringify(tasks, null, 2)}\n`, "utf8")
	return outputPath
}
