import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { execFileSync } from "node:child_process"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import test from "node:test"
import { fleetCampaignRsiPlanDigest, preflightFleetCampaignRsi, readMonitorInferenceDisabled, runAuthorizedFleetCampaignRsi, type FleetCampaignRsiPlan } from "../fleet-campaign.js"

function plan(): FleetCampaignRsiPlan {
	const unsigned = {
		schemaVersion: 1 as const,
		campaignId: "fleet-synthetic-intake",
		repoRoot: "/tmp/fleet-synthetic",
		baseCommit: "a".repeat(40),
		campaignFixtures: { root: "/tmp/fleet-synthetic", manifestSha256: "b".repeat(64) },
		harnessCommit: "1".repeat(40),
		dependencyLockSha256: "2".repeat(64),
		runtimeImageDigest: `sha256:${"3".repeat(64)}` as `sha256:${string}`,
		evaluatorImageDigest: `sha256:${"c".repeat(64)}` as `sha256:${string}`,
		evaluatorPolicySha256: "d".repeat(64),
		inferenceLimits: { maxCalls: 3, maxInputTokensPerCall: 32_000, maxOutputTokensPerCall: 4_000, maxTotalTokens: 108_000,
			maxCallSpendUsd: 0.01, maxJobSpendUsd: 0.02, maxCampaignSpendUsd: 0.02, mutationBudgetUsd: 0.019,
			benchmarkBudgetUsd: 0.001, maxInputPricePerMillionUsd: 0.1, maxOutputPricePerMillionUsd: 0.2 } as const,
		objective: "intake-parsing" as const,
		allowedMutationPaths: ["candidate.py"] as const,
		regressionCommand: "python3 -m unittest test_intake",
		evalCommands: ["python3 -m unittest test_intake.CampaignCases.test_parse", "python3 -m unittest test_intake.CampaignCases.test_deduplicate", "python3 -m unittest test_intake.CampaignCases.test_recovery", "python3 -m unittest test_intake.CampaignCases.test_report"],
		typecheckCommand: "python3 -c \"compile(open('candidate.py').read(), 'candidate.py', 'exec')\"",
		maxSpendUsd: 0.02,
		maxDurationMs: 300_000,
		maxWorkerIterations: 3 as const,
	}
	return { ...unsigned, planDigest: fleetCampaignRsiPlanDigest(unsigned) }
}

test("Fleet RSI plan digest is canonical and stale pins fail before preflight probes", async () => {
	const value = plan()
	const reordered = { ...value, campaignFixtures: { manifestSha256: value.campaignFixtures.manifestSha256, root: value.campaignFixtures.root } }
	assert.equal(fleetCampaignRsiPlanDigest(Object.fromEntries(Object.entries(reordered).filter(([key]) => key !== "planDigest")) as Omit<FleetCampaignRsiPlan, "planDigest">), value.planDigest)
	let probes = 0
	const stale = { ...value, baseCommit: "e".repeat(40) }
	const result = await preflightFleetCampaignRsi(stale, { env: {}, sharedBudgetLedgerReady: async () => { probes += 1; return true } })
	assert.equal(result.ready, false)
	assert.deepEqual(result.checks.map((check) => check.id), ["frozen-plan"])
	assert.equal(probes, 0)
})

test("plan binds image, harness, lockfile, and exact provider ceilings", async () => {
	const value = plan()
	const env: NodeJS.ProcessEnv = {
		HEADLESSCODE_RSI_OPENROUTER_MAX_CAMPAIGN_SPEND_USD: "0.02",
		HEADLESSCODE_RSI_OPENROUTER_MUTATION_BUDGET_USD: "0.019",
		HEADLESSCODE_RSI_OPENROUTER_BENCHMARK_BUDGET_USD: "0.001",
		HEADLESSCODE_RSI_OPENROUTER_MAX_CALLS: "3",
		HEADLESSCODE_RSI_OPENROUTER_MAX_INPUT_TOKENS_PER_CALL: "32000",
		HEADLESSCODE_RSI_OPENROUTER_MAX_OUTPUT_TOKENS_PER_CALL: "4000",
		HEADLESSCODE_RSI_OPENROUTER_MAX_TOTAL_TOKENS: "108000",
		HEADLESSCODE_RSI_OPENROUTER_MAX_CALL_SPEND_USD: "0.01",
		HEADLESSCODE_RSI_OPENROUTER_MAX_JOB_SPEND_USD: "0.02",
		HEADLESSCODE_RSI_OPENROUTER_MAX_INPUT_PRICE_PER_MILLION_USD: "0.1",
		HEADLESSCODE_RSI_OPENROUTER_MAX_OUTPUT_PRICE_PER_MILLION_USD: "0.2",
		HEADLESSCODE_RSI_OPENROUTER_MAX_DURATION_MS: "300000",
	}
	const readyCaps = await preflightFleetCampaignRsi(value, { env })
	assert.equal(readyCaps.checks.find((check) => check.id === "spend-ceiling")?.state, "ready")
	env.HEADLESSCODE_RSI_OPENROUTER_MAX_CALLS = "4"
	const changedCaps = await preflightFleetCampaignRsi(value, { env })
	assert.equal(changedCaps.checks.find((check) => check.id === "spend-ceiling")?.state, "missing")
	assert.equal(changedCaps.checks.find((check) => check.id === "harness-runtime")?.state, "invalid")
})

