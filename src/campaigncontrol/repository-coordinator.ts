import {
	REPOSITORY_CAMPAIGN_STEPS,
	RepositoryCampaignStore,
	type ClaimedRepositoryJob,
	type RepositoryCampaignDefinition,
	type RepositoryCampaignJob,
	type RepositoryCampaignStep,
	type RepositoryEvidenceRef,
} from "./repository-campaigns.js"
import type { ActiveCampaignRun } from "./store.js"
import type { RepositoryCampaignRunLease } from "./repository-run-lease.js"
import type { PublishedAdvisoryRecord } from "./repository-advisory-intake.js"

export interface RepositoryWorkerExecutionResult {
	status: "succeeded" | "failed" | "ambiguous"
	accounting: "measured" | "ambiguous"
	actualMicros: number | null
	actualTokens: number | null
	completedSteps: RepositoryCampaignStep[]
	evidenceRefs: RepositoryEvidenceRef[]
	boardRef?: string | null
	currentTask: string
	blocker: string | null
	nextStep: string | null
}

export interface RegisteredRepositoryWorker {
	readonly workerProfile: string
	readonly recipeDigest: string
	readonly evaluatorDigest: string
	readonly model: string
	readonly executionKind: "development-checkpoint" | "live-cve"
	readonly advisoryIntake?: { readonly publicBaseRevision: string; readonly supportedAdvisoryIds: readonly string[]; poll(): Promise<PublishedAdvisoryRecord[]> }
	readonly reservation: { readonly micros: number; readonly tokens: number }
	execute(input: {
		definition: RepositoryCampaignDefinition
		claim: ClaimedRepositoryJob
		signal: AbortSignal
		progress(patch: { stage: RepositoryCampaignStep; currentTask: string; completedSteps: RepositoryCampaignStep[]; blocker?: string | null; nextStep?: string | null; evidenceRefs?: RepositoryEvidenceRef[]; boardRef?: string | null }): Promise<void>
	}): Promise<RepositoryWorkerExecutionResult>
}

export interface RepositoryRuntimeReadiness { state: "ready" | "blocked-prerequisite"; reasons: string[] }

const MAX_CONCURRENT_WORKERS = 2
const MAX_POLL_MS = 5_000
const HEARTBEAT_MS = 30_000
const GLOBAL_RUN_LEASE_MS = 20 * 60_000
const INTAKE_POLL_MS = 10 * 60_000
const ERROR_TEXT = "Registered worker failed before a qualified result was available"

function identityMatches(definition: RepositoryCampaignDefinition, worker: RegisteredRepositoryWorker): boolean {
	return definition.workerProfile === worker.workerProfile && definition.recipeDigest === worker.recipeDigest &&
		definition.evaluatorDigest === worker.evaluatorDigest && definition.model === worker.model
}

/** Bounded in-process poller. Only statically registered, digest-matched adapters can claim work. */
export class RepositoryCampaignCoordinator {
	private loopPromise?: Promise<void>
	private stopped = false
	private lastFailure: { at: number; kind: "store-unavailable" | "worker-failure" } | null = null
	private readonly active = new Map<string, AbortController>()
	private readonly jobs = new Set<Promise<void>>()
	private wake?: () => void
	private globalRun: ActiveCampaignRun | null = null
	private readonly intakePollAt = new Map<string, number>()
	private readonly intakeErrors = new Map<string, number>()
	private readonly intakeOutcomes = new Map<string, "empty" | "observed" | "unavailable">()

	constructor(private readonly store: RepositoryCampaignStore, private readonly workers: readonly RegisteredRepositoryWorker[],
		private readonly pollMs = MAX_POLL_MS, private readonly runLease?: RepositoryCampaignRunLease) {
		if (!Number.isSafeInteger(pollMs) || pollMs < 100 || pollMs > MAX_POLL_MS || workers.length > 32) throw new Error("repository coordinator bounds are invalid")
		for (const worker of workers) {
			if (!worker || !/^[a-z0-9][a-z0-9-]{1,62}$/.test(worker.workerProfile) || !/^[a-f0-9]{64}$/.test(worker.recipeDigest) ||
				!/^[a-f0-9]{64}$/.test(worker.evaluatorDigest) || typeof worker.model !== "string" || worker.model.length > 160 ||
				!Number.isSafeInteger(worker.reservation?.micros) || worker.reservation.micros < 1 ||
				!Number.isSafeInteger(worker.reservation?.tokens) || worker.reservation.tokens < 1 || typeof worker.execute !== "function") throw new Error("registered repository worker identity is invalid")
		}
	}

