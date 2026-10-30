import assert from "node:assert/strict"
import { execFileSync, spawnSync } from "node:child_process"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { test } from "node:test"

const helper = new URL("./stage-fleet-test-source.mjs", import.meta.url)
const remote = "git@github.com:Capsize-Games/fleet-security-watch.git"

function git(root, ...args) {
	return execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim()
}

function checkout(root) {
	fs.mkdirSync(root)
	git(root, "init", "-q")
	git(root, "config", "user.name", "Fixture")
	git(root, "config", "user.email", "fixture@example.invalid")
	git(root, "remote", "add", "origin", remote)
	const bridge = path.join(root, "operations")
	fs.mkdirSync(bridge)
	fs.writeFileSync(path.join(bridge, "campaign_budget_bridge.py"), "pinned\n")
	git(root, "add", ".")
	git(root, "commit", "-qm", "fixture")
	return git(root, "rev-parse", "HEAD")
}

function run(root, ref, temp) {
	const envFile = path.join(temp, "github-env")
	fs.writeFileSync(envFile, "")
	return spawnSync(process.execPath, [helper.pathname], {
		encoding: "utf8",
		env: {
			...process.env,
			FLEET_SECURITY_WATCH_PRIVATE_ROOT: root,
			FLEET_SECURITY_WATCH_TEST_REF: ref,
			GITHUB_ENV: envFile,
			RUNNER_TEMP: temp,
		},
	})
}

test("stages the configured commit and ignores dirty checkout files", () => {
	const temp = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-stage-test-"))
	try {
		const root = path.join(temp, "checkout")
		const commit = checkout(root)
		fs.writeFileSync(path.join(root, "operations/campaign_budget_bridge.py"), "dirty\n")
		const result = run(root, commit, temp)
		assert.equal(result.status, 0, result.stderr)
		const staged = fs.readFileSync(path.join(temp, "github-env"), "utf8")
		const sourceRoot = staged.trim().split("=").at(-1)
		assert.equal(
			fs.readFileSync(path.join(sourceRoot, "operations/campaign_budget_bridge.py"), "utf8"),
			"pinned\n",
		)
	} finally {
		fs.rmSync(temp, { recursive: true, force: true })
	}
})

test("fails clearly when required configuration or commit is unavailable", () => {
	const temp = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-stage-invalid-"))
	try {
		const root = path.join(temp, "checkout")
		checkout(root)
		const missing = run(root, "", temp)
		assert.notEqual(missing.status, 0)
		assert.match(missing.stderr, /FLEET_SECURITY_WATCH_TEST_REF is missing/)
		const invalid = run(root, "missing-ref", temp)
		assert.notEqual(invalid.status, 0)
		assert.match(invalid.stderr, /staging failed/)
	} finally {
		fs.rmSync(temp, { recursive: true, force: true })
	}
})

test("rejects a symlinked private source checkout", () => {
	const temp = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-stage-symlink-"))
	try {
		const root = path.join(temp, "checkout")
		const commit = checkout(root)
		const link = path.join(temp, "checkout-link")
		fs.symlinkSync(root, link, "dir")
		const result = run(link, commit, temp)
		assert.notEqual(result.status, 0)
		assert.match(result.stderr, /must not be a symlink/)
	} finally {
		fs.rmSync(temp, { recursive: true, force: true })
	}
})
