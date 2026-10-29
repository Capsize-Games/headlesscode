import assert from "node:assert/strict"
import test from "node:test"
import { execFileSync } from "node:child_process"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { assertMutationAllowlist } from "../mutation-allowlist.js"

function repository(): { root: string; base: string; close: () => void } {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "rsi-mutation-allowlist-"))
	const git = (...args: string[]) => execFileSync("git", args, { cwd: root, stdio: "pipe" }).toString().trim()
	git("init", "--quiet")
	git("config", "user.name", "Test")
	git("config", "user.email", "test@example.invalid")
	fs.writeFileSync(path.join(root, "candidate.py"), "value = 1\n")
	fs.writeFileSync(path.join(root, "evaluator.py"), "def evaluate(): return True\n")
	git("add", ".")
	git("commit", "--quiet", "-m", "base")
	const base = git("rev-parse", "HEAD")
	return { root, base, close: () => fs.rmSync(root, { recursive: true, force: true }) }
}

async function commit(root: string) {
	execFileSync("git", ["add", "-A"], { cwd: root, stdio: "pipe" })
	execFileSync("git", ["commit", "--quiet", "-m", "candidate"], { cwd: root, stdio: "pipe" })
}

test("positive mutation allowlist accepts only the pinned regular text path", async () => {
	const repo = repository()
	try {
		fs.writeFileSync(path.join(repo.root, "candidate.py"), "value = 2\n")
		await commit(repo.root)
		await assertMutationAllowlist(repo.root, repo.base, ["candidate.py"])
	} finally { repo.close() }
})

test("positive mutation allowlist rejects evaluator, added, binary, and mode changes", async () => {
	for (const kind of ["evaluator", "added", "binary", "mode"] as const) {
		const repo = repository()
		try {
			if (kind === "evaluator") fs.writeFileSync(path.join(repo.root, "evaluator.py"), "def evaluate(): return False\n")
			if (kind === "added") fs.writeFileSync(path.join(repo.root, "new.py"), "value = 3\n")
			if (kind === "binary") fs.writeFileSync(path.join(repo.root, "candidate.py"), Buffer.from([0, 1, 2]))
			if (kind === "mode") fs.chmodSync(path.join(repo.root, "candidate.py"), 0o755)
			await commit(repo.root)
			await assert.rejects(assertMutationAllowlist(repo.root, repo.base, ["candidate.py"]), /disallowed|binary|uncommitted/)
		} finally { repo.close() }
	}
})
