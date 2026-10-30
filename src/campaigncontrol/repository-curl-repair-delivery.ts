import { createHash, randomUUID } from "node:crypto"
import { execFile, spawnSync } from "node:child_process"
import * as fs from "node:fs"
import * as fsp from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { promisify } from "node:util"
import { CURL_FIXED_ADVISORY } from "./repository-curl-evaluator.js"
import {
	CURL_REPAIR_CANDIDATE_REVISION, CURL_REPAIR_CANDIDATE_TREE_SHA, CURL_REPAIR_HISTORICAL_BASE,
	CURL_REPAIR_PATCH_PATH, CURL_REPAIR_PATCH_SHA256, CURL_REPAIR_PROFILE_ID,
	CURL_REPAIR_PROTECTED_EVALUATOR_DIGEST, CURL_REPAIR_SOURCE_REVISION, CURL_REPAIR_SOURCE_TREE_SHA, CURL_REPAIR_TARGET_BASE,
	CURL_REPAIR_TARGET_REPOSITORY, buildCurlHistoricalRepairCandidate, type CurlHistoricalRepairCandidate,
} from "./repository-curl-repair.js"
import { evaluateCurlHistoricalRepairCandidate, type CurlHistoricalRepairReceipt } from "./repository-curl-repair-evaluator.js"
import type { ClaimedRepositoryJob } from "./repository-campaigns.js"

const execFileAsync = promisify(execFile)
const DEFAULT_BRANCH = "reviewed-source-ce573393"
const VERIFIED_TARGET_TIP = "12a286c3ddb18aa5124775f0084b40f94accaceb"
const VERIFIED_TARGET_TREE = "e1a2673971d538f348ea5e5af80e0a8b62428ecf"
const VERIFIED_TARGET_ADDITIONS = Object.freeze(["AGENTS.md", "CAPSIZE_SOURCE_ADOPTION.md"])
const HISTORICAL_BASE_TREE = "b1ea31bb7377dd2bfe08fd67af44860de57afc12"
const STATE_SCHEMA = 1
const MAX_STATE_BYTES = 256 * 1024
const MAX_PATCH_BYTES = 2_000_000
const BRANCH_PREFIX = "codex/curl-CVE-2026-92390-"
const REPOSITORY_URL = `https://github.com/${CURL_REPAIR_TARGET_REPOSITORY}`
const GIT_URL = `${REPOSITORY_URL}.git`
const GITHUB_CLI = "/usr/bin/gh"
const TARGET_PATH = path.join(os.homedir(), ".local", "share", "headlesscode", "repository-sources", "curl-maintenance")

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
	allowedTargetBases: Object.freeze([CURL_REPAIR_HISTORICAL_BASE, CURL_REPAIR_TARGET_BASE, VERIFIED_TARGET_TIP]),
	noPullRequestWhenCandidateIsAncestor: true,
	maximumPatchBytes: MAX_PATCH_BYTES,
})
export const CURL_REPAIR_DELIVERY_POLICY_SHA256 = sha256(canonical(CURL_REPAIR_DELIVERY_POLICY))

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
	candidateIsAncestor(candidateRevision: string, targetRevision: string): Promise<boolean>
	remoteBranchRevision(branch: string): Promise<string | null>
	pushCandidate(branch: string, candidateRevision: string, expectedBaseRevision: string): Promise<void>
}

export interface CurlRepairGitHubAdapter {
	findPullRequests(branch: string): Promise<CurlRepairPullRequest[]>
	createDraftPullRequest(input: { branch: string; title: string; body: string }): Promise<void>
}

export interface CurlRepairDeliveryDependencies {
	store: CurlRepairDeliveryStore
	stateRoot?: string
	git?: CurlRepairGitAdapter
	github?: CurlRepairGitHubAdapter
	evaluate?: typeof evaluateCurlHistoricalRepairCandidate
}

interface DeliveryState {
	schemaVersion: 1
	entries: Record<string, {
		identitySha256: string
		claimId: string
		epoch: number
		jobId: string
		branch: string
		candidateRevision: string
		receiptSha256: string
		state: "already-fixed" | "push-intent" | "branch-uncertain" | "branch-pushed" | "pr-intent" | "pr-uncertain" | "draft-ready" | "blocked"
		reasonCode: string
		privateRef: string | null
		updatedAt: number
	}>
}

