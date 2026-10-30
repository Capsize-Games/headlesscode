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
import type { KnownCurlDebianAdvisory } from "./repository-known-advisory.js"

export type RepositoryAdvisoryIntake =
	| { source: "osv-commit-query"; publicBaseRevision: string; supportedAdvisoryIds: readonly string[]; poll(): Promise<PublishedAdvisoryRecord[]>; verifySource?(): Promise<void> }
	| { source: "debian-tracker-repair-snapshot"; publicBaseRevision: string; poll(): Promise<KnownCurlDebianAdvisory>; verifySource(): Promise<void> }

export interface RepositoryWorkerExecutionResult {
	status: "succeeded" | "failed" | "ambiguous"
	stage?: RepositoryCampaignStep
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
	readonly advisoryIntake?: RepositoryAdvisoryIntake
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
	private readonly active = new Map<string, { campaignId: string; controller: AbortController }>()
	private readonly jobs = new Set<Promise<void>>()
	private wake?: () => void
	private globalRun: ActiveCampaignRun | null = null
	private readonly intakePollAt = new Map<string, number>()
	private readonly intakeErrors = new Map<string, number>()
	private readonly intakeOutcomes = new Map<string, "empty" | "observed" | "unavailable">()
	private readonly intakePrerequisiteErrors = new Map<string, string>()

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
		const intakePrerequisiteError = this.intakePrerequisiteErrors.get(definition.id)
		if (intakePrerequisiteError) return { state: "blocked-prerequisite", reasons: [intakePrerequisiteError] }
		const matches = this.workers.filter((worker) => worker.workerProfile === definition.workerProfile)
		if (!matches.length) return { state: "blocked-prerequisite", reasons: ["contained-worker-adapter-unregistered", "protected-evaluator-unregistered", "private-delivery-adapter-unregistered"] }
		if (matches.length !== 1 || !identityMatches(definition, matches[0]!)) return { state: "blocked-prerequisite", reasons: ["worker-recipe-evaluator-identity-mismatch"] }
		if (matches[0]!.advisoryIntake?.source === "debian-tracker-repair-snapshot" && this.intakeErrors.has(definition.id)) {
			return { state: "blocked-prerequisite", reasons: ["debian-repair-intake-unavailable"] }
		}
		if (!definition.repositoryId || !definition.repository) return { state: "blocked-prerequisite", reasons: ["private-repository-identity-unavailable"] }
		if (matches[0]!.executionKind === "live-cve" && !this.runLease) return { state: "blocked-prerequisite", reasons: ["global-campaign-run-lease-unavailable"] }
		return { state: "ready", reasons: [] }
	}

	activityMode(): "offline-synthetic-only" | "registered-live-cve" {
		return this.workers.some((worker) => worker.executionKind === "live-cve") ? "registered-live-cve" : "offline-synthetic-only"
	}

	intakeStatus(campaignId: string): { source: "osv-commit-query" | "debian-tracker-repair-snapshot" | "unavailable"; coverage: "partial" | "pinned-snapshot" | "unavailable"; state: "not-configured" | "waiting" | "empty" | "observed" | "unavailable"; lastPollAt: number | null } {
		const worker = this.workers.find((item) => item.workerProfile === this.store.registeredDefinitions().find((definition) => definition.id === campaignId)?.workerProfile)
		if (!worker?.advisoryIntake) return { source: "unavailable", coverage: "unavailable", state: "not-configured", lastPollAt: null }
		const intake = worker.advisoryIntake
		return { source: intake.source, coverage: intake.source === "osv-commit-query" ? "partial" : "pinned-snapshot",
			state: this.intakeErrors.has(campaignId) || this.intakePrerequisiteErrors.has(campaignId) ? "unavailable" : this.intakeOutcomes.get(campaignId) ?? "waiting",
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
		for (const active of this.active.values()) active.controller.abort(new Error("repository coordinator stopped"))
		await this.loopPromise
		await Promise.allSettled([...this.jobs])
		await this.finishGlobalRun("failed")
		this.loopPromise = undefined
	}

	/** Abort only this campaign's active work after its durable Stop transition. */
	stopCampaign(campaignId: string): void {
		if (!/^[a-z0-9][a-z0-9-]{1,62}$/.test(campaignId)) throw new Error("repository campaign identity is invalid")
		for (const active of this.active.values()) {
			if (active.campaignId === campaignId && !active.controller.signal.aborted) {
				active.controller.abort(new Error("repository campaign stopped"))
			}
		}
		this.wake?.()
	}

	async tick(): Promise<void> {
		if (this.stopped || this.active.size >= MAX_CONCURRENT_WORKERS) return
		const status = await this.readStatus()
		for (const definition of status.campaigns) {
			if (this.active.size >= MAX_CONCURRENT_WORKERS || this.stopped) break
			if (!this.intakeCampaignEnabled(definition, status.campaigns)) continue
			if (!await this.verifyIntakePrerequisite(definition)) continue
			await this.pollIntake(definition)
			const refreshed = await this.readStatus()
			await this.startQueuedJob(definition, refreshed)
		}
		if (this.active.size === 0 && this.globalRun) await this.finishGlobalRun("succeeded")
	}

	private intakeCampaignEnabled(definition: RepositoryCampaignDefinition, campaigns: RepositoryCampaignDefinition[]): boolean {
		const campaign = campaigns.find((entry) => entry.id === definition.id) as (RepositoryCampaignDefinition & { enabled?: boolean; readiness?: string }) | undefined
		return campaign?.enabled === true && campaign.readiness === "ready" && this.readiness(definition).state === "ready"
	}

	private async readStatus(): Promise<{ campaigns: RepositoryCampaignDefinition[]; jobs: RepositoryCampaignJob[] }> {
		try {
			const status = await this.store.status() as { campaigns: RepositoryCampaignDefinition[]; jobs: RepositoryCampaignJob[] }
			this.lastFailure = null
			return status
		} catch {
			this.lastFailure = { at: Date.now(), kind: "store-unavailable" }
			throw new Error("repository coordinator store is unavailable")
		}
	}

	private async pollIntake(definition: RepositoryCampaignDefinition): Promise<void> {
		const worker = this.workers.find((entry) => identityMatches(definition, entry))
		const intake = worker?.advisoryIntake
		if (!intake || worker.executionKind !== "live-cve" || Date.now() - (this.intakePollAt.get(definition.id) ?? 0) < INTAKE_POLL_MS) return
		this.intakePollAt.set(definition.id, Date.now())
		try {
			if (intake.source === "debian-tracker-repair-snapshot") {
				const record = await intake.poll()
				await this.store.observeKnownRepairAdvisory({ campaignId: definition.id, publicBaseRevision: intake.publicBaseRevision,
					advisoryId: record.advisoryId, snapshotSha256: record.snapshotSha256, sourceUrl: record.sourceUrl,
					sourceContentSha256: record.sourceHtmlSha256, affectedRange: record.affectedRange })
				this.intakeOutcomes.set(definition.id, "observed")
			} else {
				const records = await intake.poll()
				for (const record of records) await this.store.observePublishedAdvisory({ campaignId: definition.id,
					publicBaseRevision: intake.publicBaseRevision, advisoryId: record.advisoryId,
					snapshotSha256: record.snapshotSha256, eligible: intake.supportedAdvisoryIds.includes(record.advisoryId) })
				this.intakeOutcomes.set(definition.id, records.length ? "observed" : "empty")
			}
			this.intakeErrors.delete(definition.id)
			this.intakePrerequisiteErrors.delete(definition.id)
		} catch {
			this.intakeErrors.set(definition.id, Date.now())
			this.intakeOutcomes.set(definition.id, "unavailable")
			if (intake.source === "debian-tracker-repair-snapshot") this.intakePrerequisiteErrors.set(definition.id, "debian-repair-intake-unavailable")
		}
	}

	private async verifyIntakePrerequisite(definition: RepositoryCampaignDefinition): Promise<boolean> {
		const worker = this.workers.find((entry) => identityMatches(definition, entry))
		const intake = worker?.advisoryIntake
		if (!intake || typeof intake.verifySource !== "function") return true
		try {
			await intake.verifySource()
			this.intakePrerequisiteErrors.delete(definition.id)
			return true
		} catch {
			this.intakePrerequisiteErrors.set(definition.id, "private-source-pin-changed-or-unavailable")
			this.intakeOutcomes.set(definition.id, "unavailable")
			return false
		}
	}

	private async startQueuedJob(definition: RepositoryCampaignDefinition, status: { campaigns: RepositoryCampaignDefinition[]; jobs: RepositoryCampaignJob[] }): Promise<void> {
		if (!await this.verifyIntakePrerequisite(definition)) return
		const registered = this.workers.find((entry) => identityMatches(definition, entry))
		if (registered?.advisoryIntake?.source === "debian-tracker-repair-snapshot" && this.intakeErrors.has(definition.id)) return
		const worker = this.eligibleWorker(definition, status)
		if (!worker || !await this.ensureRun(worker)) return
		const claim = await this.store.claimNext(definition.id, worker.reservation, new Date(), { executionKind: worker.executionKind })
		if (claim) this.launch(worker, definition, claim)
	}

	private eligibleWorker(definition: RepositoryCampaignDefinition, status: { campaigns: RepositoryCampaignDefinition[]; jobs: RepositoryCampaignJob[] }): RegisteredRepositoryWorker | undefined {
		if (this.readiness(definition).state !== "ready") return undefined
		const worker = this.workers.find((entry) => identityMatches(definition, entry))
		const campaign = status.campaigns.find((item) => item.id === definition.id) as (RepositoryCampaignDefinition & { enabled?: boolean; readiness?: string }) | undefined
		const queued = status.jobs.some((job) => job.campaignId === definition.id && job.status === "queued")
		return worker && campaign?.enabled && campaign.readiness === "ready" && queued ? worker : undefined
	}

	private async ensureRun(worker: RegisteredRepositoryWorker): Promise<boolean> {
		if (worker.executionKind !== "live-cve" || this.globalRun) return true
		try { this.globalRun = await this.runLease!.acquire(GLOBAL_RUN_LEASE_MS) }
		catch { return false }
		return this.globalRun !== null
	}

	private launch(worker: RegisteredRepositoryWorker, definition: RepositoryCampaignDefinition, claim: ClaimedRepositoryJob): void {
		const controller = new AbortController()
		this.active.set(claim.job.id, { campaignId: definition.id, controller })
		const pending = this.process(worker, definition, claim, controller.signal).finally(() => {
			this.active.delete(claim.job.id)
			this.jobs.delete(pending)
			this.wake?.()
		})
		this.jobs.add(pending)
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
			await this.store.assertClaimCurrent(claim)
			if (signal.aborted) throw signal.reason ?? new Error("repository campaign stopped")
			heartbeat = setInterval(() => { void this.store.heartbeat(claim).catch(() => undefined) }, HEARTBEAT_MS)
			const result = await worker.execute({ definition, claim, signal, progress: (patch) => this.store.updateClaimProgress(claim, patch) })
			this.validateResult(result)
			await this.saveResult(claim, result)
		} catch {
			await this.failAmbiguous(claim)
		} finally { if (heartbeat) clearInterval(heartbeat) }
	}

	private async saveResult(claim: ClaimedRepositoryJob, result: RepositoryWorkerExecutionResult): Promise<void> {
		const stage = result.stage ?? (result.status === "succeeded" ? "deliver" : (result.completedSteps.at(-1) ?? "intake"))
		const progress = { currentTask: result.currentTask, blocker: result.blocker, nextStep: result.nextStep, boardRef: result.boardRef }
		await this.store.updateClaimProgress(claim, { stage, ...progress,
			completedSteps: result.completedSteps, evidenceRefs: result.evidenceRefs })
		if (result.accounting === "ambiguous" || result.status === "ambiguous" || result.actualMicros === null || result.actualTokens === null) {
			await this.store.finish(claim, { status: "ambiguous", progress })
			return
		}
		await this.store.finish(claim, { status: result.status, actualMicros: result.actualMicros, actualTokens: result.actualTokens, progress })
	}

	private async failAmbiguous(claim: ClaimedRepositoryJob): Promise<void> {
		this.lastFailure = { at: Date.now(), kind: "worker-failure" }
		await this.store.finish(claim, { status: "ambiguous" }).catch(() => undefined)
	}

	private validateResult(result: RepositoryWorkerExecutionResult): void {
		if (!isValidWorkerResult(result) || (result.status === "succeeded" && !isCompleteWorkerResult(result))) throw new Error(ERROR_TEXT)
	}
}

