/**
 * Local-model output summarization for oversized tool results
 * (opt-in — see the `HEADLESSCODE_LOCAL_SUMMARIZATION` env var).
 *
 * ─── Why this exists ─────────────────────────────────────────────────────────
 *
 * `src/tools/executor.ts`'s MAX_RESULT_CHARS (30,000) hard-truncates any tool
 * result before it reaches the model. For large, mostly-noisy command output
 * (a verbose test run, a big `npm install` log, a large `grep -r`) that blunt
 * cut discards whatever sat past the cutoff even when it contained the one
 * relevant line. This module gives an opted-in session a way to have a small
 * LOCAL model (via Ollama) compress that output instead — fast, zero marginal
 * $ cost, and deliberately NOT involved in any coding decision: it only
 * rewrites text the cloud model will read.
 *
 * ─── Ollama chat API — verified shape (2026-08-01, real local calls) ────────
 *
 * Verified live against `http://localhost:11434` (Ollama 0.24.0) — this is
 * the CHAT endpoint, distinct from the `/api/embed` embeddings endpoint that
 * `src/codesearch/` uses (see src/codesearch/ollama-embedder.ts if present):
 *
 *   POST /api/chat
 *   body: {
 *     model: "qwen3:8b",
 *     messages: [{ role: "system", content: ... }, { role: "user", content: ... }],
 *     stream: false,
 *     think: false,               // qwen3-class models only (see below)
 *     options: { num_predict, temperature }
 *   }
 *   200 response: {
 *     model, created_at,
 *     message: { role: "assistant", content: "...", thinking?: "..." },
 *     done: true, done_reason: "stop" | "length",
 *     total_duration, load_duration, prompt_eval_count, eval_count, ...
 *   }
 *
 * VERIFIED FINDING 1 — qwen3-class models reason by default: with a plain
 * request (no `think` field), `qwen3:8b` fills `message.thinking` and leaves
 * `message.content` EMPTY until the token budget is exhausted. The request
 * MUST send `think: false` for those models (llama3.1 ignores the field).
 *
 * VERIFIED FINDING 2 — a cold model takes ~3-6s to load into VRAM before the
 * first token; a warm call is ~1-2s for a ~7KB input. Ollama holds the model
 * resident after the first call, so consecutive oversized outputs in one
 * session are cheap.
 *
 * VERIFIED FINDING 3 — a summarization prompt that only says "keep errors
 * verbatim" makes the model DISCARD listing content (grep output) entirely.
 * The prompt must tell it what the output IS (error log vs listing) and that
 * it must never invent labels/content (llama3.1:8b fabricated "Error:",
 * "Exit code: 1" and merged code lines when not explicitly forbidden).
 *
 * ─── Failure contract (non-fatal, matches loop.ts's idiom) ──────────────────
 *
 * EVERY failure path in here throws; the executor catches and falls back to
 * its existing blunt truncation. A summarizer must NEVER turn a tool result
 * into an error or block the session. Timeout, unreachable Ollama, HTTP
 * error, non-JSON body, missing `message.content`, empty content — all
 * throw, all fall back.
 */

import type { Logger } from "../engine/logger.js"

/** Env var that gates the whole feature (default OFF — see executor.ts). */
export const LOCAL_SUMMARIZATION_ENV = "HEADLESSCODE_LOCAL_SUMMARIZATION"

/** Ollama base URL override. */
export const OLLAMA_URL_ENV = "HEADLESSCODE_OLLAMA_URL"

/** Default Ollama base URL (local default install). */
export const DEFAULT_OLLAMA_URL = "http://localhost:11434"

/** Default local chat model used for summarization. */
export const DEFAULT_SUMMARIZATION_MODEL = "qwen3:8b"

/** Model override env var. */
export const SUMMARIZATION_MODEL_ENV = "HEADLESSCODE_SUMMARIZATION_MODEL"

