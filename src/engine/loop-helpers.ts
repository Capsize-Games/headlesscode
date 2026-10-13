/**
 * Pure sync helpers moved from src/engine/loop.ts (#127 slice).
 * Behavior-identical moves; loop.ts re-exports them.
 * Leaf imports only (never loop.ts): no import cycle.
 */

import { isReadOnlyEquivalentShellCommand } from "./tool-classes.js"
import type { ChatMessage, ChatTool } from "./types.js"
import type { ToolExecutor } from "../tools/executor.js"
import type {
	ExtensionRevision,
	ExtensionSummary,
} from "../extensions/registry.js"
import { MAX_BATCH_CALLS } from "../tools/batch.js"

export function combineAbortSignals(
	signals: readonly (AbortSignal | undefined)[],
): { signal: AbortSignal; dispose: () => void } {
	const controller = new AbortController()
	type Entry = { signal: AbortSignal; listener: () => void }
	const listeners: Entry[] = []
	for (const signal of signals) {
		if (!signal) continue
		if (signal.aborted) {
			controller.abort(signal.reason)
			break
		}
		const listener = (): void => {
			controller.abort(signal.reason)
		}
		signal.addEventListener("abort", listener, { once: true })
		listeners.push({ signal, listener })
	}
	const dispose = (): void => {
		for (const e of listeners) {
			e.signal.removeEventListener("abort", e.listener)
		}
	}
	return { signal: controller.signal, dispose }
}

/** Monitor observations cannot mutate nested tool args. */
export function immutableBoundaryArguments(
	args: Record<string, unknown>,
): Readonly<Record<string, unknown>> {
	const copy = structuredClone(args)
	const pending: unknown[] = [copy]
	while (pending.length > 0) {
		const value = pending.pop()
		if (value === null || typeof value !== "object") continue
		for (const child of Object.values(value)) {
			pending.push(child)
		}
		Object.freeze(value)
	}
	return copy
}

/** Tool names that count as "blind tree-walking". */
const READ_ONLY_TOOL_NAMES = new Set([
	"list_files",
	"read_file",
	"search_files",
])

/** Direct-call read-only test for top-level and batch calls. */
export function isReadOnlyDirectCall(call: {
	name: string
	args: Record<string, unknown>
}): boolean {
	if (READ_ONLY_TOOL_NAMES.has(call.name)) return true
	if (call.name !== "execute_command") return false
	if (typeof call.args.command !== "string") return false
	return isReadOnlyEquivalentShellCommand(call.args.command)
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	if (typeof value !== "object" || value === null) return undefined
	if (Array.isArray(value)) return undefined
	return value as Record<string, unknown>
}

function isBatchChildReadOnly(item: unknown): boolean {
	const record = asRecord(item)
	if (!record) return false
	const tool = record["tool"]
	if (typeof tool !== "string" || tool.trim() === "") return false
	if (tool === "batch") return false
	const subArgs = asRecord(record["args"] ?? {})
	if (!subArgs) return false
	return isReadOnlyDirectCall({
		name: tool,
		args: subArgs as Record<string, unknown>,
	})
}

/** Whether one top-level turn call counts as read-only. */
export function isReadOnlyTurnCall(call: {
	name: string
	args: Record<string, unknown>
}): boolean {
	if (call.name !== "batch") {
		return isReadOnlyDirectCall(call)
	}
	const raw = call.args.calls
	if (!Array.isArray(raw) || raw.length === 0) return false
	if (raw.length > MAX_BATCH_CALLS) return false
	return raw.every(isBatchChildReadOnly)
}

/** Artifact-gate rejection guardrail nudge (issue #152). */
export function artifactRejectionNudgeMessage(
	streak: number,
	relativePath: string,
): string {
	const parts = [
		`Your last ${streak} attempts to complete this `,
		"task were rejected for the same reason, and ",
		`each time you edited '${relativePath}' without `,
		"making any read_file call in between. Adding a ",
		"citation-shaped string or a section heading does ",
		"NOT satisfy this requirement unless it reflects ",
		"something real you actually verified — a ",
		"citation with a real line number but a wrong ",
		"description of what's there, or a section ",
		"heading with placeholder content, is worse ",
		"than not having it at all. Before your next ",
		"edit: use read_file on the real source file(s) ",
		"you intend to cite, confirm exactly what's ",
		"at that line, and only then write content that ",
		"genuinely reflects it. Do not just patch in ",
		"the missing surface feature again.",
	]
	return parts.join("")
}

/** Keep reasoning only on the most-recent assistant message. */
export function stripSupersededReasoning(
	messages: ChatMessage[],
): void {
	let lastAssistant = -1
	for (let i = messages.length - 1; i >= 0; i--) {
		if (messages[i].role === "assistant") {
			lastAssistant = i
			break
		}
	}
	for (let i = 0; i < messages.length; i++) {
		const stale = i !== lastAssistant
		const isAssistant = messages[i].role === "assistant"
		const hasReasoning = messages[i].reasoning !== undefined
		if (stale && isAssistant && hasReasoning) {
			messages[i].reasoning = undefined
		}
	}
}

/** Approx token count from chars (~4 chars/token). */
export function estimateTokenSize(chars: number): number {
	return Math.ceil(chars / 4)
}

/** True when two tool lists advertise the same name set. */
export function sameToolNames(a: ChatTool[], b: ChatTool[]): boolean {
	const names = (tools: ChatTool[]): string[] =>
		tools
			.filter((t) => t.type === "function")
			.map((t) => t.function.name)
			.sort()
	const na = names(a)
	const nb = names(b)
	if (na.length !== nb.length) return false
	return na.every((n, i) => n === nb[i])
}

/** Stable-prefix check for background condense snapshots. */
export function messagesPrefixEquals(
	live: ChatMessage[],
	snapshot: ChatMessage[],
): boolean {
	if (live.length < snapshot.length) return false
	return snapshot.every((m, i) => live[i] === m)
}

const WORKSPACE_WRITE_TOOLS = new Set([
	"write_to_file",
	"apply_diff",
	"search_replace",
	"edit_file",
	"set_indentation",
])

export function hasWorkspaceWriteTool(
	tools: readonly ChatTool[],
): boolean {
	return tools.some(
		(tool) =>
			tool.type === "function" &&
			WORKSPACE_WRITE_TOOLS.has(tool.function.name),
	)
}

export function hasExecutorWorkspaceWriteTool(
	executor: ToolExecutor,
): boolean {
	return [...WORKSPACE_WRITE_TOOLS].some((name) =>
		executor.has(name),
	)
}

export function extensionIdentity(
	revision: ExtensionRevision,
): { kind: "skill" | "tool" | "mcp"; id: string; digest: string } {
	return {
		kind: revision.manifest.kind,
		id: revision.manifest.id,
		digest: revision.digest,
	}
}

export function extensionSummaryData(
	summary: ExtensionSummary,
): { manifest: ExtensionSummary["manifest"]; digest: string } {
	return { manifest: summary.manifest, digest: summary.digest }
}

export function boundedExtensionJson(value: unknown): string {
	const serialized = JSON.stringify(value)
	const tooLarge =
		typeof serialized !== "string" ||
		Buffer.byteLength(serialized, "utf8") > 512 * 1024
	if (tooLarge) {
		throw new Error(
			"extension result exceeds the 512 KiB session result limit",
		)
	}
	return serialized
}
