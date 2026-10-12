import { createHash, randomUUID } from "node:crypto"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { performance } from "node:perf_hooks"
import { Pool } from "pg"

const STATUS_SCHEMA_VERSION = 1
const MAX_WORKERS = 100
const MAX_ACTIVE_JOBS = 100
const MAX_HISTORY = 100
const MAX_QUERY_TIMEOUT_MS = 30_000
const MAX_POLL_MS = 60_000
const MAX_MONITOR_RUNTIME_MS = 86_400_000
const MAX_STALL_MS = 604_800_000
const REQUIRED_TABLES = [
	"headlesscode_rsi_queue_policy",
	"headlesscode_rsi_workers",
	"headlesscode_rsi_jobs",
	"headlesscode_rsi_proof_campaigns",
	"headlesscode_rsi_proof_campaign_arms",
	"headlesscode_rsi_proof_campaign_attempts",
	"headlesscode_rsi_inference_campaigns",
	"headlesscode_rsi_inference_jobs",
	"headlesscode_rsi_inference_calls",
]

type Health = "healthy" | "degraded" | "unhealthy" | "unknown"
type QueryResultLike = { rows: Array<Record<string, unknown>>; rowCount: number | null }
interface RsiMonitorClient {
	query(sql: string, values?: unknown[]): Promise<QueryResultLike>
	release(error?: boolean): void
}
export interface RsiMonitorPool {
	connect(): Promise<RsiMonitorClient>
	end(): Promise<void>
}

export interface RsiOperationsStatus {
	schemaVersion: 1
	observedAt: string
	health: Health
	condition: string
	queue: {
		name: string
		policy: { maxInFlight: number; leaseMs: number; maxAttempts: number }
		jobCounts: Record<string, number>
		expiredLeases: number
		pendingTeardown: number
		jobs: Array<Record<string, unknown>>
		jobsTruncated: boolean
		workers: Array<Record<string, unknown>>
		workersTruncated: boolean
		freshWorkers: number
	}
	campaign: {
		id: string
		state: string
		sequence: number
		deadlineAt: string
		deadlineExpired: boolean
		terminal: boolean
		arms: Array<Record<string, unknown>>
		attemptCounts: Record<string, number>
		unsettledAttempts: number
		rootBudgetMicrousd: { ceiling: number; spent: number; reserved: number; unsettled: number }
		inferenceBudgetsMicrousd: Array<{ role: "mutation" | "benchmark"; recorded: boolean; ceiling?: number; spent?: number; reserved?: number; unsettled?: number; blocked?: boolean; calls?: Record<string, number> }>
		inferenceUnmeasuredCalls: number
		inferenceReservedCalls: number
		inferenceInvalidReceipts: number
		accountingComplete: boolean
	}
	progressFingerprint: string
	progressObservedAt?: string
	progressStalled?: boolean
	progressAgeMs?: number
}

export interface RsiStatusOptions {
	queueName: string
	campaignId: string
	queryTimeoutMs: number
	now?: () => Date
}

export interface RsiMonitorOptions extends RsiStatusOptions {
	pool: RsiMonitorPool
	stateDirectory: string
	pollMs: number
	stallMs: number
	maxRuntimeMs: number
	signal?: AbortSignal
	stdout?: (line: string) => void | Promise<void>
}

function safeInteger(value: unknown, name: string, minimum = 0): number {
	const parsed = typeof value === "number" ? value : typeof value === "string" && /^\d+$/.test(value) ? Number(value) : Number.NaN
	if (!Number.isSafeInteger(parsed) || parsed < minimum) throw new Error(`invalid ${name}`)
	return parsed
}

function safeSum(values: number[], name: string): number {
	const total = values.reduce((sum, value) => sum + value, 0)
	if (!Number.isSafeInteger(total)) throw new Error(`invalid ${name}`)
	return total
}

function iso(value: unknown, name: string): string {
	const date = value instanceof Date ? value : new Date(String(value))
	if (!Number.isFinite(date.getTime())) throw new Error(`invalid ${name}`)
	return date.toISOString()
}

function identifier(value: unknown): string {
	const text = String(value ?? "")
	if (!/^[A-Za-z0-9._:-]{1,160}$/.test(text)) throw new Error("invalid operational identifier")
	return text
}

function countRows(rows: Array<Record<string, unknown>>, key: string, label: string, allowedStatuses: readonly string[]): Record<string, number> {
	const result: Record<string, number> = {}
	for (const row of rows) {
		const status = String(row[key] ?? "")
		if (!allowedStatuses.includes(status)) throw new Error(`invalid ${label} status`)
		result[status] = safeInteger(row.count, `${label} count`)
	}
	return result
}

function unknownStatus(queueName: string, campaignId: string, condition: string, now: Date): RsiOperationsStatus {
	return {
		schemaVersion: STATUS_SCHEMA_VERSION,
		observedAt: now.toISOString(),
		health: "unknown",
		condition,
		queue: { name: queueName, policy: { maxInFlight: 0, leaseMs: 0, maxAttempts: 0 }, jobCounts: {}, expiredLeases: 0, pendingTeardown: 0, jobs: [], jobsTruncated: false, workers: [], workersTruncated: false, freshWorkers: 0 },
		campaign: { id: campaignId, state: "unknown", sequence: 0, deadlineAt: "", deadlineExpired: false, terminal: false, arms: [], attemptCounts: {}, unsettledAttempts: 0, rootBudgetMicrousd: { ceiling: 0, spent: 0, reserved: 0, unsettled: 0 }, inferenceBudgetsMicrousd: [], inferenceUnmeasuredCalls: 0, inferenceReservedCalls: 0, inferenceInvalidReceipts: 0, accountingComplete: false },
		progressFingerprint: "",
	}
}

