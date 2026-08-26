/**
 * Stage-isolated pipeline sequencing (issue #148).
 *
 * Generalizes the reviewer pattern (src/orchestrator/reviewer.ts) from ONE
 * stage — review — to the pipeline stages that need it: research (produce a
 * finding doc) and filing (turn that doc into a real GitHub issue). Each
 * stage runs as a genuinely FRESH `HeadlessSession` (in-process, own
 * context, own mode, own executor) that takes the PRIOR STAGE'S ARTIFACT as
 * input — never the prior stage's raw conversation — exactly as
 * `runReview`/`parseReviewResult` already do for review and `--plan-first`
 * does for planning.
 *
 * This is deliberately NOT the per-worker subprocess spawn path
 * (`run-worker.sh`): those already give process isolation between worktrees.
 * This layer is for the stages that run IN-PROCESS today as one continuous
 * session (the top-level explore→file→implement→review pipeline), so each
 * one gets the same fresh-context treatment review already has.
 *
 * Design notes:
 * - The research stage binds `requireArtifactPathPattern` /
 *   `requireArtifactMinCitations` / `requireArtifactSections` BY DEFAULT —
 *   the CLI flags exist (src/cli.ts) but nothing binds them per-mode; a
 *   researcher session must not complete without a real, well-cited doc on
 *   disk at the known path.
 * - The filing stage's task input is built from the research doc's CONTENT
 *   read off disk (not the research session's conversation), and its result
 *   is parsed deterministically (mirroring `parseReviewResult`) into the
 *   real issue number(s) `gh issue create` returned.
 */

import * as fsSync from "node:fs"
import * as fsp from "node:fs/promises"
import * as path from "node:path"

import { HeadlessSession } from "../engine/loop.js"
import { Logger } from "../engine/logger.js"
import { OpenRouterClient } from "../llm/openrouter.js"
import { OllamaClient } from "../llm/ollama.js"
import { loadCustomModes, selectToolsForMode } from "../engine/prompt.js"
import { createHeadlessExecutor } from "../tools/executor.js"
import { resolvePerModeEnv } from "../cli.js"
import type { LlmClient, SessionResult } from "../engine/types.js"

/** Default path pattern for a research stage's artifact (relative to workspace). */
export const DEFAULT_RESEARCH_ARTIFACT_PATTERN = "research/*.md"

/** Default minimum real file:line citations the research doc must contain. */
export const DEFAULT_RESEARCH_MIN_CITATIONS = 3

/** Default required section headings in the research doc. */
export const DEFAULT_RESEARCH_SECTIONS = ["Finding", "What to build", "What NOT to do", "How to verify"]

/** Mode slug the research stage runs (defined in .roomodes). */
export const RESEARCH_MODE = "researcher"

/** Mode slug the filing stage runs (defined in .roomodes). */
export const FILER_MODE = "issue-filer"

/** Max iterations for a stage session (research/filing are bounded, short). */
export const STAGE_MAX_ITERATIONS = 60

// ─── Types ──────────────────────────────────────────────────────────────────

export interface PipelineStageOptions {
	/** The worktree/repo the stage runs against. */
	workspaceRoot: string
	/** Mode slug for the stage session (default: stage's own). */
	mode?: string
	/** Model id (default: env OPENROUTER_MODEL / client default). */
	model?: string
	/** LLM client; inject a fake in tests (default: OpenRouterClient). */
	llmClient?: LlmClient
	/** Per-stage iteration cap (default: STAGE_MAX_ITERATIONS). */
	maxIterations?: number
}

export interface ResearchStageOptions extends PipelineStageOptions {
	/** Task text for the research session (default: built from the workspace). */
	taskText?: string
	/**
	 * Glob (relative to workspaceRoot) that the research doc must match on
	 * disk at completion. Bound by default — the research stage is the one
	 * that needs the artifact gate as a structural guarantee, not a
	 * per-invocation flag.
	 */
	artifactPathPattern?: string
	/** Minimum real file:line citations the doc must contain. */
	minCitations?: number
	/** Required section headings (case-insensitive substring match). */
	sections?: string[]
}

