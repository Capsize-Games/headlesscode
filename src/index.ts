/**
 * headlesscode package entry — runs the CLI when executed directly
 * (`tsx src/index.ts`, `npm run dev`) and re-exports the public API for
 * programmatic use.
 */

import { main } from "./cli.js"

// Run the CLI when this file is executed directly (e.g. `tsx src/index.ts`).
main()
	.then((code) => {
		process.exitCode = code
	})
	.catch((err) => {
		process.stderr.write(`headlesscode: unexpected error: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`)
		process.exitCode = 2
	})

export * from "./cli.js"
export * from "./memory/index.js"
export { OpenRouterClient, OpenRouterError, DEFAULT_MODEL } from "./llm/openrouter.js"
export { HeadlessSession, truncateHistory, DEFAULT_MAX_TOKENS } from "./engine/loop.js"
export {
	maybeCondense,
	condenseOldestTurns,
	computeCondenseCount,
	computeCondensePlan,
	DEFAULT_CONDENSE_THRESHOLD_FRACTION,
	DEFAULT_CONDENSE_EARLY_FIRE_FRACTION,
	DEFAULT_CONDENSE_MAX_TOKENS,
	DEFAULT_CONTEXT_WINDOW_TOKENS,
} from "./engine/condense.js"
export {
	runLocalExplorePhase,
	buildLocalExploreHandoffMessage,
	buildLocalExploreTools,
	OllamaLocalChatClient,
	LocalExploreError,
	isLocalExploreEnabled,
	LOCAL_EXPLORE_ENV,
	DEFAULT_LOCAL_EXPLORE_MODEL,
	DEFAULT_LOCAL_EXPLORE_MAX_ITERATIONS,
	DEFAULT_LOCAL_EXPLORE_CONTEXT_TOKENS,
	EXPLORE_SYSTEM_PROMPT,
} from "./engine/local-explore.js"
export { Logger } from "./engine/logger.js"
export { parseToolCalls, parseToolCall, bestEffortPartialJson } from "./engine/parser.js"
export {
	createHeadlessExecutor,
	ToolExecutor,
	resolveWithinWorkspace,
	PathTraversalError,
} from "./tools/executor.js"
export {
	buildSystemPrompt,
	loadCustomModes,
	selectToolsForMode,
	EXECUTABLE_TOOL_NAMES,
} from "./engine/prompt.js"
export {
	detectStacks,
	loadStackRules,
	appendStackRulesSection,
	STACK_NAMES,
	STACK_RULES_HEADER,
	getCentralStackRulesDir,
	getCentralStackRulesFile,
	getProjectStackRulesFile,
} from "./engine/stacks.js"
export type { StackName, LoadedStackRules } from "./engine/stacks.js"
export type {
	ChatMessage,
	ChatTool,
	ChatToolCall,
	LlmClient,
	LlmRequest,
	LlmResponse,
	ParsedToolCall,
	SessionResult,
	ToolResult,
} from "./engine/types.js"
