/**
 * Headless reviewer (Phase 2) — an adversarial fresh-context verification run.
 *
 * The reviewer is a SECOND harness session run against a worker's worktree /
 * branch, with the review-mode checklist
 * (`shared/prompts/review-mode-prompt.md`) used as the system prompt
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
import * as fsSync from "node:fs"
import * as path from "node:path"
import { execFileSync } from "node:child_process"
import { fileURLToPath } from "node:url"

import { HeadlessSession } from "../engine/loop.js"
import { Logger } from "../engine/logger.js"
import { OpenRouterClient } from "../llm/openrouter.js"
import { OllamaClient } from "../llm/ollama.js"
import { envBoolean, resolvePerModeEnv } from "../cli.js"
import { createReadOnlyHeadlessExecutor } from "../tools/executor.js"
import { getNativeTools } from "../vendor/zoo-code/src/core/prompts/tools/native-tools/index.js"
import { addCustomInstructions } from "../vendor/zoo-code/src/core/prompts/sections/custom-instructions.js"
import type { ChatTool, LlmClient, SessionResult } from "../engine/types.js"
import type { SessionBudget } from "../budget/budget.js"

/** Default location of the reviewer checklist, relative to the harness repo. */
export const DEFAULT_REVIEW_PROMPT_PATH = "shared/prompts/review-mode-prompt.md"

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
	/** Path to the reviewer system prompt (default: harness shared/prompts/…). */
	reviewPromptPath?: string
	/** LLM client; inject a fake in tests (default: OpenRouterClient). */
	llmClient?: LlmClient
	/** Review task text (default: built from the workspace/branch). */
	taskText?: string
	/**
	 * Issue number(s) this group was actually assigned, when known (the
	 * orchestrator always has this in `group.issues`). When provided (and
	 * `taskText` is not explicitly overridden), the default task text names
	 * them directly instead of asking the reviewer to discover what was
	 * worked on via `gh issue list --state closed`. 2026-08-27: verified
	 * live — a review session given the generic "figure out which issues
	 * were closed" task, against a group whose issue had NOT actually been
	 * filed to GitHub (a synthetic `--issues-json` test group, closed
	 * locally but with no real issue thread to find), stalled into repeated
	 * empty replies ("I need to review the work... let me first understand
	 * what issues were closed") across all 3 retry attempts and correctly
	 * escalated to NEEDS-HUMAN — the fail-closed path worked, but a review
	 * that already knows the issue number shouldn't have to search for it
	 * at all. This closes that gap generally, not just for the synthetic
	 * case: even in normal use, `gh issue list --state closed` can miss
	 * for other reasons (API lag, pagination, label filtering) and there's
	 * no reason to re-derive data the caller already has.
	 */
	issues?: number[]
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
	/**
	 * clean = nothing wrong found; finding = reviewer reported a real problem
	 * with the WORKER's code; error = the review SESSION ITSELF failed
	 * (crashed, hit its own mistake/budget limit) before ever producing a
	 * real verdict — deliberately distinct from "finding" so the caller
	 * retries the REVIEW, not the worker's already-fine code (see
	 * runReviewWithRetries; issue caught live 2026-08-05 — a review session's
	 * own bounded-failure was being treated exactly like a code finding and
	 * triggered a pointless worker rework cycle).
	 */
	verdict: "clean" | "finding" | "error"
	/** The reviewer's full final summary. */
	summary: string
	/**
	 * Issue #34: absolute path to the review session's complete final report
	 * (`<workspaceRoot>/.headlesscode/reports/<sessionId>.md`), when the
	 * session succeeded and the report write succeeded. The orchestrator
	 * persists this so the full reasoning behind a review verdict is one
	 * file-read away, not a re-run away. Absent for a session error (no
	 * report was ever produced).
	 */
	reportPath?: string
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

