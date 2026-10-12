import type { CandidateRecord, Fitness, RsiConfig, RsiRunRecord } from "./types.js"

export function formatCandidate(candidate: CandidateRecord): string {
	const fitness = candidate.fitness
	const parent = candidate.parentSelection ? `, parent=${candidate.parent} (${candidate.parentSelection.strategy})` : ""
	const mutation = candidate.mutationKind ? `, mutation=${candidate.mutationKind}` : ""
	const metrics = fitness ? `, metrics=${JSON.stringify(fitness.metrics)}` : ""
	const comparison = candidate.pairedComparison ? `, paired=${candidate.pairedComparison.reason} (${candidate.pairedComparison.baselinePasses}/${candidate.pairedComparison.trialCount} → ${candidate.pairedComparison.candidatePasses}/${candidate.pairedComparison.trialCount}; duration ratio ${candidate.pairedComparison.durationRatio.toFixed(3)})` : ""
	const describeProofArm = (label: string, arm: NonNullable<CandidateRecord["developmentProof"]>["immediateParent"]): string => {
		const resources = (totals: typeof arm.childTotals) => `cost=${totals.costUsd ?? "unmeasured"}, calls=${totals.calls ?? "unmeasured"}, tokens=${totals.tokens ?? "unmeasured"}, wallMs=${totals.wallTimeMs ?? "unmeasured"}`
		return `${label}[${arm.childCommit} vs ${arm.referenceCommit}]: ${arm.comparable ? "comparable" : "incomparable"} (${arm.reason}); wins=${arm.childWins}-${arm.parentWins}, bothPass=${arm.bothPass}, bothFail=${arm.bothFail}, invalid=${arm.invalid}; child(${resources(arm.childTotals)}), reference(${resources(arm.parentTotals)}); meanTokenRatio=${arm.meanTokenIncreaseRatio ?? "unmeasured"}`
	}
	const proof = candidate.developmentProof?.immediateParent && candidate.developmentProof.originalBase
		? `, development=${candidate.developmentProof.accepted ? "eligible" : "ineligible"} (${candidate.developmentProof.reason}); ${describeProofArm("immediate-parent", candidate.developmentProof.immediateParent)}; ${describeProofArm("original-base", candidate.developmentProof.originalBase)}; protocol=${candidate.developmentProof.protocolDigest}; attemptRefs child/parent/root=${candidate.developmentProof.childAttemptIds.length}/${candidate.developmentProof.parentAttemptIds.length}/${candidate.developmentProof.originalBaseAttemptIds.length}`
		: candidate.developmentProof ? `, development=ineligible (${candidate.developmentProof.reason || "incomplete proof record"})` : ", development=unmeasured (no benchmark proof recorded)"
	const formatDenials = (denials: NonNullable<CandidateRecord["inferenceDenials"]>) => denials.map((entry) => `${entry.statusCode}:${entry.reason}=${entry.count}`).join(",") || "none"
	const model = candidate.modelProvider ? `, worker=${candidate.modelProvider}/${candidate.model}${candidate.inferenceUsage ? ` endpoint=${candidate.inferenceUsage.endpointProvider} returned=${candidate.inferenceUsage.returnedModels.join(",")} calls=${candidate.inferenceUsage.calls} tokens=${candidate.inferenceUsage.totalTokens} costUsd=${candidate.inferenceUsage.costUsd} denials=${formatDenials(candidate.inferenceUsage.denials)}` : ` usage=unmeasured${candidate.inferenceDenials ? ` denials=${formatDenials(candidate.inferenceDenials)}` : ""}`}` : ""
	const workerHarness = candidate.workerHarnessExecution
		? `, harness=${candidate.workerHarnessExecution.mode} parent=${candidate.workerHarnessExecution.parentCommit} snapshot=${candidate.workerHarnessExecution.snapshotCommit}/${candidate.workerHarnessExecution.snapshotTreeDigest} image=${candidate.workerHarnessExecution.runtime.imageDigest} commit=${candidate.workerHarnessExecution.runtime.harnessCommit} lock=${candidate.workerHarnessExecution.runtime.dependencyLockDigest} cli=${candidate.workerHarnessExecution.executedCliPath}`
		: ""
	return `${candidate.id}: ${candidate.status}${parent}${mutation}${model}${workerHarness}${fitness ? `, score=${fitness.score}, ${fitness.reason}` : ""}${proof}${comparison}${metrics}`
}

