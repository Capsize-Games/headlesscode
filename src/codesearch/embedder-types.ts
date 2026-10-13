/**
 * Embedder leaf types (issue #128).
 *
 * Embedder/EmbedResult lived in src/codesearch/embedder.ts, which the Ollama
 * and AIRunner backends need only as types — pulling the whole factory back
 * in and closing import cycles (the architecture checker counts even
 * type-only edges). This leaf has no imports, so the factory and both
 * backends can share the contracts cycle-free; embedder.ts re-exports them.
 */

/** The embedder interface the index build + tool handler depend on. */
export interface Embedder {
	/** Model id used for embedding (for pricing/usage accounting). */
	readonly model: string
	/**
	 * Embed a batch of text chunks. Returns one vector per input, in order,
	 * plus the real token usage (for budget accounting).
	 */
	embedBatch(texts: string[]): Promise<{
		embeddings: number[][]
		promptTokens: number
		totalTokens: number
	}>
}

/** Result of one embedder batch, including model + cost info for accounting. */
export interface EmbedResult {
	embeddings: number[][]
	model: string
	promptTokens: number
	totalTokens: number
}

/** Truncate a raw body to a bounded excerpt for error messages. */
export function excerpt(body: string): string {
	return body.length > 500 ? `${body.slice(0, 500)}…` : body
}

/**
 * Validate a local embedder's raw vectors: every entry must be a numeric
 * array. Shared by the Ollama/AIRunner backends (their loops were an exact
 * clone) so garbage never silently poisons the index.
 */
export function validateLocalVectors(
	vectors: unknown[],
	rawBody: string,
	label: string,
	makeError: (message: string) => Error,
): { embeddings: number[][]; promptTokens: number } {
	const embeddings: number[][] = []
	let promptTokens = 0
	for (const item of vectors) {
		if (!Array.isArray(item) || item.some((v) => typeof v !== "number")) {
			throw makeError(
				`${label} embeddings response contained a non-numeric embedding vector. Raw body: ${excerpt(rawBody)}`,
			)
		}
		embeddings.push(item as number[])
		promptTokens += (item as number[]).length
	}
	return { embeddings, promptTokens }
}
