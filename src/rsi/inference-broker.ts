import { createHash, randomBytes, timingSafeEqual } from "node:crypto"
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import { networkInterfaces } from "node:os"
import { mkdir, open, readFile, rename, rm, stat } from "node:fs/promises"
import * as path from "node:path"
import { CAMPAIGN_MUTATION_TOOL_NAMES } from "../engine/prompt.js"

export const RSI_OPENROUTER_MODEL = "deepseek/deepseek-v4-flash-0731"
export const RSI_OPENROUTER_ENDPOINT_PROVIDER = "deepinfra"
export const RSI_OPENROUTER_ENDPOINT_TAG = "deepinfra/fp8"
export const RSI_OPENROUTER_ENDPOINT_QUANTIZATION = "fp8"
export const RSI_MUSE_OPENROUTER_MODEL = "meta/muse-spark-1.3-contributor"
export const RSI_MUSE_OPENROUTER_BILLING_MODEL = "meta/muse-spark-1.3-contributor-20260902"
export const RSI_OPENROUTER_PROFILE_IDS = ["deepseek-deepinfra-fp8", "muse-spark-contributor"] as const
export type RsiOpenRouterProfileId = typeof RSI_OPENROUTER_PROFILE_IDS[number]
export const RSI_DEFAULT_OPENROUTER_PROFILE_ID: RsiOpenRouterProfileId = "deepseek-deepinfra-fp8"

export interface RsiOpenRouterProfile {
	id: RsiOpenRouterProfileId
	model: string
	returnedModels: readonly string[]
	endpointProvider: string
	endpointProviderName: string
	endpointTag: string
	quantization?: string
	requiredParameters: readonly string[]
	allowFallbacks: false
	cacheRouting?: "opaque-job-key"
}

export const RSI_OPENROUTER_PROFILES: Readonly<Record<RsiOpenRouterProfileId, RsiOpenRouterProfile>> = Object.freeze({
	"deepseek-deepinfra-fp8": Object.freeze({
		id: "deepseek-deepinfra-fp8", model: RSI_OPENROUTER_MODEL, returnedModels: Object.freeze([RSI_OPENROUTER_MODEL]),
		endpointProvider: RSI_OPENROUTER_ENDPOINT_PROVIDER, endpointProviderName: "DeepInfra", endpointTag: RSI_OPENROUTER_ENDPOINT_TAG,
		quantization: RSI_OPENROUTER_ENDPOINT_QUANTIZATION, requiredParameters: Object.freeze(["max_tokens", "temperature", "tools", "tool_choice"]), allowFallbacks: false,
	}),
	"muse-spark-contributor": Object.freeze({
		id: "muse-spark-contributor", model: RSI_MUSE_OPENROUTER_MODEL, returnedModels: Object.freeze([RSI_MUSE_OPENROUTER_MODEL, RSI_MUSE_OPENROUTER_BILLING_MODEL]),
		endpointProvider: "meta", endpointProviderName: "Meta", endpointTag: "meta", quantization: "unknown",
		requiredParameters: Object.freeze(["max_tokens", "temperature", "tools", "tool_choice"]), allowFallbacks: false, cacheRouting: "opaque-job-key",
	}),
})

export function openRouterProfileById(id: unknown): RsiOpenRouterProfile {
	if (typeof id !== "string" || !Object.hasOwn(RSI_OPENROUTER_PROFILES, id)) throw new Error("RSI OpenRouter profile is not admitted")
	return RSI_OPENROUTER_PROFILES[id as RsiOpenRouterProfileId]
}

export function openRouterProfileForModel(model: string, profileId?: unknown): RsiOpenRouterProfile {
	const profile = profileId === undefined
		? Object.values(RSI_OPENROUTER_PROFILES).find((candidate) => candidate.model === model)
		: openRouterProfileById(profileId)
	if (!profile || profile.model !== model) throw new Error("RSI OpenRouter profile/model identity is not admitted")
	return profile
}

export interface OpenRouterBrokerLimits {
	campaignId: string
	maxCalls: number
	maxInputTokensPerCall: number
	maxOutputTokensPerCall: number
	maxTotalTokens: number
	maxDurationMs: number
	maxRequestBytes: number
	maxResponseBytes: number
	maxInputPricePerMillionUsd: number
	maxOutputPricePerMillionUsd: number
	maxCallSpendUsd: number
	maxJobSpendUsd: number
	maxCampaignSpendUsd: number
}

export interface OpenRouterBrokerGrant {
	jobId: string
	leaseToken: string
	capability: string
	model: string
	/** SHA-256 of the exact host API key selected for this broker; never the key itself. */
	apiKeyIdentity?: string
	profileId?: RsiOpenRouterProfileId
	endpointPrice?: OpenRouterEndpointPriceSnapshot
	limits: OpenRouterBrokerLimits
	/** Local start instant; durable ledgers preserve the first registration across restarts. */
	issuedAtMs?: number
}

export interface OpenRouterCallReservation {
	callId: string
	requestSha256: string
	reservedUsd: number
	reservedTokens: number
	startedAt: string
}

export interface OpenRouterCallSettlement {
	state: "complete" | "unmeasured"
	qualified?: boolean
	returnedModel?: string
	returnedProvider?: string
	providerRequestId?: string
	promptTokens?: number
	cachedPromptTokens?: number
	completionTokens?: number
	costUsd?: number
	responseSha256?: string
	completedAt: string
}

export interface OpenRouterCallReceipt extends OpenRouterCallReservation, Omit<OpenRouterCallSettlement, "completedAt" | "state"> {
	jobId: string
	campaignId: string
	model: string
	profileId?: RsiOpenRouterProfileId
	state: "reserved" | OpenRouterCallSettlement["state"]
	completedAt?: string
	authoritative: boolean
}

export type OpenRouterDenialReason = "metadata-not-admitted" | "unsupported-endpoint" | "malformed-call-id" | "invalid-request" | "request-size-limit" | "budget-or-fence" | "job-deadline" | "upstream-ambiguous" | "usage-unverifiable" | "usage-out-of-bounds" | "settlement-failed" | "request-failed"

export interface OpenRouterDenialSummary { statusCode: number; reason: OpenRouterDenialReason; count: number }

export interface OpenRouterBrokerReceipt {
	provider: "openrouter"
	endpointProvider: string
	jobId: string
	campaignId: string
	model: string
	profileId?: RsiOpenRouterProfileId
	endpointPrice?: OpenRouterEndpointPriceSnapshot
	returnedModels: string[]
	returnedProviders: string[]
	calls: number
	promptTokens: number | null
	completionTokens: number | null
	totalTokens: number | null
	costUsd: number | null
	accounting: "supervisor-enforced" | "incomplete"
	qualified: boolean
	callReceipts: OpenRouterCallReceipt[]
	denials: OpenRouterDenialSummary[]
}

export interface OpenRouterInferenceLedger {
	register(grant: OpenRouterBrokerGrant): Promise<number>
	recordDenial(grant: OpenRouterBrokerGrant, statusCode: number, reason: OpenRouterDenialReason): Promise<void>
	reserve(grant: OpenRouterBrokerGrant, reservation: OpenRouterCallReservation): Promise<void>
	settle(grant: OpenRouterBrokerGrant, settlement: OpenRouterCallSettlement & { callId: string }): Promise<void>
	receipt(grant: OpenRouterBrokerGrant): Promise<OpenRouterBrokerReceipt>
}

interface PersistedBrokerJob {
	grant: Omit<OpenRouterBrokerGrant, "capability" | "leaseToken">
	capabilitySha256: string
	leaseSha256: string
	blocked: boolean
	deadlineAtMs: number
	reservations: OpenRouterCallReceipt[]
	denials?: Record<string, number>
}

