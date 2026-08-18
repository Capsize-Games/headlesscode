/**
 * Tests for the default-on central-store protection
 * (src/permissions/store-protection.ts) — the always-applied guard against
 * recursive `rm` commands whose resolved target is the shared central store
 * (or a parent of it).
 *
 * This is the regression suite for the real incident in
 * plans/protect-shared-store-from-destructive-commands.md: a worker ran
 * `rm -rf ~/.local/share/headlesscode` against the REAL store three times.
 *
 * SAFETY: every test in this file only PARSES command strings and compares
 * resolved paths — `checkCommand`/`decideCommand` never execute anything, so
 * the incident test can safely run against the REAL (default) store root
 * without a $HEADLESSCODE_DATA_DIR override. The mechanism tests use a
 * throwaway tmp store under an override, exactly as the plan mandates.
 *
 * Plain assert-based script (no test framework), run via `npm test` ->
 * `tsx src/permissions/__tests__/store-protection.test.ts`.
 */

import assert from "node:assert/strict"
import * as fsp from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"

import { checkCommand, decideCommand } from "../commands.js"
import {
	checkCentralStoreDestruction,
	expandEnv,
	expandHome,
	isCentralStoreOrParent,
	resolveCommandTarget,
	splitCommandWords,
} from "../store-protection.js"
import {
	migrateLegacyProjectData,
	projectStoreRoot,
	resolveProjectDataDir,
	resolveProjectIdentity,
	writeProjectMetadata,
} from "../../project-store.js"

async function mkTmp(prefix: string): Promise<string> {
	return fsp.mkdtemp(path.join(os.tmpdir(), prefix))
}

/** Save/restore an env var around an (async) test body. */
async function withEnv(name: string, value: string | undefined, fn: () => Promise<void> | void): Promise<void> {
	const saved = process.env[name]
	try {
		if (value === undefined) {
			delete process.env[name]
		} else {
			process.env[name] = value
		}
		await fn()
	} finally {
		if (saved === undefined) {
			delete process.env[name]
		} else {
			process.env[name] = saved
		}
	}
}

// ─── (a) THE regression: the exact incident commands, zero config ────────────

async function testIncidentRefusedWithZeroConfig(): Promise<void> {
	// The exact scenario that failed tonight: NO $HEADLESSCODE_DATA_DIR override
	// and NO permissions config — the store root is the real
	// ~/.local/share/headlesscode and the check must refuse before anything
	// runs. Nothing here executes a command (checkCommand only parses and
	// compares path strings), so resolving against the real default store root
	// is safe.
	await withEnv("HEADLESSCODE_DATA_DIR", undefined, async () => {
		// Align $HOME expansion with os.homedir() — the basis the default store
		// root is computed from — so the $HOME variants match deterministically.
		await withEnv("HOME", os.homedir(), () => {
			const storeRoot = projectStoreRoot()
			assert.equal(storeRoot, path.join(os.homedir(), ".local", "share", "headlesscode"))

			const variants = [
				"rm -rf ~/.local/share/headlesscode", // the exact incident command
				"rm -rf ~/.local/share/headlesscode/", // trailing slash
				"rm -fr ~/.local/share/headlesscode", // flag order swapped
				"rm -r ~/.local/share/headlesscode", // recursive without -f
				"rm -Rf ~/.local/share/headlesscode", // traditional -R spelling
				"rm -rf $HOME/.local/share/headlesscode", // env-var expansion
				"rm -rf ${HOME}/.local/share/headlesscode", // braced env-var expansion
				"rm -rf ~/.local/share/headlesscode/*", // "delete the contents" idiom
				`rm -rf "${storeRoot}"`, // double-quoted absolute path
				`rm -rf '${storeRoot}'`, // single-quoted absolute path
				"rm -rf -- ~/.local/share/headlesscode", // end-of-options marker
				// Parents of the store are refused too (containment rule):
				"rm -rf ~/.local/share",
				"rm -rf ~/.local",
				"rm -rf ~",
				"rm -rf /",
			]
			for (const cmd of variants) {
				const refusal = checkCommand(cmd, [], [])
				assert.ok(refusal !== null, `${cmd}: must be refused with ZERO permissions config`)
				assert.equal(refusal.kind, "protected_store", `${cmd}: refusal kind must be protected_store`)
				assert.equal(refusal.storeRoot, storeRoot, `${cmd}: refusal names the real store root`)
				assert.equal(decideCommand(cmd, [], []), "deny", `${cmd}: decideCommand denies with zero config`)
			}

			// Compound: a store-targeting sub-command blocks the whole chain.
			const compound = checkCommand("echo hi && rm -rf ~/.local/share/headlesscode", [], [])
			assert.ok(compound !== null, "compound chain with a store rm is refused")
			assert.equal(compound.kind, "protected_store", "compound refusal kind is protected_store")
			assert.equal(compound.subCommand, "rm -rf ~/.local/share/headlesscode", "refusal names the offending sub-command")
			assert.equal(compound.target, storeRoot, "refusal reports the resolved store target")
		})
	})
}

