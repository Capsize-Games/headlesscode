import { createHash, randomBytes } from "node:crypto"
import type { Pool, PoolClient } from "pg"
import { openRouterProfileForModel, RSI_DEFAULT_OPENROUTER_PROFILE_ID } from "./inference-broker.js"

export type ProofCampaignState = "planned" | "running" | "evaluated" | "selected" | "rejected" | "confirmed" | "finished"
export type ProofCampaignAttemptKind = "mutation" | "development-proof" | "verification" | "confirmation" | "fixed-control"

export interface ProofCampaignManifest {
	schemaVersion: 1
	/** Engineering-only roots terminate after development and never freeze confirmation task IDs. */
	phaseMode?: "paired-confirmation" | "engineering-only"
	campaignId: string
	rootCommit: string
	benchmarkDigests: { manifest: string; development: string; confirmation: string }
	armAssignment: { fixedControl: string; selfHosted: string }
	model: { provider: string; id: string; settings: Record<string, unknown>; profileId?: string }
	seed: string
	taskOrder: string[]
	schedule: Array<{ armId: string; generation: number; candidateId: string; taskId: string; seed: string; attemptKind: ProofCampaignAttemptKind; phase?: "development" | "confirmation" }>
	budgets: {
		attempt: { maxCalls: number; maxTokens: number; maxSpendUsd: number; maxDurationMs: number }
		root: { maxCalls: number; maxTokens: number; maxSpendUsd: number; maxRuntimeMs: number }
	}
	acceptanceRule: Record<string, unknown>
	runtime: { imageDigest: string; harnessCommit: string; dependencyLockDigest: string }
	analysisVersion: string
	settings: Record<string, unknown>
}

export interface ProofCampaignArmLease {
	campaignId: string
	armId: string
	runId: string
	epoch: number
	coordinatorId: string
	token: string
	manifestSha256: string
	deadlineAt: string
	phase: "development" | "confirmation"
}

export interface ProofAttemptReservation {
	attemptKey: string
	kind: ProofCampaignAttemptKind
	identity: {
		generation: number
		candidateId: string
		taskId: string
		seed: string
		attemptKind: ProofCampaignAttemptKind
	}
	requestSha256: string
	sourceCandidateId?: string
	calls: number
	tokens: number
	spendUsd: number
	jobId?: string
	brokerJobId?: string
}

export interface ProofAttemptSettlement {
	status: "completed" | "uncertain" | "failed"
	resultSha256?: string
	artifactRefs?: Record<string, unknown>
	actualCalls?: number
	actualTokens?: number
	actualSpendUsd?: number
	error?: string
}

export interface ProofAttemptSkip {
	attemptKey: string
	identity: ProofAttemptReservation["identity"]
	requestSha256: string
	reason: string
}

function stableJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`
	if (value && typeof value === "object") {
		const object = value as Record<string, unknown>
		return `{${Object.keys(object).filter((key) => object[key] !== undefined).sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b))).map((key) => `${JSON.stringify(key)}:${stableJson(object[key])}`).join(",")}}`
	}
	const encoded = JSON.stringify(value)
	return encoded === undefined ? "null" : encoded
}

function digest(value: unknown): string { return createHash("sha256").update(stableJson(value)).digest("hex") }
function ceilMicros(usd: number): number {
	if (!Number.isFinite(usd) || usd < 0) throw new Error("proof campaign spend must be finite and nonnegative")
	const result = Math.ceil(usd * 1_000_000)
	if (!Number.isSafeInteger(result)) throw new Error("proof campaign spend exceeds safe accounting range")
	return result
}
function floorMicros(usd: number): number {
	if (!Number.isFinite(usd) || usd < 0) throw new Error("proof campaign spend cap must be finite and nonnegative")
	const result = Math.floor(usd * 1_000_000)
	if (!Number.isSafeInteger(result)) throw new Error("proof campaign spend cap exceeds safe accounting range")
	return result
}
function validCounter(value: number, label: string): void {
	if (!Number.isSafeInteger(value) || value < 0) throw new Error(`proof campaign ${label} must be a nonnegative safe integer`)
}

export function proofCampaignManifestDigest(manifest: ProofCampaignManifest): string {
	validateProofCampaignManifest(manifest)
	return digest(manifest)
}

export function validateProofCampaignManifest(manifest: ProofCampaignManifest): void {
	if (manifest.schemaVersion !== 1 || !/^[A-Za-z0-9._:-]{1,160}$/.test(manifest.campaignId)) throw new Error("proof campaign manifest identity is malformed")
	if (!/^[a-f0-9]{40}$/.test(manifest.rootCommit)) throw new Error("proof campaign root commit must be a full commit SHA")
	for (const [name, sha] of Object.entries(manifest.benchmarkDigests)) if (!/^[a-f0-9]{64}$/.test(sha)) throw new Error(`proof campaign ${name} benchmark digest is malformed`)
	if (!manifest.armAssignment.fixedControl || !manifest.armAssignment.selfHosted || manifest.armAssignment.fixedControl === manifest.armAssignment.selfHosted) throw new Error("proof campaign must freeze distinct fixed-control and self-hosted arm assignments")
	if (!manifest.model.provider.trim() || !manifest.model.id.trim() || !manifest.seed.trim()) throw new Error("proof campaign model and seed identity are required")
	if (manifest.model.provider === "openshell-openrouter") {
		const profile = openRouterProfileForModel(manifest.model.id, manifest.model.profileId)
		if (profile.id !== RSI_DEFAULT_OPENROUTER_PROFILE_ID && manifest.model.profileId !== profile.id) throw new Error("proof campaign OpenRouter profile identity is missing or mismatched")
	}
	if (!manifest.taskOrder.length || new Set(manifest.taskOrder).size !== manifest.taskOrder.length || manifest.taskOrder.some((id) => !id.trim())) throw new Error("proof campaign task order must be nonempty and unique")
	if (!manifest.schedule.length || manifest.schedule.some((cell) => ![manifest.armAssignment.fixedControl, manifest.armAssignment.selfHosted].includes(cell.armId) || !Number.isSafeInteger(cell.generation) || cell.generation < 0 || !cell.candidateId.trim() || !cell.taskId.trim() || !cell.seed.trim() || !["mutation", "development-proof", "verification", "confirmation", "fixed-control"].includes(cell.attemptKind) || (cell.phase !== undefined && !["development", "confirmation"].includes(cell.phase)))) throw new Error("proof campaign schedule contains an invalid task cell")
	const scheduleKeys = manifest.schedule.map((cell) => stableJson(cell))
	if (new Set(scheduleKeys).size !== scheduleKeys.length || manifest.schedule.some((cell) => !manifest.taskOrder.includes(cell.taskId))) throw new Error("proof campaign schedule must contain unique cells from the frozen task order")
	for (const [name, budget] of Object.entries(manifest.budgets)) {
		validCounter(budget.maxCalls, `${name} call ceiling`)
		validCounter(budget.maxTokens, `${name} token ceiling`)
		floorMicros(budget.maxSpendUsd)
	}
	validCounter(manifest.budgets.attempt.maxDurationMs, "attempt duration ceiling")
	if (manifest.budgets.attempt.maxDurationMs < 1) throw new Error("proof campaign attempt duration ceiling must be positive")
	validCounter(manifest.budgets.root.maxRuntimeMs, "root runtime ceiling")
	if (manifest.budgets.root.maxRuntimeMs < 1) throw new Error("proof campaign root runtime ceiling must be positive")
	if (!/^sha256:[a-f0-9]{64}$/.test(manifest.runtime.imageDigest) || !/^[a-f0-9]{40}$/.test(manifest.runtime.harnessCommit) || !/^[a-f0-9]{64}$/.test(manifest.runtime.dependencyLockDigest)) throw new Error("proof campaign runtime identity is malformed")
	if (!manifest.analysisVersion.trim()) throw new Error("proof campaign analysis version is required")
	if (manifest.phaseMode !== undefined && !["paired-confirmation", "engineering-only"].includes(manifest.phaseMode)) throw new Error("proof campaign phase mode is invalid")
	if (manifest.phaseMode === "engineering-only" && manifest.schedule.some((cell) => (cell.phase ?? "development") === "confirmation")) throw new Error("engineering-only proof campaign may not freeze confirmation cells")
	stableJson(manifest)
}

async function transaction<T>(pool: Pool, action: (client: PoolClient) => Promise<T>): Promise<T> {
	const client = await pool.connect()
	try {
		await client.query("BEGIN")
		const result = await action(client)
		await client.query("COMMIT")
		return result
	} catch (error) {
		await client.query("ROLLBACK").catch(() => undefined)
		throw error
	} finally { client.release() }
}

/** PostgreSQL is authoritative for campaign identity, admission, fencing, and promotion decisions. */
export class PostgresProofCampaign {
	constructor(private readonly pool: Pool, private readonly leaseMs = 30_000) {
		if (!Number.isSafeInteger(leaseMs) || leaseMs < 1000) throw new Error("proof campaign coordinator lease must be at least one second")
	}

	async acquire(manifest: ProofCampaignManifest, armId: string, runId: string, coordinatorId: string): Promise<ProofCampaignArmLease> {
		validateProofCampaignManifest(manifest)
		if (!manifest.armAssignment || ![manifest.armAssignment.fixedControl, manifest.armAssignment.selfHosted].includes(armId) || !coordinatorId.trim() || !runId.trim()) throw new Error("proof campaign arm or coordinator identity is invalid")
		const manifestSha256 = proofCampaignManifestDigest(manifest)
		const token = randomBytes(32).toString("base64url")
		const tokenHash = createHash("sha256").update(token).digest("hex")
		return transaction(this.pool, async (client) => {
			const inserted = await client.query(
				`INSERT INTO headlesscode_rsi_proof_campaigns(campaign_id,schema_version,manifest,manifest_sha256,expected_arms,state,deadline_at,max_calls,max_tokens,max_spend_microusd)
				 VALUES($1,1,$2::jsonb,$3,$4::jsonb,'planned',clock_timestamp()+($5::text || ' milliseconds')::interval,$6,$7,$8)
				 ON CONFLICT(campaign_id) DO NOTHING RETURNING campaign_id`,
				[manifest.campaignId, stableJson(manifest), manifestSha256, JSON.stringify([manifest.armAssignment.fixedControl, manifest.armAssignment.selfHosted]), manifest.budgets.root.maxRuntimeMs, manifest.budgets.root.maxCalls, manifest.budgets.root.maxTokens, floorMicros(manifest.budgets.root.maxSpendUsd)],
			)
			const rowResult = await client.query("SELECT *, deadline_at > clock_timestamp() AS deadline_valid FROM headlesscode_rsi_proof_campaigns WHERE campaign_id=$1 FOR UPDATE", [manifest.campaignId])
			const row = rowResult.rows[0]
			if (!row || row.schema_version !== 1 || row.manifest_sha256.trim() !== manifestSha256 || stableJson(row.manifest) !== stableJson(manifest)
				|| stableJson(row.expected_arms) !== stableJson([manifest.armAssignment.fixedControl, manifest.armAssignment.selfHosted])
				|| Number(row.max_calls) !== manifest.budgets.root.maxCalls || Number(row.max_tokens) !== manifest.budgets.root.maxTokens || Number(row.max_spend_microusd) !== floorMicros(manifest.budgets.root.maxSpendUsd)) throw new Error("proof campaign manifest or root budget changed during resume")
			if (row.deadline_valid !== true || row.state === "finished") throw new Error("proof campaign root deadline has expired or campaign is finished")
			await client.query(
				`INSERT INTO headlesscode_rsi_proof_campaign_arms(campaign_id,arm_id,run_id,state) VALUES($1,$2,$3,'planned') ON CONFLICT(campaign_id,arm_id) DO NOTHING`,
				[manifest.campaignId, armId, runId],
			)
			const armResult = await client.query("SELECT *, lease_expires_at > clock_timestamp() AS lease_valid FROM headlesscode_rsi_proof_campaign_arms WHERE campaign_id=$1 AND arm_id=$2 FOR UPDATE", [manifest.campaignId, armId])
			const arm = armResult.rows[0]
			if (!arm || arm.run_id !== runId) throw new Error("proof campaign arm is already bound to a different run ID")
			if (arm.state === "finished") throw new Error("proof campaign arm is terminal and cannot be reacquired")
			if (arm.lease_valid === true) throw new Error("proof campaign arm already has an active coordinator; wait for lease expiry before recovery")
			if (arm.phase === "confirmation") {
				const phases = await client.query("SELECT arm_id,phase FROM headlesscode_rsi_proof_campaign_arms WHERE campaign_id=$1 AND arm_id=ANY($2::text[]) ORDER BY arm_id", [manifest.campaignId, [manifest.armAssignment.fixedControl, manifest.armAssignment.selfHosted]])
				if (phases.rowCount !== 2 || phases.rows.some((entry) => entry.phase !== "confirmation")) throw new Error("proof campaign confirmation phase is unavailable until both arms finish development")
			}
			const epoch = Number(arm.epoch) + 1
			await client.query("UPDATE headlesscode_rsi_proof_campaign_arms SET epoch=$3,coordinator_id=$4,lease_token_sha256=$5,lease_expires_at=clock_timestamp()+($6::text || ' milliseconds')::interval,state='running',updated_at=clock_timestamp() WHERE campaign_id=$1 AND arm_id=$2", [manifest.campaignId, armId, epoch, coordinatorId, tokenHash, this.leaseMs])
			await client.query("UPDATE headlesscode_rsi_proof_campaigns SET state='running',updated_at=clock_timestamp() WHERE campaign_id=$1 AND state IN ('planned','running','evaluated','selected','rejected')", [manifest.campaignId])
			await this.appendEvent(client, manifest.campaignId, armId, epoch, "arm-acquired", { runId, coordinatorId, manifestSha256 })
			const deadline = await client.query("SELECT deadline_at FROM headlesscode_rsi_proof_campaigns WHERE campaign_id=$1", [manifest.campaignId])
			return { campaignId: manifest.campaignId, armId, runId, epoch, coordinatorId, token, manifestSha256, deadlineAt: new Date(String(deadline.rows[0].deadline_at)).toISOString(), phase: arm.phase }
		})
	}

	async renew(lease: ProofCampaignArmLease): Promise<boolean> {
		const result = await this.pool.query(
			`UPDATE headlesscode_rsi_proof_campaign_arms AS arm SET lease_expires_at=clock_timestamp()+($5::text || ' milliseconds')::interval,updated_at=clock_timestamp()
			 FROM headlesscode_rsi_proof_campaigns AS campaign
			 WHERE arm.campaign_id=$1 AND arm.arm_id=$2 AND arm.run_id=$3 AND arm.epoch=$4 AND arm.lease_token_sha256=$6
			 AND arm.lease_expires_at > clock_timestamp() AND campaign.campaign_id=arm.campaign_id AND campaign.manifest_sha256=$7 AND campaign.deadline_at > clock_timestamp() AND campaign.state <> 'finished'`,
			[lease.campaignId, lease.armId, lease.runId, lease.epoch, this.leaseMs, createHash("sha256").update(lease.token).digest("hex"), lease.manifestSha256],
		)
		return result.rowCount === 1
	}

	async admit(lease: ProofCampaignArmLease, input: ProofAttemptReservation): Promise<{ duplicate: boolean; status: string }> {
		validCounter(input.calls, "attempt calls"); validCounter(input.tokens, "attempt tokens"); floorMicros(input.spendUsd)
		if (!input.attemptKey.trim() || !/^[a-f0-9]{64}$/.test(input.requestSha256)) throw new Error("proof campaign attempt identity is malformed")
		validCounter(input.identity.generation, "attempt generation")
		if (input.identity.attemptKind !== input.kind || !input.identity.candidateId.trim() || !input.identity.taskId.trim() || !input.identity.seed.trim()) throw new Error("proof campaign task-cell identity is incomplete or disagrees with attempt kind")
		const sourceCandidateId = input.sourceCandidateId ?? input.identity.candidateId
		const identitySha256 = digest({ ...input.identity, sourceCandidateId })
		const reserveSpend = ceilMicros(input.spendUsd)
		return transaction(this.pool, async (client) => {
			const campaign = await this.lockLease(client, lease)
			const frozenAttempt = (campaign.manifest as ProofCampaignManifest).budgets.attempt
			if (input.calls > frozenAttempt.maxCalls || input.tokens > frozenAttempt.maxTokens || reserveSpend > floorMicros(frozenAttempt.maxSpendUsd)) throw new Error("proof campaign attempt reservation exceeds its frozen per-attempt ceiling")
			const schedule = (campaign.manifest as ProofCampaignManifest).schedule
			const frozenCell = schedule.find((cell) => cell.armId === lease.armId && cell.generation === input.identity.generation && cell.candidateId === input.identity.candidateId && cell.taskId === input.identity.taskId && cell.seed === input.identity.seed && cell.attemptKind === input.kind)
			if (!frozenCell) throw new Error("proof campaign attempt is outside the frozen task schedule")
			const cellPhase = frozenCell.phase ?? "development"
			const existingResult = await client.query("SELECT * FROM headlesscode_rsi_proof_campaign_attempts WHERE campaign_id=$1 AND arm_id=$2 AND attempt_key=$3 FOR UPDATE", [lease.campaignId, lease.armId, input.attemptKey])
			const existing = existingResult.rows[0]
			if (existing) {
				if (existing.identity_sha256.trim() !== identitySha256 || existing.source_candidate_id !== sourceCandidateId || existing.request_sha256.trim() !== input.requestSha256 || existing.attempt_kind !== input.kind
					|| Number(existing.reserved_calls) !== input.calls || Number(existing.reserved_tokens) !== input.tokens || Number(existing.reserved_spend_microusd) !== reserveSpend || (input.brokerJobId && existing.broker_job_id !== input.brokerJobId)) throw new Error("proof campaign attempt key was reused with changed identity or reservation")
				if (cellPhase !== lease.phase && !(cellPhase === "development" && lease.phase === "confirmation" && existing.status === "completed")) throw new Error(`proof campaign ${cellPhase} cell cannot be admitted during the ${lease.phase} phase`)
				if (Number(existing.epoch) !== lease.epoch && existing.status !== "completed") await client.query("UPDATE headlesscode_rsi_proof_campaign_attempts SET epoch=$4,updated_at=clock_timestamp() WHERE campaign_id=$1 AND arm_id=$2 AND attempt_key=$3", [lease.campaignId, lease.armId, input.attemptKey, lease.epoch])
				return { duplicate: true, status: String(existing.status) }
			}
			if (cellPhase !== lease.phase) throw new Error(`proof campaign ${cellPhase} cell cannot be admitted during the ${lease.phase} phase`)
			const logicalCell = await client.query("SELECT attempt_key FROM headlesscode_rsi_proof_campaign_attempts WHERE campaign_id=$1 AND arm_id=$2 AND generation=$3 AND candidate_id=$4 AND task_id=$5 AND seed=$6 AND attempt_kind=$7 FOR UPDATE", [lease.campaignId, lease.armId, input.identity.generation, input.identity.candidateId, input.identity.taskId, input.identity.seed, input.kind])
			if (logicalCell.rowCount) throw new Error("proof campaign logical task cell was already admitted under a different attempt key")
			if (Number(campaign.used_calls) + Number(campaign.reserved_calls) + input.calls > Number(campaign.max_calls)
				|| Number(campaign.used_tokens) + Number(campaign.reserved_tokens) + input.tokens > Number(campaign.max_tokens)
				|| Number(campaign.used_spend_microusd) + Number(campaign.reserved_spend_microusd) + reserveSpend > Number(campaign.max_spend_microusd)) throw new Error("proof campaign root admission budget exhausted")
			await client.query("UPDATE headlesscode_rsi_proof_campaigns SET reserved_calls=reserved_calls+$2,reserved_tokens=reserved_tokens+$3,reserved_spend_microusd=reserved_spend_microusd+$4,updated_at=clock_timestamp() WHERE campaign_id=$1", [lease.campaignId, input.calls, input.tokens, reserveSpend])
			await client.query(
				`INSERT INTO headlesscode_rsi_proof_campaign_attempts(campaign_id,arm_id,attempt_key,attempt_kind,generation,candidate_id,source_candidate_id,task_id,seed,identity_sha256,request_sha256,status,epoch,job_id,broker_job_id,reserved_calls,reserved_tokens,reserved_spend_microusd)
				 VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'admitted',$12,$13,$14,$15,$16,$17)`,
				[lease.campaignId, lease.armId, input.attemptKey, input.kind, input.identity.generation, input.identity.candidateId, sourceCandidateId, input.identity.taskId, input.identity.seed, identitySha256, input.requestSha256, lease.epoch, input.jobId ?? null, input.brokerJobId ?? null, input.calls, input.tokens, reserveSpend],
			)
			await this.appendEvent(client, lease.campaignId, lease.armId, lease.epoch, "attempt-admitted", { attemptKey: input.attemptKey, kind: input.kind, identitySha256, requestSha256: input.requestSha256, calls: input.calls, tokens: input.tokens, spendMicrousd: reserveSpend })
			return { duplicate: false, status: "admitted" }
		})
	}

	async markDispatched(lease: ProofCampaignArmLease, attemptKey: string, jobId?: string): Promise<void> {
		await transaction(this.pool, async (client) => {
			await this.lockLease(client, lease)
			const updated = await client.query("UPDATE headlesscode_rsi_proof_campaign_attempts SET status='dispatched',job_id=COALESCE($5,job_id),updated_at=clock_timestamp() WHERE campaign_id=$1 AND arm_id=$2 AND attempt_key=$3 AND epoch=$4 AND status IN ('admitted','dispatched')", [lease.campaignId, lease.armId, attemptKey, lease.epoch, jobId ?? null])
			if (updated.rowCount !== 1) throw new Error("proof campaign attempt was not admitted under the current epoch")
			await this.appendEvent(client, lease.campaignId, lease.armId, lease.epoch, "attempt-dispatched", { attemptKey, jobId: jobId ?? null })
		})
	}

	async skipAfterHardGate(lease: ProofCampaignArmLease, skip: ProofAttemptSkip): Promise<void> {
		if (!skip.attemptKey.trim() || !/^[a-f0-9]{64}$/.test(skip.requestSha256) || !skip.reason.trim()) throw new Error("proof campaign hard-gate skip requires a bound identity, digest, and reason")
		validCounter(skip.identity.generation, "skipped attempt generation")
		if (skip.identity.attemptKind !== "mutation" && skip.identity.attemptKind !== "development-proof" && skip.identity.attemptKind !== "verification") throw new Error("only predeclared mutation, proof, or verification cells can be skipped after a hard gate")
		await transaction(this.pool, async (client) => {
			const campaign = await this.lockLease(client, lease)
			if (lease.phase !== "development" || campaign.arm_phase !== "development") throw new Error("hard-gate skips cannot be added after the development phase closes")
			const identitySha256 = digest({ ...skip.identity, sourceCandidateId: skip.identity.candidateId })
			const frozenCell = (campaign.manifest as ProofCampaignManifest).schedule.some((cell) => cell.armId === lease.armId && (cell.phase ?? "development") === "development" && cell.generation === skip.identity.generation && cell.candidateId === skip.identity.candidateId && cell.taskId === skip.identity.taskId && cell.seed === skip.identity.seed && cell.attemptKind === skip.identity.attemptKind)
			if (!frozenCell) throw new Error("hard-gate skip is outside the frozen task schedule")
			const logicalCell = await client.query("SELECT attempt_key,status FROM headlesscode_rsi_proof_campaign_attempts WHERE campaign_id=$1 AND arm_id=$2 AND generation=$3 AND candidate_id=$4 AND task_id=$5 AND seed=$6 AND attempt_kind=$7 FOR UPDATE", [lease.campaignId, lease.armId, skip.identity.generation, skip.identity.candidateId, skip.identity.taskId, skip.identity.seed, skip.identity.attemptKind])
			if (logicalCell.rowCount) {
				const existing = logicalCell.rows[0]
				if (existing.attempt_key !== skip.attemptKey) throw new Error("hard-gate skip conflicts with a previously admitted proof cell under another key")
				if (existing.status === "skipped-after-hard-gate") return
				if (existing.status !== "admitted") throw new Error("hard-gate skip cannot replace a dispatched, uncertain, or completed proof cell")
				const reservation = await client.query("SELECT reserved_calls,reserved_tokens,reserved_spend_microusd FROM headlesscode_rsi_proof_campaign_attempts WHERE campaign_id=$1 AND arm_id=$2 AND attempt_key=$3 FOR UPDATE", [lease.campaignId, lease.armId, skip.attemptKey])
				await client.query("UPDATE headlesscode_rsi_proof_campaigns SET reserved_calls=reserved_calls-$2,reserved_tokens=reserved_tokens-$3,reserved_spend_microusd=reserved_spend_microusd-$4,updated_at=clock_timestamp() WHERE campaign_id=$1", [lease.campaignId, Number(reservation.rows[0].reserved_calls), Number(reservation.rows[0].reserved_tokens), Number(reservation.rows[0].reserved_spend_microusd)])
				await client.query("UPDATE headlesscode_rsi_proof_campaign_attempts SET status='skipped-after-hard-gate',request_sha256=$4,reserved_calls=0,reserved_tokens=0,reserved_spend_microusd=0,error=$5,updated_at=clock_timestamp() WHERE campaign_id=$1 AND arm_id=$2 AND attempt_key=$3", [lease.campaignId, lease.armId, skip.attemptKey, skip.requestSha256, skip.reason.slice(0, 512)])
				await this.appendEvent(client, lease.campaignId, lease.armId, lease.epoch, "attempt-skipped-after-hard-gate", { attemptKey: skip.attemptKey, identitySha256, evidenceSha256: skip.requestSha256, reason: skip.reason.slice(0, 512), dispatched: false, releasedReservation: { calls: Number(reservation.rows[0].reserved_calls), tokens: Number(reservation.rows[0].reserved_tokens), spendMicrousd: Number(reservation.rows[0].reserved_spend_microusd) } })
				return
			}
			await client.query(
				`INSERT INTO headlesscode_rsi_proof_campaign_attempts(campaign_id,arm_id,attempt_key,attempt_kind,generation,candidate_id,source_candidate_id,task_id,seed,identity_sha256,request_sha256,status,epoch,reserved_calls,reserved_tokens,reserved_spend_microusd,error)
				 VALUES($1,$2,$3,$4,$5,$6,$6,$7,$8,$9,$10,'skipped-after-hard-gate',$11,0,0,0,$12)`,
				[lease.campaignId, lease.armId, skip.attemptKey, skip.identity.attemptKind, skip.identity.generation, skip.identity.candidateId, skip.identity.taskId, skip.identity.seed, identitySha256, skip.requestSha256, lease.epoch, skip.reason.slice(0, 512)],
			)
			await this.appendEvent(client, lease.campaignId, lease.armId, lease.epoch, "attempt-skipped-after-hard-gate", { attemptKey: skip.attemptKey, identitySha256, evidenceSha256: skip.requestSha256, reason: skip.reason.slice(0, 512), dispatched: false, spendMicrousd: 0 })
		})
	}

	async markNotSelected(lease: ProofCampaignArmLease, input: { attemptKey: string; generation: number; candidateId: string; taskId: string; seed: string; reason: string }): Promise<void> {
		if (!input.attemptKey.trim() || !input.candidateId.trim() || !input.taskId.trim() || !input.seed.trim() || !input.reason.trim()) throw new Error("not-selected disposition requires complete frozen cell identity and reason")
		validCounter(input.generation, "not-selected generation")
		await transaction(this.pool, async (client) => {
			const campaign = await this.lockLease(client, lease)
			if (lease.phase !== "confirmation" || campaign.arm_phase !== "confirmation") throw new Error("confirmation dispositions require the confirmation phase")
			const manifest = campaign.manifest as ProofCampaignManifest
			const cell = manifest.schedule.find((entry) => entry.armId === lease.armId && (entry.phase ?? "development") === "confirmation" && entry.generation === input.generation && entry.candidateId === input.candidateId && entry.taskId === input.taskId && entry.seed === input.seed && entry.attemptKind === "confirmation")
			if (!cell) throw new Error("not-selected disposition is outside the frozen confirmation schedule")
		const finalSelection = await client.query("SELECT payload FROM headlesscode_rsi_proof_campaign_events WHERE campaign_id=$1 AND arm_id=$2 AND event_type='final-harness-selected' FOR UPDATE", [lease.campaignId, lease.armId])
		if (finalSelection.rowCount !== 1 || (finalSelection.rows[0].payload as { candidateId?: string }).candidateId === input.candidateId) throw new Error("selected or undecided confirmation slot cannot be marked not-selected")
			const identity = { generation: input.generation, candidateId: input.candidateId, taskId: input.taskId, seed: input.seed, attemptKind: "confirmation" as const }
			const identitySha256 = digest({ ...identity, sourceCandidateId: input.candidateId })
			const requestSha256 = digest({ identity, disposition: "not-selected", reason: input.reason })
			const existing = await client.query("SELECT attempt_key,status,identity_sha256,request_sha256 FROM headlesscode_rsi_proof_campaign_attempts WHERE campaign_id=$1 AND arm_id=$2 AND generation=$3 AND candidate_id=$4 AND task_id=$5 AND seed=$6 AND attempt_kind='confirmation' FOR UPDATE", [lease.campaignId, lease.armId, input.generation, input.candidateId, input.taskId, input.seed])
			if (existing.rowCount) {
				const row = existing.rows[0]
				if (row.attempt_key !== input.attemptKey || row.status !== "not-selected" || row.identity_sha256.trim() !== identitySha256 || row.request_sha256.trim() !== requestSha256) throw new Error("not-selected confirmation cell conflicts with prior admission or disposition")
				return
			}
			await client.query(`INSERT INTO headlesscode_rsi_proof_campaign_attempts(campaign_id,arm_id,attempt_key,attempt_kind,generation,candidate_id,source_candidate_id,task_id,seed,identity_sha256,request_sha256,status,epoch,reserved_calls,reserved_tokens,reserved_spend_microusd,error)
				VALUES($1,$2,$3,'confirmation',$4,$5,$5,$6,$7,$8,$9,'not-selected',$10,0,0,0,$11)`, [lease.campaignId, lease.armId, input.attemptKey, input.generation, input.candidateId, input.taskId, input.seed, identitySha256, requestSha256, lease.epoch, input.reason.slice(0, 512)])
			await this.appendEvent(client, lease.campaignId, lease.armId, lease.epoch, "confirmation-not-selected", { attemptKey: input.attemptKey, identitySha256, requestSha256, reason: input.reason.slice(0, 512), spendMicrousd: 0 })
		})
	}

	/** Freeze the one final harness whose result will be compared with root on confirmation tasks. */
	async selectFinalHarness(lease: ProofCampaignArmLease, selection: { generation: number; candidateId: string; commit: string }): Promise<void> {
		if (!Number.isSafeInteger(selection.generation) || selection.generation < 0 || !selection.candidateId.trim() || !/^[a-f0-9]{40}$/.test(selection.commit)) throw new Error("final confirmation harness identity is malformed")
		await transaction(this.pool, async (client) => {
			const campaign = await this.lockLease(client, lease)
			if (lease.phase !== "confirmation" || campaign.arm_phase !== "confirmation") throw new Error("final harness selection requires the confirmation phase")
			const manifest = campaign.manifest as ProofCampaignManifest
			const confirmationCells = manifest.schedule.filter((cell) => cell.armId === lease.armId && (cell.phase ?? "development") === "confirmation")
			const finalGeneration = Math.max(...confirmationCells.map((cell) => cell.generation))
			if (selection.generation > finalGeneration) throw new Error("final harness selection is outside the frozen generation schedule")
			const generationSelections = await client.query("SELECT payload FROM headlesscode_rsi_proof_campaign_events WHERE campaign_id=$1 AND arm_id=$2 AND event_type='generation-selected' ORDER BY (payload->>'generation')::int", [lease.campaignId, lease.armId])
			const selectedGenerations = generationSelections.rows.filter((entry) => Array.isArray((entry.payload as { selectedCandidateIds?: unknown }).selectedCandidateIds) && ((entry.payload as { selectedCandidateIds: string[] }).selectedCandidateIds.length > 0))
			const latestSelected = selectedGenerations.at(-1)
			if (selection.candidateId === "root-control") {
				if (latestSelected || selection.generation !== finalGeneration || selection.commit !== manifest.rootCommit) throw new Error("root may be selected as final harness only when no campaign generation selected an accepted candidate")
			} else {
				const latestGeneration = Number((latestSelected?.payload as { generation?: unknown } | undefined)?.generation)
				const latestSelectedIds = (latestSelected?.payload as { selectedCandidateIds?: unknown } | undefined)?.selectedCandidateIds
				if (!latestSelected || latestGeneration !== selection.generation || !Array.isArray(latestSelectedIds) || !latestSelectedIds.includes(selection.candidateId)) throw new Error("final confirmation harness must come from the latest nonempty durable generation selection")
				const eligible = await client.query(`SELECT 1 FROM headlesscode_rsi_proof_campaign_decisions AS decision
					JOIN headlesscode_rsi_proof_campaign_events AS selected ON selected.campaign_id=decision.campaign_id AND selected.arm_id=decision.arm_id AND selected.event_type='generation-selected'
					AND selected.payload->>'generation'=$4 AND selected.payload->'selectedCandidateIds' ? decision.candidate_id
					WHERE decision.campaign_id=$1 AND decision.arm_id=$2 AND decision.generation=$3 AND decision.candidate_id=$5 AND decision.child_commit=$6 AND decision.decision='accepted'`,
				[lease.campaignId, lease.armId, selection.generation, String(selection.generation), selection.candidateId, selection.commit])
				if (eligible.rowCount !== 1) throw new Error("final confirmation harness must be an accepted candidate selected by its generation")
			}
			const payload = { generation: selection.generation, candidateId: selection.candidateId, commit: selection.commit }
			const existing = await client.query("SELECT payload FROM headlesscode_rsi_proof_campaign_events WHERE campaign_id=$1 AND arm_id=$2 AND event_type='final-harness-selected' FOR UPDATE", [lease.campaignId, lease.armId])
			if (existing.rowCount) {
				if (existing.rowCount !== 1 || stableJson(existing.rows[0].payload) !== stableJson(payload)) throw new Error("final confirmation harness conflicts with an earlier durable selection")
				return
			}
			await this.appendEvent(client, lease.campaignId, lease.armId, lease.epoch, "final-harness-selected", payload)
		})
	}

	async settle(lease: ProofCampaignArmLease, attemptKey: string, settlement: ProofAttemptSettlement): Promise<void> {
		await transaction(this.pool, async (client) => {
			await this.lockLease(client, lease)
			const result = await client.query("SELECT * FROM headlesscode_rsi_proof_campaign_attempts WHERE campaign_id=$1 AND arm_id=$2 AND attempt_key=$3 FOR UPDATE", [lease.campaignId, lease.armId, attemptKey])
			const attempt = result.rows[0]
			if (!attempt) throw new Error("proof campaign attempt settlement is stale or missing")
			if (attempt.status === "completed") {
				const duplicateCalls = settlement.status === "completed" ? settlement.actualCalls ?? 0 : -1
				const duplicateTokens = settlement.status === "completed" ? settlement.actualTokens ?? 0 : -1
				const duplicateSpend = settlement.status === "completed" ? ceilMicros(settlement.actualSpendUsd ?? 0) : -1
				if (settlement.status !== "completed" || attempt.result_sha256.trim() !== settlement.resultSha256 || Number(attempt.actual_calls) !== duplicateCalls || Number(attempt.actual_tokens) !== duplicateTokens || Number(attempt.actual_spend_microusd) !== duplicateSpend || stableJson(attempt.artifact_refs) !== stableJson(settlement.artifactRefs ?? {})) throw new Error("conflicting duplicate proof campaign result")
				return
			}
			if (Number(attempt.epoch) !== lease.epoch) throw new Error("proof campaign attempt settlement is stale or missing")
			if (attempt.status === "failed" && settlement.status === "failed") return
			if (settlement.status === "uncertain") {
				await client.query("UPDATE headlesscode_rsi_proof_campaign_attempts SET status='uncertain',error=$4,updated_at=clock_timestamp() WHERE campaign_id=$1 AND arm_id=$2 AND attempt_key=$3", [lease.campaignId, lease.armId, attemptKey, settlement.error?.slice(0, 512) ?? "result accounting is uncertain"])
				await this.appendEvent(client, lease.campaignId, lease.armId, lease.epoch, "attempt-uncertain", { attemptKey, reason: settlement.error ?? "unmeasured dispatch" })
				return
			}
			if (settlement.status === "failed" && attempt.status !== "admitted") {
				await client.query("UPDATE headlesscode_rsi_proof_campaign_attempts SET status='uncertain',error=$4,updated_at=clock_timestamp() WHERE campaign_id=$1 AND arm_id=$2 AND attempt_key=$3", [lease.campaignId, lease.armId, attemptKey, settlement.error?.slice(0, 512) ?? "dispatched attempt failure has unreconciled spend"])
				await this.appendEvent(client, lease.campaignId, lease.armId, lease.epoch, "attempt-uncertain", { attemptKey, reason: "dispatched attempt failure has unreconciled spend" })
				return
			}
			const actualCalls = settlement.status === "failed" ? 0 : settlement.actualCalls ?? 0
			const actualTokens = settlement.status === "failed" ? 0 : settlement.actualTokens ?? 0
			const actualSpend = ceilMicros(settlement.actualSpendUsd ?? 0)
			if (settlement.status === "completed" && !/^[a-f0-9]{64}$/.test(settlement.resultSha256 ?? "")) throw new Error("completed proof campaign result requires its content digest")
			if (actualCalls > Number(attempt.reserved_calls) || actualTokens > Number(attempt.reserved_tokens) || actualSpend > Number(attempt.reserved_spend_microusd)) throw new Error("proof campaign result exceeds its pre-admitted reservation")
			await client.query(
				`UPDATE headlesscode_rsi_proof_campaigns SET reserved_calls=reserved_calls-$2,reserved_tokens=reserved_tokens-$3,reserved_spend_microusd=reserved_spend_microusd-$4,
				 used_calls=used_calls+$5,used_tokens=used_tokens+$6,used_spend_microusd=used_spend_microusd+$7,updated_at=clock_timestamp() WHERE campaign_id=$1`,
				[lease.campaignId, Number(attempt.reserved_calls), Number(attempt.reserved_tokens), Number(attempt.reserved_spend_microusd), actualCalls, actualTokens, actualSpend],
			)
			await client.query(
				`UPDATE headlesscode_rsi_proof_campaign_attempts SET status=$4,actual_calls=$5,actual_tokens=$6,actual_spend_microusd=$7,result_sha256=$8,artifact_refs=$9::jsonb,error=$10,updated_at=clock_timestamp()
				 WHERE campaign_id=$1 AND arm_id=$2 AND attempt_key=$3`,
				[lease.campaignId, lease.armId, attemptKey, settlement.status, actualCalls, actualTokens, actualSpend, settlement.resultSha256 ?? null, stableJson(settlement.artifactRefs ?? {}), settlement.error?.slice(0, 512) ?? null],
			)
			await this.appendEvent(client, lease.campaignId, lease.armId, lease.epoch, `attempt-${settlement.status}`, { attemptKey, resultSha256: settlement.resultSha256 ?? null, actualCalls, actualTokens, actualSpendMicrousd: actualSpend, artifactRefs: settlement.artifactRefs ?? {} })
		})
	}

	async recordDecision(lease: ProofCampaignArmLease, decision: { generation: number; candidateId: string; parentId: string; status: "accepted" | "rejected" | "failed" | "incomplete"; childCommit: string; parentCommit: string; proof: unknown; attemptKeys: string[] }): Promise<string> {
		const proofSha256 = digest(decision.proof)
		if (!decision.attemptKeys.length || new Set(decision.attemptKeys).size !== decision.attemptKeys.length) throw new Error("proof campaign candidate decision must name unique proof attempts")
		return transaction(this.pool, async (client) => {
			const leaseState = await this.lockLease(client, lease)
			if (lease.phase !== "development" || leaseState.arm_phase !== "development") throw new Error("candidate decisions are closed after the development phase")
			const manifestResult = await client.query("SELECT manifest FROM headlesscode_rsi_proof_campaigns WHERE campaign_id=$1", [lease.campaignId])
			const manifest = manifestResult.rows[0]?.manifest as ProofCampaignManifest | undefined
			if (!manifest || !manifest.schedule.some((cell) => cell.armId === lease.armId && cell.generation === decision.generation && cell.attemptKind === "mutation" && cell.candidateId === decision.candidateId)) throw new Error("candidate decision is outside the frozen campaign schedule")
			let lineageKind: "root" | "root-restart" | "selected-parent" | "selected-ancestor"
			let parentGeneration: number | null = null
			if (decision.generation === 0) {
				if (decision.parentCommit !== manifest.rootCommit) throw new Error("root-generation candidate does not reference the frozen campaign base commit")
				lineageKind = "root"
			} else if (decision.parentId === "baseline" && decision.parentCommit === manifest.rootCommit) {
				const priorSelection = await client.query("SELECT payload FROM headlesscode_rsi_proof_campaign_events WHERE campaign_id=$1 AND arm_id=$2 AND event_type='generation-selected' AND payload->>'generation'=$3 FOR UPDATE", [lease.campaignId, lease.armId, String(decision.generation - 1)])
				const priorAccepted = await client.query("SELECT 1 FROM headlesscode_rsi_proof_campaign_decisions WHERE campaign_id=$1 AND arm_id=$2 AND generation=$3 AND decision='accepted' FOR UPDATE", [lease.campaignId, lease.armId, decision.generation - 1])
				const selected = priorSelection.rows[0]?.payload?.selectedCandidateIds
				if (priorSelection.rowCount !== 1 || !Array.isArray(selected) || selected.length !== 0 || priorAccepted.rowCount !== 0) throw new Error("root restart requires an empty immediately preceding generation with no accepted candidate")
				lineageKind = "root-restart"
			} else {
				const selectedParent = await client.query(
					`SELECT parent.generation,parent.child_commit FROM headlesscode_rsi_proof_campaign_decisions AS parent
					 JOIN headlesscode_rsi_proof_campaign_events AS selection ON selection.campaign_id=parent.campaign_id AND selection.arm_id=parent.arm_id AND selection.event_type='generation-selected'
					 AND (selection.payload->>'generation')::int=parent.generation AND selection.payload->'selectedCandidateIds' ? parent.candidate_id
					 WHERE parent.campaign_id=$1 AND parent.arm_id=$2 AND parent.candidate_id=$3 AND parent.decision='accepted' AND parent.child_commit=$4 AND parent.generation<$5
					 ORDER BY parent.generation DESC LIMIT 1 FOR UPDATE OF parent`,
					[lease.campaignId, lease.armId, decision.parentId, decision.parentCommit, decision.generation],
				)
				if (selectedParent.rowCount !== 1) throw new Error("candidate decision parent is not a previously accepted campaign lineage commit")
				parentGeneration = Number(selectedParent.rows[0]!.generation)
				lineageKind = parentGeneration === decision.generation - 1 ? "selected-parent" : "selected-ancestor"
			}
			const expectedCells = manifest.schedule.filter((cell) => cell.armId === lease.armId && (cell.phase ?? "development") === "development" && cell.generation === decision.generation && (cell.attemptKind === "development-proof" ? cell.candidateId.replace(/:(child|parent|base)$/, "") : cell.candidateId) === decision.candidateId)
			const attempts = await client.query("SELECT attempt_key,status,generation,candidate_id,task_id,seed,attempt_kind FROM headlesscode_rsi_proof_campaign_attempts WHERE campaign_id=$1 AND arm_id=$2 AND attempt_key=ANY($3::text[]) FOR UPDATE", [lease.campaignId, lease.armId, decision.attemptKeys])
			const actualCells = attempts.rows.map((row) => ({ generation: Number(row.generation), candidateId: row.candidate_id, taskId: row.task_id, seed: row.seed, attemptKind: row.attempt_kind }))
			const expectedKeys = expectedCells.map((cell) => stableJson({ generation: cell.generation, candidateId: cell.candidateId, taskId: cell.taskId, seed: cell.seed, attemptKind: cell.attemptKind })).sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))
			const actualKeys = actualCells.map(stableJson).sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))
			if (expectedKeys.length !== actualKeys.length || expectedKeys.some((key, index) => key !== actualKeys[index])) throw new Error(`candidate decision attempt keys must exactly cover its frozen campaign cells (expected=${expectedKeys.join(";")}; actual=${actualKeys.join(";")})`)
			if (attempts.rowCount !== decision.attemptKeys.length || attempts.rows.some((row) => row.status !== "completed" && !(decision.status !== "accepted" && row.status === "skipped-after-hard-gate"))) throw new Error("candidate decision references an incomplete, uncertain, or missing campaign proof attempt")
			const inserted = await client.query(
				`INSERT INTO headlesscode_rsi_proof_campaign_decisions(campaign_id,arm_id,generation,candidate_id,parent_id,lineage_kind,parent_generation,decision,child_commit,parent_commit,proof,proof_sha256,attempt_keys,epoch)
				 VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12,$13::jsonb,$14) ON CONFLICT(campaign_id,arm_id,candidate_id) DO NOTHING RETURNING proof_sha256`,
				[lease.campaignId, lease.armId, decision.generation, decision.candidateId, decision.parentId, lineageKind, parentGeneration, decision.status, decision.childCommit, decision.parentCommit, stableJson(decision.proof), proofSha256, JSON.stringify(decision.attemptKeys), lease.epoch],
			)
			if (inserted.rowCount !== 1) {
				const existing = await client.query("SELECT generation,parent_id,lineage_kind,parent_generation,decision,child_commit,parent_commit,proof,proof_sha256,attempt_keys FROM headlesscode_rsi_proof_campaign_decisions WHERE campaign_id=$1 AND arm_id=$2 AND candidate_id=$3", [lease.campaignId, lease.armId, decision.candidateId])
				const row = existing.rows[0]
				if (!row || Number(row.generation) !== decision.generation || row.parent_id !== decision.parentId || row.lineage_kind !== lineageKind || (row.parent_generation === null ? null : Number(row.parent_generation)) !== parentGeneration || row.decision !== decision.status || row.child_commit !== decision.childCommit || row.parent_commit !== decision.parentCommit || row.proof_sha256.trim() !== proofSha256 || digest(row.proof) !== proofSha256 || stableJson(row.attempt_keys) !== stableJson(decision.attemptKeys)) throw new Error("proof campaign candidate decision conflicts with an earlier import")
			}
			await client.query("UPDATE headlesscode_rsi_proof_campaign_arms SET state='evaluated',updated_at=clock_timestamp() WHERE campaign_id=$1 AND arm_id=$2", [lease.campaignId, lease.armId])
			await client.query("UPDATE headlesscode_rsi_proof_campaigns SET state='evaluated',updated_at=clock_timestamp() WHERE campaign_id=$1 AND state='running'", [lease.campaignId])
			await this.appendEvent(client, lease.campaignId, lease.armId, lease.epoch, "candidate-evaluated", { ...decision, lineageKind, parentGeneration, proofSha256 })
			return proofSha256
		})
	}

	async recordIncompleteCandidate(lease: ProofCampaignArmLease, failure: { generation: number; candidateId: string; parentId: string; parentCommit: string; reason: string }): Promise<void> {
		await transaction(this.pool, async (client) => {
			const leaseState = await this.lockLease(client, lease)
			if (lease.phase !== "development" || leaseState.arm_phase !== "development") throw new Error("candidate failure events are closed after the development phase")
			const manifestResult = await client.query("SELECT manifest FROM headlesscode_rsi_proof_campaigns WHERE campaign_id=$1", [lease.campaignId])
			const manifest = manifestResult.rows[0]?.manifest as ProofCampaignManifest | undefined
			if (!manifest) throw new Error("proof campaign manifest is unavailable for candidate failure")
			const cells = manifest.schedule.filter((cell) => cell.armId === lease.armId && cell.generation === failure.generation && (cell.phase ?? "development") === "development" && (cell.attemptKind === "development-proof" ? cell.candidateId.replace(/:(child|parent|base)$/, "") : cell.candidateId) === failure.candidateId)
			if (!cells.some((cell) => cell.attemptKind === "mutation" && cell.candidateId === failure.candidateId)) throw new Error("candidate failure is outside the frozen campaign schedule")
			if (failure.generation === 0) {
				if (failure.parentId !== "baseline" || failure.parentCommit !== manifest.rootCommit) throw new Error("root-generation candidate failure does not reference the frozen campaign base commit")
			} else if (failure.parentId === "baseline" && failure.parentCommit === manifest.rootCommit) {
				const priorSelection = await client.query("SELECT payload FROM headlesscode_rsi_proof_campaign_events WHERE campaign_id=$1 AND arm_id=$2 AND event_type='generation-selected' AND payload->>'generation'=$3 FOR UPDATE", [lease.campaignId, lease.armId, String(failure.generation - 1)])
				const priorAccepted = await client.query("SELECT 1 FROM headlesscode_rsi_proof_campaign_decisions WHERE campaign_id=$1 AND arm_id=$2 AND generation=$3 AND decision='accepted' FOR UPDATE", [lease.campaignId, lease.armId, failure.generation - 1])
				const selected = priorSelection.rows[0]?.payload?.selectedCandidateIds
				if (priorSelection.rowCount !== 1 || !Array.isArray(selected) || selected.length !== 0 || priorAccepted.rowCount !== 0) throw new Error("root restart failure requires an empty immediately preceding generation with no accepted candidate")
			} else {
				const selectedParent = await client.query(
					`SELECT 1 FROM headlesscode_rsi_proof_campaign_decisions AS parent
					 JOIN headlesscode_rsi_proof_campaign_events AS selection ON selection.campaign_id=parent.campaign_id AND selection.arm_id=parent.arm_id AND selection.event_type='generation-selected'
					 AND (selection.payload->>'generation')::int=parent.generation AND selection.payload->'selectedCandidateIds' ? parent.candidate_id
					 WHERE parent.campaign_id=$1 AND parent.arm_id=$2 AND parent.candidate_id=$3 AND parent.decision='accepted' AND parent.child_commit=$4 AND parent.generation<$5 LIMIT 1 FOR UPDATE OF parent`,
					[lease.campaignId, lease.armId, failure.parentId, failure.parentCommit, failure.generation],
				)
				if (selectedParent.rowCount !== 1) throw new Error("candidate failure parent is not a previously accepted campaign lineage commit")
			}
			const schedule: Array<Record<string, unknown>> = []
			for (const cell of cells) {
				const attempt = await client.query(
					`SELECT attempt_key,status,reserved_calls,reserved_tokens,reserved_spend_microusd,actual_calls,actual_tokens,actual_spend_microusd,error
					 FROM headlesscode_rsi_proof_campaign_attempts WHERE campaign_id=$1 AND arm_id=$2 AND generation=$3 AND candidate_id=$4 AND task_id=$5 AND seed=$6 AND attempt_kind=$7 FOR UPDATE`,
					[lease.campaignId, lease.armId, cell.generation, cell.candidateId, cell.taskId, cell.seed, cell.attemptKind],
				)
				if (attempt.rows.length > 1) throw new Error("candidate failure found duplicate rows for a frozen campaign cell")
				const row = attempt.rows[0]
				schedule.push({
					...cell,
					attemptKey: row ? String(row.attempt_key) : null,
					status: row ? String(row.status) : "missing",
					...(row ? { reservedCalls: Number(row.reserved_calls), reservedTokens: Number(row.reserved_tokens), reservedSpendMicrousd: Number(row.reserved_spend_microusd), actualCalls: row.actual_calls === null ? null : Number(row.actual_calls), actualTokens: row.actual_tokens === null ? null : Number(row.actual_tokens), actualSpendMicrousd: row.actual_spend_microusd === null ? null : Number(row.actual_spend_microusd), ...(row.error ? { attemptError: String(row.error) } : {}) } : {}),
				})
			}
			const payload = { generation: failure.generation, candidateId: failure.candidateId, parentId: failure.parentId, parentCommit: failure.parentCommit, outcome: "incomplete", reason: failure.reason.slice(0, 512), cells: schedule }
			const existing = await client.query("SELECT payload FROM headlesscode_rsi_proof_campaign_events WHERE campaign_id=$1 AND arm_id=$2 AND event_type='candidate-incomplete' FOR UPDATE", [lease.campaignId, lease.armId])
			const matching = existing.rows.filter((row) => row.payload?.candidateId === failure.candidateId && Number(row.payload?.generation) === failure.generation)
			if (matching.length > 1) throw new Error("proof campaign has duplicate candidate-incomplete events")
			if (matching.length === 1) {
				if (stableJson(matching[0]!.payload) !== stableJson(payload)) throw new Error("candidate-incomplete event conflicts with an earlier checkpoint")
				return
			}
			await this.appendEvent(client, lease.campaignId, lease.armId, lease.epoch, "candidate-incomplete", payload)
		})
	}

	async selectGeneration(lease: ProofCampaignArmLease, generation: number, selectedCandidateIds: string[]): Promise<void> {
		await transaction(this.pool, async (client) => {
			const leaseState = await this.lockLease(client, lease)
			if (lease.phase !== "development" || leaseState.arm_phase !== "development") throw new Error("generation selections are closed after the development phase")
			const decisions = await client.query("SELECT candidate_id,decision,attempt_keys FROM headlesscode_rsi_proof_campaign_decisions WHERE campaign_id=$1 AND arm_id=$2 AND generation=$3 FOR UPDATE", [lease.campaignId, lease.armId, generation])
			const byId = new Map(decisions.rows.map((row) => [String(row.candidate_id), row]))
			const manifestResult = await client.query("SELECT manifest FROM headlesscode_rsi_proof_campaigns WHERE campaign_id=$1", [lease.campaignId])
			const manifest = manifestResult.rows[0]?.manifest as ProofCampaignManifest | undefined
			if (!manifest) throw new Error("proof campaign manifest is unavailable for generation selection")
			const scheduled = manifest.schedule.filter((cell) => cell.armId === lease.armId && (cell.phase ?? "development") === "development" && cell.generation === generation)
			if (!scheduled.length) throw new Error("generation is absent from the frozen proof campaign schedule")
			const candidateIds = [...new Set(scheduled.filter((cell) => cell.attemptKind === "mutation").map((cell) => cell.candidateId))].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))
			if (!candidateIds.length) throw new Error("generation schedule has no candidate mutation cells")
			if (byId.size !== candidateIds.length || candidateIds.some((candidateId) => !byId.has(candidateId))) throw new Error("generation selection is incomplete: every scheduled candidate needs a durable decision")
			for (const cell of scheduled) {
				const attempt = await client.query("SELECT status FROM headlesscode_rsi_proof_campaign_attempts WHERE campaign_id=$1 AND arm_id=$2 AND generation=$3 AND candidate_id=$4 AND task_id=$5 AND seed=$6 AND attempt_kind=$7", [lease.campaignId, lease.armId, cell.generation, cell.candidateId, cell.taskId, cell.seed, cell.attemptKind])
				const status = String(attempt.rows[0]?.status ?? "missing")
				const ownerCandidateId = cell.attemptKind === "development-proof" ? cell.candidateId.replace(/:(child|parent|base)$/, "") : cell.candidateId
				const decision = byId.get(ownerCandidateId)
				if (attempt.rowCount !== 1 || (status !== "completed" && !(status === "skipped-after-hard-gate" && decision?.decision !== "accepted"))) throw new Error("generation selection is incomplete: a scheduled task cell is missing, uncertain, or skipped for an accepted candidate")
			}
			const canonicalSelectedIds = [...selectedCandidateIds].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))
			if (new Set(canonicalSelectedIds).size !== canonicalSelectedIds.length) throw new Error("campaign selection contains duplicate candidate IDs")
			for (const candidateId of canonicalSelectedIds) {
				const decision = byId.get(candidateId)
				if (!decision || decision.decision !== "accepted") throw new Error("campaign selection references a candidate without an accepted durable proof decision")
				const attempts = await client.query("SELECT status FROM headlesscode_rsi_proof_campaign_attempts WHERE campaign_id=$1 AND arm_id=$2 AND attempt_key=ANY($3::text[])", [lease.campaignId, lease.armId, decision.attempt_keys])
				if (attempts.rowCount !== decision.attempt_keys.length || attempts.rows.some((row) => row.status !== "completed")) throw new Error("campaign selection references incomplete proof attempt evidence")
			}
			const payload = { generation, selectedCandidateIds: canonicalSelectedIds }
			const priorSelection = await client.query("SELECT payload FROM headlesscode_rsi_proof_campaign_events WHERE campaign_id=$1 AND arm_id=$2 AND event_type='generation-selected' AND payload->>'generation'=$3 FOR UPDATE", [lease.campaignId, lease.armId, String(generation)])
			if (priorSelection.rowCount) {
				if (priorSelection.rowCount !== 1 || stableJson(priorSelection.rows[0].payload) !== stableJson(payload)) throw new Error("generation selection conflicts with an earlier durable selection")
				return
			}
			await this.appendEvent(client, lease.campaignId, lease.armId, lease.epoch, "generation-selected", payload)
			const state: ProofCampaignState = selectedCandidateIds.length ? "selected" : "rejected"
			await client.query("UPDATE headlesscode_rsi_proof_campaign_arms SET state=$3,updated_at=clock_timestamp() WHERE campaign_id=$1 AND arm_id=$2", [lease.campaignId, lease.armId, state])
			await client.query("UPDATE headlesscode_rsi_proof_campaigns SET state=$2,updated_at=clock_timestamp() WHERE campaign_id=$1 AND state IN ('running','evaluated','selected','rejected')", [lease.campaignId, state])
		})
	}

	async finishArm(lease: ProofCampaignArmLease, selectedCandidateIds: string[]): Promise<void> {
		await transaction(this.pool, async (client) => {
			const campaign = await this.lockLease(client, lease)
			const manifest = campaign.manifest as ProofCampaignManifest
			const scheduled = manifest.schedule.filter((cell) => cell.armId === lease.armId)
			if (!scheduled.length) throw new Error("cannot finish an arm with no frozen task schedule")
			if (scheduled.some((cell) => (cell.phase ?? "development") === "confirmation") && (lease.phase !== "confirmation" || campaign.arm_phase !== "confirmation")) throw new Error("proof campaign arm cannot finish before both arms complete development")
			for (const generation of [...new Set(scheduled.map((cell) => cell.generation))]) {
				const selection = await client.query("SELECT payload FROM headlesscode_rsi_proof_campaign_events WHERE campaign_id=$1 AND arm_id=$2 AND event_type='generation-selected' AND payload->>'generation'=$3 FOR UPDATE", [lease.campaignId, lease.armId, String(generation)])
				if (selection.rowCount !== 1) throw new Error(`cannot finish proof campaign arm: generation ${generation} has no canonical selection`)
			}
			for (const cell of scheduled) {
				const result = await client.query("SELECT status FROM headlesscode_rsi_proof_campaign_attempts WHERE campaign_id=$1 AND arm_id=$2 AND generation=$3 AND candidate_id=$4 AND task_id=$5 AND seed=$6 AND attempt_kind=$7", [lease.campaignId, lease.armId, cell.generation, cell.candidateId, cell.taskId, cell.seed, cell.attemptKind])
				const phase = cell.phase ?? "development"
				const status = String(result.rows[0]?.status ?? "missing")
				const terminal = status === "completed" || (phase === "development" && status === "skipped-after-hard-gate") || (phase === "confirmation" && status === "not-selected")
				if (result.rowCount !== 1 || !terminal) throw new Error("cannot finish proof campaign arm with a missing, incomplete, or uncertain frozen task cell")
			}
			const confirmation = scheduled.filter((cell) => (cell.phase ?? "development") === "confirmation")
			if (confirmation.length) {
				const selectedEvent = await client.query("SELECT payload FROM headlesscode_rsi_proof_campaign_events WHERE campaign_id=$1 AND arm_id=$2 AND event_type='final-harness-selected'", [lease.campaignId, lease.armId])
				if (selectedEvent.rowCount !== 1) throw new Error("cannot finish proof campaign without final-harness selection")
				const selected = selectedEvent.rows[0].payload as { candidateId: string; generation: number; commit: string }
				const recordedSelection = [...selectedCandidateIds].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))
				if (stableJson(recordedSelection) !== stableJson([selected.candidateId])) throw new Error("final arm selection does not match its frozen campaign selection")
				for (const cell of confirmation) {
					const attempt = await client.query("SELECT status FROM headlesscode_rsi_proof_campaign_attempts WHERE campaign_id=$1 AND arm_id=$2 AND generation=$3 AND candidate_id=$4 AND task_id=$5 AND seed=$6 AND attempt_kind=$7", [lease.campaignId, lease.armId, cell.generation, cell.candidateId, cell.taskId, cell.seed, cell.attemptKind])
					const required = cell.candidateId === "root-control" || (cell.candidateId === selected.candidateId && cell.generation === selected.generation)
					const expectedStatus = required ? "completed" : "not-selected"
					if (attempt.rowCount !== 1 || attempt.rows[0].status !== expectedStatus) throw new Error(`final confirmation cell ${cell.candidateId}/${cell.taskId} must be ${expectedStatus}`)
				}
			}
			const pending = await client.query("SELECT count(*)::int AS count FROM headlesscode_rsi_proof_campaign_attempts WHERE campaign_id=$1 AND arm_id=$2 AND status NOT IN ('completed','failed','skipped-after-hard-gate','not-selected')", [lease.campaignId, lease.armId])
			if (Number(pending.rows[0]?.count ?? 0) !== 0) throw new Error("cannot finish proof campaign arm with incomplete or uncertain attempts")
			const state: ProofCampaignState = selectedCandidateIds.length ? "selected" : "rejected"
			await client.query("UPDATE headlesscode_rsi_proof_campaign_arms SET state='finished',coordinator_id=NULL,lease_token_sha256=NULL,lease_expires_at=NULL,updated_at=clock_timestamp() WHERE campaign_id=$1 AND arm_id=$2 AND epoch=$3", [lease.campaignId, lease.armId, lease.epoch])
			await this.appendEvent(client, lease.campaignId, lease.armId, lease.epoch, "arm-finished", { outcome: state, selectedCandidateIds })
			const arms = await client.query("SELECT count(*)::int AS total,count(*) FILTER (WHERE state='finished')::int AS finished FROM headlesscode_rsi_proof_campaign_arms WHERE campaign_id=$1", [lease.campaignId])
			const campaignState = Number(arms.rows[0]?.total) === 2 && Number(arms.rows[0]?.finished) === 2 ? "finished" : state
			await client.query("UPDATE headlesscode_rsi_proof_campaigns SET state=$2,updated_at=clock_timestamp() WHERE campaign_id=$1", [lease.campaignId, campaignState])
		})
	}

	async finishDevelopmentArm(lease: ProofCampaignArmLease): Promise<void> {
		await transaction(this.pool, async (client) => {
			const stateResult = await client.query(`SELECT campaign.manifest, campaign.manifest_sha256, arm.phase AS arm_phase, arm.epoch AS arm_epoch, arm.state AS arm_state, arm.run_id
				FROM headlesscode_rsi_proof_campaigns campaign JOIN headlesscode_rsi_proof_campaign_arms arm USING(campaign_id)
				WHERE campaign.campaign_id=$1 AND arm.arm_id=$2 FOR UPDATE OF campaign,arm`, [lease.campaignId, lease.armId])
			const state = stateResult.rows[0]
			if (!state || state.manifest_sha256.trim() !== lease.manifestSha256 || state.run_id !== lease.runId) throw new Error("proof campaign development completion has a stale campaign or arm identity")
			const priorFinish = await client.query("SELECT 1 FROM headlesscode_rsi_proof_campaign_events WHERE campaign_id=$1 AND arm_id=$2 AND epoch=$3 AND event_type='development-phase-finished' AND payload->>'remainingPhase'='confirmation'", [lease.campaignId, lease.armId, lease.epoch])
			if (state.arm_phase === "confirmation" && lease.phase === "development" && priorFinish.rowCount === 1) return
			const priorEngineeringFinish = await client.query("SELECT 1 FROM headlesscode_rsi_proof_campaign_events WHERE campaign_id=$1 AND arm_id=$2 AND event_type='engineering-development-finished'", [lease.campaignId, lease.armId])
			if (state.arm_state === "finished" && lease.phase === "development" && priorEngineeringFinish.rowCount === 1) return
			const campaign = await this.lockLease(client, lease)
			if (lease.phase === "confirmation" && campaign.arm_phase === "confirmation") {
				const finished = await client.query("SELECT 1 FROM headlesscode_rsi_proof_campaign_events WHERE campaign_id=$1 AND arm_id=$2 AND event_type='development-phase-finished' AND payload->>'remainingPhase'='confirmation' LIMIT 1", [lease.campaignId, lease.armId])
				if (finished.rowCount === 1) return
				throw new Error("proof campaign confirmation phase has no durable development completion event")
			}
			if (lease.phase !== "development" || campaign.arm_phase !== "development") throw new Error("proof campaign development phase is already closed")
			const manifest = campaign.manifest as ProofCampaignManifest
			const development = manifest.schedule.filter((cell) => cell.armId === lease.armId && (cell.phase ?? "development") === "development")
			if (!development.length) throw new Error("cannot finish development phase without frozen development cells")
			for (const generation of [...new Set(development.map((cell) => cell.generation))]) {
				const selection = await client.query("SELECT 1 FROM headlesscode_rsi_proof_campaign_events WHERE campaign_id=$1 AND arm_id=$2 AND event_type='generation-selected' AND payload->>'generation'=$3", [lease.campaignId, lease.armId, String(generation)])
				if (selection.rowCount !== 1) throw new Error(`cannot finish development phase: generation ${generation} has no canonical selection`)
			}
			for (const cell of development) {
				const result = await client.query("SELECT status FROM headlesscode_rsi_proof_campaign_attempts WHERE campaign_id=$1 AND arm_id=$2 AND generation=$3 AND candidate_id=$4 AND task_id=$5 AND seed=$6 AND attempt_kind=$7", [lease.campaignId, lease.armId, cell.generation, cell.candidateId, cell.taskId, cell.seed, cell.attemptKind])
				if (result.rowCount !== 1 || !["completed", "skipped-after-hard-gate"].includes(String(result.rows[0].status))) throw new Error("cannot finish development phase with incomplete or uncertain development evidence")
			}
			if (manifest.phaseMode === "engineering-only") {
				const prior = await client.query("SELECT 1 FROM headlesscode_rsi_proof_campaign_events WHERE campaign_id=$1 AND arm_id=$2 AND event_type='engineering-development-finished'", [lease.campaignId, lease.armId])
				if (prior.rowCount) return
				await client.query("UPDATE headlesscode_rsi_proof_campaign_arms SET state='finished',coordinator_id=NULL,lease_token_sha256=NULL,lease_expires_at=NULL,updated_at=clock_timestamp() WHERE campaign_id=$1 AND arm_id=$2 AND epoch=$3", [lease.campaignId, lease.armId, lease.epoch])
				await this.appendEvent(client, lease.campaignId, lease.armId, lease.epoch, "engineering-development-finished", { confirmationFrozen: false })
				const arms = await client.query("SELECT count(*)::int AS total,count(*) FILTER (WHERE state='finished')::int AS finished FROM headlesscode_rsi_proof_campaign_arms WHERE campaign_id=$1", [lease.campaignId])
				if (Number(arms.rows[0]?.total) === 2 && Number(arms.rows[0]?.finished) === 2) await client.query("UPDATE headlesscode_rsi_proof_campaigns SET state='finished',updated_at=clock_timestamp() WHERE campaign_id=$1", [lease.campaignId])
			} else {
				await client.query("UPDATE headlesscode_rsi_proof_campaign_arms SET state='evaluated',phase='confirmation',coordinator_id=NULL,lease_token_sha256=NULL,lease_expires_at=NULL,updated_at=clock_timestamp() WHERE campaign_id=$1 AND arm_id=$2 AND epoch=$3", [lease.campaignId, lease.armId, lease.epoch])
				await this.appendEvent(client, lease.campaignId, lease.armId, lease.epoch, "development-phase-finished", { remainingPhase: "confirmation" })
				await client.query("UPDATE headlesscode_rsi_proof_campaigns SET state='evaluated',updated_at=clock_timestamp() WHERE campaign_id=$1 AND state <> 'finished'", [lease.campaignId])
			}
		})
	}

	async snapshotIfExists(campaignId: string): Promise<Record<string, unknown> | undefined> {
		const result = await this.pool.query("SELECT 1 FROM headlesscode_rsi_proof_campaigns WHERE campaign_id=$1", [campaignId])
		return result.rowCount === 1 ? this.snapshot(campaignId) : undefined
	}

	async snapshot(campaignId: string): Promise<Record<string, unknown>> {
		const client = await this.pool.connect()
		try {
			await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY")
			const campaign = await client.query("SELECT * FROM headlesscode_rsi_proof_campaigns WHERE campaign_id=$1", [campaignId])
			if (campaign.rowCount !== 1) throw new Error(`proof campaign ${campaignId} does not exist`)
			const arms = await client.query("SELECT arm_id,run_id,epoch,state,phase,lease_expires_at FROM headlesscode_rsi_proof_campaign_arms WHERE campaign_id=$1 ORDER BY arm_id", [campaignId])
			const attempts = await client.query("SELECT arm_id,attempt_key,attempt_kind,generation,candidate_id,source_candidate_id,task_id,seed,status,identity_sha256,request_sha256,epoch,job_id,reserved_calls,reserved_tokens,reserved_spend_microusd,actual_calls,actual_tokens,actual_spend_microusd,result_sha256,artifact_refs,error FROM headlesscode_rsi_proof_campaign_attempts WHERE campaign_id=$1 ORDER BY arm_id,attempt_key", [campaignId])
			const decisions = await client.query("SELECT arm_id,generation,candidate_id,parent_id,lineage_kind,parent_generation,decision,child_commit,parent_commit,proof,proof_sha256,attempt_keys,epoch FROM headlesscode_rsi_proof_campaign_decisions WHERE campaign_id=$1 ORDER BY arm_id,generation,candidate_id", [campaignId])
			const events = await client.query("SELECT sequence,arm_id,epoch,event_type,payload,payload_sha256,created_at FROM headlesscode_rsi_proof_campaign_events WHERE campaign_id=$1 ORDER BY sequence", [campaignId])
			const row = campaign.rows[0]!
			if (row.schema_version !== 1 || row.manifest.campaignId !== campaignId || digest(row.manifest) !== row.manifest_sha256.trim()) throw new Error("proof campaign manifest bytes do not match the frozen digest")
			if (events.rows.length !== Number(row.sequence) || events.rows.some((event, index) => Number(event.sequence) !== index + 1 || digest(event.payload) !== String(event.payload_sha256).trim())) throw new Error("proof campaign event sequence or payload digest is corrupt")
			for (const attempt of attempts.rows) {
				const identity = { generation: Number(attempt.generation), candidateId: attempt.candidate_id, taskId: attempt.task_id, seed: attempt.seed, attemptKind: attempt.attempt_kind, sourceCandidateId: attempt.source_candidate_id }
				if (digest(identity) !== String(attempt.identity_sha256).trim()) throw new Error(`proof campaign logical attempt identity is corrupt: ${attempt.attempt_key}`)
				if (attempt.artifact_refs && Object.values(attempt.artifact_refs as Record<string, unknown>).some((reference) => !reference || typeof reference !== "object" || !/^[a-f0-9]{64}$/.test(String((reference as Record<string, unknown>).sha256 ?? "")))) throw new Error(`proof campaign attempt artifact reference is malformed: ${attempt.attempt_key}`)
			}
			for (const decision of decisions.rows) if (digest(decision.proof) !== String(decision.proof_sha256).trim()) throw new Error(`proof campaign decision evidence digest is corrupt: ${decision.candidate_id}`)
			await client.query("COMMIT")
			return { campaign: row, arms: arms.rows, attempts: attempts.rows, decisions: decisions.rows, events: events.rows }
		} catch (error) {
			await client.query("ROLLBACK").catch(() => undefined)
			throw error
		} finally {
			client.release()
		}
	}

	private async lockLease(client: PoolClient, lease: ProofCampaignArmLease): Promise<Record<string, unknown>> {
		const tokenHash = createHash("sha256").update(lease.token).digest("hex")
		const result = await client.query(
			`SELECT campaign.*,arm.epoch AS arm_epoch,arm.phase AS arm_phase,arm.run_id,arm.lease_token_sha256,arm.lease_expires_at,
			 arm.lease_expires_at > clock_timestamp() AS arm_lease_valid,campaign.deadline_at > clock_timestamp() AS deadline_valid
			 FROM headlesscode_rsi_proof_campaigns AS campaign JOIN headlesscode_rsi_proof_campaign_arms AS arm USING(campaign_id)
			 WHERE campaign.campaign_id=$1 AND arm.arm_id=$2 FOR UPDATE OF campaign,arm`,
			[lease.campaignId, lease.armId],
		)
		const row = result.rows[0]
		if (!row || Number(row.arm_epoch) !== lease.epoch || row.run_id !== lease.runId || row.arm_phase !== lease.phase || row.lease_token_sha256?.trim() !== tokenHash || row.manifest_sha256.trim() !== lease.manifestSha256 || row.arm_lease_valid !== true || row.deadline_valid !== true || row.state === "finished") throw new Error("proof campaign write rejected by stale coordinator epoch, phase, lease, manifest, or root deadline")
		return row
	}

	private async appendEvent(client: PoolClient, campaignId: string, armId: string | null, epoch: number | null, type: string, payload: unknown): Promise<void> {
		const encoded = stableJson(payload)
		const sequenceResult = await client.query("UPDATE headlesscode_rsi_proof_campaigns SET sequence=sequence+1,updated_at=clock_timestamp() WHERE campaign_id=$1 RETURNING sequence", [campaignId])
		const sequence = Number(sequenceResult.rows[0]?.sequence)
		if (!Number.isSafeInteger(sequence) || sequence < 1) throw new Error("proof campaign event sequence failed to advance")
		await client.query("INSERT INTO headlesscode_rsi_proof_campaign_events(campaign_id,sequence,arm_id,epoch,event_type,payload,payload_sha256) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7)", [campaignId, sequence, armId, epoch, type, encoded, createHash("sha256").update(encoded).digest("hex")])
	}
}
