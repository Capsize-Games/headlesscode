import { createHash } from "node:crypto"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import { execFileSync } from "node:child_process"
import { fileURLToPath, pathToFileURL } from "node:url"
import { loadBenchmark } from "../src/rsi/benchmark/runner.js"
import { readArchive } from "../src/rsi/archive.js"
import { parseRsiArgs } from "../src/rsi/config.js"
import { createProofCampaignManifest, RSI_CONFIRMATION_RETENTION_TASK_IDS, runRsi } from "../src/rsi/controller.js"
import { fetchPinnedOpenRouterEndpointPrice, openRouterAllocatedEnvironment, openRouterBrokerLimitsFromEnvironment, RSI_OPENROUTER_MODEL } from "../src/rsi/inference-broker.js"
import { freezeProofDemonstrationManifest, frozenProofConfigDigest, verifyFrozenProofDemonstrationManifest, type FrozenProofDemonstrationManifest } from "../src/rsi/proof-demonstration-manifest.js"
import { assertFrozenProofDemonstrationPlanMatches, planProofDemonstration } from "../src/rsi/proof-demonstration-plan.js"
import { analyzeProofDemonstration, verifyProofDemonstrationArtifactBytes } from "../src/rsi/proof-demonstration.js"
import { workerHarnessRuntimeIdentityFromEnvironment } from "../src/rsi/worker-harness.js"
import { proofCampaignManifestDigest } from "../src/rsi/proof-campaign.js"
import type { CandidateRecord, RsiConfig, RsiRunRecord } from "../src/rsi/types.js"

interface Options {
	command: "estimate" | "plan" | "verify" | "analyze" | "engineering" | "execute"
	output: string
	planPath?: string
	archiveDir?: string
	outputExplicit?: boolean
	execute?: boolean
	repo: string
	operatorCapUsd?: number
	seeds: string[]
	mutationTask: string
	engineeringEvidencePath?: string
}

type ProofPlanPreview = Omit<Parameters<typeof freezeProofDemonstrationManifest>[0], "operatorCapUsd" | "engineeringEvidence"> & { plan: ReturnType<typeof planProofDemonstration> }
interface EngineeringEvidenceRecord {
	schemaVersion: 1
	campaignId: string
	rootCommit: string
	manifestSha256: string
	snapshotSha256: string
	archiveDir: string
	arms: Array<{ runId: string; armId: "fixed-control" | "self-hosted"; runSha256: string; selectedCommit: string }>
	digestSha256: string
}

function usage(): string {
	return `Usage:
  npx tsx scripts/rsi-proof-demonstration.ts estimate --seed <engineering> --campaign-seed <seed> --campaign-seed <seed> --campaign-seed <seed> [--repo <path>]
  npx tsx scripts/rsi-proof-demonstration.ts engineering --seed <engineering> --operator-cap-usd <USD> [--execute] [--repo <path>] [--out <evidence.json>]
  npx tsx scripts/rsi-proof-demonstration.ts plan --engineering-evidence <path> --operator-cap-usd <USD> --seed <engineering> --campaign-seed <seed> --campaign-seed <seed> --campaign-seed <seed> [--out <path>] [--repo <path>]
  npx tsx scripts/rsi-proof-demonstration.ts execute --plan <path> --operator-cap-usd <USD> --execute
  npx tsx scripts/rsi-proof-demonstration.ts verify --plan <path>
  npx tsx scripts/rsi-proof-demonstration.ts analyze --plan <path> --archive <directory> [--out <path>]

Estimate, engineering estimates, plan, and verify perform pricing metadata GETs only; they do not submit model inference.
Engineering prints a bounded estimate unless --execute is supplied. Paid execution requires an
explicit operator cap, broker/PostgreSQL/OpenShell configuration, and a clean checkout. Its
development-only manifest contains no confirmation cells. Final plan requires passing
engineering evidence and freezes the three confirmation campaigns afterward. Execute resumes
the frozen campaigns; analyze independently checks their archive and artifacts.
`
}

