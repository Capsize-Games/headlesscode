import { createHash, randomUUID } from "node:crypto"
import { readFileSync } from "node:fs"
import { Pool, type PoolClient } from "pg"
import type { ResourceClass, WorkerHarnessMode, WorkerHarnessRuntimeIdentity } from "./types.js"
import { createRsiArtifactStore, type RsiArtifactReference, type RsiArtifactStore } from "./artifact-store.js"
import { sumMicrousd, sumMicrousdAsUsd, usdEqualsMicrousd } from "./microusd.js"
import { endpointPriceIdentity, openRouterProfileForModel, RSI_DEFAULT_OPENROUTER_PROFILE_ID, type OpenRouterBrokerGrant, type OpenRouterBrokerReceipt, type OpenRouterCallReceipt, type OpenRouterCallReservation, type OpenRouterCallSettlement, type OpenRouterDenialReason, type OpenRouterEndpointPriceSnapshot, type OpenRouterInferenceLedger, type RsiOpenRouterProfileId } from "./inference-broker.js"
import type { OpenRouterBrokerLimits } from "./inference-broker.js"
import { PostgresProofCampaign, type ProofCampaignArmLease, type ProofCampaignManifest } from "./proof-campaign.js"

const MIGRATIONS = [
	{ version: 1, sql: readFileSync(new URL("./migrations/001_postgres_fleet_queue.sql", import.meta.url), "utf8") },
	{ version: 2, sql: readFileSync(new URL("./migrations/002_external_artifacts_and_job_leases.sql", import.meta.url), "utf8") },
	{ version: 3, sql: readFileSync(new URL("./migrations/003_model_training_jobs.sql", import.meta.url), "utf8") },
	{ version: 4, sql: readFileSync(new URL("./migrations/004_openrouter_inference_broker.sql", import.meta.url), "utf8") },
	{ version: 5, sql: readFileSync(new URL("./migrations/005_openrouter_denial_summaries.sql", import.meta.url), "utf8") },
	{ version: 6, sql: readFileSync(new URL("./migrations/006_proof_campaigns.sql", import.meta.url), "utf8") },
	{ version: 7, sql: readFileSync(new URL("./migrations/007_proof_campaign_phases.sql", import.meta.url), "utf8") },
	{ version: 8, sql: readFileSync(new URL("./migrations/008_openrouter_returned_provider.sql", import.meta.url), "utf8") },
	{ version: 9, sql: readFileSync(new URL("./migrations/009_openrouter_cached_prompt_tokens.sql", import.meta.url), "utf8") },
	{ version: 10, sql: readFileSync(new URL("./migrations/010_openrouter_endpoint_price_snapshot.sql", import.meta.url), "utf8") },
	{ version: 11, sql: readFileSync(new URL("./migrations/011_fleet_cancellation_requests.sql", import.meta.url), "utf8") },
]

function sha256Text(value: string): string { return createHash("sha256").update(value).digest("hex") }
function usdToMicrosCeiling(value: number): number {
	const result = Math.ceil(value * 1_000_000)
	if (!Number.isSafeInteger(result) || result < 0) throw new Error("invalid broker USD amount")
	return result
}
function usdCapToMicros(value: number): number {
	const result = Math.floor(value * 1_000_000)
	if (!Number.isSafeInteger(result) || result < 0) throw new Error("invalid broker USD cap")
	return result
}
function microsToUsd(value: unknown): number { return Number(value ?? 0) / 1_000_000 }
function persistedEndpointPrice(value: unknown): OpenRouterEndpointPriceSnapshot | undefined {
	let candidate = value
	if (typeof candidate === "string") {
		try { candidate = JSON.parse(candidate) } catch { throw new Error("OpenRouter job contains malformed durable endpoint-price evidence") }
	}
	if (candidate === null || candidate === undefined) return undefined
	if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) throw new Error("OpenRouter job contains malformed durable endpoint-price evidence")
	const price = candidate as Partial<OpenRouterEndpointPriceSnapshot>
	if (typeof price.model !== "string" || typeof price.provider !== "string" || typeof price.endpointTag !== "string"
		|| (price.quantization !== undefined && typeof price.quantization !== "string")
		|| !Array.isArray(price.supportedParameters) || !price.supportedParameters.every((item) => typeof item === "string")
		|| !Number.isFinite(price.inputPricePerMillionUsd) || !Number.isFinite(price.outputPricePerMillionUsd)
		|| typeof price.observedAt !== "string" || typeof price.responseSha256 !== "string") throw new Error("OpenRouter job contains malformed durable endpoint-price evidence")
	return price as OpenRouterEndpointPriceSnapshot
}

export interface FleetQueuePolicy {
	queueName: string
	maxInFlight: number
	leaseMs: number
	maxAttempts: number
	classCapacity?: Partial<Record<ResourceClass, number>>
	concurrencyKeyCapacity?: Record<string, number>
}

function parseCapacityMap(raw: string | undefined, name: string): Record<string, number> {
	if (!raw?.trim()) return {}
	let value: unknown
	try { value = JSON.parse(raw) } catch { throw new Error(`${name} must be a JSON object of positive integer capacities`) }
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${name} must be a JSON object of positive integer capacities`)
	const result: Record<string, number> = {}
	for (const [key, limit] of Object.entries(value)) {
		if (!key || !Number.isInteger(limit) || Number(limit) < 1) throw new Error(`${name} must contain only positive integer capacities`)
		result[key] = Number(limit)
	}
	return result
}

export function fleetQueuePolicy(queueName: string, maxInFlight: number, env: NodeJS.ProcessEnv = process.env): FleetQueuePolicy {
	const leaseMs = env.HEADLESSCODE_RSI_LEASE_MS?.trim() ? Number(env.HEADLESSCODE_RSI_LEASE_MS) : 60 * 60_000
	const maxAttempts = env.HEADLESSCODE_RSI_MAX_ATTEMPTS?.trim() ? Number(env.HEADLESSCODE_RSI_MAX_ATTEMPTS) : 2
	return validatePolicy({
		queueName,
		maxInFlight,
		leaseMs,
		maxAttempts,
		classCapacity: parseCapacityMap(env.HEADLESSCODE_RSI_CLASS_CAPACITY, "HEADLESSCODE_RSI_CLASS_CAPACITY") as FleetQueuePolicy["classCapacity"],
		concurrencyKeyCapacity: parseCapacityMap(env.HEADLESSCODE_RSI_KEY_CAPACITY, "HEADLESSCODE_RSI_KEY_CAPACITY"),
	})
}

/** Return required classes that have no live registered worker capacity under this queue policy. */
export function missingFleetResourceClasses(
	required: readonly ResourceClass[],
	eligibleWorkerSlots: Partial<Record<ResourceClass, number>>,
	policy: FleetQueuePolicy,
): ResourceClass[] {
	return [...new Set(required)].filter((resourceClass) => {
		const slots = eligibleWorkerSlots[resourceClass] ?? 0
		const classCapacity = policy.classCapacity?.[resourceClass] ?? policy.maxInFlight
		return !Number.isSafeInteger(slots) || slots < 1 || classCapacity < 1
	})
}

export interface FleetWorkerRegistration {
	workerId: string
	gatewayId: string
	hostname: string
	maxActive: number
	resourceClasses: ResourceClass[]
}

export interface FleetJobPayload {
	schemaVersion: 1
	snapshotSha256: string
	snapshotBytes: number
	snapshotCommit: string
	task: string
	model: string
	provider?: "ollama" | "openrouter"
	openRouterProfile?: RsiOpenRouterProfileId
	proofCampaign?: { campaignId: string; armId: string; epoch: number; manifestSha256: string; cells: Array<{ attemptKey: string; slotId: string; attemptKind: "mutation" | "verification" }> }
	evaluatorRuntime?: { imageDigest: string; policySha256: string }
	/** Supervisor-authored adversarial artifacts, bound to the immutable snapshot. */
	adversarialEvaluation?: { testsSha256: string; runnerSha256: string }
	inferenceLimits?: OpenRouterBrokerLimits
	maxIterations: number
	timeoutMs: number
	protectedPaths: string[]
	candidate: Record<string, unknown>
	regressionCommand?: string
	evalCommands?: string[]
	workerHarness?: {
		runMode: WorkerHarnessMode
		mode: WorkerHarnessMode
		pairId?: string
		parentCommit: string
		snapshotTreeDigest: string
		runtime: WorkerHarnessRuntimeIdentity
		executedCliPath: string
	}
	modelTask?: {
		kind: "qlora-train" | "model-evaluation"
		datasetVersion: string
		datasetSha256: string
		manifestSha256: string
		baseModelId: string
		baseModelPath: "/workspace/.rsi-base-model"
		seed: 1337
		maxSteps?: 8
		modelCandidateId?: string
		adapterPath?: string
		modelKind?: "base" | "adapter"
		cellSetSha256: string
		cellIds: string[]
	}
}

export interface FleetJob {
	jobId: string
	idempotencyKey: string
	runId: string
	candidateId: string
	jobKind: "mutation" | "evaluation" | "training" | "model-evaluation"
	resourceClass: ResourceClass
	concurrencyKey?: string
	artifactSha256: string
	payload: FleetJobPayload
	status: "queued" | "leased" | "completed" | "failed" | "cancelled"
	attempts: number
	maxAttempts: number
	leaseDurationMs: number
	leaseOwner?: string
	leaseToken?: string
	leaseExpiresAt?: string
	result?: unknown
	error?: string
	createdAt: string
	updatedAt: string
	cancelRequestedAt?: string
	cancelReason?: string
}

export interface FleetJobLease { job: FleetJob; token: string; workerId: string }
export interface QueueMutationResult { accepted: boolean; duplicate: boolean; job?: FleetJob }
export type FleetJobIdentity = Pick<FleetJob, "idempotencyKey" | "runId" | "candidateId" | "jobKind" | "resourceClass" | "concurrencyKey" | "artifactSha256" | "payload">

function stableJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`
	if (value && typeof value === "object") {
		const object = value as Record<string, unknown>
		return `{${Object.keys(object).filter((key) => object[key] !== undefined).sort().map((key) => `${JSON.stringify(key)}:${stableJson(object[key])}`).join(",")}}`
	}
	const encoded = JSON.stringify(value)
	return encoded === undefined ? "undefined" : encoded
}

export function fleetPayloadDigest(payload: FleetJobPayload): string { return sha256Text(stableJson(payload)) }

