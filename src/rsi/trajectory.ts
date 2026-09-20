import { createHash } from "node:crypto"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import type { CandidateRecord, RsiConfig, TrajectoryMessage, TrajectoryRecord, TrajectorySummary } from "./types.js"

interface CapturedCall {
	messages?: TrajectoryMessage[]
	response?: { message?: { tool_calls?: unknown[] } }
	error?: string
	provider?: string
	model?: string
}

function failureClass(candidate: CandidateRecord): string | undefined {
	if (candidate.failure) return candidate.failure.includes("Max iterations") ? "iteration-cap" : "mutation-failure"
	if (candidate.result && !candidate.result.ok) {
		const text = `${candidate.result.stderr}\n${candidate.result.stdout}`.toLowerCase()
		if (candidate.result.timedOut) return "timeout"
		if (text.includes("test") || text.includes("typecheck")) return "regression-failure"
		return "evaluation-failure"
	}
	return undefined
}

async function readCapturedCalls(candidate: CandidateRecord): Promise<CapturedCall[]> {
	const directory = path.join(candidate.worktree, ".headlesscode", "rsi-transcripts")
	let names: string[]
	try {
		names = (await fs.readdir(directory)).filter((name) => name.endsWith(".jsonl")).sort()
	} catch {
		return []
	}
	const calls: CapturedCall[] = []
	for (const name of names) {
		const lines = (await fs.readFile(path.join(directory, name), "utf8")).split("\n").filter(Boolean)
		for (const line of lines) {
			try {
				calls.push(JSON.parse(line) as CapturedCall)
			} catch {
				// A torn JSONL line is marked incomplete by the absence of a call.
			}
		}
	}
	return calls
}

export function trajectoryOutcome(candidate: CandidateRecord): TrajectoryRecord["outcome"] {
	if (candidate.status === "accepted" && candidate.fitness?.hardGates.completed) return "success"
	if (candidate.status === "failed" || candidate.status === "rejected") return "failure"
	return "incomplete"
}

export async function captureCandidateTrajectory(
	candidate: CandidateRecord,
	config: RsiConfig,
	now: string,
): Promise<{ record: TrajectoryRecord; summary: TrajectorySummary }> {
	const calls = await readCapturedCalls(candidate)
	const messages = calls.flatMap((call) => call.messages ?? [])
	const toolCalls = calls.reduce((count, call) => count + (call.response?.message?.tool_calls?.length ?? 0), 0)
	const outcome = trajectoryOutcome(candidate)
	const trusted = outcome === "success" && candidate.fitness?.hardGates.noProtectedPathViolation === true
	const record: TrajectoryRecord = {
		id: `trajectory-${candidate.id}`,
		task: candidate.mutation,
		environment: { repoRoot: config.repoRoot, baseCommit: candidate.baseCommit, generation: candidate.generation },
		model: { id: candidate.model, candidateId: candidate.modelCandidateId },
		harnessVersion: candidate.parentCommit ?? candidate.baseCommit,
		promptConfig: {
			mutationKind: candidate.mutationKind,
			hypothesis: candidate.hypothesis,
			parentSelection: candidate.parentSelection,
		},
		messages,
		toolCalls,
		outcome,
		verification: {
			verified: trusted,
			regressionPass: candidate.fitness?.hardGates.regressionPass === true,
			hiddenPass: candidate.fitness?.hardGates.hiddenEvalPass === true,
		},
		failureClassification: failureClass(candidate),
		fitnessImpact: candidate.fitness?.score,
		provenance: { source: "headlesscode-rsi", capturedAt: now, trusted },
	}
	const outputDir = config.trajectoryDir ?? path.join(config.archiveDir, "trajectories")
	await fs.mkdir(outputDir, { recursive: true })
	const outputPath = path.join(outputDir, `${candidate.id}.json`)
	await fs.writeFile(outputPath, `${JSON.stringify(record, null, 2)}\n`, "utf8")
	return {
		record,
		summary: {
			path: outputPath,
			messageCount: messages.length,
			toolCalls,
			trusted,
			outcome,
			failureClassification: record.failureClassification,
		},
	}
}

export async function readTrajectoryRecord(filePath: string): Promise<TrajectoryRecord | undefined> {
	try {
		return JSON.parse(await fs.readFile(filePath, "utf8")) as TrajectoryRecord
	} catch {
		return undefined
	}
}

function jsonl(records: unknown[]): string {
	return records.map((record) => JSON.stringify(record)).join("\n") + (records.length ? "\n" : "")
}

export async function exportTrajectoryDatasets(records: TrajectoryRecord[], outputDir: string): Promise<{
	sft: number
	preferences: number
	failures: number
	manifestPath: string
}> {
	await fs.mkdir(outputDir, { recursive: true })
	const trusted = records.filter((record) => record.provenance.trusted && record.outcome === "success")
	const failures = records.filter((record) => record.outcome === "failure")
	const preferences: Array<{ task: string; chosen: TrajectoryRecord; rejected: TrajectoryRecord }> = []
	for (const task of new Set(records.map((record) => record.task))) {
		const successful = records.find((record) => record.task === task && record.provenance.trusted && record.outcome === "success")
		const failed = records.find((record) => record.task === task && record.outcome === "failure")
		if (successful && failed) preferences.push({ task, chosen: successful, rejected: failed })
	}
	await fs.writeFile(path.join(outputDir, "sft.jsonl"), jsonl(trusted), "utf8")
	await fs.writeFile(path.join(outputDir, "preferences.jsonl"), jsonl(preferences), "utf8")
	await fs.writeFile(path.join(outputDir, "failures.jsonl"), jsonl(failures), "utf8")
	const manifest = {
		schemaVersion: 1,
		createdAt: new Date().toISOString(),
		counts: { sft: trusted.length, preferences: preferences.length, failures: failures.length },
		trustedOnly: true,
		sha256: createHash("sha256").update(JSON.stringify(records)).digest("hex"),
	}
	const manifestPath = path.join(outputDir, "manifest.json")
	await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8")
	return { ...manifest.counts, manifestPath }
}