function healthCondition(input: {
	queuePending: number; freshWorkers: number; expiredLeases: number; pendingTeardown: number; campaignState: string;
	deadlineExpired: boolean; armLeaseExpired: boolean; rootCeiling: number; rootSpent: number; rootReserved: number;
	inferenceUnmeasuredCalls: number; inferenceReservedCalls: number; inferenceInvalidReceipts: number; brokerReserved: number; unsettledAttempts: number; armsFinished: boolean;
	inferenceBudgetsRecorded: boolean;
}): { health: Health; condition: string; accountingComplete: boolean } {
	const accountingComplete = input.inferenceBudgetsRecorded && input.unsettledAttempts === 0 && input.rootReserved === 0 && input.brokerReserved === 0 && input.inferenceReservedCalls === 0 && input.inferenceUnmeasuredCalls === 0 && input.inferenceInvalidReceipts === 0
	if (safeSum([input.rootSpent, input.rootReserved], "root budget use") > input.rootCeiling) return { health: "unhealthy", condition: "root-budget-over-ceiling", accountingComplete }
	if (input.deadlineExpired && input.campaignState !== "finished") return { health: "unhealthy", condition: "campaign-deadline-expired", accountingComplete }
	if (input.expiredLeases > 0) return { health: "unhealthy", condition: "expired-job-leases", accountingComplete }
	if (input.pendingTeardown > 0) return { health: "unhealthy", condition: "cancellation-teardown-pending", accountingComplete }
	if (input.inferenceUnmeasuredCalls > 0) return { health: "unhealthy", condition: "inference-accounting-unmeasured", accountingComplete }
	if (input.inferenceInvalidReceipts > 0) return { health: "unhealthy", condition: "inference-receipt-invalid", accountingComplete }
	if (input.inferenceReservedCalls > 0) return { health: "degraded", condition: "inference-call-reservation-open", accountingComplete }
	if (!input.inferenceBudgetsRecorded) return { health: "degraded", condition: "inference-budget-registration-incomplete", accountingComplete }
	if ((input.campaignState === "running" || input.campaignState === "planned") && input.armLeaseExpired) return { health: "unhealthy", condition: "campaign-arm-lease-expired", accountingComplete }
	if (input.queuePending > 0 && input.freshWorkers === 0) return { health: "unhealthy", condition: "pending-work-without-live-worker", accountingComplete }
	if (input.campaignState === "finished" && input.armsFinished && !accountingComplete) return { health: "unhealthy", condition: "terminal-campaign-with-unsettled-accounting", accountingComplete }
	if (input.campaignState === "finished" && !input.armsFinished) return { health: "unhealthy", condition: "terminal-campaign-arm-state-mismatch", accountingComplete }
	if (input.campaignState === "finished" && input.armsFinished) return { health: "healthy", condition: "campaign-terminal-accounting-settled", accountingComplete }
	if (input.unsettledAttempts > 0 || input.rootReserved > 0 || input.brokerReserved > 0) return { health: "degraded", condition: "work-or-accounting-in-progress", accountingComplete }
	return { health: "healthy", condition: "campaign-active-no-pending-accounting", accountingComplete }
}

