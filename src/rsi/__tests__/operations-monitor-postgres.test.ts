import assert from "node:assert/strict"
import test from "node:test"
import { randomUUID } from "node:crypto"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import { Pool } from "pg"
import { readRsiOperationsStatus } from "../operations-monitor.js"

const connectionString = process.env.HEADLESSCODE_RSI_MONITOR_TEST_DATABASE_URL
const explicitlyEnabled = process.env.HEADLESSCODE_RSI_MONITOR_ALLOW_TEST_DB === "1"

test("isolated PostgreSQL monitor reports cancellation teardown and budget state", { skip: !connectionString || !explicitlyEnabled ? "requires a separately provisioned isolated monitor test database and explicit opt-in" : false }, async () => {
	const dbUrl = connectionString
	if (!dbUrl) throw new Error("test database URL was not provided")
	const url = new URL(dbUrl)
	if (!["localhost", "127.0.0.1", "::1"].includes(url.hostname) || !/test/i.test(url.pathname)) {
		throw new Error("monitor integration tests require a loopback database whose database name includes 'test'")
	}
	const admin = new Pool({ connectionString, max: 1, connectionTimeoutMillis: 2_000, query_timeout: 5_000 })
	const schema = `hc_rsi_monitor_test_${process.pid}_${randomUUID().slice(0, 8)}`
	const pool = new Pool({ connectionString, max: 1, connectionTimeoutMillis: 2_000, query_timeout: 5_000, options: `-c search_path=${schema}` })
	try {
		await admin.query(`CREATE SCHEMA "${schema}"`)
		const migrationDirectory = path.join(process.cwd(), "src", "rsi", "migrations")
		for (const migration of ["001_postgres_fleet_queue.sql", "004_openrouter_inference_broker.sql", "006_proof_campaigns.sql", "007_proof_campaign_phases.sql", "008_openrouter_returned_provider.sql", "009_openrouter_cached_prompt_tokens.sql", "011_fleet_cancellation_requests.sql"]) {
			await pool.query(await fs.readFile(path.join(migrationDirectory, migration), "utf8"))
		}
		await pool.query("INSERT INTO headlesscode_rsi_queue_policy(queue_name,max_in_flight,lease_ms,max_attempts) VALUES ('monitor-test',2,5000,3)")
		const digest = "a".repeat(64)
		const jobId = randomUUID()
		await pool.query("INSERT INTO headlesscode_rsi_artifacts(sha256,storage_id,object_key,backend,byte_length) VALUES ($1,'synthetic-store','synthetic/monitor-test','file',1)", [digest])
		await pool.query(`INSERT INTO headlesscode_rsi_jobs(job_id,queue_name,idempotency_key,run_id,candidate_id,job_kind,resource_class,artifact_sha256,payload,status,attempts,max_attempts,lease_owner,lease_token,lease_expires_at,cancel_requested_at,cancel_reason)
			VALUES ($1,'monitor-test','synthetic-job','synthetic-run','synthetic-candidate','evaluation','CPU',$2,'{}'::jsonb,'leased',1,3,'synthetic-worker',$3,clock_timestamp()+interval '30 seconds',clock_timestamp(),'synthetic teardown probe')`, [jobId, digest, randomUUID()])
		await pool.query(`INSERT INTO headlesscode_rsi_proof_campaigns(campaign_id,schema_version,manifest,manifest_sha256,expected_arms,state,deadline_at,max_calls,max_tokens,max_spend_microusd)
			VALUES ('monitor-campaign',1,'{}'::jsonb,$1,'[]'::jsonb,'running',clock_timestamp()+interval '1 hour',10,1000,1000000)`, [digest])
		for (const armId of ["arm-a", "arm-b"]) await pool.query(`INSERT INTO headlesscode_rsi_proof_campaign_arms(campaign_id,arm_id,run_id,state)
			VALUES ('monitor-campaign',$1,$2,'planned')`, [armId, `synthetic-${armId}`])
		for (const role of ["mutation", "benchmark"]) await pool.query(`INSERT INTO headlesscode_rsi_inference_campaigns(campaign_id,provider,model,max_spend_microusd)
			VALUES ($1,'openrouter','synthetic-test-model',500000)`, [`monitor-campaign:${role}`])
		const inferenceJobId = randomUUID()
		await pool.query(`INSERT INTO headlesscode_rsi_jobs(job_id,queue_name,idempotency_key,run_id,candidate_id,job_kind,resource_class,artifact_sha256,payload,status,attempts,max_attempts)
			VALUES ($1,'monitor-test','synthetic-inference-job','synthetic-inference-run','synthetic-inference-candidate','mutation','CPU',$2,'{}'::jsonb,'queued',0,3)`, [inferenceJobId, digest])
		await pool.query(`INSERT INTO headlesscode_rsi_inference_jobs(job_id,campaign_id,provider,model,limits,lease_token_sha256,capability_sha256,max_spend_microusd,max_calls,max_tokens,max_duration_ms)
			VALUES ($1,'monitor-campaign:mutation','openrouter','synthetic-test-model','{}'::jsonb,$2,$2,1000,1,100,1000)`, [inferenceJobId, digest])
		await pool.query(`INSERT INTO headlesscode_rsi_inference_calls(job_id,call_id,capability_sha256,request_sha256,state,reserved_spend_microusd,reserved_tokens,actual_spend_microusd,qualified,prompt_tokens,completion_tokens,returned_model,provider_request_id,response_sha256,started_at)
			VALUES ($1,'synthetic-call',$2,$2,'complete',100,100,NULL,false,NULL,NULL,NULL,NULL,NULL,clock_timestamp())`, [inferenceJobId, digest])

		const status = await readRsiOperationsStatus(pool, { queueName: "monitor-test", campaignId: "monitor-campaign", queryTimeoutMs: 3_000 })
		assert.equal(status.health, "unhealthy")
		assert.equal(status.condition, "cancellation-teardown-pending")
		assert.equal(status.queue.pendingTeardown, 1)
		assert.equal(status.queue.jobs[0]?.jobId, jobId)
		assert.ok(status.queue.jobs[0]?.cancelRequestedAt)
		assert.equal(status.campaign.accountingComplete, true, "synthetic campaign has no unsettled inference spend")
		const persisted = await pool.query("SELECT status,cancel_requested_at FROM headlesscode_rsi_jobs WHERE job_id=$1", [jobId])
		assert.equal(persisted.rows[0].status, "leased", "status collection leaves cancellation and lease state unchanged")
		assert.ok(persisted.rows[0].cancel_requested_at)
		const invalidReceiptStatus = await readRsiOperationsStatus(pool, { queueName: "monitor-test", campaignId: "monitor-campaign", queryTimeoutMs: 3_000 })
		assert.equal(invalidReceiptStatus.campaign.inferenceInvalidReceipts, 1, "a complete but unqualified receipt missing billing, tokens and provider/response metadata is unsettled")
		assert.equal(invalidReceiptStatus.campaign.accountingComplete, false)
		assert.equal(invalidReceiptStatus.condition, "cancellation-teardown-pending", "higher-priority teardown alert does not hide the accounting fields")
		await pool.query("UPDATE headlesscode_rsi_jobs SET status='completed' WHERE job_id=$1", [jobId])
		const receiptOnlyStatus = await readRsiOperationsStatus(pool, { queueName: "monitor-test", campaignId: "monitor-campaign", queryTimeoutMs: 3_000 })
		assert.equal(receiptOnlyStatus.condition, "inference-receipt-invalid")
		assert.equal(receiptOnlyStatus.campaign.accountingComplete, false, "missing or unqualified complete receipts cannot appear settled")
		const unchangedReceipt = await pool.query("SELECT state,qualified,actual_spend_microusd,prompt_tokens,completion_tokens FROM headlesscode_rsi_inference_calls WHERE job_id=$1", [inferenceJobId])
		assert.equal(unchangedReceipt.rows[0].state, "complete", "monitor remains read-only")
		assert.equal(unchangedReceipt.rows[0].qualified, false)
	} finally {
		await pool.end()
		await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => undefined)
		await admin.end()
	}
})
