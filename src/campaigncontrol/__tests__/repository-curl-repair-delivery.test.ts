import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import * as os from "node:os"
import * as path from "node:path"
import {
	CURL_REPAIR_DELIVERY_POLICY, CURL_REPAIR_DELIVERY_POLICY_SHA256,
	fixedCurlDeliveryGitHubEnvironment,
	deliverVerifiedCurlRepairDraft,
	type CurlRepairClaim, type CurlRepairDeliveryDependencies, type CurlRepairGitAdapter,
	type CurlRepairGitHubAdapter, type CurlRepairPullRequest, type CurlRepairTarget,
} from "../repository-curl-repair-delivery.js"
import { CURL_FIXED_ADVISORY } from "../repository-curl-evaluator.js"
import {
	CURL_REPAIR_CANDIDATE_REVISION, CURL_REPAIR_CANDIDATE_TREE_SHA, CURL_REPAIR_HISTORICAL_BASE,
	CURL_REPAIR_PATCH_PATH, CURL_REPAIR_PATCH_SHA256, CURL_REPAIR_PROFILE_ID,
	CURL_REPAIR_SOURCE_REVISION, CURL_REPAIR_SOURCE_TREE_SHA,
	CURL_REPAIR_PROTECTED_ARTIFACT_MANIFEST_SHA256, CURL_REPAIR_PROTECTED_EVALUATOR_DIGEST,
	CURL_REPAIR_PROTECTED_PROOF_EVIDENCE_SHA256, CURL_REPAIR_PROTECTED_RECEIPT_SHA256,
	type CurlHistoricalRepairCandidate,
} from "../repository-curl-repair.js"
import type { CurlHistoricalRepairReceipt } from "../repository-curl-repair-evaluator.js"
import { runMain, type SuiteTest } from "../../test-runner.js"

const repo = "Capsize-Games/curl-maintenance"
const branch = "reviewed-source-ce573393"
const jobId = "repair-delivery-fixture"
const claim: CurlRepairClaim = { claimId: "11111111-1111-4111-8111-111111111111", epoch: 4,
	job: { id: jobId, campaignId: "curl-historical-repair", advisoryId: CURL_FIXED_ADVISORY, status: "running", epoch: 4,
		createdAt: 1, updatedAt: 1, month: "2026-10", reservedMicros: 1, settledMicros: 0, reservedTokens: 1, settledTokens: 0 } }

function digest(input: string): string { return createHash("sha256").update(input).digest("hex") }
function canonical(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value)
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`
	return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))
		.map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`
}

function makeCandidate(): CurlHistoricalRepairCandidate {
	return { schemaVersion: 1, advisoryId: CURL_FIXED_ADVISORY, profileId: CURL_REPAIR_PROFILE_ID,
		sourceRepository: repo, sourceRevision: CURL_REPAIR_HISTORICAL_BASE,
		sourceTreeSha: "b1ea31bb7377dd2bfe08fd67af44860de57afc12",
		candidateRevision: CURL_REPAIR_CANDIDATE_REVISION, candidateTreeSha: CURL_REPAIR_CANDIDATE_TREE_SHA,
		patchPath: CURL_REPAIR_PATCH_PATH, patchBase64: Buffer.from("fixture-patch").toString("base64"), patchBytes: 13,
		patchSha256: CURL_REPAIR_PATCH_SHA256, sourceEnvelopeSha256: digest("envelope"), artifactManifestSha256: digest("manifest"),
		protectedProof: { profileId: "curl-92390-fixed-v1", evaluatorId: "package-regression-v1",
			evaluatorDigest: CURL_REPAIR_PROTECTED_EVALUATOR_DIGEST, evidenceSha256: CURL_REPAIR_PROTECTED_PROOF_EVIDENCE_SHA256,
			receiptSha256: CURL_REPAIR_PROTECTED_RECEIPT_SHA256, artifactManifestSha256: CURL_REPAIR_PROTECTED_ARTIFACT_MANIFEST_SHA256,
			phases: ["historical_base-red", "reference_fix-green", "fork_head-green", "candidate-green"] as const },
	}
}

