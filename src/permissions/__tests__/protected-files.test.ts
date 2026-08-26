/**
 * Unit tests for protected-file glob matching + permissions config resolution
 * (src/permissions/protected-files.ts, src/permissions/config.ts). Plain
 * assert-based script (no test framework, no network), run via `npm test` ->
 * `tsx src/permissions/__tests__/protected-files.test.ts`.
 *
 * Covers: `.env` (and `subdir/.env`) refused by the built-in defaults; custom
 * pattern lists refuse/allow as configured; the escape hatch
 * (`allowProtectedWrites`) resolves when explicitly set; and the full
 * CLI > env > permissions.json > defaults precedence chain.
 */

import assert from "node:assert/strict"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"

import { DEFAULT_PROTECTED_FILES, findMatchingPattern, isProtectedPath } from "../protected-files.js"
import {
	loadPermissionsFile,
	permissionsFilePath,
	resolvePermissions,
	type PermissionsOverrides,
} from "../config.js"

async function mkTmpWorkspace(prefix: string): Promise<string> {
	return fs.mkdtemp(path.join(os.tmpdir(), prefix))
}

// ─── (a) built-in defaults: .env / .env.* / *.pem / *.key / id_rsa* ─────────

async function testDefaultProtectedPatterns(): Promise<void> {
	assert.deepEqual(DEFAULT_PROTECTED_FILES, [".env", ".env.*", "*.pem", "*.key", "id_rsa*"])

	// .env at any depth.
	assert.equal(isProtectedPath(".env", DEFAULT_PROTECTED_FILES), true)
	assert.equal(isProtectedPath("subdir/.env", DEFAULT_PROTECTED_FILES), true)
	assert.equal(findMatchingPattern("subdir/.env", DEFAULT_PROTECTED_FILES), ".env", "must name the matched pattern")
	// .env.* at any depth.
	assert.equal(isProtectedPath("subdir/.env.local", DEFAULT_PROTECTED_FILES), true)
	assert.equal(isProtectedPath("config/.env.production", DEFAULT_PROTECTED_FILES), true)
	assert.equal(isProtectedPath(".env.example", DEFAULT_PROTECTED_FILES), true)
	// *.pem / *.key at any depth.
	assert.equal(isProtectedPath("a/b/server.pem", DEFAULT_PROTECTED_FILES), true)
	assert.equal(isProtectedPath("a/b/private.key", DEFAULT_PROTECTED_FILES), true)
	assert.equal(findMatchingPattern("a/b/server.pem", DEFAULT_PROTECTED_FILES), "*.pem")
	// id_rsa* at any depth.
	assert.equal(isProtectedPath("config/id_rsa", DEFAULT_PROTECTED_FILES), true)
	assert.equal(isProtectedPath("config/id_rsa_backup", DEFAULT_PROTECTED_FILES), true)
	// Windows separators are normalized before matching.
	assert.equal(isProtectedPath("subdir\\.env", DEFAULT_PROTECTED_FILES), true)

	// Non-secret files are NOT protected.
	assert.equal(isProtectedPath("src/main.ts", DEFAULT_PROTECTED_FILES), false)
	assert.equal(isProtectedPath("package.json", DEFAULT_PROTECTED_FILES), false)
	assert.equal(isProtectedPath("subdir/README.md", DEFAULT_PROTECTED_FILES), false)
	// ".envs" is not ".env" and does not match ".env.*" — sanity check.
	assert.equal(isProtectedPath(".envs", DEFAULT_PROTECTED_FILES), false)
}

// ─── (b) custom pattern list refuses/allows as configured ───────────────────