// ─── (b) mechanism against a throwaway tmp store (controlled env) ───────────

async function testMechanismAgainstTmpStore(): Promise<void> {
	const tmp = await mkTmp("hc-store-protect-mech-")
	const storeRoot = path.join(tmp, "central-store")
	const workspace = path.join(tmp, "workspace")
	await fsp.mkdir(workspace, { recursive: true })
	await withEnv("HEADLESSCODE_DATA_DIR", storeRoot, () => {
		assert.equal(projectStoreRoot(), storeRoot)

			// Refused: absolute targets, trailing slash, flag permutations,
			// quoting, env-var expansion, parent-of-store.
			const refused = [
				`rm -rf ${storeRoot}`,
				`rm -rf ${storeRoot}/`,
				`rm -fr ${storeRoot}`,
				`rm -r ${storeRoot}`,
				`rm -Rf ${storeRoot}`,
				`rm --recursive --force ${storeRoot}`,
				`rm -rf -- ${storeRoot}`,
				`rm -rf "${storeRoot}"`,
				`rm -rf '${storeRoot}'`,
				`rm -rf ${storeRoot}/*`,
				`rm -rf $HEADLESSCODE_DATA_DIR`,
				"rm -rf ${HEADLESSCODE_DATA_DIR}",
				`rm -rf ${tmp}`, // tmp is a parent of the store
				`rm -rf ${tmp}/`, // parent, trailing slash
				`rm -rf ${tmp}/..`, // normalizes to /tmp — still a parent
				"rm -rf ../central-store", // relative target that climbs out of the workspace into the store
			]
			for (const cmd of refused) {
				const refusal = checkCommand(cmd, [], [], { workspaceRoot: workspace })
				assert.ok(refusal !== null, `${cmd}: must be refused against the tmp store`)
				assert.equal(refusal.kind, "protected_store", `${cmd}: refusal kind`)
			}

			// NOT refused: workspace-internal cleanup and non-destructive access.
			const allowed = [
				"rm -rf ./tmp-scratch",
				"rm -rf tmp-scratch",
				`rm -rf ${path.join(workspace, "tmp-scratch")}`,
				"rm -rf ../workspace", // resolves to the workspace, not the store
				"rm -rf .",
				`echo ${storeRoot}`,
				`ls ${storeRoot}`,
			]
			for (const cmd of allowed) {
				assert.equal(checkCommand(cmd, [], [], { workspaceRoot: workspace }), null, `${cmd}: must NOT be refused`)
			}
	})
	await fsp.rm(tmp, { recursive: true, force: true })
}

// ─── (b2) SEC-6: descendants, symlinks, and cd-chains ───────────────────────

