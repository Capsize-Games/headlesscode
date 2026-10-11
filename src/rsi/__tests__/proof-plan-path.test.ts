import assert from "node:assert/strict"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { execFileSync } from "node:child_process"
import test from "node:test"
import { assertSupervisorOnlyPlanPath, readProtectedProofInput } from "../../../scripts/rsi-proof-demonstration.js"

test("frozen plan paths are external or ignored supervisor-only paths and reject symlink parents", async (t) => {
	const repo = await fs.mkdtemp(path.join(os.tmpdir(), "rsi-plan-path-"))
	t.after(() => fs.rm(repo, { recursive: true, force: true }))
	execFileSync("git", ["init", "--quiet"], { cwd: repo })
	await fs.writeFile(path.join(repo, ".gitignore"), "/.headlesscode/\n")
	assert.equal(await assertSupervisorOnlyPlanPath(repo, path.join(repo, ".headlesscode/rsi-proof/plan.json")), path.join(repo, ".headlesscode/rsi-proof/plan.json"))
	assert.equal(await assertSupervisorOnlyPlanPath(repo, path.join(os.tmpdir(), "outside-plan.json")), path.join(os.tmpdir(), "outside-plan.json"))
	await assert.rejects(assertSupervisorOnlyPlanPath(repo, path.join(repo, "src/leaked-plan.json")), /outside the source repository or under ignored/)
	await fs.symlink(path.join(repo, "src"), path.join(repo, ".headlesscode"))
	await assert.rejects(assertSupervisorOnlyPlanPath(repo, path.join(repo, ".headlesscode/rsi-proof/plan.json")), /symlink/)
})

test("protected proof inputs reject symlink leaves, non-files, exposed modes, and oversized files", async (t) => {
	const repo = await fs.mkdtemp(path.join(os.tmpdir(), "rsi-proof-input-"))
	t.after(() => fs.rm(repo, { recursive: true, force: true }))
	execFileSync("git", ["init", "--quiet"], { cwd: repo })
	await fs.writeFile(path.join(repo, ".gitignore"), "/.headlesscode/\n")
	const directory = path.join(repo, ".headlesscode/rsi-proof")
	await fs.mkdir(directory, { recursive: true, mode: 0o700 })
	const input = path.join(directory, "plan.json")
	await fs.writeFile(input, '{"schemaVersion":1}\n', { mode: 0o600 })
	await fs.chmod(input, 0o600)
	assert.equal((await readProtectedProofInput(repo, input)).toString("utf8"), '{"schemaVersion":1}\n')

	const symlink = path.join(directory, "symlink.json")
	await fs.symlink(input, symlink)
	await assert.rejects(readProtectedProofInput(repo, symlink), /symlink/)
	const dangling = path.join(directory, "dangling.json")
	await fs.symlink(path.join(directory, "missing.json"), dangling)
	await assert.rejects(readProtectedProofInput(repo, dangling), /symlink|ENOENT/)
	const nonFile = path.join(directory, "directory-input")
	await fs.mkdir(nonFile, { mode: 0o700 })
	await assert.rejects(readProtectedProofInput(repo, nonFile), /regular file|EISDIR/)

	await fs.chmod(input, 0o640)
	await assert.rejects(readProtectedProofInput(repo, input), /accessible to group or other/)
	await fs.chmod(input, 0o600)
	const oversized = path.join(directory, "oversized.json")
	await fs.writeFile(oversized, "123456789", { mode: 0o600 })
	await fs.chmod(oversized, 0o600)
	await assert.rejects(readProtectedProofInput(repo, oversized, 8), /between 1 byte and 8 bytes/)

	const absentOutput = path.join(directory, "new-output.json")
	assert.equal(await assertSupervisorOnlyPlanPath(repo, absentOutput), absentOutput, "output validation continues to allow a not-yet-created leaf")
})
