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
		"--regression",
		"npm test -- --filter mode-models",
		"--hidden-eval",
		"./hidden-check.sh",
		"--population",
		"3",
	])
	assert.ok(parsed.config)
	assert.equal(parsed.config.dryRun, true)
	assert.deepEqual(parsed.config.evalCommands, ["npm test", "npm run typecheck"])
	assert.equal(parsed.config.regressionCommand, "npm test -- --filter mode-models")
	assert.deepEqual(parsed.config.hiddenEvalCommands, ["./hidden-check.sh"])
	assert.equal(parsed.config.population, 3)
}

function testUnknownFlagIsUsageError(): void {
	const parsed = parseRsiArgs(["--wat"])
	assert.match(parsed.error ?? "", /unknown improve argument/)
}

function testRegressionCommandCannotBeEmpty(): void {
	const parsed = parseRsiArgs(["--repo", "/tmp/repo", "--regression", "  "])
	assert.match(parsed.error ?? "", /--regression must not be empty/)
}

function testRoleRoutingIsProviderIndependent(): void {
	const roles = resolveRoles(undefined, {
		HEADLESSCODE_RSI_ROLE_CRITIC_MODEL: "critic-model",
		HEADLESSCODE_RSI_ROLE_ADVERSARY_MODEL: "review-model",
		HEADLESSCODE_RSI_ROLE_ADVERSARY_PROVIDER: "openrouter",
		HEADLESSCODE_RSI_ROLE_ADVERSARY_BASE_URL: "https://router.example.invalid",
	}, DEFAULT_RSI_MODEL)
	assert.equal(roles.worker?.provider, "ollama")
	assert.equal(roles.worker?.model, DEFAULT_RSI_MODEL)
	assert.equal(roles.critic?.model, "critic-model")
	assert.equal(roles.adversary?.model, "review-model")
	assert.equal(roles.adversary?.provider, "openrouter")
	assert.equal(roles.adversary?.baseUrl, "https://router.example.invalid")
}

function testAdaptivePolicyHasExplicitBudgets(): void {
	const defaults = parseRsiArgs(["--repo", "/tmp/repo", "--compute-policy", "adaptive-independent"])
	assert.equal(defaults.config?.generations, 1, "one configured adaptive generation permits one follow-up stage")
	const parsed = parseRsiArgs(["--repo", "/tmp/repo", "--compute-policy", "adaptive-independent", "--population", "3", "--max-iterations", "5", "--max-trajectories", "4", "--max-total-iterations", "20", "--max-runtime-ms", "90000"])
	assert.ok(parsed.config)
	assert.equal(parsed.config.maxTrajectories, 4)
	assert.equal(parsed.config.maxTotalIterations, 20)
	assert.equal(parsed.config.maxRuntimeMs, 90_000)
	assert.match(parseRsiArgs(["--repo", "/tmp/repo", "--compute-policy", "adaptive-independent", "--population", "3", "--max-trajectories", "2"]).error ?? "", /must cover the initial --population/)
	assert.match(parseRsiArgs(["--repo", "/tmp/repo", "--compute-policy", "adaptive-independent", "--max-trajectories", "4"]).error ?? "", /at most one follow-up/)
	assert.match(parseRsiArgs(["--repo", "/tmp/repo", "--compute-policy", "adaptive-independent", "--generations", "2"]).error ?? "", /exactly one follow-up generation/)
	assert.match(parseRsiArgs(["--repo", "/tmp/repo", "--compute-policy", "adaptive-independent", "--max-total-iterations", "200"]).error ?? "", /cannot exceed max-iterations times max-trajectories/)
	assert.match(parseRsiArgs(["--repo", "/tmp/repo", "--compute-policy", "adaptive-independent", "--population", "1"]).error ?? "", /population of at least 2/)
	assert.match(parseRsiArgs(["--repo", "/tmp/repo", "--compute-policy", "adaptive-independent", "--max-total-iterations", "40"]).error ?? "", /cover the initial population/)
}

function testEngineeringOnlyHarnessRequiresPairedDevelopmentRun(): void {
	assert.match(parseRsiArgs(["--repo", "/tmp/repo", "--worker-harness-engineering-only"]).error ?? "", /requires an explicit paired campaign ID and arm/)
	assert.match(parseRsiArgs(["--repo", "/tmp/repo", "--worker-harness-mode", "fixed-control", "--worker-harness-pair-id", "engineering", "--worker-harness-engineering-only", "--worker-harness-phase", "confirmation"]).error ?? "", /only the development phase/)
	const parsed = parseRsiArgs(["--repo", "/tmp/repo", "--worker-harness-mode", "fixed-control", "--worker-harness-pair-id", "engineering", "--worker-harness-engineering-only"])
	assert.equal(parsed.config?.workerHarnessEngineeringOnly, true)
}

const tests = [
	["defaults select local Qwen", testDefaultsUseLocalQwen],
	["dry-run and evaluation commands parse", testDryRunAndCommandsParse],
	["unknown flags return usage errors", testUnknownFlagIsUsageError],
	["empty regression command is rejected", testRegressionCommandCannotBeEmpty],
	["role routing resolves configured critic models", testRoleRoutingIsProviderIndependent],
	["adaptive trajectories require explicit bounded capacity", testAdaptivePolicyHasExplicitBudgets],
	["engineering-only mode requires a paired development run", testEngineeringOnlyHarnessRequiresPairedDevelopmentRun],
] as const

for (const [name, test] of tests) {
	test()
	console.log(`  ok   ${name}`)
}
console.log(`All ${tests.length} RSI config tests passed`)