async function testSec6DescendantsSymlinksCdChains(): Promise<void> {
	const tmp = await mkTmp("hc-store-protect-sec6-")
	const storeRoot = path.join(tmp, "central-store")
	const workspace = path.join(tmp, "workspace")
	await fsp.mkdir(path.join(storeRoot, "projects", "foo"), { recursive: true })
	await fsp.mkdir(workspace, { recursive: true })
	await withEnv("HEADLESSCODE_DATA_DIR", storeRoot, async () => {
		assert.equal(projectStoreRoot(), storeRoot)

		// Descendant of the store is now refused (previously out of scope).
		const descendantRefusal = checkCommand(`rm -rf ${storeRoot}/projects`, [], [], { workspaceRoot: workspace })
		assert.ok(descendantRefusal !== null, "rm -rf <store>/projects must be refused")
		assert.equal(descendantRefusal?.kind, "protected_store")

		const nestedRefusal = checkCommand(`rm -rf ${path.join(storeRoot, "projects", "foo")}`, [], [], {
			workspaceRoot: workspace,
		})
		assert.ok(nestedRefusal !== null, "rm -rf <store>/projects/foo must be refused")

		// Symlink into the store is followed and refused.
		const link = path.join(tmp, "store-link")
		await fsp.symlink(storeRoot, link, "dir")
		const symlinkRefusal = checkCommand(`rm -rf ${link}`, [], [], { workspaceRoot: workspace })
		assert.ok(symlinkRefusal !== null, "rm -rf through a symlink to the store must be refused")
		assert.equal(symlinkRefusal?.kind, "protected_store")

		// cd-chain: a relative target resolves against the post-cd cwd, not the
		// pre-cd workspaceRoot.
		const cdChainRefusal = checkCommand(`cd ${tmp} && rm -rf central-store`, [], [], { workspaceRoot: workspace })
		assert.ok(cdChainRefusal !== null, "cd <tmp> && rm -rf central-store must resolve against the post-cd cwd")
		assert.equal(cdChainRefusal?.kind, "protected_store")

		// cd-chain into an unrelated dir does not false-positive.
		const cdChainAllowed = checkCommand(`cd ${workspace} && rm -rf ./scratch`, [], [], { workspaceRoot: workspace })
		assert.equal(cdChainAllowed, null, "cd into workspace + relative cleanup must not be refused")
	})
	await fsp.rm(tmp, { recursive: true, force: true })
}

// ─── (c) workspace cleanup is NOT blocked ───────────────────────────────────

async function testWorkspaceCleanupNotBlocked(): Promise<void> {
	const tmp = await mkTmp("hc-store-protect-ws-")
	// Store and workspace are deliberately in SEPARATE subtrees of tmp so no
	// workspace-internal relative path can ever resolve to the store.
	const storeRoot = path.join(tmp, "data", "central-store")
	const workspace = path.join(tmp, "workspace")
	await fsp.mkdir(workspace, { recursive: true })
	await withEnv("HEADLESSCODE_DATA_DIR", storeRoot, () => {
		assert.equal(checkCommand("rm -rf ./tmp-scratch", [], [], { workspaceRoot: workspace }), null)
			assert.equal(checkCommand("rm -rf tmp-scratch", [], [], { workspaceRoot: workspace }), null)
			assert.equal(
				checkCommand(`rm -rf ${path.join(workspace, "tmp-scratch")}`, [], [], { workspaceRoot: workspace }),
				null,
			)
			assert.equal(decideCommand("rm -rf ./tmp-scratch", [], [], { workspaceRoot: workspace }), "allow")
			// A relative path anchored on the WORKSPACE stays in the workspace.
			assert.equal(checkCommand("rm -rf ../workspace", [], [], { workspaceRoot: workspace }), null)
			assert.equal(checkCommand("rm -rf .", [], [], { workspaceRoot: workspace }), null)
			// Non-destructive reads of the store are unaffected.
			assert.equal(checkCommand(`echo ${storeRoot}`, [], [], { workspaceRoot: workspace }), null)
			assert.equal(decideCommand(`ls ${storeRoot}`, [], [], { workspaceRoot: workspace }), "allow")
			// v1 scope (documented): a NON-recursive rm of a single file inside
			// the store is deliberately not blocked — the pattern covers
			// recursive deletes of the store root/parents only.
			assert.equal(
				checkCommand(`rm ${path.join(storeRoot, "settings.json")}`, [], [], { workspaceRoot: workspace }),
				null,
			)
	})
	await fsp.rm(tmp, { recursive: true, force: true })
}

