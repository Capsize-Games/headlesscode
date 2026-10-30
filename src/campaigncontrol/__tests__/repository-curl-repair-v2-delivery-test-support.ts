import { createHash } from "node:crypto"
import { evaluateCurlHistoricalRepairCandidate } from
	"../repository-curl-repair-evaluator.js"
import { CURL_REPAIR_DELIVERY_POLICY } from
	"../repository-curl-repair-delivery.js"
import type { CurlRepairV2DeliveryInput } from
	"../repository-curl-repair-v2-delivery-validation.js"
import type { CurlRepairV2DeliveryDependencies } from
	"../repository-curl-repair-v2-private-delivery-types.js"
import type {
	CurlRepairV2EvaluatorReceipt, CurlRepairV2WorkerReceipt,
} from "../repository-curl-repair-v2-execution.js"
import type { CurlRepairV2StageReceipt } from
	"../repository-curl-repair-v2-receipt-types.js"

const jobId = "11111111-1111-4111-8111-111111111111"
const claimId = "22222222-2222-4222-8222-222222222222"
const epoch = 7

export type DeliveryFixture = {
	input: CurlRepairV2DeliveryInput
	workerStage: CurlRepairV2StageReceipt<CurlRepairV2WorkerReceipt>
	evaluatorStage: CurlRepairV2StageReceipt<CurlRepairV2EvaluatorReceipt>
}

export function makeDeliveryDependencies(
	root: string,
	stateRoot: string,
	fixture: DeliveryFixture,
	loseAck = false,
): CurlRepairV2DeliveryDependencies & { postCount(): number } {
	const state = { markers: new Set<string>(), posts: 0 }
	return {
		...createDependencyBase(root, stateRoot, fixture),
		...createTargetAndBoard(state, loseAck),
		postCount: () => state.posts,
	}
}

function createDependencyBase(
	root: string,
	stateRoot: string,
	fixture: DeliveryFixture,
): CurlRepairV2DeliveryDependencies {
	return {
		store: { path: `${root}/campaigns.json`,
			assertClaimCurrent: async () => undefined },
		stateRoot,
		verifyEvidence: async () => ({
			worker: fixture.workerStage,
			evaluator: fixture.evaluatorStage,
		}),
		evaluateBase: evaluateBase,
	}
}

async function evaluateBase(
	input: Parameters<typeof evaluateCurlHistoricalRepairCandidate>[0],
): ReturnType<typeof evaluateCurlHistoricalRepairCandidate> {
	return await evaluateCurlHistoricalRepairCandidate({
		candidate: input.candidate,
		jobId: input.jobId,
		buildCandidate: async () => input.candidate,
		evaluateFixedProof: async () => ({
			schemaVersion: 1,
			accepted: true,
			disposition: "already-fixed",
			evidenceSha256: sha256("proof"),
			reasonCode: "fixed-proof-verified",
		}),
	})
}

function createTargetAndBoard(
	state: { markers: Set<string>; posts: number },
	loseAck: boolean,
): Pick<CurlRepairV2DeliveryDependencies, "git" | "board"> {
	return { git: createReadOnlyTarget(), board: createBoard(state, loseAck) }
}

function createReadOnlyTarget(): NonNullable<
	CurlRepairV2DeliveryDependencies["git"]
> {
	return {
		inspectTarget: async () => ({
			repository: CURL_REPAIR_DELIVERY_POLICY.targetRepository,
			private: true,
			branch: CURL_REPAIR_DELIVERY_POLICY.targetBranch,
			baseRevision: CURL_REPAIR_DELIVERY_POLICY.verifiedCurrentTargetTip,
			treeSha: CURL_REPAIR_DELIVERY_POLICY.verifiedCurrentTargetTree,
			changedPathsFromSource: [
				...CURL_REPAIR_DELIVERY_POLICY.verifiedCurrentTargetAddedPaths,
			],
		}),
		candidateIsAncestor: async () => true,
	}
}

function createBoard(
	state: { markers: Set<string>; posts: number },
	loseAck: boolean,
): NonNullable<CurlRepairV2DeliveryDependencies["board"]> {
	return {
		hasMarker: async (marker) => state.markers.has(marker),
		addComment: async (comment) => addComment(comment, state, loseAck),
	}
}

async function addComment(
	comment: string,
	state: { markers: Set<string>; posts: number },
	loseAck: boolean,
): Promise<void> {
	state.posts += 1
	const marker = comment.match(/^\[([^\]]+)\]/)?.[1]
	if (marker) state.markers.add(marker)
	if (loseAck) throw new Error("synthetic lost acknowledgement")
}


function sha256(value: string): string {
	return createHash("sha256").update(value).digest("hex")
}
