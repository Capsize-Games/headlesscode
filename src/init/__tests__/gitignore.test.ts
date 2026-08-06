/**
 * Unit tests for src/init/gitignore.ts — `headlesscode init`'s .gitignore
 * hygiene (ensure .headlesscode/ is excluded from a target repo).
 *
 * Plain assert-based script (no test framework, no network), run via
 * `npm test` -> `tsx src/init/__tests__/gitignore.test.ts`.
 */

import assert from "node:assert/strict"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"

import { ensureWorkspaceGitignore } from "../gitignore.js"

const EXPECTED_ENTRY = "# headlesscode session artifacts (events, reports, usage, scratch, memory)\n/.headlesscode/\n"

async function mkWs(): Promise<string> {
	return fs.mkdtemp(path.join(os.tmpdir(), "hc-init-gi-"))
}

/** No .gitignore exists → the file is created with the .headlesscode entry. */
async function testMissingFileCreatesEntry(): Promise<void> {
	const ws = await mkWs()
	try {
		const result = ensureWorkspaceGitignore(ws)
		assert.equal(result.action, "created", "a missing .gitignore must be reported as created")
		const content = await fs.readFile(path.join(ws, ".gitignore"), "utf-8")
		assert.equal(content, EXPECTED_ENTRY, "new .gitignore must be exactly comment + /.headlesscode/")
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

/** .gitignore exists without a covering line → entry appended, existing content byte-untouched. */
async function testAppendsAndPreservesExistingContent(): Promise<void> {
	const ws = await mkWs()
	try {
		const before = "node_modules/\n\ndist/\n*.log\n"
		await fs.writeFile(path.join(ws, ".gitignore"), before, "utf-8")
		const result = ensureWorkspaceGitignore(ws)
		assert.equal(result.action, "appended", "an uncovered .gitignore must be reported as appended")
		const content = await fs.readFile(path.join(ws, ".gitignore"), "utf-8")
		assert.ok(content.startsWith(before), "existing content must be preserved byte-for-byte at the front")
		assert.ok(content.endsWith(EXPECTED_ENTRY), "entry must be appended at the end")
		assert.equal(content, before + EXPECTED_ENTRY, "file must be exactly old content + entry")
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

/**
 * Any of the four accepted spellings already covering .headlesscode → no-op;
 * verified by exact byte comparison, not just "still contains the pattern".
 */
async function testAlreadyCoveredIsNoop(): Promise<void> {
	const spellings = [".headlesscode/", "/.headlesscode/", ".headlesscode", "/.headlesscode"]
	for (const spelling of spellings) {
		const ws = await mkWs()
		try {
			const before = `node_modules/\n${spelling}\n*.log\n`
			const gitignorePath = path.join(ws, ".gitignore")
			await fs.writeFile(gitignorePath, before, "utf-8")
			const result = ensureWorkspaceGitignore(ws)
			assert.equal(result.action, "unchanged", `spelling "${spelling}" must be recognized as already covered`)
			const after = await fs.readFile(gitignorePath, "utf-8")
			assert.equal(after, before, `file must be byte-identical when "${spelling}" already covers it`)
		} finally {
			await fs.rm(ws, { recursive: true, force: true })
		}
	}
}

/** A commented .headlesscode line (or a bare `*`) also counts as covered. */
async function testCommentedAndWildcardCoverage(): Promise<void> {
	for (const [label, content] of [
		["commented line", "# .headlesscode is gitignored\n/.headlesscode/\n"],
		["bare wildcard", "*\n"],
	]) {
		const ws = await mkWs()
		try {
			const gitignorePath = path.join(ws, ".gitignore")
			await fs.writeFile(gitignorePath, content, "utf-8")
			const result = ensureWorkspaceGitignore(ws)
			assert.equal(result.action, "unchanged", `${label} must count as covering .headlesscode`)
			assert.equal(await fs.readFile(gitignorePath, "utf-8"), content, "file must remain byte-identical")
		} finally {
			await fs.rm(ws, { recursive: true, force: true })
		}
	}
}

/** An unrelated pattern that does NOT cover .headlesscode → entry still appended. */
async function testUnrelatedPatternStillAppends(): Promise<void> {
	const ws = await mkWs()
	try {
		const before = "node_modules/\n"
		await fs.writeFile(path.join(ws, ".gitignore"), before, "utf-8")
		const result = ensureWorkspaceGitignore(ws)
		assert.equal(result.action, "appended", "node_modules/ alone must not count as covering .headlesscode")
		const content = await fs.readFile(path.join(ws, ".gitignore"), "utf-8")
		assert.equal(content, before + EXPECTED_ENTRY, "entry must be appended after the unrelated pattern")
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

/** A nonexistent workspace (or a plain file) → untouched, no .gitignore created. */
async function testNonDirectoryWorkspaceIsSkipped(): Promise<void> {
	const ws = await mkWs()
	try {
		const missing = path.join(ws, "does-not-exist")
		const result = ensureWorkspaceGitignore(missing)
		assert.equal(result.action, "unchanged", "missing workspace must be a silent no-op")
		assert.equal(
			await fs.stat(path.join(missing, ".gitignore")).then(() => true).catch(() => false),
			false,
			"no .gitignore must be created for a missing workspace",
		)

		const fileWs = path.join(ws, "afile")
		await fs.writeFile(fileWs, "x", "utf-8")
		const fileResult = ensureWorkspaceGitignore(fileWs)
		assert.equal(fileResult.action, "unchanged", "a file (not a directory) workspace must be a no-op")
		assert.equal(
			await fs.stat(path.join(fileWs, ".gitignore")).then(() => true).catch(() => false),
			false,
			"no .gitignore must be created for a file workspace",
		)
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

const tests: Array<[string, () => Promise<void>]> = [
	["missing .gitignore is created with the .headlesscode entry", testMissingFileCreatesEntry],
	["existing .gitignore without coverage gets the entry appended, content preserved", testAppendsAndPreservesExistingContent],
	["all four .headlesscode spellings are recognized as already covered (byte-identical no-op)", testAlreadyCoveredIsNoop],
	["commented .headlesscode entry and bare * count as covered", testCommentedAndWildcardCoverage],
	["unrelated pattern (node_modules/) still gets the entry appended", testUnrelatedPatternStillAppends],
	["missing / non-directory workspace is a silent no-op (no .gitignore created)", testNonDirectoryWorkspaceIsSkipped],
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
	console.log(`\nAll ${tests.length} gitignore tests passed`)
}

main().catch((err) => {
	console.error("Test runner crashed:", err)
	process.exit(1)
})
