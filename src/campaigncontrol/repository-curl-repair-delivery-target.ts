import type {
	CurlRepairTarget,
} from "./repository-curl-repair-delivery-model.js"
import {
	CURL_REPAIR_HISTORICAL_BASE,
	CURL_REPAIR_SOURCE_TREE_SHA,
	CURL_REPAIR_TARGET_BASE,
	CURL_REPAIR_TARGET_REPOSITORY,
} from "./repository-curl-repair.js"
import { isSha } from "./repository-curl-repair-delivery-store.js"
import { canonical } from "./repository-curl-repair-delivery-primitives.js"
import {
	DEFAULT_BRANCH,
	HISTORICAL_BASE_TREE,
	VERIFIED_TARGET_TIP,
	VERIFIED_TARGET_TREE,
	VERIFIED_TARGET_ADDITIONS,
} from "./repository-curl-repair-delivery-model.js"

export function sameTargetBase(
	latest: CurlRepairTarget,
	target: CurlRepairTarget,
): boolean {
	return (
		latest.baseRevision === target.baseRevision &&
		latest.private &&
		latest.repository === CURL_REPAIR_TARGET_REPOSITORY &&
		latest.branch === DEFAULT_BRANCH
	)
}

export function sameChangedPaths(paths: string[]): boolean {
	return (
		canonical([...paths].sort()) ===
		canonical([...VERIFIED_TARGET_ADDITIONS].sort())
	)
}

export function isPrivateTarget(target: CurlRepairTarget): boolean {
	return (
		target.repository === CURL_REPAIR_TARGET_REPOSITORY &&
		target.private &&
		target.branch === DEFAULT_BRANCH &&
		isSha(target.baseRevision) &&
		isSha(target.treeSha) &&
		Array.isArray(target.changedPathsFromSource)
	)
}

export function approvedTargetKind(
	target: CurlRepairTarget,
): "current" | "vulnerable" | "unknown" {
	const currentSource =
		target.baseRevision === CURL_REPAIR_TARGET_BASE &&
		target.treeSha === CURL_REPAIR_SOURCE_TREE_SHA &&
		target.changedPathsFromSource.length === 0
	const currentDocs =
		target.baseRevision === VERIFIED_TARGET_TIP &&
		target.treeSha === VERIFIED_TARGET_TREE &&
		sameChangedPaths(target.changedPathsFromSource)
	if (currentSource || currentDocs) return "current"
	return target.baseRevision === CURL_REPAIR_HISTORICAL_BASE &&
		target.treeSha === HISTORICAL_BASE_TREE
		? "vulnerable"
		: "unknown"
}
