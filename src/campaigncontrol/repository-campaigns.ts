import * as fs from "node:fs/promises"
import { validPrivateBoardRef } from "./repository-board-reference.js"
import * as constants from "node:fs"
import * as path from "node:path"
import { randomUUID } from "node:crypto"
import { CURL_CAMPAIGN_ID, CURL_DEBIAN_AFFECTED_RANGE, CURL_DEBIAN_FIXED_REVISION, CURL_DEBIAN_INTRODUCED_REVISION,
	CURL_DEBIAN_PUBLIC_BASE_REVISION, CURL_DEBIAN_SNAPSHOT_SHA256, CURL_DEBIAN_SOURCE_HTML_SHA256, CURL_DEBIAN_SOURCE_URL,
	CURL_FIXED_ADVISORY } from "./repository-known-advisory.js"
import { CURL_REPAIR_CAMPAIGN_ID, CURL_REPAIR_V2_CAMPAIGN_ID } from "./repository-campaign-ids.js"
import { CURL_REPAIR_EVALUATOR_DIGEST, CURL_REPAIR_POLICY_SHA256, CURL_REPAIR_PROFILE_ID, CURL_REPAIR_RECIPE_DIGEST, CURL_REPAIR_SOURCE_REVISION,
	CURL_REPAIR_REPOSITORY_ID, CURL_REPAIR_RESERVATION, CURL_REPAIR_TARGET_REPOSITORY } from "./repository-curl-repair.js"
import { CURL_REPAIR_V2_EVALUATOR_DIGEST, CURL_REPAIR_V2_POLICY_SHA256, CURL_REPAIR_V2_PROFILE_ID,
	CURL_REPAIR_V2_RECIPE_DIGEST, CURL_REPAIR_V2_REPOSITORY_ID,
	CURL_REPAIR_V2_RESERVATION } from "./repository-curl-repair-v2-profile.js"

export const REPOSITORY_CAMPAIGN_BUDGET_CAP_MICROS = 5_000_000
// Keeps the mock subcap within the existing fixed Fleet campaign's 108k-token ceiling.
export const REPOSITORY_CAMPAIGN_BUDGET_CAP_TOKENS = 108_000
const MAX_CAMPAIGNS = 32
const MAX_JOBS = 500
const MAX_INTAKE_RECORDS = 5_000
const MAX_HISTORY = 200
const MOCK_DISPATCH_TIMEOUT_MS = 30_000
export const REPOSITORY_WORKER_LEASE_MS = 120_000
export const REPOSITORY_PROGRESS_FRESH_MS = 60_000
export const REPOSITORY_CAMPAIGN_STEPS = ["intake", "deduplicate", "investigate", "prepare-candidate", "verify", "deliver"] as const
export type RepositoryCampaignStep = typeof REPOSITORY_CAMPAIGN_STEPS[number]

export interface RepositoryEvidenceRef {
	id: string
	kind: "intake" | "candidate" | "test-receipt" | "delivery" | "diagnostic" | "no-call-proof" | "billing-proof"
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
	/** Fixed local Agent Board result reference, present only after verified private delivery. */
	boardRef?: string | null
}


export interface RepositoryCampaignDefinition {
	id: string
	name: string
	repositoryId?: string
	repository?: string
	sourceRevision: string | null
	policySha256?: string
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
	mode: "synthetic-test" | "fleet-v2" | "fleet-v2-readonly" | "fleet-v2-budget-only" | "unavailable"
	available: boolean
	snapshotOnly?: boolean
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
	runId?: string | null
	runExpiresAtMs?: number | null
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
	purpose?: "qualification" | "repair"
	/** Explicit owner-authorized lineage for the verified Curl no-call and historical repair retry paths. */
	retryOf?: string
}

type ObservedAdvisoryInput = { campaignId: string; publicBaseRevision: string; advisoryId: string; snapshotSha256: string; eligible: boolean }
type RepositoryProgressUpdate = {
	stage: RepositoryCampaignStep; currentTask: string; completedSteps: RepositoryCampaignStep[];
	blocker?: string | null; nextStep?: string | null; evidenceRefs?: RepositoryEvidenceRef[]; boardRef?: string | null
}
type RepositoryFinishProgress = { currentTask?: string; blocker?: string | null; nextStep?: string | null; boardRef?: string | null }
type RepositoryFinishResult = { status: "succeeded" | "failed" | "ambiguous"; actualMicros?: number; actualTokens?: number; progress?: RepositoryFinishProgress }
type RecoveredFinishResult = { status: "succeeded" | "failed"; actualMicros: number; actualTokens: number;
	proofSha256?: string; proofKind?: "no-call-proof" | "billing-proof" }

export interface RepositoryAdvisoryIntakeRecord {
	campaignId: string
	publicBaseRevision: string
	advisoryId: string
	snapshotSha256: string
	disposition: "eligible" | "unsupported-profile"
	firstSeenAt: number
	lastSeenAt: number
	jobId: string | null
	source?: "osv-commit-query" | "debian-tracker-snapshot" | "debian-tracker-repair-snapshot" | "debian-tracker-repair-v2-snapshot"
	sourceUrl?: string
	sourceContentSha256?: string
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
	intakeRecords: RepositoryAdvisoryIntakeRecord[]
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

function includeSnapshotLimits(spendLimit: number | undefined, allowLimits: boolean): boolean { return allowLimits || spendLimit !== undefined }

function hasExactLifetimeLimits(row: Record<string, unknown>, spendLimit: number, tokenLimit?: number): boolean {
	return Number.isSafeInteger(row.limitMicros) && Number(row.limitMicros) === spendLimit &&
		Number.isSafeInteger(row.limitTokens) && Number(row.limitTokens) === tokenLimit
}

function hasCappedLifetimeLimits(row: Record<string, unknown>): boolean {
	const spend = Number.isSafeInteger(row.limitMicros) && Number(row.limitMicros) >= 0 && Number(row.limitMicros) <= REPOSITORY_CAMPAIGN_BUDGET_CAP_MICROS
	const tokens = Number.isSafeInteger(row.limitTokens) && Number(row.limitTokens) >= 0 && Number(row.limitTokens) <= REPOSITORY_CAMPAIGN_BUDGET_CAP_TOKENS
	return spend && tokens
}

function validLifetimeSnapshot(value: unknown, spendLimit?: number, tokenLimit?: number, allowLimits = false): boolean {
	if (!validUsageCounters(value, includeSnapshotLimits(spendLimit, allowLimits))) return false
	const row = value as Record<string, unknown>
	if (spendLimit !== undefined) return hasExactLifetimeLimits(row, spendLimit, tokenLimit)
	if (allowLimits) return hasCappedLifetimeLimits(row)
	return !Object.hasOwn(value, "limitMicros") && !Object.hasOwn(value, "limitTokens")
}

function validMonthlySnapshot(value: unknown): boolean {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false
	const row = value as Record<string, unknown>
	return Object.keys(value).sort().join(",") === "ambiguousMicros,limitMicros,month,reservedMicros,settledMicros" &&
		typeof row.month === "string" && row.month === monthNow(new Date()) &&
		Number.isSafeInteger(row.limitMicros) && Number(row.limitMicros) > 0 && Number(row.limitMicros) <= 5_000_000 &&
		["settledMicros", "reservedMicros", "ambiguousMicros"].every((key) => Number.isSafeInteger(row[key]) && Number(row[key]) >= 0)
}

function isPrivateDefinitionFile(stat: Awaited<ReturnType<typeof fs.lstat>>): boolean {
	const owner = typeof process.getuid !== "function" || stat.uid === process.getuid()
	return stat.isFile() && !stat.isSymbolicLink() && stat.size <= 64 * 1024 && (Number(stat.mode) & 0o077) === 0 && owner
}

function isPrivateDefinitionDirectory(stat: Awaited<ReturnType<typeof fs.lstat>>): boolean {
	const owner = typeof process.getuid !== "function" || stat.uid === process.getuid()
	return stat.isDirectory() && !stat.isSymbolicLink() && (Number(stat.mode) & 0o077) === 0 && owner
}

async function readDefinitionRegistry(filePath: string): Promise<unknown> {
	const stat = await fs.lstat(filePath)
	const parent = await fs.lstat(path.dirname(filePath))
	if (!isPrivateDefinitionFile(stat) || !isPrivateDefinitionDirectory(parent)) throw new Error("repository campaign registry must be a bounded owner-only file")
	return JSON.parse(await fs.readFile(filePath, "utf8")) as unknown
}

function parseDefinitionRows(value: unknown): RepositoryCampaignDefinition[] {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("repository campaign registry failed schema validation")
	const registry = value as Record<string, unknown>
	const keysValid = Object.keys(registry).sort().join(",") === "repositories,schemaVersion" && registry.schemaVersion === 1
	if (!keysValid || !Array.isArray(registry.repositories) || registry.repositories.length > MAX_CAMPAIGNS) throw new Error("repository campaign registry failed schema validation")
	const definitions = registry.repositories as RepositoryCampaignDefinition[]
	const ids = new Set<string>()
	for (const definition of definitions) {
		validateDefinition(definition)
		if (ids.has(definition.id)) throw new Error("duplicate repository campaign definition")
		ids.add(definition.id)
	}
	return definitions
}

export async function loadRepositoryCampaignDefinitions(filePath: string): Promise<RepositoryCampaignDefinition[]> {
	try { return parseDefinitionRows(await readDefinitionRegistry(filePath)) }
	catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return []
		throw error
	}
}

function validId(value: unknown): value is string {
	return typeof value === "string" && /^[a-z0-9][a-z0-9-]{1,62}$/.test(value) &&
		!new Set(["constructor", "prototype", "tostring", "valueof", "hasownproperty", "__proto__"]).has(value)
}
function validAdvisoryId(value: unknown): value is string {
	return typeof value === "string" && /^(?:CVE-\d{4}-\d{4,12}|GHSA-[23456789cfghjmpqrvwx-]{4}-[23456789cfghjmpqrvwx-]{4}-[23456789cfghjmpqrvwx-]{4}|PYSEC-\d{4}-\d+|RUSTSEC-\d{4}-\d+)$/.test(value)
}
function validAdvisorySourceUrl(value: unknown): value is string {
	if (typeof value !== "string" || value.length > 512) return false
	try {
		const url = new URL(value)
		return url.protocol === "https:" && ["osv.dev", "security-tracker.debian.org", "nvd.nist.gov"].includes(url.hostname) &&
			!url.username && !url.password && !url.search && !url.hash
	} catch { return false }
}
function monthNow(date: Date): string { return date.toISOString().slice(0, 7) }

function blankState(now: Date): CampaignState {
	return { schemaVersion: 1, month: monthNow(now), campaigns: {}, drafts: {}, jobs: [], intakeRecords: [], history: [] }
}

function validDefinitionShape(definition: RepositoryCampaignDefinition): boolean {
	const shapes = ["dataAccessProfile,evaluatorDigest,id,model,name,qualification,recipeDigest,sourceRevision,workerProfile",
		"dataAccessProfile,evaluatorDigest,id,model,name,policySha256,qualification,recipeDigest,sourceRevision,workerProfile",
		"dataAccessProfile,evaluatorDigest,id,model,name,qualification,recipeDigest,repository,repositoryId,sourceRevision,workerProfile",
		"dataAccessProfile,evaluatorDigest,id,model,name,policySha256,qualification,recipeDigest,repository,repositoryId,sourceRevision,workerProfile"]
	return !!definition && typeof definition === "object" && shapes.includes(Object.keys(definition).sort().join(","))
}

function validDefinitionNames(definition: RepositoryCampaignDefinition): boolean {
	return validId(definition.id) && typeof definition.name === "string" && !!definition.name.trim() && definition.name.length <= 100
}

function validDefinitionRepository(definition: RepositoryCampaignDefinition): boolean {
	const id = definition.repositoryId === undefined || validId(definition.repositoryId)
	const repository = definition.repository === undefined || (typeof definition.repository === "string" && /^[A-Za-z0-9_.-]{1,39}\/[A-Za-z0-9_.-]{1,100}$/.test(definition.repository))
	return id && repository
}

function validDefinitionRefs(definition: RepositoryCampaignDefinition): boolean {
	const values = [definition.sourceRevision, definition.workerProfile, definition.recipeDigest, definition.evaluatorDigest, definition.model, definition.dataAccessProfile]
	return values.every((value) => value === null || (typeof value === "string" && value.length <= 160))
}

function validDefinitionHashes(definition: RepositoryCampaignDefinition): boolean {
	const revision = definition.sourceRevision === null || /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(definition.sourceRevision)
	const recipe = definition.recipeDigest === null || /^[a-f0-9]{64}$/.test(definition.recipeDigest)
	const evaluator = definition.evaluatorDigest === null || /^[a-f0-9]{64}$/.test(definition.evaluatorDigest)
	const policy = definition.policySha256 === undefined || /^[a-f0-9]{64}$/.test(definition.policySha256)
	return revision && recipe && evaluator && policy
}

function validDefinitionQualification(definition: RepositoryCampaignDefinition): boolean {
	const q = definition.qualification
	return !!q && Object.keys(q).sort().join(",") === "accessApproved,dataApproved,evaluatorQualified,modelApproved,recipeQualified,sourceAudited,workerQualified" &&
		Object.values(q).every((value) => typeof value === "boolean")
}

function validateDefinition(definition: RepositoryCampaignDefinition): void {
	if (!validDefinitionShape(definition) || !validDefinitionNames(definition) || !validDefinitionRepository(definition) ||
		!validDefinitionRefs(definition) || !validDefinitionHashes(definition) || !validDefinitionQualification(definition)) {
		throw new Error("repository campaign definition is invalid")
	}
}

function validStateKeys(s: Partial<CampaignState>): boolean {
	const allowed = ["campaigns,drafts,history,jobs,month,schemaVersion", "campaigns,drafts,history,intakeRecords,jobs,month,schemaVersion"]
	return allowed.includes(Object.keys(s as object).sort().join(",")) && s.schemaVersion === 1
}

function validStateCampaigns(s: Partial<CampaignState>): boolean {
	return !!s.campaigns && typeof s.campaigns === "object" && !Array.isArray(s.campaigns) && Object.keys(s.campaigns).length <= MAX_CAMPAIGNS
}

