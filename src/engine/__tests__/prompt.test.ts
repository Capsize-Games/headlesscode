/**
 * Unit tests for src/engine/prompt.ts's tool selection — specifically a
 * regression guard for the 2026-08-01 incident: `read_file`'s vendored
 * schema had `strict: true` while listing several genuinely-optional
 * properties outside `required`, which directly violates OpenAI's own
 * strict-mode contract (every property must be required when
 * strict:true). Lenient OpenRouter-routed hosts silently tolerated this;
 * DeepSeek's OFFICIAL endpoint (which headlesscode pins deepseek/* requests
 * to, in src/llm/openrouter.ts, for accurate cost/cache pricing) validates
 * it correctly and rejects the entire request with HTTP 400 the moment a
 * tool with this defect is included — confirmed live against the real API.
 *
 * This test is intentionally generic across EVERY tool this harness could
 * ever advertise to a model, not just read_file — the same defect could be
 * introduced by any future tool addition/edit, vendored or not, and this
 * guard exists to catch it before it reaches a real session.
 *
 * Plain assert-based script (no test framework, no network), run via
 * `npm test` -> `tsx src/engine/__tests__/prompt.test.ts`.
 */

import assert from "node:assert/strict"

import {
	appendBrowserActionTool,
	appendCodeIntelEditTools,
	appendCodeIntelTools,
	appendDescribeImageTool,
	appendRunTestsTool,
	buildHeadlessConventions,
	selectToolsForMode,
} from "../prompt.js"
import type { ChatTool } from "../types.js"

function findStrictModeViolations(tools: ChatTool[]): string[] {
	const violations: string[] = []
	for (const t of tools) {
		if (t.type !== "function") continue
		const fn = t.function as { name: string; strict?: boolean; parameters?: Record<string, unknown> }
		if (!fn.strict) continue
		const params = fn.parameters ?? {}
		const properties = (params.properties as Record<string, unknown> | undefined) ?? {}
		const required = new Set((params.required as string[] | undefined) ?? [])
		const missing = Object.keys(properties).filter((p) => !required.has(p))
		if (missing.length > 0) {
			violations.push(`${fn.name}: strict=true but not required: ${missing.join(", ")}`)
		}
	}
	return violations
}

async function testNoStrictModeViolationsInCodeMode(): Promise<void> {
	const tools = selectToolsForMode("code", [])
	assert.ok(tools.length > 0, "expected at least one tool for the code mode")
	const violations = findStrictModeViolations(tools)
	assert.deepEqual(
		violations,
		[],
		`strict-mode schema violations found (will HTTP 400 against DeepSeek's official endpoint): ${violations.join("; ")}`,
	)
}

/**
 * The append* helpers add NON-vendored tools (browser_action, describe_image,
 * code-intelligence incl. rename_symbol, run_tests) to a mode's tool list —
 * the same strict-mode contract applies to them, so include them in the
 * violation sweep alongside selectToolsForMode's output.
 */
function codeModeToolsWithAppendedTools(): ChatTool[] {
	const base = selectToolsForMode("code", [])
	return appendRunTestsTool(
		appendCodeIntelEditTools(
			appendCodeIntelTools(appendDescribeImageTool(appendBrowserActionTool(base))),
		),
	)
}

async function testNoStrictModeViolationsInAppendedTools(): Promise<void> {
	const tools = codeModeToolsWithAppendedTools()
	const violations = findStrictModeViolations(tools)
	assert.deepEqual(
		violations,
		[],
		`strict-mode schema violations in appended tools (will HTTP 400 against DeepSeek's official endpoint): ${violations.join("; ")}`,
	)
	// The new tools must actually be present (guards against a future wiring
	// regression silently dropping them from the advertised set).
	const names = tools.filter((t) => t.type === "function").map((t) => t.function.name)
	assert.ok(names.includes("rename_symbol"), "rename_symbol must be advertised for code mode")
	assert.ok(names.includes("run_tests"), "run_tests must be advertised for code mode")
}

async function testReadFileSpecificallyIsNotStrictModeBroken(): Promise<void> {
	// The exact regression: read_file must either not be strict, or have
	// every property required — either is fine, silently reintroducing the
	// mismatch is not.
	const tools = selectToolsForMode("code", [])
	const readFile = tools.find((t) => t.type === "function" && t.function.name === "read_file")
	assert.ok(readFile && readFile.type === "function", "expected read_file to be in the code mode's tool set")
	const fn = readFile.function as { strict?: boolean; parameters?: Record<string, unknown> }
	if (fn.strict) {
		const params = fn.parameters ?? {}
		const properties = Object.keys((params.properties as Record<string, unknown> | undefined) ?? {})
		const required = new Set((params.required as string[] | undefined) ?? [])
		for (const p of properties) {
			assert.ok(required.has(p), `read_file is strict:true but '${p}' is not required`)
		}
	}
}

async function testHeadlessConventionsGuideExternalCheckWaiting(): Promise<void> {
	const conventions = buildHeadlessConventions("code", [])
	assert.ok(conventions, "edit-capable modes must get the headless workflow conventions")
	assert.match(
		conventions ?? "",
		/gh run watch/,
		"issue #119: conventions must steer workers toward a single gh run watch over repeated polls",
	)
	assert.match(
		conventions ?? "",
		/iteration budget/,
		"issue #119: conventions must name why (waits count against the iteration budget)",
	)
	assert.match(
		conventions ?? "",
		/sleep/,
		"issue #119: conventions must name the wasteful polling pattern it replaces",
	)
}

async function testHeadlessConventionsNotShownToReadOnlyModes(): Promise<void> {
	// Read-only reviewer/QA roles never see the edit-workflow conventions
	// (modeHasEditGroup gate) — and that includes the new waiting guidance.
	assert.equal(buildHeadlessConventions("reviewer", []), undefined)
	assert.equal(buildHeadlessConventions("qa", []), undefined)
}

const tests: Array<[string, () => Promise<void>]> = [
	["no strict-mode schema violations across the code mode's full tool set", testNoStrictModeViolationsInCodeMode],
	["no strict-mode schema violations in the appended (non-vendored) tools", testNoStrictModeViolationsInAppendedTools],
	["read_file specifically: strict/required are consistent", testReadFileSpecificallyIsNotStrictModeBroken],
	["headless conventions guide external-check waiting (gh run watch, iteration budget)", testHeadlessConventionsGuideExternalCheckWaiting],
	["headless conventions are not shown to read-only modes", testHeadlessConventionsNotShownToReadOnlyModes],
]

async function main(): Promise<void> {
	let failed = 0
	for (const [name, fn] of tests) {
		try {
			await fn()
			console.log(`  ok   ${name}`)
		} catch (err) {
			failed++
			console.error(`  FAIL ${name}`)
			console.error(err instanceof Error ? err.stack : err)
		}
	}
	if (failed > 0) {
		console.error(`\n${failed} test(s) failed`)
		process.exit(1)
	}
	console.log(`\nAll ${tests.length} prompt/tool-schema tests passed`)
}

main()
