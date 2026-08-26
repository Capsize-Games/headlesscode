/**
 * Protected-file glob matching for the headless harness.
 *
 * A write to any path matching the resolved protected-files list is refused
 * (unless the `--allow-protected-writes` escape hatch is on). Simple glob
 * matching, implemented in-repo — the vendored checkpoint excludes.ts
 * (src/vendor/zoo-code/src/services/checkpoints/excludes.ts) only *builds*
 * pattern lists that shadow-git feeds to git itself (via `git config
 * core.excludesFile`-style config), it has no reusable TS matcher, and there
 * is no glob/minimatch/picomatch dependency in this repo or node_modules.
 *
 * Matching semantics (deliberate, documented):
 * - Paths are normalized to POSIX separators and matched against their path
 *   relative to the workspace root.
 * - A pattern WITHOUT a slash matches the BASENAME at any depth — so `.env`
 *   matches `subdir/.env`, `*.key` matches `a/b/secret.key`, `id_rsa*`
 *   matches `config/id_rsa_backup`. This is the behavior the plan requires
 *   ("a bare filename pattern like `.env` should match `.env` at any depth").
 * - A pattern WITH a slash is anchored to the workspace root (gitignore-style)
 *   and matches the full relative path — `config/credentials.key` matches
 *   `config/credentials.key` but not `other/config/credentials.key`.
 * - A pattern ending in `/` protects a directory and everything under it.
 * - `*` matches within one path segment (`[^/]*`), `**` matches across
 *   segments (`.*`), `?` matches one non-`/` character. Matching is
 *   case-sensitive (Linux glob convention).
 */

/** Built-in protected-file default: secrets/credentials an unattended agent
 * must never silently overwrite. Adjust/extend via config, but ship a real
 * default. */
export const DEFAULT_PROTECTED_FILES: string[] = [".env", ".env.*", "*.pem", "*.key", "id_rsa*"]

/** Escape regex metacharacters except the glob wildcards we handle ourselves. */
function escapeRegExp(ch: string): string {
	return "\\^$.[]{}()|+".includes(ch) ? `\\${ch}` : ch
}

/** Convert `*`/`**`/`?` glob wildcards to a regex source (segment-aware). */
function globSource(pattern: string): string {
	let out = ""
	for (let i = 0; i < pattern.length; i++) {
		const ch = pattern[i]
		if (ch === "*") {
			if (pattern[i + 1] === "*") {
				out += ".*"
				i++
			} else {
				out += "[^/]*"
			}
		} else if (ch === "?") {
			out += "[^/]"
		} else {
			out += escapeRegExp(ch)
		}
	}
	return out
}

/** Compile one protected-files pattern to a RegExp (see module header). */
export function patternToRegExp(pattern: string): RegExp {
	// Directory pattern: "secrets/" protects the dir and everything under it.
	if (pattern.endsWith("/")) {
		const dir = globSource(pattern.slice(0, -1))
		return new RegExp(`^${dir}(?:/.*)?$`)
	}
	// Anchored always. No-slash patterns are matched against the basename
	// (findMatchingPattern picks the basename candidate), slash patterns against
	// the full workspace-relative path — but both are full matches, never
	// substring matches (so `.env` matches `.env` but not `.envs` or `.env.local`).
	return new RegExp(`^${globSource(pattern)}$`)
}

/**
 * Return the first pattern in `patternList` that matches `relPath`, or `null`.
 * `relPath` is the workspace-relative path (POSIX separators preferred; `\`
 * is normalized).
 */
export function findMatchingPattern(relPath: string, patternList: string[]): string | null {
	const normalized = relPath.replace(/\\/g, "/")
	for (const pattern of patternList) {
		if (pattern === "") {
			continue
		}
		const hasSlash = pattern.includes("/")
		const candidate = hasSlash ? normalized : normalized.split("/").pop() ?? ""
		if (candidate !== "" && patternToRegExp(pattern).test(candidate)) {
			return pattern
		}
	}
	return null
}

/** True when `relPath` matches any of the protected patterns. */
export function isProtectedPath(relPath: string, patternList: string[]): boolean {
	return findMatchingPattern(relPath, patternList) !== null
}
