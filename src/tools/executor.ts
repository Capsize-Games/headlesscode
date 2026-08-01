/**
 * Headless tool executor.
 *
 * Implements the Phase 1 core tools using plain `fs` + `child_process` — NO
 * `vscode.*` anywhere. Argument names match the vendored native-tool schemas
 * exactly (see `src/vendor/zoo-code/src/core/prompts/tools/native-tools/`):
 *
 *   - read_file         { path, offset?, limit? }
 *   - write_to_file     { path, content }
 *   - execute_command   { command, cwd?, timeout? }
 *   - list_files        { path?, recursive? }
 *
 * Every file operation resolves relative to the configured workspace root and
 * is rejected if it escapes the workspace (path-traversal guard). Results are
 * plain strings + an { isError } flag; long outputs are truncated to keep the
 * model context bounded.
 */

import * as fs from "node:fs"
import * as fsp from "node:fs/promises"
import * as path from "node:path"
import { spawn } from "node:child_process"
import { setTimeout as sleep } from "node:timers/promises"

// Side effect: installs String.prototype.toPosix() used by path formatting.
import "../vendor/zoo-code/src/utils/path.js"

import type { ToolContext, ToolHandler, ToolResult } from "../engine/types.js"
import { checkCommand, type CommandRefusal } from "../permissions/commands.js"
import { findMatchingPattern } from "../permissions/protected-files.js"
import { resolvePermissions, type PermissionsConfig } from "../permissions/config.js"

/** Cap on tool-result text fed back to the model (keep context bounded). */
export const MAX_RESULT_CHARS = 30_000

/** Default execute_command timeout in seconds (matches vendored default ~120s). */
export const DEFAULT_COMMAND_TIMEOUT_S = 120

/** Max entries returned by list_files before truncation. */
export const MAX_LIST_FILES = 500

/** Options that configure a ToolExecutor's decision-escalation behavior. */
export interface ToolExecutorOptions {
	/** ask_followup_question escalation timeout, ms (default 30 min — see DEFAULT_DECISION_TIMEOUT_MS). */
	decisionTimeoutMs?: number
	/** ask_followup_question poll interval, ms (default 5s — override in tests). */
	decisionPollIntervalMs?: number
	/**
	 * Resolved permissions (command allow/deny + protected files). When absent
	 * the executor resolves them itself from env vars +
	 * `<workspaceRoot>/.headlesscode/permissions.json` + built-in defaults, so
	 * executors constructed without CLI flags (reviewer/QA, tests) still
	 * enforce the repo's committed policy.
	 */
	permissions?: PermissionsConfig
}

export class ToolExecutor {
	private readonly handlers = new Map<string, ToolHandler>()
	private pauseBudgetClock: (() => void) | undefined
	private resumeBudgetClock: (() => void) | undefined
	/** Resolved permissions handed to every handler call (see ToolExecutorOptions.permissions). */
	readonly permissions: PermissionsConfig

	constructor(
		readonly workspaceRoot: string,
		private readonly options: ToolExecutorOptions = {},
	) {
		this.permissions =
			options.permissions ?? resolvePermissions({ workspaceRoot: this.workspaceRoot, env: process.env })
	}

	register(name: string, handler: ToolHandler): void {
		this.handlers.set(name, handler)
	}

	has(name: string): boolean {
		return this.handlers.has(name)
	}

	names(): string[] {
		return [...this.handlers.keys()]
	}

	/**
	 * Wired by HeadlessSession right after it constructs a BudgetTracker, so
	 * ask_followup_question (and any future blocking tool) can pause the
	 * session's budget-duration clock while waiting on an external answer.
	 * Never called when no budget is configured.
	 */
	setBudgetClockHooks(pause: () => void, resume: () => void): void {
		this.pauseBudgetClock = pause
		this.resumeBudgetClock = resume
	}

	async execute(name: string, args: Record<string, unknown>): Promise<ToolResult> {
		const handler = this.handlers.get(name)
		if (!handler) {
			return {
				content: `[Error] Unknown tool: ${name}. This harness has no handler registered for it.`,
				isError: true,
			}
		}
		try {
			return await handler(args, {
				workspaceRoot: this.workspaceRoot,
				permissions: this.permissions,
				decisionTimeoutMs: this.options.decisionTimeoutMs,
				decisionPollIntervalMs: this.options.decisionPollIntervalMs,
				pauseBudgetClock: this.pauseBudgetClock,
				resumeBudgetClock: this.resumeBudgetClock,
			})
		} catch (err) {
			return {
				content: `[Error] Tool '${name}' failed: ${err instanceof Error ? err.message : String(err)}`,
				isError: true,
			}
		}
	}
}

