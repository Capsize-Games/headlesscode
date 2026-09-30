import assert from "node:assert/strict"
import { createHash, randomBytes, randomUUID } from "node:crypto"
import { CreateBucketCommand, DeleteBucketCommand, DeleteObjectsCommand, HeadObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client } from "@aws-sdk/client-s3"
import { Pool } from "pg"
import test from "node:test"
import { S3RsiArtifactStore } from "../artifact-store.js"
import { FileRsiArtifactStore } from "../artifact-store.js"
import type { OpenRouterBrokerGrant, OpenRouterCallReservation, OpenRouterBrokerLimits } from "../inference-broker.js"
import { fleetJobMatches, fleetQueuePolicy, PostgresRsiJobQueue, requiredFleetJobLeaseMs, type FleetJob, type FleetJobIdentity, type FleetJobPayload, type FleetQueuePolicy } from "../postgres-queue.js"

test("fleet job replay identity rejects stale snapshots, tasks, base commits, evaluation config, and routing", () => {
	const expected: FleetJobIdentity = {
		idempotencyKey: "run:candidate:evaluation",
		runId: "run",
		candidateId: "candidate",
		jobKind: "evaluation",
		resourceClass: "CPU",
		concurrencyKey: "eval:candidate",
		artifactSha256: "a".repeat(64),
		payload: {
			schemaVersion: 1, snapshotSha256: "a".repeat(64), snapshotBytes: 10, snapshotCommit: "base-commit",
			task: "evaluate candidate", model: "worker", maxIterations: 1, timeoutMs: 1000, protectedPaths: [],
			candidate: { id: "candidate", generation: 0, parent: "base" }, regressionCommand: "npm test", evalCommands: ["npm run visible"],
		},
	}
	const job: FleetJob = {
		jobId: "job", ...expected, status: "completed", attempts: 1, maxAttempts: 1, leaseDurationMs: 60_000,
		createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(),
	}
	assert.equal(fleetJobMatches(job, expected), true, "an exact replay is reusable")
	const mismatches: Array<[string, (copy: FleetJob) => void]> = [
		["snapshot", (copy) => { copy.payload.snapshotSha256 = "b".repeat(64) }],
		["task", (copy) => { copy.payload.task = "different task" }],
		["base commit", (copy) => { copy.payload.snapshotCommit = "other-base" }],
		["evaluation config", (copy) => { copy.payload.evalCommands = ["npm run other-evaluation"] }],
		["concurrency key", (copy) => { copy.concurrencyKey = "eval:other" }],
	]
	for (const [label, change] of mismatches) {
		const stale = structuredClone(job)
		change(stale)
		assert.equal(fleetJobMatches(stale, expected), false, `${label} change must invalidate a queued replay`)
	}
})

const databaseUrl = process.env.HEADLESSCODE_RSI_TEST_DATABASE_URL
const endpoint = process.env.HEADLESSCODE_RSI_TEST_S3_ENDPOINT
const accessKeyId = process.env.HEADLESSCODE_RSI_TEST_S3_ACCESS_KEY
const secretAccessKey = process.env.HEADLESSCODE_RSI_TEST_S3_SECRET_KEY
const integrationReady = Boolean(databaseUrl && endpoint && accessKeyId && secretAccessKey)

test("default fleet lease covers the default OpenShell timeout and blocked heartbeat margin", () => {
	const policy = fleetQueuePolicy("rsi-default", 1, {})
	assert.ok(policy.leaseMs > 3 * 15 * 60_000 + 120_000)
})

test("evaluation lease budget scales with every configured visible command", () => {
	const timeoutMs = 15 * 60_000
	const oneCommand = requiredFleetJobLeaseMs("evaluation", timeoutMs, 1)
	const threeCommands = requiredFleetJobLeaseMs("evaluation", timeoutMs, 3)
	assert.equal(oneCommand, 2 * (timeoutMs * 3 + 180_000))
	assert.equal(threeCommands, 4 * (timeoutMs * 3 + 180_000))
	assert.ok(threeCommands > oneCommand)
})