function denialSummaries(denials: Record<string, number> | undefined): OpenRouterDenialSummary[] {
	return Object.entries(denials ?? {}).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, count]) => {
		const match = /^(\d{3}):([a-z-]+)$/.exec(key)
		if (!match) throw new Error("OpenRouter ledger contains a malformed denial summary")
		return { statusCode: Number(match[1]), reason: match[2] as OpenRouterDenialReason, count }
	})
}

function grantProfile(grant: OpenRouterBrokerGrant): RsiOpenRouterProfile {
	return openRouterProfileForModel(grant.model, grant.profileId)
}

function profileReceiptIdentity(profile: RsiOpenRouterProfile): { profileId?: RsiOpenRouterProfileId } {
	return profile.id === RSI_DEFAULT_OPENROUTER_PROFILE_ID ? {} : { profileId: profile.id }
}

export function endpointPriceIdentity(price: OpenRouterEndpointPriceSnapshot): Pick<OpenRouterEndpointPriceSnapshot, "model" | "provider" | "endpointTag" | "quantization" | "supportedParameters" | "inputPricePerMillionUsd" | "outputPricePerMillionUsd"> {
	return {
		model: price.model,
		provider: price.provider,
		endpointTag: price.endpointTag,
		...(price.quantization === undefined ? {} : { quantization: price.quantization }),
		supportedParameters: [...new Set(price.supportedParameters)].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b))),
		inputPricePerMillionUsd: price.inputPricePerMillionUsd,
		outputPricePerMillionUsd: price.outputPricePerMillionUsd,
	}
}

interface PersistedBrokerState {
	jobs: Record<string, PersistedBrokerJob>
	campaigns: Record<string, { maxSpendUsd: number; spentUsd: number; reservedUsd: number; blocked: boolean }>
}

/** File-backed ledger for same-host benchmark runs; fleet workers use the PostgreSQL ledger. */
export class FileOpenRouterInferenceLedger implements OpenRouterInferenceLedger {
	private readonly filePath: string
	private readonly lockPath: string
	constructor(filePath: string) { this.filePath = path.resolve(filePath); this.lockPath = `${this.filePath}.lock` }

