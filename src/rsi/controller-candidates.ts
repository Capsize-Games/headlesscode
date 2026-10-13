import { execFileSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import { baseModelCandidate } from "./models.js"
import { mutationSnapshotProtectedPathViolations } from "./sandbox.js"
import type {
	CandidateRecord,
	ExperimentJob,
	RsiArchive,
	RsiConfig,
	RsiRunRecord,
} from "./types.js"

export function isTerminal(candidate: CandidateRecord): boolean {
	return candidate.status === "accepted" || candidate.status === "rejected" || candidate.status === "failed"
}

export class CandidateLineageError extends Error {}

export function validateCandidateParent(candidate: CandidateRecord, run: RsiRunRecord, config: RsiConfig, protocol: NonNullable<RsiRunRecord["developmentProofProtocol"]>): void {
	if (candidate.parent === "baseline") {
		if (candidate.baseCommit !== run.baseCommit || candidate.parentCommit !== run.baseCommit) throw new CandidateLineageError("baseline child does not use the frozen run base commit")
		return
	}
	const parent = run.candidates.find((entry) => entry.id === candidate.parent)
	if (!parent || parent.status !== "accepted" || parent.developmentProof?.accepted !== true || parent.developmentProof.runId !== run.runId || parent.developmentProof.protocolDigest !== protocol.protocolDigest || !parent.fitness || Object.values(parent.fitness.hardGates).some((passed) => passed === false)) {
		throw new CandidateLineageError(`candidate parent ${candidate.parent} is missing, rejected, from another run/protocol, or fails hard gates`)
	}
	const parentCommit = parent.commits[0]
	if (!parentCommit || candidate.baseCommit !== parentCommit || candidate.parentCommit !== parentCommit) throw new CandidateLineageError(`candidate parent ${candidate.parent} commit does not match its mutation base`)
	try {
		execFileSync("git", ["merge-base", "--is-ancestor", run.baseCommit, parentCommit], { cwd: config.repoRoot, stdio: "ignore" })
	} catch { throw new CandidateLineageError(`candidate parent ${candidate.parent} is outside the frozen run base lineage`) }
	const inheritedPaths = execFileSync("git", ["diff", "--name-only", "-z", "--no-renames", run.baseCommit, parentCommit], { cwd: config.repoRoot, encoding: "buffer" }) as Buffer
	const violations = mutationSnapshotProtectedPathViolations(inheritedPaths.toString("utf8").split("\0").filter(Boolean), config.protectedPaths)
	if (violations.length > 0) throw new CandidateLineageError(`candidate parent ${candidate.parent} inherits protected path changes: ${violations.join(", ")}`)
}

export function replaceJob(run: RsiRunRecord, job: ExperimentJob): void {
	run.jobs ??= []
	const index = run.jobs.findIndex((entry) => entry.id === job.id)
	if (index >= 0) run.jobs[index] = job
	else run.jobs.push(job)
}

export function combinedArchive(archive: RsiArchive, run: RsiRunRecord): RsiArchive {
	const currentIds = new Set(run.candidates.map((candidate) => candidate.id))
	return { ...archive, candidates: [...archive.candidates.filter((candidate) => !currentIds.has(candidate.id)), ...run.candidates] }
}

export function validateDeterministicWorkerHarnessRunId(config: RsiConfig): void {
	if (config.workerHarnessRunId) {
		const suffix = config.workerHarnessMode === "fixed-control" ? "fixed" : config.workerHarnessMode === "self-hosted" ? "self" : undefined
		if (!config.workerHarnessPairId || !suffix || config.workerHarnessRunId !== `${config.workerHarnessPairId}-${suffix}` || !/^rsi-proof-[a-f0-9]{20}-(fixed|self)$/.test(config.workerHarnessRunId)) throw new Error("deterministic worker harness run ID must match its paired campaign and arm")
	}
	}

export function initialRun(config: RsiConfig, baseCommit: string, now: string): RsiRunRecord {
	const modelCandidateId = config.modelCandidateId ?? "model-base"
	validateDeterministicWorkerHarnessRunId(config)
	return {
		runId: config.workerHarnessRunId ?? `rsi-${now.replace(/[^0-9]/g, "").slice(0, 14)}-${randomUUID().slice(0, 8)}`,
		startedAt: now,
		model: config.model,
		baseRef: config.baseRef,
		baseCommit,
		generations: config.generations,
		parentSelectionPolicy: config.parentSelectionPolicy ?? "champion-specialist-novelty",
		selectedCandidates: [],
		parentChoices: {},
		modelCandidates: [baseModelCandidate(config.model, now, modelCandidateId)],
		combinations: [],
		jobs: [],
		trajectoryRefs: [],
		curriculumTasks: [],
		adversarialReviews: [],
		candidates: [],
		reports: [],
		confirmationEvidence: "unmeasured",
	}
}