function defaultTaskText(workspaceRoot: string, issues?: number[]): string {
	const targetLine =
		issues && issues.length > 0
			? `Review the work done in this workspace (branch: ${currentBranch(workspaceRoot)}) for ` +
				`issue${issues.length > 1 ? "s" : ""} ${issues.map((n) => `#${n}`).join(", ")} — that is exactly ` +
				`what this group was assigned, so start there directly (\`gh issue view ${issues[0]}\`, etc.) ` +
				"rather than searching for it. If the issue number doesn't resolve on GitHub (e.g. a locally-" +
				"tracked or synthetic task never filed as a real issue), that is not a review blocker — fall " +
				"back to the worktree's own git log and diff against its base branch as the source of truth " +
				"for what was actually done, and review that directly instead of stalling on the missing issue " +
				"thread.\n\n"
			: `Review the work done in this workspace (branch: ${currentBranch(workspaceRoot)}) ` +
				"exactly as your operating procedure instructs. For each issue the worker closed, read the " +
				"closing report, read the real diff, and re-run every checkable claim yourself.\n\n"
	return (
		targetLine +
		"Any scratch " +
		"you need (probe scripts, temp output captures) goes in `.headlesscode/scratch/` inside this " +
		"workspace — NEVER write to `/tmp` or any other path outside the workspace. When you are " +
		"done, call attempt_completion with a structured summary: a Findings section listing anything " +
		"wrong with file:line evidence (omit or write 'none' if clean), and the final baseline numbers " +
		"you personally confirmed.\n\n" +
		"The VERY LAST LINE of your attempt_completion result must be exactly one of:\n" +
		"VERDICT: CLEAN\n" +
		"VERDICT: FINDING\n" +
		"Nothing else on that line — no prose, no punctuation, no markdown formatting. This is the ONLY " +
		"line the orchestrator parses to decide whether to trigger a rework cycle; everything else in " +
		"your report is for a human reader. Get this exactly right even when the rest of your report " +
		"discusses both clean and problematic findings — the verdict reflects the OVERALL outcome " +
		"(FINDING if you reopened ANY issue, CLEAN only if none needed reopening)."
	)
}

/**
 * Run one headless review session against `workspaceRoot` using the reviewer
 * checklist as the system prompt override and a read-only executor. Returns
 * the parsed verdict/findings/summary. A failed session (LLM error, max
 * iterations, bounded-failure mistake limit) is reported as `verdict:
 * "error"` with a synthetic finding, so the orchestrator never mistakes an
 * inconclusive review for a clean one — but also never mistakes it for a
 * real code finding either (see runReviewWithRetries, which callers should
 * generally use instead of calling this directly).
 */
