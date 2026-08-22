/**
 * AIRunner embedder for the codebase index.
 *
 * A third backend alongside the OpenRouter (src/codesearch/embedder.ts) and
 * Ollama (src/codesearch/ollama-embedder.ts) embedders. AIRunner (the local
 * FastAPI/Python server in the sibling `airunner` repo) exposes its native
 * in-process embedding stack (intfloat/e5-large) through a plain HTTP
 * endpoint — POST /api/v1/embed/text — so headlesscode can embed chunks
 * against a locally running AIRunner server without going through the
 * Ollama-shaped shim or spending cloud money.
 *
 * Opt-in via `HEADLESSCODE_EMBEDDING_BACKEND=airunner` or
 * `--embedding-backend airunner` on `headlesscode index`; the default stays
 * OpenRouter.
 *
 * ─── AIRunner embeddings — endpoint contract ────────────────────────────
 *
 * 1. ENDPOINT + BATCHING: POST {AIRUNNER_EMBED_URL}/api/v1/embed/text
 *    accepts `{"texts": string[]}` and returns
 *    `{"model": "intfloat/e5-large", "embeddings": number[][]}` — one HTTP
 *    call per whole batch, vectors in input order (mirrors the Ollama
 *    /api/embed contract). e5-large produces 1024-dim vectors.
 * 2. RESPONSE SHAPE: embeddings are plain JSON number arrays. There is no
 *    usage/token accounting for a fully local call — promptTokens is
 *    approximate (vector length) and only used for display, exactly like the
 *    Ollama backend.
 * 3. DIMENSION: e5-large = 1024 dims, NOT interchangeable with Ollama's
 *    qwen3-embedding:8b (4096) or OpenRouter's qwen/qwen3-embedding-4b
 *    (2560). The index build records {backend, model} metadata and the
 *    `codebase_search` tool refuses a backend mismatch (see
 *    src/codesearch/index.ts + the executor handler), same as the other
 *    local backend.
 *
 * The embedder interface (Embedder) is shared with the other paths; only the
 * HTTP client differs. No batching/hashing logic is duplicated here — the
 * caller (src/codesearch/index.ts buildIndex) slices batches exactly as it
 * does for the other backends.
 */

import type { EmbedResult } from "./embedder.js"

/** Default AIRunner server base URL (AIRunner's standard local port). */
export const DEFAULT_AIRUNNER_URL = "http://localhost:8080"

/** Default local embedding model (the one AIRunner serves). */
export const DEFAULT_AIRUNNER_EMBEDDING_MODEL = "intfloat/e5-large"

/** Env var that overrides the AIRunner server URL. */
export const AIRUNNER_URL_ENV = "HEADLESSCODE_AIRUNNER_EMBED_URL"

/** Env var that overrides the AIRunner embedding model name. */
export const AIRUNNER_EMBEDDING_MODEL_ENV = "HEADLESSCODE_AIRUNNER_EMBED_MODEL"

/** Resolve the AIRunner URL: env override → default. */
export function resolveAirunnerUrl(env: NodeJS.ProcessEnv = process.env): string {
	return env[AIRUNNER_URL_ENV]?.trim() || DEFAULT_AIRUNNER_URL
}

/** Resolve the AIRunner embedding model: env override → default. */
export function resolveAirunnerEmbeddingModel(env: NodeJS.ProcessEnv = process.env): string {
	return env[AIRUNNER_EMBEDDING_MODEL_ENV]?.trim() || DEFAULT_AIRUNNER_EMBEDDING_MODEL
}

/** Typed error for AIRunner failures, carrying a pre-built actionable message. */
export class AirunnerEmbedError extends Error {
	/** HTTP status when AIRunner answered (undefined for network-level failures). */
	readonly status?: number
	/** The raw error body AIRunner returned, when one exists. */
	readonly body?: string

	constructor(message: string, status?: number, body?: string) {
		super(message)
		this.name = "AirunnerEmbedError"
		this.status = status
		this.body = body
	}
}