	private async locked<T>(fn: (state: PersistedBrokerState) => Promise<T> | T): Promise<T> {
		await mkdir(path.dirname(this.filePath), { recursive: true, mode: 0o700 })
		const deadline = Date.now() + 10_000
		let lock
		const ownerToken = randomBytes(16).toString("hex")
		for (;;) {
			try {
				lock = await open(this.lockPath, "wx", 0o600)
				await lock.writeFile(JSON.stringify({ pid: process.pid, token: ownerToken, createdAt: Date.now() }))
				await lock.sync()
				break
			}
			catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "EEXIST" || Date.now() >= deadline) throw new Error("OpenRouter file ledger is locked or unavailable; refusing concurrent spend")
				try {
					const raw = await readFile(this.lockPath, "utf8")
					const metadata = JSON.parse(raw) as { pid?: unknown; token?: unknown; createdAt?: unknown }
					const lockAge = Date.now() - Number(metadata.createdAt)
					if (Number.isSafeInteger(metadata.pid) && lockAge > 1000) {
						try { process.kill(Number(metadata.pid), 0) }
						catch (probeError) {
							if ((probeError as NodeJS.ErrnoException).code === "ESRCH") {
								throw new Error("OpenRouter file ledger has a stale lock; refusing spend until an operator verifies and removes it")
							}
						}
					} else if (!Number.isFinite(lockAge) || lockAge > 30_000) {
						const lockStat = await stat(this.lockPath)
						if (Date.now() - lockStat.mtimeMs > 30_000) throw new Error("OpenRouter file ledger has an unreadable stale lock; refusing spend until an operator verifies and removes it")
					}
				} catch (inspectError) {
					if (inspectError instanceof Error && /stale lock/.test(inspectError.message)) throw inspectError
					/* lock may be in the process of being created; wait and recheck */
				}
				await new Promise((resolve) => setTimeout(resolve, 25))
			}
		}
		try {
			const state = await readFile(this.filePath, "utf8").then((raw) => JSON.parse(raw) as PersistedBrokerState).catch((error) => {
				if ((error as NodeJS.ErrnoException).code === "ENOENT") return { jobs: {}, campaigns: {} }
				throw new Error("OpenRouter file ledger is corrupt; refusing spend")
			})
			if (!state || typeof state !== "object" || !state.jobs || typeof state.jobs !== "object" || !state.campaigns || typeof state.campaigns !== "object") throw new Error("OpenRouter file ledger has an invalid schema")
			const result = await fn(state)
			const temporary = `${this.filePath}.${randomBytes(8).toString("hex")}.tmp`
			const output = await open(temporary, "wx", 0o600)
			try { await output.writeFile(JSON.stringify(state)); await output.sync() } finally { await output.close() }
			await rename(temporary, this.filePath)
			return result
		} finally {
			await lock.close()
			try {
				const metadata = JSON.parse(await readFile(this.lockPath, "utf8")) as { token?: unknown }
				if (metadata.token === ownerToken) await rm(this.lockPath, { force: true })
			} catch { /* another owner replaced or recovered this lock */ }
		}
	}

	async register(grant: OpenRouterBrokerGrant): Promise<number> {
		const profile = grantProfile(grant)
		const priceIdentity = profile.id === RSI_DEFAULT_OPENROUTER_PROFILE_ID ? undefined : grant.endpointPrice && endpointPriceIdentity(grant.endpointPrice)
		if (profile.id !== RSI_DEFAULT_OPENROUTER_PROFILE_ID && !priceIdentity) throw new Error("Muse OpenRouter grant is missing its admitted endpoint-price snapshot")
		const fingerprint = { campaignId: grant.limits.campaignId, model: grant.model, ...(grant.apiKeyIdentity ? { apiKeyIdentity: grant.apiKeyIdentity } : {}), ...profileReceiptIdentity(profile), ...(priceIdentity ? { endpointPrice: priceIdentity } : {}), limits: grant.limits }
		return this.locked((state) => {
			const current = state.jobs[grant.jobId]
			const currentFingerprint = current && {
				campaignId: current.grant.limits.campaignId,
				model: current.grant.model,
				...(current.grant.apiKeyIdentity ? { apiKeyIdentity: current.grant.apiKeyIdentity } : {}),
				...(current.grant.profileId ? { profileId: current.grant.profileId } : {}),
				...(current.grant.endpointPrice ? { endpointPrice: endpointPriceIdentity(current.grant.endpointPrice) } : {}),
				limits: current.grant.limits,
			}
			if (currentFingerprint && JSON.stringify(currentFingerprint) !== JSON.stringify(fingerprint)) throw new Error("OpenRouter file ledger job identity conflicts with prior accounting")
			if (current && (!Number.isSafeInteger(current.deadlineAtMs) || current.deadlineAtMs <= 0)) throw new Error("OpenRouter file ledger is missing a durable job deadline; refusing restart")
			const campaign = state.campaigns[grant.limits.campaignId]
			if (campaign && campaign.maxSpendUsd !== grant.limits.maxCampaignSpendUsd) throw new Error("OpenRouter file ledger campaign cap differs from prior accounting")
			state.campaigns[grant.limits.campaignId] ??= { maxSpendUsd: grant.limits.maxCampaignSpendUsd, spentUsd: 0, reservedUsd: 0, blocked: false }
			const deadlineAtMs = current?.deadlineAtMs ?? (grant.issuedAtMs ?? Date.now()) + grant.limits.maxDurationMs
			const persistedGrant = current?.grant ?? { campaignId: grant.limits.campaignId, model: grant.model,
				...(grant.apiKeyIdentity ? { apiKeyIdentity: grant.apiKeyIdentity } : {}),
				...profileReceiptIdentity(profile), ...(grant.endpointPrice ? { endpointPrice: grant.endpointPrice } : {}), limits: grant.limits }
			state.jobs[grant.jobId] = current ?? { grant: persistedGrant, capabilitySha256: sha256(grant.capability), leaseSha256: sha256(grant.leaseToken), blocked: false, deadlineAtMs, reservations: [] }
			if (current) {
				current.capabilitySha256 = sha256(grant.capability)
				current.leaseSha256 = sha256(grant.leaseToken)
			}
			return deadlineAtMs
		})
	}

	async reserve(grant: OpenRouterBrokerGrant, reservation: OpenRouterCallReservation): Promise<void> {
		await this.locked((state) => {
			const job = state.jobs[grant.jobId]
			const campaign = state.campaigns[grant.limits.campaignId]
			if (!job || !campaign || job.blocked || campaign.blocked || job.capabilitySha256 !== sha256(grant.capability) || job.leaseSha256 !== sha256(grant.leaseToken)) throw new Error("OpenRouter file ledger grant is stale or blocked")
			if (!Number.isFinite(Date.parse(reservation.startedAt)) || Date.parse(reservation.startedAt) >= job.deadlineAtMs) throw new Error("OpenRouter job duration limit exhausted")
			if (job.reservations.some((call) => call.callId === reservation.callId)) throw new Error("duplicate OpenRouter call id is rejected")
			const reservedCalls = job.reservations.length
			const tokens = job.reservations.reduce((sum, call) => sum + call.reservedTokens, 0)
			const spend = job.reservations.reduce((sum, call) => sum + (call.costUsd ?? call.reservedUsd), 0)
			const reservedUsd = Math.ceil(reservation.reservedUsd * 1_000_000) / 1_000_000
			if (reservedCalls >= grant.limits.maxCalls || reservedUsd > grant.limits.maxCallSpendUsd || tokens + reservation.reservedTokens > grant.limits.maxTotalTokens || spend + reservedUsd > grant.limits.maxJobSpendUsd || campaign.spentUsd + campaign.reservedUsd + reservedUsd > campaign.maxSpendUsd) throw new Error("OpenRouter file ledger budget exhausted")
			campaign.reservedUsd = Math.ceil((campaign.reservedUsd + reservedUsd) * 1_000_000) / 1_000_000
			job.reservations.push({ ...reservation, reservedUsd, jobId: grant.jobId, campaignId: grant.limits.campaignId, model: grant.model, ...profileReceiptIdentity(grantProfile(grant)), state: "reserved", authoritative: false })
		})
	}

	async recordDenial(grant: OpenRouterBrokerGrant, statusCode: number, reason: OpenRouterDenialReason): Promise<void> {
		if (!Number.isSafeInteger(statusCode) || statusCode < 400 || statusCode > 599) throw new Error("invalid OpenRouter denial status")
		await this.locked((state) => {
			const job = state.jobs[grant.jobId]
			if (!job || job.capabilitySha256 !== sha256(grant.capability) || job.leaseSha256 !== sha256(grant.leaseToken)) throw new Error("OpenRouter denial grant mismatch")
			job.denials ??= {}
			const key = `${statusCode}:${reason}`
			job.denials[key] = (job.denials[key] ?? 0) + 1
		})
	}

	async settle(grant: OpenRouterBrokerGrant, settlement: OpenRouterCallSettlement & { callId: string }): Promise<void> {
		await this.locked((state) => {
			const job = state.jobs[grant.jobId]
			const campaign = state.campaigns[grant.limits.campaignId]
			const call = job?.reservations.find((entry) => entry.callId === settlement.callId)
			if (!job || !campaign || !call || job.capabilitySha256 !== sha256(grant.capability) || job.leaseSha256 !== sha256(grant.leaseToken) || call.state !== "reserved") throw new Error("OpenRouter file ledger settlement does not match a pending call")
			Object.assign(call, settlement)
			const completedAtMs = Date.parse(settlement.completedAt)
		const measurable = settlement.state === "complete" && Number.isFinite(completedAtMs) && completedAtMs <= job.deadlineAtMs && settlement.returnedModel !== undefined && settlement.returnedProvider !== undefined && settlement.promptTokens !== undefined && settlement.completionTokens !== undefined && settlement.costUsd !== undefined && settlement.responseSha256 !== undefined
			if (!measurable) {
				call.state = "unmeasured"
				call.authoritative = false
				job.blocked = true
				return
			}
			call.authoritative = settlement.qualified !== false && grantProfile(grant).returnedModels.includes(settlement.returnedModel ?? "") && settlement.returnedProvider === grantProfile(grant).endpointProvider
				&& settlement.promptTokens !== undefined && settlement.promptTokens <= grant.limits.maxInputTokensPerCall
				&& (settlement.cachedPromptTokens === undefined || settlement.cachedPromptTokens <= settlement.promptTokens)
				&& settlement.completionTokens !== undefined && settlement.completionTokens <= grant.limits.maxOutputTokensPerCall
				&& settlement.costUsd !== undefined && settlement.costUsd <= call.reservedUsd
				&& settlement.promptTokens + settlement.completionTokens <= call.reservedTokens && settlement.responseSha256 !== undefined
			campaign.reservedUsd = Math.max(0, campaign.reservedUsd - call.reservedUsd)
			campaign.spentUsd = Math.ceil((campaign.spentUsd + settlement.costUsd!) * 1_000_000) / 1_000_000
			if (!call.authoritative) job.blocked = true
			if (campaign.spentUsd > campaign.maxSpendUsd) campaign.blocked = true
		})
	}

	async receipt(grant: OpenRouterBrokerGrant): Promise<OpenRouterBrokerReceipt> {
		return this.locked((state) => {
			const job = state.jobs[grant.jobId]
			const campaign = state.campaigns[grant.limits.campaignId]
			if (!job || !campaign || job.capabilitySha256 !== sha256(grant.capability) || job.leaseSha256 !== sha256(grant.leaseToken)) throw new Error("OpenRouter file ledger receipt grant mismatch")
			const calls = job.reservations
			const qualified = calls.length > 0 && !job.blocked && !campaign.blocked && calls.every((call) => call.authoritative && call.state === "complete" && call.costUsd !== undefined && call.promptTokens !== undefined && call.completionTokens !== undefined)
			const promptTokens = qualified ? calls.reduce((sum, call) => sum + call.promptTokens!, 0) : null
			const completionTokens = qualified ? calls.reduce((sum, call) => sum + call.completionTokens!, 0) : null
			const costUsd = qualified ? calls.reduce((sum, call) => sum + call.costUsd!, 0) : null
			const profile = grantProfile(grant)
			return { provider: "openrouter", endpointProvider: profile.endpointProvider, jobId: grant.jobId, campaignId: grant.limits.campaignId, model: grant.model, ...profileReceiptIdentity(profile), ...(job.grant.endpointPrice ? { endpointPrice: job.grant.endpointPrice } : {}),
				returnedModels: [...new Set(calls.map((call) => call.returnedModel).filter((model): model is string => Boolean(model)))],
				returnedProviders: [...new Set(calls.map((call) => call.returnedProvider).filter((provider): provider is string => Boolean(provider)))],
				calls: calls.length, promptTokens, completionTokens, totalTokens: promptTokens === null || completionTokens === null ? null : promptTokens + completionTokens,
				costUsd, accounting: qualified ? "supervisor-enforced" : "incomplete", qualified, callReceipts: structuredClone(calls), denials: denialSummaries(job.denials) }
		})
	}

	async lookupReceipt(jobId: string): Promise<OpenRouterBrokerReceipt | undefined> {
		return this.locked((state) => {
			const job = state.jobs[jobId]
			if (!job) return undefined
			const campaignId = job.grant.limits.campaignId
			const campaign = state.campaigns[campaignId]
			if (!campaign) throw new Error("OpenRouter file ledger campaign record is missing")
			const calls = job.reservations
			const qualified = calls.length > 0 && !job.blocked && !campaign.blocked && calls.every((call) => call.authoritative && call.state === "complete" && call.costUsd !== undefined && call.promptTokens !== undefined && call.completionTokens !== undefined)
			const promptTokens = qualified ? calls.reduce((sum, call) => sum + call.promptTokens!, 0) : null
			const completionTokens = qualified ? calls.reduce((sum, call) => sum + call.completionTokens!, 0) : null
			const costUsd = qualified ? calls.reduce((sum, call) => sum + call.costUsd!, 0) : null
			const profile = grantProfile(job.grant as OpenRouterBrokerGrant)
			return { provider: "openrouter", endpointProvider: profile.endpointProvider, jobId, campaignId, model: job.grant.model, ...profileReceiptIdentity(profile), ...(job.grant.endpointPrice ? { endpointPrice: job.grant.endpointPrice } : {}),
				returnedModels: [...new Set(calls.map((call) => call.returnedModel).filter((model): model is string => Boolean(model)))],
				returnedProviders: [...new Set(calls.map((call) => call.returnedProvider).filter((provider): provider is string => Boolean(provider)))],
				calls: calls.length, promptTokens, completionTokens, totalTokens: promptTokens === null || completionTokens === null ? null : promptTokens + completionTokens,
				costUsd, accounting: qualified ? "supervisor-enforced" : "incomplete", qualified, callReceipts: structuredClone(calls), denials: denialSummaries(job.denials) }
		})
	}
}

