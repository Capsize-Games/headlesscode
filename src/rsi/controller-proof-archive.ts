import { createHash } from "node:crypto"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import { appendRun } from "./archive.js"
import { isTerminal } from "./controller-candidates.js"
import { compareFitness } from "./fitness.js"
import {
	openRouterProfileForModel,
	RSI_DEFAULT_OPENROUTER_PROFILE_ID,
} from "./inference-broker.js"
import {
	fleetJobMatches,
	type FleetJob,
	type FleetJobIdentity,
	type PostgresRsiJobQueue,
} from "./postgres-queue.js"
import {
	proofCampaignManifestDigest,
	type ProofCampaignArmLease,
	type ProofCampaignManifest,
} from "./proof-campaign.js"
import { formatRunReport } from "./reports.js"
import type { RsiConfig, RsiRunRecord } from "./types.js"

export async function reconcileProofCampaignJob(queue: PostgresRsiJobQueue, existing: FleetJob | undefined, expected: FleetJobIdentity, lease: ProofCampaignArmLease): Promise<FleetJob | undefined> {
	if (!existing || fleetJobMatches(existing, expected)) return existing
	if (existing.status === "queued") {
		const rebound = await queue.rebindQueuedProofJob(existing.jobId, expected, lease)
		if (fleetJobMatches(rebound, expected)) return rebound
	}
	throw new Error("existing proof campaign job is not the same completed result or a safely rebindable queued job")
}

export async function rebuildFinishedProofCampaignArchive(args: {
	run: RsiRunRecord
	config: RsiConfig
	snapshot: Record<string, unknown>
	manifest: ProofCampaignManifest
	armId: string
	now: () => string
}): Promise<RsiRunRecord> {
	const campaign = args.snapshot.campaign as Record<string, unknown> | undefined
	const arms = args.snapshot.arms as Array<Record<string, unknown>> | undefined
	const arm = arms?.find((entry) => entry.arm_id === args.armId)
	const expectedDigest = proofCampaignManifestDigest(args.manifest)
	if (!campaign || !arm || arm.state !== "finished" || String(campaign.manifest_sha256).trim() !== expectedDigest) throw new Error("finished proof campaign snapshot does not match the frozen manifest and arm")
	if (arm.run_id !== args.run.runId || args.run.candidates.some((candidate) => !isTerminal(candidate))) throw new Error("finished proof campaign arm cannot rebuild an incomplete or foreign run archive")
	if (args.manifest.phaseMode === "engineering-only") {
		const events = args.snapshot.events as Array<Record<string, unknown>> | undefined
		if (!events?.some((event) => event.arm_id === args.armId && event.event_type === "engineering-development-finished") || args.run.proofConfirmation || args.run.confirmationAttempts?.length) throw new Error("engineering-only recovery must have a terminal development event and no confirmation evidence")
	} else await verifyFinishedConfirmationCheckpoint(args.run, args.config.archiveDir, args.snapshot, args.manifest, args.armId)
	args.run.proofCampaign = { manifest: args.manifest, manifestSha256: expectedDigest, campaignId: args.manifest.campaignId, armId: args.armId, epoch: Number(arm.epoch), state: "finished", ledgerSnapshot: args.snapshot }
	const selections = (args.snapshot.events as Array<Record<string, unknown>>).filter((event) => event.arm_id === args.armId && event.event_type === "generation-selected").sort((left, right) => Number(left.sequence) - Number(right.sequence))
	const finalSelection = selections.at(-1)?.payload as { generation?: number; selectedCandidateIds?: string[] } | undefined
	if (finalSelection && Number.isSafeInteger(finalSelection.generation)) {
		args.run.selectedCandidates = (finalSelection.selectedCandidateIds ?? []).map((slot) => {
			const generationCandidates = args.run.candidates.filter((candidate) => candidate.generation === finalSelection.generation)
			const index = Number(/candidate-(\d+)$/.exec(slot)?.[1] ?? -1)
			return generationCandidates[index]?.id ?? ""
		}).filter(Boolean)
		args.run.selected ??= [...args.run.candidates.filter((candidate) => candidate.status === "accepted")].sort((a, b) => compareFitness(b.fitness, a.fitness))[0]?.id
	}
	args.run.finishedAt ??= args.now()
	const recoveredReportPath = `${args.config.archiveDir}/${args.run.runId}.md`
	await fs.mkdir(args.config.archiveDir, { recursive: true })
	await fs.writeFile(recoveredReportPath, formatRunReport(args.run, args.config), "utf8")
	args.run.reports = [...new Set([...args.run.reports, recoveredReportPath])]
	await appendRun(args.config.archiveDir, args.run)
	return args.run
}

