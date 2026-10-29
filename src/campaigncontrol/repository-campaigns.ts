import * as fs from "node:fs/promises"
import * as constants from "node:fs"
import * as path from "node:path"
import { randomUUID } from "node:crypto"

export const REPOSITORY_CAMPAIGN_BUDGET_CAP_MICROS = 5_000_000
// Keeps the mock subcap within the existing fixed Fleet campaign's 108k-token ceiling.
export const REPOSITORY_CAMPAIGN_BUDGET_CAP_TOKENS = 108_000
const MAX_CAMPAIGNS = 32
const MAX_JOBS = 500
const MAX_HISTORY = 200
const MOCK_DISPATCH_TIMEOUT_MS = 30_000
export const REPOSITORY_WORKER_LEASE_MS = 120_000
export const REPOSITORY_PROGRESS_FRESH_MS = 60_000
export const REPOSITORY_CAMPAIGN_STEPS = ["intake", "deduplicate", "investigate", "prepare-candidate", "verify", "deliver"] as const
export type RepositoryCampaignStep = typeof REPOSITORY_CAMPAIGN_STEPS[number]

export interface RepositoryEvidenceRef {
	id: string
	kind: "intake" | "candidate" | "test-receipt" | "delivery"
	label: string
}

export interface RepositoryJobProgress {
	executionKind: "development-checkpoint" | "live-cve"
	workerId: string
	goal: string
	currentTask: string
	stage: RepositoryCampaignStep
	completedSteps: RepositoryCampaignStep[]
	requiredSteps: RepositoryCampaignStep[]
	lastActionAt: number
	heartbeatAt: number
	leaseExpiresAt: number
	blocker: string | null
	nextStep: string | null
	evidenceRefs: RepositoryEvidenceRef[]
}

export interface RepositoryCampaignDefinition {
	id: string
	name: string
	repositoryId?: string
	repository?: string
	sourceRevision: string | null
	workerProfile: string | null
	recipeDigest: string | null
	evaluatorDigest: string | null
	model: string | null
	dataAccessProfile: string | null
	qualification: {
		sourceAudited: boolean
		workerQualified: boolean
		recipeQualified: boolean
		evaluatorQualified: boolean
		modelApproved: boolean
		dataApproved: boolean
		accessApproved: boolean
	}
}

export interface RepositoryBudgetAuthority {
	mode: "synthetic-test" | "fleet-v2"
	available: boolean
	limitMicros: number
	limitTokens: number
	committedMicros: number
	committedTokens: number
	/** Fresh authority projection fields are present only for mode=fleet-v2. */
	asOfMs?: number
	campaignId?: string
	globalEnabled?: boolean
	canAdmit?: boolean
	controlEpoch?: number
	runId?: string
	runExpiresAtMs?: number
	repositoryCampaignId?: string
	repositoryId?: string
	repository?: string
	sourceRevision?: string
	policySha256?: string
	model?: string
	profileId?: string
	repositoryEnabled?: boolean
	repositoryEpoch?: number
	monthly?: { month: string; limitMicros: number; settledMicros: number; reservedMicros: number; ambiguousMicros: number }
	campaignLifetime?: { limitMicros: number; limitTokens: number; settledMicros: number; reservedMicros: number; ambiguousMicros: number; settledTokens: number; reservedTokens: number; ambiguousTokens: number }
	legacyLifetime?: { settledMicros: number; reservedMicros: number; ambiguousMicros: number; settledTokens: number; reservedTokens: number; ambiguousTokens: number }
	repositoryLifetime?: { limitMicros: number; limitTokens: number; settledMicros: number; reservedMicros: number; ambiguousMicros: number; settledTokens: number; reservedTokens: number; ambiguousTokens: number }
}

export interface RepositoryCampaignJob {
	id: string
	campaignId: string
	advisoryId: string
	status: "queued" | "running" | "cancelled" | "succeeded" | "failed" | "ambiguous"
	epoch: number
	createdAt: number
	updatedAt: number
	month: string
	claimId?: string
	reservedMicros: number
	settledMicros: number
	reservedTokens: number
	settledTokens: number
	progress?: RepositoryJobProgress
	detail?: string
}

interface CampaignRecord {
	enabled: boolean
	epoch: number
	budgetLimitMicros: number
	budgetLimitTokens: number
	settledMicros: number
	reservedMicros: number
	ambiguousMicros: number
	settledTokens: number
	reservedTokens: number
	ambiguousTokens: number
}

interface CampaignState {
	schemaVersion: 1
	month: string
	campaigns: Record<string, CampaignRecord>
	drafts: Record<string, { id: string; repository: string; name: string; sourceRevision: string | null; requestedModelProfile: string | null }>
	jobs: RepositoryCampaignJob[]
	history: Array<{ at: number; campaignId: string; action: "drafted" | "configured" | "started" | "stopped" | "budget" | "budget-exhausted" | "claimed" | "completed" | "interrupted"; epoch: number; jobId?: string }>
}

export interface ClaimedRepositoryJob {
	job: RepositoryCampaignJob
	claimId: string
	epoch: number
}

export type MockRepositoryDispatcher = (job: RepositoryCampaignJob) => Promise<{
	status: "succeeded" | "failed" | "ambiguous"
	actualMicros?: number
	actualTokens?: number
}>

function validUsageCounters(value: unknown, includeLimits = false): value is Record<string, number> {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false
	const counters = ["settledMicros", "reservedMicros", "ambiguousMicros", "settledTokens", "reservedTokens", "ambiguousTokens"]
	if (Object.keys(value).sort().join(",") !== [...counters, ...(includeLimits ? ["limitMicros", "limitTokens"] : [])].sort().join(",")) return false
	return [...counters, ...(includeLimits ? ["limitMicros", "limitTokens"] : [])]
		.every((key) => Number.isSafeInteger((value as Record<string, unknown>)[key]) && Number((value as Record<string, unknown>)[key]) >= 0)
}

function validLifetimeSnapshot(value: unknown, spendLimit?: number, tokenLimit?: number, allowLimits = false): boolean {
	if (!validUsageCounters(value, allowLimits || spendLimit !== undefined)) return false
	const row = value as Record<string, unknown>
	if (spendLimit === undefined) {
		if (!allowLimits) return !Object.hasOwn(value, "limitMicros") && !Object.hasOwn(value, "limitTokens")
		return Number.isSafeInteger(row.limitMicros) && Number(row.limitMicros) >= 0 && Number(row.limitMicros) <= REPOSITORY_CAMPAIGN_BUDGET_CAP_MICROS &&
			Number.isSafeInteger(row.limitTokens) && Number(row.limitTokens) >= 0 && Number(row.limitTokens) <= REPOSITORY_CAMPAIGN_BUDGET_CAP_TOKENS
	}
	return Number.isSafeInteger(row.limitMicros) && Number(row.limitMicros) === spendLimit &&
		Number.isSafeInteger(row.limitTokens) && Number(row.limitTokens) === tokenLimit
}