export interface OpenRouterBrokerOptions {
	jobId: string
	leaseToken: string
	model?: string
	profileId?: RsiOpenRouterProfileId
	/** Enforce the fixed four-tool campaign mutation contract before reservation or upstream POST. */
	campaignMutationOnly?: boolean
	limits: OpenRouterBrokerLimits
	apiKey: string
	ledger: OpenRouterInferenceLedger
	bindHost?: string
	port?: number
	upstreamFetch?: typeof fetch
	now?: () => number
	/** Observes response status and method only; request bodies and credentials are never exposed. */
	onHttpResponse?: (event: { method: string; statusCode: number; requestBytes?: number }) => void
}

export interface RunningOpenRouterBroker {
	readonly capability: string
	readonly guestBaseUrl: string
	readonly localBaseUrl: string
	readonly port: number
	readonly maxPromptBytes: number
	close(): Promise<void>
	receipt(): Promise<OpenRouterBrokerReceipt>
}

function finiteInteger(value: number, minimum = 1): boolean {
	return Number.isSafeInteger(value) && value >= minimum
}

function spendCapUsd(value: number): number {
	if (!Number.isFinite(value) || value < 0) throw new Error("OpenRouter broker spend limits must be finite non-negative USD amounts")
	const micros = Math.floor(value * 1_000_000)
	if (!Number.isSafeInteger(micros)) throw new Error("OpenRouter broker spend limit is too large")
	return micros / 1_000_000
}

export function validateOpenRouterBrokerLimits(limits: OpenRouterBrokerLimits): OpenRouterBrokerLimits {
	if (!/^[A-Za-z0-9._:-]{1,160}$/.test(limits.campaignId)) throw new Error("OpenRouter campaign id is malformed")
	for (const [name, value] of Object.entries({
		maxCalls: limits.maxCalls, maxInputTokensPerCall: limits.maxInputTokensPerCall,
		maxOutputTokensPerCall: limits.maxOutputTokensPerCall, maxTotalTokens: limits.maxTotalTokens,
		maxDurationMs: limits.maxDurationMs, maxRequestBytes: limits.maxRequestBytes, maxResponseBytes: limits.maxResponseBytes,
	})) if (!finiteInteger(value)) throw new Error(`OpenRouter ${name} must be a positive integer`)
	for (const [name, value] of Object.entries({ maxInputPricePerMillionUsd: limits.maxInputPricePerMillionUsd, maxOutputPricePerMillionUsd: limits.maxOutputPricePerMillionUsd })) {
		if (!Number.isFinite(value) || value <= 0) throw new Error(`OpenRouter ${name} must be a positive finite price ceiling`)
	}
	const normalized = { ...limits, maxCallSpendUsd: spendCapUsd(limits.maxCallSpendUsd), maxJobSpendUsd: spendCapUsd(limits.maxJobSpendUsd), maxCampaignSpendUsd: spendCapUsd(limits.maxCampaignSpendUsd) }
	if (normalized.maxCallSpendUsd <= 0 || normalized.maxJobSpendUsd < normalized.maxCallSpendUsd || normalized.maxCampaignSpendUsd < normalized.maxJobSpendUsd) throw new Error("OpenRouter spend ceilings must satisfy 0 < per-call <= job <= campaign")
	if (normalized.maxInputTokensPerCall + normalized.maxOutputTokensPerCall > normalized.maxTotalTokens) throw new Error("OpenRouter per-call token ceilings exceed the job token ceiling")
	return normalized
}

export function openRouterBrokerLimitsFromEnvironment(
	env: NodeJS.ProcessEnv,
	campaignId: string,
	overrides: Partial<Pick<OpenRouterBrokerLimits, "maxCalls" | "maxOutputTokensPerCall" | "maxDurationMs">> = {},
): OpenRouterBrokerLimits {
	const positive = (name: string, fallback: number): number => {
		const raw = env[name]
		if (raw === undefined || raw.trim() === "") return fallback
		const value = Number(raw)
		if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`)
		return value
	}
	const usd = (name: string): number => {
		const raw = env[name]
		if (raw === undefined || raw.trim() === "") throw new Error(`${name} is required for bounded OpenRouter inference`)
		const value = Number(raw)
		if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive finite USD amount`)
		return value
	}
	const maxCalls = overrides.maxCalls ?? positive("HEADLESSCODE_RSI_OPENROUTER_MAX_CALLS", 8)
	const maxInputTokensPerCall = positive("HEADLESSCODE_RSI_OPENROUTER_MAX_INPUT_TOKENS_PER_CALL", 16_000)
	const maxOutputTokensPerCall = overrides.maxOutputTokensPerCall ?? positive("HEADLESSCODE_RSI_OPENROUTER_MAX_OUTPUT_TOKENS_PER_CALL", 4096)
	return validateOpenRouterBrokerLimits({
		campaignId, maxCalls, maxInputTokensPerCall, maxOutputTokensPerCall,
		maxTotalTokens: positive("HEADLESSCODE_RSI_OPENROUTER_MAX_TOTAL_TOKENS", maxCalls * (maxInputTokensPerCall + maxOutputTokensPerCall)),
		maxDurationMs: overrides.maxDurationMs ?? positive("HEADLESSCODE_RSI_OPENROUTER_MAX_DURATION_MS", 15 * 60_000),
		maxRequestBytes: positive("HEADLESSCODE_RSI_OPENROUTER_MAX_REQUEST_BYTES", 8 * 1024 * 1024),
		maxResponseBytes: positive("HEADLESSCODE_RSI_OPENROUTER_MAX_RESPONSE_BYTES", 8 * 1024 * 1024),
		maxInputPricePerMillionUsd: usd("HEADLESSCODE_RSI_OPENROUTER_MAX_INPUT_PRICE_PER_MILLION_USD"),
		maxOutputPricePerMillionUsd: usd("HEADLESSCODE_RSI_OPENROUTER_MAX_OUTPUT_PRICE_PER_MILLION_USD"),
		maxCallSpendUsd: usd("HEADLESSCODE_RSI_OPENROUTER_MAX_CALL_SPEND_USD"),
		maxJobSpendUsd: usd("HEADLESSCODE_RSI_OPENROUTER_MAX_JOB_SPEND_USD"),
		maxCampaignSpendUsd: usd("HEADLESSCODE_RSI_OPENROUTER_MAX_CAMPAIGN_SPEND_USD"),
	})
}

