import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import type { RepositoryCampaignDefinition, RepositoryCampaignJob } from
	"./repository-campaigns.js"
import type { FleetRepositoryBudgetScope } from
	"../rsi/fleet-repository-budget-ledger.js"
import { CURL_REPAIR_V2_CAMPAIGN_ID } from "./repository-campaign-ids.js"
import * as profile from "./repository-curl-repair-v2-profile.js"
import { CURL_DEBIAN_SNAPSHOT_SHA256 } from "./repository-known-advisory.js"

export function isNoModelV2RecoveryScope(
	definition: RepositoryCampaignDefinition,
	scope: FleetRepositoryBudgetScope,
): boolean {
	return definition.id === CURL_REPAIR_V2_CAMPAIGN_ID &&
		scope.repositoryCampaignId === definition.id &&
		matchesDefinition(definition) && scope.model === "none" &&
		scope.profileId === "no-model" &&
		scope.repositoryId === definition.repositoryId &&
		scope.repository === definition.repository &&
		scope.sourceRevision === definition.sourceRevision &&
		scope.policySha256 === definition.policySha256
}

function matchesDefinition(definition: RepositoryCampaignDefinition): boolean {
	return definition.repositoryId === profile.CURL_REPAIR_V2_REPOSITORY_ID &&
		definition.repository === profile.CURL_REPAIR_V2_TARGET_REPOSITORY &&
		definition.sourceRevision === profile.CURL_REPAIR_V2_SOURCE_REVISION &&
		definition.policySha256 === profile.CURL_REPAIR_V2_POLICY_SHA256 &&
		definition.workerProfile === profile.CURL_REPAIR_V2_PROFILE_ID &&
		definition.recipeDigest === profile.CURL_REPAIR_V2_RECIPE_DIGEST &&
		definition.evaluatorDigest === profile.CURL_REPAIR_V2_EVALUATOR_DIGEST &&
		definition.model === "none"
}

export function isNoModelV2RecoveryJob(job: RepositoryCampaignJob): boolean {
	if (job.campaignId !== CURL_REPAIR_V2_CAMPAIGN_ID ||
		job.purpose !== "repair" || job.retryOf !== undefined ||
		job.advisoryId !== "CVE-2026-92390" || !job.progress ||
		job.progress.executionKind !== "live-cve") return false
	const refs = job.progress.evidenceRefs
	return refs.every((ref) =>
		["intake", "diagnostic", "no-call-proof"].includes(ref.kind)) &&
		refs.filter((ref) => ref.kind === "diagnostic").length === 1 &&
		refs.filter((ref) => ref.kind === "intake" &&
			ref.id === CURL_DEBIAN_SNAPSHOT_SHA256).length === 1
}

export function listCurlV2RecoveryContainers(
	job: RepositoryCampaignJob,
): string[] {
	const prepare = "fleet-curl-v2-" + hash(job.id).slice(0, 24)
	const attempt = hash(`${job.id}:${job.claimId}:${job.epoch}`).slice(0, 32)
	const result = spawnSync("docker", ["--host", "unix:///var/run/docker.sock",
		"ps", "-a", "--filter", `name=^${prepare}$`, "--filter",
		`name=^fleet-curl-${attempt}-candidate$`, "--format", "{{.Names}}"],
	{ encoding: "utf8", timeout: 10_000, maxBuffer: 4096,
		env: { PATH: "/usr/bin:/bin" } })
	if (result.error || result.status !== 0) {
		throw new Error("could not verify Curl v2 container cleanup")
	}
	return result.stdout.trim().split(/\r?\n/).filter(Boolean)
}

function hash(value: string): string {
	return createHash("sha256").update(value).digest("hex")
}
