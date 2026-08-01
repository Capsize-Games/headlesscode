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
 *
 * Every file operation resolves relative to the configured workspace root and
 * is rejected if it escapes the workspace (path-traversal guard). Results are
 * plain strings + an { isError } flag; long outputs are truncated to keep the
 * model context bounded.
 *
 * The three surgical edit tools are backed by the vendored Zoo Code diff
 * logic: `apply_diff` uses the fuzzy MultiSearchReplaceDiffStrategy
 * (src/vendor/zoo-code/src/core/diff/strategies/multi-search-replace.ts),
 * `search_replace` is a strict one-occurrence literal match, and `edit_file`
 * falls back exact → whitespace-tolerant → token-based matching (plus
 * file-creation when old_string is "").
 */

import * as fs from "node:fs"
import * as fsp from "node:fs/promises"
import * as path from "node:path"
import { spawn } from "node:child_process"
import { setTimeout as sleep } from "node:timers/promises"

// Side effect: installs String.prototype.toPosix() used by path formatting.
import "../vendor/zoo-code/src/utils/path.js"

import { MultiSearchReplaceDiffStrategy } from "../vendor/zoo-code/src/core/diff/strategies/multi-search-replace.js"

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
								`edit_file: occurrence count mismatch in file '${rel}'\n\n<error_details>\nExpected ${expectedReplacements} occurrence(s) but found ${exactOccurrences} exact match(es).\n\nRecovery suggestions:\n1. Provide a more specific old_string so it matches exactly once\n2. If you intend to replace all occurrences, set expected_replacements to ${exactOccurrences}\n3. Use read_file to confirm the exact text and counts\n</error_details>`,
							)
						}
						return err(
							`edit_file: occurrence count mismatch in file '${rel}'\n\n<error_details>\nExpected ${expectedReplacements} occurrence(s), but matching found ${wsOccurrences} (whitespace-tolerant) and ${tokenOccurrences} (token-based).\n\nRecovery suggestions:\n1. Provide more surrounding context in old_string to make the match unique\n2. If multiple replacements are intended, adjust expected_replacements to the intended count\n3. Use read_file to confirm the current file contents and refine the match\n</error_details>`,
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

/** Stub for vendored tools that the headless harness does not implement. */
function stubHandler(name: string): ToolHandler {
	return () =>
		err(
			`Tool '${name}' is not implemented in the headless harness yet. Implemented tools: read_file, write_to_file, apply_diff, search_replace, edit_file, execute_command, list_files. Adapt and retry with one of those.`,
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

const IMPLEMENTED_TOOLS = new Set([
	"read_file",
	"write_to_file",
	"apply_diff",
	"search_replace",
	"edit_file",
	"execute_command",
	"list_files",
])

/**
 * Create the default headless executor for a workspace root: the 7 core tools
 * (read_file, write_to_file, apply_diff, search_replace, edit_file,
 * execute_command, list_files), attempt_completion + ask_followup_question
 * handlers, and stubs for every other vendored tool schema.
 */
export function createHeadlessExecutor(workspaceRoot: string, options: ToolExecutorOptions = {}): ToolExecutor {
	const executor = new ToolExecutor(workspaceRoot, options)

	executor.register("read_file", readFileHandler)
	executor.register("write_to_file", writeToFileHandler)
	executor.register("apply_diff", applyDiffHandler)
	executor.register("search_replace", searchReplaceHandler)
	executor.register("edit_file", editFileHandler)
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
