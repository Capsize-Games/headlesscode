/** Repository-scoped adapter for Fleet's v2 shared budget authority. */
import { createHash } from "node:crypto"
import { spawn, type StdioOptions } from "node:child_process"
import { constants } from "node:fs"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import { CAMPAIGN_CONTROL_FILE } from "../campaigncontrol/paths.js"
import { prepareDispatchLock } from "../campaigncontrol/runner.js"
import { FLEET_BUDGET_CAMPAIGN_ID, type FleetBudgetLedgerOptions, invokeFleetBudgetBridge,
	resolveFleetBudgetBridgeRelease } from "./fleet-budget-ledger.js"
import { CURL_REPAIR_CAMPAIGN_ID, CURL_REPAIR_POLICY_SHA256, CURL_REPAIR_REPOSITORY_ID,
	CURL_REPAIR_SOURCE_REVISION, CURL_REPAIR_TARGET_REPOSITORY } from "../campaigncontrol/repository-curl-repair.js"
import type {
	OpenRouterBrokerGrant, OpenRouterBrokerReceipt, OpenRouterCallReceipt,
	OpenRouterCallReservation, OpenRouterCallSettlement, OpenRouterDenialReason, OpenRouterInferenceLedger,
} from "./inference-broker.js"

const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/
const HEX = /^[a-f0-9]{64}$/
const REPOSITORY = /^[A-Za-z0-9_.-]{1,39}\/[A-Za-z0-9_.-]{1,100}$/
const MODEL = "meta/muse-spark-1.3-contributor"
const PROFILE = "muse-spark-contributor"
const RETURNED_MODELS = new Set([MODEL, "meta/muse-spark-1.3-contributor-20260902"])
const DENIAL_REASONS = new Set<OpenRouterDenialReason>([
	"metadata-not-admitted", "unsupported-endpoint", "malformed-call-id", "invalid-request", "request-size-limit",
	"budget-or-fence", "job-deadline", "upstream-ambiguous", "usage-unverifiable", "usage-out-of-bounds",
	"settlement-failed", "request-failed",
])
const MAX_HANDOFF_REPLY = 64 * 1024

export interface FleetRepositoryBudgetScope {
	repositoryCampaignId: string
	repositoryId: string
	repository: string
	sourceRevision: string
	policySha256: string
	model: typeof MODEL | "none"
	profileId: typeof PROFILE | "no-model"
	/** Current owner-controlled Fleet repository epoch, distinct from the HCL claim epoch. */
	repositoryEpoch: number
}

export interface FleetRepositoryBudgetLedgerOptions extends FleetBudgetLedgerOptions {
	scope: FleetRepositoryBudgetScope
	/** Test seams only; production uses the bounded cross-process request-start handoff. */
	assertDispatchFence?: () => Promise<void>
	requestStartHandoff?: (message: Record<string, unknown>, onAdmitted: (reply: Reply) => void | Promise<void>) => Promise<void>
}

export interface FleetRepositoryReconciliation {
	calls: Array<{ callId: string; state: string; attemptId: string }>
	receipt: OpenRouterBrokerReceipt
}

export interface FleetRepositoryNoCallProof {
	campaignId: typeof FLEET_BUDGET_CAMPAIGN_ID
	repositoryCampaignId: string
	repositoryId: string
	repository: string
	sourceRevision: string
	policySha256: string
	repositoryEpoch: number
	model: string
	profileId: string
	keyIdentity: string
	proved: boolean
	disposition: "no-recorded-provider-activity" | "expired-unused-grant" | "grant-not-expired" | "activity-present"
	asOfMs: number
	jobId: string
	counts: { grants: number; calls: number; denials: number }
	grant: null | { issuedAtMs: number; deadlineAtMs: number; grantSha256: string; runId: string; controlEpoch: number }
}

export interface FleetRepositoryClosedSessionProof {
	schemaVersion: 1
	campaignId: typeof FLEET_BUDGET_CAMPAIGN_ID
	repositoryCampaignId: string
	repositoryId: string
	repository: string
	sourceRevision: string
	policySha256: string
	repositoryEpoch: number
	model: string
	profileId: string
	keyIdentity: string
	jobId: string
	asOfMs: number
	grant: { grantSha256: string; runId: string; controlEpoch: number; issuedAtMs: number; deadlineAtMs: number; limits: Record<string, unknown> }
	calls: Array<{ callId: string; attemptId: string; requestSha256: string; reservedMicros: number; reservedTokens: number;
		actualMicros: number; actualTokens: number; settlement: Record<string, unknown> }>
	denials: Array<{ statusCode: number; reason: OpenRouterDenialReason; count: number }>
	settledMicros: number
	settledTokens: number
	proofSha256: string
}

export interface FleetRepositoryBudgetSnapshot {
	mode: "fleet-v2" | "fleet-v2-readonly"
	available: boolean
	snapshotOnly?: boolean
	limitMicros: number
	limitTokens: number
	committedMicros: number
	committedTokens: number
	asOfMs: number
	campaignId: string
	globalEnabled: boolean
	canAdmit: boolean
	controlEpoch: number
	runId: string | null
	runExpiresAtMs: number | null
	repositoryCampaignId: string
	repositoryId: string
	repository: string
	sourceRevision: string
	policySha256: string
	model: string
	profileId: string
	repositoryEnabled: boolean
	repositoryEpoch: number
	monthly: { month: string; limitMicros: number; settledMicros: number; reservedMicros: number; ambiguousMicros: number }
	campaignLifetime: { limitMicros: number; limitTokens: number; settledMicros: number; reservedMicros: number; ambiguousMicros: number; settledTokens: number; reservedTokens: number; ambiguousTokens: number }
	legacyLifetime: { settledMicros: number; reservedMicros: number; ambiguousMicros: number; settledTokens: number; reservedTokens: number; ambiguousTokens: number }
	repositoryLifetime: { limitMicros: number; limitTokens: number; settledMicros: number; reservedMicros: number; ambiguousMicros: number; settledTokens: number; reservedTokens: number; ambiguousTokens: number }
}

type Reply = Record<string, unknown>

/**
 * Carries the fixed repository/source/job identity through every v2 bridge call.
 * It shares FleetBudgetInferenceLedger's bridge transport and host key identity;
 * no provider key, repository path or executable crosses the bridge boundary.
 */
export class FleetRepositoryBudgetLedger implements OpenRouterInferenceLedger {
	readonly requiresHostApiKeyIdentity = true
	private readonly options: FleetRepositoryBudgetLedgerOptions
	private readonly invokeTestSeam: boolean
	private readonly scope: FleetRepositoryBudgetScope
	private readonly expectedKeyIdentity: string
	private readonly call: (message: Record<string, unknown>) => Promise<Reply>
	private readonly assertDispatchFence?: () => Promise<void>
	private readonly jobs = new Map<string, OpenRouterBrokerGrant>()
	private readonly idempotency = new Map<string, string>()

