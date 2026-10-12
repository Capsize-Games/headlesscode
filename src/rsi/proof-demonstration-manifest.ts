import { createHash } from "node:crypto"
import * as path from "node:path"
import { openRouterProfileForModel, RSI_DEFAULT_OPENROUTER_PROFILE_ID, type OpenRouterEndpointPriceSnapshot, type RsiOpenRouterProfileId } from "./inference-broker.js"
import type { OpenRouterBrokerLimits } from "./inference-broker.js"
import type { ProofDemonstrationPlan } from "./proof-demonstration-plan.js"
import type { RsiConfig } from "./types.js"
import type { WorkerHarnessRuntimeIdentity } from "./types.js"
import type { ProofBenchmarkFixtureBinding } from "./types.js"

export interface FrozenProofDemonstrationManifest {
	schemaVersion: 1
	createdAt: string
	rootCommit: string
	benchmarkFixtures?: ProofBenchmarkFixtureBinding
	benchmarkManifestSha256: string
	model: { provider: "openshell-openrouter"; requestedId: string; profileId?: RsiOpenRouterProfileId; sampling: { temperature: 0; think: false; seed: "provider-default" } }
	endpointPrice: OpenRouterEndpointPriceSnapshot
	priceCeilingsPerMillionUsd: { input: number; output: number }
	runtime: WorkerHarnessRuntimeIdentity
	execution: {
		configs: [RsiConfig, RsiConfig, RsiConfig, RsiConfig]
		configSha256: string
		analysisSourceSha256: string
		inferenceLimits: { mutation: OpenRouterBrokerLimits; benchmark: OpenRouterBrokerLimits }
		taskIdentities: Array<{ id: string; split: string; family: string; seed: number; startDigest: string; verifierDigest: string; knownGoodDigest: string; knownBadDigest: string; ceilings: { timeoutMs: number; maxCalls: number; maxOutputTokensPerCall: number; maxPatchBytes: number } }>
	}
	seeds: { engineering: string; campaigns: [string, string, string] }
	campaignIds: { engineering: string; campaigns: [string, string, string] }
	operatorCapUsd: number
	plan: ProofDemonstrationPlan
	analysis: { bootstrapSeed: string; bootstrapReplicates: number; confirmationRetentionTaskIds: string[] }
	/** Digest-bound development-only engineering pair that had to pass before this holdout manifest was frozen. */
	engineeringEvidence: { path: string; sha256: string; campaignId: string; rootCommit: string; manifestSha256: string; snapshotSha256: string }
	digestSha256: string
}

function canonical(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(canonical)
	if (value && typeof value === "object") return Object.fromEntries(Object.entries(value as Record<string, unknown>)
		.filter(([, item]) => item !== undefined)
		.sort(([a], [b]) => Buffer.compare(Buffer.from(a), Buffer.from(b)))
		.map(([key, item]) => [key, canonical(item)]))
	return value
}

export function frozenProofDemonstrationDigest(manifest: Omit<FrozenProofDemonstrationManifest, "digestSha256">): string {
	return createHash("sha256").update(JSON.stringify(canonical(manifest))).digest("hex")
}


export function frozenProofConfigDigest(config: unknown): string {
	return createHash("sha256").update(JSON.stringify(canonical(config))).digest("hex")
}

function verifyEndpointProfile(model: FrozenProofDemonstrationManifest["model"], endpointPrice: OpenRouterEndpointPriceSnapshot): void {
	const profile = openRouterProfileForModel(model.requestedId, model.profileId)
	if (profile.id !== RSI_DEFAULT_OPENROUTER_PROFILE_ID && model.profileId !== profile.id) throw new Error("non-default proof demonstration profile identity must be explicit")
	if (endpointPrice.model !== model.requestedId || endpointPrice.provider !== profile.endpointProvider || endpointPrice.endpointTag !== profile.endpointTag || endpointPrice.quantization !== profile.quantization || !profile.requiredParameters.every((parameter) => endpointPrice.supportedParameters.includes(parameter))) throw new Error(`endpoint price identity differs from the admitted ${profile.id} route`)
}

