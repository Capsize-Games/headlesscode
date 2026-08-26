/**
 * Command allow/deny + protected-file permissions configuration for the
 * headless harness.
 *
 * Resolution precedence (mirrors the flag/env/file convention established for
 * the per-session budget in src/budget/cost.ts and src/cli.ts):
 *
 *   CLI flags > env vars > central permissions.json > built-in defaults
 *
 * - CLI flags:  `--allowed-commands` / `--denied-commands` / `--protected-files`
 *               / `--allow-protected-writes` (see src/cli.ts parseArgs)
 * - env vars:   `HEADLESSCODE_ALLOWED_COMMANDS` / `HEADLESSCODE_DENIED_COMMANDS`
 *               / `HEADLESSCODE_PROTECTED_FILES` /
 *               `HEADLESSCODE_ALLOW_PROTECTED_WRITES`
 * - config file: the CENTRAL project store's `permissions.json`
 *               (`~/.local/share/headlesscode/projects/<key>/permissions.json` —
 *               see src/project-store.ts; keyed by the repo's git-common-dir, so
 *               worktrees share one policy with zero per-directory setup),
 *               auto-loaded when present (no flag needed). Schema:
 *               `{ "allowedCommands": string[], "deniedCommands": string[],
 *               "protectedFiles": string[], "allowProtectedWrites": boolean }`.
 *               A malformed file fails loudly — mirroring how
 *               `HEADLESSCODE_PRICING_JSON` is treated in src/budget/cost.ts —
 *               never silently weakens a policy.
 *
 * Deliberate defaults (documented in plans/permissions-parity.md):
 * - `allowedCommands` defaults to `[]`, which the command decision layer
 *   (src/permissions/commands.ts) treats as "allow everything except the
 *   deny-list" — default-ALLOW, backward compatible with the pre-permissions
 *   harness. `deniedCommands` always applies even then.
 * - `protectedFiles` defaults to `DEFAULT_PROTECTED_FILES` (secret/credential
 *   file patterns) — an unattended agent must not silently overwrite .env /
 *   keys / PEMs. Unlike command allow/deny, leaving this OFF by default would
 *   be unsafe.
 * - `allowProtectedWrites` defaults to `false` (an explicit escape hatch only).
 */

import * as fs from "node:fs"
import * as path from "node:path"

import { resolveProjectDataDir } from "../project-store.js"
import { DEFAULT_PROTECTED_FILES } from "./protected-files.js"

/**
 * Fully resolved permissions for one session / executor. Everything is
 * concrete — no `undefined` fields — so enforcement code never has to guess.
 */
export interface PermissionsConfig {
	/** Command prefixes that may run (empty = default-ALLOW; see commands.ts). */
	allowedCommands: string[]
	/** Command prefixes that may NEVER run (deny wins over allow). */
	deniedCommands: string[]
	/** Glob patterns of files that may not be written (see protected-files.ts). */
	protectedFiles: string[]
	/** Escape hatch: when true, the protected-files check is bypassed. */
	allowProtectedWrites: boolean
}

/**
 * Raw (pre-resolution) overrides. Lists arrive as comma-separated strings —
 * the same shape the CLI flags and env vars carry, so callers don't need to
 * pre-split. `null`/absent means "no override at this layer".
 */
export interface PermissionsOverrides {
	allowedCommands?: string | null
	deniedCommands?: string | null
	protectedFiles?: string | null
	allowProtectedWrites?: boolean | null
}

/** The auto-loaded per-repo config file (schema above). */
export interface PermissionsFile {
	allowedCommands?: string[]
	deniedCommands?: string[]
	protectedFiles?: string[]
	allowProtectedWrites?: boolean
}

/** Config file basename inside the central project data dir. */
export const PERMISSIONS_CONFIG_FILE = "permissions.json"

/** Absolute path of the central permissions.json for a workspace root. */
export function permissionsFilePath(workspaceRoot: string): string {
	return path.join(resolveProjectDataDir(workspaceRoot), PERMISSIONS_CONFIG_FILE)
}

/** Split a comma-separated list (CLI flag / env var) into trimmed entries. */
export function parseCommaSeparated(raw: string | undefined): string[] | undefined {
	if (raw === undefined || raw === null) {
		return undefined
	}
	const entries = raw
		.split(",")
		.map((s) => s.trim())
		.filter((s) => s.length > 0)
	return entries.length > 0 ? entries : undefined
}

/**
 * Validate an already-parsed permissions-file body (an object of
 * {allowedCommands?, deniedCommands?, protectedFiles?, allowProtectedWrites?})
 * and return the normalized `PermissionsFile`. Throws on malformed input —
 * a broken policy must fail loudly, never silently fall back to weaker
 * defaults. The file path is only used in error messages.
 *
 * Shared by BOTH the file loader below and the dashboard settings POST, so
 * the HTTP save path can never drift from what the CLI/env path enforces.
 */
