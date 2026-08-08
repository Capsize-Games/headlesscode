/**
 * Auto-index: a throttled, non-fatal, skippable refresh of the codebase-search
 * index at session/round start (plans/auto-index-on-session-start.md, issue #58).
 *
 * `codebase_search` needs a pre-built index, and in practice nobody runs the
 * manual `headlesscode index` step routinely — rounds were found running with
 * the index missing entirely or days stale, which silently degraded workers to
 * grep-via-execute_command for whole sessions. The fix is to refresh the index
 * automatically at the two moments a NEW unit of work starts:
 *
 *   1. Orchestrator round start (src/orchestrator/cli.ts) — ONCE, against the
 *      main checkout, BEFORE any worktree is spawned. Every git worktree of a
 *      repo collapses onto the SAME central index (src/project-store.ts), so
 *      this must run once centrally, not once per worker — concurrent per-
 *      worktree builds would race on the shared index file.
 *   2. Bare `headlesscode` CLI session start (src/cli.ts) — the non-
 *      orchestrated, single-workspace case. One process, one workspace, no
 *      concurrency concern.
 *
 * Spawned workers/reviewers/QA (run-worker.sh / run-qa.sh) set
 * HEADLESSCODE_SKIP_AUTO_INDEX=1: the round-start refresh already covered
 * them, and a mid-round re-index (e.g. a continuation re-spawn) would
 * reintroduce the exact per-worktree race this design avoids.
 *
 * The refresh itself is safe to run often because the index build is
 * INCREMENTAL (src/codesearch/index.ts): a no-op refresh (nothing changed
 * since the last build) costs zero embedding calls — only the file-walk +
 * hash pass — so "always run it at round start" is viable, not reckless.
 *
 * The three properties that keep this from ever blocking or failing the thing
 * it helps (matching this codebase's auxiliary-subsystem idiom — checkpoints,
 * condensation, handoff):
 *
 *   - NON-FATAL: any failure (no API key, network, embedder error) is caught,
 *     logged as a WARN with the real error message, and the round/session
 *     proceeds with whatever index exists (or none).
 *   - THROTTLED: the index metadata records when it was last built
 *     (`lastBuiltAt`); if that was within
 *     $HEADLESSCODE_AUTO_INDEX_MIN_INTERVAL_MS (default 15 minutes) the
 *     walk+hash pass is skipped entirely and the skip is logged at INFO.
 *   - SKIPPABLE: --skip-auto-index (orchestrate + bare CLI) and
 *     $HEADLESSCODE_SKIP_AUTO_INDEX=1 disable it completely — no stale check
 *     either — so a CI/test environment with no API key turns it off cleanly
 *     instead of eating a warning every run.
 */

import {
	buildIndex,
	indexFilePath,
	loadIndexMetadata,
	type IndexBuildResult,
} from "./codesearch/index.js"
import {
	createEmbedder,
	resolveEmbeddingBackend,
	type Embedder,
	type EmbeddingBackend,
} from "./codesearch/embedder.js"
import { estimateCost, priceFor } from "./budget/cost.js"

/** Env var that disables auto-index entirely (no stale check, no walk). */
export const AUTO_INDEX_SKIP_ENV = "HEADLESSCODE_SKIP_AUTO_INDEX"

/** Env var for the minimum interval between auto-refreshes (ms). */
export const AUTO_INDEX_MIN_INTERVAL_ENV = "HEADLESSCODE_AUTO_INDEX_MIN_INTERVAL_MS"

/** Default minimum interval between auto-refreshes (15 minutes). */
export const DEFAULT_AUTO_INDEX_MIN_INTERVAL_MS = 15 * 60 * 1000

export interface AutoIndexOptions {
	/** INFO-line sink (default: process.stdout.write). */
	log?: (msg: string) => void
	/** WARN-line sink (default: process.stderr.write). */
	warn?: (msg: string) => void
	/** Explicit skip (the --skip-auto-index flag). */
	skip?: boolean
	/** Test seam: inject an embedder (bypasses createEmbedder). */
	embedder?: Embedder
	/** Backend override (default: resolveEmbeddingBackend(env)). */
	backend?: EmbeddingBackend
	/** Min-interval override in ms (0 = never throttled; default: env or 15 min). */
	minIntervalMs?: number
	/** Env to resolve defaults from (default: process.env). */
	env?: NodeJS.ProcessEnv
}

export type AutoIndexOutcome = "disabled" | "throttled" | "refreshed" | "error"

export interface AutoIndexResult {
	/** What happened (informational — every path is non-fatal). */
	outcome: AutoIndexOutcome
	/** The build result when the refresh actually ran. */
	build?: IndexBuildResult
}

/** True when auto-index is disabled via the env var. */
export function autoIndexSkippedByEnv(env: NodeJS.ProcessEnv = process.env): boolean {
	return env[AUTO_INDEX_SKIP_ENV]?.trim() === "1"
}

