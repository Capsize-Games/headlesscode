import assert from "node:assert/strict"
import {
	CURL_REPAIR_CANDIDATE_REVISION,
	CURL_REPAIR_HISTORICAL_BASE,
} from "../repository-curl-repair.js"
import type {
	CurlRepairGitAdapter,
	CurlRepairGitHubAdapter,
	CurlRepairTarget,
	CurlRepairPullRequest,
} from "../repository-curl-repair-delivery.js"
import {
	branch,
	repo,
	type FixtureState,
} from "./repository-curl-repair-delivery-contract.js"

export function fixtureGit(
	targetBase: string,
	alreadyFixed: boolean,
	state: FixtureState,
	target: CurlRepairTarget,
): CurlRepairGitAdapter {
	return {
		inspectTarget: async (): Promise<CurlRepairTarget> =>
			inspectFixtureTarget(state, target),
		candidateIsAncestor: async (candidate, base): Promise<boolean> =>
			fixtureAncestry(candidate, base, targetBase, alreadyFixed, state),
		remoteBranchRevision: async (value): Promise<string | null> =>
			fixtureBranchRevision(value, state),
		pushCandidate: async (value, candidate, base): Promise<void> =>
			fixturePush(value, candidate, base, targetBase, state),
	}
}

function inspectFixtureTarget(
	state: FixtureState,
	target: CurlRepairTarget,
): CurlRepairTarget {
	state.calls.push("inspect-target")
	return target
}

function fixtureAncestry(
	candidate: string,
	base: string,
	targetBase: string,
	alreadyFixed: boolean,
	state: FixtureState,
): boolean {
	state.calls.push("ancestry")
	assert.equal(candidate, CURL_REPAIR_CANDIDATE_REVISION)
	assert.equal(base, targetBase)
	return alreadyFixed
}

function fixtureBranchRevision(
	value: string,
	state: FixtureState,
): string | null {
	state.calls.push("read-branch")
	assert.match(value, /^codex\/curl-CVE-2026-92390-[a-f0-9]{16}$/)
	return state.pushed ? CURL_REPAIR_CANDIDATE_REVISION : null
}

function fixturePush(
	value: string,
	candidate: string,
	base: string,
	targetBase: string,
	state: FixtureState,
): void {
	state.calls.push("push")
	assert.match(value, /^codex\/curl-CVE-2026-92390-[a-f0-9]{16}$/)
	assert.equal(candidate, CURL_REPAIR_CANDIDATE_REVISION)
	assert.equal(base, CURL_REPAIR_HISTORICAL_BASE)
	assert.equal(targetBase, CURL_REPAIR_HISTORICAL_BASE)
	state.pushed = true
}

export function fixtureGitHub(
	targetBase: string,
	state: FixtureState,
): CurlRepairGitHubAdapter {
	return {
		findPullRequests: async (value): Promise<CurlRepairPullRequest[]> =>
			fixturePullRequests(value, state),
		createDraftPullRequest: async (input): Promise<void> =>
			createFixtureDraft(input, targetBase, state),
	}
}

function fixturePullRequests(
	value: string,
	state: FixtureState,
): CurlRepairPullRequest[] {
	state.calls.push("find-pull")
	assert.match(value, /^codex\/curl-CVE-2026-92390-[a-f0-9]{16}$/)
	return state.persistedPull ? [state.persistedPull] : []
}

function createFixtureDraft(
	input: { branch: string; title: string; body: string },
	targetBase: string,
	state: FixtureState,
): void {
	state.calls.push("create-pull")
	state.created.push(input)
	state.persistedPull = makeFixturePull(input, targetBase)
}

function makeFixturePull(
	input: { branch: string; title: string; body: string },
	targetBase: string,
): CurlRepairPullRequest {
	return {
		number: 9,
		url: `https://github.com/${repo}/pull/9`,
		state: "open",
		draft: true,
		title: input.title,
		body: input.body,
		branch: input.branch,
		baseBranch: branch,
		headRepository: repo,
		headRevision: CURL_REPAIR_CANDIDATE_REVISION,
		baseRevision: targetBase,
	}
}