	constructor(options: FleetRepositoryBudgetLedgerOptions) {
		if (!/^[a-f0-9]{64}$/.test(options.expectedKeyIdentity)) throw new Error("Fleet repository ledger requires a host API-key identity")
		if (!options.invoke && (options.python !== undefined || options.timeoutMs !== undefined || options.assertDispatchFence !== undefined)) {
			throw new Error("Fleet repository bridge process overrides are restricted to the injected test seam")
		}
		if (!options.invoke && options.requestStartHandoff !== undefined) throw new Error("Fleet request-start handoff override is restricted to the injected test seam")
		this.scope = validateScope(options.scope)
		this.options = options
		this.invokeTestSeam = options.invoke !== undefined
		this.expectedKeyIdentity = options.expectedKeyIdentity
		this.call = (message) => invokeFleetBudgetBridge(message, options)
		this.assertDispatchFence = options.assertDispatchFence
	}

	assertApiKey(apiKey: string): void {
		if (createHash("sha256").update(apiKey).digest("hex") !== this.expectedKeyIdentity) {
			throw new Error("Fleet repository ledger host API-key identity differs from selected broker key")
		}
	}

	async register(grant: OpenRouterBrokerGrant): Promise<number> {
		this.remember(grant)
		const issuedAtMs = grant.issuedAtMs ?? Date.now()
		if (!Number.isSafeInteger(issuedAtMs) || !Number.isSafeInteger(grant.limits.maxDurationMs) || grant.limits.maxDurationMs < 1) {
			throw new Error("invalid Fleet repository job deadline")
		}
		grant.issuedAtMs = issuedAtMs
		const result = await this.call({ ...this.identity(grant, "repository-register"), ...grantLimits(grant), issuedAtMs })
		const deadline = result.deadlineAtMs
		if (!Number.isSafeInteger(deadline) || Number(deadline) <= Date.now() || Number(deadline) > issuedAtMs + grant.limits.maxDurationMs) {
			throw new Error("Fleet authority returned an invalid repository grant deadline")
		}
		return Number(deadline)
	}

	async recordDenial(grant: OpenRouterBrokerGrant, statusCode: number, reason: OpenRouterDenialReason): Promise<void> {
		this.remember(grant)
		if (!Number.isInteger(statusCode) || statusCode < 400 || statusCode > 599 || !DENIAL_REASONS.has(reason)) throw new Error("invalid repository denial")
		await this.call({ ...this.identity(grant, "repository-denial"), statusCode, reason })
	}

	async reserve(grant: OpenRouterBrokerGrant, reservation: OpenRouterCallReservation): Promise<void> {
		this.remember(grant)
		validateReservation(reservation)
		const idempotencyKey = idempotencyKeyFor(this.scope, grant.jobId, reservation)
		const previous = this.idempotency.get(reservation.callId)
		if (previous && previous !== idempotencyKey) throw new Error("repository call identity changed")
		const result = await this.call({ ...this.identity(grant, "repository-reserve"), ...grantLimits(grant),
			callId: reservation.callId, idempotencyKey, requestSha256: reservation.requestSha256,
			reservedMicros: usdMicros(reservation.reservedUsd), reservedTokens: reservation.reservedTokens,
			startedAt: reservation.startedAt })
		if (result.reserved !== true || !["reserved", "reserve-intent"].includes(String(result.state))) {
			throw new Error("Fleet authority did not preserve the repository reservation")
		}
		this.idempotency.set(reservation.callId, idempotencyKey)
	}

	/** Admit and invoke the exact HTTP send while the shared Fleet lock is held, then release before response completion. */
	async requestStart(grant: OpenRouterBrokerGrant, reservation: OpenRouterCallReservation,
		start: () => Promise<Response>, markStarted: (request: Promise<Response>) => void): Promise<void> {
		this.remember(grant)
		validateReservation(reservation)
		const idempotencyKey = idempotencyKeyFor(this.scope, grant.jobId, reservation)
		const message = { ...this.identity(grant, "repository-request-start"), callId: reservation.callId, idempotencyKey }
		const admitAndSend = (result: Reply) => {
			assertRequestStartReply(result, this.scope, grant, reservation)
			if (result.started !== true || result.state !== "transmitting") throw new Error("Fleet repository request-start was not admitted")
			markStarted(start())
		}
		if (this.invokeTestSeam && !this.options.requestStartHandoff) {
			await this.assertDispatchFence?.()
			admitAndSend(await this.call(message))
		} else if (this.options.requestStartHandoff) {
			await this.options.requestStartHandoff(message, admitAndSend)
		} else {
			await invokeRequestStartHandoff(message, this.options, admitAndSend)
		}
	}

	async settle(grant: OpenRouterBrokerGrant, settlement: OpenRouterCallSettlement & { callId: string }): Promise<void> {
		this.remember(grant)
		const idempotencyKey = this.idempotency.get(settlement.callId)
		if (!idempotencyKey) throw new Error("repository settlement has no matching durable reservation")
		const result = await this.call({ ...this.identity(grant, "repository-settle"),
			callId: settlement.callId, idempotencyKey, settlement })
		if (settlement.state === "complete" && result.settled !== true) throw new Error("Fleet authority could not settle measured repository call")
	}

	async receipt(grant: OpenRouterBrokerGrant): Promise<OpenRouterBrokerReceipt> {
		this.remember(grant)
		const result = await this.call({ ...this.identity(grant, "repository-receipt") })
		assertReceiptIdentity(result, this.scope, grant)
		return toBrokerReceipt(result, grant, this.scope)
	}

	/** Read the registered scope's current Fleet epochs and separate monthly/lifetime usage. */
	async budgetSnapshot(): Promise<FleetRepositoryBudgetSnapshot> {
		return await this.readBudgetSnapshot("repository-budget-status")
	}

	/** Read accounting for cold-start UI/budget setup without creating a run or admission. */
	async budgetSnapshotOnly(): Promise<FleetRepositoryBudgetSnapshot> {
		return await this.readBudgetSnapshot("repository-budget-snapshot")
	}

