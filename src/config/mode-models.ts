/**
 * Per-mode model assignment — the CENTRAL project store's `mode-models.json`
 * (`~/.local/share/headlesscode/projects/<key>/mode-models.json`, see
 * src/project-store.ts). Keyed by the repo's git-common-dir, so every worktree
 * of a repo resolves the same per-mode models with zero per-directory setup.
 *
 * Maps a mode slug to an OpenRouter model id, with an optional `_default`
 * fallback key. Kept deliberately simple (a plain local config file — no
 * complexity-based routing, which is an explicit future idea, not this):
 *
 *   { "code": "deepseek/deepseek-v4-flash", "deepseek-reviewer": "deepseek/deepseek-reasoner", "_default": "deepseek/deepseek-v4-flash" }
 *
 * Resolution precedence for `resolveModelForMode`:
 *   1. `explicitModel` (an actual `--model` flag value) — always wins, a
 *      deliberate manual override.
 *   2. `mode-models.json[mode]`.
 *   3. `mode-models.json["_default"]`.
 *   4. `env.OPENROUTER_MODEL`.
 *   5. `undefined` — the caller's OpenRouter client then falls back to its
 *      own built-in default (`DEFAULT_MODEL` in src/llm/openrouter.ts),
 *      which stays the single source of truth for the ultimate default.
 *
 * Non-model `_`-prefixed keys extend the same file: `_condensation` assigns
 * a cheaper model for the context-condensation call (consulted via extraKeys
 * before the mode entry), and `_reasoning_effort` sets the graded reasoning
 * effort for deepseek/* models (see resolveReasoningEffortForMode).
 *
 * Fail-loudly on a malformed file (invalid JSON, non-object, or a non-string
 * value) — the same idiom as the central permissions.json (see
 * src/permissions/config.ts): a broken config file throws with a clear
 * message, it never silently falls back. A missing file is NOT an error —
 * zero config means zero behavior change.
 */

import * as fs from "node:fs"
import * as path from "node:path"

import { resolveProjectDataDir } from "../project-store.js"

/** Config file basename inside the central project data dir. */
export const MODE_MODELS_CONFIG_FILE = "mode-models.json"

/** Absolute path of the central mode-models.json for a workspace root. */
export function modeModelsFilePath(workspaceRoot: string): string {
	return path.join(resolveProjectDataDir(workspaceRoot), MODE_MODELS_CONFIG_FILE)
}

/** The fallback key inside the config file (not a mode slug itself). */
export const DEFAULT_KEY = "_default"

/** The parsed config file: mode slug (or `_default`) -> model id. */
export type ModeModelsFile = Record<string, string>

export interface ResolveModelOptions {
	workspaceRoot: string
	/** Mode slug to resolve a model for (e.g. "code", "deepseek-reviewer", "qa-agent"). */
	mode: string
	/** An explicit `--model` flag value, if the caller passed one. Always wins. */
	explicitModel?: string
	/** Env to read OPENROUTER_MODEL from (default: process.env). */
	env?: NodeJS.ProcessEnv
	/**
	 * Optional EXTRA config keys consulted BEFORE the mode entry (e.g.
	 * `_condensation` — a cheaper model id used for the context-condensation
	 * LLM call; see src/engine/condense.ts). Each key is read directly from
	 * the config file, so an entry like `"_condensation": "qwen/qwen3-8b"`
	 * works without being a real mode slug. Consulted first because the
	 * whole point of such a key is to override whatever the session model
	 * resolves to — if the mode entry shadowed it, a file that sets both
	 * `"code"` and `"_condensation"` (the canonical example) would silently
	 * keep running condensation on the full-price session model. When none
	 * of the keys resolve, precedence falls through to `mode` → `_default`
	 * → `OPENROUTER_MODEL` → undefined exactly as before.
	 */
	extraKeys?: string[]
}

/**
 * Load the central `mode-models.json` for a workspace when present.
 * Returns `null` when the file does not exist (the common case). A
 * present-but-malformed file throws — a broken mapping must fail loudly,
 * never silently fall back to a different model than the one configured.
 * Falls back to the legacy `<workspaceRoot>/.headlesscode/mode-models.json`
 * only when the central file is absent AND the legacy one still exists
 * (pre-migration grace — the migration in resolveProjectDataDir normally
 * moves it before this is reached).
 */