export function freezeProofDemonstrationManifest(args: Omit<FrozenProofDemonstrationManifest, "schemaVersion" | "digestSha256">): FrozenProofDemonstrationManifest {
	if (!/^[a-f0-9]{40}$/.test(args.rootCommit)) throw new Error("proof demonstration root commit must be a full commit SHA")
	if (!/^[a-f0-9]{64}$/.test(args.benchmarkManifestSha256)) throw new Error("proof demonstration benchmark manifest digest is malformed")
	validateBenchmarkFixtureBinding(args.benchmarkFixtures, args.benchmarkManifestSha256, args.execution.configs)
	if (!Number.isFinite(args.operatorCapUsd) || args.operatorCapUsd <= 0) throw new Error("proof demonstration requires a positive finite operator cap")
	if (new Set([args.seeds.engineering, ...args.seeds.campaigns]).size !== 4 || [args.seeds.engineering, ...args.seeds.campaigns].some((seed) => !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(seed))) throw new Error("proof demonstration requires four distinct explicit seeds")
	verifyEndpointProfile(args.model, args.endpointPrice)
	if (![args.priceCeilingsPerMillionUsd.input, args.priceCeilingsPerMillionUsd.output].every((value) => Number.isFinite(value) && value > 0) || args.priceCeilingsPerMillionUsd.input < args.endpointPrice.inputPricePerMillionUsd || args.priceCeilingsPerMillionUsd.output < args.endpointPrice.outputPricePerMillionUsd) throw new Error("configured price ceilings do not cover the observed endpoint rates")
	if (!/^[a-f0-9]{64}$/.test(args.execution.configSha256) || args.execution.configSha256 !== frozenProofConfigDigest(args.execution.configs) || !/^[a-f0-9]{64}$/.test(args.execution.analysisSourceSha256)) throw new Error("proof demonstration config or analysis-source digest is malformed")
	const evaluatorPins = args.execution.configs.map((config) => config.evaluatorTrustedKeySha256)
	if (evaluatorPins.some((pin) => typeof pin !== "string" || !/^sha256:[a-f0-9]{64}$/.test(pin)) || new Set(evaluatorPins).size !== 1) throw new Error("proof demonstration requires one independently pinned evaluator integrity key")
	if (args.execution.configs.some((config) => config.evaluatorSigningKeyPath !== undefined || config.evaluatorTrustedPublicKeyPath !== undefined)) throw new Error("proof demonstration must not freeze evaluator key paths")
	if (!args.execution.taskIdentities.length || args.execution.taskIdentities.some((task) => !/^[a-f0-9]{64}$/.test(task.verifierDigest) || !/^[a-f0-9]{64}$/.test(task.knownGoodDigest) || !/^[a-f0-9]{64}$/.test(task.knownBadDigest))) throw new Error("proof demonstration task identities are incomplete")
	const confirmationIds = new Set(args.execution.taskIdentities.filter((task) => task.split === "confirmation").map((task) => task.id))
	if (!args.analysis.bootstrapSeed.trim() || !Number.isSafeInteger(args.analysis.bootstrapReplicates) || args.analysis.bootstrapReplicates < 1 || !args.analysis.confirmationRetentionTaskIds.length || new Set(args.analysis.confirmationRetentionTaskIds).size !== args.analysis.confirmationRetentionTaskIds.length || args.analysis.confirmationRetentionTaskIds.some((id) => !confirmationIds.has(id))) throw new Error("proof demonstration analysis settings or confirmation retention set are invalid")
	if (args.operatorCapUsd + 1e-9 < args.plan.campaignRootsSpendCeilingUsd) throw new Error(`operator cap $${args.operatorCapUsd.toFixed(6)} is below the three frozen campaign roots reservation $${args.plan.campaignRootsSpendCeilingUsd.toFixed(6)}`)
	if (!args.engineeringEvidence.path || !/^[a-f0-9]{64}$/.test(args.engineeringEvidence.sha256) || !/^[A-Za-z0-9._:-]{1,160}$/.test(args.engineeringEvidence.campaignId) || args.engineeringEvidence.rootCommit !== args.rootCommit || !/^[a-f0-9]{64}$/.test(args.engineeringEvidence.manifestSha256) || !/^[a-f0-9]{64}$/.test(args.engineeringEvidence.snapshotSha256)) throw new Error("engineering evidence identity is malformed or belongs to another root")
	const body = { schemaVersion: 1 as const, ...args }
	return { ...body, digestSha256: frozenProofDemonstrationDigest(body) }
}