	/** Read immutable Fleet ledgers for explicit owner recovery; this never calls provider authority. */
	async proveNoCall(jobId: string, repositoryEpoch: number): Promise<FleetRepositoryNoCallProof> {
		if (this.scope.model !== MODEL || this.scope.profileId !== PROFILE) throw new Error("no-call proof is unavailable for a budget-only repository scope")
		if (!ID.test(jobId) || !Number.isSafeInteger(repositoryEpoch) || repositoryEpoch < 0) throw new Error("Fleet no-call proof identity is invalid")
		const result = await this.call({ schemaVersion: 2, op: "repository-no-call-proof", campaignId: FLEET_BUDGET_CAMPAIGN_ID,
			repositoryCampaignId: this.scope.repositoryCampaignId, repositoryId: this.scope.repositoryId,
			repository: this.scope.repository, sourceRevision: this.scope.sourceRevision,
			policySha256: this.scope.policySha256, model: this.scope.model, profileId: this.scope.profileId,
			keyIdentity: this.expectedKeyIdentity, repositoryEpoch, jobId })
		const counts = result.counts
		const expected = "asOfMs,campaignId,counts,disposition,grant,jobId,keyIdentity,model,policySha256,profileId,proved,repository,repositoryCampaignId,repositoryEpoch,repositoryId,schemaVersion,sourceRevision"
		const validCounts = !!counts && typeof counts === "object" && !Array.isArray(counts) &&
			Object.keys(counts).sort().join(",") === "calls,denials,grants" &&
			["grants", "calls", "denials"].every((key) => Number.isSafeInteger((counts as Record<string, unknown>)[key]) && Number((counts as Record<string, unknown>)[key]) >= 0)
		const grant = result.grant as Record<string, unknown> | null
		const zeroCallsAndDenials = validCounts && Number((counts as Record<string, number>).calls) === 0 && Number((counts as Record<string, number>).denials) === 0
		const zeroGrant = validCounts && Number((counts as Record<string, number>).grants) === 0 && grant === null
		const grantShape = !!grant && typeof grant === "object" && !Array.isArray(grant) &&
			Object.keys(grant).sort().join(",") === "controlEpoch,deadlineAtMs,grantSha256,issuedAtMs,runId" &&
			typeof grant.issuedAtMs === "number" && Number.isSafeInteger(grant.issuedAtMs) && grant.issuedAtMs >= 0 &&
			typeof grant.deadlineAtMs === "number" && Number.isSafeInteger(grant.deadlineAtMs) &&
			grant.deadlineAtMs > grant.issuedAtMs && typeof grant.controlEpoch === "number" && Number.isSafeInteger(grant.controlEpoch) && grant.controlEpoch >= 0 &&
			typeof grant.runId === "string" && /^[a-z0-9][a-z0-9._-]{0,95}$/.test(grant.runId) &&
			typeof grant.grantSha256 === "string" && /^[a-f0-9]{64}$/.test(grant.grantSha256)
		const expiredUnusedGrant = validCounts && Number((counts as Record<string, number>).grants) === 1 && grantShape &&
			zeroCallsAndDenials && Number(grant!.issuedAtMs) <= Number(result.asOfMs) && Number(grant!.deadlineAtMs) <= Number(result.asOfMs)
		const proved = zeroCallsAndDenials && (zeroGrant || expiredUnusedGrant)
		const disposition = zeroGrant ? "no-recorded-provider-activity" : expiredUnusedGrant ? "expired-unused-grant" :
			grantShape && zeroCallsAndDenials ? "grant-not-expired" : "activity-present"
		if (Object.keys(result).sort().join(",") !== expected || result.schemaVersion !== 2 ||
			result.campaignId !== FLEET_BUDGET_CAMPAIGN_ID || result.repositoryCampaignId !== this.scope.repositoryCampaignId ||
			result.repositoryId !== this.scope.repositoryId || result.repository !== this.scope.repository ||
			result.sourceRevision !== this.scope.sourceRevision || result.policySha256 !== this.scope.policySha256 ||
			result.model !== this.scope.model || result.profileId !== this.scope.profileId || result.keyIdentity !== this.expectedKeyIdentity ||
			result.repositoryEpoch !== repositoryEpoch || result.jobId !== jobId || !validCounts ||
			!Number.isSafeInteger(result.asOfMs) || Date.now() - Number(result.asOfMs) > 60_000 || Number(result.asOfMs) > Date.now() + 60_000 ||
			result.proved !== proved || result.disposition !== disposition) {
			throw new Error("Fleet repository no-call proof is invalid")
		}
		return { campaignId: FLEET_BUDGET_CAMPAIGN_ID, repositoryCampaignId: this.scope.repositoryCampaignId,
			repositoryId: this.scope.repositoryId, repository: this.scope.repository, sourceRevision: this.scope.sourceRevision,
			policySha256: this.scope.policySha256, repositoryEpoch, model: this.scope.model, profileId: this.scope.profileId,
			keyIdentity: this.expectedKeyIdentity, proved,
			disposition: disposition,
			asOfMs: Number(result.asOfMs), jobId, counts: counts as FleetRepositoryNoCallProof["counts"],
			grant: grant as FleetRepositoryNoCallProof["grant"] }
	}