/** Read only bounded operational metadata. It deliberately never selects payload, manifest, prompt or artifact columns. */
export async function readRsiOperationsStatus(pool: RsiMonitorPool, options: RsiStatusOptions): Promise<RsiOperationsStatus> {
	const now = (options.now ?? (() => new Date()))()
	const unknown = (condition: string) => unknownStatus(options.queueName, options.campaignId, condition, now)
	try { validateRsiMonitorArguments(options) } catch { return unknown("monitor-configuration-invalid") }
	let client: RsiMonitorClient | undefined
	let transactionOpen = false
	try {
		const queryDeadline = performance.now() + options.queryTimeoutMs
		const connected = await pool.connect()
		client = connected
		if (performance.now() >= queryDeadline) throw new Error("status query budget exhausted while connecting")
		await connected.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY")
		transactionOpen = true
		if (performance.now() >= queryDeadline) throw new Error("status query budget exhausted while starting snapshot")
		await connected.query(`SET LOCAL statement_timeout = ${options.queryTimeoutMs}`)
		if (performance.now() >= queryDeadline) throw new Error("status query budget exhausted while starting snapshot")
		const query = async (sql: string, values?: unknown[]): Promise<QueryResultLike> => {
			const remaining = Math.floor(queryDeadline - performance.now())
			if (remaining <= 0) throw new Error("status query budget exhausted")
			await connected.query(`SET LOCAL statement_timeout = ${remaining}`)
			if (performance.now() >= queryDeadline) throw new Error("status query budget exhausted")
			const result = await connected.query(sql, values)
			if (performance.now() > queryDeadline) throw new Error("status query budget exhausted")
			return result
		}
		const tables = await query("SELECT table_name FROM information_schema.tables WHERE table_schema=current_schema() AND table_name=ANY($1::text[])", [REQUIRED_TABLES])
		const found = new Set(tables.rows.map((row) => String(row.table_name)))
		if (REQUIRED_TABLES.some((table) => !found.has(table))) {
			await client.query("ROLLBACK")
			transactionOpen = false
			return unknown("required-schema-missing")
		}

		const policyResult = await query("SELECT max_in_flight,lease_ms,max_attempts FROM headlesscode_rsi_queue_policy WHERE queue_name=$1", [options.queueName])
		const jobGroupResult = await query(`SELECT status,count(*)::bigint AS count,
				count(*) FILTER (WHERE status='leased' AND cancel_requested_at IS NULL AND lease_expires_at <= clock_timestamp())::bigint AS expired_leases,
				count(*) FILTER (WHERE status='leased' AND cancel_requested_at IS NOT NULL)::bigint AS pending_teardown,
				COALESCE(sum(attempts),0)::bigint AS attempts_total
				FROM headlesscode_rsi_jobs WHERE queue_name=$1 GROUP BY status ORDER BY status`, [options.queueName])
		const jobResult = await query(`SELECT job_id,job_kind,resource_class,status,attempts,max_attempts,lease_owner,lease_expires_at,
				(lease_expires_at IS NOT NULL AND lease_expires_at <= clock_timestamp()) AS lease_expired,
				cancel_requested_at,updated_at
				FROM headlesscode_rsi_jobs WHERE queue_name=$1 AND status IN ('queued','leased') ORDER BY created_at,job_id LIMIT $2`, [options.queueName, MAX_ACTIVE_JOBS + 1])
		const campaignResult = await query(`SELECT campaign_id,state,sequence,deadline_at,deadline_at <= clock_timestamp() AS deadline_expired,
				max_spend_microusd,reserved_spend_microusd,used_spend_microusd
				FROM headlesscode_rsi_proof_campaigns WHERE campaign_id=$1`, [options.campaignId])
		const armResult = await query(`SELECT arm_id,epoch,state,phase,coordinator_id,lease_expires_at,
				(lease_expires_at IS NOT NULL AND lease_expires_at > clock_timestamp()) AS lease_fresh
				FROM headlesscode_rsi_proof_campaign_arms WHERE campaign_id=$1 ORDER BY arm_id LIMIT 3`, [options.campaignId])
		const attemptResult = await query("SELECT status,count(*)::bigint AS count FROM headlesscode_rsi_proof_campaign_attempts WHERE campaign_id=$1 GROUP BY status ORDER BY status", [options.campaignId])
		const brokerResult = await query(`SELECT campaign_id,max_spend_microusd,reserved_spend_microusd,spent_microusd,blocked
				FROM headlesscode_rsi_inference_campaigns WHERE campaign_id=ANY($1::text[]) ORDER BY campaign_id`, [[`${options.campaignId}:mutation`, `${options.campaignId}:benchmark`]])
		const callResult = await query(`SELECT inference.campaign_id,calls.state,count(*)::bigint AS count,
				count(*) FILTER (WHERE calls.state='reserved')::bigint AS reserved_count,
				count(*) FILTER (WHERE calls.state='unmeasured')::bigint AS unmeasured_count,
				count(*) FILTER (WHERE calls.state='complete' AND (
					calls.qualified IS NOT TRUE OR calls.actual_spend_microusd IS NULL OR calls.prompt_tokens IS NULL
					OR calls.completion_tokens IS NULL OR calls.returned_model IS NULL OR btrim(calls.returned_model)=''
					OR calls.returned_provider IS NULL OR btrim(calls.returned_provider)=''
					OR calls.provider_request_id IS NULL OR btrim(calls.provider_request_id)=''
					OR calls.response_sha256 IS NULL OR calls.response_sha256 !~ '^[a-f0-9]{64}$'
					OR calls.actual_spend_microusd > calls.reserved_spend_microusd
					OR calls.prompt_tokens + calls.completion_tokens > calls.reserved_tokens
					OR (calls.cached_prompt_tokens IS NOT NULL AND calls.cached_prompt_tokens > calls.prompt_tokens)
				))::bigint AS invalid_receipts,
				COALESCE(sum(calls.reserved_spend_microusd),0)::bigint AS reserved_microusd
				FROM headlesscode_rsi_inference_campaigns AS campaigns
				LEFT JOIN headlesscode_rsi_inference_jobs AS inference ON inference.campaign_id=campaigns.campaign_id
			LEFT JOIN headlesscode_rsi_inference_calls AS calls ON calls.job_id=inference.job_id
			WHERE campaigns.campaign_id=ANY($1::text[]) GROUP BY inference.campaign_id,calls.state ORDER BY inference.campaign_id,calls.state`, [[`${options.campaignId}:mutation`, `${options.campaignId}:benchmark`]])
		const policy = policyResult.rows[0]
		const campaign = campaignResult.rows[0]
		if (!policy || !campaign) {
			await client.query("ROLLBACK")
			transactionOpen = false
			return unknown(!policy ? "queue-not-found" : "campaign-not-found")
		}

		const maxInFlight = safeInteger(policy.max_in_flight, "queue capacity", 1)
		const leaseMs = safeInteger(policy.lease_ms, "queue lease", 1000)
		const maxAttempts = safeInteger(policy.max_attempts, "queue retry limit", 1)
		const freshWorkerCountResult = await query(`SELECT count(*)::bigint AS count FROM headlesscode_rsi_workers
			WHERE queue_name=$1 AND active AND heartbeat_at > clock_timestamp()-($2::text || ' milliseconds')::interval`, [options.queueName, leaseMs * 2])
		const workerResult = await query(`SELECT worker_id,active,resource_classes,registered_at,heartbeat_at,
			GREATEST(0,floor(extract(epoch FROM (clock_timestamp()-heartbeat_at))*1000))::bigint AS heartbeat_age_ms,
			heartbeat_at > clock_timestamp()-($2::text || ' milliseconds')::interval AS heartbeat_fresh
			FROM headlesscode_rsi_workers WHERE queue_name=$1 ORDER BY heartbeat_at DESC,worker_id LIMIT $3`, [options.queueName, leaseMs * 2, MAX_WORKERS + 1])
		const workerRows = workerResult.rows
		const workersTruncated = workerRows.length > MAX_WORKERS
		const workers = workerRows.slice(0, MAX_WORKERS).map((row) => {
			if (typeof row.active !== "boolean" || typeof row.heartbeat_fresh !== "boolean" || !Array.isArray(row.resource_classes)) throw new Error("invalid worker registration metadata")
			const resourceClasses = row.resource_classes.map(String)
			if (resourceClasses.some((resource) => !["LOCAL_GPU", "CPU", "REMOTE_API", "TRAINING_GPU"].includes(resource))) throw new Error("invalid worker resource metadata")
			return {
				workerId: identifier(row.worker_id), active: row.active,
				resourceClasses, registeredAt: iso(row.registered_at, "worker registration time"), heartbeatAt: iso(row.heartbeat_at, "worker heartbeat"),
				heartbeatAgeMs: safeInteger(row.heartbeat_age_ms, "worker heartbeat age"), heartbeatFresh: row.heartbeat_fresh,
			}
		})
		const freshWorkers = safeInteger(freshWorkerCountResult.rows[0]?.count, "fresh worker count")
		const jobCounts = countRows(jobGroupResult.rows, "status", "job", ["queued", "leased", "completed", "failed", "cancelled"])
		for (const status of ["queued", "leased", "completed", "failed", "cancelled"]) jobCounts[status] ??= 0
		const expiredLeases = safeSum(jobGroupResult.rows.map((row) => safeInteger(row.expired_leases, "expired lease count")), "expired lease count")
		const pendingTeardown = safeSum(jobGroupResult.rows.map((row) => safeInteger(row.pending_teardown, "pending teardown count")), "pending teardown count")
		const attemptsTotal = safeSum(jobGroupResult.rows.map((row) => safeInteger(row.attempts_total, "job attempts")), "job attempts")
		const jobRows = jobResult.rows
		const jobsTruncated = jobRows.length > MAX_ACTIVE_JOBS
		const jobs = jobRows.slice(0, MAX_ACTIVE_JOBS).map((row) => ({
			jobId: identifier(row.job_id),
			jobKind: safeEnum(row.job_kind, ["mutation", "evaluation"] as const, "job kind"),
			resourceClass: safeEnum(row.resource_class, ["LOCAL_GPU", "CPU", "REMOTE_API", "TRAINING_GPU"] as const, "resource class"),
			status: safeEnum(row.status, ["queued", "leased"] as const, "active job status"), attempts: safeInteger(row.attempts, "job attempt count"),
			maxAttempts: safeInteger(row.max_attempts, "job retry limit", 1), leaseOwner: row.lease_owner === null ? null : identifier(row.lease_owner),
			leaseExpiresAt: row.lease_expires_at === null ? null : iso(row.lease_expires_at, "job lease expiry"), leaseExpired: row.lease_expired === true,
			cancelRequestedAt: row.cancel_requested_at === null ? null : iso(row.cancel_requested_at, "cancellation request"),
			updatedAt: iso(row.updated_at, "job update time"),
		}))

		const campaignId = identifier(campaign.campaign_id)
		const campaignState = safeEnum(campaign.state, ["planned", "running", "evaluated", "selected", "rejected", "confirmed", "finished"] as const, "campaign state")
		const sequence = safeInteger(campaign.sequence, "campaign event sequence")
		const deadlineAt = iso(campaign.deadline_at, "campaign deadline")
		if (typeof campaign.deadline_expired !== "boolean") throw new Error("invalid campaign deadline state")
		const rootCeiling = safeInteger(campaign.max_spend_microusd, "root budget")
		const rootReserved = safeInteger(campaign.reserved_spend_microusd, "root reserved budget")
		const rootSpent = safeInteger(campaign.used_spend_microusd, "root spent budget")
		if (armResult.rows.length !== 2) throw new Error("campaign must have exactly two arms for a trustworthy status")
		const arms = armResult.rows.map((row) => {
			if (typeof row.lease_fresh !== "boolean") throw new Error("invalid arm lease state")
			return {
				armId: identifier(row.arm_id), epoch: safeInteger(row.epoch, "arm epoch"),
				state: safeEnum(row.state, ["planned", "running", "evaluated", "selected", "rejected", "confirmed", "finished"] as const, "arm state"),
				phase: safeEnum(row.phase, ["development", "confirmation"] as const, "arm phase"),
				coordinatorId: row.coordinator_id === null ? null : identifier(row.coordinator_id),
				leaseExpiresAt: row.lease_expires_at === null ? null : iso(row.lease_expires_at, "arm lease expiry"), leaseFresh: row.lease_fresh,
			}
		})
		const attemptCounts = countRows(attemptResult.rows, "status", "campaign attempt", ["admitted", "dispatched", "completed", "uncertain", "failed", "incomplete", "skipped-after-hard-gate", "not-selected"])
		const unsettledAttempts = safeSum(["admitted", "dispatched", "uncertain", "incomplete"].map((key) => attemptCounts[key] ?? 0), "unsettled attempt count")
		const inferenceUnmeasuredCalls = safeSum(callResult.rows.map((row) => safeInteger(row.unmeasured_count, "unmeasured inference calls")), "unmeasured inference call count")
		const inferenceReservedCalls = safeSum(callResult.rows.map((row) => safeInteger(row.reserved_count, "reserved inference calls")), "reserved inference call count")
		const inferenceInvalidReceipts = safeSum(callResult.rows.map((row) => safeInteger(row.invalid_receipts, "invalid inference receipts")), "invalid inference receipt count")
		const inferenceBudgetsMicrousd = (["mutation", "benchmark"] as const).map((role) => {
			const id = `${options.campaignId}:${role}`
			const row = brokerResult.rows.find((candidate) => candidate.campaign_id === id)
			const callRows = callResult.rows.filter((candidate) => candidate.campaign_id === id && candidate.state !== null)
			const calls = Object.fromEntries(callRows.map((candidate) => [safeEnum(candidate.state, ["reserved", "complete", "unmeasured"] as const, "inference call state"), safeInteger(candidate.count, "inference call count")]))
			if (!row) return { role, recorded: false }
			if (typeof row.blocked !== "boolean") throw new Error("invalid inference campaign block state")
			const ceiling = safeInteger(row.max_spend_microusd, "inference budget")
			const reserved = safeInteger(row.reserved_spend_microusd, "inference reserved budget")
			const spent = safeInteger(row.spent_microusd, "inference spent budget")
			return { role, recorded: true, ceiling, spent, reserved, unsettled: reserved, blocked: row.blocked, calls }
		})
		const brokerReserved = safeSum(inferenceBudgetsMicrousd.map((budget) => budget.reserved ?? 0), "inference reserved budget sum")
		const armsFinished = arms.length === 2 && arms.every((arm) => arm.state === "finished")
		const terminal = campaignState === "finished" && armsFinished
		const armLeaseExpired = arms.some((arm) => arm.state === "running" && arm.leaseFresh === false)
		const assessment = healthCondition({
			queuePending: safeSum([jobCounts.queued, jobCounts.leased], "pending job count"), freshWorkers, expiredLeases, pendingTeardown, campaignState,
			deadlineExpired: campaign.deadline_expired, armLeaseExpired, rootCeiling, rootSpent, rootReserved,
			inferenceUnmeasuredCalls, inferenceReservedCalls, inferenceInvalidReceipts, brokerReserved, unsettledAttempts, armsFinished, inferenceBudgetsRecorded: inferenceBudgetsMicrousd.every((budget) => budget.recorded),
		})
		if (inferenceBudgetsMicrousd.some((budget) => budget.blocked || (budget.ceiling !== undefined && safeSum([budget.spent ?? 0, budget.reserved ?? 0], `${budget.role} budget use`) > budget.ceiling))) {
			assessment.health = "unhealthy"
			assessment.condition = "inference-campaign-blocked-or-over-ceiling"
		}
		const progressFingerprint = createHash("sha256").update(JSON.stringify({
			jobCounts, attemptsTotal, campaignState, sequence, attemptCounts, rootCeiling, rootSpent, rootReserved,
				inference: inferenceBudgetsMicrousd.map(({ role, recorded, ceiling, spent, reserved, calls }) => ({ role, recorded, ceiling, spent, reserved, calls })),
		})).digest("hex")
		await client.query("COMMIT")
		transactionOpen = false
		return {
			schemaVersion: STATUS_SCHEMA_VERSION,
			observedAt: now.toISOString(),
			health: assessment.health,
			condition: assessment.condition,
			queue: { name: options.queueName, policy: { maxInFlight, leaseMs, maxAttempts }, jobCounts, expiredLeases, pendingTeardown, jobs, jobsTruncated, workers, workersTruncated, freshWorkers },
			campaign: {
				id: campaignId, state: campaignState, sequence, deadlineAt, deadlineExpired: campaign.deadline_expired, terminal,
				arms, attemptCounts, unsettledAttempts,
				rootBudgetMicrousd: { ceiling: rootCeiling, spent: rootSpent, reserved: rootReserved, unsettled: rootReserved },
				inferenceBudgetsMicrousd, inferenceUnmeasuredCalls, inferenceReservedCalls, inferenceInvalidReceipts, accountingComplete: assessment.accountingComplete,
			},
			progressFingerprint,
		}
	} catch {
		if (transactionOpen && client) await client.query("ROLLBACK").catch(() => undefined)
		return unknown("database-or-records-unavailable")
	} finally {
		client?.release()
	}
}

