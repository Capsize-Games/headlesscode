/**
 * Phase 3 memory subsystem — public API boundary.
 *
 * Re-exports the memory contracts, the fully working local backend, the local
 * embedder, the deterministic summarizer, and the UwUChat client stub so
 * callers (HeadlessSession, the CLI, and future consumers) depend on this
 * module — never on file paths into `src/memory/`.
 */

export * from "./types.js"
export { LocalMemoryStore, sanitizeProject, type LocalMemoryStoreOptions } from "./local.js"
export { createLocalEmbedder, cosine, similarity, fnv1a, tokenize } from "./embed.js"
export {
	extractSessionSummary,
	extractFacts,
	buildRollingSummary,
	classifyLine,
	NoopSummarizer,
	type SummarizeWithLlm,
	type ExtractSummaryOptions,
} from "./summarizer.js"
export { UwUChatMemoryStore, UwUChatMemoryError, API_PREFIX, type UwUChatMemoryOptions } from "./uwuchat.js"
