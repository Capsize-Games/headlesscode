/**
 * Headless QA (Phase 4) — run the target repo's `qa-agent` mode headlessly.
 *
 * Decision documented in docs/phase4-qa.md: the `qa-agent` mode's
 * core loop (start the app → run `node qa/runner.js` → read `qa/last-report.json`
 * → correlate with the server log → diagnose → fix → verify) is driven entirely
 * by read + execute_command (+ edit for remediation) tools. The Playwright MCP
 * server referenced in the mode's customInstructions is OPTIONAL enrichment
 * ("you can also use Playwright MCP tools directly") — the harness cannot serve
 * MCP (the vendored McpHub is a stub and MCP tools are excluded from
 * `selectToolsForMode`), so browser interaction is done via the repo's own
 * Playwright CLI (`qa/runner.js`, `npx playwright ...`) through
 * `execute_command`. That is choice (b)-via-CLI from the Phase 4 spec.
 *
 * `runQa` therefore runs a second harness session against a worktree in
 * `--mode qa-agent` (spliced from the target repo's `.roomodes` +
 * `.roo/rules-qa-agent/` automatically by the vendored prompt builder — same
 * mechanism as the reviewer). When the target repo has no `qa-agent` mode, a
 * generic QA checklist (`GENERIC_QA_CHECKLIST`) is used as a
 * `systemPromptOverride` so the session still gets a real QA operating
 * procedure.
 *
 * Non-edit discipline: QA may RUN the app + tests (execute_command) but must
 * NOT be able to modify source files unexpectedly. `write_to_file` is absent
 * from BOTH the advertised tool list (`qaTools()`) and the executor
 * (`createQaHeadlessExecutor`) — a model that calls it gets a clear
 * "not implemented" error and the loop's consecutive-mistake bound will
 * eventually trip.
 *
 * Verdict parsing mirrors the reviewer (`src/orchestrator/reviewer.ts`) but is
 * FAIL-CLOSED: a QA report that neither explicitly passes nor explicitly fails
 * is treated as `fail`, because QA gates a deploy — an inconclusive QA run must
 * never let a deployment through.
 */

import { execFileSync } from "node:child_process"
import * as fs from "node:fs"
import * as path from "node:path"

import { HeadlessSession } from "../engine/loop.js"
import { Logger } from "../engine/logger.js"
import { OllamaClient } from "../llm/ollama.js"
import { OpenRouterClient } from "../llm/openrouter.js"
import { resolvePerModeEnv } from "../cli.js"
import { appendBrowserActionTool, appendCodeIntelTools, loadCustomModes } from "../engine/prompt.js"
import { createQaHeadlessExecutor } from "../tools/executor.js"
import { getNativeTools } from "../vendor/zoo-code/src/core/prompts/tools/native-tools/index.js"
import type { ChatTool, LlmClient, SessionResult } from "../engine/types.js"
import type { MemoryStore } from "../memory/types.js"
import type { SessionBudget } from "../budget/budget.js"

/** Default mode slug used for QA sessions (the qa-agent mode). */
export const DEFAULT_QA_MODE = "qa-agent"

/** Tools the QA agent may call: read + list + command + reporting. NO write. */
const QA_TOOL_NAMES = new Set([
	"read_file",
	"list_files",
	"execute_command",
	"attempt_completion",
	"ask_followup_question",
])

/**
 * The QA-mode tool schemas (read-only + command, no write tools), plus
 * browser_action and the four code-intelligence tools — QA can boot the app,
 * visually verify it in a headless browser (the phase4 gap "live
 * Playwright-MCP interactivity is not available headlessly" is partially
 * closed for agent-driven checks; see src/tools/browser/tool.ts), and
 * navigate source to substantiate findings (see src/codeintel/).
 */
export function qaTools(): ChatTool[] {
	const tools = getNativeTools().filter(
		(t) => t.type === "function" && QA_TOOL_NAMES.has(t.function.name),
	) as unknown as ChatTool[]
	return appendCodeIntelTools(appendBrowserActionTool(tools))
}