function validStateDrafts(s: Partial<CampaignState>): boolean {
	return !!s.drafts && typeof s.drafts === "object" && !Array.isArray(s.drafts) && Object.keys(s.drafts).length <= MAX_CAMPAIGNS
}

function validStateArrays(s: Partial<CampaignState>): boolean {
	const jobs = Array.isArray(s.jobs) && s.jobs.length <= MAX_JOBS
	const history = Array.isArray(s.history) && s.history.length <= MAX_HISTORY
	const intake = s.intakeRecords === undefined || (Array.isArray(s.intakeRecords) && s.intakeRecords.length <= MAX_INTAKE_RECORDS)
	return jobs && history && intake
}

function validStateCollections(s: Partial<CampaignState>): boolean {
	return validStateCampaigns(s) && validStateDrafts(s) && validStateArrays(s)
}

function validStateEnvelope(s: Partial<CampaignState>): boolean {
	return validStateKeys(s) && typeof s.month === "string" && /^\d{4}-(0[1-9]|1[0-2])$/.test(s.month) && validStateCollections(s)
}

function validCampaignRecord(id: string, record: CampaignRecord): boolean {
	const counters = [record.budgetLimitMicros, record.budgetLimitTokens, record.settledMicros, record.reservedMicros,
		record.ambiguousMicros, record.settledTokens, record.reservedTokens, record.ambiguousTokens]
	return validId(id) && !!record && typeof record === "object" &&
		Object.keys(record).sort().join(",") === "ambiguousMicros,ambiguousTokens,budgetLimitMicros,budgetLimitTokens,enabled,epoch,reservedMicros,reservedTokens,settledMicros,settledTokens" &&
		typeof record.enabled === "boolean" && Number.isSafeInteger(record.epoch) && record.epoch >= 0 &&
		counters.every((n) => Number.isSafeInteger(n) && n >= 0) &&
		record.budgetLimitMicros <= REPOSITORY_CAMPAIGN_BUDGET_CAP_MICROS && record.budgetLimitTokens <= REPOSITORY_CAMPAIGN_BUDGET_CAP_TOKENS
}

function validDraftShape(id: string, draft: CampaignState["drafts"][string]): boolean {
	return validId(id) && !!draft && typeof draft === "object" &&
		Object.keys(draft).sort().join(",") === "id,name,repository,requestedModelProfile,sourceRevision" && draft.id === id
}

function validDraftText(draft: CampaignState["drafts"][string]): boolean {
	return typeof draft.name === "string" && !!draft.name.trim() && draft.name.length <= 100 &&
		typeof draft.repository === "string" && /^[A-Za-z0-9_.-]{1,39}\/[A-Za-z0-9_.-]{1,100}$/.test(draft.repository)
}

function validDraftRefs(draft: CampaignState["drafts"][string]): boolean {
	const revision = draft.sourceRevision === null || (typeof draft.sourceRevision === "string" && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(draft.sourceRevision))
	const profile = draft.requestedModelProfile === null || (typeof draft.requestedModelProfile === "string" && /^[a-z0-9-]{1,64}$/.test(draft.requestedModelProfile))
	return revision && profile
}

function validDraftRecord(id: string, draft: CampaignState["drafts"][string]): boolean {
	return validDraftShape(id, draft) && validDraftText(draft) && validDraftRefs(draft)
}

function validQualificationJob(job: RepositoryCampaignJob, s: Partial<CampaignState>): boolean {
	if (job.purpose !== "qualification" || job.campaignId !== CURL_CAMPAIGN_ID || job.advisoryId !== CURL_FIXED_ADVISORY) return false
	if (job.retryOf === undefined) return (s.intakeRecords ?? []).some((row) => row?.source === "debian-tracker-snapshot" && row.jobId === job.id &&
		row.campaignId === job.campaignId && row.advisoryId === job.advisoryId && row.snapshotSha256 === CURL_DEBIAN_SNAPSHOT_SHA256)
	const seen = new Set<string>([job.id])
	let parentId: string | undefined = job.retryOf
	while (parentId !== undefined) {
		const parent = (s.jobs ?? []).find((row) => row.id === parentId)
		if (!parent || seen.has(parent.id) || parent.purpose !== "qualification" || parent.campaignId !== job.campaignId ||
			parent.advisoryId !== job.advisoryId || parent.status !== "failed" || parent.reservedMicros !== 0 || parent.reservedTokens !== 0 ||
			parent.settledMicros !== 0 || parent.settledTokens !== 0 || (s.jobs ?? []).filter((row) => row.retryOf === parent.id).length !== 1) return false
		const parentProof = parent.progress?.evidenceRefs.filter((ref) => ref.kind === "no-call-proof") ?? []
		if (parentProof.length !== 1 || !/^[a-f0-9]{64}$/.test(parentProof[0]!.id)) return false
		seen.add(parent.id)
		if (parent.retryOf === undefined) return (s.intakeRecords ?? []).some((row) => row?.source === "debian-tracker-snapshot" && row.jobId === parent.id &&
			row.campaignId === job.campaignId && row.advisoryId === job.advisoryId && row.snapshotSha256 === CURL_DEBIAN_SNAPSHOT_SHA256)
		parentId = parent.retryOf
	}
	return false
}

function validRepairJob(job: RepositoryCampaignJob, s: Partial<CampaignState>): boolean {
	if (job.purpose !== "repair" || job.campaignId !== CURL_REPAIR_CAMPAIGN_ID || job.advisoryId !== CURL_FIXED_ADVISORY) return false
	let root = job
	const seen = new Set<string>([job.id])
	while (root.retryOf !== undefined) {
		if (!validId(root.retryOf)) return false
		const parent = (s.jobs ?? []).find((candidate) => candidate.id === root.retryOf)
		if (!parent || seen.has(parent.id) || !retryableHistoricalRepairFailure(parent) || parent.campaignId !== job.campaignId ||
			parent.advisoryId !== job.advisoryId || (s.jobs ?? []).filter((candidate) => candidate.retryOf === parent.id).length > 1) return false
		seen.add(parent.id)
		root = parent
	}
	return (s.intakeRecords ?? []).some((row) => row?.source === "debian-tracker-repair-snapshot" && row.jobId === root.id &&
		row.campaignId === job.campaignId && row.advisoryId === job.advisoryId && row.snapshotSha256 === CURL_DEBIAN_SNAPSHOT_SHA256)
}

function validRepairV2Job(job: RepositoryCampaignJob, s: Partial<CampaignState>): boolean {
	if (job.purpose !== "repair" ||
		job.campaignId !== CURL_REPAIR_V2_CAMPAIGN_ID ||
		job.advisoryId !== CURL_FIXED_ADVISORY) return false
	if (job.retryOf === undefined) return hasV2RepairIntake(job, s)
	if (!validId(job.retryOf)) return false
	const parent = (s.jobs ?? []).find((item) => item.id === job.retryOf)
	return !!parent && validV2RecoveryParent(parent, s) &&
		(s.jobs ?? []).filter((item) => item.retryOf === parent.id).length === 1
}

function hasV2RepairIntake(
	job: RepositoryCampaignJob, s: Partial<CampaignState>,
): boolean {
	return (s.intakeRecords ?? []).filter((row) =>
		row?.source === "debian-tracker-repair-v2-snapshot" &&
		row.jobId === job.id && row.campaignId === job.campaignId &&
		row.advisoryId === job.advisoryId &&
		row.snapshotSha256 === CURL_DEBIAN_SNAPSHOT_SHA256).length === 1
}

function validV2RecoveryParent(
	job: RepositoryCampaignJob, s: Partial<CampaignState>,
): boolean {
	const progress = job.progress
	return job.retryOf === undefined && job.purpose === "repair" &&
		job.campaignId === CURL_REPAIR_V2_CAMPAIGN_ID &&
		job.advisoryId === CURL_FIXED_ADVISORY &&
		job.status === "failed" && job.reservedMicros === 0 &&
		job.reservedTokens === 0 &&
		job.settledMicros === 0 && job.settledTokens === 0 &&
		validV2RecoveryProgress(progress) && validV2RecoveryEvidence(progress) &&
		hasV2RepairIntake(job, s)
}

function validV2RecoveryProgress(
	progress: RepositoryJobProgress | undefined,
): boolean {
	return progress?.executionKind === "live-cve" &&
		progress.blocker === "registered-pipeline-step-failed" &&
		progress.currentTask ===
			"Failed prepare attempt reconciled against Fleet no-call proof" &&
		progress.nextStep ===
			"Review the prepare failure before considering a separate job" &&
		JSON.stringify(progress.requiredSteps) ===
		JSON.stringify(REPOSITORY_CAMPAIGN_STEPS) &&
		(correctedPrepareProgress(progress) || legacyPrepareProgress(progress))
}

function correctedPrepareProgress(progress: RepositoryJobProgress): boolean {
	return progress.stage === "prepare-candidate" &&
		JSON.stringify(progress.completedSteps) ===
			JSON.stringify(REPOSITORY_CAMPAIGN_STEPS.slice(0, 3))
}

function legacyPrepareProgress(progress: RepositoryJobProgress): boolean {
	return progress.stage === "verify" &&
		JSON.stringify(progress.completedSteps) ===
			JSON.stringify(REPOSITORY_CAMPAIGN_STEPS.slice(0, 4))
}

function evidenceCount(
	refs: RepositoryEvidenceRef[], kind: RepositoryEvidenceRef["kind"],
): number {
	return refs.filter((ref) => ref.kind === kind).length
}

function validV2RecoveryEvidence(
	progress: RepositoryJobProgress | undefined,
): boolean {
	if (!progress) return false
	const refs = progress.evidenceRefs
	const diagnostic = refs.filter((ref) => ref.kind === "diagnostic")
	const proof = refs.filter((ref) => ref.kind === "no-call-proof")
	return evidenceCount(refs, "intake") === 1 && diagnostic.length === 1 &&
		/^[a-f0-9]{64}$/.test(diagnostic[0]!.id) &&
		evidenceCount(refs, "candidate") === 0 &&
		evidenceCount(refs, "test-receipt") === 0 &&
		evidenceCount(refs, "delivery") === 0 &&
		evidenceCount(refs, "billing-proof") === 0 && proof.length === 1 &&
		/^[a-f0-9]{64}$/.test(proof[0]!.id)
}

function validV2RetryParent(job: RepositoryCampaignJob | undefined,
	s: CampaignState, proofSha256: string): job is RepositoryCampaignJob {
	if (!job || !validV2RecoveryParent(job, s)) return false
	const proofs = job.progress!.evidenceRefs.filter(
		(ref) => ref.kind === "no-call-proof",
	)
	return proofs.length === 1 && proofs[0]!.id === proofSha256
}

function requireV2RetryParent(s: CampaignState, parentId: string,
	proofSha256: string): RepositoryCampaignJob {
	const parent = s.jobs.find((job) => job.id === parentId)
	if (!validV2RetryParent(parent, s, proofSha256)) {
		throw new Error(
			"retry parent is not a recovered zero-cost v2 prepare failure",
		)
	}
	if (s.jobs.some((job) => job.retryOf === parent.id)) {
		throw new Error("this recovered v2 failure already has a retry child")
	}
	if (s.jobs.some((job) => job.campaignId === CURL_REPAIR_V2_CAMPAIGN_ID &&
		(job.status === "queued" || job.status === "running"))) {
		throw new Error("another Curl v2 repair job is active")
	}
	return parent
}

function makeRecoveredV2Retry(parent: RepositoryCampaignJob, epoch: number,
	month: string, now: Date): RepositoryCampaignJob {
	return {
		id: randomUUID(), retryOf: parent.id, campaignId: parent.campaignId,
		advisoryId: parent.advisoryId, status: "queued", epoch,
		createdAt: now.getTime(), updatedAt: now.getTime(), month,
		reservedMicros: 0, settledMicros: 0, reservedTokens: 0,
		settledTokens: 0, purpose: "repair",
	}
}

function retryableHistoricalRepairFailure(job: RepositoryCampaignJob): boolean {
	const progress = job.progress
	const refs = progress?.evidenceRefs ?? []
	const count = (kind: RepositoryEvidenceRef["kind"]) => refs.filter((ref) => ref.kind === kind).length
	return job.purpose === "repair" && job.campaignId === CURL_REPAIR_CAMPAIGN_ID && job.advisoryId === CURL_FIXED_ADVISORY &&
		job.status === "failed" && job.reservedMicros === 0 && job.reservedTokens === 0 && job.settledMicros === 0 && job.settledTokens === 0 &&
		progress?.executionKind === "live-cve" && (progress.stage === "verify" || progress.stage === "deliver") &&
		progress.blocker === "registered-pipeline-step-failed" && progress.nextStep === "review the private bounded diagnostic before any recovery" &&
		(progress.currentTask === "Prepare the bounded isolated workspace" ||
			progress.currentTask === "Record the verified result through private delivery") &&
		JSON.stringify(progress.completedSteps) === JSON.stringify(REPOSITORY_CAMPAIGN_STEPS.slice(0, 5)) &&
		JSON.stringify(progress.requiredSteps) === JSON.stringify(REPOSITORY_CAMPAIGN_STEPS) &&
		count("intake") === 1 && count("candidate") === 1 && count("test-receipt") === 1 && count("diagnostic") === 1 && count("delivery") === 0
}

function validJobRecord(job: RepositoryCampaignJob, s: Partial<CampaignState>, ids: Set<string>): boolean {
	if (!validJobIdentityAndStatus(job, s) || !validJobAccounting(job) || ids.has(job.id)) return false
	if (!validJobOptionalDetails(job, s)) return false
	ids.add(job.id)
	return true
}

function validJobOptionalDetails(job: RepositoryCampaignJob, s: Partial<CampaignState>): boolean {
	const text = (job.claimId === undefined || typeof job.claimId === "string") && (job.detail === undefined || typeof job.detail === "string")
	const retry = job.retryOf === undefined || validId(job.retryOf)
	const purpose = job.purpose === undefined || validQualificationJob(job, s) ||
		validRepairJob(job, s) || validRepairV2Job(job, s)
	const progress = job.progress === undefined || validProgress(job.progress, job.campaignId)
	return text && retry && purpose && progress
}