export async function runReview(options: ReviewOptions): Promise<ReviewResult> {
	const {
		workspaceRoot,
		mode = "deepseek-reviewer",
		model,
		reviewPromptPath = `${HARNESS_ROOT}${DEFAULT_REVIEW_PROMPT_PATH}`,
		llmClient,
		taskText,
		issues,
		maxIterations = 200,
		budget,
	} = options

	// 2026-08-27: verified live — a review session couldn't find the `curlee`
	// compiler at all ("curlee runtime is not available in this environment"),
	// fell back to eyeballing source code instead of running real checks, and
	// separately had no idea `.roo/rules/rules.md` (this workspace's own
	// language/build reference — e.g. joeos's documented curlee compiler
	// location and Curlee syntax rules) existed. Root cause: `systemPromptOverride`
	// is used VERBATIM by loop.ts (`this.config.systemPromptOverride ?? (await
	// buildPrompt(...))`), which means review sessions skip `buildPrompt`
	// entirely and, with it, `addCustomInstructions` — the exact mechanism
	// that splices `.roo/rules/` into a WORKER session's prompt. Review
	// sessions were structurally blind to project-specific guidance that
	// worker sessions always get. Splicing it in here closes that gap the
	// same way buildSystemPrompt already does for workers (see prompt.ts).
	const reviewPromptText = await fs.readFile(reviewPromptPath, "utf-8")
	const workspaceCustomInstructions = await addCustomInstructions("", "", workspaceRoot, mode, {})
	const systemPromptOverride = workspaceCustomInstructions
		? `${reviewPromptText}\n\n${workspaceCustomInstructions}`
		: reviewPromptText
	// Issue #142 follow-up: orchestrate's review pass built its own
	// OpenRouterClient unconditionally, so a local-backend setup (e.g. a
	// review daemon on its own GPU) had no effect on it — only the
	// single-session `--mode` CLI path respected HEADLESSCODE_LOCAL_BACKEND_MODES.
	// Mirror cli.ts's gate here so `mode` (default "deepseek-reviewer")
	// routes to the same local daemon a direct CLI invocation would.
	const useLocalBackend =
		process.env.HEADLESSCODE_CODE_MODE_BACKEND === "ollama" &&
		(process.env.HEADLESSCODE_LOCAL_BACKEND_MODES ?? "code")
			.split(",")
			.map((s) => s.trim())
			.filter(Boolean)
			.includes(mode)
	// 2026-08-27: cli.ts's own useLocalCodeBackend path learned this the hard
	// way (see its effectiveModel doc comment) — every downstream consumer of
	// `model` (session-start logs, cost/usage records, the `request.model`
	// OllamaClient sends, which OllamaClient.resolveModel() prefers over its
	// own defaultModel) must see the LOCAL model id when local backend is
	// active, not the cloud one, or a local review session logs/tags itself
	// as e.g. "deepseek/deepseek-v4-flash-0731" throughout even though it
	// never touches OpenRouter.
	const effectiveModel = useLocalBackend ? (resolvePerModeEnv("HEADLESSCODE_CODE_MODE_MODEL", mode) ?? model) : model
	const client =
		llmClient ??
		(useLocalBackend
			? new OllamaClient({
					baseUrl: resolvePerModeEnv("HEADLESSCODE_OLLAMA_URL", mode),
					defaultModel: effectiveModel,
					// OllamaClient has its own independent abort timer
					// (ollama.ts's DEFAULT_OLLAMA_TIMEOUT_MS, 300s), separate
					// from the llmTimeoutMs passed to HeadlessSession below —
					// verified live 2026-08-28 (cli.ts's LOCAL_LLM_TIMEOUT_MS
					// doc comment has the full story): raising the session-
					// level timeout alone still left review sessions dying at
					// exactly 300000ms because this constructor never heard
					// about it.
					timeoutMs: useLocalBackend ? 630_000 : undefined,
				})
			: new OpenRouterClient({ apiKey: process.env.HEADLESSCODE_OPENROUTER_API_KEY, defaultModel: model }))

	// Mirror every log line to <worktree>/review.log — the same visibility
	// `run-worker.sh` gives a worker via harness.log (a plain `tail -f`
	// target), which review/QA sessions never had: they run IN-PROCESS
	// inside orchestrate rather than as a spawned subprocess with redirected
	// stdout, so their activity was only ever visible by hand-parsing the
	// structured `.headlesscode/events/*.jsonl` feed. Raised directly
	// 2026-08-05: "frustrating that i can't see the review logs the same way
	// i can the harness logs... i don't like having to hunt them down."
	// Append-only (matches harness.log's own convention across
	// retries/rework re-reviews) with a run-separator line per session.
	const logFilePath = path.join(workspaceRoot, "review.log")
	fsSync.appendFileSync(logFilePath, `\n===== headlesscode review start: ${new Date().toISOString()} =====\n`, "utf-8")
	const logger = new Logger({ level: "info", filePath: logFilePath })

	const session = new HeadlessSession({
		workspaceRoot,
		mode,
		model: effectiveModel,
		taskText: taskText ?? defaultTaskText(workspaceRoot, issues),
		maxIterations,
		budget,
		systemPromptOverride,
		tools: reviewTools(),
		executor: createReadOnlyHeadlessExecutor(workspaceRoot),
		llmClient: client,
		logger,
		// Issue #144: mirror cli.ts's local-backend cost-tracking skip — a
		// review session on a local daemon (e.g. the 2080 review-daemon) has
		// no real dollar cost either.
		trackCost: !useLocalBackend,
		// 2026-08-27: verified live — a local Qwen3.5-9B review session
		// fabricated a fake `<tool_call>...</tool_call>` text block as its
		// very first reply, never ran a single real verification command, and
		// the harness's bare-text pragmatic-success fallback (see cli.ts's
		// requireExplicitCompletion doc comment) accepted that garbage as a
		// normal `status: "success"` result. Because the session-level result
		// looked like an ordinary success, `parseReviewResult`'s deliberate
		// fail-open default ("no finding marker found -> clean", see its own
		// doc comment) then silently recorded verdict "clean" for a worker
		// whose `git diff --stat` was completely empty — the exact false
		// completion this review stage exists to catch. cli.ts's worker path
		// was already hardened against this for local sessions
		// (requireExplicitCompletion); the review path never got the same
		// treatment, even though it runs on the same daemon and hits the same
		// failure mode. Without this, a garbage local-reviewer reply is
		// silently indistinguishable from a real "verified clean" verdict —
		// forcing it here means a bare/fabricated reply becomes a
		// non-completing mistake (retried, then a genuine session error) so
		// runReviewWithRetries's existing fail-closed handling actually
		// triggers instead of being bypassed.
		requireExplicitCompletion: useLocalBackend && !envBoolean("HEADLESSCODE_ALLOW_TEXT_ONLY_COMPLETION"),
		// Same gap as cli.ts's LOCAL_LLM_TIMEOUT_MS (see its doc comment for
		// the full story): this session construction never set llmTimeoutMs
		// at all, so a review session on the local daemon always used the
		// generic DEFAULT_LLM_TIMEOUT_MS (300s) — shorter than the shim's
		// own deliberately-raised 600s upstream patience, so the harness
		// gives up first on a genuinely slow (not hung) local call.
		llmTimeoutMs: useLocalBackend ? 630_000 : undefined,
	})

	const result: SessionResult = await session.run()
	if (result.status !== "success" || result.result === undefined) {
		const error = result.error ?? "unknown review session error"
		return {
			findings: [`[review session error] ${error}`],
			verdict: "error",
			summary: `Review session failed: ${error}`,
		}
	}
	return { ...parseReviewResult(result.result), reportPath: result.reportPath }
}

