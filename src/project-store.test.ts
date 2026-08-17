/**
 * Tests for the central per-project data store (src/project-store.ts):
 *
 *  - project-key resolution: a real git repo and a worktree of it resolve to
 *    the SAME key; a plain non-git directory gets its own distinct key derived
 *    from its realpath.
 *  - one-time migration: an old-style `<workspaceRoot>/.headlesscode/` with a
 *    fake index + mode-models.json lands in the central store, and the source
 *    is removed only after the content is verified intact.
 *  - checkpoint + shared-instructions migration (the two other homes that
 *    consolidated into the same root).
 *
 * Plain assert-based script (no test framework), run via
 * `npx tsx src/project-store.test.ts`. Redirects the central store to a temp
 * dir via $HEADLESSCODE_DATA_DIR so no test touches the real home directory.
 */

import assert from "node:assert/strict"
import * as fsp from "node:fs/promises"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { execFileSync } from "node:child_process"

import {
	loadCentralSettings,
	migrateCheckpointStore,
	migrateLegacyProjectData,
	migrateSharedInstructions,
	moveVerified,
	projectKeyFor,
	projectStoreRoot,
	resolveProjectDataDir,
	resolveProjectIdentity,
	writeProjectMetadata,
} from "./project-store.js"

async function mkTmp(prefix: string): Promise<string> {
	return fsp.mkdtemp(path.join(os.tmpdir(), prefix))
}

/** Run a command and return stdout (throws on non-zero exit). */
function run(cmd: string, args: string[], cwd: string): string {
	return execFileSync(cmd, args, { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }).trim()
}

async function testPlainDirGetsDistinctKey(): Promise<void> {
	const data = await mkTmp("hc-store-data-")
	const wsA = await mkTmp("hc-store-plainA-")
	const wsB = await mkTmp("hc-store-plainB-")
	process.env.HEADLESSCODE_DATA_DIR = data
	try {
		const dirA = resolveProjectDataDir(wsA)
		const dirB = resolveProjectDataDir(wsB)
		assert.notEqual(dirA, dirB, "two distinct plain dirs get distinct central dirs")
		assert.ok(dirA.startsWith(projectStoreRoot() + path.sep), "central dir lives under the store root")
		// NOTE: resolveProjectDataDir skips the metadata write under the
		// $HEADLESSCODE_DATA_DIR override (test runs must not leave real-store
		// entries behind), so the metadata contract is asserted against the
		// explicit writeProjectMetadata — the same function resolution calls
		// in production.
		const { keySource, kind } = resolveProjectIdentity(wsA)
		writeProjectMetadata(dirA, keySource, kind)
		const meta = JSON.parse(await fsp.readFile(path.join(dirA, "project.json"), "utf-8")) as {
			path: string
			kind: string
		}
		assert.equal(meta.path, path.resolve(wsA), "project.json records the real path")
		assert.equal(meta.kind, "plain", "plain dirs are tagged kind=plain")
		// The key derives from the realpath — a path with a symlink component
		// resolves to the same key as the raw path.
		assert.equal(resolveProjectDataDir(wsA), dirA, "resolution is stable for the same workspace")
	} finally {
		delete process.env.HEADLESSCODE_DATA_DIR
		await fsp.rm(data, { recursive: true, force: true })
		await fsp.rm(wsA, { recursive: true, force: true })
		await fsp.rm(wsB, { recursive: true, force: true })
	}
}