export function verifyFrozenProofDemonstrationManifest(value: unknown): FrozenProofDemonstrationManifest {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("frozen proof demonstration manifest is malformed")
	const manifest = value as FrozenProofDemonstrationManifest
	if (manifest.schemaVersion !== 1 || !/^[a-f0-9]{64}$/.test(manifest.digestSha256)) throw new Error("frozen proof demonstration manifest schema or digest is malformed")
	const { digestSha256, ...body } = manifest
	if (frozenProofDemonstrationDigest(body) !== digestSha256) throw new Error("frozen proof demonstration manifest digest mismatch")
	verifyEndpointProfile(manifest.model, manifest.endpointPrice)
	if (!/^[a-f0-9]{64}$/.test(manifest.benchmarkManifestSha256)) throw new Error("frozen proof benchmark manifest digest is malformed")
	validateBenchmarkFixtureBinding(manifest.benchmarkFixtures, manifest.benchmarkManifestSha256, manifest.execution.configs)
	if (manifest.operatorCapUsd + 1e-9 < manifest.plan.campaignRootsSpendCeilingUsd) throw new Error("frozen proof demonstration operator cap is below the three campaign root reservations")
	if (!manifest.engineeringEvidence || !manifest.engineeringEvidence.path || !/^[a-f0-9]{64}$/.test(manifest.engineeringEvidence.sha256) || manifest.engineeringEvidence.rootCommit !== manifest.rootCommit || !/^[a-f0-9]{64}$/.test(manifest.engineeringEvidence.manifestSha256) || !/^[a-f0-9]{64}$/.test(manifest.engineeringEvidence.snapshotSha256)) throw new Error("frozen engineering evidence reference is missing or malformed")
	if (frozenProofConfigDigest(manifest.execution.configs) !== manifest.execution.configSha256) throw new Error("frozen proof demonstration config digest mismatch")
	const evaluatorPins = manifest.execution.configs.map((config) => config.evaluatorTrustedKeySha256)
	if (evaluatorPins.some((pin) => typeof pin !== "string" || !/^sha256:[a-f0-9]{64}$/.test(pin)) || new Set(evaluatorPins).size !== 1) throw new Error("frozen proof demonstration requires one independently pinned evaluator integrity key")
	if (manifest.execution.configs.some((config) => config.evaluatorSigningKeyPath !== undefined || config.evaluatorTrustedPublicKeyPath !== undefined)) throw new Error("frozen proof demonstration must not contain evaluator key paths")
	const confirmationIds = new Set(manifest.execution.taskIdentities.filter((task) => task.split === "confirmation").map((task) => task.id))
	if (!manifest.analysis.bootstrapSeed.trim() || !Number.isSafeInteger(manifest.analysis.bootstrapReplicates) || manifest.analysis.bootstrapReplicates < 1 || !manifest.analysis.confirmationRetentionTaskIds.length || new Set(manifest.analysis.confirmationRetentionTaskIds).size !== manifest.analysis.confirmationRetentionTaskIds.length || manifest.analysis.confirmationRetentionTaskIds.some((id) => !confirmationIds.has(id))) throw new Error("frozen proof demonstration analysis settings or confirmation retention set is invalid")
	return manifest
}


function validateBenchmarkFixtureBinding(binding: ProofBenchmarkFixtureBinding | undefined, manifestSha256: string, configs: RsiConfig[]): void {
	if (!binding) {
		if (configs.some((config) => config.proofBenchmarkFixtures !== undefined)) throw new Error("proof configs contain a fixture binding absent from the frozen manifest")
		return
	}
	if (!binding || typeof binding.root !== "string" || !path.isAbsolute(binding.root) || path.resolve(binding.root) !== binding.root
		|| !/^[a-f0-9]{64}$/.test(binding.manifestSha256) || binding.manifestSha256 !== manifestSha256) throw new Error("proof benchmark fixture root or manifest binding is malformed")
	const bindingKeys = Object.keys(binding).sort()
	const expectedBindingKeys = binding.snapshotPackage ? ["manifestSha256", "root", "snapshotPackage"] : ["manifestSha256", "root"]
	if (bindingKeys.length !== expectedBindingKeys.length || bindingKeys.some((key, index) => key !== expectedBindingKeys[index])) throw new Error("proof benchmark fixture binding has unexpected fields")
	if (binding.snapshotPackage !== undefined && (Object.keys(binding.snapshotPackage).sort().join(",") !== "digest,path" || typeof binding.snapshotPackage.path !== "string" || !binding.snapshotPackage.path || !/^[a-f0-9]{64}$/.test(binding.snapshotPackage.digest))) throw new Error("proof benchmark snapshot package binding is malformed")
	if (configs.some((config) => JSON.stringify(config.proofBenchmarkFixtures) !== JSON.stringify(binding))) throw new Error("proof configs do not share the frozen benchmark fixture binding")
}
