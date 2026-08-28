/**
 * Dedicated tests for src/engine/parser.ts (tool-call parsing + best-effort
 * partial-JSON recovery). Previously only exercised indirectly through
 * loop.test.ts's malformed-JSON scenario (see COV-8, issue #97) — this suite
 * covers parseToolCalls/parseToolCall/bestEffortPartialJson directly,
 * including the balanced-brace recovery and key/value scavenging paths that
 * had no dedicated assertions.
 *
 * Plain assert-based script (no test framework), run via `npm test` →
 * `tsx src/engine/__tests__/parser.test.ts`.
 */

import assert from "node:assert/strict"

import { bestEffortPartialJson, extractEmbeddedToolCall, parseToolCall, parseToolCalls } from "../parser.js"
import type { ChatMessage, ChatToolCall } from "../types.js"

function call(overrides: Partial<ChatToolCall> = {}, id = "call_1"): ChatToolCall {
	return {
		id,
		type: "function",
		function: { name: "read_file", arguments: '{"path":"a.ts"}' },
		...overrides,
	}
}

// ─── parseToolCalls ──────────────────────────────────────────────────────────

function testNoToolCallsYieldsEmptyArray(): void {
	const message: ChatMessage = { role: "assistant", content: "just text" }
	assert.deepEqual(parseToolCalls(message), [])
}

function testEmptyToolCallsArrayYieldsEmptyArray(): void {
	const message: ChatMessage = { role: "assistant", content: "", tool_calls: [] }
	assert.deepEqual(parseToolCalls(message), [])
}

function testParsesMultipleToolCallsInOrder(): void {
	const message: ChatMessage = {
		role: "assistant",
		content: "",
		tool_calls: [
			call({ function: { name: "read_file", arguments: '{"path":"a.ts"}' } }, "call_a"),
			call({ function: { name: "write_to_file", arguments: '{"path":"b.ts","content":"x"}' } }, "call_b"),
		],
	}
	const parsed = parseToolCalls(message)
	assert.equal(parsed.length, 2)
	assert.equal(parsed[0].id, "call_a")
	assert.equal(parsed[0].name, "read_file")
	assert.deepEqual(parsed[0].args, { path: "a.ts" })
	assert.equal(parsed[1].id, "call_b")
	assert.equal(parsed[1].name, "write_to_file")
	assert.deepEqual(parsed[1].args, { path: "b.ts", content: "x" })
}

function testFiltersOutNonFunctionCallsButKeepsUntypedOnes(): void {
	// A call whose `type` is some other value (never actually seen from
	// OpenRouter, but the parser defends against it) is filtered out; a call
	// missing the `type` field entirely (some providers omit it) is treated
	// as a function call.
	const nonFunctionCall = { id: "call_x", type: "something_else", function: { name: "n", arguments: "{}" } } as unknown as ChatToolCall
	const untypedCall = { id: "call_untyped", function: { name: "read_file", arguments: "{}" } } as unknown as ChatToolCall

	const withUntyped: ChatMessage = { role: "assistant", content: "", tool_calls: [untypedCall] }
	const parsedUntyped = parseToolCalls(withUntyped)
	assert.equal(parsedUntyped.length, 1, "a call with no `type` field is treated as a function call")
	assert.equal(parsedUntyped[0].id, "call_untyped")

	const withNonFunction: ChatMessage = { role: "assistant", content: "", tool_calls: [nonFunctionCall] }
	assert.equal(parseToolCalls(withNonFunction).length, 0, "non-function call types are filtered out")
}

// ─── parseToolCall: id/name/argument fallbacks ──────────────────────────────

function testMissingIdFallsBackToIndexedPlaceholder(): void {
	const noId = { type: "function", function: { name: "read_file", arguments: "{}" } } as unknown as ChatToolCall
	const parsed = parseToolCall(noId, 2)
	assert.equal(parsed.id, "call_2")
}

function testMissingNameFallsBackToUnknownTool(): void {
	const noName = { id: "x", type: "function", function: { arguments: "{}" } } as unknown as ChatToolCall
	const parsed = parseToolCall(noName)
	assert.equal(parsed.name, "unknown_tool")
}

