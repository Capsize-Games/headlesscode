import type {
	FleetRepositoryBudgetScope,
	FleetRepositoryClosedSessionProof,
} from "../rsi/fleet-repository-budget-ledger.js"

export function assertClosedCurlProof(
	proof: FleetRepositoryClosedSessionProof,
	jobId: string,
	scope: FleetRepositoryBudgetScope,
	keyIdentity: string,
): void {
	if (!matchesProofScope(proof, jobId, scope, keyIdentity) ||
		!matchesClosedTotals(proof) || !hasClosedGrantAndDenial(proof)) {
		throw new Error("Fleet proof does not match the exact denied qualification")
	}
}

function matchesProofScope(
	proof: FleetRepositoryClosedSessionProof,
	jobId: string,
	scope: FleetRepositoryBudgetScope,
	keyIdentity: string,
): boolean {
	return proof.jobId === jobId && proof.campaignId === "fleet-security-watch" &&
		proof.repositoryCampaignId === scope.repositoryCampaignId &&
		proof.repositoryId === scope.repositoryId &&
		proof.repository === scope.repository &&
		proof.sourceRevision === scope.sourceRevision &&
		proof.policySha256 === scope.policySha256 &&
		proof.repositoryEpoch === scope.repositoryEpoch &&
		proof.model === scope.model &&
		proof.profileId === scope.profileId && proof.keyIdentity === keyIdentity
}

function matchesClosedTotals(
	proof: FleetRepositoryClosedSessionProof,
): boolean {
	return proof.settledMicros === 493 && proof.settledTokens === 6_064 &&
		proof.calls.length === 2 && /^[a-f0-9]{64}$/.test(proof.proofSha256)
}

function hasClosedGrantAndDenial(
	proof: FleetRepositoryClosedSessionProof,
): boolean {
	const fresh = Number.isSafeInteger(proof.asOfMs) &&
		Date.now() - proof.asOfMs <= 60_000 && proof.asOfMs <= Date.now() + 60_000
	const closedGrant = fresh && proof.grant.deadlineAtMs <= proof.asOfMs
	const denial = proof.denials.length === 1 &&
		proof.denials[0]?.statusCode === 429 &&
		proof.denials[0]?.reason === "budget-or-fence" &&
		proof.denials[0]?.count === 1
	return closedGrant && denial
}
