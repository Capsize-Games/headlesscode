/**
 * Unit tests for the CLI-env leaf (src/cli-env.ts, issue #128).
 *
 * resolvePerModeEnv/envBooleanValue/envBoolean move out of src/cli.ts so
 * orchestrator/cli, reviewer, qa, and pipeline can share them without an
 * import cycle back into the root CLI (cli.ts statically imports
 * orchestrator/cli for the `orchestrate` subcommand). cli.ts keeps
 * re-exporting the same names for backward compatibility.
 *
 * Plain assert-based script (no test framework), run via `npm test` →
 * `tsx src/__tests__/cli-env.test.ts`.
 */

import assert from "node:assert/strict"

import { envBoolean, envBooleanValue, resolvePerModeEnv } from "../cli-env.js"
import {
	envBoolean as cliEnvBoolean,
	envBooleanValue as cliEnvBooleanValue,
	resolvePerModeEnv as cliResolvePerModeEnv,
} from "../cli.js"

async function testPerModeOverrideWins(): Promise<void> {
	const env = { HEADLESSCODE_FOO: "global", HEADLESSCODE_FOO__CODE: "per-mode" }
	assert.equal(resolvePerModeEnv("HEADLESSCODE_FOO", "code", env), "per-mode")
}

async function testGlobalFallsBack(): Promise<void> {
	const env = { HEADLESSCODE_FOO: "global" }
	assert.equal(resolvePerModeEnv("HEADLESSCODE_FOO", "code", env), "global")
}

async function testModeSlugNormalization(): Promise<void> {
	const env = { HEADLESSCODE_FOO__DEEPSEEK_REVIEWER: "review" }
	assert.equal(resolvePerModeEnv("HEADLESSCODE_FOO", "deepseek-reviewer", env), "review")
}

async function testMissingIsUndefined(): Promise<void> {
	assert.equal(resolvePerModeEnv("HEADLESSCODE_DEFINITELY_MISSING", "code", {}), undefined)
}

async function testEnvBooleanValues(): Promise<void> {
	for (const truthy of ["1", "true", "TRUE", "yes", "on", " On "]) {
		assert.equal(envBooleanValue("FLAG", { FLAG: truthy }), true, `${truthy} must be true`)
	}
	for (const falsy of ["0", "false", "no", "off", "", "maybe"]) {
		assert.equal(envBooleanValue("FLAG", { FLAG: falsy }), false, `${falsy || "(empty)"} must be false`)
	}
	assert.equal(envBooleanValue("FLAG", {}), false)
}

async function testCliReexportsTheLeaf(): Promise<void> {
	assert.equal(cliResolvePerModeEnv, resolvePerModeEnv)
	assert.equal(cliEnvBooleanValue, envBooleanValue)
	assert.equal(cliEnvBoolean, envBoolean)
}

async function main(): Promise<void> {
	const tests: Array<[string, () => Promise<void>]> = [
		["per-mode override wins", testPerModeOverrideWins],
		["global falls back", testGlobalFallsBack],
		["mode slug normalization", testModeSlugNormalization],
		["missing is undefined", testMissingIsUndefined],
		["env boolean values", testEnvBooleanValues],
		["cli re-exports the leaf", testCliReexportsTheLeaf],
	]

	let failed = 0
	for (const [name, fn] of tests) {
		try {
			await fn()
			console.log(`  ok   ${name}`)
		} catch (error) {
			failed++
			console.error(`  FAIL ${name}`)
			console.error(error instanceof Error ? (error.stack ?? error.message) : String(error))
		}
	}
	if (failed > 0) {
		console.error(`\n${failed} test(s) failed`)
		process.exit(1)
	}
	console.log(`\nAll ${tests.length} cli-env tests passed`)
}

main().catch((error) => {
	console.error("Test runner crashed:", error)
	process.exit(1)
})