function testEmptyArgumentsParseToEmptyObject(): void {
	const parsed = parseToolCall(call({ function: { name: "attempt_completion", arguments: "" } }))
	assert.deepEqual(parsed.args, {})
	assert.equal(parsed.parseError, undefined)
}

function testWhitespaceOnlyArgumentsParseToEmptyObject(): void {
	const parsed = parseToolCall(call({ function: { name: "attempt_completion", arguments: "   \n\t " } }))
	assert.deepEqual(parsed.args, {})
	assert.equal(parsed.parseError, undefined)
}

function testValidJsonObjectParsesCleanly(): void {
	const parsed = parseToolCall(call({ function: { name: "read_file", arguments: '{"path":"src/a.ts","limit":50}' } }))
	assert.deepEqual(parsed.args, { path: "src/a.ts", limit: 50 })
	assert.equal(parsed.parseError, undefined)
	assert.equal(parsed.rawArguments, '{"path":"src/a.ts","limit":50}')
}

function testNonObjectJsonYieldsParseError(): void {
	const parsed = parseToolCall(call({ function: { name: "read_file", arguments: "[1,2,3]" } }))
	assert.deepEqual(parsed.args, {})
	assert.match(parsed.parseError ?? "", /did not parse to an object/)
}

function testMalformedJsonRecoversViaBalancedBrace(): void {
	// Trailing junk after a well-formed object — the balanced-brace recovery
	// path should still extract the object.
	const parsed = parseToolCall(
		call({ function: { name: "read_file", arguments: '{"path": "x.ts"} and then some trailing junk' } }),
	)
	assert.deepEqual(parsed.args, { path: "x.ts" })
	assert.equal(parsed.parseError, undefined)
}

function testTruncatedJsonRecoversViaScavenging(): void {
	// Truncated tail with no closing brace — balanced-brace recovery fails,
	// key/value scavenging should still pull out the complete pairs.
	const parsed = parseToolCall(
		call({ function: { name: "read_file", arguments: '{"path": "x.ts", "limit": 50, "trunc' } }),
	)
	assert.equal(parsed.args.path, "x.ts")
	assert.equal(parsed.args.limit, 50)
	assert.equal(parsed.parseError, undefined)
}

function testUnrecoverableJsonSetsParseError(): void {
	const parsed = parseToolCall(call({ function: { name: "read_file", arguments: "not json at all, no colons" } }))
	assert.deepEqual(parsed.args, {})
	assert.match(parsed.parseError ?? "", /invalid JSON arguments/)
}

// ─── bestEffortPartialJson ───────────────────────────────────────────────────

function testBalancedBraceRecoveryPicksOutermostObject(): void {
	assert.deepEqual(bestEffortPartialJson('{"a": 1, "b": {"nested": true}} trailing garbage'), {
		a: 1,
		b: { nested: true },
	})
}

function testScavengingHandlesStringsNumbersBooleansNull(): void {
	const result = bestEffortPartialJson('"s": "hi", "n": 42, "neg": -3.5, "t": true, "f": false, "nil": null, trunc')
	assert.deepEqual(result, { s: "hi", n: 42, neg: -3.5, t: true, f: false, nil: null })
}

function testScavengingUnescapesStringValues(): void {
	const result = bestEffortPartialJson('"path": "a\\\\b", "note": "line1\\nline2", "quoted": "she said \\"hi\\""')
	assert.deepEqual(result, { path: "a\\b", note: "line1\nline2", quoted: 'she said "hi"' })
}

function testNoRecoverablePairsReturnsUndefined(): void {
	assert.equal(bestEffortPartialJson("nothing json-like here"), undefined)
}

// ─── extractEmbeddedToolCall ─────────────────────────────────────────────────

function testEmbeddedBareResultObjectRecoveredAsAttemptCompletion(): void {
	const text = '```json\n{\n  "result": "The check passed cleanly — no diagnostics."\n}\n```'
	const recovered = extractEmbeddedToolCall(text)
	assert.equal(recovered?.name, "attempt_completion")
	assert.deepEqual(recovered?.args, { result: "The check passed cleanly — no diagnostics." })
}

function testEmbeddedBareResultObjectRecoveredWithoutFence(): void {
	const text = '{"result": "done"}'
	const recovered = extractEmbeddedToolCall(text)
	assert.equal(recovered?.name, "attempt_completion")
	assert.deepEqual(recovered?.args, { result: "done" })
}