/** Request timeout: a slow/broken local model must never block the loop. */
export const DEFAULT_SUMMARIZATION_TIMEOUT_MS = 15_000

/**
 * Hard cap on the raw content we are willing to SEND to the local model. A
 * pathological multi-MB output should not be uploaded to the local server at
 * full size; beyond this the model sees only the first `MAX_RESULT_CHARS`
 * window (matching the blunt truncation) and summarizes that window. Keeps a
 * 500KB command log from becoming a 500KB local request.
 */
export const MAX_SUMMARIZER_INPUT_CHARS = 60_000

/** Blunt-truncation cap used by the summarizer's own fallback (matches executor MAX_RESULT_CHARS). */
export const MAX_RESULT_CHARS_FOR_FALLBACK = 30_000

/** Soft cap on summary length the model is asked to stay under. */
export const SUMMARIZATION_TARGET_CHARS = 400

/** Hard safety cap on what the summarizer is ALLOWED to return. */
export const MAX_SUMMARY_CHARS = 8_000

/**
 * Whether local output summarization is enabled when
 * HEADLESSCODE_LOCAL_SUMMARIZATION is unset. Measured decision (2026-08-15,
 * r3-summarize round): oversized execute_command results that would engage
 * the summarizer occur in ~1.8% of real exec results (~0.5/session), saving
 * ~4k input tokens/session (mostly provider-cache-covered) at +2.5-3.4s
 * latency per result — not material enough to impose on every deployment,
 * and summary quality is model-dependent. Flipping to true is a one-line
 * default change; the env var then acts as the opt-out ("0"/"false").
 */
export const LOCAL_SUMMARIZATION_DEFAULT_ENABLED = false

/** Env-var gate: is local summarization enabled for this process? */
export function isLocalSummarizationEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	if (env[LOCAL_SUMMARIZATION_ENV] !== undefined) {
		const v = env[LOCAL_SUMMARIZATION_ENV].toLowerCase()
		return v === "1" || v === "true"
	}
	return LOCAL_SUMMARIZATION_DEFAULT_ENABLED
}

/** Resolve the Ollama base URL: env → default. */
export function resolveOllamaUrl(env: NodeJS.ProcessEnv = process.env): string {
	return (env[OLLAMA_URL_ENV]?.trim() || DEFAULT_OLLAMA_URL).replace(/\/+$/, "")
}

/** Resolve the summarization model: env → default. */
export function resolveSummarizationModel(env: NodeJS.ProcessEnv = process.env): string {
	return env[SUMMARIZATION_MODEL_ENV]?.trim() || DEFAULT_SUMMARIZATION_MODEL
}

/** Result of a successful local summarization. */
export interface SummarizeResult {
	/** The compressed output (never exceeds MAX_SUMMARY_CHARS). */
	summary: string
	/** Original length in characters (for the transparency header). */
	originalChars: number
	/** True when the response was cut off by the model's token budget. */
	truncated: boolean
	/** Wall-clock time the local call took, ms. */
	elapsedMs: number
}

/** Options for OllamaOutputSummarizer. */
export interface OutputSummarizerOptions {
	baseUrl?: string
	model?: string
	timeoutMs?: number
	/**
	 * Injectable fetch for tests. Must accept a RequestInfo/URL + init and
	 * return a Response-like object (the real `fetch` signature).
	 */
	fetchImpl?: typeof fetch
}

/**
 * Summarize large tool output via a local Ollama chat model.
 *
 * System prompt: extractive, anti-hallucination, output-type-aware — the
 * evaluation found this exact combination is what makes a small local model
 * keep the needle instead of inventing one or discarding the whole listing.
 */
export class OllamaOutputSummarizer {
	/**
	 * Optional explicit base URL/model (used by tests / non-env callers).
	 * When absent, resolved from process.env on EACH summarize() call, so a
	 * process whose env changes (tests) always hits the right endpoint.
	 */
	private readonly baseUrlOverride: string | undefined
	private readonly modelOverride: string | undefined
	/** Model id used for summarization (surfaced in the transparency header). */
	readonly model: string
	private readonly timeoutMs: number
	private readonly fetchImpl: typeof fetch