export async function verifyFinishedConfirmationCheckpoint(run: RsiRunRecord, archiveDir: string, snapshot: Record<string, unknown>, manifest: ProofCampaignManifest, armId: string): Promise<void> {
	const events = snapshot.events as Array<Record<string, unknown>> | undefined
	const attempts = snapshot.attempts as Array<Record<string, unknown>> | undefined
	const selection = events?.filter((event) => event.arm_id === armId && event.event_type === "final-harness-selected")
	const payload = selection?.length === 1 ? selection[0]!.payload as { generation?: number; candidateId?: string; commit?: string } : undefined
	const saved = run.proofConfirmation
	if (!payload || !saved || saved.selectedHarness.slotId !== payload.candidateId || saved.selectedHarness.generation !== payload.generation || saved.selectedHarness.commit !== payload.commit || saved.rootHarness.commit !== manifest.rootCommit || run.confirmationEvidence !== "complete") throw new Error("finished campaign recovery requires a matching checkpointed final-harness selection and confirmation result")
	const cells = manifest.schedule.filter((cell) => cell.armId === armId && cell.phase === "confirmation" && (cell.candidateId === "root-control" || (cell.candidateId === payload.candidateId && cell.generation === payload.generation)))
	const byCandidateKind = (candidateId: string, kind: string) => cells.filter((cell) => cell.candidateId === candidateId && cell.attemptKind === kind)
	const selectedRows = byCandidateKind(String(payload.candidateId), payload.candidateId === "root-control" ? "fixed-control" : "confirmation")
	const rootRows = byCandidateKind("root-control", "fixed-control")
	const rowFor = (cell: typeof cells[number]) => attempts?.filter((row) => row.arm_id === armId && Number(row.generation) === cell.generation && row.candidate_id === cell.candidateId && row.task_id === cell.taskId && row.seed === cell.seed && row.attempt_kind === cell.attemptKind && row.status === "completed") ?? []
	const expectedSelectedRows = selectedRows.flatMap((cell) => rowFor(cell))
	const expectedRootRows = rootRows.flatMap((cell) => rowFor(cell))
	const orderedIds = (rows: Array<Record<string, unknown>>) => rows.map((row) => String(row.broker_job_id)).sort()
	if (expectedSelectedRows.length !== selectedRows.length || expectedRootRows.length !== rootRows.length || JSON.stringify(orderedIds(expectedSelectedRows)) !== JSON.stringify([...saved.selectedHarness.attemptIds].sort()) || JSON.stringify(orderedIds(expectedRootRows)) !== JSON.stringify([...saved.rootHarness.attemptIds].sort())) throw new Error("finished campaign recovery checkpoint does not name the completed selected and root confirmation cells")
	const artifacts = new Map((run.confirmationAttempts ?? []).map((attempt) => [attempt.attemptId, attempt]))
	for (const row of [...expectedSelectedRows, ...expectedRootRows]) {
		const attemptId = String(row.broker_job_id)
		const attempt = artifacts.get(attemptId)
		const expectedProfile = attempt ? openRouterProfileForModel(attempt.model.id, run.proofCampaign?.manifest.model.profileId) : undefined
		const profileIdMatches = expectedProfile?.id === RSI_DEFAULT_OPENROUTER_PROFILE_ID ? attempt?.inferenceReceipt?.profileId === undefined || attempt?.inferenceReceipt?.profileId === expectedProfile.id : attempt?.inferenceReceipt?.profileId === expectedProfile?.id
		if (!attempt || attempt.validity !== "valid" || !attempt.proofQualified || attempt.resourceAccounting !== "supervisor-enforced" || !attempt.inferenceReceipt?.qualified || !profileIdMatches || attempt.inferenceReceipt.endpointProvider !== expectedProfile?.endpointProvider || attempt.inferenceReceipt.returnedProviders?.join(",") !== expectedProfile?.endpointProvider || createHash("sha256").update(JSON.stringify(attempt)).digest("hex") !== String(row.result_sha256).trim()) throw new Error(`finished campaign recovery attempt ${attemptId} does not match its verified durable result`)
		const storedRefs = row.artifact_refs as Record<string, { sha256?: string }> | undefined
		if (!storedRefs || Object.entries(attempt.artifactRefs).some(([name, digest]) => storedRefs[name]?.sha256 !== digest)) throw new Error(`finished campaign recovery attempt ${attemptId} has different artifact references`)
		const candidateId = String(row.candidate_id)
		const kind = String(row.attempt_kind)
		const outputRoot = path.join(archiveDir, "confirmation", manifest.campaignId, armId, candidateId, kind, "harness", attempt.harnessCommit)
		for (const digest of Object.values(attempt.artifactRefs)) {
			if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error(`finished campaign recovery attempt ${attemptId} has a malformed artifact digest`)
			const artifact = path.join(outputRoot, "artifacts", "sha256", digest.slice(0, 2), digest)
			const stat = await fs.lstat(artifact)
			if (!stat.isFile() || stat.isSymbolicLink() || createHash("sha256").update(await fs.readFile(artifact)).digest("hex") !== digest) throw new Error(`finished campaign recovery artifact ${digest} is missing or changed`)
		}
	}
}