function safeEnum<const T extends readonly string[]>(value: unknown, allowed: T, name: string): T[number] {
	if (typeof value !== "string" || !allowed.includes(value)) throw new Error(`invalid ${name}`)
	return value as T[number]
}

export function createRsiMonitorPool(env: NodeJS.ProcessEnv = process.env, queryTimeoutMs = 5_000): Pool {
	const connectionString = env.HEADLESSCODE_RSI_DATABASE_URL?.trim()
	if (!connectionString) throw new Error("HEADLESSCODE_RSI_DATABASE_URL is required")
	if (!Number.isSafeInteger(queryTimeoutMs) || queryTimeoutMs < 250 || queryTimeoutMs > MAX_QUERY_TIMEOUT_MS) throw new Error("query timeout must be between 250 and 30000 milliseconds")
	return new Pool({
		connectionString,
		max: 1,
		connectionTimeoutMillis: queryTimeoutMs,
		query_timeout: queryTimeoutMs,
		statement_timeout: queryTimeoutMs,
		application_name: "headlesscode-rsi-monitor",
	})
}

export function validateRsiMonitorArguments(input: { queueName: string; campaignId: string; queryTimeoutMs: number; pollMs?: number; stallMs?: number; maxRuntimeMs?: number }): void {
	if (!/^[a-z0-9][a-z0-9_-]{0,62}$/.test(input.queueName)) throw new Error("queue name must be a simple lowercase identifier")
	if (!/^[A-Za-z0-9._:-]{1,160}$/.test(input.campaignId)) throw new Error("campaign ID must be a simple identifier")
	if (!Number.isSafeInteger(input.queryTimeoutMs) || input.queryTimeoutMs < 250 || input.queryTimeoutMs > MAX_QUERY_TIMEOUT_MS) throw new Error("query timeout must be between 250 and 30000 milliseconds")
	if (input.pollMs !== undefined && (!Number.isSafeInteger(input.pollMs) || input.pollMs < 1000 || input.pollMs > MAX_POLL_MS)) throw new Error("poll interval must be between 1000 and 60000 milliseconds")
	if (input.stallMs !== undefined && (!Number.isSafeInteger(input.stallMs) || input.stallMs < (input.pollMs ?? 1000) * 2 || input.stallMs > MAX_STALL_MS)) throw new Error("stall limit must be at least twice the poll interval and no more than seven days")
	if (input.maxRuntimeMs !== undefined && (!Number.isSafeInteger(input.maxRuntimeMs) || input.maxRuntimeMs < 1000 || input.maxRuntimeMs > MAX_MONITOR_RUNTIME_MS)) throw new Error("monitor runtime must be between 1000 milliseconds and 24 hours")
}

