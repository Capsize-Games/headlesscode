import { createHash, randomUUID } from "node:crypto"
import { spawnSync } from "node:child_process"
import * as fs from "node:fs/promises"
import * as fsSync from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import type { CampaignControlStore } from "./store.js"
import { RepositoryCampaignStore, type ClaimedRepositoryJob, type RepositoryCampaignDefinition, type RepositoryCampaignJob } from "./repository-campaigns.js"
import { CURL_PRIVATE_SOURCE_ROOT } from "./repository-curl-runtime.js"
import { CAMPAIGN_CONTROL_FILE } from "./paths.js"
import { withCampaignDispatchFence } from "./repository-run-lease.js"
import type { FleetRepositoryBudgetLedger, FleetRepositoryBudgetScope, FleetRepositoryNoCallProof } from "../rsi/fleet-repository-budget-ledger.js"

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const ID = /^[a-z0-9][a-z0-9._-]{0,95}$/
const HEX = /^[a-f0-9]{64}$/
const DOCKER_SOCKET = "unix:///var/run/docker.sock"

export interface RepositoryNoCallRecoveryDependencies {
	store: RepositoryCampaignStore
	controlStore: CampaignControlStore
	ledger: FleetRepositoryBudgetLedger
	definition: RepositoryCampaignDefinition
	scope: FleetRepositoryBudgetScope
	expectedKeyIdentity: string
	storePath: string
	listRunningSandboxes?: () => string[]
	worktreeRoot?: string
	clock?: () => number
	withDispatchFence?: <T>(operation: () => Promise<T>) => Promise<T>
}

/** Explicit, owner-only recovery. It settles a proven pre-send failure and never queues a retry. */
export async function recoverAmbiguousPrepareWithNoCallProof(jobId: string, confirmation: string,
	dependencies: RepositoryNoCallRecoveryDependencies): Promise<{ jobId: string; status: "failed"; settledMicros: 0; settledTokens: 0; proofSha256: string }> {
	if (!UUID.test(jobId) || confirmation !== `CONFIRM RECOVER NO-CALL ${jobId}`) throw new Error("explicit no-call recovery confirmation is required")
	const { definition, scope } = dependencies
	if (definition.id !== "curl-maintenance" || definition.repository !== scope.repository ||
		definition.repositoryId !== scope.repositoryId || definition.sourceRevision !== scope.sourceRevision ||
		definition.policySha256 !== scope.policySha256 || scope.repositoryCampaignId !== definition.id ||
		scope.model !== definition.model || scope.profileId !== "muse-spark-contributor") {
		throw new Error("no-call recovery is outside the fixed Curl qualification scope")
	}
	const now = dependencies.clock?.() ?? Date.now()
	const initialControl = await dependencies.controlStore.snapshot(new Date(now))
	if (initialControl.activeRun !== null) throw new Error("no-call recovery requires no active global run")
	const view = await dependencies.store.recoveryView(jobId, new Date(now))
	const target = view.job
	if (view.activeJobs.length || !isRecoverableTarget(target, definition, now)) {
		throw new Error("no-call recovery requires one expired ambiguous prepare attempt and no active worker")
	}
	assertNoActiveCurlWorktrees(dependencies.worktreeRoot ?? path.join(CURL_PRIVATE_SOURCE_ROOT, ".worktrees"))
	const listSandboxes = dependencies.listRunningSandboxes ?? listRunningOpenShellSandboxes
	if (listSandboxes().length) throw new Error("no-call recovery requires no running OpenShell sandbox")
	const proof = await dependencies.ledger.proveNoCall(jobId, scope.repositoryEpoch)
	assertProofMatches(proof, jobId, scope, dependencies.expectedKeyIdentity)
	if (!proof.proved) throw new Error("Fleet records provider activity for this job; ambiguous usage remains held")
	const withFence = dependencies.withDispatchFence ?? ((operation) => withCampaignDispatchFence(CAMPAIGN_CONTROL_FILE, operation))
	return await withFence(async () => {
		const latestControl = await dependencies.controlStore.snapshot(new Date())
		const latestJobs = await dependencies.store.recoveryView(jobId)
		if (latestControl.activeRun !== null || latestJobs.activeJobs.length || !isRecoverableTarget(latestJobs.job, definition, Date.now())) {
			throw new Error("no-call recovery preconditions changed before settlement")
		}
		assertNoActiveCurlWorktrees(dependencies.worktreeRoot ?? path.join(CURL_PRIVATE_SOURCE_ROOT, ".worktrees"))
		if (listSandboxes().length) throw new Error("no-call recovery requires no running OpenShell sandbox")
		assertProofMatches(proof, jobId, scope, dependencies.expectedKeyIdentity)
		if (!proof.proved) throw new Error("Fleet records provider activity for this job; ambiguous usage remains held")
		const claim = { claimId: target.claimId!, epoch: target.epoch, job: target } as ClaimedRepositoryJob
		const proofSha256 = await persistProof(dependencies.storePath, claim, proof)
		await dependencies.store.settleRecoveredClaim(claim, { status: "failed", actualMicros: 0, actualTokens: 0, proofSha256 }, new Date())
		return { jobId, status: "failed", settledMicros: 0, settledTokens: 0, proofSha256 }
	})
}

