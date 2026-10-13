// Self-test for scripts/coverage.mjs: exercises the floor logic and the
// percentage report on a tiny filtered run (claims tests, a few seconds)
// instead of the full suite. Exit 1 with a clear message on any mismatch.
import { execFileSync } from "node:child_process"
import path from "node:path"
import { fileURLToPath } from "node:url"

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

function runCoverage(args) {
	try {
		const out = execFileSync("node", ["scripts/coverage.mjs", ...args], {
			cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
		})
		return { status: 0, out }
	} catch (error) {
		return { status: error.status ?? 1, out: `${error.stdout ?? ""}${error.stderr ?? ""}` }
	}
}

function fail(message) {
	console.error(`FAIL coverage-selftest: ${message}`)
	process.exit(1)
}

const filter = ["--filter", "watcher/__tests__/claims.test.ts"]
const pass = runCoverage([...filter, "--min", "0"])
if (pass.status !== 0) fail(`--min 0 run failed (status ${pass.status})`)
if (!/^coverage: lines \d+(\.\d+)?% \(\d+\/\d+\)/m.test(pass.out)) {
	fail("percentage summary line missing or malformed")
}
const floor = runCoverage([...filter, "--min", "100"])
if (floor.status === 0) fail("--min 100 unexpectedly passed")
if (!/below the 100% floor/.test(floor.out)) fail("floor-failure message missing")
const invalid = runCoverage(["--min", "abc"])
if (invalid.status !== 2) fail(`invalid --min exited ${invalid.status}, want 2`)
console.log("  ok   coverage-selftest: summary line, floor pass/fail, invalid arg")