function parse(argv: string[]): Options {
	const command = argv[0]
	if (command !== "estimate" && command !== "plan" && command !== "verify" && command !== "analyze" && command !== "engineering" && command !== "execute") throw new Error("expected estimate, engineering, plan, execute, verify or analyze")
	const defaultOutput = command === "analyze" ? ".headlesscode/rsi-proof/report.json" : command === "engineering" ? ".headlesscode/rsi-proof/engineering-evidence.json" : ".headlesscode/rsi-proof/plan.json"
	const options: Options = { command, output: path.resolve(defaultOutput), repo: process.cwd(), seeds: [], mutationTask: "Improve headlesscode agent reliability on the frozen development benchmark while preserving existing behavior." }
	for (let index = 1; index < argv.length; index++) {
		const arg = argv[index]!
		if (arg === "--execute") { options.execute = true; continue }
		if (arg === "--help" || arg === "-h") throw new Error(usage())
		const value = argv[index + 1]
		if (!value || value.startsWith("--")) throw new Error(`${arg} requires a value`)
		if (arg === "--out") { options.output = path.resolve(value); options.outputExplicit = true }
		else if (arg === "--plan") options.planPath = path.resolve(value)
		else if (arg === "--archive") options.archiveDir = path.resolve(value)
		else if (arg === "--engineering-evidence") options.engineeringEvidencePath = path.resolve(value)
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
function engineeringRunId(campaign: string, arm: "fixed-control" | "self-hosted"): string {
	const match = /^rsi-proof-([a-f0-9]{20})$/.exec(campaign)
	if (!match) throw new Error("engineering campaign ID is malformed")
	return `rsi-proof-${match[1]}-${arm === "fixed-control" ? "fixed" : "self"}`
}

export function assertEngineeringTransition(fixed: RsiRunRecord, self: RsiRunRecord): void {
	const selfSnapshot = self.proofCampaign?.ledgerSnapshot
	const selfEvents = (selfSnapshot?.events as Array<Record<string, unknown>> | undefined) ?? []
	const selfDecisions = (selfSnapshot?.decisions as Array<Record<string, unknown>> | undefined) ?? []
	const selectedEvent = selfEvents.find((event) => event.arm_id === "self-hosted" && event.event_type === "generation-selected" && Number((event.payload as Record<string, unknown>).generation) === 0)
	const slots = ((selectedEvent?.payload as Record<string, unknown> | undefined)?.selectedCandidateIds as string[] | undefined) ?? []
	const generationZero = self.candidates.filter((candidate) => candidate.generation === 0)
	const selectedZero = slots.map((slot) => generationZero[Number(/candidate-(\d+)$/.exec(slot)?.[1] ?? -1)])
		.filter((candidate): candidate is CandidateRecord => Boolean(candidate && candidate.status === "accepted" && candidate.developmentProof?.accepted === true && candidate.commits[0]))
	if (!selectedZero.length) throw new Error("engineering evidence lacks a durably selected accepted generation-zero self-hosted parent")
	const generationOne = self.candidates.filter((candidate) => candidate.generation === 1)
	const transition = generationOne.some((child) => selectedZero.some((parent) => {
		const slot = `g1-candidate-${generationOne.indexOf(child)}`
		return child.status === "accepted" && child.developmentProof?.accepted === true && child.parent === parent.id && child.baseCommit === parent.commits[0] && child.parentCommit === parent.commits[0] && child.workerHarnessExecution?.parentCommit === parent.commits[0] && Boolean(child.commits[0]) && selfDecisions.some((entry) => entry.arm_id === "self-hosted" && Number(entry.generation) === 1 && entry.candidate_id === slot && entry.decision === "accepted" && entry.parent_commit === parent.commits[0])
	}))
	if (!transition) throw new Error("engineering evidence lacks an accepted generation-one self-hosted mutation from a durable selected generation-zero parent")
	const fixedSchedule = fixed.proofCampaign?.manifest.schedule.filter((cell) => cell.armId === "fixed-control" && cell.phase === "development" && cell.generation === 1) ?? []
	const fixedRows = (fixed.proofCampaign?.ledgerSnapshot?.attempts as Array<Record<string, unknown>> | undefined) ?? []
	const fixedDecisions = (fixed.proofCampaign?.ledgerSnapshot?.decisions as Array<Record<string, unknown>> | undefined) ?? []
	const fixedCandidates = [...new Set(fixedSchedule.map((cell) => cell.candidateId))]
	if (!fixedSchedule.length || fixedSchedule.some((cell) => {
		const rows = fixedRows.filter((row) => row.arm_id === "fixed-control" && Number(row.generation) === 1 && row.candidate_id === cell.candidateId && row.task_id === cell.taskId && row.seed === cell.seed && row.attempt_kind === cell.attemptKind)
		return rows.length !== 1 || !["completed", "skipped-after-hard-gate"].includes(String(rows[0]?.status))
	}) || fixedCandidates.some((candidateId) => {
		const rows = fixedDecisions.filter((row) => row.arm_id === "fixed-control" && Number(row.generation) === 1 && row.candidate_id === candidateId)
		return rows.length !== 1 || !["accepted", "rejected", "failed"].includes(String(rows[0]?.decision))
	})) throw new Error("engineering evidence lacks terminal fixed-control generation-one cells and candidate decisions")
}

async function verifyEngineeringEvidenceFile(evidencePath: string, repo: string, expectedRoot?: string): Promise<{ record: EngineeringEvidenceRecord; fileSha256: string }> {
	const safePath = await assertSupervisorOnlyPlanPath(repo, evidencePath)
	const bytes = await fs.readFile(safePath)
	const record = JSON.parse(bytes.toString("utf8")) as EngineeringEvidenceRecord
	if (!record || record.schemaVersion !== 1 || !Array.isArray(record.arms) || record.arms.length !== 2) throw new Error("engineering evidence record is malformed")
	const { digestSha256, ...body } = record
	if (!/^[a-f0-9]{64}$/.test(digestSha256) || canonicalHash(body) !== digestSha256) throw new Error("engineering evidence digest mismatch")
	if (expectedRoot && record.rootCommit !== expectedRoot) throw new Error("engineering evidence belongs to a different clean root commit")
	const archive = await readArchive(record.archiveDir)
	const snapshot: Record<string, unknown> | undefined = archive.runs.concat(archive.activeRuns).map((run) => run.proofCampaign?.ledgerSnapshot).find((entry) => {
		const campaign = (entry as Record<string, unknown> | undefined)?.campaign as Record<string, unknown> | undefined
		return campaign?.campaign_id === record.campaignId && campaign.manifest_sha256?.toString().trim() === record.manifestSha256 && canonicalHash(entry) === record.snapshotSha256
	})
	if (!snapshot) throw new Error("engineering evidence durable PostgreSQL snapshot is missing or changed")
	const campaign = snapshot.campaign as Record<string, unknown>
	const arms = snapshot.arms as Array<Record<string, unknown>>
	const events = snapshot.events as Array<Record<string, unknown>>
	if (campaign.state !== "finished" || String(campaign.manifest_sha256).trim() !== record.manifestSha256 || arms.length !== 2 || arms.some((arm) => arm.state !== "finished") || events.filter((event) => event.event_type === "engineering-development-finished").length !== 2) throw new Error("engineering evidence does not have two finished development-only ledger arms")
	const uniqueArms = new Set<string>()
	for (const armRef of record.arms) {
		if (!/^[a-f0-9]{64}$/.test(armRef.runSha256) || !/^[a-f0-9]{40}$/.test(armRef.selectedCommit) || uniqueArms.has(armRef.armId)) throw new Error("engineering evidence arm reference is malformed or duplicated")
		uniqueArms.add(armRef.armId)
		const run = archive.runs.concat(archive.activeRuns).find((entry) => entry.runId === armRef.runId)
		if (!run || canonicalHash(run) !== armRef.runSha256 || run.baseCommit !== record.rootCommit || run.finishedAt === undefined || run.workerHarnessPairId !== record.campaignId || run.workerHarnessMode !== armRef.armId || !run.proofCampaign || run.proofCampaign.manifest.phaseMode !== "engineering-only" || run.proofCampaign.manifestSha256 !== record.manifestSha256 || proofCampaignManifestDigest(run.proofCampaign.manifest) !== record.manifestSha256 || run.proofCampaign.state !== "finished" || run.proofConfirmation || (run.confirmationAttempts?.length ?? 0) > 0 || run.proofCampaign.manifest.schedule.some((cell) => cell.phase === "confirmation") || (run.proofCampaign.manifest.settings.confirmationTaskIdentities as unknown[] | undefined)?.length) throw new Error(`engineering evidence run ${armRef.runId} is incomplete or includes confirmation inputs`)
		if (run.candidates.some((candidate) => !["accepted", "rejected", "failed"].includes(candidate.status))) throw new Error(`engineering evidence run ${armRef.runId} has incomplete candidate outcomes`)
		if (armRef.armId === "self-hosted" && (!run.selected || !run.candidates.some((candidate) => candidate.id === run.selected && candidate.status === "accepted" && candidate.developmentProof?.accepted === true && candidate.commits.length > 0 && candidate.commits[0] === armRef.selectedCommit))) throw new Error("engineering self-hosted arm did not select an accepted development-proof candidate")
		if (armRef.armId === "fixed-control" && armRef.selectedCommit !== run.baseCommit && !run.candidates.some((candidate) => candidate.id === run.selected && candidate.commits[0] === armRef.selectedCommit)) throw new Error("engineering fixed-control selected commit is not in its recorded run")
	}
	if (!uniqueArms.has("fixed-control") || !uniqueArms.has("self-hosted")) throw new Error("engineering evidence must contain one run for each paired arm")
	const [fixed, self] = record.arms
	const fixedRun = archive.runs.concat(archive.activeRuns).find((run) => run.runId === fixed!.runId)!
	const selfRun = archive.runs.concat(archive.activeRuns).find((run) => run.runId === self!.runId)!
	if (fixedRun.workerHarnessConfigDigest !== selfRun.workerHarnessConfigDigest || fixedRun.workerHarnessSamplingSeed !== selfRun.workerHarnessSamplingSeed || fixedRun.workerHarnessRuntime?.harnessCommit !== selfRun.workerHarnessRuntime?.harnessCommit) throw new Error("engineering pair has mismatched frozen configuration, seed, or runtime")
	assertEngineeringTransition(fixedRun, selfRun)
	return { record, fileSha256: sha256(bytes) }
}

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
		`Broker hard spend reservations: engineering root $${plan.engineering.rootSpendCeilingUsd.toFixed(6)}; three future campaign roots $${plan.campaignRootsSpendCeilingUsd.toFixed(6)} total ($${plan.campaign.rootSpendCeilingUsd.toFixed(6)} each)`,
		`Price-ceiling-derived spend bounds: engineering root $${plan.engineering.rootPriceDerivedSpendCeilingUsd.toFixed(6)}; three future campaign roots $${(3 * plan.campaign.rootPriceDerivedSpendCeilingUsd).toFixed(6)} total ($${plan.campaign.rootPriceDerivedSpendCeilingUsd.toFixed(6)} each)`,
		`Broker reservations across engineering + campaigns: ${plan.totalCalls} calls, ${plan.totalTokens} tokens, $${plan.totalReservedSpendUsd.toFixed(6)} reserved; final-plan operator cap applies to the three future campaigns: ${operatorCapUsd === undefined ? "not supplied" : `$${operatorCapUsd.toFixed(6)}`}`,
		`Schedule: engineering ${plan.engineering.developmentProofCells} development cells; confirmation is not frozen until it passes. Each final campaign has ${plan.campaign.developmentProofCells} development + ${plan.campaign.confirmationScheduleCells} confirmation cells (${plan.campaign.confirmationNotSelectedCells} not-selected, ${plan.campaign.paidConfirmationCells} selected-final, ${plan.campaign.rootControlCells} root-control)`,
		`Worst-case serial task wall bound: ${(plan.totalTaskWallMs / 3_600_000).toFixed(1)} hours`,
		`Seeds: ${[preview.seeds.engineering, ...preview.seeds.campaigns].join(", ")}`,
		`Configured ceilings bound the estimate. No inference request was made.`,
	].join("\n")
}

