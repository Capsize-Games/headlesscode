import type { ClaimedRepositoryJob,
	RepositoryCampaignDefinition } from "./repository-campaigns.js"
import { createRepositoryBudgetAuthorityReader } from
	"./repository-budget-authority.js"
import {
	MODEL, PROFILE_ID, CURL_CAMPAIGN_POLICY_SHA256, MAX_LIFETIME_MICROS,
	MAX_LIFETIME_TOKENS, MAX_JOB_MICROS, MAX_JOB_TOKENS,
} from "./repository-curl-profile.js"
import { CURL_PRIVATE_SOURCE_REVISION } from "./repository-curl-evaluator.js"

type RepositoryAuthoritySnapshot = Awaited<ReturnType<ReturnType<typeof
	createRepositoryBudgetAuthorityReader>>>

export function isFreshLiveAuthority(value: RepositoryAuthoritySnapshot,
	definition: RepositoryCampaignDefinition): boolean {
	return hasLiveRunAuthority(value) && hasFreshAuthorityTime(value) &&
		matchesRepositoryAuthority(value,
			definition) && hasAuthorizedBudgetLimits(value)
}

function hasLiveRunAuthority(value: RepositoryAuthoritySnapshot): boolean {
	return value.mode === "fleet-v2" && value.available === true &&
		value.canAdmit === true &&
		value.globalEnabled === true && value.campaignId === "fleet-security-watch" &&
		value.repositoryEnabled === true && hasCurrentRunIdentity(value) &&
			hasPositiveEpochs(value)
}

function hasCurrentRunIdentity(value: RepositoryAuthoritySnapshot): boolean {
	return value.runId !== null && typeof value.runId === "string" &&
		Number.isSafeInteger(value.controlEpoch)
}

function hasPositiveEpochs(value: RepositoryAuthoritySnapshot): boolean {
	return Number.isSafeInteger(value.repositoryEpoch) &&
		value.repositoryEpoch! > 0
}

function hasFreshAuthorityTime(value: RepositoryAuthoritySnapshot): boolean {
	if (typeof value.asOfMs !== "number") return false
	const ageMs = Date.now() - value.asOfMs
	return ageMs >= 0 && ageMs <= 30_000
}

function matchesRepositoryAuthority(value: RepositoryAuthoritySnapshot,
	definition: RepositoryCampaignDefinition): boolean {
	return value.repositoryCampaignId === definition.id &&
		value.repositoryId === definition.repositoryId &&
		value.repository === definition.repository &&
			value.sourceRevision === CURL_PRIVATE_SOURCE_REVISION &&
		value.policySha256 === CURL_CAMPAIGN_POLICY_SHA256 && value.model === MODEL &&
		value.profileId === PROFILE_ID
}

function hasAuthorizedBudgetLimits(value: RepositoryAuthoritySnapshot):
	boolean {
	const repositoryLimits = value.repositoryLifetime
	return value.monthly?.limitMicros !== undefined &&
		value.campaignLifetime?.limitMicros === MAX_LIFETIME_MICROS &&
		value.campaignLifetime.limitTokens === MAX_LIFETIME_TOKENS &&
		repositoryLimits !== undefined &&
			Number.isSafeInteger(repositoryLimits.limitMicros) &&
		repositoryLimits.limitMicros >= MAX_JOB_MICROS &&
			repositoryLimits.limitMicros <= MAX_LIFETIME_MICROS &&
		Number.isSafeInteger(repositoryLimits.limitTokens) &&
			repositoryLimits.limitTokens >= MAX_JOB_TOKENS &&
		repositoryLimits.limitTokens <= MAX_LIFETIME_TOKENS
}

export function buildLimits(claim: ClaimedRepositoryJob): { campaignId:
	string; maxCalls: number; maxInputTokensPerCall: number;
		maxOutputTokensPerCall: number; maxTotalTokens: number; maxDurationMs:
			number; maxRequestBytes: number; maxResponseBytes: number;
				maxInputPricePerMillionUsd: number; maxOutputPricePerMillionUsd: number;
					maxCallSpendUsd: number; maxJobSpendUsd: number; maxCampaignSpendUsd:
						number } {
	const { micros, tokens } = assertReservation(claim)
	return { campaignId: "fleet-security-watch", maxCalls: 2,
		maxInputTokensPerCall: 32_000, maxOutputTokensPerCall: 4_000,
			maxTotalTokens: tokens,
		maxDurationMs: 300_000, maxRequestBytes: 32_768, maxResponseBytes: 65_536,
		maxInputPricePerMillionUsd: 0.1, maxOutputPricePerMillionUsd: 0.2,
		maxCallSpendUsd: 0.004, maxJobSpendUsd: micros / 1_000_000,
		maxCampaignSpendUsd: 0.02 }
}


function assertReservation(claim: ClaimedRepositoryJob): { micros: number;
	tokens: number } {
	const micros = claim.job.reservedMicros
	const tokens = claim.job.reservedTokens
	if (micros !== MAX_JOB_MICROS || tokens !== MAX_JOB_TOKENS ||
		!Number.isSafeInteger(micros) || !Number.isSafeInteger(tokens)) {
		throw new
			Error("Curl job reservation is outside the fixed Fleet worker ceiling")
	}
	return { micros, tokens }
}
