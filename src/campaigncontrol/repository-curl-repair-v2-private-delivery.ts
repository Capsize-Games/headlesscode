import { assertAlreadyFixed } from
	"./repository-curl-repair-v2-delivery-target.js"
import {
	assertPriorDeliveryMatches,
	buildV2DeliveryMarker,
	createPendingRecord,
	deliverBoardReceipt,
	deliveryResult,
} from "./repository-curl-repair-v2-delivery-board.js"
import { verifyFreshDeliveryInput } from
	"./repository-curl-repair-v2-delivery-evidence.js"
import { requireClaimCurrent } from
	"./repository-curl-repair-v2-delivery-current.js"
import {
	readDeliveryState,
	withDeliveryState,
	writeDeliveryState,
	type CurlRepairV2DeliveryState,
} from "./repository-curl-repair-v2-delivery-state.js"
import type {
	CurlRepairV2DeliveryDependencies,
	CurlRepairV2DeliveryInput,
	CurlRepairV2DeliveryResult,
	VerifiedCurlRepairV2Delivery,
} from "./repository-curl-repair-v2-private-delivery-types.js"

export type {
	CurlRepairV2DeliveryDependencies,
	CurlRepairV2DeliveryInput,
	CurlRepairV2DeliveryResult,
} from "./repository-curl-repair-v2-private-delivery-types.js"
export { buildV2DeliveryMarker } from
	"./repository-curl-repair-v2-delivery-board.js"

export async function deliverVerifiedCurlHistoricalRepairV2(
	input: CurlRepairV2DeliveryInput,
	dependencies: CurlRepairV2DeliveryDependencies,
): Promise<CurlRepairV2DeliveryResult> {
	const verified = await verifyFreshDeliveryInput(input, dependencies)
	await requireClaimCurrent(dependencies, input.claim, input.signal)
	return await withDeliveryState(
		dependencies.store.path,
		dependencies.stateRoot,
		input.claim.job.id,
		async (state) => await deliverWithState(
			input,
			verified,
			state.statePath,
			state.lock,
			dependencies,
		),
	)
}

async function deliverWithState(
	input: CurlRepairV2DeliveryInput,
	verified: VerifiedCurlRepairV2Delivery,
	statePath: string,
	lock: import("node:fs").promises.FileHandle,
	dependencies: CurlRepairV2DeliveryDependencies,
): Promise<CurlRepairV2DeliveryResult> {
	await requireClaimCurrent(dependencies, input.claim, input.signal)
	const prior = await readDeliveryState(statePath)
	await requireClaimCurrent(dependencies, input.claim, input.signal)
	if (prior) return await resumePrior({
		prior, verified, input, statePath, lock, dependencies,
	})
	await assertAlreadyFixed(verified, input, dependencies)
	const pending = createPendingRecord(verified)
	await persistCurrent(pending, input, statePath, dependencies)
	return await deliverBoardReceipt(pending, input, statePath, lock, dependencies)
}


async function resumePrior(task: {
	prior: CurlRepairV2DeliveryState
	verified: VerifiedCurlRepairV2Delivery
	input: CurlRepairV2DeliveryInput
	statePath: string
	lock: import("node:fs").promises.FileHandle
	dependencies: CurlRepairV2DeliveryDependencies
}): Promise<CurlRepairV2DeliveryResult> {
	const { prior, verified, input, statePath, lock, dependencies } = task
	assertPriorDeliveryMatches(prior, verified)
	if (prior.deliveryStatus === "delivered") return deliveryResult(prior, true)
	await assertAlreadyFixed(verified, input, dependencies)
	return await deliverBoardReceipt(prior, input, statePath, lock, dependencies)
}

async function persistCurrent(
	record: CurlRepairV2DeliveryState,
	input: CurlRepairV2DeliveryInput,
	statePath: string,
	dependencies: CurlRepairV2DeliveryDependencies,
): Promise<void> {
	await requireClaimCurrent(dependencies, input.claim, input.signal)
	await writeDeliveryState(statePath, record)
	await requireClaimCurrent(dependencies, input.claim, input.signal)
}