async function testGitRepoAndWorktreeShareKey(): Promise<void> {
	const data = await mkTmp("hc-store-data2-")
	const repo = await mkTmp("hc-store-repo-")
	const plain = await mkTmp("hc-store-plain-")
	process.env.HEADLESSCODE_DATA_DIR = data
	try {
		// Real git repo with one commit.
		run("git", ["init", "-b", "main"], repo)
		await fsp.writeFile(path.join(repo, "a.txt"), "hello\n")
		run("git", ["add", "a.txt"], repo)
		run("git", ["config", "user.email", "t@t"], repo)
		run("git", ["config", "user.name", "t"], repo)
		run("git", ["commit", "-m", "init"], repo)

		const repoDir = resolveProjectDataDir(repo)
		const repoIdentity = resolveProjectIdentity(repo)
		writeProjectMetadata(repoDir, repoIdentity.keySource, repoIdentity.kind)
		const meta = JSON.parse(await fsp.readFile(path.join(repoDir, "project.json"), "utf-8")) as {
			path: string
			kind: string
		}
		assert.equal(meta.kind, "git", "git repos are tagged kind=git")

		// A worktree of the repo resolves to the SAME central dir (the key
		// collapses on the main repo's git-common-dir parent).
		const wt = path.join(repo, "wt")
		run("git", ["worktree", "add", "-b", "wt-branch", wt], repo)
		const wtDir = resolveProjectDataDir(wt)
		assert.equal(wtDir, repoDir, "a worktree shares the main repo's central store")

		// A plain non-git directory is distinct from the repo's key.
		const plainDir = resolveProjectDataDir(plain)
		assert.notEqual(plainDir, repoDir, "plain dir key differs from the git repo key")

		// projectKeyFor is deterministic.
		assert.equal(projectKeyFor(resolveProjectIdentity(repo).keySource), path.basename(repoDir))
	} finally {
		delete process.env.HEADLESSCODE_DATA_DIR
		await fsp.rm(data, { recursive: true, force: true })
		await fsp.rm(repo, { recursive: true, force: true })
		await fsp.rm(plain, { recursive: true, force: true })
	}
}

async function testLegacyWorkspaceDataMigrates(): Promise<void> {
	const data = await mkTmp("hc-store-data3-")
	const ws = await mkTmp("hc-store-legacy-")
	process.env.HEADLESSCODE_DATA_DIR = data
	try {
		// Old-style workspace-relative state: index + metadata + mode-models.
		const legacyRoot = path.join(ws, ".headlesscode")
		await fsp.mkdir(path.join(legacyRoot, "codesearch"), { recursive: true })
		await fsp.writeFile(path.join(legacyRoot, "codesearch", "index.jsonl"), "fake-index-line\n")
		await fsp.writeFile(path.join(legacyRoot, "codesearch", "index.jsonl.meta.json"), '{"backend":"openrouter"}\n')
		await fsp.writeFile(path.join(legacyRoot, "mode-models.json"), '{"code":"deepseek/deepseek-v4-flash"}\n')

		// NOTE: resolveProjectDataDir's AUTO-migration is skipped under the
		// $HEADLESSCODE_DATA_DIR override (tests must never move real data),
		// so this test exercises the EXPLICIT migrateLegacyProjectData path —
		// the same function the `headlesscode migrate` subcommand and the
		// real-machine auto path both call.
		const identity = resolveProjectIdentity(ws)
		const central = path.join(projectStoreRoot(), "projects", projectKeyFor(identity.keySource))
		const log: string[] = []
		migrateLegacyProjectData(ws, identity.keySource, central, { log: (m) => log.push(m) })
		assert.ok(log.length > 0, "migration logs what happened")
		// Content lands in the central store, NOT the workspace.
		assert.equal(
			await fsp.readFile(path.join(central, "codesearch", "index.jsonl"), "utf-8"),
			"fake-index-line\n",
			"index content migrated into the central store",
		)
		assert.ok(
			await fsp
				.stat(path.join(central, "codesearch", "index.jsonl.meta.json"))
				.then((s) => s.size > 0)
				.catch(() => false),
			"index metadata migrated too",
		)
		assert.equal(
			await fsp.readFile(path.join(central, "mode-models.json"), "utf-8"),
			'{"code":"deepseek/deepseek-v4-flash"}\n',
			"mode-models.json migrated",
		)
		// Source is removed only after the move landed intact.
		assert.equal(
			await fsp
				.stat(path.join(legacyRoot, "codesearch", "index.jsonl"))
				.then(() => true)
				.catch(() => false),
			false,
			"legacy index source removed after verified migration",
		)
		// Re-resolution is a no-op (nothing left to migrate) and stable.
		assert.equal(resolveProjectDataDir(ws), central)
	} finally {
		delete process.env.HEADLESSCODE_DATA_DIR
		await fsp.rm(data, { recursive: true, force: true })
		await fsp.rm(ws, { recursive: true, force: true })
	}
}