function validJobIdentityAndStatus(job: RepositoryCampaignJob, s: Partial<CampaignState>): boolean {
	return !!job && typeof job === "object" && validId(job.id) && validId(job.campaignId) && /^CVE-\d{4}-\d{4,12}$/.test(job.advisoryId) &&
		!!s.campaigns?.[job.campaignId] && ["queued", "running", "cancelled", "succeeded", "failed", "ambiguous"].includes(job.status)
}

function validJobAccounting(job: RepositoryCampaignJob): boolean {
	return [job.epoch, job.createdAt, job.updatedAt].every(Number.isSafeInteger) && typeof job.month === "string" &&
		/^\d{4}-(0[1-9]|1[0-2])$/.test(job.month) &&
		[job.reservedMicros, job.settledMicros, job.reservedTokens, job.settledTokens].every((n) => Number.isSafeInteger(n) && n >= 0)
}

function validPinnedDebianIntake(row: RepositoryAdvisoryIntakeRecord): boolean {
	const campaignId = row.source === "debian-tracker-repair-snapshot" ? CURL_REPAIR_CAMPAIGN_ID :
		row.source === "debian-tracker-repair-v2-snapshot" ? CURL_REPAIR_V2_CAMPAIGN_ID : CURL_CAMPAIGN_ID
	return row.campaignId === campaignId && row.advisoryId === CURL_FIXED_ADVISORY &&
		row.publicBaseRevision === CURL_DEBIAN_PUBLIC_BASE_REVISION && row.sourceUrl === CURL_DEBIAN_SOURCE_URL &&
		row.sourceContentSha256 === CURL_DEBIAN_SOURCE_HTML_SHA256 && row.snapshotSha256 === CURL_DEBIAN_SNAPSHOT_SHA256
}

function repairIntakeMatches(input: { campaignId: string; advisoryId: string; publicBaseRevision: string;
	snapshotSha256: string; sourceUrl: string; sourceContentSha256: string; affectedRange: string },
	campaignId: string): boolean {
	return input.campaignId === campaignId && input.advisoryId === CURL_FIXED_ADVISORY &&
		input.publicBaseRevision === CURL_DEBIAN_PUBLIC_BASE_REVISION &&
		input.snapshotSha256 === CURL_DEBIAN_SNAPSHOT_SHA256 && input.sourceUrl === CURL_DEBIAN_SOURCE_URL &&
		input.sourceContentSha256 === CURL_DEBIAN_SOURCE_HTML_SHA256 && input.affectedRange === CURL_DEBIAN_AFFECTED_RANGE
}

function queuePinnedRepairInState(s: CampaignState, input: { campaignId: string; advisoryId: string;
	publicBaseRevision: string; snapshotSha256: string; sourceUrl: string; sourceContentSha256: string },
	source: "debian-tracker-repair-snapshot" | "debian-tracker-repair-v2-snapshot", now: Date): RepositoryCampaignJob {
	const records = s.intakeRecords ??= []
	if (records.some((row) => row.campaignId === input.campaignId && row.advisoryId === input.advisoryId && row.source === source)) {
		throw new Error("known advisory repair has already been recorded")
	}
	const campaign = s.campaigns[input.campaignId]
	if (!campaign?.enabled || s.jobs.length >= MAX_JOBS || records.length >= MAX_INTAKE_RECORDS) throw new Error("known advisory repair is not admissible")
	const job = newRepairJob(input, campaign.epoch, s.month, now)
	s.jobs.push(job)
	records.push(newRepairIntake(input, source, job.id, now))
	return { ...job }
}

function newRepairJob(input: { campaignId: string; advisoryId: string }, epoch: number,
	month: string, now: Date): RepositoryCampaignJob {
	return { id: randomUUID(), campaignId: input.campaignId, advisoryId: input.advisoryId,
		status: "queued", epoch, createdAt: now.getTime(), updatedAt: now.getTime(), month,
		reservedMicros: 0, settledMicros: 0, reservedTokens: 0, settledTokens: 0, purpose: "repair" }
}

function newRepairIntake(input: { campaignId: string; advisoryId: string; publicBaseRevision: string;
	snapshotSha256: string; sourceUrl: string; sourceContentSha256: string },
	source: "debian-tracker-repair-snapshot" | "debian-tracker-repair-v2-snapshot",
	jobId: string, now: Date): RepositoryAdvisoryIntakeRecord {
	return { campaignId: input.campaignId, publicBaseRevision: input.publicBaseRevision,
		advisoryId: input.advisoryId, snapshotSha256: input.snapshotSha256, disposition: "eligible",
		firstSeenAt: now.getTime(), lastSeenAt: now.getTime(), jobId, source,
		sourceUrl: input.sourceUrl, sourceContentSha256: input.sourceContentSha256 }
}

function validIntakeRecord(row: RepositoryAdvisoryIntakeRecord, s: Partial<CampaignState>, keys: Set<string>): boolean {
	if (!validIntakeIdentity(row, s) || !validIntakeSource(row) || !validIntakeTimes(row, s)) return false
	const key = `${row.campaignId}:${row.publicBaseRevision}:${row.advisoryId}:${row.source ?? "osv-commit-query"}`
	if (keys.has(key)) return false
	keys.add(key)
	return true
}

function validIntakeIdentity(row: RepositoryAdvisoryIntakeRecord, s: Partial<CampaignState>): boolean {
	return !!row && typeof row === "object" && validId(row.campaignId) && !!s.campaigns?.[row.campaignId] &&
		/^[a-f0-9]{40}$/.test(row.publicBaseRevision) && validAdvisoryId(row.advisoryId) && /^[a-f0-9]{64}$/.test(row.snapshotSha256) &&
		["eligible", "unsupported-profile"].includes(row.disposition)
}

function validIntakeSource(row: RepositoryAdvisoryIntakeRecord): boolean {
	const source = row.source === undefined || ["osv-commit-query", "debian-tracker-snapshot",
		"debian-tracker-repair-snapshot", "debian-tracker-repair-v2-snapshot"].includes(row.source)
	const url = row.sourceUrl === undefined || validAdvisorySourceUrl(row.sourceUrl)
	const content = row.sourceContentSha256 === undefined || /^[a-f0-9]{64}$/.test(row.sourceContentSha256)
	const pinned = !["debian-tracker-snapshot", "debian-tracker-repair-snapshot",
		"debian-tracker-repair-v2-snapshot"].includes(row.source ?? "") || validPinnedDebianIntake(row)
	return source && url && content && pinned
}

function validIntakeTimes(row: RepositoryAdvisoryIntakeRecord, s: Partial<CampaignState>): boolean {
	const times = [row.firstSeenAt, row.lastSeenAt].every(Number.isSafeInteger) && row.firstSeenAt <= row.lastSeenAt
	const job = row.jobId === null || (validId(row.jobId) && (s.jobs ?? []).some((candidate) => candidate.id === row.jobId))
	return times && job
}

function validHistoryItem(item: CampaignState["history"][number], s: Partial<CampaignState>): boolean {
	return validHistoryOwner(item, s) && validHistoryTime(item) && validHistoryAction(item)
}

function validHistoryOwner(item: CampaignState["history"][number], s: Partial<CampaignState>): boolean {
	return !!item && typeof item === "object" && validId(item.campaignId) && !!(s.campaigns?.[item.campaignId] || s.drafts?.[item.campaignId])
}

function validHistoryTime(item: CampaignState["history"][number]): boolean {
	return Number.isSafeInteger(item.at) && Number.isSafeInteger(item.epoch) && item.epoch >= 0
}

function validHistoryAction(item: CampaignState["history"][number]): boolean {
	const action = ["drafted", "configured", "started", "stopped", "budget", "budget-exhausted", "claimed", "completed", "interrupted"].includes(item.action)
	const keys = Object.keys(item).every((key) => ["at", "campaignId", "action", "epoch", "jobId"].includes(key))
	return action && keys && (item.jobId === undefined || validId(item.jobId))
}

function validateState(value: unknown): value is CampaignState {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false
	const s = value as Partial<CampaignState>
	if (!validStateEnvelope(s) || !Object.entries(s.campaigns!).every(([id, row]) => validCampaignRecord(id, row)) ||
		!Object.entries(s.drafts!).every(([id, row]) => validDraftRecord(id, row))) return false
	const ids = new Set<string>()
	if (!s.jobs!.every((job) => validJobRecord(job, s, ids))) return false
	const keys = new Set<string>()
	if (!(s.intakeRecords ?? []).every((row) => validIntakeRecord(row, s, keys))) return false
	return s.history!.every((item) => validHistoryItem(item, s))
}

function validProgressIdentity(p: RepositoryJobProgress, value: object): boolean {
	const keys = Object.keys(value).sort().join(",")
	const shape = keys === "blocker,completedSteps,currentTask,evidenceRefs,executionKind,goal,heartbeatAt,lastActionAt,leaseExpiresAt,nextStep,requiredSteps,stage,workerId" ||
		keys === "blocker,boardRef,completedSteps,currentTask,evidenceRefs,executionKind,goal,heartbeatAt,lastActionAt,leaseExpiresAt,nextStep,requiredSteps,stage,workerId"
	return shape && ["development-checkpoint", "live-cve"].includes(p.executionKind) && /^[0-9a-f-]{36}$/.test(p.workerId) &&
		typeof p.goal === "string" && p.goal.length > 0 && p.goal.length <= 240 &&
		typeof p.currentTask === "string" && p.currentTask.length > 0 && p.currentTask.length <= 240
}

function validProgressSteps(p: RepositoryJobProgress): boolean {
	const steps = new Set<string>(REPOSITORY_CAMPAIGN_STEPS)
	return steps.has(p.stage) && Array.isArray(p.requiredSteps) && p.requiredSteps.length === REPOSITORY_CAMPAIGN_STEPS.length &&
		p.requiredSteps.every((step, index) => step === REPOSITORY_CAMPAIGN_STEPS[index]) &&
		Array.isArray(p.completedSteps) && p.completedSteps.length <= p.requiredSteps.length &&
		p.completedSteps.every((step, index) => steps.has(step) && p.requiredSteps.indexOf(step) >= 0 &&
			(index === 0 || p.requiredSteps.indexOf(step) > p.requiredSteps.indexOf(p.completedSteps[index - 1]!)))
}

function validProgressTimes(p: RepositoryJobProgress): boolean {
	return [p.lastActionAt, p.heartbeatAt, p.leaseExpiresAt].every(Number.isSafeInteger) &&
		p.lastActionAt <= p.heartbeatAt && p.heartbeatAt <= p.leaseExpiresAt
}

function validOptionalProgressNote(value: unknown): boolean {
	return value === null || (typeof value === "string" && value.length <= 240)
}

function isV2Campaign(campaignId: string): boolean {
	return campaignId === CURL_REPAIR_V2_CAMPAIGN_ID
}

function validProgressTimesAndNotes(p: RepositoryJobProgress, campaignId: string): boolean {
	const board = p.boardRef === undefined || p.boardRef === null ||
		(typeof p.boardRef === "string" && p.boardRef.length <= 256 &&
			validPrivateBoardRef(p.boardRef, isV2Campaign(campaignId)))
	return validProgressTimes(p) && validOptionalProgressNote(p.blocker) && validOptionalProgressNote(p.nextStep) && board
}

function validProgressEvidence(p: RepositoryJobProgress): boolean {
	return Array.isArray(p.evidenceRefs) && p.evidenceRefs.length <= 20 && p.evidenceRefs.every((item) => item &&
		Object.keys(item).sort().join(",") === "id,kind,label" && /^[a-f0-9]{64}$/.test(item.id) &&
		["intake", "candidate", "test-receipt", "delivery", "diagnostic", "no-call-proof", "billing-proof"].includes(item.kind) &&
		typeof item.label === "string" && item.label.length > 0 && item.label.length <= 80)
}

function validProgress(value: unknown, campaignId: string): value is RepositoryJobProgress {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false
	const progress = value as RepositoryJobProgress
	return validProgressIdentity(progress, value) && validProgressSteps(progress) &&
		validProgressTimesAndNotes(progress, campaignId) && validProgressEvidence(progress)
}

function missingSourceAndRecipe(definition: RepositoryCampaignDefinition): string[] {
	const q = definition.qualification
	const missing: string[] = []
	if (!definition.sourceRevision || !q.sourceAudited) missing.push("audited-private-source")
	if (!definition.policySha256) missing.push("reviewed-policy-digest")
	if (!definition.workerProfile || !q.workerQualified) missing.push("qualified-worker")
	if (!definition.recipeDigest || !q.recipeQualified) missing.push("reviewed-recipe")
	return missing
}

function missingEvaluatorAndAccess(definition: RepositoryCampaignDefinition): string[] {
	const q = definition.qualification
	const missing: string[] = []
	if (!definition.evaluatorDigest || !q.evaluatorQualified) missing.push("independent-evaluator")
	if (!definition.model || !q.modelApproved) missing.push("approved-exact-model")
	if (!definition.dataAccessProfile || !q.dataApproved) missing.push("approved-data-destination")
	if (!q.accessApproved) missing.push("operation-specific-access")
	return missing
}

function missingQualification(definition: RepositoryCampaignDefinition): string[] {
	return [...missingSourceAndRecipe(definition), ...missingEvaluatorAndAccess(definition)]
}

function usageBelowLimits(usage: { settledMicros: number; reservedMicros: number; ambiguousMicros: number;
	settledTokens: number; reservedTokens: number; ambiguousTokens: number }, micros: number, tokens: number): boolean {
	return usage.settledMicros + usage.reservedMicros + usage.ambiguousMicros < micros &&
		usage.settledTokens + usage.reservedTokens + usage.ambiguousTokens < tokens
}

function monthlyUsage(usage: { settledMicros: number; reservedMicros: number; ambiguousMicros: number }): number {
	return usage.settledMicros + usage.reservedMicros + usage.ambiguousMicros
}

function lifetimeSpend(usage: { settledMicros: number; reservedMicros: number; ambiguousMicros: number }): number {
	return monthlyUsage(usage)
}

function lifetimeTokens(usage: { settledTokens: number; reservedTokens: number; ambiguousTokens: number }): number {
	return usage.settledTokens + usage.reservedTokens + usage.ambiguousTokens
}