export function formatAnalysisReport(report: ReturnType<typeof analyzeProofDemonstration>, planDigest: string): string {
	const lines = [
		"# RSI proof demonstration analysis", "", `Frozen plan: ${planDigest}`, `Verdict: **${report.verdict}**`, "",
		"## Paired campaign outcomes", "",
		"Campaign | Self-hosted lineage (generation: parent → commit) | Final commit | Selected lineage depth | Net confirmation wins vs root | Retention losses | Self-hosted calls / tokens / wall ms / spend USD | Fixed-control final commit | Fixed-control calls / tokens / wall ms / spend USD",
		"---|---|---|---:|---:|---|---|---|---",
	]
	const resource = (value: Record<string, number | null>) => `${value.calls ?? "unmeasured"} / ${value.tokens ?? "unmeasured"} / ${value.wallTimeMs ?? "unmeasured"} / ${value.spendUsd ?? "unmeasured"}`
	for (const campaign of report.campaigns) {
		const lineage = campaign.selfHosted.lineage.map((edge) => `g${edge.generation}: ${edge.parentId}@${edge.parentCommit} → ${edge.candidateId}@${edge.commit}`).join("; ") || "root (no accepted mutation)"
		lines.push(`${campaign.campaignId} | ${lineage} | ${campaign.selfHosted.finalCommit} | ${campaign.selfHosted.adjacentAcceptedDepth} | ${campaign.selfHosted.netWinsVsRoot} | ${campaign.selfHosted.retentionLosses.join(", ") || "none"} | ${resource(campaign.selfHosted.resources)} | ${campaign.fixedControl.finalCommit} | ${resource(campaign.fixedControl.resources)}`)
	}
	lines.push("", "## Development denominators", "")
	for (const campaign of report.campaigns) {
		for (const [armName, arm] of [["self-hosted", campaign.selfHosted], ["fixed-control", campaign.fixedControl]] as const) {
			const data = arm.development as { scheduledCandidateSlots?: number; candidateCounts?: Record<string, number>; scheduledDevelopmentProofCells?: number; completedDevelopmentProofCells?: number; candidates?: Array<{ id: string; generation: number; status: string; proofAccepted: boolean; reason: string }>; otherDevelopmentCells?: Array<{ generation: number; candidateId: string; taskId: string; attemptKind: string; status: unknown }> }
			lines.push(`- ${campaign.campaignId}/${armName}: ${data.candidateCounts?.accepted ?? 0} accepted, ${data.candidateCounts?.rejected ?? 0} rejected, ${data.candidateCounts?.failed ?? 0} failed, ${data.candidateCounts?.incomplete ?? 0} incomplete of ${data.scheduledCandidateSlots ?? 0} scheduled candidate slots; ${data.completedDevelopmentProofCells ?? 0}/${data.scheduledDevelopmentProofCells ?? 0} development-proof cells completed.`)
			for (const candidate of data.candidates ?? []) if (candidate.status !== "accepted") lines.push(`  - ${candidate.id} (generation ${candidate.generation}, ${candidate.status}): ${candidate.reason}`)
			for (const cell of data.otherDevelopmentCells ?? []) lines.push(`  - ${cell.candidateId}/${cell.taskId}/${cell.attemptKind}: ${String(cell.status)}`)
		}
	}
	lines.push("", "## Confirmation denominators", "")
	for (const campaign of report.campaigns) {
		for (const [armName, arm] of [["self-hosted", campaign.selfHosted], ["fixed-control", campaign.fixedControl]] as const) {
			const valid = (attempts: Array<Record<string, unknown>>) => attempts.filter((attempt) => attempt.validity === "valid" && attempt.proofQualified === true).length
			lines.push(`- ${campaign.campaignId}/${armName}: selected-final ${valid(arm.confirmation)}/${arm.confirmation.length} valid; root ${valid(arm.root)}/${arm.root.length} valid; complete=${arm.complete}.`)
		}
	}
	lines.push("", "## Aggregate results", "", `Task clusters: ${report.pooled.taskIds.length}; campaigns: ${report.pooled.campaignCount}; self-hosted successful cells: ${report.pooled.selfHostedSuccesses}; fixed-control successful cells: ${report.pooled.fixedControlSuccesses}.`, `Mean paired difference: ${report.pooled.difference}; task-cluster 90% interval: ${report.pooled.cluster90PercentInterval?.join(" to ") ?? "unavailable"}.`, `Bootstrap: ${report.pooled.bootstrapReplicates} replicates; frozen seed ${report.pooled.bootstrapSeed}.`, "", "## Denominators and exclusions", "", `Confirmation task denominator: ${report.denominators.pairedConfirmationTasks}; missing cells: ${report.denominators.missingCells.length}; excluded attempts: ${report.denominators.excludedAttempts.length}.`)
	if (report.denominators.missingCells.length) lines.push("", "Missing cells:", ...report.denominators.missingCells.map((cell) => `- ${cell}`))
	if (report.denominators.excludedAttempts.length) lines.push("", "Excluded attempts:", ...report.denominators.excludedAttempts.map((attempt) => `- ${attempt}`))
	lines.push("", "## Verdict gates", "", ...report.verdictReasons.map((reason) => `- ${reason}`), "", "## Limitations", "", ...report.limitations.map((limitation) => `- ${limitation}`), "")
	return lines.join("\n")
}

