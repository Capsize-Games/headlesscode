import type { ClaimedRepositoryJob } from "./repository-campaigns.js"
import type {
	evaluateCurlHistoricalRepairV2,
} from "./repository-curl-repair-v2-evaluator.js"
import type {
	verifyCurlRepairV2Evidence,
} from "./repository-curl-repair-v2-execution.js"
import type { FixedCurlReadOnlyGit } from
	"./repository-curl-repair-delivery.js"
import type { CurlPrivateBoardTransport } from
	"./repository-curl-private-types.js"
import type { CurlRepairV2DeliveryInput } from
	"./repository-curl-repair-v2-delivery-validation.js"
import type { CurlHistoricalRepairV2Receipt } from
	"./repository-curl-repair-v2-evaluator.js"

export type { CurlRepairV2DeliveryInput } from
	"./repository-curl-repair-v2-delivery-validation.js"

export interface CurlRepairV2DeliveryDependencies {
	store: {
		path: string
		assertClaimCurrent(claim: ClaimedRepositoryJob): Promise<void>
	}
	stateRoot?: string
	git?: FixedCurlReadOnlyGit
	board?: CurlPrivateBoardTransport
	verifyEvidence?: typeof verifyCurlRepairV2Evidence
	evaluateBase?: Parameters<
		typeof evaluateCurlHistoricalRepairV2
	>[0]["evaluateBase"]
}

export interface VerifiedCurlRepairV2Delivery {
	candidateSha256: string
	claim: ClaimedRepositoryJob
	marker: string
	receipt: CurlHistoricalRepairV2Receipt
}

export interface CurlRepairV2DeliveryResult {
	accepted: boolean
	evidenceSha256: string
	boardRef: string | null
}

export type { FixedCurlReadOnlyGit }