async function testCustomPatternLists(): Promise<void> {
	// Single-segment `*` does not cross directories; `**` does.
	assert.equal(isProtectedPath("secrets/token.txt", ["secrets/*"]), true)
	assert.equal(isProtectedPath("other/token.txt", ["secrets/*"]), false)
	assert.equal(isProtectedPath("secrets/a/b/token.txt", ["secrets/*"]), false)
	assert.equal(isProtectedPath("secrets/a/b/token.txt", ["secrets/**"]), true)

	// Slash patterns are anchored to the workspace root (gitignore-style).
	assert.equal(isProtectedPath("config/credentials.json", ["config/credentials.json"]), true)
	assert.equal(isProtectedPath("other/config/credentials.json", ["config/credentials.json"]), false)

	// Bare-extension patterns match at any depth (basename matching).
	assert.equal(isProtectedPath("logs/app.log", ["*.log"]), true)
	assert.equal(isProtectedPath("a b/x.key", ["*.key"]), true)

	// Trailing-slash patterns protect a directory and everything under it.
	assert.equal(isProtectedPath("build/out.js", ["build/"]), true)
	assert.equal(isProtectedPath("build/a/b/out.js", ["build/"]), true)
	assert.equal(isProtectedPath("src/build/x.js", ["build/"]), false)
}

// ─── (c) config resolution + escape hatch ───────────────────────────────────

async function testResolutionDefaultsAndEscapeHatch(): Promise<void> {
	// Nothing configured anywhere -> built-in protected defaults, empty lists,
	// escape hatch OFF.
	const defaults = resolvePermissions({ workspaceRoot: "/tmp/nonexistent-ws", env: {} })
	assert.deepEqual(defaults.protectedFiles, DEFAULT_PROTECTED_FILES)
	assert.deepEqual(defaults.allowedCommands, [])
	assert.deepEqual(defaults.deniedCommands, [])
	assert.equal(defaults.allowProtectedWrites, false)

	// Escape hatch: explicit override (the --allow-protected-writes flag) wins.
	const withOverride = resolvePermissions({
		workspaceRoot: "/tmp/nonexistent-ws",
		overrides: { allowProtectedWrites: true },
		env: {},
	})
	assert.equal(withOverride.allowProtectedWrites, true)
	// Env fallback also works (worker parity).
	const withEnv = resolvePermissions({ workspaceRoot: "/tmp/nonexistent-ws", env: { HEADLESSCODE_ALLOW_PROTECTED_WRITES: "1" } })
	assert.equal(withEnv.allowProtectedWrites, true)

	// CLI (override) beats env beats file beats defaults.
	const overrides: PermissionsOverrides = { protectedFiles: "cli.env,cli/*" }
	const withCli = resolvePermissions({
		workspaceRoot: "/tmp/nonexistent-ws",
		overrides,
		env: { HEADLESSCODE_PROTECTED_FILES: "env.env" },
	})
	assert.deepEqual(withCli.protectedFiles, ["cli.env", "cli/*"])
	const withEnvOnly = resolvePermissions({
		workspaceRoot: "/tmp/nonexistent-ws",
		env: { HEADLESSCODE_PROTECTED_FILES: "env.env, env2.env " },
	})
	assert.deepEqual(withEnvOnly.protectedFiles, ["env.env", "env2.env"])

	// Comma-separated command lists resolve the same way.
	const withCommands = resolvePermissions({
		workspaceRoot: "/tmp/nonexistent-ws",
		overrides: { allowedCommands: "git,npm run", deniedCommands: "rm " },
		env: {},
	})
	assert.deepEqual(withCommands.allowedCommands, ["git", "npm run"])
	assert.deepEqual(withCommands.deniedCommands, ["rm"])
}

