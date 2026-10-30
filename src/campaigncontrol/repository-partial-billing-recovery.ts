import { createHash, randomUUID } from "node:crypto"
import * as fs from "node:fs/promises"
import * as fsSync from "node:fs"
import path from "node:path"
import type { CampaignControlStore } from "./store.js"
import { RepositoryCampaignStore, type ClaimedRepositoryJob, type RepositoryCampaignDefinition, type RepositoryCampaignJob } from "./repository-campaigns.js"
import { withCampaignDispatchFence } from "./repository-run-lease.js"
import { CAMPAIGN_CONTROL_FILE } from "./paths.js"
import { CURL_PRIVATE_SOURCE_ROOT } from "./repository-curl-runtime.js"
import { FleetRepositoryBudgetLedger, type FleetRepositoryBudgetScope, type FleetRepositoryClosedSessionProof } from "../rsi/fleet-repository-budget-ledger.js"
import { spawnSync } from "node:child_process"
import * as os from "node:os"

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const DOCKER_SOCKET = "unix:///var/run/docker.sock"
export interface PartialBillingRecoveryDependencies {
	store: RepositoryCampaignStore; controlStore: CampaignControlStore; ledger: FleetRepositoryBudgetLedger
	definition: RepositoryCampaignDefinition; scope: FleetRepositoryBudgetScope; expectedKeyIdentity: string; storePath: string
	worktreeRoot?: string; listRunningSandboxes?: () => string[]; clock?: () => number
	withDispatchFence?: <T>(operation: () => Promise<T>) => Promise<T>
}

/** Reconcile only fully settled calls from an independent, closed Fleet ledger proof. */
export async function reconcileClosedCurlQualificationBilling(jobId: string, confirmation: string,
	dependencies: PartialBillingRecoveryDependencies): Promise<{ jobId: string; status: "failed"; settledMicros: number; settledTokens: number; proofSha256: string }> {
	if (!UUID.test(jobId) || confirmation !== `CONFIRM SETTLE PARTIAL QUALIFICATION ${jobId}`) throw new Error("explicit partial billing confirmation is required")
	const { definition, scope } = dependencies
	if (definition.id !== "curl-maintenance" || definition.repository !== scope.repository || definition.repositoryId !== scope.repositoryId ||
		definition.sourceRevision !== scope.sourceRevision || definition.policySha256 !== scope.policySha256 || scope.repositoryCampaignId !== definition.id ||
		scope.model !== definition.model || scope.profileId !== "muse-spark-contributor") throw new Error("billing reconciliation is outside the fixed Curl qualification scope")
	const now = dependencies.clock?.() ?? Date.now()
	const initialControl = await dependencies.controlStore.snapshot(new Date(now))
	const view = await dependencies.store.recoveryView(jobId, new Date(now))
	if (initialControl.activeRun !== null || view.activeJobs.length || !isTarget(view.job, definition, now)) throw new Error("billing reconciliation requires one expired ambiguous qualification and no active worker/run")
	assertNoActiveWorktrees(dependencies.worktreeRoot ?? path.join(CURL_PRIVATE_SOURCE_ROOT, ".worktrees"))
	const listSandboxes = dependencies.listRunningSandboxes ?? listOpenShellSandboxes
	if (listSandboxes().length) throw new Error("billing reconciliation requires no running OpenShell sandbox")
	const proof = await dependencies.ledger.proveClosedCurlQualificationSession(jobId, scope.repositoryEpoch)
	assertProof(proof, jobId, scope, dependencies.expectedKeyIdentity)
	const withFence = dependencies.withDispatchFence ?? ((operation) => withCampaignDispatchFence(CAMPAIGN_CONTROL_FILE, operation))
	return withFence(async () => {
		const control = await dependencies.controlStore.snapshot(new Date())
		const latest = await dependencies.store.recoveryView(jobId)
		if (control.activeRun !== null || latest.activeJobs.length || !isTarget(latest.job, definition, Date.now())) throw new Error("billing reconciliation preconditions changed before settlement")
		assertNoActiveWorktrees(dependencies.worktreeRoot ?? path.join(CURL_PRIVATE_SOURCE_ROOT, ".worktrees"))
		if (listSandboxes().length) throw new Error("billing reconciliation requires no running OpenShell sandbox")
		const secondProof = await dependencies.ledger.proveClosedCurlQualificationSession(jobId, scope.repositoryEpoch)
		assertProof(secondProof, jobId, scope, dependencies.expectedKeyIdentity)
		if (proof.proofSha256 !== secondProof.proofSha256) throw new Error("Fleet closed-session proof changed before settlement")
		const claim = { claimId: latest.job!.claimId!, epoch: latest.job!.epoch, job: latest.job! } as ClaimedRepositoryJob
		const artifactSha256 = await persistProof(dependencies.storePath, claim, secondProof)
		await dependencies.store.settleRecoveredClaim(claim, { status: "failed", actualMicros: secondProof.settledMicros,
			actualTokens: secondProof.settledTokens, proofSha256: artifactSha256, proofKind: "billing-proof" }, new Date())
		return { jobId, status: "failed", settledMicros: secondProof.settledMicros, settledTokens: secondProof.settledTokens, proofSha256: artifactSha256 }
	})
}

