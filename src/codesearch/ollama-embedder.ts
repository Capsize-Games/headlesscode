/**
 * Local Ollama embedder for the codebase index.
 *
 * An alternative backend to the OpenRouter embedder (src/codesearch/embedder.ts)
 * for environments where Ollama runs locally with an embedding model pulled
 * (the project owner's machine: `qwen3-embedding:8b` on an RTX 5080). Opt-in
 * via `HEADLESSCODE_EMBEDDING_BACKEND=ollama` or `--embedding-backend ollama`
 * on `headlesscode index`; the default stays OpenRouter, because hosted/headless
 * workers don't have a local GPU.
 *
 * ─── Ollama embeddings — verified findings (2026-08-01, real local calls) ──
 *
 * 1. ENDPOINT + BATCHING: POST {OLLAMA_URL}/api/embed accepts an ARRAY of
 *    inputs in one call — `{"model": "...", "input": ["a", "b", ...]}` returns
 *    `embeddings: [vector, vector, ...]` in input order, one HTTP call (verified
 *    live: 2 inputs → 2 vectors in one response). The older
 *    POST /api/embeddings endpoint takes ONE `prompt` per call and returns
 *    `{embedding: [...]}` (also verified live). We use the batch `/api/embed`
 *    endpoint — same one-request-per-batch property as OpenRouter's
 *    /api/v1/embeddings.
 * 2. RESPONSE SHAPE: `{ model, embeddings: number[][], total_duration,
 *    load_duration, prompt_eval_count, ... }`. The embeddings are plain JSON
 *    number arrays; `prompt_eval_count` is the total prompt tokens across all
 *    inputs (verified: a 2-input call reported 6 = 2 + 4). There is NO
 *    `usage` object and no cost — the call is free and fully local, so we do
 *    NOT feed the budget/cost path (src/budget/cost.ts) for this backend.
 * 3. DIMENSION: `qwen3-embedding:8b` returns 4096-dim vectors (measured live),
 *    vs 2560 for `qwen/qwen3-embedding-4b` (OpenRouter) — NOT interchangeable.
 *    An index built with one backend is unusable for search with the other,
 *    so the index build records `{backend, model}` metadata and the
 *    `codebase_search` tool refuses a backend mismatch with a clear error
 *    (see src/codesearch/index.ts + the executor handler).
 * 4. COLD vs WARM LATENCY: a cold call (model freshly loaded into VRAM)
 *    measures ~48ms load + ~40ms eval for one short input (~130ms wall);
 *    warm calls drop the load duration to ~0 and run at roughly
 *    ~14ms/input in a batch of 16 and ~13ms/input in a batch of 64
 *    (verified live). The 8B model stays loaded after the first call
 *    (default keep_alive), so a large first-time index build can batch
 *    aggressively (the same 128-chunk batch size as the cloud path) —
 *    the per-batch cost is wall-clock only, and there is no spend to
 *    control.
 *
 * The embedder interface (Embedder) is shared with the OpenRouter path; only
 * the HTTP client differs. No batching/hashing logic is duplicated here — the
 * caller (src/codesearch/index.ts buildIndex) slices batches exactly as it
 * does for the cloud path.
 */

import type { EmbedResult } from "./embedder.js"

/** Default Ollama server base URL (Ollama's standard local port). */
export const DEFAULT_OLLAMA_URL = "http://localhost:11434"

/** Default local embedding model (the one the project owner has pulled). */
export const DEFAULT_OLLAMA_EMBEDDING_MODEL = "qwen3-embedding:8b"

/** Env var that overrides the Ollama server URL. */
export const OLLAMA_URL_ENV = "HEADLESSCODE_OLLAMA_URL"

/** Env var that overrides the local embedding model name. */
export const OLLAMA_EMBEDDING_MODEL_ENV = "HEADLESSCODE_OLLAMA_EMBEDDING_MODEL"

/** Resolve the Ollama URL: env override → default. */
export function resolveOllamaUrl(env: NodeJS.ProcessEnv = process.env): string {
	return env[OLLAMA_URL_ENV]?.trim() || DEFAULT_OLLAMA_URL
}