export function formatRunReport(run: RsiRunRecord, config: RsiConfig): string {
	const lines = [
		`# RSI Generation Report: ${run.runId}`,
		"",
		`- Model: ${run.model}`,
		`- Base commit: ${run.baseCommit}`,
		`- Evaluator integrity: ${run.evaluatorIntegrity?.status ?? "unsealed historical record"}${run.evaluatorIntegrity?.status === "sealed" ? `; key=${run.evaluatorIntegrity.keyId}; input=${run.evaluatorIntegrity.inputSha256}; manifest=${run.evaluatorIntegrity.manifestSha256}` : "; no independently signed integrity seal"}`,
		`- Worker harness: mode=${run.workerHarnessMode ?? "fixed-control"}; pair=${run.workerHarnessPairId ?? "unpaired"}; plannedGenerations=${run.workerHarnessPlannedGenerations ?? run.generations}; configDigest=${run.workerHarnessConfigDigest ?? "unavailable"}; samplingSeed=${run.workerHarnessSamplingSeed ?? "unavailable"}${run.workerHarnessRuntime ? `; image=${run.workerHarnessRuntime.imageDigest}; harnessCommit=${run.workerHarnessRuntime.harnessCommit}; dependencyLock=${run.workerHarnessRuntime.dependencyLockDigest}` : ""}`,
		`- Development proof: ${run.developmentProofProtocol ? `frozen protocol ${run.developmentProofProtocol.protocolDigest}; ${run.developmentProofProtocol.taskIds.length} development tasks; minimum net wins ${run.developmentProofProtocol.rule.minimumNetWins}; retention tasks ${run.developmentProofProtocol.rule.retentionTaskIds.join(", ")}; maximum mean-token increase ratio ${run.developmentProofProtocol.rule.maximumMeanTokenIncreaseRatio}` : "unavailable"}`,
		`- Confirmation evidence: ${run.confirmationEvidence ?? "unmeasured"}`,
		...(run.proofCampaign ? [`- Proof campaign state: ${run.proofCampaign.state}${run.proofCampaign.incompleteReason ? `; reason=${run.proofCampaign.incompleteReason}` : ""}`] : []),
		...(run.proofConfirmation ? [
			`- Confirmation harness: ${run.proofConfirmation.selectedHarness.candidateId} (${run.proofConfirmation.selectedHarness.commit}; generation ${run.proofConfirmation.selectedHarness.generation}; attempt IDs ${run.proofConfirmation.selectedHarness.attemptIds.join(",") || "none"})`,
			`- Root control: ${run.proofConfirmation.rootHarness.commit}; attempt IDs ${run.proofConfirmation.rootHarness.attemptIds.join(",") || "none"}`,
		] : []),
		`- Generations: ${run.generations}`,
		`- Started: ${run.startedAt}`,
		`- Finished: ${run.finishedAt ?? "in progress"}`,
		`- Baseline: ${run.baseline ? (run.baseline.ok ? "pass" : "fail") : "not run (dry-run)"}${run.baselineFitness ? `, score=${run.baselineFitness.score}` : ""}`,
		`- Selected candidate: ${run.selected ?? "none"}`,
		`- Pareto candidates: ${run.selectedCandidates?.join(", ") || "none"}`,
		`- Parent policy: ${run.parentSelectionPolicy ?? config.parentSelectionPolicy ?? "champion-specialist-novelty"}`,
		`- Model candidates: ${run.modelCandidates?.map((model) => `${model.id} (${model.status})`).join(", ") || "none"}`,
		`- Experiment jobs: ${run.jobs?.length ?? 0}`,
		`- Trajectories: ${run.trajectoryRefs?.length ?? 0}`,
		...(config.computePolicy === "adaptive-independent" ? [
			`- Adaptive budgets: trajectories ${config.maxTrajectories ?? config.population + 1}; total iterations ${config.maxTotalIterations ?? (config.population + 1) * config.maxIterations}; runtime admission ${config.maxRuntimeMs ?? 60 * 60_000} ms; max concurrent ${config.maxConcurrent}`,
		] : []),
		"",
		"## Candidates",
		"",
		...run.candidates.map((candidate) => `- ${formatCandidate(candidate)}${candidate.failure ? `; failure=${candidate.failure}` : ""}`),
		"",
		...(run.adaptiveSearch?.length ? [
			"## Adaptive allocation decisions",
			"",
			...run.adaptiveSearch.map((decision) => `- Generation ${decision.generation}: ${decision.decision} (${decision.reason}); candidates=${decision.candidateIds.join(", ") || "none"}; evidence=${decision.evidence.map((entry) => `${entry.candidateId}:${entry.status}${entry.visiblePassRate === undefined ? "" : `:${entry.visiblePassRate.toFixed(3)}`}`).join(", ") || "none"}; allocated=${decision.allocatedTrajectories} trajectories/${decision.allocatedIterations} iterations; remaining=${decision.remainingTrajectories} trajectories/${decision.remainingIterations} iterations; elapsed=${decision.elapsedMs} ms.`),
			"",
		] : []),
		...(run.curriculumTasks?.length ? [
			"## Curriculum fixture status",
			"",
			...run.curriculumTasks.map((task) => `- ${task.id}: ${task.promotedAt ? `promoted at ${task.promotedAt}` : task.validated ? "fixture-replay validated; not promoted" : "proposal; unvalidated"}; fixture=${task.fixtureId}; ${task.fixtureDescription}${task.validation ? `; base=${task.validation.baseCommit}; replays=${task.validation.replays.length}; reproducible=${task.validation.reproducible}; reason=${task.validation.reason}` : "; no executable validation recorded"}`),
			"",
			"Validated means the registered fixture reference passed, a known incorrect mutant was rejected, and two clean OpenShell replays produced identical output digests. It does not certify that task wording measures the named capability.",
			"",
		] : []),
		...(run.adversarialReviews?.length ? [
			"## Adversarial review",
			"",
			...run.adversarialReviews.map((review) => `- ${review.candidateId}: ${review.status}; role=${review.role}; provider=${review.provider}; model=${review.model}; promptVersion=${review.promptVersion}; prompt=${review.promptSha256 || "unavailable"}; result=${review.resultSha256 || "unavailable"}; error=${review.errorSha256 || "none"}; tests=${review.testArtifactSha256 || "unavailable"}; OpenShell output=${review.testResults.map((entry) => entry.outputArtifactSha256).filter(Boolean).join(", ") || "none"}; penalty=${review.penaltyPoints}; findings=${review.findings.map((finding) => finding.severity + ":" + finding.message.replace(/\s+/g, " ").slice(0, 240)).join(" | ") || "none"}; ${review.testResults.map((entry) => entry.id + ":" + (entry.passed ? "pass" : "fail")).join(", ") || review.error || "no test result"}${review.summary ? `; summary=${review.summary.replace(/\s+/g, " ").slice(0, 400)}` : ""}`),
			"",
			"Adversarial tests run in a fresh OpenShell evaluation guest. The coordinator alone applies their pass/fail gate and bounded finding penalty.",
			"",
		] : []),
		"## Guardrails",
		"",
		`- Regression gate: ${config.regressionCommand}`,
		`- Visible evaluations: ${config.evalCommands.join("; ") || "none"}`,
		`- Hidden evaluations: ${config.hiddenSuiteSha256 ? "supervisor-owned declarative suite (" + config.hiddenSuiteSha256 + ")" : config.hiddenEvalCommands.length || 0}`,
		`- Compute policy: ${config.computePolicy ?? "single"}`,
		`- Protected paths: ${config.protectedPaths.join(", ")}`,
		"",
		"The archive is the durable machine-readable record for this run.",
	]
	return `${lines.join("\n")}\n`
}

export function fitnessSummary(fitness: Fitness | undefined): string {
	if (!fitness) return "not evaluated"
	return `${fitness.score} (${fitness.reason})`
}