interface MonitorState {
	schemaVersion: 1
	queueName: string
	campaignId: string
	lastProgressFingerprint: string
	lastProgressAt: string
	lastHistoryFingerprint?: string
	history: Array<{ observedAt: string; health: Health; condition: string; campaignState: string; jobCounts: Record<string, number>; progressFingerprint: string }>
}

async function preparePrivateStateDirectory(directory: string): Promise<string> {
	if (!path.isAbsolute(directory)) throw new Error("monitor state directory must be an absolute path")
	await fs.mkdir(directory, { recursive: true, mode: 0o700 })
	const info = await fs.lstat(directory)
	if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("monitor state directory must be a real directory")
	if (typeof process.getuid === "function" && info.uid !== process.getuid()) throw new Error("monitor state directory must be owned by the current user")
	if ((info.mode & 0o077) !== 0) throw new Error("monitor state directory must not be accessible by group or other users")
	return await fs.realpath(directory)
}

async function atomicJson(directory: string, filename: string, value: unknown): Promise<void> {
	const temporary = path.join(directory, `.${filename}.${process.pid}.${randomUUID()}.tmp`)
	const target = path.join(directory, filename)
	try {
		const handle = await fs.open(temporary, "wx", 0o600)
		try { await handle.writeFile(`${JSON.stringify(value)}\n`, "utf8"); await handle.sync() } finally { await handle.close() }
		await fs.rename(temporary, target)
		const directoryHandle = await fs.open(directory, "r")
		try { await directoryHandle.sync() } finally { await directoryHandle.close() }
	} finally { await fs.rm(temporary, { force: true }).catch(() => undefined) }
}

