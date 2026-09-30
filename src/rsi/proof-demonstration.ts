import { createHash } from "node:crypto"
import type { BenchmarkAttempt } from "./benchmark/types.js"
import type { RsiRunRecord } from "./types.js"
import { proofCampaignManifestDigest } from "./proof-campaign.js"
import { RSI_OPENROUTER_MODEL } from "./inference-broker.js"

export type ProofDemonstrationVerdict = "demonstrated" | "inconclusive" | "not-demonstrated"
export interface ProofDemonstrationReport {
  schemaVersion: 1
  analysisVersion: "task-cluster-bootstrap-90-v1"
  verdict: ProofDemonstrationVerdict
  verdictReasons: string[]
  campaigns: Array<{
    campaignId: string
    selfHosted: { runId: string; finalCommit: string; selectedCandidateId: string; adjacentAcceptedDepth: number; confirmation: Array<Record<string, unknown>>; root: Array<Record<string, unknown>>; netWinsVsRoot: number; retentionLosses: string[]; resources: Record<string, number | null>; complete: boolean }
    fixedControl: { runId: string; finalCommit: string; selectedCandidateId: string; confirmation: Array<Record<string, unknown>>; root: Array<Record<string, unknown>>; resources: Record<string, number | null>; complete: boolean }
  }>
  pooled: { taskIds: string[]; campaignCount: number; selfHostedSuccesses: number; fixedControlSuccesses: number; difference: number; cluster90PercentInterval: [number, number] | null; bootstrapReplicates: number; bootstrapSeed: string }
  denominators: { campaigns: number; pairedConfirmationTasks: number; missingCells: string[]; excludedAttempts: string[] }
  limitations: string[]
}

function sha256(value: string): string { return createHash("sha256").update(value).digest("hex") }
function sorted<T extends string>(items: T[]): T[] { return [...items].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b))) }
function percentile(values: number[], fraction: number): number {
  if (!values.length) throw new Error("cannot calculate percentile from no bootstrap samples")
  return values[Math.min(values.length - 1, Math.max(0, Math.ceil(fraction * values.length) - 1))]!
}
function seededRandom(seed: string): () => number {
  let state = Number.parseInt(sha256(seed).slice(0, 8), 16) >>> 0
  if (!state) state = 0x9e3779b9
  return () => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return (state >>> 0) / 0x1_0000_0000 }
}
function campaignSlot(run: RsiRunRecord, candidateId: string): string | undefined {
  const candidate = run.candidates.find((entry) => entry.id === candidateId)
  if (!candidate) return undefined
  const generation = run.candidates.filter((entry) => entry.generation === candidate.generation)
  const index = generation.indexOf(candidate)
  return index < 0 ? undefined : "g" + candidate.generation + "-candidate-" + index
}
function durablySelected(run: RsiRunRecord, candidate: RsiRunRecord["candidates"][number]): boolean {
  const snapshot = run.proofCampaign?.ledgerSnapshot
  const slot = campaignSlot(run, candidate.id)
  if (!snapshot || !slot) return false
  const events = (snapshot.events as Array<Record<string, unknown>> | undefined) ?? []
  const decisions = (snapshot.decisions as Array<Record<string, unknown>> | undefined) ?? []
  const selected = events.some((event) => event.arm_id === run.workerHarnessMode && event.event_type === "generation-selected" && Number((event.payload as { generation?: unknown })?.generation) === candidate.generation && ((event.payload as { selectedCandidateIds?: unknown })?.selectedCandidateIds as unknown[] | undefined)?.includes(slot))
  const decision = decisions.find((entry) => entry.arm_id === run.workerHarnessMode && Number(entry.generation) === candidate.generation && entry.candidate_id === slot)
  return selected && decision?.decision === "accepted" && decision.child_commit === candidate.commits[0] && decision.parent_commit === candidate.parentCommit && decision.parent_id === (candidate.parent === "baseline" ? "baseline" : campaignSlot(run, candidate.parent ?? ""))
}
function chainDepth(run: RsiRunRecord): number {
  const selected = run.proofConfirmation?.selectedHarness
  let current = selected ? run.candidates.find((candidate) => candidate.id === selected.candidateId) : undefined
  if (!current || current.status !== "accepted" || current.developmentProof?.accepted !== true || !durablySelected(run, current)) return 0
  let depth = 0
  for (;;) {
    if (!current.parent || current.parent === "baseline") {
      if (current.generation === 0 && current.baseCommit === run.baseCommit && current.parentCommit === run.baseCommit && current.developmentProof?.immediateParent.comparable && current.developmentProof.immediateParent.eligible && durablySelected(run, current)) depth++
      return depth
    }
    const parent = run.candidates.find((candidate) => candidate.id === current!.parent)
    if (!parent || parent.status !== "accepted" || parent.developmentProof?.accepted !== true || !durablySelected(run, parent) || current.generation !== parent.generation + 1 || current.baseCommit !== parent.commits[0] || current.parentCommit !== parent.commits[0] || !current.developmentProof?.immediateParent.comparable || !current.developmentProof.immediateParent.eligible || current.workerHarnessExecution?.parentCommit !== parent.commits[0]) return depth
    depth++
    current = parent
  }
}

