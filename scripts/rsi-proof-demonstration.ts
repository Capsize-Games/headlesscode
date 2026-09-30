import { createHash } from "node:crypto"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import { execFileSync } from "node:child_process"
import { fileURLToPath, pathToFileURL } from "node:url"
import { loadBenchmark } from "../src/rsi/benchmark/runner.js"
import { parseRsiArgs } from "../src/rsi/config.js"
import { fetchPinnedOpenRouterEndpointPrice, openRouterAllocatedEnvironment, openRouterBrokerLimitsFromEnvironment, RSI_OPENROUTER_MODEL } from "../src/rsi/inference-broker.js"
import { freezeProofDemonstrationManifest, frozenProofConfigDigest, verifyFrozenProofDemonstrationManifest } from "../src/rsi/proof-demonstration-manifest.js"
import { planProofDemonstration } from "../src/rsi/proof-demonstration-plan.js"
import { workerHarnessRuntimeIdentityFromEnvironment } from "../src/rsi/worker-harness.js"

interface Options {
	command: "estimate" | "plan" | "verify"
	output: string
	repo: string
	operatorCapUsd?: number
	seeds: string[]
	mutationTask: string
}

type ProofPlanPreview = Omit<Parameters<typeof freezeProofDemonstrationManifest>[0], "operatorCapUsd"> & { plan: ReturnType<typeof planProofDemonstration> }

function usage(): string {
	return `Usage:
  npx tsx scripts/rsi-proof-demonstration.ts estimate --seed <engineering> --campaign-seed <seed> --campaign-seed <seed> --campaign-seed <seed> [--repo <path>]
  npx tsx scripts/rsi-proof-demonstration.ts plan --operator-cap-usd <USD> --seed <engineering> --campaign-seed <seed> --campaign-seed <seed> --campaign-seed <seed> [--out <path>] [--repo <path>]
  npx tsx scripts/rsi-proof-demonstration.ts verify --plan <path>

Estimate and plan perform pricing metadata GETs only; they do not submit model inference.
Estimate prints reservations without assuming an operator cap. Plan requires a clean root
checkout, frozen runtime image identity, explicit broker ceilings, four distinct seeds, and
a supplied operator cap covering all four campaign reservations.
`
}

function parse(argv: string[]): Options {
	const command = argv[0]
	if (command !== "estimate" && command !== "plan" && command !== "verify") throw new Error("expected estimate, plan or verify")
	const options: Options = { command, output: path.resolve(".headlesscode/rsi-proof/plan.json"), repo: process.cwd(), seeds: [], mutationTask: "Improve headlesscode agent reliability on the frozen development benchmark while preserving existing behavior." }
	for (let index = 1; index < argv.length; index++) {
		const arg = argv[index]!
		if (arg === "--help" || arg === "-h") throw new Error(usage())
		const value = argv[index + 1]
		if (!value || value.startsWith("--")) throw new Error(`${arg} requires a value`)
		if (arg === "--out" || arg === "--plan") options.output = path.resolve(value)
		else if (arg === "--repo") options.repo = path.resolve(value)
		else if (arg === "--operator-cap-usd") options.operatorCapUsd = Number(value)
		else if (arg === "--seed" || arg === "--campaign-seed") options.seeds.push(value)
		else if (arg === "--mutation-task") options.mutationTask = value
		else throw new Error(`unknown option ${arg}`)
		index++
	}
	return options
}

export async function assertSupervisorOnlyPlanPath(repoRoot: string, output: string): Promise<string> {
	const repo = await fs.realpath(repoRoot)
	const absolute = path.resolve(output)
	const segments = absolute.slice(path.parse(absolute).root.length).split(path.sep).filter(Boolean)
	let current = path.parse(absolute).root
	for (const segment of segments.slice(0, -1)) {
		current = path.join(current, segment)
		try { if ((await fs.lstat(current)).isSymbolicLink()) throw new Error("frozen plan path may not pass through a symlink") }
		catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error }
	}
	const relative = path.relative(repo, absolute)
	if (relative && !relative.startsWith(`..${path.sep}`) && relative !== "..") {
		if (!relative.startsWith(`${path.join(".headlesscode", "rsi-proof")}${path.sep}`)) throw new Error("frozen plan must be outside the source repository or under ignored .headlesscode/rsi-proof")
		try { execFileSync("git", ["check-ignore", "--quiet", "--", relative], { cwd: repo, stdio: "ignore" }) }
		catch { throw new Error("frozen plan path is not Git-ignored") }
	}
	return absolute
}

