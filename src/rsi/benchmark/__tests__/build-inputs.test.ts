import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { assertImageBuildInputsUnchanged, changedImageBuildInputs } from "../build-inputs.js"

const root = await fs.mkdtemp(path.join(os.tmpdir(), "rsi-build-inputs-"))
const git = (args: string[]) => execFileSync("git", args, { cwd: root, stdio: "ignore" })
try {
	git(["init", "--quiet", "--initial-branch=main"])
	git(["config", "user.name", "RSI build input test"])
	git(["config", "user.email", "rsi-build-inputs@invalid.example"])
	await fs.writeFile(path.join(root, "package.json"), JSON.stringify({ scripts: { prepare: "safe" } }) + "\n")
	await fs.writeFile(path.join(root, "package-lock.json"), "{}\n")
	await fs.mkdir(path.join(root, "src"), { recursive: true })
	await fs.writeFile(path.join(root, "src", "value.ts"), "export const value = 1\n")
	git(["add", "--all"])
	git(["commit", "--quiet", "-m", "baseline"])
	const base = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim()

	await fs.writeFile(path.join(root, "src", "value.ts"), "export const value = 2\n")
	git(["add", "--all"])
	git(["commit", "--quiet", "-m", "source-only candidate"])
	const sourceCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim()
	assert.deepEqual(changedImageBuildInputs(root, sourceCommit, base), [])
	assert.doesNotThrow(() => assertImageBuildInputsUnchanged(root, sourceCommit, base))

	await fs.writeFile(path.join(root, "package.json"), JSON.stringify({ scripts: { prepare: "candidate-code" } }) + "\n")
	git(["add", "--all"])
	git(["commit", "--quiet", "-m", "candidate changes package script"])
	const unsafeCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim()
	assert.deepEqual(changedImageBuildInputs(root, unsafeCommit, base), ["package.json"])
	assert.throws(() => assertImageBuildInputsUnchanged(root, unsafeCommit, base), /protected image build inputs: package\.json/)
	await fs.writeFile(path.join(root, "src", "value.ts"), "export const value = 3\n")
	git(["add", "--all"])
	git(["commit", "--quiet", "-m", "source-only child inherits package change"])
	const inheritedCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim()
	assert.deepEqual(changedImageBuildInputs(root, inheritedCommit, base), ["package.json"])
	assert.throws(() => assertImageBuildInputsUnchanged(root, inheritedCommit, base), /protected image build inputs: package\.json/)

	await fs.mkdir(path.join(root, "docker"), { recursive: true })
	await fs.writeFile(path.join(root, "docker", "Dockerfile"), "FROM scratch\n")
	git(["add", "--all"])
	git(["commit", "--quiet", "-m", "candidate changes docker recipe"])
	const dockerCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim()
	assert.match(changedImageBuildInputs(root, dockerCommit, base).join(" "), /docker\/Dockerfile/)
	assert.throws(() => assertImageBuildInputsUnchanged(root, dockerCommit, base), /protected image build inputs/)

	git(["checkout", "--quiet", "--orphan", "unrelated"])
	await fs.rm(path.join(root, "package.json"), { force: true })
	await fs.rm(path.join(root, "package-lock.json"), { force: true })
	await fs.rm(path.join(root, "src"), { recursive: true, force: true })
	await fs.writeFile(path.join(root, "unrelated.txt"), "separate history\n")
	git(["add", "--all"])
	git(["commit", "--quiet", "-m", "unrelated history"])
	const unrelatedCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim()
	assert.throws(() => assertImageBuildInputsUnchanged(root, unrelatedCommit, base), /not descended from supervisor base/)
	console.log("Benchmark image builder rejects candidate package and Docker build inputs")
} finally {
	await fs.rm(root, { recursive: true, force: true })
}