test("Fleet RSI execution requires independent exact-plan authorization", async () => {
	let executed = false
	await assert.rejects(runAuthorizedFleetCampaignRsi(plan(), { planDigest: "wrong" }, {
		verifyPlanCheckpoint: async () => false,
		execute: async () => { executed = true; throw new Error("should not execute") },
	}), /root-recorded execution checkpoint/)
	assert.equal(executed, false)
})

test("monitor readiness accepts only a protected local assessment that disables inference", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "fleet-rsi-monitor-gate-"))
	const configPath = path.join(root, "assessment.json")
	const uid = typeof process.getuid === "function" ? process.getuid() : 0
	try {
		await fs.writeFile(configPath, JSON.stringify({ model_enabled: false }), { mode: 0o600 })
		assert.equal(await readMonitorInferenceDisabled(configPath, uid, uid), true)
		await fs.writeFile(configPath, JSON.stringify({ model_enabled: true }))
		assert.equal(await readMonitorInferenceDisabled(configPath, uid, uid), false)
		await fs.writeFile(configPath, JSON.stringify({ model_enabled: false }))
		await fs.chmod(configPath, 0o662)
		assert.equal(await readMonitorInferenceDisabled(configPath, uid, uid), false)
		await fs.chmod(configPath, 0o600)
		const linkPath = path.join(root, "assessment-link.json")
		await fs.symlink(configPath, linkPath)
		assert.equal(await readMonitorInferenceDisabled(linkPath, uid, uid), false)
	} finally { await fs.rm(root, { recursive: true, force: true }) }
})

test("campaign fixture preflight pins manifest and every candidate/test/corpus file", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "fleet-rsi-fixtures-"))
	try {
		const candidate = "def parse_record(raw):\n    return raw\n"
		const tests = "# fixed public toy tests\n"
		const corpus = "{\"event\":\"toy\"}\n"
		await fs.writeFile(path.join(root, "candidate.py"), candidate)
		await fs.writeFile(path.join(root, "test_intake.py"), tests)
		await fs.writeFile(path.join(root, "fixtures.json"), corpus)
		const commands = ["parse", "deduplicate", "recovery", "report"].map((name) => `python3 -m unittest test_intake.CampaignCases.test_${name}`)
		const digest = (value: string | Buffer) => createHash("sha256").update(value).digest("hex")
		const manifest = { schemaVersion: 1, objective: "intake-parsing", candidatePath: "candidate.py", testsPath: "test_intake.py", corpusPath: "fixtures.json", candidateSha256: digest(candidate), testsSha256: digest(tests), corpusSha256: digest(corpus), commands }
		const rawManifest = `${JSON.stringify(manifest, null, 2)}\n`
		await fs.writeFile(path.join(root, "manifest.json"), rawManifest)
		execFileSync("git", ["init", "-q"], { cwd: root })
		execFileSync("git", ["config", "user.email", "fixture@example.invalid"], { cwd: root })
		execFileSync("git", ["config", "user.name", "Fixture"], { cwd: root })
		execFileSync("git", ["add", "."], { cwd: root })
		execFileSync("git", ["commit", "-qm", "fixture"], { cwd: root })
		const { planDigest: _baseDigest, ...base } = plan()
		const policy = await fs.readFile(path.resolve("shared/openshell/headlesscode-policy.yaml"))
		const unsigned = { ...base, repoRoot: root, baseCommit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(), campaignFixtures: { root, manifestSha256: digest(rawManifest) }, evaluatorPolicySha256: digest(policy), evalCommands: commands }
		const value = { ...unsigned, planDigest: fleetCampaignRsiPlanDigest(unsigned) }
		const readiness = await preflightFleetCampaignRsi(value, { env: { PATH: "" } })
		assert.equal(readiness.checks.find((check) => check.id === "campaign-fixtures")?.state, "ready", JSON.stringify(readiness.checks))
		await fs.writeFile(path.join(root, "fixtures.json"), "changed")
		const changed = await preflightFleetCampaignRsi(value, { env: { PATH: "" } })
		assert.equal(changed.checks.find((check) => check.id === "campaign-fixtures")?.state, "invalid")
	} finally {
		await fs.rm(root, { recursive: true, force: true })
	}
})