test("PostgreSQL migrations upgrade an earlier artifact and lease schema", { skip: !databaseUrl }, async () => {
	const schema = `rsi_migrate_${randomUUID().replaceAll("-", "")}`
	const root = await import("node:fs/promises").then(({ mkdtemp }) => mkdtemp(`${process.env.TMPDIR ?? "/tmp"}/rsi-migration-test-`))
	const admin = new Pool({ connectionString: databaseUrl })
	await admin.query(`CREATE SCHEMA ${schema}`)
	const scopedPool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}` })
	const queue = new PostgresRsiJobQueue(scopedPool, testPolicy(`migrate-${randomUUID().slice(0, 8)}`), new FileRsiArtifactStore(root))
	try {
		await queue.migrate()
		await scopedPool.query("DELETE FROM headlesscode_rsi_schema_migrations WHERE version=2")
		await scopedPool.query("ALTER TABLE headlesscode_rsi_artifacts DROP COLUMN storage_id, DROP COLUMN object_key, DROP COLUMN backend, DROP COLUMN byte_length, ADD COLUMN content bytea NOT NULL")
		await scopedPool.query("ALTER TABLE headlesscode_rsi_jobs DROP COLUMN lease_duration_ms")
		await queue.migrate()
		const artifactColumns = await scopedPool.query("SELECT column_name FROM information_schema.columns WHERE table_schema=$1 AND table_name='headlesscode_rsi_artifacts'", [schema])
		const jobColumns = await scopedPool.query("SELECT column_name FROM information_schema.columns WHERE table_schema=$1 AND table_name='headlesscode_rsi_jobs'", [schema])
		assert.ok(artifactColumns.rows.some((row) => row.column_name === "storage_id"))
		assert.ok(artifactColumns.rows.some((row) => row.column_name === "byte_length"))
		assert.equal(artifactColumns.rows.some((row) => row.column_name === "content"), false, "empty legacy NOT NULL PostgreSQL blob column is removed")
		assert.ok(jobColumns.rows.some((row) => row.column_name === "lease_duration_ms"))
		assert.equal((await scopedPool.query("SELECT version FROM headlesscode_rsi_schema_migrations ORDER BY version")).rowCount, 4)
		const campaignColumns = await scopedPool.query("SELECT column_name FROM information_schema.columns WHERE table_schema=$1 AND table_name='headlesscode_rsi_inference_campaigns'", [schema])
		assert.ok(campaignColumns.rows.some((row) => row.column_name === "blocked"), "migration 004 adds the campaign block state used by admission and settlement")
		await scopedPool.query("DELETE FROM headlesscode_rsi_schema_migrations WHERE version=2")
		await scopedPool.query("ALTER TABLE headlesscode_rsi_artifacts DROP COLUMN storage_id, DROP COLUMN object_key, DROP COLUMN backend, DROP COLUMN byte_length, ADD COLUMN content bytea NOT NULL")
		await scopedPool.query("INSERT INTO headlesscode_rsi_artifacts(sha256,content) VALUES($1,decode('0102','hex'))", ["a".repeat(64)])
		await assert.rejects(queue.migrate(), /still contains PostgreSQL blobs; upload legacy bytes to the configured shared object store/)
	} finally {
		await queue.close().catch(() => undefined)
		await admin.query(`DROP SCHEMA ${schema} CASCADE`)
		await admin.end()
		await import("node:fs/promises").then(({ rm }) => rm(root, { recursive: true, force: true }))
	}
})

test("PostgreSQL OpenRouter admission persists reservations, blocks overspend, and invalidates stale lease receipts", { skip: !databaseUrl }, async () => {
	const schema = `rsi_broker_${randomUUID().replaceAll("-", "")}`
	const root = await import("node:fs/promises").then(({ mkdtemp }) => mkdtemp(`${process.env.TMPDIR ?? "/tmp"}/rsi-broker-test-`))
	const admin = new Pool({ connectionString: databaseUrl })
	await admin.query(`CREATE SCHEMA ${schema}`)
	const connection = { connectionString: databaseUrl, options: `-c search_path=${schema}` }
	const pool = new Pool(connection)
	const policy = testPolicy(`broker-${randomUUID().slice(0, 8)}`)
	let queue = new PostgresRsiJobQueue(pool, policy, new FileRsiArtifactStore(root))
	try {
		await queue.migrate()
		const job = await addJob(queue, "broker-admission", "LOCAL_GPU", "openrouter:test-model")
		await queue.registerWorker({ workerId: "broker-worker", gatewayId: "test-gateway", hostname: "test-host", maxActive: 1, resourceClasses: ["LOCAL_GPU"] })
		const lease = await queue.claim("broker-worker")
		assert.ok(lease)
		const limits: OpenRouterBrokerLimits = {
			campaignId: `campaign-${randomUUID()}`, maxCalls: 2, maxInputTokensPerCall: 500, maxOutputTokensPerCall: 500,
			maxTotalTokens: 1000, maxDurationMs: 60_000, maxRequestBytes: 16_384, maxResponseBytes: 16_384,
			maxInputPricePerMillionUsd: 1, maxOutputPricePerMillionUsd: 1, maxCallSpendUsd: 0.01, maxJobSpendUsd: 0.01, maxCampaignSpendUsd: 0.01,
		}
		const grant: OpenRouterBrokerGrant = { jobId: job.jobId, leaseToken: lease.token, capability: randomUUID(), model: "deepseek/deepseek-v4-flash-0731", limits }
		await queue.register(grant)
		const reservation = (callId: string): OpenRouterCallReservation => ({ callId, requestSha256: "a".repeat(64), reservedUsd: 0.01, reservedTokens: 100, startedAt: new Date().toISOString() })
		const admissions = await Promise.allSettled([queue.reserve(grant, reservation("call-concurrent-0001")), queue.reserve(grant, reservation("call-concurrent-0002"))])
		assert.equal(admissions.filter((item) => item.status === "fulfilled").length, 1, "campaign and job spend locks admit only one call under contention")
		const callId = admissions[0]?.status === "fulfilled" ? "call-concurrent-0001" : "call-concurrent-0002"
		await queue.settle(grant, { callId, state: "complete", qualified: true, returnedModel: grant.model, promptTokens: 12, completionTokens: 8, costUsd: 0.001, responseSha256: "b".repeat(64), completedAt: new Date().toISOString() })
		const receipt = await queue.receipt(grant)
		assert.equal(receipt.qualified, true)
		assert.equal(receipt.totalTokens, 20)
		await queue.pool.query("UPDATE headlesscode_rsi_jobs SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE job_id=$1", [job.jobId])
		assert.equal((await queue.receipt(grant)).qualified, false, "expired lease invalidates an otherwise measured receipt before publication")
		await queue.pool.query("UPDATE headlesscode_rsi_jobs SET lease_expires_at=clock_timestamp()+interval '1 minute' WHERE job_id=$1", [job.jobId])
		assert.equal((await queue.complete(lease, { ok: true })).accepted, true, "current lease publishes the result")
		assert.equal((await queue.receipt(grant)).qualified, true, "accepted completed job retains its immutable authoritative receipt")
		await queue.close()
		queue = new PostgresRsiJobQueue(new Pool(connection), policy, new FileRsiArtifactStore(root))
		assert.equal((await queue.receipt(grant)).qualified, true, "durable receipt survives queue process reconstruction")
		await queue.pool.query("UPDATE headlesscode_rsi_jobs SET status='failed' WHERE job_id=$1", [job.jobId])
		assert.equal((await queue.receipt(grant)).qualified, false, "failed/fenced work cannot retain proof qualification")
	} finally {
		await queue.close().catch(() => undefined)
		await admin.query(`DROP SCHEMA ${schema} CASCADE`)
		await admin.end()
		await import("node:fs/promises").then(({ rm }) => rm(root, { recursive: true, force: true }))
	}
})

test("queue integration cleanup preserves unrelated artifact metadata and S3 objects", { skip: !integrationReady }, async () => {
	const { queue, s3, cleanup } = await createQueue()
	const foreignBucket = `rsi-foreign-${randomUUID().replaceAll("-", "").slice(0, 18)}`
	const foreignKey = "unrelated/preserved-artifact"
	const foreignContent = Buffer.from("artifact owned by another queue")
	const foreignDigest = createHash("sha256").update(foreignContent).digest("hex")
	const foreignStorageId = `s3:${new URL(endpoint!).origin}:us-east-1:${foreignBucket}:foreign-prefix`
	const admin = new Pool({ connectionString: databaseUrl })
	const foreignS3 = new S3Client({ endpoint, region: "us-east-1", forcePathStyle: true, credentials: { accessKeyId: accessKeyId!, secretAccessKey: secretAccessKey! } })
	let cleanedQueue = false
	try {
		await foreignS3.send(new CreateBucketCommand({ Bucket: foreignBucket }))
		await foreignS3.send(new PutObjectCommand({ Bucket: foreignBucket, Key: foreignKey, Body: foreignContent, ContentLength: foreignContent.byteLength }))
		await admin.query(
			"INSERT INTO headlesscode_rsi_artifacts(sha256,storage_id,object_key,backend,byte_length) VALUES($1,$2,$3,'s3',$4)",
			[foreignDigest, foreignStorageId, foreignKey, foreignContent.byteLength],
		)
		await cleanup()
		cleanedQueue = true
		const row = await admin.query("SELECT storage_id,object_key FROM headlesscode_rsi_artifacts WHERE sha256=$1", [foreignDigest])
		assert.deepEqual(row.rows, [{ storage_id: foreignStorageId, object_key: foreignKey }])
		const head = await foreignS3.send(new HeadObjectCommand({ Bucket: foreignBucket, Key: foreignKey }))
		assert.equal(head.ContentLength, foreignContent.byteLength)
	} finally {
		if (!cleanedQueue) await cleanup().catch(() => undefined)
		await admin.query("DELETE FROM headlesscode_rsi_artifacts WHERE sha256=$1", [foreignDigest]).catch(() => undefined)
		await foreignS3.send(new DeleteObjectsCommand({ Bucket: foreignBucket, Delete: { Objects: [{ Key: foreignKey }], Quiet: true } })).catch(() => undefined)
		await foreignS3.send(new DeleteBucketCommand({ Bucket: foreignBucket })).catch(() => undefined)
		await admin.end()
		foreignS3.destroy()
		s3.destroy()
	}
})

function testPolicy(queueName: string, overrides: Partial<FleetQueuePolicy> = {}): FleetQueuePolicy {
	return {
		queueName,
		maxInFlight: 8,
		leaseMs: 1_000,
		maxAttempts: 2,
		classCapacity: { LOCAL_GPU: 4, CPU: 4 },
		concurrencyKeyCapacity: { ollama: 4 },
		...overrides,
	}
}

async function createQueue(policy = testPolicy(`test-${randomUUID().slice(0, 8)}`)) {
	if (!databaseUrl || !endpoint || !accessKeyId || !secretAccessKey) throw new Error("queue integration services unavailable")
	const pool = new Pool({ connectionString: databaseUrl, max: 16 })
	const s3 = new S3Client({ endpoint, region: "us-east-1", forcePathStyle: true, credentials: { accessKeyId, secretAccessKey } })
	const bucket = `rsi-test-${randomUUID().replaceAll("-", "").slice(0, 20)}`
	const storageId = `s3:${new URL(endpoint).origin}:us-east-1:${bucket}:rsi-test`
	await s3.send(new CreateBucketCommand({ Bucket: bucket }))
	const artifacts = new S3RsiArtifactStore({ bucket, endpoint, region: "us-east-1", forcePathStyle: true, prefix: "rsi-test", maxBytes: 32 * 1024 * 1024, client: s3 })
	const queue = new PostgresRsiJobQueue(pool, policy, artifacts)
	await queue.migrate()
	async function cleanupBucket() {
		let continuationToken: string | undefined
		do {
			const listed = await s3.send(new ListObjectsV2Command({ Bucket: bucket, ContinuationToken: continuationToken }))
			const objects = listed.Contents?.flatMap((item) => item.Key ? [{ Key: item.Key }] : []) ?? []
			if (objects.length) await s3.send(new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: objects, Quiet: true } }))
			continuationToken = listed.IsTruncated ? listed.NextContinuationToken : undefined
		} while (continuationToken)
		await s3.send(new DeleteBucketCommand({ Bucket: bucket }))
	}
	async function cleanup() {
		await pool.query("DELETE FROM headlesscode_rsi_workers WHERE queue_name=$1", [policy.queueName])
		await pool.query("DELETE FROM headlesscode_rsi_jobs WHERE queue_name=$1", [policy.queueName])
		await pool.query("DELETE FROM headlesscode_rsi_queue_policy WHERE queue_name=$1", [policy.queueName])
		await pool.query("DELETE FROM headlesscode_rsi_artifacts WHERE storage_id=$1", [storageId])
		await cleanupBucket()
		await queue.close().catch(() => undefined)
		s3.destroy()
	}
	return { queue, pool, s3, cleanup, cleanupBucket, destroyClient: () => s3.destroy() }
}

async function addJob(queue: PostgresRsiJobQueue, key: string, resourceClass: "LOCAL_GPU" | "CPU" = "LOCAL_GPU", concurrencyKey = "ollama") {
	const artifact = await queue.putArtifact(Buffer.from(`${queue.policy.queueName}:${key}:sanitized-snapshot`))
	const payload: FleetJobPayload = {
		schemaVersion: 1,
		snapshotSha256: artifact.sha256,
		snapshotBytes: artifact.byteLength,
		snapshotCommit: "1".repeat(40),
		task: "apply a focused source correction",
		model: "local-test-model",
		maxIterations: 4,
		timeoutMs: 10_000,
		protectedPaths: ["src/rsi/"],
		candidate: { id: `candidate-${key}` },
	}
	return queue.enqueue({
		idempotencyKey: key,
		runId: "integration-run",
		candidateId: `candidate-${key}`,
		jobKind: "mutation",
		resourceClass,
		concurrencyKey,
		artifactSha256: artifact.sha256,
		payload,
	})
}

test("PostgreSQL queue integration: atomic capacity claims and bounded concurrent worker admission", { skip: !integrationReady }, async () => {
	const { queue, pool, cleanup } = await createQueue()
	try {
		const snapshot = Buffer.alloc(20 * 1024 * 1024, randomBytes(1)[0])
		const artifact = await queue.putArtifact(snapshot)
		assert.equal(artifact.byteLength, snapshot.byteLength)
		assert.deepEqual(await queue.getArtifact(artifact.sha256), snapshot)

		for (let index = 0; index < 100; index++) await addJob(queue, `load-${index}`)
		const workers = Array.from({ length: 12 }, (_, index) => `worker-${index}`)
		for (const workerId of workers) await queue.registerWorker({ workerId, gatewayId: `gateway-${workerId}`, hostname: `host-${workerId}`, maxActive: 1, resourceClasses: ["LOCAL_GPU"] })
		const claims = await Promise.all(workers.map((workerId) => queue.claim(workerId)))
		const leases = claims.filter((claim) => claim !== undefined)
		assert.equal(leases.length, 4, "class and concurrency-key caps admit only four workers")
		assert.equal(new Set(leases.map((lease) => lease.job.jobId)).size, leases.length, "each job is claimed once under contention")
		for (const lease of leases) assert.equal((await queue.getJob(lease.job.jobId))?.leaseOwner, lease.workerId)
		for (const lease of leases) await queue.complete(lease, { firstWave: true })
		let active = 0
		let observedMax = 0
		const completed: string[] = []
		const claimDrainStarted = Date.now()
		await Promise.all(workers.map(async (workerId) => {
			while (true) {
				const lease = await queue.claim(workerId)
				if (!lease) return
				active += 1
				observedMax = Math.max(observedMax, active)
				await new Promise((resolve) => setTimeout(resolve, 3))
				const result = await queue.complete(lease, { drained: true })
				assert.equal(result.accepted, true)
				completed.push(lease.job.jobId)
				active -= 1
			}
		}))
		assert.equal(completed.length, 96)
		assert.equal(new Set(completed).size, 96)
		assert.ok(observedMax > 1, "multiple gateway workers should overlap claims")
		assert.ok(observedMax <= 4, "global class/key capacities must hold during sustained contention")
		const claimDrainMs = Date.now() - claimDrainStarted
		const claimsPerSecond = completed.length / (claimDrainMs / 1000)
		assert.ok(claimsPerSecond >= 3, `claim drain fell below the conservative local integration floor: ${claimsPerSecond.toFixed(1)} jobs/s`)
		console.log(`[rsi-queue-load] 12 simulated workers drained 96 admitted jobs in ${claimDrainMs} ms (${claimsPerSecond.toFixed(1)} jobs/s); observed active=${observedMax}, policy cap=4`)
	} finally {
		await cleanup()
	}
})

test("PostgreSQL queue integration: worker loss, lease fencing and reclaim", { skip: !integrationReady }, async () => {
	const { queue, pool, cleanup } = await createQueue(testPolicy(`lease-${randomUUID().slice(0, 8)}`, { maxInFlight: 2, classCapacity: { LOCAL_GPU: 2 }, concurrencyKeyCapacity: { ollama: 2 } }))
	try {
		const job = await addJob(queue, "lost-worker")
		await queue.registerWorker({ workerId: "worker-lost", gatewayId: "gateway-lost", hostname: "host-lost", maxActive: 1, resourceClasses: ["LOCAL_GPU"] })
		await queue.registerWorker({ workerId: "worker-replacement", gatewayId: "gateway-replacement", hostname: "host-replacement", maxActive: 1, resourceClasses: ["LOCAL_GPU"] })
		const staleLease = await queue.claim("worker-lost")
		assert.ok(staleLease)
		await pool.query("UPDATE headlesscode_rsi_jobs SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE job_id=$1", [job.jobId])
		assert.equal(await queue.heartbeat(staleLease), false, "expired lease cannot be revived")
		const reclaimed = await queue.claim("worker-replacement")
		assert.ok(reclaimed)
		assert.equal(reclaimed.job.jobId, job.jobId)
		assert.equal(reclaimed.job.attempts, 2)
		assert.notEqual(reclaimed.token, staleLease.token)
		assert.equal((await queue.complete(staleLease, { stale: true })).accepted, false, "old fencing token cannot complete a reclaimed job")
		const completed = await queue.complete(reclaimed, { patchSha256: "abc123" })
		assert.equal(completed.accepted, true)
		assert.equal(completed.duplicate, false)
		assert.equal((await queue.complete(reclaimed, { patchSha256: "abc123" })).duplicate, true, "identical duplicate result is idempotent")
		assert.equal((await queue.complete(reclaimed, { patchSha256: "different" })).accepted, false, "conflicting duplicate result is rejected")
		const retryJob = await addJob(queue, "max-retry-job")
		const firstAttempt = await queue.claim("worker-lost")
		assert.ok(firstAttempt)
		assert.equal(firstAttempt.job.jobId, retryJob.jobId)
		assert.equal(await queue.fail(firstAttempt, "temporary gateway failure"), true)
		const secondAttempt = await queue.claim("worker-replacement")
		assert.ok(secondAttempt)
		assert.equal(secondAttempt.job.attempts, 2)
		assert.equal(await queue.fail(secondAttempt, "second failure"), true)
		assert.equal((await queue.getJob(retryJob.jobId))?.status, "failed", "retry budget ends in a terminal failed state")
		const heartbeatJob = await addJob(queue, "stale-worker-heartbeat")
		await pool.query("UPDATE headlesscode_rsi_workers SET heartbeat_at=clock_timestamp()-interval '1 day' WHERE queue_name=$1 AND worker_id=$2", [queue.policy.queueName, "worker-replacement"])
		assert.equal(await queue.claim("worker-replacement"), undefined, "worker with an expired registration heartbeat cannot claim")
		assert.equal(await queue.heartbeatWorker("worker-replacement"), true)
		const heartbeatLease = await queue.claim("worker-replacement")
		assert.equal(heartbeatLease?.job.jobId, heartbeatJob.jobId)
	} finally {
		await cleanup()
	}
})

test("PostgreSQL queue integration: a timeout cannot release capacity from a live guest lease", { skip: !integrationReady }, async () => {
	const { queue, cleanup } = await createQueue(testPolicy(`timeout-${randomUUID().slice(0, 8)}`, { maxInFlight: 1, classCapacity: { LOCAL_GPU: 1 } }))
	try {
		const job = await addJob(queue, "guest-still-running")
		await queue.registerWorker({ workerId: "worker-active", gatewayId: "gateway-active", hostname: "host-active", maxActive: 1, resourceClasses: ["LOCAL_GPU"] })
		await queue.registerWorker({ workerId: "worker-waiting", gatewayId: "gateway-waiting", hostname: "host-waiting", maxActive: 1, resourceClasses: ["LOCAL_GPU"] })
		const lease = await queue.claim("worker-active")
		assert.ok(lease)
		assert.equal(await queue.cancel(job.jobId, "coordinator wait timed out"), false, "a leased OpenShell guest must retain capacity until teardown or lease expiry")
		assert.equal((await queue.getJob(job.jobId))?.status, "leased")
		assert.equal(await queue.claim("worker-waiting"), undefined, "capacity remains occupied while the leased guest may still run")
		assert.equal((await queue.complete(lease, { tornDown: true })).accepted, true)
		assert.equal((await queue.getJob(job.jobId))?.status, "completed")
	} finally {
		await cleanup()
	}
})

test("PostgreSQL queue integration: idempotency survives process restart and conflicts fail closed", { skip: !integrationReady }, async () => {
	const policy = testPolicy(`restart-${randomUUID().slice(0, 8)}`)
	const first = await createQueue(policy)
	let jobId = ""
	try {
		const firstJob = await addJob(first.queue, "restart-key")
		jobId = firstJob.jobId
		const duplicate = await addJob(first.queue, "restart-key")
		assert.equal(duplicate.jobId, jobId)
		await assert.rejects(addJob(first.queue, "restart-key", "CPU", "other-key"), /reused for different RSI job contents/)
	} finally {
		await first.cleanupBucket()
		await first.queue.close().catch(() => undefined)
		first.destroyClient()
	}
	const restarted = await createQueue(policy)
	try {
		assert.equal((await restarted.queue.getJob(jobId))?.status, "queued")
	} finally {
		await restarted.cleanup()
	}
})

test("PostgreSQL queue integration: persisted admission policy cannot drift across coordinators", { skip: !integrationReady }, async () => {
	const name = `policy-${randomUUID().slice(0, 8)}`
	const first = await createQueue(testPolicy(name))
	try {
		const secondPool = new Pool({ connectionString: databaseUrl })
		const second = new PostgresRsiJobQueue(secondPool, testPolicy(name, { maxInFlight: 7 }), new S3RsiArtifactStore({ bucket: "unused", endpoint, region: "us-east-1", forcePathStyle: true }))
		await assert.rejects(second.migrate(), /differs from requested admission settings/)
		await second.close()
	} finally {
		await first.cleanup()
	}
})

test("PostgreSQL queue integration: artifacts reject a configured size limit", { skip: !integrationReady }, async () => {
	const { queue, pool, cleanup } = await createQueue()
	try {
		const artifact = new S3RsiArtifactStore({ bucket: "unused", endpoint, region: "us-east-1", forcePathStyle: true, maxBytes: 8 })
		await assert.rejects(artifact.put(randomBytes(9)), /configured 8 byte limit/)
	} finally {
		await cleanup()
	}
})