function validMonthlySnapshot(value: unknown): boolean {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false
	const row = value as Record<string, unknown>
	return Object.keys(value).sort().join(",") === "ambiguousMicros,limitMicros,month,reservedMicros,settledMicros" &&
		typeof row.month === "string" && row.month === monthNow(new Date()) &&
		Number.isSafeInteger(row.limitMicros) && Number(row.limitMicros) > 0 && Number(row.limitMicros) <= 5_000_000 &&
		["settledMicros", "reservedMicros", "ambiguousMicros"].every((key) => Number.isSafeInteger(row[key]) && Number(row[key]) >= 0)
}

export async function loadRepositoryCampaignDefinitions(filePath: string): Promise<RepositoryCampaignDefinition[]> {
	try {
		const stat = await fs.lstat(filePath)
		const parent = await fs.lstat(path.dirname(filePath))
		if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 64 * 1024 || (stat.mode & 0o077) !== 0 ||
			(typeof process.getuid === "function" && stat.uid !== process.getuid()) || !parent.isDirectory() || parent.isSymbolicLink() ||
			(parent.mode & 0o077) !== 0 || (typeof process.getuid === "function" && parent.uid !== process.getuid())) throw new Error("repository campaign registry must be a bounded owner-only file")
		const value: unknown = JSON.parse(await fs.readFile(filePath, "utf8"))
		if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("repository campaign registry failed schema validation")
		const registry = value as Record<string, unknown>
		if (Object.keys(registry).sort().join(",") !== "repositories,schemaVersion" ||
			registry.schemaVersion !== 1 || !Array.isArray(registry.repositories) || registry.repositories.length > MAX_CAMPAIGNS) {
			throw new Error("repository campaign registry failed schema validation")
		}
		const definitions = registry.repositories as RepositoryCampaignDefinition[]
		const ids = new Set<string>()
		for (const definition of definitions) { validateDefinition(definition); if (ids.has(definition.id)) throw new Error("duplicate repository campaign definition"); ids.add(definition.id) }
		return definitions
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return []
		throw error
	}
}

function validId(value: unknown): value is string {
	return typeof value === "string" && /^[a-z0-9][a-z0-9-]{1,62}$/.test(value) &&
		!new Set(["constructor", "prototype", "tostring", "valueof", "hasownproperty", "__proto__"]).has(value)
}
function monthNow(date: Date): string { return date.toISOString().slice(0, 7) }

function blankState(now: Date): CampaignState {
	return { schemaVersion: 1, month: monthNow(now), campaigns: {}, drafts: {}, jobs: [], history: [] }
}

function validateDefinition(definition: RepositoryCampaignDefinition): void {
	if (!definition || typeof definition !== "object") throw new Error("repository campaign definition is invalid")
	const q = definition.qualification
	if (!(["dataAccessProfile,evaluatorDigest,id,model,name,qualification,recipeDigest,sourceRevision,workerProfile",
		"dataAccessProfile,evaluatorDigest,id,model,name,qualification,recipeDigest,repository,repositoryId,sourceRevision,workerProfile"].includes(Object.keys(definition).sort().join(","))) ||
		!validId(definition.id) || typeof definition.name !== "string" || !definition.name.trim() || definition.name.length > 100 ||
		(definition.repositoryId !== undefined && !validId(definition.repositoryId)) ||
		(definition.repository !== undefined && (typeof definition.repository !== "string" || !/^[A-Za-z0-9_.-]{1,39}\/[A-Za-z0-9_.-]{1,100}$/.test(definition.repository))) ||
		![definition.sourceRevision, definition.workerProfile, definition.recipeDigest, definition.evaluatorDigest, definition.model, definition.dataAccessProfile]
			.every((value) => value === null || (typeof value === "string" && value.length <= 160)) ||
		!q || Object.keys(q).sort().join(",") !== "accessApproved,dataApproved,evaluatorQualified,modelApproved,recipeQualified,sourceAudited,workerQualified" ||
		Object.values(q).some((value) => typeof value !== "boolean") ||
		(definition.sourceRevision !== null && !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(definition.sourceRevision)) ||
		(definition.recipeDigest !== null && !/^[a-f0-9]{64}$/.test(definition.recipeDigest)) ||
		(definition.evaluatorDigest !== null && !/^[a-f0-9]{64}$/.test(definition.evaluatorDigest))) {
		throw new Error("repository campaign definition is invalid")
	}
}

function validateState(value: unknown): value is CampaignState {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false
	const s = value as Partial<CampaignState>
	if (Object.keys(value as object).sort().join(",") !== "campaigns,drafts,history,jobs,month,schemaVersion" ||
		s.schemaVersion !== 1 || typeof s.month !== "string" || !/^\d{4}-(0[1-9]|1[0-2])$/.test(s.month) ||
		!s.campaigns || typeof s.campaigns !== "object" || Array.isArray(s.campaigns) || Object.keys(s.campaigns).length > MAX_CAMPAIGNS ||
		!s.drafts || typeof s.drafts !== "object" || Array.isArray(s.drafts) || Object.keys(s.drafts).length > MAX_CAMPAIGNS ||
		!Array.isArray(s.jobs) || s.jobs.length > MAX_JOBS || !Array.isArray(s.history) || s.history.length > MAX_HISTORY) return false
	for (const [id, record] of Object.entries(s.campaigns)) {
		if (!validId(id) || !record || typeof record !== "object" || Object.keys(record).sort().join(",") !== "ambiguousMicros,ambiguousTokens,budgetLimitMicros,budgetLimitTokens,enabled,epoch,reservedMicros,reservedTokens,settledMicros,settledTokens" ||
			typeof record.enabled !== "boolean" || !Number.isSafeInteger(record.epoch) || record.epoch < 0 ||
			![record.budgetLimitMicros, record.budgetLimitTokens, record.settledMicros, record.reservedMicros, record.ambiguousMicros,
				record.settledTokens, record.reservedTokens, record.ambiguousTokens].every((n) => Number.isSafeInteger(n) && n >= 0) ||
			record.budgetLimitMicros > REPOSITORY_CAMPAIGN_BUDGET_CAP_MICROS || record.budgetLimitTokens > REPOSITORY_CAMPAIGN_BUDGET_CAP_TOKENS) return false
	}
	for (const [id, draft] of Object.entries(s.drafts)) {
		if (!validId(id) || !draft || typeof draft !== "object" || Object.keys(draft).sort().join(",") !== "id,name,repository,requestedModelProfile,sourceRevision" ||
			draft.id !== id || typeof draft.name !== "string" || !draft.name.trim() || draft.name.length > 100 ||
			typeof draft.repository !== "string" || !/^[A-Za-z0-9_.-]{1,39}\/[A-Za-z0-9_.-]{1,100}$/.test(draft.repository) ||
			(draft.sourceRevision !== null && (typeof draft.sourceRevision !== "string" || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(draft.sourceRevision))) ||
			(draft.requestedModelProfile !== null && (typeof draft.requestedModelProfile !== "string" || !/^[a-z0-9-]{1,64}$/.test(draft.requestedModelProfile)))) return false
	}
	const ids = new Set<string>()
	for (const job of s.jobs) {
		if (!job || typeof job !== "object" || !validId(job.id) || !validId(job.campaignId) || !/^CVE-\d{4}-\d{4,12}$/.test(job.advisoryId) ||
			!s.campaigns[job.campaignId] || !["queued", "running", "cancelled", "succeeded", "failed", "ambiguous"].includes(job.status) ||
			!Number.isSafeInteger(job.epoch) || !Number.isSafeInteger(job.createdAt) || !Number.isSafeInteger(job.updatedAt) ||
			typeof job.month !== "string" || !/^\d{4}-(0[1-9]|1[0-2])$/.test(job.month) ||
			![job.reservedMicros, job.settledMicros, job.reservedTokens, job.settledTokens].every((n) => Number.isSafeInteger(n) && n >= 0) || ids.has(job.id) ||
			(job.claimId !== undefined && typeof job.claimId !== "string") || (job.detail !== undefined && typeof job.detail !== "string") ||
			(job.progress !== undefined && !validProgress(job.progress))) return false
		ids.add(job.id)
	}
	for (const item of s.history) {
		if (!item || typeof item !== "object" || !validId(item.campaignId) || (!s.campaigns[item.campaignId] && !s.drafts[item.campaignId]) ||
			!Number.isSafeInteger(item.at) || !Number.isSafeInteger(item.epoch) || item.epoch < 0 ||
			!["drafted", "configured", "started", "stopped", "budget", "budget-exhausted", "claimed", "completed", "interrupted"].includes(item.action) ||
			(item.jobId !== undefined && !validId(item.jobId)) || Object.keys(item).some((key) => !["at", "campaignId", "action", "epoch", "jobId"].includes(key))) return false
	}
	return true
}

