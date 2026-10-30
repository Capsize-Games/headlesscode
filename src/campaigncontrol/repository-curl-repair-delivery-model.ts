import * as os from "node:os"
import * as path from "node:path"
import { CURL_FIXED_ADVISORY } from "./repository-curl-evaluator.js"
import {
	CURL_REPAIR_CANDIDATE_REVISION,
	CURL_REPAIR_CANDIDATE_TREE_SHA,
	CURL_REPAIR_HISTORICAL_BASE,
	CURL_REPAIR_PATCH_PATH,
	CURL_REPAIR_PATCH_SHA256,
	CURL_REPAIR_PROFILE_ID,
	CURL_REPAIR_PROTECTED_EVALUATOR_DIGEST,
	CURL_REPAIR_SOURCE_TREE_SHA,
	CURL_REPAIR_TARGET_BASE,
	CURL_REPAIR_TARGET_REPOSITORY,
	type CurlHistoricalRepairCandidate,
} from "./repository-curl-repair.js"
import {
	evaluateCurlHistoricalRepairCandidate,
	type CurlHistoricalRepairReceipt,
} from "./repository-curl-repair-evaluator.js"
import type { ClaimedRepositoryJob } from "./repository-campaigns.js"
import {
	canonical,
	sha256,
} from "./repository-curl-repair-delivery-primitives.js"

export const DEFAULT_BRANCH = "reviewed-source-ce573393"
export const VERIFIED_TARGET_TIP = "12a286c3ddb18aa5124775f0084b40f94accaceb"
export const VERIFIED_TARGET_TREE = "e1a2673971d538f348ea5e5af80e0a8b62428ecf"
export const VERIFIED_TARGET_ADDITIONS = Object.freeze([
	"AGENTS.md",
	"CAPSIZE_SOURCE_ADOPTION.md",
])
export const HISTORICAL_BASE_TREE = "b1ea31bb7377dd2bfe08fd67af44860de57afc12"
export const STATE_SCHEMA = 1
export const MAX_STATE_BYTES = 256 * 1024
export const MAX_PATCH_BYTES = 2_000_000
export const BRANCH_PREFIX = "codex/curl-CVE-2026-92390-"
export const REPOSITORY_URL =
	"https://github.com/" + CURL_REPAIR_TARGET_REPOSITORY
export const GIT_URL = `${REPOSITORY_URL}.git`
export const TARGET_PATH = path.join(
	os.homedir(),
	".local",
	"share",
	"headlesscode",
	"repository-sources",
	"curl-maintenance",
)

export const CURL_REPAIR_DELIVERY_POLICY = Object.freeze({
	schemaVersion: 1,
	campaignId: "curl-historical-repair",
	repositoryId: "curl-maintenance-repair",
	advisoryId: CURL_FIXED_ADVISORY,
	targetRepository: CURL_REPAIR_TARGET_REPOSITORY,
	targetBranch: DEFAULT_BRANCH,
	verifiedCurrentTargetTip: VERIFIED_TARGET_TIP,
	verifiedCurrentTargetTree: VERIFIED_TARGET_TREE,
	verifiedCurrentTargetAddedPaths: VERIFIED_TARGET_ADDITIONS,
	sourceRevision: CURL_REPAIR_HISTORICAL_BASE,
	sourceTreeSha: HISTORICAL_BASE_TREE,
	candidateRevision: CURL_REPAIR_CANDIDATE_REVISION,
	candidateTreeSha: CURL_REPAIR_CANDIDATE_TREE_SHA,
	patchPath: CURL_REPAIR_PATCH_PATH,
	patchSha256: CURL_REPAIR_PATCH_SHA256,
	protectedEvaluatorDigest: CURL_REPAIR_PROTECTED_EVALUATOR_DIGEST,
	allowedTargetBases: Object.freeze([
		CURL_REPAIR_HISTORICAL_BASE,
		CURL_REPAIR_TARGET_BASE,
		VERIFIED_TARGET_TIP,
	]),
	noPullRequestWhenCandidateIsAncestor: true,
	maximumPatchBytes: MAX_PATCH_BYTES,
})
export const CURL_REPAIR_DELIVERY_POLICY_SHA256 = sha256(
	canonical(CURL_REPAIR_DELIVERY_POLICY),
)

export interface CurlRepairClaim {
	claimId: string
	epoch: number
	job: ClaimedRepositoryJob["job"]
}

export interface CurlRepairDeliveryInput {
	claim: CurlRepairClaim
	candidate: CurlHistoricalRepairCandidate
	receipt: CurlHistoricalRepairReceipt
}

export interface CurlRepairDeliveryReceipt {
	accepted: boolean
	disposition: "already-fixed" | "draft-ready" | "blocked"
	evidenceSha256: string
	privateRef: string | null
	reasonCode: string
}

export interface CurlRepairTarget {
	repository: string
	private: boolean
	branch: string
	baseRevision: string
	treeSha: string
	changedPathsFromSource: string[]
}

export interface CurlRepairPullRequest {
	number: number
	url: string
	state: string
	draft: boolean
	title: string
	body: string
	branch: string
	baseBranch: string
	headRepository: string
	headRevision: string
	baseRevision: string
}

export interface CurlRepairDeliveryStore {
	path: string
	assertClaimCurrent(claim: CurlRepairClaim): Promise<void>
}

export interface CurlRepairGitAdapter {
	inspectTarget(): Promise<CurlRepairTarget>
	candidateIsAncestor(
		candidateRevision: string,
		targetRevision: string,
	): Promise<boolean>
	remoteBranchRevision(branch: string): Promise<string | null>
	pushCandidate(
		branch: string,
		candidateRevision: string,
		expectedBaseRevision: string,
	): Promise<void>
}

export interface CurlRepairGitHubAdapter {
	findPullRequests(branch: string): Promise<CurlRepairPullRequest[]>
	createDraftPullRequest(input: {
		branch: string
		title: string
		body: string
	}): Promise<void>
}

export interface CurlRepairDeliveryDependencies {
	store: CurlRepairDeliveryStore
	stateRoot?: string
	git?: CurlRepairGitAdapter
	github?: CurlRepairGitHubAdapter
	evaluate?: typeof evaluateCurlHistoricalRepairCandidate
}

export interface DeliveryState {
	schemaVersion: 1
	entries: Record<
		string,
		{
			identitySha256: string
			claimId: string
			epoch: number
			jobId: string
			branch: string
			candidateRevision: string
			receiptSha256: string
			state:
				| "already-fixed"
				| "push-intent"
				| "branch-uncertain"
				| "branch-pushed"
				| "pr-intent"
				| "pr-uncertain"
				| "draft-ready"
				| "blocked"
			reasonCode: string
			privateRef: string | null
			updatedAt: number
		}
	>
}

export type DeliveryIdentity = {
	jobId: string
	patchSha256: string
	receiptSha256: string
	identitySha256: string
	key: string
}

export type BlockedDeliveryContext = {
	state: DeliveryState
	statePath: string
	key: string
	identity: DeliveryIdentity
	claim: CurlRepairClaim
}

export type DeliveryContext = BlockedDeliveryContext & {
	input: CurlRepairDeliveryInput
	dependencies: CurlRepairDeliveryDependencies
	git: CurlRepairGitAdapter
	github: CurlRepairGitHubAdapter
	target: CurlRepairTarget
	prior?: DeliveryState["entries"][string]
	branch: string
	expectedBody: string
	entry: DeliveryState["entries"][string]
}
