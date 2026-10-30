import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import * as os from "node:os"
import * as path from "node:path"
import {
	CURL_REPAIR_DELIVERY_POLICY,
	CURL_REPAIR_DELIVERY_POLICY_SHA256,
	fixedCurlDeliveryGitHubEnvironment,
	deliverVerifiedCurlRepairDraft,
	type CurlRepairClaim,
	type CurlRepairDeliveryDependencies,
	type CurlRepairGitAdapter,
	type CurlRepairGitHubAdapter,
	type CurlRepairPullRequest,
	type CurlRepairTarget,
} from "../repository-curl-repair-delivery.js"
import {
	CURL_REPAIR_CANDIDATE_REVISION,
	CURL_REPAIR_CANDIDATE_TREE_SHA,
	CURL_REPAIR_HISTORICAL_BASE,
	CURL_REPAIR_PATCH_PATH,
	CURL_REPAIR_PATCH_SHA256,
	CURL_REPAIR_PROFILE_ID,
	CURL_REPAIR_SOURCE_REVISION,
	CURL_REPAIR_SOURCE_TREE_SHA,
	CURL_REPAIR_PROTECTED_ARTIFACT_MANIFEST_SHA256,
	CURL_REPAIR_PROTECTED_EVALUATOR_DIGEST,
	CURL_REPAIR_PROTECTED_PROOF_EVIDENCE_SHA256,
	CURL_REPAIR_PROTECTED_RECEIPT_SHA256,
	type CurlHistoricalRepairCandidate,
} from "../repository-curl-repair.js"
import type * as Evaluator from "../repository-curl-repair-evaluator.js"
import type * as Contract from "./repository-curl-repair-delivery-contract.js"
import {
	fixtureGit,
	fixtureGitHub,
} from "./repository-curl-repair-delivery-adapters.js"
import {
	makeCandidate,
	makeReceipt,
} from "./repository-curl-repair-delivery-data.js"
import { runMain, type SuiteTest } from "../../test-runner.js"

import {
	branch,
	claim,
	repo,
	jobId,
} from "./repository-curl-repair-delivery-contract.js"

export {
	canonical,
	digest,
	makeCandidate,
	makeReceipt,
} from "./repository-curl-repair-delivery-data.js"

export {
	branch,
	claim,
	repo,
	jobId,
} from "./repository-curl-repair-delivery-contract.js"
type FixtureState = Contract.FixtureState
export type { FixtureState }

type DeliveryFixture = {
	dependencies: CurlRepairDeliveryDependencies
	calls: string[]
	created: { branch: string; title: string; body: string }[]
}

export function fixture(
	targetBase: string,
	alreadyFixed: boolean,
): DeliveryFixture {
	const root = fixtureRoot()
	const state = newFixtureState()
	const target = fixtureTarget(targetBase)
	const git = fixtureGit(targetBase, alreadyFixed, state, target)
	const github = fixtureGitHub(targetBase, state)
	const dependencies = fixtureDependencies(root, state, git, github)
	return { dependencies, calls: state.calls, created: state.created }
}

function fixtureRoot(): string {
	const label = `curl-repair-delivery-${process.pid}`
	return path.join(
		os.tmpdir(),
		`${label}-${Math.random().toString(16).slice(2)}`,
	)
}

function newFixtureState(): FixtureState {
	return { calls: [], created: [], pushed: false }
}

function fixtureTarget(targetBase: string): CurlRepairTarget {
	return {
		repository: repo,
		private: true,
		branch,
		baseRevision: targetBase,
		treeSha: fixtureTreeSha(targetBase),
		changedPathsFromSource: fixtureChangedPaths(targetBase),
	}
}

function fixtureTreeSha(targetBase: string): string {
	if (targetBase === CURL_REPAIR_HISTORICAL_BASE) {
		return "b1ea31bb7377dd2bfe08fd67af44860de57afc12"
	}
	if (targetBase === CURL_REPAIR_SOURCE_REVISION)
		return CURL_REPAIR_SOURCE_TREE_SHA
	return "e1a2673971d538f348ea5e5af80e0a8b62428ecf"
}

function fixtureChangedPaths(targetBase: string): string[] {
	return targetBase === "12a286c3ddb18aa5124775f0084b40f94accaceb"
		? ["AGENTS.md", "CAPSIZE_SOURCE_ADOPTION.md"]
		: []
}

function fixtureDependencies(
	root: string,
	state: FixtureState,
	git: CurlRepairGitAdapter,
	github: CurlRepairGitHubAdapter,
): CurlRepairDeliveryDependencies {
	return {
		store: fixtureStore(root, state),
		stateRoot: root,
		git,
		github,
		evaluate: async ({ candidate: value, jobId: valueJob }) =>
			fixtureEvaluation(value, valueJob, state),
	}
}

function fixtureStore(
	root: string,
	state: FixtureState,
): CurlRepairDeliveryDependencies["store"] {
	return {
		path: path.join(root, "store.json"),
		assertClaimCurrent: async (current): Promise<void> => {
			state.calls.push("fence")
			assert.equal(current.claimId, claim.claimId)
		},
	}
}

function fixtureEvaluation(
	candidate: CurlHistoricalRepairCandidate,
	valueJob: string,
	state: FixtureState,
): Evaluator.CurlHistoricalRepairReceipt {
	state.calls.push("verify-receipt")
	assert.equal(valueJob, jobId)
	return makeReceipt(candidate)
}
