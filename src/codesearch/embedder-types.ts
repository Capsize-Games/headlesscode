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