/**
 * Generic QA checklist used when the target repo defines no `qa-agent` mode.
 * The text deliberately opens with "You are a QA agent" so e2e mock
 * scenarios can classify QA sessions deterministically (see
 * scripts/e2e/mock-openrouter.mjs `qa-orchestrate`).
 */
export const GENERIC_QA_CHECKLIST = [
	"You are a QA agent for this project. Your job is to verify the work done in this workspace",
	"and report evidence with REAL command output. You operate in a loop: boot → test → exercise →",
	"report. You do not write or edit source files — QA is verification only; report problems,",
	"do not fix them.",
	"",
	"## How to perform QA",
	"",
	"1. Boot the application or relevant service using the repo's own start script / command",
	"   (check `scripts/`, README, package.json). Run it as a background process if it would",
	"   block; set a timeout on every wait loop and every command. Any scratch you need (probe",
	"   scripts, temp output captures) goes in `<workspace>/.headlesscode/scratch/` — NEVER write",
	"   to `/tmp` or any other path outside the workspace.",
	"2. Run the project's test suite (`npm test` / `pytest` / whatever the repo uses) and capture",
	"   the REAL output — counts of passed/failed tests are the primary evidence.",
	"3. Exercise the changed behavior described in your task: run the relevant command, script,",
	"   or browser check (e.g. a Playwright runner script the repo already has) and capture output.",
	"4. If anything fails, report it — do not modify source files to make it pass.",
	"",
	"## Definition of done",
	"",
	"A task is complete when every check ran clean and the changed behavior works as expected.",
	"Report a final summary with evidence: the real commands you ran and their output, test",
	"counts, and any errors found.",
	"",
	"## How to finish",
	"",
	"Call attempt_completion with a structured summary:",
	"- A verdict line: `QA PASS` (all checks clean) or `QA FAIL` (any error, failed test, or",
	"  behavior that does not work).",
	"- An `## Evidence` section listing each command you ran and its real output.",
	"- The final baseline numbers you personally confirmed.",
].join("\n")

export interface RunQaOptions {
	/** The worktree to run QA against (checked out on the worker's branch). */
	workspaceRoot: string
	/** The QA checklist task text (default: built from the mode/workspace). */
	taskText?: string
	/** Mode slug (default: `qa-agent` — the QA mode, auto-spliced). */
	mode?: string
	/** Model id (default: env OPENROUTER_MODEL / client default). */
	model?: string
	/** LLM client; inject a fake in tests (default: OpenRouterClient). */
	llmClient?: LlmClient
	/** OpenRouter base URL override (e2e points this at the mock server). */
	baseUrl?: string
	/**
	 * Loop iteration cap — a backstop, not the primary guard (see `budget`
	 * below). Default is deliberately generous (200): QA that boots the
	 * app, runs a real test suite, and exercises changed behavior can
	 * legitimately need many tool calls, and cutting it off mid-work
	 * silently loses the real evidence rather than ending cleanly (see
	 * `runQa`'s session-failure fallback below) — a review session hitting
	 * this exact problem at the old default of 40 was a real incident.
	 */
	maxIterations?: number
	/**
	 * Cost/duration backstop (SessionBudget's maxCostUsd/maxDurationMs) —
	 * the preferred way to bound a QA session: a true runaway gets caught
	 * by spend or wall-clock time, not by an arbitrary tool-call count that
	 * penalizes legitimate thorough work.
	 */
	budget?: Pick<SessionBudget, "maxCostUsd" | "maxDurationMs">
	/** Phase 3 memory store (optional; QA can reuse the project's memory). */
	memory?: MemoryStore | null
	/** Project scope for memory (default: basename of workspaceRoot). */
	project?: string
}

export type QaVerdict = "pass" | "fail" | "error"