function isValidWorkerResult(result: RepositoryWorkerExecutionResult): boolean {
	return Boolean(result && validResultStatus(result) && validResultAmounts(result) && validSteps(result.completedSteps) &&
		validResultDetails(result) && validBoardRef(result.boardRef))
}

function validResultStatus(result: RepositoryWorkerExecutionResult): boolean {
	return ["succeeded", "failed", "ambiguous"].includes(result.status) && ["measured", "ambiguous"].includes(result.accounting)
}
function validResultAmounts(result: RepositoryWorkerExecutionResult): boolean {
	return validAmount(result.actualMicros) && validAmount(result.actualTokens)
}
function validResultDetails(result: RepositoryWorkerExecutionResult): boolean {
	return (result.stage === undefined || REPOSITORY_CAMPAIGN_STEPS.includes(result.stage)) &&
		Array.isArray(result.evidenceRefs) && result.evidenceRefs.length <= 20 && validMessage(result.currentTask, false) &&
		validMessage(result.blocker, true) && validMessage(result.nextStep, true)
}

function validAmount(value: number | null): boolean { return value === null || (Number.isSafeInteger(value) && value >= 0) }
function validMessage(value: string | null, nullable: boolean): boolean {
	return (nullable && value === null) || (typeof value === "string" && value.length <= 240 && (nullable || value.trim().length > 0))
}
function validBoardRef(value: string | null | undefined): boolean {
	return value === undefined || value === null || (typeof value === "string" && value.length <= 256 &&
		/^http:\/\/127\.0\.0\.1:8078\/api\/cards\/1c25cecf-e5e8-4b68-b6fd-5d6ad25426d7#hc-repository-result-v1:[a-f0-9]{64}$/.test(value))
}
function validSteps(steps: RepositoryCampaignStep[]): boolean {
	return Array.isArray(steps) && steps.every((step, index) => REPOSITORY_CAMPAIGN_STEPS.includes(step) &&
		(index === 0 || REPOSITORY_CAMPAIGN_STEPS.indexOf(step) > REPOSITORY_CAMPAIGN_STEPS.indexOf(steps[index - 1]!)))
}
function isCompleteWorkerResult(result: RepositoryWorkerExecutionResult): boolean {
	return result.accounting === "measured" && result.actualMicros !== null && result.actualTokens !== null &&
		result.completedSteps.length === REPOSITORY_CAMPAIGN_STEPS.length &&
		result.completedSteps.every((step, index) => step === REPOSITORY_CAMPAIGN_STEPS[index]) &&
		["intake", "candidate", "test-receipt", "delivery"].every((kind) => result.evidenceRefs.some((ref) => ref.kind === kind))
}
