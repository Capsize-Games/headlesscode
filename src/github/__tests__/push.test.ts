/**
 * Unit tests for src/github/push.ts — the push-a-branch primitive.
 * Plain assert-based (no framework, no network). The "remote" is a REAL local
 * bare git repo created as a test fixture, so the push is a real `git push` —
 * git itself doesn't care that the "remote" is local. Run via `npm test`.
 *
 * The token-bearing URL construction is proven the same way provision.test.ts
 * proves its clone URL: a git `insteadOf` rewrite maps
 * `https://x-access-token:<TOKEN>@github.com/` onto the local bare-remotes
 * dir, so the push can only succeed if pushBranch built EXACTLY
 * `https://x-access-token:<TOKEN>@github.com/<owner>/<repo>.git`. Any wrong
 * owner/repo/token prefix and git either hits the real (unreachable)
 * github.com or a nonexistent local path and fails.
 *
 * The security property is asserted against the ACTUAL resulting
 * `.git/config` (via `git remote get-url origin`): after pushBranch returns —
 * success OR failure — the origin URL must be back to its original token-free
 * form and must NOT contain the token (mirrors provision.test.ts's clone
 * assertion).
 */

import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import * as fs from "node:fs"
import * as fsP from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"

import { PushError, pushBranch } from "../push.js"

/** The token used for pushes in these tests (fake — never a real one). */
const FAKE_TOKEN = "ghs_TESTTOKEN1234567890"

function git(args: string[], cwd?: string): string {
	return execFileSync("git", args, { cwd, encoding: "utf-8" }).trim()
}

/**
 * Create a local source repo with one commit, then a BARE clone of it at
 * <tmp>/<owner>/<repo>.git — the "remote" the push will land in. Returns the
 * bare dir path plus the bare repo's default ref (whatever git decided —
 * main/master — so tests never hardcode it).
 */
async function makeBareRemote(tmpRoot: string, owner: string, repo: string): Promise<{ bareDir: string; defaultRef: string }> {
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

	const defaultRef = git(["symbolic-ref", "HEAD"], bareDir)
	return { bareDir, defaultRef }
}

/**
 * Build the wrapper git binary pushBranch will invoke. It injects an insteadOf
 * rewrite so the token-bearing `https://x-access-token:<TOKEN>@github.com/`
 * URL in pushBranch's push actually resolves to the local bare-remotes dir,
 * and credential.helper= so no credential helper ever sees the token URL.
 */
function makeWrapper(tmpRoot: string): string {
	const wrapperDir = path.join(tmpRoot, "gitbin")
	fs.mkdirSync(wrapperDir)
	const wrapper = path.join(wrapperDir, "git")
	const insteadOfArg = `url.${path.join(tmpRoot, "git-remotes")}/.insteadOf=https://x-access-token:${FAKE_TOKEN}@github.com/`
	fs.writeFileSync(
		wrapper,
		`#!/usr/bin/env bash\n` +
			`exec /usr/bin/git -c "${insteadOfArg}" -c credential.helper= "$@"\n`,
	)
	fs.chmodSync(wrapper, 0o755)
	return wrapper
}

/**
 * Set up a local working repo in <tmp>/work that looks exactly like a
 * provisioned clone: origin points at the token-free
 * `https://github.com/<owner>/<repo>.git` URL, with one extra commit on a
 * feature branch ready to push. Returns the local dir + the commit sha.
 */
function makeWorkingRepo(tmpRoot: string, bareDir: string, owner: string, repo: string, branch: string): { localDir: string; headSha: string } {
	const localDir = path.join(tmpRoot, "work")
	git(["clone", "-q", bareDir, localDir])
	// Simulate the post-provision state: token-free origin URL.
	git(["remote", "set-url", "origin", `https://github.com/${owner}/${repo}.git`], localDir)
	git(["checkout", "-q", "-b", branch], localDir)
	fs.writeFileSync(path.join(localDir, "feature.txt"), "feature work\n")
	git(["add", "."], localDir)
	git(["config", "user.email", "t@example.com"], localDir)
	git(["config", "user.name", "Test"], localDir)
	git(["commit", "-qm", "feature work"], localDir)
	const headSha = git(["rev-parse", "HEAD"], localDir)
	return { localDir, headSha }
}

