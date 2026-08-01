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
import { spawn, type ChildProcess } from "node:child_process"
import { setTimeout as sleep } from "node:timers/promises"

// Side effect: installs String.prototype.toPosix() used by path formatting.
import "../vendor/zoo-code/src/utils/path.js"

import type { ToolContext, ToolHandler, ToolResult } from "../engine/types.js"

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
}

export class ToolExecutor {
	private readonly handlers = new Map<string, ToolHandler>()
	private pauseBudgetClock: (() => void) | undefined
	private resumeBudgetClock: (() => void) | undefined

	constructor(
		readonly workspaceRoot: string,
		private readonly options: ToolExecutorOptions = {},
	) {}

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

	/**
		* Session teardown: hard-kill any execute_command children that a timeout
		* left running in the background (see executeCommandHandler). A single tool
		* call timing out mid-session does NOT trigger this — the backgrounded
		* process is exactly what the model asked for and must keep running until
		* the model cleans it up or the session truly ends. Only calling this at
		* true session end does, so nothing is orphaned past its session.
		*/
	dispose(): void {
		killBackgroundCommands()
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

		try {
			await fsp.mkdir(path.dirname(target), { recursive: true })
			await fsp.writeFile(target, content, "utf-8")
		} catch (error) {
			return err(`write_to_file: failed to write '${rel}': ${errorMessage(error)}`)
		}
		return ok(`File written: ${rel} (${Buffer.byteLength(content, "utf-8")} bytes)`)
	})()
}

// ─── execute_command backgrounded-child registry ─────────────────────────────

/**
 * Children that timed out and were intentionally left running in the
 * background (see executeCommandHandler). Tracked for exactly two reasons:
 *   (a) their stdout/stderr pipes keep being drained so a long-running child
 *       never blocks on a full pipe buffer, and
 *   (b) `ToolExecutor.dispose()` can hard-kill anything still running when a
 *       session truly ends, so the harness never orphans a process.
 * A later `execute_command` mid-session (e.g. `pkill`, `docker compose down`)
 * works unchanged — the model targets the process by port/name/pattern, same
 * as a human would.
 */
const backgroundCommands = new Set<ChildProcess>()

/** Best-effort unref of a stdio pipe so it can't keep the event loop alive. */
function unrefStream(stream: NodeJS.ReadableStream | null): void {
	try {
		// child.stdout/stderr are net.Socket instances at runtime but typed as
		// Readable, so feature-detect `unref` rather than casting to Socket.
		;(stream as { unref?: () => void } | null)?.unref?.()
	} catch {
		// Not every stream type supports unref — the child's own unref (see
		// executeCommandHandler) is the important part for harness exit.
	}
}

/**
 * Session teardown: hard-kill every execute_command child still running after
 * a timeout. Called by `ToolExecutor.dispose()` when a session ends (success,
 * bounded failure, budget abort, or thrown error) so no backgrounded process
 * is orphaned past its session. Deliberately NOT called when a single tool
 * call times out mid-session — that is the whole point of the background
 * semantics (see the vendored execute_command tool's timeout contract).
 */
function killBackgroundCommands(): void {
	for (const child of backgroundCommands) {
		try {
			if (child.exitCode === null && child.signalCode === null) {
				if (child.pid != null) {
					// The child is a detached process-group leader (see
					// executeCommandHandler), so kill the whole group with a
					// negative pid — that reaps grandchildren too (e.g. the
					// `node`/`sh` the shell may have spawned), not just the
					// shell itself. Falls back to killing the direct child on
					// platforms where group signals aren't supported.
					try {
						process.kill(-child.pid, "SIGKILL")
					} catch {
						child.kill("SIGKILL")
					}
				} else {
					child.kill("SIGKILL")
				}
			}
		} catch {
			// Already gone — nothing to clean up.
		}
	}
	backgroundCommands.clear()
}

