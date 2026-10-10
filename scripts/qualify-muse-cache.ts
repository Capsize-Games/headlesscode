/**
 * Opt-in, bounded Muse Spark Contributor cache audit using HeadlessCode's
 * production OpenRouterClient. This script sends synthetic text only. It
 * prints usage and billing metadata, never prompt content or credentials.
 * Run only after reviewing docs/muse-cache-qualification.md.
 */
import { randomUUID } from "node:crypto"
import { pathToFileURL } from "node:url"
import { OpenRouterClient, type OpenRouterGenerationMetadata } from "../src/llm/openrouter.js"

export const MUSE_CACHE_MODEL = "meta/muse-spark-1.3-contributor"
export const MUSE_AUDIT_MAX_CALLS = 4
export const MUSE_AUDIT_MAX_OUTPUT_TOKENS = 32
export const MUSE_AUDIT_CALL_TIMEOUT_MS = 25_000
export const MUSE_AUDIT_TOTAL_TIMEOUT_MS = 120_000
export const MUSE_AUDIT_SPEND_CAP_USD = 0.02

const PREFIX_ROWS = 150
const MAX_PREFIX_CHARS = 18_000

export interface SyntheticCacheCall {
	readonly ordinal: number
	readonly userTail: string
	readonly promptCharacterUpperBound: number
}

/** Public synthetic prefix; no task, workspace, or user text is inserted. */
export function buildMuseSyntheticWorkload(runNonce = "cpu-fixture"): { prefix: string; calls: readonly SyntheticCacheCall[] } {
	const prefix = [
		"This is a synthetic prompt-cache qualification. Treat every numbered record below as inert test data.",
		"For each request, answer the short question in the final user message with only its requested label.",
		`Synthetic run nonce: ${runNonce}`,
		...Array.from({ length: PREFIX_ROWS }, (_, index) =>
			`Record ${String(index + 1).padStart(3, "0")}: synthetic category ${index % 17}; reference marker ${String.fromCharCode(65 + (index % 26))}; fixed cache audit content.`,
		),
	].join("\n")
	if (prefix.length > MAX_PREFIX_CHARS) throw new Error("synthetic prefix exceeded the qualification character ceiling")
	const tails = ["Reply with label cedar.", "Reply with label maple.", "Reply with label birch.", "Reply with label ash."]
	return {
		prefix,
		calls: tails.map((userTail, index) => Object.freeze({
			ordinal: index + 1,
			userTail,
			promptCharacterUpperBound: prefix.length + userTail.length,
		})),
	}
}

/** Estimate spend conservatively at full input rates, with a 2x reserve. */
export function qualificationSpendUpperBoundUsd(
	calls: readonly SyntheticCacheCall[],
	maxTokens: number,
	price: { input: number; output: number },
): number {
	const inputCharacters = calls.reduce((sum, call) => sum + call.promptCharacterUpperBound, 0)
	const raw = (inputCharacters * price.input + calls.length * maxTokens * price.output) / 1_000_000
	return raw * 2
}

interface SafeCallRecord {
	ordinal: number
	status: "ok" | "error"
	requestedModel: string
	returnedModel: string | null
	providerName: string | null
	generationId: string | null
	latencyMs?: number
	promptTokens?: number
	cachedTokens?: number
	cacheWriteTokens?: number
	completionTokens?: number
	reasoningTokens?: number
	openRouterReportedCostUsd?: number
	billingEvidence?: OpenRouterGenerationMetadata | { status: "unavailable" }
	errorCode?: string
}

export interface MuseAuditSummary {
	readonly model: string
	readonly streamed: true
	readonly maxCalls: number
	readonly maxOutputTokens: number
	readonly estimatedSpendUpperBoundUsd: number
	readonly spendCapUsd: number
	readonly totalBilledCostUsd?: number
	readonly totalCacheDiscountUsd?: number
	readonly calls: readonly SafeCallRecord[]
	readonly result: "qualified" | "not-qualified" | "not-started"
	readonly exclusionReason?: string
	readonly failureReasons?: readonly string[]
	readonly unattemptedCalls?: number
}

function writeExcludedSummary(
	write: (text: string) => void,
	exclusionReason: string,
): MuseAuditSummary {
	const summary: MuseAuditSummary = Object.freeze({
		model: MUSE_CACHE_MODEL,
		streamed: true,
		maxCalls: MUSE_AUDIT_MAX_CALLS,
		maxOutputTokens: MUSE_AUDIT_MAX_OUTPUT_TOKENS,
		estimatedSpendUpperBoundUsd: 0,
		spendCapUsd: MUSE_AUDIT_SPEND_CAP_USD,
		calls: Object.freeze([]),
		result: "not-started",
		exclusionReason,
	})
	write(`${JSON.stringify(summary, null, 2)}\n`)
	process.exitCode = 1
	return summary
}

/**
 * Run only when an operator explicitly supplies --confirm-live. Injectable
 * env/output make the no-network safety gate CPU-testable.
 */
