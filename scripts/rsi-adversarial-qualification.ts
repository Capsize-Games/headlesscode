#!/usr/bin/env node
import { createHash, createPrivateKey, createPublicKey, randomUUID, sign, verify } from "node:crypto"
import { constants } from "node:fs"
import * as fs from "node:fs/promises"
import { execFileSync } from "node:child_process"
import * as path from "node:path"
import { fileURLToPath } from "node:url"

import { OpenRouterClient, type OpenRouterGenerationMetadata } from "../src/llm/openrouter.js"
import { DEFAULT_PROTECTED_PATHS } from "../src/rsi/config.js"
import { ADVERSARIAL_COMMAND, requestAdversarialReview } from "../src/rsi/adversarial.js"
import { RSI_MUSE_OPENROUTER_MODEL, RSI_OPENROUTER_PROFILES } from "../src/rsi/inference-broker.js"
import { PostgresRsiJobQueue, fleetQueuePolicy, type FleetJob, type FleetJobIdentity, type FleetJobPayload } from "../src/rsi/postgres-queue.js"
import { runRsi } from "../src/rsi/controller.js"
import type { RsiConfig, RsiRunRecord, RoleModelConfig } from "../src/rsi/types.js"

export const REVIEWER_QUALIFICATION_LIMITS = Object.freeze({
	protocol: "headlesscode.rsi-adversarial-qualification.v2",
	requestedOutputTokens: 4_096,
	admittedOutputTokens: 6_144,
})
const MAX_REVIEW_OUTPUT_TOKENS = REVIEWER_QUALIFICATION_LIMITS.admittedOutputTokens
const MAX_REVIEW_PROMPT_BYTES = 16 * 1024
const MAX_REVIEW_COST_USD = 0.005
const MAX_REVIEW_HTTP_DURATION_MS = 120_000
const MAX_METADATA_HTTP_DURATION_MS = 120_000
export const ADVERSARIAL_QUALIFICATION_MAX_RUNTIME_MS = 10 * 60_000
const QUALIFICATION_MUTATION = "Deterministic qualification fixture patch; no mutation model or provider inference is used. The patch intentionally removes the upper clamp so the adversarial reviewer can test a changed source export."

export function createQualificationHttpDeadlines(timeout: (milliseconds: number) => AbortSignal = AbortSignal.timeout): {
	metadata: AbortSignal
	review(): AbortSignal
} {
	return {
		metadata: timeout(MAX_METADATA_HTTP_DURATION_MS),
		review: () => timeout(MAX_REVIEW_HTTP_DURATION_MS),
	}
}

interface Options {
	artifactsDir?: string
	signingKeyPath?: string
	trustedPublicKeyPath?: string
	publicKeySha256?: string
	help?: boolean
}

interface ReceiptEnvelope {
	schemaVersion: 1
	algorithm: "Ed25519"
	publicKeySha256: string
	payload: Record<string, unknown>
	signature: string
}

function sha256(value: string | Buffer): string {
	return createHash("sha256").update(value).digest("hex")
}

export function assertReviewerBillingTokens(usage: { promptTokens?: number; completionTokens?: number }, billing: OpenRouterGenerationMetadata): void {
	const billedPromptTokens = billing.nativeTokensPrompt ?? billing.tokensPrompt
	const billedCompletionTokens = billing.nativeTokensCompletion ?? billing.tokensCompletion
	if (!Number.isSafeInteger(usage.promptTokens) || !Number.isSafeInteger(usage.completionTokens) || usage.promptTokens! < 0 || usage.completionTokens! < 0 || billedPromptTokens !== usage.promptTokens || billedCompletionTokens !== usage.completionTokens) throw new Error("reviewer response and authoritative billing token counts do not match")
}

function canonicalJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`
	if (value && typeof value === "object") {
		const record = value as Record<string, unknown>
		return `{${Object.keys(record).filter((key) => record[key] !== undefined).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`
	}
	const encoded = JSON.stringify(value)
	if (encoded === undefined) throw new Error("receipt contains a non-JSON value")
	return encoded
}

export function parseQualificationArgs(argv: string[]): { options?: Options; error?: string } {
	const options: Options = {}
	for (let index = 0; index < argv.length; index++) {
		const arg = argv[index]
		if (arg === "--help" || arg === "-h") { options.help = true; continue }
		if (arg !== "--artifacts-dir" && arg !== "--receipt-signing-key" && arg !== "--receipt-public-key-sha256" && arg !== "--evaluator-trusted-public-key") return { error: `unknown argument: ${arg}` }
		const value = argv[index + 1]
		if (!value || value.startsWith("--")) return { error: `${arg} requires a value` }
		index++
		if (arg === "--artifacts-dir") options.artifactsDir = path.resolve(value)
		else if (arg === "--receipt-signing-key") options.signingKeyPath = path.resolve(value)
		else if (arg === "--evaluator-trusted-public-key") options.trustedPublicKeyPath = path.resolve(value)
		else options.publicKeySha256 = value.toLowerCase()
	}
	if (options.help) return { options }
	if (!options.signingKeyPath || !options.trustedPublicKeyPath || !options.publicKeySha256) return { error: "--receipt-signing-key, --evaluator-trusted-public-key, and --receipt-public-key-sha256 are required" }
	if (!/^[a-f0-9]{64}$/.test(options.publicKeySha256)) return { error: "--receipt-public-key-sha256 must be a SHA-256 hex digest" }
	return { options }
}

export function verifyReceipt(envelope: ReceiptEnvelope, pinnedPublicKeySha256: string, publicKey: Buffer): boolean {
	if (envelope.schemaVersion !== 1 || envelope.algorithm !== "Ed25519" || envelope.publicKeySha256 !== pinnedPublicKeySha256) return false
	if (sha256(createPublicKey(publicKey).export({ type: "spki", format: "der" })) !== pinnedPublicKeySha256) return false
	return verify(null, Buffer.from(canonicalJson(envelope.payload)), createPublicKey(publicKey), Buffer.from(envelope.signature, "base64"))
}

export function signReceipt(payload: Record<string, unknown>, privateKey: ReturnType<typeof createPrivateKey>, publicKey: ReturnType<typeof createPublicKey>, pinnedPublicKeySha256: string): ReceiptEnvelope {
	const actualPin = sha256(publicKey.export({ type: "spki", format: "der" }))
	if (actualPin !== pinnedPublicKeySha256) throw new Error("receipt signing key does not match --receipt-public-key-sha256")
	const signature = sign(null, Buffer.from(canonicalJson(payload)), privateKey).toString("base64")
	const envelope: ReceiptEnvelope = { schemaVersion: 1, algorithm: "Ed25519", publicKeySha256: actualPin, payload, signature }
	if (!verify(null, Buffer.from(canonicalJson(payload)), publicKey, Buffer.from(signature, "base64"))) throw new Error("signed qualification receipt failed its local signature check")
	return envelope
}

async function loadSigningKeys(keyPath: string, expectedPin: string): Promise<{ privateKey: ReturnType<typeof createPrivateKey>; publicKey: ReturnType<typeof createPublicKey> }> {
	const resolved = path.resolve(keyPath)
	const parts = resolved.split(path.sep).filter(Boolean)
	let cursor = path.parse(resolved).root
	for (const part of parts) {
		cursor = path.join(cursor, part)
		const stat = await fs.lstat(cursor)
		if (stat.isSymbolicLink()) throw new Error("receipt signing-key path must not contain symlinks")
	}
	const handle = await fs.open(resolved, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
	try {
		const stat = await handle.stat()
		if (!stat.isFile() || stat.size < 1 || stat.size > 16 * 1024 || (stat.mode & 0o077) !== 0) throw new Error("receipt signing key must be a regular file, at most 16 KiB, with mode 0600 or stricter")
		if (typeof process.getuid === "function" && stat.uid !== process.getuid()) throw new Error("receipt signing key must be owned by the current user")
		const bytes = await handle.readFile()
		const privateKey = createPrivateKey(bytes)
		if (privateKey.asymmetricKeyType !== "ed25519") throw new Error("receipt signing key must be Ed25519")
		const publicKey = createPublicKey(privateKey)
		if (sha256(publicKey.export({ type: "spki", format: "der" })) !== expectedPin) throw new Error("receipt signing key does not match the pinned public-key SHA-256")
		return { privateKey, publicKey }
	} finally {
		await handle.close()
	}
}

async function writePrivateFile(root: string, relative: string, content: Buffer | string): Promise<{ path: string; sha256: string; bytes: number }> {
	const destination = path.resolve(root, relative)
	if (!destination.startsWith(`${path.resolve(root)}${path.sep}`)) throw new Error("artifact path escaped the qualification output directory")
	const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content)
	await ensurePrivateDirectory(path.dirname(destination))
	const handle = await fs.open(destination, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600)
	try { await handle.writeFile(bytes); await handle.sync() } finally { await handle.close() }
	return { path: relative, sha256: sha256(bytes), bytes: bytes.byteLength }
}

/** Preserve charged exchanges before any identity, usage, or controller gate can reject them. */
export async function captureReviewerExchange(
	root: string,
	identity: Record<string, unknown>,
	response: string | undefined,
	lookupBilling: (generationId: string) => Promise<OpenRouterGenerationMetadata | undefined>,
): Promise<OpenRouterGenerationMetadata | undefined> {
	await writePrivateFile(root, "reviewer-response-identity.json", JSON.stringify(identity, null, 2) + "\n")
	if (response !== undefined) await writePrivateFile(root, "reviewer-response.txt", response)
	try {
		if (typeof identity.generationId !== "string" || !identity.generationId || identity.generationId.length > 512) throw new Error("OpenRouter did not return a bounded generation ID for billing identity")
		const billing = await lookupBilling(identity.generationId)
		await writePrivateFile(root, "reviewer-generation-billing.json", JSON.stringify({ generationId: identity.generationId, billing: billing ?? null }, null, 2) + "\n")
		return billing
	} catch (error) {
		await writePrivateFile(root, "reviewer-billing-failure.json", JSON.stringify({ generationId: identity.generationId ?? null, error: error instanceof Error ? error.message.slice(0, 512) : "billing lookup failed" }, null, 2) + "\n")
		throw error
	}
}

export async function ensurePrivateDirectory(directory: string): Promise<void> {
	const resolved = path.resolve(directory)
	let cursor = path.parse(resolved).root
	const parts = resolved.slice(cursor.length).split(path.sep).filter(Boolean)
	for (const part of parts) {
		cursor = path.join(cursor, part)
		try {
			const stat = await fs.lstat(cursor)
			if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("private qualification path contains a symlink or non-directory component")
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
			await fs.mkdir(cursor, { mode: 0o700 })
		}
	}
	const stat = await fs.lstat(resolved)
	if ((stat.mode & 0o077) !== 0 || await fs.realpath(resolved) !== resolved) throw new Error("qualification directory must be private and must not traverse symlinks")
}

function git(cwd: string, args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim()
}

export async function createSyntheticWorkspace(root: string): Promise<{ repoRoot: string; mutationPatch: Buffer; sourcePatchSha256: string }> {
	const repoRoot = path.join(root, "synthetic-repo")
	await fs.mkdir(path.join(repoRoot, "src"), { recursive: true, mode: 0o700 })
	await fs.writeFile(path.join(repoRoot, "package.json"), JSON.stringify({ name: "rsi-adversarial-qualification-fixture", private: true, type: "module", scripts: { typecheck: "node --check src/subject.mjs" } }, null, 2) + "\n", { mode: 0o600, flag: "wx" })
	const sourcePath = path.join(repoRoot, "src", "subject.mjs")
	const baseline = "export function clampPercent(value) {\n\treturn Math.max(0, Math.min(100, Math.trunc(value)))\n}\n"
	const candidate = "export function clampPercent(value) {\n\treturn Math.max(0, Math.trunc(value))\n}\n"
	await fs.writeFile(sourcePath, baseline, { mode: 0o600, flag: "wx" })
	git(repoRoot, ["init", "--quiet", "--initial-branch=main"])
	git(repoRoot, ["config", "user.name", "HeadlessCode qualification fixture"])
	git(repoRoot, ["config", "user.email", "qualification-fixture@example.invalid"])
	git(repoRoot, ["add", "package.json", "src/subject.mjs"])
	git(repoRoot, ["-c", "core.hooksPath=/dev/null", "commit", "--quiet", "-m", "synthetic adversarial qualification baseline"])
	await fs.writeFile(sourcePath, candidate, { mode: 0o600 })
	const mutationPatch = execFileSync("git", ["diff", "--binary", "--no-ext-diff", "--no-renames", "--", "src/subject.mjs"], { cwd: repoRoot, encoding: "buffer" }) as Buffer
	if (mutationPatch.byteLength < 1 || mutationPatch.byteLength > 32 * 1024) throw new Error("synthetic candidate patch is empty or oversized")
	await fs.writeFile(sourcePath, baseline, { mode: 0o600 })
	if (git(repoRoot, ["status", "--porcelain", "--untracked-files=all"])) throw new Error("synthetic fixture repo was not restored to its clean baseline")
	return { repoRoot, mutationPatch, sourcePatchSha256: sha256(mutationPatch) }
}

function queueWithFixtureMutation(queue: PostgresRsiJobQueue, patch: Buffer): { queue: PostgresRsiJobQueue; jobs: Map<string, FleetJob> } {
	const jobs = new Map<string, FleetJob>()
	const byKey = new Map<string, FleetJob>()
	const wrapped = new Proxy(queue, {
		get(target, property) {
			if (property === "close") return async () => undefined
			if (property === "enqueue") return async (input: FleetJobIdentity): Promise<FleetJob> => {
				if (input.jobKind !== "mutation") return target.enqueue(input)
				const artifact = await target.putArtifact(patch)
				const now = new Date().toISOString()
				const job: FleetJob = {
					jobId: `fixture-${randomUUID()}`, idempotencyKey: input.idempotencyKey, runId: input.runId,
					candidateId: input.candidateId, jobKind: input.jobKind, resourceClass: input.resourceClass,
					...(input.concurrencyKey ? { concurrencyKey: input.concurrencyKey } : {}), artifactSha256: input.artifactSha256,
					payload: input.payload as FleetJobPayload, status: "completed", attempts: 1, maxAttempts: 1,
					leaseDurationMs: 1, result: { ok: true, provider: "fixture-script", model: "deterministic-patch", patchSha256: artifact.sha256, patchBytes: artifact.byteLength, durationMs: 0 },
					createdAt: now, updatedAt: now,
				}
				jobs.set(job.jobId, job)
				byKey.set(job.idempotencyKey, job)
				return job
			}
			if (property === "getJob") return async (jobId: string) => jobs.get(jobId) ?? target.getJob(jobId)
			if (property === "getJobByIdempotencyKey") return async (key: string) => byKey.get(key) ?? target.getJobByIdempotencyKey(key)
			const value = Reflect.get(target, property, target) as unknown
			return typeof value === "function" ? value.bind(target) : value
		},
	}) as PostgresRsiJobQueue
	return { queue: wrapped, jobs }
}

export function verifyControllerGate(run: RsiRunRecord, reviewStatus: string, testResults: Array<{ passed: boolean }>, penaltyPoints: number): { gateMatched: boolean; selectionMatched: boolean; expectedAdversarialPass: boolean } {
	if (run.candidates.length !== 1) throw new Error("controlled qualification must produce exactly one candidate")
	const candidate = run.candidates[0]!
	const expectedAdversarialPass = reviewStatus === "passed" && testResults.length > 0 && testResults.every((test) => test.passed)
	const gateMatched = candidate.fitness?.hardGates.adversarialPass === expectedAdversarialPass && (candidate.fitness?.adversarialPenalty ?? 0) === penaltyPoints
	const shouldSelect = candidate.status === "accepted" && candidate.developmentProof?.accepted === true && candidate.fitness?.score !== undefined && candidate.fitness.score > 0
	const selectionMatched = shouldSelect ? run.selected === candidate.id && run.selectedCandidates?.includes(candidate.id) === true : run.selected !== candidate.id && !(run.selectedCandidates ?? []).includes(candidate.id)
	return { gateMatched, selectionMatched, expectedAdversarialPass }
}

/** A rejected candidate alone cannot qualify a broken evaluator as a counterexample. */
export function assertControlledCounterexample(output: Buffer): void {
	const records: unknown = JSON.parse(output.toString("utf8"))
	if (!Array.isArray(records)) throw new Error("controlled evaluator output must be an array")
	const matches = records.filter((record) => record && typeof record === "object" && record.command === ADVERSARIAL_COMMAND)
	if (matches.length !== 1) throw new Error("controlled evaluator output lacks one exact adversarial command")
	const record = matches[0] as { stdout?: unknown; stderr?: unknown }
	const text = [record.stdout, record.stderr].filter((value): value is string => typeof value === "string").join("\n")
	if (!text.includes("AssertionError") || !text.includes("ERR_ASSERTION") || /ERR_MODULE_NOT_FOUND|MODULE_NOT_FOUND|SyntaxError|ReferenceError/.test(text)) {
		throw new Error("controlled candidate did not produce an executed assertion counterexample")
	}
}

function helpText(): string {
	return [
		"Usage: npx tsx scripts/rsi-adversarial-qualification.ts --receipt-signing-key <mode-0600-ed25519-key> --receipt-public-key-sha256 <sha256> --evaluator-trusted-public-key <mode-0600-public-key>",
		"       [--artifacts-dir <private-output-directory>]",
		"Runs a synthetic controlled candidate through one Meta-routed OpenRouter Muse Contributor review and a separate OpenShell CPU evaluation guest.",
		"The fixture mutation is scripted, not model-generated. Requires the configured RSI PostgreSQL/S3 queue, an active CPU OpenShell worker, and HEADLESSCODE_OPENROUTER_API_KEY.",
	].join("\n") + "\n"
}

export async function runAdversarialQualification(options: Required<Pick<Options, "signingKeyPath" | "trustedPublicKeyPath" | "publicKeySha256">> & Pick<Options, "artifactsDir">): Promise<{ outputDir: string; qualification: Record<string, unknown> }> {
	if (!process.env.HEADLESSCODE_OPENROUTER_API_KEY?.trim()) throw new Error("HEADLESSCODE_OPENROUTER_API_KEY is required for the single live reviewer call")
	const scratchRoot = path.resolve(process.cwd(), ".headlesscode", "scratch")
	const tempRoot = process.env.TMPDIR ? path.resolve(process.env.TMPDIR) : ""
	if (!tempRoot || !tempRoot.startsWith(`${scratchRoot}${path.sep}`)) throw new Error(`TMPDIR must point inside ${scratchRoot}; refusing system temporary directories`)
	await ensurePrivateDirectory(tempRoot)
	const tempStat = await fs.lstat(tempRoot)
	if (tempStat.isSymbolicLink() || !tempStat.isDirectory() || (tempStat.mode & 0o077) !== 0) throw new Error("TMPDIR must be a non-symlink private directory with mode 0700 or stricter")
	const outputDir = path.resolve(options.artifactsDir ?? path.join(process.cwd(), ".headlesscode", "scratch", "rsi-adversarial-qualification", new Date().toISOString().replace(/[:.]/g, "-")))
	await ensurePrivateDirectory(outputDir)
	const outputStat = await fs.lstat(outputDir)
	if (outputStat.isSymbolicLink() || !outputStat.isDirectory() || (outputStat.mode & 0o077) !== 0) throw new Error("artifact directory must be a non-symlink directory with mode 0700 or stricter")
	const keys = await loadSigningKeys(options.signingKeyPath, options.publicKeySha256)
	const source = await createSyntheticWorkspace(outputDir)
	const runId = `adversarial-qualification-${randomUUID()}`
	const artifactsDir = path.join(outputDir, "artifacts")
	await fs.mkdir(artifactsDir, { mode: 0o700 })
	const role: RoleModelConfig = { provider: "openrouter", model: RSI_MUSE_OPENROUTER_MODEL }
	const profile = RSI_OPENROUTER_PROFILES["muse-spark-contributor"]
	const client = new OpenRouterClient({ defaultModel: profile.model, disableTranscriptCapture: true })
	const httpDeadlines = createQualificationHttpDeadlines()
	const metadata = await client.fetchModelInfo(profile.model, httpDeadlines.metadata)
	if (!metadata?.price || !(metadata.endpoints ?? []).some((endpoint) => endpoint.providerName?.toLowerCase() === "meta")) throw new Error("OpenRouter Muse endpoint metadata is unavailable or does not advertise Meta")
	const { input: inputPrice, output: outputPrice } = metadata.price
	if (!Number.isFinite(inputPrice) || !Number.isFinite(outputPrice) || inputPrice <= 0 || outputPrice <= 0 || inputPrice > 0.10 || outputPrice > 0.20) throw new Error("Muse endpoint prices are unavailable or exceed the qualification ceiling ($0.10/M input, $0.20/M output)")
	const queueBase = PostgresRsiJobQueue.fromEnvironment(fleetQueuePolicy(process.env.HEADLESSCODE_RSI_QUEUE_NAME?.trim() || "rsi-default", 1, process.env), process.env)
	const queueWrap = queueWithFixtureMutation(queueBase, source.mutationPatch)
	const capturedJobs = queueWrap.jobs
	let promptText: string | undefined
	let responseText: string | undefined
	let responseIdentity: Record<string, unknown> | undefined
	let reviewerCalls = 0
	let generationBilling: Record<string, unknown> | undefined
	let run: RsiRunRecord | undefined
	const config: RsiConfig = {
		repoRoot: source.repoRoot, model: "qualification-fixture-worker", population: 1, generations: 1, maxConcurrent: 1,
		mutationTask: QUALIFICATION_MUTATION, regressionCommand: "node --input-type=module -e \"import { clampPercent } from './src/subject.mjs'; if (clampPercent(50) !== 50) process.exit(1)\"",
		evalCommands: ["node --input-type=module -e \"import { clampPercent } from './src/subject.mjs'; if (clampPercent(25) !== 25) process.exit(1)\""],
		hiddenEvalCommands: [], archiveDir: path.join(outputDir, "archive"), worktreeDir: path.join(source.repoRoot, ".worktrees"),
		baseRef: "main", seed: runId, dryRun: false, keepWorktrees: false, maxIterations: 1, maxTokens: 32,
		maxTrajectories: 1, maxTotalIterations: 1, maxRuntimeMs: ADVERSARIAL_QUALIFICATION_MAX_RUNTIME_MS, protectedPaths: [...DEFAULT_PROTECTED_PATHS],
		commandTimeoutMs: 60_000, evaluatorSigningKeyPath: options.signingKeyPath, evaluatorTrustedPublicKeyPath: options.trustedPublicKeyPath, evaluatorTrustedKeySha256: `sha256:${options.publicKeySha256}`, roles: { worker: { provider: "ollama", model: "qualification-fixture-worker" }, adversary: role },
	}
	try {
		run = await runRsi(config, {
			log: () => undefined,
			runAdversary: async ({ role: actualRole, prompt }) => {
				reviewerCalls++
				if (reviewerCalls !== 1 || actualRole.provider !== "openrouter" || actualRole.model !== profile.model) throw new Error("qualification attempted an unexpected reviewer identity or more than one call")
				const reviewSignal = httpDeadlines.review()
				promptText = prompt
				const promptBytes = Buffer.byteLength(prompt, "utf8")
				if (promptBytes > MAX_REVIEW_PROMPT_BYTES) throw new Error("review prompt exceeds the 16 KiB qualification bound")
				const requestCostCeiling = (promptBytes * inputPrice + MAX_REVIEW_OUTPUT_TOKENS * outputPrice) / 1_000_000
				if (requestCostCeiling > MAX_REVIEW_COST_USD) throw new Error("conservative reviewer call cost exceeds the $0.005 qualification cap")
				const raw = await requestAdversarialReview(actualRole, prompt, {
					createChatCompletion: async (request) => {
						const requestBytes = Buffer.byteLength(JSON.stringify({
							model: profile.model,
							messages: request.messages,
							temperature: 0.1,
							max_tokens: REVIEWER_QUALIFICATION_LIMITS.requestedOutputTokens,
							provider: { only: ["meta"], allow_fallbacks: false },
						}), "utf8")
						if (requestBytes > MAX_REVIEW_PROMPT_BYTES) throw new Error("serialized reviewer request exceeds the 16 KiB qualification bound")
						const requestCostCeiling = (requestBytes * inputPrice + MAX_REVIEW_OUTPUT_TOKENS * outputPrice) / 1_000_000
						if (requestCostCeiling > MAX_REVIEW_COST_USD) throw new Error("conservative reviewer call cost exceeds the $0.005 qualification cap")
						const response = await client.createChatCompletion({
							...request,
							model: profile.model,
							maxTokens: REVIEWER_QUALIFICATION_LIMITS.requestedOutputTokens,
							providerOnly: "meta",
							signal: reviewSignal,
						})
						const returnedModel = response.returnedModel
						const providerName = response.providerName
						responseIdentity = {
							requestedModel: profile.model, returnedModel, providerName,
							generationId: response.generationId,
							usage: response.usage ?? {},
							promptBytes, requestBytes, maxOutputTokens: MAX_REVIEW_OUTPUT_TOKENS,
							requestedOutputTokens: REVIEWER_QUALIFICATION_LIMITS.requestedOutputTokens,
							worstCaseCostUsd: requestCostCeiling,
						}
						responseText = typeof response.message.content === "string" ? response.message.content : undefined
						const billing = await captureReviewerExchange(artifactsDir, responseIdentity, responseText, (id) => client.fetchGenerationMetadata(id, reviewSignal))
						generationBilling = billing as unknown as Record<string, unknown> | undefined
						if (!returnedModel || !profile.returnedModels.includes(returnedModel) || providerName?.toLowerCase() !== "meta") throw new Error("OpenRouter reviewer response did not match the admitted Muse model and Meta provider")
						if (response.usage?.promptTokens !== undefined && response.usage.promptTokens > promptBytes) throw new Error("reported reviewer input tokens exceeded the conservative byte bound")
						if (response.usage?.completionTokens !== undefined && response.usage.completionTokens > MAX_REVIEW_OUTPUT_TOKENS) throw new Error("reviewer output exceeded its token cap")
						return response
					},
				})
				if (!responseText || raw !== responseText.trim()) throw new Error("review response content capture did not match the controller response")
				if (!responseIdentity?.generationId || typeof responseIdentity.generationId !== "string") throw new Error("OpenRouter did not return a generation ID for billing identity")
				const billing = generationBilling as OpenRouterGenerationMetadata | undefined
				if (!billing || billing.providerName?.toLowerCase() !== "meta" || !billing.model || !profile.returnedModels.includes(billing.model)) throw new Error("OpenRouter billing record is unavailable or does not match the admitted Muse/Meta identity")
				if (billing.id !== responseIdentity.generationId || typeof billing.totalCostUsd !== "number" || !Number.isFinite(billing.totalCostUsd) || billing.totalCostUsd < 0 || billing.totalCostUsd > MAX_REVIEW_COST_USD) throw new Error("OpenRouter billing record is unavailable or exceeds the $0.005 qualification cap")
				const usage = responseIdentity.usage as { promptTokens?: number; completionTokens?: number }
				assertReviewerBillingTokens(usage, billing)
				generationBilling = billing as unknown as Record<string, unknown>
				return raw
			},
			runDevelopmentBenchmark: async () => { throw new Error("qualification stop: development benchmarks are deliberately excluded so this command admits only the single adversarial reviewer call") },
		}, queueWrap.queue)
	} catch (error) {
		await queueBase.close()
		throw error
	}
	try {
	if (!run || reviewerCalls !== 1 || !promptText || !responseText || !responseIdentity || !generationBilling) throw new Error("qualification did not complete exactly one identity-verified real reviewer call")
	const review = run.adversarialReviews?.[0]
	const candidate = run.candidates[0]
	if (!review || !candidate) throw new Error("controller archive lacks the controlled candidate review")
	const qualification = verifyControllerGate(run, review.status, review.testResults, review.penaltyPoints)
	if (!qualification.gateMatched || !qualification.selectionMatched) throw new Error("independent gate or single-candidate selection reconstruction disagrees with the controller archive")
	const evaluationJob = review.jobId ? (await queueBase.getJob(review.jobId)) : undefined
	if (!evaluationJob || evaluationJob.jobKind !== "evaluation" || evaluationJob.status !== "completed") throw new Error("OpenShell adversarial evaluation job is missing or incomplete")
	const result = evaluationJob.result as { evaluation?: { visible?: Array<{ outputArtifactSha256?: string }> }; outputArtifact?: { sha256?: string; bytes?: number } } | undefined
	const outputSha = result?.evaluation?.visible?.[0]?.outputArtifactSha256 ?? result?.outputArtifact?.sha256
	if (!outputSha) throw new Error("OpenShell evaluator did not return a durable output artifact reference")
	const openShellOutput = await queueBase.getArtifact(outputSha)
	if (sha256(openShellOutput) !== outputSha) throw new Error("OpenShell output artifact digest did not verify")
	const artifactRefs: Record<string, { sha256: string; bytes: number }> = {}
	for (const [name, digest] of [
		["prompt.json", review.promptArtifactSha256], ["response.txt", review.resultArtifactSha256],
		["generated-tests.json", review.testArtifactSha256], ["evaluation-snapshot.bundle", review.snapshotArtifactSha256],
	] as const) {
		if (!digest) throw new Error(`controller review lacks ${name} artifact provenance`)
		const bytes = await queueBase.getArtifact(digest)
		if (sha256(bytes) !== digest) throw new Error(`${name} artifact digest did not verify`)
		artifactRefs[name] = await writePrivateFile(artifactsDir, name, bytes)
	}
	artifactRefs["openshell-output.json"] = await writePrivateFile(artifactsDir, "openshell-output.json", openShellOutput)
	artifactRefs["controller-run.json"] = await writePrivateFile(artifactsDir, "controller-run.json", JSON.stringify(run, null, 2) + "\n")
	const archiveBytes = await fs.readFile(path.join(config.archiveDir, "archive.json"))
	artifactRefs["controller-archive.json"] = await writePrivateFile(artifactsDir, "controller-archive.json", archiveBytes)
	assertControlledCounterexample(openShellOutput)
	const candidateGate = candidate.fitness?.hardGates.adversarialPass
	const payload: Record<string, unknown> = {
		protocol: REVIEWER_QUALIFICATION_LIMITS.protocol,
		createdAt: new Date().toISOString(),
		fixture: { kind: "synthetic-controlled-candidate", mutationInferenceCalls: 0, sourcePatchSha256: source.sourcePatchSha256, changedFiles: candidate.changedFiles },
		reviewer: {
			role: "adversary", requested: profile.model, providerOnly: "meta", ...responseIdentity, billing: generationBilling,
			endpointAdmission: { pricePerMillion: metadata.price, endpoints: metadata.endpoints, contextWindow: metadata.contextWindow },
		},
		limits: { reviewerCalls: 1, maxOutputTokens: MAX_REVIEW_OUTPUT_TOKENS, requestedOutputTokens: REVIEWER_QUALIFICATION_LIMITS.requestedOutputTokens, maxPromptBytes: MAX_REVIEW_PROMPT_BYTES, maxCallCostUsd: MAX_REVIEW_COST_USD },
		controllerReview: { status: review.status, provider: review.provider, model: review.model, promptVersion: review.promptVersion, promptSha256: review.promptSha256, resultSha256: review.resultSha256, testSha256: review.testArtifactSha256, snapshotSha256: review.snapshotArtifactSha256, findings: review.findings, testResults: review.testResults, penaltyPoints: review.penaltyPoints, evaluationJobId: review.jobId },
		openShell: { queueName: queueBase.policy.queueName, jobId: evaluationJob.jobId, jobKind: evaluationJob.jobKind, status: evaluationJob.status, snapshotSha256: evaluationJob.artifactSha256, outputSha256: outputSha, workerResult: result?.evaluation?.visible?.[0] ?? result?.outputArtifact },
		independentDecision: { expectedAdversarialPass: qualification.expectedAdversarialPass, controllerAdversarialPass: candidateGate, gateMatched: qualification.gateMatched, candidateStatus: candidate.status, selected: run.selected ?? null, selectedCandidates: run.selectedCandidates ?? [], selectionMatched: qualification.selectionMatched, developmentProof: candidate.developmentProof?.accepted === true ? "completed" : "not-qualified-by-this-one-review command" },
		artifacts: artifactRefs,
	}
	const signed = signReceipt(payload, keys.privateKey, keys.publicKey, options.publicKeySha256)
	const envelopeBytes = JSON.stringify(signed, null, 2) + "\n"
	const receiptArtifact = await writePrivateFile(outputDir, "qualification-receipt.json", envelopeBytes)
	return { outputDir, qualification: { receipt: receiptArtifact, gateMatched: qualification.gateMatched, selectionMatched: qualification.selectionMatched, reviewStatus: review.status, candidateStatus: candidate.status, selected: run.selected ?? null, testResults: review.testResults } }
	} finally {
		await queueBase.close()
	}
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
	const parsed = parseQualificationArgs(process.argv.slice(2))
	if (parsed.options?.help) process.stdout.write(helpText())
	else if (parsed.error || !parsed.options?.signingKeyPath || !parsed.options.publicKeySha256) {
		process.stderr.write(`rsi-adversarial-qualification: ${parsed.error ?? "invalid options"}\n${helpText()}`)
		process.exitCode = 2
	} else {
		try {
			const result = await runAdversarialQualification(parsed.options as Required<Pick<Options, "signingKeyPath" | "trustedPublicKeyPath" | "publicKeySha256">> & Pick<Options, "artifactsDir">)
			process.stdout.write(JSON.stringify(result.qualification) + `\nArtifacts: ${result.outputDir}\n`)
		} catch (error) {
			process.stderr.write(`rsi-adversarial-qualification: ${error instanceof Error ? error.message : String(error)}\n`)
			process.exitCode = 1
		}
	}
}