function sha256(value: string | Buffer): string { return createHash("sha256").update(value).digest("hex") }
function canonicalHash(value: unknown): string { return sha256(JSON.stringify(value)) }

function campaignId(seed: string): string { return `rsi-proof-${sha256(seed).slice(0, 20)}` }

async function analysisDigest(repo: string): Promise<string> {
	const sources = [
		"src/rsi/development-proof.ts", "src/rsi/proof-campaign.ts", "src/rsi/proof-confirmation.ts",
		"src/rsi/proof-demonstration.ts", "src/rsi/proof-demonstration-plan.ts", "src/rsi/proof-demonstration-manifest.ts",
		"src/rsi/controller.ts", "scripts/rsi-proof-demonstration.ts",
	]
	const hash = createHash("sha256")
	for (const relative of sources) hash.update(relative).update("\0").update(await fs.readFile(path.join(repo, relative))).update("\0")
	return hash.digest("hex")
}

async function ensureCleanRoot(repo: string): Promise<string> {
	const status = execFileSync("git", ["status", "--porcelain=v1", "--untracked-files=all"], { cwd: repo, encoding: "utf8" })
	if (status.trim()) throw new Error("plan requires a clean root checkout; commit or remove tracked and untracked changes first")
	return execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim()
}

function parseUsd(value: number | undefined): number {
	if (value === undefined || !Number.isFinite(value) || value <= 0) throw new Error("--operator-cap-usd must be a positive finite amount")
	return Math.floor(value * 1_000_000) / 1_000_000
}

function formatPlan(preview: ProofPlanPreview, operatorCapUsd?: number, digestSha256?: string): string {
	const { plan } = preview
	return [
		`${digestSha256 ? `Frozen proof plan ${digestSha256}` : "Read-only proof plan estimate (not frozen)"}`,
		`Root commit: ${preview.rootCommit}`,
		`Benchmark manifest: ${preview.benchmarkManifestSha256}`,
		`Model: ${preview.model.requestedId} (endpoint: ${preview.endpointPrice.provider})`,
		`Endpoint rate observed ${preview.endpointPrice.observedAt}: input $${preview.endpointPrice.inputPricePerMillionUsd}/M, output $${preview.endpointPrice.outputPricePerMillionUsd}/M`,
		`Configured maximum price ceilings: input $${preview.priceCeilingsPerMillionUsd.input}/M, output $${preview.priceCeilingsPerMillionUsd.output}/M`,
		`Worst-case price-ceiling-derived reserve: $${plan.campaign.rootPriceDerivedSpendCeilingUsd.toFixed(6)} per campaign root; all four roots $${plan.totalRootPriceDerivedSpendCeilingUsd.toFixed(6)}`,
		`Broker reservations: ${plan.totalCalls} calls, ${plan.totalTokens} tokens, $${plan.totalRootSpendCeilingUsd.toFixed(6)} root spend; operator cap ${operatorCapUsd === undefined ? "not supplied" : `$${operatorCapUsd.toFixed(6)}`}`,
		`Schedule: engineering ${plan.engineering.developmentProofCells} development cells; each campaign ${plan.campaign.developmentProofCells} development + ${plan.campaign.confirmationScheduleCells} confirmation cells (${plan.campaign.confirmationNotSelectedCells} not-selected, ${plan.campaign.paidConfirmationCells} final, ${plan.campaign.rootControlCells} root-control)`,
		`Worst-case serial task wall bound: ${(plan.totalTaskWallMs / 3_600_000).toFixed(1)} hours`,
		`Seeds: ${[preview.seeds.engineering, ...preview.seeds.campaigns].join(", ")}`,
		`Configured ceilings bound the estimate. No inference request was made.`,
	].join("\n")
}

