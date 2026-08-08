/**
 * Unit tests for src/orchestrator/auto-split.ts — the semantic-split
 * follow-up to the issue #53 pre-flight size warning.
 *
 * Plain assert-based script (no test framework, no network) matching the
 * src/orchestrator/__tests__/split.test.ts style. Run via `npm test`. The
 * LLM client and gh calls are all injected fakes — no real network access.
 */

import assert from "node:assert/strict"

import { autoSplitOversizedIssues, proposeSemanticSplit } from "../auto-split.js"
import type { IssueSizeWarning, SplitIssue } from "../split.js"
import type { LlmClient, LlmRequest, LlmResponse } from "../../engine/types.js"

function issue(number: number, title: string, body?: string): SplitIssue {
	return { number, title, body }
}

function warning(number: number, title: string, sections: number): IssueSizeWarning {
	return { number, title, sections }
}

class FakeLlmClient implements LlmClient {
	requests: LlmRequest[] = []
	constructor(private readonly reply: (req: LlmRequest) => string | Error) {}
	async createChatCompletion(request: LlmRequest): Promise<LlmResponse> {
		this.requests.push(request)
		const result = this.reply(request)
		if (result instanceof Error) {
			throw result
		}
		return { message: { role: "assistant", content: result } }
	}
}

// ─── proposeSemanticSplit ────────────────────────────────────────────────────

async function testProposeSemanticSplitParsesCleanJson(): Promise<void> {
	const client = new FakeLlmClient(
		() => JSON.stringify([{ title: "Fix A: server query", body: "..." }, { title: "Fix B: client loading state", body: "..." }]),
	)
	const proposals = await proposeSemanticSplit(issue(100, "slow conversation list", "..."), client, "fake-model")
	assert.equal(proposals.length, 2)
	assert.equal(proposals[0].title, "Fix A: server query")
}

async function testProposeSemanticSplitTolerantOfCodeFence(): Promise<void> {
	const client = new FakeLlmClient(
		() => "Here you go:\n```json\n" + JSON.stringify([{ title: "A", body: "a" }, { title: "B", body: "b" }]) + "\n```",
	)
	const proposals = await proposeSemanticSplit(issue(1, "t", "..."), client, "fake-model")
	assert.equal(proposals.length, 2)
}

async function testProposeSemanticSplitEmptyArrayMeansDontSplit(): Promise<void> {
	const client = new FakeLlmClient(() => "[]")
	const proposals = await proposeSemanticSplit(issue(1, "t", "..."), client, "fake-model")
	assert.deepEqual(proposals, [])
}

async function testProposeSemanticSplitSingleEntryTreatedAsDontSplit(): Promise<void> {
	// Below MIN_SUBISSUES (2) — the model effectively said "this is one piece."
	const client = new FakeLlmClient(() => JSON.stringify([{ title: "only one", body: "b" }]))
	const proposals = await proposeSemanticSplit(issue(1, "t", "..."), client, "fake-model")
	assert.deepEqual(proposals, [])
}

async function testProposeSemanticSplitCapsAtMax(): Promise<void> {
	const many = Array.from({ length: 20 }, (_, i) => ({ title: `piece ${i}`, body: "b" }))
	const client = new FakeLlmClient(() => JSON.stringify(many))
	const proposals = await proposeSemanticSplit(issue(1, "t", "..."), client, "fake-model")
	assert.ok(proposals.length <= 8, `expected <=8 proposals, got ${proposals.length}`)
}

async function testProposeSemanticSplitThrowsOnGarbage(): Promise<void> {
	const client = new FakeLlmClient(() => "not json at all, sorry")
	await assert.rejects(proposeSemanticSplit(issue(1, "t", "..."), client, "fake-model"))
}

async function testProposeSemanticSplitThrowsOnEmptyMessage(): Promise<void> {
	const client = new FakeLlmClient(() => "")
	await assert.rejects(proposeSemanticSplit(issue(1, "t", "..."), client, "fake-model"))
}

async function testProposeSemanticSplitPropagatesLlmError(): Promise<void> {
	const client = new FakeLlmClient(() => new Error("network error"))
	await assert.rejects(proposeSemanticSplit(issue(1, "t", "..."), client, "fake-model"), /network error/)
}

// ─── autoSplitOversizedIssues ────────────────────────────────────────────────