/** Verify and deliver only the pinned Curl repair patch to the owner-private repository. */
export async function deliverVerifiedCurlRepairDraft(
	input: CurlRepairDeliveryInput,
	dependencies: CurlRepairDeliveryDependencies,
): Promise<CurlRepairDeliveryReceipt> {
	const identity = validateInput(input)
	await dependencies.store.assertClaimCurrent(input.claim)
	const evaluation = await (dependencies.evaluate ?? evaluateCurlHistoricalRepairCandidate)({ candidate: input.candidate, jobId: identity.jobId })
	if (canonical(evaluation) !== canonical(input.receipt) || input.receipt.evidenceSha256 !== identity.receiptSha256) {
		throw new Error("protected Curl repair receipt does not match this source patch and campaign job")
	}
	const stateRoot = path.resolve(dependencies.stateRoot ?? path.join(path.dirname(path.resolve(dependencies.store.path)), "curl-repair-delivery"))
	await ensurePrivateDirectory(stateRoot)
	const lock = await acquireLock(path.join(stateRoot, "delivery.lock"))
	try {
		await dependencies.store.assertClaimCurrent(input.claim)
		const statePath = path.join(stateRoot, "delivery-state.json")
		const state = await readState(statePath)
		const key = identity.key
		const prior = state.entries[key]
		if (prior) {
			if (prior.identitySha256 !== identity.identitySha256 || prior.claimId !== input.claim.claimId || prior.epoch !== input.claim.epoch || prior.jobId !== identity.jobId) {
				throw new Error("stored Curl delivery identity conflicts with the current claim")
			}
			if (prior.state === "already-fixed" || prior.state === "draft-ready") return receiptFromState(prior)
			if (prior.state === "blocked") return receiptFromState(prior)
		}
		const git = dependencies.git ?? new FixedCurlGitAdapter(stateRoot)
		const github = dependencies.github ?? new FixedCurlGitHubAdapter()
		const target = await git.inspectTarget()
		if (target.repository !== CURL_REPAIR_TARGET_REPOSITORY || target.private !== true || target.branch !== DEFAULT_BRANCH ||
			!isSha(target.baseRevision) || !isSha(target.treeSha) || !Array.isArray(target.changedPathsFromSource)) {
			return await saveBlocked(state, statePath, key, identity, input.claim, "private-target-identity-mismatch")
		}
		const currentSourceTarget = target.baseRevision === CURL_REPAIR_TARGET_BASE && target.treeSha === CURL_REPAIR_SOURCE_TREE_SHA && target.changedPathsFromSource.length === 0
		const currentDocsTarget = target.baseRevision === VERIFIED_TARGET_TIP && target.treeSha === VERIFIED_TARGET_TREE &&
			canonical([...target.changedPathsFromSource].sort()) === canonical([...VERIFIED_TARGET_ADDITIONS].sort())
		const vulnerableBase = target.baseRevision === CURL_REPAIR_HISTORICAL_BASE && target.treeSha === HISTORICAL_BASE_TREE
		if (!currentSourceTarget && !currentDocsTarget && !vulnerableBase) {
			return await saveBlocked(state, statePath, key, identity, input.claim, "private-target-source-tree-is-not-an-approved-pin")
		}
		const candidateIsPresent = await git.candidateIsAncestor(CURL_REPAIR_CANDIDATE_REVISION, target.baseRevision)
		if (currentSourceTarget || currentDocsTarget) {
			if (!candidateIsPresent) return await saveBlocked(state, statePath, key, identity, input.claim, "known-private-target-lost-the-reviewed-fix")
			await dependencies.store.assertClaimCurrent(input.claim)
			const entry = makeEntry(identity, input.claim, "already-fixed", `${REPOSITORY_URL}/tree/${DEFAULT_BRANCH}`)
			state.entries[key] = entry
			await writeState(statePath, state)
			return receiptFromState(entry)
		}
		if (!vulnerableBase || candidateIsPresent) {
			return await saveBlocked(state, statePath, key, identity, input.claim, "private-target-base-is-not-an-approved-repair-base")
		}

		const branch = BRANCH_PREFIX + identity.patchSha256.slice(0, 16)
		const expectedBody = repairPullRequestBody(identity)
		let entry = prior ?? makeEntry(identity, input.claim, "push-intent", null, branch)
		if (entry.state !== "branch-pushed" && entry.state !== "pr-intent" && entry.state !== "pr-uncertain" && entry.state !== "draft-ready") {
			entry = { ...entry, state: "push-intent", updatedAt: Date.now() }
			state.entries[key] = entry
			await writeState(statePath, state)
			const remoteBranch = await git.remoteBranchRevision(branch)
			if (remoteBranch !== null && remoteBranch !== CURL_REPAIR_CANDIDATE_REVISION) {
				return await saveBlocked(state, statePath, key, identity, input.claim, "private-repair-branch-is-occupied")
			}
			if (remoteBranch === null) {
				const latest = await git.inspectTarget()
			if (latest.baseRevision !== target.baseRevision || latest.private !== true || latest.repository !== CURL_REPAIR_TARGET_REPOSITORY || latest.branch !== DEFAULT_BRANCH) {
					return await saveBlocked(state, statePath, key, identity, input.claim, "private-target-moved-before-branch-write")
				}
				await dependencies.store.assertClaimCurrent(input.claim)
				try { await git.pushCandidate(branch, CURL_REPAIR_CANDIDATE_REVISION, target.baseRevision) }
				catch {
					const recoveredBranch = await git.remoteBranchRevision(branch)
					if (recoveredBranch !== CURL_REPAIR_CANDIDATE_REVISION) {
						return await saveBlocked(state, statePath, key, identity, input.claim, "private-branch-write-needs-readback", "branch-uncertain")
					}
				}
				if (await git.remoteBranchRevision(branch) !== CURL_REPAIR_CANDIDATE_REVISION) {
					return await saveBlocked(state, statePath, key, identity, input.claim, "private-branch-write-readback-mismatch", "pr-uncertain")
				}
			}
			entry = { ...entry, state: "branch-pushed", updatedAt: Date.now() }
			state.entries[key] = entry
			await writeState(statePath, state)
		}

		const pulls = await github.findPullRequests(branch)
		if (pulls.length > 1) return await saveBlocked(state, statePath, key, identity, input.claim, "private-draft-pull-request-ambiguous")
		if (pulls.length === 1) {
			const pull = pulls[0]!
			if (!matchesPullRequest(pull, { branch, baseRevision: target.baseRevision, body: expectedBody })) {
				return await saveBlocked(state, statePath, key, identity, input.claim, "private-draft-pull-request-metadata-mismatch")
			}
			entry = { ...entry, state: "draft-ready", privateRef: pull.url, updatedAt: Date.now() }
			state.entries[key] = entry
			await writeState(statePath, state)
			return receiptFromState(entry)
		}
		if (prior?.state === "pr-intent" || prior?.state === "pr-uncertain") {
			return await saveBlocked(state, statePath, key, identity, input.claim, "prior-draft-write-has-no-exact-readback", "pr-uncertain")
		}
		const latest = await git.inspectTarget()
		if (latest.baseRevision !== target.baseRevision || latest.private !== true || latest.repository !== CURL_REPAIR_TARGET_REPOSITORY || latest.branch !== DEFAULT_BRANCH) {
			return await saveBlocked(state, statePath, key, identity, input.claim, "private-target-moved-before-draft-write")
		}
		entry = { ...entry, state: "pr-intent", updatedAt: Date.now() }
		state.entries[key] = entry
		await writeState(statePath, state)
		await dependencies.store.assertClaimCurrent(input.claim)
		try { await github.createDraftPullRequest({ branch, title: repairPullRequestTitle(), body: expectedBody }) }
		catch { return await saveBlocked(state, statePath, key, identity, input.claim, "private-draft-write-needs-readback", "pr-uncertain") }
		const readback = await github.findPullRequests(branch)
		if (readback.length !== 1 || !matchesPullRequest(readback[0]!, { branch, baseRevision: target.baseRevision, body: expectedBody })) {
			return await saveBlocked(state, statePath, key, identity, input.claim, "private-draft-write-readback-mismatch", "pr-uncertain")
		}
		entry = { ...entry, state: "draft-ready", privateRef: readback[0]!.url, updatedAt: Date.now() }
		state.entries[key] = entry
		await writeState(statePath, state)
		return receiptFromState(entry)
	} finally {
		lock.close()
	}
}