function makeReceipt(candidate: CurlHistoricalRepairCandidate): CurlHistoricalRepairReceipt {
	const base: Omit<CurlHistoricalRepairReceipt, "evidenceSha256"> = {
		schemaVersion: 1, disposition: "historical-fix-qualified", proofMode: "reused-signed-offline-phase-evidence",
		scope: "historical-public-regression-only", advisoryId: CURL_FIXED_ADVISORY, profileId: CURL_REPAIR_PROFILE_ID,
		sourceRevision: candidate.sourceRevision, sourceTreeSha: candidate.sourceTreeSha,
		candidateRevision: candidate.candidateRevision, candidateTreeSha: candidate.candidateTreeSha,
		patchSha256: candidate.patchSha256, sourceEnvelopeSha256: candidate.sourceEnvelopeSha256,
		artifactManifestSha256: candidate.artifactManifestSha256,
		protectedProof: { profileId: "curl-92390-fixed-v1", evaluatorDigest: CURL_REPAIR_PROTECTED_EVALUATOR_DIGEST,
			evidenceSha256: CURL_REPAIR_PROTECTED_PROOF_EVIDENCE_SHA256, receiptSha256: CURL_REPAIR_PROTECTED_RECEIPT_SHA256,
			artifactManifestSha256: CURL_REPAIR_PROTECTED_ARTIFACT_MANIFEST_SHA256, evaluatorEvidenceSha256: digest("protected-evidence") },
	}
	return { ...base, evidenceSha256: digest(canonical(base)) }
}

function fixture(targetBase: string, alreadyFixed: boolean): {
	dependencies: CurlRepairDeliveryDependencies; calls: string[]; created: { branch: string; title: string; body: string }[]
} {
	const root = path.join(os.tmpdir(), `curl-repair-delivery-${process.pid}-${Math.random().toString(16).slice(2)}`)
	const calls: string[] = []
	const created: { branch: string; title: string; body: string }[] = []
	let pushed = false
	const treeSha = targetBase === CURL_REPAIR_HISTORICAL_BASE ? "b1ea31bb7377dd2bfe08fd67af44860de57afc12" :
		targetBase === CURL_REPAIR_SOURCE_REVISION ? CURL_REPAIR_SOURCE_TREE_SHA : "e1a2673971d538f348ea5e5af80e0a8b62428ecf"
	const changedPathsFromSource = targetBase === "12a286c3ddb18aa5124775f0084b40f94accaceb" ? ["AGENTS.md", "CAPSIZE_SOURCE_ADOPTION.md"] : []
	const target: CurlRepairTarget = { repository: repo, private: true, branch, baseRevision: targetBase, treeSha, changedPathsFromSource }
	const git: CurlRepairGitAdapter = {
		async inspectTarget() { calls.push("inspect-target"); return target },
		async candidateIsAncestor(candidate, base) { calls.push("ancestry"); assert.equal(candidate, CURL_REPAIR_CANDIDATE_REVISION); assert.equal(base, targetBase); return alreadyFixed },
		async remoteBranchRevision(value) { calls.push("read-branch"); assert.match(value, /^codex\/curl-CVE-2026-92390-[a-f0-9]{16}$/); return pushed ? CURL_REPAIR_CANDIDATE_REVISION : null },
		async pushCandidate(value, candidate, base) { calls.push("push"); assert.match(value, /^codex\/curl-CVE-2026-92390-[a-f0-9]{16}$/); assert.equal(candidate, CURL_REPAIR_CANDIDATE_REVISION); assert.equal(base, CURL_REPAIR_HISTORICAL_BASE); pushed = true },
	}
	let persistedPull: CurlRepairPullRequest | undefined
	const github: CurlRepairGitHubAdapter = {
		async findPullRequests(value) { calls.push("find-pull"); assert.match(value, /^codex\/curl-CVE-2026-92390-[a-f0-9]{16}$/); return persistedPull ? [persistedPull] : [] },
		async createDraftPullRequest(input) {
			calls.push("create-pull")
			created.push(input)
			persistedPull = { number: 9, url: `https://github.com/${repo}/pull/9`, state: "open", draft: true,
				title: input.title, body: input.body, branch: input.branch, baseBranch: branch, headRepository: repo,
				headRevision: CURL_REPAIR_CANDIDATE_REVISION, baseRevision: targetBase }
		},
	}
	const candidate = makeCandidate()
	const receipt = makeReceipt(candidate)
	const dependencies: CurlRepairDeliveryDependencies = {
		store: { path: path.join(root, "store.json"), async assertClaimCurrent(current) { calls.push("fence"); assert.equal(current.claimId, claim.claimId) } },
		stateRoot: root, git, github, evaluate: async ({ candidate: value, jobId: valueJob }) => { calls.push("verify-receipt"); assert.equal(valueJob, jobId); return makeReceipt(value) },
	}
	return { dependencies, calls, created }
}

