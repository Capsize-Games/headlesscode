/**
 * Shared assert-style test runner (issue #138). Every `*.test.ts` file
 * used to inline the same ~20-line main() loop; the copies were flagged
 * as clone groups by the architecture gate. New and migrated files end
 * with a single line instead:
 *
 *   import { runMain } from "../../test-runner.js"
 *   runMain("my-module", tests)
 *
 * Semantics are the established house pattern: per-test try/catch,
 * `  ok   <name>` / `  FAIL <name>` + stack lines, and an
 * `All N <label> tests passed` summary (the label segment is omitted
 * when empty, matching the labelless files). runSuites returns the
 * failure count WITHOUT exiting so files with teardown can run it
 * first (`const failed = await runSuites(...)`) — runMain exits 1.
 */

/** One test case: sync or async, either is awaited. */
export type SuiteFn = () => void | Promise<void>

/** One [name, fn] row; readonly so `as const` tables pass unchanged. */
export type SuiteTest = readonly [string, SuiteFn]

/**
 * Run every row, logging per-test results plus the closing summary or
 * failure count. Returns the number of failed tests; never exits, so
 * callers with teardown can sequence it before their own exit.
 */
async function runOne(name: string, fn: SuiteFn): Promise<boolean> {
	try {
		await fn()
		console.log(`  ok   ${name}`)
		return true
	} catch (err) {
		console.error(`  FAIL ${name}`)
		const detail = err instanceof Error ? (err.stack ?? err.message) : String(err)
		console.error(detail)
		return false
	}
}

export async function runSuites(
	label: string,
	tests: readonly SuiteTest[],
): Promise<number> {
	let failed = 0
	for (const [name, fn] of tests) {
		if (!(await runOne(name, fn))) {
			failed++
		}
	}
	if (failed > 0) {
		console.error(`\n${failed} test(s) failed`)
		return failed
	}
	const scope = label === "" ? "" : ` ${label}`
	console.log(`\nAll ${tests.length}${scope} tests passed`)
	return 0
}

/**
 * File entry point: run the suite, exiting 1 on any failure, and
 * converting an unexpected crash (outside any single test) into a
 * loud message + exit 1.
 */
export function runMain(label: string, tests: readonly SuiteTest[]): void {
	runSuites(label, tests).then(
		(failed) => {
			if (failed > 0) {
				process.exit(1)
			}
		},
		(err: unknown) => {
			console.error("Test runner crashed:", err)
			process.exit(1)
		},
	)
}