export async function buildProofPlanPreview(options: Options, env: NodeJS.ProcessEnv = process.env, fetcher: typeof fetch = fetch): Promise<ProofPlanPreview> {
	if (options.command !== "estimate" && options.command !== "plan" && options.command !== "engineering") throw new Error("plan options are required")
	if (options.command === "engineering" && options.seeds.length !== 1) throw new Error("engineering requires exactly one explicit --seed")
	if (options.command !== "engineering" && options.seeds.length !== 4) throw new Error("provide one --seed for engineering and exactly three --campaign-seed values")
	const seeds = options.command === "engineering" ? [options.seeds[0]!, "preview-a-" + sha256(options.seeds[0]!).slice(0, 12), "preview-b-" + sha256(options.seeds[0]!).slice(12, 24), "preview-c-" + sha256(options.seeds[0]!).slice(24, 36)] : options.seeds
	if (new Set(seeds).size !== 4) throw new Error("engineering and campaign seeds must be distinct")
	const repo = path.resolve(options.repo)
	const rootCommit = await ensureCleanRoot(repo)
	const runtime = workerHarnessRuntimeIdentityFromEnvironment(env)
	try { execFileSync("git", ["cat-file", "-e", `${runtime.harnessCommit}^{commit}`], { cwd: repo, stdio: "ignore" }) }
	catch { throw new Error("fixed-control runtime harness commit must be present in the root repository") }
	const parsed = parseRsiArgs(["--repo", repo, "--population", "2", "--generations", "3", "--seed", seeds[0]!, "--base-ref", rootCommit, "--max-runtime-ms", String(72 * 60 * 60_000), "--mutation-task", options.mutationTask])
	if (!parsed.config) throw new Error(parsed.error ?? "could not construct proof configuration")
	const baseConfig = { ...parsed.config, archiveDir: options.archiveDir ?? parsed.config.archiveDir, model: RSI_OPENROUTER_MODEL, roles: { worker: { provider: "openrouter" as const, model: RSI_OPENROUTER_MODEL } }, mutationTask: options.mutationTask, workerHarnessRuntime: runtime }
	const configs = seeds.map((seed, index) => ({ ...baseConfig, generations: index === 0 ? 2 : 3, seed })) as [typeof baseConfig, typeof baseConfig, typeof baseConfig, typeof baseConfig]
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
		seeds: { engineering: seeds[0]!, campaigns: [seeds[1]!, seeds[2]!, seeds[3]!] },
		campaignIds: { engineering: campaignId(seeds[0]!), campaigns: [campaignId(seeds[1]!), campaignId(seeds[2]!), campaignId(seeds[3]!)] },
		analysis: { bootstrapSeed: "rsi-proof-task-cluster-bootstrap-v1", bootstrapReplicates: 10_000, confirmationRetentionTaskIds: [...RSI_CONFIRMATION_RETENTION_TASK_IDS] },
		plan,
	}
}

export async function runEngineeringArm(config: RsiConfig, campaign: string, arm: "fixed-control" | "self-hosted", rootCommit: string, seed: string, runtime: NonNullable<RsiConfig["workerHarnessRuntime"]>, runner: typeof runRsi = runRsi): Promise<RsiRunRecord> {
	const before = await readArchive(config.archiveDir)
	const prior = before.runs.concat(before.activeRuns).filter((entry) => entry.workerHarnessPairId === campaign && entry.workerHarnessMode === arm)
	if (prior.length > 1) throw new Error(`engineering replay found duplicate archived ${arm} runs`)
	const existing = prior[0]
	const plannedRunId = engineeringRunId(campaign, arm)
	if (existing) {
		if (existing.runId !== plannedRunId || existing.baseCommit !== rootCommit || existing.workerHarnessSamplingSeed !== seed || JSON.stringify(existing.workerHarnessRuntime) !== JSON.stringify(runtime) || existing.proofCampaign?.manifest.phaseMode !== "engineering-only") throw new Error(`engineering replay found a ${arm} run with changed frozen identity`)
		if (existing.finishedAt && existing.proofCampaign.state === "finished") {
			const arms = existing.proofCampaign.ledgerSnapshot?.arms as Array<Record<string, unknown>> | undefined
			if (!arms?.some((entry) => entry.arm_id === arm && entry.state === "finished") || existing.proofCampaign.manifest.schedule.some((cell) => cell.phase === "confirmation")) throw new Error(`engineering replay found an invalid terminal ${arm} checkpoint`)
			return existing
		}
		if (before.runs.some((entry) => entry.runId === existing.runId)) throw new Error(`engineering ${arm} run is archived without a terminal campaign finish; refusing to create a second identity`)
	}
	return runner({ ...config, dryRun: false, workerHarnessRunId: plannedRunId, ...(existing ? { resumeRunId: existing.runId } : {}), workerHarnessMode: arm, workerHarnessPhase: "development", workerHarnessPairId: campaign, workerHarnessEngineeringOnly: true, workerHarnessRuntime: runtime })
}

