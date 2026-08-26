/**
 * Synchronous single-tool execution for the dashboard control plane.
 *
 * Gives callers (e.g. a host app's code-mode agent tools — see the host
 * project's uwuchat server `proxy_tools.py`) the same
 * headlesscode tool set WITHOUT spinning up a full session: build one
 * `ToolExecutor` for a workspace root, run exactly one tool call, return the
 * `ToolResult`. Every guardrail is inherited from the executor — workspace
 * path safety (`resolveWithinWorkspace`), command allow/deny + protected-file
 * permissions (`src/permissions/`), output truncation, timeout→background
 * semantics for `execute_command`.
 *
 * Deliberately STATELESS: each call constructs a fresh executor, so the
 * session-scoped read_file cache, list_files repeat-call guard, and todo list
 * do NOT carry across calls. UwUChat's own conversation history is the cache.
 * Revisit with a session-keyed executor pool if token cost from re-reading
 * files ever becomes material.
 *
 * Background-command semantics: `execute_command`'s timeout leaves the child
 * running in the background (the model gets partial output + "running in the
 * background"). For the proxy we call `executor.dispose()` in a `finally`,
 * which hard-kills any backgrounded child (see ToolExecutor.dispose /
 * killBackgroundCommands) — the proxy does NOT support long-running
 * background commands; a timed-out call returns partial output and the child
 * is reaped. Callers should pass an explicit `timeout` to bound long commands.
 */

import * as fs from "node:fs"

import { createHeadlessExecutor } from "../tools/executor.js"
import type { ToolResult } from "../engine/types.js"

/** Request body for POST /api/tool/execute. */
export interface ToolExecuteRequest {
	/** Workspace root the tool runs against (the registered project's worktree). */
	workspace: string
	/** Tool name, e.g. "execute_command". */
	name: string
	/** Tool args (command/cwd for execute_command, path/content for file tools…). */
	args: Record<string, unknown>
}

/** Response body for POST /api/tool/execute. */
export interface ToolExecuteResult {
	ok: boolean
	isError: boolean
	content: string
}

/**
 * Run one tool call against `req.workspace` and return the executor result.
 *
 * Validates the request shape first (workspace exists + absolute, name
 * non-empty, args an object). `executor.dispose()` always runs afterwards so
 * a timed-out backgrounded `execute_command` child is hard-killed rather than
 * orphaned.
 */
export function executeTool(req: ToolExecuteRequest): Promise<ToolExecuteResult> {
	const err = validateToolExecuteRequest(req)
	if (err) {
		return Promise.resolve({ ok: false, isError: true, content: err })
	}
	const executor = createHeadlessExecutor(req.workspace)
	try {
		return executor.execute(req.name, req.args).then((result: ToolResult) => ({
			ok: !result.isError,
			isError: result.isError,
			content: result.content,
		}))
	} finally {
		executor.dispose()
	}
}

/** Return a validation error string, or null when `req` is well-formed. */
export function validateToolExecuteRequest(req: ToolExecuteRequest): string | null {
	if (!req || typeof req !== "object") {
		return "invalid request body — expected { workspace, name, args }"
	}
	if (typeof req.workspace !== "string" || req.workspace.trim() === "") {
		return "missing 'workspace' — provide the absolute workspace root the tool should run against"
	}
	if (!pathIsAbsolute(req.workspace)) {
		return `'workspace' must be an absolute path: ${req.workspace}`
	}
	if (!fs.existsSync(req.workspace)) {
		return `'workspace' does not exist: ${req.workspace}`
	}
	if (typeof req.name !== "string" || req.name.trim() === "") {
		return "missing 'name' — provide the tool name to execute"
	}
	if (req.args === null || typeof req.args !== "object" || Array.isArray(req.args)) {
		return "'args' must be an object of tool arguments"
	}
	return null
}

/** `path.isAbsolute` without importing node:path (kept dependency-light). */
function pathIsAbsolute(p: string): boolean {
	if (p.startsWith("/")) {
		return true
	}
	if (/^[A-Za-z]:[\\/]/.test(p)) {
		return true
	}
	return false
}
