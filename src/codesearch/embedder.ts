/**
 * Cloud (OpenRouter) embedder for the codebase index.
 *
 * SEPARATE from the Phase 3 memory embedder (src/memory/embed.ts,
 * `createLocalEmbedder`) — that one is a deliberately cheap deterministic
 * hash stand-in for handful-of-records recall. This one embeds whole-repo
 * source chunks with a real cloud model and reports real token usage into the
 * budget (src/budget/cost.ts).
 *
 * ─── OpenRouter embeddings — verified findings (2026-08-01) ─────────────────
 *
 * This section is load-bearing: the project owner needs to know exactly what
 * was verified before building on it, because OpenRouter's embeddings story
 * is (as of this date) NOT what a reader might assume.
 *
 * 1. MODEL AVAILABILITY: Embedding models are NOT listed in OpenRouter's
 *    public `/api/v1/models` catalog (337 models returned, zero embedding
 *    ids, zero embedding-modality entries — verified live against a real
 *    API key on 2026-08-01). They are also absent from `/api/v1/models?q=`
 *    and from the single-model `/api/v1/models/:id` endpoint (404). The
 *    embeddings endpoint itself is LIVE, however: POST /api/v1/embeddings
 *    returns proper 4xx errors for bad models, and real embeddings for the
 *    few ids the platform currently serves.
 * 2. MODELS THAT ACTUALLY WORK (probed live, real API key, 2026-08-01):
 *    - `google/gemini-embedding-001`  → 3072 dims, works.
 *    - `qwen/qwen3-embedding-4b`      → 2560 dims, works (Qwen3-Embedding-4B).
 *    - `qwen/qwen3-embedding-8b`      → engine overloaded at probe time (the
 *      model exists; the endpoint was just busy).
 *    Models that FAILED live: `qwen/qwen3-embedding-0.6b` (no endpoints),
 *    `openai/text-embedding-3-small`/`-large` (guardrail/data-policy 404),
 *    `google/gemini-embedding-002` / `google/text-embedding-004` (do not
 *      exist), `mistralai/mistral-embed-2312` / `mistralai/codestral-embed-
 *      2505` (no allowed providers on this account), `google/gemini-
 *      embedding-001:free` (no free endpoints).
 * 3. PRICING: OpenRouter's response `usage` object includes `cost` (USD) and
 *    `cost_details`, but NOT the model's price-per-token. `qwen/qwen3-
 *    embedding-4b` responded with `cost: 0` and `is_byok: true` (a BYOK
 *    routed endpoint — the account's own provider key, costed at $0 through
 *    OpenRouter). `google/gemini-embedding-001` responded with real cost
 *    (~$0.00000015/token → $0.15/1M). Because embedding models are hidden
 *    from the catalog, their published OpenRouter list prices could NOT be
 *    read from the API on this date, and the doc page is a client-rendered
 *    app (no server-rendered content to scrape). We therefore price
 *    `qwen/qwen3-embedding-4b` conservatively at the same per-token rate as
 *    Google's embedding (input-only, $0.15/1M — see src/budget/cost.ts) and
 *    treat OpenRouter's own `usage.cost` as advisory only.
 * 4. BATCHING: confirmed live — N inputs in one request → N embeddings, one
 *    HTTP call, `usage.prompt_tokens` summed across all inputs. Embedding an
 *    entire repo's changed chunks is therefore ONE request per model-context
 *    budget, not one request per chunk.
 * 5. DIMENSIONS: `qwen/qwen3-embedding-4b` = 2560, `google/gemini-
 *    embedding-001` = 3072. Vectors are stored as plain JSON number arrays in
 *    the index; dimension is whatever the model returns, and cosine similarity
 *    is computed over whatever length comes back, so no fixed-dimension
 *    constraint needs to be hard-coded.
 *
 * The chosen default model is `qwen/qwen3-embedding-4b` (open weights, no
 * data-policy guardrail restriction on this account, 2560 dims — a solid
 * quality/size/cost balance for code search). It is overridable via
 * `HEADLESSCODE_EMBEDDING_MODEL` (or the constructor option).
 */

import { OpenRouterClient } from "../llm/openrouter.js"