	/** Verify the independent read-only ledger proof for the exact closed two-call Curl qualification session. */
	async proveClosedCurlQualificationSession(jobId: string, repositoryEpoch: number): Promise<FleetRepositoryClosedSessionProof> {
		if (this.scope.repositoryCampaignId !== "curl-maintenance" || this.scope.model !== MODEL || this.scope.profileId !== PROFILE ||
			!ID.test(jobId) || !Number.isSafeInteger(repositoryEpoch) || repositoryEpoch < 0 || repositoryEpoch !== this.scope.repositoryEpoch) {
			throw new Error("closed-session proof is outside the fixed Curl qualification scope")
		}
		const result = await this.call({ schemaVersion: 2, op: "repository-closed-session-proof", campaignId: FLEET_BUDGET_CAMPAIGN_ID,
			repositoryCampaignId: this.scope.repositoryCampaignId, repositoryId: this.scope.repositoryId, repository: this.scope.repository,
			sourceRevision: this.scope.sourceRevision, policySha256: this.scope.policySha256, model: this.scope.model,
			profileId: this.scope.profileId, keyIdentity: this.expectedKeyIdentity, repositoryEpoch, jobId })
		const required = "asOfMs,calls,campaignId,denials,grant,jobId,keyIdentity,model,policySha256,profileId,proofSha256,repository,repositoryCampaignId,repositoryEpoch,repositoryId,schemaVersion,settledMicros,settledTokens,sourceRevision"
		if (Object.keys(result).sort().join(",") !== required || result.schemaVersion !== 1 || result.campaignId !== FLEET_BUDGET_CAMPAIGN_ID ||
			result.repositoryCampaignId !== this.scope.repositoryCampaignId || result.repositoryId !== this.scope.repositoryId ||
			result.repository !== this.scope.repository || result.sourceRevision !== this.scope.sourceRevision ||
			result.policySha256 !== this.scope.policySha256 || result.repositoryEpoch !== repositoryEpoch ||
			result.model !== MODEL || result.profileId !== PROFILE || result.keyIdentity !== this.expectedKeyIdentity || result.jobId !== jobId ||
			!Number.isSafeInteger(result.asOfMs) || Date.now() - Number(result.asOfMs) > 60_000 || Number(result.asOfMs) > Date.now() + 60_000 ||
			!HEX.test(String(result.proofSha256))) throw new Error("Fleet closed-session proof identity is invalid or stale")
		if (sha256Canonical(withoutField(result, "proofSha256")) !== result.proofSha256) throw new Error("Fleet closed-session proof digest is forged")
		const expectedLimits = { maxCalls: 2, maxInputTokensPerCall: 32_000, maxOutputTokensPerCall: 4_000, maxTotalTokens: 72_000,
			maxDurationMs: 300_000, maxRequestBytes: 32_768, maxResponseBytes: 65_536, maxInputPricePerMillionUsd: "0.1",
			maxOutputPricePerMillionUsd: "0.2", maxCallSpendUsd: 4_000, maxJobSpendUsd: 8_000, maxCampaignSpendUsd: 20_000 }
		const grant = result.grant
		if (!isRecord(grant) || Object.keys(grant).sort().join(",") !== "controlEpoch,deadlineAtMs,grantSha256,issuedAtMs,limits,runId" ||
			!HEX.test(String(grant.grantSha256)) || !ID.test(String(grant.runId)) || !Number.isSafeInteger(grant.controlEpoch) ||
			Number(grant.controlEpoch) < 0 || !Number.isSafeInteger(grant.issuedAtMs) || !Number.isSafeInteger(grant.deadlineAtMs) ||
			Number(grant.issuedAtMs) < 0 || Number(grant.issuedAtMs) >= Number(grant.deadlineAtMs) ||
			Number(grant.deadlineAtMs) > Number(grant.issuedAtMs) + 300_000 || Number(grant.deadlineAtMs) > Number(result.asOfMs) ||
			!isRecord(grant.limits) || canonicalJson(grant.limits) !== canonicalJson(expectedLimits)) {
			throw new Error("Fleet closed-session grant is active or outside the fixed call ceiling")
		}
		if (!Array.isArray(result.calls) || result.calls.length !== 2 || !Array.isArray(result.denials) || result.denials.length !== 1 ||
			!isRecord(result.denials[0]) || Object.keys(result.denials[0]).sort().join(",") !== "count,reason,statusCode" ||
			result.denials[0].statusCode !== 429 || result.denials[0].reason !== "budget-or-fence" || result.denials[0].count !== 1) {
			throw new Error("Fleet closed-session proof does not show the exact pre-forward cap denial")
		}
		const calls = result.calls.map((value) => {
			if (!isRecord(value) || Object.keys(value).sort().join(",") !== "actualMicros,actualTokens,attemptId,callId,requestSha256,reservedMicros,reservedTokens,settlement" ||
				!ID.test(String(value.callId)) || !ID.test(String(value.attemptId)) || !HEX.test(String(value.requestSha256)) ||
				value.reservedMicros !== 4_000 || !Number.isSafeInteger(value.reservedTokens) || Number(value.reservedTokens) < 1 || Number(value.reservedTokens) > 36_000 ||
				!Number.isSafeInteger(value.actualMicros) || Number(value.actualMicros) < 0 || Number(value.actualMicros) > Number(value.reservedMicros) ||
				!Number.isSafeInteger(value.actualTokens) || Number(value.actualTokens) < 0 || Number(value.actualTokens) > Number(value.reservedTokens) ||
				!isRecord(value.settlement) || !validClosedSessionSettlement(value.settlement, Number(value.actualMicros), Number(value.actualTokens), Number(value.reservedTokens))) {
				throw new Error("Fleet closed-session proof contains an unsettled or mismatched call")
			}
			return value as unknown as FleetRepositoryClosedSessionProof["calls"][number]
		})
		if (new Set(calls.map((call) => call.callId)).size !== 2 || new Set(calls.map((call) => call.attemptId)).size !== 2) {
			throw new Error("Fleet closed-session call identities are duplicated")
		}
		const settledMicros = calls.reduce((sum, call) => sum + call.actualMicros, 0)
		const settledTokens = calls.reduce((sum, call) => sum + call.actualTokens, 0)
		if (settledMicros > 8_000 || settledTokens > 72_000 || result.settledMicros !== settledMicros || result.settledTokens !== settledTokens) {
			throw new Error("Fleet closed-session aggregate usage does not match its exact call receipts")
		}
		return result as unknown as FleetRepositoryClosedSessionProof
	}

