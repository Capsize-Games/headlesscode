import type {
	OpenRouterBrokerGrant, OpenRouterBrokerReceipt, OpenRouterCallReservation,
	OpenRouterCallSettlement, OpenRouterDenialReason, OpenRouterInferenceLedger,
} from "../rsi/inference-broker.js"

import { REPOSITORY_CAMPAIGN_BUDGET_CAP_TOKENS,
	type ClaimedRepositoryJob, type RepositoryCampaignStore } from "./repository-campaigns.js"

export const FLEET_REPOSITORY_CAMPAIGN_ID = "fleet-security-watch"
export const FLEET_BRIDGE_CAMPAIGN_LIFETIME_CAP_MICROS = 20_000

/**
 * Binds one already-persisted repository job claim to the existing Fleet
 * inference ledger. The repository claim reserves the lifetime subcap before
 * this adapter registers a bounded broker job; Fleet remains authoritative for
 * each global spend reservation. This adapter never creates a second allowance.
 */
export class RepositoryCampaignBudgetBinding implements OpenRouterInferenceLedger {
	readonly requiresHostApiKeyIdentity: boolean
	constructor(private readonly store: RepositoryCampaignStore, private readonly claim: ClaimedRepositoryJob,
		private readonly fleet: OpenRouterInferenceLedger) {
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

	requestStartGate(start: () => Promise<Response>): Promise<Response> {
		return this.store.withClaimRequestStart(this.claim, start)
	}

	/** Finish the persisted subcap only from a qualified, settled Fleet receipt. */
	async finishFromReceipt(grant: OpenRouterBrokerGrant, now = new Date()): Promise<void> {
		this.validateGrant(grant)
		const receipt = await this.fleet.receipt(grant)
		if (!receipt.qualified || receipt.calls < 1 || receipt.costUsd === null || receipt.totalTokens === null) {
			await this.store.finish(this.claim, { status: "ambiguous" }, now)
			return
		}
		const actualMicros = Math.ceil(receipt.costUsd * 1_000_000)
		if (actualMicros > this.claim.job.reservedMicros || receipt.totalTokens > this.claim.job.reservedTokens) {
			await this.store.finish(this.claim, { status: "ambiguous" }, now)
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
