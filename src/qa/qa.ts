/**
 * Headless QA (Phase 4) — run the target repo's `qa-agent` mode headlessly.
 *
 * Decision documented in docs/phase4-qa.md: the airunner `qa-agent` mode's
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

import { HeadlessSession } from "../engine/loop.js"
import { OpenRouterClient } from "../llm/openrouter.js"
import { appendBrowserActionTool, appendCodeIntelTools, loadCustomModes } from "../engine/prompt.js"
import { createQaHeadlessExecutor } from "../tools/executor.js"
import { getNativeTools } from "../vendor/zoo-code/src/core/prompts/tools/native-tools/index.js"
import type { ChatTool, LlmClient, SessionResult } from "../engine/types.js"
import type { MemoryStore } from "../memory/types.js"

/** Default mode slug used for QA sessions (the airunner qa-agent mode). */
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
	"   block; set a timeout on every wait loop and every command.",
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
	/** Mode slug (default: `qa-agent` — the airunner QA mode, auto-spliced). */
	mode?: string
	/** Model id (default: env OPENROUTER_MODEL / client default). */
	model?: string
	/** LLM client; inject a fake in tests (default: OpenRouterClient). */
	llmClient?: LlmClient
	/** OpenRouter base URL override (e2e points this at the mock server). */
	baseUrl?: string
	/** Loop iteration cap (default: 50). */
	maxIterations?: number
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
		`(branch: ${currentBranch(workspaceRoot)}, mode: ${mode}). Boot the app, run the relevant ` +
		`test suite, exercise the changed behavior, and report EVIDENCE with real command output. ` +
		`When you are done, call attempt_completion with a structured summary: a verdict line ` +
		`(QA PASS or QA FAIL), an Evidence section with the real commands you ran and their ` +
		`output, and the final baseline numbers you personally confirmed.`
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
		maxIterations = 50,
		memory = null,
		project,
	} = options

	// Detect whether the target repo actually defines the requested mode. If
	// not, fall back to the generic checklist as a system prompt override.
	const customModes = await loadCustomModes(workspaceRoot)
	const modeExists = customModes.some((m) => m.slug === mode)
	const systemPromptOverride = modeExists ? undefined : GENERIC_QA_CHECKLIST

	const client =
		llmClient ??
		new OpenRouterClient({ apiKey: process.env.HEADLESSCODE_OPENROUTER_API_KEY, defaultModel: model, baseUrl })

	const session = new HeadlessSession({
		workspaceRoot,
		mode,
		model,
		taskText: options.taskText ?? defaultTaskText(workspaceRoot, mode),
		maxIterations,
		systemPromptOverride,
		tools: qaTools(),
		executor: createQaHeadlessExecutor(workspaceRoot),
		llmClient: client,
		memory,
		project,
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
	return parseQaResult(result.result)
}

/**
 * Parse a QA session's final report into { verdict, evidence, summary }.
 *
 * Deterministic + tested:
 *   - "pass"  — explicit pass markers (QA PASS, all tests pass, no errors
 *               found, definition of done satisfied, `errors: []`, …).
 *   - "fail"  — explicit fail markers (QA FAIL, failed, errors found, bug,
 *               regression, does not work, definition of done NOT met, …).
 *   - default "fail" when neither is stated (FAIL-CLOSED: an inconclusive QA
 *     report never gates a deploy through).
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

	const hasPassMarker =
		/\b(qa\s*pass|all\s*tests?\s*pass|no\s+errors?\s+found|no\s+failures|definition\s+of\s+done\s+(is\s+|was\s+)?(met|satisfied)|errors?\s*:\s*\[\s*\]|passed\s+(\d+)\/\d+|verified\s+ok)\b/i.test(
			lower,
		)
	// Fail markers use negative lookbehind so "no errors found" / "no failures
	// found" (pass statements) never trip the fail branch. Lookbehinds honor
	// the /i flag, so "No errors found" is also protected.
	const hasFailMarker =
		/\b(qa\s*fail|(?<!no\s)failed|(?<!no\s)failure|(?<!no\s)failures?\s+found|(?<!no\s)errors?\s+found|bug|regression|does\s+not\s+work|broken|definition\s+of\s+done\s+not|failing)\b/i.test(
			lower,
		)

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