/** Compare every queued execution input before a coordinator reuses an idempotent job. */
export function fleetJobMatches(job: FleetJob, expected: FleetJobIdentity): boolean {
	const identityMatches = job.idempotencyKey === expected.idempotencyKey
		&& job.runId === expected.runId
		&& job.candidateId === expected.candidateId
		&& job.jobKind === expected.jobKind
		&& job.resourceClass === expected.resourceClass
		&& (job.concurrencyKey ?? undefined) === (expected.concurrencyKey ?? undefined)
		&& job.artifactSha256 === expected.artifactSha256
	if (!identityMatches) return false
	if (stableJson(job.payload) === stableJson(expected.payload)) return true
	return completedProofJobMatches(job, expected)
}

function normalizedProofReplayPayload(payload: FleetJobPayload): FleetJobPayload {
	const normalized = structuredClone(payload)
	if (normalized.proofCampaign) normalized.proofCampaign.epoch = 0
	if (normalized.inferenceLimits) normalized.inferenceLimits.maxDurationMs = 0
	return normalized
}

function completedProofJobMatches(job: FleetJob, expected: FleetJobIdentity): boolean {
	if (job.status !== "completed" || !job.payload.proofCampaign || !expected.payload.proofCampaign) return false
	return stableJson(normalizedProofReplayPayload(job.payload)) === stableJson(normalizedProofReplayPayload(expected.payload))
}

function validatePolicy(policy: FleetQueuePolicy): FleetQueuePolicy {
	if (!/^[a-z0-9][a-z0-9_-]{0,62}$/.test(policy.queueName)) throw new Error("queueName must be a simple lowercase identifier")
	for (const [name, value, minimum] of [["maxInFlight", policy.maxInFlight, 1], ["leaseMs", policy.leaseMs, 1000], ["maxAttempts", policy.maxAttempts, 1]] as const) {
		if (!Number.isInteger(value) || value < minimum) throw new Error(`queue ${name} must be an integer of at least ${minimum}`)
	}
	for (const [key, value] of Object.entries({ ...(policy.classCapacity ?? {}), ...(policy.concurrencyKeyCapacity ?? {}) })) {
		if (!Number.isInteger(value) || value < 1) throw new Error(`queue capacity ${key} must be a positive integer`)
	}
	return {
		...policy,
		classCapacity: policy.classCapacity ?? {},
		concurrencyKeyCapacity: policy.concurrencyKeyCapacity ?? {},
	}
}

function rowToJob(row: Record<string, unknown>): FleetJob {
	return {
		jobId: String(row.job_id),
		idempotencyKey: String(row.idempotency_key),
		runId: String(row.run_id),
		candidateId: String(row.candidate_id),
		jobKind: row.job_kind as FleetJob["jobKind"],
		resourceClass: row.resource_class as ResourceClass,
		...(typeof row.concurrency_key === "string" ? { concurrencyKey: row.concurrency_key } : {}),
		artifactSha256: String(row.artifact_sha256).trim(),
		payload: row.payload as FleetJobPayload,
		status: row.status as FleetJob["status"],
		attempts: Number(row.attempts),
		maxAttempts: Number(row.max_attempts),
		leaseDurationMs: Number(row.lease_duration_ms),
		...(typeof row.lease_owner === "string" ? { leaseOwner: row.lease_owner } : {}),
		...(typeof row.lease_token === "string" ? { leaseToken: row.lease_token } : {}),
		...(row.lease_expires_at ? { leaseExpiresAt: new Date(String(row.lease_expires_at)).toISOString() } : {}),
		...(row.result !== null && row.result !== undefined ? { result: row.result } : {}),
		...(typeof row.error === "string" ? { error: row.error } : {}),
		...(row.cancel_requested_at ? { cancelRequestedAt: new Date(String(row.cancel_requested_at)).toISOString() } : {}),
		...(typeof row.cancel_reason === "string" ? { cancelReason: row.cancel_reason } : {}),
		createdAt: new Date(String(row.created_at)).toISOString(),
		updatedAt: new Date(String(row.updated_at)).toISOString(),
	}
}

function completionResultWithFailureHistory(resultValue: unknown, previousResult: unknown): unknown {
	const prior = previousResult && typeof previousResult === "object" && !Array.isArray(previousResult)
		? (previousResult as Record<string, unknown>).failureHistory
		: undefined
	const failureHistory = Array.isArray(prior) ? prior : []
	const result = resultValue && typeof resultValue === "object" && !Array.isArray(resultValue)
		? { ...(resultValue as Record<string, unknown>) }
		: failureHistory.length > 0 ? { value: resultValue } : resultValue
	if (!result || typeof result !== "object" || Array.isArray(result)) return result
	delete (result as Record<string, unknown>).failureHistory
	return failureHistory.length > 0 ? { ...(result as Record<string, unknown>), failureHistory } : result
}

/** Worst-case synchronous OpenShell CLI budget, including setup and teardown. */
export function requiredFleetJobLeaseMs(jobKind: FleetJob["jobKind"], timeoutMs: number, visibleCommandCount = 0): number {
	if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || !Number.isSafeInteger(visibleCommandCount) || visibleCommandCount < 0) throw new Error("invalid fleet job timeout or visible command count")
	const sessions = jobKind === "evaluation" ? visibleCommandCount + 1 : 1
	const required = sessions * (timeoutMs * 3 + 180_000)
	if (!Number.isSafeInteger(required) || required > 2_147_483_647) throw new Error("RSI job timeout budget exceeds PostgreSQL's 24-day lease range")
	return required
}

async function inTransaction<T>(pool: Pool, run: (client: PoolClient) => Promise<T>): Promise<T> {
	const client = await pool.connect()
	try {
		await client.query("BEGIN")
		const result = await run(client)
		await client.query("COMMIT")
		return result
	} catch (error) {
		await client.query("ROLLBACK").catch(() => undefined)
		throw error
	} finally {
		client.release()
	}
}

/** PostgreSQL is the source of truth for workers, admission, leases and results. */
export class PostgresRsiJobQueue {
	readonly policy: FleetQueuePolicy
	readonly artifactBackend: RsiArtifactStore["backend"]
	constructor(readonly pool: Pool, policy: FleetQueuePolicy, private readonly artifactStore: RsiArtifactStore) {
		this.policy = validatePolicy(policy)
		this.artifactBackend = artifactStore.backend
	}

	static fromEnvironment(policy: FleetQueuePolicy, env: NodeJS.ProcessEnv = process.env): PostgresRsiJobQueue {
		const connectionString = env.HEADLESSCODE_RSI_DATABASE_URL?.trim()
		if (!connectionString) throw new Error("HEADLESSCODE_RSI_DATABASE_URL is required for RSI fleet execution")
		return new PostgresRsiJobQueue(new Pool({ connectionString, max: 8, application_name: `headlesscode-rsi-${policy.queueName}` }), policy, createRsiArtifactStore(env))
	}

	async migrate(): Promise<void> {
		await this.pool.query(`CREATE TABLE IF NOT EXISTS headlesscode_rsi_schema_migrations (
			version integer PRIMARY KEY,
			applied_at timestamptz NOT NULL DEFAULT clock_timestamp()
		)`)
		for (const migration of MIGRATIONS) {
			const applied = await this.pool.query("SELECT 1 FROM headlesscode_rsi_schema_migrations WHERE version=$1", [migration.version])
			if (applied.rowCount) continue
			await inTransaction(this.pool, async (client) => {
				await client.query(migration.sql)
				await client.query("INSERT INTO headlesscode_rsi_schema_migrations(version) VALUES($1) ON CONFLICT DO NOTHING", [migration.version])
			})
		}
		const inserted = await this.pool.query(
			`INSERT INTO headlesscode_rsi_queue_policy(queue_name, max_in_flight, lease_ms, max_attempts, class_capacity, key_capacity)
			 VALUES($1,$2,$3,$4,$5::jsonb,$6::jsonb) ON CONFLICT(queue_name) DO NOTHING`,
			[this.policy.queueName, this.policy.maxInFlight, this.policy.leaseMs, this.policy.maxAttempts, JSON.stringify(this.policy.classCapacity), JSON.stringify(this.policy.concurrencyKeyCapacity)],
		)
		void inserted
		const persisted = await this.pool.query("SELECT max_in_flight, lease_ms, max_attempts, class_capacity, key_capacity FROM headlesscode_rsi_queue_policy WHERE queue_name=$1", [this.policy.queueName])
		const row = persisted.rows[0]
		if (!row || Number(row.max_in_flight) !== this.policy.maxInFlight || Number(row.lease_ms) !== this.policy.leaseMs || Number(row.max_attempts) !== this.policy.maxAttempts || stableJson(row.class_capacity) !== stableJson(this.policy.classCapacity) || stableJson(row.key_capacity) !== stableJson(this.policy.concurrencyKeyCapacity)) {
			throw new Error(`persisted RSI queue policy for ${this.policy.queueName} differs from requested admission settings`)
		}
	}

	proofCampaignCoordinator(): PostgresProofCampaign { return new PostgresProofCampaign(this.pool) }

	async registerWorker(registration: FleetWorkerRegistration): Promise<void> {
		if (!registration.workerId.trim() || !registration.gatewayId.trim() || !registration.hostname.trim()) throw new Error("worker id, gateway id and hostname are required")
		if (!Number.isInteger(registration.maxActive) || registration.maxActive < 1) throw new Error("worker maxActive must be a positive integer")
		await this.pool.query(
			`INSERT INTO headlesscode_rsi_workers(queue_name,worker_id,gateway_id,hostname,max_active,resource_classes,active,registered_at,heartbeat_at)
			 VALUES($1,$2,$3,$4,$5,$6::jsonb,true,clock_timestamp(),clock_timestamp())
			 ON CONFLICT(queue_name,worker_id) DO UPDATE SET gateway_id=EXCLUDED.gateway_id, hostname=EXCLUDED.hostname, max_active=EXCLUDED.max_active,
			 resource_classes=EXCLUDED.resource_classes, active=true, heartbeat_at=clock_timestamp()`,
			[this.policy.queueName, registration.workerId, registration.gatewayId, registration.hostname, registration.maxActive, JSON.stringify(registration.resourceClasses)],
		)
	}

	async heartbeatWorker(workerId: string): Promise<boolean> {
		const result = await this.pool.query("UPDATE headlesscode_rsi_workers SET heartbeat_at=clock_timestamp() WHERE queue_name=$1 AND worker_id=$2 AND active=true", [this.policy.queueName, workerId])
		return result.rowCount === 1
	}

	async activeWorkerCount(resourceClass?: ResourceClass): Promise<number> {
		const result = await this.pool.query(
			`SELECT count(*)::int AS count FROM headlesscode_rsi_workers
			 WHERE queue_name=$1 AND active=true AND heartbeat_at > clock_timestamp()-($2::text || ' milliseconds')::interval
			 AND ($3::text IS NULL OR resource_classes @> jsonb_build_array($3::text))`,
			[this.policy.queueName, this.policy.leaseMs * 2, resourceClass ?? null],
		)
		return Number(result.rows[0]?.count ?? 0)
	}