export interface OpenRouterCampaignBudgetAllocation { totalUsd: number; mutationUsd: number; benchmarkUsd: number }

export function openRouterCampaignBudgetAllocation(env: NodeJS.ProcessEnv): OpenRouterCampaignBudgetAllocation {
	const readMicroUsd = (name: string, round: "down" | "up"): number => {
		const raw = env[name]
		const value = raw === undefined || raw.trim() === "" ? Number.NaN : Number(raw)
		if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} is required as a positive finite USD ceiling`)
		const microUsd = value * 1_000_000
		if (!Number.isFinite(microUsd) || microUsd > Number.MAX_SAFE_INTEGER) throw new Error(`${name} exceeds the safe integer micro-USD range`)
		const rounded = round === "up" ? Math.ceil(microUsd) : Math.floor(microUsd)
		if (!Number.isSafeInteger(rounded)) throw new Error(`${name} exceeds the safe integer micro-USD range`)
		return rounded
	}
	const totalMicroUsd = readMicroUsd("HEADLESSCODE_RSI_OPENROUTER_MAX_CAMPAIGN_SPEND_USD", "down")
	const mutationMicroUsd = readMicroUsd("HEADLESSCODE_RSI_OPENROUTER_MUTATION_BUDGET_USD", "up")
	const benchmarkMicroUsd = readMicroUsd("HEADLESSCODE_RSI_OPENROUTER_BENCHMARK_BUDGET_USD", "up")
	const allocatedMicroUsd = mutationMicroUsd + benchmarkMicroUsd
	if (!Number.isSafeInteger(allocatedMicroUsd)) throw new Error("OpenRouter mutation and benchmark allocation sum exceeds the safe integer micro-USD range")
	if (allocatedMicroUsd > totalMicroUsd) throw new Error("OpenRouter mutation and benchmark allocations exceed the operator campaign spend ceiling")
	return { totalUsd: totalMicroUsd / 1_000_000, mutationUsd: mutationMicroUsd / 1_000_000, benchmarkUsd: benchmarkMicroUsd / 1_000_000 }
}

export function openRouterAllocatedEnvironment(env: NodeJS.ProcessEnv, allocation: "mutation" | "benchmark"): NodeJS.ProcessEnv {
	const budgets = openRouterCampaignBudgetAllocation(env)
	const rolePrefix = `HEADLESSCODE_RSI_OPENROUTER_${allocation.toUpperCase()}_`
	const scopedTotalTokens = env[`${rolePrefix}MAX_TOTAL_TOKENS`]?.trim()
	const scopedJobSpendUsd = env[`${rolePrefix}MAX_JOB_SPEND_USD`]?.trim()
	if (scopedTotalTokens) {
		const value = Number(scopedTotalTokens)
		if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${rolePrefix}MAX_TOTAL_TOKENS must be a positive integer`)
	}
	if (scopedJobSpendUsd) {
		const value = Number(scopedJobSpendUsd)
		if (!Number.isFinite(value) || value <= 0) throw new Error(`${rolePrefix}MAX_JOB_SPEND_USD must be a positive finite USD amount`)
	}
	return {
		...env,
		HEADLESSCODE_RSI_OPENROUTER_MAX_CAMPAIGN_SPEND_USD: String(allocation === "mutation" ? budgets.mutationUsd : budgets.benchmarkUsd),
		...(scopedTotalTokens ? { HEADLESSCODE_RSI_OPENROUTER_MAX_TOTAL_TOKENS: scopedTotalTokens } : {}),
		...(scopedJobSpendUsd ? { HEADLESSCODE_RSI_OPENROUTER_MAX_JOB_SPEND_USD: scopedJobSpendUsd } : {}),
	}
}

function sha256(value: Buffer | string): string { return createHash("sha256").update(value).digest("hex") }

async function readBody(request: IncomingMessage, maximumBytes: number): Promise<Buffer> {
	const chunks: Buffer[] = []
	let size = 0
	for await (const chunk of request) {
		const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
		size += bytes.byteLength
		if (size > maximumBytes) throw new Error("request body exceeds broker limit")
		chunks.push(bytes)
	}
	return Buffer.concat(chunks, size)
}

async function readResponse(response: Response, maximumBytes: number): Promise<Buffer> {
	if (!response.body) return Buffer.alloc(0)
	const reader = response.body.getReader()
	const chunks: Buffer[] = []
	let size = 0
	for (;;) {
		const { done, value } = await reader.read()
		if (done) break
		size += value.byteLength
		if (size > maximumBytes) {
			await reader.cancel().catch(() => undefined)
			throw new Error("upstream response exceeds broker limit")
		}
		chunks.push(Buffer.from(value))
	}
	return Buffer.concat(chunks, size)
}

function parseUsage(body: Buffer, contentType: string): { model?: string; provider?: string; id?: string; promptTokens?: number; cachedPromptTokens?: number; completionTokens?: number; costUsd?: number; refusal?: boolean } {
	let values: Array<Record<string, unknown>> = []
	if (contentType.includes("text/event-stream")) {
		for (const line of body.toString("utf8").split(/\r?\n/)) {
			if (!line.startsWith("data:")) continue
			const data = line.slice(5).trim()
			if (!data || data === "[DONE]") continue
			try { const item = JSON.parse(data) as unknown; if (item && typeof item === "object") values.push(item as Record<string, unknown>) } catch { /* the OpenRouter client reports malformed event data */ }
		}
	} else {
		try { const item = JSON.parse(body.toString("utf8")) as unknown; if (item && typeof item === "object") values = [item as Record<string, unknown>] } catch { return {} }
	}
	let model: string | undefined
	let provider: string | undefined
	let id: string | undefined
	let promptTokens: number | undefined
	let cachedPromptTokens: number | undefined
	let completionTokens: number | undefined
	let costUsd: number | undefined
	let refusal = false
	for (const item of values) {
		if (typeof item.model === "string") model = item.model
		if (typeof item.id === "string") id = item.id
		if (Array.isArray(item.choices)) {
			for (const choice of item.choices) {
				if (!choice || typeof choice !== "object" || Array.isArray(choice)) continue
				const row = choice as Record<string, unknown>
				if (row.finish_reason === "content_filter") refusal = true
				for (const field of ["message", "delta"]) {
					const content = row[field]
					if (content && typeof content === "object" && !Array.isArray(content)) {
						const refusalText = (content as Record<string, unknown>).refusal
						if (typeof refusalText === "string" && refusalText.trim().length > 0) refusal = true
					}
				}
			}
		}
		const metadata = item.openrouter_metadata
		if (metadata && typeof metadata === "object" && !Array.isArray(metadata)) {
			const endpoints = (metadata as Record<string, unknown>).endpoints
			const available = endpoints && typeof endpoints === "object" && !Array.isArray(endpoints) ? (endpoints as Record<string, unknown>).available : undefined
			if (Array.isArray(available)) {
				const selected = available.filter((endpoint) => endpoint && typeof endpoint === "object" && (endpoint as Record<string, unknown>).selected === true)
				if (selected.length === 1 && typeof (selected[0] as Record<string, unknown>).provider === "string") provider = String((selected[0] as Record<string, unknown>).provider).toLowerCase()
			}
		}
		const usage = item.usage
		if (!usage || typeof usage !== "object") continue
		const row = usage as Record<string, unknown>
		if (Number.isSafeInteger(row.prompt_tokens) && Number(row.prompt_tokens) >= 0) promptTokens = Number(row.prompt_tokens)
		const promptDetails = row.prompt_tokens_details
		if (promptDetails && typeof promptDetails === "object" && !Array.isArray(promptDetails)) {
			const cached = (promptDetails as Record<string, unknown>).cached_tokens
			if (Number.isSafeInteger(cached) && Number(cached) >= 0) cachedPromptTokens = Number(cached)
		}
		if (Number.isSafeInteger(row.completion_tokens) && Number(row.completion_tokens) >= 0) completionTokens = Number(row.completion_tokens)
		if (typeof row.cost === "number" && Number.isFinite(row.cost) && row.cost >= 0) costUsd = row.cost
	}
	return { ...(model ? { model } : {}), ...(provider ? { provider } : {}), ...(id ? { id } : {}), ...(promptTokens !== undefined ? { promptTokens } : {}), ...(cachedPromptTokens !== undefined ? { cachedPromptTokens } : {}), ...(completionTokens !== undefined ? { completionTokens } : {}), ...(costUsd !== undefined ? { costUsd } : {}), ...(refusal ? { refusal: true } : {}) }
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
	const bytes = Buffer.from(JSON.stringify(body))
	response.writeHead(status, { "content-type": "application/json", "content-length": String(bytes.byteLength), "cache-control": "no-store" })
	response.end(bytes)
}