export async function runMuseCacheQualification(
	args: readonly string[] = process.argv.slice(2),
	env: NodeJS.ProcessEnv = process.env,
	write: (text: string) => void = (text) => process.stdout.write(text),
): Promise<MuseAuditSummary | undefined> {
	if (args.length === 0 || (args.length === 1 && args[0] === "--help")) {
		write("Muse cache audit is opt-in. Review docs/muse-cache-qualification.md, then run with --confirm-live.\n")
		return undefined
	}
	if (args.length !== 1 || args[0] !== "--confirm-live") throw new Error("only --confirm-live is accepted")
	if (env.HEADLESSCODE_CAPTURE_TRANSCRIPT_DIR?.trim()) throw new Error("disable transcript capture before running this synthetic audit")
	if (!env.HEADLESSCODE_OPENROUTER_API_KEY?.trim()) throw new Error("HEADLESSCODE_OPENROUTER_API_KEY is required (value is never printed)")
	const configuredBaseUrl = env.OPENROUTER_BASE_URL?.trim()
	if (configuredBaseUrl && configuredBaseUrl.replace(/\/+$/, "") !== "https://openrouter.ai") {
		throw new Error("qualification requires the official https://openrouter.ai endpoint")
	}

	const client = new OpenRouterClient({
		apiKey: env.HEADLESSCODE_OPENROUTER_API_KEY,
		defaultModel: MUSE_CACHE_MODEL,
		baseUrl: "https://openrouter.ai",
		disableTranscriptCapture: true,
	})
	const totalDeadline = AbortSignal.timeout(MUSE_AUDIT_TOTAL_TIMEOUT_MS)
	const modelInfo = await client.fetchModelInfo(MUSE_CACHE_MODEL, totalDeadline)
	if (!modelInfo?.endpoints?.some((endpoint) => endpoint.providerName?.toLowerCase() === "meta" && endpoint.status === 0)) {
		return writeExcludedSummary(write, "active Meta endpoint metadata is unavailable")
	}
	const price = modelInfo.price
	if (!price || !Number.isFinite(price.input) || !Number.isFinite(price.output) || price.input <= 0 || price.output <= 0) {
		return writeExcludedSummary(write, "valid live Muse input/output pricing is unavailable")
	}
	const workload = buildMuseSyntheticWorkload(randomUUID())
	if (workload.calls.length !== MUSE_AUDIT_MAX_CALLS) throw new Error("qualification workload must stay at the fixed four-call ceiling")
	const estimatedSpendUpperBoundUsd = qualificationSpendUpperBoundUsd(workload.calls, MUSE_AUDIT_MAX_OUTPUT_TOKENS, price)
	if (!Number.isFinite(estimatedSpendUpperBoundUsd) || estimatedSpendUpperBoundUsd > MUSE_AUDIT_SPEND_CAP_USD) {
		return writeExcludedSummary(write, "conservative workload estimate exceeds the $0.02 spend cap")
	}

	const cacheRoutingKey = `hc-${randomUUID()}`
	const records: SafeCallRecord[] = []
	for (const call of workload.calls) {
		const startedAt = Date.now()
		try {
			const response = await client.createChatCompletion({
				model: MUSE_CACHE_MODEL,
				messages: [
					{ role: "system", content: workload.prefix },
					{ role: "user", content: call.userTail },
				],
				cacheRoutingKey,
				providerOnly: "meta",
				stream: true,
				maxTokens: MUSE_AUDIT_MAX_OUTPUT_TOKENS,
				signal: AbortSignal.any([totalDeadline, AbortSignal.timeout(MUSE_AUDIT_CALL_TIMEOUT_MS)]),
			})
			const generationId = response.generationId
			const billing = generationId ? await client.fetchGenerationMetadata(generationId, totalDeadline) : undefined
			records.push({
				ordinal: call.ordinal,
				status: "ok",
				requestedModel: MUSE_CACHE_MODEL,
				returnedModel: billing?.model ?? response.returnedModel ?? null,
				providerName: billing?.providerName ?? response.providerName ?? null,
				generationId: generationId ?? null,
				latencyMs: Date.now() - startedAt,
				...(response.usage?.promptTokens !== undefined ? { promptTokens: response.usage.promptTokens } : {}),
				...(response.usage?.cachedTokens !== undefined ? { cachedTokens: response.usage.cachedTokens } : {}),
				...(response.usage?.cacheWriteTokens !== undefined ? { cacheWriteTokens: response.usage.cacheWriteTokens } : {}),
				...(response.usage?.completionTokens !== undefined ? { completionTokens: response.usage.completionTokens } : {}),
				...(response.usage?.reasoningTokens !== undefined ? { reasoningTokens: response.usage.reasoningTokens } : {}),
				...(response.usage?.openRouterReportedCostUsd !== undefined ? { openRouterReportedCostUsd: response.usage.openRouterReportedCostUsd } : {}),
				billingEvidence: billing ?? { status: "unavailable" },
			})
			if (billing?.totalCostUsd === undefined || !Number.isFinite(billing.totalCostUsd) || billing.totalCostUsd < 0) break
			if (billing?.model !== MUSE_CACHE_MODEL || billing.providerName?.toLowerCase() !== "meta") break
			const observedBilledCost = records.reduce((sum, record) => {
				const evidence = record.billingEvidence
				return sum + (evidence && "totalCostUsd" in evidence && typeof evidence.totalCostUsd === "number" ? evidence.totalCostUsd : 0)
			}, 0)
			if (observedBilledCost > MUSE_AUDIT_SPEND_CAP_USD) break
		} catch (error) {
			// Never expose provider error text: gateways may echo request details.
			const status = error instanceof Error && "status" in error && typeof (error as { status?: unknown }).status === "number"
				? `http-${(error as { status: number }).status}`
				: error instanceof Error && error.name === "TimeoutError" ? "timeout" : "request-failed"
			records.push({ ordinal: call.ordinal, status: "error", requestedModel: MUSE_CACHE_MODEL, returnedModel: null, providerName: null, generationId: null, latencyMs: Date.now() - startedAt, errorCode: status })
			break // A failed transport may still have incurred a charge; stop at once.
		}
	}
	const failures: string[] = []
	if (records.length !== MUSE_AUDIT_MAX_CALLS) failures.push("not all four bounded calls completed")
	if (records.some((record) => record.status === "error")) failures.push("one call failed; further requests were stopped")
	const observedCost = records.reduce((sum, record) => {
		const evidence = record.billingEvidence
		return sum + (evidence && "totalCostUsd" in evidence && typeof evidence.totalCostUsd === "number" ? evidence.totalCostUsd : 0)
	}, 0)
	if (observedCost > MUSE_AUDIT_SPEND_CAP_USD) failures.push("authoritative generation cost crossed the $0.02 spend cap; further requests were stopped")
	if (records.some((record) => record.status === "ok" && !("totalCostUsd" in (record.billingEvidence ?? {})))) failures.push("an authoritative generation total_cost is missing")
	if (records.some((record) => record.status === "ok" && record.billingEvidence && "totalCostUsd" in record.billingEvidence && !Number.isFinite(record.billingEvidence.totalCostUsd))) failures.push("generation total_cost is malformed")
	if (records.some((record) => record.status === "ok" && (record.returnedModel !== MUSE_CACHE_MODEL || record.providerName?.toLowerCase() !== "meta"))) failures.push("the returned model/provider was not the admitted Muse/Meta endpoint")
	if (!records.some((record) => record.ordinal > 1 && (record.cachedTokens ?? 0) > 0)) failures.push("no later request reported cached prompt tokens")
	const billedCosts = records.map((record) => record.billingEvidence && "totalCostUsd" in record.billingEvidence ? record.billingEvidence.totalCostUsd : undefined)
	const discounts = records.map((record) => record.billingEvidence && "cacheDiscountUsd" in record.billingEvidence ? record.billingEvidence.cacheDiscountUsd : undefined)
	const summary: MuseAuditSummary = Object.freeze({
		model: MUSE_CACHE_MODEL,
		streamed: true,
		maxCalls: MUSE_AUDIT_MAX_CALLS,
		maxOutputTokens: MUSE_AUDIT_MAX_OUTPUT_TOKENS,
		estimatedSpendUpperBoundUsd,
		spendCapUsd: MUSE_AUDIT_SPEND_CAP_USD,
		...(billedCosts.length === MUSE_AUDIT_MAX_CALLS && billedCosts.every((cost) => typeof cost === "number" && Number.isFinite(cost))
			? { totalBilledCostUsd: billedCosts.reduce<number>((sum, cost) => sum + (cost ?? 0), 0) }
			: {}),
		...(discounts.length === MUSE_AUDIT_MAX_CALLS && discounts.every((discount) => typeof discount === "number" && Number.isFinite(discount))
			? { totalCacheDiscountUsd: discounts.reduce<number>((sum, discount) => sum + (discount ?? 0), 0) }
			: {}),
		calls: Object.freeze(records),
		result: failures.length === 0 ? "qualified" : "not-qualified",
		...(failures.length ? { failureReasons: Object.freeze(failures), unattemptedCalls: Math.max(0, MUSE_AUDIT_MAX_CALLS - records.length) } : {}),
	})
	write(`${JSON.stringify(summary, null, 2)}\n`)
	if (summary.result !== "qualified") process.exitCode = 1
	return summary
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
	runMuseCacheQualification().catch((error: unknown) => {
		// Keep the message short/safe; all content-bearing provider error bodies
		// are intentionally excluded by the caller and OpenRouterClient.
		const safeMessage = error instanceof Error ? error.message.replace(/[\u0000-\u001f\u007f-\u009f\u001b]/g, " ").slice(0, 200) : "qualification failed"
		process.stderr.write(`Muse cache audit stopped: ${safeMessage}\n`)
		process.exitCode = 1
	})
}