export function parsePermissionsFileBody(parsed: unknown, source: string): PermissionsFile {
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error(
			`permissions: '${source}' must be a JSON object of {allowedCommands, deniedCommands, protectedFiles, allowProtectedWrites}`,
		)
	}

	const out: PermissionsFile = {}
	const obj = parsed as Record<string, unknown>

	for (const key of ["allowedCommands", "deniedCommands", "protectedFiles"] as const) {
		const value = obj[key]
		if (value === undefined) {
			continue
		}
		if (!Array.isArray(value) || !value.every((v) => typeof v === "string")) {
			throw new Error(`permissions: '${source}' field '${key}' must be an array of strings`)
		}
		out[key] = value as string[]
	}

	const allowProtectedWrites = obj.allowProtectedWrites
	if (allowProtectedWrites !== undefined) {
		if (typeof allowProtectedWrites !== "boolean") {
			throw new Error(`permissions: '${source}' field 'allowProtectedWrites' must be a boolean`)
		}
		out.allowProtectedWrites = allowProtectedWrites
	}

	return out
}

/**
 * Load the central `permissions.json` for a workspace when present.
 * Returns `null` when the file does not exist (the common case). A
 * present-but-malformed file throws — a broken policy must fail loudly, never
 * silently fall back to weaker defaults. Falls back to the legacy
 * `<workspaceRoot>/.headlesscode/permissions.json` only when the central file
 * is absent AND the legacy one still exists (pre-migration grace — the
 * migration in resolveProjectDataDir normally moves it before this is reached).
 */
export function loadPermissionsFile(workspaceRoot: string): PermissionsFile | null {
	const filePath = permissionsFilePath(workspaceRoot)
	let raw: string
	try {
		raw = fs.readFileSync(filePath, "utf-8")
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") {
			const legacy = path.resolve(workspaceRoot, ".headlesscode", PERMISSIONS_CONFIG_FILE)
			try {
				raw = fs.readFileSync(legacy, "utf-8")
			} catch {
				return null
			}
		} else {
			throw new Error(
				`permissions: cannot read permissions file '${filePath}': ${err instanceof Error ? err.message : String(err)}`,
			)
		}
	}

	let parsed: unknown
	try {
		parsed = JSON.parse(raw)
	} catch (err) {
		throw new Error(
			`permissions: invalid JSON in '${filePath}': ${err instanceof Error ? err.message : String(err)}`,
		)
	}

	return parsePermissionsFileBody(parsed, filePath)
}

/** Parse a truthy env flag ("1"/"true"/"yes"); undefined when unset. */
function envBoolean(name: string, env: NodeJS.ProcessEnv): boolean | undefined {
	const raw = env[name]
	if (raw === undefined || raw === "") {
		return undefined
	}
	return raw === "1" || raw.toLowerCase() === "true" || raw.toLowerCase() === "yes"
}

/**
 * Resolve the effective permissions for a session:
 * CLI-flag overrides > env vars > permissions.json > built-in defaults.
 *
 * `workspaceRoot` is required so the auto-loaded `<workspaceRoot>/.headlesscode/
 * permissions.json` policy can participate. Callers that have no CLI flags (the
 * reviewer/QA executors, which resolve at executor-construction time) simply
 * omit `overrides` — env + config file + defaults still apply.
 */
export function resolvePermissions(options: {
	workspaceRoot: string
	overrides?: PermissionsOverrides
	env?: NodeJS.ProcessEnv
}): PermissionsConfig {
	const { workspaceRoot, overrides = {}, env = process.env } = options
	const file = loadPermissionsFile(workspaceRoot)

	const allowedCommands =
		parseCommaSeparated(overrides.allowedCommands ?? undefined) ??
		parseCommaSeparated(env.HEADLESSCODE_ALLOWED_COMMANDS) ??
		file?.allowedCommands ??
		[]

	const deniedCommands =
		parseCommaSeparated(overrides.deniedCommands ?? undefined) ??
		parseCommaSeparated(env.HEADLESSCODE_DENIED_COMMANDS) ??
		file?.deniedCommands ??
		[]

	const protectedFiles =
		parseCommaSeparated(overrides.protectedFiles ?? undefined) ??
		parseCommaSeparated(env.HEADLESSCODE_PROTECTED_FILES) ??
		file?.protectedFiles ??
		[...DEFAULT_PROTECTED_FILES]

	// The escape hatch has no env-var requirement upstream, but honoring an
	// env var keeps it usable for unattended workers (run-worker.sh sets
	// policy via env). Precedence is the same chain.
	const allowProtectedWrites =
		overrides.allowProtectedWrites ??
		envBoolean("HEADLESSCODE_ALLOW_PROTECTED_WRITES", env) ??
		file?.allowProtectedWrites ??
		false

	return { allowedCommands, deniedCommands, protectedFiles, allowProtectedWrites }
}

/** Pretty-printed canonical serialization for the settings file. */
export function stringifyPermissionsFile(file: PermissionsFile): string {
	return JSON.stringify(file, null, 2) + "\n"
}