function capabilityMatches(header: string | undefined, capability: string): boolean {
	const value = header?.startsWith("Bearer ") ? header.slice(7) : ""
	if (!value) return false
	const actual = Buffer.from(sha256(value), "hex")
	const expected = Buffer.from(sha256(capability), "hex")
	return timingSafeEqual(actual, expected)
}

function validateRequestBody(body: Buffer, limits: OpenRouterBrokerLimits, profile: RsiOpenRouterProfile, cacheRoutingKey: string, campaignMutationOnly = false): { encodedBody: Buffer; outputLimit: number } {
	let parsed: unknown
	try { parsed = JSON.parse(body.toString("utf8")) } catch { throw new Error("request JSON is malformed") }
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("request must be a JSON object")
	const value = parsed as Record<string, unknown>
	const allowed = new Set(["model", "messages", "tools", "tool_choice", "temperature", "max_tokens", "max_completion_tokens", "stream", "stream_options", "provider", "include_reasoning", "reasoning", "session_id", "prompt_cache_key"])
	for (const key of Object.keys(value)) if (!allowed.has(key)) throw new Error(`request field is not admitted: ${key}`)
	if (value.model !== profile.model) throw new Error("request model is not admitted for this job")
	if (campaignMutationOnly) {
		const tools = value.tools
		const names = Array.isArray(tools) ? tools.map((tool) => {
			if (!tool || typeof tool !== "object" || Array.isArray(tool)) return ""
			const fn = (tool as Record<string, unknown>).function
			return fn && typeof fn === "object" && !Array.isArray(fn) && typeof (fn as Record<string, unknown>).name === "string"
				? (fn as Record<string, unknown>).name as string : ""
		}) : []
		const allowed = new Set<string>(CAMPAIGN_MUTATION_TOOL_NAMES)
		if (names.length > allowed.size || names.some((name) => !allowed.has(name)) || new Set(names).size !== names.length) {
			throw new Error("campaign mutation request tools exceed the fixed four-tool ceiling")
		}
	}
	if (!Array.isArray(value.messages) || value.messages.length < 1) throw new Error("request messages are malformed")
	for (const message of value.messages) {
		if (!message || typeof message !== "object" || Array.isArray(message)) throw new Error("request message is malformed")
		const entry = message as Record<string, unknown>
		if (!new Set(["system", "user", "assistant", "tool"]).has(String(entry.role)) || !(typeof entry.content === "string" || entry.content === null)) throw new Error("request message role/content is not admitted")
		for (const key of Object.keys(entry)) if (!["role", "content", "name", "tool_call_id", "tool_calls", "reasoning"].includes(key)) throw new Error(`request message field is not admitted: ${key}`)
	}
	const promptEnvelopeBytes = Buffer.byteLength(JSON.stringify(value), "utf8")
	if (promptEnvelopeBytes + 128 > limits.maxInputTokensPerCall) throw new Error("request exceeds conservative input-token byte bound")
	const requested = value.max_completion_tokens ?? value.max_tokens
	if (requested !== undefined && (!Number.isSafeInteger(requested) || Number(requested) < 1)) throw new Error("requested output-token limit is malformed")
	const outputLimit = Math.min(requested === undefined ? limits.maxOutputTokensPerCall : Number(requested), limits.maxOutputTokensPerCall)
	if (value.provider !== undefined) {
		if (!value.provider || typeof value.provider !== "object" || Array.isArray(value.provider)) throw new Error("request provider routing is malformed")
		const provider = value.provider as Record<string, unknown>
		if (provider.only && JSON.stringify(provider.only) !== JSON.stringify([profile.endpointProvider])) throw new Error("request provider routing does not match the pinned endpoint provider")
		if (provider.allow_fallbacks !== undefined && provider.allow_fallbacks !== profile.allowFallbacks) throw new Error("request provider fallbacks are disabled")
		for (const key of Object.keys(provider)) if (!["only", "allow_fallbacks"].includes(key)) throw new Error(`request provider field is not admitted: ${key}`)
	}
	if (value.stream_options !== undefined) {
		if (!value.stream_options || typeof value.stream_options !== "object" || Array.isArray(value.stream_options)) throw new Error("request stream options are malformed")
		for (const key of Object.keys(value.stream_options as Record<string, unknown>)) if (key !== "include_usage") throw new Error(`request stream option is not admitted: ${key}`)
	}
	value.provider = { only: [profile.endpointProvider], allow_fallbacks: profile.allowFallbacks }
	if (profile.cacheRouting === "opaque-job-key") {
		value.session_id = cacheRoutingKey
		value.prompt_cache_key = cacheRoutingKey
	} else {
		delete value.session_id
		delete value.prompt_cache_key
	}
	delete value.max_tokens
	value.max_tokens = outputLimit
	value.stream_options = { ...(value.stream_options && typeof value.stream_options === "object" ? value.stream_options as Record<string, unknown> : {}), include_usage: true }
	const encodedBody = Buffer.from(JSON.stringify(value))
	if (encodedBody.byteLength > limits.maxRequestBytes) throw new Error("request body exceeds broker limit")
	return { encodedBody, outputLimit }
}

export interface OpenRouterEndpointPriceSnapshot {
	model: string
	provider: string
	endpointTag: string
	quantization?: string
	supportedParameters: string[]
	inputPricePerMillionUsd: number
	outputPricePerMillionUsd: number
	observedAt: string
	responseSha256: string
}