/**
 * execute_command — spawn via child_process, capture stdout+stderr.
 *
 * Timeout semantics follow the vendored tool's own contract (see
 * src/vendor/zoo-code/src/core/prompts/tools/native-tools/execute_command.ts):
 * when the `timeout` elapses the command KEEPS RUNNING in the background — it
 * is NOT killed — and the model receives the output captured so far so it can
 * start a dev server / long migration and move on. The result is a normal
 * (non-error) tool result: a timeout here is expected behavior the model asked
 * for via the `timeout` arg, so it must not count toward the loop's
 * consecutive-mistake bounded-failure limit.
 */
function executeCommandHandler(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
	const command = requireString(args, "command")
	const timeoutS = toNonNegativeInt(args.timeout, DEFAULT_COMMAND_TIMEOUT_S) || DEFAULT_COMMAND_TIMEOUT_S

	return (async () => {
		let cwd = ctx.workspaceRoot
		if (args.cwd != null && args.cwd !== "") {
			const cwdArg = requireString(args, "cwd")
			cwd = safeTarget(ctx, cwdArg)
		}

		return new Promise<ToolResult>((resolve) => {
			let stdout = ""
			let stderr = ""
			let settled = false
			let timedOut = false

			const finish = (result: ToolResult) => {
				if (!settled) {
					settled = true
					resolve(result)
				}
			}

			let child
			try {
				// `detached: true` puts the shell in its own process group
				// (pgid = child.pid). That serves two purposes: (a) a timed-out
				// command can keep running fully independent of the harness's
				// own process group, and (b) session teardown can kill the whole
				// group (`process.kill(-pid)`) so grandchildren are reaped too.
				// The process-group kill is the only way to clean up the full
				// tree of a `shell: true` spawn — killing the shell alone would
				// orphan whatever it had launched.
				child = spawn(command, { cwd, shell: true, detached: true })
			} catch (error) {
				return finish(err(`execute_command: failed to spawn '${command}': ${errorMessage(error)}`))
			}

			const timer = setTimeout(() => {
				// Do NOT kill the child — the vendored contract says a timed-out
				// command keeps running in the background so the model can start
				// dev servers / long migrations and get control back.
				timedOut = true
				backgroundCommands.add(child)
				// Detach from the harness's event loop: the child and its pipes
				// must not keep the process alive once a session is done. The
				// child stays tracked in backgroundCommands so session teardown
				// (ToolExecutor.dispose) can hard-kill it rather than orphan it.
				child.unref()
				unrefStream(child.stdout)
				unrefStream(child.stderr)
				const combined = [stdout, stderr].filter(Boolean).join("\n")
				finish(
					ok(
						`[execute_command] timed out after ${timeoutS}s — process is still running in the background, output captured so far:\n${combined}`,
					),
				)
			}, timeoutS * 1000)

			child.stdout?.on("data", (chunk) => {
				// After a timeout the model already got its partial output; keep
				// draining the pipe (so the child never blocks on a full buffer)
				// but stop accumulating output we can no longer deliver.
				if (!timedOut) {
					stdout += chunk.toString()
				}
			})
			child.stderr?.on("data", (chunk) => {
				if (!timedOut) {
					stderr += chunk.toString()
				}
			})
			child.on("error", (error) => {
				clearTimeout(timer)
				backgroundCommands.delete(child)
				finish(err(`execute_command: spawn error for '${command}': ${errorMessage(error)}`))
			})
			child.on("close", (code, signal) => {
				clearTimeout(timer)
				backgroundCommands.delete(child)
				const combined = [stdout, stderr].filter(Boolean).join("\n")
				if (signal === "SIGKILL") {
					// Defensive path only: a timeout never sends SIGKILL anymore,
					// so this is reachable solely when something external killed
					// the process (the model's own `pkill` cleanup command, or
					// ToolExecutor.dispose during session teardown).
					finish(err(`execute_command: command '${command}' was killed by signal ${signal}.\n${combined}`))
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
