/**
 * Tests for the `headlesscode projects` subcommand (src/projects/cli.ts):
 * `list` (table + --json + each filter flag + --size) and `prune`
 * (--dry-run changes nothing; default --yes removes only unregistered-missing
 * + no-project.json litter; --include-registered --yes also removes the
 * registered-but-missing entry).
 *
 * Plain assert-based script (no test framework), run via `npm test` ->
 * `tsx src/projects/__tests__/cli.test.ts`. Every test redirects the central
 * store to a temp dir via $HEADLESSCODE_DATA_DIR — never the real
 * ~/.local/share/headlesscode.
 */

import assert from "node:assert/strict"
import * as fs from "node:fs"
import * as fsp from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"

import { projectsMain } from "../cli.js"

async function mkTmp(prefix: string): Promise<string> {
	return fsp.mkdtemp(path.join(os.tmpdir(), prefix))
}

/** Capture the subcommand's stdout/stderr while calling projectsMain directly. */
async function runCli(argv: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
	const outChunks: string[] = []
	const errChunks: string[] = []
	const origOut = process.stdout.write.bind(process.stdout)
	const origErr = process.stderr.write.bind(process.stderr)
	process.stdout.write = ((chunk: string | Uint8Array) => {
		outChunks.push(String(chunk))
		return true
	}) as typeof process.stdout.write
	process.stderr.write = ((chunk: string | Uint8Array) => {
		errChunks.push(String(chunk))
		return true
	}) as typeof process.stderr.write
	try {
		const code = await projectsMain(argv)
		return { code, stdout: outChunks.join(""), stderr: errChunks.join("") }
	} finally {
		process.stdout.write = origOut
		process.stderr.write = origErr
	}
}

/** Hand-write a project.json into a store dir (fixture — not via writeProjectMetadata). */
function writeMeta(dir: string, meta: Record<string, unknown>): void {
	fs.mkdirSync(dir, { recursive: true })
	fs.writeFileSync(path.join(dir, "project.json"), JSON.stringify(meta, null, 2) + "\n", "utf-8")
}

/**
 * Build the fixture store: a registered+existing entry, an
 * unregistered+existing entry, a registered+missing-path entry, an
 * unregistered+missing-path entry, and a directory with no project.json at
 * all (pre-Part-A litter). Returns the real dirs that must be cleaned up.
 */
async function seedStore(data: string): Promise<{ existingA: string; existingB: string }> {
	const existingA = await mkTmp("hc-projects-existingA-")
	const existingB = await mkTmp("hc-projects-existingB-")
	const projects = path.join(data, "projects")
	writeMeta(path.join(projects, "aaaa"), {
		path: existingA,
		kind: "plain",
		firstSeen: "2026-08-01T00:00:00.000Z",
		lastSeen: "2026-08-17T10:00:00.000Z",
		registered: true,
	})
	writeMeta(path.join(projects, "bbbb"), {
		path: existingB,
		kind: "plain",
		firstSeen: "2026-08-02T00:00:00.000Z",
		lastSeen: "2026-08-17T09:00:00.000Z",
		registered: false,
	})
	writeMeta(path.join(projects, "cccc"), {
		path: path.join(data, "gone-registered"),
		kind: "git",
		firstSeen: "2026-08-03T00:00:00.000Z",
		lastSeen: "2026-08-16T00:00:00.000Z",
		registered: true,
	})
	writeMeta(path.join(projects, "dddd"), {
		path: path.join(data, "gone-unregistered"),
		kind: "git",
		firstSeen: "2026-08-04T00:00:00.000Z",
		lastSeen: "2026-08-15T00:00:00.000Z",
		registered: false,
	})
	// No project.json at all — the exact litter Part A stops producing.
	fs.mkdirSync(path.join(projects, "eeee"), { recursive: true })
	// A real file in aaaa so --size has something to measure.
	fs.writeFileSync(path.join(projects, "aaaa", "permissions.json"), "x".repeat(128), "utf-8")
	return { existingA, existingB }
}