function validProgress(value: unknown): value is RepositoryJobProgress {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false
	const p = value as RepositoryJobProgress
	const steps = new Set<string>(REPOSITORY_CAMPAIGN_STEPS)
	return Object.keys(value).sort().join(",") === "blocker,completedSteps,currentTask,evidenceRefs,executionKind,goal,heartbeatAt,lastActionAt,leaseExpiresAt,nextStep,requiredSteps,stage,workerId" &&
		["development-checkpoint", "live-cve"].includes(p.executionKind) && /^[0-9a-f-]{36}$/.test(p.workerId) &&
		typeof p.goal === "string" && p.goal.length > 0 && p.goal.length <= 240 &&
		typeof p.currentTask === "string" && p.currentTask.length > 0 && p.currentTask.length <= 240 &&
		steps.has(p.stage) && Array.isArray(p.requiredSteps) && p.requiredSteps.length === REPOSITORY_CAMPAIGN_STEPS.length &&
		p.requiredSteps.every((step, index) => step === REPOSITORY_CAMPAIGN_STEPS[index]) &&
		Array.isArray(p.completedSteps) && p.completedSteps.length <= p.requiredSteps.length &&
		p.completedSteps.every((step, index) => steps.has(step) && p.requiredSteps.indexOf(step) >= 0 &&
			(index === 0 || p.requiredSteps.indexOf(step) > p.requiredSteps.indexOf(p.completedSteps[index - 1]!))) &&
		[p.lastActionAt, p.heartbeatAt, p.leaseExpiresAt].every(Number.isSafeInteger) &&
		p.lastActionAt <= p.heartbeatAt && p.heartbeatAt <= p.leaseExpiresAt &&
		(p.blocker === null || (typeof p.blocker === "string" && p.blocker.length <= 240)) &&
		(p.nextStep === null || (typeof p.nextStep === "string" && p.nextStep.length <= 240)) &&
		Array.isArray(p.evidenceRefs) && p.evidenceRefs.length <= 20 && p.evidenceRefs.every((item) => item &&
			Object.keys(item).sort().join(",") === "id,kind,label" && /^[a-f0-9]{64}$/.test(item.id) &&
			["intake", "candidate", "test-receipt", "delivery"].includes(item.kind) &&
			typeof item.label === "string" && item.label.length > 0 && item.label.length <= 80)
}

/** Durable control plane. Its optional budget adapter is synthetic-test-only; production is denied until the broker integration exists. */
export class RepositoryCampaignStore {
	readonly path: string
	private readonly lockPath: string
	private readonly definitions = new Map<string, RepositoryCampaignDefinition>()
	private readonly readBudgetAuthority: (campaignId?: string) => RepositoryBudgetAuthority

	constructor(filePath: string, definitions: RepositoryCampaignDefinition[], readBudgetAuthority: (campaignId?: string) => RepositoryBudgetAuthority = () => ({ mode: "synthetic-test", available: false, limitMicros: 0, limitTokens: 0, committedMicros: 0, committedTokens: 0 })) {
		this.path = path.resolve(filePath)
		this.lockPath = `${this.path}.lock`
		this.readBudgetAuthority = readBudgetAuthority
		if (definitions.length > MAX_CAMPAIGNS) throw new Error("too many repository campaign definitions")
		for (const definition of definitions) {
			validateDefinition(definition)
			if (this.definitions.has(definition.id)) throw new Error("duplicate repository campaign definition")
			this.definitions.set(definition.id, { ...definition })
		}
	}

	async status(now = new Date()): Promise<Record<string, unknown>> {
		const state = await this.read(now)
		const authority = this.budgetAuthority(this.definitions.keys().next().value)
		const totals = this.aggregateTotals(state)
		return {
			month: state.month,
			budget: { authority: authority.mode, adapter: authority.available ? authority.mode : "none", available: authority.available,
				limitMicros: authority.limitMicros, limitTokens: authority.limitTokens, externalCommittedMicros: authority.committedMicros,
				externalCommittedTokens: authority.committedTokens, ...totals,
				...(authority.monthly ? { monthly: authority.monthly } : {}),
				...(authority.campaignLifetime ? { campaignLifetime: authority.campaignLifetime } : {}),
				remainingMicros: Math.max(0, authority.limitMicros - authority.committedMicros - totals.settledMicros - totals.reservedMicros - totals.ambiguousMicros),
				remainingTokens: Math.max(0, authority.limitTokens - authority.committedTokens - totals.settledTokens - totals.reservedTokens - totals.ambiguousTokens) },
			campaigns: [...this.definitions.values()].map((definition) => {
				const campaign = state.campaigns[definition.id] ?? this.initialCampaign()
				const scopedAuthority = this.budgetAuthority(definition.id)
				const missing = this.missingReadiness(definition, scopedAuthority, campaign, state)
				const exhausted = this.isExhausted(campaign)
				const stateName = this.campaignState(definition.id, campaign, missing, exhausted, state.jobs)
				const readiness = missing.some((reason) => reason !== "aggregate-budget-exhausted") ? "blocked-prerequisite" :
					exhausted || missing.includes("aggregate-budget-exhausted") ? "budget-exhausted" : "ready"
				return { ...definition, qualification: undefined, ...campaign, exhausted, state: stateName,
					readiness, readinessReasons: missing }
			}),
			drafts: Object.values(state.drafts).map((draft) => ({ ...draft, readiness: "blocked-prerequisite", readinessReasons: ["owner-provisioned-enrollment-review"] })),
			jobs: state.jobs.slice(-100), history: state.history.slice(-100),
		}
	}