function isTarget(job: RepositoryCampaignJob | undefined, definition: RepositoryCampaignDefinition, now: number): job is RepositoryCampaignJob {
	return !!job && job.campaignId === definition.id && job.advisoryId === "CVE-2026-92390" && job.purpose === "qualification" &&
		job.status === "ambiguous" && UUID.test(job.claimId ?? "") && Number.isSafeInteger(job.epoch) && job.epoch! > 0 && !!job.progress &&
		Number.isSafeInteger(job.progress.leaseExpiresAt) && job.progress.leaseExpiresAt <= now && job.settledMicros === 8_000 &&
		job.settledTokens === 72_000 && job.reservedMicros === 0 && job.reservedTokens === 0 &&
		!job.progress.evidenceRefs.some((ref) => ref.kind === "billing-proof" || ref.kind === "no-call-proof")
}

function assertProof(proof: FleetRepositoryClosedSessionProof, jobId: string, scope: FleetRepositoryBudgetScope, keyIdentity: string): void {
	if (proof.jobId !== jobId || proof.campaignId !== "fleet-security-watch" || proof.repositoryCampaignId !== scope.repositoryCampaignId ||
		proof.repositoryId !== scope.repositoryId || proof.repository !== scope.repository || proof.sourceRevision !== scope.sourceRevision ||
		proof.policySha256 !== scope.policySha256 || proof.repositoryEpoch !== scope.repositoryEpoch || proof.model !== scope.model ||
		proof.profileId !== scope.profileId || proof.keyIdentity !== keyIdentity || proof.settledMicros !== 493 || proof.settledTokens !== 6_064 ||
		!Number.isSafeInteger(proof.asOfMs) || Date.now() - proof.asOfMs > 60_000 || proof.asOfMs > Date.now() + 60_000 ||
		!proof.grant || proof.grant.deadlineAtMs > proof.asOfMs || !Array.isArray(proof.calls) || proof.calls.length !== 2 ||
		!Array.isArray(proof.denials) || proof.denials.length !== 1 || proof.denials[0]?.statusCode !== 429 ||
		proof.denials[0]?.reason !== "budget-or-fence" || proof.denials[0]?.count !== 1 || !/^[a-f0-9]{64}$/.test(proof.proofSha256)) {
		throw new Error("Fleet closed-session proof does not match the exact two-settlement denied qualification")
	}
}

async function persistProof(storePath: string, claim: ClaimedRepositoryJob, proof: FleetRepositoryClosedSessionProof): Promise<string> {
	const parent = path.resolve(path.dirname(storePath)); const parentInfo = await fs.lstat(parent)
	if (!parentInfo.isDirectory() || parentInfo.isSymbolicLink() || (parentInfo.mode & 0o077) || (typeof process.getuid === "function" && parentInfo.uid !== process.getuid())) throw new Error("billing proof parent is not owner-only")
	const directory = path.join(parent, "partial-billing-proofs")
	await fs.mkdir(directory, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => { if (error.code !== "EEXIST") throw error })
	const info = await fs.lstat(directory)
	if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) || (typeof process.getuid === "function" && info.uid !== process.getuid())) throw new Error("billing proof directory is not owner-only")
	const bytes = Buffer.from(`${JSON.stringify({ schemaVersion: 1, claimId: claim.claimId, epoch: claim.epoch, jobId: claim.job.id, proof })}\n`)
	if (bytes.byteLength > 24 * 1024) throw new Error("billing proof exceeds its storage bound")
	const digest = createHash("sha256").update(bytes).digest("hex")
	const target = path.join(directory, `${claim.job.id}-${claim.claimId}-${claim.epoch}-${digest}.json`)
	const temporary = path.join(directory, `.${claim.job.id}.${randomUUID()}.tmp`)
	const handle = await fs.open(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600)
	try { await handle.chmod(0o600); await handle.writeFile(bytes); await handle.sync() } finally { await handle.close() }
	try { await fs.link(temporary, target) } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; const existing = await fs.readFile(target); if (!existing.equals(bytes)) throw new Error("existing billing proof artifact conflicts") } finally { await fs.unlink(temporary).catch(() => undefined) }
	return digest
}
function assertNoActiveWorktrees(root: string): void { try { const info = requireLstat(root); if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077)) throw new Error("Curl worktree root is not owner-only"); if (requireNames(root).some((name) => name.startsWith("curl-campaign-"))) throw new Error("Curl campaign worktree remains") } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error } }
function requireLstat(root: string) { return fsSync.lstatSync(root) }
function requireNames(root: string): string[] { return fsSync.readdirSync(root) }
function listOpenShellSandboxes(): string[] { const result = spawnSync("docker", ["--host", DOCKER_SOCKET, "ps", "-q", "--no-trunc", "--filter", "label=openshell.ai/isolation-role=sandbox"], { encoding: "utf8", timeout: 10_000, maxBuffer: 256 * 1024, env: { HOME: os.homedir(), PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin" } }); if (result.error || result.status !== 0) throw new Error("could not verify OpenShell sandboxes"); const ids = (result.stdout ?? "").split(/\r?\n/).filter(Boolean); if (ids.length > 200 || ids.some((id) => !/^[a-f0-9]{64}$/i.test(id))) throw new Error("OpenShell sandbox list is invalid"); return ids }