async function testListTableAndJson(): Promise<void> {
	const data = await mkTmp("hc-projects-data-")
	const { existingA, existingB } = await seedStore(data)
	process.env.HEADLESSCODE_DATA_DIR = data
	try {
		// Every fixture path in this suite lives under a mkTmp()'d root (so
		// tests never touch the real store), which means the default clutter
		// filter would hide all 5 of them — exercise the full picture via
		// --all here; the default-hides-tmp-clutter behavior itself is
		// covered by testListDefaultHidesClutter below.
		const table = await runCli(["list", "--all"])
		assert.equal(table.code, 0, "list --all exits 0")
		for (const key of ["aaaa", "bbbb", "cccc", "dddd", "eeee"]) {
			assert.ok(table.stdout.includes(key), `table lists ${key}`)
		}
		assert.ok(table.stdout.includes("✓"), "registered marker shown")
		assert.ok(table.stdout.includes("·"), "unregistered marker shown")
		assert.ok(table.stdout.includes("ok"), "existing marker shown")
		assert.ok(table.stdout.includes("gone"), "missing-path marker shown")
		assert.match(table.stdout, /5 project\(s\): 2 registered, 3 with missing paths/, "summary line")

		const json = await runCli(["list", "--json"])
		assert.equal(json.code, 0, "--json exits 0")
		const parsed = JSON.parse(json.stdout) as Array<{
			key: string
			path?: string
			kind?: string
			firstSeen?: string
			lastSeen?: string
			registered: boolean
			exists: boolean
		}>
		assert.equal(parsed.length, 5, "--json lists every entry")
		// Sorted by lastSeen descending; the no-project.json entry sorts last.
		assert.deepEqual(
			parsed.map((e) => e.key),
			["aaaa", "bbbb", "cccc", "dddd", "eeee"],
			"entries sort by lastSeen desc, missing lastSeen last",
		)
		const aaaa = parsed.find((e) => e.key === "aaaa")
		assert.ok(aaaa && aaaa.registered === true && aaaa.exists === true && aaaa.path === existingA)
		const cccc = parsed.find((e) => e.key === "cccc")
		assert.ok(cccc && cccc.registered === true && cccc.exists === false)
		const eeee = parsed.find((e) => e.key === "eeee")
		assert.ok(eeee, "no-project.json dir is still listed")
		assert.equal(eeee.registered, false)
		assert.equal(eeee.exists, false)
		assert.equal(eeee.path, undefined, "no project.json → path undefined (omitted by JSON.stringify)")
		assert.equal(eeee.kind, undefined)
		assert.equal(eeee.lastSeen, undefined)
	} finally {
		delete process.env.HEADLESSCODE_DATA_DIR
		await fsp.rm(data, { recursive: true, force: true })
		await fsp.rm(existingA, { recursive: true, force: true })
		await fsp.rm(existingB, { recursive: true, force: true })
	}
}

async function testListFilters(): Promise<void> {
	const data = await mkTmp("hc-projects-data2-")
	const { existingA, existingB } = await seedStore(data)
	process.env.HEADLESSCODE_DATA_DIR = data
	try {
		const reg = await runCli(["list", "--registered-only", "--json"])
		assert.equal(reg.code, 0)
		const regParsed = JSON.parse(reg.stdout) as Array<{ key: string }>
		assert.deepEqual(regParsed.map((e) => e.key), ["aaaa", "cccc"], "--registered-only filters")

		const stale = await runCli(["list", "--stale", "--json"])
		assert.equal(stale.code, 0)
		const staleParsed = JSON.parse(stale.stdout) as Array<{ key: string }>
		assert.deepEqual(staleParsed.map((e) => e.key), ["cccc", "dddd", "eeee"], "--stale filters to missing paths")

		const both = await runCli(["list", "--registered-only", "--stale", "--json"])
		const bothParsed = JSON.parse(both.stdout) as Array<{ key: string }>
		assert.deepEqual(bothParsed.map((e) => e.key), ["cccc"], "filters compose")

		// SIZE is always shown in table mode now; --size is a no-op kept for
		// backward compatibility.
		const size = await runCli(["list", "--size"])
		assert.equal(size.code, 0)
		assert.ok(size.stdout.includes("SIZE"), "table mode includes a size column")

		const plain = await runCli(["list"])
		assert.equal(plain.code, 0)
		assert.ok(plain.stdout.includes("SIZE"), "size column shown by default, no flag required")
	} finally {
		delete process.env.HEADLESSCODE_DATA_DIR
		await fsp.rm(data, { recursive: true, force: true })
		await fsp.rm(existingA, { recursive: true, force: true })
		await fsp.rm(existingB, { recursive: true, force: true })
	}
}

