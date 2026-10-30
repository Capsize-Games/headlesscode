import { CURL_FIXED_ADVISORY } from "./repository-curl-evaluator.js"
import {
	CURL_REPAIR_CANDIDATE_REVISION,
	CURL_REPAIR_CANDIDATE_TREE_SHA,
	CURL_REPAIR_HISTORICAL_BASE,
	CURL_REPAIR_TARGET_REPOSITORY,
} from "./repository-curl-repair.js"
import type {
	CurlRepairGitHubAdapter,
	CurlRepairPullRequest,
} from "./repository-curl-repair-delivery-model.js"
import {
	DEFAULT_BRANCH,
	REPOSITORY_URL,
} from "./repository-curl-repair-delivery-model.js"
import { isRecord } from "./repository-curl-repair-delivery-primitives.js"
import {
	isSha,
	validateBranch,
} from "./repository-curl-repair-delivery-store.js"
import { runGitHub } from "./repository-curl-repair-delivery-runtime.js"

type DraftInput = { branch: string; title: string; body: string }
type RepairIdentity = {
	receiptSha256: string
	patchSha256: string
	identitySha256: string
}

export class FixedCurlGitHubAdapter implements CurlRepairGitHubAdapter {
	async findPullRequests(branch: string): Promise<CurlRepairPullRequest[]> {
		validateBranch(branch)
		const raw = await runGitHub("gh-list-pull-requests", [
			"api",
			pullRequestListPath(branch),
		])
		let rows: unknown
		try {
			rows = JSON.parse(raw)
		} catch {
			throw new Error("private Curl pull request response is invalid")
		}
		if (!Array.isArray(rows) || rows.length >= 100)
			throw new Error(
				"private Curl pull request response exceeds its bound",
			)
		return parsePullRequests(rows)
	}
	async createDraftPullRequest(input: {
		branch: string
		title: string
		body: string
	}): Promise<void> {
		validateBranch(input.branch)
		assertDraftContent(input)
		await createDraftRequest(input)
	}
}

function pullRequestListPath(branch: string): string {
	return (
		`repos/${CURL_REPAIR_TARGET_REPOSITORY}/pulls?state=all&` +
		`head=Capsize-Games:${branch}&per_page=100`
	)
}

async function createDraftRequest(input: DraftInput): Promise<void> {
	await runGitHub("gh-create-draft", draftArguments(input), 60_000)
}

function draftArguments(input: DraftInput): string[] {
	return [
		"pr",
		"create",
		"--draft",
		"--repo",
		CURL_REPAIR_TARGET_REPOSITORY,
		"--base",
		DEFAULT_BRANCH,
		"--head",
		draftHead(input.branch),
		"--title",
		input.title,
		"--body",
		input.body,
	]
}

function draftHead(branch: string): string {
	return `${CURL_REPAIR_TARGET_REPOSITORY.split("/")[0]}:${branch}`
}

function assertDraftContent(input: { title: string; body: string }): void {
	if (
		input.title !== repairPullRequestTitle() ||
		input.body.length > 8_000 ||
		!input.body.startsWith("Verified historical Curl repair")
	) {
		throw new Error(
			"private Curl draft content is outside the fixed repair template",
		)
	}
}

function parsePullRequests(rows: unknown[]): CurlRepairPullRequest[] {
	return rows.map(parsePullRequest)
}

function parsePullRequest(value: unknown): CurlRepairPullRequest {
	const result = pullRequestFromValue(value)
	if (
		!hasValidPullRequestScalars(result) ||
		!hasValidPullRequestRefs(result)
	) {
		throw new Error("private Curl pull request record is incomplete")
	}
	return result
}