// ─── Path safety ─────────────────────────────────────────────────────────────

export class PathTraversalError extends Error {
	constructor(requested: string, root: string) {
		super(`Path escapes the workspace root (${root}): ${requested}`)
		this.name = "PathTraversalError"
	}
}

/**
 * Resolve `p` against the workspace root and reject anything that escapes it.
 * Uses path.resolve + a containment check, mirroring the harness's Phase 1
 * requirement (no symlink-following resolution — lexical containment only).
 */
export function resolveWithinWorkspace(root: string, p: string): string {
	const rootAbs = path.resolve(root)
	const target = path.resolve(rootAbs, p)
	if (target !== rootAbs && !target.startsWith(rootAbs + path.sep)) {
		throw new PathTraversalError(p, rootAbs)
	}
	return target
}

/** Build a path-safety-checked absolute path, catching traversal errors. */
function safeTarget(ctx: ToolContext, p: string): string {
	return resolveWithinWorkspace(ctx.workspaceRoot, p)
}

// ─── Result helpers ──────────────────────────────────────────────────────────

function ok(content: string): ToolResult {
	return { content: truncate(content), isError: false }
}

function err(content: string): ToolResult {
	return { content: truncate(`[Error] ${content}`), isError: true }
}

/**
 * Build the model-facing refusal message for a blocked execute_command. The
 * tone matches the other err(...) messages in this file: name what was
 * refused and why, and give a well-behaved model a concrete way to adjust.
 */
function refusalMessage(command: string, refusal: CommandRefusal): ToolResult {
	switch (refusal.kind) {
		case "dangerous":
			return err(
				`execute_command: refusing to run '${command}': it contains a dangerous shell substitution pattern ` +
					`(e.g. \${var@P}, \${!var}, <<<\$(...), =(...), or *(e:...:)) which is ALWAYS blocked and cannot be ` +
					`allow-listed or configured away. Rewrite the command without shell parameter-expansion tricks.`,
			)
		case "malformed":
			return err(
				`execute_command: refusing to run '${command}': malformed command (` +
					`${refusal.parseError?.message ?? "shell syntax error"}) — a shell syntax error is never auto-approved. ` +
					`Fix the quoting and retry.`,
			)
		case "denied":
			return err(
				`execute_command: refusing to run '${command}': sub-command '${refusal.subCommand}' is denied by the ` +
					`permissions policy (matches denied pattern '${refusal.pattern}'). Adjust your approach; this command ` +
					`is not permitted even if other parts of the chain are allowed.`,
			)
		case "not_allowed":
			return err(
				`execute_command: refusing to run '${command}': sub-command '${refusal.subCommand}' is not in the ` +
					`allowed-commands list and cannot be auto-approved in this headless session. Add it via ` +
					`--allowed-commands, HEADLESSCODE_ALLOWED_COMMANDS, or <workspaceRoot>/.headlesscode/permissions.json, ` +
					`or adjust your approach.`,
			)
	}
}

function truncate(content: string): string {
	if (content.length <= MAX_RESULT_CHARS) {
		return content
	}
	return (
		content.slice(0, MAX_RESULT_CHARS) +
		`\n…[output truncated at ${MAX_RESULT_CHARS} chars to keep context bounded]`
	)
}

function requireString(args: Record<string, unknown>, key: string): string {
	const v = args[key]
	if (typeof v !== "string") {
		throw new Error(`Missing or invalid string argument '${key}' for tool`)
	}
	return v
}

function toNonNegativeInt(v: unknown, fallback: number): number {
	if (typeof v === "number" && Number.isFinite(v)) {
		return Math.max(0, Math.floor(v))
	}
	if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) {
		return Math.max(0, Math.floor(Number(v)))
	}
	return fallback
}

// ─── Tool handlers ───────────────────────────────────────────────────────────