async function testListDefaultHidesClutter(): Promise<void> {
	const data = await mkTmp("hc-projects-data-clutter-")
	const { existingA, existingB } = await seedStore(data)
	process.env.HEADLESSCODE_DATA_DIR = data
	try {
		// Every fixture entry has a /tmp-rooted path (or none at all, for
		// eeee) — the default view should hide all 5 and say so.
		const plain = await runCli(["list"])
		assert.equal(plain.code, 0)
		for (const key of ["aaaa", "bbbb", "cccc", "dddd", "eeee"]) {
			assert.ok(!plain.stdout.includes(key), `default view hides /tmp-clutter entry ${key}`)
		}
		assert.match(plain.stdout, /PROJECT\s+SIZE\s+PATH/, "default view uses the compact PROJECT/SIZE/PATH table")
		assert.match(plain.stdout, /5 .*hidden.*use --all/, "summary explains the hidden count + escape hatch")

		const all = await runCli(["list", "--all"])
		assert.equal(all.code, 0)
		for (const key of ["aaaa", "bbbb", "cccc", "dddd", "eeee"]) {
			assert.ok(all.stdout.includes(key), `--all shows ${key}`)
		}
		assert.ok(!all.stdout.includes("hidden"), "--all does not report a hidden count")
	} finally {
		delete process.env.HEADLESSCODE_DATA_DIR
		await fsp.rm(data, { recursive: true, force: true })
		await fsp.rm(existingA, { recursive: true, force: true })
		await fsp.rm(existingB, { recursive: true, force: true })
	}
}

async function testPruneDryRunChangesNothing(): Promise<void> {
	const data = await mkTmp("hc-projects-data3-")
	const { existingA, existingB } = await seedStore(data)
	process.env.HEADLESSCODE_DATA_DIR = data
	try {
		const dry = await runCli(["prune", "--dry-run"])
		assert.equal(dry.code, 0, "dry-run exits 0")
		assert.ok(dry.stdout.includes("dddd"), "dry-run lists the unregistered-missing candidate")
		assert.ok(dry.stdout.includes("eeee"), "dry-run lists the no-project.json candidate")
		assert.ok(!dry.stdout.includes("cccc"), "registered-but-missing is NOT a default candidate")
		assert.match(dry.stdout, /Total reclaimable/, "dry-run prints the reclaimable byte total")

		// Nothing was removed.
		for (const key of ["aaaa", "bbbb", "cccc", "dddd", "eeee"]) {
			assert.ok(fs.existsSync(path.join(data, "projects", key)), `dry-run leaves ${key} on disk`)
		}
	} finally {
		delete process.env.HEADLESSCODE_DATA_DIR
		await fsp.rm(data, { recursive: true, force: true })
		await fsp.rm(existingA, { recursive: true, force: true })
		await fsp.rm(existingB, { recursive: true, force: true })
	}
}