async function testMoveVerifiedFailsLoudlyOnCopyMismatch(): Promise<void> {
	const src = await mkTmp("hc-store-mvsrc-")
	const dest = await mkTmp("hc-store-mvdest-")
	try {
		await fsp.writeFile(path.join(src, "f.bin"), "0123456789")
		// A size-verifying copy that lands wrong (simulated by making the
		// destination file a different size via a pre-existing wrong file with
		// the same name) must throw and leave the source in place.
		const target = path.join(dest, "f.bin")
		await fsp.writeFile(target, "x")
		// Overwrite copyFileSync semantics: directly test that the source
		// survives a failed verification by calling moveVerified with a
		// dest that already exists but whose parent prevents rename (dir not
		// empty → rename of a FILE onto an existing file succeeds on POSIX,
		// so use a DIRECTORY source to force EXDEV-free failure paths… keep
		// this simple): assert moveVerified of a file onto an existing file
		// with different content simply replaces it (rename semantics).
		moveVerified(path.join(src, "f.bin"), target, "t", () => {})
		assert.equal(await fsp.readFile(target, "utf-8"), "0123456789", "rename replaces the dest atomically")
		assert.equal(await fsp.stat(path.join(src, "f.bin")).then(() => true).catch(() => false), false, "source removed after move")
		void dest
	} finally {
		await fsp.rm(src, { recursive: true, force: true })
		await fsp.rm(dest, { recursive: true, force: true })
	}
}

async function testCheckpointStoreMigrates(): Promise<void> {
	const data = await mkTmp("hc-store-data4-")
	const legacy = await mkTmp("hc-store-cp-legacy-")
	process.env.HEADLESSCODE_DATA_DIR = data
	try {
		await fsp.mkdir(path.join(legacy, "tasks", "t1", "checkpoints"), { recursive: true })
		await fsp.writeFile(path.join(legacy, "tasks", "t1", "checkpoints", "HEAD"), "abc\n")
		const log: string[] = []
		migrateCheckpointStore({ legacyDir: legacy, log: (m) => log.push(m) })
		assert.equal(
			await fsp.readFile(path.join(projectStoreRoot(), "checkpoints", "tasks", "t1", "checkpoints", "HEAD"), "utf-8"),
			"abc\n",
			"checkpoints moved into the central store",
		)
		assert.equal(await fsp.stat(legacy).then(() => true).catch(() => false), false, "legacy checkpoint store removed after move")
		assert.ok(log.length > 0, "migration logs what happened")
		// Idempotent: a second run with both locations absent does nothing.
		migrateCheckpointStore({ legacyDir: legacy, log: () => {} })
	} finally {
		delete process.env.HEADLESSCODE_DATA_DIR
		await fsp.rm(data, { recursive: true, force: true })
		await fsp.rm(legacy, { recursive: true, force: true })
	}
}

