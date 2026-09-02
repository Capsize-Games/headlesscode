/**
 * Direct tests for src/engine/lazy-tools.ts — the local-backend core/lazy
 * tool-catalog split (HEADLESSCODE_LAZY_TOOL_CATALOG).
 *
 * Plain assert-based script (no test framework), run via `npm test` →
 * `tsx src/engine/__tests__/lazy-tools.test.ts`.
 */

import assert from "node:assert/strict"

import {
	CORE_TOOL_NAMES,
	LIST_TOOLS_NAME,
	REQUEST_TOOL_NAME,
	buildListToolsTool,
	buildRequestToolTool,
	renderToolIndex,
	splitCoreAndLazyTools,
} from "../lazy-tools.js"
import type { ChatTool } from "../types.js"

function fnTool(name: string, description = `${name} description`): ChatTool {
	return { type: "function", function: { name, description, parameters: { type: "object", properties: {} } } }
}

// 2026-09-02: real usage data across 62 logged local-backend eval sessions
// showed zero calls, ever, to new_task/switch_mode/update_todo_list, while
// their schemas were paid on every single turn regardless — demoted to
// lazy. This locks that decision in as an explicit, intentional test rather
// than something a future edit could silently regress.
function testNewTaskSwitchModeUpdateTodoListAreLazyNotCore(): void {
	for (const name of ["new_task", "switch_mode", "update_todo_list"]) {
		assert.equal(CORE_TOOL_NAMES.has(name), false, `${name} must be lazy, not core (2026-09-02 usage data)`)
	}
}

// set_indentation has the OPPOSITE evidence (issue #141: made lazy once,
// the model never called request_tool for it even when told to) — must
// stay core despite also showing zero calls in the same usage-data sweep
// that demoted the other three. Locks in that the two are NOT the same
// situation just because both currently show zero real-world calls.
function testSetIndentationStaysCoreDespiteAlsoShowingZeroCalls(): void {
	assert.equal(CORE_TOOL_NAMES.has("set_indentation"), true)
}

function testCoreToolsIncludeTheHeavilyUsedOnes(): void {
	for (const name of ["execute_command", "read_file", "edit_file", "list_files", "write_to_file", "attempt_completion", "ask_followup_question"]) {
		assert.equal(CORE_TOOL_NAMES.has(name), true, `${name} must remain core`)
	}
}

function testApplyDiffAndSearchReplaceRemainExcludedFromCore(): void {
	assert.equal(CORE_TOOL_NAMES.has("apply_diff"), false)
	assert.equal(CORE_TOOL_NAMES.has("search_replace"), false)
}

function testSplitPutsCoreToolsInCoreAndEverythingElseLazy(): void {
	const all = [
		fnTool("read_file"),
		fnTool("edit_file"),
		fnTool("apply_diff"),
		fnTool("search_replace"),
		fnTool("new_task"),
		fnTool("switch_mode"),
		fnTool("update_todo_list"),
		fnTool("describe_image"),
	]
	const { core, lazyByName } = splitCoreAndLazyTools(all)
	const coreNames = core.map((t) => (t.type === "function" ? t.function.name : t.type)).sort()
	assert.deepEqual(coreNames, ["edit_file", LIST_TOOLS_NAME, "read_file", REQUEST_TOOL_NAME].sort())
	assert.deepEqual(
		[...lazyByName.keys()].sort(),
		["apply_diff", "describe_image", "new_task", "search_replace", "switch_mode", "update_todo_list"].sort(),
	)
}

// The list_tools description is built FROM CORE_TOOL_NAMES (2026-09-02 fix
// — it used to be a hand-written duplicate that had already drifted out of
// sync, naming apply_diff/search_replace as "always available" when
// neither was ever core). Assert it can never drift again: every real core
// tool name must appear in the description, and none of the demoted/
// never-core names should be claimed as "always available".
function testListToolsDescriptionMatchesCoreToolNamesExactly(): void {
	const description = buildListToolsTool().function.description ?? ""
	const parenMatch = /\(([^)]*)\)/.exec(description)
	assert.ok(parenMatch, "description must contain a parenthetical listing the core tools")
	const coreListText = parenMatch[1]
	for (const name of CORE_TOOL_NAMES) {
		assert.ok(coreListText.includes(name), `list_tools description must mention core tool '${name}'`)
	}
	for (const name of ["new_task", "switch_mode", "update_todo_list", "apply_diff", "search_replace"]) {
		assert.equal(
			coreListText.includes(name),
			false,
			`list_tools description must NOT claim '${name}' is always available`,
		)
	}
	// The mechanism itself isn't part of the "core the model chooses among" —
	// it's what you're CALLING to see this list in the first place.
	assert.equal(coreListText.includes(LIST_TOOLS_NAME), false)
	assert.equal(coreListText.includes(REQUEST_TOOL_NAME), false)
}

function testRequestToolDescriptionUnaffected(): void {
	const description = buildRequestToolTool().function.description ?? ""
	assert.match(description, /callable/i)
	assert.match(description, /already active/i)
}

function testRenderToolIndexShapesOneLinePerLazyTool(): void {
	const lazy = new Map<string, ChatTool>([
		["new_task", fnTool("new_task", "Create a new task instance. Extra detail that gets truncated.")],
		["switch_mode", fnTool("switch_mode", "Request to switch to a different mode.")],
	])
	const index = renderToolIndex(lazy)
	assert.match(index, /- new_task: Create a new task instance\./)
	assert.match(index, /- switch_mode: Request to switch to a different mode\./)
}

function testRenderToolIndexEmptyCase(): void {
	assert.equal(renderToolIndex(new Map()), "No additional tools are available in this session.")
}

const tests: Array<[string, () => void]> = [
	["new_task/switch_mode/update_todo_list are lazy, not core (2026-09-02 usage data)", testNewTaskSwitchModeUpdateTodoListAreLazyNotCore],
	["set_indentation stays core despite also showing zero calls (different evidence, issue #141)", testSetIndentationStaysCoreDespiteAlsoShowingZeroCalls],
	["heavily-used tools remain core", testCoreToolsIncludeTheHeavilyUsedOnes],
	["apply_diff/search_replace remain excluded from core", testApplyDiffAndSearchReplaceRemainExcludedFromCore],
	["splitCoreAndLazyTools partitions correctly", testSplitPutsCoreToolsInCoreAndEverythingElseLazy],
	["list_tools description matches CORE_TOOL_NAMES exactly (no drift)", testListToolsDescriptionMatchesCoreToolNamesExactly],
	["request_tool description unaffected", testRequestToolDescriptionUnaffected],
	["renderToolIndex: one line per lazy tool, truncated at first sentence", testRenderToolIndexShapesOneLinePerLazyTool],
	["renderToolIndex: empty case", testRenderToolIndexEmptyCase],
]

function main(): void {
	let failed = 0
	for (const [name, fn] of tests) {
		try {
			fn()
			console.log(`  ok   ${name}`)
		} catch (error) {
			failed++
			console.error(`  FAIL ${name}`)
			console.error(error)
		}
	}
	console.log(`\n${failed === 0 ? "All" : `${tests.length - failed}/${tests.length}`} ${tests.length} tests passed`)
	if (failed > 0) {
		process.exit(1)
	}
}

main()
