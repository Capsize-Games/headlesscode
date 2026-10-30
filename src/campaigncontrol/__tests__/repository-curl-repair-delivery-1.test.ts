import * as support from "./repository-curl-repair-delivery-test-support.js"

async function testPolicyIsFixedAndRepairClaimsAreDistinct(): Promise<void> {
	assertFixedPolicy()
	const candidate = support.makeCandidate()
	const f = support.fixture("b31c35238d5488fa00185c319f7059938cb474d5", false)
	await assertInvalidClaimBlocked(candidate, f.dependencies)
	support.assert.equal(f.calls.length, 0)
}

async function testReadOnlyGitSurfaceHasNoMutationMethods(): Promise<void> {
	const adapter = support.createFixedCurlReadOnlyGitAdapter()
	support.assert.deepEqual(Object.keys(adapter).sort(), [
		"candidateIsAncestor",
		"inspectTarget",
	])
	support.assert.equal(typeof adapter.inspectTarget, "function")
	support.assert.equal(typeof adapter.candidateIsAncestor, "function")
}

function assertFixedPolicy(): void {
	support.assert.equal(
		support.CURL_REPAIR_DELIVERY_POLICY.campaignId,
		"curl-historical-repair",
	)
	support.assert.equal(
		support.CURL_REPAIR_DELIVERY_POLICY.targetRepository,
		support.repo,
	)
	support.assert.equal(
		support.CURL_REPAIR_DELIVERY_POLICY.targetBranch,
		support.branch,
	)
	support.assert.equal(support.CURL_REPAIR_DELIVERY_POLICY_SHA256.length, 64)
}

async function assertInvalidClaimBlocked(
	candidate: support.CurlHistoricalRepairCandidate,
	dependencies: support.CurlRepairDeliveryDependencies,
): Promise<void> {
	const badClaim = {
		...support.claim,
		job: { ...support.claim.job, campaignId: "curl-maintenance" },
	}
	await support.assert.rejects(
		support.deliverVerifiedCurlRepairDraft(
			{
				claim: badClaim,
				candidate,
				receipt: support.makeReceipt(candidate),
			},
			dependencies,
		),
		/compiled claim/,
	)
}

async function testRejectedCredentialAndBusPaths(): Promise<void> {
	const fakeAddress = `unix:path=/tmp/dbus-fake-unowned,guid=${"c".repeat(32)}`
	const env = support.fixedCurlDeliveryGitHubEnvironment({
		PATH: "/untrusted/bin",
		HOME: "/untrusted/home",
		DBUS_SESSION_BUS_ADDRESS: fakeAddress,
		XDG_RUNTIME_DIR: "/tmp/attacker-runtime",
		GH_TOKEN: "fake-credential-must-not-be-forwarded",
		GITHUB_TOKEN: "fake-compat-credential-must-not-be-forwarded",
		SSH_AUTH_SOCK: "/tmp/unrelated-agent.sock",
		AWS_ACCESS_KEY_ID: "unrelated-secret",
	})
	assertSafeEnvironmentPaths(env, fakeAddress)
	assertNoInheritedSecrets(env)
}

function assertSafeEnvironmentPaths(
	env: NodeJS.ProcessEnv,
	fakeAddress: string,
): void {
	support.assert.deepEqual(
		{ PATH: env.PATH, HOME: env.HOME },
		{ PATH: "/usr/local/bin:/usr/bin:/bin", HOME: support.os.homedir() },
	)
	support.assert.notEqual(
		env.DBUS_SESSION_BUS_ADDRESS,
		fakeAddress,
		"D-Bus address must come from the validated owner desktop process",
	)
	assertOwnerRuntimeIfPresent(env)
}

function assertOwnerRuntimeIfPresent(env: NodeJS.ProcessEnv): void {
	if (env.DBUS_SESSION_BUS_ADDRESS !== undefined) {
		support.assert.match(
			env.DBUS_SESSION_BUS_ADDRESS,
			/^unix:path=\/tmp\/dbus-[A-Za-z0-9]{1,64},guid=[a-f0-9]{32}$/,
		)
		support.assert.equal(
			env.XDG_RUNTIME_DIR,
			`/run/user/${process.getuid?.() ?? -1}`,
		)
	} else support.assert.equal(env.XDG_RUNTIME_DIR, undefined)
}

function assertNoInheritedSecrets(env: NodeJS.ProcessEnv): void {
	for (const secretName of [
		"GH_TOKEN",
		"GITHUB_TOKEN",
		"SSH_AUTH_SOCK",
		"AWS_ACCESS_KEY_ID",
	]) {
		support.assert.equal(
			Object.hasOwn(env, secretName),
			false,
			`${secretName} must not enter fixed gh subprocess environment`,
		)
	}
}

async function testAlreadyFixedTargetCreatesNoDraft(): Promise<void> {
	const candidate = support.makeCandidate()
	const f = support.fixture(support.VERIFIED_TARGET_TIP, true)
	const result = await support.deliverFixture(candidate, f.dependencies)
	assertAlreadyFixed(result, f.calls)
}

function assertAlreadyFixed(
	result: support.CurlRepairDeliveryReceipt,
	calls: string[],
): void {
	support.assert.equal(result.accepted, true)
	support.assert.equal(result.disposition, "already-fixed")
	support.assert.equal(
		result.privateRef,
		`https://github.com/${support.repo}/tree/${support.branch}`,
	)
	support.assert.equal(calls.includes("push"), false)
	support.assert.equal(calls.includes("find-pull"), false)
	support.assert.equal(calls.includes("create-pull"), false)
}

const tests: readonly support.SuiteTest[] = [
	[
		"repair delivery policy is fixed and separate from the qualification claim",
		testPolicyIsFixedAndRepairClaimsAreDistinct,
	],
	[
		"fixed read-only Git surface exposes no mutation methods",
		testReadOnlyGitSurfaceHasNoMutationMethods,
	],
	[
		"fixed GitHub delivery rejects fake credential and D-Bus paths",
		testRejectedCredentialAndBusPaths,
	],
	[
		"candidate already in the private target never creates a branch " +
			"or pull request",
		testAlreadyFixedTargetCreatesNoDraft,
	],
]

await support.runMain("repository-curl-repair-delivery-1", tests)
