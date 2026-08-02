/**
 * Phase 2 orchestration layer — public exports.
 *
 * Replaces the airunner GUI orchestration (xdotool inject + wmctrl wake-up)
 * with headless harness subprocesses, reusing the issue-splitting heuristics
 * and the reviewer checklist from the airunner repo.
 */

export { splitIssues } from "./split.js"
export type { SplitIssue, WorktreeSpec } from "./split.js"

export { loadState, loadStateSync, saveState, saveStateSync, updateGroup, defaultState } from "./state.js"
export type { OrchestratorGroup, OrchestratorState } from "./state.js"

export { runReview, parseReviewResult, reviewTools, HARNESS_ROOT, DEFAULT_REVIEW_PROMPT_PATH } from "./reviewer.js"
export type { ReviewOptions, ReviewResult } from "./reviewer.js"

export { watchGroups, inspectGroup, tailLog, groupWorktreePath, DEFAULT_POLL_INTERVAL_MS, DEFAULT_STALL_TIMEOUT_MS } from "./watch.js"
export type { WatchOptions, WatchSummary } from "./watch.js"

export {
	buildStatusSummary,
	formatStatusText,
	verdictLine,
	waitForTerminalState,
	isTerminalStatus,
	TERMINAL_STATUSES,
	DEFAULT_STATUS_POLL_INTERVAL_MS,
	DEFAULT_STATUS_TIMEOUT_MS,
} from "./status.js"
export type { StatusSummary, StatusCounts, StatusGroupRow, WaitForTerminalOptions, WaitForTerminalResult } from "./status.js"