/** Read current pinned endpoint pricing. This is a metadata GET; it does not submit inference. */
export async function fetchOpenRouterEndpointPrice(profile: RsiOpenRouterProfile, apiKey: string, fetcher: typeof fetch = fetch, now: () => number = Date.now): Promise<OpenRouterEndpointPriceSnapshot> {
	const url = `https://openrouter.ai/api/v1/models/${profile.model}/endpoints`
	const response = await fetcher(url, { method: "GET", redirect: "error", signal: AbortSignal.timeout(15_000), headers: apiKey.trim() ? { authorization: `Bearer ${apiKey}` } : {} })
	if (!response.ok) throw new Error(`OpenRouter price preflight failed with HTTP ${response.status}`)
	const bytes = await readResponse(response, 1024 * 1024)
	let data: { data?: { endpoints?: Array<{ provider_name?: unknown; provider_slug?: unknown; tag?: unknown; quantization?: unknown; status?: unknown; supported_parameters?: unknown; supports_tool_choice?: unknown; pricing?: { prompt?: unknown; completion?: unknown } }> } }
	try { data = JSON.parse(bytes.toString("utf8")) as typeof data } catch { throw new Error("OpenRouter price preflight returned malformed JSON") }
	const rows = data.data?.endpoints ?? []
	const endpoint = rows.find((row) => row.provider_name === profile.endpointProviderName && row.tag === profile.endpointTag
		&& (profile.quantization === undefined ? row.quantization === undefined || row.quantization === null : row.quantization === profile.quantization))
	const prompt = Number(endpoint?.pricing?.prompt)
	const completion = Number(endpoint?.pricing?.completion)
	const supportedParameters = Array.isArray(endpoint?.supported_parameters) ? endpoint.supported_parameters.filter((parameter): parameter is string => typeof parameter === "string") : []
	const supportsToolChoice = endpoint?.supports_tool_choice && typeof endpoint.supports_tool_choice === "object" ? endpoint.supports_tool_choice as Record<string, unknown> : {}
	if (!Number.isFinite(prompt) || prompt <= 0 || !Number.isFinite(completion) || completion <= 0 || endpoint?.status !== 0 || !profile.requiredParameters.every((parameter) => supportedParameters.includes(parameter)) || supportsToolChoice.auto !== true || supportsToolChoice.required !== true) throw new Error(`OpenRouter price preflight did not return the available pinned ${profile.endpointProviderName} endpoint with required agent parameters`)
	return {
		model: profile.model, provider: profile.endpointProvider, endpointTag: profile.endpointTag,
		...(profile.quantization ? { quantization: profile.quantization } : {}), supportedParameters,
		inputPricePerMillionUsd: prompt * 1_000_000,
		outputPricePerMillionUsd: completion * 1_000_000,
		observedAt: new Date(now()).toISOString(),
		responseSha256: sha256(bytes),
	}
}

export async function fetchPinnedOpenRouterEndpointPrice(apiKey: string, fetcher: typeof fetch = fetch, now: () => number = Date.now): Promise<OpenRouterEndpointPriceSnapshot> {
	return fetchOpenRouterEndpointPrice(RSI_OPENROUTER_PROFILES["deepseek-deepinfra-fp8"], apiKey, fetcher, now)
}

async function verifyPinnedPriceCeiling(fetcher: typeof fetch, apiKey: string, limits: OpenRouterBrokerLimits, profile: RsiOpenRouterProfile): Promise<OpenRouterEndpointPriceSnapshot> {
	const price = await fetchOpenRouterEndpointPrice(profile, apiKey, fetcher)
	const inputPricePerMillion = price.inputPricePerMillionUsd
	const outputPricePerMillion = price.outputPricePerMillionUsd
	if (limits.maxInputPricePerMillionUsd < inputPricePerMillion || limits.maxOutputPricePerMillionUsd < outputPricePerMillion) throw new Error("configured OpenRouter price ceiling is below the current pinned endpoint rate")
	const worstCase = (limits.maxInputTokensPerCall * limits.maxInputPricePerMillionUsd + limits.maxOutputTokensPerCall * limits.maxOutputPricePerMillionUsd) / 1_000_000
	if (limits.maxCallSpendUsd + 0.000001 < worstCase) throw new Error("per-call spend reservation is below the configured worst-case token cost")
	return price
}

function isHostInterfaceAddress(address: string): boolean {
	return Object.values(networkInterfaces()).flatMap((entries) => entries ?? []).some((entry) => entry.address === address)
}

