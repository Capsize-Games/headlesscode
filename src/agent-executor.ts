/** Agent implementation selection shared by orchestrate and issue intake. */
export type AgentExecutor = "builtin" | "muse"

export interface AgentExecutorSelection {
	executor: AgentExecutor
	museModel?: string
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
	const executor = labeledExecutor ?? defaults.executor ?? "builtin"
	const museModel = labeledModel ?? defaults.museModel
	if (museModel && !isMuseModelIdentifier(museModel)) return { error: "invalid native Muse model identifier" }
	if (museModel && executor !== "muse") return { error: "native Muse model selection requires the Muse executor" }
	return { selection: { executor, ...(museModel ? { museModel } : {}) } }
}
