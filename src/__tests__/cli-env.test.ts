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
import { runMain } from "../test-runner.js"

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
	const out = resolvePerModeEnv("HEADLESSCODE_FOO", "deepseek-reviewer", env)
	assert.equal(out, "review")
}

async function testMissingIsUndefined(): Promise<void> {
	const out = resolvePerModeEnv("HEADLESSCODE_DEFINITELY_MISSING", "code", {})
	assert.equal(out, undefined)
}

async function testEnvBooleanValues(): Promise<void> {
	for (const truthy of ["1", "true", "TRUE", "yes", "on", " On "]) {
		const got = envBooleanValue("FLAG", { FLAG: truthy })
		assert.equal(got, true, `${truthy} → true`)
	}
	for (const falsy of ["0", "false", "no", "off", "", "maybe"]) {
		const label = falsy || "(empty)"
		const got = envBooleanValue("FLAG", { FLAG: falsy })
		assert.equal(got, false, `${label} → false`)
	}
	assert.equal(envBooleanValue("FLAG", {}), false)
}

async function testCliReexportsTheLeaf(): Promise<void> {
	assert.equal(cliResolvePerModeEnv, resolvePerModeEnv)
	assert.equal(cliEnvBooleanValue, envBooleanValue)
	assert.equal(cliEnvBoolean, envBoolean)
}

const tests: Array<[string, () => Promise<void>]> = [
	["per-mode override wins", testPerModeOverrideWins],
	["global falls back", testGlobalFallsBack],
	["mode slug normalization", testModeSlugNormalization],
	["missing is undefined", testMissingIsUndefined],
	["env boolean values", testEnvBooleanValues],
	["cli re-exports the leaf", testCliReexportsTheLeaf],
]

runMain("cli-env", tests)
