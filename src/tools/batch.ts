/**
 * `batch`: run up to MAX_BATCH_CALLS tool calls as ONE turn — for models
 * that emit one call per turn and would otherwise pay a full LLM round
 * trip per read. Read-only sub-calls run concurrently; edits run in
 * submission order (the loop's S3 partition, reused, not reimplemented).
 *
 * `strict` is deliberately false below: sub-call `args` are free-form
 * per-tool objects, which strict schemas cannot express. Each sub-call
 * is validated at runtime instead; a malformed batch is a batch-level
 * error, while a bad sub-call is a per-section error whose siblings
 * still run.
 */

import { editToolTargetPath, isParallelReadOnlyCall } from "../engine/tool-classes.js"
import type { ToolContext, ToolResult } from "../engine/types.js"
import { assembleSections, formatSummary } from "./batch-format.js"
import type { ToolExecutor } from "./executor.js"

/** Hard cap on sub-calls per batch (bounds one turn's blast radius). */
export const MAX_BATCH_CALLS = 10

/** Tools that must be their own top-level turn, never a sub-call. */
const REFUSED_IN_BATCH = new Set([
	"batch",
	"new_task",
	"switch_mode",
	"ask_followup_question",
	"attempt_completion",
])

/** One validated sub-call. */
interface BatchSubCall {
	tool: string
	args: Record<string, unknown>
}

/** One executed, refused, or skipped sub-call, in submission order. */
export interface BatchSection {
	tool: string
	ok: boolean
	skipped: boolean
	content: string
}

/** Parsed batch args: sub-calls + the stop flag. */
interface BatchRequest {
	calls: BatchSubCall[]
	stopOnError: boolean
}

function parseBatchArgs(
	args: Record<string, unknown>,
	tool: string,
): BatchRequest {
	const raw = args["calls"]
	if (!Array.isArray(raw) || raw.length === 0) {
		throw new Error(`${tool}: 'calls' must be a non-empty array`)
	}
	if (raw.length > MAX_BATCH_CALLS) {
		throw new Error(`${tool}: at most ${MAX_BATCH_CALLS} sub-calls`)
	}
	const calls = raw.map((item, index) => parseSubCall(item, index, tool))
	return { calls, stopOnError: args["stop_on_error"] === true }
}

function parseSubCall(
	item: unknown,
	index: number,
	tool: string,
): BatchSubCall {
	if (typeof item !== "object" || item === null || Array.isArray(item)) {
		throw new Error(`${tool}: calls[${index}] must be an object`)
	}
	const record = item as Record<string, unknown>
	const name = record["tool"]
	if (typeof name !== "string" || name.trim() === "") {
		throw new Error(`${tool}: calls[${index}].tool must be a string`)
	}
	const subArgs = record["args"] ?? {}
	if (
		typeof subArgs !== "object" || subArgs === null ||
		Array.isArray(subArgs)
	) {
		throw new Error(`${tool}: calls[${index}].args must be an object`)
	}
	return { tool: name, args: subArgs as Record<string, unknown> }
}

/** Why a sub-call cannot run here, or undefined when it can. */
function refusalFor(
	executor: ToolExecutor,
	sub: BatchSubCall,
): string | undefined {
	if (REFUSED_IN_BATCH.has(sub.tool)) {
		return `'${sub.tool}' cannot run inside batch — call it as its own`
			+ " top-level turn"
	}
	if (!executor.has(sub.tool)) {
		return `tool '${sub.tool}' is not available on this executor`
	}
	return undefined
}

async function runSubCall(
	executor: ToolExecutor,
	sub: BatchSubCall,
): Promise<BatchSection> {
	const refused = refusalFor(executor, sub)
	if (refused !== undefined) {
		return {
			tool: sub.tool,
			ok: false,
			skipped: false,
			content: `[Error] ${refused}`,
		}
	}
	const result = await executor.execute(sub.tool, sub.args)
	return {
		tool: sub.tool,
		ok: !result.isError,
		skipped: false,
		content: result.content,
	}
}

/** Split sub-call indexes into the concurrent and the in-order groups. */
function partitionBatch(
	workspaceRoot: string,
	calls: BatchSubCall[],
): { parallel: number[]; serial: number[] } {
	const edited = new Set<string>()
	for (const sub of calls) {
		const target = editToolTargetPath(workspaceRoot, {
			name: sub.tool,
			args: sub.args,
		})
		if (target !== undefined) {
			edited.add(target)
		}
	}
	const parallel: number[] = []
	const serial: number[] = []
	calls.forEach((sub, index) => {
		const shape = { name: sub.tool, args: sub.args }
		if (isParallelReadOnlyCall(workspaceRoot, shape, edited)) {
			parallel.push(index)
		} else {
			serial.push(index)
		}
	})
	return { parallel, serial }
}

function skippedSection(sub: BatchSubCall): BatchSection {
	return {
		tool: sub.tool,
		ok: false,
		skipped: true,
		content: "[skipped] stop_on_error is set and an earlier sub-call failed",
	}
}

async function executeBatch(
	executor: ToolExecutor,
	workspaceRoot: string,
	request: BatchRequest,
): Promise<BatchSection[]> {
	const groups = partitionBatch(workspaceRoot, request.calls)
	const sections = new Map<number, BatchSection>()
	await Promise.all(
		groups.parallel.map(async (index) => {
			sections.set(index, await runSubCall(executor, request.calls[index]))
		}),
	)
	for (const index of groups.serial) {
		if (request.stopOnError && hasFailure(sections)) {
			sections.set(index, skippedSection(request.calls[index]))
			continue
		}
		sections.set(index, await runSubCall(executor, request.calls[index]))
	}
	return orderedSections(request.calls.length, sections)
}

function hasFailure(sections: Map<number, BatchSection>): boolean {
	for (const section of sections.values()) {
		if (!section.ok) {
			return true
		}
	}
	return false
}

function orderedSections(
	count: number,
	sections: Map<number, BatchSection>,
): BatchSection[] {
	const ordered: BatchSection[] = []
	for (let i = 0; i < count; i++) {
		const section = sections.get(i)
		if (section === undefined) {
			throw new Error("batch: internal error — missing section")
		}
		ordered.push(section)
	}
	return ordered
}

/**
 * Run one batch. executor comes from the registration closure (the
 * run_tests precedent) so sub-calls see this session's real executor —
 * including its read-only discipline and stubs.
 */
export async function batchHandler(
	executor: ToolExecutor,
	args: Record<string, unknown>,
	ctx: ToolContext,
): Promise<ToolResult> {
	const request = parseBatchArgs(args, "batch")
	const sections = await executeBatch(executor, ctx.workspaceRoot, request)
	const body = assembleSections(request.calls.length, sections)
	const summary = formatSummary(request.calls.length, sections)
	const succeeded = sections.some((s) => s.ok)
	return { content: `${body}\n${summary}`, isError: !succeeded }
}