async function testConfigFilePrecedence(): Promise<void> {
	const ws = await mkTmpWorkspace("hc-perm-file-")
	try {
		// The config file lives in the CENTRAL project store now
		// (permissionsFilePath) — the legacy `.headlesscode/` migration path is
		// covered by src/project-store.test.ts.
		const filePath = permissionsFilePath(ws)

		// Missing file -> null.
		assert.equal(loadPermissionsFile(ws), null)

		// File supplies protectedFiles + allowedCommands + allowProtectedWrites.
		await fs.writeFile(
			filePath,
			JSON.stringify({
				allowedCommands: ["git", "npm"],
				deniedCommands: ["gh"],
				protectedFiles: ["file.env"],
				allowProtectedWrites: true,
			}),
			"utf-8",
		)
		const fromFile = resolvePermissions({ workspaceRoot: ws, env: {} })
		assert.deepEqual(fromFile.protectedFiles, ["file.env"], "config file beats built-in defaults")
		assert.deepEqual(fromFile.allowedCommands, ["git", "npm"])
		assert.deepEqual(fromFile.deniedCommands, ["gh"])
		assert.equal(fromFile.allowProtectedWrites, true)

		// Env beats file.
		const envBeatsFile = resolvePermissions({
			workspaceRoot: ws,
			env: { HEADLESSCODE_PROTECTED_FILES: "env.env", HEADLESSCODE_ALLOWED_COMMANDS: "envcmd" },
		})
		assert.deepEqual(envBeatsFile.protectedFiles, ["env.env"])
		assert.deepEqual(envBeatsFile.allowedCommands, ["envcmd"])

		// CLI (override) beats env beats file.
		const cliBeatsAll = resolvePermissions({
			workspaceRoot: ws,
			overrides: { protectedFiles: "cli.env", deniedCommands: "clideny" },
			env: { HEADLESSCODE_PROTECTED_FILES: "env.env", HEADLESSCODE_DENIED_COMMANDS: "envdeny" },
		})
		assert.deepEqual(cliBeatsAll.protectedFiles, ["cli.env"])
		assert.deepEqual(cliBeatsAll.deniedCommands, ["clideny"])
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

async function testMalformedConfigFileFailsLoudly(): Promise<void> {
	const ws = await mkTmpWorkspace("hc-perm-bad-")
	try {
		const filePath = permissionsFilePath(ws)

		// Invalid JSON throws (never silently ignored).
		await fs.writeFile(filePath, "{ not json", "utf-8")
		assert.throws(() => resolvePermissions({ workspaceRoot: ws, env: {} }), /invalid JSON/)

		// Non-object JSON throws.
		await fs.writeFile(filePath, '["a"]', "utf-8")
		assert.throws(() => resolvePermissions({ workspaceRoot: ws, env: {} }), /must be a JSON object/)

		// Wrong field type throws.
		await fs.writeFile(filePath, JSON.stringify({ protectedFiles: "not-an-array" }), "utf-8")
		assert.throws(() => resolvePermissions({ workspaceRoot: ws, env: {} }), /'protectedFiles' must be an array of strings/)

		// allowProtectedWrites must be a boolean.
		await fs.writeFile(filePath, JSON.stringify({ allowProtectedWrites: "yes" }), "utf-8")
		assert.throws(() => resolvePermissions({ workspaceRoot: ws, env: {} }), /'allowProtectedWrites' must be a boolean/)
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

// ─── Runner ──────────────────────────────────────────────────────────────────

const tests: Array<[string, () => Promise<void>]> = [
	["built-in defaults protect .env / .env.* / *.pem / *.key / id_rsa* at any depth", testDefaultProtectedPatterns],
	["custom pattern lists refuse/allow as configured (segment-aware globs, anchored slash patterns)", testCustomPatternLists],
	["resolution defaults + escape hatch (allowProtectedWrites) resolves when explicitly set", testResolutionDefaultsAndEscapeHatch],
	["permissions.json config file participates in precedence (file < env < CLI)", testConfigFilePrecedence],
	["malformed permissions.json fails loudly", testMalformedConfigFileFailsLoudly],
]

async function main(): Promise<void> {
	// Redirect the central store to a temp dir so no test touches the real
	// home directory's central store.
	const storeTmp = await fs.mkdtemp(path.join(os.tmpdir(), "hc-perm-store-"))
	process.env.HEADLESSCODE_DATA_DIR = storeTmp
	let failed = 0
	try {
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
	} finally {
		delete process.env.HEADLESSCODE_DATA_DIR
		await fs.rm(storeTmp, { recursive: true, force: true })
	}
	if (failed > 0) {
		console.error(`\n${failed} test(s) failed`)
		process.exit(1)
	}
	console.log(`\nAll ${tests.length} protected-file + config tests passed`)
}

main().catch((err) => {
	console.error("Test runner crashed:", err)
	process.exit(1)
})