/** Resolve the min-interval: explicit override → env → default. 0 = never throttled. */
export function resolveAutoIndexMinIntervalMs(
	env: NodeJS.ProcessEnv = process.env,
	override?: number,
): number {
	if (override !== undefined && Number.isFinite(override)) {
		return override < 0 ? 0 : override
	}
	const raw = env[AUTO_INDEX_MIN_INTERVAL_ENV]?.trim()
	if (raw !== undefined && raw !== "") {
		const n = Number(raw)
		if (Number.isFinite(n) && n >= 0) {
			return n
		}
	}
	return DEFAULT_AUTO_INDEX_MIN_INTERVAL_MS
}

/**
 * Refresh the codebase-search index for a workspace if a refresh is due.
 *
 * Never throws and never blocks the caller on index health: every failure
 * path returns an "error"/"disabled"/"throttled" outcome after logging. The
 * caller proceeds regardless (the non-fatal contract — see the header).
 */
export async function refreshIndexIfDue(workspaceRoot: string, options: AutoIndexOptions = {}): Promise<AutoIndexResult> {
	const env = options.env ?? process.env
	const log = options.log ?? ((msg: string): void => { process.stdout.write(msg + "\n") })
	const warn = options.warn ?? ((msg: string): void => { process.stderr.write(msg + "\n") })

	// Skippable: --skip-auto-index or $HEADLESSCODE_SKIP_AUTO_INDEX=1 — not
	// even a stale check (a CI/test env with no API key must be able to turn
	// this off without eating a warning every run).
	if (options.skip || autoIndexSkippedByEnv(env)) {
		log(`[auto-index] skipped (${AUTO_INDEX_SKIP_ENV}=1 or --skip-auto-index)`)
		return { outcome: "disabled" }
	}

	// Throttle: skip the walk+hash pass entirely when the index was built
	// within the min interval (a round-per-minute test loop must not re-walk
	// a 50k-file repo every single time). The timestamp comes from the index
	// metadata, written by EVERY build (manual `headlesscode index` and
	// auto-refresh alike) — a human just building the index manually is the
	// strongest possible "no refresh needed" signal.
	const minIntervalMs = resolveAutoIndexMinIntervalMs(env, options.minIntervalMs)
	if (minIntervalMs > 0) {
		const lastBuiltAt = loadIndexMetadata(workspaceRoot)?.lastBuiltAt
		if (lastBuiltAt !== undefined) {
			const last = Date.parse(lastBuiltAt)
			if (Number.isFinite(last)) {
				const ageMs = Date.now() - last
				if (ageMs >= 0 && ageMs < minIntervalMs) {
					log(
						`[auto-index] skip: index refreshed ${Math.round(ageMs / 1000)}s ago ` +
							`(min interval ${minIntervalMs}ms; ${AUTO_INDEX_MIN_INTERVAL_ENV} to change)`,
					)
					return { outcome: "throttled" }
				}
			}
		}
	}

	// Everything from here on is inside the try: ANY failure (a bad
	// $HEADLESSCODE_EMBEDDING_BACKEND value, createEmbedder, the build, the
	// embedder, a full disk) is a WARN, never an abort — the non-fatal
	// contract.
	try {
		const backend = options.backend ?? resolveEmbeddingBackend(env)
		if (backend === "openrouter" && !env.HEADLESSCODE_OPENROUTER_API_KEY) {
			// The same cheap pre-check `headlesscode index` does — fail before
			// any network call, not after a doomed auth round-trip.
			warn(
				`[auto-index] HEADLESSCODE_OPENROUTER_API_KEY is not set — cannot auto-refresh the codebase index. ` +
					`Run 'headlesscode index --workspace <path>' manually, or set ${AUTO_INDEX_SKIP_ENV}=1 to silence this warning.`,
			)
			return { outcome: "error" }
		}

		const embedder = options.embedder ?? createEmbedder(backend, {}, env)
		const result = await buildIndex(embedder, workspaceRoot, undefined, backend)
		// Cost-visible, not cost-gated: mirror the `headlesscode index` cost
		// line (src/codesearch/cli.ts) so a human watching stdout sees exactly
		// what got spent — the --skip-auto-index opt-out is the cost control.
		const costLine =
			backend === "openrouter"
				? `estimated cost $${estimateCost({ model: result.model, inputTokens: result.promptTokens, outputTokens: 0 }).toFixed(6)} ` +
					`(${result.model} @ $${priceFor(result.model).input}/1M input)`
				: "estimated cost $0.00 (local backend — no cloud spend)"
		log(
			`[auto-index] refreshed: ${result.filesScanned} files scanned, ${result.chunksEmbedded} chunks embedded, ` +
				`${result.chunksSkipped} skipped, ${result.chunksRemoved} removed, ${result.totalChunks} total; ` +
				`index: ${indexFilePath(workspaceRoot)}; ${costLine}`,
		)
		return { outcome: "refreshed", build: result }
	} catch (err) {
		// Non-fatal: the round/session proceeds with whatever index exists (or
		// none) — indexing is an auxiliary subsystem, never load-bearing.
		warn(
			`[auto-index] refresh failed (proceeding with the existing index or none): ` +
				`${err instanceof Error ? err.message : String(err)}`,
		)
		return { outcome: "error" }
	}
}