async function tmpRoot(): Promise<string> {
	return fsP.mkdtemp(path.join(os.tmpdir(), "headlesscode-push-"))
}

// ─── Tests ───────────────────────────────────────────────────────────────────

async function testPushesNamedBranchAndScrubsToken(): Promise<void> {
	const tmp = await tmpRoot()
	try {
		const { bareDir, defaultRef } = await makeBareRemote(tmp, "octo", "hello")
		const wrapper = makeWrapper(tmp)
		const defaultShaBefore = git(["rev-parse", defaultRef], bareDir)
		const { localDir, headSha } = makeWorkingRepo(tmp, bareDir, "octo", "hello", "feature-x")

		await pushBranch({
			installationId: 123,
			owner: "octo",
			repo: "hello",
			localDir,
			branchName: "feature-x",
			getToken: async () => FAKE_TOKEN,
			gitBin: wrapper,
		})

		// The push went to the NAMED branch only: refs/heads/feature-x now
		// exists at the local commit, and the repo's default branch ref is
		// untouched.
		const featureSha = git(["rev-parse", "refs/heads/feature-x"], bareDir)
		assert.equal(featureSha, headSha, "the pushed branch points at the local HEAD commit")
		assert.equal(git(["rev-parse", defaultRef], bareDir), defaultShaBefore, "the default branch ref must be unchanged")
		const refs = git(["for-each-ref", "--format=%(refname)", "refs/heads"], bareDir)
		assert.ok(refs.includes("refs/heads/feature-x"), "only the named branch was pushed")

		// SECURITY: origin restored to its original token-free URL; the token
		// must not appear anywhere in .git/config.
		const origin = git(["remote", "get-url", "origin"], localDir)
		assert.equal(origin, `https://github.com/octo/hello.git`, `origin must be restored token-free, got: ${origin}`)
		assert.ok(!origin.includes(FAKE_TOKEN), "the token must NOT appear in the restored origin URL")
	} finally {
		await fsP.rm(tmp, { recursive: true, force: true })
	}
}

async function testFailedPushStillScrubsToken(): Promise<void> {
	const tmp = await tmpRoot()
	try {
		const { bareDir } = await makeBareRemote(tmp, "octo", "hello")
		const wrapper = makeWrapper(tmp)
		const { localDir } = makeWorkingRepo(tmp, bareDir, "octo", "hello", "feature-x")

		// A branch name with a space is an invalid refspec — the push fails
		// AFTER the authenticated URL has been set on origin.
		await assert.rejects(
			() =>
				pushBranch({
					installationId: 123,
					owner: "octo",
					repo: "hello",
					localDir,
					branchName: "feature x",
					getToken: async () => FAKE_TOKEN,
					gitBin: wrapper,
				}),
			(err) => {
				assert.ok(err instanceof PushError)
				assert.match((err as Error).message, /failed for branch 'feature x'/)
				return true
			},
		)

		// Even on failure the token must be scrubbed immediately (the finally
		// restore runs regardless of push outcome).
		const origin = git(["remote", "get-url", "origin"], localDir)
		assert.equal(origin, `https://github.com/octo/hello.git`, `origin must be restored even after a failed push, got: ${origin}`)
		assert.ok(!origin.includes(FAKE_TOKEN), "the token must NOT survive a failed push")
	} finally {
		await fsP.rm(tmp, { recursive: true, force: true })
	}
}

async function testRefusesMissingToken(): Promise<void> {
	await assert.rejects(
		() =>
			pushBranch({
				installationId: 123,
				owner: "octo",
				repo: "hello",
				localDir: "/nonexistent",
				branchName: "feature-x",
				getToken: async () => "",
			}),
		(err) => {
			assert.ok(err instanceof PushError)
			assert.match((err as Error).message, /no installation token/)
			return true
		},
	)
}

// ─── Runner ──────────────────────────────────────────────────────────────────

const tests: Array<[string, () => Promise<void>]> = [
	["pushes to the named branch (never the default) and scrubs the token from origin", testPushesNamedBranchAndScrubsToken],
	["a failed push still scrubs the token from origin", testFailedPushStillScrubsToken],
	["refuses when the token supplier returns nothing", testRefusesMissingToken],
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
	console.log(`\nAll ${tests.length} push tests passed`)
}

main().catch((err) => {
	console.error("Test runner crashed:", err)
	process.exit(1)
})
