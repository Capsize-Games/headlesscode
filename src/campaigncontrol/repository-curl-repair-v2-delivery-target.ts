import type { CurlRepairV2DeliveryInput } from
	"./repository-curl-repair-v2-delivery-validation.js"
import type {
	CurlRepairV2DeliveryDependencies,
	VerifiedCurlRepairV2Delivery,
} from "./repository-curl-repair-v2-private-delivery-types.js"
import {
	createFixedCurlReadOnlyGitAdapter,
	CURL_REPAIR_DELIVERY_POLICY,
	type CurlRepairTarget,
	type FixedCurlReadOnlyGit,
} from "./repository-curl-repair-delivery.js"
import { CURL_REPAIR_SOURCE_TREE_SHA, CURL_REPAIR_TARGET_BASE } from
	"./repository-curl-repair.js"
import { requireClaimCurrent } from
	"./repository-curl-repair-v2-delivery-current.js"
import { canonical } from
	"./repository-curl-repair-v2-delivery-digest.js"

export async function assertAlreadyFixed(
	verified: VerifiedCurlRepairV2Delivery,
	input: CurlRepairV2DeliveryInput,
	dependencies: CurlRepairV2DeliveryDependencies,
): Promise<void> {
	await requireClaimCurrent(dependencies, input.claim, input.signal)
	const git = dependencies.git ?? createFixedCurlReadOnlyGitAdapter()
	const target = await git.inspectTarget()
	await requireClaimCurrent(dependencies, input.claim, input.signal)
	if (!targetIsApprovedFixedTarget(target)) {
		throw new Error("private Curl target is outside its reviewed fixed pins")
	}
	await verifyTargetAncestry(git, target, verified, input, dependencies)
}

async function verifyTargetAncestry(
	git: FixedCurlReadOnlyGit,
	target: CurlRepairTarget,
	verified: VerifiedCurlRepairV2Delivery,
	input: CurlRepairV2DeliveryInput,
	dependencies: CurlRepairV2DeliveryDependencies,
): Promise<void> {
	await requireClaimCurrent(dependencies, input.claim, input.signal)
	const present = await git.candidateIsAncestor(
		verified.receipt.candidateRevision,
		target.baseRevision,
	)
	await requireClaimCurrent(dependencies, input.claim, input.signal)
	if (!present) {
		throw new Error("private Curl target does not contain the reviewed fix")
	}
}

function targetIsApprovedFixedTarget(target: CurlRepairTarget): boolean {
	if (target.repository !== CURL_REPAIR_DELIVERY_POLICY.targetRepository ||
		target.private !== true ||
		target.branch !== CURL_REPAIR_DELIVERY_POLICY.targetBranch) return false
	return sourceTargetMatches(target) || docsTargetMatches(target)
}

function sourceTargetMatches(target: CurlRepairTarget): boolean {
	return target.baseRevision === CURL_REPAIR_TARGET_BASE &&
		target.treeSha === CURL_REPAIR_SOURCE_TREE_SHA &&
		target.changedPathsFromSource.length === 0
}

function docsTargetMatches(target: CurlRepairTarget): boolean {
	const expected = CURL_REPAIR_DELIVERY_POLICY.verifiedCurrentTargetAddedPaths
	return target.baseRevision ===
		CURL_REPAIR_DELIVERY_POLICY.verifiedCurrentTargetTip &&
		target.treeSha === CURL_REPAIR_DELIVERY_POLICY.verifiedCurrentTargetTree &&
		canonical([...target.changedPathsFromSource].sort()) ===
			canonical([...expected].sort())
}