	private async readBudgetSnapshot(op: "repository-budget-status" | "repository-budget-snapshot"): Promise<FleetRepositoryBudgetSnapshot> {
		const result = await this.call({ schemaVersion: 2, op, campaignId: FLEET_BUDGET_CAMPAIGN_ID,
			repositoryCampaignId: this.scope.repositoryCampaignId, repositoryId: this.scope.repositoryId,
			repository: this.scope.repository, sourceRevision: this.scope.sourceRevision,
			policySha256: this.scope.policySha256, model: this.scope.model, profileId: this.scope.profileId,
			keyIdentity: this.expectedKeyIdentity })
		const monthly = result.monthly
		const campaignLifetime = result.campaignLifetime
		const legacyLifetime = result.legacyLifetime
		const repositoryLifetime = result.repositoryLifetime
		const budgetOnly = this.scope.model === "none" && this.scope.profileId === "no-model"
		const snapshotOnly = op === "repository-budget-snapshot" || budgetOnly
		const snapshotRunValid = budgetOnly
			? (result.runId === null && result.runExpiresAtMs === null) ||
				(typeof result.runId === "string" && ID.test(result.runId) && Number.isSafeInteger(result.runExpiresAtMs) && Number(result.asOfMs) < Number(result.runExpiresAtMs))
			: result.runId === null && result.runExpiresAtMs === null
		if (result.schemaVersion !== 2 || typeof result.available !== "boolean" || (snapshotOnly && result.snapshotOnly !== true) ||
			(!snapshotOnly && result.snapshotOnly !== undefined && result.snapshotOnly !== false) || !Number.isSafeInteger(result.asOfMs) ||
			result.campaignId !== FLEET_BUDGET_CAMPAIGN_ID || typeof result.globalEnabled !== "boolean" || typeof result.canAdmit !== "boolean" ||
			Date.now() - Number(result.asOfMs) > 60_000 || Number(result.asOfMs) > Date.now() + 60_000 ||
			!Number.isSafeInteger(result.controlEpoch) || (snapshotOnly
				? !snapshotRunValid || result.available !== false
				: typeof result.runId !== "string" || !ID.test(result.runId) || !Number.isSafeInteger(result.runExpiresAtMs) || Number(result.asOfMs) >= Number(result.runExpiresAtMs)) ||
			result.repositoryCampaignId !== this.scope.repositoryCampaignId || result.repositoryId !== this.scope.repositoryId ||
			result.repository !== this.scope.repository || result.sourceRevision !== this.scope.sourceRevision ||
			result.policySha256 !== this.scope.policySha256 || result.model !== this.scope.model || result.profileId !== this.scope.profileId ||
			typeof result.repositoryEnabled !== "boolean" || !Number.isSafeInteger(result.repositoryEpoch) || Number(result.repositoryEpoch) < 0 ||
			!isMonthlyUsage(monthly) || !isLifetimeUsage(campaignLifetime, 20_000, 108_000) ||
			!isLifetimeUsage(legacyLifetime) || !isLifetimeUsage(repositoryLifetime, undefined, undefined, true)) {
			throw new Error("Fleet repository budget snapshot is invalid")
		}
		const externalMicros = Number(legacyLifetime.settledMicros) + Number(legacyLifetime.reservedMicros) + Number(legacyLifetime.ambiguousMicros)
		const externalTokens = Number(legacyLifetime.settledTokens) + Number(legacyLifetime.reservedTokens) + Number(legacyLifetime.ambiguousTokens)
		const monthlyUsed = Number(monthly.settledMicros) + Number(monthly.reservedMicros) + Number(monthly.ambiguousMicros)
		const campaignSpend = Number(campaignLifetime.settledMicros) + Number(campaignLifetime.reservedMicros) + Number(campaignLifetime.ambiguousMicros)
		const campaignTokens = Number(campaignLifetime.settledTokens) + Number(campaignLifetime.reservedTokens) + Number(campaignLifetime.ambiguousTokens)
		const repositorySpend = Number(repositoryLifetime.settledMicros) + Number(repositoryLifetime.reservedMicros) + Number(repositoryLifetime.ambiguousMicros)
		const repositoryTokens = Number(repositoryLifetime.settledTokens) + Number(repositoryLifetime.reservedTokens) + Number(repositoryLifetime.ambiguousTokens)
		const derivedAvailable = !snapshotOnly && result.globalEnabled === true && result.canAdmit === true && result.repositoryEnabled === true &&
			monthlyUsed < Number(monthly.limitMicros) && campaignSpend < 20_000 && campaignTokens < 108_000 &&
			repositorySpend < Number(repositoryLifetime.limitMicros) && repositoryTokens < Number(repositoryLifetime.limitTokens)
		if (result.externalCommittedMicros !== externalMicros || result.externalCommittedTokens !== externalTokens ||
			result.available !== derivedAvailable || !Number.isSafeInteger(monthly.limitMicros) || Number(monthly.limitMicros) > 5_000_000 ||
			Number(repositoryLifetime.limitMicros) > 20_000 || Number(repositoryLifetime.limitTokens) > 108_000 ||
			monthlyUsed > Number(monthly.limitMicros) || campaignSpend > 20_000 || campaignTokens > 108_000 ||
			repositorySpend > Number(repositoryLifetime.limitMicros) || repositoryTokens > Number(repositoryLifetime.limitTokens)) {
			throw new Error("Fleet repository budget snapshot counters are inconsistent")
		}
		return { mode: snapshotOnly ? "fleet-v2-readonly" : "fleet-v2", available: result.available,
			...(snapshotOnly ? { snapshotOnly: true } : {}), limitMicros: 20_000, limitTokens: 108_000,
			committedMicros: externalMicros, committedTokens: externalTokens, asOfMs: Number(result.asOfMs),
			campaignId: FLEET_BUDGET_CAMPAIGN_ID, globalEnabled: result.globalEnabled, canAdmit: result.canAdmit,
			controlEpoch: Number(result.controlEpoch), runId: result.runId === null ? null : String(result.runId),
			runExpiresAtMs: result.runExpiresAtMs === null ? null : Number(result.runExpiresAtMs),
			repositoryCampaignId: String(result.repositoryCampaignId), repositoryId: String(result.repositoryId),
			repository: String(result.repository), sourceRevision: String(result.sourceRevision), policySha256: String(result.policySha256),
			model: String(result.model), profileId: String(result.profileId), repositoryEnabled: result.repositoryEnabled,
			repositoryEpoch: Number(result.repositoryEpoch), monthly: monthly as FleetRepositoryBudgetSnapshot["monthly"],
			campaignLifetime: campaignLifetime as FleetRepositoryBudgetSnapshot["campaignLifetime"],
			legacyLifetime: legacyLifetime as FleetRepositoryBudgetSnapshot["legacyLifetime"],
			repositoryLifetime: repositoryLifetime as FleetRepositoryBudgetSnapshot["repositoryLifetime"] }
	}

	async reconcile(grant: OpenRouterBrokerGrant, callId?: string): Promise<FleetRepositoryReconciliation> {
		this.remember(grant)
		if (callId !== undefined && !ID.test(callId)) throw new Error("invalid repository reconciliation call id")
		const result = await this.call({ ...this.identity(grant, "repository-reconcile"), ...(callId ? { callId } : {}) })
		assertReceiptIdentity(result, this.scope, grant)
		const rows = result.calls
		if (!Array.isArray(rows) || rows.length > grant.limits.maxCalls) throw new Error("Fleet repository reconciliation response is invalid")
		const calls = rows.map((row) => {
			if (!isRecord(row) || !ID.test(String(row.callId)) || !ID.test(String(row.attemptId)) ||
				!new Set(["reserve-intent", "reserved", "start-intent", "transmitting", "settled", "ambiguous", "settle-intent"]).has(String(row.state))) {
				throw new Error("Fleet repository reconciliation row is invalid")
			}
			return { callId: String(row.callId), state: String(row.state), attemptId: String(row.attemptId) }
		})
		return { calls, receipt: await this.receipt(grant) }
	}

	private identity(grant: OpenRouterBrokerGrant, op: string): Record<string, unknown> {
		return { schemaVersion: 2, op, campaignId: FLEET_BUDGET_CAMPAIGN_ID,
			repositoryCampaignId: this.scope.repositoryCampaignId, repositoryId: this.scope.repositoryId,
			repository: this.scope.repository, sourceRevision: this.scope.sourceRevision,
			policySha256: this.scope.policySha256, model: this.scope.model, profileId: this.scope.profileId,
			repositoryEpoch: this.scope.repositoryEpoch, jobId: grant.jobId, keyIdentity: this.expectedKeyIdentity }
	}