export async function executeEngineeringPair(options: Options, env: NodeJS.ProcessEnv = process.env, runner: typeof runRsi = runRsi): Promise<EngineeringEvidenceRecord | undefined> {
	if (options.command !== "engineering") throw new Error("engineering command is required")
	const preview = await buildProofPlanPreview(options, env)
	const required = preview.plan.engineering.rootSpendCeilingUsd
	if (!options.execute) {
		if (options.operatorCapUsd !== undefined && parseUsd(options.operatorCapUsd) + 1e-9 < required) throw new Error(`operator cap $${options.operatorCapUsd.toFixed(6)} is below engineering-only root reservation $${required.toFixed(6)}`)
		process.stdout.write(`${formatPlan(preview, options.operatorCapUsd)}\nEngineering evidence output: ${options.output}\nNo inference request or campaign write was made. Use --execute only after provisioning PostgreSQL/OpenShell and reviewing the cap.\n`)
		return undefined
	}
	if (env !== process.env) throw new Error("engineering execution must use the validated process environment; injected environments are allowed only for read-only estimates")
	const cap = parseUsd(options.operatorCapUsd)
	if (cap + 1e-9 < required) throw new Error(`operator cap $${cap.toFixed(6)} is below engineering-only root reservation $${required.toFixed(6)}`)
	const mutationAllocation = preview.execution.inferenceLimits.mutation.maxCampaignSpendUsd
	const benchmarkAllocation = preview.execution.inferenceLimits.benchmark.maxCampaignSpendUsd
	if (mutationAllocation + benchmarkAllocation > cap + 1e-9 || mutationAllocation + benchmarkAllocation + 1e-9 < required) throw new Error("configured mutation and benchmark allocations must fit the operator cap and fund the engineering-only root reservation")
	if (await ensureCleanRoot(options.repo) !== preview.rootCommit) throw new Error("engineering execution root changed after its estimate")
	const campaign = campaignId(preview.seeds.engineering)
	const config = preview.execution.configs[0]
	const runs: RsiRunRecord[] = []
	for (const arm of ["fixed-control", "self-hosted"] as const) {
		runs.push(await runEngineeringArm(config, campaign, arm, preview.rootCommit, preview.seeds.engineering, preview.runtime, runner))
	}
	const archive = await readArchive(config.archiveDir)
	const savedRuns = runs.map((run) => archive.runs.concat(archive.activeRuns).filter((entry) => entry.runId === run.runId))
	if (savedRuns.some((entries) => entries.length !== 1)) throw new Error("engineering runner did not persist exactly one archive record per paired arm")
	const records = savedRuns.map((entries) => entries[0]!)
	const fixed = records.find((run) => run.workerHarnessMode === "fixed-control")
	const self = records.find((run) => run.workerHarnessMode === "self-hosted")
	if (!fixed || !self) throw new Error("engineering runner did not persist both fixed-control and self-hosted arms")
	for (const run of [fixed, self]) {
		const manifest = run.proofCampaign?.manifest
		if (!run.finishedAt || run.proofCampaign?.state !== "finished" || manifest?.phaseMode !== "engineering-only" || manifest.schedule.some((cell) => cell.phase === "confirmation") || (manifest.settings.confirmationTaskIdentities as unknown[] | undefined)?.length || run.proofConfirmation || (run.confirmationAttempts?.length ?? 0) > 0 || run.candidates.some((candidate) => !["accepted", "rejected", "failed"].includes(candidate.status))) throw new Error(`engineering arm ${run.runId} did not finish without confirmation work`)
	}
	const selectedSelf = self.candidates.find((candidate) => candidate.id === self.selected)
	if (!selectedSelf || selectedSelf.status !== "accepted" || selectedSelf.developmentProof?.accepted !== true || !selectedSelf.commits[0]) throw new Error("engineering gate failed: self-hosted arm has no accepted development-proof candidate")
	const selfSnapshot = self.proofCampaign!.ledgerSnapshot!
	const selfEvents = selfSnapshot.events as Array<Record<string, unknown>>
	const selfDecisions = selfSnapshot.decisions as Array<Record<string, unknown>>
	const generationZeroSelection = selfEvents.find((event) => event.arm_id === "self-hosted" && event.event_type === "generation-selected" && Number((event.payload as Record<string, unknown>).generation) === 0)
	const selectedZeroSlots = ((generationZeroSelection?.payload as Record<string, unknown> | undefined)?.selectedCandidateIds as string[] | undefined) ?? []
	const generationZero = self.candidates.filter((candidate) => candidate.generation === 0)
	const selectedZero = selectedZeroSlots.map((slot) => {
		const selectedIndex = Number(/candidate-(\d+)$/.exec(slot)?.[1] ?? -1)
		return generationZero[selectedIndex]
	}).filter((candidate): candidate is CandidateRecord => Boolean(candidate && candidate.status === "accepted" && candidate.developmentProof?.accepted === true && candidate.commits[0]))
	if (!selectedZero.length) throw new Error("engineering gate failed: generation 0 has no durably selected accepted self-hosted parent")
	const generationOneChildren = self.candidates.filter((candidate) => candidate.generation === 1 && selectedZero.some((parent) => candidate.status === "accepted" && candidate.developmentProof?.accepted === true && candidate.parent === parent.id && candidate.baseCommit === parent.commits[0] && candidate.parentCommit === parent.commits[0] && candidate.workerHarnessExecution?.parentCommit === parent.commits[0] && candidate.commits.length > 0 && selfDecisions.some((entry) => entry.arm_id === "self-hosted" && Number(entry.generation) === 1 && entry.candidate_id === `g1-candidate-${self.candidates.filter((item) => item.generation === 1).indexOf(candidate)}` && entry.decision === "accepted" && entry.parent_commit === parent.commits[0])))
	if (generationOneChildren.length === 0) throw new Error("engineering gate failed: no accepted generation-one self-hosted mutation ran from a durably selected generation-zero harness")
	const fixedSnapshot = fixed.proofCampaign?.ledgerSnapshot
	const fixedSchedule = fixed.proofCampaign!.manifest.schedule.filter((cell) => cell.armId === "fixed-control" && cell.phase === "development" && cell.generation === 1)
	const fixedRows = (fixedSnapshot?.attempts as Array<Record<string, unknown>> | undefined) ?? []
	const fixedDecisions = (fixedSnapshot?.decisions as Array<Record<string, unknown>> | undefined) ?? []
	const fixedCandidates = [...new Set(fixedSchedule.map((cell) => cell.candidateId))]
	if (!fixedSchedule.length || fixedSchedule.some((cell) => {
		const rows = fixedRows.filter((row) => row.arm_id === "fixed-control" && Number(row.generation) === 1 && row.candidate_id === cell.candidateId && row.task_id === cell.taskId && row.seed === cell.seed && row.attempt_kind === cell.attemptKind)
		return rows.length !== 1 || !["completed", "skipped-after-hard-gate"].includes(String(rows[0]?.status))
	}) || fixedCandidates.some((candidateId) => {
		const rows = fixedDecisions.filter((row) => row.arm_id === "fixed-control" && Number(row.generation) === 1 && row.candidate_id === candidateId)
		return rows.length !== 1 || !["accepted", "rejected", "failed"].includes(String(rows[0]?.decision))
	})) throw new Error("engineering gate failed: fixed-control generation-one cells and candidate decisions are not durably terminal")
	const snapshot = self.proofCampaign?.ledgerSnapshot
	if (!snapshot || !fixed.proofCampaign?.ledgerSnapshot || (fixed.proofCampaign.ledgerSnapshot.events as Array<Record<string, unknown>>).filter((event) => event.event_type === "engineering-development-finished" && event.arm_id === "fixed-control").length !== 1) throw new Error("engineering pair lacks both durable arm finish records")
	const campaignRow = snapshot.campaign as Record<string, unknown>
	if (campaignRow.state !== "finished" || String(campaignRow.manifest_sha256).trim() !== self.proofCampaign?.manifestSha256) throw new Error("engineering campaign ledger is not finished or has a mismatched manifest")
	const body = {
		schemaVersion: 1 as const, campaignId: campaign, rootCommit: preview.rootCommit,
		manifestSha256: self.proofCampaign.manifestSha256, snapshotSha256: canonicalHash(snapshot), archiveDir: config.archiveDir,
		arms: ([fixed, self] as const).map((run) => ({ runId: run.runId, armId: run.workerHarnessMode!, runSha256: canonicalHash(run), selectedCommit: run.workerHarnessMode === "self-hosted" ? selectedSelf.commits[0]! : run.candidates.find((candidate) => candidate.id === run.selected)?.commits[0] ?? run.baseCommit })),
	}
	const evidence: EngineeringEvidenceRecord = { ...body, digestSha256: canonicalHash(body) }
	const outputPath = await assertSupervisorOnlyPlanPath(options.repo, options.output)
	await fs.mkdir(path.dirname(outputPath), { recursive: true, mode: 0o700 })
	try {
		const existing = JSON.parse(await fs.readFile(outputPath, "utf8")) as EngineeringEvidenceRecord
		const { digestSha256, ...existingBody } = existing
		if (digestSha256 !== evidence.digestSha256 || canonicalHash(existingBody) !== evidence.digestSha256) throw new Error("existing engineering evidence differs from the verified completed pair")
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
		await fs.writeFile(outputPath, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600, flag: "wx" })
	}
	return evidence
}

