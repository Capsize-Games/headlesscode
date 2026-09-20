import * as fs from "node:fs/promises"
import * as path from "node:path"
import type { CandidateRecord, RsiArchive, RsiRunRecord } from "./types.js"

export function archivePath(archiveDir: string): string {
	return path.join(archiveDir, "archive.json")
}

function emptyArchive(): RsiArchive {
	return {
		schemaVersion: 2,
		updatedAt: new Date(0).toISOString(),
		runs: [],
		activeRuns: [],
		candidates: [],
		modelCandidates: [],
		combinations: [],
		jobs: [],
		trajectoryRefs: [],
		curriculumTasks: [],
	}
}

function normalizeRun(run: RsiRunRecord): RsiRunRecord {
	return {
		...run,
		candidates: Array.isArray(run.candidates) ? run.candidates : [],
		reports: Array.isArray(run.reports) ? run.reports : [],
		selectedCandidates: run.selectedCandidates ?? (run.selected ? [run.selected] : []),
	}
}

function migrate(raw: Partial<RsiArchive> & { schemaVersion?: number }): RsiArchive {
	const archive = emptyArchive()
	archive.updatedAt = raw.updatedAt ?? archive.updatedAt
	archive.runs = (Array.isArray(raw.runs) ? raw.runs : []).map((run) => normalizeRun(run))
	archive.activeRuns = (Array.isArray(raw.activeRuns) ? raw.activeRuns : []).map((run) => normalizeRun(run))
	archive.candidates = Array.isArray(raw.candidates) ? raw.candidates : archive.runs.flatMap((run) => run.candidates)
	archive.modelCandidates = Array.isArray(raw.modelCandidates) ? raw.modelCandidates : []
	archive.combinations = Array.isArray(raw.combinations) ? raw.combinations : []
	archive.jobs = Array.isArray(raw.jobs) ? raw.jobs : []
	archive.trajectoryRefs = Array.isArray(raw.trajectoryRefs) ? raw.trajectoryRefs : []
	archive.curriculumTasks = Array.isArray(raw.curriculumTasks) ? raw.curriculumTasks : []
	return archive
}

export async function readArchive(archiveDir: string): Promise<RsiArchive> {
	try {
		const raw = await fs.readFile(archivePath(archiveDir), "utf8")
		const parsed = JSON.parse(raw) as Record<string, unknown> & { schemaVersion?: number }
		if ((parsed.schemaVersion === 1 || parsed.schemaVersion === 2) && Array.isArray(parsed.runs)) {
			return migrate(parsed as Partial<RsiArchive> & { schemaVersion?: number })
		}
	} catch {
		// A missing or malformed archive starts a new durable history. The next
		// write makes the state explicit and inspectable.
	}
	return emptyArchive()
}

export async function writeArchive(archiveDir: string, archive: RsiArchive): Promise<void> {
	await fs.mkdir(archiveDir, { recursive: true })
	const destination = archivePath(archiveDir)
	const temporary = `${destination}.tmp-${process.pid}`
	await fs.writeFile(temporary, `${JSON.stringify(archive, null, 2)}\n`, "utf8")
	await fs.rename(temporary, destination)
}

export async function appendRun(archiveDir: string, run: RsiRunRecord): Promise<RsiArchive> {
	const archive = await readArchive(archiveDir)
	archive.activeRuns = archive.activeRuns.filter((entry) => entry.runId !== run.runId)
	archive.runs = [...archive.runs.filter((entry) => entry.runId !== run.runId), normalizeRun(run)]
	for (const candidate of run.candidates) {
		const index = archive.candidates.findIndex((entry) => entry.id === candidate.id)
		if (index >= 0) archive.candidates[index] = candidate
		else archive.candidates.push(candidate)
	}
	for (const model of run.modelCandidates ?? []) {
		if (!archive.modelCandidates.some((entry) => entry.id === model.id)) archive.modelCandidates.push(model)
	}
	for (const combination of run.combinations ?? []) {
		const index = archive.combinations.findIndex((entry) => entry.id === combination.id)
		if (index >= 0) archive.combinations[index] = combination
		else archive.combinations.push(combination)
	}
	for (const job of run.jobs ?? []) {
		const index = archive.jobs.findIndex((entry) => entry.id === job.id)
		if (index >= 0) archive.jobs[index] = job
		else archive.jobs.push(job)
	}
	for (const task of run.curriculumTasks ?? []) {
		if (!archive.curriculumTasks.some((entry) => entry.id === task.id)) archive.curriculumTasks.push(task)
	}
	archive.trajectoryRefs = [...new Set([...archive.trajectoryRefs, ...(run.trajectoryRefs ?? [])])]
	archive.updatedAt = new Date().toISOString()
	await writeArchive(archiveDir, archive)
	return archive
}

export async function checkpointRun(archiveDir: string, run: RsiRunRecord): Promise<RsiArchive> {
	const archive = await readArchive(archiveDir)
	const normalized = normalizeRun(run)
	archive.activeRuns = [...archive.activeRuns.filter((entry) => entry.runId !== run.runId), normalized]
	for (const candidate of run.candidates) {
		const index = archive.candidates.findIndex((entry) => entry.id === candidate.id)
		if (index >= 0) archive.candidates[index] = candidate
		else archive.candidates.push(candidate)
	}
	for (const job of run.jobs ?? []) {
		const index = archive.jobs.findIndex((entry) => entry.id === job.id)
		if (index >= 0) archive.jobs[index] = job
		else archive.jobs.push(job)
	}
	archive.updatedAt = new Date().toISOString()
	await writeArchive(archiveDir, archive)
	return archive
}

export async function findActiveRun(archiveDir: string, runId: string): Promise<RsiRunRecord | undefined> {
	return (await readArchive(archiveDir)).activeRuns.find((run) => run.runId === runId)
}

export function archiveCandidate(archive: RsiArchive, candidate: CandidateRecord): RsiArchive {
	const index = archive.candidates.findIndex((entry) => entry.id === candidate.id)
	if (index >= 0) archive.candidates[index] = candidate
	else archive.candidates.push(candidate)
	archive.updatedAt = new Date().toISOString()
	return archive
}
