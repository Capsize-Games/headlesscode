/**
 * Tests for loop read-only/guardrail helpers (src/engine/loop.ts).
 * Tests-first for the loop-helpers extraction (#127 slice).
 * Plain assert script run via `npm test` -> tsx (no framework).
 */

import assert from "node:assert/strict"

import {
	artifactRejectionNudgeMessage,
	combineAbortSignals,
	immutableBoundaryArguments,
	isReadOnlyDirectCall,
	isReadOnlyTurnCall,
} from "../loop.js"

function testCombineAbortedWhenInputAborted(): void {
	const c = new AbortController()
	c.abort("boom")
	const { signal, dispose } = combineAbortSignals([c.signal])
	assert.equal(signal.aborted, true)
	dispose()
}

function testCombineAbortsOnLaterAbort(): void {
	const c = new AbortController()
	const { signal, dispose } = combineAbortSignals([c.signal])
	assert.equal(signal.aborted, false)
	c.abort("stop")
	assert.equal(signal.aborted, true)
	dispose()
}

function testCombineDisposeRemovesListeners(): void {
	const c = new AbortController()
	const { signal, dispose } = combineAbortSignals([c.signal])
	dispose()
	c.abort("late")
	assert.equal(signal.aborted, false)
}

function testCombineSkipsUndefined(): void {
	const { signal, dispose } = combineAbortSignals([undefined])
	assert.equal(signal.aborted, false)
	dispose()
}

function testImmutableFreezesNested(): void {
	const args = { a: { b: [1, 2] }, c: "x" }
	const frozen = immutableBoundaryArguments(args)
	assert.deepEqual(frozen, args)
	assert.equal(Object.isFrozen(frozen), true)
	assert.equal(Object.isFrozen(frozen["a"]), true)
}

function testImmutableCopiesWithoutSharing(): void {
	const inner = { b: 1 }
	const frozen = immutableBoundaryArguments({ inner })
	assert.notEqual(frozen["inner"], inner)
	inner.b = 2
	assert.equal((frozen["inner"] as { b: number }).b, 1)
}

function testDirectReadOnlyTools(): void {
	const args = { path: "src/app.ts" }
	assert.equal(isReadOnlyDirectCall({ name: "read_file", args }), true)
	assert.equal(isReadOnlyDirectCall({ name: "list_files", args }), true)
	assert.equal(isReadOnlyDirectCall({ name: "write_to_file", args }), false)
}

function testDirectReadOnlyShell(): void {
	const read = { command: "ls -la" }
	const readCall = { name: "execute_command", args: read }
	assert.equal(isReadOnlyDirectCall(readCall), true)
	const write = { command: "rm -rf build" }
	const writeCall = { name: "execute_command", args: write }
	assert.equal(isReadOnlyDirectCall(writeCall), false)
}

function testTurnNonBatchDelegates(): void {
	const read = { name: "read_file", args: { path: "x" } }
	assert.equal(isReadOnlyTurnCall(read), true)
	const edit = { name: "edit_file", args: { path: "x" } }
	assert.equal(isReadOnlyTurnCall(edit), false)
}

function testTurnBatchAllReadOnly(): void {
	const call = {
		name: "batch",
		args: { calls: [{ tool: "read_file", args: { path: "a" } }] },
	}
	assert.equal(isReadOnlyTurnCall(call), true)
}

function testTurnBatchMixedIsProductive(): void {
	const call = {
		name: "batch",
		args: {
			calls: [
				{ tool: "read_file", args: { path: "a" } },
				{ tool: "write_to_file", args: { path: "b" } },
			],
		},
	}
	assert.equal(isReadOnlyTurnCall(call), false)
}

function testTurnBatchMalformedIsProductive(): void {
	assert.equal(isReadOnlyTurnCall({ name: "batch", args: { calls: [] } }), false)
	assert.equal(isReadOnlyTurnCall({ name: "batch", args: {} }), false)
	const nested = {
		name: "batch",
		args: { calls: [{ tool: "batch", args: { calls: [] } }] },
	}
	assert.equal(isReadOnlyTurnCall(nested), false)
}

function testTurnBatchOversizedIsProductive(): void {
	const calls = Array.from({ length: 11 }, () => ({
		tool: "read_file",
		args: { path: "a" },
	}))
	assert.equal(isReadOnlyTurnCall({ name: "batch", args: { calls } }), false)
}

function testArtifactNudgeNamesStreakAndPath(): void {
	const msg = artifactRejectionNudgeMessage(3, "plans/x.md")
	assert.ok(msg.includes("3"))
	assert.ok(msg.includes("plans/x.md"))
	assert.ok(msg.includes("read_file"))
}

const tests: Array<[string, () => void]> = [
	["combine: already-aborted input", testCombineAbortedWhenInputAborted],
	["combine: later abort propagates", testCombineAbortsOnLaterAbort],
	["combine: dispose removes listeners", testCombineDisposeRemovesListeners],
	["combine: undefined skipped", testCombineSkipsUndefined],
	["immutable: nested frozen", testImmutableFreezesNested],
	["immutable: no shared refs", testImmutableCopiesWithoutSharing],
	["direct: read-only tools", testDirectReadOnlyTools],
	["direct: read-only shell", testDirectReadOnlyShell],
	["turn: non-batch delegates", testTurnNonBatchDelegates],
	["turn: all-read-only batch", testTurnBatchAllReadOnly],
	["turn: mixed batch productive", testTurnBatchMixedIsProductive],
	["turn: malformed batch productive", testTurnBatchMalformedIsProductive],
	["turn: oversized batch productive", testTurnBatchOversizedIsProductive],
	["artifact nudge names streak+path", testArtifactNudgeNamesStreakAndPath],
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
