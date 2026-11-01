import assert from "node:assert/strict"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { ensurePrivateRoot } from
	"../repository-curl-repair-v2-evidence-store.js"
import { runMain, type SuiteTest } from "../../test-runner.js"

async function createsAccumulatedPrivatePath(): Promise<void> {
	await withTemporaryHome(async (home) => {
		const nested = path.join(home, ".local", "state", "fleet-security-watch",
			"automation", "repository-campaign-evidence", "curl-92390-historical-v2")
		await ensurePrivateRoot(nested)
		const info = await fs.lstat(nested)
		assert.equal(info.mode & 0o777, 0o700)
		for (const name of ["state", "fleet-security-watch", "automation"]) {
			await assert.rejects(fs.lstat(path.join(home, name)), { code: "ENOENT" })
		}
	})
}

async function rejectsSymlinkParent(): Promise<void> {
	await withTemporaryHome(async (home) => {
		const outside = await fs.mkdtemp(path.join(os.tmpdir(), "curl-v2-outside-"))
		await fs.symlink(outside, path.join(home, ".local"))
		const nested = path.join(home, ".local", "state", "campaign-evidence")
		try {
			await assert.rejects(ensurePrivateRoot(nested), /not owner-private/)
			await assert.rejects(
				fs.lstat(path.join(outside, "state")), { code: "ENOENT" },
			)
		} finally {
			await fs.rm(outside, { recursive: true, force: true })
		}
	})
}

async function withTemporaryHome(
	run: (home: string) => Promise<void>,
): Promise<void> {
	const home = await fs.mkdtemp(path.join(os.tmpdir(), "curl-v2-home-"))
	const originalHome = process.env.HOME
	process.env.HOME = home
	try {
		await run(home)
	} finally {
		if (originalHome === undefined) delete process.env.HOME
		else process.env.HOME = originalHome
		await fs.rm(home, { recursive: true, force: true })
	}
}

const tests: readonly SuiteTest[] = [
	[
		"nested evidence paths are created below the selected home",
		createsAccumulatedPrivatePath,
	],
	[
		"a symlink parent is rejected before writing beneath its target",
		rejectsSymlinkParent,
	],
]

await runMain("repository-curl-repair-v2-evidence-store", tests)