export interface ResearchStageResult {
	/** Path (absolute) of the research doc on disk, when produced. */
	artifactPath?: string
	/** Status: ok = doc produced + artifact gate passed; error = session/artifact failure. */
	status: "ok" | "error"
	/** The session's final summary. */
	summary: string
}

export interface FilingStageOptions extends PipelineStageOptions {
	/** Task text for the filing session (default: built from the research doc). */
	taskText?: string
	/**
	 * Path of the research doc whose CONTENT becomes the filing task input
	 * (read off disk — never the research session's conversation).
	 */
	researchArtifactPath?: string
}

export interface FilingStageResult {
	/** Real GitHub issue number(s) parsed from the session's completion. */
	issueNumbers: number[]
	/** Status: ok = at least one issue number parsed; error = none found. */
	status: "ok" | "error"
	/** The session's final summary. */
	summary: string
}

// ─── LLM client resolution (mirrors reviewer.ts) ─────────────────────────────

function resolveStageClient(mode: string, model?: string, llmClient?: LlmClient): LlmClient {
	if (llmClient) {
		return llmClient
	}
	const useLocalBackend =
		process.env.HEADLESSCODE_CODE_MODE_BACKEND === "ollama" &&
		(process.env.HEADLESSCODE_LOCAL_BACKEND_MODES ?? "code")
			.split(",")
			.map((s) => s.trim())
			.filter(Boolean)
			.includes(mode)
	if (useLocalBackend) {
		return new OllamaClient({
			baseUrl: resolvePerModeEnv("HEADLESSCODE_OLLAMA_URL", mode),
			defaultModel: resolvePerModeEnv("HEADLESSCODE_CODE_MODE_MODEL", mode) ?? model,
		})
	}
	return new OpenRouterClient({ apiKey: process.env.HEADLESSCODE_OPENROUTER_API_KEY, defaultModel: model })
}

function buildLogger(workspaceRoot: string, label: string): Logger {
	const logFilePath = path.join(workspaceRoot, `${label}.log`)
	fsSync.appendFileSync(
		logFilePath,
		`\n===== headlesscode ${label} stage start: ${new Date().toISOString()} =====\n`,
		"utf-8",
	)
	return new Logger({ level: "info", filePath: logFilePath })
}

// ─── Research stage ──────────────────────────────────────────────────────────

export function defaultResearchTaskText(workspaceRoot: string, artifactPathPattern: string): string {
	return (
		`Research the codebase in this workspace exactly as your operating procedure instructs, and ` +
		`produce ONE written research document. Your task text names an exact output path — that path ` +
		`is your deliverable, not a suggestion.\n\n` +
		`Write the document to a path matching \`${artifactPathPattern}\` (relative to this workspace ` +
		`root). The document MUST contain:\n` +
		`- at least one clearly-labeled "Finding" section;\n` +
		`- a "What to build" section proposing the concrete change;\n` +
		`- a "What NOT to do" section bounding scope;\n` +
		`- a "How to verify" section with real checkable steps.\n\n` +
		`Ground every claim in real file:line citations from files you actually opened ` +
		`(e.g. \`src/engine/loop.ts:123\`) — never invent a citation. Any scratch you need goes in ` +
		`\`.headlesscode/scratch/\` inside this workspace — NEVER write to \`/tmp\` or any other path ` +
		`outside the workspace.\n\n` +
		`You do NOT implement anything, and you do NOT decide there is a different, better task to ` +
		`work on. When the document exists on disk with real content, call attempt_completion naming ` +
		`the path you wrote.`
	)
}

/**
 * Run the research stage: a fresh, bounded `researcher`-mode session that
 * must produce a real, well-cited `.md` doc on disk (artifact gate bound by
 * default). Returns the artifact path when the gate passed.
 */
