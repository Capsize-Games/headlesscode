import { CURL_FIXED_ADVISORY } from "./repository-curl-evaluator.js"
import {
	CURL_REPAIR_CANDIDATE_REVISION,
	CURL_REPAIR_HISTORICAL_BASE,
} from "./repository-curl-repair.js"
import type {
	BlockedDeliveryContext,
	CurlRepairDeliveryReceipt,
	CurlRepairTarget,
	DeliveryContext,
	DeliveryIdentity,
	DeliveryState,
} from "./repository-curl-repair-delivery-model.js"
import {
	BRANCH_PREFIX,
	DEFAULT_BRANCH,
	REPOSITORY_URL,
} from "./repository-curl-repair-delivery-model.js"
import { writeState } from "./repository-curl-repair-delivery-store.js"
import { canonical } from "./repository-curl-repair-delivery-primitives.js"
import {
	repairPullRequestBody,
} from "./repository-curl-repair-delivery-github.js"
import {
	ensureDraftPullRequest,
	saveEntry,
} from "./repository-curl-repair-delivery-reconcile-draft.js"
import {
	approvedTargetKind,
	isPrivateTarget,
	sameTargetBase,
} from "./repository-curl-repair-delivery-target.js"
import {
	isBranchReady,
	saveBlocked,
	makeEntry,
	receiptFromState,
} from "./repository-curl-repair-delivery-state.js"

export async function reconcileTarget(
	context: Omit<DeliveryContext, "branch" | "expectedBody" | "entry">,
): Promise<CurlRepairDeliveryReceipt> {
	const kind = classifyTarget(context.target)
	if (kind === "unknown") {
		return saveBlocked(
			context,
			"private-target-source-tree-is-not-an-approved-pin",
		)
	}
	if (kind === "invalid")
		return saveBlocked(context, "private-target-identity-mismatch")
	const candidatePresent = await context.git.candidateIsAncestor(
		CURL_REPAIR_CANDIDATE_REVISION,
		context.target.baseRevision,
	)
	return routeTarget(context, kind, candidatePresent)
}

function classifyTarget(
	target: CurlRepairTarget,
): "current" | "vulnerable" | "unknown" | "invalid" {
	if (!isPrivateTarget(target)) return "invalid"
	return approvedTargetKind(target)
}

async function routeTarget(
	context: Omit<DeliveryContext, "branch" | "expectedBody" | "entry">,
	kind: "current" | "vulnerable" | "unknown",
	candidatePresent: boolean,
): Promise<CurlRepairDeliveryReceipt> {
	if (kind === "current") return recordAlreadyFixed(context, candidatePresent)
	return candidatePresent
		? saveBlocked(
				context,
				"private-target-base-is-not-an-approved-repair-base",
			)
		: reconcileRepair(context)
}

async function recordAlreadyFixed(
	context: Omit<DeliveryContext, "branch" | "expectedBody" | "entry">,
	candidatePresent: boolean,
): Promise<CurlRepairDeliveryReceipt> {
	if (!candidatePresent)
		return saveBlocked(
			context,
			"known-private-target-lost-the-reviewed-fix",
		)
	await context.dependencies.store.assertClaimCurrent(context.input.claim)
	return saveAlreadyFixed(context)
}

async function saveAlreadyFixed(
	context: Omit<DeliveryContext, "branch" | "expectedBody" | "entry">,
): Promise<CurlRepairDeliveryReceipt> {
	const entry = makeEntry(
		context.identity,
		context.input.claim,
		"already-fixed",
		`${REPOSITORY_URL}/tree/${DEFAULT_BRANCH}`,
	)
	context.state.entries[context.key] = entry
	await writeState(context.statePath, context.state)
	return receiptFromState(entry)
}

async function reconcileRepair(
	context: Omit<DeliveryContext, "branch" | "expectedBody" | "entry">,
): Promise<CurlRepairDeliveryReceipt> {
	const active = createRepairContext(context)
	const blocked = await ensureRepairBranch(active)
	if (blocked) return blocked
	return ensureDraftPullRequest(active)
}

function createRepairContext(
	context: Omit<DeliveryContext, "branch" | "expectedBody" | "entry">,
): DeliveryContext {
	const branch = BRANCH_PREFIX + context.identity.patchSha256.slice(0, 16)
	const expectedBody = repairPullRequestBody(context.identity)
	const entry =
		context.prior ??
		makeEntry(
			context.identity,
			context.input.claim,
			"push-intent",
			null,
			branch,
		)
	return { ...context, branch, expectedBody, entry }
}

async function ensureRepairBranch(
	context: DeliveryContext,
): Promise<CurlRepairDeliveryReceipt | null> {
	if (isBranchReady(context.entry)) return null
	await markPushIntent(context)
	const remoteBranch = await context.git.remoteBranchRevision(context.branch)
	return reconcileRemoteBranch(context, remoteBranch)
}

async function markPushIntent(context: DeliveryContext): Promise<void> {
	context.entry = {
		...context.entry,
		state: "push-intent",
		updatedAt: Date.now(),
	}
	await saveEntry(context)
}

async function reconcileRemoteBranch(
	context: DeliveryContext,
	remoteBranch: string | null,
): Promise<CurlRepairDeliveryReceipt | null> {
	if (
		remoteBranch !== null &&
		remoteBranch !== CURL_REPAIR_CANDIDATE_REVISION
	) {
		return saveBlocked(context, "private-repair-branch-is-occupied")
	}
	if (remoteBranch === null) return pushRepairBranch(context)
	await markBranchPushed(context)
	return null
}

async function markBranchPushed(context: DeliveryContext): Promise<void> {
	context.entry = {
		...context.entry,
		state: "branch-pushed",
		updatedAt: Date.now(),
	}
	await saveEntry(context)
}

async function pushRepairBranch(
	context: DeliveryContext,
): Promise<CurlRepairDeliveryReceipt | null> {
	if (!(await isCurrentClaimAndTarget(context))) {
		return saveBlocked(context, "private-target-moved-before-branch-write")
	}
	const uncertain = await pushAndReadBack(context)
	if (uncertain) return uncertain
	context.entry = {
		...context.entry,
		state: "branch-pushed",
		updatedAt: Date.now(),
	}
	await saveEntry(context)
	return null
}

async function isCurrentClaimAndTarget(
	context: DeliveryContext,
): Promise<boolean> {
	const latest = await context.git.inspectTarget()
	if (!sameTargetBase(latest, context.target)) return false
	await context.dependencies.store.assertClaimCurrent(context.input.claim)
	return true
}

async function pushAndReadBack(
	context: DeliveryContext,
): Promise<CurlRepairDeliveryReceipt | null> {
	if (!(await pushOrRecover(context))) {
		return saveBlocked(
			context,
			"private-branch-write-needs-readback",
			"branch-uncertain",
		)
	}
	return verifyPushedBranch(context)
}

async function pushOrRecover(context: DeliveryContext): Promise<boolean> {
	try {
		await context.git.pushCandidate(
			context.branch,
			CURL_REPAIR_CANDIDATE_REVISION,
			context.target.baseRevision,
		)
		return true
	} catch {
		const recovered = await context.git.remoteBranchRevision(context.branch)
		return recovered === CURL_REPAIR_CANDIDATE_REVISION
	}
}

async function verifyPushedBranch(
	context: DeliveryContext,
): Promise<CurlRepairDeliveryReceipt | null> {
	return (await context.git.remoteBranchRevision(context.branch)) ===
		CURL_REPAIR_CANDIDATE_REVISION
		? null
		: saveBlocked(
				context,
				"private-branch-write-readback-mismatch",
				"pr-uncertain",
			)
}
