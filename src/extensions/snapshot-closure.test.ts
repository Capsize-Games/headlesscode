import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import * as fs from "node:fs/promises"
import * as path from "node:path"

import { createMutationSnapshotBundle } from "../rsi/openshell.js"
import type { RsiConfig } from "../rsi/types.js"

const scratch = path.join(process.cwd(), ".headlesscode", "scratch")

async function testTrackedCapsulesReachSanitizedMutationBundleOnly(): Promise<void> {
	await fs.mkdir(scratch, { recursive: true })
	process.env.TMPDIR = scratch
	const ceilings = (process.env.GIT_CEILING_DIRECTORIES ?? "").split(path.delimiter).filter(Boolean)
	process.env.GIT_CEILING_DIRECTORIES = [...new Set([...ceilings, await fs.realpath(scratch)])].join(path.delimiter)
	const root = await fs.mkdtemp(path.join(scratch, "extension-snapshot-"))
	const clone = path.join(scratch, `extension-snapshot-clone-${process.pid}`)
	try {
		await fs.mkdir(path.join(root, ".agents/headlesscode/extensions/example-skill/" + "a".repeat(64)), { recursive: true })
		await fs.mkdir(path.join(root, "src/extensions"), { recursive: true })
		await fs.mkdir(path.join(root, "src/rsi"), { recursive: true })
		await fs.mkdir(path.join(root, "scripts/evaluator"), { recursive: true })
		await fs.mkdir(path.join(root, "__headlesscode_rsi_adversarial__"), { recursive: true })
		await fs.writeFile(path.join(root, ".agents/headlesscode/extensions/example-skill/" + "a".repeat(64), "manifest.json"), JSON.stringify({ schemaVersion: 1, id: "example-skill", kind: "skill", description: "Fixture skill" }))
		await fs.writeFile(path.join(root, ".agents/headlesscode/extensions/example-skill/" + "a".repeat(64), "SKILL.md"), "---\nname: example-skill\ndescription: Fixture skill\n---\nRead-only fixture guidance.\n")
		await fs.writeFile(path.join(root, "src/extensions/runtime.js"), "export const runtime = true\n")
		await fs.writeFile(path.join(root, "src/rsi/evaluator-secret.js"), "protected evaluator fixture\n")
		await fs.writeFile(path.join(root, "scripts/evaluator/private.js"), "protected evaluator fixture\n")
		await fs.writeFile(path.join(root, "__headlesscode_rsi_adversarial__/private.js"), "protected fixture\n")
		execFileSync("git", ["init", "--quiet"], { cwd: root })
		execFileSync("git", ["config", "user.name", "Fixture"], { cwd: root })
		execFileSync("git", ["config", "user.email", "fixture@example.invalid"], { cwd: root })
		execFileSync("git", ["add", "--all"], { cwd: root })
		execFileSync("git", ["commit", "--quiet", "-m", "fixture"], { cwd: root })
		const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim()
		const config: RsiConfig = {
			repoRoot: root,
			model: "fixture",
			population: 1,
			generations: 1,
			maxConcurrent: 1,
			mutationTask: "fixture task",
			regressionCommand: "true",
			evalCommands: [],
			hiddenEvalCommands: [],
			archiveDir: path.join(root, "archive"),
			worktreeDir: path.join(root, "worktrees"),
			baseRef: commit,
			seed: "fixture",
			dryRun: true,
			keepWorktrees: false,
			maxIterations: 1,
			protectedPaths: ["src/rsi/", "scripts/evaluator/", "__headlesscode_rsi_adversarial__/"] ,
			commandTimeoutMs: 1000,
		}
		const bundle = createMutationSnapshotBundle(root, commit, config)
		const bundlePath = path.join(scratch, `extension-snapshot-${process.pid}.bundle`)
		await fs.writeFile(bundlePath, bundle.content)
		try {
			execFileSync("git", ["clone", "--quiet", bundlePath, clone], { cwd: scratch })
			assert.equal(await fs.readFile(path.join(clone, ".agents/headlesscode/extensions/example-skill/" + "a".repeat(64), "SKILL.md"), "utf8"), "---\nname: example-skill\ndescription: Fixture skill\n---\nRead-only fixture guidance.\n")
			assert.equal(await fs.readFile(path.join(clone, "src/extensions/runtime.js"), "utf8"), "export const runtime = true\n")
			for (const forbidden of ["src/rsi/evaluator-secret.js", "scripts/evaluator/private.js", "__headlesscode_rsi_adversarial__/private.js"]) {
				await assert.rejects(fs.access(path.join(clone, forbidden)), { code: "ENOENT" }, `${forbidden} must remain outside the candidate snapshot`)
			}
		} finally {
			await fs.rm(bundlePath, { force: true })
		}
	} finally {
		await fs.rm(root, { recursive: true, force: true })
		await fs.rm(clone, { recursive: true, force: true })
	}
}

async function testRuntimeIsIncludedInPublishedPackageAndGuestSource(): Promise<void> {
	const packageJson = JSON.parse(await fs.readFile(path.join(process.cwd(), "package.json"), "utf8")) as { files: string[] }
	assert.ok(packageJson.files.includes("src/"), "published package includes runtime source")
	assert.ok(packageJson.files.includes("!src/**/__tests__/"))
	assert.ok(packageJson.files.includes("!src/**/*.test.ts"))
	const baseImage = await fs.readFile(path.join(process.cwd(), "docker/OpenShell.Dockerfile"), "utf8")
	const rsiImage = await fs.readFile(path.join(process.cwd(), "docker/OpenShell-RSI.Dockerfile"), "utf8")
	assert.match(baseImage, /COPY src \.\/src/)
	assert.match(rsiImage, /rm -rf \/opt\/headlesscode\/src\/rsi/)
	assert.match(rsiImage, /find \/opt\/headlesscode\/src -type d -name __tests__/)
}

await testTrackedCapsulesReachSanitizedMutationBundleOnly()
await testRuntimeIsIncludedInPublishedPackageAndGuestSource()
console.log("All extension snapshot closure tests passed")