function attemptSummary(attempt: BenchmarkAttempt): Record<string, unknown> {
  return {
    attemptId: attempt.attemptId, taskId: attempt.taskId, harnessCommit: attempt.harnessCommit,
    verifiedSuccess: attempt.verifiedSuccess, validity: attempt.validity, proofQualified: attempt.proofQualified,
    resourceAccounting: attempt.resourceAccounting, calls: attempt.calls, tokens: attempt.tokens,
    wallTimeMs: attempt.wallTimeMs, costUsd: attempt.inferenceReceipt?.costUsd ?? null,
    model: attempt.model, seed: attempt.seed, startDigest: attempt.startDigest,
    evaluatorDigest: attempt.evaluatorDigest, patchDigest: attempt.patchDigest,
    artifactRefs: attempt.artifactRefs, stopReason: attempt.stopReason,
  }
}
function ledgerAttempt(run: RsiRunRecord, attempt: BenchmarkAttempt): Record<string, unknown> | undefined {
  const entries = (run.proofCampaign?.ledgerSnapshot?.attempts as Array<Record<string, unknown>> | undefined) ?? []
  return entries.find((entry) => entry.broker_job_id === attempt.attemptId)
}
function validateScheduledConfirmation(run: RsiRunRecord, missing: string[]): boolean {
  const manifest = run.proofCampaign?.manifest
  const snapshot = run.proofCampaign?.ledgerSnapshot
  const rows = snapshot?.attempts as Array<Record<string, unknown>> | undefined
  if (!manifest || !rows) { missing.push(run.runId + ":missing-campaign-snapshot"); return false }
  const selected = run.proofConfirmation?.selectedHarness
  let complete = true
  for (const cell of manifest.schedule.filter((entry) => entry.armId === run.proofCampaign?.armId && entry.phase === "confirmation")) {
    const expected = cell.candidateId === "root-control" || (cell.candidateId === selected?.slotId && cell.generation === selected.generation) ? "completed" : "not-selected"
    const matches = rows.filter((row) => row.arm_id === run.proofCampaign?.armId && Number(row.generation) === cell.generation && row.candidate_id === cell.candidateId && row.task_id === cell.taskId && row.seed === cell.seed && row.attempt_kind === cell.attemptKind)
    if (matches.length !== 1 || matches[0]?.status !== expected) {
      missing.push(run.runId + "/" + cell.candidateId + "/" + cell.taskId + ":expected-" + expected)
      complete = false
    }
  }
  return complete
}
type FrozenTaskIdentity = { id: string; seed: number; startDigest: string; verifierDigest: string; ceilings: BenchmarkAttempt["ceilings"] }
function validateAttempt(run: RsiRunRecord, attempt: BenchmarkAttempt, expectedCommit: string, expectedTask: FrozenTaskIdentity | undefined, missing: string[], excluded: string[]): boolean {
	const expectedTaskId = expectedTask?.id ?? "unknown-task"
	const label = run.runId + "/" + expectedTaskId
	if (!expectedTask || attempt.taskId !== expectedTaskId || attempt.harnessCommit !== expectedCommit || attempt.split !== "confirmation" || attempt.seed !== expectedTask.seed || attempt.startDigest !== expectedTask.startDigest || attempt.evaluatorDigest !== expectedTask.verifierDigest || JSON.stringify(attempt.ceilings) !== JSON.stringify(expectedTask.ceilings)) { missing.push(label + ":identity"); return false }
	const expectedModel = run.proofCampaign?.manifest.model
	if (!expectedModel || attempt.model.provider !== expectedModel.provider || attempt.model.id !== expectedModel.id || JSON.stringify(attempt.model.sampling) !== JSON.stringify(expectedModel.settings.sampling) || attempt.inferenceReceipt?.model !== expectedModel.id || attempt.inferenceReceipt.returnedModels.length !== 1 || attempt.inferenceReceipt.returnedModels[0] !== expectedModel.id) { missing.push(label + ":model-identity"); return false }
	const limits = run.proofCampaign?.manifest.settings.inferenceCeilings as { maxInputTokensPerCall?: unknown; maxTotalTokens?: unknown; maxJobSpendUsd?: unknown } | undefined
	const maxTokens = Math.min(Number(limits?.maxTotalTokens), expectedTask.ceilings.maxCalls * (Number(limits?.maxInputTokensPerCall) + expectedTask.ceilings.maxOutputTokensPerCall))
	if (!Number.isSafeInteger(maxTokens) || attempt.wallTimeMs > expectedTask.ceilings.timeoutMs || attempt.calls === null || attempt.calls > expectedTask.ceilings.maxCalls || attempt.tokens === null || attempt.tokens > maxTokens || attempt.inferenceReceipt?.costUsd === null || attempt.inferenceReceipt?.costUsd === undefined || attempt.inferenceReceipt.costUsd > Number(limits?.maxJobSpendUsd) || attempt.inferenceReceipt.calls !== attempt.calls || attempt.inferenceReceipt.totalTokens !== attempt.tokens) { missing.push(label + ":resource-ceiling"); return false }
	const row = ledgerAttempt(run, attempt)
	if (!row || row.status !== "completed" || row.result_sha256 !== sha256(JSON.stringify(attempt))) { missing.push(label + ":ledger-result"); return false }
	const savedRefs = row.artifact_refs as Record<string, { sha256?: string }> | undefined
	if (!savedRefs || Object.entries(attempt.artifactRefs).some(([key, value]) => savedRefs[key]?.sha256 !== value)) { missing.push(label + ":artifact-reference-mismatch"); return false }
  if (attempt.validity !== "valid" || !attempt.proofQualified || attempt.resourceAccounting !== "supervisor-enforced" || !attempt.inferenceReceipt?.qualified) {
    excluded.push(label + ":" + attempt.validity + "/" + attempt.resourceAccounting)
    return false
  }
  return true
}
function matchAttempts(run: RsiRunRecord, attemptIds: string[], commit: string, taskIds: string[], taskIdentities: Map<string, FrozenTaskIdentity>, missing: string[], excluded: string[]): Map<string, BenchmarkAttempt> {
  const all = new Map((run.confirmationAttempts ?? []).map((attempt) => [attempt.attemptId, attempt]))
  const selected = attemptIds.map((id) => all.get(id)).filter((entry): entry is BenchmarkAttempt => Boolean(entry))
  if (selected.length !== attemptIds.length) missing.push(run.runId + ":attempt-artifact")
  const byTask = new Map<string, BenchmarkAttempt>()
  for (const taskId of taskIds) {
    const matches = selected.filter((attempt) => attempt.taskId === taskId)
    if (matches.length !== 1) { missing.push(run.runId + "/" + taskId + ":expected-one-attempt"); continue }
		if (validateAttempt(run, matches[0]!, commit, taskIdentities.get(taskId), missing, excluded)) byTask.set(taskId, matches[0]!)
  }
  return byTask
}