function monthlyUsageBelowLimit(usage: { settledMicros: number; reservedMicros: number; ambiguousMicros: number }, limitMicros: number): boolean {
	return usage.settledMicros + usage.reservedMicros + usage.ambiguousMicros < limitMicros
}

function snapshotProvisionAdmission(authority: RepositoryBudgetAuthority): boolean {
	return authority.mode === "fleet-v2-readonly" && authority.snapshotOnly === true && authority.globalEnabled === true &&
		authority.canAdmit === true
}

function snapshotProvisionBudget(authority: RepositoryBudgetAuthority): boolean {
	return !!authority.monthly && !!authority.campaignLifetime && !!authority.repositoryLifetime &&
		monthlyUsageBelowLimit(authority.monthly, authority.monthly.limitMicros) &&
		usageBelowLimits(authority.campaignLifetime, authority.limitMicros, authority.limitTokens) &&
		usageBelowLimits(authority.repositoryLifetime, authority.repositoryLifetime.limitMicros, authority.repositoryLifetime.limitTokens)
}

function snapshotCanProvision(authority: RepositoryBudgetAuthority): boolean {
	return snapshotProvisionAdmission(authority) && snapshotProvisionBudget(authority)
}

function liveBudgetOnlyAdmission(authority: RepositoryBudgetAuthority, definition: RepositoryCampaignDefinition): boolean {
	const profile = v1RepairDefinition(definition) || v2RepairDefinition(definition)
	return authority.mode === "fleet-v2-budget-only" && profile && authority.snapshotOnly === true && !authority.available &&
		authority.globalEnabled === true && authority.canAdmit === true && authority.repositoryEnabled === true &&
		!!authority.runId && Number.isSafeInteger(authority.runExpiresAtMs) && Number(authority.runExpiresAtMs) > Date.now()
}

function v1RepairDefinition(definition: RepositoryCampaignDefinition): boolean {
	return definition.id === CURL_REPAIR_CAMPAIGN_ID && definition.repositoryId === CURL_REPAIR_REPOSITORY_ID &&
		definition.repository === CURL_REPAIR_TARGET_REPOSITORY && definition.sourceRevision === CURL_REPAIR_SOURCE_REVISION &&
		definition.policySha256 === CURL_REPAIR_POLICY_SHA256 && definition.workerProfile === CURL_REPAIR_PROFILE_ID &&
		definition.recipeDigest === CURL_REPAIR_RECIPE_DIGEST && definition.evaluatorDigest === CURL_REPAIR_EVALUATOR_DIGEST
}

function v2RepairDefinition(definition: RepositoryCampaignDefinition): boolean {
	return definition.id === CURL_REPAIR_V2_CAMPAIGN_ID && definition.repositoryId === CURL_REPAIR_V2_REPOSITORY_ID &&
		definition.repository === CURL_REPAIR_TARGET_REPOSITORY && definition.sourceRevision === CURL_REPAIR_SOURCE_REVISION &&
		definition.policySha256 === CURL_REPAIR_V2_POLICY_SHA256 && definition.workerProfile === CURL_REPAIR_V2_PROFILE_ID &&
		definition.recipeDigest === CURL_REPAIR_V2_RECIPE_DIGEST && definition.evaluatorDigest === CURL_REPAIR_V2_EVALUATOR_DIGEST
}

function v2RetryAuthorityReady(authority: RepositoryBudgetAuthority,
	definition: RepositoryCampaignDefinition, now: Date): boolean {
	if (!v2RepairDefinition(definition)) return false
	const identity = authority.repositoryCampaignId === definition.id &&
		authority.repositoryId === definition.repositoryId &&
		authority.repository === definition.repository &&
		authority.sourceRevision === definition.sourceRevision &&
		authority.policySha256 === definition.policySha256 &&
		authority.model === "none" &&
		authority.profileId === "no-model"
	const enabled = authority.globalEnabled === true &&
		authority.canAdmit === true &&
		authority.repositoryEnabled === true
	const live = authority.mode === "fleet-v2" && authority.available &&
		validActiveRun(authority, now.getTime())
	return identity && enabled && (live || snapshotCanProvision(authority) ||
		liveBudgetOnlyAdmission(authority, definition))
}

function v2RetryHasBudget(
	authority: RepositoryBudgetAuthority,
	totals: Pick<CampaignRecord,
		"settledMicros" | "reservedMicros" | "ambiguousMicros" |
		"settledTokens" | "reservedTokens" | "ambiguousTokens"
	>,
	campaign: CampaignRecord): boolean {
	const micros = CURL_REPAIR_V2_RESERVATION.micros
	const tokens = CURL_REPAIR_V2_RESERVATION.tokens
	const monthly = authority.monthly!
	const lifetime = authority.campaignLifetime!
	const repository = authority.repositoryLifetime!
	return campaign.budgetLimitMicros - lifetimeSpend(campaign) >= micros &&
		campaign.budgetLimitTokens - lifetimeTokens(campaign) >= tokens &&
		authority.limitMicros - authority.committedMicros -
			lifetimeSpend(totals) >= micros &&
		authority.limitTokens - authority.committedTokens -
			lifetimeTokens(totals) >= tokens &&
		monthly.limitMicros - monthlyUsage(monthly) >= micros &&
		lifetime.limitMicros - lifetimeSpend(lifetime) >= micros &&
		lifetime.limitTokens - lifetimeTokens(lifetime) >= tokens &&
		repository.limitMicros - lifetimeSpend(repository) >= micros &&
		repository.limitTokens - lifetimeTokens(repository) >= tokens
}

function aggregateBudgetExhausted(authority: RepositoryBudgetAuthority,
	totals: Pick<CampaignRecord, "settledMicros" | "reservedMicros" | "ambiguousMicros" | "settledTokens" | "reservedTokens" | "ambiguousTokens">): boolean {
	const micros = authority.committedMicros + totals.settledMicros + totals.reservedMicros + totals.ambiguousMicros >= authority.limitMicros
	const tokens = authority.committedTokens + totals.settledTokens + totals.reservedTokens + totals.ambiguousTokens >= authority.limitTokens
	return micros || tokens
}

function validAuthorityBase(authority: RepositoryBudgetAuthority): boolean {
	if (!authority || !["synthetic-test", "fleet-v2", "fleet-v2-readonly", "fleet-v2-budget-only", "unavailable"].includes(authority.mode) || typeof authority.available !== "boolean") return false
	const committed = [authority.committedMicros, authority.committedTokens]
	const limitsValid = Number.isSafeInteger(authority.limitMicros) && authority.limitMicros >= 0 && authority.limitMicros <= REPOSITORY_CAMPAIGN_BUDGET_CAP_MICROS &&
		Number.isSafeInteger(authority.limitTokens) && authority.limitTokens >= 0 && authority.limitTokens <= REPOSITORY_CAMPAIGN_BUDGET_CAP_TOKENS
	return limitsValid &&
		committed.every((n) => Number.isSafeInteger(n) && n >= 0)
}

function validUnavailableAuthority(authority: RepositoryBudgetAuthority): boolean {
	return !authority.available && authority.limitMicros === 0 && authority.limitTokens === 0 && authority.committedMicros === 0 && authority.committedTokens === 0
}

function isFleetAuthority(mode: RepositoryBudgetAuthority["mode"]): boolean {
	return mode === "fleet-v2" || mode === "fleet-v2-readonly" || mode === "fleet-v2-budget-only"
}

function validFleetAuthority(authority: RepositoryBudgetAuthority, campaignId: string | undefined,
	definitionFor: (id: string) => RepositoryCampaignDefinition): boolean {
	const snapshotOnly = authority.mode === "fleet-v2-readonly"
	const budgetOnly = authority.mode === "fleet-v2-budget-only"
	return validFleetTimestampAndRun(authority, snapshotOnly, budgetOnly) && validFleetScopeFields(authority) &&
		validFleetUsage(authority, snapshotOnly, budgetOnly) && validFleetCampaign(authority, campaignId, definitionFor)
}

function freshAuthorityTimestamp(authority: RepositoryBudgetAuthority, now: number): boolean {
	return Number.isSafeInteger(authority.asOfMs) && now - Number(authority.asOfMs) <= 60_000 && Number(authority.asOfMs) <= now + 60_000
}

function validAuthorityEpochs(authority: RepositoryBudgetAuthority): boolean {
	const control = Number.isSafeInteger(authority.controlEpoch) && Number(authority.controlEpoch) >= 0
	const repository = Number.isSafeInteger(authority.repositoryEpoch) && Number(authority.repositoryEpoch) >= 0
	return control && repository
}

function validSnapshotOnlyRun(authority: RepositoryBudgetAuthority): boolean {
	return authority.snapshotOnly === true && !authority.available && authority.runId === null && authority.runExpiresAtMs === null
}

function validActiveRun(authority: RepositoryBudgetAuthority, now: number, budgetOnly = false): boolean {
	const runId = typeof authority.runId === "string" && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(authority.runId)
	const expiry = Number.isSafeInteger(authority.runExpiresAtMs) && Number(authority.asOfMs) < Number(authority.runExpiresAtMs) && now < Number(authority.runExpiresAtMs)
	return (budgetOnly ? authority.snapshotOnly === true : authority.snapshotOnly !== true) && runId && expiry
}

function validFleetTimestampAndRun(authority: RepositoryBudgetAuthority, snapshotOnly: boolean, budgetOnly = false): boolean {
	const now = Date.now()
	if (!freshAuthorityTimestamp(authority, now) || !validAuthorityEpochs(authority) || authority.campaignId !== "fleet-security-watch") return false
	return snapshotOnly ? validSnapshotOnlyRun(authority) : validActiveRun(authority, now, budgetOnly)
}

function validFleetRepositoryIdentity(authority: RepositoryBudgetAuthority): boolean {
	return !!authority.repositoryCampaignId && validId(authority.repositoryId) &&
		typeof authority.repository === "string" && /^[A-Za-z0-9_.-]{1,39}\/[A-Za-z0-9_.-]{1,100}$/.test(authority.repository) &&
		typeof authority.sourceRevision === "string" && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(authority.sourceRevision) &&
		typeof authority.policySha256 === "string" && /^[a-f0-9]{64}$/.test(authority.policySha256)
}

function validFleetModelProfile(authority: RepositoryBudgetAuthority): boolean {
	return validId(authority.profileId) && typeof authority.model === "string" && /^[\w./:-]{1,160}$/.test(authority.model)
}

function validFleetAdmissionFlags(authority: RepositoryBudgetAuthority): boolean {
	return typeof authority.globalEnabled === "boolean" && typeof authority.canAdmit === "boolean" && typeof authority.repositoryEnabled === "boolean"
}

function validFleetScopeFields(authority: RepositoryBudgetAuthority): boolean {
	return validFleetRepositoryIdentity(authority) && validFleetModelProfile(authority) && validFleetAdmissionFlags(authority)
}

function validFleetUsageSnapshots(authority: RepositoryBudgetAuthority): boolean {
	const monthly = authority.monthly && validMonthlySnapshot(authority.monthly)
	const campaign = authority.campaignLifetime && validLifetimeSnapshot(authority.campaignLifetime, 20_000, REPOSITORY_CAMPAIGN_BUDGET_CAP_TOKENS)
	const legacy = authority.legacyLifetime && validLifetimeSnapshot(authority.legacyLifetime)
	const repository = authority.repositoryLifetime && validLifetimeSnapshot(authority.repositoryLifetime, undefined, undefined, true)
	return !!monthly && !!campaign && !!legacy && !!repository && authority.limitMicros === 20_000 &&
		authority.limitTokens === REPOSITORY_CAMPAIGN_BUDGET_CAP_TOKENS
}

function validLegacyUsageProjection(authority: RepositoryBudgetAuthority): boolean {
	const legacy = authority.legacyLifetime!
	const micros = legacy.settledMicros + legacy.reservedMicros + legacy.ambiguousMicros
	const tokens = legacy.settledTokens + legacy.reservedTokens + legacy.ambiguousTokens
	return authority.committedMicros === micros && authority.committedTokens === tokens
}

function validFleetUsage(authority: RepositoryBudgetAuthority, snapshotOnly: boolean, budgetOnly = false): boolean {
	return validFleetUsageSnapshots(authority) && validLegacyUsageProjection(authority) &&
		authority.available === (snapshotOnly || budgetOnly ? false : fleetUsageAvailable(authority)) &&
		(!budgetOnly || (authority.snapshotOnly === true && authority.model === "none" && authority.profileId === "no-model"))
}

function fleetUsageAvailable(authority: RepositoryBudgetAuthority): boolean {
	const m = authority.monthly!, c = authority.campaignLifetime!, r = authority.repositoryLifetime!
	const enabled = authority.globalEnabled === true && authority.canAdmit === true && authority.repositoryEnabled === true
	const monthly = m.settledMicros + m.reservedMicros + m.ambiguousMicros < m.limitMicros
	const campaign = c.settledMicros + c.reservedMicros + c.ambiguousMicros < authority.limitMicros &&
		c.settledTokens + c.reservedTokens + c.ambiguousTokens < authority.limitTokens
	const repository = r.settledMicros + r.reservedMicros + r.ambiguousMicros < r.limitMicros &&
		r.settledTokens + r.reservedTokens + r.ambiguousTokens < r.limitTokens
	return enabled && monthly && campaign && repository
}

function validFleetCampaign(authority: RepositoryBudgetAuthority, campaignId: string | undefined,
	definitionFor: (id: string) => RepositoryCampaignDefinition): boolean {
	if (campaignId === undefined) return authority.mode !== "fleet-v2-budget-only"
	const definition = definitionFor(campaignId)
	const ordinary = authority.mode !== "fleet-v2-budget-only" && authority.repositoryCampaignId === campaignId &&
		authority.sourceRevision === definition.sourceRevision && authority.model === definition.model
	return ordinary || (liveBudgetOnlyAdmission(authority, definition) && authority.repositoryCampaignId === definition.id &&
		authority.repositoryId === definition.repositoryId && authority.repository === definition.repository &&
		authority.sourceRevision === definition.sourceRevision && authority.policySha256 === definition.policySha256 &&
		authority.model === "none" && authority.profileId === "no-model")
}