/** Resolve the local embedding model: env override → default. */
export function resolveOllamaEmbeddingModel(env: NodeJS.ProcessEnv = process.env): string {
	return env[OLLAMA_EMBEDDING_MODEL_ENV]?.trim() || DEFAULT_OLLAMA_EMBEDDING_MODEL
}

/** Typed error for Ollama failures, carrying a pre-built actionable message. */
export class OllamaEmbedError extends Error {
	/** HTTP status when Ollama answered (undefined for network-level failures). */
	readonly status?: number
	/** The raw error body Ollama returned, when one exists. */
	readonly body?: string

	constructor(message: string, status?: number, body?: string) {
		super(message)
		this.name = "OllamaEmbedError"
		this.status = status
		this.body = body
	}
}

/** Distinguish Ollama's "model not found" error from everything else. */
const MODEL_NOT_FOUND_RE = /not found|pull/i

/**
 * Ollama-backed embedder. One HTTP call per batch (POST /api/embed), matching
 * the OpenRouter path's batching. Failures are wrapped in actionable errors —
 * never a silent fallback to the cloud backend (that would surprise the user
 * with unexpected spend).
 */
export class OllamaEmbedder {
	readonly backend = "ollama" as const
	readonly model: string
	private readonly baseUrl: string

	constructor(model: string = resolveOllamaEmbeddingModel(), baseUrl: string = resolveOllamaUrl()) {
		this.model = model
		this.baseUrl = baseUrl.replace(/\/+$/, "")
	}

	async embedBatch(texts: string[]): Promise<EmbedResult> {
		if (texts.length === 0) {
			return { embeddings: [], model: this.model, promptTokens: 0, totalTokens: 0 }
		}

		// Same guard as OpenRouterEmbedder: empty inputs are rejected upstream
		// and produce no useful vector anyway.
		const emptyIndex = texts.findIndex((t) => t.trim() === "")
		if (emptyIndex !== -1) {
			throw new OllamaEmbedError(`cannot embed empty/whitespace-only input at index ${emptyIndex} — providers reject it`)
		}

		const url = `${this.baseUrl}/api/embed`
		let response: Response
		try {
			response = await fetch(url, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ model: this.model, input: texts }),
			})
		} catch (err) {
			// Network-level failure (connection refused, DNS, ...) — Ollama is
			// either not running or unreachable. Actionable, not generic.
			throw new OllamaEmbedError(
				`Ollama backend selected but ${this.baseUrl} is unreachable — is \`ollama serve\` running? ` +
					`(or set HEADLESSCODE_OLLAMA_URL if Ollama listens elsewhere): ` +
					`${err instanceof Error ? err.message : String(err)}`,
			)
		}

		const rawBody = await response.text().catch(() => "")
		if (!response.ok) {
			// Ollama answers HTTP 400/404 with `{"error": "model \"...\" not found,
			// try pulling it first"}` for a missing model — surface that
			// specifically, since it's the second most common misconfiguration.
			if (MODEL_NOT_FOUND_RE.test(rawBody)) {
				throw new OllamaEmbedError(
					`Ollama backend selected but model "${this.model}" is not pulled — run ` +
						`\`ollama pull ${this.model}\``,
					response.status,
					excerpt(rawBody),
				)
			}
			throw new OllamaEmbedError(
				`Ollama embeddings returned HTTP ${response.status}: ${excerpt(rawBody || "(empty body)")}`,
				response.status,
				excerpt(rawBody),
			)
		}

		let data:
			| {
					embeddings?: unknown
					error?: { message?: string }
			  }
			| undefined
		try {
			data = JSON.parse(rawBody)
		} catch {
			throw new OllamaEmbedError(
				`Ollama embeddings returned HTTP 200 with a non-JSON/unparseable body: ${excerpt(rawBody || "(empty)")}`,
			)
		}

		if (!Array.isArray(data?.embeddings) || data.embeddings.length !== texts.length) {
			const n = Array.isArray(data?.embeddings) ? data.embeddings.length : 0
			throw new OllamaEmbedError(
				`Ollama embeddings response contained ${n} embeddings for ${texts.length} inputs. ` +
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
				throw new OllamaEmbedError(
					`Ollama embeddings response contained a non-numeric embedding vector. Raw body: ${excerpt(rawBody)}`,
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
