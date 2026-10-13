/**
 * Unit tests for the terminal-status leaf
 * (src/orchestrator/terminal-status.ts, issue #128).
 *
 * TERMINAL_STATUSES/isTerminalStatus move out of src/orchestrator/status.ts
 * so cleanup.ts can share them without an import cycle back into status.ts
 * (status.ts only needs the CleanupStatus TYPE from cleanup.ts, which is
 * cycle-free on its own). status.ts keeps re-exporting the same names.
 *
 * Plain assert-based script (no test framework), run via `npm test` →
 * `tsx src/orchestrator/__tests__/terminal-status.test.ts`.
 */

import assert from "node:assert/strict"

import {
	isTerminalStatus as statusIsTerminal,
	TERMINAL_STATUSES as STATUS_LIST,
} from "../status.js"
import { isTerminalStatus, TERMINAL_STATUSES } from "../terminal-status.js"

async function testTerminalStatusesAreTerminal(): Promise<void> {
	for (const status of ["done", "failed", "needs-human", "orphaned"]) {
		assert.equal(isTerminalStatus(status), true, `${status} must be terminal`)
	}
}

async function testLiveStatusesAreNotTerminal(): Promise<void> {
	const live = ["spawned", "running", "blocked", "", "done "]
	for (const status of live) {
		assert.equal(isTerminalStatus(status), false, `${status === "" ? "(empty)" : status} must not be terminal`)
	}
}

async function testBlockedStaysNonTerminal(): Promise<void> {
	assert.equal(isTerminalStatus("blocked"), false, "blocked is a decision-escalation wait state, not terminal")
}

async function testStatusReexportsTheLeaf(): Promise<void> {
	assert.deepEqual([...STATUS_LIST], [...TERMINAL_STATUSES])
	assert.equal(statusIsTerminal("done"), isTerminalStatus("done"))
	assert.equal(statusIsTerminal("running"), isTerminalStatus("running"))
}

async function main(): Promise<void> {
	const tests: Array<[string, () => Promise<void>]> = [
		["terminal statuses are terminal", testTerminalStatusesAreTerminal],
		["live statuses are not terminal", testLiveStatusesAreNotTerminal],
		["blocked stays non-terminal", testBlockedStaysNonTerminal],
		["status re-exports the leaf", testStatusReexportsTheLeaf],
	]

	let failed = 0
	for (const [name, fn] of tests) {
		try {
			await fn()
			console.log(`  ok   ${name}`)
		} catch (error) {
			failed++
			console.error(`  FAIL ${name}`)
			console.error(error instanceof Error ? (error.stack ?? error.message) : String(error))
		}
	}
	if (failed > 0) {
		console.error(`\n${failed} test(s) failed`)
		process.exit(1)
	}
	console.log(`\nAll ${tests.length} terminal-status tests passed`)
}

main().catch((error) => {
	console.error("Test runner crashed:", error)
	process.exit(1)
})