/** Default embedding model (see header comment for verification notes). */
export const DEFAULT_EMBEDDING_MODEL = "qwen/qwen3-embedding-4b"

/** Env var that overrides the embedding model. */
export const EMBEDDING_MODEL_ENV = "HEADLESSCODE_EMBEDDING_MODEL"

/** Embedding batch size (chunks per request). Kept modest for retry granularity. */
export const EMBED_BATCH_SIZE = 128

/** Max tokens per chunk before we refuse to embed it (4 chars/token heuristic). */
export const MAX_CHUNK_CHARS = 8_000

/** How many consecutive 429/overloaded responses before giving up. */
const MAX_RETRIES = 3
const INITIAL_RETRY_DELAY_MS = 500

/** Resolve the embedding model: constructor option → env → default. */
export function resolveEmbeddingModel(env: NodeJS.ProcessEnv = process.env, override?: string): string {
	return override?.trim() || env[EMBEDDING_MODEL_ENV]?.trim() || DEFAULT_EMBEDDING_MODEL
}

/** The embedder interface the index build + tool handler depend on. */
export interface Embedder {
	/** Model id used for embedding (for pricing/usage accounting). */
	readonly model: string
	/**
	 * Embed a batch of text chunks. Returns one vector per input, in order,
	 * plus the real token usage (for budget accounting).
	 */
	embedBatch(texts: string[]): Promise<{ embeddings: number[][]; promptTokens: number; totalTokens: number }>
}

/** Result of one embedder batch, including model + cost info for accounting. */
export interface EmbedResult {
	embeddings: number[][]
	model: string
	promptTokens: number
	totalTokens: number
}

/**
 * OpenRouter-backed embedder. Batches chunks (one HTTP call per batch), retries
 * transient failures with backoff, and returns real usage for budget feeding.
 */
export class OpenRouterEmbedder implements Embedder {
	private readonly client: OpenRouterClient

	constructor(
		readonly model: string = resolveEmbeddingModel(),
		client?: OpenRouterClient,
	) {
		this.client = client ?? new OpenRouterClient()
	}

	async embedBatch(texts: string[]): Promise<EmbedResult> {
		if (texts.length === 0) {
			return { embeddings: [], model: this.model, promptTokens: 0, totalTokens: 0 }
		}

		const embeddings: number[][] = []
		let promptTokens = 0
		let totalTokens = 0

		for (let i = 0; i < texts.length; i += EMBED_BATCH_SIZE) {
			const batch = texts.slice(i, i + EMBED_BATCH_SIZE)
			let attempt = 0
			let lastError: unknown
			while (attempt < MAX_RETRIES) {
				try {
					const result = await this.client.embed(batch, this.model)
					embeddings.push(...result.embeddings)
					promptTokens += result.promptTokens
					totalTokens += result.totalTokens
					lastError = undefined
					break
				} catch (err) {
					lastError = err
					const status =
						err instanceof Error && "status" in err ? (err as { status?: number }).status : undefined
					const isTransient = status === 429 || status === 502 || status === 503
					if (!isTransient || attempt >= MAX_RETRIES - 1) {
						throw err
					}
					await new Promise((r) => setTimeout(r, INITIAL_RETRY_DELAY_MS * 2 ** attempt))
					attempt++
				}
			}
			if (lastError) {
				throw lastError
			}
		}

		return { embeddings, model: this.model, promptTokens, totalTokens }
	}
}

/**
 * Compute cosine similarity between two vectors. Handles different lengths by
 * treating missing entries as 0 (index entries are all the same model's
 * dimension in practice, but a mixed old/new index should not crash).
 */
export function cosineSimilarity(a: number[], b: number[]): number {
	let dot = 0
	let normA = 0
	let normB = 0
	const len = Math.max(a.length, b.length)
	for (let i = 0; i < len; i++) {
		const av = a[i] ?? 0
		const bv = b[i] ?? 0
		dot += av * bv
		normA += av * av
		normB += bv * bv
	}
	if (normA === 0 || normB === 0) {
		return 0
	}
	return dot / (Math.sqrt(normA) * Math.sqrt(normB))
}
