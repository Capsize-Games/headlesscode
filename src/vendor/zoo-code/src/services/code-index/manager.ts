/**
 * SHIM — replaces zoo-code/src/services/code-index/manager.ts.
 *
 * The real CodeIndexManager maintains an embedded codebase-search index. The
 * vendored `core/prompts/system.ts` only calls its `getInstance()` factory for
 * initialization side effects; the returned instance is unused by the prompt
 * builder. Codebase search execution is out of scope for Phase 1.
 */

export class CodeIndexManager {
	private static instance: CodeIndexManager | null = null

	static getInstance(_context: unknown, _cwd: string): CodeIndexManager {
		if (!CodeIndexManager.instance) {
			CodeIndexManager.instance = new CodeIndexManager()
		}
		return CodeIndexManager.instance
	}
}
