/**
 * Phase 5 — GitHub issue watcher — public exports.
 *
 * The watcher polls a target label on a GitHub repo, fans each newly-seen
 * issue out into a batch (splitIssues -> spawn via the existing bash
 * spawner), and tracks idempotency durably in a state file so a restart
 * never double-spawns. See docs/phase5-issue-watcher.md.
 */

export {
	watchIssues,
	defaultSpawn,
	DEFAULT_POLL_INTERVAL_MS,
	DEFAULT_MAX_PER_SWEEP,
} from "./watch.js"
export type {
	WatcherConfig,
	WatcherBatchInfo,
	SpawnBatch,
	SpawnResult,
	SweepResult,
	WatchResult,
} from "./watch.js"

export {
	loadWatcherState,
	loadWatcherStateSync,
	saveWatcherState,
	saveWatcherStateSync,
	markProcessed,
	isProcessed,
	defaultWatcherState,
} from "./state.js"
export type { WatcherIssueEntry, WatcherIssueStatus, WatcherState } from "./state.js"

export {
	ghApi,
	buildGhUrl,
	listIssues,
	getIssue,
	addLabel,
	createGhClient,
	toIssue,
	GhApiError,
	DEFAULT_GH_BASE_URL,
	GH_API_VERSION,
	ISSUES_PAGE_SIZE,
	DEFAULT_MAX_ISSUES,
} from "./github.js"
export type {
	GhClient,
	GhClientOptions,
	GhRequestOptions,
	GitHubIssue,
	ListIssuesOptions,
} from "./github.js"

export { watchMain, parseWatchArgs } from "./cli.js"
export type { WatchCliOptions } from "./cli.js"