/** Recompute the preregistered verdict from immutable attempt artifacts and durable campaign snapshots. */
export function analyzeProofDemonstration(runs: RsiRunRecord[], options: { expectedCampaignIds: string[]; retentionTaskIds?: string[]; bootstrapSeed: string; bootstrapReplicates?: number }): ProofDemonstrationReport {
  const missing: string[] = []
  const excluded: string[] = []
  const campaignIds = sorted([...new Set(options.expectedCampaignIds)])
  if (campaignIds.length !== 3 || options.expectedCampaignIds.length !== 3) throw new Error("analysis requires exactly three distinct preregistered campaign IDs")
  const confirmationTasks = sorted([...new Set(runs.flatMap((run) => run.proofCampaign?.manifest.schedule.filter((cell) => cell.phase === "confirmation" && cell.candidateId === "root-control").map((cell) => cell.taskId) ?? []))])
  if (!confirmationTasks.length) throw new Error("confirmation task schedule is empty")
  const frozenRetentionTaskIds = (runs.find((run) => run.proofCampaign)?.proofCampaign?.manifest.acceptanceRule.confirmationRetentionTaskIds as string[] | undefined) ?? []
  if (!frozenRetentionTaskIds.length || frozenRetentionTaskIds.some((id) => !confirmationTasks.includes(id))) throw new Error("frozen confirmation retention set is missing or outside the confirmation split")
  if (options.retentionTaskIds && JSON.stringify(sorted(options.retentionTaskIds)) !== JSON.stringify(sorted(frozenRetentionTaskIds))) throw new Error("analysis retention set differs from the frozen confirmation rule")
  const campaigns: ProofDemonstrationReport["campaigns"] = []
  const benchmarkManifestDigests = new Set<string>()
  const providerModels = new Set<string>()
  const protocolIdentities = new Set<string>()
  const campaignSeeds = new Set<string>()
  const paired: Array<{ taskId: string; self: number; fixed: number }> = []
  let selfSuccesses = 0
  let fixedSuccesses = 0
  for (const campaignId of campaignIds) {
    const arms = runs.filter((run) => run.workerHarnessPairId === campaignId)
    const selfRun = arms.find((run) => run.workerHarnessMode === "self-hosted")
    const fixedRun = arms.find((run) => run.workerHarnessMode === "fixed-control")
    if (!selfRun || !fixedRun) { missing.push(campaignId + ":missing-arm"); continue }
    if (selfRun.proofCampaign?.manifestSha256 !== fixedRun.proofCampaign?.manifestSha256 || selfRun.workerHarnessConfigDigest !== fixedRun.workerHarnessConfigDigest || selfRun.workerHarnessSamplingSeed !== fixedRun.workerHarnessSamplingSeed) missing.push(campaignId + ":paired-manifest-or-seed-mismatch")
    for (const run of [selfRun, fixedRun]) {
      const frozen = run.proofCampaign?.manifest
      if (frozen) {
        benchmarkManifestDigests.add(frozen.benchmarkDigests.manifest)
        providerModels.add(frozen.model.provider + "/" + frozen.model.id)
        campaignSeeds.add(frozen.seed)
        const frozenSettings = Object.fromEntries(Object.entries(frozen.settings).filter(([key]) => key !== "configDigest" && key !== "inferenceCampaignIds"))
        protocolIdentities.add(JSON.stringify({ rootCommit: frozen.rootCommit, benchmarkDigests: frozen.benchmarkDigests, provider: frozen.model.provider, model: frozen.model.id, modelSettings: frozen.model.settings, settings: frozenSettings, acceptanceRule: frozen.acceptanceRule, runtime: frozen.runtime, budgets: frozen.budgets, taskOrder: frozen.taskOrder, analysisVersion: frozen.analysisVersion }))
        for (const armId of [frozen.armAssignment.fixedControl, frozen.armAssignment.selfHosted]) {
          const rootTaskIds = sorted(frozen.schedule.filter((cell) => cell.armId === armId && cell.phase === "confirmation" && cell.candidateId === "root-control").map((cell) => cell.taskId))
          if (JSON.stringify(rootTaskIds) !== JSON.stringify(confirmationTasks)) missing.push(campaignId + ":confirmation-task-schedule-mismatch:" + armId)
        }
      }
    }
    const selfMeta = selfRun.proofConfirmation
    const fixedMeta = fixedRun.proofConfirmation
    if (!selfMeta || !fixedMeta) { missing.push(campaignId + ":missing-final-harness-selection"); continue }
    const identities = ((selfRun.proofCampaign?.manifest.settings.confirmationTaskIdentities as FrozenTaskIdentity[] | undefined) ?? []).map((task) => [task.id, task] as const)
    const taskIdentities = new Map(identities)
    if (confirmationTasks.some((taskId) => !taskIdentities.has(taskId))) missing.push(campaignId + ":missing-frozen-task-identity")
    const selfFinal = matchAttempts(selfRun, selfMeta.selectedHarness.attemptIds, selfMeta.selectedHarness.commit, confirmationTasks, taskIdentities, missing, excluded)
    const selfRoot = matchAttempts(selfRun, selfMeta.rootHarness.attemptIds, selfMeta.rootHarness.commit, confirmationTasks, taskIdentities, missing, excluded)
    const fixedFinal = matchAttempts(fixedRun, fixedMeta.selectedHarness.attemptIds, fixedMeta.selectedHarness.commit, confirmationTasks, taskIdentities, missing, excluded)
    const fixedRoot = matchAttempts(fixedRun, fixedMeta.rootHarness.attemptIds, fixedMeta.rootHarness.commit, confirmationTasks, taskIdentities, missing, excluded)
    const wins = confirmationTasks.filter((id) => selfFinal.get(id)?.verifiedSuccess && !selfRoot.get(id)?.verifiedSuccess).length
    const losses = confirmationTasks.filter((id) => !selfFinal.get(id)?.verifiedSuccess && selfRoot.get(id)?.verifiedSuccess).length
    const retentionLosses = frozenRetentionTaskIds.filter((id) => selfFinal.has(id) && selfRoot.has(id) && !selfFinal.get(id)?.verifiedSuccess && Boolean(selfRoot.get(id)?.verifiedSuccess))
    const depth = chainDepth(selfRun)
    const selfComplete = selfFinal.size === confirmationTasks.length && selfRoot.size === confirmationTasks.length && selfRun.confirmationEvidence === "complete" && validateScheduledConfirmation(selfRun, missing)
    const fixedComplete = fixedFinal.size === confirmationTasks.length && fixedRoot.size === confirmationTasks.length && fixedRun.confirmationEvidence === "complete" && validateScheduledConfirmation(fixedRun, missing)
    const latestSnapshot = [selfRun, fixedRun].map((armRun) => armRun.proofCampaign?.ledgerSnapshot).filter((snapshot): snapshot is NonNullable<RsiRunRecord["proofCampaign"]>["ledgerSnapshot"] => Boolean(snapshot)).sort((a, b) => Number((b?.campaign as Record<string, unknown> | undefined)?.sequence ?? 0) - Number((a?.campaign as Record<string, unknown> | undefined)?.sequence ?? 0))[0]
    const ledger = latestSnapshot?.campaign as Record<string, unknown> | undefined
    const ledgerArms = latestSnapshot?.arms as Array<Record<string, unknown>> | undefined
    const manifest = selfRun.proofCampaign?.manifest
    if (!ledger || !manifest || ledger.state !== "finished" || String(ledger.manifest_sha256).trim() !== proofCampaignManifestDigest(manifest) || manifest.campaignId !== campaignId) missing.push(campaignId + ":campaign-ledger-not-finished-or-manifest-corrupt")
    if (!ledgerArms || ledgerArms.length !== 2 || ledgerArms.some((arm) => arm.state !== "finished")) missing.push(campaignId + ":campaign-arm-not-finished")
    if (ledger && manifest) {
      const usedCalls = Number(ledger.used_calls)
      const usedTokens = Number(ledger.used_tokens)
      const usedSpend = Number(ledger.used_spend_microusd)
      const reservedCalls = Number(ledger.reserved_calls)
      const reservedTokens = Number(ledger.reserved_tokens)
      const reservedSpend = Number(ledger.reserved_spend_microusd)
      if (![usedCalls, usedTokens, usedSpend, reservedCalls, reservedTokens, reservedSpend].every(Number.isSafeInteger) || usedCalls > manifest.budgets.root.maxCalls || usedTokens > manifest.budgets.root.maxTokens || usedSpend > Math.floor(manifest.budgets.root.maxSpendUsd * 1_000_000) || reservedCalls !== 0 || reservedTokens !== 0 || reservedSpend !== 0) missing.push(campaignId + ":root-budget-accounting-invalid")
      const deadline = Date.parse(String(ledger.deadline_at))
      if (!Number.isFinite(deadline) || [selfRun, fixedRun].some((armRun) => !armRun.finishedAt || Date.parse(armRun.finishedAt) > deadline)) missing.push(campaignId + ":root-runtime-deadline-exceeded")
    }
    const retentionIds = manifest?.acceptanceRule.confirmationRetentionTaskIds
    if (!Array.isArray(retentionIds) || retentionIds.length === 0 || retentionIds.some((id) => typeof id !== "string" || !confirmationTasks.includes(id)) || JSON.stringify(sorted(retentionIds as string[])) !== JSON.stringify(sorted(frozenRetentionTaskIds))) missing.push(campaignId + ":confirmation-retention-set-invalid")
    if (!selfComplete || !fixedComplete) missing.push(campaignId + ":incomplete-confirmation-cells")
    for (const taskId of confirmationTasks) {
      const left = selfFinal.get(taskId)
      const right = fixedFinal.get(taskId)
      if (left && right) {
        const selfValue = left.verifiedSuccess ? 1 : 0
        const fixedValue = right.verifiedSuccess ? 1 : 0
        paired.push({ taskId, self: selfValue, fixed: fixedValue })
        selfSuccesses += selfValue
        fixedSuccesses += fixedValue
      }
    }
    const sumResources = (attempts: BenchmarkAttempt[]): Record<string, number | null> => ({
      calls: attempts.every((entry) => entry.calls !== null) ? attempts.reduce((sum, entry) => sum + (entry.calls ?? 0), 0) : null,
      tokens: attempts.every((entry) => entry.tokens !== null) ? attempts.reduce((sum, entry) => sum + (entry.tokens ?? 0), 0) : null,
      wallTimeMs: attempts.reduce((sum, entry) => sum + entry.wallTimeMs, 0),
      spendUsd: attempts.every((entry) => entry.inferenceReceipt?.costUsd !== null && entry.inferenceReceipt?.costUsd !== undefined) ? attempts.reduce((sum, entry) => sum + (entry.inferenceReceipt?.costUsd ?? 0), 0) : null,
    })
    campaigns.push({
      campaignId,
      selfHosted: { runId: selfRun.runId, finalCommit: selfMeta.selectedHarness.commit, selectedCandidateId: selfMeta.selectedHarness.candidateId, adjacentAcceptedDepth: depth, confirmation: [...selfFinal.values()].map(attemptSummary), root: [...selfRoot.values()].map(attemptSummary), netWinsVsRoot: wins - losses, retentionLosses, resources: sumResources([...selfFinal.values(), ...selfRoot.values()]), complete: selfComplete },
      fixedControl: { runId: fixedRun.runId, finalCommit: fixedMeta.selectedHarness.commit, selectedCandidateId: fixedMeta.selectedHarness.candidateId, confirmation: [...fixedFinal.values()].map(attemptSummary), root: [...fixedRoot.values()].map(attemptSummary), resources: sumResources([...fixedFinal.values(), ...fixedRoot.values()]), complete: fixedComplete },
    })
  }
  if (benchmarkManifestDigests.size !== 1) missing.push("paired:benchmark-manifest-digest-mismatch")
  if (providerModels.size !== 1) missing.push("paired:provider-model-mismatch")
  if (providerModels.size === 1 && !providerModels.has("openshell-openrouter/" + RSI_OPENROUTER_MODEL)) missing.push("paired:model-is-not-the-pinned-OpenRouter-endpoint")
  if (protocolIdentities.size !== 1) missing.push("paired:frozen-protocol-runtime-budget-or-selection-mismatch")
  if (campaignSeeds.size !== 3) missing.push("paired:campaign-seeds-are-not-three-independent-values")
  const taskIds = sorted([...new Set(paired.map((entry) => entry.taskId))])
  const replicates = options.bootstrapReplicates ?? 10_000
  if (!Number.isSafeInteger(replicates) || replicates < 1) throw new Error("bootstrap replicates must be a positive safe integer")
  let interval: [number, number] | null = null
  let difference = 0
  if (taskIds.length === confirmationTasks.length && paired.length === confirmationTasks.length * campaignIds.length) {
    const clusterMeans = taskIds.map((taskId) => {
      const cluster = paired.filter((entry) => entry.taskId === taskId)
      return cluster.reduce((sum, entry) => sum + entry.self - entry.fixed, 0) / cluster.length
    })
    difference = clusterMeans.reduce((sum, value) => sum + value, 0) / clusterMeans.length
    const random = seededRandom(options.bootstrapSeed)
    const samples: number[] = []
    for (let sample = 0; sample < replicates; sample++) {
      let total = 0
      for (let index = 0; index < clusterMeans.length; index++) total += clusterMeans[Math.floor(random() * clusterMeans.length)]!
      samples.push(total / clusterMeans.length)
    }
    samples.sort((a, b) => a - b)
    interval = [percentile(samples, 0.05), percentile(samples, 0.95)]
  } else missing.push("pooled:incomplete-task-cluster-matrix")
  const allComplete = missing.length === 0 && excluded.length === 0 && campaigns.length === 3 && campaigns.every((entry) => entry.selfHosted.complete && entry.fixedControl.complete)
  const winningCampaigns = campaigns.filter((entry) => entry.selfHosted.adjacentAcceptedDepth >= 2 && entry.selfHosted.netWinsVsRoot > 0 && entry.selfHosted.retentionLosses.length === 0).length
  const intervalPass = interval !== null && interval[0] > 0
  const demonstrated = allComplete && winningCampaigns >= 2 && intervalPass
  const reasons: string[] = []
  if (!allComplete) reasons.push("a frozen confirmation cell or durable artifact is missing, unqualified, or invalid")
  if (winningCampaigns < 2) reasons.push("fewer than two self-hosted campaigns have two successive immediate-parent transitions, a net confirmation win, and no retention loss")
  if (!intervalPass) reasons.push("the task-cluster 90% interval lower bound is not above zero")
  if (!demonstrated && allComplete) reasons.push("all scheduled cells completed, but one or more preregistered improvement gates did not pass")
  return {
    schemaVersion: 1, analysisVersion: "task-cluster-bootstrap-90-v1",
    verdict: demonstrated ? "demonstrated" : allComplete ? "not-demonstrated" : "inconclusive",
    verdictReasons: demonstrated ? ["all frozen campaign, lineage, confirmation, retention, and task-cluster interval gates passed"] : reasons,
    campaigns,
    pooled: { taskIds, campaignCount: campaignIds.length, selfHostedSuccesses: selfSuccesses, fixedControlSuccesses: fixedSuccesses, difference, cluster90PercentInterval: interval, bootstrapReplicates: replicates, bootstrapSeed: options.bootstrapSeed },
    denominators: { campaigns: campaignIds.length, pairedConfirmationTasks: taskIds.length, missingCells: sorted(missing), excludedAttempts: sorted(excluded) },
    limitations: ["This analysis covers only the registered tasks, runtime, model endpoint, prompts, and budgets.", "A result does not establish model-weight improvement or broad coding ability.", "Input and output artifacts must remain available for independent digest and verifier replay."],
  }
}
