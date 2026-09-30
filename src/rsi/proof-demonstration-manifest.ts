import { createHash } from "node:crypto"
import { RSI_OPENROUTER_ENDPOINT_PROVIDER, RSI_OPENROUTER_ENDPOINT_QUANTIZATION, RSI_OPENROUTER_ENDPOINT_TAG, type OpenRouterEndpointPriceSnapshot } from "./inference-broker.js"
import type { OpenRouterBrokerLimits } from "./inference-broker.js"
import type { ProofDemonstrationPlan } from "./proof-demonstration-plan.js"
import type { RsiConfig } from "./types.js"
import type { WorkerHarnessRuntimeIdentity } from "./types.js"

export interface FrozenProofDemonstrationManifest {
	schemaVersion: 1
	createdAt: string
	rootCommit: string
	benchmarkManifestSha256: string
	model: { provider: "openshell-openrouter"; requestedId: string; sampling: { temperature: 0; think: false; seed: "provider-default" } }
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

export function freezeProofDemonstrationManifest(args: Omit<FrozenProofDemonstrationManifest, "schemaVersion" | "digestSha256">): FrozenProofDemonstrationManifest {
	if (!/^[a-f0-9]{40}$/.test(args.rootCommit)) throw new Error("proof demonstration root commit must be a full commit SHA")
	if (!/^[a-f0-9]{64}$/.test(args.benchmarkManifestSha256)) throw new Error("proof demonstration benchmark manifest digest is malformed")
	if (!Number.isFinite(args.operatorCapUsd) || args.operatorCapUsd <= 0) throw new Error("proof demonstration requires a positive finite operator cap")
	if (new Set([args.seeds.engineering, ...args.seeds.campaigns]).size !== 4 || [args.seeds.engineering, ...args.seeds.campaigns].some((seed) => !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(seed))) throw new Error("proof demonstration requires four distinct explicit seeds")
	if (args.endpointPrice.model !== args.model.requestedId || args.endpointPrice.provider !== RSI_OPENROUTER_ENDPOINT_PROVIDER || args.endpointPrice.endpointTag !== RSI_OPENROUTER_ENDPOINT_TAG || args.endpointPrice.quantization !== RSI_OPENROUTER_ENDPOINT_QUANTIZATION) throw new Error("endpoint price identity differs from the frozen DeepInfra fp8 model route")
	if (![args.priceCeilingsPerMillionUsd.input, args.priceCeilingsPerMillionUsd.output].every((value) => Number.isFinite(value) && value > 0) || args.priceCeilingsPerMillionUsd.input < args.endpointPrice.inputPricePerMillionUsd || args.priceCeilingsPerMillionUsd.output < args.endpointPrice.outputPricePerMillionUsd) throw new Error("configured price ceilings do not cover the observed endpoint rates")
	if (!/^[a-f0-9]{64}$/.test(args.execution.configSha256) || args.execution.configSha256 !== frozenProofConfigDigest(args.execution.configs) || !/^[a-f0-9]{64}$/.test(args.execution.analysisSourceSha256)) throw new Error("proof demonstration config or analysis-source digest is malformed")
	if (!args.execution.taskIdentities.length || args.execution.taskIdentities.some((task) => !/^[a-f0-9]{64}$/.test(task.verifierDigest) || !/^[a-f0-9]{64}$/.test(task.knownGoodDigest) || !/^[a-f0-9]{64}$/.test(task.knownBadDigest))) throw new Error("proof demonstration task identities are incomplete")
	if (args.operatorCapUsd + 1e-9 < args.plan.totalRootSpendCeilingUsd) throw new Error(`operator cap $${args.operatorCapUsd.toFixed(6)} is below the frozen root reservation $${args.plan.totalRootSpendCeilingUsd.toFixed(6)}`)
	const body = { schemaVersion: 1 as const, ...args }
	return { ...body, digestSha256: frozenProofDemonstrationDigest(body) }
}

export function verifyFrozenProofDemonstrationManifest(value: unknown): FrozenProofDemonstrationManifest {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("frozen proof demonstration manifest is malformed")
	const manifest = value as FrozenProofDemonstrationManifest
	if (manifest.schemaVersion !== 1 || !/^[a-f0-9]{64}$/.test(manifest.digestSha256)) throw new Error("frozen proof demonstration manifest schema or digest is malformed")
	const { digestSha256, ...body } = manifest
	if (frozenProofDemonstrationDigest(body) !== digestSha256) throw new Error("frozen proof demonstration manifest digest mismatch")
	if (manifest.endpointPrice.model !== manifest.model.requestedId || manifest.endpointPrice.provider !== RSI_OPENROUTER_ENDPOINT_PROVIDER || manifest.endpointPrice.endpointTag !== RSI_OPENROUTER_ENDPOINT_TAG || manifest.endpointPrice.quantization !== RSI_OPENROUTER_ENDPOINT_QUANTIZATION || !["max_tokens", "temperature", "tools", "tool_choice"].every((parameter) => manifest.endpointPrice.supportedParameters.includes(parameter))) throw new Error("frozen proof demonstration endpoint is not the pinned DeepInfra fp8 route with required parameters")
	if (manifest.operatorCapUsd + 1e-9 < manifest.plan.totalRootSpendCeilingUsd) throw new Error("frozen proof demonstration operator cap is below root reservations")
	if (frozenProofConfigDigest(manifest.execution.configs) !== manifest.execution.configSha256) throw new Error("frozen proof demonstration config digest mismatch")
	return manifest
}
