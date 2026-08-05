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

export {
	runReview,
	runReviewWithRetries,
	parseReviewResult,
	reviewTools,
	HARNESS_ROOT,
	DEFAULT_REVIEW_PROMPT_PATH,
} from "./reviewer.js"
export type { ReviewOptions, ReviewResult } from "./reviewer.js"

export { analyzeWorktreeSessions, formatAnalysisReport, listSessionIds } from "./log-analysis.js"
export type { SessionLogAnalysis, AnalyzeOptions, ToolErrorSample, StallGap, RepeatedCommand } from "./log-analysis.js"

export { analyzeCliMain, parseAnalyzeArgs } from "./analyze-cli.js"

export {
	costHistoryFilePath,
	appendCostHistoryRecord,
	readCostHistory,
	recordGroupCost,
	sessionCostHistoryFilePath,
	appendSessionCostRecord,
	readSessionCostHistory,
	recordAllSessionCosts,
} from "./cost-history.js"
export type { CostHistoryRecord, SessionCostRecord } from "./cost-history.js"

export { costHistoryCliMain, parseCostHistoryArgs } from "./cost-history-cli.js"

export { watchGroups, inspectGroup, tailLog, groupWorktreePath, isPidAlive, DEFAULT_POLL_INTERVAL_MS, DEFAULT_STALL_TIMEOUT_MS } from "./watch.js"
export type { WatchOptions, WatchSummary } from "./watch.js"

export { checkMergedByAncestor, checkMergedByGitHubPr } from "./merge-check.js"
export type { MergeCheckResult } from "./merge-check.js"

export {
	applyCleanup,
	assessGroupCleanup,
	assessGroupCleanupSync,
	checkGroupMerged,
	cleanupMain,
	parseCleanupArgs,
	planCleanup,
	removeHarnessArtifacts,
	resolveBaseBranch,
	resolveGroupBranch,
	worktreeUncommitted,
} from "./cleanup.js"
export type { CleanupDeps, CleanupPlan, CleanupPlanEntry, CleanupRunResult, CleanupStatus, GhWiring } from "./cleanup.js"

export {
	branchSyncStatus,
	ORCHESTRATE_SYNC_DISABLED_ENV,
	syncBranchWithOrigin,
	syncSummaryLines,
	syncWarningLines,
	TRIVIAL_DRIFT_AHEAD,
} from "./git-sync.js"
export type { BranchSyncResult, BranchSyncStatus } from "./git-sync.js"

export {
	buildStatusSummary,
	formatStatusText,
	reconcileGroups,
	verdictLine,
	waitForTerminalState,
	isTerminalStatus,
	TERMINAL_STATUSES,
	DEFAULT_STATUS_POLL_INTERVAL_MS,
	DEFAULT_STATUS_TIMEOUT_MS,
} from "./status.js"
export type {
	StatusSummary,
	StatusCounts,
	StatusGroupRow,
	WaitForTerminalOptions,
	WaitForTerminalResult,
	ReconcileHooks,
	ReconcileResult,
} from "./status.js"