async function testPolicyIsFixedAndRepairClaimsAreDistinct(): Promise<void> {
	assert.equal(CURL_REPAIR_DELIVERY_POLICY.campaignId, "curl-historical-repair")
	assert.equal(CURL_REPAIR_DELIVERY_POLICY.targetRepository, repo)
	assert.equal(CURL_REPAIR_DELIVERY_POLICY.targetBranch, branch)
	assert.equal(CURL_REPAIR_DELIVERY_POLICY_SHA256.length, 64)
	const candidate = makeCandidate()
	const f = fixture("b31c35238d5488fa00185c319f7059938cb474d5", false)
	const badClaim = { ...claim, job: { ...claim.job, campaignId: "curl-maintenance" } }
	await assert.rejects(deliverVerifiedCurlRepairDraft({ claim: badClaim, candidate, receipt: makeReceipt(candidate) }, f.dependencies), /compiled claim/)
	assert.equal(f.calls.length, 0)
}

async function testFixedGitHubEnvironmentUsesKeyringContextWithoutCredentialEnv(): Promise<void> {
	const env = fixedCurlDeliveryGitHubEnvironment({
		PATH: "/untrusted/bin", HOME: "/untrusted/home",
		DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus",
		XDG_RUNTIME_DIR: "/run/user/1000",
		GH_TOKEN: "fake-credential-must-not-be-forwarded",
		GITHUB_TOKEN: "fake-compat-credential-must-not-be-forwarded",
		SSH_AUTH_SOCK: "/tmp/unrelated-agent.sock",
		AWS_ACCESS_KEY_ID: "unrelated-secret",
	})
	assert.deepEqual(env, {
		PATH: "/usr/local/bin:/usr/bin:/bin", HOME: os.homedir(),
		DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus",
		XDG_RUNTIME_DIR: "/run/user/1000",
	})
	for (const secretName of ["GH_TOKEN", "GITHUB_TOKEN", "SSH_AUTH_SOCK", "AWS_ACCESS_KEY_ID"]) {
		assert.equal(Object.hasOwn(env, secretName), false, `${secretName} must not enter fixed gh subprocess environment`)
	}
}

async function testCandidateAlreadyInPrivateBaseNeverCreatesBranchOrPullRequest(): Promise<void> {
	const candidate = makeCandidate()
	const f = fixture("12a286c3ddb18aa5124775f0084b40f94accaceb", true)
	const result = await deliverVerifiedCurlRepairDraft({ claim, candidate, receipt: makeReceipt(candidate) }, f.dependencies)
	assert.equal(result.accepted, true)
	assert.equal(result.disposition, "already-fixed")
	assert.equal(result.privateRef, `https://github.com/${repo}/tree/${branch}`)
	assert.equal(f.calls.includes("push"), false)
	assert.equal(f.calls.includes("find-pull"), false)
	assert.equal(f.calls.includes("create-pull"), false)
}