function validCampaignStateFile(stat: Awaited<ReturnType<typeof fs.lstat>>): boolean {
	const owner = typeof process.getuid !== "function" || stat.uid === process.getuid()
	return stat.isFile() && !stat.isSymbolicLink() && stat.size <= 1024 * 1024 && owner
}

async function parseCampaignStateFile(filePath: string): Promise<CampaignState> {
	const stat = await fs.lstat(filePath)
	if (!validCampaignStateFile(stat)) throw new Error("repository campaign state is not a bounded owner file")
	const state = JSON.parse(await fs.readFile(filePath, "utf8")) as CampaignState
	if (state && typeof state === "object" && !Array.isArray(state) && !Object.hasOwn(state, "intakeRecords")) state.intakeRecords = []
	if (!validateState(state)) throw new Error("repository campaign state failed schema validation")
	return state
}

async function readCampaignStateFile(filePath: string): Promise<CampaignState | undefined> {
	try { return await parseCampaignStateFile(filePath) }
	catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
		throw error
	}
}

async function ensurePrivateCampaignRoot(parent: string): Promise<void> {
	await fs.mkdir(parent, { recursive: true, mode: 0o700 })
	const stat = await fs.lstat(parent)
	const owner = typeof process.getuid !== "function" || stat.uid === process.getuid()
	if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 || !owner) {
		throw new Error("repository campaign root must be private and owner controlled")
	}
}

async function createCampaignLock(lockPath: string): Promise<() => Promise<void>> {
	const file = await fs.open(lockPath, "wx", 0o600)
	await file.writeFile(`${process.pid}\n`)
	return async () => { await file.close(); await fs.rm(lockPath, { force: true }) }
}

async function campaignLockOwnerAlive(lockPath: string): Promise<boolean> {
	const owner = Number((await fs.readFile(lockPath, "utf8").catch(() => "")).trim())
	if (!Number.isSafeInteger(owner) || owner <= 0) return false
	try { process.kill(owner, 0); return true }
	catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM" }
}

async function removeStaleCampaignLock(lockPath: string): Promise<void> {
	const stale = `${lockPath}.stale.${randomUUID()}`
	await fs.rename(lockPath, stale).catch(() => undefined)
	await fs.rm(stale, { force: true }).catch(() => undefined)
}

async function acquireCampaignLock(lockPath: string): Promise<() => Promise<void>> {
	for (let attempt = 0; attempt < 100; attempt++) {
		try { return await createCampaignLock(lockPath) }
		catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
			if (!await campaignLockOwnerAlive(lockPath)) { await removeStaleCampaignLock(lockPath); continue }
			await new Promise((resolve) => setTimeout(resolve, 10 + attempt))
		}
	}
	throw new Error("repository campaign state is busy")
}

function validProgressUpdateSteps(patch: RepositoryProgressUpdate): boolean {
	if (!Array.isArray(patch.completedSteps) || patch.completedSteps.length > REPOSITORY_CAMPAIGN_STEPS.length) return false
	return patch.completedSteps.every((step, index) => REPOSITORY_CAMPAIGN_STEPS.includes(step) &&
		(index === 0 || REPOSITORY_CAMPAIGN_STEPS.indexOf(step) > REPOSITORY_CAMPAIGN_STEPS.indexOf(patch.completedSteps[index - 1]!)))
}

function validProgressUpdateEvidence(refs: RepositoryEvidenceRef[] | undefined): boolean {
	if (refs === undefined) return true
	return Array.isArray(refs) && refs.length <= 20 && refs.every((ref) => ref && /^[a-f0-9]{64}$/.test(ref.id) &&
		["intake", "candidate", "test-receipt", "delivery", "diagnostic", "no-call-proof", "billing-proof"].includes(ref.kind) && typeof ref.label === "string" && !!ref.label.trim() && ref.label.length <= 80)
}

function validOptionalUpdateText(value: unknown, allowNull: boolean): boolean {
	if (value === undefined) return true
	if (allowNull && value === null) return true
	return typeof value === "string" && value.length <= 240
}

function validProgressUpdateNotes(patch: RepositoryProgressUpdate, campaignId: string): boolean {
	const board = patch.boardRef === undefined || patch.boardRef === null ||
		(typeof patch.boardRef === "string" && patch.boardRef.length <= 256 &&
			validPrivateBoardRef(patch.boardRef, isV2Campaign(campaignId)))
	return validOptionalUpdateText(patch.blocker, true) && validOptionalUpdateText(patch.nextStep, true) && board
}

function validProgressUpdate(patch: RepositoryProgressUpdate, campaignId: string): boolean {
	if (!patch || typeof patch !== "object") return false
	const fields = REPOSITORY_CAMPAIGN_STEPS.includes(patch.stage) && typeof patch.currentTask === "string" &&
		!!patch.currentTask.trim() && patch.currentTask.length <= 240
	return fields && validProgressUpdateSteps(patch) &&
		validProgressUpdateNotes(patch, campaignId) &&
		validProgressUpdateEvidence(patch.evidenceRefs)
}

function validFinishProgress(progress: RepositoryFinishProgress | undefined, campaignId: string): boolean {
	if (progress === undefined) return true
	const knownKeys = Object.keys(progress).every((key) => ["currentTask", "blocker", "nextStep", "boardRef"].includes(key))
	return !!progress && knownKeys && validFinishText(progress) && validFinishBoardRef(progress.boardRef, campaignId)
}

function validFinishText(progress: RepositoryFinishProgress): boolean {
	const task = progress.currentTask === undefined || (typeof progress.currentTask === "string" && !!progress.currentTask.trim() && progress.currentTask.length <= 240)
	return task && validOptionalUpdateText(progress.blocker, true) && validOptionalUpdateText(progress.nextStep, true)
}

function validFinishBoardRef(value: string | null | undefined, campaignId: string): boolean {
	return value === undefined || value === null ||
		(typeof value === "string" && value.length <= 256 &&
			validPrivateBoardRef(value, isV2Campaign(campaignId)))
}

function validFinishResult(claim: ClaimedRepositoryJob, result: RepositoryFinishResult): boolean {
	const usage = [result.actualMicros, result.actualTokens].every((n) => n === undefined || (Number.isSafeInteger(n) && n >= 0))
	return !!claim && !!claim.job && ["succeeded", "failed", "ambiguous"].includes(result.status) && usage &&
		validFinishProgress(result.progress, claim.job.campaignId)
}

function validRecoveredFinish(claim: ClaimedRepositoryJob, result: RecoveredFinishResult): boolean {
	return !!claim && !!claim.job && ["succeeded", "failed"].includes(result.status) &&
		[result.actualMicros, result.actualTokens].every((n) => Number.isSafeInteger(n) && n >= 0) &&
		(result.proofSha256 === undefined || /^[a-f0-9]{64}$/.test(result.proofSha256)) &&
		(result.proofKind === undefined || result.proofKind === "no-call-proof" || result.proofKind === "billing-proof") &&
		(result.proofKind === undefined || result.proofSha256 !== undefined)
}

async function invokeClaimStart<T>(start: () => Promise<T>,
	beforeStart: ((start: () => Promise<T>, markStarted: (request: Promise<T>) => void) => Promise<void>) | undefined,
	markStarted: (request: Promise<T>) => void): Promise<void> {
	if (!beforeStart) { markStarted(start()); return }
	await beforeStart(start, markStarted)
	}

function assertRequestClaimCurrent(state: CampaignState, claim: ClaimedRepositoryJob, message = "campaign request claim is stale or stopped"): void {
	const job = state.jobs.find((candidate) => candidate.id === claim.job.id)
	const campaign = state.campaigns[claim.job.campaignId]
	if (!campaign?.enabled || campaign.epoch !== claim.epoch || !job || job.status !== "running" ||
		job.claimId !== claim.claimId || job.epoch !== claim.epoch) throw new Error(message)
}

function requireRunningProgressJob(s: CampaignState, claim: ClaimedRepositoryJob, now: Date): RepositoryCampaignJob {
	const job = s.jobs.find((candidate) => candidate.id === claim.job.id)
	if (!job || job.status !== "running" || job.claimId !== claim.claimId || job.epoch !== claim.epoch || !job.progress) throw new Error("campaign claim is stale")
	if (now.getTime() > job.progress.leaseExpiresAt) throw new Error("campaign worker lease expired")
	return job
}

function assertProgressAppendOnly(old: RepositoryJobProgress, patch: RepositoryProgressUpdate): RepositoryEvidenceRef[] {
	if (patch.completedSteps.some((step) => !old.requiredSteps.includes(step)) ||
		old.completedSteps.some((step, index) => patch.completedSteps[index] !== step)) throw new Error("campaign progress cannot forget completed steps")
	const refs = patch.evidenceRefs ?? old.evidenceRefs
	if (refs.length < old.evidenceRefs.length || old.evidenceRefs.some((item, index) => JSON.stringify(refs[index]) !== JSON.stringify(item))) {
		throw new Error("campaign evidence cannot be removed or changed")
	}
	return refs
}

function applyProgressUpdate(job: RepositoryCampaignJob, patch: RepositoryProgressUpdate, refs: RepositoryEvidenceRef[], now: Date): void {
	const old = job.progress!
	const boardRef = patch.boardRef === undefined ? (old.boardRef ?? null) : patch.boardRef
	if (old.boardRef && boardRef !== old.boardRef) throw new Error("private Board reference cannot be removed or changed")
	job.progress = { ...old, stage: patch.stage, currentTask: patch.currentTask, completedSteps: [...patch.completedSteps],
		lastActionAt: now.getTime(), heartbeatAt: now.getTime(), leaseExpiresAt: now.getTime() + REPOSITORY_WORKER_LEASE_MS,
		blocker: patch.blocker === undefined ? old.blocker : patch.blocker,
		nextStep: patch.nextStep === undefined ? old.nextStep : patch.nextStep,
		evidenceRefs: structuredClone(refs), boardRef }
	job.updatedAt = now.getTime()
}

function validateFinishClaim(job: RepositoryCampaignJob, claim: ClaimedRepositoryJob): void {
	if (job.status !== "running" || job.claimId !== claim.claimId || job.epoch !== claim.epoch) throw new Error("campaign claim is stale")
}

function settleFinishUsage(job: RepositoryCampaignJob, campaign: CampaignRecord, result: RepositoryFinishResult): void {
	campaign.reservedMicros -= job.reservedMicros
	campaign.reservedTokens -= job.reservedTokens
	if (result.status === "ambiguous") {
		job.status = "ambiguous"
		job.settledMicros = job.reservedMicros
		job.settledTokens = job.reservedTokens
		campaign.ambiguousMicros += job.reservedMicros
		campaign.ambiguousTokens += job.reservedTokens
		return
	}
	const actual = result.actualMicros ?? 0
	const tokens = result.actualTokens ?? 0
	if (actual > job.reservedMicros || tokens > job.reservedTokens) throw new Error("actual usage exceeds reservation")
	job.status = result.status
	job.settledMicros = actual
	job.settledTokens = tokens
	campaign.settledMicros += actual
	campaign.settledTokens += tokens
}

function updateFinishedProgress(job: RepositoryCampaignJob, result: RepositoryFinishResult, now: Date): void {
	if (!job.progress) return
	job.progress.lastActionAt = now.getTime()
	job.progress.heartbeatAt = now.getTime()
	job.progress.leaseExpiresAt = now.getTime()
	job.progress.currentTask = result.progress?.currentTask ?? (result.status === "succeeded" ? "Worker completed; review the recorded result" :
		result.status === "failed" ? "Worker stopped after an unsuccessful result" : "Worker result needs reconciliation")
	job.progress.nextStep = result.progress?.nextStep ?? (result.status === "succeeded" ? null : "reconcile recorded result before retry")
	job.progress.blocker = result.progress?.blocker ?? (result.status === "succeeded" ? null : "Result requires review before any retry")
	if (result.progress?.boardRef !== undefined) job.progress.boardRef = result.progress.boardRef
}

function matchesClaim(job: RepositoryCampaignJob, claim: ClaimedRepositoryJob): boolean {
	return job.claimId === claim.claimId && job.epoch === claim.epoch
}

function isAlreadySettled(job: RepositoryCampaignJob, result: RecoveredFinishResult): boolean {
	const proofKind = result.proofKind ?? "no-call-proof"
	const proofMatches = result.proofSha256 === undefined || !!job.progress?.evidenceRefs.some((ref) => ref.kind === proofKind && ref.id === result.proofSha256)
	return job.status === result.status && job.settledMicros === result.actualMicros && job.settledTokens === result.actualTokens && proofMatches
}

function requireRecoveredJob(s: CampaignState, claim: ClaimedRepositoryJob): RepositoryCampaignJob {
	const job = s.jobs.find((candidate) => candidate.id === claim.job.id)
	if (!job || job.claimId !== claim.claimId || job.epoch !== claim.epoch) throw new Error("campaign claim is stale")
	if (job.status !== "ambiguous") throw new Error("campaign claim is not a recovered ambiguous job")
	return job
}

function applyRecoveredSettlement(job: RepositoryCampaignJob, campaign: CampaignRecord, result: RecoveredFinishResult, now: Date): void {
	const heldMicros = job.settledMicros
	const heldTokens = job.settledTokens
	if (result.actualMicros > heldMicros || result.actualTokens > heldTokens || campaign.ambiguousMicros < heldMicros || campaign.ambiguousTokens < heldTokens) {
		throw new Error("recovered usage exceeds its ambiguous reservation")
	}
	campaign.ambiguousMicros -= heldMicros
	campaign.ambiguousTokens -= heldTokens
	campaign.settledMicros += result.actualMicros
	campaign.settledTokens += result.actualTokens
	job.status = result.status
	job.settledMicros = result.actualMicros
	job.settledTokens = result.actualTokens
	job.updatedAt = now.getTime()
	if (result.proofSha256) {
		if (!job.progress) throw new Error("recovered no-call proof has no job progress record")
		const proofKind = result.proofKind ?? "no-call-proof"
		const existing = job.progress.evidenceRefs.find((ref) => ref.kind === proofKind)
		if (existing && existing.id !== result.proofSha256) throw new Error("recovered ledger proof conflicts with prior job evidence")
		if (!existing) job.progress.evidenceRefs.push({ id: result.proofSha256, kind: proofKind,
			label: proofKind === "no-call-proof" ? "Fleet no-call proof" : "Fleet closed-session billing proof" })
		job.progress.lastActionAt = now.getTime()
		job.progress.heartbeatAt = now.getTime()
		job.progress.leaseExpiresAt = now.getTime()
		job.progress.currentTask = proofKind === "no-call-proof" ? "Failed prepare attempt reconciled against Fleet no-call proof" :
			"Paid calls reconciled from Fleet closed-session proof; qualification remains unqualified"
		job.progress.nextStep = proofKind === "no-call-proof" ? "Review the prepare failure before considering a separate job" :
			"Retain the denied qualification result; no retry was created"
	}
}