	readiness(definition: RepositoryCampaignDefinition): RepositoryRuntimeReadiness {
		if (this.lastFailure?.kind === "store-unavailable") return { state: "blocked-prerequisite", reasons: ["repository-coordinator-store-unavailable"] }
		const matches = this.workers.filter((worker) => worker.workerProfile === definition.workerProfile)
		if (!matches.length) return { state: "blocked-prerequisite", reasons: ["contained-worker-adapter-unregistered", "protected-evaluator-unregistered", "private-delivery-adapter-unregistered"] }
		if (matches.length !== 1 || !identityMatches(definition, matches[0]!)) return { state: "blocked-prerequisite", reasons: ["worker-recipe-evaluator-identity-mismatch"] }
		if (!definition.repositoryId || !definition.repository) return { state: "blocked-prerequisite", reasons: ["private-repository-identity-unavailable"] }
		if (matches[0]!.executionKind === "live-cve" && !this.runLease) return { state: "blocked-prerequisite", reasons: ["global-campaign-run-lease-unavailable"] }
		return { state: "ready", reasons: [] }
	}

	activityMode(): "offline-synthetic-only" | "registered-live-cve" {
		return this.workers.some((worker) => worker.executionKind === "live-cve") ? "registered-live-cve" : "offline-synthetic-only"
	}

	intakeStatus(campaignId: string): { source: "osv-commit-query" | "unavailable"; coverage: "partial" | "unavailable"; state: "not-configured" | "waiting" | "empty" | "observed" | "unavailable"; lastPollAt: number | null } {
		const worker = this.workers.find((item) => item.workerProfile === this.store.registeredDefinitions().find((definition) => definition.id === campaignId)?.workerProfile)
		if (!worker?.advisoryIntake) return { source: "unavailable", coverage: "unavailable", state: "not-configured", lastPollAt: null }
		return { source: "osv-commit-query", coverage: "partial", state: this.intakeErrors.has(campaignId) ? "unavailable" : this.intakeOutcomes.get(campaignId) ?? "waiting",
			lastPollAt: this.intakePollAt.get(campaignId) ?? null }
	}

	async start(): Promise<void> {
		if (this.loopPromise) return
		this.stopped = false
		// A process restart never replays a prior running claim.
		await this.store.recoverInterrupted()
		this.loopPromise = this.loop()
	}

	async stop(): Promise<void> {
		this.stopped = true
		this.wake?.()
		for (const controller of this.active.values()) controller.abort(new Error("repository coordinator stopped"))
		await this.loopPromise
		await Promise.allSettled([...this.jobs])
		await this.finishGlobalRun("failed")
		this.loopPromise = undefined
	}

	async tick(): Promise<void> {
		if (this.stopped || this.active.size >= MAX_CONCURRENT_WORKERS) return
		let status: { campaigns: RepositoryCampaignDefinition[]; jobs: RepositoryCampaignJob[] }
		try { status = await this.store.status() as { campaigns: RepositoryCampaignDefinition[]; jobs: RepositoryCampaignJob[] }; this.lastFailure = null }
		catch { this.lastFailure = { at: Date.now(), kind: "store-unavailable" }; throw new Error("repository coordinator store is unavailable") }
		for (const definition of status.campaigns) {
			if (this.active.size >= MAX_CONCURRENT_WORKERS || this.stopped) break
			const runtime = this.readiness(definition)
			if (runtime.state !== "ready") continue
			const worker = this.workers.find((entry) => identityMatches(definition, entry))
			if (!worker) continue
			const campaign = status.campaigns.find((item) => item.id === definition.id) as (RepositoryCampaignDefinition & { enabled?: boolean; readiness?: string }) | undefined
			if (!campaign?.enabled || campaign.readiness !== "ready") continue
			if (worker.executionKind === "live-cve" && worker.advisoryIntake) {
				const lastPoll = this.intakePollAt.get(definition.id) ?? 0
				if (Date.now() - lastPoll >= INTAKE_POLL_MS) {
					this.intakePollAt.set(definition.id, Date.now())
					try {
						const records = await worker.advisoryIntake.poll()
						for (const record of records) await this.store.observePublishedAdvisory({ campaignId: definition.id,
							publicBaseRevision: worker.advisoryIntake.publicBaseRevision, advisoryId: record.advisoryId,
							snapshotSha256: record.snapshotSha256, eligible: worker.advisoryIntake.supportedAdvisoryIds.includes(record.advisoryId) })
						this.intakeErrors.delete(definition.id)
						this.intakeOutcomes.set(definition.id, records.length ? "observed" : "empty")
						status = await this.store.status() as typeof status
					} catch { this.intakeErrors.set(definition.id, Date.now()); this.intakeOutcomes.set(definition.id, "unavailable") }
				}
			}
			const queued = status.jobs.some((job) => job.campaignId === definition.id && job.status === "queued")
			if (!queued) continue
			if (worker.executionKind === "live-cve" && !this.globalRun) {
				try { this.globalRun = await this.runLease!.acquire(GLOBAL_RUN_LEASE_MS) }
				catch { continue }
				if (!this.globalRun) continue
			}
			const claim = await this.store.claimNext(definition.id, worker.reservation, new Date(), { executionKind: worker.executionKind })
			if (!claim) continue
			const controller = new AbortController()
			this.active.set(claim.job.id, controller)
			const pending = this.process(worker, definition, claim, controller.signal).finally(() => {
				this.active.delete(claim.job.id)
				this.jobs.delete(pending)
				this.wake?.()
			})
			this.jobs.add(pending)
		}
		if (this.active.size === 0 && this.globalRun) await this.finishGlobalRun("succeeded")
	}

