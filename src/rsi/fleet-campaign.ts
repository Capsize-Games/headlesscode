/** Narrow Fleet synthetic-intake campaign binding for the existing RSI controller.
 *
 * Readiness is deliberately read-only. Execution is impossible unless the
 * caller verifies the root-recorded, plan-bound execution checkpoint and confirms that the
 * worker is wired to Fleet's shared budget ledger.
 */
import { createHash } from "node:crypto"
import { spawnSync } from "node:child_process"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import { fileURLToPath } from "node:url"
import { HeadBucketCommand, S3Client } from "@aws-sdk/client-s3"
import { runRsi } from "./controller.js"
import { RSI_MUSE_OPENROUTER_MODEL, openRouterCampaignBudgetAllocation } from "./inference-broker.js"
import { resolveFleetBudgetBridgeRelease, verifyFleetBudgetCredential } from "./fleet-budget-ledger.js"
import { PostgresRsiJobQueue, fleetQueuePolicy } from "./postgres-queue.js"
import { verifyWorkerHarnessRuntime } from "./openshell.js"
import { workerHarnessRuntimeIdentityFromEnvironment } from "./worker-harness.js"
import type { RsiConfig, RsiRunRecord } from "./types.js"

const HEX40 = /^[a-f0-9]{40}$/
const HEX64 = /^[a-f0-9]{64}$/
const SAFE_PATH = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9._/-]{1,180}$/
const CAMPAIGN_TYPECHECK = "python3 -c \"compile(open('candidate.py').read(), 'candidate.py', 'exec')\""

export interface FleetCampaignFixtureManifest {
	schemaVersion: 1
	objective: FleetCampaignRsiPlan["objective"]
	candidatePath: "candidate.py"
	testsPath: "test_intake.py"
	corpusPath: "fixtures.json"
	candidateSha256: string
	testsSha256: string
	corpusSha256: string
	commands: string[]
}

export interface FleetCampaignRsiPlan {
	schemaVersion: 1
	campaignId: string
	repoRoot: string
	baseCommit: string
	campaignFixtures: { root: string; manifestSha256: string }
	harnessCommit: string
	dependencyLockSha256: string
	runtimeImageDigest: `sha256:${string}`
	evaluatorImageDigest: `sha256:${string}`
	evaluatorPolicySha256: string
	inferenceLimits: {
		maxCalls: 3
		maxInputTokensPerCall: 32_000
		maxOutputTokensPerCall: 4_000
		maxTotalTokens: 108_000
		maxCallSpendUsd: 0.01
		maxJobSpendUsd: 0.02
		maxCampaignSpendUsd: 0.02
		mutationBudgetUsd: 0.019
		benchmarkBudgetUsd: 0.001
		maxInputPricePerMillionUsd: 0.1
		maxOutputPricePerMillionUsd: 0.2
	}
	objective: "intake-parsing" | "deduplication" | "evidence-validation" | "reporting"
	allowedMutationPaths: readonly [string]
	regressionCommand: string
	evalCommands: readonly string[]
	typecheckCommand: string
	maxSpendUsd: number
	maxDurationMs: number
	maxWorkerIterations: 3
	planDigest: string
}