export function loadModeModelsFile(workspaceRoot: string): ModeModelsFile | null {
	const filePath = modeModelsFilePath(workspaceRoot)
	let raw: string
	try {
		raw = fs.readFileSync(filePath, "utf-8")
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") {
			const legacy = path.resolve(workspaceRoot, ".headlesscode", MODE_MODELS_CONFIG_FILE)
			try {
				raw = fs.readFileSync(legacy, "utf-8")
			} catch {
				return null
			}
		} else {
			throw new Error(
				`mode-models: cannot read mode-models file '${filePath}': ${err instanceof Error ? err.message : String(err)}`,
			)
		}
	}

	let parsed: unknown
	try {
		parsed = JSON.parse(raw)
	} catch (err) {
		throw new Error(
			`mode-models: invalid JSON in '${filePath}': ${err instanceof Error ? err.message : String(err)}`,
		)
	}

	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error(`mode-models: '${filePath}' must be a JSON object of mode slug -> model id strings`)
	}

	const out: ModeModelsFile = {}
	const obj = parsed as Record<string, unknown>
	for (const [key, value] of Object.entries(obj)) {
		if (typeof value !== "string") {
			throw new Error(
				`mode-models: '${filePath}' entry '${key}' must be a string model id, got ${JSON.stringify(value)}`,
			)
		}
		out[key] = value
	}
	return out
}

/**
 * Resolve the model id to use for one session, per the precedence rules in
 * the file header. Returns `undefined` when nothing more specific is
 * configured — the caller's OpenRouter client then applies its own built-in
 * default, keeping `DEFAULT_MODEL` in src/llm/openrouter.ts the single
 * source of truth for the ultimate fallback.
 */
export function resolveModelForMode(options: ResolveModelOptions): string | undefined {
	const { workspaceRoot, mode, explicitModel, extraKeys, env = process.env } = options

	if (explicitModel !== undefined && explicitModel !== "") {
		return explicitModel
	}

	const file = loadModeModelsFile(workspaceRoot)
	if (file !== null) {
		for (const key of extraKeys ?? []) {
			if (typeof file[key] === "string") {
				return file[key]
			}
		}
		if (typeof file[mode] === "string") {
			return file[mode]
		}
		if (typeof file[DEFAULT_KEY] === "string") {
			return file[DEFAULT_KEY]
		}
	}

	const envModel = env.OPENROUTER_MODEL
	return envModel === undefined || envModel === "" ? undefined : envModel
}

/** The optional `_reasoning_effort` key inside mode-models.json (not a mode slug). */
export const REASONING_EFFORT_KEY = "_reasoning_effort"

export interface ResolveReasoningEffortOptions {
	workspaceRoot: string
	/** Env to read HEADLESSCODE_REASONING_EFFORT from (default: process.env). */
	env?: NodeJS.ProcessEnv
}

/**
 * Resolve the session's graded reasoning effort (issue #30 experiment) from
 * the central `mode-models.json` `_reasoning_effort` key (beats env), then
 * `$HEADLESSCODE_REASONING_EFFORT`, then `undefined` — no effort sent, the
 * endpoint's undeclared default applies (pre-existing behavior). The value is
 * a plain string in the same `Record<string, string>` format as model ids, so
 * no format change is needed. The caller validates/normalizes the value
 * (parseReasoningEffort in src/llm/openrouter.ts); a missing file/key/env is
 * NOT an error — zero config means zero behavior change.
 */
export function resolveReasoningEffortForMode(options: ResolveReasoningEffortOptions): string | undefined {
	const { workspaceRoot, env = process.env } = options
	const file = loadModeModelsFile(workspaceRoot)
	if (file !== null && typeof file[REASONING_EFFORT_KEY] === "string") {
		return file[REASONING_EFFORT_KEY]
	}
	const envValue = env.HEADLESSCODE_REASONING_EFFORT
	return envValue === undefined || envValue === "" ? undefined : envValue
}

/**
 * Validate a prospective config-file body (used by the dashboard settings
 * endpoint so a malformed save is rejected server-side instead of writing
 * garbage that later throws when a worker reads it). Throws on invalid input;
 * a `{...}` object of string values always passes.
 */
export function validateModeModelsBody(body: unknown): asserts body is ModeModelsFile {
	if (body === null || typeof body !== "object" || Array.isArray(body)) {
		throw new Error("mode-models: body must be a JSON object of mode slug -> model id strings")
	}
	for (const [key, value] of Object.entries(body as Record<string, unknown>)) {
		if (typeof value !== "string") {
			throw new Error(
				`mode-models: entry '${key}' must be a string model id, got ${JSON.stringify(value)}`,
			)
		}
	}
}

/** Pretty-printed canonical serialization for the settings file. */
export function stringifyModeModelsFile(file: ModeModelsFile): string {
	return JSON.stringify(file, null, 2) + "\n"
}
