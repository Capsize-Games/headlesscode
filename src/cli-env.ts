/**
 * Shared CLI env helpers (issue #128 leaf).
 *
 * resolvePerModeEnv/envBooleanValue/envBoolean lived in src/cli.ts, which
 * every subcommand CLI statically imports — so any module that needed one of
 * these helpers (orchestrator/cli, reviewer, pipeline, qa) pulled the whole
 * root CLI back in and closed an import cycle. This leaf has no imports, so
 * everyone can share the helpers cycle-free; src/cli.ts re-exports them.
 */

/**
 * Per-mode env var lookup: `HEADLESSCODE_<BASE>__<MODE>` (mode slug
 * uppercased, "-" -> "_") wins if set, else the plain global
 * `HEADLESSCODE_<BASE>`, else undefined.
 */
export function resolvePerModeEnv(
	baseName: string,
	mode: string,
	env: NodeJS.ProcessEnv = process.env,
): string | undefined {
	const modeKey = mode.toUpperCase().replace(/-/g, "_")
	return env[`${baseName}__${modeKey}`] ?? env[baseName]
}

/** Pure env-boolean parse ("1"/"true"/"yes"/"on" → true). */
export function envBooleanValue(name: string, env: NodeJS.ProcessEnv): boolean {
	const raw = env[name]
	if (raw === undefined || raw === "") {
		return false
	}
	return ["1", "true", "yes", "on"].includes(raw.trim().toLowerCase())
}

/** Env boolean opt-in from process.env (unset → false). */
export function envBoolean(name: string): boolean {
	return envBooleanValue(name, process.env)
}