function validateInput(input: CurlRepairDeliveryInput): {
	jobId: string; patchSha256: string; receiptSha256: string; identitySha256: string; key: string
} {
	const claim = input?.claim
	const candidate = input?.candidate
	const receipt = input?.receipt
	if (!claim || !candidate || !receipt || claim.claimId !== claim.claimId?.toLowerCase() || !/^[a-f0-9-]{36}$/.test(claim.claimId) ||
		!Number.isSafeInteger(claim.epoch) || claim.epoch < 1 || claim.job?.campaignId !== "curl-historical-repair" ||
		claim.job.advisoryId !== CURL_FIXED_ADVISORY || !/^[a-z0-9][a-z0-9._-]{0,95}$/.test(claim.job.id) ||
		claim.job.epoch !== claim.epoch || claim.job.status !== "running" ||
		candidate.sourceRepository !== CURL_REPAIR_TARGET_REPOSITORY || candidate.sourceRevision !== CURL_REPAIR_HISTORICAL_BASE ||
		candidate.sourceTreeSha !== "b1ea31bb7377dd2bfe08fd67af44860de57afc12" ||
		candidate.candidateRevision !== CURL_REPAIR_CANDIDATE_REVISION || candidate.candidateTreeSha !== CURL_REPAIR_CANDIDATE_TREE_SHA ||
		candidate.patchPath !== CURL_REPAIR_PATCH_PATH || candidate.patchSha256 !== CURL_REPAIR_PATCH_SHA256 ||
		!Number.isSafeInteger(candidate.patchBytes) || candidate.patchBytes < 1 || candidate.patchBytes > MAX_PATCH_BYTES ||
		typeof candidate.patchBase64 !== "string" || candidate.patchBase64.length > Math.ceil(MAX_PATCH_BYTES * 4 / 3) ||
		!isDigest(candidate.sourceEnvelopeSha256) || !isDigest(candidate.artifactManifestSha256) || !isDigest(receipt.evidenceSha256) ||
		receipt.profileId !== CURL_REPAIR_PROFILE_ID || receipt.sourceRevision !== candidate.sourceRevision ||
		receipt.sourceTreeSha !== candidate.sourceTreeSha || receipt.candidateRevision !== candidate.candidateRevision ||
		receipt.candidateTreeSha !== candidate.candidateTreeSha || receipt.patchSha256 !== candidate.patchSha256 ||
		receipt.sourceEnvelopeSha256 !== candidate.sourceEnvelopeSha256 || receipt.artifactManifestSha256 !== candidate.artifactManifestSha256 ||
		receipt.protectedProof?.evaluatorDigest !== CURL_REPAIR_PROTECTED_EVALUATOR_DIGEST) {
		throw new Error("Curl repair delivery input is outside its compiled claim, source, artifact and receipt bounds")
	}
	const patch = Buffer.from(candidate.patchBase64, "base64")
	if (patch.length !== candidate.patchBytes || patch.toString("base64") !== candidate.patchBase64) throw new Error("Curl repair source patch encoding is invalid")
	const jobId = claim.job.id
	const receiptSha256 = receipt.evidenceSha256
	const identitySha256 = sha256(canonical({ campaignId: claim.job.campaignId, jobId, advisoryId: claim.job.advisoryId,
		claimId: claim.claimId, epoch: claim.epoch, sourceRevision: candidate.sourceRevision,
		candidateRevision: candidate.candidateRevision, candidateTreeSha: candidate.candidateTreeSha,
		patchSha256: candidate.patchSha256, envelopeSha256: candidate.sourceEnvelopeSha256,
		artifactManifestSha256: candidate.artifactManifestSha256, receiptSha256 }))
	return { jobId, patchSha256: candidate.patchSha256, receiptSha256, identitySha256,
		key: sha256(`${claim.job.campaignId}:${jobId}:${claim.claimId}:${claim.epoch}:${candidate.patchSha256}`) }
}

