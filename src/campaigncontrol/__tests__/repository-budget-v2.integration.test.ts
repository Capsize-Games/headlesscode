import assert from "node:assert/strict"
import * as path from "node:path"
import { test } from "node:test"
import { RepositoryCampaignStore } from "../repository-campaigns.js"
import {
	FleetRepositoryBudgetLedger,
} from "../../rsi/fleet-repository-budget-ledger.js"
import { fixture } from "./budget-v2-seed.js"
import {
	deferred, keyIdentity, reservation,
	type CampaignBudgetStatus,
} from "./budget-v2-fixtures.js"
import {
	abortingHandoff, assertRestartPreserved, assertSharedLifetimePool,
	bindTestClaim, finishOrderedStop, gateSettleFinishBoth, gatedHandoff,
	refuseLiveClaim, registerAndReserveBoth, rollMonthAfterSettleFault,
	reconcileLateReceipt, verifyRestartPreserved,
} from "./budget-v2-bindings.js"
import {
	assertSharedReservation, newCoordinatorRun,
	openCoordinator, openPipelineStore, pipelineAuthority,
	pipelineDefinitions, pipelineRoot,
} from "./budget-v2-coordinator.js"
import {
	assertExtraLedgerConsumed, beginOrderedSend, fenceAndSettle,
	orderedStopGates, recoverAmbiguousJob, reconcileAmbiguous,
	reconcileCrashedHandoff, requireStatusJob, stopCoordinatorQuietly,
} from "./budget-v2-drive.js"
import {
	acquireColdRun, assertColdProvisioning, assertColdSnapshotOnly,
	assertEmptyNoCall, assertExpiredGrantProof, assertGrantedNoCall,
	assertZeroCallAdmitted, coldReadAuthority, primaryDefinition,
	provisionColdClaim, proveNoCallLedger, readonlyAuthority,
	rejectedZeroCallLedger, stopColdCampaign, v2ZeroCallPayload,
	v2ZeroCallScope, zeroCallInvalidVariants,
} from "./budget-v2-proofs.js"
import { expireGrantRow, grantDbPath } from "./budget-v2-handoff.js"
test(
	"HCL binding sends v2 repository identities and both repositories " +
		"consume the same legacy campaign lifetime pool",
	async (t) => {
		const f = await fixture(); t.after(f.cleanup)
		await registerAndReserveBoth(f)
		assert.equal(await gateSettleFinishBoth(f), 2)
		await assertSharedLifetimePool(f)
		await assertExtraLedgerConsumed(f)
	})
test(
	"two-repository coordinator pipelines reserve together, Stop fences new " +
		"calls, and restart preserves settled budget and progress",
	async (t) => {
		const f = await fixture(); t.after(f.cleanup)
		const root = await pipelineRoot(f)
		const pipeline = pipelineDefinitions()
		const store = await openPipelineStore(root, pipeline)
		const run = newCoordinatorRun(f, root, store)
		const coordinator = openCoordinator(run, store)
		const ledger = await assertSharedReservation(coordinator, run, f)
		try {
			const terminal = await fenceAndSettle(run, store, f, coordinator)
			await verifyRestartPreserved(pipelineAuthority(), store,
				pipeline, terminal, ledger)
		} finally {
			await stopCoordinatorQuietly(coordinator, run)
		}
	})
test("Fleet no-call proof is scope-bound, point-in-time and read-only",
	async (t) => {
		const f = await fixture(); t.after(f.cleanup)
		const ledger = proveNoCallLedger(f)
		await assertEmptyNoCall(ledger)
		await assertGrantedNoCall(ledger, "prepare-job-with-grant")
		const bridgeDb = grantDbPath(f)
		expireGrantRow(bridgeDb, "prepare-job-with-grant")
		await assertExpiredGrantProof(ledger, "prepare-job-with-grant",
			bridgeDb)
		await assert.rejects(ledger.proveNoCall("prepare-failed-job", -1),
			/no-call proof identity is invalid/)
	})
