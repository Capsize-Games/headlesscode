// Test runner: discovers test files by glob instead of a hand-maintained
// list in package.json's "test" script. That list was one long `&&`-chained
// string naming every file explicitly — any two branches that each added a
// different test file were GUARANTEED to conflict on that exact line at
// merge time (hit on 3 separate PRs in the same session; see issue #26).
// Adding a test file now requires touching zero lines outside the new file
// itself.
//
// Discovery: every `*.test.ts` under src/ (this already covers both
// `__tests__/*.test.ts` dirs and the few top-level `*.test.ts` files, e.g.
// src/index-util.test.ts), run in sorted order for determinism, plus a short
// explicit list of non-test-suffixed check scripts that were previously
// chained in by hand.
//
// Semantics preserved from the old `&&` chain: run sequentially, stop at the
// first failure (fail-fast), exit with that failure's exit code.

import { execFileSync } from "node:child_process"
import * as fs from "node:fs"
import * as path from "node:path"
import { fileURLToPath } from "node:url"

const repoRoot = path.resolve(fileURLToPath(import.meta.url), "..", "..")

/** Non-test-suffixed scripts that ran as part of the old chain. */
const EXTRA_FILES = ["scripts/check-page-script.mjs"]

function findTestFiles(dir) {
	const found = []
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		if (entry.name === "node_modules" || entry.name.startsWith(".")) {
			continue
		}
		const full = path.join(dir, entry.name)
		if (entry.isDirectory()) {
			found.push(...findTestFiles(full))
		} else if (entry.isFile() && entry.name.endsWith(".test.ts")) {
			found.push(full)
		}
	}
	return found
}

function main() {
	const filterArgIndex = process.argv.indexOf("--filter")
	const filter = filterArgIndex >= 0 ? process.argv[filterArgIndex + 1] : undefined

	const srcDir = path.join(repoRoot, "src")
	const discovered = findTestFiles(srcDir)
		.map((f) => path.relative(repoRoot, f))
		.sort()
	const extras = EXTRA_FILES.filter((f) => fs.existsSync(path.join(repoRoot, f)))
	let files = [...discovered, ...extras]

	if (filter) {
		files = files.filter((f) => f.includes(filter))
	}

	if (files.length === 0) {
		process.stderr.write(`run-tests: no test files matched${filter ? ` filter "${filter}"` : ""}\n`)
		process.exit(1)
	}

	process.env.HEADLESSCODE_DATA_DIR = process.env.HEADLESSCODE_DATA_DIR ?? ".headlesscode/test-store"

	process.stdout.write(`run-tests: running ${files.length} file(s)${filter ? ` (filter: "${filter}")` : ""}\n\n`)

	const tsxBin = path.join(repoRoot, "node_modules", ".bin", "tsx")

	for (const file of files) {
		try {
			execFileSync(tsxBin, [file], { cwd: repoRoot, stdio: "inherit", env: process.env })
		} catch (err) {
			process.stderr.write(`\nrun-tests: FAILED at ${file}\n`)
			process.exit(typeof err.status === "number" ? err.status : 1)
		}
	}

	process.stdout.write(`\nrun-tests: all ${files.length} file(s) passed\n`)
}

main()