async function testAutoSplitFilesSubIssuesAndClosesParent(): Promise<void> {
	const issues = [issue(100, "big issue", "..."), issue(200, "small issue", "one thing")]
	const warnings = [warning(100, "big issue", 16)]
	const created: Array<{ title: string }> = []
	let closedNumber: number | undefined
	let closedComment: string | undefined

	const { issues: next, outcomes } = await autoSplitOversizedIssues(issues, warnings, {
		proposeSplit: async () => [
			{ title: "Fix A", body: "server side" },
			{ title: "Fix B", body: "client side" },
		],
		createIssue: (issue) => {
			created.push({ title: issue.title })
			return { number: 1000 + created.length, url: `https://example.test/issues/${1000 + created.length}` }
		},
		closeParent: (n, comment) => {
			closedNumber = n
			closedComment = comment
		},
	})

	// The oversized parent is replaced by its two children; the untouched
	// issue #200 passes through unchanged.
	assert.deepEqual(
		next.map((i) => i.number).sort((a, b) => a - b),
		[200, 1001, 1002],
	)
	assert.equal(closedNumber, 100)
	assert.match(closedComment ?? "", /#1001/)
	assert.match(closedComment ?? "", /#1002/)
	assert.equal(outcomes.length, 1)
	assert.equal(outcomes[0].outcome, "split")
	assert.equal(outcomes[0].created?.length, 2)
}

async function testAutoSplitKeepsIssueAsIsWhenModelSaysDontSplit(): Promise<void> {
	const issues = [issue(100, "big issue", "...")]
	const warnings = [warning(100, "big issue", 16)]
	let createCalled = false

	const { issues: next, outcomes } = await autoSplitOversizedIssues(issues, warnings, {
		proposeSplit: async () => [], // model decided: one coherent piece
		createIssue: () => {
			createCalled = true
			return { number: 999, url: "https://example.test/issues/999" }
		},
		closeParent: () => {
			throw new Error("must not be called")
		},
	})

	assert.equal(createCalled, false)
	assert.deepEqual(next, issues) // untouched
	assert.equal(outcomes[0].outcome, "kept-as-is")
}

async function testAutoSplitFailsOpenOnProposeSplitError(): Promise<void> {
	const issues = [issue(100, "big issue", "...")]
	const warnings = [warning(100, "big issue", 16)]

	const { issues: next, outcomes } = await autoSplitOversizedIssues(issues, warnings, {
		proposeSplit: async () => {
			throw new Error("provider down")
		},
		createIssue: () => ({ number: 999, url: "https://example.test/issues/999" }),
		closeParent: () => {
			throw new Error("must not be called")
		},
	})

	// Original issue dispatched unchanged — a bad split attempt must never
	// abort the round or drop the issue.
	assert.deepEqual(next, issues)
	assert.equal(outcomes[0].outcome, "failed")
	assert.match(outcomes[0].reason ?? "", /provider down/)
}

async function testAutoSplitFailsOpenOnFilingError(): Promise<void> {
	const issues = [issue(100, "big issue", "...")]
	const warnings = [warning(100, "big issue", 16)]

	const { issues: next, outcomes } = await autoSplitOversizedIssues(issues, warnings, {
		proposeSplit: async () => [
			{ title: "Fix A", body: "a" },
			{ title: "Fix B", body: "b" },
		],
		createIssue: () => {
			throw new Error("gh rate limited")
		},
		closeParent: () => {
			throw new Error("must not be called")
		},
	})

	assert.deepEqual(next, issues)
	assert.equal(outcomes[0].outcome, "failed")
	assert.match(outcomes[0].reason ?? "", /gh rate limited/)
}

async function testAutoSplitLeavesUnflaggedIssuesAlone(): Promise<void> {
	const issues = [issue(1, "a"), issue(2, "b"), issue(3, "c")]
	const { issues: next, outcomes } = await autoSplitOversizedIssues(issues, [], {
		proposeSplit: async () => {
			throw new Error("must not be called")
		},
		createIssue: () => {
			throw new Error("must not be called")
		},
		closeParent: () => {
			throw new Error("must not be called")
		},
	})
	assert.deepEqual(next, issues)
	assert.deepEqual(outcomes, [])
}

async function testAutoSplitPreservesOrderOfUnflaggedIssues(): Promise<void> {
	const issues = [issue(1, "a"), issue(100, "big", "..."), issue(3, "c")]
	const warnings = [warning(100, "big", 16)]
	const { issues: next } = await autoSplitOversizedIssues(issues, warnings, {
		proposeSplit: async () => [
			{ title: "A", body: "a" },
			{ title: "B", body: "b" },
		],
		createIssue: () => ({ number: 500 + Math.floor(Math.random() * 1000), url: "https://example.test/issues/x" }),
		closeParent: () => {},
	})
	assert.equal(next[0].number, 1)
	assert.equal(next[next.length - 1].number, 3)
}

// ─── Test registry ────────────────────────────────────────────────────────────

const tests: Array<[string, () => Promise<void>]> = [
	["proposeSemanticSplit: parses clean JSON array", testProposeSemanticSplitParsesCleanJson],
	["proposeSemanticSplit: tolerant of a code-fenced response", testProposeSemanticSplitTolerantOfCodeFence],
	["proposeSemanticSplit: empty array means don't split", testProposeSemanticSplitEmptyArrayMeansDontSplit],
	["proposeSemanticSplit: single entry treated as don't split (below MIN_SUBISSUES)", testProposeSemanticSplitSingleEntryTreatedAsDontSplit],
	["proposeSemanticSplit: caps proposals at MAX_SUBISSUES", testProposeSemanticSplitCapsAtMax],
	["proposeSemanticSplit: throws on unparseable response", testProposeSemanticSplitThrowsOnGarbage],
	["proposeSemanticSplit: throws on empty message", testProposeSemanticSplitThrowsOnEmptyMessage],
	["proposeSemanticSplit: propagates an LLM call error", testProposeSemanticSplitPropagatesLlmError],
	["autoSplitOversizedIssues: files sub-issues and closes the parent", testAutoSplitFilesSubIssuesAndClosesParent],
	["autoSplitOversizedIssues: keeps the issue as-is when the model says don't split", testAutoSplitKeepsIssueAsIsWhenModelSaysDontSplit],
	["autoSplitOversizedIssues: fails open when proposeSplit throws", testAutoSplitFailsOpenOnProposeSplitError],
	["autoSplitOversizedIssues: fails open when filing a sub-issue throws", testAutoSplitFailsOpenOnFilingError],
	["autoSplitOversizedIssues: leaves unflagged issues alone (no calls at all)", testAutoSplitLeavesUnflaggedIssuesAlone],
	["autoSplitOversizedIssues: preserves the relative order of unflagged issues", testAutoSplitPreservesOrderOfUnflaggedIssues],
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
			console.error(err instanceof Error ? err.stack ?? err.message : String(err))
		}
	}
	if (failed > 0) {
		console.error(`\n${failed} test(s) failed`)
		process.exit(1)
	}
	console.log(`\nAll ${tests.length} auto-split tests passed`)
}

main().catch((err) => {
	console.error("Test runner crashed:", err)
	process.exit(1)
})