/** read_file — slice mode with offset/limit pagination (offset is 1-based). */
function readFileHandler(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
	const filePath = requireString(args, "path")
	return (async () => {
		const target = safeTarget(ctx, filePath)
		const rel = path.relative(ctx.workspaceRoot, target).toPosix() || path.basename(target)

		let stat: fs.Stats
		try {
			stat = await fsp.stat(target)
		} catch (error) {
			return err(`read_file: cannot stat '${rel}': ${errorMessage(error)}`)
		}
		if (!stat.isFile()) {
			return err(`read_file: '${rel}' is not a file`)
		}

		const mode = typeof args.mode === "string" ? args.mode : "slice"
		const offset = toNonNegativeInt(args.offset, 1) // 1-based
		const limit = toNonNegativeInt(args.limit, 2000)

		let content: string
		try {
			content = await fsp.readFile(target, "utf-8")
		} catch (error) {
			return err(`read_file: cannot read '${rel}': ${errorMessage(error)}`)
		}

		const allLines = content.split(/\r?\n/)
		if (mode === "indentation") {
			// Phase 1 minimal: indentation mode falls back to a window around the
			// anchor line (anchor_line 1-based), which is good enough for the loop.
			const anchor = toNonNegativeInt(
				(args.indentation as Record<string, unknown> | undefined)?.["anchor_line"],
				offset,
			)
			const windowLines = toNonNegativeInt(
				(args.indentation as Record<string, unknown> | undefined)?.["max_lines"],
				60,
			)
			const start = Math.max(1, anchor)
			return ok(formatFileSlice(rel, allLines, start, windowLines))
		}

		return ok(formatFileSlice(rel, allLines, Math.max(1, offset), limit))
	})()
}

function formatFileSlice(rel: string, allLines: string[], offset: number, limit: number): string {
	const start = Math.max(1, offset)
	const slice = allLines.slice(start - 1, start - 1 + limit)
	const totalLines = allLines.length
	const body = slice.map((line, i) => `${start + i} | ${line}`).join("\n")

	const header = `File: ${rel}`
	if (totalLines > start - 1 + limit) {
		return `${header}\nShowing lines ${start}-${start + slice.length - 1} of ${totalLines} total lines (use read_file with offset=${start + limit} to read more).\n${body}`
	}
	return `${header}\n${body}`.replace(/\n$/, "")
}

/** write_to_file — create parent dirs as needed, overwrite existing files. */
function writeToFileHandler(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
	const filePath = requireString(args, "path")
	const content = requireString(args, "content")
	return (async () => {
		const target = safeTarget(ctx, filePath)
		const rel = path.relative(ctx.workspaceRoot, target).toPosix() || path.basename(target)

		// Permissions: refuse writes to protected files (secret/credential
		// patterns) unless the escape hatch — --allow-protected-writes or
		// "allowProtectedWrites": true in .headlesscode/permissions.json — is
		// explicitly on (OFF by default). Naming the matched pattern gives a
		// well-behaved model a concrete reason to stop. A refusal is a real
		// tool error (isError: true) and counts toward the consecutive-mistake
		// bound, exactly like any other tool failure.
		if (!ctx.permissions.allowProtectedWrites) {
			const matchedPattern = findMatchingPattern(rel, ctx.permissions.protectedFiles)
			if (matchedPattern !== null) {
				return err(
					`write_to_file: refusing to write protected file '${rel}' (matches protected pattern '${matchedPattern}'). ` +
						`This file is protected by the harness permissions policy and cannot be overwritten. If this write is ` +
						`genuinely required, re-run with --allow-protected-writes (or set "allowProtectedWrites": true in ` +
						`<workspaceRoot>/.headlesscode/permissions.json); it is OFF by default.`,
				)
			}
		}

		try {
			await fsp.mkdir(path.dirname(target), { recursive: true })
			await fsp.writeFile(target, content, "utf-8")
		} catch (error) {
			return err(`write_to_file: failed to write '${rel}': ${errorMessage(error)}`)
		}
		return ok(`File written: ${rel} (${Buffer.byteLength(content, "utf-8")} bytes)`)
	})()
}