// ─── (d) NOT overridable by per-workspace permissions config ────────────────

async function testNotOverridableByConfig(): Promise<void> {
	const tmp = await mkTmp("hc-store-protect-nover-")
	const storeRoot = path.join(tmp, "central-store")
	await withEnv("HEADLESSCODE_DATA_DIR", storeRoot, () => {
		const cmd = `rm -rf ${storeRoot}`
			// An allow-list that would otherwise permit rm does NOT override the
			// store check — the refusal kind stays protected_store, not "denied".
			assert.equal(decideCommand(cmd, ["rm", "rm -rf"], []), "deny")
			const refusal = checkCommand(cmd, ["rm", "rm -rf"], [])
			assert.ok(refusal !== null, "must be refused even with rm allow-listed")
			assert.equal(refusal.kind, "protected_store", "refusal kind is protected_store, not the allow/deny kinds")
			// A wildcard allow-list ("allow everything") cannot bypass it either.
			assert.equal(decideCommand(cmd, ["*"], []), "deny")
			// Zero config (the default-allow branch) is also refused.
			assert.equal(decideCommand(cmd, [], []), "deny")
			// A compound chain cannot hide the protected sub-command.
			assert.equal(decideCommand(`echo hi && ${cmd}`, ["echo", "rm"], []), "deny")
	})
	await fsp.rm(tmp, { recursive: true, force: true })
}

// ─── (e) legitimate central-store access is completely unaffected ───────────

async function testLegitimateAccessUnaffected(): Promise<void> {
	const tmp = await mkTmp("hc-store-protect-legit-")
	const storeRoot = path.join(tmp, "central-store")
	const workspace = path.join(tmp, "workspace")
	await fsp.mkdir(workspace, { recursive: true })
	await withEnv("HEADLESSCODE_DATA_DIR", storeRoot, async () => {
		// project-store.ts's own read/write path never routes through
			// checkCommand — the protection only gates the execute_command
			// TOOL. Prove the harness's normal store access works while the
			// protection is active (same env): resolveProjectDataDir still
			// resolves under the store root and the metadata write still lands.
			const dir = resolveProjectDataDir(workspace)
			assert.ok(dir.startsWith(storeRoot + path.sep), "harness project dir resolves under the store root")
			const { keySource, kind } = resolveProjectIdentity(workspace)
			writeProjectMetadata(dir, keySource, kind)
			const meta = await fsp.readFile(path.join(dir, "project.json"), "utf-8")
			assert.ok(meta.includes(keySource), "harness writes project metadata into the store untouched")

			// The `headlesscode migrate` subcommand's workspace step (the same
			// calls migrateMain makes — resolveProjectDataDir +
			// migrateLegacyProjectData) still moves legacy data into the store.
			await fsp.mkdir(path.join(workspace, ".headlesscode", "codesearch"), { recursive: true })
			await fsp.writeFile(path.join(workspace, ".headlesscode", "codesearch", "index.jsonl"), "legacy\n")
			const centralDir = resolveProjectDataDir(workspace)
			migrateLegacyProjectData(workspace, keySource, centralDir, { log: () => {} })
			assert.equal(
				await fsp.readFile(path.join(centralDir, "codesearch", "index.jsonl"), "utf-8"),
				"legacy\n",
				"headlesscode migrate still moves legacy data into the store",
			)

			// And the check itself ignores non-destructive access entirely.
			assert.equal(checkCentralStoreDestruction(`ls ${storeRoot}`, workspace), null)
			assert.equal(checkCentralStoreDestruction(`echo ${storeRoot}`, workspace), null)
	})
	await fsp.rm(tmp, { recursive: true, force: true })
}

// ─── (f) word splitting / path resolution / containment edges ───────────────

