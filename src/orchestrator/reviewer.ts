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
	maxIterations?: number
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
		maxIterations = 40,
	} = options

	const systemPromptOverride = await fs.readFile(reviewPromptPath, "utf-8")
	const client = llmClient ?? new OpenRouterClient({ apiKey: process.env.HEADLESSCODE_OPENROUTER_API_KEY, defaultModel: model })

	const session = new HeadlessSession({
		workspaceRoot,
		mode,
		model,
		taskText: taskText ?? defaultTaskText(workspaceRoot),
		maxIterations,
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
 *     explicit "verdict: finding";
 *   - "clean" if it contains explicit clean markers ("review clean",
 *     "verified clean", "no findings", "everything checks out");
 *   - default "clean" when the report states neither (the reviewer only
 *     reopens for real problems, so an unmarked report is treated as clean).
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

	const hasFindingMarker =
		/\b(reopen(ed)?|finding|verdict[^.\n]*finding|regression|failed|does\s+not\b|wrong)\b/i.test(lower)
	const hasCleanMarker =
		/\b(review\s*clean|verdict[^.\n]*clean|verified\s*clean|no\s+findings|everything\s+checks?\s+out|all\s+claims?\s+verified|nothing\s+wrong)\b/i.test(
			lower,
		)

	const verdict: "clean" | "finding" = hasFindingMarker && !hasCleanMarker ? "finding" : "clean"
	return { findings: [...new Set(findings)], verdict, summary }
}