export interface QaResult {
	/** pass = all QA checks clean; fail = problems found; error = session error. */
	verdict: QaVerdict
	/** The evidence section extracted from the report (real command output). */
	evidence: string
	/** The full final summary from the QA session. */
	summary: string
	/**
	 * Issue #34: absolute path to the QA session's complete final report
	 * (`<workspaceRoot>/.headlesscode/reports/<sessionId>.md`), when the
	 * session succeeded and the report write succeeded. The orchestrator
	 * persists this so the full reasoning behind a QA verdict is one
	 * file-read away, not a re-run away. Absent for a session error (no
	 * report was ever produced).
	 */
	reportPath?: string
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

function defaultTaskText(workspaceRoot: string, mode: string): string {
	return (
		`Run the QA checklist defined in your operating instructions against this workspace ` +
		`(branch: ${currentBranch(workspaceRoot)}, mode: ${mode}).\n\n` +
		`FIRST: run \`git diff origin/master...HEAD --stat\` (or the equivalent against this repo's ` +
		`actual base branch) to see EXACTLY which files changed. That diff is your scope — it tells ` +
		`you which behavior to exercise. A real incident: without this instruction, a QA session spent ` +
		`over a dozen iterations exploring an unrelated chat-UI input component and an unrelated ` +
		`dependency-pinning question before ever looking at the actual diff, on a change that only ` +
		`touched two shell scripts and a docs file.\n\n` +
		`Boot the app and confirm it starts cleanly (a QUICK smoke test — no new JS/console errors on ` +
		`load — not a deep exploration of unrelated areas), run the relevant test suite, then exercise ` +
		`SPECIFICALLY the behavior the diff touched. If the diff doesn't touch the browser-facing app at ` +
		`all (e.g. only scripts/docs/backend), the boot-and-smoke-test step still applies but do not go ` +
		`looking for unrelated things to click through — there's nothing in scope for deeper UI ` +
		`interaction. Report EVIDENCE with real command output. ` +
		`When you are done, call attempt_completion with a structured summary: an Evidence section ` +
		`with the real commands you ran and their output, and the final baseline numbers you ` +
		`personally confirmed.\n\n` +
		`The VERY LAST LINE of your attempt_completion result must be exactly one of:\n` +
		`QA_VERDICT: PASS\n` +
		`QA_VERDICT: FAIL\n` +
		`Nothing else on that line — no prose, no punctuation, no markdown formatting. This is the ONLY ` +
		`line the orchestrator parses to decide pass/fail; everything else in your report is for a ` +
		`human reader.`
	)
}

/**
 * Run one headless QA session against `workspaceRoot` using the target repo's
 * `qa-agent` mode (auto-spliced from .roomodes + .roo/rules-qa-agent/) or a
 * generic checklist when the mode is absent. Returns the parsed verdict /
 * evidence / summary. A failed session (LLM error, max iterations) is reported
 * as `verdict: "error"` — the caller must never treat an inconclusive QA run
 * as a pass.
 */
export async function runQa(options: RunQaOptions): Promise<QaResult> {
	const {
		workspaceRoot,
		mode = DEFAULT_QA_MODE,
		model,
		llmClient,
		baseUrl,
		maxIterations = 200,
		budget,
		memory = null,
		project,
	} = options

	// Detect whether the target repo actually defines the requested mode. If
	// not, fall back to the generic checklist as a system prompt override.
	const customModes = await loadCustomModes(workspaceRoot)
	const modeExists = customModes.some((m) => m.slug === mode)
	const systemPromptOverride = modeExists ? undefined : GENERIC_QA_CHECKLIST

	// Mirror reviewer.ts's runReview gate (issue #142 follow-up): unlike
	// reviewer.ts, this constructed an OpenRouterClient unconditionally, so
	// a local-backend setup (HEADLESSCODE_CODE_MODE_BACKEND=ollama +
	// HEADLESSCODE_LOCAL_BACKEND_MODES including this QA mode) had no effect
	// on QA sessions at all, even though the worker and reviewer both
	// respected it. Same gate, same precedence (an explicit llmClient/model/
	// baseUrl injected by a caller still wins).
	const useLocalBackend =
		process.env.HEADLESSCODE_CODE_MODE_BACKEND === "ollama" &&
		(process.env.HEADLESSCODE_LOCAL_BACKEND_MODES ?? "code")
			.split(",")
			.map((s) => s.trim())
			.filter(Boolean)
			.includes(mode)
	// Same fix as reviewer.ts's effectiveModel (2026-08-27): downstream
	// consumers of `model` (session-start logs, cost records, the
	// `request.model` OllamaClient sends) must see the LOCAL model id when
	// local backend is active, or a local QA session logs itself as the
	// cloud model throughout even though it never touches OpenRouter.
	const effectiveModel = useLocalBackend ? (resolvePerModeEnv("HEADLESSCODE_CODE_MODE_MODEL", mode) ?? model) : model
	const client =
		llmClient ??
		(useLocalBackend
			? new OllamaClient({
					baseUrl: baseUrl ?? resolvePerModeEnv("HEADLESSCODE_OLLAMA_URL", mode),
					defaultModel: effectiveModel,
				})
			: new OpenRouterClient({ apiKey: process.env.HEADLESSCODE_OPENROUTER_API_KEY, defaultModel: model, baseUrl }))

	// Mirror every log line to <worktree>/qa.log — see reviewer.ts's runReview
	// for the full rationale (same fix, same incident: review/QA run
	// in-process rather than as a spawned subprocess with redirected stdout
	// like a worker gets via harness.log, so there was no `tail -f`able file).
	const logFilePath = path.join(workspaceRoot, "qa.log")
	fs.appendFileSync(logFilePath, `\n===== headlesscode qa start: ${new Date().toISOString()} =====\n`, "utf-8")
	const logger = new Logger({ level: "info", filePath: logFilePath })

	const session = new HeadlessSession({
		workspaceRoot,
		mode,
		model: effectiveModel,
		taskText: options.taskText ?? defaultTaskText(workspaceRoot, mode),
		maxIterations,
		budget,
		systemPromptOverride,
		tools: qaTools(),
		executor: createQaHeadlessExecutor(workspaceRoot),
		llmClient: client,
		// Issue #144 (mirrors reviewer.ts): local inference is free — a
		// fabricated dollar figure in the QA log is noise at best.
		trackCost: !useLocalBackend,
		memory,
		project,
		logger,
	})

	const result: SessionResult = await session.run()
	if (result.status !== "success" || result.result === undefined) {
		const error = result.error ?? "unknown QA session error"
		return {
			verdict: "error",
			evidence: "",
			summary: `QA session failed: ${error}`,
		}
	}
	return { ...parseQaResult(result.result), reportPath: result.reportPath }
}

/**
 * Run QA, retrying ONLY when the session itself failed (verdict "error" —
 * a crash, budget stop, bounded-failure mistake limit, or an
 * attempt_completion whose result never actually populated), up to
 * `maxRetries` additional attempts. A real "pass" or "fail" is returned
 * immediately, first try.
 *
 * Mirrors reviewer.ts's runReviewWithRetries — same class of bug, same fix.
 * Caught live 2026-08-05 running issue #18's own round: a QA session ended
 * with no real result (`result.result === undefined` despite the
 * HeadlessSession itself reporting "success"), correctly classified as
 * verdict "error" by runQa — but `cli.ts` had nowhere to route that
 * distinctly from a real "fail": the group's top-level status stayed "done",
 * cost got recorded, and the round was silently considered fully settled
 * with an empty-evidence "failed" QA that nobody would ever look at again.
 */
export async function runQaWithRetries(options: RunQaOptions, maxRetries = 2): Promise<QaResult> {
	let last: QaResult = { verdict: "error", evidence: "", summary: "no attempt made" }
	for (let attempt = 0; attempt <= maxRetries; attempt++) {
		last = await runQa(options)
		if (last.verdict !== "error") {
			return last
		}
	}
	return last
}

/**
 * Parse a QA session's final report into { verdict, evidence, summary }.
 *
 * Deterministic + tested:
 *   - "pass"  — explicit pass markers (QA PASS, all tests pass, no errors
 *               found, definition of done satisfied, `errors: []`, …).
 *   - "fail"  — explicit fail markers (QA FAIL, does not work, definition of
 *               done NOT met) — deliberately narrow, see below;
 *   - default "fail" when neither is stated (FAIL-CLOSED: an inconclusive QA
 *     report never gates a deploy through).
 *
 * The fail-marker list is deliberately narrow — the SAME class of bug as
 * `reviewer.ts`'s parseReviewResult, found in the same incident: it used to
 * include bare "failed"/"failure"/"failures found"/"errors found"/"bug"/
 * "regression"/"broken"/"failing" ANYWHERE in the report. A QA report citing
 * real baseline test counts ("12 failed, 1187 passed" — pre-existing on
 * master, unrelated to the change) contains the bare word "failed", which
 * alone tripped the fail branch — and fail always wins over pass in this
 * function's logic, so ANY QA report mentioning ordinary baseline numbers
 * would be force-classified as "fail" even when QA genuinely passed. The
 * negative lookbehind `(?<!no\s)failed` only protects the exact phrase "no
 * failed" — it does nothing for "12 failed", which is the actual shape
 * baseline reporting takes. Narrowed to `qa fail` / `definition of done
 * not` / `does not work` — explicit, structured verdict language, not
 * incidental words that show up constantly in normal test-output prose.
 * Do not add generic words back without a specific report shape that needs
 * them AND a test proving no false-positive on baseline/prose language.
 *
 * Evidence: an `## Evidence` / `Evidence:` section when present, else the full
 * summary text (which still contains the real command output).
 */
export function parseQaResult(text: string): QaResult {
	const summary = text.trim()
	const lower = summary.toLowerCase()

	// Extract an "## Evidence" / "Evidence:" section if present.
	let evidence = ""
	const section = summary.match(
		/(?:^|\n)(?:#{1,6}\s*)?evidence\s*:?\s*\n([\s\S]*?)(?=\n#{1,6}\s|\n\s*(?:verdict|summary)\b|\s*$)/i,
	)
	if (section?.[1]) {
		evidence = section[1].trim()
	}

	// Primary path: an explicit, structured "QA_VERDICT: PASS"/"QA_VERDICT: FAIL"
	// line (required by defaultTaskText) is authoritative — exact match, no
	// heuristics. Same rationale as reviewer.ts's parseReviewResult: free-form
	// regex heuristics on prose have no ceiling on false positives (a real
	// incident here — baseline "N failed" test counts forced a fail verdict on
	// a QA session that explicitly said "QA PASS").
	const structuredVerdict = summary.match(/^QA_VERDICT:\s*(PASS|FAIL)\s*$/im)
	if (structuredVerdict) {
		const verdict: QaVerdict = structuredVerdict[1]!.toUpperCase() === "PASS" ? "pass" : "fail"
		return { verdict, evidence: evidence || summary, summary }
	}

	// Fallback for a session that didn't emit the required line.
	const hasPassMarker =
		/\b(qa\s*pass|all\s*tests?\s*pass|no\s+errors?\s+found|no\s+failures|definition\s+of\s+done\s+(is\s+|was\s+)?(met|satisfied)|errors?\s*:\s*\[\s*\]|passed\s+(\d+)\/\d+|verified\s+ok)\b/i.test(
			lower,
		)
	const hasFailMarker = /\b(qa\s*fail|definition\s+of\s+done\s+not|does\s+not\s+work)\b/i.test(lower)

	let verdict: QaVerdict
	if (hasPassMarker && !hasFailMarker) {
		verdict = "pass"
	} else if (hasFailMarker) {
		verdict = "fail"
	} else {
		// Fail-closed: no explicit verdict → do not pass.
		verdict = "fail"
	}

	return { verdict, evidence: evidence || summary, summary }
}