export async function buildFrozenProofPlan(options: Options, env: NodeJS.ProcessEnv = process.env, fetcher: typeof fetch = fetch): Promise<ReturnType<typeof freezeProofDemonstrationManifest>> {
	if (options.command !== "plan") throw new Error("plan options are required")
	const operatorCapUsd = parseUsd(options.operatorCapUsd)
	if (!options.engineeringEvidencePath) throw new Error("final campaign plan requires --engineering-evidence from a completed development-only engineering pair")
	const preview = await buildProofPlanPreview(options, env, fetcher)
	if (operatorCapUsd < preview.plan.campaignRootsSpendCeilingUsd) throw new Error(`operator cap $${operatorCapUsd.toFixed(6)} is below required three-campaign root reservations $${preview.plan.campaignRootsSpendCeilingUsd.toFixed(6)}`)
	const evidence = await verifyEngineeringEvidenceFile(options.engineeringEvidencePath, options.repo, preview.rootCommit)
	if (evidence.record.campaignId !== preview.campaignIds.engineering) throw new Error("engineering evidence seed/campaign identity differs from the final plan")
	return freezeProofDemonstrationManifest({ ...preview, engineeringEvidence: { path: options.engineeringEvidencePath, sha256: evidence.fileSha256, campaignId: evidence.record.campaignId, rootCommit: evidence.record.rootCommit, manifestSha256: evidence.record.manifestSha256, snapshotSha256: evidence.record.snapshotSha256 }, operatorCapUsd })
}

export async function verifyLiveFrozenProofPlan(manifest: ReturnType<typeof verifyFrozenProofDemonstrationManifest>, env: NodeJS.ProcessEnv = process.env, fetcher: typeof fetch = fetch): Promise<void> {
	const repo = path.resolve(manifest.execution.configs[0].repoRoot)
	if (await ensureCleanRoot(repo) !== manifest.rootCommit) throw new Error("plan root commit or working tree differs from the frozen plan")
	const loaded = await loadBenchmark(path.join(repo, "fixtures/rsi-benchmark"), repo)
	if (loaded.manifestDigest !== manifest.benchmarkManifestSha256) throw new Error("benchmark manifest differs from the frozen plan")
	const engineering = await verifyEngineeringEvidenceFile(manifest.engineeringEvidence.path, repo, manifest.rootCommit)
	if (engineering.fileSha256 !== manifest.engineeringEvidence.sha256 || engineering.record.campaignId !== manifest.engineeringEvidence.campaignId || engineering.record.manifestSha256 !== manifest.engineeringEvidence.manifestSha256 || engineering.record.snapshotSha256 !== manifest.engineeringEvidence.snapshotSha256) throw new Error("engineering evidence bytes or ledger identity differ from the frozen final plan")
	if (canonicalHash(await analysisDigest(repo)) !== canonicalHash(manifest.execution.analysisSourceSha256)) throw new Error("analysis or launcher source differs from the frozen plan")
	const runtime = workerHarnessRuntimeIdentityFromEnvironment(env)
	if (JSON.stringify(runtime) !== JSON.stringify(manifest.runtime)) throw new Error("fixed-control runtime identity differs from the frozen plan")
	const config = manifest.execution.configs[0]
	const mutation = openRouterBrokerLimitsFromEnvironment(openRouterAllocatedEnvironment(env, "mutation"), "plan-mutation", { maxCalls: config.maxIterations, ...(config.maxTokens ? { maxOutputTokensPerCall: config.maxTokens } : {}), maxDurationMs: config.commandTimeoutMs })
	const benchmark = openRouterBrokerLimitsFromEnvironment(openRouterAllocatedEnvironment(env, "benchmark"), "plan-benchmark")
	if (canonicalHash(mutation) !== canonicalHash(manifest.execution.inferenceLimits.mutation) || canonicalHash(benchmark) !== canonicalHash(manifest.execution.inferenceLimits.benchmark)) throw new Error("broker limits or allocations differ from the frozen plan")
	assertFrozenProofDemonstrationPlanMatches(manifest.plan, { config, manifest: loaded.manifest, mutationLimits: mutation, benchmarkLimits: benchmark })
	const key = env.HEADLESSCODE_OPENROUTER_API_KEY?.trim() ?? ""
	const price = await fetchPinnedOpenRouterEndpointPrice(key, fetcher)
	if (price.model !== manifest.model.requestedId || price.provider !== manifest.endpointPrice.provider || price.inputPricePerMillionUsd > manifest.priceCeilingsPerMillionUsd.input || price.outputPricePerMillionUsd > manifest.priceCeilingsPerMillionUsd.output) throw new Error("live pinned endpoint price exceeds or differs from frozen plan ceilings")
}