/**
 * AIRunner-backed embedder. One HTTP call per batch (POST /api/v1/embed/text),
 * matching the other backends' batching. Failures are wrapped in actionable
 * errors — never a silent fallback to another backend (that would surprise
 * the user with unexpected cloud spend).
 */
export class AirunnerEmbedder {
	readonly backend = "airunner" as const
	readonly model: string
	private readonly baseUrl: string

	constructor(model: string = resolveAirunnerEmbeddingModel(), baseUrl: string = resolveAirunnerUrl()) {
		this.model = model
		this.baseUrl = baseUrl.replace(/\/+$/, "")
	}

	async embedBatch(texts: string[]): Promise<EmbedResult> {
		if (texts.length === 0) {
			return { embeddings: [], model: this.model, promptTokens: 0, totalTokens: 0 }
		}

		// Same guard as the other embedders: empty inputs are rejected
		// upstream and produce no useful vector anyway.
		const emptyIndex = texts.findIndex((t) => t.trim() === "")
		if (emptyIndex !== -1) {
			throw new AirunnerEmbedError(
				`cannot embed empty/whitespace-only input at index ${emptyIndex} — providers reject it`,
			)
		}

		const url = `${this.baseUrl}/api/v1/embed/text`
		let response: Response
		try {
			response = await fetch(url, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ texts }),
			})
		} catch (err) {
			// Network-level failure (connection refused, DNS, ...) — AIRunner
			// is either not running or unreachable. Actionable, not generic.
			throw new AirunnerEmbedError(
				`AIRunner backend selected but ${this.baseUrl} is unreachable — is the AIRunner server running? ` +
					`(or set HEADLESSCODE_AIRUNNER_EMBED_URL if AIRunner listens elsewhere): ` +
					`${err instanceof Error ? err.message : String(err)}`,
			)
		}

		const rawBody = await response.text().catch(() => "")
		if (!response.ok) {
			throw new AirunnerEmbedError(
				`AIRunner embeddings returned HTTP ${response.status}: ${excerpt(rawBody || "(empty body)")}`,
				response.status,
				excerpt(rawBody),
			)
		}

		let data:
			| {
					model?: unknown
					embeddings?: unknown
					error?: { message?: string }
			  }
			| undefined
		try {
			data = JSON.parse(rawBody)
		} catch {
			throw new AirunnerEmbedError(
				`AIRunner embeddings returned HTTP 200 with a non-JSON/unparseable body: ${excerpt(rawBody || "(empty)")}`,
			)
		}

		if (!Array.isArray(data?.embeddings) || data.embeddings.length !== texts.length) {
			const n = Array.isArray(data?.embeddings) ? data.embeddings.length : 0
			throw new AirunnerEmbedError(
				`AIRunner embeddings response contained ${n} embeddings for ${texts.length} inputs. ` +
					`Raw body: ${excerpt(rawBody || "(empty)")}`,
			)
		}

		// Validate every entry is a numeric array — garbage here would silently
		// poison the index (dimension is whatever the model returns, so the
		// per-vector length must at least be self-consistent).
		const embeddings: number[][] = []
		let promptTokens = 0
		for (const item of data.embeddings) {
			if (!Array.isArray(item) || item.some((v) => typeof v !== "number")) {
				throw new AirunnerEmbedError(
					`AIRunner embeddings response contained a non-numeric embedding vector. Raw body: ${excerpt(rawBody)}`,
				)
			}
			embeddings.push(item as number[])
			promptTokens += (item as number[]).length
		}

		// No usage/cost to report for a fully local call — promptTokens is
		// approximate (vector length, not true token count) and only used for
		// display; totalTokens mirrors it so accounting call sites never see
		// NaN/undefined.
		return { embeddings, model: this.model, promptTokens, totalTokens: promptTokens }
	}
}

/** Truncate a raw body to a bounded excerpt for error messages. */
function excerpt(body: string): string {
	return body.length > 500 ? `${body.slice(0, 500)}…` : body
}