async function processStartTicks(pid: number): Promise<string> {
	const stat = await fs.readFile(`/proc/${pid}/stat`, "utf8")
	const suffix = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/)
	const startTicks = suffix[19]
	if (!/^\d+$/.test(startTicks ?? "")) throw new Error("could not verify process start identity")
	return startTicks
}

async function monitorProcessIdentity(): Promise<{ pid: number; startTicks: string; bootId: string }> {
	const [startTicks, bootId] = await Promise.all([
		processStartTicks(process.pid), fs.readFile("/proc/sys/kernel/random/boot_id", "utf8").then((value) => value.trim()),
	])
	if (!/^[a-f0-9-]{16,64}$/i.test(bootId)) throw new Error("could not verify system boot identity")
	return { pid: process.pid, startTicks, bootId }
}

interface MonitorProcessIdentity { pid: number; startTicks: string; bootId: string }

async function isStaleMonitorLock(contents: string, queueName: string, campaignId: string): Promise<boolean> {
	let parsed: { schemaVersion?: unknown; pid?: unknown; startTicks?: unknown; bootId?: unknown; queueName?: unknown; campaignId?: unknown }
	try { parsed = JSON.parse(contents) as typeof parsed } catch { throw new Error("monitor lock is malformed; inspect it before removal") }
	const pid = parsed?.pid
	const startTicks = parsed?.startTicks
	const bootId = parsed?.bootId
	if (parsed?.schemaVersion !== 1 || typeof pid !== "number" || !Number.isSafeInteger(pid) || pid < 1
		|| typeof startTicks !== "string" || !/^\d+$/.test(startTicks)
		|| typeof bootId !== "string" || !/^[a-f0-9-]{16,64}$/i.test(bootId)
		|| parsed.queueName !== queueName || parsed.campaignId !== campaignId) throw new Error("monitor lock identity or scope is invalid; inspect it before removal")
	const currentBoot = (await fs.readFile("/proc/sys/kernel/random/boot_id", "utf8").catch(() => "")).trim()
	if (!currentBoot) throw new Error("system boot identity is unavailable; inspect monitor lock before removal")
	if (currentBoot !== bootId) return true
	try { return await processStartTicks(pid) !== startTicks }
	catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return true
		throw new Error("could not verify the process recorded in monitor lock")
	}
}