/** Verify the immutable no-call artifact before creating an explicit retry child. */
export async function verifyRecoveredNoCallArtifact(job: RepositoryCampaignJob, storePath: string,
	scope: FleetRepositoryBudgetScope, keyIdentity: string): Promise<string> {
	if (job.campaignId !== "curl-maintenance" || job.advisoryId !== "CVE-2026-92390" || job.purpose !== "qualification" ||
		job.status !== "failed" || (job.retryOf !== undefined && !validRetryParent(job.retryOf)) || job.settledMicros !== 0 || job.settledTokens !== 0 ||
		job.reservedMicros !== 0 || job.reservedTokens !== 0 || !job.progress || !job.claimId || !Number.isSafeInteger(job.epoch)) {
		throw new Error("retry target is not a recovered zero-cost Curl qualification")
	}
	const refs = job.progress.evidenceRefs.filter((ref) => ref.kind === "no-call-proof")
	if (refs.length !== 1 || !HEX.test(refs[0]!.id)) throw new Error("retry target has no unique no-call proof reference")
	const digest = refs[0]!.id
	const directory = path.join(path.dirname(path.resolve(storePath)), "no-call-proofs")
	const directoryStat = await fs.lstat(directory)
	if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink() || (directoryStat.mode & 0o077) !== 0 ||
		(typeof process.getuid === "function" && directoryStat.uid !== process.getuid())) throw new Error("no-call proof directory is not owner-only")
	const filename = `${job.id}-${job.claimId}-${job.epoch}-${digest}.json`
	const target = path.join(directory, filename)
	const info = await fs.lstat(target)
	if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) !== 0 || info.nlink !== 1 || info.size > 8 * 1024 ||
		(typeof process.getuid === "function" && info.uid !== process.getuid())) throw new Error("no-call proof artifact is unavailable")
	const handle = await fs.open(target, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK)
	let bytes: Buffer
	try {
		const opened = await handle.stat()
		if (!opened.isFile() || opened.nlink !== 1 || opened.size > 8 * 1024 || (opened.mode & 0o077) !== 0 ||
			(typeof process.getuid === "function" && opened.uid !== process.getuid())) throw new Error("no-call proof artifact changed while opening")
		bytes = await handle.readFile()
	} finally { await handle.close() }
	if (bytes.byteLength > 8 * 1024) throw new Error("no-call proof artifact exceeds its bound")
	if (createHash("sha256").update(bytes).digest("hex") !== digest) throw new Error("no-call proof artifact digest does not match")
	let record: Record<string, unknown>
	try { record = JSON.parse(bytes.toString("utf8")) } catch { throw new Error("no-call proof artifact is malformed") }
	const proof = record.proof as FleetRepositoryNoCallProof | undefined
	if (Object.keys(record).sort().join(",") !== "claimId,epoch,jobId,proof,schemaVersion" || record.schemaVersion !== 1 ||
		record.claimId !== job.claimId || record.epoch !== job.epoch || record.jobId !== job.id || !proof || proof.proved !== true ||
		!isAcceptedNoCallProof(proof) || proof.jobId !== job.id || proof.campaignId !== "fleet-security-watch" ||
		proof.repositoryCampaignId !== scope.repositoryCampaignId || proof.repositoryId !== scope.repositoryId ||
		proof.repository !== scope.repository || proof.sourceRevision !== scope.sourceRevision || proof.policySha256 !== scope.policySha256 ||
		proof.model !== scope.model || proof.profileId !== scope.profileId || proof.keyIdentity !== keyIdentity ||
		!Number.isSafeInteger(proof.repositoryEpoch) || !Number.isSafeInteger(proof.asOfMs) || proof.asOfMs > Date.now() + 60_000 ||
		!proof.counts || proof.counts.calls !== 0 || proof.counts.denials !== 0) {
		throw new Error("no-call proof artifact does not match the recovered Curl attempt")
	}
	return digest
}

function validRetryParent(value: string): boolean { return UUID.test(value) }

function isRecoverableTarget(job: RepositoryCampaignJob | undefined, definition: RepositoryCampaignDefinition, now: number): job is RepositoryCampaignJob {
	return !!job && job.id !== undefined && job.campaignId === definition.id && job.advisoryId === "CVE-2026-92390" &&
		job.purpose === "qualification" && job.status === "ambiguous" && typeof job.claimId === "string" && UUID.test(job.claimId) &&
		Number.isSafeInteger(job.epoch) && job.epoch > 0 && job.progress !== undefined &&
		Number.isSafeInteger(job.progress.leaseExpiresAt) && job.progress.leaseExpiresAt <= now &&
		job.settledMicros > 0 && job.settledTokens > 0 && job.reservedMicros === 0 && job.reservedTokens === 0
}

