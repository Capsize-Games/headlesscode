import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { test } from "node:test"
import { verifyPinnedGitWorktreeTree } from "../repository-source-tree.js"

async function fixture(): Promise<{ root: string; revision: string; treeSha: string; cleanup(): Promise<void> }> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "hcl-pinned-source-tree-"))
	const git = (args: string[]) => {
		const result = spawnSync("git", ["-C", root, ...args], { encoding: "utf8", timeout: 10_000 })
		if (result.error || result.status !== 0) throw new Error("temporary git fixture setup failed")
		return result.stdout.trim()
	}
	git(["init", "--quiet"])
	git(["config", "user.name", "Fixture"])
	git(["config", "user.email", "fixture@example.invalid"])
	await fs.mkdir(path.join(root, "src"))
	await fs.writeFile(path.join(root, "src", "main.ts"), "export const value = 1\n")
	git(["add", "src/main.ts"])
	git(["commit", "--quiet", "-m", "fixture"])
	const revision = git(["rev-parse", "HEAD"])
	const treeSha = git(["rev-parse", "HEAD^{tree}"])
	return { root, revision, treeSha, cleanup: () => fs.rm(root, { recursive: true, force: true }) }
}

test("pinned source verifier checks actual bytes and ignores no changed-file flags", async (t) => {
	const f = await fixture(); t.after(f.cleanup)
	const verified = await verifyPinnedGitWorktreeTree({ worktree: f.root, revision: f.revision, expectedTreeSha: f.treeSha })
	assert.equal(verified.treeSha, f.treeSha)
	assert.equal(verified.fileCount, 1)
	await new Promise<void>((resolve, reject) => {
		const result = spawnSync("git", ["-C", f.root, "update-index", "--assume-unchanged", "src/main.ts"], { encoding: "utf8" })
		if (result.error || result.status !== 0) reject(new Error("could not set fixture index flag")); else resolve()
	})
	await fs.writeFile(path.join(f.root, "src", "main.ts"), "export const value = 2\n")
	await assert.rejects(verifyPinnedGitWorktreeTree({ worktree: f.root, revision: f.revision, expectedTreeSha: f.treeSha }), /bytes differ/)
})

test("pinned source verifier rejects untracked files, symlinks and mismatched tree IDs", async (t) => {
	const f = await fixture(); t.after(f.cleanup)
	await fs.writeFile(path.join(f.root, "extra.txt"), "unexpected\n")
	await assert.rejects(verifyPinnedGitWorktreeTree({ worktree: f.root, revision: f.revision, expectedTreeSha: f.treeSha }), /unexpected file/)
	await fs.rm(path.join(f.root, "extra.txt"))
	await fs.symlink("main.ts", path.join(f.root, "src", "link.ts"))
	await assert.rejects(verifyPinnedGitWorktreeTree({ worktree: f.root, revision: f.revision, expectedTreeSha: f.treeSha }), /symbolic link/)
	await fs.rm(path.join(f.root, "src", "link.ts"))
	await assert.rejects(verifyPinnedGitWorktreeTree({ worktree: f.root, revision: f.revision, expectedTreeSha: "0".repeat(40) }), /does not match/)
})