	private remember(grant: OpenRouterBrokerGrant): void {
		if (!grant || !ID.test(grant.jobId) || grant.limits?.campaignId !== FLEET_BUDGET_CAMPAIGN_ID ||
			grant.model !== this.scope.model || grant.profileId !== this.scope.profileId || grant.model !== MODEL || grant.profileId !== PROFILE ||
			grant.apiKeyIdentity !== this.expectedKeyIdentity ||
			usdMicros(grant.limits.maxJobSpendUsd) > this.scopeMaxSpend() ||
			grant.limits.maxCampaignSpendUsd > 0.02 || grant.limits.maxTotalTokens > this.scopeMaxTokens()) {
			throw new Error("Fleet repository grant differs from its registered source, model, key or lifetime allocation")
		}
		const prior = this.jobs.get(grant.jobId)
		if (prior && (prior.model !== grant.model || prior.profileId !== grant.profileId || prior.apiKeyIdentity !== grant.apiKeyIdentity ||
			prior.limits.maxCampaignSpendUsd !== grant.limits.maxCampaignSpendUsd)) throw new Error("Fleet repository job grant changed")
		this.jobs.set(grant.jobId, grant)
	}

	private scopeMaxSpend(): number { return 20_000 }
	private scopeMaxTokens(): number { return 108_000 }
}

function validateScope(scope: FleetRepositoryBudgetScope): FleetRepositoryBudgetScope {
	const museProfile = scope?.model === MODEL && scope.profileId === PROFILE
	const repairBudgetOnlyProfile = scope?.model === "none" && scope.profileId === "no-model" &&
		scope.repositoryCampaignId === CURL_REPAIR_CAMPAIGN_ID && scope.repositoryId === CURL_REPAIR_REPOSITORY_ID &&
		scope.repository === CURL_REPAIR_TARGET_REPOSITORY && scope.sourceRevision === CURL_REPAIR_SOURCE_REVISION &&
		scope.policySha256 === CURL_REPAIR_POLICY_SHA256
	if (!scope || !ID.test(scope.repositoryCampaignId) || !ID.test(scope.repositoryId) || !REPOSITORY.test(scope.repository) ||
		!(/^[a-f0-9]{40}$|^[a-f0-9]{64}$/).test(scope.sourceRevision) || !HEX.test(scope.policySha256) ||
		(!museProfile && !repairBudgetOnlyProfile) || !Number.isSafeInteger(scope.repositoryEpoch) || scope.repositoryEpoch < 0) {
		throw new Error("Fleet repository budget scope is invalid")
	}
	return Object.freeze({ ...scope })
}

function validateReservation(reservation: OpenRouterCallReservation): void {
	if (!reservation || !ID.test(reservation.callId) || !HEX.test(reservation.requestSha256) ||
		!Number.isSafeInteger(reservation.reservedTokens) || reservation.reservedTokens < 1 ||
		typeof reservation.startedAt !== "string" || reservation.startedAt.length > 64) throw new Error("repository call reservation is invalid")
	}

function idempotencyKeyFor(scope: FleetRepositoryBudgetScope, jobId: string, reservation: OpenRouterCallReservation): string {
	return createHash("sha256").update([scope.repositoryCampaignId, scope.repositoryId, scope.sourceRevision,
		scope.policySha256, jobId, reservation.callId, reservation.requestSha256].join("\0")).digest("hex")
}

function grantLimits(grant: OpenRouterBrokerGrant): Record<string, unknown> {
	const l = grant.limits
	return { maxCalls: l.maxCalls, maxInputTokensPerCall: l.maxInputTokensPerCall,
		maxOutputTokensPerCall: l.maxOutputTokensPerCall, maxTotalTokens: l.maxTotalTokens,
		maxDurationMs: l.maxDurationMs, maxRequestBytes: l.maxRequestBytes, maxResponseBytes: l.maxResponseBytes,
		maxInputPricePerMillionUsd: l.maxInputPricePerMillionUsd, maxOutputPricePerMillionUsd: l.maxOutputPricePerMillionUsd,
		maxCallSpendMicros: usdMicros(l.maxCallSpendUsd), maxJobSpendMicros: usdMicros(l.maxJobSpendUsd),
		maxCampaignSpendMicros: usdMicros(l.maxCampaignSpendUsd) }
}

function usdMicros(value: number): number {
	if (!Number.isFinite(value) || value <= 0) throw new Error("repository spend reservation is invalid")
	const micros = Math.ceil(value * 1_000_000)
	if (!Number.isSafeInteger(micros) || micros > 5_000_000) throw new Error("repository spend reservation exceeds the existing Fleet cap")
	return micros
}

function assertRequestStartReply(result: Reply, scope: FleetRepositoryBudgetScope, grant: OpenRouterBrokerGrant,
	reservation: OpenRouterCallReservation): void {
	if (Object.keys(result).sort().join(",") !== "attemptId,callId,jobId,repositoryCampaignId,repositoryEpoch,repositoryId,started,state" ||
		typeof result.started !== "boolean" || result.jobId !== grant.jobId || result.callId !== reservation.callId ||
		result.repositoryCampaignId !== scope.repositoryCampaignId || result.repositoryId !== scope.repositoryId ||
		result.repositoryEpoch !== scope.repositoryEpoch || typeof result.attemptId !== "string" ||
		!/^rsi-repo-[a-f0-9]{64}$/.test(result.attemptId) ||
		(result.started ? result.state !== "transmitting" : !["reserved", "ambiguous", "settled"].includes(String(result.state)))) {
		throw new Error("Fleet repository request-start identity is invalid")
	}
}

/**
 * The Python bridge and this process share one open-file description for the
 * global dispatch flock. Python emits its admission while holding the flock;
 * this process invokes fetch synchronously, acknowledges that invocation, then
 * retains its descriptor until the Python child exits or is killed.
 */
