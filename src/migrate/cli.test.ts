/**
 * Tests for the `headlesscode migrate` subcommand (src/migrate/cli.ts): the
 * explicit, human-triggerable version of the central-store migrations. Under a
 * $HEADLESSCODE_DATA_DIR override the global (real-home-data) steps are
 * skipped, so the test exercises the workspace-legacy-data step safely.
 */

import assert from "node:assert/strict"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"

import { migrateMain } from "./cli.js"
import { projectStoreRoot, resolveProjectDataDir } from "../project-store.js"

async function mkTmp(prefix: string): Promise<string> {
	return fs.mkdtemp(path.join(os.tmpdir(), prefix))
}

async function testMigrateMovesWorkspaceLegacyData(): Promise<void> {
	const data = await mkTmp("hc-migrate-data-")
	const ws = await mkTmp("hc-migrate-ws-")
	process.env.HEADLESSCODE_DATA_DIR = data
	try {
		await fs.mkdir(path.join(ws, ".headlesscode", "codesearch"), { recursive: true })
		await fs.writeFile(path.join(ws, ".headlesscode", "codesearch", "index.jsonl"), "legacy\n")
		await fs.writeFile(path.join(ws, ".headlesscode", "mode-models.json"), '{"_default":"x"}\n')

		const code = await migrateMain(["--workspace", ws])
		assert.equal(code, 0, "migrate exits 0 on success")

		const central = resolveProjectDataDir(ws)
		assert.equal(
			await fs.readFile(path.join(central, "codesearch", "index.jsonl"), "utf-8"),
			"legacy\n",
			"index lands in the central store",
		)
		assert.equal(
			await fs.readFile(path.join(central, "mode-models.json"), "utf-8"),
			'{"_default":"x"}\n',
			"mode-models.json lands in the central store",
		)
		assert.equal(
			await fs.stat(path.join(ws, ".headlesscode", "codesearch", "index.jsonl")).then(() => true).catch(() => false),
			false,
			"legacy source removed after verified move",
		)
	} finally {
		delete process.env.HEADLESSCODE_DATA_DIR
		await fs.rm(data, { recursive: true, force: true })
		await fs.rm(ws, { recursive: true, force: true })
	}
}

async function testMigrateHelp(): Promise<void> {
	const data = await mkTmp("hc-migrate-help-")
	// The no-args call resolves workspace = process.cwd() and writes the
	// project-dir metadata — must land in the tmp store, never the real
	// ~/.local/share/headlesscode (the earlier test's finally deletes the
	// suite-wide override, so this test sets its own).
	process.env.HEADLESSCODE_DATA_DIR = data
	try {
		assert.equal(await migrateMain(["--help"]), 0, "--help exits 0")
		assert.equal(await migrateMain([]), 0, "no args exits 0 (workspace = cwd, no-op when nothing to migrate)")
		assert.equal(await migrateMain(["--bogus"]), 2, "unknown arg exits 2")
	} finally {
		delete process.env.HEADLESSCODE_DATA_DIR
		await fs.rm(data, { recursive: true, force: true })
	}
}

async function testMigrateUsesStoreRoot(): Promise<void> {
	const data = await mkTmp("hc-migrate-data2-")
	process.env.HEADLESSCODE_DATA_DIR = data
	try {
		assert.equal(projectStoreRoot(), path.resolve(data), "store root respects the override")
	} finally {
		delete process.env.HEADLESSCODE_DATA_DIR
		await fs.rm(data, { recursive: true, force: true })
	}
}

const tests: Array<[string, () => Promise<void>]> = [
	["migrate --workspace moves legacy .headlesscode/ into the central store", testMigrateMovesWorkspaceLegacyData],
	["migrate --help / no-op / bad-arg exit codes", testMigrateHelp],
	["migrate respects the store-root override", testMigrateUsesStoreRoot],
]

async function main(): Promise<void> {
	let failed = 0
	for (const [name, fn] of tests) {
		try {
			await fn()
			console.log(`  ok   ${name}`)
		} catch (err) {
			failed++
			console.error(`  FAIL ${name}`)
			console.error(err instanceof Error ? err.stack ?? err.message : String(err))
		}
	}
	if (failed > 0) {
		console.error(`\n${failed} test(s) failed`)
		process.exit(1)
	}
	console.log(`\nAll ${tests.length} migrate CLI tests passed`)
}

main().catch((err) => {
	console.error("Test runner crashed:", err)
	process.exit(1)
})