/** Rebuild only the durable development-phase checkpoint after its DB commit. */
export async function rebuildEvaluatedProofCampaignArchive(args: {
	run: RsiRunRecord
	config: RsiConfig
	snapshot: Record<string, unknown>
	manifest: ProofCampaignManifest
	armId: string
	now: () => string
}): Promise<RsiRunRecord> {
	const campaign = args.snapshot.campaign as Record<string, unknown> | undefined
	const arms = args.snapshot.arms as Array<Record<string, unknown>> | undefined
	const events = args.snapshot.events as Array<Record<string, unknown>> | undefined
	const arm = arms?.find((entry) => entry.arm_id === args.armId)
	const expectedDigest = proofCampaignManifestDigest(args.manifest)
	const finishEvent = events?.some((event) => event.arm_id === args.armId && event.event_type === "development-phase-finished" && (event.payload as { remainingPhase?: unknown })?.remainingPhase === "confirmation")
	if (!campaign || !arm || !finishEvent || arm.phase !== "confirmation" || !["evaluated", "selected", "rejected"].includes(String(arm.state)) || String(campaign.manifest_sha256).trim() !== expectedDigest) throw new Error("evaluated proof campaign snapshot does not match the frozen manifest and development completion")
	if (arm.run_id !== args.run.runId || args.run.candidates.some((candidate) => !isTerminal(candidate))) throw new Error("evaluated proof campaign arm cannot rebuild from an incomplete or foreign run checkpoint")
	const expectedMode = args.armId === args.manifest.armAssignment.fixedControl ? "fixed-control" : "self-hosted"
	if (args.run.workerHarnessPairId !== args.manifest.campaignId || args.run.workerHarnessMode !== expectedMode) throw new Error("evaluated proof campaign checkpoint has a foreign paired-run identity")
	if (arm.lease_expires_at && new Date(String(arm.lease_expires_at)).getTime() > Date.now()) throw new Error("evaluated proof campaign arm has an active coordinator; refusing read-only recovery during confirmation work")
	args.run.proofCampaign = { manifest: args.manifest, manifestSha256: expectedDigest, campaignId: args.manifest.campaignId, armId: args.armId, epoch: Number(arm.epoch), state: "evaluated", ledgerSnapshot: args.snapshot }
	args.run.finishedAt ??= args.now()
	const reportPath = `${args.config.archiveDir}/${args.run.runId}.md`
	await fs.mkdir(args.config.archiveDir, { recursive: true })
	await fs.writeFile(reportPath, formatRunReport(args.run, args.config), "utf8")
	args.run.reports = [...new Set([...args.run.reports, reportPath])]
	await appendRun(args.config.archiveDir, args.run)
	return args.run
}
