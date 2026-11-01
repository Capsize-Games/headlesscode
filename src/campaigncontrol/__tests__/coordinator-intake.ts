import assert from "node:assert/strict"
import type {
	RepositoryWorkerPipelineAdapters,
} from "../repository-worker-pipeline.js"
import {
	type RegisteredRepositoryWorker, type RepositoryAdvisoryIntake,
	RepositoryCampaignCoordinator,
} from "../repository-coordinator.js"
import type {
	RepositoryCampaignStore,
} from "../repository-campaigns.js"
import {
	awaitLeaseFinish, definition, readStatus, waitForTerminal,
} from "./coordinator-fixtures.js"
import type { ActiveCampaignRun } from "../store.js"
import type {
	RepositoryCampaignRunLease,
} from "../repository-run-lease.js"
import type {
	PublishedAdvisoryRecord,
} from "../repository-advisory-intake.js"
import { digest } from "./coordinator-fixtures.js"
import { pipelineShell } from "./coordinator-workers.js"

function quietAdapters(
	message: string,
): Pick<RepositoryWorkerPipelineAdapters, "lookupAdvisory" |
	"prepareWorkspace" | "evaluate" | "deliverPrivate"> {
	return {
		async lookupAdvisory(): Promise<never> {
			throw new Error(message)
		},
		async prepareWorkspace(): Promise<never> {
			throw new Error(message)
		},
		async evaluate(): Promise<never> {
			throw new Error(message)
		},
		async deliverPrivate(): Promise<never> {
			throw new Error(message)
		},
	}
}

export function recordingLease(
	run: ActiveCampaignRun,
	events: string[],
): RepositoryCampaignRunLease {
	return {
		async acquire(timeoutMs: number): ReturnType<
			RepositoryCampaignRunLease["acquire"]> {
			events.push(`acquire:${timeoutMs}`)
			return run
		},
		async finish(value: ActiveCampaignRun,
			status: "succeeded" | "failed"): ReturnType<
			RepositoryCampaignRunLease["finish"]> {
			assert.equal(value.id, run.id)
			events.push(`finish:${status}`)
			return { ...value, status, finishedAt: Date.now() }
		},
	}
}

export function busyLease(
	run: ActiveCampaignRun,
	isBusy: () => boolean,
): RepositoryCampaignRunLease {
	return {
		async acquire(): ReturnType<
			RepositoryCampaignRunLease["acquire"]> {
			return isBusy() ? null : run
		},
		async finish(value: ActiveCampaignRun,
			status: "succeeded" | "failed"): ReturnType<
			RepositoryCampaignRunLease["finish"]> {
			assert.equal(value.id, run.id)
			assert.equal(status, "succeeded")
			return { ...value, status, finishedAt: Date.now() }
		},
	}
}

export function nullLease(): RepositoryCampaignRunLease {
	return {
		async acquire(): Promise<null> {
			return null
		},
		async finish(value: ActiveCampaignRun,
			status: "succeeded" | "failed"): ReturnType<
			RepositoryCampaignRunLease["finish"]> {
			return { ...value, status, finishedAt: Date.now() }
		},
	}
}

export function publishedRecord(): PublishedAdvisoryRecord {
	return {
		advisoryId: "CVE-2026-1262",
		snapshotSha256: digest("d"),
		sourceUrl: "https://osv.dev/vulnerability/CVE-2026-1262",
		summary: "Fixture published advisory",
		affectedRange: "< 1.0",
	}
}

function publishedSource(
	onPoll: () => void,
	record: PublishedAdvisoryRecord,
): RepositoryAdvisoryIntake {
	return {
		source: "osv-commit-query" as const,
		publicBaseRevision: "e".repeat(40),
		supportedAdvisoryIds: ["CVE-2026-1262"],
		async poll(): Promise<PublishedAdvisoryRecord[]> {
			onPoll()
			return [record]
		},
	}
}

export function publishedIntakeWorker(
	onPoll: () => void,
	record: PublishedAdvisoryRecord,
): RegisteredRepositoryWorker {
	return pipelineShell("live-cve", {
		...quietAdapters("busy lease must not dispatch"),
		advisoryIntake: publishedSource(onPoll, record),
	})
}

function blockedSource(
	onPoll: () => void,
): RepositoryAdvisoryIntake {
	return {
		source: "osv-commit-query" as const,
		publicBaseRevision: "e".repeat(40),
		supportedAdvisoryIds: ["CVE-2026-1262"],
		async verifySource(): Promise<void> {
			throw new Error("private Curl source pin changed")
		},
		async poll(): Promise<PublishedAdvisoryRecord[]> {
			onPoll()
			return []
		},
	}
}

export function blockedIntakeWorker(
	onPoll: () => void,
): RegisteredRepositoryWorker {
	return pipelineShell("live-cve", {
		...quietAdapters("changed source must not dispatch"),
		advisoryIntake: blockedSource(onPoll),
	})
}

export async function driveLeaseLifecycle(
	store: RepositoryCampaignStore,
	events: string[],
): Promise<void> {
	const terminal = await waitForTerminal(store)
	assert.equal(terminal.status, "succeeded")
	await awaitLeaseFinish(events)
	assert.deepEqual(events, [`acquire:${20 * 60_000}`, "intake",
		"worker", "evaluate", "deliver", "finish:succeeded"])
}

export async function driveBusyLeaseRetry(
	coordinator: RepositoryCampaignCoordinator,
	store: RepositoryCampaignStore,
	release: () => void,
): Promise<void> {
	await coordinator.tick()
	const queued = readStatus(await store.status()).jobs[0]
	assert.ok(queued)
	assert.equal(queued.status, "queued")
	release()
	await coordinator.tick()
	const retried = await waitForTerminal(store)
	assert.equal(retried.status, "succeeded",
		"a later poll retries lease acquisition")
	await coordinator.stop()
}

export async function drivePublishedIntake(
	coordinator: RepositoryCampaignCoordinator,
	store: RepositoryCampaignStore,
	polls: { count: number },
): Promise<void> {
	await coordinator.tick()
	const status = readStatus(await store.status())
	assert.equal(status.jobs.length, 1)
	assert.equal(status.intakeRecords.length, 1)
	assert.equal(status.intakeRecords[0].disposition, "eligible")
	await coordinator.tick()
	assert.equal(polls.count, 1,
		"unchanged source is quiet until the next bounded interval")
}

export async function driveRestartedIntake(
	store: RepositoryCampaignStore,
	worker: RegisteredRepositoryWorker,
	lease: RepositoryCampaignRunLease,
	record: PublishedAdvisoryRecord,
	polls: { count: number },
): Promise<void> {
	const restarted = new RepositoryCampaignCoordinator(store, [worker],
		100, lease)
	await restarted.tick()
	const status = readStatus(await store.status())
	assert.equal(polls.count, 2, "process restart resumes polling")
	assert.equal(status.jobs.length, 1,
		"persisted digest prevents duplicate dispatch after restart")
	assert.equal(status.intakeRecords[0].snapshotSha256,
		record.snapshotSha256)
	await restarted.stop()
}

export async function assertBlockedIntake(
	coordinator: RepositoryCampaignCoordinator,
	store: RepositoryCampaignStore,
	polls: number,
): Promise<void> {
	await coordinator.tick()
	const status = readStatus(await store.status())
	assert.equal(polls, 0,
		"private source identity is checked before ordinary OSV intake")
	assert.equal(status.jobs.length, 0)
	assert.equal(status.intakeRecords.length, 0)
	assert.equal(coordinator.intakeStatus(definition.id).state,
		"unavailable")
}
