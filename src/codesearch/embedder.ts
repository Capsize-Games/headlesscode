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
 * The chosen default model is `qwen/qwen3-embedding-8b` (the 4b→8b switch is
 * documented below; 2560+ dims — a solid quality/size/cost balance for code
 * search), pinned to the DeepInfra provider (see DEFAULT_EMBEDDING_PROVIDER).
 * Both the model and the pin are overridable per machine via the central
 * store's settings.json (src/project-store.ts) and per build via
 * `HEADLESSCODE_EMBEDDING_MODEL` (or the constructor option).
 */

import { OpenRouterClient } from "../llm/openrouter.js"
import { loadCentralSettings, type CentralSettings } from "../project-store.js"
import { AirunnerEmbedder, resolveAirunnerEmbeddingModel, resolveAirunnerUrl } from "./airunner-embedder.js"
import {
	DEFAULT_OLLAMA_EMBEDDING_MODEL,
	DEFAULT_OLLAMA_URL,
	OLLAMA_EMBEDDING_MODEL_ENV,
	OLLAMA_URL_ENV,
	OllamaEmbedder,
	resolveOllamaEmbeddingModel,
	resolveOllamaUrl,
} from "./ollama-embedder.js"

/**
 * Default embedding model (see header comment for verification notes).
 * The 8b variant (not 4b) — matching airunner's own working setup
 * (projects/uwuchat/server/embedding_provider.py): chosen there for zero data
 * retention + lower cost. The default is overridable per machine via the
 * central store's settings.json (`embedding.model` — see src/project-store.ts)
 * and per build via $HEADLESSCODE_EMBEDDING_MODEL / --model.
 */
export const DEFAULT_EMBEDDING_MODEL = "qwen/qwen3-embedding-8b"

/** Env var that overrides the embedding model. */
export const EMBEDDING_MODEL_ENV = "HEADLESSCODE_EMBEDDING_MODEL"

/** Embedding backends (the codebase index build + query can pick between). */
export const EMBEDDING_BACKENDS = ["openrouter", "ollama", "airunner"] as const

/** Default backend — OpenRouter, matching the pre-existing behavior. */
export const DEFAULT_EMBEDDING_BACKEND = "openrouter"

/** Env var that selects the backend (`openrouter` | `ollama` | `airunner`). */
export const EMBEDDING_BACKEND_ENV = "HEADLESSCODE_EMBEDDING_BACKEND"

/** Env var that overrides the OpenRouter embedding model. */
export const OPENROUTER_EMBEDDING_MODEL_ENV = "HEADLESSCODE_OPENROUTER_EMBEDDING_MODEL"

/**
 * Default OpenRouter provider pin for embedding requests, matching airunner's
 * working setup (projects/uwuchat/server/embedding_provider.py): DeepInfra,
 * zero data retention, no fallbacks. Verified live 2026-08-04 against
 * OpenRouter's `/api/v1/models/<id>/endpoints` that the provider slug casing
 * is exactly `"DeepInfra"` (capital D/I). Overridable per machine via the
 * central store's settings.json (`embedding.provider` /
 * `embedding.allowFallbacks` — see src/project-store.ts).
 */
export const DEFAULT_EMBEDDING_PROVIDER = "DeepInfra"
export const DEFAULT_EMBEDDING_ALLOW_FALLBACKS = false

/** The backend an index was built with (recorded per entry + in metadata). */
export type EmbeddingBackend = (typeof EMBEDDING_BACKENDS)[number]

/**
 * Resolve the embedding backend: explicit override → env → default. The
 * default is deliberately `openrouter` (opt-in for Ollama), because hosted/
 * headless workers have no local GPU — see plans/local-embeddings-ollama.md.
 */
export function resolveEmbeddingBackend(env: NodeJS.ProcessEnv = process.env, override?: string): EmbeddingBackend {
	const raw = (override?.trim() || env[EMBEDDING_BACKEND_ENV]?.trim() || DEFAULT_EMBEDDING_BACKEND).toLowerCase()
	if (raw === "ollama" || raw === "openrouter" || raw === "airunner") {
		return raw
	}
	throw new Error(
		`Invalid embedding backend "${raw}" (from ${EMBEDDING_BACKEND_ENV} or --embedding-backend): expected "openrouter", "ollama", or "airunner"`,
	)
}

/** Embedding batch size (chunks per request). Kept modest for retry granularity. */
export const EMBED_BATCH_SIZE = 128

/** Max tokens per chunk before we refuse to embed it (4 chars/token heuristic). */
export const MAX_CHUNK_CHARS = 8_000

/** How many consecutive 429/overloaded responses before giving up. */
const MAX_RETRIES = 3
const INITIAL_RETRY_DELAY_MS = 500

/**
 * Resolve the embedding model: constructor option → env → central settings →
 * built-in default. The central settings default (src/project-store.ts's
 * settings.json `embedding.model`) is the per-machine override knob so the
 * 8b default is not hardcoded in application code with no way to change it.
 */