async function testWordSplittingAndPathResolution(): Promise<void> {
	// Quoting + word splitting.
	assert.deepEqual(splitCommandWords("rm -rf ~/.local/share/headlesscode"), ["rm", "-rf", "~/.local/share/headlesscode"])
	assert.deepEqual(splitCommandWords('rm -rf "$HOME/x"'), ["rm", "-rf", "$HOME/x"])
	assert.deepEqual(splitCommandWords("rm -rf '/tmp/a b'"), ["rm", "-rf", "/tmp/a b"])
	assert.deepEqual(splitCommandWords("rm -rf -- /tmp/x"), ["rm", "-rf", "--", "/tmp/x"])
	assert.deepEqual(splitCommandWords('echo "a && b"'), ["echo", "a && b"])

	// Tilde + env expansion.
	assert.equal(expandHome("~/x"), path.join(os.homedir(), "x"))
	assert.equal(expandHome("~"), os.homedir())
	assert.equal(expandHome("/abs/path"), "/abs/path")
	assert.equal(expandEnv("$HOME/x", { HOME: "/home/t" }), "/home/t/x")
	assert.equal(expandEnv("${HOME}/x", { HOME: "/home/t" }), "/home/t/x")
	assert.equal(expandEnv("$UNSET_VAR/x", {}), "$UNSET_VAR/x", "unset vars stay literal")

	// Relative-vs-absolute resolution.
	assert.equal(resolveCommandTarget("./scratch", "/ws"), path.resolve("/ws", "./scratch"))
	assert.equal(resolveCommandTarget("~/x", "/ws"), path.join(os.homedir(), "x"))
	assert.equal(resolveCommandTarget("/abs/x", "/ws"), "/abs/x", "absolute targets ignore the workspace root")
	// With the store override UNSET, $HEADLESSCODE_DATA_DIR stays literal (an
	// unset var is not expanded). `npm test` sets the var at the suite level,
	// so clear it explicitly for this deterministic assertion.
	await withEnv("HEADLESSCODE_DATA_DIR", undefined, () => {
		assert.equal(resolveCommandTarget("$HEADLESSCODE_DATA_DIR", "/ws"), path.resolve("/ws", "$HEADLESSCODE_DATA_DIR"))
	})

	// Containment edges (no filesystem access — pure path comparison).
	await withEnv("HEADLESSCODE_DATA_DIR", "/srv/central-store", () => {
		assert.equal(isCentralStoreOrParent("/srv/central-store"), true, "the store root itself")
		assert.equal(isCentralStoreOrParent("/srv/central-store/"), true, "trailing slash normalized away")
		assert.equal(isCentralStoreOrParent("/srv"), true, "a parent of the store")
		assert.equal(isCentralStoreOrParent("/"), true, "the filesystem root is a parent of everything")
		assert.equal(isCentralStoreOrParent("/srv/central-store-other"), false, "prefix sibling is NOT the store")
		assert.equal(isCentralStoreOrParent("/srv/central-store/sub"), true, "descendant is protected too (SEC-6)")
		assert.equal(isCentralStoreOrParent("/etc"), false)
	})
}

// ─── Runner ──────────────────────────────────────────────────────────────────

const tests: Array<[string, () => Promise<void>]> = [
	["THE incident: rm -rf ~/.local/share/headlesscode + variants refused with ZERO config", testIncidentRefusedWithZeroConfig],
	["mechanism: tmp store refuses recursive deletes (flags, quoting, env vars, parents, relative escapes)", testMechanismAgainstTmpStore],
	["SEC-6: descendants, symlinks, and cd-chains are protected too", testSec6DescendantsSymlinksCdChains],
	["workspace cleanup (rm -rf ./tmp-scratch) and non-destructive access are NOT blocked", testWorkspaceCleanupNotBlocked],
	["the check cannot be bypassed by permissions.json allow-lists", testNotOverridableByConfig],
	["legitimate central-store access (project-store + migrate paths) is unaffected", testLegitimateAccessUnaffected],
	["word splitting / tilde + env expansion / containment edges", testWordSplittingAndPathResolution],
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
	console.log(`\nAll ${tests.length} store-protection tests passed`)
}

main().catch((err) => {
	console.error("Test runner crashed:", err)
	process.exit(1)
})