	async assertResourceClassCoverage(required: readonly ResourceClass[]): Promise<void> {
		const classes = [...new Set(required)]
		if (classes.length === 0) return
		const result = await this.pool.query(
			`SELECT required.resource_class,
				COALESCE(SUM(worker.max_active), 0)::int AS worker_slots
			 FROM unnest($2::text[]) AS required(resource_class)
			 LEFT JOIN headlesscode_rsi_workers AS worker
				ON worker.queue_name=$1 AND worker.active=true
				AND worker.heartbeat_at > clock_timestamp()-($3::text || ' milliseconds')::interval
				AND worker.resource_classes @> jsonb_build_array(required.resource_class)
			 GROUP BY required.resource_class`,
			[this.policy.queueName, classes, this.policy.leaseMs * 2],
		)
		const eligibleWorkerSlots: Partial<Record<ResourceClass, number>> = {}
		for (const row of result.rows) eligibleWorkerSlots[row.resource_class as ResourceClass] = Number(row.worker_slots)
		const missing = missingFleetResourceClasses(classes, eligibleWorkerSlots, this.policy)
		if (missing.length > 0) {
			const details = missing.map((resourceClass) => `${resourceClass} (no fresh worker slot or queue capacity)`).join(", ")
			throw new Error(`RSI fleet admission requires live worker capacity for ${details}; start a worker registered with HEADLESSCODE_RSI_WORKER_RESOURCE_CLASSES including each missing class and verify its shared queue policy`)
		}
	}

	async stopWorker(workerId: string): Promise<void> {
		await this.pool.query("UPDATE headlesscode_rsi_workers SET active=false, heartbeat_at=clock_timestamp() WHERE queue_name=$1 AND worker_id=$2", [this.policy.queueName, workerId])
	}

	async putArtifact(content: Buffer): Promise<RsiArtifactReference> {
		const reference = await this.artifactStore.put(content)
		await this.pool.query("INSERT INTO headlesscode_rsi_artifacts(sha256,storage_id,object_key,backend,byte_length) VALUES($1,$2,$3,$4,$5) ON CONFLICT(sha256) DO NOTHING", [reference.sha256, reference.storageId, reference.objectKey, reference.backend, reference.byteLength])
		const verified = await this.pool.query("SELECT storage_id,object_key,backend,byte_length FROM headlesscode_rsi_artifacts WHERE sha256=$1", [reference.sha256])
		if (verified.rows[0]?.storage_id !== reference.storageId || verified.rows[0]?.object_key !== reference.objectKey || Number(verified.rows[0]?.byte_length) !== reference.byteLength || verified.rows[0]?.backend !== reference.backend) throw new Error("stored RSI artifact metadata did not match uploaded content")
		return reference
	}

	async getArtifact(sha256: string): Promise<Buffer> {
		const result = await this.pool.query("SELECT storage_id,object_key,backend,byte_length FROM headlesscode_rsi_artifacts WHERE sha256=$1", [sha256])
		if (result.rowCount !== 1) throw new Error(`RSI artifact not found: ${sha256}`)
		const row = result.rows[0]
		const reference: RsiArtifactReference = { sha256, storageId: row.storage_id, objectKey: row.object_key, byteLength: Number(row.byte_length), backend: row.backend }
		if (reference.backend !== this.artifactStore.backend) throw new Error("RSI artifact backend differs from the configured worker artifact store")
		return this.artifactStore.get(reference)
	}

	async enqueue(input: { idempotencyKey: string; runId: string; candidateId: string; jobKind: FleetJob["jobKind"]; resourceClass: ResourceClass; concurrencyKey?: string; artifactSha256: string; payload: FleetJobPayload }): Promise<FleetJob> {
		if (!input.idempotencyKey.trim()) throw new Error("job idempotencyKey must not be empty")
		if (input.payload.schemaVersion !== 1 || input.payload.snapshotSha256 !== input.artifactSha256 || !/^[0-9a-f]{40,64}$/.test(input.payload.snapshotCommit)) throw new Error("job payload must bind to its sanitized snapshot artifact and commit")
		if (input.payload.snapshotBytes < 1) throw new Error("job payload declares an invalid snapshot size")
		return inTransaction(this.pool, async (client) => {
			const jobId = randomUUID()
			const proof = input.payload.proofCampaign
			const priorJob = proof ? await client.query("SELECT job_id FROM headlesscode_rsi_jobs WHERE queue_name=$1 AND idempotency_key=$2", [this.policy.queueName, input.idempotencyKey]) : undefined
			if (proof) {
			if (!proof.cells.length || new Set(proof.cells.map((cell) => cell.attemptKey)).size !== proof.cells.length || proof.cells.some((cell) => cell.attemptKind !== (input.jobKind === "mutation" ? "mutation" : "verification"))) throw new Error("proof-bound queue job requires unique campaign task cells matching its job kind")
				const campaign = await client.query("SELECT manifest,manifest_sha256,deadline_at > clock_timestamp() AS deadline_valid FROM headlesscode_rsi_proof_campaigns WHERE campaign_id=$1 FOR UPDATE", [proof.campaignId])
				const arm = await client.query("SELECT epoch,run_id,lease_expires_at > clock_timestamp() AS lease_valid,state FROM headlesscode_rsi_proof_campaign_arms WHERE campaign_id=$1 AND arm_id=$2 FOR UPDATE", [proof.campaignId, proof.armId])
				const attempt = await client.query("SELECT status,epoch,candidate_id,source_candidate_id,attempt_kind,generation,task_id,seed,job_id,attempt_key FROM headlesscode_rsi_proof_campaign_attempts WHERE campaign_id=$1 AND arm_id=$2 AND attempt_key=ANY($3::text[]) ORDER BY attempt_key FOR UPDATE", [proof.campaignId, proof.armId, proof.cells.map((cell) => cell.attemptKey).sort()])
				const cellsValid = attempt.rowCount === proof.cells.length && proof.cells.every((cell) => {
					const row = attempt.rows.find((entry) => entry.attempt_key === cell.attemptKey)
					return row?.status === "dispatched" && Number(row.epoch) === proof.epoch && row.candidate_id === cell.slotId && row.source_candidate_id === input.candidateId && row.attempt_kind === cell.attemptKind && (!row.job_id || String(row.job_id) === String(priorJob?.rows[0]?.job_id ?? ""))
				})
				const manifest = campaign.rows[0]?.manifest as { schedule?: Array<{ armId: string; generation: number; candidateId: string; taskId: string; seed: string; attemptKind: string }> } | undefined
				const rows = attempt.rows
				const generation = rows[0]?.generation
				const expectedCells = manifest?.schedule?.filter((cell) => cell.armId === proof.armId && cell.generation === Number(generation) && cell.candidateId === rows[0]?.candidate_id && cell.attemptKind === (input.jobKind === "mutation" ? "mutation" : "verification")) ?? []
				const actualCells = rows.map((row) => ({ generation: Number(row.generation), candidateId: row.candidate_id, taskId: row.task_id, seed: row.seed, attemptKind: row.attempt_kind }))
				const frozenCells = expectedCells.map((cell) => JSON.stringify({ generation: cell.generation, candidateId: cell.candidateId, taskId: cell.taskId, seed: cell.seed, attemptKind: cell.attemptKind })).sort()
				const admittedCells = actualCells.map((cell) => JSON.stringify(cell)).sort()
				const bindingOwnsJob = arm.rows[0]?.run_id === input.runId && rows.every((row) => row.source_candidate_id === input.candidateId && Number(row.generation) === Number(generation))
				if (!campaign.rows[0] || campaign.rows[0].manifest_sha256.trim() !== proof.manifestSha256 || campaign.rows[0].deadline_valid !== true || !arm.rows[0] || Number(arm.rows[0].epoch) !== proof.epoch || arm.rows[0].lease_valid !== true || arm.rows[0].state === "finished" || !cellsValid || !bindingOwnsJob || expectedCells.length !== actualCells.length || frozenCells.some((cell, index) => cell !== admittedCells[index])) throw new Error("proof-bound queue job admission requires exact current dispatched cells for this run and candidate")
			}
			const inserted = await client.query(
				`INSERT INTO headlesscode_rsi_jobs(job_id,queue_name,idempotency_key,run_id,candidate_id,job_kind,resource_class,concurrency_key,artifact_sha256,payload,status,max_attempts,lease_duration_ms)
				 VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,'queued',$11,$12) ON CONFLICT(queue_name,idempotency_key) DO NOTHING RETURNING *`,
				[jobId, this.policy.queueName, input.idempotencyKey, input.runId, input.candidateId, input.jobKind, input.resourceClass, input.concurrencyKey ?? null, input.artifactSha256, JSON.stringify(input.payload), this.policy.maxAttempts, Math.max(this.policy.leaseMs, requiredFleetJobLeaseMs(input.jobKind, input.payload.timeoutMs, input.payload.evalCommands?.length ?? 0))],
			)
			if (inserted.rowCount === 1) {
				if (proof) await client.query("UPDATE headlesscode_rsi_proof_campaign_attempts SET job_id=$4,updated_at=clock_timestamp() WHERE campaign_id=$1 AND arm_id=$2 AND attempt_key=ANY($3::text[]) AND job_id IS NULL", [proof.campaignId, proof.armId, proof.cells.map((cell) => cell.attemptKey), jobId])
				return rowToJob(inserted.rows[0])
			}
			const existing = await client.query("SELECT * FROM headlesscode_rsi_jobs WHERE queue_name=$1 AND idempotency_key=$2 FOR UPDATE", [this.policy.queueName, input.idempotencyKey])
			const row = existing.rows[0]
			if (!row || row.run_id !== input.runId || row.candidate_id !== input.candidateId || row.job_kind !== input.jobKind || row.resource_class !== input.resourceClass || row.concurrency_key !== (input.concurrencyKey ?? null) || row.artifact_sha256.trim() !== input.artifactSha256 || stableJson(row.payload) !== stableJson(input.payload)) {
				throw new Error(`idempotency key ${input.idempotencyKey} was reused for different RSI job contents`)
			}
			return rowToJob(row)
		})
	}