function testEmbeddedResultObjectWithExtraKeysNotRecovered(): void {
	// Only a single-key {"result": "..."} object is treated as an implicit
	// attempt_completion — an object with other keys alongside "result" is
	// ambiguous (could be ordinary narrated JSON, e.g. quoting a program's
	// own output) and must fall through unrecovered.
	const text = '```json\n{"result": "done", "status": "ok"}\n```'
	assert.equal(extractEmbeddedToolCall(text), undefined)
}

function testEmbeddedResultObjectWithEmptyStringNotRecovered(): void {
	const text = '{"result": "  "}'
	assert.equal(extractEmbeddedToolCall(text), undefined)
}

function testEmbeddedResultObjectWithNonStringResultNotRecovered(): void {
	const text = '{"result": 42}'
	assert.equal(extractEmbeddedToolCall(text), undefined)
}

// ─── Runner ──────────────────────────────────────────────────────────────────

const tests: Array<[string, () => void]> = [
	["parseToolCalls: no tool_calls -> []", testNoToolCallsYieldsEmptyArray],
	["parseToolCalls: empty tool_calls array -> []", testEmptyToolCallsArrayYieldsEmptyArray],
	["parseToolCalls: parses multiple calls in order", testParsesMultipleToolCallsInOrder],
	["parseToolCalls: filters non-function types, keeps untyped", testFiltersOutNonFunctionCallsButKeepsUntypedOnes],
	["parseToolCall: missing id -> call_<index>", testMissingIdFallsBackToIndexedPlaceholder],
	["parseToolCall: missing name -> unknown_tool", testMissingNameFallsBackToUnknownTool],
	["parseToolCall: empty arguments -> {}", testEmptyArgumentsParseToEmptyObject],
	["parseToolCall: whitespace-only arguments -> {}", testWhitespaceOnlyArgumentsParseToEmptyObject],
	["parseToolCall: valid JSON object parses cleanly", testValidJsonObjectParsesCleanly],
	["parseToolCall: non-object JSON -> parseError", testNonObjectJsonYieldsParseError],
	["parseToolCall: malformed JSON recovers via balanced-brace", testMalformedJsonRecoversViaBalancedBrace],
	["parseToolCall: truncated JSON recovers via scavenging", testTruncatedJsonRecoversViaScavenging],
	["parseToolCall: unrecoverable JSON -> parseError", testUnrecoverableJsonSetsParseError],
	["bestEffortPartialJson: balanced-brace picks outermost object", testBalancedBraceRecoveryPicksOutermostObject],
	["bestEffortPartialJson: scavenging handles all value types", testScavengingHandlesStringsNumbersBooleansNull],
	["bestEffortPartialJson: scavenging unescapes string values", testScavengingUnescapesStringValues],
	["bestEffortPartialJson: no recoverable pairs -> undefined", testNoRecoverablePairsReturnsUndefined],
	[
		"extractEmbeddedToolCall: bare {result} recovered as attempt_completion",
		testEmbeddedBareResultObjectRecoveredAsAttemptCompletion,
	],
	[
		"extractEmbeddedToolCall: bare {result} recovered without fence",
		testEmbeddedBareResultObjectRecoveredWithoutFence,
	],
	[
		"extractEmbeddedToolCall: {result, ...extra} not recovered",
		testEmbeddedResultObjectWithExtraKeysNotRecovered,
	],
	[
		"extractEmbeddedToolCall: {result: \"\"} not recovered",
		testEmbeddedResultObjectWithEmptyStringNotRecovered,
	],
	[
		"extractEmbeddedToolCall: {result: <non-string>} not recovered",
		testEmbeddedResultObjectWithNonStringResultNotRecovered,
	],
]

function main(): void {
	let failed = 0
	for (const [name, fn] of tests) {
		try {
			fn()
			console.log(`  ok   ${name}`)
		} catch (err) {
			failed++
			console.error(`  FAIL ${name}`)
			console.error(err instanceof Error ? err.stack ?? err.message : String(err))
		}
	}
	if (failed > 0) {
		console.error(`\n${failed} test(s) failed`)
		process.exit(1)
	}
	console.log(`\nAll ${tests.length} tests passed`)
}

main()
