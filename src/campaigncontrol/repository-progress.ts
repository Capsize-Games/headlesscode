import type {
	RepositoryCampaignDefinition,
	RepositoryCampaignJob,
} from "./repository-campaigns.js"
import { repositoryProgressBudget } from "./repository-progress-budget.js"
import {
	repositoryProgressCounts,
	repositoryProgressFreshness,
	repositoryProgressWorkers,
} from "./repository-progress-workers.js"
import type {
	FleetRepositoryBudgetSnapshot,
	RepositoryProgressSnapshot,
	RepositoryRuntimeReadiness,
} from "./repository-progress-types.js"

export type {
	FleetRepositoryBudgetSnapshot,
	ProgressFreshness,
	ProgressState,
	RepositoryProgressBudget,
	RepositoryProgressCounts,
	RepositoryProgressSnapshot,
	RepositoryProgressWorker,
	RepositoryRuntimeReadiness,
} from "./repository-progress-types.js"

type Readiness = RepositoryProgressSnapshot["readiness"]
type SnapshotOptions = {
	fleetBudget?: FleetRepositoryBudgetSnapshot
	runtimeReadiness?: RepositoryRuntimeReadiness
}
type SnapshotContext = {
	liveJobs: RepositoryCampaignJob[]
	developmentJobs: RepositoryCampaignJob[]
	visible: RepositoryCampaignJob[]
	freshness: RepositoryProgressSnapshot["freshness"]
	readiness: Readiness
}

function campaignState(value: unknown): RepositoryProgressSnapshot["state"] {
	const states: RepositoryProgressSnapshot["state"][] = [
		"ready", "running", "waiting", "stopped", "budget-exhausted",
		"blocked-prerequisite", "blocked-access",
	]
	return states.includes(value as RepositoryProgressSnapshot["state"])
		? value as RepositoryProgressSnapshot["state"]
		: "unavailable"
}

function readinessState(value: unknown): Readiness["state"] {
	const states: Readiness["state"][] = [
		"ready", "blocked-prerequisite", "blocked-access", "budget-exhausted",
	]
	return states.includes(value as Readiness["state"])
		? value as Readiness["state"]
		: "unavailable"
}

function readinessReasons(value: unknown): string[] {
	if (!Array.isArray(value)) return []
	return value.filter((reason): reason is string => typeof reason === "string")
}

function resolveReadiness(
	campaign: Record<string, unknown>,
	override?: RepositoryRuntimeReadiness,
): Readiness {
	const reasons = readinessReasons(campaign.readinessReasons)
	if (override && override.state !== "ready") {
		reasons.push(...override.reasons)
	}
	const state = override && override.state !== "ready"
		? override.state
		: readinessState(campaign.readiness)
	return { state, reasons: [...new Set(reasons)].slice(0, 32) }
}

function executionKind(
	liveJobs: RepositoryCampaignJob[],
	developmentJobs: RepositoryCampaignJob[],
): RepositoryProgressSnapshot["executionKind"] {
	if (liveJobs.length && developmentJobs.length) return "unavailable"
	if (liveJobs.length) return "live-cve"
	return developmentJobs.length ? "development-checkpoint" : "unavailable"
}

function visibleJobs(
	liveJobs: RepositoryCampaignJob[],
	developmentJobs: RepositoryCampaignJob[],
): RepositoryCampaignJob[] {
	return [...liveJobs, ...developmentJobs].slice(-100)
}

function snapshotState(
	readiness: Readiness,
	campaign: Record<string, unknown>,
): RepositoryProgressSnapshot["state"] {
	if (readiness.state === "blocked-prerequisite" ||
		readiness.state === "blocked-access") return readiness.state
	return campaignState(campaign.state)
}

export function repositoryProgressSnapshot(
	definition: RepositoryCampaignDefinition,
	campaign: Record<string, unknown>,
	jobs: RepositoryCampaignJob[],
	observedAt = Date.now(),
	options: SnapshotOptions = {},
): RepositoryProgressSnapshot {
	return buildSnapshot(definition, campaign, jobs, observedAt, options)
}

function buildSnapshot(
	definition: RepositoryCampaignDefinition,
	campaign: Record<string, unknown>,
	jobs: RepositoryCampaignJob[],
	observedAt: number,
	options: SnapshotOptions,
): RepositoryProgressSnapshot {
	const context = snapshotContext(
		jobs,
		campaign,
		observedAt,
		options.runtimeReadiness,
	)
	return renderSnapshot(definition, campaign, observedAt, options, context)
}

function snapshotContext(
	jobs: RepositoryCampaignJob[],
	campaign: Record<string, unknown>,
	observedAt: number,
	override?: RepositoryRuntimeReadiness,
): SnapshotContext {
	const liveJobs = jobs.filter((job) =>
		job.progress?.executionKind === "live-cve")
	const developmentJobs = jobs.filter((job) =>
		job.progress?.executionKind === "development-checkpoint")
	return {
		liveJobs,
		developmentJobs,
		visible: visibleJobs(liveJobs, developmentJobs),
		freshness: repositoryProgressFreshness(jobs, observedAt),
		readiness: resolveReadiness(campaign, override),
	}
}

function renderSnapshot(
	definition: RepositoryCampaignDefinition,
	campaign: Record<string, unknown>,
	observedAt: number,
	options: SnapshotOptions,
	context: SnapshotContext,
): RepositoryProgressSnapshot {
	return {
		...snapshotHeader(definition, context, observedAt),
		...snapshotStateFields(context, campaign),
		...snapshotRuntimeFields(
			definition,
			observedAt,
			options.fleetBudget,
			context,
		),
	}
}

function snapshotStateFields(
	context: SnapshotContext,
	campaign: Record<string, unknown>,
): Pick<RepositoryProgressSnapshot, "state" | "readiness" | "freshness"> {
	return {
		state: snapshotState(context.readiness, campaign),
		readiness: context.readiness,
		freshness: context.freshness,
	}
}

function snapshotRuntimeFields(
	definition: RepositoryCampaignDefinition,
	observedAt: number,
	budget: FleetRepositoryBudgetSnapshot | undefined,
	context: SnapshotContext,
): Pick<RepositoryProgressSnapshot, "budget" | "workers" | "counts"> {
	return {
		budget: repositoryProgressBudget(definition, budget, observedAt),
		workers: repositoryProgressWorkers(context.visible),
		counts: repositoryProgressCounts(
			context.visible,
			context.freshness.state,
		),
	}
}

function snapshotHeader(
	definition: RepositoryCampaignDefinition,
	context: SnapshotContext,
	observedAt: number,
): SnapshotHeader {
	return {
		schemaVersion: 1,
		campaignId: definition.id,
		executionKind: executionKind(
			context.liveJobs,
			context.developmentJobs,
		),
		observedAt,
		repository: {
			id: definition.id,
			name: definition.name,
			slug: definition.repository ?? null,
		},
	}
}

type SnapshotHeader = Pick<
	RepositoryProgressSnapshot,
	"schemaVersion" | "campaignId" | "executionKind" | "observedAt" | "repository"
>
