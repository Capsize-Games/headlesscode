import type {
	OpenRouterBrokerGrant, OpenRouterBrokerReceipt, OpenRouterCallReservation,
	OpenRouterCallSettlement, OpenRouterDenialReason, OpenRouterInferenceLedger,
} from "../rsi/inference-broker.js"
import { FleetRepositoryBudgetLedger, type FleetRepositoryBudgetScope, type FleetRepositoryBudgetSnapshot, type FleetRepositoryReconciliation } from "../rsi/fleet-repository-budget-ledger.js"

import { REPOSITORY_CAMPAIGN_BUDGET_CAP_TOKENS,
	type ClaimedRepositoryJob, type RepositoryCampaignStore } from "./repository-campaigns.js"

export const FLEET_REPOSITORY_CAMPAIGN_ID = "fleet-security-watch"
export const FLEET_BRIDGE_CAMPAIGN_LIFETIME_CAP_MICROS = 20_000

export type RepositoryBudgetLedger = OpenRouterInferenceLedger & {
	requestStart(grant: OpenRouterBrokerGrant, reservation: OpenRouterCallReservation): Promise<void>
	reconcile(grant: OpenRouterBrokerGrant, callId?: string): Promise<FleetRepositoryReconciliation>
	budgetSnapshot(): Promise<FleetRepositoryBudgetSnapshot>
}

export function createRepositoryCampaignBudgetBinding(options: {
	store: RepositoryCampaignStore
	claim: ClaimedRepositoryJob
	scope: FleetRepositoryBudgetScope
	expectedKeyIdentity: string
	python?: string
	timeoutMs?: number
	invoke?: (message: Record<string, unknown>) => Promise<Record<string, unknown>>
	assertDispatchFence?: () => Promise<void>
}): RepositoryCampaignBudgetBinding {
	const fleet = new FleetRepositoryBudgetLedger({
		expectedKeyIdentity: options.expectedKeyIdentity, scope: options.scope,
		...(options.python !== undefined ? { python: options.python } : {}),
		...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
		...(options.invoke ? { invoke: options.invoke } : {}),
		...(options.assertDispatchFence ? { assertDispatchFence: options.assertDispatchFence } : {}),
	})
	return new RepositoryCampaignBudgetBinding(options.store, options.claim, fleet)
}

/**
 * Binds one already-persisted repository job claim to the existing Fleet
 * inference ledger. The repository claim reserves the lifetime subcap before
 * this adapter registers a bounded broker job; Fleet remains authoritative for
 * each global spend reservation. This adapter never creates a second allowance.
 */
export class RepositoryCampaignBudgetBinding implements OpenRouterInferenceLedger {
	readonly requiresHostApiKeyIdentity: boolean
	constructor(private readonly store: RepositoryCampaignStore, private readonly claim: ClaimedRepositoryJob,
		private readonly fleet: RepositoryBudgetLedger) {
		this.requiresHostApiKeyIdentity = (fleet as OpenRouterInferenceLedger & { requiresHostApiKeyIdentity?: boolean }).requiresHostApiKeyIdentity === true
	}

	async register(grant: OpenRouterBrokerGrant): Promise<number> {
		this.validateGrant(grant)
		await this.store.assertClaimCurrent(this.claim)
		return await this.fleet.register(grant)
	}

	async recordDenial(grant: OpenRouterBrokerGrant, statusCode: number, reason: OpenRouterDenialReason): Promise<void> {
		this.validateGrant(grant)
		await this.fleet.recordDenial(grant, statusCode, reason)
	}

	async reserve(grant: OpenRouterBrokerGrant, reservation: OpenRouterCallReservation): Promise<void> {
		this.validateGrant(grant)
		if (Math.ceil(reservation.reservedUsd * 1_000_000) > this.claim.job.reservedMicros ||
			reservation.reservedTokens > this.claim.job.reservedTokens) throw new Error("call reservation exceeds the durable repository job allocation")
		await this.store.assertClaimCurrent(this.claim)
		await this.fleet.reserve(grant, reservation)
	}

	async settle(grant: OpenRouterBrokerGrant, settlement: OpenRouterCallSettlement & { callId: string }): Promise<void> {
		this.validateGrant(grant)
		await this.fleet.settle(grant, settlement)
	}

	async receipt(grant: OpenRouterBrokerGrant): Promise<OpenRouterBrokerReceipt> {
		this.validateGrant(grant)
		return await this.fleet.receipt(grant)
	}

	/** Return the exact fresh shared-budget view used to qualify this adapter. */
	async budgetSnapshot(): Promise<FleetRepositoryBudgetSnapshot> {
		return await this.fleet.budgetSnapshot()
	}

	requestStartGate(start: () => Promise<Response>, context: { grant: OpenRouterBrokerGrant; reservation: OpenRouterCallReservation }): Promise<Response> {
		this.validateGrant(context.grant)
		return this.store.withClaimRequestStart(this.claim, start, async () => {
			await this.fleet.requestStart(context.grant, context.reservation)
		})
	}

	/** Reconcile one persisted broker job before a worker is resumed. */
	async reconcile(grant: OpenRouterBrokerGrant, callId?: string, now = new Date()): Promise<FleetRepositoryReconciliation> {
		this.validateGrant(grant)
		const result = await this.fleet.reconcile(grant, callId)
		await this.finishFromReceipt(grant, now)
		return result
	}

	/** Finish the persisted subcap only from a qualified, settled Fleet receipt. */
	async finishFromReceipt(grant: OpenRouterBrokerGrant, now = new Date()): Promise<void> {
		this.validateGrant(grant)
		const receipt = await this.fleet.receipt(grant)
		const status = await this.store.status(now) as { jobs?: Array<{ id: string; status: string }> }
		const current = status.jobs?.find((job) => job.id === this.claim.job.id)
		if (!receipt.qualified || receipt.calls < 1 || receipt.costUsd === null || receipt.totalTokens === null) {
			if (current?.status === "ambiguous") return
			await this.store.finish(this.claim, { status: "ambiguous" }, now)
			return
		}
		const actualMicros = Math.ceil(receipt.costUsd * 1_000_000)
		if (actualMicros > this.claim.job.reservedMicros || receipt.totalTokens > this.claim.job.reservedTokens) {
			if (current?.status === "ambiguous") return
			await this.store.finish(this.claim, { status: "ambiguous" }, now)
			return
		}
		if (current?.status === "ambiguous") {
			await this.store.settleRecoveredClaim(this.claim, { status: "succeeded", actualMicros, actualTokens: receipt.totalTokens }, now)
			return
		}
		await this.store.finish(this.claim, { status: "succeeded", actualMicros, actualTokens: receipt.totalTokens }, now)
	}

	private validateGrant(grant: OpenRouterBrokerGrant): void {
		if (!grant || grant.jobId !== this.claim.job.id || grant.limits.campaignId !== FLEET_REPOSITORY_CAMPAIGN_ID ||
			grant.limits.maxJobSpendUsd * 1_000_000 > this.claim.job.reservedMicros ||
			grant.limits.maxTotalTokens > this.claim.job.reservedTokens ||
			grant.limits.maxCampaignSpendUsd * 1_000_000 > FLEET_BRIDGE_CAMPAIGN_LIFETIME_CAP_MICROS ||
			grant.limits.maxTotalTokens > REPOSITORY_CAMPAIGN_BUDGET_CAP_TOKENS) {
			throw new Error("Fleet grant is outside the claimed repository allocation")
		}
	}
}
