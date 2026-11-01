import * as path from "node:path"
import {
	evaluateCurlHistoricalRepairCandidate,
	type CurlHistoricalRepairReceipt,
} from "./repository-curl-repair-evaluator.js"
import type {
	CurlRepairDeliveryDependencies,
	CurlRepairDeliveryInput,
	CurlRepairDeliveryReceipt,
	BlockedDeliveryContext,
	DeliveryContext,
	DeliveryIdentity,
	DeliveryState,
	CurlRepairTarget,
} from "./repository-curl-repair-delivery-model.js"
import { FixedCurlGitAdapter } from "./repository-curl-repair-delivery-git.js"
import {
	FixedCurlGitHubAdapter,
} from "./repository-curl-repair-delivery-github.js"
import {
	acquireLock,
	ensurePrivateDirectory,
	readState,
} from "./repository-curl-repair-delivery-store.js"
import { canonical } from "./repository-curl-repair-delivery-primitives.js"
import { validateInput } from "./repository-curl-repair-delivery-validation.js"
import { reconcileTarget } from "./repository-curl-repair-delivery-reconcile.js"
import { receiptFromState } from "./repository-curl-repair-delivery-state.js"

/** Deliver the pinned Curl repair patch to its private repository. */
export async function deliverVerifiedCurlRepairDraft(
	input: CurlRepairDeliveryInput,
	dependencies: CurlRepairDeliveryDependencies,
): Promise<CurlRepairDeliveryReceipt> {
	const identity = validateInput(input)
	await dependencies.store.assertClaimCurrent(input.claim)
	await verifyEvaluation(input, dependencies, identity)
	const stateRoot = deliveryStateRoot(dependencies)
	await ensurePrivateDirectory(stateRoot)
	return withDeliveryLock(stateRoot, () =>
		runLockedDelivery(input, dependencies, identity, stateRoot),
	)
}

function deliveryStateRoot(
	dependencies: CurlRepairDeliveryDependencies,
): string {
	const fallback = path.join(
		path.dirname(path.resolve(dependencies.store.path)),
		"curl-repair-delivery",
	)
	return path.resolve(dependencies.stateRoot ?? fallback)
}

async function withDeliveryLock<T>(
	stateRoot: string,
	operation: () => Promise<T>,
): Promise<T> {
	const lock = await acquireLock(path.join(stateRoot, "delivery.lock"))
	try {
		return await operation()
	} finally {
		lock.close()
	}
}

async function verifyEvaluation(
	input: CurlRepairDeliveryInput,
	dependencies: CurlRepairDeliveryDependencies,
	identity: DeliveryIdentity,
): Promise<void> {
	const evaluate =
		dependencies.evaluate ?? evaluateCurlHistoricalRepairCandidate
	const evaluation = await evaluate({
		candidate: input.candidate,
		jobId: identity.jobId,
	})
	assertEvaluationReceipt(evaluation, input, identity)
}

function assertEvaluationReceipt(
	evaluation: CurlHistoricalRepairReceipt,
	input: CurlRepairDeliveryInput,
	identity: DeliveryIdentity,
): void {
	if (
		canonical(evaluation) !== canonical(input.receipt) ||
		input.receipt.evidenceSha256 !== identity.receiptSha256
	) {
		throw new Error(
			"protected Curl repair receipt does not match this source patch " +
				"and campaign job",
		)
	}
}

async function runLockedDelivery(
	input: CurlRepairDeliveryInput,
	dependencies: CurlRepairDeliveryDependencies,
	identity: DeliveryIdentity,
	stateRoot: string,
): Promise<CurlRepairDeliveryReceipt> {
	await dependencies.store.assertClaimCurrent(input.claim)
	const loaded = await loadDeliveryState(stateRoot, identity, input.claim)
	const priorReceipt = existingDeliveryReceipt(loaded, identity)
	if (priorReceipt) return priorReceipt
	return inspectAndReconcile(
		input,
		dependencies,
		stateRoot,
		loaded.context,
		loaded.prior,
	)
}

function existingDeliveryReceipt(
	loaded: {
		context: BlockedDeliveryContext
		prior: DeliveryState["entries"][string] | undefined
	},
	identity: DeliveryIdentity,
): CurlRepairDeliveryReceipt | null {
	return priorDeliveryReceipt(loaded.prior, loaded.context, identity)
}

async function loadDeliveryState(
	stateRoot: string,
	identity: DeliveryIdentity,
	claim: CurlRepairDeliveryInput["claim"],
): Promise<{
	context: BlockedDeliveryContext
	prior: DeliveryState["entries"][string] | undefined
}> {
	const statePath = path.join(stateRoot, "delivery-state.json")
	const state = await readState(statePath)
	const key = identity.key
	const context = { state, statePath, key, identity, claim }
	const prior = state.entries[key]
	return { context, prior }
}

async function inspectAndReconcile(
	input: CurlRepairDeliveryInput,
	dependencies: CurlRepairDeliveryDependencies,
	stateRoot: string,
	context: BlockedDeliveryContext,
	prior: DeliveryState["entries"][string] | undefined,
): Promise<CurlRepairDeliveryReceipt> {
	const git = dependencies.git ?? new FixedCurlGitAdapter(stateRoot)
	const github = dependencies.github ?? new FixedCurlGitHubAdapter()
	const target = await git.inspectTarget()
	return reconcileTarget({
		...context,
		input,
		dependencies,
		git,
		github,
		target,
		prior,
	})
}

function priorDeliveryReceipt(
	prior: DeliveryState["entries"][string] | undefined,
	context: BlockedDeliveryContext,
	identity: DeliveryIdentity,
): CurlRepairDeliveryReceipt | null {
	if (!prior) return null
	if (
		prior.identitySha256 !== identity.identitySha256 ||
		prior.claimId !== context.claim.claimId ||
		prior.epoch !== context.claim.epoch ||
		prior.jobId !== identity.jobId
	) {
		throw new Error(
			"stored Curl delivery identity conflicts with the current claim",
		)
	}
	return isTerminalEntry(prior) ? receiptFromState(prior) : null
}

function isTerminalEntry(entry: DeliveryState["entries"][string]): boolean {
	return (
		entry.state === "already-fixed" ||
		entry.state === "draft-ready" ||
		entry.state === "blocked"
	)
}