export function resolveEmbeddingModel(env: NodeJS.ProcessEnv = process.env, override?: string): string {
	const settings = loadCentralSettings()
	return (
		override?.trim() ||
		env[EMBEDDING_MODEL_ENV]?.trim() ||
		settings.embedding?.model?.trim() ||
		DEFAULT_EMBEDDING_MODEL
	)
}

/**
 * Resolve the OpenRouter provider pin for embedding requests: central settings
 * → built-in default. Returns undefined only when settings explicitly disable
 * pinning (allowFallbacks without a provider is treated as no pin).
 */
export function resolveEmbeddingProvider(settings: CentralSettings = loadCentralSettings()): {
	order?: string[]
	allowFallbacks?: boolean
} | undefined {
	const provider = settings.embedding?.provider?.trim()
	if (!provider) {
		return { order: [DEFAULT_EMBEDDING_PROVIDER], allowFallbacks: DEFAULT_EMBEDDING_ALLOW_FALLBACKS }
	}
	return {
		order: [provider],
		...(typeof settings.embedding?.allowFallbacks === "boolean"
			? { allowFallbacks: settings.embedding.allowFallbacks }
			: { allowFallbacks: DEFAULT_EMBEDDING_ALLOW_FALLBACKS }),
	}
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

/** Name of the backend field on the index metadata block (shared with index.ts/types.ts). */
export const METADATA_BACKEND_KEY = "backend" as const

/** Name of the model field on the index metadata block (shared with index.ts/types.ts). */
export const METADATA_MODEL_KEY = "model" as const

/**
 * Create the embedder for a backend, defaulting to `openrouter`. The
 * OpenRouter model resolves from the constructor option → env → default; the
 * Ollama model/URL from their own env vars (or constructor options).
 */
export function createEmbedder(
	backend?: EmbeddingBackend,
	options: {
		/** OpenRouter embedding model override (--model / HEADLESSCODE_OPENROUTER_EMBEDDING_MODEL). */
		model?: string
		/** Ollama embedding model override (HEADLESSCODE_OLLAMA_EMBEDDING_MODEL). */
		ollamaModel?: string
		/** Ollama server URL override (HEADLESSCODE_OLLAMA_URL). */
		ollamaUrl?: string
		/** AIRunner embedding model override (HEADLESSCODE_AIRUNNER_EMBED_MODEL). */
		airunnerModel?: string
		/** AIRunner server URL override (HEADLESSCODE_AIRUNNER_EMBED_URL). */
		airunnerUrl?: string
	} = {},
	env: NodeJS.ProcessEnv = process.env,
): Embedder {
	const resolved = resolveEmbeddingBackend(env, backend)
	if (resolved === "ollama") {
		return new OllamaEmbedder(options.ollamaModel ?? resolveOllamaEmbeddingModel(env), options.ollamaUrl ?? resolveOllamaUrl(env))
	}
	if (resolved === "airunner") {
		return new AirunnerEmbedder(
			options.airunnerModel ?? resolveAirunnerEmbeddingModel(env),
			options.airunnerUrl ?? resolveAirunnerUrl(env),
		)
	}
	return new OpenRouterEmbedder(
		options.model ?? env[OPENROUTER_EMBEDDING_MODEL_ENV] ?? resolveEmbeddingModel(env),
		undefined,
		resolveEmbeddingProvider(),
	)
}

/**
 * OpenRouter-backed embedder. Batches chunks (one HTTP call per batch), retries
 * transient failures with backoff, and returns real usage for budget feeding.
 */
export class OpenRouterEmbedder implements Embedder {
	private readonly client: OpenRouterClient
	private readonly provider: { order?: string[]; allowFallbacks?: boolean } | undefined

	constructor(
		readonly model: string = resolveEmbeddingModel(),
		client?: OpenRouterClient,
		provider: { order?: string[]; allowFallbacks?: boolean } | undefined = resolveEmbeddingProvider(),
	) {
		this.client = client ?? new OpenRouterClient()
		this.provider = provider
	}

	async embedBatch(texts: string[]): Promise<EmbedResult> {
		if (texts.length === 0) {
			return { embeddings: [], model: this.model, promptTokens: 0, totalTokens: 0 }
		}

		// Defensive: embedding providers reject empty strings outright (live
		// crash 2026-08-16 — OpenRouter HTTP 400 "too_small"). buildIndex
		// filters these before calling, but any other caller must get a clear
		// diagnostic here, not a cryptic 400 from upstream.
		const emptyIndex = texts.findIndex((t) => t.trim() === "")
		if (emptyIndex !== -1) {
			throw new Error(`embedder: cannot embed empty/whitespace-only input at index ${emptyIndex} — providers reject it`)
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
					const result = await this.client.embed(batch, this.model, { provider: this.provider })
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
