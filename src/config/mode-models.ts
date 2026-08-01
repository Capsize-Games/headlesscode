/**
 * Per-mode model assignment — `<workspaceRoot>/.headlesscode/mode-models.json`.
 *
 * Maps a mode slug to an OpenRouter model id, with an optional `_default`
 * fallback key. Kept deliberately simple (a plain local config file — no
 * complexity-based routing, which is an explicit future idea, not this):
 *
 *   { "code": "deepseek/deepseek-chat", "deepseek-reviewer": "deepseek/deepseek-reasoner", "_default": "deepseek/deepseek-chat" }
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
 * Fail-loudly on a malformed file (invalid JSON, non-object, or a non-string
 * value) — the same idiom as `<workspaceRoot>/.headlesscode/permissions.json`
 * (see src/permissions/config.ts): a broken config file throws with a clear
 * message, it never silently falls back. A missing file is NOT an error —
 * zero config means zero behavior change.
 */

import * as fs from "node:fs"
import * as path from "node:path"

/** Config file location, relative to the workspace root. */
export const MODE_MODELS_CONFIG_FILE = ".headlesscode/mode-models.json"

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
}

/**
 * Load `<workspaceRoot>/.headlesscode/mode-models.json` when present.
 * Returns `null` when the file does not exist (the common case). A
 * present-but-malformed file throws — a broken mapping must fail loudly,
 * never silently fall back to a different model than the one configured.
 */
export function loadModeModelsFile(workspaceRoot: string): ModeModelsFile | null {
	const filePath = path.resolve(workspaceRoot, MODE_MODELS_CONFIG_FILE)
	let raw: string
	try {
		raw = fs.readFileSync(filePath, "utf-8")
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") {
			return null
		}
		throw new Error(
			`mode-models: cannot read mode-models file '${filePath}': ${err instanceof Error ? err.message : String(err)}`,
		)
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
	const { workspaceRoot, mode, explicitModel, env = process.env } = options

	if (explicitModel !== undefined && explicitModel !== "") {
		return explicitModel
	}

	const file = loadModeModelsFile(workspaceRoot)
	if (file !== null) {
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