async function acquireMonitorLock(directory: string, scope: { queueName: string; campaignId: string }): Promise<{ release: () => Promise<void>; identity: MonitorProcessIdentity }> {
	const lockPath = path.join(directory, "monitor.lock")
	const bootstrapPath = path.join(directory, "monitor.lock.bootstrap")
	const identity = await monitorProcessIdentity()
	const contents = `${JSON.stringify({ schemaVersion: 1, ...identity, ...scope, startedAt: new Date().toISOString() })}\n`
	const bootstrapContents = `${JSON.stringify({ schemaVersion: 1, ...identity, ...scope, nonce: randomUUID() })}\n`
	let bootstrap
	try { bootstrap = await fs.open(bootstrapPath, "wx", 0o600) }
	catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error("monitor lock acquisition is already in progress or a prior acquisition stopped; inspect monitor.lock.bootstrap")
		throw error
	}
	let handle: Awaited<ReturnType<typeof fs.open>> | undefined
	try {
		await bootstrap.writeFile(bootstrapContents, "utf8")
		await bootstrap.sync()
		try { handle = await fs.open(lockPath, "wx", 0o600) }
		catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
			const existing = await fs.readFile(lockPath, "utf8")
			if (!await isStaleMonitorLock(existing, scope.queueName, scope.campaignId)) throw new Error("an RSI monitor process already holds the lock")
			if (await fs.readFile(lockPath, "utf8").catch(() => "") !== existing) throw new Error("monitor lock changed during stale-owner check")
			await fs.unlink(lockPath)
			handle = await fs.open(lockPath, "wx", 0o600)
		}
		await handle.writeFile(contents, "utf8")
		await handle.sync()
	} catch (error) {
		await handle?.close().catch(() => undefined)
		throw error
	} finally {
		await bootstrap.close().catch(() => undefined)
		const current = await fs.readFile(bootstrapPath, "utf8").catch(() => "")
		if (current === bootstrapContents) await fs.unlink(bootstrapPath).catch(() => undefined)
	}
	return { identity, release: async () => {
		await handle.close().catch(() => undefined)
		const current = await fs.readFile(lockPath, "utf8").catch(() => "")
		if (current === contents) await fs.unlink(lockPath).catch(() => undefined)
	} }
}

async function readMonitorState(directory: string, scope: { queueName: string; campaignId: string }): Promise<MonitorState | undefined> {
	try {
		const parsed = JSON.parse(await fs.readFile(path.join(directory, "state.json"), "utf8")) as Partial<MonitorState>
		if (parsed.schemaVersion !== 1 || parsed.queueName !== scope.queueName || parsed.campaignId !== scope.campaignId
			|| typeof parsed.lastProgressFingerprint !== "string" || !/^(?:[a-f0-9]{64})?$/.test(parsed.lastProgressFingerprint)
			|| typeof parsed.lastProgressAt !== "string" || !Number.isFinite(Date.parse(parsed.lastProgressAt))
			|| (parsed.lastHistoryFingerprint !== undefined && !/^[a-f0-9]{64}$/.test(parsed.lastHistoryFingerprint))
			|| !Array.isArray(parsed.history) || parsed.history.length > MAX_HISTORY
			|| parsed.history.some((row) => !row || typeof row.observedAt !== "string" || !Number.isFinite(Date.parse(row.observedAt))
				|| !["healthy", "degraded", "unhealthy", "unknown"].includes(row.health) || typeof row.condition !== "string"
				|| typeof row.campaignState !== "string" || !row.jobCounts || typeof row.jobCounts !== "object"
				|| !/^(?:[a-f0-9]{64})?$/.test(row.progressFingerprint))) throw new Error("invalid RSI monitor state")
		return parsed as MonitorState
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
		throw new Error("RSI monitor state is malformed; inspect or archive it before restarting")
	}
}

function monitorReport(status: RsiOperationsStatus): Record<string, unknown> {
	return {
		observedAt: status.observedAt,
		health: status.health,
		condition: status.condition,
		queue: {
			name: status.queue.name,
			jobCounts: status.queue.jobCounts,
			expiredLeases: status.queue.expiredLeases,
			pendingTeardown: status.queue.pendingTeardown,
			freshWorkers: status.queue.freshWorkers,
		},
		campaign: {
			id: status.campaign.id,
			state: status.campaign.state,
			sequence: status.campaign.sequence,
			unsettledAttempts: status.campaign.unsettledAttempts,
			rootBudgetMicrousd: status.campaign.rootBudgetMicrousd,
			inferenceBudgetsMicrousd: status.campaign.inferenceBudgetsMicrousd,
			inferenceUnmeasuredCalls: status.campaign.inferenceUnmeasuredCalls,
			inferenceReservedCalls: status.campaign.inferenceReservedCalls,
			inferenceInvalidReceipts: status.campaign.inferenceInvalidReceipts,
			accountingComplete: status.campaign.accountingComplete,
		},
		progressStalled: status.progressStalled ?? false,
		progressAgeMs: status.progressAgeMs ?? null,
	}
}