async function testUnknownTargetTreeOrExtraSourceChangesAreBlocked(): Promise<void> {
	const candidate = makeCandidate()
	const f = fixture("12a286c3ddb18aa5124775f0084b40f94accaceb", true)
	const git = f.dependencies.git!
	const mismatched: CurlRepairGitAdapter = { ...git,
		async inspectTarget() { return { repository: repo, private: true, branch, baseRevision: "12a286c3ddb18aa5124775f0084b40f94accaceb",
			treeSha: "f".repeat(40), changedPathsFromSource: ["AGENTS.md", "CAPSIZE_SOURCE_ADOPTION.md", "src/tool_cb_hdr.c"] } },
	}
	const result = await deliverVerifiedCurlRepairDraft({ claim, candidate, receipt: makeReceipt(candidate) }, { ...f.dependencies, git: mismatched })
	assert.equal(result.accepted, false)
	assert.equal(result.reasonCode, "private-target-source-tree-is-not-an-approved-pin")
	assert.equal(f.calls.includes("push"), false)
	assert.equal(f.calls.includes("create-pull"), false)
}

async function testOnlyExactVerifiedPatchCanCreateAndReadBackPrivateDraft(): Promise<void> {
	const candidate = makeCandidate()
	const f = fixture(CURL_REPAIR_HISTORICAL_BASE, false)
	const result = await deliverVerifiedCurlRepairDraft({ claim, candidate, receipt: makeReceipt(candidate) }, f.dependencies)
	assert.equal(result.accepted, true)
	assert.equal(result.disposition, "draft-ready")
	assert.equal(result.privateRef, `https://github.com/${repo}/pull/9`)
	assert.equal(f.created.length, 1)
	assert.ok(f.calls.indexOf("fence") < f.calls.indexOf("push"))
	assert.ok(f.calls.indexOf("push") < f.calls.indexOf("create-pull"))
	assert.match(f.created[0]!.body, /historical public regression evidence only/)
}

async function testLostDraftAcknowledgementReconcilesWithoutDuplicateCreate(): Promise<void> {
	const candidate = makeCandidate()
	const f = fixture(CURL_REPAIR_HISTORICAL_BASE, false)
	const github = f.dependencies.github!
	let calls = 0
	const wrap: CurlRepairGitHubAdapter = {
		findPullRequests: (value) => github.findPullRequests(value),
		async createDraftPullRequest(input) { calls++; await github.createDraftPullRequest(input); throw new Error("ack lost") },
	}
	const dependencies = { ...f.dependencies, github: wrap }
	const first = await deliverVerifiedCurlRepairDraft({ claim, candidate, receipt: makeReceipt(candidate) }, dependencies)
	assert.equal(first.accepted, false)
	assert.equal(first.disposition, "blocked")
	const second = await deliverVerifiedCurlRepairDraft({ claim, candidate, receipt: makeReceipt(candidate) }, dependencies)
	assert.equal(second.accepted, true)
	assert.equal(second.disposition, "draft-ready")
	assert.equal(calls, 1)
}

async function testLostBranchAcknowledgementUsesExactRefReadback(): Promise<void> {
	const candidate = makeCandidate()
	const f = fixture(CURL_REPAIR_HISTORICAL_BASE, false)
	const git = f.dependencies.git!
	let writes = 0
	const wrappingGit: CurlRepairGitAdapter = {
		inspectTarget: () => git.inspectTarget(), candidateIsAncestor: (candidateSha, base) => git.candidateIsAncestor(candidateSha, base),
		remoteBranchRevision: (value) => git.remoteBranchRevision(value),
		async pushCandidate(value, candidateSha, base) { writes++; await git.pushCandidate(value, candidateSha, base); throw new Error("push ack lost") },
	}
	const result = await deliverVerifiedCurlRepairDraft({ claim, candidate, receipt: makeReceipt(candidate) }, { ...f.dependencies, git: wrappingGit })
	assert.equal(result.accepted, true)
	assert.equal(result.disposition, "draft-ready")
	assert.equal(writes, 1)
	assert.equal(f.calls.filter((call) => call === "create-pull").length, 1)
}

