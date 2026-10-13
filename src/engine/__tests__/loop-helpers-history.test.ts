/**
 * Tests for loop history/comparison helpers (src/engine/loop.ts).
 * Tests-first for the loop-helpers extraction (#127 slice).
 * Plain assert script run via `npm test` -> tsx (no framework).
 */

import assert from "node:assert/strict"

import {
	estimateTokenSize,
	messagesPrefixEquals,
	sameToolNames,
	stripSupersededReasoning,
	truncateHistory,
} from "../loop.js"
import type { ChatMessage, ChatTool } from "../types.js"
import { runMain } from "../../test-runner.js"

function msg(role: ChatMessage["role"], content: string | null): ChatMessage {
	return { role, content }
}

function tool(name: string): ChatTool {
	return { type: "function", function: { name } }
}

function testStripKeepsMostRecent(): void {
	const a: ChatMessage = { role: "assistant", content: "a", reasoning: "r1" }
	const b: ChatMessage = { role: "assistant", content: "b", reasoning: "r2" }
	const messages = [a, b]
	stripSupersededReasoning(messages)
	assert.equal(messages[0].reasoning, undefined)
	assert.equal(messages[1].reasoning, "r2")
}

function testStripIgnoresNonAssistant(): void {
	const messages = [msg("system", "s"), msg("user", "u")]
	stripSupersededReasoning(messages)
	assert.equal(messages.length, 2)
}

function testTruncateNoOpBelowWindow(): void {
	const messages = [msg("system", "s"), msg("user", "u"), msg("user", "v")]
	const result = truncateHistory(messages, 10)
	assert.equal(result.length, 3)
}

function testTruncateKeepsSystemAndFirstUser(): void {
	const messages = [msg("system", "s"), msg("user", "first")]
	for (let i = 0; i < 25; i++) messages.push(msg("user", `m${i}`))
	const result = truncateHistory(messages, 10)
	assert.equal(result[0], messages[0])
	assert.equal(result[1], messages[1])
	assert.ok(result.length <= 20)
}

function testEstimateTokenSize(): void {
	assert.equal(estimateTokenSize(0), 0)
	assert.equal(estimateTokenSize(4), 1)
	assert.equal(estimateTokenSize(5), 2)
	assert.equal(estimateTokenSize(400), 100)
}

function testSameToolNames(): void {
	const ab = [tool("a"), tool("b")]
	const ba = [tool("b"), tool("a")]
	assert.equal(sameToolNames(ab, ba), true)
	assert.equal(sameToolNames([tool("a")], [tool("a"), tool("b")]), false)
	assert.equal(sameToolNames([tool("a")], [tool("b")]), false)
	assert.equal(sameToolNames([], []), true)
}

function testPrefixEquals(): void {
	const a = msg("user", "a")
	const b = msg("user", "b")
	assert.equal(messagesPrefixEquals([a, b], [a]), true)
	assert.equal(messagesPrefixEquals([a], [a, b]), false)
	assert.equal(messagesPrefixEquals([a, msg("user", "x")], [a, b]), false)
	assert.equal(messagesPrefixEquals([], []), true)
}

function testPrefixEqualsEmptySnapshot(): void {
	const a = msg("user", "a")
	assert.equal(messagesPrefixEquals([a], []), true)
}

const tests: Array<[string, () => void]> = [
	["strip: keeps most recent", testStripKeepsMostRecent],
	["strip: ignores non-assistant", testStripIgnoresNonAssistant],
	["truncate: no-op below window", testTruncateNoOpBelowWindow],
	["truncate: keeps system+first-user", testTruncateKeepsSystemAndFirstUser],
	["estimateTokenSize heuristic", testEstimateTokenSize],
	["sameToolNames comparison", testSameToolNames],
	["messagesPrefixEquals", testPrefixEquals],
	["messagesPrefixEquals empty snapshot", testPrefixEqualsEmptySnapshot],
]

runMain("", tests)
