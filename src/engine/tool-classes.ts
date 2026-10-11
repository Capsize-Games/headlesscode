/**
 * Tool-call classification shared by the session loop (S3 concurrent-read
 * partition, same-file diagnosis, failure guardrails) and the `batch`
 * meta-tool (which partitions sub-calls the same way).
 *
 * Lives here — not in loop.ts — so tools/* can import it without an
 * import cycle back into the engine (a batch→loop edge re-entered
 * codeintel/tools.ts mid-evaluation and crashed with a TDZ error,
 * order-dependently).
 */

import * as path from "node:path"

/**
 * Leading command names treated as read-only-equivalent by
 * isReadOnlyEquivalentShellCommand — every one of these inspects the
 * workspace without changing it. Deliberately an ALLOW-list (default "not
 * read-only" for anything unrecognized) rather than a deny-list of mutating
 * commands: a shell one-liner is too open-ended to safely enumerate every
 * way it could mutate something, so the safe default is to under-count
 * (miss a real read-only command occasionally) rather than over-count (wrongly
 * treat a mutation as exploration and never nudge). Low stakes either way —
 * this only feeds a SOFT, reversible nudge, never a block.
 */
const READ_ONLY_SHELL_LEADING_COMMANDS = new Set([
	"grep",
	"egrep",
	"fgrep",
	"rg",
	"ag",
	"find",
	"ls",
	"cat",
	"head",
	"tail",
	"wc",
	"tree",
	"pwd",
	"echo",
	"printf",
	"stat",
	"file",
	"du",
	"basename",
	"dirname",
	"realpath",
	// A no-op — common as a `git status || true`-style fallback to suppress a
	// read-only command's non-zero exit (e.g. `git log` in a fresh repo).
	"true",
])
/** git/docker subcommands that only inspect state (vs. `git commit`, ...). */
const READ_ONLY_GIT_SUBCOMMANDS = new Set([
	"log",
	"diff",
	"status",
	"show",
	"blame",
	"branch",
	"rev-parse",
	"remote",
])
const READ_ONLY_DOCKER_SUBCOMMANDS = new Set([
	"ps",
	"images",
	"logs",
	"inspect",
])

/**
 * Measured on a live round (harness slowness investigation, 2026-08-08):
 * `execute_command` — NOT `read_file`/`list_files` — was the dominant
 * exploration tool by a wide margin (e.g. 37-48 execute_command calls per
 * session vs. 0-1 codebase_search calls), almost entirely ad hoc
 * grep/ls/sed/find one-liners doing the exact job `codebase_search` exists to
 * shortcut. The blind-tree-walking guardrail above never saw any of this
 * because `execute_command` wasn't in READ_ONLY_TOOL_NAMES — a long streak of
 * pure shell-grep exploration could run the entire session without ever
 * tripping the nudge. This classifier closes that gap: a `sed -n`/`cat`/`git
 * log`/`docker ps`-style command reads exactly like `read_file`/`list_files`
 * for this guardrail's purposes and should count the same way. Compound
 * commands (`&&`/`;`/`|`/newline-joined) count only if EVERY segment is
 * read-only — one mutating segment (a `git commit`, `docker compose up`, a
 * bare `>` redirect, `sed -i`) marks the whole command as NOT read-only.
 */
export function isReadOnlyEquivalentShellCommand(command: string): boolean {
	// `\|\|` MUST be tried before the bare `\|` alternative below it, or a
	// `cmd || true` fallback splits into a stray `true` segment (not on the
	// allow-list) and the whole command wrongly reads as mutating.
	const segments = command.split(/\|\||&&|;|\||\n/).map((s) => s.trim())
	if (segments.length === 0 || segments.every((s) => s === "")) {
		return false
	}
	for (const segment of segments) {
		if (segment === "") {
			continue
		}
		// A bare `>`/`>>` writes a file; `2>&1`/`>&2` (fd-to-fd redirects) don't.
		if (/(?<!\d)>>?(?!&)/.test(segment)) {
			return false
		}
		const words = segment.split(/\s+/).filter(Boolean)
		const head = words[0]
		if (head === "cd") {
			// A leading `cd x &&` is just a working-dir change, not an inspection.
			continue
		}
		if (head === "sed") {
			// `sed -n '...'` (print-only) is read-only; anything with `-i` is not.
			if (words.includes("-i") || words.some((w) => w.startsWith("-i"))) {
				return false
			}
			continue
		}
		if (head === "git") {
			if (READ_ONLY_GIT_SUBCOMMANDS.has(words[1] ?? "")) {
				continue
			}
			return false
		}
		if (head === "docker") {
			// `docker compose ps/logs` vs. `docker compose up/down/build`.
			const sub = words[1] === "compose" ? words[2] : words[1]
			if (READ_ONLY_DOCKER_SUBCOMMANDS.has(sub ?? "")) {
				continue
			}
			return false
		}
		if (READ_ONLY_SHELL_LEADING_COMMANDS.has(head ?? "")) {
			continue
		}
		return false
	}
	return true
}