class FixedCurlGitAdapter implements CurlRepairGitAdapter {
	private readonly checkout: string
	constructor(private readonly stateRoot: string) {
		this.checkout = path.join(stateRoot, "private-checkout")
	}
	async inspectTarget(): Promise<CurlRepairTarget> {
		const repository = await runGitHub(["repo", "view", CURL_REPAIR_TARGET_REPOSITORY, "--json", "nameWithOwner,url,isPrivate,defaultBranchRef"])
		let view: any
		try { view = JSON.parse(repository) } catch { throw new Error("private Curl destination metadata is invalid") }
		if (view?.nameWithOwner !== CURL_REPAIR_TARGET_REPOSITORY || view?.url !== REPOSITORY_URL || view?.isPrivate !== true ||
			view?.defaultBranchRef?.name !== DEFAULT_BRANCH) throw new Error("private Curl destination does not match the fixed repository identity")
		await this.ensureCheckout()
		await run("git", ["-C", this.checkout, "fetch", "--no-tags", "--no-recurse-submodules", "origin",
			`+refs/heads/${DEFAULT_BRANCH}:refs/remotes/origin/${DEFAULT_BRANCH}`])
		const baseRevision = await gitValue(this.checkout, "rev-parse", `refs/remotes/origin/${DEFAULT_BRANCH}^{commit}`)
		const treeSha = await gitValue(this.checkout, "rev-parse", `${baseRevision}^{tree}`)
		const changed = await gitValue(this.checkout, "diff", "--name-only", CURL_REPAIR_TARGET_BASE, baseRevision)
		const changedPathsFromSource = changed.split(/\r?\n/).filter(Boolean).sort()
		return { repository: CURL_REPAIR_TARGET_REPOSITORY, private: true, branch: DEFAULT_BRANCH, baseRevision, treeSha, changedPathsFromSource }
	}
	async candidateIsAncestor(candidateRevision: string, targetRevision: string): Promise<boolean> {
		if (candidateRevision !== CURL_REPAIR_CANDIDATE_REVISION || !isSha(targetRevision)) throw new Error("Curl ancestry query is outside the fixed source identity")
		await run("git", ["-C", this.checkout, "fetch", "--no-tags", "--no-recurse-submodules", TARGET_PATH, candidateRevision])
		const candidateTree = await gitValue(this.checkout, "rev-parse", `${candidateRevision}^{tree}`)
		if (candidateTree !== CURL_REPAIR_CANDIDATE_TREE_SHA) throw new Error("private source candidate tree differs from the compiled repair pin")
		const result = await runStatus("git", ["-C", this.checkout, "merge-base", "--is-ancestor", candidateRevision, targetRevision])
		if (result === 0) return true
		if (result === 1) return false
		throw new Error("private Curl candidate ancestry could not be established")
	}
	async remoteBranchRevision(branch: string): Promise<string | null> {
		validateBranch(branch)
		const result = await run("git", ["ls-remote", "--heads", GIT_URL, `refs/heads/${branch}`])
		const lines = result.split(/\r?\n/).filter(Boolean)
		if (lines.length === 0) return null
		if (lines.length !== 1) throw new Error("private Curl branch lookup is ambiguous")
		const [revision, ref] = lines[0]!.split(/\s+/, 2)
		if (!isSha(revision) || ref !== `refs/heads/${branch}`) throw new Error("private Curl branch lookup is invalid")
		return revision
	}
	async pushCandidate(branch: string, candidateRevision: string, expectedBaseRevision: string): Promise<void> {
		validateBranch(branch)
		if (candidateRevision !== CURL_REPAIR_CANDIDATE_REVISION || expectedBaseRevision !== CURL_REPAIR_HISTORICAL_BASE) {
			throw new Error("private Curl branch write is outside the fixed historical repair")
		}
		await this.ensureCheckout()
		const origin = await gitValue(this.checkout, "remote", "get-url", "origin")
		if (origin !== GIT_URL) throw new Error("private Curl checkout origin does not match its fixed destination")
		await run("git", ["-C", this.checkout, "fetch", "--no-tags", "--no-recurse-submodules", "origin",
			`+refs/heads/${DEFAULT_BRANCH}:refs/remotes/origin/${DEFAULT_BRANCH}`])
		const currentBase = await gitValue(this.checkout, "rev-parse", `refs/remotes/origin/${DEFAULT_BRANCH}^{commit}`)
		if (currentBase !== expectedBaseRevision) throw new Error("private Curl default branch moved before repair push")
		await run("git", ["-C", this.checkout, "push", "origin", `${candidateRevision}:refs/heads/${branch}`])
	}
	private async ensureCheckout(): Promise<void> {
		try {
			const info = await fsp.lstat(this.checkout)
			if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0 || (typeof process.getuid === "function" && info.uid !== process.getuid())) {
				throw new Error("private Curl checkout is not an owner-only directory")
			}
			const gitInfo = await fsp.lstat(path.join(this.checkout, ".git"))
			if (!gitInfo.isDirectory() || gitInfo.isSymbolicLink() || (typeof process.getuid === "function" && gitInfo.uid !== process.getuid())) {
				throw new Error("private Curl checkout Git metadata is invalid")
			}
			const origin = await gitValue(this.checkout, "remote", "get-url", "origin")
			if (origin !== GIT_URL) throw new Error("private Curl checkout origin is invalid")
			return
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
		}
		await fsp.mkdir(this.stateRoot, { recursive: true, mode: 0o700 })
		const temporary = path.join(this.stateRoot, `.private-checkout-${process.pid}-${randomUUID()}`)
		await run("git", ["clone", "--no-checkout", "--no-tags", "--single-branch", "--branch", DEFAULT_BRANCH, GIT_URL, temporary])
		await fsp.chmod(temporary, 0o700)
		await fsp.rename(temporary, this.checkout)
	}
}

