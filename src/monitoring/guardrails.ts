/** Shared, deterministic and task-agnostic corrections for the normal loop and monitor pilot. */
export const DEFAULT_READ_ONLY_NUDGE_THRESHOLD = 8
export const DEFAULT_READ_ONLY_STALL_LIMIT = 75
export const DEFAULT_IDENTICAL_CALL_NUDGE_THRESHOLD = 2
export const DEFAULT_IDENTICAL_CALL_STALL_LIMIT = 4
export const DEFAULT_TOOL_FAILURE_NUDGE_THRESHOLD = 2
export const DEFAULT_CONSECUTIVE_ERROR_LIMIT = 3

export const READ_ONLY_NUDGE_MESSAGE =
	"You've made several read/exploration calls without using `codebase_search`. If the workspace has an index (it lives in the central project store — see `~/.local/share/headlesscode/projects/`), try `codebase_search` for targeted semantic search instead of blind tree-walking."
export const READ_ONLY_PROGRESS_NUDGE_MESSAGE =
	"You've made several read/exploration calls without progress. If the next step in your todo list is verification, `run_tests` answers it in one shot — prefer running the project's test suite over more manual greps/reads. Take a progress action now (edit, test run, or completion) instead of further read-only exploration."

export function firstPendingTodoLine(todos: string | undefined): string | undefined {
	if (!todos) return undefined
	for (const line of todos.split("\n")) {
		const trimmed = line.trim()
		if (trimmed.startsWith("[ ]") || trimmed.startsWith("[-]")) return trimmed
	}
	return undefined
}

export function identicalCallNudgeMessage(signature: string, streak: number, nextTodo?: string): string {
	const concreteNextStep = nextTodo
		? ` Your own todo list's next unfinished step is: ${nextTodo} — do THAT now, not another ${signature} call.`
		: ""
	return (
		`You have called ${signature} ${streak} times in a row with IDENTICAL arguments. Repeating the exact same call ` +
		`will not produce a different result. The information from your earlier call is still visible above in this ` +
		`conversation — re-read it there instead of calling again.${concreteNextStep} If you are stuck on a ` +
		`persistent error, address that error specifically instead of resubmitting the same call or looking around ` +
		`the workspace again.`
	)
}

export function toolFailureNudgeMessage(
	toolName: string,
	streak: number,
	targetLabel: string | undefined,
	readFileAvailable: boolean,
	retryToolAvailable: boolean,
): string {
	const targetHint = targetLabel ? ` on '${targetLabel}'` : ""
	const base =
		`Your last ${streak} attempts to use ${toolName}${targetHint} all failed, even though the arguments were ` +
		`different each time. Varying the arguments and hoping is not working. `
	if (readFileAvailable && retryToolAvailable) {
		return (
			base +
			`Before trying again: use read_file to see the file's CURRENT exact content around your target, quote the ` +
			`exact text you intend to match, and only THEN retry ${toolName} — do not just adjust the arguments again ` +
			`without first confirming what the file actually contains right now.`
		)
	}
	if (!readFileAvailable && retryToolAvailable) {
		return (
			base +
			`read_file is temporarily unavailable right now (cooldown from a recent repeat) — instead, carefully ` +
			`re-derive the exact current content from what you already read earlier in this conversation, quote the ` +
			`exact text you intend to match, and only THEN retry ${toolName} — do not just adjust the arguments ` +
			`again without first confirming what the file actually contains right now.`
		)
	}
	if (readFileAvailable && !retryToolAvailable) {
		return (
			base +
			`${toolName} is temporarily unavailable right now (cooldown from a recent repeat), so retrying it this ` +
			`turn will not work no matter what arguments you use. Use read_file now to see the file's CURRENT exact ` +
			`content and carefully work out the exact text you'll need to match — you'll be able to retry ${toolName} ` +
			`again in a few turns, and having the exact match ready will make that attempt count.`
		)
	}
	return (
		base +
		`Both read_file and ${toolName} are temporarily unavailable right now (cooldown from recent repeats). Do not ` +
		`fabricate a call to either — call a genuinely different tool, or give a plain text status update, and wait ` +
		`for them to become available again before retrying.`
	)
}