async function invokeRequestStartHandoff(message: Record<string, unknown>, options: FleetRepositoryBudgetLedgerOptions,
	onAdmitted: (reply: Reply) => void): Promise<void> {
	const payload = Buffer.from(JSON.stringify(message) + "\n", "utf8")
	if (payload.length > 32 * 1024) throw new Error("Fleet request-start exceeds its size bound")
	const { releaseRoot } = await resolveFleetBudgetBridgeRelease()
	const lockPath = await prepareDispatchLock(CAMPAIGN_CONTROL_FILE)
	const lock = await fs.open(lockPath, constants.O_RDWR | constants.O_NOFOLLOW)
	const info = await lock.stat()
	if (!info.isFile() || info.nlink !== 1 || (info.mode & 0o077) !== 0 ||
		(typeof process.getuid === "function" && info.uid !== process.getuid())) {
		await lock.close()
		throw new Error("Fleet request-start lock is not an owner-only regular file")
	}
	const python = options.python ?? "/usr/bin/python3"
	return await new Promise<void>((resolve, reject) => {
		const env: NodeJS.ProcessEnv = { PATH: "/usr/bin:/bin", PYTHONPATH: releaseRoot, PYTHONNOUSERSITE: "1",
			HEADLESSCODE_CAMPAIGN_LOCK_FD: "3" }
		const stdio: StdioOptions = ["pipe", "pipe", "ignore", lock.fd]
		const child = spawn(python, ["-m", "operations.campaign_budget_bridge"], { cwd: releaseRoot, shell: false, env, stdio })
		const stdout = child.stdout, stdin = child.stdin
		if (!stdout || !stdin) { child.kill("SIGKILL"); void lock.close(); reject(new Error("Fleet handoff pipes are unavailable")); return }
		let buffer = Buffer.alloc(0), admitted = false, requestInvoked = false, protocolFault = false, done = false
		let timeoutError = false
		const finish = async (error?: Error) => {
			if (done) return
			done = true
			clearTimeout(timer)
			await lock.close().catch(() => undefined)
			if (error && !requestInvoked) reject(error)
			else resolve()
		}
		const timer = setTimeout(() => {
			timeoutError = true
			child.kill("SIGKILL")
		}, options.timeoutMs ?? 5_000)
		stdout.on("data", (chunk: Buffer) => {
			if (done) return
			buffer = Buffer.concat([buffer, chunk])
			if (buffer.length > MAX_HANDOFF_REPLY) { protocolFault = true; child.kill("SIGKILL"); return }
			if (admitted) { protocolFault = true; child.kill("SIGKILL"); return }
			const newline = buffer.indexOf(10)
			if (newline < 0) return
			if (newline !== buffer.length - 1) { protocolFault = true; child.kill("SIGKILL"); return }
			let reply: Reply
			try {
				const parsed: unknown = JSON.parse(buffer.subarray(0, newline).toString("utf8"))
				if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error()
				reply = parsed as Reply
			} catch { protocolFault = true; child.kill("SIGKILL"); return }
			try {
				onAdmitted(reply)
				requestInvoked = reply.started === true
				admitted = true
				stdin.write(reply.started ? "send-started\n" : "abort\n")
				stdin.end()
			} catch {
				protocolFault = true
				child.kill("SIGKILL")
			}
		})
		child.on("error", () => { void finish(new Error("Fleet request-start bridge is unavailable")) })
		child.on("close", (code) => {
			const error = timeoutError ? new Error("Fleet request-start handoff timed out") :
				!admitted || code !== 0 || protocolFault ? new Error("Fleet request-start handoff failed closed") : undefined
			void finish(error)
		})
		stdin.on("error", () => { protocolFault = true })
		stdin.write(payload)
	})
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

function canonicalJson(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value)
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`
	return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
		.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`
}

function sha256Canonical(value: unknown): string {
	return createHash("sha256").update(canonicalJson(value)).digest("hex")
}

function withoutField(value: Record<string, unknown>, field: string): Record<string, unknown> {
	return Object.fromEntries(Object.entries(value).filter(([key]) => key !== field))
}

function validClosedSessionSettlement(value: Record<string, unknown>, actualMicros: number, actualTokens: number, reservedTokens: number): boolean {
	const keys = Object.keys(value).sort().join(",")
	const required = ["completedAt", "costUsd", "completionTokens", "promptTokens", "providerRequestId", "qualified", "responseSha256", "returnedModel", "returnedProvider", "state"].sort().join(",")
	const optionalCached = keys === [...required.split(","), "cachedPromptTokens"].sort().join(",")
	if (keys !== required && !optionalCached) return false
	const prompt = value.promptTokens, completion = value.completionTokens, cost = value.costUsd
	const tokenFields = Number.isSafeInteger(prompt) && Number(prompt) >= 0 && Number(prompt) <= 32_000 &&
		Number.isSafeInteger(completion) && Number(completion) >= 0 && Number(completion) <= 4_000 &&
		Number(prompt) + Number(completion) === actualTokens && actualTokens <= reservedTokens
	const cached = value.cachedPromptTokens === undefined || (Number.isSafeInteger(value.cachedPromptTokens) &&
		Number(value.cachedPromptTokens) >= 0 && Number(value.cachedPromptTokens) <= Number(prompt))
	const costValid = typeof cost === "number" && Number.isFinite(cost) && cost >= 0 &&
		Math.ceil(cost * 1_000_000 - 1e-9) === actualMicros && actualMicros <= 4_000
	return value.state === "complete" && value.qualified === true && typeof value.returnedModel === "string" && RETURNED_MODELS.has(value.returnedModel) &&
		value.returnedProvider === "meta" && typeof value.providerRequestId === "string" && value.providerRequestId.length > 0 &&
		value.providerRequestId.length <= 256 && HEX.test(String(value.responseSha256)) &&
		typeof value.completedAt === "string" && Number.isFinite(Date.parse(value.completedAt)) && tokenFields && cached && costValid
}

function isUsage(value: unknown, includeLimits: boolean): value is Record<string, unknown> {
	if (!isRecord(value)) return false
	const numbers = ["settledMicros", "reservedMicros", "ambiguousMicros", "settledTokens", "reservedTokens", "ambiguousTokens"]
	if (includeLimits) numbers.push("limitMicros", "limitTokens")
	return Object.keys(value).sort().join(",") === numbers.sort().join(",") &&
		numbers.every((key) => Number.isSafeInteger(value[key]) && Number(value[key]) >= 0)
}

function isLifetimeUsage(value: unknown, spendLimit?: number, tokenLimit?: number, allowLimits = false): value is Record<string, unknown> {
	if (!isUsage(value, spendLimit !== undefined || allowLimits)) return false
	if (spendLimit !== undefined) return value.limitMicros === spendLimit && value.limitTokens === tokenLimit
	if (allowLimits) return Number(value.limitMicros) > 0 && Number(value.limitMicros) <= 20_000 &&
		Number(value.limitTokens) > 0 && Number(value.limitTokens) <= 108_000
	return true
}

function isMonthlyUsage(value: unknown): value is Record<string, unknown> {
	return isRecord(value) && typeof value.month === "string" && /^\d{4}-(0[1-9]|1[0-2])$/.test(value.month) &&
		Object.keys(value).sort().join(",") === "ambiguousMicros,limitMicros,month,reservedMicros,settledMicros" &&
		Number.isSafeInteger(value.limitMicros) && Number(value.limitMicros) > 0 &&
		["settledMicros", "reservedMicros", "ambiguousMicros"].every((key) => Number.isSafeInteger(value[key]) && Number(value[key]) >= 0)
}