class FixedCurlGitHubAdapter implements CurlRepairGitHubAdapter {
	async findPullRequests(branch: string): Promise<CurlRepairPullRequest[]> {
		validateBranch(branch)
		const raw = await runGitHub(["api", `repos/${CURL_REPAIR_TARGET_REPOSITORY}/pulls?state=all&head=Capsize-Games:${branch}&per_page=100`])
		let rows: any
		try { rows = JSON.parse(raw) } catch { throw new Error("private Curl pull request response is invalid") }
		if (!Array.isArray(rows) || rows.length >= 100) throw new Error("private Curl pull request response exceeds its bound")
		return rows.map((item: any) => {
			const result = { number: item?.number, url: item?.html_url, state: item?.state, draft: item?.draft,
				title: item?.title, body: item?.body, branch: item?.head?.ref, baseBranch: item?.base?.ref,
				headRepository: item?.head?.repo?.full_name, headRevision: item?.head?.sha, baseRevision: item?.base?.sha }
			if (!Number.isSafeInteger(result.number) || typeof result.url !== "string" || typeof result.state !== "string" ||
				typeof result.draft !== "boolean" || typeof result.title !== "string" || typeof result.body !== "string" ||
				typeof result.branch !== "string" || typeof result.baseBranch !== "string" || typeof result.headRepository !== "string" ||
				!isSha(result.headRevision) || !isSha(result.baseRevision)) throw new Error("private Curl pull request record is incomplete")
			return result as CurlRepairPullRequest
		})
	}
	async createDraftPullRequest(input: { branch: string; title: string; body: string }): Promise<void> {
		validateBranch(input.branch)
		if (input.title !== repairPullRequestTitle() || input.body.length > 8_000 || !input.body.startsWith("Verified historical Curl repair")) {
			throw new Error("private Curl draft content is outside the fixed repair template")
		}
		await runGitHub(["pr", "create", "--draft", "--repo", CURL_REPAIR_TARGET_REPOSITORY, "--base", DEFAULT_BRANCH,
			"--head", `${CURL_REPAIR_TARGET_REPOSITORY.split("/")[0]}:${input.branch}`, "--title", input.title, "--body", input.body], 60_000)
	}
}