/** execute_command — spawn via child_process, capture stdout+stderr, timeout. */
function executeCommandHandler(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
	const command = requireString(args, "command")
	const timeoutS = toNonNegativeInt(args.timeout, DEFAULT_COMMAND_TIMEOUT_S) || DEFAULT_COMMAND_TIMEOUT_S

	return (async () => {
		let cwd = ctx.workspaceRoot
		if (args.cwd != null && args.cwd !== "") {
			const cwdArg = requireString(args, "cwd")
			cwd = safeTarget(ctx, cwdArg)
		}

		// Permissions gate (command allow/deny + dangerous substitution):
		// refuse BEFORE spawning so nothing is ever executed. Compound
		// commands are checked per sub-command (parseCommand splits on
		// &&/||/;/|/&) — a denied or unallow-listed sub-command blocks the
		// whole chain. This applies to every executor built on this handler,
		// including the read-only reviewer/QA executors (they share it), which
		// also run unattended and could otherwise run arbitrary commands. A
		// refusal is a real tool error (isError: true) and therefore counts
		// toward the loop's consecutive-mistake bound, same as any tool error.
		const refusal = checkCommand(command, ctx.permissions.allowedCommands, ctx.permissions.deniedCommands)
		if (refusal !== null) {
			return refusalMessage(command, refusal)
		}

		return new Promise<ToolResult>((resolve) => {
			let stdout = ""
			let stderr = ""
			let settled = false

			const finish = (result: ToolResult) => {
				if (!settled) {
					settled = true
					resolve(result)
				}
			}

			let child
			try {
				child = spawn(command, { cwd, shell: true })
			} catch (error) {
				return finish(err(`execute_command: failed to spawn '${command}': ${errorMessage(error)}`))
			}

			const timer = setTimeout(() => {
				child.kill("SIGKILL")
			}, timeoutS * 1000)

			child.stdout?.on("data", (chunk) => {
				stdout += chunk.toString()
			})
			child.stderr?.on("data", (chunk) => {
				stderr += chunk.toString()
			})
			child.on("error", (error) => {
				clearTimeout(timer)
				finish(err(`execute_command: spawn error for '${command}': ${errorMessage(error)}`))
			})
			child.on("close", (code, signal) => {
				clearTimeout(timer)
				const combined = [stdout, stderr].filter(Boolean).join("\n")
				if (signal === "SIGKILL") {
					finish(
						err(
							`execute_command: command '${command}' timed out after ${timeoutS}s and was killed. Output so far:\n${combined}`,
						),
					)
					return
				}
				if (code !== 0) {
					finish(err(`execute_command: command '${command}' exited with code ${code}.\n${combined}`))
					return
				}
				finish(ok(combined === "" ? `(command completed with no output)` : combined))
			})
		})
	})()
}

/** list_files — top-level or recursive listing, dirs first, truncated. */
function listFilesHandler(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
	const dirPath = args.path == null || args.path === "" ? "." : requireString(args, "path")
	const recursive = args.recursive === true

	return (async () => {
		const target = safeTarget(ctx, dirPath)
		const rel = path.relative(ctx.workspaceRoot, target).toPosix() || path.basename(target) || "."

		let entries: Array<{ rel: string; isDir: boolean }> = []
		try {
			entries = await collectEntries(target, ctx.workspaceRoot, recursive)
		} catch (error) {
			return err(`list_files: cannot list '${rel}': ${errorMessage(error)}`)
		}

		// Sort dirs first, then alphabetically.
		entries.sort((a, b) => {
			if (a.isDir !== b.isDir) {
				return a.isDir ? -1 : 1
			}
			return a.rel.localeCompare(b.rel)
		})

		const lines = entries.slice(0, MAX_LIST_FILES).map((e) => (e.isDir ? `${e.rel}/` : e.rel))
		const truncated = entries.length > MAX_LIST_FILES ? `\n(File list truncated: ${MAX_LIST_FILES} of ${entries.length} entries shown. Use list_files on specific subdirectories to see more.)` : ""

		return ok(lines.length > 0 ? lines.join("\n") + truncated : "(empty directory)")
	})()
}

async function collectEntries(
	dir: string,
	root: string,
	recursive: boolean,
	depth = 0,
): Promise<Array<{ rel: string; isDir: boolean }>> {
	if (depth > 32) {
		return []
	}
	const dirents = await fsp.readdir(dir, { withFileTypes: true })
	const out: Array<{ rel: string; isDir: boolean }> = []
	for (const ent of dirents) {
		const abs = path.join(dir, ent.name)
		const rel = path.relative(root, abs).toPosix() || ent.name
		if (ent.isDirectory()) {
			out.push({ rel, isDir: true })
			if (recursive) {
				out.push(...(await collectEntries(abs, root, recursive, depth + 1)))
			}
		} else {
			out.push({ rel, isDir: false })
		}
	}
	return out
}

/** attempt_completion — the loop intercepts this; registering it keeps the executor total. */
function attemptCompletionHandler(args: Record<string, unknown>): ToolResult {
	const result = typeof args.result === "string" ? args.result : JSON.stringify(args)
	return ok(result)
}

/** Marker basenames, relative to the workspace root (mirrors the .harness.* idiom). */
const NEEDS_DECISION_FILENAME = ".harness.needs-decision"
const DECISION_ANSWER_FILENAME = ".harness.decision-answer"

