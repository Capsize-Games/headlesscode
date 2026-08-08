/**
 * Language → language-server registry (issue #59).
 *
 * The extension seam that makes "ANY language with a real language server
 * can plug in" concrete: one entry per language maps the language to the
 * command that starts its server. The registry is deliberately tiny — only
 * languages we can actually TEST are wired:
 *
 *   - `python` → pyright, BUNDLED as a real npm dependency (it ships a
 *     `pyright-langserver` binary), so Python code-intelligence works for
 *     every user with zero extra install. This directly closes the gap that
 *     motivated the plan (a Python-only workspace previously got NONE of the
 *     six code-intel tools).
 *
 * Adding another language is one entry:
 *
 *   rust: { command: "rust-analyzer", args: [], rootMarkers: ["Cargo.toml"] }
 *   go:   { command: "gopls",          args: [], rootMarkers: ["go.mod"] }
 *
 * ...plus a row in `detectWorkspaceLanguages` (src/tools/language-detect.ts)
 * if the language isn't already detected, and a test. Servers that can't be
 * tested are deliberately NOT built out (per the plan).
 *
 * `rootMarkers` is informational today (the service is already scoped to one
 * workspace root); it documents the files a future per-subproject-root
 * implementation would search for when the server needs a narrower cwd.
 */

import { createRequire } from "node:module"

const require = createRequire(import.meta.url)

/** A language server's spawn config (argv + the markers that identify its root). */
export interface LanguageServerSpec {
	command: string
	args: string[]
	rootMarkers: string[]
}

/** Resolve the bundled pyright-langserver entry (throws when not installed). */
export function resolvePyrightLangserver(): string {
	// pyright (npm) declares its pyright-langserver bin as
	// "langserver.index.js" at the package root. require.resolve walks up the
	// module graph exactly like the rest of the toolchain, so this works both
	// in this repo and in any install that ran `npm install`.
	return require.resolve("pyright/langserver.index.js")
}

/**
 * The wired servers. `command` for python is resolved lazily via
 * require.resolve (a hard dependency, so it always succeeds post-install; a
 * missing install → unresolvable → the language simply has no backend, which
 * the executor treats exactly like today's "no TS workspace" case).
 */
export const LANGUAGE_SERVERS: Record<string, LanguageServerSpec> = {
	python: {
		command: resolvePyrightLangserver(),
		args: ["--stdio"],
		rootMarkers: ["pyproject.toml", "setup.py", "setup.cfg", "requirements.txt", "Pipfile"],
	},
}
