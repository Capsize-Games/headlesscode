import { CURL_REPAIR_CANDIDATE_REVISION } from "./repository-curl-repair.js"
import type {
	CurlRepairGitAdapter,
	CurlRepairTarget,
} from "./repository-curl-repair-delivery-model.js"
import {
	FixedCurlGitCheckout,
} from "./repository-curl-repair-delivery-git-checkout.js"
import {
	verifyTargetRepository,
	readTargetSnapshot,
	validateAncestryRequest,
	fetchCandidate,
	verifyCandidateTree,
	checkCandidateAncestry,
	validatePushRequest,
	verifyPushOrigin,
	verifyPushBase,
	pushPinnedCandidate,
} from "./repository-curl-repair-delivery-git-operations.js"
import { GIT_URL } from "./repository-curl-repair-delivery-model.js"
import {
	isSha,
	validateBranch,
} from "./repository-curl-repair-delivery-store.js"
import { run, gitValue } from "./repository-curl-repair-delivery-runtime.js"

export class FixedCurlGitAdapter implements CurlRepairGitAdapter {
	private readonly checkout: string
	private readonly checkoutManager: FixedCurlGitCheckout
	constructor(stateRoot: string) {
		this.checkoutManager = new FixedCurlGitCheckout(stateRoot)
		this.checkout = this.checkoutManager.path
	}
	async inspectTarget(): Promise<CurlRepairTarget> {
		await this.checkoutManager.ensure()
		await verifyTargetRepository()
		return readTargetSnapshot(this.checkout)
	}
	async candidateIsAncestor(
		candidateRevision: string,
		targetRevision: string,
	): Promise<boolean> {
		validateAncestryRequest(candidateRevision, targetRevision)
		await fetchCandidate(this.checkout, candidateRevision)
		await verifyCandidateTree(this.checkout, candidateRevision)
		return checkCandidateAncestry(
			this.checkout,
			candidateRevision,
			targetRevision,
		)
	}
	async remoteBranchRevision(branch: string): Promise<string | null> {
		validateBranch(branch)
		const result = await run("git-ls-remote-branch", [
			"ls-remote",
			"--heads",
			GIT_URL,
			`refs/heads/${branch}`,
		])
		const lines = result.split(/\r?\n/).filter(Boolean)
		if (lines.length === 0) return null
		if (lines.length !== 1)
			throw new Error("private Curl branch lookup is ambiguous")
		const [revision, ref] = lines[0]!.split(/\s+/, 2)
		if (!isSha(revision) || ref !== `refs/heads/${branch}`)
			throw new Error("private Curl branch lookup is invalid")
		return revision
	}
	async pushCandidate(
		branch: string,
		candidateRevision: string,
		expectedBaseRevision: string,
	): Promise<void> {
		validatePushRequest(branch, candidateRevision, expectedBaseRevision)
		await this.checkoutManager.ensure()
		await verifyPushOrigin(this.checkout)
		await verifyPushBase(this.checkout, expectedBaseRevision)
		await pushPinnedCandidate(this.checkout, branch, candidateRevision)
	}
}