	async createDraft(input: { id: string; repository: string; name: string }, now = new Date()): Promise<void> {
		if (!validId(input.id) || typeof input.name !== "string" || !input.name.trim() || input.name.length > 100 ||
			typeof input.repository !== "string" || !/^[A-Za-z0-9_.-]{1,39}\/[A-Za-z0-9_.-]{1,100}$/.test(input.repository)) throw new Error("repository draft metadata is invalid")
		if (this.definitions.has(input.id)) throw new Error("repository campaign is already registered")
		await this.update((s) => {
			if (s.campaigns[input.id]) throw new Error("repository campaign is already registered")
			const existing = s.drafts[input.id]
			if (existing) {
				if (existing.name === input.name && existing.repository === input.repository) return
				throw new Error("repository draft already exists with different metadata")
			}
			if (Object.keys(s.drafts).length + this.definitions.size >= MAX_CAMPAIGNS) throw new Error("repository campaign registry is full")
			s.drafts[input.id] = { ...input, sourceRevision: null, requestedModelProfile: null }
			this.draftEvent(s, input.id, "drafted", now)
		}, now)
	}

	async configureDraft(id: string, input: { sourceRevision: string; requestedModelProfile: string }, now = new Date()): Promise<void> {
		if (!validId(id) || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(input.sourceRevision) || !/^[a-z0-9-]{1,64}$/.test(input.requestedModelProfile)) throw new Error("repository draft configuration is invalid")
		await this.update((s) => {
			const draft = s.drafts[id]
			if (!draft) throw new Error("repository draft is not registered")
			if (draft.sourceRevision === input.sourceRevision && draft.requestedModelProfile === input.requestedModelProfile) return
			draft.sourceRevision = input.sourceRevision
			draft.requestedModelProfile = input.requestedModelProfile
			this.draftEvent(s, id, "configured", now)
		}, now)
	}

