import * as path from "node:path"
import {
	canonicalJson,
	evaluatorBaseTreeIdentity,
	evaluatorGenerationDecisionDigest,
	evaluatorIntegrityDigest,
	evaluatorSourceIdentity,
	hasEvaluatorIntegrityManifests,
	readEvaluatorIntegrityManifest,
	signEvaluatorIntegrity,
	verifyEvaluatorIntegrity,
	writeEvaluatorIntegrityManifest,
} from "./evaluation-integrity.js"
import type {
	EvaluatorIntegrityPayload,
	EvaluatorIntegrityTrust,
} from "./evaluation-integrity.js"
import type { EvaluatorRuntimeIdentity } from "./evaluator-runtime.js"
import { freezeDevelopmentProofProtocol } from "./development-proof.js"
import { compareFitness } from "./fitness.js"
import { paretoFront } from "./selection.js"
import { workerHarnessConfigDigest } from "./worker-harness.js"
import {
	evaluatorArchiveStateDigest,
	verifyArchivedIntegrityOutputs,
} from "./controller-integrity.js"
import type { RsiConfig, RsiRunRecord } from "./types.js"

export async function persistEvaluatorIntegrity(
	config: RsiConfig,
	run: RsiRunRecord,
	trust: EvaluatorIntegrityTrust | undefined,
	input: Record<string, unknown>,
): Promise<void> {
	const record = run.evaluatorIntegrity
	if (!record) throw new Error("evaluator integrity record was not initialized")
	if (!trust) {
		record.status = "unsealed"
		return
	}
	const payload: EvaluatorIntegrityPayload = {
		schemaVersion: 1,
		runId: run.runId,
		input,
		inputSha256: evaluatorIntegrityDigest(input),
		archiveStateSha256: evaluatorArchiveStateDigest(run),
		outputs: record.outputs,
		generations: record.generations,
		...(record.selectedCandidateId ? { selectedCandidateId: record.selectedCandidateId } : {}),
	}
	const saved = await writeEvaluatorIntegrityManifest(config.archiveDir, run.runId, signEvaluatorIntegrity(trust, payload))
	record.status = "sealed"
	record.keyId = trust.keyId
	record.inputSha256 = payload.inputSha256
	record.archiveStateSha256 = payload.archiveStateSha256
	record.manifestPath = saved.path
	record.manifestSha256 = saved.sha256
}

export async function verifyResumedEvaluatorIntegrity(
	config: RsiConfig,
	run: RsiRunRecord,
	trust: EvaluatorIntegrityTrust | undefined,
	input: Record<string, unknown>,
	attested: boolean,
): Promise<void> {
	const existing = run.evaluatorIntegrity
	const hasSealArtifacts = await hasEvaluatorIntegrityManifests(config.archiveDir, run.runId)
	if ((!existing || existing.status !== "sealed") && hasSealArtifacts) throw new Error("evaluator integrity seal artifacts exist but archive metadata is missing or downgraded; refusing unsealed resume")
	if (!existing) {
		if (attested) throw new Error("attested RSI resume requires a signed evaluator integrity manifest; this historical run is unsealed")
		if (trust) throw new Error("cannot retroactively seal a historical RSI run; start a new run with evaluator integrity trust configured")
		return
	}
	const currentInputSha256 = evaluatorIntegrityDigest(input)
	if (existing.status === "sealed") {
		if (!trust) throw new Error("sealed RSI run cannot resume without its independently pinned evaluator integrity trust")
		if (!existing.manifestSha256 || existing.manifestPath !== path.posix.join("evaluator-integrity", `${run.runId}.${existing.manifestSha256}.json`)) throw new Error("evaluator integrity manifest pointer is malformed")
		const saved = await readEvaluatorIntegrityManifest(config.archiveDir, run.runId, existing.manifestSha256)
		if (saved.sha256 !== existing.manifestSha256) throw new Error("evaluator integrity manifest bytes changed since the run was checkpointed")
		const envelope = verifyEvaluatorIntegrity(trust, saved.envelope)
		const payload = envelope.payload as Partial<EvaluatorIntegrityPayload>
		if (payload.schemaVersion !== 1 || payload.runId !== run.runId || payload.inputSha256 !== currentInputSha256 || canonicalJson(payload.input) !== canonicalJson(input)) throw new Error("evaluator source, base tree, configuration, commands, or inputs changed since the signed RSI snapshot")
		if (payload.archiveStateSha256 !== evaluatorArchiveStateDigest(run) || existing.archiveStateSha256 !== payload.archiveStateSha256) throw new Error("archived evaluator state changed since its last signed checkpoint")
		if (canonicalJson(payload.outputs) !== canonicalJson(existing.outputs) || canonicalJson(payload.generations) !== canonicalJson(existing.generations) || payload.selectedCandidateId !== existing.selectedCandidateId) throw new Error("signed evaluator outputs or selection differ from the RSI archive checkpoint")
		if (existing.keyId !== trust.keyId || existing.inputSha256 !== currentInputSha256) throw new Error("evaluator integrity trust or manifest identity differs from the frozen run identity")
		verifyArchivedIntegrityOutputs(run, existing.outputs)
		for (const generation of existing.generations) {
			const generationCandidates = run.candidates.filter((candidate) => candidate.generation === generation.generation)
			const accepted = generationCandidates.filter((candidate) => candidate.status === "accepted")
			const expectedSelectedIds = paretoFront(accepted).map((candidate) => candidate.id)
			const expectedSelected = [...accepted].sort((left, right) => compareFitness(right.fitness, left.fitness))[0]?.id
			const reviews = (run.adversarialReviews ?? []).filter((review) => generationCandidates.some((candidate) => candidate.id === review.candidateId))
			if (canonicalJson(generation.selectedCandidateIds) !== canonicalJson(expectedSelectedIds) || generation.selectedCandidateId !== expectedSelected ||
				generation.decisionsSha256 !== evaluatorGenerationDecisionDigest(generationCandidates, reviews, expectedSelected)) {
				throw new Error(`archived evaluator decisions differ from the signed selection for generation ${generation.generation}`)
			}
		}
		const latestGeneration = existing.generations.at(-1)
		if ((latestGeneration && canonicalJson(latestGeneration.selectedCandidateIds) !== canonicalJson(run.selectedCandidates ?? [])) || existing.selectedCandidateId !== run.selected) throw new Error("selected candidates differ from the signed evaluator selection")
		return
	}
	if (trust) throw new Error("cannot retroactively seal an unsealed RSI run; start a new run with evaluator integrity trust configured")
	if (attested) throw new Error("attested RSI resume requires an independently signed evaluator integrity manifest")
}

