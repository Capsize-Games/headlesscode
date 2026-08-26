/**
 * Unit tests for src/codesearch/files.ts — git-aware source-file discovery.
 *
 * Plain assert-based script (no test framework, no network), run via
 * `npm test` -> `tsx src/codesearch/__tests__/files.test.ts`.
 */

import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { promisify } from "node:util"

import { walkSourceFiles } from "../files.js"

const execFileP = promisify(execFile)

async function mkGitRepo(files: Record<string, string>): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "hc-files-"))
	for (const [rel, content] of Object.entries(files)) {
		const abs = path.join(dir, rel)
		await fs.mkdir(path.dirname(abs), { recursive: true })
		await fs.writeFile(abs, content, "utf-8")
	}
	await execFileP("git", ["init", "-q"], { cwd: dir })
	await execFileP("git", ["config", "user.email", "test@example.com"], { cwd: dir })
	await execFileP("git", ["config", "user.name", "Test"], { cwd: dir })
	await execFileP("git", ["add", "-A"], { cwd: dir })
	await execFileP("git", ["commit", "-q", "-m", "init"], { cwd: dir })
	return dir
}

/**
 * The motivating real-world case: a generated coverage report + a lockfile
 * committed to git WITHOUT a .gitignore entry (the airunner repo's actual
 * state — client/coverage/ was tracked and cost real embedding-API money
 * before this exclusion existed). .gitignore alone can't protect against
 * this, since by definition these files were never gitignored.
 */
async function testAlwaysExcludesGeneratedArtifactsEvenWhenGitTracked(): Promise<void> {
	const ws = await mkGitRepo({
		"src/app.ts": "export const a = 1\n",
		"coverage/lcov-report/index.html": "<html>coverage report</html>\n",
		"coverage/lcov-report/base.css": "body {}\n",
		"client/coverage/block-navigation.js": "// generated\n",
		"package-lock.json": "{}\n",
		"dist/bundle.js": "// built output\n",
	})
	try {
		const files = await walkSourceFiles(ws)
		const rels = files.map((f) => f.rel)
		assert.ok(rels.includes("src/app.ts"), "real source must still be indexed")
		assert.ok(
			!rels.some((r) => r.startsWith("coverage/")),
			"top-level coverage/ must be excluded even when git-tracked",
		)
		assert.ok(
			!rels.some((r) => r.startsWith("client/coverage/")),
			"nested client/coverage/ must be excluded even when git-tracked",
		)
		assert.ok(!rels.includes("package-lock.json"), "lockfiles must be excluded even when git-tracked")
		assert.ok(
			!rels.some((r) => r.startsWith("dist/")),
			"dist/ build output must be excluded even when git-tracked",
		)
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

/** A directory that merely CONTAINS "coverage" as a substring must not be excluded — only exact path segments. */
async function testDoesNotOverMatchPartialNames(): Promise<void> {
	const ws = await mkGitRepo({
		"coverage-report-tool/src/index.ts": "export const tool = 1\n",
		"my-dist-utils/helper.ts": "export const helper = 1\n",
	})
	try {
		const files = await walkSourceFiles(ws)
		const rels = files.map((f) => f.rel)
		assert.ok(rels.includes("coverage-report-tool/src/index.ts"), "partial-name directory must not be excluded")
		assert.ok(rels.includes("my-dist-utils/helper.ts"), "partial-name directory must not be excluded")
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

const tests: Array<[string, () => Promise<void>]> = [
	["generated artifacts (coverage/, dist/, lockfiles) excluded even when git-tracked", testAlwaysExcludesGeneratedArtifactsEvenWhenGitTracked],
	["exclusion matches exact path segments only, not partial directory names", testDoesNotOverMatchPartialNames],
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
	console.log(`\nAll ${tests.length} files tests passed`)
}

main().catch((err) => {
	console.error("Test runner crashed:", err)
	process.exit(1)
})
