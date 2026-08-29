/**
 * Headless tool executor.
 *
 * Implements the Phase 1 core tools using plain `fs` + `child_process` — NO
 * `vscode.*` anywhere. Argument names match the vendored native-tool schemas
 * exactly (see `src/vendor/zoo-code/src/core/prompts/tools/native-tools/`):
 *
 *   - read_file         { path, offset?, limit? }
 *   - write_to_file     { path, content }
 *   - apply_diff        { path, diff }
 *   - search_replace    { file_path, old_string, new_string }
 *   - edit_file         { file_path, old_string, new_string, expected_replacements? }
 *   - execute_command   { command, cwd?, timeout? }
 *   - list_files        { path?, recursive? }
 *   - browser_action    { action, url?, selector?, text? } — Playwright-backed
 *     headless browser inspection (launch/screenshot/click/type/getConsoleLogs/
 *     getNetworkErrors/close); NEW work, no upstream port (see src/tools/browser/).
 *   - outline / go_to_definition / find_references / import_graph — the four
 *     code-intelligence tools (TS Compiler API backed, src/codeintel/): one
 *     cached ts.Program per workspace serves all four. NEW work, no upstream
 *     port (see src/codeintel/).
 *
 * Every file operation resolves relative to the configured workspace root and
 * is rejected if it escapes the workspace — both lexically (`../` traversal)
 * and after following symlinks (a symlink whose real location is outside the
 * workspace is refused; see resolveWithinWorkspace). Results are plain strings
 * + an { isError } flag; long outputs are truncated to keep the model context
 * bounded.
 *
 * The three surgical edit tools are backed by the vendored Zoo Code diff
 * logic: `apply_diff` uses the fuzzy MultiSearchReplaceDiffStrategy
 * (src/vendor/zoo-code/src/core/diff/strategies/multi-search-replace.ts),
 * `search_replace` is a strict one-occurrence literal match, and `edit_file`
 * falls back exact → whitespace-tolerant → token-based matching (plus
 * file-creation when old_string is "").
 *
 * read_file carries a session-scoped cache (see the readFileCache comment
 * below): the exact same effective args served against byte-identical content
 * earlier in THIS session get a short cache-hit message instead of the full
 * content, because re-sending identical content is pure output-token waste.
 *
 * OPT-IN local summarization (see src/tools/output-summarizer.ts): when
 * HEADLESSCODE_LOCAL_SUMMARIZATION=1, oversized execute_command output that
 * would exceed MAX_RESULT_CHARS is compressed by a small local Ollama model
 * before reaching the cloud model (with a "[Output summarized by local
 * model…]" transparency header). OFF by default; on ANY failure the result
 * falls back to today's exact blunt truncation. Deliberately limited to
 * execute_command output — read_file / write_to_file / diff content always
 * stays verbatim (summarizing code a model is about to edit would be a
 * correctness hazard).
 *
 * KNOWN LIMITATION (issue #88) — edit-tool read-modify-write is NOT atomic:
 * `apply_diff`, `search_replace`, `edit_file`, and `write_to_file` each read
 * the current file, compute the new content, and write it back with a plain
 * `fs.writeFile` — no mtime re-check, no lock, no compare-and-swap. Within
 * one session this is safe: the loop serializes edits to the same file and
 * restricts the parallel read-only tool-call group to paths that aren't
 * being edited (see loop.ts's same-file batching / parallel-group
 * restriction). It is NOT safe across an external editor or a second,
 * concurrent headlesscode session touching the same file — whichever write
 * lands last silently wins and the other one's changes are lost (classic
 * TOCTOU). No fix is planned; this is accepted as a known limitation rather
 * than adding locking complexity for a single-session tool.
 */

import * as fs from "node:fs"
import * as fsp from "node:fs/promises"
import * as path from "node:path"
import { createHash } from "node:crypto"
import { spawn, type ChildProcess } from "node:child_process"
import { setTimeout as sleep } from "node:timers/promises"

import { isTypeScriptWorkspace } from "./language-detect.js"
import type { Logger } from "../engine/logger.js"

// Side effect: installs String.prototype.toPosix() used by path formatting.
import "../vendor/zoo-code/src/utils/path.js"

import { MultiSearchReplaceDiffStrategy } from "../vendor/zoo-code/src/core/diff/strategies/multi-search-replace.js"

import { browserActionHandler, disposeBrowserSessions } from "./browser/handler.js"
import { describeImageHandler } from "../vision/tool.js"
import {
	goToDefinitionHandler,
	findReferencesHandler,
	importGraphHandler,
	outlineHandler,
	renameSymbolHandler,
} from "../codeintel/handlers.js"
import { runTestsHandler } from "./run-tests.js"

import type { AuxLlmUsage, ToolContext, ToolHandler, ToolResult } from "../engine/types.js"
import {
	checkCommand,
	checkRedirectEscape,
	describeRedirect,
	type CommandRefusal,
	type RedirectTarget,
} from "../permissions/commands.js"
import {
	OllamaOutputSummarizer,
	isLocalSummarizationEnabled,
	summarizeToolResult,
	MAX_SUMMARIZER_INPUT_CHARS as SUMMARIZER_INPUT_CAP,
} from "./output-summarizer.js"
import { findMatchingPattern } from "../permissions/protected-files.js"
import { resolvePermissions, type PermissionsConfig } from "../permissions/config.js"
import { createEmbedder, EMBEDDING_BACKEND_ENV, resolveEmbeddingBackend } from "../codesearch/embedder.js"
import { indexFilePath, loadIndexMetadata } from "../codesearch/index.js"
import { formatSearchResults, searchIndex } from "../codesearch/search.js"

/**
 * Absolute path to bash, if present, for execute_command's shell (see the
 * spawn() call below) — `undefined` falls back to `spawn`'s own default
 * (`/bin/sh`) on a host without bash, rather than failing to spawn at all.
 *
 * That fallback must never be SILENT: it reintroduces the exact class of bug
 * fixed in issue #35 (bash-only syntax like `${PIPESTATUS[0]}` silently
 * failing the whole command line under `/bin/sh`, which produced a real
 * false QA_VERDICT: FAIL). A future environment (e.g. a minimal Alpine-based
 * Docker image shipping only `ash`) that lacks bash would quietly bring this
 * back with no signal — so warn loudly, once, at module load, instead of
 * letting it fail silently again.
 */
export const BASH_PATH: string | undefined = fs.existsSync("/bin/bash")
	? "/bin/bash"
	: fs.existsSync("/usr/bin/bash")
		? "/usr/bin/bash"
		: undefined

if (BASH_PATH === undefined) {
	process.stderr.write(
		"[executor] WARNING: bash not found (checked /bin/bash, /usr/bin/bash) — execute_command falls back to " +
			"/bin/sh, which does NOT support bash-only syntax (${PIPESTATUS[0]}, [[ ]], arrays). This previously " +
			"caused a real false QA_VERDICT: FAIL (issue #35). Install bash in this environment to avoid it.\n",
	)
}

/** Cap on tool-result text fed back to the model (keep context bounded). */
export const MAX_RESULT_CHARS = 30_000

/**
 * Per-stream accumulation cap for execute_command output. The small margin
 * above MAX_RESULT_CHARS guarantees the final combined string always exceeds
 * the cap, so truncate()'s "output truncated" trailer still fires (a combined
 * string exactly at the cap would be returned unchanged, silently losing it).
 */
const MAX_COMMAND_STREAM_CHARS = MAX_RESULT_CHARS + 1024

/**
 * Default read_file slice-mode line limit when the model passes no explicit
 * `limit`. 600 lines, down from the vendored tool-schema default of 2000: a
 * no-arg broad read historically pulled up to ~30k chars (~7-8k tokens) of
 * history per call, and the truncation header already tells the model to page
 * with `offset` for anything bigger. An explicit `limit` arg always wins, so
 * 2000 stays available as an opt-in. Measured from real session logs: ~29% of
 * read_file calls were no-arg broad reads.
 */
export const DEFAULT_READ_LIMIT = 600

/** Resolve the read_file slice-mode default limit (env-overridable). */
export function readLimitFromEnv(env: NodeJS.ProcessEnv = process.env): number {
	const raw = env.HEADLESSCODE_READ_LIMIT
	if (raw === undefined || raw === "") {
		return DEFAULT_READ_LIMIT
	}
	const n = Number(raw)
	return Number.isInteger(n) && n > 0 ? n : DEFAULT_READ_LIMIT
}

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
	/** See ToolContext.guardLargeOverwrites (types.ts) for the full writeup. */
	guardLargeOverwrites?: boolean
	/**
	 * Live worker monitoring: fired at the same lifecycle points where the
	 * `.harness.needs-decision` marker is written/cleared, so the session can
	 * mirror them on its event feed (see ToolContext.onDecisionEvent).
	 */
	onDecisionEvent?: (eventType: "decision_blocked" | "decision_answered", fields: Record<string, unknown>) => void
	/**
	 * Live todo-list monitoring: fired each time update_todo_list replaces the
	 * session's checklist (see ToolContext.onTodoEvent). The session mirrors
	 * it on its event feed as `todo_updated`.
	 */
	onTodoEvent?: (fields: { todos: string; done: number; inProgress: number; pending: number }) => void
	/**
	 * Test-selection (run_tests): optional session-provided inference of the
	 * files changed since the session's baseline. Wired by HeadlessSession to
	 * diff the shadow-checkpoint repo's baseline commit against the current
	 * working tree (see src/checkpoints/service.ts) — the checkpoint service
	 * tracks a baseline per task, so this works even when the workspace
	 * itself has no git repo. Returning `undefined` makes the run_tests
	 * handler fall back to the workspace's own `git status`. Absent for bare
	 * executors (tests, reviewer/QA — which don't register run_tests anyway).
	 */
	getSessionChangedFiles?: () => Promise<string[] | undefined>
	/**
	 * Auxiliary LLM usage reporting (cloud vision captioning — see
	 * src/vision/describe.ts). Wired by HeadlessSession right after it
	 * constructs a BudgetTracker (same place as setBudgetClockHooks), so every
	 * captioning call's tokens/cost lands in the SAME BudgetTracker + running
	 * session totals as a main call — never an untracked side channel. Absent
	 * for bare executors (tests, reviewer/QA) — which also disables the
	 * screenshot action's automatic captioning, so an un-accounted executor
	 * never spends money behind the session's back (the model can still call
	 * `describe_image` explicitly).
	 */
	onAuxLlmUsage?: (usage: AuxLlmUsage) => void
}

export class ToolExecutor {
	private readonly handlers = new Map<string, ToolHandler>()
	private pauseBudgetClock: (() => void) | undefined
	private resumeBudgetClock: (() => void) | undefined
	private onAuxLlmUsage: ((usage: AuxLlmUsage) => void) | undefined
	/**
	 * Session-scoped read_file cache (see readFileCache below). One executor
	 * serves one session, so per-instance state is exactly per-session state.
	 * Keyed by a serialized string (see makeReadFileCacheKey) — the map must
	 * never be keyed by object identity, or no two calls would ever collide.
	 */
	private readonly readCache = new Map<string, ReadFileCacheEntry>()
	/**
	 * Session-scoped todo list state (see TodoListState below). update_todo_list
	 * always REPLACES the whole checklist, so this holds only the latest one.
	 * Conversational/session state — NEVER written to a workspace file.
	 */
	private readonly todoList = new TodoListState()
	/**
	 * Session-scoped repeat-call guard for list_files (see listFilesHandler's
	 * doc comment). Keyed by the call's effective (path, recursive) — value is
	 * the condensationGeneration this key was last listed at, so a repeat is
	 * only refused when nothing has been condensed since (the earlier result
	 * might have been evicted from context, in which case re-listing is the
	 * only way to see it again).
	 */
	private readonly listFilesCalls = new Map<string, ListFilesCallEntry>()
	/**
	 * Incremented by notifyCondensed() every time HeadlessSession applies a
	 * condensation (sync or background) — see listFilesCalls above.
	 */
	private condensationGeneration = 0
	/** Resolved permissions handed to every handler call (see ToolExecutorOptions.permissions). */
	readonly permissions: PermissionsConfig

