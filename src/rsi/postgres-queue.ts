import { createHash, randomUUID } from "node:crypto"
import { readFileSync } from "node:fs"
import { Pool, type PoolClient } from "pg"
import type { ResourceClass } from "./types.js"
import { createRsiArtifactStore, type RsiArtifactReference, type RsiArtifactStore } from "./artifact-store.js"

const MIGRATIONS = [
	{ version: 1, sql: readFileSync(new URL("./migrations/001_postgres_fleet_queue.sql", import.meta.url), "utf8") },
	{ version: 2, sql: readFileSync(new URL("./migrations/002_external_artifacts_and_job_leases.sql", import.meta.url), "utf8") },
	{ version: 3, sql: readFileSync(new URL("./migrations/003_model_training_jobs.sql", import.meta.url), "utf8") },
]

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
	maxIterations: number
	timeoutMs: number
	protectedPaths: string[]
	candidate: Record<string, unknown>
	regressionCommand?: string
	evalCommands?: string[]
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

/** Compare every queued execution input before a coordinator reuses an idempotent job. */
export function fleetJobMatches(job: FleetJob, expected: FleetJobIdentity): boolean {
	return job.idempotencyKey === expected.idempotencyKey
		&& job.runId === expected.runId
		&& job.candidateId === expected.candidateId
		&& job.jobKind === expected.jobKind
		&& job.resourceClass === expected.resourceClass
		&& (job.concurrencyKey ?? undefined) === (expected.concurrencyKey ?? undefined)
		&& job.artifactSha256 === expected.artifactSha256
		&& stableJson(job.payload) === stableJson(expected.payload)
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
		createdAt: new Date(String(row.created_at)).toISOString(),
		updatedAt: new Date(String(row.updated_at)).toISOString(),
	}
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
			const inserted = await client.query(
				`INSERT INTO headlesscode_rsi_jobs(job_id,queue_name,idempotency_key,run_id,candidate_id,job_kind,resource_class,concurrency_key,artifact_sha256,payload,status,max_attempts,lease_duration_ms)
				 VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,'queued',$11,$12) ON CONFLICT(queue_name,idempotency_key) DO NOTHING RETURNING *`,
				[jobId, this.policy.queueName, input.idempotencyKey, input.runId, input.candidateId, input.jobKind, input.resourceClass, input.concurrencyKey ?? null, input.artifactSha256, JSON.stringify(input.payload), this.policy.maxAttempts, Math.max(this.policy.leaseMs, requiredFleetJobLeaseMs(input.jobKind, input.payload.timeoutMs, input.payload.evalCommands?.length ?? 0))],
			)
			if (inserted.rowCount === 1) return rowToJob(inserted.rows[0])
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
				 SELECT job_id FROM headlesscode_rsi_jobs WHERE queue_name=$1 AND status='leased' AND lease_expires_at <= clock_timestamp()
				 ORDER BY lease_expires_at LIMIT 100 FOR UPDATE SKIP LOCKED
				)
				UPDATE headlesscode_rsi_jobs AS jobs SET status=CASE WHEN jobs.attempts >= jobs.max_attempts THEN 'failed' ELSE 'queued' END,
				 error='worker lease expired before completion', lease_owner=NULL, lease_token=NULL, lease_expires_at=NULL, updated_at=clock_timestamp()
				 FROM expired WHERE jobs.job_id=expired.job_id`,
				[this.policy.queueName],
			)
			const capacities = await client.query(
				`SELECT count(*)::int AS total,
				 count(*) FILTER (WHERE lease_owner=$1)::int AS worker_total
				 FROM headlesscode_rsi_jobs WHERE queue_name=$2 AND status='leased' AND lease_expires_at > clock_timestamp()`,
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
					(SELECT count(*) FROM headlesscode_rsi_jobs AS active WHERE active.queue_name=$1 AND active.status='leased' AND active.lease_expires_at > clock_timestamp() AND active.resource_class=job.resource_class))
				 AND (job.concurrency_key IS NULL OR COALESCE((policy.key_capacity->>job.concurrency_key)::int, policy.max_in_flight) >
					(SELECT count(*) FROM headlesscode_rsi_jobs AS active WHERE active.queue_name=$1 AND active.status='leased' AND active.lease_expires_at > clock_timestamp() AND active.concurrency_key=job.concurrency_key))
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
			 WHERE job_id=$1 AND queue_name=$4 AND lease_owner=$2 AND lease_token=$3 AND status='leased' AND lease_expires_at > clock_timestamp()`,
			[lease.job.jobId, lease.workerId, lease.token, this.policy.queueName],
		)
		return result.rowCount === 1
	}

	async complete(lease: FleetJobLease, resultValue: unknown): Promise<QueueMutationResult> {
		const resultJson = JSON.stringify(resultValue)
		return inTransaction(this.pool, async (client) => {
			const updated = await client.query(
				`UPDATE headlesscode_rsi_jobs SET status='completed', result=$4::jsonb, completed_at=clock_timestamp(), updated_at=clock_timestamp(),
				 lease_owner=NULL, lease_token=NULL, lease_expires_at=NULL
				 WHERE job_id=$1 AND queue_name=$5 AND lease_owner=$2 AND lease_token=$3 AND status='leased' AND lease_expires_at > clock_timestamp() RETURNING *`,
				[lease.job.jobId, lease.workerId, lease.token, resultJson, this.policy.queueName],
			)
			if (updated.rowCount === 1) return { accepted: true, duplicate: false, job: rowToJob(updated.rows[0]) }
			const existing = await client.query("SELECT * FROM headlesscode_rsi_jobs WHERE job_id=$1 AND queue_name=$2", [lease.job.jobId, this.policy.queueName])
			const row = existing.rows[0]
			if (row?.status === "completed" && stableJson(row.result) === stableJson(resultValue)) return { accepted: true, duplicate: true, job: rowToJob(row) }
			return { accepted: false, duplicate: false, ...(row ? { job: rowToJob(row) } : {}) }
		})
	}

	async fail(lease: FleetJobLease, error: string): Promise<boolean> {
		const result = await this.pool.query(
			`UPDATE headlesscode_rsi_jobs SET status=CASE WHEN attempts >= max_attempts THEN 'failed' ELSE 'queued' END, error=$4,
			 updated_at=clock_timestamp(), lease_owner=NULL, lease_token=NULL, lease_expires_at=NULL
			 WHERE job_id=$1 AND queue_name=$5 AND lease_owner=$2 AND lease_token=$3 AND status='leased' AND lease_expires_at > clock_timestamp()`,
			[lease.job.jobId, lease.workerId, lease.token, error.slice(0, 4000), this.policy.queueName],
		)
		return result.rowCount === 1
	}

	async getJob(jobId: string): Promise<FleetJob | undefined> {
		const result = await this.pool.query("SELECT * FROM headlesscode_rsi_jobs WHERE job_id=$1 AND queue_name=$2", [jobId, this.policy.queueName])
		return result.rowCount === 1 ? rowToJob(result.rows[0]) : undefined
	}

	async getJobByIdempotencyKey(idempotencyKey: string): Promise<FleetJob | undefined> {
		const result = await this.pool.query("SELECT * FROM headlesscode_rsi_jobs WHERE queue_name=$1 AND idempotency_key=$2", [this.policy.queueName, idempotencyKey])
		return result.rowCount === 1 ? rowToJob(result.rows[0]) : undefined
	}

	async cancel(jobId: string, reason: string): Promise<boolean> {
		const result = await this.pool.query(
			`UPDATE headlesscode_rsi_jobs SET status='cancelled', error=$3, updated_at=clock_timestamp(), lease_owner=NULL, lease_token=NULL, lease_expires_at=NULL
			 WHERE queue_name=$1 AND job_id=$2 AND status='queued'`,
			[this.policy.queueName, jobId, reason.slice(0, 4000)],
		)
		return result.rowCount === 1
	}

	async close(): Promise<void> {
		await Promise.all([this.pool.end(), Promise.resolve(this.artifactStore.close?.())])
	}
}