	async historyPage(id: string, cursor: number, limit: number, now = new Date()): Promise<{ items: CampaignState["history"]; nextCursor: number | null }> {
		if (!validId(id) || !Number.isSafeInteger(cursor) || cursor < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error("history cursor or limit is invalid")
		return this.update((s) => {
			if (!this.definitions.has(id) && !s.drafts[id]) throw new Error("repository campaign is not registered")
			const rows = s.history.filter((item) => item.campaignId === id)
			if (cursor > rows.length) throw new Error("history cursor is out of range")
			const items = rows.slice(cursor, cursor + limit)
			return { items, nextCursor: cursor + items.length < rows.length ? cursor + items.length : null }
		}, now)
	}

	async setCampaignBudget(id: string, micros: number, tokens: number, now = new Date()): Promise<void> {
		this.requireDefinition(id); this.validBudget(micros, tokens)
		await this.update((s) => {
			const c = this.campaign(s, id)
			if (micros < c.settledMicros + c.reservedMicros + c.ambiguousMicros || tokens < c.settledTokens + c.reservedTokens + c.ambiguousTokens) throw new Error("campaign budget is below committed usage")
			const authority = this.budgetAuthority(id)
			const allocated = Object.values(s.campaigns).reduce((sum, campaign) => ({ micros: sum.micros + campaign.budgetLimitMicros, tokens: sum.tokens + campaign.budgetLimitTokens }), { micros: 0, tokens: 0 })
			if (!authority.available || allocated.micros - c.budgetLimitMicros + micros > authority.limitMicros || allocated.tokens - c.budgetLimitTokens + tokens > authority.limitTokens) throw new Error("repository budgets exceed authoritative Fleet allocation or broker authority is unavailable")
			if (c.budgetLimitMicros !== micros || c.budgetLimitTokens !== tokens) {
				c.budgetLimitMicros = micros; c.budgetLimitTokens = tokens; c.epoch += 1; this.event(s, id, "budget", now)
				if (this.isExhausted(c) && c.enabled) { c.enabled = false; c.epoch += 1; this.event(s, id, "budget-exhausted", now) }
			}
		}, now)
	}

	async start(id: string, now = new Date()): Promise<void> {
		this.requireDefinition(id)
		await this.update((s) => {
			const c = this.campaign(s, id)
			if (c.enabled) return
			const reasons = this.missingReadiness(this.requireDefinition(id), this.budgetAuthority(id), c, s)
			if (this.isExhausted(c)) reasons.push("campaign-budget-exhausted")
			if (reasons.length) throw new Error(`campaign is blocked: ${reasons.join(", ")}`)
			c.enabled = true; c.epoch += 1; this.event(s, id, "started", now)
		}, now)
	}

	async stop(id: string, now = new Date()): Promise<void> {
		this.requireDefinition(id)
		await this.update((s) => {
			const c = this.campaign(s, id)
			if (c.enabled) { c.enabled = false; c.epoch += 1; this.event(s, id, "stopped", now) }
			for (const job of s.jobs) if (job.campaignId === id && job.status === "queued") { job.status = "cancelled"; job.updatedAt = now.getTime() }
		}, now)
	}

	/**
	 * Linearize an upstream request start against Stop using the same durable
	 * campaign-state lock. The lock is released as soon as `start` returns its
	 * promise; an already-started request may finish and must still be settled.
	 */
	async withClaimRequestStart<T>(claim: ClaimedRepositoryJob, start: () => Promise<T>,
		beforeStart?: (start: () => Promise<T>, markStarted: (request: Promise<T>) => void) => Promise<void>): Promise<T> {
		if (!claim || typeof start !== "function") throw new Error("campaign request claim is invalid")
		const release = await this.lock()
		let pending: Promise<T> | undefined
		try {
			const state = await this.loadState(new Date())
			const job = state.jobs.find((candidate) => candidate.id === claim.job.id)
			const campaign = state.campaigns[claim.job.campaignId]
			if (!campaign?.enabled || campaign.epoch !== claim.epoch || !job || job.status !== "running" ||
				job.claimId !== claim.claimId || job.epoch !== claim.epoch) throw new Error("campaign request claim is stale or stopped")
			// Repository and Fleet admissions are both checked before invoking the
			// callback that starts the HTTP request. Keep the repository lock while
			// the Fleet v2 start transition is resolved, so Stop cannot slip between
			// the local epoch check and the actual request invocation.
			if (beforeStart) {
				await beforeStart(start, (request) => {
					if (pending) throw new Error("campaign request was started more than once")
					pending = request
					// The handoff may wait for its cross-process lock acknowledgement
					// after fetch has already returned a rejected promise. Attach a
					// rejection observer now; the original promise is still awaited
					// below once the dispatch lock is released.
					void request.catch(() => undefined)
				})
				if (!pending) throw new Error("campaign request-start did not invoke the request")
			} else pending = start()
		} finally {
			await release()
		}
		return await pending!
	}

	async assertClaimCurrent(claim: ClaimedRepositoryJob): Promise<void> {
		if (!claim) throw new Error("campaign claim is invalid")
		const release = await this.lock()
		try {
			const state = await this.loadState(new Date())
			const job = state.jobs.find((candidate) => candidate.id === claim.job.id)
			const campaign = state.campaigns[claim.job.campaignId]
			if (!campaign?.enabled || campaign.epoch !== claim.epoch || !job || job.status !== "running" ||
				job.claimId !== claim.claimId || job.epoch !== claim.epoch) throw new Error("campaign claim is stale or stopped")
		} finally { await release() }
	}

	/** Enqueue deduplicated advisory work; input is metadata only, never fetched or executed. */
	async enqueue(id: string, advisoryId: string, now = new Date()): Promise<RepositoryCampaignJob> {
		this.requireDefinition(id)
		if (!/^CVE-\d{4}-\d{4,12}$/.test(advisoryId)) throw new Error("advisory identifier is invalid")
		return this.update((s) => {
			const existing = s.jobs.find((job) => job.campaignId === id && job.advisoryId === advisoryId && job.status !== "cancelled")
			if (existing) return existing
			if (s.jobs.length >= MAX_JOBS) throw new Error("campaign job queue is full")
			const job: RepositoryCampaignJob = { id: randomUUID(), campaignId: id, advisoryId, status: "queued",
				epoch: this.campaign(s, id).epoch, createdAt: now.getTime(), updatedAt: now.getTime(), month: s.month,
				reservedMicros: 0, settledMicros: 0, reservedTokens: 0, settledTokens: 0 }
			s.jobs.push(job); return job
		}, now)
	}

	/** Reserve aggregate and per-campaign capacity before handing a job to a mock dispatcher. */
	async claimNext(id: string, reservation: { micros: number; tokens: number }, now = new Date(),
		mode: { executionKind: RepositoryJobProgress["executionKind"]; requiredSteps?: readonly RepositoryCampaignStep[] } = { executionKind: "development-checkpoint" }): Promise<ClaimedRepositoryJob | undefined> {
		this.requireDefinition(id)
		if (![reservation?.micros, reservation?.tokens].every((n) => Number.isSafeInteger(n) && n > 0)) throw new Error("reservation must include positive token and spend limits")
		const requiredSteps = mode.requiredSteps ?? REPOSITORY_CAMPAIGN_STEPS
		if ((mode.executionKind !== "development-checkpoint" && mode.executionKind !== "live-cve") ||
			requiredSteps.length !== REPOSITORY_CAMPAIGN_STEPS.length || requiredSteps.some((step, index) => step !== REPOSITORY_CAMPAIGN_STEPS[index])) {
			throw new Error("campaign worker progress profile is invalid")
		}
		if (mode.executionKind === "live-cve" && (this.readBudgetAuthority() as { mode?: string }).mode !== "fleet-v2") {
			throw new Error("live campaign claims require authoritative Fleet v2 registration")
		}
		return this.update((s) => {
			const c = this.campaign(s, id)
			const authority = this.budgetAuthority(id)
			if (!c.enabled || this.missingReadiness(this.requireDefinition(id), authority, c, s).length) return undefined
			if (this.isExhausted(c)) { c.enabled = false; c.epoch += 1; this.event(s, id, "budget-exhausted", now); return undefined }
			const totals = this.aggregateTotals(s)
			if (authority.committedMicros + totals.settledMicros + totals.reservedMicros + totals.ambiguousMicros + reservation.micros > authority.limitMicros ||
				authority.committedTokens + totals.settledTokens + totals.reservedTokens + totals.ambiguousTokens + reservation.tokens > authority.limitTokens ||
				c.settledMicros + c.reservedMicros + c.ambiguousMicros + reservation.micros > c.budgetLimitMicros ||
				c.settledTokens + c.reservedTokens + c.ambiguousTokens + reservation.tokens > c.budgetLimitTokens) return undefined
			const job = s.jobs.find((candidate) => candidate.campaignId === id && candidate.status === "queued")
			if (!job) return undefined
			const claimId = randomUUID()
			job.status = "running"; job.claimId = claimId; job.epoch = c.epoch; job.reservedMicros = reservation.micros; job.reservedTokens = reservation.tokens; job.updatedAt = now.getTime()
			job.progress = { executionKind: mode.executionKind, workerId: randomUUID(),
				goal: `Assess ${job.advisoryId} and prepare a verified review candidate`, currentTask: "Read registered advisory metadata",
				stage: "intake", completedSteps: [], requiredSteps: [...requiredSteps], lastActionAt: now.getTime(),
				heartbeatAt: now.getTime(), leaseExpiresAt: now.getTime() + REPOSITORY_WORKER_LEASE_MS,
				blocker: null, nextStep: "deduplicate", evidenceRefs: [] }
			c.reservedMicros += reservation.micros; c.reservedTokens += reservation.tokens; this.event(s, id, "claimed", now, job.id)
			return { job: { ...job }, claimId, epoch: c.epoch }
		}, now)
	}

	/** Persist coordinator progress under the same durable lock as the claim and budget. */
	async updateClaimProgress(claim: ClaimedRepositoryJob, patch: {
		stage: RepositoryCampaignStep; currentTask: string; completedSteps: RepositoryCampaignStep[];
		blocker?: string | null; nextStep?: string | null; evidenceRefs?: RepositoryEvidenceRef[]
	}, now = new Date()): Promise<void> {
		if (!claim || !patch || !REPOSITORY_CAMPAIGN_STEPS.includes(patch.stage) ||
			typeof patch.currentTask !== "string" || !patch.currentTask.trim() || patch.currentTask.length > 240 ||
			!Array.isArray(patch.completedSteps) || patch.completedSteps.length > REPOSITORY_CAMPAIGN_STEPS.length ||
			patch.completedSteps.some((step, index) => !REPOSITORY_CAMPAIGN_STEPS.includes(step) ||
				(index > 0 && REPOSITORY_CAMPAIGN_STEPS.indexOf(step) <= REPOSITORY_CAMPAIGN_STEPS.indexOf(patch.completedSteps[index - 1]!))) ||
			(patch.blocker !== undefined && patch.blocker !== null && (typeof patch.blocker !== "string" || patch.blocker.length > 240)) ||
			(patch.nextStep !== undefined && patch.nextStep !== null && (typeof patch.nextStep !== "string" || patch.nextStep.length > 240)) ||
			(patch.evidenceRefs !== undefined && (!Array.isArray(patch.evidenceRefs) || patch.evidenceRefs.length > 20 ||
				patch.evidenceRefs.some((ref) => !ref || !/^[a-f0-9]{64}$/.test(ref.id) ||
					!["intake", "candidate", "test-receipt", "delivery"].includes(ref.kind) ||
					typeof ref.label !== "string" || !ref.label.trim() || ref.label.length > 80)))) {
			throw new Error("campaign progress update is invalid")
		}
		await this.update((s) => {
			const job = s.jobs.find((candidate) => candidate.id === claim.job.id)
			if (!job || job.status !== "running" || job.claimId !== claim.claimId || job.epoch !== claim.epoch || !job.progress) throw new Error("campaign claim is stale")
			if (now.getTime() > job.progress.leaseExpiresAt) throw new Error("campaign worker lease expired")
			const old = job.progress
			if (patch.completedSteps.some((step) => !old.requiredSteps.includes(step)) ||
				old.completedSteps.some((step, index) => patch.completedSteps[index] !== step)) throw new Error("campaign progress cannot forget completed steps")
			const refs = patch.evidenceRefs ?? old.evidenceRefs
			if (refs.length < old.evidenceRefs.length || old.evidenceRefs.some((item, index) => JSON.stringify(refs[index]) !== JSON.stringify(item))) throw new Error("campaign evidence cannot be removed or changed")
			job.progress = { ...old, stage: patch.stage, currentTask: patch.currentTask,
				completedSteps: [...patch.completedSteps], lastActionAt: now.getTime(), heartbeatAt: now.getTime(),
				leaseExpiresAt: now.getTime() + REPOSITORY_WORKER_LEASE_MS,
				blocker: patch.blocker === undefined ? old.blocker : patch.blocker,
				nextStep: patch.nextStep === undefined ? old.nextStep : patch.nextStep,
				evidenceRefs: structuredClone(refs) }
			job.updatedAt = now.getTime()
		}, now)
	}

	async heartbeat(claim: ClaimedRepositoryJob, now = new Date()): Promise<void> {
		await this.update((s) => {
			const job = s.jobs.find((candidate) => candidate.id === claim?.job?.id)
			if (!job || job.status !== "running" || job.claimId !== claim.claimId || job.epoch !== claim.epoch || !job.progress) throw new Error("campaign claim is stale")
			if (now.getTime() > job.progress.leaseExpiresAt) throw new Error("campaign worker lease expired")
			job.progress.heartbeatAt = now.getTime()
			job.progress.leaseExpiresAt = now.getTime() + REPOSITORY_WORKER_LEASE_MS
			job.updatedAt = now.getTime()
		}, now)
	}

	/** Test-only synthetic execution seam; production never supplies a dispatcher. */
	async dispatchMockNext(id: string, reservation: { micros: number; tokens: number }, dispatcher: MockRepositoryDispatcher,
		now = new Date()): Promise<RepositoryCampaignJob | undefined> {
		if (typeof dispatcher !== "function") throw new Error("mock dispatcher is required")
		const claim = await this.claimNext(id, reservation, now)
		if (!claim) return undefined
		let timer: NodeJS.Timeout | undefined
		try {
			const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("mock dispatch timed out")), MOCK_DISPATCH_TIMEOUT_MS) })
			const result = await Promise.race([dispatcher(claim.job), timeout])
			await this.finish(claim, result, now)
		} catch {
			await this.finish(claim, { status: "ambiguous" }, now)
		} finally { if (timer) clearTimeout(timer) }
		return (await this.read(now)).jobs.find((job) => job.id === claim.job.id)
	}

	/** Settle only a matching claim in the same ON epoch; an uncertain result remains charged. */
	async finish(claim: ClaimedRepositoryJob, result: { status: "succeeded" | "failed" | "ambiguous"; actualMicros?: number; actualTokens?: number }, now = new Date()): Promise<void> {
		if (!claim || !claim.job || !["succeeded", "failed", "ambiguous"].includes(result.status) ||
			(result.actualMicros !== undefined && (!Number.isSafeInteger(result.actualMicros) || result.actualMicros < 0)) ||
			(result.actualTokens !== undefined && (!Number.isSafeInteger(result.actualTokens) || result.actualTokens < 0))) throw new Error("campaign result is invalid")
		await this.update((s) => {
			const job = s.jobs.find((candidate) => candidate.id === claim.job.id)
			if (!job || job.status !== "running" || job.claimId !== claim.claimId || job.epoch !== claim.epoch) throw new Error("campaign claim is stale")
			const c = this.campaign(s, job.campaignId)
			c.reservedMicros -= job.reservedMicros; c.reservedTokens -= job.reservedTokens
			if (result.status === "ambiguous") {
				job.status = "ambiguous"; job.settledMicros = job.reservedMicros; job.settledTokens = job.reservedTokens
				c.ambiguousMicros += job.reservedMicros; c.ambiguousTokens += job.reservedTokens
			} else {
				const actual = result.actualMicros ?? 0
				const tokens = result.actualTokens ?? 0
				if (actual > job.reservedMicros || tokens > job.reservedTokens) throw new Error("actual usage exceeds reservation")
				job.status = result.status; job.settledMicros = actual; job.settledTokens = tokens
				c.settledMicros += actual; c.settledTokens += tokens
			}
			job.reservedMicros = 0; job.reservedTokens = 0; job.updatedAt = now.getTime()
			if (job.progress) {
				job.progress.lastActionAt = now.getTime()
				job.progress.heartbeatAt = now.getTime()
				job.progress.leaseExpiresAt = now.getTime()
				job.progress.currentTask = result.status === "succeeded" ? "Worker completed; review the recorded result" :
					result.status === "failed" ? "Worker stopped after an unsuccessful result" : "Worker result needs reconciliation"
				job.progress.nextStep = result.status === "succeeded" ? null : "reconcile recorded result before retry"
				job.progress.blocker = result.status === "succeeded" ? null : "Result requires review before any retry"
			}
			if (this.isExhausted(c) && c.enabled) { c.enabled = false; c.epoch += 1; this.event(s, job.campaignId, "budget-exhausted", now) }
			this.event(s, job.campaignId, "completed", now, job.id)
		}, now)
	}

	/** Reclassify a recovered ambiguous hold only after an authoritative bridge receipt was verified. */
	async settleRecoveredClaim(claim: ClaimedRepositoryJob,
		result: { status: "succeeded" | "failed"; actualMicros: number; actualTokens: number }, now = new Date()): Promise<void> {
		if (!claim || !claim.job || !["succeeded", "failed"].includes(result.status) ||
			![result.actualMicros, result.actualTokens].every((n) => Number.isSafeInteger(n) && n >= 0)) {
			throw new Error("recovered campaign settlement is invalid")
		}
		await this.update((s) => {
			const job = s.jobs.find((candidate) => candidate.id === claim.job.id)
			if (!job || job.claimId !== claim.claimId || job.epoch !== claim.epoch) throw new Error("campaign claim is stale")
			if (job.status === result.status && job.settledMicros === result.actualMicros && job.settledTokens === result.actualTokens) return
			if (job.status !== "ambiguous") throw new Error("campaign claim is not a recovered ambiguous job")
			const heldMicros = job.settledMicros
			const heldTokens = job.settledTokens
			const c = this.campaign(s, job.campaignId)
			if (result.actualMicros > heldMicros || result.actualTokens > heldTokens ||
				c.ambiguousMicros < heldMicros || c.ambiguousTokens < heldTokens) throw new Error("recovered usage exceeds its ambiguous reservation")
			c.ambiguousMicros -= heldMicros; c.ambiguousTokens -= heldTokens
			c.settledMicros += result.actualMicros; c.settledTokens += result.actualTokens
			job.status = result.status; job.settledMicros = result.actualMicros; job.settledTokens = result.actualTokens; job.updatedAt = now.getTime()
			if (this.isExhausted(c) && c.enabled) { c.enabled = false; c.epoch += 1; this.event(s, job.campaignId, "budget-exhausted", now) }
			this.event(s, job.campaignId, "completed", now, job.id)
		}, now)
	}

	/** A lost process never causes an automatic replay of a claimed job. */
	async recoverInterrupted(now = new Date()): Promise<number> {
		return this.update((s) => {
			let count = 0
			for (const job of s.jobs) if (job.status === "running") {
				const c = this.campaign(s, job.campaignId)
				c.reservedMicros -= job.reservedMicros; c.reservedTokens -= job.reservedTokens
				c.ambiguousMicros += job.reservedMicros; c.ambiguousTokens += job.reservedTokens
				job.status = "ambiguous"; job.settledMicros = job.reservedMicros; job.settledTokens = job.reservedTokens
				job.reservedMicros = 0; job.reservedTokens = 0; job.updatedAt = now.getTime(); count += 1
				if (this.isExhausted(c) && c.enabled) { c.enabled = false; c.epoch += 1; this.event(s, job.campaignId, "budget-exhausted", now) }
				this.event(s, job.campaignId, "interrupted", now, job.id)
			}
			return count
		}, now)
	}

	private requireDefinition(id: string): RepositoryCampaignDefinition {
		const value = this.definitions.get(id)
		if (!value) throw new Error("repository campaign is not registered")
		return value
	}
	private validBudget(micros: number, tokens: number): void {
		if (!Number.isSafeInteger(micros) || micros < 0 || micros > REPOSITORY_CAMPAIGN_BUDGET_CAP_MICROS ||
			!Number.isSafeInteger(tokens) || tokens < 0 || tokens > REPOSITORY_CAMPAIGN_BUDGET_CAP_TOKENS) throw new Error("budget is outside the permitted range")
	}
	private budgetAuthority(campaignId?: string): RepositoryBudgetAuthority {
		const authority = this.readBudgetAuthority(campaignId)
		if (!authority || !["synthetic-test", "fleet-v2"].includes(authority.mode) || typeof authority.available !== "boolean" || !Number.isSafeInteger(authority.limitMicros) || authority.limitMicros < 0 || authority.limitMicros > REPOSITORY_CAMPAIGN_BUDGET_CAP_MICROS ||
			!Number.isSafeInteger(authority.limitTokens) || authority.limitTokens < 0 || authority.limitTokens > REPOSITORY_CAMPAIGN_BUDGET_CAP_TOKENS ||
			![authority.committedMicros, authority.committedTokens].every((n) => Number.isSafeInteger(n) && n >= 0)) throw new Error("authoritative Fleet budget is unavailable")
		if (authority.mode === "fleet-v2" && (!Number.isSafeInteger(authority.asOfMs) || Date.now() - Number(authority.asOfMs) > 60_000 || Number(authority.asOfMs) > Date.now() + 60_000 ||
			!Number.isSafeInteger(authority.controlEpoch) || Number(authority.controlEpoch) < 0 || !Number.isSafeInteger(authority.repositoryEpoch) || Number(authority.repositoryEpoch) < 0 ||
			authority.campaignId !== "fleet-security-watch" || !authority.runId || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(authority.runId) ||
			!Number.isSafeInteger(authority.runExpiresAtMs) || Number(authority.asOfMs) >= Number(authority.runExpiresAtMs) ||
			Date.now() >= Number(authority.runExpiresAtMs) || !authority.repositoryCampaignId || !authority.repositoryId ||
			!authority.repository || !authority.sourceRevision || !authority.policySha256 || !authority.model || !authority.profileId ||
			typeof authority.globalEnabled !== "boolean" || typeof authority.canAdmit !== "boolean" || typeof authority.repositoryEnabled !== "boolean" ||
			!authority.monthly || !authority.campaignLifetime || !authority.legacyLifetime || !authority.repositoryLifetime ||
			!validMonthlySnapshot(authority.monthly) || !validLifetimeSnapshot(authority.campaignLifetime, REPOSITORY_CAMPAIGN_BUDGET_CAP_MICROS, REPOSITORY_CAMPAIGN_BUDGET_CAP_TOKENS) ||
			!validLifetimeSnapshot(authority.legacyLifetime) || !validLifetimeSnapshot(authority.repositoryLifetime, undefined, undefined, true) ||
			!validId(authority.repositoryId) || !/^[A-Za-z0-9_.-]{1,39}\/[A-Za-z0-9_.-]{1,100}$/.test(authority.repository) ||
			!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(authority.sourceRevision) || !/^[a-f0-9]{64}$/.test(authority.policySha256) ||
			!validId(authority.profileId) ||
			authority.limitMicros !== REPOSITORY_CAMPAIGN_BUDGET_CAP_MICROS || authority.limitTokens !== REPOSITORY_CAMPAIGN_BUDGET_CAP_TOKENS ||
			authority.committedMicros !== authority.legacyLifetime.settledMicros + authority.legacyLifetime.reservedMicros + authority.legacyLifetime.ambiguousMicros ||
			authority.committedTokens !== authority.legacyLifetime.settledTokens + authority.legacyLifetime.reservedTokens + authority.legacyLifetime.ambiguousTokens ||
			authority.available !== (authority.globalEnabled === true && authority.canAdmit === true && authority.repositoryEnabled === true &&
				authority.monthly.settledMicros + authority.monthly.reservedMicros + authority.monthly.ambiguousMicros < authority.monthly.limitMicros &&
				authority.campaignLifetime.settledMicros + authority.campaignLifetime.reservedMicros + authority.campaignLifetime.ambiguousMicros < authority.limitMicros &&
				authority.campaignLifetime.settledTokens + authority.campaignLifetime.reservedTokens + authority.campaignLifetime.ambiguousTokens < authority.limitTokens &&
				authority.repositoryLifetime.settledMicros + authority.repositoryLifetime.reservedMicros + authority.repositoryLifetime.ambiguousMicros < authority.repositoryLifetime.limitMicros &&
				authority.repositoryLifetime.settledTokens + authority.repositoryLifetime.reservedTokens + authority.repositoryLifetime.ambiguousTokens < authority.repositoryLifetime.limitTokens) ||
			campaignId !== undefined && (authority.repositoryCampaignId !== campaignId || authority.sourceRevision !== this.requireDefinition(campaignId).sourceRevision ||
				authority.model !== this.requireDefinition(campaignId).model))) {
			throw new Error("Fleet v2 repository budget snapshot is invalid")
		}
		return authority
	}
	private campaign(s: CampaignState, id: string): CampaignRecord {
		return s.campaigns[id] ?? (s.campaigns[id] = this.initialCampaign())
	}
	private initialCampaign(): CampaignRecord {
		return { enabled: false, epoch: 0, budgetLimitMicros: 0, budgetLimitTokens: 0, settledMicros: 0, reservedMicros: 0, ambiguousMicros: 0, settledTokens: 0, reservedTokens: 0, ambiguousTokens: 0 }
	}
	private aggregateTotals(s: CampaignState): Pick<CampaignRecord, "settledMicros" | "reservedMicros" | "ambiguousMicros" | "settledTokens" | "reservedTokens" | "ambiguousTokens"> {
		return Object.values(s.campaigns).reduce((sum, c) => ({ settledMicros: sum.settledMicros + c.settledMicros, reservedMicros: sum.reservedMicros + c.reservedMicros,
			ambiguousMicros: sum.ambiguousMicros + c.ambiguousMicros, settledTokens: sum.settledTokens + c.settledTokens,
			reservedTokens: sum.reservedTokens + c.reservedTokens, ambiguousTokens: sum.ambiguousTokens + c.ambiguousTokens }),
		{ settledMicros: 0, reservedMicros: 0, ambiguousMicros: 0, settledTokens: 0, reservedTokens: 0, ambiguousTokens: 0 })
	}
	private missingReadiness(definition: RepositoryCampaignDefinition, authority: RepositoryBudgetAuthority, campaign: CampaignRecord, state: CampaignState): string[] {
		const q = definition.qualification
		const missing: string[] = []
		if (!definition.sourceRevision || !q.sourceAudited) missing.push("audited-private-source")
		if (!definition.workerProfile || !q.workerQualified) missing.push("qualified-worker")
		if (!definition.recipeDigest || !q.recipeQualified) missing.push("reviewed-recipe")
		if (!definition.evaluatorDigest || !q.evaluatorQualified) missing.push("independent-evaluator")
		if (!definition.model || !q.modelApproved) missing.push("approved-exact-model")
		if (!definition.dataAccessProfile || !q.dataApproved) missing.push("approved-data-destination")
		if (!q.accessApproved) missing.push("operation-specific-access")
		if (!authority.available) missing.push("authoritative-broker-budget")
		const allocations = Object.values(state.campaigns).reduce((sum, c) => ({ micros: sum.micros + c.budgetLimitMicros, tokens: sum.tokens + c.budgetLimitTokens }), { micros: 0, tokens: 0 })
		if (allocations.micros > authority.limitMicros || allocations.tokens > authority.limitTokens) missing.push("aggregate-budget-allocation")
		const totals = this.aggregateTotals(state)
		if (authority.available && (authority.committedMicros + totals.settledMicros + totals.reservedMicros + totals.ambiguousMicros >= authority.limitMicros ||
			authority.committedTokens + totals.settledTokens + totals.reservedTokens + totals.ambiguousTokens >= authority.limitTokens)) missing.push("aggregate-budget-exhausted")
		if (campaign.budgetLimitMicros <= 0 || campaign.budgetLimitTokens <= 0) missing.push("finite-token-and-spend-allocation")
		return missing
	}
	private isExhausted(campaign: CampaignRecord): boolean {
		return (campaign.budgetLimitMicros > 0 && campaign.settledMicros + campaign.reservedMicros + campaign.ambiguousMicros >= campaign.budgetLimitMicros) ||
			(campaign.budgetLimitTokens > 0 && campaign.settledTokens + campaign.reservedTokens + campaign.ambiguousTokens >= campaign.budgetLimitTokens)
	}
	private campaignState(id: string, campaign: CampaignRecord, missing: string[], exhausted: boolean, jobs: RepositoryCampaignJob[]): string {
		if (missing.includes("operation-specific-access")) return "blocked-access"
		if (missing.some((reason) => reason !== "aggregate-budget-exhausted")) return "blocked-prerequisite"
		if (exhausted || missing.includes("aggregate-budget-exhausted")) return "budget-exhausted"
		if (!campaign.enabled) return "stopped"
		if (jobs.some((job) => job.campaignId === id && job.status === "running")) return "running"
		return jobs.some((job) => job.campaignId === id && job.status === "queued") ? "ready" : "waiting"
	}
	private event(s: CampaignState, id: string, action: Exclude<CampaignState["history"][number]["action"], "drafted" | "configured">, now: Date, jobId?: string): void {
		s.history.push({ at: now.getTime(), campaignId: id, action, epoch: this.campaign(s, id).epoch, ...(jobId ? { jobId } : {}) })
		if (s.history.length > MAX_HISTORY) s.history.splice(0, s.history.length - MAX_HISTORY)
	}
	private draftEvent(s: CampaignState, id: string, action: "drafted" | "configured", now: Date): void {
		s.history.push({ at: now.getTime(), campaignId: id, action, epoch: 0 })
		if (s.history.length > MAX_HISTORY) s.history.splice(0, s.history.length - MAX_HISTORY)
	}
	private async read(now: Date): Promise<CampaignState> {
		return this.update((s) => {
			for (const [id] of Object.entries(s.campaigns)) if (!this.definitions.has(id)) throw new Error("state references an unregistered repository campaign")
			s.month = monthNow(now)
			return structuredClone(s)
		}, now)
	}
	private async update<T>(mutate: (s: CampaignState) => T, now: Date): Promise<T> {
		const release = await this.lock()
		try {
			const s = await this.loadState(now)
			if (s.month !== monthNow(now)) s.month = monthNow(now)
			for (const id of this.definitions.keys()) if (!s.campaigns[id]) s.campaigns[id] = this.initialCampaign()
			const result = mutate(s)
			await this.write(s)
			return result
		} finally { await release() }
	}
	private async loadState(now: Date): Promise<CampaignState> {
		let s: CampaignState
		try {
			const st = await fs.lstat(this.path)
			if (!st.isFile() || st.isSymbolicLink() || st.size > 1024 * 1024 || (typeof process.getuid === "function" && st.uid !== process.getuid())) throw new Error("repository campaign state is not a bounded owner file")
			s = JSON.parse(await fs.readFile(this.path, "utf8"))
			if (!validateState(s)) throw new Error("repository campaign state failed schema validation")
		} catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; s = blankState(now) }
		if (s.month !== monthNow(now)) s.month = monthNow(now)
		for (const id of this.definitions.keys()) if (!s.campaigns[id]) s.campaigns[id] = this.initialCampaign()
		return s
	}
	private async lock(): Promise<() => Promise<void>> {
		const parent = path.dirname(this.path)
		await fs.mkdir(parent, { recursive: true, mode: 0o700 })
		const p = await fs.lstat(parent)
		if (!p.isDirectory() || p.isSymbolicLink() || (p.mode & 0o077) !== 0 || (typeof process.getuid === "function" && p.uid !== process.getuid())) throw new Error("repository campaign root must be private and owner controlled")
		for (let i = 0; i < 100; i++) {
			try {
				const f = await fs.open(this.lockPath, "wx", 0o600); await f.writeFile(`${process.pid}\n`)
				return async () => { await f.close(); await fs.rm(this.lockPath, { force: true }) }
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
				const owner = Number((await fs.readFile(this.lockPath, "utf8").catch(() => "")).trim())
				let alive = Number.isSafeInteger(owner) && owner > 0
				if (alive) try { process.kill(owner, 0) } catch (e) { alive = (e as NodeJS.ErrnoException).code === "EPERM" }
				if (!alive) { const stale = `${this.lockPath}.stale.${randomUUID()}`; await fs.rename(this.lockPath, stale).catch(() => undefined); await fs.rm(stale, { force: true }).catch(() => undefined); continue }
				await new Promise((resolve) => setTimeout(resolve, 10 + i))
			}
		}
		throw new Error("repository campaign state is busy")
	}
	private async write(s: CampaignState): Promise<void> {
		const tmp = `${this.path}.tmp.${process.pid}.${randomUUID()}`
		const f = await fs.open(tmp, constants.constants.O_CREAT | constants.constants.O_EXCL | constants.constants.O_WRONLY, 0o600)
		try { await f.writeFile(`${JSON.stringify(s, null, 2)}\n`); await f.sync() } finally { await f.close() }
		await fs.rename(tmp, this.path)
		const dir = await fs.open(path.dirname(this.path), "r"); try { await dir.sync() } finally { await dir.close() }
	}
}