export async function buildEvaluatorIntegrityInput(args: {
	config: RsiConfig
	run: RsiRunRecord
	packageRoot: string
	roles: RsiConfig["roles"]
	workerModel: string
	workerProvider: string
	workerOpenRouterProfile?: string
	proofProtocol: ReturnType<typeof freezeDevelopmentProofProtocol>
	benchmarkManifestSha256: string
	evaluatorRuntime?: EvaluatorRuntimeIdentity
	hiddenVerifierIdentity?: RsiRunRecord["hiddenVerifierIdentity"]
	syntheticRuntimeIdentity?: boolean
}): Promise<Record<string, unknown>> {
	const source = await evaluatorSourceIdentity(args.packageRoot)
	const baseTreeSha256 = evaluatorBaseTreeIdentity(args.config.repoRoot, args.run.baseCommit)
	const config = args.config
	return {
		schemaVersion: 1,
		runId: args.run.runId,
		baseCommit: args.run.baseCommit,
		baseTreeSha256,
		evaluatorSource: source,
		imageIdentity: {
			requestedImage: args.evaluatorRuntime ? `headlesscode-openshell-rsi@${args.evaluatorRuntime.imageDigest}` : null,
			pinnedImageDigest: args.evaluatorRuntime?.imageDigest ?? null,
			identitySource: args.evaluatorRuntime?.identitySource ?? "not-executed-dry-run",
			workerHarnessRuntime: args.run.workerHarnessRuntime ?? null,
			gatewayAlias: process.env.OPENSHELL_GATEWAY ?? null,
		},
		evaluatorIsolationPolicy: args.evaluatorRuntime ? { source: args.evaluatorRuntime.policySource, sha256: args.evaluatorRuntime.policySha256 } : null,
		storageAndWorkspace: {
			repository: path.resolve(config.repoRoot),
			archive: path.resolve(config.archiveDir),
			worktrees: path.resolve(config.worktreeDir),
			trajectoryOutput: path.resolve(config.trajectoryDir ?? path.join(config.archiveDir, "trajectories")),
			curriculumOutput: path.resolve(config.curriculumDir ?? path.join(config.archiveDir, "curriculum")),
		},
		commands: {
			regression: config.regressionCommand,
			visible: [...config.evalCommands],
			hidden: [...config.hiddenEvalCommands],
		},
		effectiveArguments: {
			baseRef: config.baseRef,
			model: args.workerModel,
			provider: args.workerProvider,
			openRouterProfile: args.workerOpenRouterProfile ?? null,
			roles: args.roles ?? null,
			population: config.population,
			generations: args.run.generations,
			maxConcurrent: config.maxConcurrent,
			maxIterations: config.maxIterations,
			maxTokens: config.maxTokens ?? null,
			commandTimeoutMs: config.commandTimeoutMs,
			computePolicy: config.computePolicy ?? "single",
			maxTrajectories: config.maxTrajectories ?? null,
			maxTotalIterations: config.maxTotalIterations ?? null,
			maxRuntimeMs: config.maxRuntimeMs ?? null,
			seed: config.seed,
			mutationTask: config.mutationTask,
			mutationKind: config.mutationKind ?? "corrective",
			hypothesis: config.hypothesis ?? null,
			protectedPaths: [...config.protectedPaths].sort(),
			parentSelectionPolicy: config.parentSelectionPolicy ?? "champion-specialist-novelty",
			developmentProofRule: config.developmentProofRule ?? null,
			developmentProofProtocolSha256: args.proofProtocol.protocolDigest,
			workerHarness: {
				mode: args.run.workerHarnessMode ?? "fixed-control",
				pairId: args.run.workerHarnessPairId ?? null,
				configDigest: args.run.workerHarnessConfigDigest ?? null,
				plannedGenerations: args.run.workerHarnessPlannedGenerations ?? null,
				phase: config.workerHarnessPhase ?? null,
				engineeringOnly: config.workerHarnessEngineeringOnly ?? false,
			},
		},
		inputArtifacts: [
			{ id: "development-benchmark-manifest", sha256: args.benchmarkManifestSha256 },
			...(args.hiddenVerifierIdentity ? [{ id: "hidden-verifier-suite", sha256: args.hiddenVerifierIdentity.suiteSha256 }, { id: "hidden-verifier-public-key", sha256: args.hiddenVerifierIdentity.publicKeySha256 }, { id: "hidden-verifier-image", sha256: args.hiddenVerifierIdentity.imageDigest }] : []),
		],
	}
}