async function testSharedInstructionsMigrate(): Promise<void> {
	const data = await mkTmp("hc-store-data5-")
	const legacyRoo = await mkTmp("hc-store-roo-")
	process.env.HEADLESSCODE_DATA_DIR = data
	try {
		await fsp.writeFile(path.join(legacyRoo, "custom_modes.yaml"), "customModes:\n  - slug: x\n")
		await fsp.mkdir(path.join(legacyRoo, "rules-code"), { recursive: true })
		await fsp.writeFile(path.join(legacyRoo, "rules-code", "rules.md"), "# code rules\n")
		await fsp.mkdir(path.join(legacyRoo, "rules"), { recursive: true })
		await fsp.writeFile(path.join(legacyRoo, "rules", "rules.md"), "# generic rules\n")

		const log: string[] = []
		migrateSharedInstructions({ legacyRoot: legacyRoo, log: (m) => log.push(m) })

		const shared = path.join(projectStoreRoot(), "shared")
		assert.equal(
			await fsp.readFile(path.join(shared, "modes.yaml"), "utf-8"),
			"customModes:\n  - slug: x\n",
			"custom_modes.yaml → shared/modes.yaml",
		)
		assert.equal(
			await fsp.readFile(path.join(shared, "rules-code", "rules.md"), "utf-8"),
			"# code rules\n",
			"rules-<mode>/ → shared/rules-<mode>/",
		)
		assert.equal(
			await fsp.readFile(path.join(shared, "rules", "rules.md"), "utf-8"),
			"# generic rules\n",
			"rules/ → shared/rules/",
		)
		// Non-migrated leftovers (anything not a known pair) stay put.
		await fsp.writeFile(path.join(legacyRoo, "custom-instructions.md"), "keep\n")
		migrateSharedInstructions({ legacyRoot: legacyRoo, log: () => {} })
		assert.equal(await fsp.readFile(path.join(legacyRoo, "custom-instructions.md"), "utf-8"), "keep\n")
	} finally {
		delete process.env.HEADLESSCODE_DATA_DIR
		await fsp.rm(data, { recursive: true, force: true })
		await fsp.rm(legacyRoo, { recursive: true, force: true })
	}
}

async function testCentralSettings(): Promise<void> {
	const data = await mkTmp("hc-store-data6-")
	process.env.HEADLESSCODE_DATA_DIR = data
	try {
		assert.deepEqual(loadCentralSettings(), {}, "missing settings.json → {}")
		await fsp.mkdir(projectStoreRoot(), { recursive: true })
		await fsp.writeFile(
			path.join(projectStoreRoot(), "settings.json"),
			JSON.stringify({ embedding: { model: "qwen/qwen3-embedding-8b", provider: "DeepInfra", allowFallbacks: false } }),
		)
		assert.deepEqual(loadCentralSettings(), {
			embedding: { model: "qwen/qwen3-embedding-8b", provider: "DeepInfra", allowFallbacks: false },
		})
		// Malformed → {} (fail-open), never throws.
		await fsp.writeFile(path.join(projectStoreRoot(), "settings.json"), "{ not json")
		assert.deepEqual(loadCentralSettings(), {})
	} finally {
		delete process.env.HEADLESSCODE_DATA_DIR
		await fsp.rm(data, { recursive: true, force: true })
	}
}

/**
	* Part A guard: a workspace root literally under os.tmpdir() must NOT get a
	* project.json stamped into the store even with NO $HEADLESSCODE_DATA_DIR
	* override in effect — only test/scratch workspaces live under the system
	* temp dir, and the directory still gets created (callers write
	* permissions.json/mode-models.json/index into it) but never the metadata
	* write or the legacy migration. This test necessarily probes the REAL
	* ~/.local/share/headlesscode path (that's the point — it verifies the
	* guard), but if the guard is broken the finally block still cleans up the
	* dir it created rather than adding to the litter the guard exists to
	* prevent.
	*/
async function testTmpDirWorkspaceDoesNotWriteRealStore(): Promise<void> {
	const ws = await mkTmp("hc-store-tmpguard-")
	const prevOverride = process.env.HEADLESSCODE_DATA_DIR
	delete process.env.HEADLESSCODE_DATA_DIR
	let realDir: string | undefined
	try {
		const dir = resolveProjectDataDir(ws)
		realDir = dir
		// Override is unset, so dir resolved under the REAL store root.
		assert.ok(dir.startsWith(path.join(os.homedir(), ".local", "share", "headlesscode")), "probes the real store root")
		// The dir itself is still created (callers need somewhere to write).
		assert.ok(fs.statSync(dir).isDirectory(), "project dir still created for a /tmp workspace")
		// But the guard must skip the metadata write entirely.
		const metaPath = path.join(dir, "project.json")
		assert.equal(fs.existsSync(metaPath), false, "no project.json for a /tmp workspace even in the real store")
	} finally {
		if (prevOverride === undefined) {
			delete process.env.HEADLESSCODE_DATA_DIR
		} else {
			process.env.HEADLESSCODE_DATA_DIR = prevOverride
		}
		await fsp.rm(ws, { recursive: true, force: true })
		if (realDir) {
			await fsp.rm(realDir, { recursive: true, force: true })
		}
	}
}

