import * as fs from "node:fs/promises"
import * as path from "node:path"
import type { CandidateRecord, CurriculumTask, RsiArchive } from "./types.js"

const FAILURE_TASKS: Record<string, { capability: string; difficulty: CurriculumTask["difficulty"]; template: string }> = {
	"iteration-cap": {
		capability: "completion-discipline",
		difficulty: 3,
		template: "Complete a bounded implementation task and prove it with a final verification command before the iteration budget expires.",
	},
	"regression-failure": {
		capability: "regression-recovery",
		difficulty: 3,
		template: "Repair a deliberately failing change while preserving the existing regression suite and report the verified result.",
	},
	"timeout": {
		capability: "tool-efficiency",
		difficulty: 4,
		template: "Solve a repository task under a strict command-time budget without repeating unproductive exploration.",
	},
	"evaluation-failure": {
		capability: "generalization",
		difficulty: 4,
		template: "Make a focused repository improvement that passes the visible suite and an adjacent executable behavior check.",
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
		return [{
			id: `curriculum-${failureClass}`,
			task: definition.template,
			difficulty: definition.difficulty,
			capability: definition.capability,
			groundTruthCommand: "npm test",
			provenance: { sourceCandidateIds: candidates.map((candidate) => candidate.id), failureClass, generatedAt: now },
			validated: false,
		}]
	})
}

export function validateCurriculumTask(task: CurriculumTask): boolean {
	return task.task.trim() !== "" && task.groundTruthCommand.trim() !== "" && task.provenance.sourceCandidateIds.length > 0
}

export async function writeCurriculumProposals(tasks: CurriculumTask[], outputDir: string): Promise<string> {
	await fs.mkdir(outputDir, { recursive: true })
	const validated = tasks.map((task) => ({ ...task, validated: validateCurriculumTask(task) }))
	const outputPath = path.join(outputDir, "proposals.json")
	await fs.writeFile(outputPath, `${JSON.stringify(validated, null, 2)}\n`, "utf8")
	return outputPath
}