function pullRequestFromValue(value: unknown): CurlRepairPullRequest {
	if (!hasPullRequestRelations(value))
		throw new Error("private Curl pull request record is incomplete")
	return {
		number: value.number as number,
		url: value.html_url as string,
		state: value.state as string,
		draft: value.draft as boolean,
		title: value.title as string,
		body: value.body as string,
		branch: value.head.ref as string,
		baseBranch: value.base.ref as string,
		headRepository: value.head.repo.full_name as string,
		headRevision: value.head.sha as string,
		baseRevision: value.base.sha as string,
	}
}

function hasPullRequestRelations(value: unknown): value is Record<
	string,
	unknown
> & {
	head: Record<string, unknown> & { repo: Record<string, unknown> }
	base: Record<string, unknown>
} {
	return (
		isRecord(value) &&
		isRecord(value.head) &&
		isRecord(value.base) &&
		isRecord(value.head.repo)
	)
}

function hasValidPullRequestScalars(pull: CurlRepairPullRequest): boolean {
	return (
		Number.isSafeInteger(pull.number) &&
		typeof pull.url === "string" &&
		typeof pull.state === "string" &&
		typeof pull.draft === "boolean" &&
		typeof pull.title === "string" &&
		typeof pull.body === "string" &&
		typeof pull.branch === "string" &&
		typeof pull.baseBranch === "string" &&
		typeof pull.headRepository === "string"
	)
}

function hasValidPullRequestRefs(pull: CurlRepairPullRequest): boolean {
	return isSha(pull.headRevision) && isSha(pull.baseRevision)
}

export function matchesPullRequest(
	pull: CurlRepairPullRequest,
	expected: { branch: string; baseRevision: string; body: string },
): boolean {
	return (
		hasExpectedPullRequestState(pull) &&
		hasExpectedPullRequestSource(pull, expected) &&
		hasExpectedPullRequestContent(pull, expected)
	)
}

function hasExpectedPullRequestState(pull: CurlRepairPullRequest): boolean {
	return (
		pull.state === "open" &&
		pull.draft === true &&
		Number.isSafeInteger(pull.number) &&
		pull.number > 0
	)
}

function hasExpectedPullRequestSource(
	pull: CurlRepairPullRequest,
	expected: { branch: string; baseRevision: string; body: string },
): boolean {
	return (
		pull.branch === expected.branch &&
		pull.baseBranch === DEFAULT_BRANCH &&
		pull.headRepository === CURL_REPAIR_TARGET_REPOSITORY &&
		pull.headRevision === CURL_REPAIR_CANDIDATE_REVISION &&
		pull.baseRevision === expected.baseRevision
	)
}

function hasExpectedPullRequestContent(
	pull: CurlRepairPullRequest,
	expected: { branch: string; baseRevision: string; body: string },
): boolean {
	return (
		pull.title === repairPullRequestTitle() &&
		pull.body === expected.body &&
		pull.url === `${REPOSITORY_URL}/pull/${pull.number}`
	)
}

export function repairPullRequestTitle(): string {
	return `[Draft] ${CURL_FIXED_ADVISORY} Curl historical repair review`
}

export function repairPullRequestBody(identity: RepairIdentity): string {
	return repairBodyLines(identity).join("\n")
}

function repairBodyLines(identity: RepairIdentity): string[] {
	return [
		"Verified historical Curl repair",
		"",
		`Advisory: ${CURL_FIXED_ADVISORY}`,
		`Source: ${CURL_REPAIR_HISTORICAL_BASE}`,
		candidateEvidenceLine(),
		`Patch SHA-256: ${identity.patchSha256}`,
		`Protected receipt SHA-256: ${identity.receiptSha256}`,
		`Delivery identity SHA-256: ${identity.identitySha256}`,
		"Scope: historical public regression evidence only; current host " +
			"applicability was not assessed.",
		"Draft for private review. This workflow does not merge, install, or " +
			"publish to an upstream repository.",
		"",
	]
}

function candidateEvidenceLine(): string {
	return (
		`Candidate: ${CURL_REPAIR_CANDIDATE_REVISION} (tree ` +
		`${CURL_REPAIR_CANDIDATE_TREE_SHA})`
	)
}