async function testReceiptMismatchAndStaleClaimStopBeforeRemoteEffects(): Promise<void> {
	const candidate = makeCandidate()
	const f = fixture(CURL_REPAIR_HISTORICAL_BASE, false)
	const badReceipt = { ...makeReceipt(candidate), evidenceSha256: "f".repeat(64) }
	await assert.rejects(deliverVerifiedCurlRepairDraft({ claim, candidate, receipt: badReceipt }, f.dependencies), /protected Curl repair receipt/)
	assert.equal(f.calls.includes("inspect-target"), false)
	const stale = { ...f.dependencies, store: { ...f.dependencies.store, async assertClaimCurrent() { throw new Error("claim stale") } } }
	await assert.rejects(deliverVerifiedCurlRepairDraft({ claim, candidate, receipt: makeReceipt(candidate) }, stale), /claim stale/)
	assert.equal(f.calls.includes("push"), false)
}

async function testSharedDescriptorLockRejectsConcurrentDelivery(): Promise<void> {
	const candidate = makeCandidate()
	const f = fixture("12a286c3ddb18aa5124775f0084b40f94accaceb", true)
	let enteredResolve!: () => void
	let releaseResolve!: () => void
	const entered = new Promise<void>((resolve) => { enteredResolve = resolve })
	const blocked = new Promise<void>((resolve) => { releaseResolve = resolve })
	const git: CurlRepairGitAdapter = {
		async inspectTarget() { enteredResolve(); await blocked; return { repository: repo, private: true, branch,
			baseRevision: "12a286c3ddb18aa5124775f0084b40f94accaceb", treeSha: "e1a2673971d538f348ea5e5af80e0a8b62428ecf",
			changedPathsFromSource: ["AGENTS.md", "CAPSIZE_SOURCE_ADOPTION.md"] } },
		async candidateIsAncestor() { return true }, async remoteBranchRevision() { return null }, async pushCandidate() { throw new Error("must not push") },
	}
	const dependencies = { ...f.dependencies, git }
	const request = { claim, candidate, receipt: makeReceipt(candidate) }
	const first = deliverVerifiedCurlRepairDraft(request, dependencies)
	await entered
	await assert.rejects(deliverVerifiedCurlRepairDraft(request, dependencies), /already being reconciled/)
	releaseResolve()
	assert.equal((await first).disposition, "already-fixed")
}

const tests: readonly SuiteTest[] = [
	["fixed GitHub delivery uses desktop keyring context without forwarding fake credentials", testFixedGitHubEnvironmentUsesKeyringContextWithoutCredentialEnv],
	["repair delivery policy is fixed and separate from the qualification claim", testPolicyIsFixedAndRepairClaimsAreDistinct],
	["candidate already in the private target never creates a branch or pull request", testCandidateAlreadyInPrivateBaseNeverCreatesBranchOrPullRequest],
	["unknown target trees and changed source paths fail closed", testUnknownTargetTreeOrExtraSourceChangesAreBlocked],
	["verified historical patch creates only an exact private draft on the vulnerable pinned base", testOnlyExactVerifiedPatchCanCreateAndReadBackPrivateDraft],
	["lost draft acknowledgement is reconciled before any retry", testLostDraftAcknowledgementReconcilesWithoutDuplicateCreate],
	["lost private branch acknowledgement is resolved by the exact remote ref", testLostBranchAcknowledgementUsesExactRefReadback],
	["receipt mismatch and stale claim stop before remote effects", testReceiptMismatchAndStaleClaimStopBeforeRemoteEffects],
	["shared descriptor lock excludes concurrent private delivery reconciliation", testSharedDescriptorLockRejectsConcurrentDelivery],
]

await runMain("repository-curl-repair-delivery", tests)