/** Default ask_followup_question escalation timeout: 30 minutes. */
export const DEFAULT_DECISION_TIMEOUT_MS = 1_800_000
/** Default poll interval while waiting for an answer, matching watch.ts's DEFAULT_POLL_INTERVAL_MS. */
export const DEFAULT_DECISION_POLL_INTERVAL_MS = 5_000

/** Today's non-interactive fallback text — reused verbatim on timeout (see file header). */
function autonomousDecisionError(question: string): ToolResult {
	return {
		content: `[Non-interactive] This headless harness cannot display questions or collect answers. The model must decide autonomously. (Question asked: ${question})`,
		isError: true,
	}
}

/** Extract suggestion text from the `follow_up` arg (see the vendored native-tool schema). */
function extractSuggestions(followUp: unknown): string[] | undefined {
	if (!Array.isArray(followUp)) {
		return undefined
	}
	const texts = followUp
		.map((item) => (item !== null && typeof item === "object" ? (item as Record<string, unknown>).text : undefined))
		.filter((t): t is string => typeof t === "string" && t.length > 0)
	return texts.length > 0 ? texts : undefined
}

async function safeUnlink(p: string): Promise<void> {
	try {
		await fsp.unlink(p)
	} catch {
		// Already gone / never existed — fine either way.
	}
}

/**
 * ask_followup_question — decision escalation (workstream 2).
 *
 * Writes `<workspaceRoot>/.harness.needs-decision` (JSON: question,
 * suggestions?, askedAt), then polls for `<workspaceRoot>/.harness.decision-
 * answer` every `decisionPollIntervalMs` (default 5s) up to
 * `decisionTimeoutMs` (default 30min). The session's budget-duration clock is
 * paused for the duration of the wait (see pauseBudgetClock/resumeBudgetClock
 * on ToolContext).
 *
 * - Answer arrives in time: both marker files are deleted and the answer text
 *   is returned as a NORMAL (non-error) tool result — the model continues
 *   with real input, and this does NOT count toward the loop's consecutive-
 *   mistake bounded-failure limit.
 * - Timeout elapses: the needs-decision marker is deleted (a log line notes
 *   the timeout) and the handler falls back to EXACTLY today's behavior — the
 *   "must decide autonomously" tool error, which DOES count as a mistake.
 */
async function askFollowupQuestionHandler(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
	const question = typeof args.question === "string" ? args.question : "(no question)"
	const suggestions = extractSuggestions(args.follow_up)
	const askedAt = new Date().toISOString()

	const needsDecisionPath = path.join(ctx.workspaceRoot, NEEDS_DECISION_FILENAME)
	const answerPath = path.join(ctx.workspaceRoot, DECISION_ANSWER_FILENAME)
	const timeoutMs = ctx.decisionTimeoutMs ?? DEFAULT_DECISION_TIMEOUT_MS
	const pollIntervalMs = ctx.decisionPollIntervalMs ?? DEFAULT_DECISION_POLL_INTERVAL_MS

	try {
		await fsp.writeFile(
			needsDecisionPath,
			JSON.stringify({ question, ...(suggestions ? { suggestions } : {}), askedAt }, null, 2) + "\n",
			"utf-8",
		)
	} catch (error) {
		// Can't even signal escalation (e.g. read-only workspace) — fall back
		// immediately to today's behavior rather than blocking on a wait no one
		// can ever answer.
		process.stderr.write(
			`[headlesscode] ask_followup_question: failed to write ${NEEDS_DECISION_FILENAME}, falling back to autonomous decision: ${errorMessage(error)}\n`,
		)
		return autonomousDecisionError(question)
	}

	ctx.pauseBudgetClock?.()
	try {
		const deadline = Date.now() + timeoutMs
		while (Date.now() < deadline) {
			let answer: string | undefined
			try {
				answer = await fsp.readFile(answerPath, "utf-8")
			} catch {
				answer = undefined
			}
			if (answer !== undefined) {
				await safeUnlink(needsDecisionPath)
				await safeUnlink(answerPath)
				return ok(`[Human/orchestrator answer received] ${answer.trim()}`)
			}
			const remaining = deadline - Date.now()
			if (remaining <= 0) {
				break
			}
			await sleep(Math.min(pollIntervalMs, remaining))
		}
	} finally {
		ctx.resumeBudgetClock?.()
	}

	// Timed out: fall back to exactly today's behavior.
	process.stderr.write(
		`[headlesscode] ask_followup_question: timed out after ${timeoutMs}ms waiting for ${DECISION_ANSWER_FILENAME}, falling back to autonomous decision.\n`,
	)
	await safeUnlink(needsDecisionPath)
	return autonomousDecisionError(question)
}