	constructor(options: OutputSummarizerOptions = {}) {
		this.baseUrlOverride = options.baseUrl
		this.modelOverride = options.model
		// When no explicit model was given, resolve now so `readonly model` is
		// stable for the header even if env changes later; per-call resolution
		// below only affects the URL when no override is present.
		this.model = options.model ?? resolveSummarizationModel()
		this.timeoutMs = options.timeoutMs ?? DEFAULT_SUMMARIZATION_TIMEOUT_MS
		this.fetchImpl = options.fetchImpl ?? fetch
	}

	/** Base URL used for the next request: explicit override, else env-per-call. */
	private currentBaseUrl(): string {
		return this.baseUrlOverride ?? resolveOllamaUrl()
	}

	/**
	 * Compress `rawOutput`. Throws on any failure — the caller (the executor)
	 * catches and falls back to blunt truncation. Never resolves with an empty
	 * or oversized summary.
	 */
	async summarize(rawOutput: string): Promise<SummarizeResult> {
		const started = Date.now()
		const controller = new AbortController()
		const timer = setTimeout(() => controller.abort(), this.timeoutMs)
		const baseUrl = this.currentBaseUrl()

		let response: Response
		try {
			response = await this.fetchImpl(`${baseUrl}/api/chat`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					model: this.model,
					messages: [
						{ role: "system", content: SUMMARIZATION_SYSTEM_PROMPT },
						{ role: "user", content: buildSummarizeUserPrompt(rawOutput) },
					],
					stream: false,
					// qwen3-class models reason by default and leave content
					// empty; think:false forces a direct answer (verified live,
					// see header). Harmless for models that ignore the field.
					think: false,
					options: { num_predict: 700, temperature: 0 },
				}),
				signal: controller.signal,
			})
		} catch (error) {
			throw new SummarizerError(
				error instanceof Error && error.name === "AbortError"
					? `local summarization timed out after ${this.timeoutMs}ms (${this.model} @ ${baseUrl})`
					: `local summarization request failed (Ollama unreachable?): ${
							error instanceof Error ? error.message : String(error)
						}`,
			)
		} finally {
			clearTimeout(timer)
		}

		if (!response.ok) {
			const body = await response.text().catch(() => "")
			throw new SummarizerError(
				`local summarization returned HTTP ${response.status} from ${baseUrl} (model ${this.model}): ${excerpt(body)}`,
			)
		}

		const rawBody = await response.text()
		let data:
			| {
					message?: { content?: string; thinking?: string }
					done_reason?: string
			  }
			| undefined
		try {
			data = JSON.parse(rawBody) as { message?: { content?: string }; done_reason?: string }
		} catch {
			throw new SummarizerError(
				`local summarization returned a non-JSON body from ${baseUrl}: ${excerpt(rawBody) || "(empty)"}`,
			)
		}

		// A qwen3-class model that ignored `think: false` (or an old Ollama that
		// doesn't support the field) leaves content empty — treat as a failure
		// rather than sending the model an empty summary.
		const content = data?.message?.content
		if (typeof content !== "string" || content.trim() === "") {
			throw new SummarizerError(
				`local summarization returned an empty message.content (model ${this.model} may have put everything in 'thinking'; ${
					this.model.startsWith("qwen3") ? "is think:false supported by this Ollama version?" : ""
				}). Raw body: ${excerpt(rawBody)}`,
			)
		}

		// Hard safety cap: a runaway model response must never blow the context
		// budget this feature exists to protect. If it exceeds the cap we fall
		// back to blunt truncation rather than serving a summary bigger than
		// the original truncation.
		if (content.length > MAX_SUMMARY_CHARS) {
			throw new SummarizerError(
				`local summarization produced ${content.length} chars (cap ${MAX_SUMMARY_CHARS}) — falling back to blunt truncation`,
			)
		}

		return {
			summary: content.trim(),
			originalChars: rawOutput.length,
			truncated: data.done_reason === "length",
			elapsedMs: Date.now() - started,
		}
	}
}