function matchesPullRequest(pull: CurlRepairPullRequest, expected: { branch: string; baseRevision: string; body: string }): boolean {
	return pull.state === "open" && pull.draft === true && pull.branch === expected.branch && pull.baseBranch === DEFAULT_BRANCH &&
		pull.headRepository === CURL_REPAIR_TARGET_REPOSITORY && pull.headRevision === CURL_REPAIR_CANDIDATE_REVISION &&
		pull.baseRevision === expected.baseRevision && pull.title === repairPullRequestTitle() && pull.body === expected.body &&
		pull.url === `${REPOSITORY_URL}/pull/${pull.number}` && Number.isSafeInteger(pull.number) && pull.number > 0
}

function repairPullRequestTitle(): string { return `[Draft] ${CURL_FIXED_ADVISORY} Curl historical repair review` }

function repairPullRequestBody(identity: { receiptSha256: string; patchSha256: string; identitySha256: string }): string {
	return [
		"Verified historical Curl repair",
		"",
		`Advisory: ${CURL_FIXED_ADVISORY}`,
		`Source: ${CURL_REPAIR_HISTORICAL_BASE}`,
		`Candidate: ${CURL_REPAIR_CANDIDATE_REVISION} (tree ${CURL_REPAIR_CANDIDATE_TREE_SHA})`,
		`Patch SHA-256: ${identity.patchSha256}`,
		`Protected receipt SHA-256: ${identity.receiptSha256}`,
		`Delivery identity SHA-256: ${identity.identitySha256}`,
		"Scope: historical public regression evidence only; current host applicability was not assessed.",
		"Draft for private review. This workflow does not merge, install, or publish to an upstream repository.",
		"",
	].join("\n")
}

async function saveBlocked(state: DeliveryState, statePath: string, key: string,
	identity: { identitySha256: string; receiptSha256: string }, claim: CurlRepairClaim, reasonCode: string,
	stateName: DeliveryState["entries"][string]["state"] = "blocked"): Promise<CurlRepairDeliveryReceipt> {
	const entry = { ...makeEntry(identity, claim, stateName, null), reasonCode }
	state.entries[key] = entry
	await writeState(statePath, state)
	return { ...receiptFromState(entry), reasonCode }
}

function makeEntry(identity: { identitySha256: string; receiptSha256: string }, claim: CurlRepairClaim,
	state: DeliveryState["entries"][string]["state"], privateRef: string | null, branch?: string) {
	return { identitySha256: identity.identitySha256, claimId: claim.claimId, epoch: claim.epoch, jobId: claim.job.id,
		branch: branch ?? BRANCH_PREFIX + CURL_REPAIR_PATCH_SHA256.slice(0, 16), candidateRevision: CURL_REPAIR_CANDIDATE_REVISION,
		receiptSha256: identity.receiptSha256, state, reasonCode: state, privateRef, updatedAt: Date.now() }
}

function receiptFromState(entry: DeliveryState["entries"][string]): CurlRepairDeliveryReceipt {
	const accepted = entry.state === "already-fixed" || entry.state === "draft-ready"
	const record = { schemaVersion: 1, identitySha256: entry.identitySha256, claimId: entry.claimId, epoch: entry.epoch,
		jobId: entry.jobId, candidateRevision: entry.candidateRevision, receiptSha256: entry.receiptSha256,
		disposition: (entry.state === "already-fixed" ? "already-fixed" : accepted ? "draft-ready" : "blocked") as CurlRepairDeliveryReceipt["disposition"],
		reasonCode: entry.reasonCode, privateRef: entry.privateRef, updatedAt: entry.updatedAt }
	return { accepted, disposition: record.disposition, evidenceSha256: sha256(canonical(record)), privateRef: entry.privateRef,
		reasonCode: accepted ? "verified-private-delivery-recorded" : entry.reasonCode }
}

async function ensurePrivateDirectory(directory: string): Promise<void> {
	await fsp.mkdir(directory, { recursive: true, mode: 0o700 })
	const stat = await fsp.lstat(directory)
	if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 ||
		(typeof process.getuid === "function" && stat.uid !== process.getuid()) || await fsp.realpath(directory) !== directory) {
		throw new Error("Curl delivery state directory must be an owner-only real directory")
	}
}