	async claim(workerId: string): Promise<FleetJobLease | undefined> {
		return inTransaction(this.pool, async (client) => {
			const policyResult = await client.query("SELECT * FROM headlesscode_rsi_queue_policy WHERE queue_name=$1 FOR UPDATE", [this.policy.queueName])
			const policy = policyResult.rows[0]
			if (!policy) throw new Error("RSI fleet queue has not been migrated")
			const workerResult = await client.query(
				`SELECT *, heartbeat_at > clock_timestamp()-($3::text || ' milliseconds')::interval AS heartbeat_fresh
				 FROM headlesscode_rsi_workers WHERE queue_name=$1 AND worker_id=$2 FOR UPDATE`,
				[this.policy.queueName, workerId, Number(policy.lease_ms) * 2],
			)
			const worker = workerResult.rows[0]
			if (!worker?.active || worker.heartbeat_fresh !== true || !Array.isArray(worker.resource_classes)) return undefined

			await client.query(
				`WITH expired AS (
				 SELECT job_id FROM headlesscode_rsi_jobs WHERE queue_name=$1 AND status='leased' AND cancel_requested_at IS NULL AND lease_expires_at <= clock_timestamp()
				 ORDER BY lease_expires_at LIMIT 100 FOR UPDATE SKIP LOCKED
				)
				UPDATE headlesscode_rsi_jobs AS jobs SET status=CASE WHEN jobs.attempts >= jobs.max_attempts THEN 'failed' ELSE 'queued' END,
				 error='worker lease expired before completion', lease_owner=NULL, lease_token=NULL, lease_expires_at=NULL, updated_at=clock_timestamp()
				 FROM expired WHERE jobs.job_id=expired.job_id`,
				[this.policy.queueName],
			)
			await client.query(
				`WITH abandoned AS (
				 SELECT job_id FROM headlesscode_rsi_jobs
				 WHERE queue_name=$1 AND status='leased'
				 AND cancel_requested_at IS NOT NULL
				 AND lease_expires_at <= clock_timestamp()
				 ORDER BY lease_expires_at LIMIT 100 FOR UPDATE SKIP LOCKED
				)
				UPDATE headlesscode_rsi_jobs AS jobs SET status='cancelled',
				 error=LEFT(COALESCE(jobs.cancel_reason,
				 'cancellation requested')
				 || ' (lease expired before teardown was acknowledged)',
				 4000),
				 lease_owner=NULL, lease_token=NULL,
				 lease_expires_at=NULL, updated_at=clock_timestamp()
				 FROM abandoned WHERE jobs.job_id=abandoned.job_id`,
				[this.policy.queueName],
			)
			const capacities = await client.query(
				`SELECT count(*)::int AS total,
				 count(*) FILTER (WHERE lease_owner=$1)::int AS worker_total
				 FROM headlesscode_rsi_jobs WHERE queue_name=$2 AND status='leased' AND (lease_expires_at > clock_timestamp() OR cancel_requested_at IS NOT NULL)`,
				[workerId, this.policy.queueName],
			)
			const active = capacities.rows[0]
			if (Number(active.total) >= Number(policy.max_in_flight) || Number(active.worker_total) >= Number(worker.max_active)) return undefined
			const allowedClasses = worker.resource_classes as ResourceClass[]
			const next = await client.query(
				`SELECT job.* FROM headlesscode_rsi_jobs AS job
				 JOIN headlesscode_rsi_queue_policy AS policy ON policy.queue_name=$1
				 WHERE job.queue_name=$1 AND job.status='queued' AND job.available_at <= clock_timestamp()
				 AND job.resource_class = ANY($2::text[])
				 AND (COALESCE((policy.class_capacity->>job.resource_class)::int, policy.max_in_flight) >
					(SELECT count(*) FROM headlesscode_rsi_jobs AS active WHERE active.queue_name=$1 AND active.status='leased' AND (active.lease_expires_at > clock_timestamp() OR active.cancel_requested_at IS NOT NULL) AND active.resource_class=job.resource_class))
				 AND (job.concurrency_key IS NULL OR COALESCE((policy.key_capacity->>job.concurrency_key)::int, policy.max_in_flight) >
					(SELECT count(*) FROM headlesscode_rsi_jobs AS active WHERE active.queue_name=$1 AND active.status='leased' AND (active.lease_expires_at > clock_timestamp() OR active.cancel_requested_at IS NOT NULL) AND active.concurrency_key=job.concurrency_key))
				 ORDER BY job.created_at, job.job_id LIMIT 1 FOR UPDATE OF job SKIP LOCKED`,
				[this.policy.queueName, allowedClasses],
			)
			const jobRow = next.rows[0]
			if (!jobRow) return undefined
			const token = randomUUID()
			const updated = await client.query(
				`UPDATE headlesscode_rsi_jobs SET status='leased', attempts=attempts+1, lease_owner=$2, lease_token=$3,
				 lease_expires_at=clock_timestamp()+(lease_duration_ms::text || ' milliseconds')::interval, updated_at=clock_timestamp()
				 WHERE job_id=$1 AND queue_name=$4 AND status='queued' RETURNING *`,
				[jobRow.job_id, workerId, token, this.policy.queueName],
			)
			return { job: rowToJob(updated.rows[0]), token, workerId }
		})
	}

	async heartbeat(lease: FleetJobLease): Promise<boolean> {
		const result = await this.pool.query(
			`UPDATE headlesscode_rsi_jobs SET lease_expires_at=clock_timestamp()+(lease_duration_ms::text || ' milliseconds')::interval, updated_at=clock_timestamp()
			 WHERE job_id=$1 AND queue_name=$4 AND lease_owner=$2 AND lease_token=$3 AND status='leased' AND cancel_requested_at IS NULL AND lease_expires_at > clock_timestamp()`,
			[lease.job.jobId, lease.workerId, lease.token, this.policy.queueName],
		)
		return result.rowCount === 1
	}

	async register(grant: OpenRouterBrokerGrant): Promise<number> {
		const profile = openRouterProfileForModel(grant.model, grant.profileId)
		const endpointPrice = profile.id === RSI_DEFAULT_OPENROUTER_PROFILE_ID ? undefined : grant.endpointPrice
		if (profile.id !== RSI_DEFAULT_OPENROUTER_PROFILE_ID && !endpointPrice) throw new Error("Muse OpenRouter grant is missing its admitted endpoint-price snapshot")
		const campaignMicros = usdCapToMicros(grant.limits.maxCampaignSpendUsd)
		const jobMicros = usdCapToMicros(grant.limits.maxJobSpendUsd)
		const capabilityHash = sha256Text(grant.capability)
		const leaseHash = sha256Text(grant.leaseToken)
		return inTransaction(this.pool, async (client) => {
			const leased = await client.query("SELECT 1 FROM headlesscode_rsi_jobs WHERE job_id=$1 AND queue_name=$2 AND status='leased' AND cancel_requested_at IS NULL AND lease_token=$3 AND lease_expires_at > clock_timestamp()", [grant.jobId, this.policy.queueName, grant.leaseToken])
			if (leased.rowCount !== 1) throw new Error("OpenRouter broker grant is stale or fenced")
			await client.query(
				`INSERT INTO headlesscode_rsi_inference_campaigns(campaign_id,provider,model,max_spend_microusd)
				 VALUES($1,'openrouter',$2,$3) ON CONFLICT(campaign_id) DO NOTHING`,
				[grant.limits.campaignId, grant.model, campaignMicros],
			)
			const campaign = await client.query("SELECT provider,model,max_spend_microusd,blocked FROM headlesscode_rsi_inference_campaigns WHERE campaign_id=$1 FOR UPDATE", [grant.limits.campaignId])
			const campaignRow = campaign.rows[0]
			if (!campaignRow || campaignRow.provider !== "openrouter" || campaignRow.model !== grant.model || Number(campaignRow.max_spend_microusd) !== campaignMicros || campaignRow.blocked) throw new Error("OpenRouter campaign already exists with a different model, cap or blocked status")
			const leaseLock = await client.query("SELECT 1 FROM headlesscode_rsi_jobs WHERE job_id=$1 AND queue_name=$2 AND status='leased' AND cancel_requested_at IS NULL AND lease_token=$3 AND lease_expires_at > clock_timestamp() FOR UPDATE", [grant.jobId, this.policy.queueName, grant.leaseToken])
			if (leaseLock.rowCount !== 1) throw new Error("OpenRouter broker grant is stale or fenced")
			const limitsJson = JSON.stringify(grant.limits)
			await client.query(
				`INSERT INTO headlesscode_rsi_inference_jobs(job_id,campaign_id,provider,model,limits,lease_token_sha256,capability_sha256,max_spend_microusd,max_calls,max_tokens,max_duration_ms,endpoint_price)
				 VALUES($1,$2,'openrouter',$3,$4::jsonb,$5,$6,$7,$8,$9,$10,$11::jsonb)
				 ON CONFLICT(job_id) DO NOTHING`,
				[grant.jobId, grant.limits.campaignId, grant.model, limitsJson, leaseHash, capabilityHash, jobMicros, grant.limits.maxCalls, grant.limits.maxTotalTokens, grant.limits.maxDurationMs, endpointPrice ? JSON.stringify(endpointPrice) : null],
			)
			const job = await client.query("SELECT lease_token_sha256,capability_sha256,campaign_id,provider,model,limits,started_at,endpoint_price FROM headlesscode_rsi_inference_jobs WHERE job_id=$1 FOR UPDATE", [grant.jobId])
			const row = job.rows[0]
			if (!row || row.campaign_id !== grant.limits.campaignId || row.provider !== "openrouter" || row.model !== grant.model || stableJson(row.limits) !== stableJson(grant.limits)) throw new Error("OpenRouter job grant conflicts with existing accounting identity")
			const persistedPrice = persistedEndpointPrice(row.endpoint_price)
			const priceMatches = endpointPrice === undefined
				? persistedPrice === undefined
				: persistedPrice !== undefined && stableJson(endpointPriceIdentity(persistedPrice)) === stableJson(endpointPriceIdentity(endpointPrice))
			if (!priceMatches) throw new Error("OpenRouter job grant conflicts with existing endpoint-price identity")
			// Preserve the first complete snapshot while allowing fresh metadata timestamps/hashes on restart.
			await client.query("UPDATE headlesscode_rsi_inference_jobs SET lease_token_sha256=$2,capability_sha256=$3 WHERE job_id=$1", [grant.jobId, leaseHash, capabilityHash])
			const startedAtMs = Date.parse(String(row.started_at))
			if (!Number.isFinite(startedAtMs)) throw new Error("OpenRouter job has an invalid durable start time")
			return startedAtMs + grant.limits.maxDurationMs
		})
	}

	async recordDenial(grant: OpenRouterBrokerGrant, statusCode: number, reason: OpenRouterDenialReason): Promise<void> {
		if (!Number.isSafeInteger(statusCode) || statusCode < 400 || statusCode > 599 || !/^[a-z-]+$/.test(reason)) throw new Error("invalid OpenRouter denial summary")
		const key = `${statusCode}:${reason}`
		const updated = await this.pool.query(
			`UPDATE headlesscode_rsi_inference_jobs
			 SET denials=jsonb_set(denials,ARRAY[$4],to_jsonb(COALESCE((denials->>$4)::integer,0)+1),true)
			 WHERE job_id=$1 AND lease_token_sha256=$2 AND capability_sha256=$3`,
			[grant.jobId, sha256Text(grant.leaseToken), sha256Text(grant.capability), key],
		)
		if (updated.rowCount !== 1) throw new Error("OpenRouter denial summary does not match an authenticated job grant")
	}