async function testPruneRequiresYesAndRemovesOnlyUnregisteredLitter(): Promise<void> {
	const data = await mkTmp("hc-projects-data4-")
	const { existingA, existingB } = await seedStore(data)
	process.env.HEADLESSCODE_DATA_DIR = data
	try {
		// Without --yes and without --dry-run: print candidates, exit 2, remove nothing.
		const noYes = await runCli(["prune"])
		assert.equal(noYes.code, 2, "prune without --yes exits 2")
		assert.match(noYes.stderr, /--yes/, "stderr tells the user to re-run with --yes")
		for (const key of ["aaaa", "bbbb", "cccc", "dddd", "eeee"]) {
			assert.ok(fs.existsSync(path.join(data, "projects", key)), "no-removal before --yes")
		}

		// With --yes: remove ONLY dddd (unregistered+missing) and eeee (no project.json).
		const yes = await runCli(["prune", "--yes"])
		assert.equal(yes.code, 0, "prune --yes exits 0")
		assert.ok(!fs.existsSync(path.join(data, "projects", "dddd")), "unregistered-missing removed")
		assert.ok(!fs.existsSync(path.join(data, "projects", "eeee")), "no-project.json litter removed")
		assert.ok(fs.existsSync(path.join(data, "projects", "cccc")), "registered-but-missing survives default prune")
		assert.ok(fs.existsSync(path.join(data, "projects", "aaaa")), "registered+existing survives")
		assert.ok(fs.existsSync(path.join(data, "projects", "bbbb")), "unregistered+existing survives")
	} finally {
		delete process.env.HEADLESSCODE_DATA_DIR
		await fsp.rm(data, { recursive: true, force: true })
		await fsp.rm(existingA, { recursive: true, force: true })
		await fsp.rm(existingB, { recursive: true, force: true })
	}
}

async function testPruneIncludeRegisteredRemovesRegisteredMissing(): Promise<void> {
	const data = await mkTmp("hc-projects-data5-")
	const { existingA, existingB } = await seedStore(data)
	process.env.HEADLESSCODE_DATA_DIR = data
	try {
		const yes = await runCli(["prune", "--include-registered", "--yes"])
		assert.equal(yes.code, 0)
		assert.ok(!fs.existsSync(path.join(data, "projects", "cccc")), "registered-but-missing removed with --include-registered")
		assert.ok(!fs.existsSync(path.join(data, "projects", "dddd")))
		assert.ok(!fs.existsSync(path.join(data, "projects", "eeee")))
		assert.ok(fs.existsSync(path.join(data, "projects", "aaaa")))
		assert.ok(fs.existsSync(path.join(data, "projects", "bbbb")))
	} finally {
		delete process.env.HEADLESSCODE_DATA_DIR
		await fsp.rm(data, { recursive: true, force: true })
		await fsp.rm(existingA, { recursive: true, force: true })
		await fsp.rm(existingB, { recursive: true, force: true })
	}
}

async function testHelpAndArgErrors(): Promise<void> {
	const data = await mkTmp("hc-projects-data6-")
	process.env.HEADLESSCODE_DATA_DIR = data
	try {
		const help = await runCli(["--help"])
		assert.equal(help.code, 0, "--help exits 0")
		assert.match(help.stdout, /projects list/, "usage mentions list")
		assert.match(help.stdout, /projects prune/, "usage mentions prune")

		const listHelp = await runCli(["list", "--help"])
		assert.equal(listHelp.code, 0, "list --help exits 0")

		const badSub = await runCli(["bogus"])
		assert.equal(badSub.code, 2, "unknown subcommand exits 2")
		assert.match(badSub.stderr, /Unknown subcommand/, "clear error for unknown subcommand")

		const badFlag = await runCli(["list", "--bogus"])
		assert.equal(badFlag.code, 2, "unknown flag exits 2")

		const crossFlag = await runCli(["prune", "--json"])
		assert.equal(crossFlag.code, 2, "a list-only flag on prune exits 2")
	} finally {
		delete process.env.HEADLESSCODE_DATA_DIR
		await fsp.rm(data, { recursive: true, force: true })
	}
}

const tests: Array<[string, () => Promise<void>]> = [
	["projects list: table + --json (sort, markers, summary, no-project.json entry)", testListTableAndJson],
	["projects list: --registered-only / --stale / composed / --size", testListFilters],
	["projects list: default view hides /tmp clutter, --all shows everything", testListDefaultHidesClutter],
	["projects prune --dry-run: candidates listed, nothing removed", testPruneDryRunChangesNothing],
	["projects prune: requires --yes, default removes only unregistered litter", testPruneRequiresYesAndRemovesOnlyUnregisteredLitter],
	["projects prune --include-registered --yes also removes registered-but-missing", testPruneIncludeRegisteredRemovesRegisteredMissing],
	["projects: --help and argument errors", testHelpAndArgErrors],
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
	console.log(`\nAll ${tests.length} projects CLI tests passed`)
}

main().catch((err) => {
	console.error("Test runner crashed:", err)
	process.exit(1)
})