async function acquireLock(lockPath: string): Promise<{ close(): void }> {
	const fd = fs.openSync(lockPath, fs.constants.O_CREAT | fs.constants.O_RDWR | fs.constants.O_NOFOLLOW, 0o600)
	try {
		const stat = fs.fstatSync(fd)
		if (!stat.isFile() || (stat.mode & 0o077) !== 0 || (typeof process.getuid === "function" && stat.uid !== process.getuid())) {
			throw new Error("Curl delivery lock is not a private owner file")
		}
		const result = spawnSync("/usr/bin/flock", ["-n", "-x", "3"], {
			encoding: "utf8", timeout: 5_000, maxBuffer: 16 * 1024, stdio: ["ignore", "ignore", "ignore", fd],
			env: { PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin", HOME: os.homedir() },
		})
		if (result.error || result.status !== 0) throw new Error("Curl private delivery is already being reconciled")
		return { close: () => fs.closeSync(fd) }
	} catch (error) {
		fs.closeSync(fd)
		throw error
	}
}

async function readState(file: string): Promise<DeliveryState> {
	try {
		const stat = await fsp.lstat(file)
		if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_STATE_BYTES || (stat.mode & 0o077) !== 0 ||
			(typeof process.getuid === "function" && stat.uid !== process.getuid())) throw new Error("Curl delivery state file is not private or bounded")
		const parsed: unknown = JSON.parse(await fsp.readFile(file, "utf8"))
		if (!isDeliveryState(parsed)) throw new Error("Curl delivery state file has an invalid schema")
		return parsed
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { schemaVersion: STATE_SCHEMA, entries: {} }
		throw error
	}
}