	async reserve(grant: OpenRouterBrokerGrant, reservation: OpenRouterCallReservation): Promise<void> {
		const reserveMicros = usdToMicrosCeiling(reservation.reservedUsd)
		const capabilityHash = sha256Text(grant.capability)
		const leaseHash = sha256Text(grant.leaseToken)
		await inTransaction(this.pool, async (client) => {
			const rowResult = await client.query("SELECT campaign_id FROM headlesscode_rsi_inference_jobs WHERE job_id=$1", [grant.jobId])
			const campaignId = rowResult.rows[0]?.campaign_id
			if (campaignId !== grant.limits.campaignId) throw new Error("OpenRouter job grant is not registered")
			const campaign = await client.query("SELECT * FROM headlesscode_rsi_inference_campaigns WHERE campaign_id=$1 FOR UPDATE", [campaignId])
			const jobResult = await client.query(
				`SELECT inference.*, jobs.status AS queue_status,jobs.lease_token AS current_lease_token,jobs.lease_expires_at,
					 jobs.lease_expires_at > clock_timestamp() AS lease_valid,
					 inference.started_at + (inference.max_duration_ms::text || ' milliseconds')::interval > clock_timestamp() AS duration_valid
				 FROM headlesscode_rsi_inference_jobs AS inference JOIN headlesscode_rsi_jobs AS jobs USING(job_id)
				 WHERE inference.job_id=$1 AND jobs.queue_name=$2 FOR UPDATE OF inference,jobs`, [grant.jobId, this.policy.queueName],
			)
			const job = jobResult.rows[0]
			const camp = campaign.rows[0]
			if (!job || !camp || job.queue_status !== "leased" || job.current_lease_token !== grant.leaseToken || job.lease_valid !== true || job.lease_token_sha256 !== leaseHash || job.capability_sha256 !== capabilityHash || job.blocked || camp.blocked) throw new Error("OpenRouter request denied: lease is stale, fenced, expired or blocked")
			if (job.duration_valid !== true) throw new Error("OpenRouter job duration limit exhausted")
			if (await client.query("SELECT 1 FROM headlesscode_rsi_inference_calls WHERE job_id=$1 AND call_id=$2", [grant.jobId, reservation.callId]).then((value) => value.rowCount)) throw new Error("duplicate OpenRouter call id is rejected; ambiguous retries are not replayed")
			const campaignUsed = Number(camp.spent_microusd) + Number(camp.reserved_spend_microusd)
			const jobUsed = Number(job.spent_microusd) + Number(job.reserved_spend_microusd)
			if (Number(job.call_count) >= grant.limits.maxCalls) throw new Error("OpenRouter job call ceiling exhausted")
			if (Number(job.reserved_tokens) + Number(job.used_tokens) + reservation.reservedTokens > grant.limits.maxTotalTokens) throw new Error("OpenRouter job token ceiling exhausted")
			if (jobUsed + reserveMicros > Number(job.max_spend_microusd)) throw new Error("OpenRouter job spend ceiling exhausted")
			if (campaignUsed + reserveMicros > Number(camp.max_spend_microusd)) throw new Error("OpenRouter campaign spend ceiling exhausted")
			await client.query(
				`INSERT INTO headlesscode_rsi_inference_calls(job_id,call_id,capability_sha256,request_sha256,state,reserved_spend_microusd,reserved_tokens,started_at)
				 VALUES($1,$2,$3,$4,'reserved',$5,$6,$7)`,
				[grant.jobId, reservation.callId, capabilityHash, reservation.requestSha256, reserveMicros, reservation.reservedTokens, reservation.startedAt],
			)
			await client.query("UPDATE headlesscode_rsi_inference_jobs SET reserved_spend_microusd=reserved_spend_microusd+$2, reserved_tokens=reserved_tokens+$3, call_count=call_count+1 WHERE job_id=$1", [grant.jobId, reserveMicros, reservation.reservedTokens])
			await client.query("UPDATE headlesscode_rsi_inference_campaigns SET reserved_spend_microusd=reserved_spend_microusd+$2 WHERE campaign_id=$1", [campaignId, reserveMicros])
		})
	}

	async settle(grant: OpenRouterBrokerGrant, settlement: OpenRouterCallSettlement & { callId: string }): Promise<void> {
		const profile = openRouterProfileForModel(grant.model, grant.profileId)
		const capabilityHash = sha256Text(grant.capability)
		await inTransaction(this.pool, async (client) => {
			const lookup = await client.query("SELECT campaign_id FROM headlesscode_rsi_inference_jobs WHERE job_id=$1", [grant.jobId])
			const campaignId = lookup.rows[0]?.campaign_id
			if (!campaignId) throw new Error("OpenRouter job accounting record is missing")
			await client.query("SELECT 1 FROM headlesscode_rsi_inference_campaigns WHERE campaign_id=$1 FOR UPDATE", [campaignId])
			const jobResult = await client.query(
				`SELECT inference.*, jobs.status AS queue_status,jobs.lease_token AS current_lease_token,jobs.lease_expires_at,
					 jobs.lease_expires_at > clock_timestamp() AS lease_valid,
					 inference.started_at + (inference.max_duration_ms::text || ' milliseconds')::interval > clock_timestamp() AS duration_valid
				 FROM headlesscode_rsi_inference_jobs AS inference JOIN headlesscode_rsi_jobs AS jobs USING(job_id)
				 WHERE inference.job_id=$1 AND jobs.queue_name=$2 FOR UPDATE OF inference,jobs`, [grant.jobId, this.policy.queueName],
			)
			const job = jobResult.rows[0]
			const callResult = await client.query("SELECT * FROM headlesscode_rsi_inference_calls WHERE job_id=$1 AND call_id=$2 FOR UPDATE", [grant.jobId, settlement.callId])
			const call = callResult.rows[0]
			if (!job || !call || call.capability_sha256 !== capabilityHash || call.state !== "reserved") throw new Error("OpenRouter settlement does not match a pending broker call")
			if (settlement.state !== "complete" || settlement.promptTokens === undefined || settlement.completionTokens === undefined || settlement.costUsd === undefined || settlement.returnedModel === undefined || settlement.returnedProvider === undefined || !settlement.responseSha256) {
				await client.query("UPDATE headlesscode_rsi_inference_calls SET state='unmeasured',completed_at=$3 WHERE job_id=$1 AND call_id=$2", [grant.jobId, settlement.callId, settlement.completedAt])
				await client.query("UPDATE headlesscode_rsi_inference_jobs SET blocked=true WHERE job_id=$1", [grant.jobId])
				return
			}
			const costMicros = usdToMicrosCeiling(settlement.costUsd)
			const actualTokens = settlement.promptTokens + settlement.completionTokens
			const currentLease = job.queue_status === "leased" && job.current_lease_token === grant.leaseToken && job.lease_valid === true
			const overLimit = job.duration_valid !== true || settlement.qualified === false || costMicros > Number(call.reserved_spend_microusd) || costMicros > usdCapToMicros(grant.limits.maxCallSpendUsd)
				|| settlement.promptTokens > grant.limits.maxInputTokensPerCall || settlement.completionTokens > grant.limits.maxOutputTokensPerCall
				|| (settlement.cachedPromptTokens !== undefined && settlement.cachedPromptTokens > settlement.promptTokens)
				|| actualTokens > Number(call.reserved_tokens) || !profile.returnedModels.includes(settlement.returnedModel) || settlement.returnedProvider !== profile.endpointProvider || !currentLease
			await client.query(
				`UPDATE headlesscode_rsi_inference_calls SET state='complete',actual_spend_microusd=$3,prompt_tokens=$4,cached_prompt_tokens=$5,completion_tokens=$6,
				 returned_model=$7,returned_provider=$8,provider_request_id=$9,response_sha256=$10,completed_at=$11,qualified=$12 WHERE job_id=$1 AND call_id=$2`,
				[grant.jobId, settlement.callId, costMicros, settlement.promptTokens, settlement.cachedPromptTokens ?? null, settlement.completionTokens, settlement.returnedModel, settlement.returnedProvider, settlement.providerRequestId ?? null, settlement.responseSha256, settlement.completedAt, !overLimit],
			)
			await client.query(
				`UPDATE headlesscode_rsi_inference_jobs SET reserved_spend_microusd=reserved_spend_microusd-$2,spent_microusd=spent_microusd+$3,
				 reserved_tokens=reserved_tokens-$4,used_tokens=used_tokens+$5,blocked=blocked OR $6 WHERE job_id=$1`,
				[grant.jobId, Number(call.reserved_spend_microusd), costMicros, Number(call.reserved_tokens), actualTokens, overLimit],
			)
			await client.query(
				`UPDATE headlesscode_rsi_inference_campaigns SET reserved_spend_microusd=reserved_spend_microusd-$2,spent_microusd=spent_microusd+$3,
				 blocked=blocked OR spent_microusd+$3 > max_spend_microusd WHERE campaign_id=$1`,
				[campaignId, Number(call.reserved_spend_microusd), costMicros],
			)
		})
	}

