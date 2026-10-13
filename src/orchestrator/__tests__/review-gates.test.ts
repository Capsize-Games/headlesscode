import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import * as fsp from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"

import type { CodeIntel } from "../../codeintel/program.js"
import type { GateRunner } from "../review-gates.js"
import { runReviewGates } from "../review-gates.js"
import { hasRealWorktreeChanges } from "../verification-gate.js"

function git(repo: string, args: string[]): string {
	return execFileSync("git", ["-C", repo, ...args], {
		encoding: "utf-8",
		stdio: ["ignore", "pipe", "ignore"],
	}).trim()
}

async function initRepo(repo: string): Promise<void> {
	execFileSync("git", ["init", "-q", "-b", "main", repo], {
		stdio: "ignore",
	})
	git(repo, ["config", "user.email", "test@headlesscode.invalid"])
	git(repo, ["config", "user.name", "Review Gates Test"])
	git(repo, ["config", "commit.gpgsign", "false"])
	await fsp.writeFile(path.join(repo, "README.md"), "# fixture\n")
	git(repo, ["add", "README.md"])
	git(repo, ["commit", "-qm", "init"])
}

async function makeFixture(): Promise<{ repo: string; wt: string }> {
	const repo = await fsp.mkdtemp(path.join(os.tmpdir(), "hc-review-gates-"))
	await initRepo(repo)
	const wt = path.join(repo, ".worktrees", "w1")
	git(repo, ["worktree", "add", "-q", "-b", "feat", wt, "main"])
	git(wt, ["branch", "--set-upstream-to=main"])
	return { repo, wt }
}

async function withFixture(fn: (wt: string) => Promise<void>): Promise<void> {
	const { repo, wt } = await makeFixture()
	try {
		await fn(wt)
	} finally {
		const wtPath = path.join(repo, ".worktrees", "w1")
		git(repo, ["worktree", "remove", "--force", wtPath])
		git(repo, ["worktree", "prune"])
		await fsp.rm(repo, { recursive: true, force: true })
	}
}

function stubIntel(): CodeIntel {
	return {
		__importGraph: { imports: new Map(), importedBy: new Map() },
	} as unknown as CodeIntel
}

function greenRunner(calls: string[][]): GateRunner {
	return (cmd: string, args: string[], _cwd: string, _timeout: number) => {
		calls.push([cmd, ...args])
		return { status: 0, output: "(stubbed)" }
	}
}

function redTscRunner(): GateRunner {
	return (_cmd: string, args: string[], _cwd: string, _t: number) => {
		if (args[0].includes("tsc")) {
			return { status: 2, output: "error TS2322: boom" }
		}
		return { status: 0, output: "(stubbed)" }
	}
}

async function writeCoveredSource(wt: string, base: string): Promise<void> {
	const dir = path.join(wt, "src", "__tests__")
	await fsp.mkdir(dir, { recursive: true })
	await fsp.writeFile(path.join(wt, "src", `${base}.ts`), "export const v = 1\n")
	const test = path.join(dir, `${base}.test.ts`)
	await fsp.writeFile(test, "void 0\n")
}

function assertAllGatesRan(calls: string[][]): void {
	assert.ok(calls.some((c) => c[1].includes("typescript/bin/tsc")))
	assert.ok(calls.some((c) => c[1] === "scripts/run-tests.mjs"))
	const std = "scripts/check-code-standards.mjs"
	assert.ok(calls.some((c) => c[1] === std))
	const arch = "scripts/check-architecture.mjs"
	assert.ok(calls.some((c) => c[2] === arch))
}

async function changesNeedFixtureFiles(wt: string): Promise<void> {
	assert.equal(hasRealWorktreeChanges(wt), false)
	await fsp.mkdir(path.join(wt, "src"), { recursive: true })
	const file = path.join(wt, "src", "a.ts")
	await fsp.writeFile(file, "export const a = 1\n")
	assert.equal(hasRealWorktreeChanges(wt), true)
}

async function bookkeepingIsIgnored(wt: string): Promise<void> {
	await fsp.writeFile(path.join(wt, "harness.log"), "noise\n")
	assert.equal(hasRealWorktreeChanges(wt), false)
}

async function coveredSourcePasses(wt: string): Promise<void> {
	await writeCoveredSource(wt, "a")
	let intelCalls = 0
	const calls: string[][] = []
	const result = runReviewGates(wt, {
		loadIntel: () => {
			intelCalls++
			return stubIntel()
		},
		run: greenRunner(calls),
	})
	assert.equal(result.ok, true)
	assert.equal(intelCalls, 0)
	assertAllGatesRan(calls)
}

async function redGateFailsClosed(wt: string): Promise<void> {
	await writeCoveredSource(wt, "b")
	const red = runReviewGates(wt, {
		loadIntel: stubIntel,
		run: redTscRunner(),
	})
	assert.equal(red.ok, false)
	assert.ok(red.summary.includes("tsc --noEmit failed (exit 2)"))
	assert.ok(red.output.includes("TS2322"))
}

async function docsOnlySkipsTypeTests(wt: string): Promise<void> {
	await fsp.writeFile(path.join(wt, "notes.md"), "notes\n")
	const calls: string[][] = []
	const result = runReviewGates(wt, {
		loadIntel: stubIntel,
		run: greenRunner(calls),
	})
	assert.equal(result.ok, true)
	assert.ok(!calls.some((c) => String(c[1]).includes("tsc")))
	assert.ok(!calls.some((c) => c[1] === "scripts/run-tests.mjs"))
}

async function uncoveredSourceFlagged(wt: string): Promise<void> {
	await fsp.mkdir(path.join(wt, "src"), { recursive: true })
	const file = path.join(wt, "src", "lonely.ts")
	await fsp.writeFile(file, "export const x = 1\n")
	const result = runReviewGates(wt, {
		loadIntel: stubIntel,
		run: greenRunner([]),
	})
	assert.equal(result.ok, false)
	const want = "no test covers changed file src/lonely.ts"
	assert.ok(result.summary.includes(want))
}

const tests: Array<[string, () => Promise<void>]> = [
	["changes track fixture files", () => withFixture(changesNeedFixtureFiles)],
	["bookkeeping files ignored", () => withFixture(bookkeepingIsIgnored)],
	["covered sources pass sans intel", () => withFixture(coveredSourcePasses)],
	["red gate fails closed", () => withFixture(redGateFailsClosed)],
	["docs-only skips tsc/tests", () => withFixture(docsOnlySkipsTypeTests)],
	["uncovered sources flagged", () => withFixture(uncoveredSourceFlagged)],
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
			const detail = err instanceof Error ? err.stack ?? err.message : String(err)
			console.error(detail)
		}
	}
	if (failed > 0) {
		console.error(`\n${failed} test(s) failed`)
		process.exit(1)
	}
	console.log(`\nAll ${tests.length} review-gates tests passed`)
}

main().catch((err) => {
	console.error("Test runner crashed:", err)
	process.exit(1)
})
