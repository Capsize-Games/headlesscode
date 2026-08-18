#!/usr/bin/env node
/**
 * headlesscode bin launcher (issue #99).
 *
 * npm's `bin` entry used to point at `src/cli.ts`, whose shebang is
 * `#!/usr/bin/env tsx` — but tsx is a devDependency, so on a clean
 * `npm install -g` (which installs dependencies only) `env` finds no `tsx`
 * on PATH and every invocation fails with "tsx: not found".
 *
 * This launcher fixes that by resolving THIS package's own node_modules/tsx
 * directly (the same ancestor walk-up `scripts/run-tests.mjs` uses — npm
 * flattens node_modules, so tsx may live in this package's node_modules OR
 * be hoisted to an ancestor's) and re-execing node through tsx's CLI entry.
 * It also pins TSX_TSCONFIG_PATH to this package's tsconfig.json so tsx
 * resolves the package's own tsconfig instead of discovering one from the
 * caller's CWD (the tsconfig now has no `paths` aliases — issue #99 rework —
 * but the pin keeps the package's compiler options, e.g. `moduleResolution`,
 * stable regardless of where the CLI is invoked from).
 *
 * A small amount of JS (not TS) on purpose: the launcher must run without
 * tsx — the whole point is that it finds tsx itself.
 */

import { spawnSync } from "node:child_process"
import * as fs from "node:fs"
import * as path from "node:path"
import { fileURLToPath } from "node:url"

/** This package's root (the directory above bin/). */
const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")

/**
 * Resolve the tsx CLI entry by walking up through ancestor `node_modules`
 * directories — the same resolution Node's own module lookup (and
 * `scripts/run-tests.mjs`) uses. npm hoists dependencies to the nearest
 * ancestor node_modules, so the tsx binary may sit at
 * `<pkgRoot>/node_modules/tsx/dist/cli.mjs` (repo checkout, nested install)
 * or at an ancestor's (a global install or a consumer with a flat tree).
 */
function resolveTsxCli(dir) {
	let current = dir
	while (true) {
		const candidate = path.join(current, "node_modules", "tsx", "dist", "cli.mjs")
		if (fs.existsSync(candidate)) {
			return candidate
		}
		const parent = path.dirname(current)
		if (parent === current) {
			return undefined
		}
		current = parent
	}
}

const tsxCli = resolveTsxCli(PKG_ROOT)
if (tsxCli === undefined) {
	process.stderr.write(
		"headlesscode: cannot find the 'tsx' runtime (node_modules/tsx/dist/cli.mjs) — " +
			"this package's dependencies are not installed. Run `npm install` (or re-install the package) and retry.\n",
	)
	process.exit(1)
}

const cliEntry = path.join(PKG_ROOT, "src", "cli.ts")
const tsconfigPath = path.join(PKG_ROOT, "tsconfig.json")

// Run the CLI through tsx in a child process with inherited stdio. The
// caller's cwd is preserved (headlesscode's own --repo/--workspace default
// to process.cwd(), matching install-cli.sh's wrapper contract). TSX_TSCONFIG_PATH
// pins tsconfig resolution to THIS package, independent of the cwd.
const result = spawnSync(
	process.execPath,
	[tsxCli, cliEntry, ...process.argv.slice(2)],
	{ stdio: "inherit", env: { ...process.env, TSX_TSCONFIG_PATH: tsconfigPath } },
)

if (result.error) {
	process.stderr.write(`headlesscode: failed to launch the CLI: ${result.error.message}\n`)
	process.exit(1)
}
// Propagate the CLI's exit code; a signal-killed child becomes a non-zero
// exit here (the launcher itself has no signal handlers installed).
process.exit(result.status ?? 1)