	constructor(
		readonly workspaceRoot: string,
		private readonly options: ToolExecutorOptions = {},
	) {
		this.permissions =
			options.permissions ?? resolvePermissions({ workspaceRoot: this.workspaceRoot, env: process.env })
		this.onAuxLlmUsage = options.onAuxLlmUsage
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

	/**
	 * Register read_file wired to THIS executor's session-scoped cache. Must be
	 * called by every construction path that wants the cache (headless,
	 * reviewer, QA) — each executor instance gets its own independent cache.
	 */
	registerReadFile(): void {
		this.register("read_file", (args, ctx) =>
			readFileHandler(args, ctx, this.readCache.get(readFileKey(args, ctx)), this.readCache),
		)
	}

	/**
	 * Register list_files wired to THIS executor's session-scoped repeat-call
	 * guard (see listFilesCalls above and listFilesHandler's doc comment).
	 * Every construction path that offers list_files should call this instead
	 * of a bare `register("list_files", listFilesHandler)`.
	 */
	registerListFiles(): void {
		this.register("list_files", (args, ctx) => listFilesHandler(args, ctx, this.listFilesCalls, this.condensationGeneration))
	}

	/**
	 * Called by HeadlessSession right after it splices a condensation into the
	 * live history (both the synchronous and background paths) — advances the
	 * generation the list_files repeat-call guard checks against, so a call
	 * repeated after a condensation is allowed again instead of refused.
	 */
	notifyCondensed(): void {
		this.condensationGeneration++
	}

	/**
	 * Register update_todo_list wired to THIS executor's session-scoped todo
	 * state, surfacing each state change via the onTodoEvent option (the
	 * session mirrors it as a `todo_updated` feed event). Must be called by
	 * the headless construction path; read-only executors (reviewer/QA/local
	 * explore) deliberately leave it unregistered — their tool lists never
	 * advertise it either, so it stays an inert stub there.
	 */
	registerTodoList(): void {
		this.register("update_todo_list", (args, ctx) => updateTodoListHandler(args, ctx, this.todoList))
	}

	/**
	 * Snapshot of the session's current todo list, or undefined before the
	 * first update_todo_list call. Read-only accessor — the dashboard /
	 * observability side can query live planning state without touching it.
	 */
	getTodoList(): TodoListSnapshot | undefined {
		return this.todoList.snapshot()
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
				guardLargeOverwrites: this.options.guardLargeOverwrites,
				decisionTimeoutMs: this.options.decisionTimeoutMs,
				decisionPollIntervalMs: this.options.decisionPollIntervalMs,
				pauseBudgetClock: this.pauseBudgetClock,
				resumeBudgetClock: this.resumeBudgetClock,
				onDecisionEvent: this.options.onDecisionEvent,
				onTodoEvent: this.options.onTodoEvent,
				// Auxiliary LLM usage (cloud vision captioning): forwarded so
				// handlers can report spend into the session's BudgetTracker.
				onAuxLlmUsage: this.onAuxLlmUsage,
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
		* left running in the background (see executeCommandHandler), AND close
		* any launched browser (see disposeBrowserSessions — a model may never
		* call browser_action's close(), so the browser is torn down here at true
		* session end, exactly like the backgrounded children). A single tool
		* call timing out mid-session does NOT trigger this — the backgrounded
		* process is exactly what the model asked for and must keep running until
		* the model cleans it up or the session truly ends. Only calling this at
		* true session end does, so nothing is orphaned past its session.
		*/
	dispose(): void {
		killBackgroundCommands()
		disposeBrowserSessions()
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
 * A path whose REAL location (after following symlinks) escapes the workspace
 * even though its lexical path stays inside it (issue #64). Subclasses
 * PathTraversalError so existing callers that catch the base class (e.g. the
 * dashboard's HTTP layer, which maps it to a 400) keep treating it the same
 * way.
 */
export class SymlinkEscapeError extends PathTraversalError {
	constructor(requested: string, root: string, resolvedTo: string) {
		super(requested, root)
		this.name = "SymlinkEscapeError"
		this.message = `Path escapes the workspace root through a symlink (${root}): ${requested} — it resolves to ${resolvedTo}`
	}
}

/**
 * Resolve `p` against the workspace root and reject anything that escapes it.
 *
 * Two layers of containment (issue #64):
 *  1. Lexical: path.resolve + a prefix check — the classic `../` traversal
 *     guard. This alone is NOT sufficient: every `fsp` call in the file tools
 *     FOLLOWS symlinks, so an agent can `ln -s ~/.ssh <ws>/sshlink` and then
 *     read AND write outside the workspace through it. The protected-files
 *     guard is bypassed the same way — it only ever sees the
 *     workspace-relative lexical path.
 *  2. Symlink-following (assertNoSymlinkEscape): the real path of the deepest
 *     resolvable ancestor must stay inside the workspace root's own real
 *     path. An escaping symlink — as a directory component, as the target
 *     itself, or as a dangling symlink a later write would create THROUGH —
 *     is refused with SymlinkEscapeError. The ancestor walk keeps writes to
 *     not-yet-existing paths working (realpath on a nonexistent path throws).
 *
 * Documented boundary: a path is usable only if every existing component of
 * it really lives inside the workspace. A symlink that escapes is refused
 * even when it points somewhere "useful" (e.g. a node_modules symlinked to a
 * sibling checkout) — the model can still reach such paths through
 * execute_command, which has its own permission gate.
 */
export function resolveWithinWorkspace(root: string, p: string): string {
	const rootAbs = path.resolve(root)
	const target = path.resolve(rootAbs, p)
	if (target !== rootAbs && !target.startsWith(rootAbs + path.sep)) {
		throw new PathTraversalError(p, rootAbs)
	}
	assertNoSymlinkEscape(rootAbs, target, p)
	return target
}

/**
 * Reject a `target` whose real location (after following symlinks) escapes
 * `rootAbs`. Called by resolveWithinWorkspace after the lexical check.
 *
 * Walk up from `target` until an existing path is found, realpath it, and
 * require the result to stay inside the root's own realpath. Three cases
 * realpath can't answer directly, each handled explicitly:
 *  - Path doesn't exist yet (a write to a new file): walk up to the deepest
 *    existing ancestor — its real location decides where the write lands.
 *  - A component is a DANGLING symlink: realpath fails, but a write through
 *    it would create the target AT THE SYMLINK'S DESTINATION, so follow the
 *    chain (re-running the containment check on each hop) instead of walking
 *    past it.
 *  - A symlink cycle (realpath throws ELOOP): unresolvable — the kernel
 *    refuses reads/writes through it too, so nothing can escape; walk up.
 */
function assertNoSymlinkEscape(rootAbs: string, target: string, requested: string): void {
	const rootReal = realpathOrSelf(rootAbs)
	const seen = new Set<string>()
	let probe = target
	for (;;) {
		if (seen.has(probe)) {
			// Symlink cycle: unresolvable, so no read/write can escape through
			// it — walk up and keep checking the ancestors.
			const parent = path.dirname(probe)
			if (parent === probe) {
				return
			}
			probe = parent
			continue
		}
		seen.add(probe)

		let real: string
		try {
			real = fs.realpathSync(probe)
		} catch {
			let st: fs.Stats | undefined
			try {
				st = fs.lstatSync(probe)
			} catch {
				st = undefined
			}
			if (st?.isSymbolicLink()) {
				// Dangling symlink: a later write would create the target at
				// the symlink's destination, so verify the destination chain
				// instead of skipping the symlink.
				probe = path.resolve(path.dirname(probe), fs.readlinkSync(probe))
				continue
			}
			const parent = path.dirname(probe)
			if (parent === probe) {
				return
			}
			probe = parent
			continue
		}
		if (real !== rootReal && !real.startsWith(rootReal + path.sep)) {
			throw new SymlinkEscapeError(requested, rootAbs, real)
		}
		return
	}
}

/** realpath of `p`, falling back to the lexical path when it can't resolve. */
function realpathOrSelf(p: string): string {
	try {
		return fs.realpathSync(p)
	} catch {
		return p
	}
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
		case "protected_store":
			return err(
				`execute_command: refusing to run '${command}': sub-command '${refusal.subCommand}' is a recursive delete ` +
					`targeting the shared central store at '${refusal.storeRoot}' (resolved target '${refusal.target}'). ` +
					`The central store is protected BY DEFAULT and this cannot be overridden via --allowed-commands or ` +
					`permissions.json — it is shared across every project on this machine, and no single workspace may ` +
					`delete it. Do not attempt to reset it from inside the harness.`,
			)
		case "redirect_escape": {
			const redirect = refusal.redirect
			const shown = redirect !== undefined ? describeRedirect(redirect) : "an output redirect"
			return err(
				`execute_command: refusing to run '${command}': it redirects output outside the workspace root ` +
					`('${shown}') — the resolved target is outside the workspace and cannot be written from a harness ` +
					`session. This is the same boundary every file tool enforces (write_to_file/apply_diff/... reject ` +
					`outside-workspace paths) and cannot be overridden via --allowed-commands or permissions.json. ` +
					`Write scratch files under <workspaceRoot>/.headlesscode/scratch/ instead.`,
			)
		}
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

/**
 * Apply the tool-result size discipline to raw handler output.
 *
 * With local summarization OFF (default) this is EXACTLY today's behavior:
 * blunt-truncate over `MAX_RESULT_CHARS`. With it ON, a result that would
 * exceed the cap is instead sent to the local model for compression; on ANY
 * summarizer failure we fall back to the same blunt truncation, so an
 * opted-in session with a broken Ollama behaves identically to a non-opted-in
 * one. Small results never reach the summarizer (that would be pure latency
 * and risk for zero benefit).
 *
 * NOTE: deliberately used ONLY for execute_command output (the large,
 * mostly-noisy command-output case). read_file / write_to_file / diff
 * content must stay verbatim — a summarized diff or file body would be a
 * correctness hazard for the cloud model.
 */
async function summarizeCommandOutput(content: string): Promise<string> {
	if (content.length <= MAX_RESULT_CHARS) {
		return content
	}
	if (!isLocalSummarizationEnabled()) {
		return truncate(content)
	}
	const summarizer = makeSummarizer()
	if (summarizer === undefined) {
		return truncate(content)
	}
	const input = content.length > SUMMARIZER_INPUT_CAP ? content.slice(0, SUMMARIZER_INPUT_CAP) : content
	return summarizeToolResult(input, summarizer, summarizerLogger)
}

/**
 * The one place summarization is actually performed, and the ONLY reason the
 * executor module imports OllamaOutputSummarizer. Wired in the constructor.
 */
let summarizerLogger: Pick<Logger, "debug" | "warn"> = {
	debug: () => {},
	warn: (message) => process.stderr.write(`[local-summ] ${message}\n`),
}

/**
 * Module-level session summarizer (one per process). Constructed lazily on the
 * first oversized result of an opted-in session; never constructed for a
 * non-opted-in session. Process-level rather than executor-level because the
 * Ollama client is stateless; one process = one summarizer.
 */
let toolSummarizer: OllamaOutputSummarizer | undefined

/** Bind the session logger (used by the summarizer for non-fatal warnings). */
export function bindSummarizerLogger(logger: Pick<Logger, "debug" | "warn">): void {
	summarizerLogger = logger
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

// ─── read_file session cache ─────────────────────────────────────────────────

/**
 * Session-scoped read_file cache.
 *
 * read_file is the one tool with measured, real waste: a real session re-read
 * the same path with identical args 14-16 times, re-sending byte-identical
 * content at full output-token cost every time (see the DEFAULT_WINDOW_SIZE
 * story in src/engine/loop.ts). Even with that history bug fixed, a model will
 * legitimately re-read a file it saw earlier in a long session — there is no
 * reason to pay full output tokens for content the conversation already has.
 *
 * Correctness: a cache hit requires BOTH (a) the exact effective args that
 * produce byte-identical output, AND (b) the current on-disk content hashing
 * identically to the prior read. (b) is checked by hashing the file at
 * cache-check time — never by tracking "did a write-shaped tool get called",
 * because a file can change for reasons the executor doesn't directly control
 * (execute_command running a formatter/build/codegen, an external editor,
 * anything else). The hash is cheap (node:crypto sha256, no new dependency).
 *
 * The hit short-circuit applies once per "unchanged streak": the first
 * identical call after real content was served returns the short cache-hit
 * message, the SECOND consecutive identical call serves real content again, so
 * a model that is confused or insistent is never stuck being told "it's
 * cached" with no way to actually get the content back.
 *
 * Scope: per ToolExecutor instance, i.e. per session (executors are
 * constructed per-session — see createHeadlessExecutor and its read-only
 * siblings). Deliberately NOT persisted to disk and NOT shared across
 * instances: a reviewer/QA executor gets its own independent cache.
 */

/**
 * Everything about a read_file call that affects its output, serialized into a
 * stable string so two calls that produce byte-identical output always collide
 * (see makeReadFileCacheKey).
 */
type ReadFileCacheKey = {
	/** Resolved absolute path (path.resolve'd, so ./a.ts and a.ts collide). */
	target: string
	/** 'slice' or 'indentation'. */
	mode: string
	/** Effective 1-based offset (default 1). */
	offset: number
	/** Effective limit (default readLimitFromEnv()). */
	limit: number
	/** Effective indentation-mode max_lines (default 60); undefined in slice mode. */
	windowLines?: number
}

/** One cache entry: content identity (hash + size + mtime) + streak state. */
type ReadFileCacheEntry = {
	/** sha256 of the file content as of the last real read of this key. */
	hash: string
	/** File size at the last real read — half of the fast-path identity. */
	size: number
	/**
	 * mtime at the last real read — the other half of the fast-path identity.
	 * mtimeMs (float, sub-ms precision) is the highest-resolution mtime this
	 * Node exposes on a non-bigint stat (mtimeNs needs { bigint: true }).
	 */
	mtimeMs: number
	/**
	 * Whether the last read of this key was already served as a cache-hit
	 * message. When true, the next identical call serves real content again
	 * (resetting this flag), so the hit message never loops forever.
	 */
	toldUnchanged: boolean
}

/**
 * Serialize a read_file cache key to a stable string. Map keys must be
 * primitives (object keys compare by identity, so two structurally-identical
 * fresh objects would never collide); a JSON string of the fully-resolved
 * effective args is both stable and collision-free.
 */
function makeReadFileCacheKey(key: ReadFileCacheKey): string {
	return JSON.stringify(key)
}

/** Cache-hit message shown instead of the full file content. */
const READ_FILE_CACHE_HIT_MESSAGE =
	"[cache] this file is unchanged since your last read of it earlier in this session (identical content, same range). Re-read the earlier tool result for the content, or call read_file again if you specifically need it re-sent."

function hashFileContent(content: string): string {
	return createHash("sha256").update(content).digest("hex")
}

/** The indentation-mode window size this harness actually uses (Phase 1 minimal). */
const DEFAULT_INDENTATION_WINDOW_LINES = 60

/** read_file — slice mode with offset/limit pagination (offset is 1-based). */
function readFileHandler(
	args: Record<string, unknown>,
	ctx: ToolContext,
	cache: ReadFileCacheEntry | undefined,
	entry: Map<string, ReadFileCacheEntry>,
): Promise<ToolResult> {
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
		const limit = toNonNegativeInt(args.limit, readLimitFromEnv())
		const indentation = args.indentation as Record<string, unknown> | undefined
		const windowLines = mode === "indentation" ? toNonNegativeInt(indentation?.["max_lines"], DEFAULT_INDENTATION_WINDOW_LINES) : undefined

		const key = makeReadFileCacheKey({ target, mode, offset, limit, windowLines })

		// Trust model: unchanged size AND mtime ⇒ identical content, so the
		// cached hash can be reused without re-reading the file; any mismatch
		// (including a same-length rewrite, which changes mtime) falls back to
		// a full read + sha256 below.
		if (
			cache !== undefined &&
			!cache.toldUnchanged &&
			cache.size === stat.size &&
			cache.mtimeMs === stat.mtimeMs
		) {
			cache.toldUnchanged = true
			return ok(READ_FILE_CACHE_HIT_MESSAGE)
		}

		let content: string
		try {
			content = await fsp.readFile(target, "utf-8")
		} catch (error) {
			return err(`read_file: cannot read '${rel}': ${errorMessage(error)}`)
		}

		// Cache-check the CURRENT on-disk content (never "no write tool was
		// called"): identical args + identical hash => byte-identical output.
		const currentHash = hashFileContent(content)
		if (cache !== undefined && cache.hash === currentHash && !cache.toldUnchanged) {
			cache.toldUnchanged = true
			return ok(READ_FILE_CACHE_HIT_MESSAGE)
		}

		const allLines = content.split(/\r?\n/)
		let result: ToolResult
		if (mode === "indentation") {
			// Phase 1 minimal: indentation mode falls back to a window around the
			// anchor line (anchor_line 1-based), which is good enough for the loop.
			const anchor = toNonNegativeInt(indentation?.["anchor_line"], offset)
			result = ok(formatFileSlice(rel, allLines, Math.max(1, anchor), windowLines ?? DEFAULT_INDENTATION_WINDOW_LINES))
		} else {
			result = ok(formatFileSlice(rel, allLines, Math.max(1, offset), limit))
		}

		// Serve (or re-serve) real content; record identity + reset the hit
		// flag so the next identical call may short-circuit once more.
		entry.set(key, { hash: currentHash, size: stat.size, mtimeMs: stat.mtimeMs, toldUnchanged: false })
		return result
	})()
}

/**
 * Compute the stable string cache key for a read_file call, mirroring exactly
 * how readFileHandler resolves its args (defaults and all) so two calls that
 * produce byte-identical output always collide on the same key. Path safety is
 * enforced identically to the handler itself, so an escaping path errors here
 * exactly as it would in the handler (and caches nothing).
 */
function readFileKey(args: Record<string, unknown>, ctx: ToolContext): string {
	const filePath = requireString(args, "path")
	const target = safeTarget(ctx, filePath)
	const mode = typeof args.mode === "string" ? args.mode : "slice"
	const offset = toNonNegativeInt(args.offset, 1) // 1-based
	const limit = toNonNegativeInt(args.limit, readLimitFromEnv())
	const indentation = args.indentation as Record<string, unknown> | undefined
	const windowLines =
		mode === "indentation" ? toNonNegativeInt(indentation?.["max_lines"], DEFAULT_INDENTATION_WINDOW_LINES) : undefined
	return makeReadFileCacheKey({ target, mode, offset, limit, windowLines })
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

/**
	* Shared protected-files guard for every write tool. Returns a refusal
	* ToolResult when `rel` (workspace-relative, POSIX-separated) matches a
	* protected pattern and the escape hatch — --allow-protected-writes or
	* "allowProtectedWrites": true in .headlesscode/permissions.json — is
	* explicitly on (OFF by default). Naming the matched pattern gives a
	* well-behaved model a concrete reason to stop. A refusal is a real tool
	* error (isError: true) and counts toward the consecutive-mistake bound,
	* exactly like any other tool failure.
	*/
function protectedWriteRefusal(toolName: string, rel: string, permissions: PermissionsConfig): ToolResult | null {
	if (permissions.allowProtectedWrites) {
		return null
	}
	const matchedPattern = findMatchingPattern(rel, permissions.protectedFiles)
	if (matchedPattern === null) {
		return null
	}
	return err(
		`${toolName}: refusing to write protected file '${rel}' (matches protected pattern '${matchedPattern}'). ` +
			`This file is protected by the harness permissions policy and cannot be overwritten. If this write is ` +
			`genuinely required, re-run with --allow-protected-writes (or set "allowProtectedWrites": true in ` +
			`<workspaceRoot>/.headlesscode/permissions.json); it is OFF by default.`,
	)
}

/**
 * Existing-file content length (bytes) above which write_to_file refuses to
 * overwrite when ctx.guardLargeOverwrites is on. Chosen well above trivial
 * stub/placeholder content (empty scaffolds, one-liners) so the common
 * legitimate case — write_to_file creating or replacing a small/new file —
 * is never affected; see largeOverwriteRefusal's doc comment.
 */
const LARGE_OVERWRITE_GUARD_BYTES = 200

/**
 * guardLargeOverwrites (see ToolContext.guardLargeOverwrites, types.ts):
 * refuse write_to_file against a file that already exists and has
 * substantial content, mirroring edit_file's empty-old_string refusal in
 * the other direction. Verified live 2026-08-20 against Qwen2.5-Coder-14B
 * and Qwen3-14B: given a real ~500-line file and a one-function-add task,
 * both had a strong bias toward regenerating the ENTIRE file from scratch
 * via write_to_file instead of a targeted diff — and since a full
 * regeneration needs far more output budget than a precise edit, this
 * reliably truncates mid-file, silently destroying everything after the
 * cutoff. The escape hatch (delete-then-write) is deliberate: it requires a
 * SEPARATE, explicit destructive action instead of one accidental call, so
 * a genuine full-file rewrite is still possible without disabling the
 * guard.
 */
async function largeOverwriteRefusal(target: string, rel: string, ctx: ToolContext): Promise<ToolResult | null> {
	if (!ctx.guardLargeOverwrites) {
		return null
	}
	let existingSize: number
	try {
		existingSize = (await fsp.stat(target)).size
	} catch {
		return null // Target doesn't exist yet — the legitimate new-file case.
	}
	if (existingSize <= LARGE_OVERWRITE_GUARD_BYTES) {
		return null
	}
	return err(
		`write_to_file: refusing to overwrite '${rel}' (${existingSize} bytes of existing content).\n\n` +
			`<error_details>\nwrite_to_file replaces this file's ENTIRE content. For an existing file of this size, ` +
			`regenerating it from scratch instead of making a targeted change risks silently losing content that ` +
			`isn't reproduced (especially if generation is cut off before finishing the full file).\n\n` +
			`Recovery suggestions:\n1. Use edit_file or search_replace to make a precise, targeted change instead\n` +
			`2. Use read_file first if you haven't seen the file's current contents\n3. If a full-file rewrite is ` +
			`genuinely intended, delete the file first (execute_command) — write_to_file always succeeds against a ` +
			`path that doesn't exist\n</error_details>`,
	)
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
		// explicitly on (OFF by default). All four write tools share the
		// protectedWriteRefusal helper below, so no write path can bypass it.
		const refusal = protectedWriteRefusal("write_to_file", rel, ctx.permissions)
		if (refusal !== null) {
			return refusal
		}

		const overwriteRefusal = await largeOverwriteRefusal(target, rel, ctx)
		if (overwriteRefusal !== null) {
			return overwriteRefusal
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

// ─── apply_diff — vendored MultiSearchReplaceDiffStrategy ────────────────────

/**
 * apply_diff — surgical edits from one or more SEARCH/REPLACE blocks in a
 * single `diff` string. Mirrors the upstream ApplyDiffTool flow, adapted to
 * this project's ToolResult/ok/err conventions: the diff string is fed to the
 * vendored MultiSearchReplaceDiffStrategy (fuzzy Levenshtein matching + optional
 * `:start_line:` disambiguation), and on success the merged content is written
 * straight to disk.
 */
async function applyDiffHandler(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
	const filePath = requireString(args, "path")
	const diffContent = requireString(args, "diff")
	return (async () => {
		const target = safeTarget(ctx, filePath)
		const rel = path.relative(ctx.workspaceRoot, target).toPosix() || path.basename(target)

		// Permissions: same protected-files guard as write_to_file (shared
		// helper) — an agent must not edit .env / *.pem / *.key through a
		// different write tool than the one the guard was originally wired to.
		const refusal = protectedWriteRefusal("apply_diff", rel, ctx.permissions)
		if (refusal !== null) {
			return refusal
		}

		let originalContent: string
		try {
			originalContent = await fsp.readFile(target, "utf-8")
		} catch (error) {
			return err(
				`apply_diff: file does not exist at '${rel}' (or could not be read): ${errorMessage(
					error,
				)}\n\nUse write_to_file to create new files; apply_diff edits existing files only.`,
			)
		}

		const strategy = new MultiSearchReplaceDiffStrategy()
		const diffResult = await strategy.applyDiff(originalContent, diffContent)

		if (!diffResult.success) {
			// Surface the first failing part's error (most actionable), else the
			// strategy-level error.
			const failPart = diffResult.failParts?.find((p) => !p.success)
			const detail = failPart?.error ?? diffResult.error ?? "Unknown diff error"
			return err(`apply_diff: unable to apply diff to '${rel}':\n\n${detail}`)
		}

		// Write the merged content back to disk.
		try {
			await fsp.writeFile(target, diffResult.content, "utf-8")
		} catch (error) {
			return err(`apply_diff: failed to write '${rel}': ${errorMessage(error)}`)
		}

		const failedParts = (diffResult.failParts ?? []).filter((p) => !p.success)
		let message = `File updated: ${rel}`
		if (failedParts.length > 0) {
			message += `\nBut unable to apply all diff parts to file: ${rel} (${failedParts.length} failed). Use the read_file tool to check the newest file version and re-apply diffs.`
		}
		// Single SEARCH/REPLACE block notice (mirrors ApplyDiffTool). The marker
		// literal is split to avoid confusing the harness's own diff parser.
		const searchMarker = "<<<<<<<" + " SEARCH"
		const searchBlocks = diffContent.split(searchMarker).length - 1
		if (searchBlocks === 1) {
			message +=
				"\n<notice>Making multiple related changes in a single apply_diff is more efficient. If other changes are needed in this file, please include them as additional SEARCH/REPLACE blocks.</notice>"
		}
		return ok(message)
	})()
}

// ─── search_replace — strict literal one-occurrence replacement ──────────────

/**
	 * search_replace — a literal string replacement requiring old_string to match
	 * EXACTLY once (the core safety property: never guess which occurrence the
	 * model meant). Normalizes line endings to LF for matching, mirroring the
	 * upstream SearchReplaceTool.
	 */
async function searchReplaceHandler(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
	const filePath = requireString(args, "file_path")
	const oldString = requireString(args, "old_string")
	const newString = requireString(args, "new_string")
	return (async () => {
		// Upstream fails on empty old_string (treated as a missing parameter) —
		// it must never be a silent no-op or a split("") character count.
		if (oldString === "") {
			return err("search_replace: missing 'old_string' — it must be a non-empty string to search for.")
		}
		if (oldString === newString) {
			return err("search_replace: 'old_string' and 'new_string' must be different.")
		}

		const target = safeTarget(ctx, filePath)
		const rel = path.relative(ctx.workspaceRoot, target).toPosix() || path.basename(target)

		// Permissions: same protected-files guard as write_to_file (shared
		// helper) — an agent must not edit .env / *.pem / *.key through a
		// different write tool than the one the guard was originally wired to.
		const refusal = protectedWriteRefusal("search_replace", rel, ctx.permissions)
		if (refusal !== null) {
			return refusal
		}

		let fileContent: string
		try {
			fileContent = await fsp.readFile(target, "utf-8")
		} catch (error) {
			return err(
				`search_replace: file not found at '${rel}' (or could not be read): ${errorMessage(
					error,
				)}\n\nCannot perform search and replace on a non-existent file.`,
			)
		}

		// Normalize line endings to LF for consistent matching (upstream behavior).
		fileContent = fileContent.replace(/\r\n/g, "\n")
		const normalizedOld = oldString.replace(/\r\n/g, "\n")
		const normalizedNew = newString.replace(/\r\n/g, "\n")

		const matchCount = fileContent.split(normalizedOld).length - 1

		if (matchCount === 0) {
			return err(
				`search_replace: no match found for 'old_string' in '${rel}'. Please ensure it matches the file contents exactly, including whitespace and indentation.`,
			)
		}
		if (matchCount > 1) {
			return err(
				`search_replace: found ${matchCount} matches for 'old_string' in '${rel}'. This tool can only replace ONE occurrence at a time. Please provide more context (3-5 lines before and after) to uniquely identify the specific instance you want to change.`,
			)
		}

		const newContent = fileContent.replace(normalizedOld, normalizedNew)
		if (newContent === fileContent) {
			return ok(`No changes needed for '${rel}'`)
		}

		try {
			await fsp.writeFile(target, newContent, "utf-8")
		} catch (error) {
			return err(`search_replace: failed to write '${rel}': ${errorMessage(error)}`)
		}
		return ok(`File updated: ${rel}`)
	})()
}

// ─── edit_file — fallback matching chain + file creation ─────────────────────

type LineEnding = "\r\n" | "\n"

/**
 * Character-count growth (new_string longer than old_string) above which a
 * multi-site edit_file replacement (expected_replacements > 1) is refused.
 * See the guard's call site in editFileHandler for the live-verified
 * failure this exists to prevent.
 */
const UNSAFE_MULTI_REPLACE_GROWTH_CHARS = 40

/**
	 * Count occurrences of a substring in a string (non-overlapping).
	 * Ported verbatim from upstream EditFileTool.ts.
	 */
function countOccurrences(str: string, substr: string): number {
	if (substr === "") return 0
	let count = 0
	let pos = str.indexOf(substr)
	while (pos !== -1) {
		count++
		pos = str.indexOf(substr, pos + substr.length)
	}
	return count
}

/**
	 * Safely replace all occurrences of a literal string, handling $ escape
	 * sequences. Ported verbatim from upstream EditFileTool.ts.
	 */
function safeLiteralReplace(str: string, oldString: string, newString: string): string {
	if (oldString === "" || !str.includes(oldString)) {
		return str
	}
	if (!newString.includes("$")) {
		return str.replaceAll(oldString, newString)
	}
	const escapedNewString = newString.replaceAll("$", "$$$$")
	return str.replaceAll(oldString, escapedNewString)
}

function detectLineEnding(content: string): LineEnding {
	return content.includes("\r\n") ? "\r\n" : "\n"
}

function normalizeToLF(content: string): string {
	return content.replace(/\r\n/g, "\n")
}

function restoreLineEnding(contentLF: string, eol: LineEnding): string {
	if (eol === "\n") return contentLF
	return contentLF.replace(/\n/g, "\r\n")
}

function escapeRegExp(input: string): string {
	return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

/**
	 * Whitespace-tolerant regex: treats runs of horizontal whitespace and
	 * cross-line whitespace as flexible, so minor formatting drift still matches.
	 * Ported verbatim from upstream EditFileTool.ts.
	 */
function buildWhitespaceTolerantRegex(oldLF: string): RegExp {
	if (oldLF === "") {
		return new RegExp("(?!)", "g")
	}

	const parts = oldLF.match(/(\s+|\S+)/g) ?? []
	const whitespacePatternForRun = (run: string): string => {
		if (run.includes("\n")) {
			return "\\s+"
		}
		return "[\\t ]+"
	}

	const pattern = parts
		.map((part) => {
			if (/^\s+$/.test(part)) {
				return whitespacePatternForRun(part)
			}
			return escapeRegExp(part)
		})
		.join("")

	return new RegExp(pattern, "g")
}

/**
	 * Token-based regex: matches the non-whitespace tokens in order, separated by
	 * any whitespace. Ported verbatim from upstream EditFileTool.ts.
	 */
function buildTokenRegex(oldLF: string): RegExp {
	const tokens = oldLF.split(/\s+/).filter(Boolean)
	if (tokens.length === 0) {
		return new RegExp("(?!)", "g")
	}

	const pattern = tokens.map(escapeRegExp).join("\\s+")
	return new RegExp(pattern, "g")
}

function countRegexMatches(content: string, regex: RegExp): number {
	const stable = new RegExp(regex.source, regex.flags)
	return Array.from(content.matchAll(stable)).length
}

/**
	 * edit_file — literal string replacement resilient to formatting drift via the
	 * fallback chain exact → whitespace-tolerant → token-based, with an optional
	 * `expected_replacements` count (default 1). Also creates new files when
	 * old_string is "" (failing clearly if the file already exists). Mirrors the
	 * upstream EditFileTool; the file's original line endings are preserved.
	 */
async function editFileHandler(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
	// Coerce old_string/new_string to handle malformed native calls that pass
	// non-strings (upstream normalizes those to "" to avoid later crashes).
	const filePath = requireString(args, "file_path")
	const oldString = typeof args.old_string === "string" ? args.old_string : ""
	const newString = typeof args.new_string === "string" ? args.new_string : ""
	const expectedReplacements = Math.max(1, toNonNegativeInt(args.expected_replacements, 1))

	return (async () => {
		const target = safeTarget(ctx, filePath)
		const rel = path.relative(ctx.workspaceRoot, target).toPosix() || path.basename(target)

		// Permissions: same protected-files guard as write_to_file (shared
		// helper) — an agent must not edit .env / *.pem / *.key through a
		// different write tool than the one the guard was originally wired to.
		const refusal = protectedWriteRefusal("edit_file", rel, ctx.permissions)
		if (refusal !== null) {
			return refusal
		}

		let currentContent: string | null = null
		let currentContentLF: string | null = null
		let originalEol: LineEnding = "\n"
		let isNewFile = false

		// Read the file (or determine it doesn't exist / we're creating it).
		let fileExists = false
		try {
			await fsp.access(target)
			fileExists = true
		} catch {
			fileExists = false
		}

		if (fileExists) {
			try {
				currentContent = await fsp.readFile(target, "utf8")
				originalEol = detectLineEnding(currentContent)
				currentContentLF = normalizeToLF(currentContent)
			} catch (error) {
				return err(
					`edit_file: failed to read file '${rel}': ${errorMessage(
						error,
					)}\n\nRecovery suggestions:\n1. Verify the file exists and is readable\n2. Check file permissions\n3. If the file may have changed, use read_file to confirm its current contents`,
				)
			}

			// Check if trying to create a file that already exists.
			if (oldString === "") {
				return err(
					`edit_file: file already exists: '${rel}'\n\n<error_details>\nYou provided an empty old_string, which indicates file creation, but the target file already exists.\n\nRecovery suggestions:\n1. To modify an existing file, provide a non-empty old_string that matches the current file contents\n2. Use read_file to confirm the exact text to match\n3. If you intended to overwrite the entire file, use write_to_file instead\n</error_details>`,
				)
			}
		} else {
			if (oldString === "") {
				// Creating a new file.
				isNewFile = true
			} else {
				return err(
					`edit_file: file does not exist at path: '${rel}'\n\n<error_details>\nThe specified file could not be found, so the replacement could not be performed.\n\nRecovery suggestions:\n1. Verify the file path is correct\n2. If you intended to create a new file, set old_string to an empty string\n3. Use list_files or read_file to confirm the correct path\n</error_details>`,
				)
			}
		}

		const oldLF = normalizeToLF(oldString)
		const newLF = normalizeToLF(newString)

		// Validate the replacement operation on an existing file.
		if (!isNewFile && currentContentLF !== null) {
			if (oldLF === newLF) {
				return err(
					`edit_file: no changes to apply for file '${rel}'\n\n<error_details>\nThe provided old_string and new_string are identical (after normalizing line endings), so there is nothing to change.\n\nRecovery suggestions:\n1. Update new_string to the intended replacement text\n2. If you intended to verify file state only, use read_file instead\n</error_details>`,
				)
			}

			// Unsafe-multi-replace-insertion guard: verified live 2026-08-20 —
			// a local model's old_string ("estimateMessageChars", a bare
			// identifier) matched 4 unrelated sites (one function definition,
			// three call sites) in condense.ts. edit_file's own error message
			// on the first (correctly refused, count-mismatch) attempt
			// suggested "if you intend to replace all occurrences, set
			// expected_replacements to N" — reasonable advice for a genuine
			// rename, but the model's real intent was to INSERT a large new
			// function body once, right after the definition. Taking that
			// suggestion literally applied the same large insertion at all 4
			// sites, corrupting the 3 call sites (each ended up with the new
			// function body spliced into the middle of a function call). A
			// multi-site replacement whose new_string is much LONGER than
			// old_string is exactly the insertion shape, not the rename
			// shape (a genuine rename keeps old_string and new_string close
			// in length) — refuse it up front rather than let the "set
			// expected_replacements" suggestion above walk a model into this.
			if (expectedReplacements > 1 && newLF.length - oldLF.length > UNSAFE_MULTI_REPLACE_GROWTH_CHARS) {
				return err(
					`edit_file: refusing expected_replacements=${expectedReplacements} — new_string is ${newLF.length - oldLF.length} characters longer than old_string.\n\n` +
						`<error_details>\nReplacing several sites at once with a much LARGER block of text is almost always a mistake: ` +
						`it means the SAME large insertion would be spliced into every matching location, not just the one you actually ` +
						`intend to change. A genuine multi-site replacement (a rename, for example) keeps old_string and new_string close ` +
						`in length.\n\nRecovery suggestions:\n1. Use read_file to see the exact surrounding context, then include enough of ` +
						`it in old_string to uniquely identify the ONE location you actually want to change\n2. Set expected_replacements back ` +
						`to 1 once old_string is unique\n3. If you genuinely want the SAME large content at multiple locations, make separate ` +
						`edit_file calls, one per location, each with a uniquely-identifying old_string\n</error_details>`,
				)
			}

			const wsRegex = buildWhitespaceTolerantRegex(oldLF)
			const tokenRegex = buildTokenRegex(oldLF)

			// Strategy 1: exact literal match.
			const exactOccurrences = countOccurrences(currentContentLF, oldLF)
			if (exactOccurrences === expectedReplacements) {
				currentContentLF = safeLiteralReplace(currentContentLF, oldLF, newLF)
			} else {
				// Strategy 2: whitespace-tolerant regex.
				const wsOccurrences = countRegexMatches(currentContentLF, wsRegex)
				if (wsOccurrences === expectedReplacements) {
					currentContentLF = currentContentLF.replace(wsRegex, () => newLF)
				} else {
					// Strategy 3: token-based regex.
					const tokenOccurrences = countRegexMatches(currentContentLF, tokenRegex)
					if (tokenOccurrences === expectedReplacements) {
						currentContentLF = currentContentLF.replace(tokenRegex, () => newLF)
					} else {
						const anyMatches = exactOccurrences > 0 || wsOccurrences > 0 || tokenOccurrences > 0
						if (!anyMatches) {
							return err(
								`edit_file: no match found in file '${rel}'\n\n<error_details>\nThe provided old_string could not be found using exact, whitespace-tolerant, or token-based matching.\n\nRecovery suggestions:\n1. Use read_file to confirm the file's current contents\n2. Ensure old_string matches exactly (including whitespace/indentation and line endings)\n3. Provide more surrounding context in old_string to make the match unique\n4. If the file has changed since you constructed old_string, re-read and retry\n</error_details>`,
							)
						}
						if (exactOccurrences > 0) {
							return err(
								`edit_file: occurrence count mismatch in file '${rel}'\n\n<error_details>\nExpected ${expectedReplacements} occurrence(s) but found ${exactOccurrences} exact match(es).\n\nRecovery suggestions:\n1. Provide a more specific old_string so it matches exactly once — this is almost always the right fix; a short old_string like a bare identifier matches every place that name is USED, not just the one place you want to change\n2. Only set expected_replacements to ${exactOccurrences} if new_string is a genuine like-for-like replacement (e.g. a rename) that is EQUALLY correct at all ${exactOccurrences} locations — an insertion or a large addition is essentially never correct at multiple sites\n3. Use read_file to confirm the exact text and counts\n</error_details>`,
							)
						}
						return err(
							`edit_file: occurrence count mismatch in file '${rel}'\n\n<error_details>\nExpected ${expectedReplacements} occurrence(s), but matching found ${wsOccurrences} (whitespace-tolerant) and ${tokenOccurrences} (token-based).\n\nRecovery suggestions:\n1. Provide more surrounding context in old_string to make the match unique — this is almost always the right fix\n2. Only adjust expected_replacements to match multiple sites if new_string is EQUALLY correct at every one of them (e.g. a rename) — never for an insertion or addition\n3. Use read_file to confirm the current file contents and refine the match\n</error_details>`,
						)
					}
				}
			}
		}

		// Apply the replacement (creating the file when old_string was "").
		const newContent = isNewFile
			? newString
			: restoreLineEnding(currentContentLF ?? currentContent ?? "", originalEol)

		if (!isNewFile && newContent === currentContent) {
			return ok(`No changes needed for '${rel}'`)
		}

		try {
			await fsp.mkdir(path.dirname(target), { recursive: true })
			await fsp.writeFile(target, newContent, "utf-8")
		} catch (error) {
			return err(`edit_file: failed to write '${rel}': ${errorMessage(error)}`)
		}

		const replacementInfo = !isNewFile && expectedReplacements > 1 ? ` (${expectedReplacements} replacements)` : ""
		return ok(`${isNewFile ? `File created: ${rel}` : `File updated: ${rel}`}${replacementInfo}`)
	})()
}

/**
 * set_indentation — change ONE line's leading indentation to an exact tab
 * count, given as a plain integer rather than a literal whitespace string
 * (issue #141). edit_file's old_string/new_string already tolerates
 * whitespace-amount differences via buildWhitespaceTolerantRegex, but that
 * only helps once the MATCH succeeds — live-verified 2026-08-21 that a
 * local model asked to fix a pure-indentation mismatch, even given the
 * exact current and desired content verbatim, sometimes submits an
 * old_string byte-identical to new_string (refused by the "no changes to
 * apply" check below `oldLF === newLF`) rather than actually varying the
 * leading whitespace between the two multi-line strings it has to type
 * out. An integer tab count sidesteps the problem structurally: there is
 * no pair of near-identical multi-line strings for the model to get
 * subtly wrong, just one small number.
 */
async function setIndentationHandler(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
	const filePath = requireString(args, "path")
	const line = toNonNegativeInt(args.line, 0)
	const tabs = toNonNegativeInt(args.tabs, -1)

	if (line < 1) {
		return err(`set_indentation: 'line' must be a positive integer (1-indexed), got ${String(args.line)}`)
	}
	if (tabs < 0) {
		return err(`set_indentation: 'tabs' must be a non-negative integer, got ${String(args.tabs)}`)
	}

	return (async () => {
		const target = safeTarget(ctx, filePath)
		const rel = path.relative(ctx.workspaceRoot, target).toPosix() || path.basename(target)

		const refusal = protectedWriteRefusal("set_indentation", rel, ctx.permissions)
		if (refusal !== null) {
			return refusal
		}

		let content: string
		try {
			content = await fsp.readFile(target, "utf-8")
		} catch (error) {
			return err(`set_indentation: failed to read file '${rel}': ${errorMessage(error)}`)
		}

		const eol = detectLineEnding(content)
		const lines = normalizeToLF(content).split("\n")
		if (line > lines.length) {
			return err(
				`set_indentation: line ${line} does not exist — '${rel}' has ${lines.length} line(s).\n\nRecovery suggestions:\n1. Use read_file to confirm the real line number\n2. If the file has changed since you last read it, re-read and retry`,
			)
		}

		const targetLine = lines[line - 1] ?? ""
		const currentIndentMatch = /^[\t ]*/.exec(targetLine)
		const currentIndent = currentIndentMatch ? currentIndentMatch[0] : ""
		const rest = targetLine.slice(currentIndent.length)
		const newIndent = "\t".repeat(tabs)

		if (currentIndent === newIndent) {
			return err(
				`set_indentation: line ${line} of '${rel}' already has exactly ${tabs} leading tab(s) — no change to make.\n\nRecovery suggestions:\n1. Use read_file to confirm the real current indentation\n2. If a different line needs the fix, check the line number`,
			)
		}

		lines[line - 1] = newIndent + rest
		const newContent = restoreLineEnding(lines.join("\n"), eol)

		try {
			await fsp.writeFile(target, newContent, "utf-8")
		} catch (error) {
			return err(`set_indentation: failed to write '${rel}': ${errorMessage(error)}`)
		}

		return ok(
			`File updated: ${rel} (line ${line} indentation changed from ${currentIndent.length} to ${tabs} tab${tabs === 1 ? "" : "s"})`,
		)
	})()
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

		// Permissions gate (command allow/deny + dangerous substitution +
		// central-store protection + redirect-escape): refuse BEFORE spawning
		// so nothing is ever executed. Compound commands are checked per
		// sub-command (parseCommand splits on &&/||/;/|/&) — a denied or
		// unallow-listed sub-command blocks the whole chain. This applies to
		// every executor built on this handler, including the read-only
		// reviewer/QA executors (they share it), which also run unattended and
		// could otherwise run arbitrary commands. A refusal is a real tool
		// error (isError: true) and therefore counts toward the loop's
		// consecutive-mistake bound, same as any tool error. The command's
		// resolved `cwd` anchors relative targets for the central-store and
		// redirect-escape checks (see src/permissions/store-protection.ts and
		// src/permissions/commands.ts). The redirect-escape scan runs against
		// the RAW command before checkCommand parses it (a redirect embedded
		// in an unparseable fragment — e.g. a heredoc body's `> /tmp` line —
		// would otherwise be swallowed by the malformed-command path).
		const redirectRoot = cwd
		const redirectEscape = checkRedirectEscape(command, redirectRoot)
		if (redirectEscape !== null) {
			return refusalMessage(command, { kind: "redirect_escape", subCommand: command, redirect: redirectEscape })
		}
		const refusal = checkCommand(command, ctx.permissions.allowedCommands, ctx.permissions.deniedCommands, {
			workspaceRoot: cwd,
		})
		if (refusal !== null) {
			return refusalMessage(command, refusal)
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

			// 2026-08-27: verified live, repeatedly, across several otherwise-
			// healthy long-running sessions (no memory pressure per
			// /proc/pressure/memory, no zombie/fd accumulation found) — spawn()
			// intermittently throws ENOENT for the shell itself ("spawn
			// /bin/bash ENOENT") even though /bin/bash demonstrably exists and
			// BASH_PATH resolved it correctly at module load. Root cause not
			// pinned down (a transient Node/libuv spawn hiccup is the leading
			// theory, not a real missing binary), but the failure mode is
			// unambiguous: a completely benign command (`git log`, `pwd`) fails
			// this way, derails the model with a spurious mistake, and burns
			// through the session's mistake budget on pure infrastructure
			// noise. One transparent retry (fresh spawn, same command/options)
			// before surfacing anything to the model treats this as the
			// transient it appears to be instead of a model-facing error.
			const isBashSpawnEnoent = (error: unknown): boolean =>
				error instanceof Error &&
				"code" in error &&
				(error as NodeJS.ErrnoException).code === "ENOENT" &&
				("path" in error ? String((error as { path?: unknown }).path ?? "") : "").includes("bash")

			// 2026-08-27: with the double-fire bug above fixed (each attempt now
			// genuinely settles once), the same daemon-review sessions still hit
			// this on some runs even across the full retry budget — the real
			// transient window can outlast a ~1.5s total retry span. Widened to
			// 8 attempts with a longer per-step backoff (500ms * attempt, so the
			// full span is several seconds) rather than assume 4 attempts was
			// already enough patience.
			const MAX_SPAWN_ATTEMPTS = 8
			const SPAWN_RETRY_DELAY_MS = 500
			const spawnAttempt = (attempt: number) => {
				// 2026-08-27: verified live — a failed spawn can fire BOTH the
				// `error` event AND the `close` event for the SAME underlying
				// failure (a known Node/libuv behavior: a child that never truly
				// started still gets its close lifecycle completed). Without a
				// guard, each independently retried, so one real failure produced
				// TWO parallel retry chains, each of which could again double —
				// confirmed live via temporary diagnostic logging: attempt counts
				// literally doubled at each level (2, 4, 8 duplicate retries for
				// the same command). That storm of concurrent spawns was plausibly
				// making the underlying transient WORSE, not better. This attempt's
				// own outcome (retry-or-finish) must be decided exactly once.
				let attemptSettled = false
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
					child = spawn(command, {
						cwd,
						// `shell: true` alone defaults to `/bin/sh` (dash on Debian/
						// Ubuntu, the common host here), which has no bash-only
						// features — `${PIPESTATUS[0]}`, `[[ ]]`, arrays. A model that
						// reaches for one of these (common; every mode's rules files
						// are silent on which shell dialect execute_command actually
						// runs) gets a shell PARSE error on the whole command line —
						// including whatever real command preceded it (e.g.
						// `npm test 2>&1 | tail -60; echo "EXIT=${PIPESTATUS[0]}"`)
						// fails with exit 2 even though `npm test` itself may have
						// passed cleanly. Confirmed live 2026-08-05: this produced a
						// genuine FALSE "QA_VERDICT: FAIL" on issue #17's round — a
						// manual re-run of the identical code passed cleanly. Every
						// `scripts/*.sh` in this repo already assumes bash; making
						// execute_command match removes an entire class of spurious
						// tool/verification failures instead of just working around
						// each occurrence as it's spotted.
						shell: BASH_PATH ?? true,
						detached: true,
						// Matches the vendored Execa-based terminal's own spawn options
						// (zoo-code/src/integrations/terminal/ExecaTerminalProcess.ts):
						// ignore stdin so a command that reads from it gets an immediate
						// EOF instead of hanging on an open, never-written pipe (there is
						// no interactive user here to type anything), and force a UTF-8
						// locale so tools sensitive to it (Ruby, CocoaPods, etc. per the
						// vendored comment) behave consistently regardless of the host's
						// own locale configuration.
						stdio: ["ignore", "pipe", "pipe"],
						env: { ...process.env, LANG: "en_US.UTF-8", LC_ALL: "en_US.UTF-8" },
					})
				} catch (error) {
					logSpawnDiagnostics(command, attempt, "sync-catch", error)
					if (attempt < MAX_SPAWN_ATTEMPTS && isBashSpawnEnoent(error)) {
						// A live standalone repro of one of these exact failures spawned
						// cleanly on the first try outside the long-running harness
						// process — this is not an inherently broken command, so a
						// single immediate retry was landing in the same narrow window
						// as the original failure. Verified live 2026-08-27: failures
						// can come in bursts of several consecutive calls, not just an
						// isolated blip (plausibly a GC pause in this specific
						// long-running process interacting with posix_spawn) — one
						// retry wasn't always enough. Escalating delay across up to
						// MAX_SPAWN_ATTEMPTS gives a longer transient window room to
						// clear before this surfaces to the model as a real failure.
						setTimeout(() => spawnAttempt(attempt + 1), SPAWN_RETRY_DELAY_MS * attempt)
						return
					}
					finish(err(`execute_command: failed to spawn '${command}': ${errorMessage(error)}`))
					return
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
					// but stop accumulating output we can no longer deliver. Once a
					// stream hits its cap, keep draining but discard — the final
					// truncation/summarization at close stays the single cut point.
					if (!timedOut && stdout.length < MAX_COMMAND_STREAM_CHARS) {
						stdout += chunk.toString()
					}
				})
				child.stderr?.on("data", (chunk) => {
					if (!timedOut && stderr.length < MAX_COMMAND_STREAM_CHARS) {
						stderr += chunk.toString()
					}
				})
				child.on("error", (error) => {
					if (attemptSettled) {
						return
					}
					attemptSettled = true
					clearTimeout(timer)
					backgroundCommands.delete(child)
					logSpawnDiagnostics(command, attempt, "error-event", error)
					if (attempt < MAX_SPAWN_ATTEMPTS && isBashSpawnEnoent(error)) {
						stdout = ""
						stderr = ""
						setTimeout(() => spawnAttempt(attempt + 1), SPAWN_RETRY_DELAY_MS * attempt)
						return
					}
					finish(err(`execute_command: spawn error for '${command}': ${errorMessage(error)}`))
				})
				child.on("close", (code, signal) => {
				if (attemptSettled) {
					return
				}
				attemptSettled = true
				clearTimeout(timer)
				backgroundCommands.delete(child)
				const combined = [stdout, stderr].filter(Boolean).join("\n")
				// Log debug information
				if (process.env.HEADLESSCODE_DEBUG) {
					console.error(`[execute_command debug] Command: ${command}, Code: ${code}, Signal: ${signal}, stdout: ${stdout.slice(0, 200)}, stderr: ${stderr.slice(0, 200)}`)
				}
				// 2026-08-27: the SAME bash-spawn-ENOENT failure this file already
				// retries on (see isBashSpawnEnoent / the `error` handler above)
				// was found live to ALSO surface via a completely different path --
				// no `error` event at all, just `close` firing with `code: -2`
				// (Node's posix_spawn fast path reporting a negated errno directly:
				// -2 is -ENOENT). A retry that only listens for the `error` event
				// silently misses this shape entirely. `code` is negative here in
				// no other real scenario (a genuine command exit code is always
				// 0-255), so treat any negative code on the first attempt the same
				// way: retry once before surfacing anything to the model.
				if (code !== null && code < 0) {
					// The same bash-spawn-ENOENT failure surfaced via `close`
					// (no `error` event). Snapshot system state at the moment of
					// the failure, before any retry backoff begins (issue #1).
					logSpawnDiagnostics(command, attempt, "close-negative-code", undefined, code)
					if (attempt < MAX_SPAWN_ATTEMPTS) {
						stdout = ""
						stderr = ""
						setTimeout(() => spawnAttempt(attempt + 1), SPAWN_RETRY_DELAY_MS * attempt)
						return
					}
				}
				if (signal === "SIGKILL") {
					// Defensive path only: a timeout never sends SIGKILL anymore,
					// so this is reachable solely when something external killed
					// the process (the model's own `pkill` cleanup command, or
					// ToolExecutor.dispose during session teardown).
					finish(err(`execute_command: command '${command}' was killed by signal ${signal}.\n${combined}`))
					return
				}
				if (code !== 0) {
					// Command failed: the stderr/stdout tail is exactly what the
					// model needs. Summarize it (opt-in) exactly like the success
					// path — a failed verbose test run is THE canonical case.
					// .catch (issue #82): summarizeCommandOutput never rejects today,
					// but this is a fire-and-forget .then() with no caller to
					// propagate a rejection to — an unhandled rejection would crash
					// the whole process on Node 15+ if that invariant ever breaks.
					// Fall back to the raw (unsummarized) output rather than lose
					// the result.
					void summarizeCommandOutput(combined)
						.then((content) =>
							finish(err(`execute_command: command '${command}' exited with code ${code}.\n${content}`)),
						)
						.catch(() =>
							finish(err(`execute_command: command '${command}' exited with code ${code}.\n${combined}`)),
						)
					return
				}
				void summarizeCommandOutput(combined === "" ? `(command completed with no output)` : combined)
					.then((content) => finish(ok(content)))
					.catch(() => finish(ok(combined === "" ? `(command completed with no output)` : combined)))
			})
			}

			spawnAttempt(1)
		})
	})()
}

/** One list_files repeat-call guard entry — see listFilesHandler's doc comment. */
type ListFilesCallEntry = {
	/** The condensation generation this key was last (really) listed at. */
	generation: number
	/**
	 * Whether the LAST identical call already got the short cache-hit
	 * message instead of a real listing. When true, the next identical
	 * call gets a real listing again — mirrors read_file's toldUnchanged
	 * (readFileHandler) exactly, and for the same reason: a one-shot notice
	 * never loops forever.
	 */
	toldUnchanged: boolean
}

/**
 * list_files — top-level or recursive listing, dirs first, truncated.
 *
 * Repeat-call guard: a local model was observed calling list_files with the
 * SAME (path, recursive) twice in one turn pair with no condensation in
 * between (verified live 2026-08-20 — see
 * plans/local-dual-model-code-agent-PROMPT-2026-08-21.md's trial 4), which
 * cost ~7.5K prompt tokens for a result already sitting in context. When
 * `calls`/`generation` are supplied (see ToolExecutor.registerListFiles), an
 * identical call within the same condensation generation gets a short
 * cache-hit notice INSTEAD of a refusal — not an error, so it never counts
 * against the consecutive-mistake budget. This was originally a hard
 * refusal (matching guardLargeOverwrites' shape); verified live 2026-08-20
 * that this was actively harmful — a model that repeats an identical call
 * verbatim after an error (the SAME cross-tool tic already documented for
 * apply_diff/ask_followup_question, see the plan doc above) burned an
 * entire 8-mistake budget refusing the identical list_files call 8 times in
 * a row and never reached the real task. A repeat AFTER a condensation is
 * always treated as fresh: the earlier result may have been the part that
 * got compressed away.
 */
function listFilesHandler(
	args: Record<string, unknown>,
	ctx: ToolContext,
	calls?: Map<string, ListFilesCallEntry>,
	generation?: number,
): Promise<ToolResult> {
	const dirPath = args.path == null || args.path === "" ? "." : requireString(args, "path")
	const recursive = args.recursive === true

	return (async () => {
		const target = safeTarget(ctx, dirPath)
		const rel = path.relative(ctx.workspaceRoot, target).toPosix() || path.basename(target) || "."
		const key = `${target} ${recursive}`
		const entry = calls?.get(key)

		if (calls !== undefined && generation !== undefined && entry !== undefined && entry.generation === generation) {
			if (!entry.toldUnchanged) {
				entry.toldUnchanged = true
				return ok(
					`[cache] '${rel}' (recursive=${recursive}) was already listed earlier this session and nothing has been ` +
						`condensed since — reuse the earlier result above instead of re-listing. Re-listing again will re-run ` +
						`the real listing.`,
				)
			}
			// Fall through to a real listing: a second identical call in a row
			// means the cache-hit notice alone didn't redirect the model, and
			// refusing again would just repeat the same unproductive exchange.
		}

		let collected: { entries: Array<{ rel: string; isDir: boolean }>; truncated: boolean }
		try {
			collected = await collectEntries(target, ctx.workspaceRoot, recursive)
		} catch (error) {
			return err(`list_files: cannot list '${rel}': ${errorMessage(error)}`)
		}

		// Only recorded on SUCCESS: a failed listing (e.g. bad path) should
		// remain retryable with the real error, never masked by the cache-hit
		// notice above.
		if (calls !== undefined && generation !== undefined) {
			calls.set(key, { generation, toldUnchanged: false })
		}

		// Sort dirs first, then alphabetically (over the collected subset).
		collected.entries.sort((a, b) => {
			if (a.isDir !== b.isDir) {
				return a.isDir ? -1 : 1
			}
			return a.rel.localeCompare(b.rel)
		})

		const lines = collected.entries.slice(0, MAX_LIST_FILES).map((e) => (e.isDir ? `${e.rel}/` : e.rel))
		// Once the walk was capped the true total is unknown, so the trailer
		// omits it — the trailer itself is still the signal that more exists.
		const truncatedNote = collected.truncated
			? `\n(File list truncated: ${MAX_LIST_FILES} entries shown. Use list_files on specific subdirectories to see more.)`
			: ""

		return ok(lines.length > 0 ? lines.join("\n") + truncatedNote : "(empty directory)")
	})()
}

async function collectEntries(
	dir: string,
	root: string,
	recursive: boolean,
	depth = 0,
	budget = MAX_LIST_FILES,
): Promise<{ entries: Array<{ rel: string; isDir: boolean }>; truncated: boolean }> {
	if (depth > 32) {
		return { entries: [], truncated: false }
	}
	const dirents = await fsp.readdir(dir, { withFileTypes: true })
	const out: Array<{ rel: string; isDir: boolean }> = []
	let truncated = false
	for (const ent of dirents) {
		// Budget exhausted: stop pushing and stop descending — the caller only
		// keeps the first MAX_LIST_FILES anyway, so a huge tree is never fully
		// walked, collected, or sorted.
		if (out.length >= budget) {
			truncated = true
			break
		}
		const abs = path.join(dir, ent.name)
		const rel = path.relative(root, abs).toPosix() || ent.name
		if (ent.isDirectory()) {
			out.push({ rel, isDir: true })
			if (recursive) {
				const sub = await collectEntries(abs, root, recursive, depth + 1, budget - out.length)
				out.push(...sub.entries)
				truncated = truncated || sub.truncated
			}
		} else {
			out.push({ rel, isDir: false })
		}
	}
	return { entries: out, truncated }
}

/** attempt_completion — the loop intercepts this; registering it keeps the executor total. */
function attemptCompletionHandler(args: Record<string, unknown>): ToolResult {
	const result = typeof args.result === "string" ? args.result : JSON.stringify(args)
	return ok(result)
}

/** Marker basenames, relative to the workspace root (mirrors the .harness.* idiom). */
export const NEEDS_DECISION_FILENAME = ".harness.needs-decision"
export const DECISION_ANSWER_FILENAME = ".harness.decision-answer"

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

/** The terminal outcome of one decision-escalation wait (see escalateDecision). */
export type DecisionEscalationResult =
	| { status: "answered"; answer: string }
	| { status: "timedOut" }
	| { status: "writeFailed"; error: string }

/**
 * Shared decision-escalation primitive (ask_followup_question AND switch_mode
 * — see plans/switch-mode-headless.md; do NOT duplicate this for future
 * blocking tools).
 *
 * Writes `<workspaceRoot>/.harness.needs-decision` (JSON: question,
 * suggestions?, askedAt), then polls for `<workspaceRoot>/.harness.decision-
 * answer` every `decisionPollIntervalMs` (default 5s) up to
 * `decisionTimeoutMs` (default 30min). The session's budget-duration clock is
 * paused for the duration of the wait (see pauseBudgetClock/resumeBudgetClock
 * on ToolContext). Both marker files are ALWAYS cleaned up on every terminal
 * outcome, and the decision_blocked / decision_answered event hooks fire at
 * the same lifecycle points as before.
 *
 * The CALLER decides what each outcome means for the model:
 *  - answered: a human/orchestrator wrote the answer file; the raw answer
 *    text (trimmed) is returned for the caller to interpret.
 *  - timedOut: no answer arrived within the timeout; the marker is already
 *    cleaned up, so a caller that refuses on timeout leaves no debris.
 *  - writeFailed: the needs-decision marker itself couldn't be written (e.g.
 *    a read-only workspace) — the caller should fail immediately rather than
 *    block on an answer no one can ever provide.
 */
export async function escalateDecision(
	ctx: ToolContext,
	question: string,
	suggestions?: string[],
): Promise<DecisionEscalationResult> {
	const needsDecisionPath = path.join(ctx.workspaceRoot, NEEDS_DECISION_FILENAME)
	const answerPath = path.join(ctx.workspaceRoot, DECISION_ANSWER_FILENAME)
	const timeoutMs = ctx.decisionTimeoutMs ?? DEFAULT_DECISION_TIMEOUT_MS
	const pollIntervalMs = ctx.decisionPollIntervalMs ?? DEFAULT_DECISION_POLL_INTERVAL_MS
	const askedAt = new Date().toISOString()

	try {
		await fsp.writeFile(
			needsDecisionPath,
			JSON.stringify({ question, ...(suggestions ? { suggestions } : {}), askedAt }, null, 2) + "\n",
			"utf-8",
		)
	} catch (error) {
		// Can't even signal escalation (e.g. read-only workspace) — report the
		// failure and let the caller decide, rather than blocking on a wait no
		// one can ever answer.
		return { status: "writeFailed", error: errorMessage(error) }
	}
	// Live worker monitoring: mirror the marker write on the session's event
	// feed (see src/engine/events.ts). Non-fatal — a feed failure must never
	// affect the tool result.
	ctx.onDecisionEvent?.("decision_blocked", { question, ...(suggestions ? { suggestions } : {}) })

	ctx.pauseBudgetClock?.()
	let answered = false
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
				ctx.onDecisionEvent?.("decision_answered", { answer: answer.trim() })
				answered = true
				return { status: "answered", answer: answer.trim() }
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
	if (!answered) {
		ctx.onDecisionEvent?.("decision_answered", { timedOut: true })
	}
	// Timed out: clean up BOTH markers (BUG-3). The answer file is usually
	// absent here, but a write can land just after the poll loop's last read
	// and before this point (a narrow but real race — the poller's last
	// `readFile` above can lose to a concurrent writer by a few ms). If that
	// happens and only needsDecisionPath were unlinked, the stale answerPath
	// would sit on disk and get read as the answer to a LATER, unrelated
	// escalateDecision call (the next ask_followup_question/switch_mode, or a
	// later session reusing the same worktree) — poisoning it with a stale
	// answer for the wrong question. Unlinking both here, unconditionally,
	// closes that gap.
	await safeUnlink(needsDecisionPath)
	await safeUnlink(answerPath)
	return { status: "timedOut" }
}

/**
 * ask_followup_question — decision escalation (workstream 2). Thin wrapper
 * over the shared escalateDecision primitive: the semantics are UNCHANGED
 * from before the refactor.
 *
 * - Answer arrives in time: the answer text is returned as a NORMAL
 *   (non-error) tool result — the model continues with real input, and this
 *   does NOT count toward the loop's consecutive-mistake bounded-failure
 *   limit.
 * - Timeout elapses (or the marker couldn't even be written): the handler
 *   falls back to EXACTLY today's behavior — the "must decide autonomously"
 *   tool error, which DOES count as a mistake.
 */
async function askFollowupQuestionHandler(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
	const question = typeof args.question === "string" ? args.question : "(no question)"
	const suggestions = extractSuggestions(args.follow_up)
	const timeoutMs = ctx.decisionTimeoutMs ?? DEFAULT_DECISION_TIMEOUT_MS

	const outcome = await escalateDecision(ctx, question, suggestions)
	if (outcome.status === "writeFailed") {
		process.stderr.write(
			`[headlesscode] ask_followup_question: failed to write ${NEEDS_DECISION_FILENAME}, falling back to autonomous decision: ${outcome.error}\n`,
		)
		return autonomousDecisionError(question)
	}
	if (outcome.status === "answered") {
		return ok(`[Human/orchestrator answer received] ${outcome.answer}`)
	}

	// Timed out: fall back to exactly today's behavior.
	process.stderr.write(
		`[headlesscode] ask_followup_question: timed out after ${timeoutMs}ms waiting for ${DECISION_ANSWER_FILENAME}, falling back to autonomous decision.\n`,
	)
	return autonomousDecisionError(question)
}

// ─── update_todo_list (structured planning aid) ─────────────────────────────

/** Status of one checklist line — matches the vendored tool's vocabulary. */
export type TodoStatus = "pending" | "in_progress" | "completed"

/** One parsed checklist item. */
export interface TodoItem {
	content: string
	status: TodoStatus
}

/**
	 * Full session todo state, as surfaced by `onTodoEvent` / `getTodoList()`.
	 * `todos` is the normalized full checklist (every line, exactly as stored).
	 */
export interface TodoListSnapshot {
	todos: string
	done: number
	inProgress: number
	pending: number
}

/**
	 * Session-scoped todo list state. update_todo_list always REPLACES the whole
	 * list (per the vendored tool contract: "Always provide the full list; the
	 * system will overwrite the previous one"), so state is just the latest
	 * parsed checklist + derived counts. In-memory conversational state only —
	 * never written to a workspace file.
	 */
class TodoListState {
	todos = ""
	done = 0
	inProgress = 0
	pending = 0

	snapshot(): TodoListSnapshot | undefined {
		if (this.todos === "") {
			return undefined
		}
		return { todos: this.todos, done: this.done, inProgress: this.inProgress, pending: this.pending }
	}

	replace(todos: string, done: number, inProgress: number, pending: number): void {
		this.todos = todos
		this.done = done
		this.inProgress = inProgress
		this.pending = pending
	}
}

/**
	 * Parse a markdown checklist into items + the normalized list. Tolerant of
	 * `-`/`*`/`+` or no list marker, and of `[ ]` / `[x]` / `[X]` / `[-]`.
	 * Lines that don't look like checklist items are preserved in the normalized
	 * output (so an update never silently drops content) but excluded from the
	 * counts, mirroring the vendored tool's single-level checklist format.
	 */
export function parseTodoList(todos: string): { items: TodoItem[]; normalized: string } {
	const items: TodoItem[] = []
	const lines: string[] = []
	for (const raw of todos.split(/\r?\n/)) {
		const line = raw.trimEnd()
		lines.push(line)
		const m = /^\s*(?:[-*+]\s+)?\[(.)\]\s*(.*)$/.exec(line)
		if (!m) {
			continue
		}
		const marker = m[1]
		let status: TodoStatus = "pending"
		if (marker === "x" || marker === "X") {
			status = "completed"
		} else if (marker === "-") {
			status = "in_progress"
		}
		const content = m[2].trim()
		if (content !== "") {
			items.push({ content, status })
		}
	}
	return { items, normalized: lines.join("\n") }
}

/**
	 * The update_todo_list handler (vendored schema: `{todos: string}`, strict,
	 * required). Stores the full checklist as session state and echoes the
	 * normalized list + counts back, so the model sees exactly what was stored.
	 * Fires `onTodoEvent` on every call so the session can surface a
	 * `todo_updated` feed event for observability.
	 */
function updateTodoListHandler(args: Record<string, unknown>, ctx: ToolContext, state: TodoListState): ToolResult {
	const todos = requireString(args, "todos")
	const { items, normalized } = parseTodoList(todos)
	const done = items.filter((i) => i.status === "completed").length
	const inProgress = items.filter((i) => i.status === "in_progress").length
	const pending = items.filter((i) => i.status === "pending").length

	state.replace(normalized, done, inProgress, pending)

	ctx.onTodoEvent?.({ todos: normalized, done, inProgress, pending })

	return ok(`TODO list updated (${done} completed, ${inProgress} in progress, ${pending} pending):\n${normalized}`)
}

/** Stub for vendored tools that the headless harness does not implement. */
function stubHandler(name: string, implemented: readonly string[] = ["read_file", "write_to_file", "apply_diff", "search_replace", "edit_file", "execute_command", "list_files", "codebase_search"]): ToolHandler {
	const available = [...implemented].sort().join(", ")
	return () =>
		err(
			`Tool '${name}' is not implemented in the headless harness yet. Implemented tools: ${available}. Adapt and retry with one of those.`,
		)
}

/**
 * codebase_search — semantic search over the persisted codebase index.
 *
 * Embeds the query (one call), loads the central project store's
 * `codesearch/index.jsonl` (see src/project-store.ts — every worktree of a
 * repo shares the same index), brute-force cosine against every stored chunk,
 * and returns the top-K as `file:startLine-endLine` + a snippet — matching the
 * vendored CodebaseSearchTool's output shape (src/vendor/zoo-code/src/core/
 * tools/CodebaseSearchTool.ts).
 *
 * If no index exists yet, returns a clear ACTIONABLE error telling the model
 * to ask a human to run `headlesscode index` — deliberately NOT a silent
 * empty result ("no matches" would look like a legitimately empty search).
 * The index is built by a separate, explicit CLI step and is never
 * auto-triggered mid-session (it costs real money and takes real time).
 */
async function codebaseSearchHandler(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
	const query = requireString(args, "query")
	const pathPrefix = typeof args.path === "string" && args.path.trim() !== "" ? args.path : undefined

	return (async () => {
		// No index → actionable error, not a silent empty result.
		const indexFile = indexFilePath(ctx.workspaceRoot)
		try {
			await fsp.access(indexFile)
		} catch {
			return err(
				`codebase_search: no codebase index found at '${indexFile}'. ` +
					`The codebase has not been indexed yet. Ask a human to run ` +
					`'headlesscode index --workspace ${ctx.workspaceRoot}' first (this builds the semantic index ` +
					`and costs a small amount of embedding API money).`,
			)
		}

		// The query embedder must match the backend the index was built with.
		// Local and cloud embedding models produce different-dimension vectors
		// (ollama qwen3-embedding:8b = 4096, openrouter qwen/qwen3-embedding-4b
		// = 2560), so a mismatch would silently compare apples to oranges.
		// The env var/flag selection happens at index-build time; the index
		// metadata records which backend built it, and we use that backend
		// here — refusing explicitly when it can't be honored.
		const metadata = loadIndexMetadata(ctx.workspaceRoot)
		let queryBackend = resolveEmbeddingBackend(process.env)
		if (metadata && metadata.backend !== queryBackend) {
			return err(
				`codebase_search: index was built with backend "${metadata.backend}" (model "${metadata.model}"), ` +
					`but ${EMBEDDING_BACKEND_ENV} selects "${queryBackend}". Embedding backends produce ` +
					`different-dimension vectors and are NOT interchangeable — rebuild the index with ` +
					`'headlesscode index --embedding-backend ${queryBackend}' or unset ` +
					`${EMBEDDING_BACKEND_ENV} to search with the backend that built the index.`,
			)
		}
		if (metadata) {
			queryBackend = metadata.backend
		}

		// Embed the query (one call). This is a real network call; failures
		// surface as a tool error so the loop's mistake handling applies.
		const embedder = createEmbedder(queryBackend)
		const queryResult = await embedder.embedBatch([query])
		if (queryResult.embeddings.length !== 1) {
			return err(`codebase_search: embedder returned ${queryResult.embeddings.length} embeddings for the query`)
		}

		const results = searchIndex(ctx.workspaceRoot, queryResult.embeddings[0]!, pathPrefix)
		return ok(formatSearchResults(query, results))
	})()
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error)
}

/**
 * Spawn-failure diagnostics snapshot (issue #1).
 *
 * The bash-spawn-ENOENT failure ("spawn /bin/bash ENOENT", and the
 * close-event variant with a negative code) has one CONFIRMED contributing
 * factor — system memory commit pressure: when /proc/meminfo's Committed_AS
 * sits above ~95-98% of CommitLimit, spawn failure rates spike — plus several
 * unconfirmed candidates (open-fd exhaustion, the ulimit -u process-count
 * ceiling, zombie/defunct accumulation, RSS growth in the long-running
 * harness process). Rather than infer the cause after the fact from separate
 * /proc snapshots, capture a one-shot snapshot AT the moment of each spawn
 * failure. Every read is best-effort: a missing /proc file (non-Linux host,
 * restricted container) yields "n/a" for that field instead of throwing, and
 * a failure here must never abort the spawn-retry logic this is diagnosing.
 */
export function collectSpawnDiagnostics(): Record<string, string> {
	const diag: Record<string, string> = {}

	// Memory commit pressure — the confirmed contributor. Values in kB.
	let committedAsKb = "n/a"
	let commitLimitKb = "n/a"
	try {
		const meminfo = fs.readFileSync("/proc/meminfo", "utf8")
		for (const line of meminfo.split("\n")) {
			if (line.startsWith("Committed_AS:")) {
				committedAsKb = (line.split(/\s+/)[1] ?? "n/a").trim()
			} else if (line.startsWith("CommitLimit:")) {
				commitLimitKb = (line.split(/\s+/)[1] ?? "n/a").trim()
			}
		}
	} catch {
		// non-Linux or /proc not mounted — fields stay "n/a"
	}
	diag.committedAsKb = committedAsKb
	diag.commitLimitKb = commitLimitKb
	const committed = Number(committedAsKb)
	const limit = Number(commitLimitKb)
	diag.committedPct =
		Number.isFinite(committed) && Number.isFinite(limit) && limit > 0
			? `${((committed / limit) * 100).toFixed(1)}%`
			: "n/a"

	// Open fd count for THIS process — fd exhaustion near the soft limit is a
	// candidate contributor (posix_spawn needs fds for the child's stdio).
	try {
		diag.openFds = String(fs.readdirSync("/proc/self/fd").length)
	} catch {
		diag.openFds = "n/a"
	}

	// System process count + zombie/defunct count + the ulimit -u ceiling.
	// The zombie scan is bounded to the first 1024 pids so the diagnostic
	// stays lightweight even on a box with tens of thousands of processes —
	// this runs ON a spawn-failure path and must never make it slower.
	let procs = 0
	let zombies = 0
	try {
		const pids = fs.readdirSync("/proc").filter((e) => /^\d+$/.test(e))
		procs = pids.length
		for (const pid of pids.slice(0, 1024)) {
			try {
				const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8")
				// comm can contain spaces and parens — the state char is the
				// first field after the LAST ')', two chars later.
				const closeParen = stat.lastIndexOf(")")
				if (closeParen !== -1 && closeParen + 2 < stat.length && stat[closeParen + 2] === "Z") {
					zombies++
				}
			} catch {
				// pid exited between readdir and read — not a zombie
			}
		}
	} catch {
		// non-Linux — both stay at their defaults
	}
	diag.systemProcs = procs > 0 ? String(procs) : "n/a"
	diag.zombies = procs > 0 ? String(zombies) : "n/a"
	let maxProcs = "n/a"
	try {
		const limits = fs.readFileSync("/proc/self/limits", "utf8")
		const m = limits.match(/Max processes\s+(\d+)/)
		if (m) {
			maxProcs = m[1]!
		}
	} catch {
		// non-Linux
	}
	diag.maxProcs = maxProcs

	// The long-running harness's own footprint — RSS climbs slowly over hours
	// (the observed llama-server pattern); heap/uptime come from process.*.
	let rssMb = "n/a"
	try {
		const status = fs.readFileSync("/proc/self/status", "utf8")
		const m = status.match(/VmRSS:\s+(\d+) kB/)
		if (m) {
			rssMb = `${(Number(m[1]!) / 1024).toFixed(0)}`
		}
	} catch {
		// non-Linux
	}
	diag.rssMb = rssMb
	diag.heapMb = `${Math.round(process.memoryUsage().heapUsed / (1024 * 1024))}`
	diag.uptimeS = `${Math.round(process.uptime())}`

	return diag
}

/** Render a diagnostics snapshot as one grep-friendly `key=value` line. */
export function formatSpawnDiagnostics(diag: Record<string, string>): string {
	return [
		`committed=${diag.committedPct} (${diag.committedAsKb}/${diag.commitLimitKb} kB)`,
		`openFds=${diag.openFds}`,
		`procs=${diag.systemProcs}`,
		`zombies=${diag.zombies}`,
		`maxProcs=${diag.maxProcs}`,
		`rss=${diag.rssMb}MB`,
		`heap=${diag.heapMb}MB`,
		`uptime=${diag.uptimeS}s`,
	].join(" ")
}

/**
 * One-line, always-on stderr log emitted at the moment of a spawn failure.
 * Unconditional (NOT HEADLESSCODE_DEBUG-gated): the whole point is that the
 * NEXT real-session occurrence gets captured without anyone having to
 * remember to enable a flag first.
 */
function logSpawnDiagnostics(command: string, attempt: number, shape: string, error?: unknown, code?: number | null): void {
	const detail =
		error !== undefined
			? ` error=${errorMessage(error)}`
			: code !== undefined
				? ` code=${code}`
				: ""
	const shown = command.length > 200 ? `${command.slice(0, 200)}…` : command
	process.stderr.write(
		`[execute_command spawn-diagnostics] shape=${shape} attempt=${attempt}${detail} cmd=${JSON.stringify(shown)} ${formatSpawnDiagnostics(collectSpawnDiagnostics())}\n`,
	)
}

/**
 * Lazily construct the session's local summarizer. Returns undefined when the
 * feature is off (never construct an Ollama client for a non-opted-in
 * session). One executor = one summarizer, so a session that keeps producing
 * oversized results reuses the same client across calls.
 */
function makeSummarizer(): OllamaOutputSummarizer | undefined {
	if (!isLocalSummarizationEnabled()) {
		return undefined
	}
	if (toolSummarizer === undefined) {
		toolSummarizer = new OllamaOutputSummarizer()
	}
	return toolSummarizer
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

const IMPLEMENTED_TOOLS = new Set([
	"read_file",
	"write_to_file",
	"apply_diff",
	"search_replace",
	"edit_file",
	"execute_command",
	"list_files",
	"codebase_search",
	"browser_action",
	"describe_image",
	"outline",
	"go_to_definition",
	"find_references",
	"import_graph",
	"update_todo_list",
	// Recursive task decomposition: implemented by HeadlessSession itself
	// (HeadlessSession.register registers handleNewTask on the executor —
	// see src/engine/loop.ts). The handler needs the SESSION (lineage,
	// budget, checkpoint service), so it lives there, not in this file's
	// stateless handler factory; read-only executors (reviewer/QA/local
	// explore) still stub it as "not implemented" via the vendored schema.
	"new_task",
	// switch_mode (plans/switch-mode-headless.md): implemented by
	// HeadlessSession itself for the same reason as new_task — the handler
	// needs SESSION state (current mode, transcript, mode-switch counter) and
	// shares ask_followup_question's decision-escalation marker protocol.
	// Read-only executors (reviewer/QA/local explore) still stub it via the
	// vendored schema.
	"switch_mode",
])

/**
 * Register the TS-ONLY code-intelligence tools + run_tests — CONDITIONALLY,
 * gated on the workspace actually being TS/JS (src/tools/language-detect.ts).
 * All of these are built on ts.Program/tsx: on a Python/C++/Rust workspace
 * they are dead weight (advertised on every request, costing prompt tokens,
 * silently useless if tried) — the same "match the tool list to what actually
 * works" discipline `codebase_search` already models with its broad extension
 * list. On non-TS workspaces they are NOT registered here, so both the
 * executor and the advertised tool list (loop.ts gates advertisement on
 * executor.has) omit them.
 */
function registerTypeScriptGatedTools(
	executor: ToolExecutor,
	workspaceRoot: string,
	options: ToolExecutorOptions = {},
): void {
	if (!isTypeScriptWorkspace(workspaceRoot)) {
		return
	}
	executor.register("outline", outlineHandler)
	executor.register("go_to_definition", goToDefinitionHandler)
	executor.register("find_references", findReferencesHandler)
	executor.register("import_graph", importGraphHandler)
	// rename_symbol EDITS files, so it is deliberately NOT registered on the
	// read-only executors (reviewer/QA/local explore) — they must never be
	// able to modify source, and their tool lists don't advertise it either
	// (see the RENAME_SYMBOL_TOOL note in src/codeintel/tools.ts).
	executor.register("rename_symbol", renameSymbolHandler)
	// run_tests RUNS the project's test suite — an edit-loop tool, not a
	// read-only inspection, so like rename_symbol it is only registered on
	// the headless (edit-capable) executor. Reviewer/QA use execute_command
	// to run tests themselves; their tool lists don't advertise run_tests.
	executor.register("run_tests", (args, ctx) => runTestsHandler(args, ctx, options.getSessionChangedFiles))
}

/**
 * Create the default headless executor for a workspace root: the 7 core tools
 * (read_file, write_to_file, apply_diff, search_replace, edit_file,
 * execute_command, list_files), attempt_completion + ask_followup_question
 * handlers, and stubs for every other vendored tool schema.
 */
export function createHeadlessExecutor(workspaceRoot: string, options: ToolExecutorOptions = {}): ToolExecutor {
	const executor = new ToolExecutor(workspaceRoot, options)

	executor.registerReadFile()
	executor.register("write_to_file", writeToFileHandler)
	executor.register("apply_diff", applyDiffHandler)
	executor.register("search_replace", searchReplaceHandler)
	executor.register("edit_file", editFileHandler)
	executor.register("set_indentation", setIndentationHandler)
	executor.register("execute_command", executeCommandHandler)
	executor.registerListFiles()
	executor.register("codebase_search", codebaseSearchHandler)
	executor.register("browser_action", browserActionHandler)
	executor.register("describe_image", describeImageHandler)
	registerTypeScriptGatedTools(executor, workspaceRoot, options)
	executor.registerTodoList()

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

	executor.registerReadFile()
	executor.registerListFiles()
	executor.register("execute_command", executeCommandHandler)
	executor.register("browser_action", browserActionHandler)
	// The four read-only code-intelligence tools (TS-only) follow the same
	// language gate as the headless executor — a reviewer of a C++/Python
	// workspace must not be handed ts.Program tools.
	if (isTypeScriptWorkspace(workspaceRoot)) {
		executor.register("outline", outlineHandler)
		executor.register("go_to_definition", goToDefinitionHandler)
		executor.register("find_references", findReferencesHandler)
		executor.register("import_graph", importGraphHandler)
	}

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

/**
 * Create the STRICTLY read-only executor for the opt-in local exploration
 * phase (see src/engine/local-explore.ts): only read_file and list_files are
 * real tools. attempt_completion is registered but its result is intercepted
 * by the local loop as the explicit "I have enough, hand off" signal — it is
 * NOT a real task completion. Every other tool — execute_command,
 * codebase_search, every write tool, ask_followup_question, browser_action —
 * is a stub.
 *
 * Deliberately narrower than createReadOnlyHeadlessExecutor (reviewer/QA),
 * which includes execute_command: arbitrary command execution has real
 * side-effect potential even without file writes, and this phase must be
 * pure information-gathering. codebase_search IS included: its embedding
 * call is cloud-side (OpenRouter), so it touches no local VRAM — the
 * original exclusion assumed a local embedding model co-resident with the
 * exploration model, which the deployed cloud embedder makes moot (the
 * cloud model still gets full codebase_search access in its own turn).
 */
export function createLocalExploreExecutor(workspaceRoot: string, options: ToolExecutorOptions = {}): ToolExecutor {
	const executor = new ToolExecutor(workspaceRoot, options)

	executor.registerReadFile()
	executor.registerListFiles()
	executor.register("codebase_search", codebaseSearchHandler)
	executor.register("attempt_completion", attemptCompletionHandler)

	for (const name of VENDORED_TOOL_NAMES) {
		if (executor.has(name)) {
			continue
		}
		executor.register(name, stubHandler(name, ["read_file", "list_files", "codebase_search", "attempt_completion"]))
	}

	return executor
}

