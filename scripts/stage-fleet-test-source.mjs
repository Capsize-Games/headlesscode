#!/usr/bin/env node
import { execFileSync } from "node:child_process"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

const privateRemote =
	/^git@github\.com:Capsize-Games\/fleet-security-watch\.git$|^https:\/\/github\.com\/Capsize-Games\/fleet-security-watch\.git$/

function requireConfig(name) {
	const value = process.env[name]?.trim()
	if (!value) throw new Error(`Required private CI variable ${name} is missing`)
	return value
}

function git(root, args) {
	return execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim()
}

function validateCheckout(root) {
	if (fs.lstatSync(root).isSymbolicLink()) {
		throw new Error("private Fleet source root must not be a symlink")
	}
	const remote = git(root, ["remote", "get-url", "origin"])
	if (!privateRemote.test(remote)) {
		throw new Error("Fleet checkout origin is not the owner-controlled private repository")
	}
}

function resolveCommit(root, ref) {
	const commit = git(root, ["rev-parse", "--verify", `${ref}^{commit}`])
	if (!/^[a-f0-9]{40,64}$/.test(commit)) {
		throw new Error("Fleet test ref did not resolve to an immutable commit")
	}
	return commit
}

function rejectSymlinks(root) {
	for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
		const entryPath = path.join(root, entry.name)
		if (entry.isSymbolicLink()) throw new Error("Fleet test archive contains a symlink")
		if (entry.isDirectory()) rejectSymlinks(entryPath)
	}
}

function writeCiEnvironment(sourceRoot) {
	const envFile = process.env.GITHUB_ENV
	if (!envFile) throw new Error("GITHUB_ENV is required for Fleet source staging")
	fs.appendFileSync(envFile, `FLEET_SECURITY_WATCH_TEST_ROOT=${sourceRoot}\n`)
}

function stageFleetTestSource() {
	const root = path.resolve(requireConfig("FLEET_SECURITY_WATCH_PRIVATE_ROOT"))
	const ref = requireConfig("FLEET_SECURITY_WATCH_TEST_REF")
	validateCheckout(root)
	const commit = resolveCommit(root, ref)
	const parent = process.env.RUNNER_TEMP ?? os.tmpdir()
	const stage = fs.mkdtempSync(path.join(parent, "fleet-test-source-"))
	const sourceRoot = path.join(stage, "source")
	const archive = path.join(stage, "source.tar")
	try {
		fs.mkdirSync(sourceRoot, { mode: 0o700 })
		execFileSync("git", ["-C", root, "archive", "--format=tar", "--output", archive, commit])
		execFileSync("tar", ["-xf", archive, "-C", sourceRoot])
		rejectSymlinks(sourceRoot)
		if (!fs.existsSync(path.join(sourceRoot, "operations/campaign_budget_bridge.py"))) {
			throw new Error("archived Fleet ref lacks the campaign budget bridge")
		}
		writeCiEnvironment(sourceRoot)
		process.stdout.write(`Staged Fleet test source at ${commit}\n`)
	} catch (error) {
		fs.rmSync(stage, { recursive: true, force: true })
		throw error
	}
}

try {
	stageFleetTestSource()
} catch (error) {
	process.stderr.write(`Fleet test source staging failed: ${error.message}\n`)
	process.exitCode = 1
}