/** Typed error for every summarizer failure (caught by the executor). */
export class SummarizerError extends Error {
	constructor(message: string) {
		super(message)
		this.name = "SummarizerError"
	}
}

/**
 * System prompt — the anti-hallucination + output-type rules are load-bearing
 * (see header VERIFIED FINDING 3). Extractive, not generative.
 */
export const SUMMARIZATION_SYSTEM_PROMPT =
	"Your job: compress LARGE command output for a software engineering agent. This is a TOOL RESULT " +
	"(stdout/stderr of a command the agent ran). Compress it while preserving the information a coding " +
	"agent needs. HARD RULES:\n" +
	"1. NEVER invent or add content. Do NOT add 'Error:', 'Warning:', 'Exit code:' labels, do NOT claim " +
	"something is an error unless the output literally contains that error, do NOT reorder or synthesize. " +
	"You may only quote, condense, or omit.\n" +
	"2. Keep failures, errors, warnings and their exact messages VERBATIM — this is the single most " +
	"important thing.\n" +
	"3. If the output is a listing (grep matches, file lists, test names), keep the listed entries with " +
	"their locations — the entries ARE the content.\n" +
	"4. If there is nothing important, say so in one short line — do not fabricate.\n" +
	"5. No meta-commentary, no preamble like 'Here is', no advice. Output the compressed content only."

/** Build the user prompt for a given raw output. */
export function buildSummarizeUserPrompt(rawOutput: string): string {
	return (
		`The agent ran a command and got this tool output (${rawOutput.length} chars). ` +
		`Compress it to roughly ${SUMMARIZATION_TARGET_CHARS} chars or fewer, keeping anything important verbatim:\n\n` +
		`=== OUTPUT BEGIN ===\n${rawOutput}\n=== OUTPUT END ===`
	)
}

/** Truncate a raw body to a bounded excerpt for error messages. */
function excerpt(body: string): string {
	return body.length > 500 ? `${body.slice(0, 500)}…` : body
}

/**
 * Wrapper used by the executor's result path: run the summarizer, log the
 * outcome, and fall back to blunt truncation on ANY failure. Mirrors the
 * checkpoint/memory "non-fatal" idiom — the local model must never be able to
 * turn a tool result into an error or block the session.
 */
export async function summarizeToolResult(
	content: string,
	summarizer: OllamaOutputSummarizer,
	logger: Pick<Logger, "debug" | "warn">,
): Promise<string> {
	try {
		const result = await summarizer.summarize(content)
		const header =
			`[Output summarized by local model (${summarizer.model}) — original was ${result.originalChars} chars; ` +
			`summary is ${result.summary.length} chars${result.truncated ? "; model hit its output budget, summary may be incomplete" : ""}]`
		logger.debug(`[local-summ] summarized ${result.originalChars} chars -> ${result.summary.length} chars`, {
			model: summarizer.model,
			elapsedMs: result.elapsedMs,
			truncated: result.truncated,
		})
		return `${header}\n${result.summary}`
	} catch (error) {
		// Non-fatal: fall back to today's blunt truncation, never an error.
		logger.warn(
			`[local-summ] summarization failed (non-fatal; falling back to blunt truncation): ${
				error instanceof Error ? error.message : String(error)
			}`,
		)
		return truncateFallback(content)
	}
}

/** Today's exact blunt-truncation behavior (also exported for tests). */
export function truncateFallback(content: string, maxChars = MAX_RESULT_CHARS_FOR_FALLBACK): string {
	if (content.length <= maxChars) {
		return content
	}
	return (
		content.slice(0, maxChars) +
		`\n…[output truncated at ${maxChars} chars to keep context bounded]`
	)
}
