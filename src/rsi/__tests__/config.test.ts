import assert from "node:assert/strict"
import { DEFAULT_RSI_MODEL, parseRsiArgs } from "../config.js"
import { resolveRoles } from "../roles.js"

function testDefaultsUseLocalQwen(): void {
	const parsed = parseRsiArgs(["--repo", "/tmp/repo"])
	assert.ok(parsed.config)
	assert.equal(parsed.config.model, DEFAULT_RSI_MODEL)
	assert.equal(parsed.config.population, 2)
	assert.equal(parsed.config.generations, 1)
}

function testDryRunAndCommandsParse(): void {
	const parsed = parseRsiArgs([
		"--repo",
		"/tmp/repo",
		"--dry-run",
		"--eval",
		"npm test;;npm run typecheck",
		"--hidden-eval",
		"./hidden-check.sh",
		"--population",
		"3",
	])
	assert.ok(parsed.config)
	assert.equal(parsed.config.dryRun, true)
	assert.deepEqual(parsed.config.evalCommands, ["npm test", "npm run typecheck"])
	assert.deepEqual(parsed.config.hiddenEvalCommands, ["./hidden-check.sh"])
	assert.equal(parsed.config.population, 3)
}

function testUnknownFlagIsUsageError(): void {
	const parsed = parseRsiArgs(["--wat"])
	assert.match(parsed.error ?? "", /unknown improve argument/)
}

function testRoleRoutingIsProviderIndependent(): void {
	const roles = resolveRoles(undefined, { HEADLESSCODE_RSI_ROLE_CRITIC_MODEL: "critic-model" }, DEFAULT_RSI_MODEL)
	assert.equal(roles.worker?.provider, "ollama")
	assert.equal(roles.worker?.model, DEFAULT_RSI_MODEL)
	assert.equal(roles.critic?.model, "critic-model")
}

const tests = [
	["defaults select local Qwen", testDefaultsUseLocalQwen],
	["dry-run and evaluation commands parse", testDryRunAndCommandsParse],
	["unknown flags return usage errors", testUnknownFlagIsUsageError],
	["role routing resolves configured critic models", testRoleRoutingIsProviderIndependent],
] as const

for (const [name, test] of tests) {
	test()
	console.log(`  ok   ${name}`)
}
console.log(`All ${tests.length} RSI config tests passed`)
