import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { fileURLToPath } from "node:url"

const root = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)), "../../..")
const home = fs.mkdtempSync(path.join(os.tmpdir(), "hcl-v2-cli-home-"))
try {
	const tsx = path.join(root, "node_modules/tsx/dist/cli.mjs")
	const result = spawnSync(process.execPath,
		[tsx, path.join(root, "src/cli.ts"), "campaign",
			"repair-known-v2", "curl-historical-repair-v2",
			"CVE-2026-92390", "--purpose=repair"], {
			cwd: root, encoding: "utf8",
			env: { ...process.env, HOME: home }, timeout: 30_000,
		})
	assert.equal(result.status, 1, `stderr=${result.stderr}`)
	assert.equal(result.stdout, "")
	assert.match(result.stderr, /v2 repair profile is not owner-registered/)
	assert.equal(
		fs.existsSync(path.join(home, ".local/share/headlesscode/campaign-control")),
		false, "missing owner registration fails before creating control state")
	const invalidRetry = spawnSync(process.execPath,
		[tsx, path.join(root, "src/cli.ts"), "campaign",
			"retry-repair", "curl-historical-repair", "invalid-id",
			"--confirm-retry-repair=invalid-id"], {
			cwd: root, encoding: "utf8",
			env: { ...process.env, HOME: home }, timeout: 30_000,
		})
	assert.equal(invalidRetry.status, 2,
		"retry rejects a malformed job id before reading campaign state")
	assert.equal(invalidRetry.stdout, "")
} finally {
	fs.rmSync(home, { recursive: true, force: true })
}
process.stdout.write("repair-known-v2 CLI prerequisite guard passed\n")