test("zero-call proof admits only the exact stopped Curl v2 budget-only scope",
	async () => {
		const scopeValue = v2ZeroCallScope()
		const payload = v2ZeroCallPayload()
		const ledger = new FleetRepositoryBudgetLedger({
			expectedKeyIdentity: keyIdentity, scope: scopeValue,
			invoke: async () => payload })
		assertZeroCallAdmitted(await ledger.proveNoCall("infra-failed-v2", 7))
		for (const invalid of zeroCallInvalidVariants(payload)) {
			const rejected = rejectedZeroCallLedger(invalid)
			await assert.rejects(rejected.proveNoCall("infra-failed-v2", 7),
				/no-call proof is invalid/)
		}
		assert.throws(() => new FleetRepositoryBudgetLedger({
			expectedKeyIdentity: keyIdentity,
			scope: { ...scopeValue, repositoryCampaignId: "other-none" },
			invoke: async () => payload }),
		/Fleet repository budget scope is invalid/)
	})
test(
	"cold start reads Fleet budget without a run, then starts, claims, and " +
		"stops through real HCL and Fleet stores",
	async (t) => {
		const f = await fixture({ activeRun: false,
			repositoryEnabled: false }); t.after(f.cleanup)
		const definition = primaryDefinition()
		const repoStore = new RepositoryCampaignStore(
			path.join(f.root, "cold-start.json"), [definition],
			coldReadAuthority(f))
		await assertColdProvisioning(repoStore)
		await assertColdSnapshotOnly(f)
		await provisionColdClaim(repoStore, definition)
		const started = await acquireColdRun(f, repoStore, definition)
		await stopColdCampaign(f, repoStore, definition, started)
	})
test(
	"read-only snapshot permits budget changes for an enabled repository " +
		"but never dispatches",
	async (t) => {
		const f = await fixture({ activeRun: false,
			repositoryEnabled: true }); t.after(f.cleanup)
		const definition = primaryDefinition()
		const repoStore = new RepositoryCampaignStore(
			path.join(f.root, "readonly-enabled.json"), [definition],
			readonlyAuthority(f))
		await repoStore.setCampaignBudget(definition.id, 10_000, 10_000)
		await repoStore.start(definition.id)
		const before = await repoStore.status() as unknown as CampaignBudgetStatus
		assert.equal(before.budget.available, false)
		assert.equal(before.budget.provisioningAvailable, true)
		assert.equal(before.campaigns[0]?.enabled, true)
		await repoStore.setCampaignBudget(definition.id, 9_000, 9_000)
		await repoStore.enqueue(definition.id, "CVE-2026-92390")
		await refuseLiveClaim(repoStore, definition)
	})
test(
	"Stop changes to either epoch before the dual request-start fence " +
		"prevent the HTTP callback",
	async (t) => {
		const f = await fixture(); t.after(f.cleanup)
		const id = "repo-a" as const, call = reservation("fixture-stop-call")
		await f.bindings[id].register(f.grants[id])
		await f.bindings[id].reserve(f.grants[id], call)
		await f.setControl({ repoAEnabled: false, repoAEpoch: 2 }); let sends = 0
		await assert.rejects(f.bindings[id].requestStartGate(async () => {
			sends += 1; return new Response("must not send") },
			{ grant: f.grants[id], reservation: call }),
			/outside|mismatched|stale|unavailable|current|handoff failed/)
		assert.equal(sends, 0)
	})
test(
	"Stop waits for Fleet request-start admission and send invocation, then " +
		"proceeds before HTTP completion",
	async (t) => {
		const f = await fixture(); t.after(f.cleanup)
		const id = "repo-a" as const
		const call = reservation("fixture-ordered-stop-call")
		const gates = orderedStopGates()
		const requestStartHandoff = gatedHandoff(f, gates.admissionEntered,
			gates.releaseAdmission)
		const binding = bindTestClaim(f, id, requestStartHandoff)
		await binding.register(f.grants[id])
		await binding.reserve(f.grants[id], call)
		const request = beginOrderedSend(binding, f.grants[id], call,
			gates.sendStarted, gates.releaseResponse)
		await gates.admissionEntered.promise
		await finishOrderedStop(f, id, gates, request)
	})
