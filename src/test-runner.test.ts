import assert from "node:assert/strict"

import { runMain, runSuites } from "./test-runner.js"

function capture(stream: "log" | "error"): {
	lines: string[]
	restore: () => void
} {
	const lines: string[] = []
	const orig = console[stream]
	console[stream] = (...args: unknown[]): void => {
		lines.push(args.map(String).join(" "))
	}
	return { lines, restore: () => void (console[stream] = orig) }
}

function stubExit(): { codes: number[]; restore: () => void } {
	const codes: number[] = []
	const orig = process.exit
	process.exit = ((code?: number) => {
		codes.push(code ?? 0)
	}) as never
	return { codes, restore: () => void (process.exit = orig) }
}

async function tick(): Promise<void> {
	await new Promise<void>((resolve) => setImmediate(() => resolve()))
}

async function boom(): Promise<void> {
	throw new Error("boom-detail")
}

async function passingSuiteLogsOkSummaryAndZero(): Promise<void> {
	const out = capture("log")
	try {
		const failed = await runSuites("demo", [
			["first", async () => {}],
			["second", () => {}],
		])
		assert.equal(failed, 0)
		const want = ["  ok   first", "  ok   second", "\nAll 2 demo tests passed"]
		assert.deepEqual(out.lines, want)
	} finally {
		out.restore()
	}
}

async function failingSuiteLogsFailStackAndCount(): Promise<void> {
	const errOut = capture("error")
	const out = capture("log")
	try {
		const failed = await runSuites("demo", [["bad", boom]])
		assert.equal(failed, 1)
	} finally {
		errOut.restore()
		out.restore()
	}
	assert.ok(errOut.lines.some((l) => l.includes("FAIL bad")))
	assert.ok(errOut.lines.some((l) => l.includes("boom-detail")))
	assert.ok(errOut.lines.some((l) => l.includes("1 test(s) failed")))
}

async function emptyLabelOmitsLabel(): Promise<void> {
	const out = capture("log")
	try {
		await runSuites("", [["only", async () => {}]])
		assert.deepEqual(out.lines, ["  ok   only", "\nAll 1 tests passed"])
	} finally {
		out.restore()
	}
}

async function mainExitsOneOnFailure(): Promise<void> {
	const errOut = capture("error")
	const out = capture("log")
	const exited = stubExit()
	try {
		runMain("demo", [["bad", boom]])
		await tick()
	} finally {
		errOut.restore()
		out.restore()
		exited.restore()
	}
	assert.deepEqual(exited.codes, [1])
}

async function crashHandlerExitsOne(): Promise<void> {
	const errOut = capture("error")
	const exited = stubExit()
	try {
		runMain("demo", null as unknown as [])
		await tick()
	} finally {
		errOut.restore()
		exited.restore()
	}
	assert.deepEqual(exited.codes, [1])
	assert.ok(errOut.lines.some((l) => l.includes("Test runner crashed:")))
}

const tests: Array<[string, () => Promise<void>]> = [
	["passing suite logs ok summary and zero", passingSuiteLogsOkSummaryAndZero],
	["failing suite logs fail stack and count", failingSuiteLogsFailStackAndCount],
	["empty label omits label", emptyLabelOmitsLabel],
	["main exits one on failure", mainExitsOneOnFailure],
	["crash handler exits one", crashHandlerExitsOne],
]

runMain("test-runner", tests)
