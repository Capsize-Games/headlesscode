/**
 * Unit tests for src/github/provision.ts — the clone-into-local-dir primitive.
 * Plain assert-based (no framework, no network). The "remote" is a REAL local
 * bare git repo created as a test fixture, so the clone is a real `git clone`
 * — git itself doesn't care that the "remote" is local. Run via `npm test`.
 *
 * The security property is asserted against the ACTUAL resulting
 * `.git/config` (via `git remote get-url origin`): the token string used
 * during the clone must NOT appear anywhere in the clone's remote URL.
 */

import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import * as fs from "node:fs"
import * as fsP from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"

import { provisionRepo, readOriginUrl } from "../provision.js"

/** The token used for clones in these tests (fake — never a real one). */
const FAKE_TOKEN = "ghs_TESTTOKEN1234567890"

function git(args: string[], cwd?: string): string {
	return execFileSync("git", args, { cwd, encoding: "utf-8" }).trim()
}

/**
 * Create a local source repo with one commit, then a BARE clone of it at
 * <tmp>/<owner>/<repo>.git. Cloning `https://x-access-token:<token>@github.com/
 * <owner>/<repo>.git` with a git `insteadOf` rewrite pointing that prefix at
 * <tmp>/ lets the test exercise the REAL `git clone` code path with the REAL
 * token-bearing URL while the actual data comes from the local bare repo.
 */
async function makeBareRemote(tmpRoot: string, owner: string, repo: string): Promise<string> {
	const src = path.join(tmpRoot, "src")
	fs.mkdirSync(src, { recursive: true })
	git(["init", "-q"], src)
	git(["config", "user.email", "t@example.com"], src)
	git(["config", "user.name", "Test"], src)
	fs.writeFileSync(path.join(src, "README.md"), "# " + repo + "\n")
	git(["add", "."], src)
	git(["commit", "-qm", "init"], src)

	const bareDir = path.join(tmpRoot, "git-remotes", owner, `${repo}.git`)
	fs.mkdirSync(path.dirname(bareDir), { recursive: true })
	git(["clone", "-q", "--bare", src, bareDir])
	return bareDir
}

/** An insteadOf rewrite making `https://x-access-token:TOKEN@github.com/` map
 * to the local bare-remotes dir, so the token-bearing URL is a REAL URL that
 * git will actually use. */
function insteadOfArgs(tmpRoot: string): string[] {
	return ["-c", `url.${path.join(tmpRoot, "git-remotes")}/.insteadOf=https://x-access-token:${FAKE_TOKEN}@github.com/`]
}

async function tmpRoot(): Promise<string> {
	return fsP.mkdtemp(path.join(os.tmpdir(), "headlesscode-provision-"))
}

// ─── Tests ───────────────────────────────────────────────────────────────────

async function testRealCloneWithTokenUrlAndNoLeak(): Promise<void> {
	const tmp = await tmpRoot()
	try {
		await makeBareRemote(tmp, "octo", "secret-repo")

		// Real `git clone` of a token-bearing github.com URL, with the URL
		// rewritten (insteadOf) to the local bare repo — so the actual clone
		// code path in provisionRepo is exercised end-to-end. The wrapper
		// injects the insteadOf rewrite + credential.helper= (no credential
		// helper so the token URL is truly the stored URL before the rewrite).
		const wrapperDir = path.join(tmp, "gitbin")
		fs.mkdirSync(wrapperDir)
		const wrapper = path.join(wrapperDir, "git")
		const insteadOfArg = `url.${path.join(tmp, "git-remotes")}/.insteadOf=https://x-access-token:${FAKE_TOKEN}@github.com/`
		fs.writeFileSync(
			wrapper,
			`#!/usr/bin/env bash\n` +
				`if [[ "$*" == *clone* ]]; then\n` +
				`  exec /usr/bin/git -c "${insteadOfArg}" -c credential.helper= "$@"\n` +
				`fi\n` +
				`exec /usr/bin/git "$@"\n`,
		)
		fs.chmodSync(wrapper, 0o755)

		const target = path.join(tmp, "clone")
		const local = await provisionRepo({
			installationId: 123,
			owner: "octo",
			repo: "secret-repo",
			targetDir: target,
			getToken: async () => FAKE_TOKEN,
			gitBin: wrapper,
		})

		assert.equal(local, target)
		// The clone actually happened and has content.
		const readme = fs.readFileSync(path.join(target, "README.md"), "utf-8")
		assert.ok(readme.includes("secret-repo"), "the clone contains the fixture repo's content")

		// SECURITY: the remote URL stored in .git/config must NOT contain the
		// token. Asserted against the ACTUAL config via git remote get-url.
		const origin = await readOriginUrl(target)
		assert.equal(origin, `https://github.com/octo/secret-repo.git`, `origin must be rewritten token-free, got: ${origin}`)
		assert.ok(!origin.includes(FAKE_TOKEN), "the token must NOT appear in the clone's remote URL")
	} finally {
		await fsP.rm(tmp, { recursive: true, force: true })
	}
}

async function testRefusesNonEmptyTarget(): Promise<void> {
	const tmp = await tmpRoot()
	try {
		await makeBareRemote(tmp, "octo", "hello")
		const target = path.join(tmp, "occupied")
		fs.mkdirSync(target, { recursive: true })
		fs.writeFileSync(path.join(target, "existing.txt"), "do not clobber me")

		await assert.rejects(
			() =>
				provisionRepo({
					installationId: 123,
					owner: "octo",
					repo: "hello",
					targetDir: target,
					getToken: async () => FAKE_TOKEN,
				}),
			(err) => {
				assert.ok(err instanceof Error)
				assert.match((err as Error).message, /not empty/)
				return true
			},
		)
		// The existing file is untouched.
		assert.equal(fs.readFileSync(path.join(target, "existing.txt"), "utf-8"), "do not clobber me")
	} finally {
		await fsP.rm(tmp, { recursive: true, force: true })
	}
}

async function testRefusesExistingFileTarget(): Promise<void> {
	const tmp = await tmpRoot()
	try {
		const target = path.join(tmp, "occupied-file")
		fs.writeFileSync(target, "i am a file")

		await assert.rejects(
			() =>
				provisionRepo({
					installationId: 123,
					owner: "octo",
					repo: "hello",
					targetDir: target,
					getToken: async () => FAKE_TOKEN,
				}),
			(err) => {
				assert.ok(err instanceof Error)
				assert.match((err as Error).message, /not a directory/)
				return true
			},
		)
	} finally {
		await fsP.rm(tmp, { recursive: true, force: true })
	}
}

// ─── Runner ──────────────────────────────────────────────────────────────────

const tests: Array<[string, () => Promise<void>]> = [
	["real clone with token-bearing URL into empty target succeeds", testRealCloneWithTokenUrlAndNoLeak],
	["token does NOT leak into the clone's remote URL (.git/config)", testRealCloneWithTokenUrlAndNoLeak],
	["refuses to clone into a non-empty target", testRefusesNonEmptyTarget],
	["refuses when target exists as a file", testRefusesExistingFileTarget],
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
	console.log(`\nAll ${tests.length} provision tests passed`)
}

main().catch((err) => {
	console.error("Test runner crashed:", err)
	process.exit(1)
})