test(
	"Python crash after durable request-start is fail-closed and preserves " +
		"both ambiguous holds",
	async (t) => {
		const f = await fixture(); t.after(f.cleanup)
		const id = "repo-a" as const
		const call = reservation("fixture-python-crash-call")
		await f.bindings[id].register(f.grants[id])
		await f.bindings[id].reserve(f.grants[id], call)
		f.crashNextHandoff(); let sends = 0
		await assert.rejects(f.bindings[id].requestStartGate(async () => {
			sends += 1; return new Response("must not send") },
			{ grant: f.grants[id], reservation: call }), /handoff failed/)
		assert.equal(sends, 0)
		assert.equal(f.tryDispatchLock(), true, "bridge crash holds the lock")
		const status = await reconcileCrashedHandoff(f, id)
		const job = requireStatusJob(status, f.claims[id].job.id)
		assert.equal(job.status, "ambiguous")
		assert.equal(status.budget.ambiguousMicros, 20_000)
	})
test(
	"Node-side no-ack closes its shared lock descriptor and leaves the send " +
		"reservation held",
	async (t) => {
		const f = await fixture(); t.after(f.cleanup)
		const id = "repo-a" as const, call = reservation("fixture-no-ack-call")
		await f.bindings[id].register(f.grants[id])
		await f.bindings[id].reserve(f.grants[id], call)
		const binding = bindTestClaim(f, id, abortingHandoff(f))
		let sends = 0
		await assert.rejects(binding.requestStartGate(async () => {
			sends += 1; return new Response("must not send") },
			{ grant: f.grants[id], reservation: call }), /handoff failed/)
		assert.equal(sends, 0); assert.equal(f.tryDispatchLock(), true)
		const status = await reconcileAmbiguous(binding, f.grants[id], f.store)
		assert.equal(status.budget.ambiguousMicros, 20_000)
	})
test(
	"immediately rejected fetch is observed during lock acknowledgement and " +
		"keeps the claim recoverable",
	async (t) => {
		const f = await fixture(); t.after(f.cleanup)
		const id = "repo-a" as const
		const call = reservation("fixture-rejected-fetch-call")
		await f.bindings[id].register(f.grants[id])
		await f.bindings[id].reserve(f.grants[id], call)
		const admitted = deferred<void>(), release = deferred<void>()
		const handoff = gatedHandoff(f, admitted, release)
		const binding = bindTestClaim(f, id, handoff)
		const request = binding.requestStartGate(
			() => Promise.reject(new Error("synthetic fetch failure")),
			{ grant: f.grants[id], reservation: call })
		await admitted.promise
		release.resolve(); await assert.rejects(request, /synthetic fetch failure/)
		const status = await recoverAmbiguousJob(f.store, f.claims[id].job.id)
		assert.equal(status.budget.ambiguousMicros, 20_000)
	})
test(
	"restart reconciliation settles an exact late receipt after Stop and " +
		"UTC month rollover",
	async (t) => {
		const f = await fixture(); t.after(f.cleanup)
		const id = "repo-a" as const, call = reservation("fixture-restart-call")
		await f.bindings[id].register(f.grants[id])
		await f.bindings[id].reserve(f.grants[id], call); let sends = 0
		await f.bindings[id].requestStartGate(async () => {
			sends += 1; return new Response("sent fixture") },
			{ grant: f.grants[id], reservation: call })
		assert.equal(sends, 1)
		const restarted = await rollMonthAfterSettleFault(f, call.callId,
			pipelineAuthority())
		const final = await reconcileLateReceipt(f, restarted)
		const settled = requireStatusJob(final, f.claims[id].job.id)
		assert.equal(settled.status, "succeeded")
		assert.equal(settled.settledMicros, 100)
		assert.equal(settled.settledTokens, 19)
		assert.equal(final.budget.ambiguousMicros, 10_000)
	})