async function writeState(file: string, state: DeliveryState): Promise<void> {
	const bytes = Buffer.from(canonical(state))
	if (bytes.length > MAX_STATE_BYTES) throw new Error("Curl delivery state exceeds its bound")
	const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`
	const handle = await fsp.open(temporary, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW, 0o600)
	try { await handle.writeFile(bytes); await handle.sync() } finally { await handle.close() }
	await fsp.rename(temporary, file)
	const directory = await fsp.open(path.dirname(file), fs.constants.O_RDONLY)
	try { await directory.sync() } finally { await directory.close() }
}

function isDeliveryState(value: unknown): value is DeliveryState {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false
	const state = value as Record<string, unknown>
	if (state.schemaVersion !== STATE_SCHEMA || !state.entries || typeof state.entries !== "object" || Array.isArray(state.entries)) return false
	for (const [key, row] of Object.entries(state.entries as Record<string, unknown>)) {
		if (!isDigest(key) || !row || typeof row !== "object" || Array.isArray(row)) return false
		const item = row as Record<string, unknown>
		if (Object.keys(item).sort().join(",") !== "branch,candidateRevision,claimId,epoch,identitySha256,jobId,privateRef,reasonCode,receiptSha256,state,updatedAt" ||
			!isDigest(item.identitySha256) || !isDigest(item.receiptSha256) || typeof item.claimId !== "string" || !/^[a-f0-9-]{36}$/.test(item.claimId) ||
			!Number.isSafeInteger(item.epoch) || Number(item.epoch) < 1 || typeof item.jobId !== "string" || !/^[a-z0-9][a-z0-9._-]{0,95}$/.test(item.jobId) ||
			item.candidateRevision !== CURL_REPAIR_CANDIDATE_REVISION || typeof item.branch !== "string" || !validBranch(item.branch) ||
			typeof item.reasonCode !== "string" || !/^[a-z0-9-]{1,96}$/.test(item.reasonCode) ||
			!(item.privateRef === null || (typeof item.privateRef === "string" && item.privateRef.length <= 256)) ||
			!(["already-fixed", "push-intent", "branch-uncertain", "branch-pushed", "pr-intent", "pr-uncertain", "draft-ready", "blocked"] as unknown[]).includes(item.state) ||
			!Number.isSafeInteger(item.updatedAt) || Number(item.updatedAt) < 0) return false
	}
	return true
}

function validateBranch(branch: string): void { if (!validBranch(branch)) throw new Error("Curl repair branch is outside its fixed identity") }
function validBranch(branch: string): boolean { return new RegExp(`^${BRANCH_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[a-f0-9]{16}$`).test(branch) }
function isSha(value: unknown): value is string { return typeof value === "string" && /^[a-f0-9]{40}$/.test(value) }
function isDigest(value: unknown): value is string { return typeof value === "string" && /^[a-f0-9]{64}$/.test(value) }
function sha256(value: Uint8Array | string): string { return createHash("sha256").update(value).digest("hex") }

function canonical(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value)
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`
	return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))
		.map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`
}

async function gitValue(root: string, ...args: string[]): Promise<string> { return (await run("git", ["-C", root, ...args])).trim() }

/** Fixed host-side gh calls use the owner's validated keyring bus, never inherited token or bus variables. */
export function fixedCurlDeliveryGitHubEnvironment(source: NodeJS.ProcessEnv = process.env,
	): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = { PATH: "/usr/local/bin:/usr/bin:/bin", HOME: os.homedir() }
	const uid = typeof process.getuid === "function" ? process.getuid() : -1
	const session = uid >= 0 ? resolveOwnerSessionBus(uid) : null
	if (session) {
		env.DBUS_SESSION_BUS_ADDRESS = session.address
		env.XDG_RUNTIME_DIR = session.runtimeDir
	}
	// Read source to make explicit that credential/bus values are not inherited.
	void source
	return env
}

function resolveOwnerSessionBus(uid: number): { address: string; runtimeDir: string } | null {
	try {
		const runtimeDir = `/run/user/${uid}`
		if (!isPrivateOwnerDirectory(runtimeDir, uid)) return null
		const tmpStat = fs.statSync("/tmp")
		if (!tmpStat.isDirectory() || tmpStat.uid !== 0 || (tmpStat.mode & 0o1000) === 0) return null
		const sessions: Array<{ pid: number; address: string }> = []
		for (const entry of fs.readdirSync("/proc")) {
			if (!/^[1-9][0-9]{0,8}$/.test(entry)) continue
			const pid = Number(entry)
			const proc = `/proc/${entry}`
			try {
				if (fs.statSync(proc).uid !== uid || fs.readFileSync(`${proc}/comm`, "utf8").trim() !== "xfce4-session" ||
					fs.realpathSync(`${proc}/exe`) !== "/usr/bin/xfce4-session") continue
				const variables = readProcEnvironment(proc)
				if (variables.XDG_RUNTIME_DIR !== runtimeDir || !isOwnerDbusProcess(pid, uid, variables.DBUS_SESSION_BUS_ADDRESS)) continue
				const match = variables.DBUS_SESSION_BUS_ADDRESS?.match(/^unix:path=(\/tmp\/dbus-[A-Za-z0-9]{1,64}),guid=([a-f0-9]{32})$/)
				if (!match) continue
				const socketStat = fs.lstatSync(match[1]!)
				if (!socketStat.isSocket() || socketStat.uid !== uid) continue
				process.kill(pid, 0)
				sessions.push({ pid, address: variables.DBUS_SESSION_BUS_ADDRESS! })
			} catch { /* stale or unverifiable process entries are ignored */ }
		}
		return sessions.length === 1 ? { address: sessions[0]!.address, runtimeDir } : null
	} catch {
		return null
	}
}

function readProcEnvironment(proc: string): Record<string, string> {
	const env: Record<string, string> = {}
	for (const item of fs.readFileSync(`${proc}/environ`).toString("utf8").split("\0")) {
		const equals = item.indexOf("=")
		if (equals < 0) continue
		const name = item.slice(0, equals)
		if (name === "DBUS_SESSION_BUS_ADDRESS" || name === "XDG_RUNTIME_DIR") env[name] = item.slice(equals + 1)
	}
	return env
}

function isPrivateOwnerDirectory(directory: string, uid: number): boolean {
	const info = fs.lstatSync(directory)
	return info.isDirectory() && !info.isSymbolicLink() && info.uid === uid && (info.mode & 0o077) === 0 &&
		fs.realpathSync(directory) === directory
}

function isOwnerDirectory(directory: string, uid: number): boolean {
	const info = fs.lstatSync(directory)
	return info.isDirectory() && !info.isSymbolicLink() && info.uid === uid && fs.realpathSync(directory) === directory
}

function isOwnerDbusProcess(sessionPid: number, uid: number, address?: string): boolean {
	if (!address) return false
	for (const entry of fs.readdirSync("/proc")) {
		if (!/^[1-9][0-9]{0,8}$/.test(entry) || Number(entry) === sessionPid) continue
		const proc = `/proc/${entry}`
		try {
			if (fs.statSync(proc).uid === uid && ["dbus-daemon", "dbus-broker"].includes(fs.readFileSync(`${proc}/comm`, "utf8").trim()) &&
				readProcEnvironment(proc).DBUS_SESSION_BUS_ADDRESS === address) {
				process.kill(Number(entry), 0)
				return true
			}
		} catch { /* stale or unverifiable process entries are ignored */ }
	}
	return false
}

async function runGitHub(args: string[], timeoutMs = 30_000): Promise<string> {
	try {
		const { stdout } = await execFileAsync(GITHUB_CLI, args, { timeout: timeoutMs, maxBuffer: 256 * 1024,
			encoding: "utf8", env: fixedCurlDeliveryGitHubEnvironment() })
		return stdout
	} catch {
		throw new Error("fixed Curl delivery command failed")
	}
}

async function run(command: string, args: string[], timeoutMs = 30_000): Promise<string> {
	try {
		const { stdout } = await execFileAsync(command, args, { timeout: timeoutMs, maxBuffer: 256 * 1024, encoding: "utf8",
			env: { PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin", HOME: os.homedir() } })
		return stdout
	} catch {
		throw new Error("fixed Curl delivery command failed")
	}
}

async function runStatus(command: string, args: string[], timeoutMs = 30_000): Promise<number> {
	try {
		await execFileAsync(command, args, { timeout: timeoutMs, maxBuffer: 256 * 1024, encoding: "utf8",
			env: { PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin", HOME: os.homedir() } } as any)
		return 0
	} catch (error) {
		const code = (error as NodeJS.ErrnoException & { code?: number }).code
		if (typeof code === "number") return code
		throw new Error("fixed Curl delivery command was unavailable")
	}
}