function assertReceiptIdentity(result: Reply, scope: FleetRepositoryBudgetScope, grant: OpenRouterBrokerGrant): void {
	if (result.jobId !== grant.jobId || result.campaignId !== FLEET_BUDGET_CAMPAIGN_ID ||
		result.repositoryCampaignId !== scope.repositoryCampaignId || result.repositoryId !== scope.repositoryId ||
		result.sourceRevision !== scope.sourceRevision || result.policySha256 !== scope.policySha256 ||
		result.repositoryEpoch !== scope.repositoryEpoch || result.model !== scope.model || result.profileId !== scope.profileId) {
		throw new Error("Fleet repository receipt identity mismatch")
	}
}

function toBrokerReceipt(result: Reply, grant: OpenRouterBrokerGrant, scope: FleetRepositoryBudgetScope): OpenRouterBrokerReceipt {
	const rows = result.calls
	const denialRows = result.denials
	if (!Array.isArray(rows) || rows.length > grant.limits.maxCalls || !Array.isArray(denialRows) || denialRows.length > 128) {
		throw new Error("Fleet repository receipt is invalid")
	}
	const calls: OpenRouterCallReceipt[] = rows.map((value) => {
		if (!isRecord(value) || value.jobId !== grant.jobId || value.campaignId !== FLEET_BUDGET_CAMPAIGN_ID ||
			value.model !== scope.model || value.profileId !== scope.profileId || !ID.test(String(value.callId)) ||
			!HEX.test(String(value.requestSha256)) || !Number.isSafeInteger(value.reservedMicros) ||
			!Number.isSafeInteger(value.reservedTokens) || typeof value.startedAt !== "string" ||
			!new Set(["reserve-intent", "reserved", "start-intent", "transmitting", "settle-intent", "ambiguous", "settled"]).has(String(value.state))) {
			throw new Error("Fleet repository call receipt is invalid")
		}
		const settlement = isRecord(value.settlement) ? value.settlement : {}
		const measured = value.state === "settled" && settlement.state === "complete" && settlement.qualified === true &&
			typeof settlement.returnedModel === "string" && RETURNED_MODELS.has(settlement.returnedModel) &&
			settlement.returnedProvider === "meta" && typeof settlement.providerRequestId === "string" &&
			Number.isSafeInteger(settlement.promptTokens) && Number(settlement.promptTokens) >= 0 && Number(settlement.promptTokens) <= grant.limits.maxInputTokensPerCall &&
			Number.isSafeInteger(settlement.completionTokens) && Number(settlement.completionTokens) >= 0 && Number(settlement.completionTokens) <= grant.limits.maxOutputTokensPerCall &&
			Number.isFinite(settlement.costUsd) && Number(settlement.costUsd) >= 0 && Number(settlement.costUsd) <= Number(value.reservedMicros) / 1_000_000 &&
			Number(settlement.promptTokens) + Number(settlement.completionTokens) <= Number(value.reservedTokens) && HEX.test(String(settlement.responseSha256))
		return { jobId: grant.jobId, campaignId: FLEET_BUDGET_CAMPAIGN_ID, model: scope.model, profileId: PROFILE,
			callId: String(value.callId), requestSha256: String(value.requestSha256), reservedUsd: Number(value.reservedMicros) / 1_000_000,
			reservedTokens: Number(value.reservedTokens), startedAt: value.startedAt,
			state: value.state === "settled" ? "complete" : "unmeasured", authoritative: measured,
			...(typeof settlement.returnedModel === "string" ? { returnedModel: settlement.returnedModel } : {}),
			...(typeof settlement.returnedProvider === "string" ? { returnedProvider: settlement.returnedProvider } : {}),
			...(typeof settlement.providerRequestId === "string" ? { providerRequestId: settlement.providerRequestId } : {}),
			...(Number.isSafeInteger(settlement.promptTokens) ? { promptTokens: Number(settlement.promptTokens) } : {}),
			...(Number.isSafeInteger(settlement.cachedPromptTokens) ? { cachedPromptTokens: Number(settlement.cachedPromptTokens) } : {}),
			...(Number.isSafeInteger(settlement.completionTokens) ? { completionTokens: Number(settlement.completionTokens) } : {}),
			...(Number.isFinite(settlement.costUsd) ? { costUsd: Number(settlement.costUsd) } : {}),
			...(typeof settlement.responseSha256 === "string" ? { responseSha256: settlement.responseSha256 } : {}) }
	})
	const denials = denialRows.map((value) => {
		if (!isRecord(value) || !Number.isSafeInteger(value.statusCode) || !DENIAL_REASONS.has(value.reason as OpenRouterDenialReason) ||
			!Number.isSafeInteger(value.count) || Number(value.count) < 1) throw new Error("Fleet repository denial receipt is invalid")
		return { statusCode: Number(value.statusCode), reason: value.reason as OpenRouterDenialReason, count: Number(value.count) }
	})
	const qualifiedCalls = calls.filter((call) => call.authoritative)
	const promptTokens = sum(qualifiedCalls, "promptTokens")
	const completionTokens = sum(qualifiedCalls, "completionTokens")
	const costUsd = sum(qualifiedCalls, "costUsd")
	return { provider: "openrouter", endpointProvider: "fleet-budget-authority", jobId: grant.jobId,
		campaignId: FLEET_BUDGET_CAMPAIGN_ID, model: scope.model, profileId: scope.profileId as OpenRouterBrokerGrant["profileId"],
		returnedModels: [...new Set(qualifiedCalls.map((call) => call.returnedModel).filter((v): v is string => Boolean(v)))],
		returnedProviders: [...new Set(qualifiedCalls.map((call) => call.returnedProvider).filter((v): v is string => Boolean(v)))],
		calls: calls.length, promptTokens, completionTokens,
		totalTokens: promptTokens === null || completionTokens === null ? null : promptTokens + completionTokens,
		costUsd, accounting: calls.length > 0 && calls.every((call) => call.authoritative) && denials.length === 0 ? "supervisor-enforced" : "incomplete",
		qualified: calls.length > 0 && calls.every((call) => call.authoritative) && denials.length === 0,
		callReceipts: calls, denials }
}

function sum(rows: OpenRouterCallReceipt[], key: "promptTokens" | "completionTokens" | "costUsd"): number | null {
	if (rows.length === 0 || rows.some((row) => typeof row[key] !== "number")) return null
	return rows.reduce((total, row) => total + Number(row[key]), 0)
}
