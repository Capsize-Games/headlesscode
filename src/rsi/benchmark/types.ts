import type { OpenRouterBrokerReceipt } from "../inference-broker.js"

export type BenchmarkSplit = "development" | "confirmation"

export interface BenchmarkResourceCeilings {
	timeoutMs: number
	maxCalls: number
	maxOutputTokensPerCall: number
	maxPatchBytes: number
}

export interface BenchmarkTask {
	id: string
	family: string
	split: BenchmarkSplit
	task: string
	startCommit?: string
	startPath?: string
	startDigest: string
	verifierPath: string
	verifierDigest: string
	knownGoodPath?: string
	knownGoodCommit?: string
	knownGoodDigest: string
	knownBadPath?: string
	knownBadCommit?: string
	knownBadDigest: string
	seed: number
	ceilings: BenchmarkResourceCeilings
	provenance?: { fixCommit: string; startCommit: string; subject: string; verifierSource?: string; verifierCommit?: string; verifierPaths?: string[] }
}

export interface BenchmarkManifest {
	schemaVersion: 1
	runnerVersion: string
	createdFromCommit: string
	tasks: BenchmarkTask[]
}

export interface BenchmarkAgentRequest {
	taskId: string
	attemptId: string
	campaignId: string
	brokerLedgerPath: string
	task: string
	seed: number
	workspace: string
	harnessCommit: string
	model: { provider: string; id: string; sampling: Record<string, number | string | boolean> }
	ceilings: BenchmarkResourceCeilings
}

export interface BenchmarkAgentResult {
	validity: "valid" | "malformed" | "missing" | "timeout" | "agent-error" | "patch-error" | "verifier-error"
	patch?: Buffer
	stdout: string
	stderr: string
	calls: number | null
	tokens: number | null
	wallTimeMs: number
	stopReason: string
	inferenceReceipt?: OpenRouterBrokerReceipt
}

export interface BenchmarkImageIdentity {
	name: string
	digest: string
	harnessCommit: string
}

export interface BenchmarkAgent {
	readonly provider: string
	imageIdentity?(harnessCommit: string): Promise<BenchmarkImageIdentity>
	run(request: BenchmarkAgentRequest): Promise<BenchmarkAgentResult>
	verifyReceipt?(attemptId: string, receipt: OpenRouterBrokerReceipt, brokerLedgerPath: string): Promise<boolean>
}

export interface BenchmarkAttempt {
	schemaVersion: 1
	manifestDigest: string
	taskId: string
	split: BenchmarkSplit
	attemptId: string
	harnessCommit: string
	agentImage: BenchmarkImageIdentity | null
	model: { provider: string; id: string; sampling: Record<string, number | string | boolean> }
	seed: number
	family: string
	startDigest: string
	ceilings: BenchmarkResourceCeilings
	verifiedSuccess: boolean
	/** True only when a trusted supervisor boundary enforced all requested resource ceilings. */
	proofQualified: boolean
	resourceAccounting: "guest-reported" | "supervisor-enforced" | "incomplete"
	/** Digest of the durable proof admission request; present for restart-safe campaign attempts. */
	proofRequestSha256?: string
	inferenceReceipt?: OpenRouterBrokerReceipt
	validity: BenchmarkAgentResult["validity"]
	calls: number | null
	tokens: number | null
	wallTimeMs: number
	stopReason: string
	patchDigest: string | null
	evaluatorDigest: string
	artifactRefs: { patch?: string; stdout: string; stderr: string }
	failure?: string
}