/**
 * Run a review, retrying ONLY when the review SESSION itself failed
 * (verdict "error" — a crash, budget stop, or bounded-failure mistake limit
 * inside the review session), up to `maxRetries` additional attempts. A real
 * "clean" or "finding" verdict is returned immediately, first try — this
 * only guards against the review session's own infrastructure hiccups, not
 * against re-litigating a real finding.
 *
 * Why this exists: `runReview` reports a failed session as `verdict:
 * "error"` rather than silently treating an inconclusive review as clean —
 * correct fail-closed behavior. But the ORIGINAL caller-side handling
 * treated ANY non-clean verdict (including "error") as a real code finding
 * and triggered a full worker rework cycle to "fix" it — pointlessly
 * respawning a worker against a placeholder error message with nothing
 * actionable in it. Caught live 2026-08-05 running issue #17's own round.
 * After `maxRetries` failed attempts, the caller gets the final "error"
 * result back and should escalate to needs-human (a human should look at
 * why review sessions keep failing) rather than reworking the worker.
 */
export async function runReviewWithRetries(options: ReviewOptions, maxRetries = 2): Promise<ReviewResult> {
	let last: ReviewResult = { findings: [], verdict: "error", summary: "no attempt made" }
	for (let attempt = 0; attempt <= maxRetries; attempt++) {
		last = await runReview(options)
		if (last.verdict !== "error") {
			return last
		}
	}
	return last
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
 * The finding-marker word list is deliberately narrow — NOT bare words
 * like "failed", "wrong", "regression", "does not", or even bare
 * "reopen(ed)" on its own. Three real production bugs came from
 * progressively narrowing an over-broad list, each caught live in the same
 * session:
 *   1. A clean marker ("verified clean") anywhere overrode an explicit
 *      finding elsewhere in the same report (fixed: finding always wins).
 *   2. Bare "failed"/"wrong"/"regression" matched ordinary baseline-
 *      reporting prose ("12 failed, 1187 passed" — pre-existing, unrelated
 *      to the change) with zero real problem present (fixed: dropped those
 *      words entirely, kept only `reopen(ed)`).
 *   3. Bare "reopen(ed)" STILL wasn't safe: a genuinely clean report can
 *      explain that something does NOT need action using the word
 *      "reopen" itself — "(pre-existing / out of scope, no reopen)",
 *      "Staying closed. No reopening warranted." — with zero negation-
 *      detection, "reopen" appearing ANYWHERE, including inside a
 *      sentence explicitly saying it's NOT happening, still tripped the
 *      finding branch.
 *
 * The fix for #3 is not another negation lookbehind (that class of patch
 * — `(?<!no\s)` — already failed once for "failed"; it only protects the
 * EXACT phrase it names, never generalizes to different phrasing). The
 * reliable signal instead is a STRUCTURAL one: `reopen(ed)` only counts
 * when it is
 *   (a) a section heading on its own ("### Reopened"), or
 *   (b) explicitly tied to a specific issue number within the same
 *       sentence ("reopened #83" / "#83 ... reopened" / "issue #83
 *       REOPENED"),
 * because the reviewer's own required report format always associates a
 * real reopen with the specific issue number it applies to — an
 * incidental "no reopen" aside never does. Do not go back to a bare
 * `\breopen(ed)?\b` match, and do not add generic words back to this list
 * without a specific report shape that needs them AND a test proving no
 * false-positive on normal baseline/prose/aside language.
 */
export function parseReviewResult(text: string): ReviewResult {
	const summary = text.trim()

	// A real reopen: either an explicit "### Reopened" heading, or
	// "reopen(ed)" tied to a specific issue number within ~30 chars on
	// either side, never crossing a sentence boundary (period/newline) —
	// see the function docstring for why bare "reopen(ed)" isn't enough.
	const REOPENED_HEADING_RE = /(?:^|\n)#{1,6}\s*reopened?\b/i
	const REOPENED_WITH_ISSUE_RE = /#\d+\b[^.\n]{0,30}\breopen(?:ed)?\b|\breopen(?:ed)?\b[^.\n]{0,30}#\d+\b/i
	const VERDICT_FINDING_RE = /\bverdict\b[^.\n]*\bfinding\b/i

	const isRealFindingLine = (line: string): boolean =>
		REOPENED_HEADING_RE.test(`\n${line}`) || REOPENED_WITH_ISSUE_RE.test(line) || VERDICT_FINDING_RE.test(line)

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
	// Fallback: any line that names a REAL reopen (tied to an issue number
	// or its own heading) — not just the bare word "finding"/"reopen".
	if (findings.length === 0) {
		for (const line of summary.split("\n")) {
			const item = line.replace(/^[-*\d.\s)\]]+\s*/, "").trim()
			if (isRealFindingLine(item) && item.length > 8) {
				findings.push(item)
			}
		}
	}

	// Primary path: an explicit, structured "VERDICT: CLEAN"/"VERDICT: FINDING"
	// line (required by defaultTaskText) is authoritative — exact match, no
	// heuristics, so no future report phrasing can ever false-positive it.
	// This exists because free-form regex heuristics on prose proved to have
	// no ceiling on false positives: three separate real incidents (see the
	// function docstring) each needed a NEW fix for a NEW phrasing the
	// previous fix didn't anticipate. A rigid required line has no such
	// ceiling — it's either present and exact, or it's absent.
	const structuredVerdict = summary.match(/^VERDICT:\s*(CLEAN|FINDING)\s*$/im)
	if (structuredVerdict) {
		const verdict: "clean" | "finding" = structuredVerdict[1]!.toUpperCase() === "FINDING" ? "finding" : "clean"
		return { findings: [...new Set(findings)], verdict, summary }
	}

	// Fallback for a session that didn't emit the required line (an older
	// prompt, a model that ignored the instruction, or a hand-written test
	// fixture) — the heuristic below, kept exactly as hardened by the three
	// past incidents, but no longer the primary path.
	const hasFindingMarker =
		REOPENED_HEADING_RE.test(summary) || REOPENED_WITH_ISSUE_RE.test(summary) || VERDICT_FINDING_RE.test(summary)

	const verdict: "clean" | "finding" = hasFindingMarker ? "finding" : "clean"
	return { findings: [...new Set(findings)], verdict, summary }
}