export async function buildProofPlanPreview(options: Options, env: NodeJS.ProcessEnv = process.env, fetcher: typeof fetch = fetch): Promise<ProofPlanPreview> {
	if (options.command !== "estimate" && options.command !== "plan") throw new Error("plan options are required")
	if (options.seeds.length !== 4) throw new Error("provide one --seed for engineering and exactly three --campaign-seed values")
	if (new Set(options.seeds).size !== 4) throw new Error("engineering and campaign seeds must be distinct")
	const repo = path.resolve(options.repo)
	const rootCommit = await ensureCleanRoot(repo)
	const runtime = workerHarnessRuntimeIdentityFromEnvironment(env)
	try { execFileSync("git", ["cat-file", "-e", `${runtime.harnessCommit}^{commit}`], { cwd: repo, stdio: "ignore" }) }
	catch { throw new Error("fixed-control runtime harness commit must be present in the root repository") }
	const parsed = parseRsiArgs(["--repo", repo, "--population", "2", "--generations", "3", "--seed", options.seeds[0]!, "--base-ref", rootCommit, "--max-runtime-ms", String(72 * 60 * 60_000), "--mutation-task", options.mutationTask])
	if (!parsed.config) throw new Error(parsed.error ?? "could not construct proof configuration")
	const baseConfig = { ...parsed.config, model: RSI_OPENROUTER_MODEL, roles: { worker: { provider: "openrouter" as const, model: RSI_OPENROUTER_MODEL } }, mutationTask: options.mutationTask }
	const configs = options.seeds.map((seed) => ({ ...baseConfig, seed })) as [typeof baseConfig, typeof baseConfig, typeof baseConfig, typeof baseConfig]
	const config = configs[0]
	const loaded = await loadBenchmark(path.join(repo, "fixtures/rsi-benchmark"), repo)
	const modelKey = env.HEADLESSCODE_OPENROUTER_API_KEY?.trim() ?? ""
	const price = await fetchPinnedOpenRouterEndpointPrice(modelKey, fetcher)
	const mutationEnv = openRouterAllocatedEnvironment(env, "mutation")
	const benchmarkEnv = openRouterAllocatedEnvironment(env, "benchmark")
	const mutationLimits = openRouterBrokerLimitsFromEnvironment(mutationEnv, "plan-mutation", { maxCalls: config.maxIterations, maxDurationMs: config.commandTimeoutMs })
	const benchmarkLimits = openRouterBrokerLimitsFromEnvironment(benchmarkEnv, "plan-benchmark")
	if (mutationLimits.maxInputPricePerMillionUsd < price.inputPricePerMillionUsd || mutationLimits.maxOutputPricePerMillionUsd < price.outputPricePerMillionUsd || benchmarkLimits.maxInputPricePerMillionUsd < price.inputPricePerMillionUsd || benchmarkLimits.maxOutputPricePerMillionUsd < price.outputPricePerMillionUsd) throw new Error("configured broker price ceiling is below the live pinned endpoint rate")
	const plan = planProofDemonstration({ config, manifest: loaded.manifest, mutationLimits, benchmarkLimits })
	return {
		createdAt: new Date().toISOString(), rootCommit, benchmarkManifestSha256: loaded.manifestDigest,
		model: { provider: "openshell-openrouter", requestedId: RSI_OPENROUTER_MODEL, sampling: { temperature: 0, think: false, seed: "provider-default" } },
		endpointPrice: price,
		priceCeilingsPerMillionUsd: { input: benchmarkLimits.maxInputPricePerMillionUsd, output: benchmarkLimits.maxOutputPricePerMillionUsd },
		runtime,
		execution: {
			configs, configSha256: frozenProofConfigDigest(configs), analysisSourceSha256: await analysisDigest(repo),
			inferenceLimits: { mutation: mutationLimits, benchmark: benchmarkLimits },
			taskIdentities: loaded.manifest.tasks.map((task) => ({ id: task.id, split: task.split, family: task.family, seed: task.seed, startDigest: task.startDigest, verifierDigest: task.verifierDigest, knownGoodDigest: task.knownGoodDigest, knownBadDigest: task.knownBadDigest, ceilings: task.ceilings })),
		},
		seeds: { engineering: options.seeds[0]!, campaigns: [options.seeds[1]!, options.seeds[2]!, options.seeds[3]!] },
		campaignIds: { engineering: campaignId(options.seeds[0]!), campaigns: [campaignId(options.seeds[1]!), campaignId(options.seeds[2]!), campaignId(options.seeds[3]!)] },
		plan,
	}
}

export async function buildFrozenProofPlan(options: Options, env: NodeJS.ProcessEnv = process.env, fetcher: typeof fetch = fetch): Promise<ReturnType<typeof freezeProofDemonstrationManifest>> {
	if (options.command !== "plan") throw new Error("plan options are required")
	const operatorCapUsd = parseUsd(options.operatorCapUsd)
	const preview = await buildProofPlanPreview(options, env, fetcher)
	if (operatorCapUsd < preview.plan.totalRootSpendCeilingUsd) throw new Error(`operator cap $${operatorCapUsd.toFixed(6)} is below required root reservations $${preview.plan.totalRootSpendCeilingUsd.toFixed(6)}`)
	return freezeProofDemonstrationManifest({ ...preview, operatorCapUsd })
}