/**
 * (S3) Tool names that are safe to run CONCURRENTLY with their siblings in a
 * single turn: plain read/exploration tools with no shared mutable state.
 * `execute_command` is additionally gated per-call by
 * isReadOnlyEquivalentShellCommand (see isParallelReadOnlyCall).
 */
export const PARALLEL_READ_ONLY_TOOL_NAMES = new Set([
	"read_file",
	"list_files",
	"search_files",
	// TS code-intelligence reads (src/codeintel/) — read-only, executor-side.
	"outline",
	"go_to_definition",
	"find_references",
	"import_graph",
	"get_diagnostics",
	"type_at_position",
	"call_hierarchy",
	"workspace_symbol",
	"find_implementations",
])

/**
 * (S3) Whether a call may run concurrently with the turn's other read-only
 * calls. Only pure reads qualify: the tools above, plus an execute_command
 * whose shell command is read-only-equivalent. Everything else — any
 * edit-capable call, switch_mode / ask_followup_question / new_task (the
 * single decision-marker protocol), or anything ambiguous — is serial.
 * A read_file whose path collides with a file an edit call in this turn
 * modifies is ALSO serial: the model composed that read against the file's
 * state at its position in the turn, so submission order must be preserved
 * (a read-then-edit must see pre-edit content; an edit-then-read must see
 * post-edit content).
 */
export function isParallelReadOnlyCall(
	workspaceRoot: string,
	call: { name: string; args: Record<string, unknown> },
	editedPaths: ReadonlySet<string>,
): boolean {
	if (call.name === "execute_command") {
		return typeof call.args.command === "string" &&
			isReadOnlyEquivalentShellCommand(call.args.command)
	}
	if (!PARALLEL_READ_ONLY_TOOL_NAMES.has(call.name)) {
		return false
	}
	if (call.name === "read_file") {
		const pathArg = call.args.path
		const raw = typeof pathArg === "string" && pathArg.trim() !== ""
			? pathArg
			: undefined
		if (raw !== undefined) {
			try {
				if (editedPaths.has(path.resolve(workspaceRoot, raw))) {
					return false
				}
			} catch {
				// Unresolvable path: fall through — a parallel read is harmless.
			}
		}
	}
	return true
}

/** Edit tools whose args name a target file (same-file batch diagnosis). */
const BATCH_EDIT_TOOL_NAMES = new Set([
	"apply_diff",
	"search_replace",
	"edit_file",
	"write_to_file",
	"set_indentation",
])

/**
 * Best-effort absolute path for ANY tool call's `path`/`file_path` arg —
 * factored out of editToolTargetPath (below) so the repeated-tool-failure
 * guardrail (issue #146) can recognize a `read_file` call as re-diagnosis
 * of the SAME target a different, currently-failing tool is acting on
 * (read_file isn't in BATCH_EDIT_TOOL_NAMES, so editToolTargetPath alone
 * never resolves it).
 */
export function toolCallPathArg(
	workspaceRoot: string,
	call: { args: Record<string, unknown> },
): string | undefined {
	const byPath = typeof call.args.path === "string" &&
		call.args.path.trim() !== ""
		? call.args.path
		: undefined
	const byFilePath = typeof call.args.file_path === "string" &&
		call.args.file_path.trim() !== ""
		? call.args.file_path
		: undefined
	const raw = byPath ?? byFilePath
	if (raw === undefined) {
		return undefined
	}
	try {
		return path.resolve(workspaceRoot, raw)
	} catch {
		return undefined
	}
}

export function editToolTargetPath(
	workspaceRoot: string,
	call: { name: string; args: Record<string, unknown> },
): string | undefined {
	if (!BATCH_EDIT_TOOL_NAMES.has(call.name)) {
		return undefined
	}
	return toolCallPathArg(workspaceRoot, call)
}