function findOrCreateObservedRecord(s: CampaignState, input: ObservedAdvisoryInput, now: Date,
	disposition: RepositoryAdvisoryIntakeRecord["disposition"]): { record: RepositoryAdvisoryIntakeRecord; changed: boolean } {
	const records = s.intakeRecords
	let record = records.find((row) => row.campaignId === input.campaignId && row.publicBaseRevision === input.publicBaseRevision &&
		row.advisoryId === input.advisoryId && (row.source ?? "osv-commit-query") === "osv-commit-query")
	const changed = !record || record.snapshotSha256 !== input.snapshotSha256 || record.disposition !== disposition
	if (!record) {
		if (records.length >= MAX_INTAKE_RECORDS) throw new Error("published advisory intake record limit reached")
		record = { campaignId: input.campaignId, publicBaseRevision: input.publicBaseRevision, advisoryId: input.advisoryId,
			snapshotSha256: input.snapshotSha256, disposition, firstSeenAt: now.getTime(), lastSeenAt: now.getTime(), jobId: null,
			source: "osv-commit-query", sourceUrl: `https://osv.dev/vulnerability/${encodeURIComponent(input.advisoryId)}` }
		records.push(record)
	} else {
		record.snapshotSha256 = input.snapshotSha256
		record.disposition = disposition
		record.lastSeenAt = now.getTime()
	}
	return { record, changed }
}

function enqueueObservedAdvisory(s: CampaignState, input: ObservedAdvisoryInput, record: RepositoryAdvisoryIntakeRecord, now: Date): boolean {
	const campaign = s.campaigns[input.campaignId]
	if (!input.eligible || !campaign?.enabled || record.jobId !== null ||
		s.jobs.some((job) => job.campaignId === input.campaignId && job.advisoryId === input.advisoryId)) return false
	if (s.jobs.length >= MAX_JOBS) throw new Error("campaign job queue is full")
	const job: RepositoryCampaignJob = { id: randomUUID(), campaignId: input.campaignId, advisoryId: input.advisoryId, status: "queued",
		epoch: campaign.epoch, createdAt: now.getTime(), updatedAt: now.getTime(), month: s.month,
		reservedMicros: 0, settledMicros: 0, reservedTokens: 0, settledTokens: 0 }
	s.jobs.push(job)
	record.jobId = job.id
	return true
}

function observePublishedAdvisoryState(s: CampaignState, input: ObservedAdvisoryInput, now: Date): { changed: boolean; queued: boolean; record: RepositoryAdvisoryIntakeRecord } {
	s.intakeRecords ??= []
	const disposition = input.eligible ? "eligible" : "unsupported-profile"
	const observed = findOrCreateObservedRecord(s, input, now, disposition)
	const queued = enqueueObservedAdvisory(s, input, observed.record, now)
	return { changed: observed.changed, queued, record: { ...observed.record } }
}

/** Durable control plane. Its optional budget adapter is synthetic-test-only; production is denied until the broker integration exists. */
export class RepositoryCampaignStore {
	readonly path: string
	private readonly lockPath: string
	private readonly definitions = new Map<string, RepositoryCampaignDefinition>()
	private readonly readBudgetAuthority: (campaignId?: string) => RepositoryBudgetAuthority | Promise<RepositoryBudgetAuthority>