export async function verifyLiveFrozenProofPlan(manifest: ReturnType<typeof verifyFrozenProofDemonstrationManifest>, env: NodeJS.ProcessEnv = process.env, fetcher: typeof fetch = fetch): Promise<void> {
	const repo = path.resolve(manifest.execution.configs[0].repoRoot)
	if (await ensureCleanRoot(repo) !== manifest.rootCommit) throw new Error("plan root commit or working tree differs from the frozen plan")
	const loaded = await loadBenchmark(path.join(repo, "fixtures/rsi-benchmark"), repo)
	if (loaded.manifestDigest !== manifest.benchmarkManifestSha256) throw new Error("benchmark manifest differs from the frozen plan")
	if (canonicalHash(await analysisDigest(repo)) !== canonicalHash(manifest.execution.analysisSourceSha256)) throw new Error("analysis or launcher source differs from the frozen plan")
	const runtime = workerHarnessRuntimeIdentityFromEnvironment(env)
	if (JSON.stringify(runtime) !== JSON.stringify(manifest.runtime)) throw new Error("fixed-control runtime identity differs from the frozen plan")
	const config = manifest.execution.configs[0]
	const mutation = openRouterBrokerLimitsFromEnvironment(openRouterAllocatedEnvironment(env, "mutation"), "plan-mutation", { maxCalls: config.maxIterations, ...(config.maxTokens ? { maxOutputTokensPerCall: config.maxTokens } : {}), maxDurationMs: config.commandTimeoutMs })
	const benchmark = openRouterBrokerLimitsFromEnvironment(openRouterAllocatedEnvironment(env, "benchmark"), "plan-benchmark")
	if (canonicalHash(mutation) !== canonicalHash(manifest.execution.inferenceLimits.mutation) || canonicalHash(benchmark) !== canonicalHash(manifest.execution.inferenceLimits.benchmark)) throw new Error("broker limits or allocations differ from the frozen plan")
	const key = env.HEADLESSCODE_OPENROUTER_API_KEY?.trim() ?? ""
	const price = await fetchPinnedOpenRouterEndpointPrice(key, fetcher)
	if (price.model !== manifest.model.requestedId || price.provider !== manifest.endpointPrice.provider || price.inputPricePerMillionUsd > manifest.priceCeilingsPerMillionUsd.input || price.outputPricePerMillionUsd > manifest.priceCeilingsPerMillionUsd.output) throw new Error("live pinned endpoint price exceeds or differs from frozen plan ceilings")
}

export async function proofDemonstrationPlanMain(argv = process.argv.slice(2)): Promise<number> {
	if (argv.includes("--help") || argv.includes("-h")) { process.stdout.write(usage()); return 0 }
	try {
		const options = parse(argv)
		if (options.command === "estimate") {
			process.stdout.write(`${formatPlan(await buildProofPlanPreview(options))}\n`)
			return 0
		}
		if (options.command === "verify") {
			const safePath = await assertSupervisorOnlyPlanPath(options.repo, options.output)
			const parsed = JSON.parse(await fs.readFile(safePath, "utf8")) as unknown
			const manifest = verifyFrozenProofDemonstrationManifest(parsed)
			await verifyLiveFrozenProofPlan(manifest)
			process.stdout.write(`Verified frozen plan ${manifest.digestSha256}; operator cap $${manifest.operatorCapUsd.toFixed(6)}; paid provider inference has not been started.\n`)
			return 0
		}
		const manifest = await buildFrozenProofPlan(options)
		const safePath = await assertSupervisorOnlyPlanPath(options.repo, options.output)
		await fs.mkdir(path.dirname(safePath), { recursive: true, mode: 0o700 })
		await fs.writeFile(safePath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600, flag: "wx" })
		process.stdout.write(`${formatPlan(manifest, manifest.operatorCapUsd, manifest.digestSha256)}\nPlan file: ${safePath}\n`)
		return 0
	} catch (error) {
		process.stderr.write(`rsi-proof-demonstration: ${error instanceof Error ? error.message : String(error)}\n`)
		return 2
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) process.exitCode = await proofDemonstrationPlanMain()
