/**
 * Honest-evaluation harness for the local exploration phase
 * (plans/local-explore-phase-experiment.md).
 * Runs the REAL phase against the REAL local Ollama instance on realistic
 * exploration tasks and prints the handoff so we can judge exploration quality.
 *
 * Usage: npx tsx scripts/local-explore-eval.mjs [task-index]
 */
import { runLocalExplorePhase } from "../src/engine/local-explore.js"
import { fileURLToPath } from "node:url"
import path from "node:path"

const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")

const tasks = [
	"Find where the read-only headless executor is created in src/tools/executor.ts and list exactly which tool names it exposes to the model.",
	"Find how the session loop in src/engine/loop.ts handles a consecutive tool-error limit and what the default limit value is.",
	"Find where codebase_search is wired into the tool set in src/engine and what conditions/backend activate it.",
]

const idx = Number(process.argv[2] ?? 0)
const taskText = tasks[idx] ?? tasks[0]
console.log(`\n===== TASK: ${taskText} =====\n`)

const started = Date.now()
const result = await runLocalExplorePhase({
	workspaceRoot,
	taskText,
	model: "qwen3.5:9b",
	baseUrl: "http://localhost:11434",
	maxIterations: 12,
	contextTokens: 131_072,
	maxTokens: 2048,
	timeoutMs: 300_000,
})
const elapsed = ((Date.now() - started) / 1000).toFixed(1)

console.log(`\n----- phase summary -----`)
console.log(`terminatedBy:       ${result.terminatedBy}`)
console.log(`iterations:         ${result.iterations}`)
console.log(`estimatedTokens:    ${result.estimatedPromptTokens}`)
console.log(`elapsedSec:         ${elapsed}`)
console.log(`detail:             ${result.detail ?? "-"}`)
console.log(`handoffChars:       ${result.handoffMessage ? result.handoffMessage.content.length : 0}`)
console.log(`\n----- FULL TRANSCRIPT (what the local model did) -----`)
for (const m of result.messages) {
	if (m.role === "system") continue
	if (m.role === "user" && m.content === taskText) continue
	if (m.role === "assistant") {
		const calls = (m.tool_calls ?? []).map((c) => `${c.function.name}(${c.function.arguments.slice(0, 120)})`).join(" + ")
		console.log(`[local] ${calls || `"${(m.content ?? "").slice(0, 300)}"`}`)
	} else if (m.role === "tool") {
		console.log(`  -> tool result (${(m.content ?? "").length} chars): ${(m.content ?? "").slice(0, 200)}`)
	} else {
		console.log(`[${m.role}] ${(m.content ?? "").slice(0, 200)}`)
	}
}
console.log(`\n----- HANDOFF MESSAGE -----`)
console.log(result.handoffMessage?.content ?? "(null)")
