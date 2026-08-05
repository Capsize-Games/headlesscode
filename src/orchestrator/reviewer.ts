/**
 * Headless reviewer (Phase 2) — an adversarial fresh-context verification run.
 *
 * The reviewer is a SECOND harness session run against a worker's worktree /
 * branch, with the airunner review-mode checklist
 * (`plans/zoo-code-review-mode-prompt.md`) used as the system prompt
 * (`systemPromptOverride`). It reuses the reviewer's core principles
 * verbatim in spirit:
 *
 *   - fresh context: the reviewer did not write the code and must not give it
 *     benefit of the doubt — a report's output is a claim, not evidence,
 *     until reproduced;
 *   - non-edit discipline: the executor is READ-ONLY (no write_to_file at
 *     all), so the reviewer can inspect, re-run commands (tests, `gh`,
 *     `git diff`) and report — but can never fix anything itself;
 *   - verdict: clean, or findings (which the caller maps to "reopen issue").
 *
 * The verdict is parsed from the session's `attempt_completion` result (or
 * its text-only answer) via `parseReviewResult`, which is exported for unit
 * testing.
 */

import * as fs from "node:fs/promises"
import { execFileSync } from "node:child_process"
import { fileURLToPath } from "node:url"

import { HeadlessSession } from "../engine/loop.js"
import { OpenRouterClient } from "../llm/openrouter.js"
import { createReadOnlyHeadlessExecutor } from "../tools/executor.js"
import { getNativeTools } from "../vendor/zoo-code/src/core/prompts/tools/native-tools/index.js"
import type { ChatTool, LlmClient, SessionResult } from "../engine/types.js"
import type { SessionBudget } from "../budget/budget.js"

/** Default location of the reviewer checklist, relative to the harness repo. */
export const DEFAULT_REVIEW_PROMPT_PATH = "plans/zoo-code-review-mode-prompt.md"

/** Tools the reviewer may call: read-only + command + completion/reporting. */
const REVIEW_TOOL_NAMES = new Set([
	"read_file",
	"list_files",
	"execute_command",
	"attempt_completion",
	"ask_followup_question",
])

/** The harness repo root (parent of src/orchestrator). */
export const HARNESS_ROOT = fileURLToPath(new URL("../..", import.meta.url))

export interface ReviewOptions {
	/** The worktree to review (checked out on the worker's branch). */
	workspaceRoot: string
	/** Mode slug for the session (default: deepseek-reviewer). */
	mode?: string
	/** Model id (default: env OPENROUTER_MODEL / client default). */
	model?: string
	/** Path to the reviewer system prompt (default: harness plans/…). */
	reviewPromptPath?: string
	/** LLM client; inject a fake in tests (default: OpenRouterClient). */
	llmClient?: LlmClient
	/** Review task text (default: built from the workspace/branch). */
	taskText?: string
	/**
	 * Iteration ceiling — a backstop, not the primary guard (see `budget`
	 * below). Default is deliberately generous (200): a review that
	 * genuinely needs to re-run tests, re-derive baselines, and check
	 * several claims can legitimately need many tool calls, and a tight cap
	 * cutting it off mid-work is worse than a real runaway — it silently
	 * loses the review's actual findings (see `runReview`'s session-failure
	 * fallback below) rather than ending the session cleanly. A real
	 * incident: a review that had ALREADY reopened the issue and posted its
	 * findings comment (real GitHub side effects, correct) hit the OLD
	 * default of 40 right before calling `attempt_completion`, so the
	 * orchestrator only saw a synthetic "session error" instead of the
	 * real finding text.
	 */
	maxIterations?: number
	/**
	 * Cost/duration backstop (SessionBudget's maxCostUsd/maxDurationMs) —
	 * the preferred way to bound a review session: a true runaway gets
	 * caught by spend or wall-clock time, not by an arbitrary tool-call
	 * count that penalizes legitimate thorough work. Omit for no budget
	 * (the harness's own defaults apply, if any).
	 */
	budget?: Pick<SessionBudget, "maxCostUsd" | "maxDurationMs">
}

export interface ReviewResult {
	/** Individual findings extracted from the reviewer's final report. */
	findings: string[]
	/** clean = nothing wrong found; finding = reviewer reported a problem. */
	verdict: "clean" | "finding"
	/** The reviewer's full final summary. */
	summary: string
}

/** The reviewer-mode tool schemas (read-only + command, no write tools). */
export function reviewTools(): ChatTool[] {
	return getNativeTools().filter(
		(t) => t.type === "function" && REVIEW_TOOL_NAMES.has(t.function.name),
	) as unknown as ChatTool[]
}

function currentBranch(workspaceRoot: string): string {
	try {
		return execFileSync("git", ["-C", workspaceRoot, "branch", "--show-current"], {
			encoding: "utf-8",
			timeout: 5000,
		}).trim()
	} catch {
		return "current branch"
	}
}

function defaultTaskText(workspaceRoot: string): string {
	return (
		`Review the work done in this workspace (branch: ${currentBranch(workspaceRoot)}) ` +
		"exactly as your operating procedure instructs. For each issue the worker closed, read the " +
		"closing report, read the real diff, and re-run every checkable claim yourself. When you are " +
		"done, call attempt_completion with a structured summary: verdict (CLEAN or FINDING), a " +
		"Findings section listing anything wrong with file:line evidence, and the final baseline " +
		"numbers you personally confirmed."
	)
}