export async function runResearchStage(options: ResearchStageOptions): Promise<ResearchStageResult> {
	const {
		workspaceRoot,
		mode = RESEARCH_MODE,
		model,
		llmClient,
		maxIterations = STAGE_MAX_ITERATIONS,
		artifactPathPattern = DEFAULT_RESEARCH_ARTIFACT_PATTERN,
		minCitations = DEFAULT_RESEARCH_MIN_CITATIONS,
		sections = DEFAULT_RESEARCH_SECTIONS,
	} = options

	const customModes = await loadCustomModes(workspaceRoot)
	const tools = selectToolsForMode(mode, customModes)
	// The researcher writes a markdown doc — it needs the write tools, but
	// the mode's own `edit` group already restricts to `*.md`; the executor
	// is the full headless one (write_to_file registered) so the artifact
	// can actually be created.
	const executor = createHeadlessExecutor(workspaceRoot)

	const session = new HeadlessSession({
		workspaceRoot,
		mode,
		model,
		taskText: options.taskText ?? defaultResearchTaskText(workspaceRoot, artifactPathPattern),
		maxIterations,
		tools,
		executor,
		customModes,
		llmClient: resolveStageClient(mode, model, llmClient),
		logger: buildLogger(workspaceRoot, "research"),
		// Structural guarantee: the research stage REQUIRES a real artifact
		// on disk before attempt_completion is accepted.
		requireArtifactPathPattern: artifactPathPattern,
		requireArtifactMinCitations: minCitations,
		requireArtifactSections: sections,
	})

	const result: SessionResult = await session.run()
	if (result.status !== "success" || result.result === undefined) {
		return {
			status: "error",
			summary: `Research session failed: ${result.error ?? "unknown error"}`,
		}
	}

	// The artifact gate already confirmed a matching file exists on disk at
	// completion; resolve its real path for the caller (first match).
	const artifactPath = await firstMatchingArtifact(workspaceRoot, artifactPathPattern)
	if (!artifactPath) {
		return {
			status: "error",
			summary: "Research session completed but no artifact matching the required pattern was found on disk",
		}
	}
	return { status: "ok", artifactPath, summary: result.result }
}

// ─── Filing stage ────────────────────────────────────────────────────────────

export function defaultFilingTaskText(researchArtifactPath: string, researchContent: string): string {
	return (
		`File REAL GitHub issue(s) from the research finding below, exactly as your operating ` +
		`procedure instructs. The finding was produced by an earlier research stage and is ` +
		`already well-scoped — you do NOT investigate from scratch.\n\n` +
		`Use \`gh issue create\` to file the issue(s) in the repo that owns this workspace. ` +
		`Confirm the repo with \`gh repo view --json nameWithOwner -q .nameWithOwner\` first, ` +
		`check for duplicates, and report EVERY issue URL \`gh issue create\` returned — never ` +
		`claim an issue was filed without the real URL.\n\n` +
		`Your attempt_completion result MUST end with a line of the exact form:\n` +
		`ISSUES: <number1>, <number2>, ...\n` +
		`listing every issue number you actually filed. Nothing else on that line — this is the ` +
		`only line the orchestrator parses.\n\n` +
		`===== Research finding =====\n${researchContent}`
	)
}

/**
 * Run the filing stage: a fresh `issue-filer`-mode session whose task input
 * is built from the RESEARCH DOC'S CONTENT read off disk (never the research
 * session's conversation). Parses the real issue number(s) from the
 * completion deterministically.
 */