	constructor(filePath: string, definitions: RepositoryCampaignDefinition[], readBudgetAuthority: (campaignId?: string) => RepositoryBudgetAuthority | Promise<RepositoryBudgetAuthority> = () => ({ mode: "synthetic-test", available: false, limitMicros: 0, limitTokens: 0, committedMicros: 0, committedTokens: 0 })) {
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

	/** Return immutable registration identities for code-owned adapter binding. */
	registeredDefinitions(): RepositoryCampaignDefinition[] {
		return [...this.definitions.values()].map((definition) => structuredClone(definition))
	}

	async status(now = new Date()): Promise<Record<string, unknown>> {
		const state = await this.read(now)
		const definitions = [...this.definitions.values()]
		const scopedAuthorities = await Promise.all(definitions.map(async (definition) => [definition.id, await this.budgetAuthority(definition.id)] as const))
		const byCampaign = new Map(scopedAuthorities)
		const authority = definitions.length ? byCampaign.get(definitions[0]!.id)! : await this.budgetAuthority()
		const totals = this.aggregateTotals(state)
		return {
			month: state.month,
			budget: { authority: authority.mode, adapter: authority.mode === "fleet-v2-readonly" || authority.mode === "fleet-v2-budget-only" ? authority.mode : authority.available ? authority.mode : "none", available: authority.available,
				provisioningAvailable: snapshotCanProvision(authority),
				limitMicros: authority.limitMicros, limitTokens: authority.limitTokens, externalCommittedMicros: authority.committedMicros,
				externalCommittedTokens: authority.committedTokens, ...totals,
				...(authority.monthly ? { monthly: authority.monthly } : {}),
				...(authority.campaignLifetime ? { campaignLifetime: authority.campaignLifetime } : {}),
				remainingMicros: Math.max(0, authority.limitMicros - authority.committedMicros - totals.settledMicros - totals.reservedMicros - totals.ambiguousMicros),
				remainingTokens: Math.max(0, authority.limitTokens - authority.committedTokens - totals.settledTokens - totals.reservedTokens - totals.ambiguousTokens) },
			campaigns: definitions.map((definition) => {
				const campaign = state.campaigns[definition.id] ?? this.initialCampaign()
				const scopedAuthority = byCampaign.get(definition.id)!
				const missing = this.missingReadiness(definition, scopedAuthority, campaign, state)
				const exhausted = this.isExhausted(campaign)
				const stateName = this.campaignState(definition.id, campaign, missing, exhausted, state.jobs)
				const readiness = missing.some((reason) => reason !== "aggregate-budget-exhausted") ? "blocked-prerequisite" :
					exhausted || missing.includes("aggregate-budget-exhausted") ? "budget-exhausted" : "ready"
				return { ...definition, qualification: undefined, ...campaign, exhausted, state: stateName,
					readiness, readinessReasons: missing }
			}),
			drafts: Object.values(state.drafts).map((draft) => ({ ...draft, readiness: "blocked-prerequisite", readinessReasons: ["owner-provisioned-enrollment-review"] })),
			jobs: state.jobs.slice(-100), history: state.history.slice(-100), intakeRecords: (state.intakeRecords ?? []).slice(-100),
		}
	}

	/** Full job view for the owner-only recovery command; never exposed by the HTTP API. */
	async recoveryView(jobId: string, now = new Date()): Promise<{ job: RepositoryCampaignJob | undefined; activeJobs: RepositoryCampaignJob[] }> {
		if (!/^[0-9a-f-]{36}$/.test(jobId)) throw new Error("recovery job identity is invalid")
		const state = await this.read(now)
		const target = state.jobs.find((job) => job.id === jobId)
		return { job: target ? structuredClone(target) : undefined,
			activeJobs: state.jobs.filter((job) => job.status === "running").map((job) => structuredClone(job)) }
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
		const authority = await this.budgetAuthority(id)
		await this.update((s) => {
			const c = this.campaign(s, id)
			if (micros < c.settledMicros + c.reservedMicros + c.ambiguousMicros || tokens < c.settledTokens + c.reservedTokens + c.ambiguousTokens) throw new Error("campaign budget is below committed usage")
			const allocated = Object.values(s.campaigns).reduce((sum, campaign) => ({ micros: sum.micros + campaign.budgetLimitMicros, tokens: sum.tokens + campaign.budgetLimitTokens }), { micros: 0, tokens: 0 })
			const repositoryLimits = authority.repositoryLifetime
			if (authority.mode === "unavailable") throw new Error("authoritative broker budget is unavailable")
			if (authority.mode === "synthetic-test" && !authority.available) {
				throw new Error("repository budgets exceed authoritative Fleet allocation or broker authority is unavailable")
			}
			if (isFleetAuthority(authority.mode) && (!repositoryLimits || micros > repositoryLimits.limitMicros || tokens > repositoryLimits.limitTokens)) {
				throw new Error("repository budget exceeds authoritative Fleet per-repository allocation")
			}
			if (allocated.micros - c.budgetLimitMicros + micros > authority.limitMicros || allocated.tokens - c.budgetLimitTokens + tokens > authority.limitTokens) {
				throw new Error("repository budgets exceed authoritative Fleet aggregate allocation")
			}
			if (c.budgetLimitMicros !== micros || c.budgetLimitTokens !== tokens) {
				c.budgetLimitMicros = micros; c.budgetLimitTokens = tokens; c.epoch += 1; this.event(s, id, "budget", now)
				if (this.isExhausted(c) && c.enabled) { c.enabled = false; c.epoch += 1; this.event(s, id, "budget-exhausted", now) }
			}
		}, now)
	}

	async start(id: string, now = new Date()): Promise<void> {
		this.requireDefinition(id)
		const authority = await this.budgetAuthority(id)
		await this.update((s) => {
			const c = this.campaign(s, id)
			if (c.enabled) return
			const reasons = this.missingReadiness(this.requireDefinition(id), authority, c, s)
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
			assertRequestClaimCurrent(state, claim)
			// Keep both admissions and request invocation inside the local Stop fence.
			await invokeClaimStart(start, beforeStart, (request) => {
				if (pending) throw new Error("campaign request was started more than once")
				pending = request
				void request.catch(() => undefined)
			})
			if (!pending) throw new Error("campaign request-start did not invoke the request")
		} finally { await release() }
		return await pending!
	}

	async assertClaimCurrent(claim: ClaimedRepositoryJob): Promise<void> {
		if (!claim) throw new Error("campaign claim is invalid")
		const release = await this.lock()
		try {
			const state = await this.loadState(new Date())
			assertRequestClaimCurrent(state, claim, "campaign claim is stale or stopped")
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

	/** Persist one OSV source/advisory observation and queue only explicitly recipe-supported CVEs. */
	async observePublishedAdvisory(input: ObservedAdvisoryInput, now = new Date()): Promise<{ changed: boolean; queued: boolean; record: RepositoryAdvisoryIntakeRecord }> {
		this.requireDefinition(input.campaignId)
		if (!/^[a-f0-9]{40}$/.test(input.publicBaseRevision) || !validAdvisoryId(input.advisoryId) ||
			(input.eligible && !input.advisoryId.startsWith("CVE-")) || !/^[a-f0-9]{64}$/.test(input.snapshotSha256) ||
		typeof input.eligible !== "boolean") throw new Error("published advisory observation is invalid")
		return this.update((s) => observePublishedAdvisoryState(s, input, now), now)
	}

	/** Queue the one owner-approved Curl known-advisory qualification, separate from the OSV discovery feed. */
	async enqueueKnownQualification(input: { campaignId: string; advisoryId: string; publicBaseRevision: string; snapshotSha256: string;
		sourceUrl: string; sourceContentSha256: string; affectedRange: string }, now = new Date()): Promise<RepositoryCampaignJob> {
		if (input.campaignId !== CURL_CAMPAIGN_ID || input.advisoryId !== CURL_FIXED_ADVISORY || input.publicBaseRevision !== CURL_DEBIAN_PUBLIC_BASE_REVISION ||
			input.snapshotSha256 !== CURL_DEBIAN_SNAPSHOT_SHA256 || input.sourceUrl !== CURL_DEBIAN_SOURCE_URL ||
			input.sourceContentSha256 !== CURL_DEBIAN_SOURCE_HTML_SHA256 || input.affectedRange !== CURL_DEBIAN_AFFECTED_RANGE) {
			throw new Error("known advisory qualification is outside the owner-approved Curl snapshot")
		}
		this.requireDefinition(input.campaignId)
		return this.update((s) => {
			const existing = (s.intakeRecords ??= []).find((row) => row.campaignId === input.campaignId && row.publicBaseRevision === input.publicBaseRevision &&
				row.advisoryId === input.advisoryId && row.source === "debian-tracker-snapshot")
			if (existing) throw new Error("known advisory qualification has already been recorded")
			if (!s.campaigns[input.campaignId]?.enabled) throw new Error("known advisory qualification requires an enabled campaign")
			const job: RepositoryCampaignJob = { id: randomUUID(), campaignId: input.campaignId, advisoryId: input.advisoryId, status: "queued",
				epoch: s.campaigns[input.campaignId]!.epoch, createdAt: now.getTime(), updatedAt: now.getTime(), month: s.month,
				reservedMicros: 0, settledMicros: 0, reservedTokens: 0, settledTokens: 0, purpose: "qualification" }
			s.jobs.push(job)
			const record: RepositoryAdvisoryIntakeRecord = { campaignId: input.campaignId, publicBaseRevision: input.publicBaseRevision,
				advisoryId: input.advisoryId, snapshotSha256: input.snapshotSha256, disposition: "eligible", firstSeenAt: now.getTime(),
				lastSeenAt: now.getTime(), jobId: job.id, source: "debian-tracker-snapshot", sourceUrl: input.sourceUrl,
				sourceContentSha256: input.sourceContentSha256 }
			if (s.jobs.length > MAX_JOBS || s.intakeRecords.length >= MAX_INTAKE_RECORDS) throw new Error("known advisory qualification storage limit reached")
			s.intakeRecords.push(record)
			return { ...job }
		}, now)
	}

	/** Create one explicit child retry for a failed, zero-cost, proof-backed Curl qualification. */
	async enqueueVerifiedNoCallRetry(parentJobId: string, confirmation: string, now = new Date()): Promise<RepositoryCampaignJob> {
		if (!validId(parentJobId) || confirmation !== `CONFIRM RETRY NO-CALL ${parentJobId}`) {
			throw new Error("explicit no-call retry confirmation is required")
		}
		const definition = this.requireDefinition(CURL_CAMPAIGN_ID)
		const authority = await this.budgetAuthority(CURL_CAMPAIGN_ID)
		const liveDispatchReady = authority.mode === "fleet-v2" && authority.available && authority.globalEnabled === true &&
			authority.canAdmit === true && authority.repositoryEnabled === true && !!authority.runId &&
			!!authority.runExpiresAtMs && authority.runExpiresAtMs > now.getTime()
		const snapshotProvisioningReady = authority.mode === "fleet-v2-readonly" && authority.snapshotOnly === true &&
			authority.globalEnabled === true && authority.canAdmit === true && authority.repositoryEnabled === true && snapshotCanProvision(authority)
		if (!liveDispatchReady && !snapshotProvisioningReady) {
			throw new Error("no-call retry requires fresh enabled Fleet provisioning authority")
		}
		return this.update((s) => {
			const campaign = this.campaign(s, CURL_CAMPAIGN_ID)
			if (!campaign.enabled || this.missingReadiness(definition, authority, campaign, s).length || this.isExhausted(campaign)) {
				throw new Error("no-call retry requires a ready campaign with remaining lifetime budget")
			}
			const parent = s.jobs.find((job) => job.id === parentJobId)
			const proofRefs = parent?.progress?.evidenceRefs.filter((ref) => ref.kind === "no-call-proof") ?? []
			if (!parent || (parent.retryOf !== undefined && !validId(parent.retryOf)) || parent.campaignId !== CURL_CAMPAIGN_ID || parent.advisoryId !== CURL_FIXED_ADVISORY ||
				parent.purpose !== "qualification" || parent.status !== "failed" || parent.reservedMicros !== 0 || parent.reservedTokens !== 0 ||
				parent.settledMicros !== 0 || parent.settledTokens !== 0 || proofRefs.length !== 1 || !/^[a-f0-9]{64}$/.test(proofRefs[0]!.id)) {
				throw new Error("retry parent is not a recovered zero-cost Curl qualification")
			}
			let intakeRoot = parent
			const seenParents = new Set<string>([parent.id])
			while (intakeRoot.retryOf !== undefined) {
				const retryParent = s.jobs.find((job) => job.id === intakeRoot.retryOf)
				if (!retryParent || seenParents.has(retryParent.id) || retryParent.campaignId !== parent.campaignId ||
					retryParent.advisoryId !== parent.advisoryId || retryParent.purpose !== "qualification") {
					throw new Error("retry lineage is invalid")
				}
				seenParents.add(retryParent.id)
				intakeRoot = retryParent
			}
			const intake = s.intakeRecords.find((row) => row.source === "debian-tracker-snapshot" && row.jobId === intakeRoot.id &&
				row.campaignId === parent.campaignId && row.advisoryId === parent.advisoryId && row.snapshotSha256 === CURL_DEBIAN_SNAPSHOT_SHA256)
			if (!intake) throw new Error("retry parent has no matching immutable advisory intake record")
			if (s.jobs.some((job) => job.retryOf === parent.id)) throw new Error("this failed qualification already has a retry child")
			if (s.jobs.some((job) => job.campaignId === CURL_CAMPAIGN_ID && (job.status === "queued" || job.status === "running"))) {
				throw new Error("another Curl qualification job is active")
			}
			const totals = this.aggregateTotals(s)
			const requiredMicros = 8_000, requiredTokens = 72_000
			const monthly = authority.monthly!, campaignLifetime = authority.campaignLifetime!, repositoryLifetime = authority.repositoryLifetime!
			if (campaign.settledMicros + campaign.reservedMicros + campaign.ambiguousMicros + requiredMicros > campaign.budgetLimitMicros ||
				campaign.settledTokens + campaign.reservedTokens + campaign.ambiguousTokens + requiredTokens > campaign.budgetLimitTokens ||
				authority.committedMicros + totals.settledMicros + totals.reservedMicros + totals.ambiguousMicros + requiredMicros > authority.limitMicros ||
				authority.committedTokens + totals.settledTokens + totals.reservedTokens + totals.ambiguousTokens + requiredTokens > authority.limitTokens ||
				monthly.settledMicros + monthly.reservedMicros + monthly.ambiguousMicros + requiredMicros > monthly.limitMicros ||
				campaignLifetime.settledMicros + campaignLifetime.reservedMicros + campaignLifetime.ambiguousMicros + requiredMicros > campaignLifetime.limitMicros ||
				campaignLifetime.settledTokens + campaignLifetime.reservedTokens + campaignLifetime.ambiguousTokens + requiredTokens > campaignLifetime.limitTokens ||
				repositoryLifetime.settledMicros + repositoryLifetime.reservedMicros + repositoryLifetime.ambiguousMicros + requiredMicros > repositoryLifetime.limitMicros ||
				repositoryLifetime.settledTokens + repositoryLifetime.reservedTokens + repositoryLifetime.ambiguousTokens + requiredTokens > repositoryLifetime.limitTokens) {
				throw new Error("no-call retry exceeds remaining Fleet or local budget")
			}
			if (s.jobs.length >= MAX_JOBS) throw new Error("campaign job queue is full")
			const child: RepositoryCampaignJob = { id: randomUUID(), retryOf: parent.id, campaignId: parent.campaignId,
				advisoryId: parent.advisoryId, status: "queued", epoch: campaign.epoch, createdAt: now.getTime(), updatedAt: now.getTime(),
				month: s.month, reservedMicros: 0, settledMicros: 0, reservedTokens: 0, settledTokens: 0, purpose: "qualification" }
			s.jobs.push(child)
			return structuredClone(child)
		}, now)
	}

	/** Queue one explicit historical Curl repair qualification, distinct from the read-only qualification purpose. */
	async enqueueKnownRepair(input: { campaignId: string; advisoryId: string; publicBaseRevision: string; snapshotSha256: string;
		sourceUrl: string; sourceContentSha256: string; affectedRange: string }, now = new Date()): Promise<RepositoryCampaignJob> {
		if (input.campaignId !== CURL_REPAIR_CAMPAIGN_ID || input.advisoryId !== CURL_FIXED_ADVISORY || input.publicBaseRevision !== CURL_DEBIAN_PUBLIC_BASE_REVISION ||
			input.snapshotSha256 !== CURL_DEBIAN_SNAPSHOT_SHA256 || input.sourceUrl !== CURL_DEBIAN_SOURCE_URL ||
			input.sourceContentSha256 !== CURL_DEBIAN_SOURCE_HTML_SHA256 || input.affectedRange !== CURL_DEBIAN_AFFECTED_RANGE) {
			throw new Error("known advisory repair is outside the owner-approved Curl snapshot")
		}
		this.requireDefinition(input.campaignId)
		return this.update((s) => {
			const existing = (s.intakeRecords ??= []).find((row) => row.campaignId === input.campaignId && row.publicBaseRevision === input.publicBaseRevision &&
				row.advisoryId === input.advisoryId && row.source === "debian-tracker-repair-snapshot")
			if (existing) throw new Error("known advisory repair has already been recorded")
			if (!s.campaigns[input.campaignId]?.enabled) throw new Error("known advisory repair requires an enabled campaign")
			const job: RepositoryCampaignJob = { id: randomUUID(), campaignId: input.campaignId, advisoryId: input.advisoryId, status: "queued",
				epoch: s.campaigns[input.campaignId]!.epoch, createdAt: now.getTime(), updatedAt: now.getTime(), month: s.month,
				reservedMicros: 0, settledMicros: 0, reservedTokens: 0, settledTokens: 0, purpose: "repair" }
			const record: RepositoryAdvisoryIntakeRecord = { campaignId: input.campaignId, publicBaseRevision: input.publicBaseRevision,
				advisoryId: input.advisoryId, snapshotSha256: input.snapshotSha256, disposition: "eligible", firstSeenAt: now.getTime(),
				lastSeenAt: now.getTime(), jobId: job.id, source: "debian-tracker-repair-snapshot", sourceUrl: input.sourceUrl,
				sourceContentSha256: input.sourceContentSha256 }
			if (s.jobs.length >= MAX_JOBS || s.intakeRecords.length >= MAX_INTAKE_RECORDS) throw new Error("known advisory repair storage limit reached")
			s.jobs.push(job)
			s.intakeRecords.push(record)
			return { ...job }
		}, now)
	}

	async enqueueKnownRepairV2(input: { campaignId: string; advisoryId: string; publicBaseRevision: string; snapshotSha256: string;
		sourceUrl: string; sourceContentSha256: string; affectedRange: string }, now = new Date()): Promise<RepositoryCampaignJob> {
		if (!repairIntakeMatches(input, CURL_REPAIR_V2_CAMPAIGN_ID)) throw new Error("known v2 repair is outside the pinned Curl snapshot")
		this.requireDefinition(CURL_REPAIR_V2_CAMPAIGN_ID)
		return await this.update((s) => queuePinnedRepairInState(s, input, "debian-tracker-repair-v2-snapshot", now), now)
	}

	async observeKnownRepairAdvisoryV2(input: { campaignId: string; advisoryId: string; publicBaseRevision: string;
		snapshotSha256: string; sourceUrl: string; sourceContentSha256: string; affectedRange: string }, now = new Date()): Promise<{ changed: boolean; queued: boolean }> {
		if (!repairIntakeMatches(input, CURL_REPAIR_V2_CAMPAIGN_ID)) throw new Error("known v2 repair observation is outside the pinned Curl snapshot")
		this.requireDefinition(CURL_REPAIR_V2_CAMPAIGN_ID)
		return await this.update((s) => {
			const records = s.intakeRecords ??= []
			const existing = records.find((row) => row.campaignId === input.campaignId &&
				row.publicBaseRevision === input.publicBaseRevision && row.advisoryId === input.advisoryId &&
				row.source === "debian-tracker-repair-v2-snapshot")
			if (existing) {
				const existingJob = existing.jobId ? s.jobs.find((job) => job.id === existing.jobId) : undefined
				if (!validPinnedDebianIntake(existing) || existing.disposition !== "eligible" || !existing.jobId ||
					!existingJob || !validRepairV2Job(existingJob, s)) {
					throw new Error("known Curl v2 repair intake record is incomplete or changed")
				}
				return { changed: false, queued: false }
			}
			const campaign = s.campaigns[input.campaignId]
			if (!campaign?.enabled) throw new Error("known v2 advisory repair requires an enabled campaign")
			queuePinnedRepairInState(s, input, "debian-tracker-repair-v2-snapshot", now)
			return { changed: true, queued: true }
		}, now)
	}

	/** Queue one explicit no-call retry for the pinned historical Curl v2 job. */
	async enqueueRecoveredCurlRepairV2Retry(parentId: string, confirmation: string,
		proofSha256: string, now = new Date()): Promise<RepositoryCampaignJob> {
		if (!validId(parentId) ||
			confirmation !== `CONFIRM RETRY RECOVERED CURL V2 NO-CALL ${parentId}` ||
			!/^[a-f0-9]{64}$/.test(proofSha256)) {
			throw new Error("explicit v2 retry confirmation and proof are required")
		}
		const definition = this.requireDefinition(CURL_REPAIR_V2_CAMPAIGN_ID)
		const authority = await this.budgetAuthority(CURL_REPAIR_V2_CAMPAIGN_ID)
		if (!v2RetryAuthorityReady(authority, definition, now)) {
			throw new Error("fresh enabled v2 Fleet budget authority is unavailable")
		}
		return this.update((s) => this.queueRecoveredV2Retry(
			s, parentId, proofSha256, definition, authority, now,
		), now)
	}

	private queueRecoveredV2Retry(s: CampaignState, parentId: string,
		proofSha256: string, definition: RepositoryCampaignDefinition,
		authority: RepositoryBudgetAuthority, now: Date): RepositoryCampaignJob {
		const campaign = this.campaign(s, CURL_REPAIR_V2_CAMPAIGN_ID)
		const readiness = this.missingReadiness(definition, authority, campaign, s)
		const budget = v2RetryHasBudget(authority, this.aggregateTotals(s), campaign)
		if (!campaign.enabled || readiness.length || !budget) {
			throw new Error("v2 retry requires ready authority and remaining reservation budget")
		}
		const parent = requireV2RetryParent(s, parentId, proofSha256)
		if (s.jobs.length >= MAX_JOBS) throw new Error("campaign job queue is full")
		const child = makeRecoveredV2Retry(parent, campaign.epoch, s.month, now)
		s.jobs.push(child)
		return structuredClone(child)
	}

	/** Create one explicit child for a zero-cost verified historical Curl repair that failed before delivery completed. */
	async enqueueVerifiedHistoricalRepairRetry(parentJobId: string, confirmation: string,
		evidence: { candidateSha256: string; verificationSha256: string }, now = new Date()): Promise<RepositoryCampaignJob> {
		if (!validId(parentJobId) || confirmation !== `CONFIRM RETRY HISTORICAL CURL DELIVERY ${parentJobId}` ||
			!/^[a-f0-9]{64}$/.test(evidence?.candidateSha256 ?? "") || !/^[a-f0-9]{64}$/.test(evidence?.verificationSha256 ?? "")) {
			throw new Error("explicit verified Curl repair retry confirmation and evidence are required")
		}
		const definition = this.requireDefinition(CURL_REPAIR_CAMPAIGN_ID)
		const authority = await this.budgetAuthority(CURL_REPAIR_CAMPAIGN_ID)
		if ((!snapshotCanProvision(authority) && !liveBudgetOnlyAdmission(authority, definition)) ||
			!authority.globalEnabled || !authority.canAdmit || !authority.repositoryEnabled) {
			throw new Error("fresh enabled Fleet budget-only Curl authority is unavailable")
		}
		return this.update((s) => {
			const campaign = this.campaign(s, CURL_REPAIR_CAMPAIGN_ID)
			if (!campaign.enabled || this.missingReadiness(definition, authority, campaign, s).length || this.isExhausted(campaign)) {
				throw new Error("verified Curl repair retry requires a started campaign with fresh prerequisites and remaining budget")
			}
			const parent = s.jobs.find((job) => job.id === parentJobId)
			if (!parent || !retryableHistoricalRepairFailure(parent) || !validRepairJob(parent, s)) {
				throw new Error("retry target is not the failed zero-cost verified Curl delivery attempt")
			}
			const candidateRefs = parent.progress!.evidenceRefs.filter((ref) => ref.kind === "candidate")
			const verificationRefs = parent.progress!.evidenceRefs.filter((ref) => ref.kind === "test-receipt")
			if (candidateRefs.length !== 1 || candidateRefs[0]!.id !== evidence.candidateSha256 ||
				verificationRefs.length !== 1 || verificationRefs[0]!.id !== evidence.verificationSha256) {
				throw new Error("recomputed Curl candidate or protected verification evidence differs from the failed job")
			}
			if (s.jobs.some((job) => job.retryOf === parent.id)) throw new Error("this failed Curl delivery attempt already has a retry child")
			if (s.jobs.some((job) => job.campaignId === CURL_REPAIR_CAMPAIGN_ID && (job.status === "queued" || job.status === "running"))) {
				throw new Error("another Curl repair job is active")
			}
			const totals = this.aggregateTotals(s), monthly = authority.monthly!, campaignLifetime = authority.campaignLifetime!, repositoryLifetime = authority.repositoryLifetime!
			const spend = CURL_REPAIR_RESERVATION.micros, tokens = CURL_REPAIR_RESERVATION.tokens
			if (campaign.settledMicros + campaign.reservedMicros + campaign.ambiguousMicros + spend > campaign.budgetLimitMicros ||
				campaign.settledTokens + campaign.reservedTokens + campaign.ambiguousTokens + tokens > campaign.budgetLimitTokens ||
				authority.committedMicros + totals.settledMicros + totals.reservedMicros + totals.ambiguousMicros + spend > authority.limitMicros ||
				authority.committedTokens + totals.settledTokens + totals.reservedTokens + totals.ambiguousTokens + tokens > authority.limitTokens ||
				monthlyUsage(monthly) + spend > monthly.limitMicros ||
				lifetimeSpend(campaignLifetime) + spend > campaignLifetime.limitMicros ||
				lifetimeTokens(campaignLifetime) + tokens > campaignLifetime.limitTokens ||
				lifetimeSpend(repositoryLifetime) + spend > repositoryLifetime.limitMicros ||
				lifetimeTokens(repositoryLifetime) + tokens > repositoryLifetime.limitTokens) {
				throw new Error("verified Curl repair retry exceeds the fresh remaining budget")
			}
			if (s.jobs.length >= MAX_JOBS) throw new Error("campaign job queue is full")
			const child: RepositoryCampaignJob = { id: randomUUID(), retryOf: parent.id, campaignId: parent.campaignId,
				advisoryId: parent.advisoryId, status: "queued", epoch: campaign.epoch, createdAt: now.getTime(), updatedAt: now.getTime(),
				month: s.month, reservedMicros: 0, settledMicros: 0, reservedTokens: 0, settledTokens: 0, purpose: "repair" }
			s.jobs.push(child)
			return structuredClone(child)
		}, now)
	}

	/** Atomically record the one pinned Debian repair snapshot and queue it once across polls and restarts. */
	async observeKnownRepairAdvisory(input: { campaignId: string; advisoryId: string; publicBaseRevision: string; snapshotSha256: string;
		sourceUrl: string; sourceContentSha256: string; affectedRange: string }, now = new Date()): Promise<{ changed: boolean; queued: boolean; job: RepositoryCampaignJob; record: RepositoryAdvisoryIntakeRecord }> {
		if (input.campaignId !== CURL_REPAIR_CAMPAIGN_ID || input.advisoryId !== CURL_FIXED_ADVISORY || input.publicBaseRevision !== CURL_DEBIAN_PUBLIC_BASE_REVISION ||
			input.snapshotSha256 !== CURL_DEBIAN_SNAPSHOT_SHA256 || input.sourceUrl !== CURL_DEBIAN_SOURCE_URL ||
			input.sourceContentSha256 !== CURL_DEBIAN_SOURCE_HTML_SHA256 || input.affectedRange !== CURL_DEBIAN_AFFECTED_RANGE) {
			throw new Error("known advisory repair observation is outside the owner-approved Curl snapshot")
		}
		this.requireDefinition(input.campaignId)
		return this.update((s) => {
			s.intakeRecords ??= []
			const existing = s.intakeRecords.find((row) => row.campaignId === input.campaignId && row.publicBaseRevision === input.publicBaseRevision &&
				row.advisoryId === input.advisoryId && row.source === "debian-tracker-repair-snapshot")
			if (existing) {
				if (!validPinnedDebianIntake(existing) || existing.disposition !== "eligible" || !existing.jobId) throw new Error("known Curl repair intake record is incomplete or changed")
				const prior = s.jobs.find((job) => job.id === existing.jobId)
				if (!prior || !validRepairJob(prior, s)) throw new Error("known Curl repair intake lost its durable job")
				return { changed: false, queued: false, job: structuredClone(prior), record: { ...existing } }
			}
			const campaign = s.campaigns[input.campaignId]
			if (!campaign?.enabled) throw new Error("known advisory repair requires an enabled campaign")
			if (s.jobs.length >= MAX_JOBS || s.intakeRecords.length >= MAX_INTAKE_RECORDS) throw new Error("known advisory repair storage limit reached")
			const job: RepositoryCampaignJob = { id: randomUUID(), campaignId: input.campaignId, advisoryId: input.advisoryId, status: "queued",
				epoch: campaign.epoch, createdAt: now.getTime(), updatedAt: now.getTime(), month: s.month,
				reservedMicros: 0, settledMicros: 0, reservedTokens: 0, settledTokens: 0, purpose: "repair" }
			const record: RepositoryAdvisoryIntakeRecord = { campaignId: input.campaignId, publicBaseRevision: input.publicBaseRevision,
				advisoryId: input.advisoryId, snapshotSha256: input.snapshotSha256, disposition: "eligible", firstSeenAt: now.getTime(),
				lastSeenAt: now.getTime(), jobId: job.id, source: "debian-tracker-repair-snapshot", sourceUrl: input.sourceUrl,
				sourceContentSha256: input.sourceContentSha256 }
			s.jobs.push(job); s.intakeRecords.push(record)
			return { changed: true, queued: true, job: structuredClone(job), record: { ...record } }
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
		const authority = await this.budgetAuthority(id)
		const budgetOnlyReady = liveBudgetOnlyAdmission(authority, this.requireDefinition(id))
		if (mode.executionKind === "live-cve" && authority.mode !== "fleet-v2" && !budgetOnlyReady) {
			throw new Error("live campaign claims require authoritative Fleet v2 registration")
		}
		return this.update((s) => {
			const c = this.campaign(s, id)
			if (!c.enabled || this.missingReadiness(this.requireDefinition(id), authority, c, s).length) return undefined
			if (this.isExhausted(c)) { c.enabled = false; c.epoch += 1; this.event(s, id, "budget-exhausted", now); return undefined }
			const totals = this.aggregateTotals(s)
			if (authority.committedMicros + totals.settledMicros + totals.reservedMicros + totals.ambiguousMicros + reservation.micros > authority.limitMicros ||
				authority.committedTokens + totals.settledTokens + totals.reservedTokens + totals.ambiguousTokens + reservation.tokens > authority.limitTokens ||
				c.settledMicros + c.reservedMicros + c.ambiguousMicros + reservation.micros > c.budgetLimitMicros ||
				c.settledTokens + c.reservedTokens + c.ambiguousTokens + reservation.tokens > c.budgetLimitTokens) return undefined
			const job = s.jobs.find((candidate) => candidate.campaignId === id && candidate.status === "queued")
			if (!job) return undefined
			if (budgetOnlyReady && (job.purpose !== "repair" || job.advisoryId !== CURL_FIXED_ADVISORY)) return undefined
			const claimId = randomUUID()
			job.status = "running"; job.claimId = claimId; job.epoch = c.epoch; job.reservedMicros = reservation.micros; job.reservedTokens = reservation.tokens; job.updatedAt = now.getTime()
			job.progress = { executionKind: mode.executionKind, workerId: randomUUID(),
				goal: job.purpose === "qualification" ? `Verify the owner-approved evidence for ${job.advisoryId} through the registered pipeline` :
					job.purpose === "repair" ? `Qualify the reviewed historical fix for ${job.advisoryId} and reconcile the private fork` :
					`Assess ${job.advisoryId} and prepare a verified review candidate`, currentTask: "Read registered advisory metadata",
				stage: "intake", completedSteps: [], requiredSteps: [...requiredSteps], lastActionAt: now.getTime(),
				heartbeatAt: now.getTime(), leaseExpiresAt: now.getTime() + REPOSITORY_WORKER_LEASE_MS,
				blocker: null, nextStep: "deduplicate", evidenceRefs: [], boardRef: null }
			c.reservedMicros += reservation.micros; c.reservedTokens += reservation.tokens; this.event(s, id, "claimed", now, job.id)
			return { job: { ...job }, claimId, epoch: c.epoch }
		}, now)
	}

	/** Persist coordinator progress under the same durable lock as the claim and budget. */
	async updateClaimProgress(claim: ClaimedRepositoryJob, patch: RepositoryProgressUpdate, now = new Date()): Promise<void> {
		if (!claim || !validProgressUpdate(patch, claim.job.campaignId)) throw new Error("campaign progress update is invalid")
		await this.update((s) => {
			const job = requireRunningProgressJob(s, claim, now)
			const refs = assertProgressAppendOnly(job.progress!, patch)
			applyProgressUpdate(job, patch, refs, now)
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
	async finish(claim: ClaimedRepositoryJob, result: RepositoryFinishResult, now = new Date()): Promise<void> {
		if (!validFinishResult(claim, result)) throw new Error("campaign result is invalid")
		await this.update((s) => {
			const job = s.jobs.find((candidate) => candidate.id === claim.job.id)
			if (!job) throw new Error("campaign claim is stale")
			validateFinishClaim(job, claim)
			const campaign = this.campaign(s, job.campaignId)
			settleFinishUsage(job, campaign, result)
			job.reservedMicros = 0
			job.reservedTokens = 0
			job.updatedAt = now.getTime()
			updateFinishedProgress(job, result, now)
			if (this.isExhausted(campaign) && campaign.enabled) { campaign.enabled = false; campaign.epoch += 1; this.event(s, job.campaignId, "budget-exhausted", now) }
			this.event(s, job.campaignId, "completed", now, job.id)
		}, now)
	}

	/** Reclassify a recovered ambiguous hold only after an authoritative bridge receipt was verified. */
	async settleRecoveredClaim(claim: ClaimedRepositoryJob, result: RecoveredFinishResult, now = new Date()): Promise<void> {
		if (!validRecoveredFinish(claim, result)) throw new Error("recovered campaign settlement is invalid")
		await this.update((s) => {
			const candidate = s.jobs.find((item) => item.id === claim.job.id)
			if (!candidate || !matchesClaim(candidate, claim)) throw new Error("campaign claim is stale")
			if (isAlreadySettled(candidate, result)) return
			const job = requireRecoveredJob(s, claim)
			const campaign = this.campaign(s, job.campaignId)
			applyRecoveredSettlement(job, campaign, result, now)
			if (this.isExhausted(campaign) && campaign.enabled) { campaign.enabled = false; campaign.epoch += 1; this.event(s, job.campaignId, "budget-exhausted", now) }
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
	private async budgetAuthority(campaignId?: string): Promise<RepositoryBudgetAuthority> {
		const authority = await this.readBudgetAuthority(campaignId)
		if (!validAuthorityBase(authority)) throw new Error("authoritative Fleet budget is unavailable")
		if (authority.mode === "unavailable") {
			if (!validUnavailableAuthority(authority)) throw new Error("unavailable Fleet authority projection is invalid")
			return authority
		}
		if (isFleetAuthority(authority.mode) && !validFleetAuthority(authority, campaignId, (id) => this.requireDefinition(id))) {
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
		const missing = missingQualification(definition)
		const canProvision = snapshotCanProvision(authority)
		const budgetOnlyReady = liveBudgetOnlyAdmission(authority, definition)
		if (!authority.available && !canProvision && !budgetOnlyReady) missing.push("authoritative-broker-budget")
		const repositoryLimits = authority.repositoryLifetime
		if (isFleetAuthority(authority.mode) && (!repositoryLimits || campaign.budgetLimitMicros > repositoryLimits.limitMicros ||
			campaign.budgetLimitTokens > repositoryLimits.limitTokens)) missing.push("repository-budget-allocation")
		const allocations = this.aggregateAllocations(state)
		if (allocations.micros > authority.limitMicros || allocations.tokens > authority.limitTokens) missing.push("aggregate-budget-allocation")
		const totals = this.aggregateTotals(state)
		if ((authority.available || canProvision || budgetOnlyReady) && aggregateBudgetExhausted(authority, totals)) missing.push("aggregate-budget-exhausted")
		if (campaign.budgetLimitMicros <= 0 || campaign.budgetLimitTokens <= 0) missing.push("finite-token-and-spend-allocation")
		return missing
	}
	private aggregateAllocations(state: CampaignState): { micros: number; tokens: number } {
		return Object.values(state.campaigns).reduce((sum, campaign) => ({ micros: sum.micros + campaign.budgetLimitMicros,
			tokens: sum.tokens + campaign.budgetLimitTokens }), { micros: 0, tokens: 0 })
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
		const state = await readCampaignStateFile(this.path) ?? blankState(now)
		if (state.month !== monthNow(now)) state.month = monthNow(now)
		for (const id of this.definitions.keys()) if (!state.campaigns[id]) state.campaigns[id] = this.initialCampaign()
		return state
	}
	private async lock(): Promise<() => Promise<void>> {
		await ensurePrivateCampaignRoot(path.dirname(this.path))
		return acquireCampaignLock(this.lockPath)
	}

	private async write(s: CampaignState): Promise<void> {
		const tmp = `${this.path}.tmp.${process.pid}.${randomUUID()}`
		const f = await fs.open(tmp, constants.constants.O_CREAT | constants.constants.O_EXCL | constants.constants.O_WRONLY, 0o600)
		try { await f.writeFile(`${JSON.stringify(s, null, 2)}\n`); await f.sync() } finally { await f.close() }
		await fs.rename(tmp, this.path)
		const dir = await fs.open(path.dirname(this.path), "r"); try { await dir.sync() } finally { await dir.close() }
	}
}