export async function startOpenRouterBroker(options: OpenRouterBrokerOptions): Promise<RunningOpenRouterBroker> {
	const model = options.model ?? RSI_OPENROUTER_MODEL
	const profile = openRouterProfileForModel(model, options.profileId)
	if (!options.apiKey.trim()) throw new Error("host OpenRouter credential is required to start the RSI broker")
	if (!/^[A-Za-z0-9._:-]{1,160}$/.test(options.jobId) || !options.leaseToken) throw new Error("OpenRouter broker requires a job id and active lease token")
	const limits = validateOpenRouterBrokerLimits(options.limits)
	const maxPromptBytes = Math.min(limits.maxInputTokensPerCall, limits.maxRequestBytes) - 128
	if (!Number.isSafeInteger(maxPromptBytes) || maxPromptBytes <= 0) throw new Error("OpenRouter broker limits are too small to provide a positive prompt byte budget")
	const capability = randomBytes(32).toString("base64url")
	const cacheRoutingKey = `hc-rsi-${randomBytes(24).toString("base64url")}`
	const upstreamFetch = options.upstreamFetch ?? fetch
	const now = options.now ?? Date.now
	const endpointPrice = await verifyPinnedPriceCeiling(upstreamFetch, options.apiKey, limits, profile)
	if (!options.bindHost || options.bindHost === "0.0.0.0" || options.bindHost === "::" || !isHostInterfaceAddress(options.bindHost)) throw new Error("OpenRouter broker requires an address assigned to a host interface; wildcard or non-local listeners are disabled")
	const issuedAtMs = now()
		const keyBoundLedger = (options.ledger as OpenRouterInferenceLedger & { requiresHostApiKeyIdentity?: boolean }).requiresHostApiKeyIdentity === true
		const grant: OpenRouterBrokerGrant = { jobId: options.jobId, leaseToken: options.leaseToken, capability, model,
			...(keyBoundLedger ? { apiKeyIdentity: createHash("sha256").update(options.apiKey).digest("hex") } : {}),
			...profileReceiptIdentity(profile), ...(profile.id !== RSI_DEFAULT_OPENROUTER_PROFILE_ID ? { endpointPrice } : {}), limits, issuedAtMs }
	const jobDeadlineAtMs = await options.ledger.register(grant)
	if (!Number.isFinite(jobDeadlineAtMs) || jobDeadlineAtMs <= now()) throw new Error("OpenRouter job duration limit exhausted")
	let closing = false
	const pendingHandlers = new Set<Promise<void>>()
	const server: Server = createServer((request, response) => {
		let requestBytes = Number(request.headers["content-length"] ?? 0)
		if (!Number.isSafeInteger(requestBytes) || requestBytes < 0) requestBytes = 0
		response.once("finish", () => {
			try { options.onHttpResponse?.({ method: request.method ?? "UNKNOWN", statusCode: response.statusCode, requestBytes }) } catch { /* diagnostics must not affect request handling */ }
		})
		let authenticated = false
		const handler = (async () => {
			if (closing) { sendJson(response, 503, { error: { message: "broker is closing" } }); return }
			const deny = async (status: number, reason: OpenRouterDenialReason, message: string): Promise<void> => {
				try { await options.ledger.recordDenial(grant, status, reason) }
				catch { sendJson(response, 500, { error: { message: "broker could not durably record request denial" } }); return }
				sendJson(response, status, { error: { message } })
			}
			if (!capabilityMatches(request.headers.authorization, capability)) { sendJson(response, 401, { error: { message: "broker authorization failed" } }); return }
			authenticated = true
			const url = new URL(request.url ?? "/", "http://rsi-broker.invalid")
			const endpointPath = `/api/v1/models/${model}/endpoints`
			if (request.method === "GET" && url.pathname === endpointPath && !url.search) {
				await deny(404, "metadata-not-admitted", "model metadata is not provided by the RSI broker"); return
			}
			if (request.method !== "POST" || url.pathname !== "/api/v1/chat/completions" || url.search) { await deny(404, "unsupported-endpoint", "broker endpoint is not admitted"); return }
			const callId = request.headers["x-rsi-call-id"]
			if (typeof callId !== "string" || !/^[A-Za-z0-9_-]{16,100}$/.test(callId)) { await deny(400, "malformed-call-id", "broker call id is missing or malformed"); return }
			let rawBody: Buffer
			let checked: { encodedBody: Buffer; outputLimit: number }
			try {
				rawBody = await readBody(request, limits.maxRequestBytes)
				requestBytes = rawBody.byteLength
				checked = validateRequestBody(rawBody, limits, profile, cacheRoutingKey, options.campaignMutationOnly === true)
			} catch (error) {
				const message = error instanceof Error ? error.message : "invalid request"
				const limited = /exceeds|too large|byte bound/i.test(message)
				await deny(limited ? 413 : 400, limited ? "request-size-limit" : "invalid-request", message); return
			}
			const reservation: OpenRouterCallReservation = {
				callId, requestSha256: sha256(checked.encodedBody), reservedUsd: limits.maxCallSpendUsd,
				reservedTokens: limits.maxInputTokensPerCall + checked.outputLimit, startedAt: new Date(now()).toISOString(),
			}
			try { await options.ledger.reserve(grant, reservation) }
			catch (error) {
				const message = error instanceof Error ? error.message : "broker budget admission failed"
				await deny(429, /duration limit|duration exhausted/i.test(message) ? "job-deadline" : "budget-or-fence", message); return
			}
			const remainingJobMs = jobDeadlineAtMs - now()
			if (remainingJobMs <= 0) {
				await options.ledger.settle(grant, { callId, state: "unmeasured", completedAt: new Date(now()).toISOString() }).catch(() => undefined)
				await deny(429, "job-deadline", "OpenRouter job duration limit exhausted"); return
			}
			const controller = new AbortController()
			const timer = setTimeout(() => controller.abort(), Math.min(limits.maxDurationMs, remainingJobMs))
			let upstream: Response
			let upstreamBody: Buffer
			try {
				upstream = await upstreamFetch("https://openrouter.ai/api/v1/chat/completions", {
					method: "POST", redirect: "error", signal: controller.signal,
					headers: { authorization: `Bearer ${options.apiKey}`, "content-type": "application/json", "X-OpenRouter-Metadata": "enabled" }, body: checked.encodedBody,
				})
				upstreamBody = await readResponse(upstream, limits.maxResponseBytes)
			} catch {
				clearTimeout(timer)
				await options.ledger.settle(grant, { callId, state: "unmeasured", completedAt: new Date(now()).toISOString() }).catch(() => undefined)
				await deny(502, "upstream-ambiguous", "upstream outcome is ambiguous; reserved budget remains charged"); return
			} finally { clearTimeout(timer) }
			if (now() >= jobDeadlineAtMs) {
				await options.ledger.settle(grant, { callId, state: "unmeasured", completedAt: new Date(now()).toISOString() }).catch(() => undefined)
				await deny(429, "job-deadline", "OpenRouter job duration limit exhausted"); return
			}
			const contentType = upstream.headers.get("content-type") ?? "application/json"
			const usage = upstream.ok ? parseUsage(upstreamBody, contentType) : {}
			const measurable = usage.promptTokens !== undefined && usage.completionTokens !== undefined && usage.costUsd !== undefined && usage.provider !== undefined && (usage.cachedPromptTokens === undefined || usage.cachedPromptTokens <= usage.promptTokens)
			if (!upstream.ok || !measurable || usage.refusal === true) {
				await options.ledger.settle(grant, { callId, state: "unmeasured", ...(usage.model ? { returnedModel: usage.model } : {}), ...(usage.provider ? { returnedProvider: usage.provider } : {}), ...(usage.id ? { providerRequestId: usage.id } : {}), ...(usage.promptTokens !== undefined ? { promptTokens: usage.promptTokens } : {}), ...(usage.cachedPromptTokens !== undefined ? { cachedPromptTokens: usage.cachedPromptTokens } : {}), ...(usage.completionTokens !== undefined ? { completionTokens: usage.completionTokens } : {}), ...(usage.costUsd !== undefined ? { costUsd: usage.costUsd } : {}), responseSha256: sha256(upstreamBody), completedAt: new Date(now()).toISOString() }).catch(() => undefined)
				await deny(502, "usage-unverifiable", usage.refusal === true
					? "upstream returned a refusal or content filter; request is unqualified"
					: "upstream response lacks verifiable usage or selected endpoint metadata; request is unqualified"); return
			}
			const promptTokens = usage.promptTokens!
			const completionTokens = usage.completionTokens!
			const costUsd = usage.costUsd!
			const usageWithinBounds = promptTokens <= limits.maxInputTokensPerCall && completionTokens <= checked.outputLimit && costUsd <= limits.maxCallSpendUsd
			if (!profile.returnedModels.includes(usage.model ?? "") || usage.provider !== profile.endpointProvider || !usageWithinBounds) {
				await options.ledger.settle(grant, { callId, state: "complete", qualified: false, returnedModel: usage.model ?? "", returnedProvider: usage.provider, ...(usage.id ? { providerRequestId: usage.id } : {}), promptTokens: usage.promptTokens, ...(usage.cachedPromptTokens !== undefined ? { cachedPromptTokens: usage.cachedPromptTokens } : {}), completionTokens: usage.completionTokens, costUsd: usage.costUsd, responseSha256: sha256(upstreamBody), completedAt: new Date(now()).toISOString() }).catch(() => undefined)
				const message = !profile.returnedModels.includes(usage.model ?? "") ? "upstream returned a different model" : usage.provider !== profile.endpointProvider ? "upstream selected an endpoint outside the pinned provider" : "upstream usage exceeded admitted broker limits"
				await deny(502, "usage-out-of-bounds", `${message}; request is unqualified`); return
			}
			try {
				await options.ledger.settle(grant, {
					callId, state: "complete", qualified: true, returnedModel: usage.model, returnedProvider: usage.provider, providerRequestId: usage.id,
					promptTokens: usage.promptTokens, ...(usage.cachedPromptTokens !== undefined ? { cachedPromptTokens: usage.cachedPromptTokens } : {}), completionTokens: usage.completionTokens, costUsd: usage.costUsd,
					responseSha256: sha256(upstreamBody), completedAt: new Date(now()).toISOString(),
				})
			} catch {
				await deny(502, "settlement-failed", "broker could not durably reconcile usage; request is unqualified"); return
			}
			response.writeHead(upstream.status, {
				"content-type": contentType, "content-length": String(upstreamBody.byteLength), "cache-control": "no-store",
				...(upstream.headers.get("x-request-id") ? { "x-request-id": upstream.headers.get("x-request-id")! } : {}),
			})
			response.end(upstreamBody)
		})().catch(async () => {
			if (authenticated) await options.ledger.recordDenial(grant, 500, "request-failed").catch(() => undefined)
			if (!response.headersSent) sendJson(response, 500, { error: { message: "broker request failed closed" } }); else response.destroy()
		})
		pendingHandlers.add(handler)
		void handler.then(() => pendingHandlers.delete(handler), () => pendingHandlers.delete(handler))
	})
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject)
		server.listen(options.port ?? 0, options.bindHost, () => { server.removeListener("error", reject); resolve() })
	})
	const address = server.address()
	if (!address || typeof address === "string") { await new Promise<void>((resolve) => server.close(() => resolve())); throw new Error("OpenRouter broker did not bind a TCP port") }
	let closePromise: Promise<void> | undefined
	return {
		capability,
		guestBaseUrl: `http://host.openshell.internal:${address.port}`,
		localBaseUrl: `http://${options.bindHost}:${address.port}`,
		port: address.port,
		maxPromptBytes,
		async close() {
			if (!closePromise) {
				closing = true
				const httpClosed = server.listening
					? new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
					: Promise.resolve()
				// Guest connections are no longer needed, including partial request bodies.
				server.closeAllConnections()
				// A disconnected guest socket does not cancel its paid upstream call.
				// Retain the existing upstream deadline and await durable settlement.
				const drained = (async () => {
					while (pendingHandlers.size > 0) await Promise.allSettled([...pendingHandlers])
				})()
				closePromise = Promise.all([httpClosed, drained]).then(() => undefined)
			}
			await closePromise
		},
		receipt: async () => await options.ledger.receipt(grant),
	}
}