export async function runRsiMonitor(options: RsiMonitorOptions): Promise<number> {
	validateRsiMonitorArguments(options)
	if (!Number.isSafeInteger(options.pollMs) || options.pollMs < 1000 || options.pollMs > MAX_POLL_MS
		|| !Number.isSafeInteger(options.stallMs) || options.stallMs < options.pollMs * 2 || options.stallMs > MAX_STALL_MS
		|| !Number.isSafeInteger(options.maxRuntimeMs) || options.maxRuntimeMs < 1000 || options.maxRuntimeMs > MAX_MONITOR_RUNTIME_MS
		|| options.queryTimeoutMs > options.maxRuntimeMs) throw new Error("monitor poll, stall and runtime limits are invalid")
	const directory = await preparePrivateStateDirectory(options.stateDirectory)
	const lock = await acquireMonitorLock(directory, options)
	const stdout = options.stdout ?? ((line: string) => process.stdout.write(`${line}\n`))
	const startedAt = Date.now()
	const deadline = startedAt + options.maxRuntimeMs
	let state: MonitorState | undefined
	let lastHealthFingerprint: string | undefined
	let exitCode = 0
	const onSignal = () => { /* AbortSignal supplied by CLI owns shutdown. */ }
	options.signal?.addEventListener("abort", onSignal, { once: true })
	try {
		state = await readMonitorState(directory, options)
		lastHealthFingerprint = state?.lastHistoryFingerprint
		while (!options.signal?.aborted) {
			const remainingMs = Math.floor(deadline - Date.now())
			if (remainingMs < 250) { exitCode = 75; break }
			const observed = await readRsiOperationsStatus(options.pool, { ...options, queryTimeoutMs: Math.min(options.queryTimeoutMs, remainingMs) })
			const now = new Date()
			if (state && observed.progressFingerprint && observed.progressFingerprint !== state.lastProgressFingerprint) {
				state.lastProgressFingerprint = observed.progressFingerprint
				state.lastProgressAt = now.toISOString()
			}
			if (!state && observed.progressFingerprint) state = { schemaVersion: 1, queueName: options.queueName, campaignId: options.campaignId, lastProgressFingerprint: observed.progressFingerprint, lastProgressAt: now.toISOString(), history: [] }
			if (state && observed.progressFingerprint) {
				observed.progressObservedAt = state.lastProgressAt
				observed.progressAgeMs = Math.max(0, now.getTime() - Date.parse(state.lastProgressAt))
				const pending = safeSum([observed.queue.jobCounts.queued, observed.queue.jobCounts.leased, observed.campaign.unsettledAttempts], "monitor pending count")
				observed.progressStalled = !observed.campaign.terminal && pending > 0 && observed.progressAgeMs >= options.stallMs
				if (observed.progressStalled && observed.health !== "unknown") {
					observed.health = "unhealthy"
					observed.condition = "operational-progress-stalled"
				}
			}
			const historyFingerprint = createHash("sha256").update(JSON.stringify({
				health: observed.health, condition: observed.condition, campaign: observed.campaign.state,
				jobs: observed.queue.jobCounts, progress: observed.progressFingerprint,
			})).digest("hex")
			if (!state) state = { schemaVersion: 1, queueName: options.queueName, campaignId: options.campaignId, lastProgressFingerprint: observed.progressFingerprint, lastProgressAt: now.toISOString(), history: [] }
			const changed = historyFingerprint !== lastHealthFingerprint
			if (changed) {
				state.history.push({ observedAt: observed.observedAt, health: observed.health, condition: observed.condition, campaignState: observed.campaign.state, jobCounts: observed.queue.jobCounts, progressFingerprint: observed.progressFingerprint })
				state.history = state.history.slice(-MAX_HISTORY)
				state.lastHistoryFingerprint = historyFingerprint
				lastHealthFingerprint = historyFingerprint
			}
			await atomicJson(directory, "state.json", state)
			await atomicJson(directory, "status.json", observed)
			await atomicJson(directory, "heartbeat.json", { schemaVersion: 1, ...lock.identity, queueName: options.queueName, campaignId: options.campaignId, heartbeatAt: new Date().toISOString(), observedAt: observed.observedAt, health: observed.health, condition: observed.condition, campaignState: observed.campaign.state, progressObservedAt: observed.progressObservedAt ?? null })
			if (changed) await stdout(JSON.stringify(monitorReport(observed)))
			if (Date.now() >= deadline) {
				exitCode = 75
				break
			}
			if (options.signal?.aborted) break
			await delay(Math.min(options.pollMs, Math.max(1, deadline - Date.now())), undefined, { signal: options.signal }).catch(() => undefined)
		}
		return exitCode
	} finally {
		options.signal?.removeEventListener("abort", onSignal)
		await lock.release()
	}
}

export async function runRsiMonitorProcess(options: Omit<RsiMonitorOptions, "pool">): Promise<number> {
	const pool = createRsiMonitorPool(process.env, options.queryTimeoutMs)
	try { return await runRsiMonitor({ ...options, pool }) } finally { await pool.end() }
}

export const RSI_MONITOR_LIMITS = { maxQueryTimeoutMs: MAX_QUERY_TIMEOUT_MS, maxPollMs: MAX_POLL_MS, maxRuntimeMs: MAX_MONITOR_RUNTIME_MS, maxStallMs: MAX_STALL_MS, maxHistory: MAX_HISTORY }
