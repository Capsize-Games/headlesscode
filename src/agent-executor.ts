/** Agent implementation selection shared by orchestrate and issue intake. */
export type AgentExecutor = "builtin" | "muse"

export interface AgentExecutorSelection {
	executor: AgentExecutor
	museModel?: string
}

export interface HeadlessCodeJobSubmission {
	task: string
	executor: AgentExecutor
	submittedBy: string
}

const MAX_HEADLESSCODE_JOB_BODY_BYTES = 128 * 1024
const MAX_HEADLESSCODE_TASK_BYTES = 64 * 1024

/** Parse only the defined job metadata sections; metadata is never task text. */
export function parseHeadlessCodeJobBody(body: string | undefined): { submission?: HeadlessCodeJobSubmission; error?: string } {
	if (typeof body !== "string" || Buffer.byteLength(body, "utf8") > MAX_HEADLESSCODE_JOB_BODY_BYTES) {
		return { error: "headlesscode-job issue body is missing or exceeds the 128 KiB limit" }
	}
	const sections = new Map<string, string[]>()
	let current: string | undefined
	let fence: { marker: "`" | "~"; length: number } | undefined
	for (const line of body.split(/\r?\n/)) {
		const fenceMatch = line.match(/^\s{0,3}(`{3,}|~{3,})/)
		if (fenceMatch) {
			const markerText = fenceMatch[1]!
			const marker = markerText[0] as "`" | "~"
			if (!fence) fence = { marker, length: markerText.length }
			else if (fence.marker === marker && markerText.length >= fence.length) fence = undefined
			if (current) sections.get(current)!.push(line)
			continue
		}
		if (!fence) {
			const heading = line.match(/^\s{0,3}(?:#{1,6}\s*)?(Task|Executor|Submitted-by)(?:\s*:\s*(.*)|\s*)$/i)
			if (heading) {
				const key = heading[1]!.toLowerCase()
				if (sections.has(key)) return { error: `headlesscode-job body has duplicate ${heading[1]} section` }
				sections.set(key, [])
				current = key
				if (heading[2]) sections.get(key)!.push(heading[2])
				continue
			}
		}
		if (current) sections.get(current)!.push(line)
		else if (line.trim()) return { error: "headlesscode-job body must start with Task, Executor, and Submitted-by sections" }
	}
	const task = sections.get("task")?.join("\n").trim()
	const executorText = sections.get("executor")?.join("\n").trim()
	const submittedBy = sections.get("submitted-by")?.join("\n").trim()
	if (!task || !executorText || !submittedBy) return { error: "headlesscode-job body requires non-empty Task, Executor, and Submitted-by sections" }
	if (Buffer.byteLength(task, "utf8") > MAX_HEADLESSCODE_TASK_BYTES) return { error: "headlesscode-job Task section exceeds the 64 KiB limit" }
	if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(task)) return { error: "headlesscode-job Task section contains unsupported control characters" }
	if (executorText.includes("\n") || (executorText !== "muse" && executorText !== "loop")) return { error: "headlesscode-job Executor section must be exactly muse or loop" }
	if (submittedBy.includes("\n") || submittedBy.length > 256 || /[\u0000-\u001f\u007f]/.test(submittedBy)) return { error: "headlesscode-job Submitted-by section must be a single line of at most 256 characters" }
	return {
		submission: {
			task,
			executor: executorText === "muse" ? "muse" : "builtin",
			submittedBy,
		},
	}
}

const MUSE_MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/

export function isMuseModelIdentifier(value: string): boolean {
	return MUSE_MODEL_PATTERN.test(value)
}

export function museUnsupportedSettingsReason(
	memoryDir: string | undefined,
	env: NodeJS.ProcessEnv = process.env,
): string | undefined {
	if (memoryDir || env.HEADLESSCODE_MEMORY_DIR) return "the built-in memory directory is not supported by Muse executor"
	for (const [key, label] of [
		["HEADLESSCODE_MAX_COST_USD", "per-session cost limit"],
		["HEADLESSCODE_MAX_DURATION_MS", "per-session duration limit"],
		["HEADLESSCODE_DECISION_TIMEOUT_MS", "decision timeout"],
		["HEADLESSCODE_WINDOW_SIZE", "HeadlessCode context window setting"],
	] as const) {
		if (env[key]) return `${label} (${key}) is not supported by Muse executor`
	}
	return undefined
}

export function resolveAgentExecutorSelection(
	labels: readonly string[],
	defaults: { executor?: AgentExecutor; museModel?: string } = {},
	requestedExecutor?: AgentExecutor,
): { selection?: AgentExecutorSelection; error?: string } {
	const executorLabels = labels.filter((label) => /^executor(?::|$)/i.test(label))
	const modelLabels = labels.filter((label) => /^muse-model(?::|$)/i.test(label))
	if (executorLabels.length > 1) return { error: "issue must have at most one executor:<builtin|muse> label" }
	if (modelLabels.length > 1) return { error: "issue must have at most one muse-model:<id> label" }

	let labeledExecutor: AgentExecutor | undefined
	if (executorLabels.length === 1) {
		const value = executorLabels[0]!.includes(":") ? executorLabels[0]!.slice(executorLabels[0]!.indexOf(":") + 1).toLowerCase() : ""
		if (value !== "builtin" && value !== "muse") return { error: `unsupported issue executor label '${executorLabels[0]}' (expected executor:builtin or executor:muse)` }
		labeledExecutor = value
	}
	if (requestedExecutor && requestedExecutor !== "builtin" && requestedExecutor !== "muse") return { error: "unsupported body executor selection" }
	if (requestedExecutor && labeledExecutor && requestedExecutor !== labeledExecutor) return { error: "issue body executor conflicts with its executor label" }
	if (requestedExecutor && defaults.executor && requestedExecutor !== defaults.executor) return { error: `issue body executor conflicts with watcher executor '${defaults.executor}'` }
	let labeledModel: string | undefined
	if (modelLabels.length === 1) {
		labeledModel = modelLabels[0]!.slice(modelLabels[0]!.indexOf(":") + 1)
		if (!isMuseModelIdentifier(labeledModel)) return { error: "issue muse-model label must contain a valid 1-128 character native Muse model identifier" }
	}
	if (labeledModel && labeledExecutor !== "muse" && defaults.executor !== "muse") {
		return { error: "muse-model:<id> requires executor:muse (or a watcher configured with --executor muse)" }
	}
	if (labeledExecutor && defaults.executor && labeledExecutor !== defaults.executor) {
		return { error: `issue executor label conflicts with watcher executor '${defaults.executor}'` }
	}
	if (labeledModel && defaults.museModel && labeledModel !== defaults.museModel) {
		return { error: "issue muse-model label conflicts with the configured native Muse model" }
	}
	const executor = requestedExecutor ?? labeledExecutor ?? defaults.executor ?? "builtin"
	const museModel = labeledModel ?? defaults.museModel
	if (museModel && !isMuseModelIdentifier(museModel)) return { error: "invalid native Muse model identifier" }
	if (museModel && executor !== "muse") return { error: "native Muse model selection requires the Muse executor" }
	return { selection: { executor, ...(museModel ? { museModel } : {}) } }
}