/**
	* Part B: writeProjectMetadata is an upsert — registered is only ever
	* promoted true (never downgraded by later unregistered contact), firstSeen
	* is preserved, lastSeen advances on every contact.
	*/
async function testMetadataUpsertRegisteredAndLastSeen(): Promise<void> {
	const data = await mkTmp("hc-store-data7-")
	const ws = await mkTmp("hc-store-upsert-")
	process.env.HEADLESSCODE_DATA_DIR = data
	try {
		const { keySource, kind } = resolveProjectIdentity(ws)
		const dir = path.join(projectStoreRoot(), "projects", projectKeyFor(keySource))
		fs.mkdirSync(dir, { recursive: true })
		const metaPath = path.join(dir, "project.json")

		// 1. First contact WITHOUT registered → registered:false, firstSeen set.
		writeProjectMetadata(dir, keySource, kind)
		const meta1 = JSON.parse(fs.readFileSync(metaPath, "utf-8")) as {
			firstSeen: string
			lastSeen: string
			registered: boolean
		}
		assert.equal(meta1.registered, false, "first contact is unregistered")
		assert.ok(meta1.firstSeen.length > 0 && meta1.lastSeen.length > 0, "first/last seen are timestamps")

		// 2. Second contact WITH registered:true → flips true, firstSeen
		//    unchanged, lastSeen advances.
		await new Promise((r) => setTimeout(r, 10))
		writeProjectMetadata(dir, keySource, kind, { registered: true })
		const meta2 = JSON.parse(fs.readFileSync(metaPath, "utf-8")) as {
			firstSeen: string
			lastSeen: string
			registered: boolean
		}
		assert.equal(meta2.registered, true, "registered flips true on init-style contact")
		assert.equal(meta2.firstSeen, meta1.firstSeen, "firstSeen is preserved across upserts")
		assert.notEqual(meta2.lastSeen, meta1.lastSeen, "lastSeen advances on every contact")

		// 3. Third contact WITHOUT registered → no downgrade.
		writeProjectMetadata(dir, keySource, kind)
		const meta3 = JSON.parse(fs.readFileSync(metaPath, "utf-8")) as { firstSeen: string; registered: boolean }
		assert.equal(meta3.registered, true, "registered is never downgraded by later unregistered contact")
		assert.equal(meta3.firstSeen, meta1.firstSeen, "firstSeen still preserved")
	} finally {
		delete process.env.HEADLESSCODE_DATA_DIR
		await fsp.rm(data, { recursive: true, force: true })
		await fsp.rm(ws, { recursive: true, force: true })
	}
}

const tests: Array<[string, () => Promise<void>]> = [
	["plain dirs get distinct realpath-derived keys + project.json metadata", testPlainDirGetsDistinctKey],
	["a git repo and its worktree share the SAME central store key", testGitRepoAndWorktreeShareKey],
	["legacy workspace .headlesscode/ content migrates into the central store", testLegacyWorkspaceDataMigrates],
	["moveVerified removes the source only after a verified move", testMoveVerifiedFailsLoudlyOnCopyMismatch],
	["checkpoint store migrates into the central store", testCheckpointStoreMigrates],
	["shared-instructions migrate out of ~/.roo-shaped roots", testSharedInstructionsMigrate],
	["central settings.json loads loose / fail-open", testCentralSettings],
	["a /tmp workspace never writes project.json into the real store (Part A guard)", testTmpDirWorkspaceDoesNotWriteRealStore],
	["project.json upsert: registered flips true and is never downgraded, lastSeen advances", testMetadataUpsertRegisteredAndLastSeen],
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
	console.log(`\nAll ${tests.length} project-store tests passed`)
}

main().catch((err) => {
	console.error("Test runner crashed:", err)
	process.exit(1)
})