export async function runFrozenCampaignArm(
	manifest: ReturnType<typeof verifyFrozenProofDemonstrationManifest>,
	campaignIndex: number,
	arm: "fixed-control" | "self-hosted",
	phase: "development" | "confirmation",
	runner: typeof runRsi = runRsi,
): Promise<RsiRunRecord> {
	const campaign = manifest.campaignIds.campaigns[campaignIndex]
	const config = manifest.execution.configs[campaignIndex + 1]
	if (!campaign || !config) throw new Error("frozen campaign index is outside the three-campaign plan")
	const runId = engineeringRunId(campaign, arm)
	const archive = await readArchive(config.archiveDir)
	const matches = archive.runs.concat(archive.activeRuns).filter((entry) => entry.workerHarnessPairId === campaign && entry.workerHarnessMode === arm)
	if (matches.length > 1) throw new Error(`campaign ${campaign} has duplicate ${arm} archive identities`)
	const existing = matches[0]
	if (existing && (existing.runId !== runId || existing.baseCommit !== manifest.rootCommit || existing.workerHarnessSamplingSeed !== config.seed || existing.workerHarnessConfigDigest === undefined || existing.workerHarnessRuntime?.harnessCommit !== manifest.runtime.harnessCommit)) throw new Error(`campaign ${campaign}/${arm} differs from its frozen run identity`)
	if (existing && (existing.workerHarnessPlannedGenerations !== config.generations || existing.model !== config.model || JSON.stringify(existing.workerHarnessRuntime) !== JSON.stringify(manifest.runtime))) throw new Error(`campaign ${campaign}/${arm} runtime, model, or generation count differs from the frozen plan`)
	if (existing) {
		const frozen = existing.proofCampaign?.manifest
		const expectedRuntime = { imageDigest: manifest.runtime.imageDigest, harnessCommit: manifest.runtime.harnessCommit, dependencyLockDigest: manifest.runtime.dependencyLockDigest }
		const internal = new Set(["workerHarnessMode", "workerHarnessPhase", "workerHarnessEngineeringOnly", "workerHarnessPairId", "workerHarnessRunId", "resumeRunId", "candidateIdNamespace", "workerHarnessParentCommit", "workerHarnessSnapshotTreeDigest"])
		const expectedConfig = Object.fromEntries(Object.entries(config).filter(([key]) => !internal.has(key)))
		if (!frozen || frozen.phaseMode !== "paired-confirmation" || frozen.campaignId !== campaign || frozen.seed !== config.seed || frozen.rootCommit !== manifest.rootCommit || frozen.benchmarkDigests.manifest !== manifest.benchmarkManifestSha256 || existing.proofCampaign?.manifestSha256 !== proofCampaignManifestDigest(frozen) || JSON.stringify(frozen.runtime) !== JSON.stringify(expectedRuntime) || canonicalHash(frozen.settings.effectiveConfig) !== canonicalHash(expectedConfig) || frozen.model.id !== manifest.model.requestedId || frozen.model.provider !== manifest.model.provider) throw new Error(`campaign ${campaign}/${arm} frozen ledger manifest differs from the plan`)
	}
	const armRow = (existing?.proofCampaign?.ledgerSnapshot?.arms as Array<Record<string, unknown>> | undefined)?.find((row) => row.arm_id === arm)
	if (phase === "development" && existing && armRow?.phase === "confirmation" && ["evaluated", "finished"].includes(existing.proofCampaign?.state ?? "")) return existing
	if (phase === "confirmation" && existing && isFullyConfirmedRun(existing, arm)) return existing
	if (existing && archive.runs.some((entry) => entry.runId === existing.runId) && phase === "development" && armRow?.phase !== "confirmation") throw new Error(`campaign ${campaign}/${arm} is archived before development completion; refusing duplicate execution`)
	const result = await runner({
		...config, dryRun: false, workerHarnessRunId: runId,
		...(existing ? { resumeRunId: existing.runId } : {}),
		workerHarnessMode: arm, workerHarnessPhase: phase, workerHarnessPairId: campaign,
		workerHarnessRuntime: manifest.runtime,
	})
	const after = await readArchive(config.archiveDir)
	const saved = after.runs.concat(after.activeRuns).filter((entry) => entry.runId === runId)
	if (saved.length !== 1 || saved[0]?.runId !== result.runId) throw new Error(`campaign ${campaign}/${arm}/${phase} did not persist its deterministic run identity`)
	if (phase === "confirmation" && !isFullyConfirmedRun(saved[0]!, arm)) throw new Error(`campaign ${campaign}/${arm} did not persist a complete terminal confirmation record`)
	return saved[0]!
}

export function isFullyConfirmedRun(run: RsiRunRecord, armId: "fixed-control" | "self-hosted"): boolean {
	const campaign = run.proofCampaign
	const snapshot = campaign?.ledgerSnapshot
	const manifest = campaign?.manifest
	const arm = (snapshot?.arms as Array<Record<string, unknown>> | undefined)?.find((entry) => entry.arm_id === armId)
	const campaignRow = snapshot?.campaign as Record<string, unknown> | undefined
	const scheduled = manifest?.schedule.filter((cell) => cell.armId === armId && cell.phase === "confirmation") ?? []
	if (!snapshot || manifest?.phaseMode !== "paired-confirmation" || campaign?.state !== "finished" || campaignRow?.state !== "finished" || arm?.state !== "finished" || arm.phase !== "confirmation" || run.confirmationEvidence !== "complete" || !run.proofConfirmation || scheduled.length === 0) return false
	const selected = run.proofConfirmation.selectedHarness
	const attempts = snapshot.attempts as Array<Record<string, unknown>> | undefined
	if (!attempts || !run.confirmationAttempts?.length || !selected.attemptIds.length || !run.proofConfirmation.rootHarness.attemptIds.length) return false
	for (const cell of scheduled) {
		const rows = attempts.filter((entry) => entry.arm_id === armId && Number(entry.generation) === cell.generation && entry.candidate_id === cell.candidateId && entry.task_id === cell.taskId && entry.seed === cell.seed && entry.attempt_kind === cell.attemptKind)
		if (rows.length !== 1) return false
		const required = cell.candidateId === "root-control" || (cell.candidateId === selected.slotId && cell.generation === selected.generation)
		if (rows[0]?.status !== (required ? "completed" : "not-selected")) return false
		if (required) {
			const brokerJobId = String(rows[0]?.broker_job_id ?? "")
			const matching = run.confirmationAttempts.filter((attempt) => attempt.attemptId === brokerJobId)
			if (matching.length !== 1 || rows[0]?.result_sha256 !== sha256(JSON.stringify(matching[0]))) return false
			const attempt = matching[0]!
			const expectedCommit = cell.candidateId === "root-control" ? run.proofConfirmation.rootHarness.commit : selected.commit
			if (attempt.taskId !== cell.taskId || attempt.seed !== Number(cell.seed) || attempt.harnessCommit !== expectedCommit || attempt.validity !== "valid" || attempt.proofQualified !== true || attempt.resourceAccounting !== "supervisor-enforced" || attempt.inferenceReceipt?.qualified !== true || attempt.inferenceReceipt.endpointProvider !== "deepinfra" || attempt.inferenceReceipt.returnedProviders?.length !== 1 || attempt.inferenceReceipt.returnedProviders[0] !== "deepinfra") return false
			const savedRefs = rows[0]?.artifact_refs as Record<string, { sha256?: string }> | undefined
			if (!savedRefs || Object.entries(attempt.artifactRefs).some(([name, digest]) => savedRefs[name]?.sha256 !== digest)) return false
		}
	}
	const attemptIds = new Set(run.confirmationAttempts.map((attempt) => attempt.attemptId))
	const requiredIds = [...selected.attemptIds, ...run.proofConfirmation.rootHarness.attemptIds]
	if (!requiredIds.every((id) => attemptIds.has(id))) return false
	const artifacts = new Map(run.confirmationAttempts.map((attempt) => [attempt.attemptId, attempt]))
	return requiredIds.every((id) => {
		const attempt = artifacts.get(id)
		return attempt?.validity === "valid" && attempt.proofQualified === true && attempt.inferenceReceipt?.qualified === true && attempt.inferenceReceipt.returnedProviders?.every((provider) => provider === "deepinfra") === true
	})
}