export async function runFilingStage(options: FilingStageOptions): Promise<FilingStageResult> {
	const {
		workspaceRoot,
		mode = FILER_MODE,
		model,
		llmClient,
		maxIterations = STAGE_MAX_ITERATIONS,
	} = options

	let taskText = options.taskText
	if (taskText === undefined) {
		if (!options.researchArtifactPath) {
			return {
				status: "error",
				summary: "Filing stage requires either taskText or researchArtifactPath",
				issueNumbers: [],
			}
		}
		let content = ""
		try {
			content = await fsp.readFile(options.researchArtifactPath, "utf-8")
		} catch (err) {
			return {
				status: "error",
				summary: `Filing stage could not read research artifact: ${err instanceof Error ? err.message : String(err)}`,
				issueNumbers: [],
			}
		}
		taskText = defaultFilingTaskText(options.researchArtifactPath, content)
	}

	const customModes = await loadCustomModes(workspaceRoot)
	const tools = selectToolsForMode(mode, customModes)
	const executor = createHeadlessExecutor(workspaceRoot)

	const session = new HeadlessSession({
		workspaceRoot,
		mode,
		model,
		taskText,
		maxIterations,
		tools,
		executor,
		customModes,
		llmClient: resolveStageClient(mode, model, llmClient),
		logger: buildLogger(workspaceRoot, "filer"),
	})

	const result: SessionResult = await session.run()
	if (result.status !== "success" || result.result === undefined) {
		return {
			status: "error",
			summary: `Filing session failed: ${result.error ?? "unknown error"}`,
			issueNumbers: [],
		}
	}

	return { ...parseFilingResult(result.result), summary: result.result }
}

/**
 * Parse a filing session's completion into real issue number(s).
 *
 * Deterministic: looks for the required `ISSUES: <n1>, <n2>` line (exact
 * match), then falls back to any `#\d+` references that look like the URLs
 * `gh issue create` returns. Returns `status: "error"` (not a partial-ok)
 * when NO issue number could be parsed — an unverifiable filing claim must
 * not be trusted, mirroring the reviewer's fail-closed verdict.
 */
export function parseFilingResult(text: string): { issueNumbers: number[]; status: "ok" | "error" } {
	const summary = text.trim()

	// Primary path: the required exact `ISSUES: n1, n2` line.
	const structured = summary.match(/^ISSUES\s*:\s*([\d,\s]+)\s*$/im)
	if (structured?.[1]) {
		const numbers = structured[1]
			.split(/[\s,]+/)
			.map((s) => Number(s))
			.filter((n) => Number.isInteger(n) && n > 0)
		if (numbers.length > 0) {
			return { issueNumbers: [...new Set(numbers)], status: "ok" }
		}
	}

	// Fallback: any issue URL `gh issue create` returns looks like
	// `https://github.com/<owner>/<repo>/issues/<n>` — pull the numbers from
	// those, but ONLY from real URL-shaped references (a bare "#42" in prose
	// is not proof of a filed issue).
	const urlNumbers = [...summary.matchAll(/github\.com\/[^/\s]+\/[^/\s]+\/issues\/(\d+)/gi)].map((m) =>
		Number(m[1]),
	)
	const unique = [...new Set(urlNumbers)].filter((n) => Number.isInteger(n) && n > 0)
	if (unique.length > 0) {
		return { issueNumbers: unique, status: "ok" }
	}

	return { issueNumbers: [], status: "error" }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Return the absolute path of the first file matching a single-directory
 * glob pattern (relative to workspaceRoot) that is real and non-empty.
 * Mirrors the artifact gate's own `matchingArtifactFileStatus` semantics for
 * the caller-facing result.
 */
async function firstMatchingArtifact(workspaceRoot: string, pattern: string): Promise<string | undefined> {
	const base = path.resolve(workspaceRoot)
	const dir = path.posix.dirname(pattern)
	const fileGlob = path.posix.basename(pattern)
	const dirAbs = path.resolve(base, dir)
	if (!dirAbs.startsWith(base + path.sep) && dirAbs !== base) {
		return undefined
	}
	let entries: fsSync.Dirent[]
	try {
		entries = fsSync.readdirSync(dirAbs, { withFileTypes: true })
	} catch {
		return undefined
	}
	// Convert the glob's `*` into a regex (only `*` is used in practice).
	const re = new RegExp(`^${fileGlob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`)
	for (const entry of entries) {
		if (!entry.isFile()) {
			continue
		}
		if (!re.test(entry.name)) {
			continue
		}
		const full = path.join(dirAbs, entry.name)
		try {
			const stat = fsSync.statSync(full)
			if (stat.size > 0) {
				return full
			}
		} catch {
			// ignore unreadable
		}
	}
	return undefined
}