function assertProofMatches(proof: FleetRepositoryNoCallProof, jobId: string, scope: FleetRepositoryBudgetScope, keyIdentity: string): void {
	if (proof.jobId !== jobId || proof.campaignId !== "fleet-security-watch" || proof.repositoryCampaignId !== scope.repositoryCampaignId ||
		proof.repositoryId !== scope.repositoryId || proof.repository !== scope.repository || proof.sourceRevision !== scope.sourceRevision ||
		proof.policySha256 !== scope.policySha256 || proof.repositoryEpoch !== scope.repositoryEpoch || proof.model !== scope.model ||
		proof.profileId !== scope.profileId || proof.keyIdentity !== keyIdentity ||
		!Number.isSafeInteger(proof.asOfMs) || Date.now() - proof.asOfMs > 60_000 || proof.asOfMs > Date.now() + 60_000 ||
		!proof.counts || ![proof.counts.grants, proof.counts.calls, proof.counts.denials].every((n) => Number.isSafeInteger(n) && n >= 0) ||
		!isAcceptedNoCallProof(proof)) {
		throw new Error("Fleet no-call proof does not match this exact job and repository scope")
	}
}

function isAcceptedNoCallProof(proof: FleetRepositoryNoCallProof): boolean {
	if (!proof.counts || proof.counts.calls !== 0 || proof.counts.denials !== 0) return false
	if (proof.counts.grants === 0) return proof.grant === null && proof.disposition === "no-recorded-provider-activity"
	const grant = proof.grant
	return proof.counts.grants === 1 && proof.disposition === "expired-unused-grant" && !!grant &&
		Number.isSafeInteger(grant.issuedAtMs) && grant.issuedAtMs >= 0 && grant.issuedAtMs <= proof.asOfMs &&
		Number.isSafeInteger(grant.deadlineAtMs) && grant.deadlineAtMs > grant.issuedAtMs && grant.deadlineAtMs <= proof.asOfMs &&
		Number.isSafeInteger(grant.controlEpoch) && grant.controlEpoch >= 0 && ID.test(grant.runId) && HEX.test(grant.grantSha256)
}

async function persistProof(storePath: string, claim: ClaimedRepositoryJob, proof: FleetRepositoryNoCallProof): Promise<string> {
	const parent = path.resolve(path.dirname(storePath))
	const parentStat = await fs.lstat(parent)
	if (!parentStat.isDirectory() || parentStat.isSymbolicLink() || (parentStat.mode & 0o077) !== 0 ||
		(typeof process.getuid === "function" && parentStat.uid !== process.getuid())) throw new Error("no-call proof parent is not owner-only")
	const directory = path.join(parent, "no-call-proofs")
	await fs.mkdir(directory, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => { if (error.code !== "EEXIST") throw error })
	const dir = await fs.lstat(directory)
	if (!dir.isDirectory() || dir.isSymbolicLink() || (dir.mode & 0o077) !== 0 ||
		(typeof process.getuid === "function" && dir.uid !== process.getuid())) throw new Error("no-call proof directory is not owner-only")
	const record = { schemaVersion: 1, claimId: claim.claimId, epoch: claim.epoch, jobId: claim.job.id, proof }
	const bytes = Buffer.from(`${JSON.stringify(record)}\n`)
	if (bytes.byteLength > 8 * 1024) throw new Error("no-call proof record exceeds its bound")
	const digest = createHash("sha256").update(bytes).digest("hex")
	const target = path.join(directory, `${claim.job.id}-${claim.claimId}-${claim.epoch}-${digest}.json`)
	const temporary = path.join(directory, `.${claim.job.id}.${randomUUID()}.tmp`)
	const handle = await fs.open(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600)
	try { await handle.chmod(0o600); await handle.writeFile(bytes); await handle.sync() }
	finally { await handle.close() }
	try { await fs.link(temporary, target) }
	catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
		const existing = await fs.readFile(target)
		if (createHash("sha256").update(existing).digest("hex") !== digest) throw new Error("existing no-call proof artifact conflicts")
	} finally { await fs.unlink(temporary).catch(() => undefined) }
	return digest
}

function assertNoActiveCurlWorktrees(worktreeRoot: string): void {
	try {
		const info = fsSync.lstatSync(worktreeRoot)
		if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0 ||
			(typeof process.getuid === "function" && info.uid !== process.getuid())) throw new Error("Curl worktree root is not owner-only")
		const entries = fsSync.readdirSync(worktreeRoot)
		if (entries.some((entry) => entry.startsWith("curl-campaign-"))) throw new Error("Curl campaign worktree remains; no-call recovery is blocked")
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
	}
}

function listRunningOpenShellSandboxes(): string[] {
	const result = spawnSync("docker", ["--host", DOCKER_SOCKET, "ps", "-q", "--no-trunc",
		"--filter", "label=openshell.ai/isolation-role=sandbox"], {
		encoding: "utf8", timeout: 10_000, maxBuffer: 256 * 1024,
		env: { HOME: os.homedir(), PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin" },
	})
	if (result.error || result.status !== 0) throw new Error("could not verify running OpenShell sandboxes for owner recovery")
	const ids = (result.stdout ?? "").split(/\r?\n/).filter(Boolean)
	if (ids.length > 200 || ids.some((id) => !/^[a-f0-9]{64}$/i.test(id))) throw new Error("running OpenShell sandbox list is invalid or exceeds its bound")
	return ids
}
