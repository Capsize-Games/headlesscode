/**
 * Unit tests for the task-files leaf (src/orchestrator/task-files.ts,
 * issue #128).
 *
 * The task-file builders + writeTaskFiles move out of
 * src/orchestrator/cli.ts so cloud providers and watcher/watch.ts can share
 * them without an import cycle back into the orchestrator CLI (which
 * statically imports reviewer → cli → openshell-session → ...). cli.ts keeps
 * re-exporting the same names for backward compatibility.
 *
 * Plain assert-based script (no test framework), run via `npm test` →
 * `tsx src/orchestrator/__tests__/task-files.test.ts`.
 */

import assert from "node:assert/strict"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"

import {
	buildContinuationTaskFileContent,
	buildPlanFirstTaskFileContent,
	buildQaReworkTaskFileContent,
	buildReworkTaskFileContent,
	buildTaskFileContent,
	writeTaskFiles,
} from "../task-files.js"
import {
	buildTaskFileContent as cliBuildTaskFileContent,
	writeTaskFiles as cliWriteTaskFiles,
} from "../cli.js"

async function testBuildTaskFileContentInlineBodies(): Promise<void> {
	const content = buildTaskFileContent(
		{ name: "w1", issues: [27], taskFile: "w1.md" },
		[{ number: 27, title: "Fix it", body: "the body" }],
	)
	assert.match(content, /### Issue #27: Fix it/)
	assert.match(content, /the body/)
	assert.match(content, /Scope: #27 only\./)
}

async function testBuildTaskFileContentFallback(): Promise<void> {
	const group = { name: "w1", issues: [99], taskFile: "w1.md" }
	const content = buildTaskFileContent(group, [])
	assert.match(content, /gh issue view 99/)
}

async function testPlanFirstMentionsPlanning(): Promise<void> {
	const content = buildPlanFirstTaskFileContent({ name: "w1", issues: [1] })
	assert.match(content, /planning phase/)
}

async function testReworkEmbedsFindings(): Promise<void> {
	const group = { name: "w1", issues: [27] }
	const content = buildReworkTaskFileContent(group, ["finding A"], 1)
	assert.match(content, /finding A/)
	assert.match(content, /rework cycle 1/)
}

async function testQaReworkAndContinuation(): Promise<void> {
	const group = { name: "w1", issues: [52] }
	const qa = buildQaReworkTaskFileContent(group, "qa evidence", 2)
	assert.match(qa, /qa evidence/i)
	const cont = buildContinuationTaskFileContent({ name: "w1", issues: [1] }, 1)
	assert.match(cont, /Continuation cycle 1/)
}

async function testWriteTaskFilesWritesBoth(): Promise<void> {
	const repo = await fs.mkdtemp(path.join(os.tmpdir(), "hc-taskfiles-"))
	const written = writeTaskFiles(
		repo,
		[{ name: "w1", issues: [27], taskFile: "w1.md" }],
		[{ number: 27, title: "T", body: "B" }],
		{ planFirst: true },
	)
	assert.equal(written.length, 2)
	for (const file of written) {
		const stat = await fs.stat(file)
		assert.ok(stat.isFile(), `${file} must exist`)
	}
	const mainPath = path.join(repo, "plans", "parallel-tasks", "w1.md")
	const main = await fs.readFile(mainPath, "utf8")
	assert.match(main, /### Issue #27: T/)
}

async function testOrchestratorCliReexportsTheLeaf(): Promise<void> {
	assert.equal(cliBuildTaskFileContent, buildTaskFileContent)
	assert.equal(cliWriteTaskFiles, writeTaskFiles)
}

async function runOne(name: string, fn: () => Promise<void>): Promise<boolean> {
	try {
		await fn()
		console.log(`  ok   ${name}`)
		return true
	} catch (error) {
		console.error(`  FAIL ${name}`)
		if (error instanceof Error) console.error(error.stack ?? error)
		else console.error(String(error))
		return false
	}
}

async function main(): Promise<void> {
	const tests: Array<[string, () => Promise<void>]> = [
		["inlines bodies", testBuildTaskFileContentInlineBodies],
		["falls back", testBuildTaskFileContentFallback],
		["plan-first mentions planning", testPlanFirstMentionsPlanning],
		["rework embeds findings", testReworkEmbedsFindings],
		["qa-rework and continuation", testQaReworkAndContinuation],
		["writeTaskFiles writes both", testWriteTaskFilesWritesBoth],
		["cli re-exports the leaf", testOrchestratorCliReexportsTheLeaf],
	]
	let failed = 0
	for (const [name, fn] of tests) {
		if (!(await runOne(name, fn))) failed++
	}
	if (failed > 0) {
		console.error(`\n${failed} test(s) failed`)
		process.exit(1)
	}
	console.log(`\nAll ${tests.length} task-files tests passed`)
}

main().catch((error) => {
	console.error("Test runner crashed:", error)
	process.exit(1)
})
