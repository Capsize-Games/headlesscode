import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { test } from "node:test"
import { restorePinnedWorktreeEolBytes,
	verifyPinnedGitWorktreeTree } from "../repository-source-tree.js"

interface GitFixture {
	root: string
	revision: string
	treeSha: string
	cleanup(): Promise<void>
}

async function fixture(): Promise<GitFixture> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(),
		"hcl-pinned-source-tree-"))
	const git = (args: string[]) => runGit(root, args)
	await prepareGitFixture(root, git)
	const revision = git(["rev-parse", "HEAD"])
	const treeSha = git(["rev-parse", "HEAD^{tree}"])
	return { root, revision, treeSha, cleanup: () => fs.rm(root,
		{ recursive: true, force: true }) }
}

function runGit(root: string, args: string[]): string {
	const { error, status, stdout } = spawnSync("git", ["-C", root, ...args],
		{ encoding: "utf8", timeout: 10_000 })
	if (error || status !== 0) {
		throw new Error("temporary git fixture setup failed")
	}
	return stdout.trim()
}

async function prepareGitFixture(root: string,
	git: (args: string[]) => string): Promise<void> {
	git(["init", "--quiet"])
	git(["config", "user.name", "Fixture"])
	git(["config", "user.email", "fixture@example.invalid"])
	await fs.mkdir(path.join(root, "src"))
	await fs.writeFile(
		path.join(root, "src", "main.ts"), "export const value = 1\n",
	)
	git(["add", "src/main.ts"])
	git(["commit", "--quiet", "-m", "fixture"])
}

test(
	"pinned source verifier checks actual bytes and ignores no changed-file flags",
	async (t) => {
		const f = await fixture(); t.after(f.cleanup)
	const verified = await verifyPinnedGitWorktreeTree({ worktree: f.root,
		revision: f.revision, expectedTreeSha: f.treeSha })
	assert.equal(verified.treeSha, f.treeSha)
	assert.equal(verified.fileCount, 1)
	await new Promise<void>((resolve, reject) => {
		const result = spawnSync("git", ["-C", f.root, "update-index",
			"--assume-unchanged", "src/main.ts"], { encoding: "utf8" })
		if (result.error || result.status !== 0) {
			reject(new Error("could not set fixture index flag"))
		} else resolve()
	})
	await fs.writeFile(path.join(f.root, "src", "main.ts"),
		"export const value = 2\n")
	await assert.rejects(verifyPinnedGitWorktreeTree({ worktree: f.root,
		revision: f.revision, expectedTreeSha: f.treeSha }), /bytes differ/)
	},
)

test(
	"pinned verifier rejects untracked files, symlinks and mismatched tree IDs",
	async (t) => {
		const f = await fixture(); t.after(f.cleanup)
	await fs.writeFile(path.join(f.root, "extra.txt"), "unexpected\n")
	await assert.rejects(verifyPinnedGitWorktreeTree({ worktree: f.root,
		revision: f.revision, expectedTreeSha: f.treeSha }), /unexpected file/)
	await fs.rm(path.join(f.root, "extra.txt"))
	await fs.symlink("main.ts", path.join(f.root, "src", "link.ts"))
	await assert.rejects(verifyPinnedGitWorktreeTree({ worktree: f.root,
		revision: f.revision, expectedTreeSha: f.treeSha }), /symbolic link/)
	await fs.rm(path.join(f.root, "src", "link.ts"))
	await assert.rejects(verifyPinnedGitWorktreeTree({ worktree: f.root,
		revision: f.revision, expectedTreeSha: "0".repeat(40) }), /does not match/)
	},
)

test(
	"fresh worktree restores verified CRLF bytes and rejects later mutation",
	async (t) => {
		const f = await fixture(); t.after(f.cleanup)
		const check = await prepareCrlfWorktree(f)
		const trees = path.join(f.root, ".worktrees")
		t.after(() => fs.rm(trees, { recursive: true, force: true }))
		await assertCrlfRestoreRejectsMutation(check)
	},
)

interface CrlfWorktree {
	worktree: string
	revision: string
	treeSha: string
}

async function prepareCrlfWorktree(f: GitFixture): Promise<CrlfWorktree> {
	await fs.writeFile(path.join(f.root, ".gitattributes"),
		"windows.txt text eol=crlf\n")
	await fs.writeFile(path.join(f.root, "windows.txt"), "first\nsecond\n")
	const git = (args: string[]) => runGit(f.root, args)
	git(["add", ".gitattributes", "windows.txt"])
	git(["commit", "--quiet", "-m", "add CRLF fixture"])
	const revision = git(["rev-parse", "HEAD"])
	const treeSha = git(["rev-parse", "HEAD^{tree}"])
	const worktreeParent = path.join(f.root, ".worktrees")
	await fs.mkdir(worktreeParent, { mode: 0o700 })
	const worktree = path.join(worktreeParent, "curl-campaign-test")
	git(["worktree", "add", "--quiet", "--detach", worktree, revision])
	return { worktree, revision, treeSha }
}

async function assertCrlfRestoreRejectsMutation(
	check: CrlfWorktree,
): Promise<void> {
	const { worktree, revision, treeSha } = check
	const checkedOut = await fs.readFile(path.join(worktree, "windows.txt"))
	assert.deepEqual(checkedOut, Buffer.from("first\r\nsecond\r\n"))
	assert.equal(await restorePinnedWorktreeEolBytes({ worktree, revision,
		expectedTreeSha: treeSha }), 1)
	assert.deepEqual(await fs.readFile(path.join(worktree, "windows.txt")),
		Buffer.from("first\nsecond\n"))
	assert.equal((await verifyPinnedGitWorktreeTree({ worktree, revision,
		expectedTreeSha: treeSha })).fileCount, 3)
	await fs.writeFile(path.join(worktree, "windows.txt"), "worker mutation\n")
	await assert.rejects(verifyPinnedGitWorktreeTree({ worktree, revision,
		expectedTreeSha: treeSha }), /bytes differ/)
}