/** Stub for vendored tools that Phase 1 does not implement headlessly. */
function stubHandler(name: string): ToolHandler {
	return () =>
		err(
			`Tool '${name}' is not implemented in the headless harness yet. Phase 1 implements: read_file, write_to_file, execute_command, list_files. Adapt and retry with one of those.`,
		)
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error)
}

// ─── Registry ────────────────────────────────────────────────────────────────

/** All tool names the vendored getNativeTools() may expose, for stubbing. */
const VENDORED_TOOL_NAMES = [
	"access_mcp_resource",
	"apply_diff",
	"apply_patch",
	"ask_followup_question",
	"attempt_completion",
	"codebase_search",
	"execute_command",
	"generate_image",
	"list_files",
	"new_task",
	"read_command_output",
	"read_file",
	"run_slash_command",
	"skill",
	"search_replace",
	"edit_file",
	"edit",
	"search_files",
	"switch_mode",
	"update_todo_list",
	"write_to_file",
] as const

const IMPLEMENTED_TOOLS = new Set(["read_file", "write_to_file", "execute_command", "list_files"])

/**
 * Create the default Phase 1 executor for a workspace root: the 4 core tools,
 * attempt_completion + ask_followup_question handlers, and stubs for every
 * other vendored tool schema.
 */
export function createHeadlessExecutor(workspaceRoot: string, options: ToolExecutorOptions = {}): ToolExecutor {
	const executor = new ToolExecutor(workspaceRoot, options)

	executor.register("read_file", readFileHandler)
	executor.register("write_to_file", writeToFileHandler)
	executor.register("execute_command", executeCommandHandler)
	executor.register("list_files", listFilesHandler)

	executor.register("attempt_completion", attemptCompletionHandler)
	executor.register("ask_followup_question", askFollowupQuestionHandler)

	for (const name of VENDORED_TOOL_NAMES) {
		if (executor.has(name) || IMPLEMENTED_TOOLS.has(name)) {
			continue
		}
		executor.register(name, stubHandler(name))
	}

	return executor
}

/**
 * Create a READ-ONLY executor for the reviewer mode (Phase 2) and the QA mode
 * (Phase 4): the non-edit discipline is enforced at the executor level —
 * `write_to_file` is NOT registered at all, so any attempt to modify files
 * fails with a clear "not implemented" error. Only read_file / list_files /
 * execute_command (used to re-run tests, git diff, `gh` commands, boot the
 * app) plus attempt_completion / ask_followup_question are available; every
 * other vendored tool is a stub.
 *
 * Phase 4 decision: a QA agent may RUN the application and test suites (it
 * needs execute_command) but must NOT be able to modify source files
 * unexpectedly — QA verifies and reports; remediation is a separate worker
 * cycle. The mode's `edit` group is therefore never honored here: write
 * tools are absent from BOTH the executor and the tool list advertised to
 * the model (see src/qa/qa.ts `qaTools()`).
 */
function createReadCommandExecutor(workspaceRoot: string, options: ToolExecutorOptions = {}): ToolExecutor {
	const executor = new ToolExecutor(workspaceRoot, options)

	executor.register("read_file", readFileHandler)
	executor.register("list_files", listFilesHandler)
	executor.register("execute_command", executeCommandHandler)

	executor.register("attempt_completion", attemptCompletionHandler)
	executor.register("ask_followup_question", askFollowupQuestionHandler)

	for (const name of VENDORED_TOOL_NAMES) {
		if (executor.has(name) || name === "write_to_file") {
			continue
		}
		executor.register(name, stubHandler(name))
	}

	return executor
}

/** Reviewer executor (Phase 2): read + command, no write. See above. */
export function createReadOnlyHeadlessExecutor(workspaceRoot: string, options: ToolExecutorOptions = {}): ToolExecutor {
	return createReadCommandExecutor(workspaceRoot, options)
}

/**
 * QA executor (Phase 4): read + command, no write. Functionally identical to
 * the reviewer executor, but named for the QA role so the intent is explicit
 * at every call site: the QA agent can boot the app and run tests via
 * execute_command, but cannot modify source files (no write_to_file).
 */
export function createQaHeadlessExecutor(workspaceRoot: string, options: ToolExecutorOptions = {}): ToolExecutor {
	return createReadCommandExecutor(workspaceRoot, options)
}
