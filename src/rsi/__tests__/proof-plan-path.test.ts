import assert from "node:assert/strict"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { execFileSync } from "node:child_process"
import test from "node:test"
import { assertSupervisorOnlyPlanPath } from "../../../scripts/rsi-proof-demonstration.js"

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