/**
 * Run one headless review session against `workspaceRoot` using the reviewer
 * checklist as the system prompt override and a read-only executor. Returns
 * the parsed verdict/findings/summary. A failed session (LLM error, max
 * iterations) is reported as `verdict: "finding"` with a synthetic finding,
 * so the orchestrator never mistakes an inconclusive review for a clean one.
 */
export async function runReview(options: ReviewOptions): Promise<ReviewResult> {
	const {
		workspaceRoot,
		mode = "deepseek-reviewer",
		model,
		reviewPromptPath = `${HARNESS_ROOT}${DEFAULT_REVIEW_PROMPT_PATH}`,
		llmClient,
		taskText,
		maxIterations = 200,
		budget,
	} = options

	const systemPromptOverride = await fs.readFile(reviewPromptPath, "utf-8")
	const client = llmClient ?? new OpenRouterClient({ apiKey: process.env.HEADLESSCODE_OPENROUTER_API_KEY, defaultModel: model })

	const session = new HeadlessSession({
		workspaceRoot,
		mode,
		model,
		taskText: taskText ?? defaultTaskText(workspaceRoot),
		maxIterations,
		budget,
		systemPromptOverride,
		tools: reviewTools(),
		executor: createReadOnlyHeadlessExecutor(workspaceRoot),
		llmClient: client,
	})

	const result: SessionResult = await session.run()
	if (result.status !== "success" || result.result === undefined) {
		const error = result.error ?? "unknown review session error"
		return {
			findings: [`[review session error] ${error}`],
			verdict: "finding",
			summary: `Review session failed: ${error}`,
		}
	}
	return parseReviewResult(result.result)
}

/**
 * Parse a reviewer's final report into { findings, verdict, summary }.
 *
 * Verdict heuristics (deterministic, tested):
 *   - "finding" if the report contains reopen/finding/problem markers, OR
 *     explicit "verdict: finding" — ALWAYS wins, even if the same report
 *     also contains clean-sounding language elsewhere (see below);
 *   - "clean" if it contains explicit clean markers ("review clean",
 *     "verified clean", "no findings", "everything checks out") AND no
 *     finding marker;
 *   - default "clean" when the report states neither (the reviewer only
 *     reopens for real problems, so an unmarked report is treated as clean).
 *
 * A finding marker ALWAYS overrides a clean marker, never the reverse. A
 * real reviewer report reopening one issue while confirming several OTHER
 * claims checked out cleanly is a completely normal report shape (e.g. a
 * "### Verified clean" section listing what's fine, alongside a separate
 * "### Reopened" section naming the real problem) — treating the ambient
 * presence of "verified clean" text as grounds to override an explicit
 * "reopened" elsewhere in the SAME report was a real production bug: it
 * silently classified a genuinely reopened review as "clean", which would
 * have skipped the entire rework mechanism this classification exists to
 * trigger. Never weaken this back to "finding && !clean" — a report is
 * either clean (nothing wrong) or it has findings; it cannot be both, and
 * when in doubt (both markers present), a real finding must win.
 *
 * The finding-marker word list is deliberately narrow — only `reopen(ed)`
 * and an explicit `verdict: ... finding` phrase — NOT bare words like
 * "failed", "wrong", "regression", or "does not". A second real production
 * bug from the SAME over-broad list: a genuinely clean review's baseline
 * test counts ("12 failed, 1187 passed" — pre-existing failures on master,
 * unrelated to the change) contain the word "failed", which alone tripped
 * the OLD list and misclassified a clean review as a finding — spawning a
 * completely unnecessary rework cycle, spending real API cost on a fix
 * for a problem that did not exist. "Failed"/"wrong"/"regression" are
 * ordinary words that show up constantly in normal baseline-reporting
 * prose; they are NOT a reliable signal on their own. `reopen(ed)` is
 * reliable because it names the actual ground-truth action the reviewer
 * takes on GitHub when — and only when — there's a real problem. Do not
 * add generic words back to this list without a specific report shape
 * that needs them AND a test proving it doesn't false-positive on normal
 * baseline/prose language.
 */
export function parseReviewResult(text: string): ReviewResult {
	const summary = text.trim()
	const lower = summary.toLowerCase()

	// Extract a "## Findings" / "Findings:" section if present.
	const findings: string[] = []
	const section = summary.match(
		/(?:^|\n)(?:#{1,6}\s*)?findings?\s*:?\s*\n([\s\S]*?)(?=\n#{1,6}\s|\n\s*(?:verdict|summary)\b|\n\s*(?:PR|issues?):|\s*$)/i,
	)
	if (section?.[1]) {
		for (const line of section[1].split("\n")) {
			const item = line.replace(/^[-*\d.\s)\]]+\s*/, "").trim()
			if (item && !/^(verdict|summary)/i.test(item)) {
				findings.push(item)
			}
		}
	}
	// Fallback: any line that explicitly names a finding / a reopen.
	if (findings.length === 0) {
		for (const line of summary.split("\n")) {
			const item = line.replace(/^[-*\d.\s)\]]+\s*/, "").trim()
			if (/\b(reopen(ed)?|finding)\b/i.test(item) && item.length > 8) {
				findings.push(item)
			}
		}
	}

	const hasFindingMarker = /\b(reopen(ed)?|verdict[^.\n]*finding)\b/i.test(lower)

	const verdict: "clean" | "finding" = hasFindingMarker ? "finding" : "clean"
	return { findings: [...new Set(findings)], verdict, summary }
}