	async receipt(grant: OpenRouterBrokerGrant): Promise<OpenRouterBrokerReceipt> {
		const [jobResult, callResult, campaignResult] = await Promise.all([
			this.pool.query(`SELECT inference.*, jobs.status AS queue_status,jobs.lease_token AS current_lease_token,
				jobs.lease_expires_at > clock_timestamp() AS lease_valid
				FROM headlesscode_rsi_inference_jobs AS inference JOIN headlesscode_rsi_jobs AS jobs USING(job_id)
				WHERE inference.job_id=$1 AND jobs.queue_name=$2`, [grant.jobId, this.policy.queueName]),
			this.pool.query("SELECT * FROM headlesscode_rsi_inference_calls WHERE job_id=$1 ORDER BY started_at,call_id", [grant.jobId]),
			this.pool.query("SELECT blocked FROM headlesscode_rsi_inference_campaigns WHERE campaign_id=$1", [grant.limits.campaignId]),
		])
		const job = jobResult.rows[0]
		if (!job) throw new Error("OpenRouter broker receipt is missing its job record")
		const denialRecord = (typeof job.denials === "string" ? JSON.parse(job.denials) : job.denials ?? {}) as Record<string, unknown>
		const denials = Object.entries(denialRecord).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, rawCount]) => {
			const match = /^(\d{3}):([a-z-]+)$/.exec(key)
			if (!match || !Number.isSafeInteger(rawCount) || Number(rawCount) < 1) throw new Error("OpenRouter job contains a malformed denial summary")
			return { statusCode: Number(match[1]), reason: match[2] as OpenRouterDenialReason, count: Number(rawCount) }
		})
		const profile = openRouterProfileForModel(grant.model, grant.profileId)
		const endpointPrice = persistedEndpointPrice(job.endpoint_price)
		if (profile.id !== RSI_DEFAULT_OPENROUTER_PROFILE_ID) {
			if (!endpointPrice || !grant.endpointPrice || stableJson(endpointPriceIdentity(endpointPrice)) !== stableJson(endpointPriceIdentity(grant.endpointPrice))) {
				throw new Error("OpenRouter Muse receipt is missing matching durable endpoint-price evidence")
			}
		} else if (endpointPrice) {
			throw new Error("legacy DeepSeek OpenRouter receipt unexpectedly contains endpoint-price evidence")
		}
		const calls: OpenRouterCallReceipt[] = callResult.rows.map((row) => ({
			jobId: grant.jobId, campaignId: String(job.campaign_id), model: grant.model, ...(profile.id !== "deepseek-deepinfra-fp8" ? { profileId: profile.id } : {}),
			callId: String(row.call_id), requestSha256: String(row.request_sha256), reservedUsd: microsToUsd(row.reserved_spend_microusd),
			reservedTokens: Number(row.reserved_tokens), startedAt: new Date(String(row.started_at)).toISOString(),
			state: row.state as OpenRouterCallSettlement["state"],
			...(row.returned_model ? { returnedModel: String(row.returned_model) } : {}),
			...(row.returned_provider ? { returnedProvider: String(row.returned_provider) } : {}),
			...(row.provider_request_id ? { providerRequestId: String(row.provider_request_id) } : {}),
			...(row.prompt_tokens !== null ? { promptTokens: Number(row.prompt_tokens) } : {}),
			...(row.cached_prompt_tokens !== null && row.cached_prompt_tokens !== undefined ? { cachedPromptTokens: Number(row.cached_prompt_tokens) } : {}),
			...(row.completion_tokens !== null ? { completionTokens: Number(row.completion_tokens) } : {}),
			...(row.actual_spend_microusd !== null ? { costUsd: microsToUsd(row.actual_spend_microusd) } : {}),
			...(row.response_sha256 ? { responseSha256: String(row.response_sha256) } : {}),
			...(row.completed_at ? { completedAt: new Date(String(row.completed_at)).toISOString() } : {}),
			authoritative: row.state === "complete" && row.qualified === true && profile.returnedModels.includes(String(row.returned_model)) && row.returned_provider === profile.endpointProvider && row.prompt_tokens !== null && row.completion_tokens !== null && row.actual_spend_microusd !== null,
		}))
		const allMeasured = calls.length > 0 && calls.every((call) => call.authoritative)
		const promptTokens = allMeasured ? calls.reduce((sum, call) => sum + (call.promptTokens ?? 0), 0) : null
		const completionTokens = allMeasured ? calls.reduce((sum, call) => sum + (call.completionTokens ?? 0), 0) : null
		const costUsd = allMeasured ? sumMicrousdAsUsd(callResult.rows.map((row) => row.actual_spend_microusd)) : null
		const grantMatches = job.lease_token_sha256 === sha256Text(grant.leaseToken) && job.capability_sha256 === sha256Text(grant.capability)
		const currentLease = (job.queue_status === "leased" && job.current_lease_token === grant.leaseToken && job.lease_valid === true)
			|| (job.queue_status === "completed" && grantMatches)
		const withinLimits = Number(job.call_count) <= grant.limits.maxCalls && Number(job.used_tokens) <= grant.limits.maxTotalTokens
			&& Number(job.spent_microusd) <= Number(job.max_spend_microusd) && Number(job.reserved_spend_microusd) === 0
			&& Number(job.reserved_tokens) === 0 && !job.blocked && campaignResult.rows[0]?.blocked !== true && currentLease && grantMatches
		return {
			provider: "openrouter", endpointProvider: profile.endpointProvider, jobId: grant.jobId, campaignId: String(job.campaign_id), model: grant.model, ...(profile.id !== RSI_DEFAULT_OPENROUTER_PROFILE_ID ? { profileId: profile.id, ...(endpointPrice ? { endpointPrice } : {}) } : {}),
			returnedModels: [...new Set(calls.map((call) => call.returnedModel).filter((model): model is string => Boolean(model)))],
			returnedProviders: [...new Set(calls.map((call) => call.returnedProvider).filter((provider): provider is string => Boolean(provider)))],
			calls: calls.length, promptTokens, completionTokens,
			totalTokens: promptTokens === null || completionTokens === null ? null : promptTokens + completionTokens,
			costUsd, accounting: allMeasured && withinLimits ? "supervisor-enforced" : "incomplete", qualified: allMeasured && withinLimits, callReceipts: calls, denials,
		}
	}

	async complete(lease: FleetJobLease, resultValue: unknown): Promise<QueueMutationResult> {
		const resultArtifactRefs: Record<string, RsiArtifactReference> = {}
		const resultObject = resultValue && typeof resultValue === "object" ? resultValue as Record<string, unknown> : {}
		const declaredArtifacts: Array<{ key: string; sha256: unknown; bytes?: unknown }> = []
		if (typeof resultObject.patchSha256 === "string") declaredArtifacts.push({ key: "patch", sha256: resultObject.patchSha256, bytes: resultObject.patchBytes })
		const outputArtifact = resultObject.outputArtifact as Record<string, unknown> | undefined
		if (outputArtifact && typeof outputArtifact.sha256 === "string") declaredArtifacts.push({ key: "evaluation-output", sha256: outputArtifact.sha256, bytes: outputArtifact.bytes })
		for (const artifact of declaredArtifacts) {
			const artifactDigest = String(artifact.sha256)
			if (!/^[a-f0-9]{64}$/.test(artifactDigest)) throw new Error(`fleet result ${artifact.key} artifact digest is malformed`)
			const bytes = await this.getArtifact(artifactDigest)
			if (createHash("sha256").update(bytes).digest("hex") !== artifactDigest || (artifact.bytes !== undefined && artifact.bytes !== bytes.byteLength)) throw new Error(`fleet result ${artifact.key} artifact bytes do not match its declared digest and length`)
			const metadata = await this.pool.query("SELECT storage_id,object_key,backend,byte_length FROM headlesscode_rsi_artifacts WHERE sha256=$1", [artifactDigest])
			if (metadata.rowCount !== 1) throw new Error(`fleet result ${artifact.key} artifact metadata is missing`)
			const row = metadata.rows[0]
			resultArtifactRefs[artifact.key] = { sha256: artifactDigest, storageId: String(row.storage_id), objectKey: String(row.object_key), backend: row.backend, byteLength: Number(row.byte_length) }
		}
		return inTransaction(this.pool, async (client) => {
			const peekResult = await client.query("SELECT payload FROM headlesscode_rsi_jobs WHERE job_id=$1 AND queue_name=$2", [lease.job.jobId, this.policy.queueName])
			const binding = peekResult.rows[0]?.payload?.proofCampaign as FleetJobPayload["proofCampaign"] | undefined
			let proofAttemptRows: Array<Record<string, unknown>> = []
			let proofManifest: ProofCampaignManifest | undefined
			if (binding) {
				const campaignResult = await client.query("SELECT * FROM headlesscode_rsi_proof_campaigns WHERE campaign_id=$1 FOR UPDATE", [binding.campaignId])
				const armResult = await client.query("SELECT * FROM headlesscode_rsi_proof_campaign_arms WHERE campaign_id=$1 AND arm_id=$2 FOR UPDATE", [binding.campaignId, binding.armId])
				const campaign = campaignResult.rows[0]
				const arm = armResult.rows[0]
				if (!campaign || !arm || arm.run_id !== lease.job.runId || campaign.manifest_sha256.trim() !== binding.manifestSha256 || Number(arm.epoch) !== binding.epoch || arm.state === "finished" || new Date(String(arm.lease_expires_at)).getTime() <= Date.now() || new Date(String(campaign.deadline_at)).getTime() <= Date.now()) throw new Error("fleet result import rejected by stale proof campaign epoch, lease, manifest, run, or deadline")
				proofManifest = campaign.manifest as ProofCampaignManifest
				if (!binding.cells.length || new Set(binding.cells.map((cell) => cell.attemptKey)).size !== binding.cells.length) throw new Error("fleet result import has no unique proof campaign cells")
				const attemptResult = await client.query("SELECT * FROM headlesscode_rsi_proof_campaign_attempts WHERE campaign_id=$1 AND arm_id=$2 AND attempt_key=ANY($3::text[]) ORDER BY attempt_key FOR UPDATE", [binding.campaignId, binding.armId, binding.cells.map((cell) => cell.attemptKey).sort()])
				proofAttemptRows = attemptResult.rows as Array<Record<string, unknown>>
				if (attemptResult.rowCount !== binding.cells.length || binding.cells.some((cell) => {
					const row = attemptResult.rows.find((entry) => entry.attempt_key === cell.attemptKey)
					return !row || Number(row.epoch) !== binding.epoch || row.candidate_id !== cell.slotId || row.source_candidate_id !== lease.job.candidateId || row.attempt_kind !== cell.attemptKind
				})) throw new Error("fleet result import does not match its preadmitted proof campaign task cells")
				const firstAttempt = attemptResult.rows[0]
				const scheduled = (campaign.manifest as { schedule?: Array<{ armId: string; generation: number; candidateId: string; taskId: string; seed: string; attemptKind: string }> }).schedule?.filter((cell) => cell.armId === binding.armId && cell.generation === Number(firstAttempt?.generation) && cell.candidateId === firstAttempt?.candidate_id && cell.attemptKind === (lease.job.jobKind === "mutation" ? "mutation" : "verification")) ?? []
				const scheduledIdentities = scheduled.map((cell) => JSON.stringify({ generation: cell.generation, candidateId: cell.candidateId, taskId: cell.taskId, seed: cell.seed, attemptKind: cell.attemptKind })).sort()
				const attemptIdentities = attemptResult.rows.map((row) => JSON.stringify({ generation: Number(row.generation), candidateId: row.candidate_id, taskId: row.task_id, seed: row.seed, attemptKind: row.attempt_kind })).sort()
				if (scheduledIdentities.length !== attemptIdentities.length || scheduledIdentities.some((identity, index) => identity !== attemptIdentities[index])) throw new Error("fleet result import does not cover the exact frozen task cells for this job")
				if (binding.cells.some((cell) => cell.attemptKind === "mutation")) {
					if (binding.cells.length !== 1 || binding.cells[0]?.attemptKind !== "mutation") throw new Error("a proof-bound mutation job must have exactly one mutation cell")
					const inferenceCampaignLookup = await client.query("SELECT campaign_id FROM headlesscode_rsi_inference_jobs WHERE job_id=$1", [lease.job.jobId])
					const inferenceCampaignId = inferenceCampaignLookup.rows[0]?.campaign_id
					if (!inferenceCampaignId) throw new Error("proof campaign mutation has no durable OpenRouter campaign record")
					await client.query("SELECT campaign_id FROM headlesscode_rsi_inference_campaigns WHERE campaign_id=$1 FOR UPDATE", [inferenceCampaignId])
					await client.query("SELECT job_id FROM headlesscode_rsi_inference_jobs WHERE job_id=$1 FOR UPDATE", [lease.job.jobId])
				}
			}
			const currentResult = await client.query("SELECT * FROM headlesscode_rsi_jobs WHERE job_id=$1 AND queue_name=$2 FOR UPDATE", [lease.job.jobId, this.policy.queueName])
			const current = currentResult.rows[0]
			const completionValue = completionResultWithFailureHistory(resultValue, current?.result)
			const resultJson = JSON.stringify(completionValue)
			const resultDigest = sha256Text(stableJson(completionValue))
			if (current?.status === "completed" && stableJson(current.result) === stableJson(completionValue)) return { accepted: true, duplicate: true, job: rowToJob(current) }
			if (!current || stableJson(current.payload?.proofCampaign) !== stableJson(binding) || current.status !== "leased" || current.cancel_requested_at || current.lease_owner !== lease.workerId || current.lease_token !== lease.token || new Date(String(current.lease_expires_at)).getTime() <= Date.now()) return { accepted: false, duplicate: false, ...(current ? { job: rowToJob(current) } : {}) }
			if (binding) {
				const attempts = proofAttemptRows
				if (attempts.some((attempt) => attempt.status !== "dispatched" || attempt.job_id !== current.job_id)) throw new Error("proof campaign attempts do not reference the current fenced queue job")
				if (binding.cells.some((cell) => cell.attemptKind !== (current.job_kind === "mutation" ? "mutation" : "verification"))) throw new Error("proof campaign task kind differs from the fenced queue job")
				let actualCalls = 0; let actualTokens = 0; let actualSpend = 0
				if (current.job_kind === "mutation") {
					if (current.job_kind !== "mutation" || !resultArtifactRefs.patch) throw new Error("proof campaign mutation result is missing its patch or mutation job identity")
					const manifestSettings = proofManifest?.settings as { inferenceCampaignIds?: { mutation?: unknown } } | undefined
					const mutationBrokerCampaignId = manifestSettings?.inferenceCampaignIds?.mutation
					if (typeof mutationBrokerCampaignId !== "string" || current.payload.inferenceLimits?.campaignId !== mutationBrokerCampaignId) throw new Error("proof campaign mutation payload does not match its frozen mutation broker campaign identity")
					const inference = await client.query("SELECT * FROM headlesscode_rsi_inference_jobs WHERE job_id=$1", [current.job_id])
					const inferenceJob = inference.rows[0]
					if (!inferenceJob || inferenceJob.campaign_id !== mutationBrokerCampaignId || inferenceJob.model !== current.payload.model || inferenceJob.provider !== "openrouter" || inferenceJob.blocked || Number(inferenceJob.reserved_spend_microusd) !== 0 || Number(inferenceJob.reserved_tokens) !== 0) throw new Error("proof campaign mutation result has no settled authoritative broker job")
					const calls = await client.query("SELECT * FROM headlesscode_rsi_inference_calls WHERE job_id=$1 ORDER BY started_at,call_id", [current.job_id])
					if (!calls.rowCount || calls.rows.some((call) => call.state !== "complete" || call.qualified !== true || call.returned_model !== inferenceJob.model || call.prompt_tokens === null || call.completion_tokens === null || call.actual_spend_microusd === null)) throw new Error("proof campaign mutation result has an incomplete or unqualified broker call")
					actualCalls = calls.rowCount
					actualTokens = calls.rows.reduce((sum, call) => sum + Number(call.prompt_tokens) + Number(call.completion_tokens), 0)
					actualSpend = sumMicrousd(calls.rows.map((call) => call.actual_spend_microusd))
					const reported = resultObject.inferenceReceipt as Record<string, unknown> | undefined
					if (!reported || reported.provider !== "openrouter" || reported.jobId !== current.job_id || reported.campaignId !== mutationBrokerCampaignId || reported.model !== inferenceJob.model || reported.qualified !== true || reported.calls !== actualCalls || reported.totalTokens !== actualTokens || !usdEqualsMicrousd(reported.costUsd, actualSpend)) throw new Error("proof campaign result receipt does not match durable broker call accounting")
				} else if (current.job_kind !== "evaluation" || binding.cells.some((cell) => cell.attemptKind !== "verification") || !resultArtifactRefs["evaluation-output"]) throw new Error("proof campaign verification result is missing its independently produced output artifact")
				for (const cell of binding.cells) {
					const attempt = attempts.find((row) => row.attempt_key === cell.attemptKey)!
					if (attempt.status !== "dispatched" || actualCalls > Number(attempt.reserved_calls) || actualTokens > Number(attempt.reserved_tokens) || actualSpend > Number(attempt.reserved_spend_microusd)) throw new Error("proof campaign result exceeded or mismatched its preadmission reservation")
					await client.query(`UPDATE headlesscode_rsi_proof_campaign_attempts SET status='completed',result_sha256=$4,artifact_refs=$5::jsonb,actual_calls=$6,actual_tokens=$7,actual_spend_microusd=$8,updated_at=clock_timestamp() WHERE campaign_id=$1 AND arm_id=$2 AND attempt_key=$3`, [binding.campaignId, binding.armId, cell.attemptKey, resultDigest, stableJson(resultArtifactRefs), actualCalls, actualTokens, actualSpend])
					await client.query(`UPDATE headlesscode_rsi_proof_campaigns SET reserved_calls=reserved_calls-$2,reserved_tokens=reserved_tokens-$3,reserved_spend_microusd=reserved_spend_microusd-$4,used_calls=used_calls+$5,used_tokens=used_tokens+$6,used_spend_microusd=used_spend_microusd+$7,updated_at=clock_timestamp() WHERE campaign_id=$1`, [binding.campaignId, Number(attempt.reserved_calls), Number(attempt.reserved_tokens), Number(attempt.reserved_spend_microusd), actualCalls, actualTokens, actualSpend])
				}
				const payload = stableJson({ attemptKeys: binding.cells.map((cell) => cell.attemptKey), resultSha256: resultDigest, artifactRefs: resultArtifactRefs, actualCalls, actualTokens, actualSpendMicrousd: actualSpend })
				const sequence = await client.query("UPDATE headlesscode_rsi_proof_campaigns SET sequence=sequence+1 WHERE campaign_id=$1 RETURNING sequence", [binding.campaignId])
				await client.query("INSERT INTO headlesscode_rsi_proof_campaign_events(campaign_id,sequence,arm_id,epoch,event_type,payload,payload_sha256) VALUES($1,$2,$3,$4,'attempt-result-imported',$5::jsonb,$6)", [binding.campaignId, sequence.rows[0].sequence, binding.armId, binding.epoch, payload, sha256Text(payload)])
			}
			const updated = await client.query(
				`UPDATE headlesscode_rsi_jobs SET status='completed', result=$4::jsonb, completed_at=clock_timestamp(), updated_at=clock_timestamp(),
				 lease_owner=NULL, lease_token=NULL, lease_expires_at=NULL
				 WHERE job_id=$1 AND queue_name=$5 AND lease_owner=$2 AND lease_token=$3 AND status='leased' AND cancel_requested_at IS NULL AND lease_expires_at > clock_timestamp() RETURNING *`,
				[lease.job.jobId, lease.workerId, lease.token, resultJson, this.policy.queueName],
			)
			if (updated.rowCount === 1) return { accepted: true, duplicate: false, job: rowToJob(updated.rows[0]) }
			throw new Error("fleet completion lost its locked lease before committing the result")
		})
	}

	async fail(lease: FleetJobLease, error: string, failureResult?: Record<string, unknown>): Promise<boolean> {
		const outputArtifact = failureResult?.failureOutputArtifact
		if (outputArtifact !== undefined) {
			if (!outputArtifact || typeof outputArtifact !== "object" || Array.isArray(outputArtifact)) throw new Error("fleet failure output artifact reference is malformed")
			const reference = outputArtifact as { sha256?: unknown; bytes?: unknown }
			if (typeof reference.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(reference.sha256) || !Number.isSafeInteger(reference.bytes) || Number(reference.bytes) < 0) throw new Error("fleet failure output artifact digest or length is malformed")
			const bytes = await this.getArtifact(reference.sha256)
			if (createHash("sha256").update(bytes).digest("hex") !== reference.sha256 || bytes.byteLength !== reference.bytes) throw new Error("fleet failure output artifact bytes do not match its declared digest and length")
		}
		return inTransaction(this.pool, async (client) => {
			const current = await client.query(
				`SELECT attempts,error,result FROM headlesscode_rsi_jobs
				 WHERE job_id=$1 AND queue_name=$4 AND lease_owner=$2 AND lease_token=$3 AND status='leased' AND cancel_requested_at IS NULL AND lease_expires_at > clock_timestamp()
				 FOR UPDATE`,
				[lease.job.jobId, lease.workerId, lease.token, this.policy.queueName],
			)
			const row = current.rows[0]
			if (!row) return false
			const previousResult = row.result && typeof row.result === "object" && !Array.isArray(row.result) ? row.result as Record<string, unknown> : undefined
			const previousHistory = Array.isArray(previousResult?.failureHistory)
				? previousResult.failureHistory
				: previousResult
					? [{ attempt: Math.max(1, Number(row.attempts) - 1), error: row.error ?? "previous attempt failed", result: previousResult }]
					: []
			const currentFailure = failureResult ? { ...failureResult } : undefined
			if (currentFailure) delete currentFailure.failureHistory
			const failureRecord = { attempt: Number(row.attempts), error: error.slice(0, 4000), result: currentFailure ?? null }
			const storedResult = {
				...(currentFailure ?? {}),
				failureHistory: [...previousHistory, failureRecord],
			}
			const result = await client.query(
				`UPDATE headlesscode_rsi_jobs SET status=CASE WHEN attempts >= max_attempts THEN 'failed' ELSE 'queued' END, error=$4,result=$6::jsonb,
				 updated_at=clock_timestamp(), lease_owner=NULL, lease_token=NULL, lease_expires_at=NULL
				 WHERE job_id=$1 AND queue_name=$5 AND lease_owner=$2 AND lease_token=$3 AND status='leased' AND cancel_requested_at IS NULL AND lease_expires_at > clock_timestamp()`,
				[lease.job.jobId, lease.workerId, lease.token, error.slice(0, 4000), this.policy.queueName, JSON.stringify(storedResult)],
			)
			return result.rowCount === 1
		})
	}

	async getJob(jobId: string): Promise<FleetJob | undefined> {
		const result = await this.pool.query("SELECT * FROM headlesscode_rsi_jobs WHERE job_id=$1 AND queue_name=$2", [jobId, this.policy.queueName])
		return result.rowCount === 1 ? rowToJob(result.rows[0]) : undefined
	}

	async getJobByIdempotencyKey(idempotencyKey: string): Promise<FleetJob | undefined> {
		const result = await this.pool.query("SELECT * FROM headlesscode_rsi_jobs WHERE queue_name=$1 AND idempotency_key=$2", [this.policy.queueName, idempotencyKey])
		return result.rowCount === 1 ? rowToJob(result.rows[0]) : undefined
	}

	/** Rebind only a never-claimed queued proof job after arm recovery. */
	async rebindQueuedProofJob(jobId: string, expected: FleetJobIdentity, lease: ProofCampaignArmLease): Promise<FleetJob> {
		const proof = expected.payload.proofCampaign
		if (!proof || proof.campaignId !== lease.campaignId || proof.armId !== lease.armId || proof.epoch !== lease.epoch || proof.manifestSha256 !== lease.manifestSha256 || !proof.cells.length) throw new Error("queued proof job rebind does not match the current campaign lease")
		return inTransaction(this.pool, async (client) => {
			const campaignResult = await client.query("SELECT * FROM headlesscode_rsi_proof_campaigns WHERE campaign_id=$1 FOR UPDATE", [lease.campaignId])
			const armResult = await client.query("SELECT * FROM headlesscode_rsi_proof_campaign_arms WHERE campaign_id=$1 AND arm_id=$2 FOR UPDATE", [lease.campaignId, lease.armId])
			const attemptsResult = await client.query("SELECT * FROM headlesscode_rsi_proof_campaign_attempts WHERE campaign_id=$1 AND arm_id=$2 AND attempt_key=ANY($3::text[]) ORDER BY attempt_key FOR UPDATE", [lease.campaignId, lease.armId, proof.cells.map((cell) => cell.attemptKey).sort()])
			const jobResult = await client.query("SELECT * FROM headlesscode_rsi_jobs WHERE job_id=$1 AND queue_name=$2 FOR UPDATE", [jobId, this.policy.queueName])
			const campaign = campaignResult.rows[0]
			const arm = armResult.rows[0]
			const jobRow = jobResult.rows[0]
			if (!campaign || !arm || !jobRow) throw new Error("queued proof job rebind target is missing")
			const armTokenHash = sha256Text(lease.token)
			if (campaign.manifest_sha256.trim() !== proof.manifestSha256 || new Date(String(campaign.deadline_at)).getTime() <= Date.now()
				|| Number(arm.epoch) !== lease.epoch || arm.run_id !== lease.runId || arm.lease_token_sha256 !== armTokenHash || new Date(String(arm.lease_expires_at)).getTime() <= Date.now() || arm.state === "finished") throw new Error("queued proof job rebind lost the current campaign lease or deadline")
			const existingJob = rowToJob(jobRow)
			if (existingJob.status !== "queued" || existingJob.attempts !== 0 || existingJob.runId !== expected.runId || existingJob.candidateId !== expected.candidateId || existingJob.jobKind !== expected.jobKind || existingJob.resourceClass !== expected.resourceClass || existingJob.concurrencyKey !== expected.concurrencyKey || existingJob.artifactSha256 !== expected.artifactSha256 || !existingJob.payload.proofCampaign
				|| existingJob.payload.proofCampaign.epoch >= lease.epoch || stableJson(normalizedProofReplayPayload(existingJob.payload)) !== stableJson(normalizedProofReplayPayload(expected.payload))) throw new Error("only an identical, never-claimed queued proof job can be rebound")
			const oldProof = existingJob.payload.proofCampaign
			if (existingJob.payload.inferenceLimits && expected.payload.inferenceLimits && expected.payload.inferenceLimits.maxDurationMs > existingJob.payload.inferenceLimits.maxDurationMs) throw new Error("queued proof job rebind cannot extend its previously frozen execution duration")
			const attempts = attemptsResult.rows
			if (attempts.length !== proof.cells.length || proof.cells.some((cell) => {
				const attempt = attempts.find((row) => row.attempt_key === cell.attemptKey)
				const limits = existingJob.payload.inferenceLimits
				const reservationMatches = expected.jobKind === "mutation"
					? !!limits && Number(attempt?.reserved_calls) === limits.maxCalls && Number(attempt?.reserved_tokens) === limits.maxTotalTokens && Number(attempt?.reserved_spend_microusd) === usdToMicrosCeiling(limits.maxJobSpendUsd)
					: Number(attempt?.reserved_calls) === 0 && Number(attempt?.reserved_tokens) === 0 && Number(attempt?.reserved_spend_microusd) === 0
				return !attempt || !reservationMatches || attempt.status !== "dispatched" || Number(attempt.epoch) !== oldProof.epoch || attempt.job_id !== jobId || attempt.candidate_id !== cell.slotId || attempt.source_candidate_id !== expected.candidateId || attempt.attempt_kind !== cell.attemptKind
			})) throw new Error("queued proof job task cells are missing, claimed, terminal, or changed")
			if (oldProof.campaignId !== proof.campaignId || oldProof.armId !== proof.armId || oldProof.manifestSha256 !== proof.manifestSha256 || stableJson(oldProof.cells) !== stableJson(proof.cells)) throw new Error("queued proof job frozen cell binding changed during rebind")
			const manifest = campaign.manifest as { schedule?: Array<{ armId: string; generation: number; candidateId: string; taskId: string; seed: string; attemptKind: string }> }
			const actualCells = attempts.map((row) => ({ generation: Number(row.generation), candidateId: row.candidate_id, taskId: row.task_id, seed: row.seed, attemptKind: row.attempt_kind }))
			const first = attempts[0]
			const frozenCells = manifest.schedule?.filter((cell) => cell.armId === proof.armId && cell.generation === Number(first?.generation) && cell.candidateId === first?.candidate_id && cell.attemptKind === (expected.jobKind === "mutation" ? "mutation" : "verification")).map((cell) => ({ generation: cell.generation, candidateId: cell.candidateId, taskId: cell.taskId, seed: cell.seed, attemptKind: cell.attemptKind })) ?? []
			const sortCells = (cells: typeof actualCells) => cells.map(stableJson).sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))
			if (stableJson(sortCells(actualCells)) !== stableJson(sortCells(frozenCells))) throw new Error("queued proof job rebind does not cover the exact frozen task cells")
			const requestSha256 = fleetPayloadDigest(expected.payload)
			await client.query("UPDATE headlesscode_rsi_proof_campaign_attempts SET epoch=$4,request_sha256=$5,updated_at=clock_timestamp() WHERE campaign_id=$1 AND arm_id=$2 AND attempt_key=ANY($3::text[])", [lease.campaignId, lease.armId, proof.cells.map((cell) => cell.attemptKey), lease.epoch, requestSha256])
			const updated = await client.query("UPDATE headlesscode_rsi_jobs SET payload=$3::jsonb,updated_at=clock_timestamp() WHERE job_id=$1 AND queue_name=$2 AND status='queued' RETURNING *", [jobId, this.policy.queueName, JSON.stringify(expected.payload)])
			if (updated.rowCount !== 1) throw new Error("queued proof job changed during epoch rebind")
			const eventPayload = stableJson({ jobId, attemptKeys: proof.cells.map((cell) => cell.attemptKey), oldEpoch: oldProof.epoch, newEpoch: lease.epoch })
			const sequence = await client.query("UPDATE headlesscode_rsi_proof_campaigns SET sequence=sequence+1,updated_at=clock_timestamp() WHERE campaign_id=$1 RETURNING sequence", [lease.campaignId])
			await client.query("INSERT INTO headlesscode_rsi_proof_campaign_events(campaign_id,sequence,arm_id,epoch,event_type,payload,payload_sha256) VALUES($1,$2,$3,$4,'queued-job-rebound',$5::jsonb,$6)", [lease.campaignId, sequence.rows[0].sequence, lease.armId, lease.epoch, eventPayload, sha256Text(eventPayload)])
			return rowToJob(updated.rows[0])
		})
	}

	async cancel(jobId: string, reason: string): Promise<boolean> {
		return inTransaction(this.pool, async (client) => {
			const boundedReason = reason.slice(0, 4000)
			const queued = await client.query(
				`UPDATE headlesscode_rsi_jobs SET status='cancelled', error=$3, updated_at=clock_timestamp()
				 WHERE queue_name=$1 AND job_id=$2 AND status='queued' RETURNING job_id`,
				[this.policy.queueName, jobId, boundedReason],
			)
			if (queued.rowCount === 1) {
				await client.query("UPDATE headlesscode_rsi_inference_jobs SET blocked=true WHERE job_id=$1", [jobId])
				return true
			}
			const leased = await client.query(
				`UPDATE headlesscode_rsi_jobs SET cancel_requested_at=COALESCE(cancel_requested_at,clock_timestamp()), cancel_reason=COALESCE(cancel_reason,$3), updated_at=clock_timestamp()
				 WHERE queue_name=$1 AND job_id=$2 AND status='leased' RETURNING job_id`,
				[this.policy.queueName, jobId, boundedReason],
			)
			if (leased.rowCount !== 1) return false
			// A broker reservation is lease-bound. Blocking it in the same
			// transaction closes the cancellation-to-worker-poll window. The
			// lease remains capacity-reserved until the worker confirms teardown.
			await client.query("UPDATE headlesscode_rsi_inference_jobs SET blocked=true WHERE job_id=$1", [jobId])
			return true
		})
	}

	async acknowledgeCancellation(lease: FleetJobLease): Promise<boolean> {
		const result = await this.pool.query(
			`UPDATE headlesscode_rsi_jobs SET status='cancelled', error=cancel_reason, updated_at=clock_timestamp(), lease_owner=NULL, lease_token=NULL, lease_expires_at=NULL
			 WHERE job_id=$1 AND queue_name=$4 AND lease_owner=$2 AND lease_token=$3 AND status='leased' AND cancel_requested_at IS NOT NULL`,
			[lease.job.jobId, lease.workerId, lease.token, this.policy.queueName],
		)
		return result.rowCount === 1
	}

	async close(): Promise<void> {
		await Promise.all([this.pool.end(), Promise.resolve(this.artifactStore.close?.())])
	}
}