export async function executeFrozenCampaigns(options: Options, env: NodeJS.ProcessEnv = process.env, runner: typeof runRsi = runRsi): Promise<void> {
	if (options.command !== "execute" || !options.execute) throw new Error("campaign execution requires execute command and explicit --execute")
	if (env !== process.env || runner !== runRsi) throw new Error("paid campaign execution only accepts the validated process environment and production runner")
	if (!options.planPath) throw new Error("--plan is required for campaign execution")
	const safePath = await assertSupervisorOnlyPlanPath(options.repo, options.planPath)
	const manifest = verifyFrozenProofDemonstrationManifest(JSON.parse(await fs.readFile(safePath, "utf8")) as unknown)
	const cap = parseUsd(options.operatorCapUsd)
	if (Math.abs(cap - manifest.operatorCapUsd) > 0.000001) throw new Error("execution operator cap must exactly match the frozen plan cap")
	await verifyLiveFrozenProofPlan(manifest, env)
	for (let campaignIndex = 0; campaignIndex < 3; campaignIndex++) {
		for (const arm of ["fixed-control", "self-hosted"] as const) await runFrozenCampaignArm(manifest, campaignIndex, arm, "development")
		for (const arm of ["fixed-control", "self-hosted"] as const) await runFrozenCampaignArm(manifest, campaignIndex, arm, "confirmation")
	}
	process.stdout.write(`All three frozen paired campaigns reached terminal confirmation state. No analysis verdict has been issued; run analyze against the frozen plan and archive.\n`)
}

export async function proofDemonstrationPlanMain(argv = process.argv.slice(2)): Promise<number> {
	if (argv.includes("--help") || argv.includes("-h")) { process.stdout.write(usage()); return 0 }
	try {
		const options = parse(argv)
		if (options.command === "estimate") {
			process.stdout.write(`${formatPlan(await buildProofPlanPreview(options))}\n`)
			return 0
		}
		if (options.command === "engineering") {
			const evidence = await executeEngineeringPair(options)
			if (evidence) process.stdout.write(`Engineering pair passed development gate: campaign=${evidence.campaignId}; evidence=${options.output}; sha256=${evidence.digestSha256}\n`)
			return 0
		}
		if (options.command === "execute") {
			await executeFrozenCampaigns(options)
			return 0
		}
		if (options.command === "verify" || options.command === "analyze") {
			const requestedPlanPath = options.planPath ?? (options.command === "verify" ? options.output : undefined)
			if (!requestedPlanPath) throw new Error("--plan is required")
			const safePath = await assertSupervisorOnlyPlanPath(options.repo, requestedPlanPath)
			const parsed = JSON.parse(await fs.readFile(safePath, "utf8")) as unknown
			const manifest = verifyFrozenProofDemonstrationManifest(parsed)
			if (options.command === "verify") {
				await verifyLiveFrozenProofPlan(manifest)
				process.stdout.write(`Verified frozen plan ${manifest.digestSha256}; operator cap $${manifest.operatorCapUsd.toFixed(6)}; paid provider inference has not been started.\n`)
				return 0
			}
			if (!options.archiveDir) throw new Error("--archive is required")
			const engineering = await verifyEngineeringEvidenceFile(manifest.engineeringEvidence.path, options.repo, manifest.rootCommit)
			if (engineering.fileSha256 !== manifest.engineeringEvidence.sha256 || engineering.record.campaignId !== manifest.engineeringEvidence.campaignId || engineering.record.manifestSha256 !== manifest.engineeringEvidence.manifestSha256 || engineering.record.snapshotSha256 !== manifest.engineeringEvidence.snapshotSha256) throw new Error("engineering gate evidence no longer matches the frozen final plan")
			if (canonicalHash(await analysisDigest(options.repo)) !== canonicalHash(manifest.execution.analysisSourceSha256)) throw new Error("analysis source differs from the frozen manifest")
			const archive = await readArchive(options.archiveDir)
			const campaignIds = new Set(manifest.campaignIds.campaigns)
			const runs = [...archive.runs, ...archive.activeRuns].filter((run) => run.workerHarnessPairId && campaignIds.has(run.workerHarnessPairId))
			await verifyProofDemonstrationArtifactBytes(runs, options.archiveDir)
			const report = analyzeProofDemonstration(runs, { frozenPlan: manifest })
			const defaultReportPath = path.resolve(".headlesscode/rsi-proof", `analysis-${manifest.digestSha256}.json`)
			const reportPath = await assertSupervisorOnlyPlanPath(options.repo, options.outputExplicit ? options.output : defaultReportPath)
			const markdownPath = path.join(path.dirname(reportPath), path.basename(reportPath, path.extname(reportPath)) + ".md")
			await assertSupervisorOnlyPlanPath(options.repo, markdownPath)
			await fs.mkdir(path.dirname(reportPath), { recursive: true, mode: 0o700 })
			await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600, flag: "wx" })
			await fs.writeFile(markdownPath, formatAnalysisReport(report, manifest.digestSha256), { mode: 0o600, flag: "wx" })
			process.stdout.write(`${JSON.stringify({ verdict: report.verdict, reportPath, markdownPath, missingCells: report.denominators.missingCells.length, excludedAttempts: report.denominators.excludedAttempts.length })}\n`)
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