function canonical(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`
	if (value && typeof value === "object") {
		const row = value as Record<string, unknown>
	return `{${Object.keys(row).sort().map((key) => `${JSON.stringify(key)}:${canonical(row[key])}`).join(",")}}`
	}
	return JSON.stringify(value) ?? "null"
}

export function fleetCampaignRsiPlanDigest(plan: Omit<FleetCampaignRsiPlan, "planDigest">): string {
	return createHash("sha256").update(canonical(plan)).digest("hex")
}

export interface FleetRsiReadinessCheck {
	id: string
	state: "ready" | "missing" | "invalid"
	detail: string
}

export interface FleetRsiReadiness {
	mode: "synthetic-only"
	ready: boolean
	checks: FleetRsiReadinessCheck[]
	model: typeof RSI_MUSE_OPENROUTER_MODEL
	activation: "not-performed"
}

export interface FleetCampaignRsiDependencies {
	env?: NodeJS.ProcessEnv
	/** Must verify an owner-held, independent authorization bound to planDigest. */
	verifyPlanCheckpoint?: (planDigest: string, checkpoint: unknown) => Promise<boolean>
	/** True only after worker.ts actually dispatches brokers through Fleet's bridge. */
	sharedBudgetLedgerReady?: () => Promise<boolean>
	/** True only after Fleet's independent monitor reservations share the same authority. */
	monitorBudgetLedgerReady?: () => Promise<boolean>
	/** Test seam; production hashes the configured host-only Fleet key without exposing it. */
	fleetCredentialReady?: () => Promise<boolean>
	/** Test seam; production defaults to the existing runRsi controller. */
	execute?: (config: RsiConfig) => Promise<RsiRunRecord>
}

function validPlan(plan: FleetCampaignRsiPlan): void {
	const expectedKeys = "allowedMutationPaths,baseCommit,campaignFixtures,campaignId,dependencyLockSha256,evalCommands,evaluatorImageDigest,evaluatorPolicySha256,harnessCommit,inferenceLimits,maxDurationMs,maxSpendUsd,maxWorkerIterations,objective,planDigest,regressionCommand,repoRoot,runtimeImageDigest,schemaVersion,typecheckCommand"
	const limits = plan?.inferenceLimits
	if (!plan || typeof plan !== "object" || Object.keys(plan).sort().join(",") !== expectedKeys ||
		!plan.campaignFixtures || typeof plan.campaignFixtures !== "object" || Object.keys(plan.campaignFixtures).sort().join(",") !== "manifestSha256,root" ||
		!limits || Object.keys(limits).sort().join(",") !== "benchmarkBudgetUsd,maxCallSpendUsd,maxCalls,maxCampaignSpendUsd,maxInputPricePerMillionUsd,maxInputTokensPerCall,maxJobSpendUsd,maxOutputPricePerMillionUsd,maxOutputTokensPerCall,maxTotalTokens,mutationBudgetUsd" ||
		plan.schemaVersion !== 1 || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(plan.campaignId) ||
		!path.isAbsolute(plan.repoRoot) || path.resolve(plan.repoRoot) !== plan.repoRoot || !HEX40.test(plan.baseCommit) ||
		!path.isAbsolute(plan.campaignFixtures.root) || path.normalize(plan.campaignFixtures.root) !== plan.campaignFixtures.root || plan.campaignFixtures.root !== plan.repoRoot || !HEX64.test(plan.campaignFixtures.manifestSha256) ||
		!HEX40.test(plan.harnessCommit) || !HEX64.test(plan.dependencyLockSha256) ||
		!/^sha256:[a-f0-9]{64}$/.test(plan.runtimeImageDigest) ||
		!/^sha256:[a-f0-9]{64}$/.test(plan.evaluatorImageDigest) || !HEX64.test(plan.evaluatorPolicySha256) ||
		limits.maxCalls !== 3 || limits.maxInputTokensPerCall !== 32_000 || limits.maxOutputTokensPerCall !== 4_000 || limits.maxTotalTokens !== 108_000 ||
		limits.maxCallSpendUsd !== 0.01 || limits.maxJobSpendUsd !== 0.02 || limits.maxCampaignSpendUsd !== 0.02 ||
		limits.mutationBudgetUsd !== 0.019 || limits.benchmarkBudgetUsd !== 0.001 || limits.maxInputPricePerMillionUsd !== 0.1 || limits.maxOutputPricePerMillionUsd !== 0.2 ||
		!["intake-parsing", "deduplication", "evidence-validation", "reporting"].includes(plan.objective) ||
		!Array.isArray(plan.allowedMutationPaths) || plan.allowedMutationPaths.length !== 1 || !SAFE_PATH.test(plan.allowedMutationPaths[0]!) ||
		plan.allowedMutationPaths.some((entry) => ["operations", "src/rsi", "fixtures", "test", "tests", "package.json"].some((protectedPart) => entry === protectedPart || entry.startsWith(`${protectedPart}/`)) || entry.endsWith(".test.ts") || entry.endsWith(".spec.ts")) ||
		plan.objective !== "intake-parsing" || plan.allowedMutationPaths[0] !== "candidate.py" || plan.regressionCommand !== "python3 -m unittest test_intake" ||
		!Array.isArray(plan.evalCommands) || plan.evalCommands.length < 1 || plan.evalCommands.length > 8 || plan.evalCommands.some((command) => !/^python3 -m unittest [A-Za-z0-9_.-]{1,160}$/.test(command)) ||
		plan.typecheckCommand !== CAMPAIGN_TYPECHECK ||
		!Number.isFinite(plan.maxSpendUsd) || plan.maxSpendUsd <= 0 || plan.maxSpendUsd > 0.02 ||
		!Number.isSafeInteger(plan.maxDurationMs) || plan.maxDurationMs < 1 || plan.maxDurationMs > 300_000 || plan.maxWorkerIterations !== 3 ||
		!HEX64.test(plan.planDigest)) throw new Error("Fleet RSI plan failed fixed synthetic campaign validation")
	if (plan.allowedMutationPaths[0]!.split("/").some((segment) => segment === "." || segment === "..") || /^\.env(?:\.|$)/.test(path.posix.basename(plan.allowedMutationPaths[0]!))) throw new Error("Fleet RSI mutation path is protected")
	const { planDigest, ...unsigned } = plan
	const digest = fleetCampaignRsiPlanDigest(unsigned)
	if (digest !== planDigest) throw new Error("Fleet RSI plan digest does not match its frozen contents")
}

function envHas(env: NodeJS.ProcessEnv, key: string): boolean { return Boolean(env[key]?.trim()) }

/** True only when the trusted local assessment explicitly disables monitor inference. */
export async function readMonitorInferenceDisabled(configPath = "/etc/capsize-security-local-assessment.json", expectedUid = 0, expectedParentUid = 0): Promise<boolean> {
	let handle: fs.FileHandle | undefined
	try {
		const parentInfo = await fs.lstat(path.dirname(configPath))
		if (!parentInfo.isDirectory() || parentInfo.isSymbolicLink() || parentInfo.uid !== expectedParentUid || (parentInfo.mode & 0o022) !== 0) return false
		handle = await fs.open(configPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
		const info = await handle.stat()
		if (!info.isFile() || info.nlink !== 1 || info.uid !== expectedUid || (info.mode & 0o022) !== 0 || info.size > 64 * 1024) return false
		const parsed: unknown = JSON.parse(await handle.readFile("utf8"))
		return Boolean(parsed && typeof parsed === "object" && !Array.isArray(parsed) && (parsed as Record<string, unknown>).model_enabled === false)
	} catch { return false }
	finally { await handle?.close().catch(() => undefined) }
}

function safeCheck(id: string, state: FleetRsiReadinessCheck["state"], detail: string): FleetRsiReadinessCheck {
	return { id, state, detail }
}

async function readCampaignFixtureManifest(plan: FleetCampaignRsiPlan): Promise<FleetCampaignFixtureManifest> {
	const rootInfo = await fs.lstat(plan.campaignFixtures.root)
	const root = await fs.realpath(plan.campaignFixtures.root)
	if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink() || root !== plan.campaignFixtures.root) throw new Error("fixture root invalid")
	const manifestPath = path.join(root, "manifest.json")
	const manifestInfo = await fs.lstat(manifestPath)
	if (!manifestInfo.isFile() || manifestInfo.isSymbolicLink() || manifestInfo.size > 32 * 1024) throw new Error("fixture manifest invalid")
	const raw = await fs.readFile(manifestPath)
	if (createHash("sha256").update(raw).digest("hex") !== plan.campaignFixtures.manifestSha256) throw new Error("fixture manifest digest differs")
	const manifest = JSON.parse(raw.toString("utf8")) as FleetCampaignFixtureManifest
	const keys = "candidatePath,candidateSha256,commands,corpusPath,corpusSha256,objective,schemaVersion,testsPath,testsSha256"
	if (!manifest || typeof manifest !== "object" || Object.keys(manifest).sort().join(",") !== keys || manifest.schemaVersion !== 1 || manifest.objective !== plan.objective ||
		manifest.candidatePath !== "candidate.py" || manifest.testsPath !== "test_intake.py" || manifest.corpusPath !== "fixtures.json" ||
		![manifest.candidateSha256, manifest.testsSha256, manifest.corpusSha256].every((value) => typeof value === "string" && HEX64.test(value)) ||
		!Array.isArray(manifest.commands) || manifest.commands.length !== 4 || manifest.commands.some((command) => !/^python3 -m unittest test_intake\.CampaignCases\.test_(parse|deduplicate|recovery|report)$/.test(command)) ||
		new Set(manifest.commands).size !== manifest.commands.length || canonical(manifest.commands) !== canonical(plan.evalCommands)) throw new Error("fixture manifest invalid")
	for (const [relative, expected] of [[manifest.candidatePath, manifest.candidateSha256], [manifest.testsPath, manifest.testsSha256], [manifest.corpusPath, manifest.corpusSha256]] as const) {
		const file = path.join(root, relative)
		const info = await fs.lstat(file)
		if (!info.isFile() || info.isSymbolicLink() || info.size > 256 * 1024 || await fs.realpath(file) !== file || createHash("sha256").update(await fs.readFile(file)).digest("hex") !== expected) throw new Error("fixture file digest invalid")
	}
	return manifest
}

/** Read-only validation of the exact Fleet snapshot, evaluator and fixture pins. */
export async function preflightFleetCampaignRsi(plan: FleetCampaignRsiPlan, deps: FleetCampaignRsiDependencies = {}): Promise<FleetRsiReadiness> {
	const env = deps.env ?? process.env
	const checks: FleetRsiReadinessCheck[] = []
	try { validPlan(plan); checks.push(safeCheck("frozen-plan", "ready", "Exact synthetic-only plan digest and fixed mutation scope validated.")) }
	catch {
		checks.push(safeCheck("frozen-plan", "invalid", "Plan identity, bounds, or fixed scope is invalid."))
		return { mode: "synthetic-only", ready: false, checks, model: RSI_MUSE_OPENROUTER_MODEL, activation: "not-performed" }
	}

	try {
		const real = await fs.realpath(plan.repoRoot)
		const stat = await fs.lstat(plan.repoRoot)
		const root = spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd: real, encoding: "utf8", timeout: 3_000 })
		const actual = spawnSync("git", ["rev-parse", "HEAD"], { cwd: real, encoding: "utf8", timeout: 3_000 })
		const dirty = spawnSync("git", ["status", "--porcelain", "--untracked-files=all"], { cwd: real, encoding: "utf8", timeout: 3_000 })
		if (stat.isDirectory() && !stat.isSymbolicLink() && real === plan.repoRoot && root.status === 0 && path.resolve(root.stdout.trim()) === real && actual.status === 0 && actual.stdout.trim() === plan.baseCommit && dirty.status === 0 && dirty.stdout.trim() === "") checks.push(safeCheck("source-snapshot", "ready", "Synthetic repository matches the frozen commit and is clean."))
		else checks.push(safeCheck("source-snapshot", "invalid", "Synthetic repository does not match the frozen clean snapshot."))
	} catch { checks.push(safeCheck("source-snapshot", "invalid", "Synthetic repository identity could not be checked.")) }

	try {
		await readCampaignFixtureManifest(plan)
		checks.push(safeCheck("campaign-fixtures", "ready", "Synthetic manifest and all three fixed file digests match."))
	} catch { checks.push(safeCheck("campaign-fixtures", "invalid", "Frozen synthetic manifest or source file identity differs.")) }

	try {
		const policy = path.resolve(env.HEADLESSCODE_OPENSHELL_POLICY?.trim() || path.join(path.dirname(fileURLToPath(import.meta.url)), "../../shared/openshell/headlesscode-policy.yaml"))
		const digest = createHash("sha256").update(await fs.readFile(policy)).digest("hex")
		if (digest !== plan.evaluatorPolicySha256) throw new Error()
		checks.push(safeCheck("evaluator-policy", "ready", "OpenShell policy digest matches the frozen identity."))
	} catch { checks.push(safeCheck("evaluator-policy", "invalid", "OpenShell policy is missing or differs from the frozen digest.")) }
	checks.push(env.HEADLESSCODE_RSI_EVALUATOR_IMAGE_DIGEST === plan.evaluatorImageDigest
		? safeCheck("evaluator-image", "ready", "Evaluator image digest matches the frozen identity.")
		: safeCheck("evaluator-image", "invalid", "Evaluator image digest is missing or differs from the frozen identity."))
	checks.push(env.HEADLESSCODE_RSI_RUNTIME_HARNESS_COMMIT === plan.harnessCommit &&
		env.HEADLESSCODE_RSI_DEPENDENCY_LOCK_DIGEST === plan.dependencyLockSha256 && env.HEADLESSCODE_RSI_RUNTIME_IMAGE_DIGEST === plan.runtimeImageDigest
		? safeCheck("harness-runtime", "ready", "Worker harness, dependency lock, and runtime image match their frozen identities.")
		: safeCheck("harness-runtime", "invalid", "Worker harness, dependency lock, or runtime image differs from the frozen identity."))
	if (!deps.env) {
		try {
			const runtime = workerHarnessRuntimeIdentityFromEnvironment(env)
			if (runtime.imageDigest !== plan.runtimeImageDigest || runtime.harnessCommit !== plan.harnessCommit || runtime.dependencyLockDigest !== plan.dependencyLockSha256) throw new Error()
			verifyWorkerHarnessRuntime(runtime)
		} catch { checks.push(safeCheck("harness-runtime-image", "invalid", "Selected worker image does not match the frozen digest, harness marker, and lockfile.")) }
	}

	const artifactBackend = env.HEADLESSCODE_RSI_ARTIFACT_BACKEND?.trim() || "s3"
	const needed = ["HEADLESSCODE_RSI_DATABASE_URL", "HEADLESSCODE_RSI_BROKER_BIND_HOST", "HEADLESSCODE_OPENSHELL_POLICY",
		...(artifactBackend === "file" ? ["HEADLESSCODE_RSI_ARTIFACT_DIR"] : ["HEADLESSCODE_RSI_ARTIFACT_BUCKET"])]
	const missing = needed.filter((name) => !envHas(env, name))
	const workerProfileMatches = env.HEADLESSCODE_RSI_ROLE_WORKER_PROVIDER === "openrouter" &&
		env.HEADLESSCODE_RSI_ROLE_WORKER_MODEL === RSI_MUSE_OPENROUTER_MODEL &&
		env.HEADLESSCODE_RSI_ROLE_WORKER_OPENROUTER_PROFILE === "muse-spark-contributor"
	checks.push(missing.length || !workerProfileMatches
		? safeCheck("runtime-configuration", "missing", `Required runtime settings are absent or the fixed Muse worker profile differs${missing.length ? `: ${missing.join(", ")}` : "."}`)
		: safeCheck("runtime-configuration", "ready", "Required queue, artifact, broker, policy, and fixed Muse worker profile settings are present."))
	let providerKeyReady = false
	try {
		providerKeyReady = deps.fleetCredentialReady
			? await deps.fleetCredentialReady()
			: deps.env === undefined && await verifyFleetBudgetCredential()
	} catch { providerKeyReady = false }
	checks.push(providerKeyReady
		? safeCheck("provider-credential", "ready", "Configured host-only Fleet key matches its private identity pin.")
		: safeCheck("provider-credential", "missing", "Configured host-only Fleet key is unavailable or does not match its private identity pin."))
	try {
		const allocation = openRouterCampaignBudgetAllocation(env)
		const limit = plan.inferenceLimits
		const fieldsMatch = Number(env.HEADLESSCODE_RSI_OPENROUTER_MAX_CALLS) === limit.maxCalls &&
			Number(env.HEADLESSCODE_RSI_OPENROUTER_MAX_INPUT_TOKENS_PER_CALL) === limit.maxInputTokensPerCall &&
			Number(env.HEADLESSCODE_RSI_OPENROUTER_MAX_OUTPUT_TOKENS_PER_CALL) === limit.maxOutputTokensPerCall &&
			Number(env.HEADLESSCODE_RSI_OPENROUTER_MAX_TOTAL_TOKENS) === limit.maxTotalTokens &&
			Number(env.HEADLESSCODE_RSI_OPENROUTER_MAX_CALL_SPEND_USD) === limit.maxCallSpendUsd &&
			Number(env.HEADLESSCODE_RSI_OPENROUTER_MAX_JOB_SPEND_USD) === limit.maxJobSpendUsd &&
			Number(env.HEADLESSCODE_RSI_OPENROUTER_MAX_CAMPAIGN_SPEND_USD) === limit.maxCampaignSpendUsd &&
			Number(env.HEADLESSCODE_RSI_OPENROUTER_MUTATION_BUDGET_USD) === limit.mutationBudgetUsd &&
			Number(env.HEADLESSCODE_RSI_OPENROUTER_BENCHMARK_BUDGET_USD) === limit.benchmarkBudgetUsd &&
			Number(env.HEADLESSCODE_RSI_OPENROUTER_MAX_INPUT_PRICE_PER_MILLION_USD) === limit.maxInputPricePerMillionUsd &&
			Number(env.HEADLESSCODE_RSI_OPENROUTER_MAX_OUTPUT_PRICE_PER_MILLION_USD) === limit.maxOutputPricePerMillionUsd &&
			Number(env.HEADLESSCODE_RSI_OPENROUTER_MAX_DURATION_MS) === plan.maxDurationMs
		if (allocation.totalUsd !== plan.maxSpendUsd || !fieldsMatch) throw new Error()
		checks.push(safeCheck("spend-ceiling", "ready", "Configured allocation is within the frozen campaign ceiling."))
	} catch { checks.push(safeCheck("spend-ceiling", "missing", "A valid bounded allocation within the frozen ceiling is unavailable.")) }

	try {
		const status = spawnSync("openshell", ["gateway", "info"], { encoding: "utf8", timeout: 3_000 })
		const output = `${status.stdout ?? ""}\n${status.stderr ?? ""}`
		const detail = status.status === 0 && /Status:\s+healthy/i.test(output)
			? "OpenShell reports a healthy gateway."
			: (status.error as NodeJS.ErrnoException | null)?.code === "ENOENT"
				? "OpenShell CLI is not installed or is absent from PATH."
				: /ECONNREFUSED|connection refused/i.test(output)
					? "OpenShell gateway endpoint is refusing connections."
					: /certificate|tls|x509/i.test(output)
						? "OpenShell gateway TLS or client-certificate validation failed."
						: "OpenShell did not report a healthy gateway."
		checks.push(status.status === 0 && /Status:\s+healthy/i.test(output)
			? safeCheck("openshell-gateway", "ready", detail)
			: safeCheck("openshell-gateway", "missing", detail))
	} catch { checks.push(safeCheck("openshell-gateway", "missing", "OpenShell gateway status could not be read.")) }

	let bridgeReady = false
	try {
		bridgeReady = deps.sharedBudgetLedgerReady
			? await deps.sharedBudgetLedgerReady()
			: env.HEADLESSCODE_RSI_FLEET_BUDGET_LEDGER === "1" && deps.env === undefined
				? Boolean((await resolveFleetBudgetBridgeRelease()).bridgeModulePath)
				: false
	} catch { bridgeReady = false }
	checks.push(bridgeReady
		? safeCheck("shared-budget-ledger", "ready", "Worker broker is bound to Fleet's shared budget authority.")
		: safeCheck("shared-budget-ledger", "missing", "Worker-to-Fleet shared budget ledger binding is not verified."))
	checks.push(safeCheck("mutation-scope", "ready", "Mutation is restricted to the single frozen candidate path by worker and controller Git-diff guards."))

	let queue: PostgresRsiJobQueue | undefined
	try {
		const queueName = env.HEADLESSCODE_RSI_QUEUE_NAME?.trim() || "rsi-default"
		const maxInFlight = Number(env.HEADLESSCODE_RSI_MAX_IN_FLIGHT || "1")
		if (!Number.isSafeInteger(maxInFlight) || maxInFlight < 1) throw new Error()
		queue = PostgresRsiJobQueue.fromEnvironment(fleetQueuePolicy(queueName, maxInFlight, env), env)
		await queue.assertResourceClassCoverage(["REMOTE_API", "CPU"])
		checks.push(safeCheck("registered-workers", "ready", "Fresh queue registration covers mutation and evaluation workers."))
	} catch {
		checks.push(safeCheck("registered-workers", "missing", "PostgreSQL queue or fresh worker capacity for REMOTE_API and CPU is unavailable."))
	} finally { await queue?.close().catch(() => undefined) }

	let storageReady = false
	let storageState: "s3" | "file" = artifactBackend === "file" ? "file" : "s3"
	let s3: S3Client | undefined
	try {
		if (artifactBackend === "file") {
			const dir = env.HEADLESSCODE_RSI_ARTIFACT_DIR?.trim()
			if (dir) {
				const info = await fs.lstat(dir)
				storageReady = info.isDirectory() && !info.isSymbolicLink() && (info.mode & 0o077) === 0 && (typeof process.getuid !== "function" || info.uid === process.getuid())
			}
		} else if (artifactBackend === "s3") {
			const bucket = env.HEADLESSCODE_RSI_ARTIFACT_BUCKET?.trim()
			if (!bucket) throw new Error()
			s3 = new S3Client({ region: env.HEADLESSCODE_RSI_ARTIFACT_REGION?.trim() || env.AWS_REGION || "us-east-1",
				...(env.HEADLESSCODE_RSI_ARTIFACT_ENDPOINT?.trim() ? { endpoint: env.HEADLESSCODE_RSI_ARTIFACT_ENDPOINT.trim() } : {}),
				forcePathStyle: env.HEADLESSCODE_RSI_ARTIFACT_PATH_STYLE === "1" || Boolean(env.HEADLESSCODE_RSI_ARTIFACT_ENDPOINT?.trim()) })
			const controller = new AbortController()
			const timer = setTimeout(() => controller.abort(), 3_000)
			try { await s3.send(new HeadBucketCommand({ Bucket: bucket }), { abortSignal: controller.signal }); storageReady = true }
			finally { clearTimeout(timer) }
		} else throw new Error()
	} catch { storageReady = false } finally { s3?.destroy() }
	checks.push(storageReady
		? safeCheck("artifact-store", "ready", storageState === "file" ? "Configured private same-host artifact directory is accessible." : "Configured S3 artifact bucket passed a read-only access check.")
		: safeCheck("artifact-store", "missing", storageState === "file" ? "Configured private same-host artifact directory is unavailable." : "Configured S3 artifact bucket is unavailable to this process."))
	let monitorLedgerReady = false
	try {
		monitorLedgerReady = deps.monitorBudgetLedgerReady
			? (await deps.monitorBudgetLedgerReady()) === true
			: deps.env === undefined && await readMonitorInferenceDisabled()
	} catch { monitorLedgerReady = false }
	checks.push(monitorLedgerReady
		? safeCheck("monitor-budget-ledger", "ready", deps.monitorBudgetLedgerReady
			? "Independent monitor reservations share the Fleet budget authority."
			: "The protected local assessment has monitor inference disabled; no monitor reservation is needed.")
		: safeCheck("monitor-budget-ledger", "missing", "Independent monitor reservations are not verified against the shared campaign authority."))
	return { mode: "synthetic-only", ready: checks.every((check) => check.state === "ready"), checks, model: RSI_MUSE_OPENROUTER_MODEL, activation: "not-performed" }
}

/** Execute only after preflight and an independent authorization bound to the plan digest. */
export async function runAuthorizedFleetCampaignRsi(plan: FleetCampaignRsiPlan, checkpoint: unknown, deps: FleetCampaignRsiDependencies = {}): Promise<RsiRunRecord> {
	validPlan(plan)
	if (!deps.verifyPlanCheckpoint || !(await deps.verifyPlanCheckpoint(plan.planDigest, checkpoint))) throw new Error("root-recorded execution checkpoint does not match this frozen Fleet RSI plan")
	const readiness = await preflightFleetCampaignRsi(plan, deps)
	if (!readiness.ready) throw new Error(`Fleet RSI prerequisites are not ready: ${readiness.checks.filter((check) => check.state !== "ready").map((check) => check.id).join(", ")}`)
	const config: RsiConfig = {
		repoRoot: plan.repoRoot,
		model: RSI_MUSE_OPENROUTER_MODEL, population: 1, generations: 1, maxConcurrent: 1,
		mutationTask: `Synthetic ${plan.objective} handling only; do not access networks or modify evaluator, policy, schema, budget, refusal, or command files.`,
		regressionCommand: plan.regressionCommand, evalCommands: [...plan.evalCommands], hiddenEvalCommands: [],
		archiveDir: path.join(plan.repoRoot, ".headlesscode", "rsi", plan.campaignId), worktreeDir: path.join(plan.repoRoot, ".worktrees"),
		baseRef: plan.baseCommit, seed: plan.campaignId, dryRun: false, keepWorktrees: true, maxIterations: plan.maxWorkerIterations,
		maxRuntimeMs: plan.maxDurationMs, commandTimeoutMs: Math.min(plan.maxDurationMs, 120_000),
		maxTokens: plan.inferenceLimits.maxOutputTokensPerCall, protectedPaths: ["operations/campaign_controller.py", "operations/campaign_rsi.py", "operations/comms_policy.py", "fleet_watch/model.py", "fleet_watch/store.py", "fleet_watch/test_watch.py", "test_intake.py", "fixtures.json", "manifest.json"],
		mutationKind: "corrective", roles: { worker: { provider: "openrouter", model: RSI_MUSE_OPENROUTER_MODEL, openRouterProfile: "muse-spark-contributor" } },
		allowedMutationPaths: [...plan.allowedMutationPaths],
		campaignScopedEvaluation: {
			planDigest: plan.planDigest,
			fixtureDigest: plan.campaignFixtures.manifestSha256,
			evaluatorDigest: createHash("sha256").update(`${plan.evaluatorImageDigest}:${plan.evaluatorPolicySha256}`).digest("hex"),
			runtime: (() => {
				const runtime = workerHarnessRuntimeIdentityFromEnvironment(process.env)
				if (runtime.imageDigest !== plan.runtimeImageDigest || runtime.harnessCommit !== plan.harnessCommit || runtime.dependencyLockDigest !== plan.dependencyLockSha256) throw new Error("Fleet RSI worker runtime does not match the frozen campaign plan")
				return runtime
			})(),
			objective: plan.objective,
			typecheckCommand: plan.typecheckCommand,
		},
	}
	return (deps.execute ?? ((value) => runRsi(value)))(config)
}
