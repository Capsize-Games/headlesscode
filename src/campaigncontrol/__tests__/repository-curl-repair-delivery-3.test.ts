import * as support from "./repository-curl-repair-delivery-test-support.js"

async function testLostPushReadback(): Promise<void> {
	const candidate = support.makeCandidate()
	const f = support.fixture(support.CURL_REPAIR_HISTORICAL_BASE, false)
	let writes = 0
	const wrappingGit = lostPushAdapter(f.dependencies.git!, () => writes++)
	const result = await support.deliverVerifiedCurlRepairDraft(
		{
			claim: support.claim,
			candidate,
			receipt: support.makeReceipt(candidate),
		},
		{ ...f.dependencies, git: wrappingGit },
	)
	assertLostPushRecovered(result, writes, f.calls)
}

function lostPushAdapter(
	git: support.CurlRepairGitAdapter,
	increment: () => void,
): support.CurlRepairGitAdapter {
	return {
		inspectTarget: () => git.inspectTarget(),
		candidateIsAncestor: (candidateSha, base) =>
			git.candidateIsAncestor(candidateSha, base),
		remoteBranchRevision: (value) => git.remoteBranchRevision(value),
		pushCandidate: async (value, candidateSha, base): Promise<void> => {
			increment()
			await git.pushCandidate(value, candidateSha, base)
			throw new Error("push ack lost")
		},
	}
}

function assertLostPushRecovered(
	result: support.CurlRepairDeliveryReceipt,
	writes: number,
	calls: string[],
): void {
	support.assert.equal(result.accepted, true)
	support.assert.equal(result.disposition, "draft-ready")
	support.assert.equal(writes, 1)
	support.assert.equal(
		calls.filter((call) => call === "create-pull").length,
		1,
	)
}

async function testInvalidReceiptAndStaleClaimBlocked(): Promise<void> {
	const candidate = support.makeCandidate()
	const f = support.fixture(support.CURL_REPAIR_HISTORICAL_BASE, false)
	await assertReceiptMismatch(candidate, f.dependencies, f.calls)
	await assertStaleClaim(candidate, f.dependencies, f.calls)
}

async function assertReceiptMismatch(
	candidate: support.CurlHistoricalRepairCandidate,
	dependencies: support.CurlRepairDeliveryDependencies,
	calls: string[],
): Promise<void> {
	const badReceipt = {
		...support.makeReceipt(candidate),
		evidenceSha256: "f".repeat(64),
	}
	await support.assert.rejects(
		support.deliverVerifiedCurlRepairDraft(
			{ claim: support.claim, candidate, receipt: badReceipt },
			dependencies,
		),
		/protected Curl repair receipt/,
	)
	support.assert.equal(calls.includes("inspect-target"), false)
}

async function assertStaleClaim(
	candidate: support.CurlHistoricalRepairCandidate,
	dependencies: support.CurlRepairDeliveryDependencies,
	calls: string[],
): Promise<void> {
	const stale = staleClaimDependencies(dependencies)
	await support.assert.rejects(
		support.deliverFixture(candidate, stale),
		/claim stale/,
	)
	support.assert.equal(calls.includes("push"), false)
}

function staleClaimDependencies(
	dependencies: support.CurlRepairDeliveryDependencies,
): support.CurlRepairDeliveryDependencies {
	return {
		...dependencies,
		store: {
			...dependencies.store,
			async assertClaimCurrent(): Promise<void> {
				throw new Error("claim stale")
			},
		},
	}
}

async function testDeliveryLockExcludesConcurrentCall(): Promise<void> {
	const candidate = support.makeCandidate()
	const f = support.fixture(support.VERIFIED_TARGET_TIP, true)
	const signal = deferredSignal()
	const git = blockingTargetAdapter(signal)
	const dependencies = { ...f.dependencies, git }
	const request = support.makeRepairRequest(candidate)
	const first = support.deliverVerifiedCurlRepairDraft(request, dependencies)
	await assertSecondDeliveryIsRejected(request, dependencies, signal.entered)
	signal.release()
	support.assert.equal((await first).disposition, "already-fixed")
}

function deferredSignal(): {
	entered: Promise<void>
	blocked: Promise<void>
	markEntered: () => void
	release: () => void
} {
	let markEntered!: () => void
	let unblock!: () => void
	const entered = new Promise<void>((resolve) => (markEntered = resolve))
	const blocked = new Promise<void>((resolve) => (unblock = resolve))
	return { entered, blocked, markEntered, release: unblock }
}

function blockingTargetAdapter(
	signal: ReturnType<typeof deferredSignal>,
): support.CurlRepairGitAdapter {
	return {
		inspectTarget: async (): Promise<support.CurlRepairTarget> => {
			signal.markEntered()
			await signal.blocked
			return approvedDocsTarget()
		},
		candidateIsAncestor: async (): Promise<boolean> => true,
		remoteBranchRevision: async (): Promise<string | null> => null,
		pushCandidate: async (): Promise<void> => {
			throw new Error("must not push")
		},
	}
}

function approvedDocsTarget(): support.CurlRepairTarget {
	return {
		repository: support.repo,
		private: true,
		branch: support.branch,
		baseRevision: "12a286c3ddb18aa5124775f0084b40f94accaceb",
		treeSha: "e1a2673971d538f348ea5e5af80e0a8b62428ecf",
		changedPathsFromSource: ["AGENTS.md", "CAPSIZE_SOURCE_ADOPTION.md"],
	}
}

async function assertSecondDeliveryIsRejected(
	request: {
		claim: support.CurlRepairClaim
		candidate: support.CurlHistoricalRepairCandidate
		receipt: support.CurlHistoricalRepairReceipt
	},
	dependencies: support.CurlRepairDeliveryDependencies,
	entered: Promise<void>,
): Promise<void> {
	await entered
	await support.assert.rejects(
		support.deliverVerifiedCurlRepairDraft(request, dependencies),
		/already being reconciled/,
	)
}

const tests: readonly support.SuiteTest[] = [
	[
		"lost private branch acknowledgement is resolved by the exact remote ref",
		testLostPushReadback,
	],
	[
		"receipt mismatch and stale claim stop before remote effects",
		testInvalidReceiptAndStaleClaimBlocked,
	],
	[
		"shared descriptor lock excludes concurrent private delivery reconciliation",
		testDeliveryLockExcludesConcurrentCall,
	],
]

await support.runMain("repository-curl-repair-delivery-3", tests)
