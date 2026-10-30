import type {
	CurlRepairDeliveryReceipt,
	CurlRepairPullRequest,
	DeliveryContext,
	DeliveryState,
} from "./repository-curl-repair-delivery-model.js"
import {
	CURL_REPAIR_CANDIDATE_REVISION,
	CURL_REPAIR_TARGET_REPOSITORY,
} from "./repository-curl-repair.js"
import { DEFAULT_BRANCH } from "./repository-curl-repair-delivery-model.js"
import {
	matchesPullRequest,
	repairPullRequestTitle,
} from "./repository-curl-repair-delivery-github.js"
import {
	saveBlocked,
	receiptFromState,
} from "./repository-curl-repair-delivery-state.js"
import { sameTargetBase } from "./repository-curl-repair-delivery-target.js"
import { writeState } from "./repository-curl-repair-delivery-store.js"

export async function ensureDraftPullRequest(
	context: DeliveryContext,
): Promise<CurlRepairDeliveryReceipt> {
	const pulls = await context.github.findPullRequests(context.branch)
	if (pulls.length > 1)
		return saveBlocked(context, "private-draft-pull-request-ambiguous")
	if (pulls.length === 1) return recordExistingDraft(context, pulls[0]!)
	if (hasUncertainDraft(context.prior)) {
		return saveBlocked(
			context,
			"prior-draft-write-has-no-exact-readback",
			"pr-uncertain",
		)
	}
	return createDraftPullRequest(context)
}

async function recordExistingDraft(
	context: DeliveryContext,
	pull: CurlRepairPullRequest,
): Promise<CurlRepairDeliveryReceipt> {
	if (!matchesPullRequest(pull, expectedPullRequest(context))) {
		return saveBlocked(
			context,
			"private-draft-pull-request-metadata-mismatch",
		)
	}
	return recordDraftReady(context, pull.url)
}

function expectedPullRequest(context: DeliveryContext): {
	branch: string
	baseRevision: string
	body: string
} {
	return {
		branch: context.branch,
		baseRevision: context.target.baseRevision,
		body: context.expectedBody,
	}
}

function hasUncertainDraft(
	prior: DeliveryState["entries"][string] | undefined,
): boolean {
	return prior?.state === "pr-intent" || prior?.state === "pr-uncertain"
}

async function createDraftPullRequest(
	context: DeliveryContext,
): Promise<CurlRepairDeliveryReceipt> {
	const stable = await ensureStableDraftTarget(context)
	if (!stable)
		return saveBlocked(context, "private-target-moved-before-draft-write")
	await markDraftIntent(context)
	await context.dependencies.store.assertClaimCurrent(context.input.claim)
	if (!(await requestDraft(context))) {
		return saveBlocked(
			context,
			"private-draft-write-needs-readback",
			"pr-uncertain",
		)
	}
	return verifyDraftReadback(context)
}

async function ensureStableDraftTarget(
	context: DeliveryContext,
): Promise<boolean> {
	const latest = await context.git.inspectTarget()
	return sameTargetBase(latest, context.target)
}

async function markDraftIntent(context: DeliveryContext): Promise<void> {
	context.entry = {
		...context.entry,
		state: "pr-intent",
		updatedAt: Date.now(),
	}
	await saveEntry(context)
}

async function requestDraft(context: DeliveryContext): Promise<boolean> {
	try {
		await context.github.createDraftPullRequest({
			branch: context.branch,
			title: repairPullRequestTitle(),
			body: context.expectedBody,
		})
		return true
	} catch {
		return false
	}
}

async function verifyDraftReadback(
	context: DeliveryContext,
): Promise<CurlRepairDeliveryReceipt> {
	const readback = await context.github.findPullRequests(context.branch)
	if (
		readback.length !== 1 ||
		!matchesPullRequest(readback[0]!, expectedPullRequest(context))
	) {
		return saveBlocked(
			context,
			"private-draft-write-readback-mismatch",
			"pr-uncertain",
		)
	}
	return recordDraftReady(context, readback[0]!.url)
}

async function recordDraftReady(
	context: DeliveryContext,
	privateRef: string,
): Promise<CurlRepairDeliveryReceipt> {
	context.entry = {
		...context.entry,
		state: "draft-ready",
		privateRef,
		updatedAt: Date.now(),
	}
	await saveEntry(context)
	return receiptFromState(context.entry)
}

export async function saveEntry(context: DeliveryContext): Promise<void> {
	context.state.entries[context.key] = context.entry
	await writeState(context.statePath, context.state)
}
