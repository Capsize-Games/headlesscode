import type { ClaimedRepositoryJob } from "./repository-campaigns.js"
import type { CurlRepairV2DeliveryDependencies } from
	"./repository-curl-repair-v2-private-delivery-types.js"

export async function requireClaimCurrent(
	dependencies: CurlRepairV2DeliveryDependencies,
	claim: ClaimedRepositoryJob,
	signal: AbortSignal,
): Promise<void> {
	const failure = await currentClaimFailure(dependencies, claim, signal)
	if (failure) throw failure
}

export async function currentClaimFailure(
	dependencies: CurlRepairV2DeliveryDependencies,
	claim: ClaimedRepositoryJob,
	signal: AbortSignal,
): Promise<Error | null> {
	let failure: Error | null = null
	try {
		await dependencies.store.assertClaimCurrent(claim)
	} catch (error) {
		failure = error instanceof Error ? error : new Error(String(error))
	}
	if (signal.aborted && !failure) {
		failure = new Error("Curl v2 private delivery was stopped")
	}
	return failure
}