	private async finishGlobalRun(status: "succeeded" | "failed"): Promise<void> {
		const run = this.globalRun
		if (!run || !this.runLease) return
		this.globalRun = null
		try { await this.runLease.finish(run, status) }
		catch { /* expired lease remains fenced and is reconciled by the control store */ }
	}

	private async loop(): Promise<void> {
		while (!this.stopped) {
			await this.tick().catch(() => undefined)
			if (this.stopped) break
			await new Promise<void>((resolve) => {
				const timer = setTimeout(() => { this.wake = undefined; resolve() }, this.pollMs)
				this.wake = () => { clearTimeout(timer); this.wake = undefined; resolve() }
			})
		}
	}

	private async process(worker: RegisteredRepositoryWorker, definition: RepositoryCampaignDefinition, claim: ClaimedRepositoryJob, signal: AbortSignal): Promise<void> {
		let heartbeat: NodeJS.Timeout | undefined
		try {
			heartbeat = setInterval(() => { void this.store.heartbeat(claim).catch(() => undefined) }, HEARTBEAT_MS)
			const result = await worker.execute({ definition, claim, signal, progress: (patch) => this.store.updateClaimProgress(claim, patch) })
			this.validateResult(result)
			const stage = result.status === "succeeded" ? "deliver" : (result.completedSteps.at(-1) ?? "intake")
			await this.store.updateClaimProgress(claim, { stage, currentTask: result.currentTask,
				completedSteps: result.completedSteps, blocker: result.blocker, nextStep: result.nextStep, evidenceRefs: result.evidenceRefs, boardRef: result.boardRef })
			if (result.accounting === "ambiguous" || result.status === "ambiguous" || result.actualMicros === null || result.actualTokens === null) {
				await this.store.finish(claim, { status: "ambiguous", progress: { currentTask: result.currentTask, blocker: result.blocker, nextStep: result.nextStep, boardRef: result.boardRef } })
			} else {
				await this.store.finish(claim, { status: result.status, actualMicros: result.actualMicros, actualTokens: result.actualTokens,
					progress: { currentTask: result.currentTask, blocker: result.blocker, nextStep: result.nextStep, boardRef: result.boardRef } })
			}
		} catch {
			this.lastFailure = { at: Date.now(), kind: "worker-failure" }
			await this.store.finish(claim, { status: "ambiguous" }).catch(() => undefined)
		} finally { if (heartbeat) clearInterval(heartbeat) }
	}

	private validateResult(result: RepositoryWorkerExecutionResult): void {
		if (!result || !["succeeded", "failed", "ambiguous"].includes(result.status) || !["measured", "ambiguous"].includes(result.accounting) ||
			(result.actualMicros !== null && (!Number.isSafeInteger(result.actualMicros) || result.actualMicros < 0)) ||
			(result.actualTokens !== null && (!Number.isSafeInteger(result.actualTokens) || result.actualTokens < 0)) ||
			!Array.isArray(result.completedSteps) || result.completedSteps.some((step, index) => !REPOSITORY_CAMPAIGN_STEPS.includes(step) || (index > 0 && REPOSITORY_CAMPAIGN_STEPS.indexOf(step) <= REPOSITORY_CAMPAIGN_STEPS.indexOf(result.completedSteps[index - 1]!))) ||
			!Array.isArray(result.evidenceRefs) || result.evidenceRefs.length > 20 || typeof result.currentTask !== "string" || !result.currentTask.trim() || result.currentTask.length > 240 ||
			(result.blocker !== null && (typeof result.blocker !== "string" || result.blocker.length > 240)) ||
			(result.nextStep !== null && (typeof result.nextStep !== "string" || result.nextStep.length > 240)) ||
			(result.boardRef !== undefined && result.boardRef !== null && (typeof result.boardRef !== "string" || result.boardRef.length > 256 ||
				!/^http:\/\/127\.0\.0\.1:8078\/api\/cards\/1c25cecf-e5e8-4b68-b6fd-5d6ad25426d7#hc-repository-result-v1:[a-f0-9]{64}$/.test(result.boardRef)))) throw new Error(ERROR_TEXT)
		if (result.status === "succeeded" && (result.accounting !== "measured" || result.actualMicros === null || result.actualTokens === null ||
			result.completedSteps.length !== REPOSITORY_CAMPAIGN_STEPS.length || result.completedSteps.some((step, index) => step !== REPOSITORY_CAMPAIGN_STEPS[index]) ||
			!["intake", "candidate", "test-receipt", "delivery"].every((kind) => result.evidenceRefs.some((ref) => ref.kind === kind)))) throw new Error(ERROR_TEXT)
	}
}
