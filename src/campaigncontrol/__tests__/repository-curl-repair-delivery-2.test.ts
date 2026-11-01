import * as support from "./repository-curl-repair-delivery-test-support.js"

async function testUnknownTargetTreeIsBlocked(): Promise<void> {
	const candidate = support.makeCandidate()
	const f = support.fixture("12a286c3ddb18aa5124775f0084b40f94accaceb", true)
	const mismatched = mismatchedTargetAdapter(f.dependencies.git!)
	const result = await support.deliverVerifiedCurlRepairDraft(
		{
			claim: support.claim,
			candidate,
			receipt: support.makeReceipt(candidate),
		},
		{ ...f.dependencies, git: mismatched },
	)
	assertUnapprovedTargetBlocked(result)
	assertNoWrites(f.calls)
}

function mismatchedTargetAdapter(
	git: support.CurlRepairGitAdapter,
): support.CurlRepairGitAdapter {
	return {
		...git,
		inspectTarget: async (): Promise<support.CurlRepairTarget> =>
			mismatchedTarget(),
	}
}

function mismatchedTarget(): support.CurlRepairTarget {
	return {
		repository: support.repo,
		private: true,
		branch: support.branch,
		baseRevision: "12a286c3ddb18aa5124775f0084b40f94accaceb",
		treeSha: "f".repeat(40),
		changedPathsFromSource: [
			"AGENTS.md",
			"CAPSIZE_SOURCE_ADOPTION.md",
			"src/tool_cb_hdr.c",
		],
	}
}

function assertUnapprovedTargetBlocked(
	result: support.CurlRepairDeliveryReceipt,
): void {
	support.assert.equal(result.accepted, false)
	support.assert.equal(
		result.reasonCode,
		"private-target-source-tree-is-not-an-approved-pin",
	)
}

function assertNoWrites(calls: string[]): void {
	support.assert.equal(calls.includes("push"), false)
	support.assert.equal(calls.includes("create-pull"), false)
}

async function testExactPatchDraftReadback(): Promise<void> {
	const candidate = support.makeCandidate()
	const f = support.fixture(support.CURL_REPAIR_HISTORICAL_BASE, false)
	const result = await support.deliverVerifiedCurlRepairDraft(
		{
			claim: support.claim,
			candidate,
			receipt: support.makeReceipt(candidate),
		},
		f.dependencies,
	)
	assertDraftReady(f, result)
}

function assertDraftReady(
	f: ReturnType<typeof support.fixture>,
	result: support.CurlRepairDeliveryReceipt,
): void {
	support.assert.equal(result.accepted, true)
	support.assert.equal(result.disposition, "draft-ready")
	support.assert.equal(
		result.privateRef,
		`https://github.com/${support.repo}/pull/9`,
	)
	support.assert.equal(f.created.length, 1)
	support.assert.ok(f.calls.indexOf("fence") < f.calls.indexOf("push"))
	support.assert.ok(f.calls.indexOf("push") < f.calls.indexOf("create-pull"))
	support.assert.match(
		f.created[0]!.body,
		/historical public regression evidence only/,
	)
}

async function testLostDraftAckCreatesNoDuplicate(): Promise<void> {
	const candidate = support.makeCandidate()
	const f = support.fixture(support.CURL_REPAIR_HISTORICAL_BASE, false)
	const github = f.dependencies.github!
	let calls = 0
	const wrap = lostDraftAckAdapter(github, () => calls++)
	const dependencies = { ...f.dependencies, github: wrap }
	const first = await support.deliverFixture(candidate, dependencies)
	const second = await support.deliverFixture(candidate, dependencies)
	support.assert.equal(first.accepted, false)
	support.assert.equal(first.disposition, "blocked")
	support.assert.equal(second.accepted, true)
	support.assert.equal(second.disposition, "draft-ready")
	support.assert.equal(calls, 1)
}

function lostDraftAckAdapter(
	github: support.CurlRepairGitHubAdapter,
	increment: () => void,
): support.CurlRepairGitHubAdapter {
	return {
		findPullRequests: (value) => github.findPullRequests(value),
		createDraftPullRequest: async (input): Promise<void> => {
			increment()
			await github.createDraftPullRequest(input)
			throw new Error("ack lost")
		},
	}
}

const tests: readonly support.SuiteTest[] = [
	[
		"unknown target trees and changed source paths fail closed",
		testUnknownTargetTreeIsBlocked,
	],
	[
		"verified historical patch creates only an exact private draft " +
			"on the vulnerable pinned base",
		testExactPatchDraftReadback,
	],
	[
		"lost draft acknowledgement is reconciled before any retry",
		testLostDraftAckCreatesNoDuplicate,
	],
]

await support.runMain("repository-curl-repair-delivery-2", tests)
