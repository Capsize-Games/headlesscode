import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { mutationSnapshotProtectedPathViolations, protectedPathReport, protectedPathViolations } from "../sandbox.js"

function testEvaluatorPathsAreProtected(): void {
	const files = ["src/rsi/fitness.ts", "scripts/eval-suite/check.sh", "src/engine/loop.ts"]
	const violations = protectedPathViolations(files, ["src/rsi/", "scripts/", "**/*.test.ts"])
	assert.deepEqual(violations, ["src/rsi/fitness.ts", "scripts/eval-suite/check.sh"])
	assert.equal(protectedPathReport(files, ["src/rsi/", "scripts/"]), "src/rsi/fitness.ts, scripts/eval-suite/check.sh")
}

function testNormalSourceChangeIsAllowed(): void {
	assert.deepEqual(protectedPathViolations(["src/engine/loop.ts"], ["src/rsi/", "scripts/"]), [])
}

function testMutationSnapshotHardProtectionsCannotBeRemovedByConfiguration(): void {
	const inheritedChanges = ["package.json", "package-lock.json", "docker/OpenShell-RSI.Dockerfile", ".dockerignore", "src/rsi/controller.ts", "fixtures/rsi-benchmark/manifest.json", "fixtures/sessions/imported-session.json", "fixtures/arbitrary/sample.json", "__rsi_benchmark_verifier__/verify.mjs"]
	assert.deepEqual(
		mutationSnapshotProtectedPathViolations(inheritedChanges, []),
		inheritedChanges,
		"content, deletion, and mode changes all appear as changed paths and remain protected even with an empty configured list",
	)
	assert.deepEqual(mutationSnapshotProtectedPathViolations(["src/engine/loop.ts"], []), [])
}

async function testProtectedParentDiffIncludesContentDeletionAndModeChanges(): Promise<void> {
	const repo = await fs.mkdtemp(path.join(os.tmpdir(), "hc-rsi-protected-parent-"))
	const git = (args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim()
	try {
		git(["init", "-q"])
		git(["config", "user.name", "RSI test"])
		git(["config", "user.email", "rsi-test@example.invalid"])
		await fs.mkdir(path.join(repo, "docker"), { recursive: true })
		await fs.mkdir(path.join(repo, "src", "engine"), { recursive: true })
		await fs.writeFile(path.join(repo, "package.json"), "{\"name\":\"base\"}\n")
		await fs.writeFile(path.join(repo, "package-lock.json"), "{}\n")
		await fs.writeFile(path.join(repo, "docker", "OpenShell-RSI.Dockerfile"), "FROM scratch\n", { mode: 0o644 })
		await fs.writeFile(path.join(repo, "src", "engine", "loop.ts"), "export const safe = true\n")
		git(["add", "."])
		git(["commit", "-qm", "base"])
		const base = git(["rev-parse", "HEAD"])
		await fs.writeFile(path.join(repo, "package.json"), "{\"name\":\"changed\"}\n")
		git(["add", "package.json"])
		git(["commit", "-qm", "change package metadata"])
		assert.deepEqual(mutationSnapshotProtectedPathViolations(git(["diff", "--name-only", "-z", "--no-renames", base, "HEAD"]).split("\0").filter(Boolean), []), ["package.json"])
		git(["reset", "--hard", base])
		await fs.rm(path.join(repo, "package-lock.json"))
		git(["add", "-u", "package-lock.json"])
		git(["commit", "-qm", "delete lockfile"])
		assert.deepEqual(mutationSnapshotProtectedPathViolations(git(["diff", "--name-only", "-z", "--no-renames", base, "HEAD"]).split("\0").filter(Boolean), []), ["package-lock.json"])
		git(["reset", "--hard", base])
		await fs.chmod(path.join(repo, "docker", "OpenShell-RSI.Dockerfile"), 0o755)
		git(["add", "docker/OpenShell-RSI.Dockerfile"])
		git(["commit", "-qm", "change docker recipe mode"])
		assert.deepEqual(mutationSnapshotProtectedPathViolations(git(["diff", "--name-only", "-z", "--no-renames", base, "HEAD"]).split("\0").filter(Boolean), []), ["docker/OpenShell-RSI.Dockerfile"])
	} finally {
		await fs.rm(repo, { recursive: true, force: true })
	}
}

testEvaluatorPathsAreProtected()
testNormalSourceChangeIsAllowed()
testMutationSnapshotHardProtectionsCannotBeRemovedByConfiguration()
await testProtectedParentDiffIncludesContentDeletionAndModeChanges()
console.log("All 4 RSI sandbox tests passed")
