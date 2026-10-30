import {
	CURL_REPAIR_CANDIDATE_REVISION,
	CURL_REPAIR_CANDIDATE_TREE_SHA,
	CURL_REPAIR_HISTORICAL_BASE,
	CURL_REPAIR_TARGET_BASE,
	CURL_REPAIR_TARGET_REPOSITORY,
} from "./repository-curl-repair.js"
import type {
	CurlRepairTarget,
} from "./repository-curl-repair-delivery-model.js"
import {
	DEFAULT_BRANCH,
	GIT_URL,
	TARGET_PATH,
	REPOSITORY_URL,
} from "./repository-curl-repair-delivery-model.js"
import { isRecord } from "./repository-curl-repair-delivery-primitives.js"
import {
	isSha,
	validateBranch,
} from "./repository-curl-repair-delivery-store.js"
import {
	run,
	runGitHub,
	gitValue,
	runStatus,
} from "./repository-curl-repair-delivery-runtime.js"

export async function verifyTargetRepository(): Promise<void> {
	const repository = await runGitHub("gh-repo-view", [
		"repo",
		"view",
		CURL_REPAIR_TARGET_REPOSITORY,
		"--json",
		"nameWithOwner,url,isPrivate,defaultBranchRef",
	])
	let view: unknown
	try {
		view = JSON.parse(repository)
	} catch {
		throw new Error("private Curl destination metadata is invalid")
	}
	if (!isFixedRepositoryView(view))
		throw new Error(
			"private Curl destination does not match fixed identity",
		)
}

function isFixedRepositoryView(view: unknown): boolean {
	return Boolean(
		isRecord(view) &&
			view.nameWithOwner === CURL_REPAIR_TARGET_REPOSITORY &&
			view.url === REPOSITORY_URL &&
			view.isPrivate === true &&
			isRecord(view.defaultBranchRef) &&
			view.defaultBranchRef.name === DEFAULT_BRANCH,
	)
}

export async function readTargetSnapshot(
	checkout: string,
): Promise<CurlRepairTarget> {
	await fetchTargetBranch(checkout)
	const baseRevision = await readDefaultBranchRevision(checkout)
	return targetSnapshot(checkout, baseRevision)
}

async function targetSnapshot(
	checkout: string,
	baseRevision: string,
): Promise<CurlRepairTarget> {
	const evidence = await targetTreeEvidence(checkout, baseRevision)
	return {
		repository: CURL_REPAIR_TARGET_REPOSITORY,
		private: true,
		branch: DEFAULT_BRANCH,
		baseRevision,
		...evidence,
	}
}

async function targetTreeEvidence(
	checkout: string,
	baseRevision: string,
): Promise<{ treeSha: string; changedPathsFromSource: string[] }> {
	const treeSha = await gitValue(
		"git-read-target-tree",
		checkout,
		"rev-parse",
		`${baseRevision}^{tree}`,
	)
	const changedPathsFromSource = await readChangedPaths(
		checkout,
		baseRevision,
	)
	return { treeSha, changedPathsFromSource }
}

async function fetchTargetBranch(checkout: string): Promise<void> {
	await run("git-fetch-target-branch", [
		"-C",
		checkout,
		"fetch",
		"--no-tags",
		"--no-recurse-submodules",
		"origin",
		`+refs/heads/${DEFAULT_BRANCH}:refs/remotes/origin/${DEFAULT_BRANCH}`,
	])
}

async function readDefaultBranchRevision(checkout: string): Promise<string> {
	return gitValue(
		"git-read-target-revision",
		checkout,
		"rev-parse",
		`refs/remotes/origin/${DEFAULT_BRANCH}^{commit}`,
	)
}

async function readChangedPaths(
	checkout: string,
	revision: string,
): Promise<string[]> {
	const changed = await gitValue(
		"git-read-source-changes",
		checkout,
		"diff",
		"--name-only",
		CURL_REPAIR_TARGET_BASE,
		revision,
	)
	return changed.split(/\r?\n/).filter(Boolean).sort()
}

export function validateAncestryRequest(
	candidate: string,
	target: string,
): void {
	if (candidate !== CURL_REPAIR_CANDIDATE_REVISION || !isSha(target))
		throw new Error(
			"Curl ancestry query is outside the fixed source identity",
		)
}

export async function fetchCandidate(
	checkout: string,
	candidate: string,
): Promise<void> {
	await run("git-fetch-candidate", [
		"-C",
		checkout,
		"fetch",
		"--no-tags",
		"--no-recurse-submodules",
		TARGET_PATH,
		candidate,
	])
}

export async function verifyCandidateTree(
	checkout: string,
	candidate: string,
): Promise<void> {
	const tree = await gitValue(
		"git-check-candidate-tree",
		checkout,
		"rev-parse",
		`${candidate}^{tree}`,
	)
	if (tree !== CURL_REPAIR_CANDIDATE_TREE_SHA)
		throw new Error(
			"private source candidate tree differs from compiled repair pin",
		)
}

export async function checkCandidateAncestry(
	checkout: string,
	candidate: string,
	target: string,
): Promise<boolean> {
	const status = await runStatus("git-check-candidate-ancestry", [
		"-C",
		checkout,
		"merge-base",
		"--is-ancestor",
		candidate,
		target,
	])
	if (status === 0) return true
	if (status === 1) return false
	throw new Error("private Curl candidate ancestry could not be established")
}

export function validatePushRequest(
	branch: string,
	candidate: string,
	base: string,
): void {
	validateBranch(branch)
	if (
		candidate !== CURL_REPAIR_CANDIDATE_REVISION ||
		base !== CURL_REPAIR_HISTORICAL_BASE
	)
		throw new Error(
			"private Curl branch write is outside fixed historical repair",
		)
}

export async function verifyPushOrigin(checkout: string): Promise<void> {
	const origin = await gitValue(
		"git-read-origin",
		checkout,
		"remote",
		"get-url",
		"origin",
	)
	if (origin !== GIT_URL)
		throw new Error(
			"private Curl checkout origin does not match fixed destination",
		)
}

export async function verifyPushBase(
	checkout: string,
	expected: string,
): Promise<void> {
	await fetchTargetBranch(checkout)
	const base = await readDefaultBranchRevision(checkout)
	if (base !== expected)
		throw new Error("private Curl default branch moved before repair push")
}

export async function pushPinnedCandidate(
	checkout: string,
	branch: string,
	candidate: string,
): Promise<void> {
	await run("git-push-candidate", [
		"-C",
		checkout,
		"push",
		"origin",
		`${candidate}:refs/heads/${branch}`,
	])
}
