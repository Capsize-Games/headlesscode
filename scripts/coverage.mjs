// Coverage percentage for the unit suite: runs scripts/run-tests.mjs under c8
// (V8 coverage, remapped to TypeScript sources) and prints the per-file and
// total statement/branch/function/line percentages.
//
// Scope: src/**/*.ts excluding tests and the vendored tree. Tests measure the
// production code; the vendor tree is upstream code kept verbatim.
// scripts/ CLIs are exercised by scripts/e2e*/run.sh, not by this report.
//
// Usage: node scripts/coverage.mjs [--filter <substring>] [--min <pct>]
//   --min fails (exit 1) when total line coverage is below <pct>; the RSI
//   and refactor gates use this as a no-regression floor.
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

function argValue(flag) {
	const i = process.argv.indexOf(flag)
	return i >= 0 ? process.argv[i + 1] : undefined
}

const filter = argValue("--filter")
const minRaw = argValue("--min")
const min = minRaw === undefined ? undefined : Number(minRaw)
if (minRaw !== undefined && (!Number.isFinite(min) || min < 0 || min > 100)) {
	console.error("coverage: --min must be a number between 0 and 100")
	process.exit(2)
}
const reportDir = path.join(repoRoot, ".headlesscode", "coverage")
// PID-unique temp dir: c8 wipes its temp dir at startup, and this script
// runs nested inside itself (coverage.test.mjs spawns filtered coverage
// runs as part of the suite). A shared tmp/ meant each nested run deleted
// every profile the outer run had collected, collapsing full-suite line
// coverage to ~4.5%. Unique dirs also let concurrent runs coexist.
const tempDir = path.join(reportDir, `tmp-${process.pid}`)

const testArgs = ["scripts/run-tests.mjs"]
if (filter) testArgs.push("--filter", filter)
const result = spawnSync("node_modules/.bin/c8", [
	"--reporter=text",
	"--reporter=json-summary",
	"--reports-dir", reportDir,
	"--temp-directory", tempDir,
	"--all",
	"--src", "src",
	"--exclude", "**/__tests__/**",
	"--exclude", "**/*.test.ts",
	"--exclude", "src/vendor/**",
	"node", ...testArgs,
], { cwd: repoRoot, stdio: "inherit", env: process.env })
// Raw V8 profiles are tens of MB per run; the report is already written by
// now, so remove them on every exit path (pass AND fail) to avoid pile-up.
try {
	fs.rmSync(tempDir, { recursive: true, force: true })
} catch {
	// best-effort — a leftover tmp dir is a disk-space nit, never worth
	// failing the coverage run over.
}
if (result.error) {
	console.error(`coverage: failed to run c8: ${result.error.message}`)
	process.exit(1)
}
if (typeof result.status === "number" && result.status !== 0) {
	process.exit(result.status)
}
const summaryPath = path.join(reportDir, "coverage-summary.json")
let total
try {
	total = JSON.parse(fs.readFileSync(summaryPath, "utf8")).total
} catch {
	console.error("coverage: c8 summary missing, cannot report a percentage")
	process.exit(1)
}
const pct = (v) => `${v.pct}% (${v.covered}/${v.total})`
process.stdout.write(`coverage: lines ${pct(total.lines)} statements ${pct(total.statements)} functions ${pct(total.functions)} branches ${pct(total.branches)}\n`)
if (min !== undefined && total.lines.pct < min) {
	console.error(`coverage: total line coverage ${total.lines.pct}% is below the ${min}% floor`)
	process.exit(1)
}
