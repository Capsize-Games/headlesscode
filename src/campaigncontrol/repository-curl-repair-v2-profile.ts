import { createHash } from "node:crypto"
import {
	CURL_REPAIR_CANDIDATE_REVISION, CURL_REPAIR_CANDIDATE_TREE_SHA,
	CURL_REPAIR_HISTORICAL_BASE, CURL_REPAIR_PATCH_SHA256,
	CURL_REPAIR_SOURCE_REVISION, CURL_REPAIR_TARGET_REPOSITORY,
} from "./repository-curl-repair.js"
import { CURL_REPAIR_V2_CAMPAIGN_ID } from "./repository-campaign-ids.js"

export const CURL_REPAIR_V2_PROFILE_ID = "curl-92390-historical-repair-v2"
export const CURL_REPAIR_V2_ADAPTER_ID =
	"curl-92390-historical-repair-runtime-v2"
export const CURL_REPAIR_V2_REPOSITORY_ID = "curl-maintenance-repair-v2"
export const CURL_REPAIR_V2_SOURCE_REVISION = CURL_REPAIR_SOURCE_REVISION
export const CURL_REPAIR_V2_TARGET_REPOSITORY = CURL_REPAIR_TARGET_REPOSITORY
export const CURL_REPAIR_V2_MODEL = "none"
export const CURL_REPAIR_V2_ACCESS_PROFILE =
	"public-source-and-published-advisory-only"
export const CURL_REPAIR_V2_RESERVATION = Object.freeze({
	 micros: 1, tokens: 1,
})
export const CURL_REPAIR_V2_LIFETIME_ALLOCATION = Object.freeze({
	 micros: 400, tokens: 500,
})
export const CURL_REPAIR_V2_HELPER_SHA256 =
	"f7bbe5b12a443107eb4eeb2920c7fb70a0ac76b6c9342bf76678644adc9e4fad"
export const CURL_REPAIR_V2_IMAGE_DIGEST =
	"8924c5d2afd16f45d34a32f34de613ed7146a9557d07deb9edc83588d2dfdc04"
export const CURL_REPAIR_V2_TEST_IDS = Object.freeze([3037, 3038, 5033])

const RECIPE = Object.freeze({
	profile: CURL_REPAIR_V2_PROFILE_ID,
	worker: "fleet-curl-historical-candidate-archive-v2",
	privateSource: CURL_REPAIR_SOURCE_REVISION,
	base: CURL_REPAIR_HISTORICAL_BASE,
	candidate: CURL_REPAIR_CANDIDATE_REVISION,
	candidateTree: CURL_REPAIR_CANDIDATE_TREE_SHA,
	patchSha256: CURL_REPAIR_PATCH_SHA256,
	imageDigest: CURL_REPAIR_V2_IMAGE_DIGEST,
	helperSha256: CURL_REPAIR_V2_HELPER_SHA256,
	testIds: CURL_REPAIR_V2_TEST_IDS,
	network: "none",
	limits: {
		cpu: 1, memoryBytes: 1_073_741_824, swapBytes: 1_073_741_824,
		pids: 64, durationSeconds: 825, outputBytes: 65_536 },
})

export const CURL_REPAIR_V2_RECIPE_DIGEST = digest(RECIPE)
export const CURL_REPAIR_V2_EVALUATOR_DIGEST = digest({
	evaluator: "fleet-curl-historical-repair-protected-evaluator-v2",
	workerDigest: CURL_REPAIR_V2_RECIPE_DIGEST,
	helperSha256: CURL_REPAIR_V2_HELPER_SHA256,
	claimBoundReceipt: true,
	separateEvaluationContainer: true,
	testIds: CURL_REPAIR_V2_TEST_IDS,
})

export const CURL_REPAIR_V2_POLICY = Object.freeze({
	schemaVersion: 2,
	campaignId: CURL_REPAIR_V2_CAMPAIGN_ID,
	repositoryId: CURL_REPAIR_V2_REPOSITORY_ID,
	repository: CURL_REPAIR_TARGET_REPOSITORY,
	sourceRevision: CURL_REPAIR_SOURCE_REVISION,
	workerProfile: CURL_REPAIR_V2_PROFILE_ID,
	adapterId: CURL_REPAIR_V2_ADAPTER_ID,
	model: CURL_REPAIR_V2_MODEL,
	accessProfile: CURL_REPAIR_V2_ACCESS_PROFILE,
	recipeDigest: CURL_REPAIR_V2_RECIPE_DIGEST,
	evaluatorDigest: CURL_REPAIR_V2_EVALUATOR_DIGEST,
	reservation: CURL_REPAIR_V2_RESERVATION,
	lifetimeAllocation: CURL_REPAIR_V2_LIFETIME_ALLOCATION,
	maxCalls: 0,
	maxTokens: 0,
	maxSpendMicros: 0,
	maximumWorkerDurationSeconds: 825,
})
export const CURL_REPAIR_V2_POLICY_SHA256 = digest(CURL_REPAIR_V2_POLICY)

function digest(value: object): string {
	return createHash("sha256").update(canonical(value)).digest("hex")
}

function canonical(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value)
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`
	const entries = Object.entries(value as Record<string, unknown>)
		.sort(([left], [right]) => left.localeCompare(right))
	return `{${entries.map(([key, item]) =>
		`${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`
}
