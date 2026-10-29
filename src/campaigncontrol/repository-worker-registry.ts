import * as fs from "node:fs/promises"
import * as path from "node:path"
import type { RepositoryCampaignDefinition } from "./repository-campaigns.js"
import type { RegisteredRepositoryWorker } from "./repository-coordinator.js"
import type { RepositoryWorkerPipelineAdapters } from "./repository-worker-pipeline.js"
import { createRepositoryWorkerPipeline } from "./repository-worker-pipeline.js"
import { OsvCommitAdvisoryIntake } from "./repository-advisory-intake.js"
import type { RepositoryCampaignStore } from "./repository-campaigns.js"
import { createCurlRepositoryPipelineAdapters } from "./repository-curl-runtime.js"

const MAX_REGISTRY_BYTES = 64 * 1024
const MAX_REGISTRATIONS = 32
const PUBLIC_INTAKE_PINS: Readonly<Record<string, { publicBaseRevision: string; supportedAdvisoryIds: readonly string[] }>> = Object.freeze({
	"curl-92390-fixed-v1": { publicBaseRevision: "ce57339379d82d29637b4752979e54128b6b2348", supportedAdvisoryIds: ["CVE-2026-92390"] },
})

export interface RepositoryWorkerRegistration {
	campaignId: string
	repositoryId: string
	repository: string
	sourceRevision: string
	policySha256: string
	workerProfile: string
	recipeDigest: string
	evaluatorDigest: string
	model: string
	profileId: string
	pipelineAdapterId: string
	executionKind: "live-cve"
	reservation: { micros: number; tokens: number }
}

export interface RepositoryPipelineAdapterFactoryContext {
	store: RepositoryCampaignStore
}

export type RepositoryPipelineAdapterFactory = (registration: RepositoryWorkerRegistration, definition: RepositoryCampaignDefinition,
	context?: RepositoryPipelineAdapterFactoryContext) => RepositoryWorkerPipelineAdapters

/** Built-in production adapters are code-owned; a private registry only selects among them. */
export const BUILTIN_REPOSITORY_PIPELINE_ADAPTER_FACTORIES: ReadonlyMap<string, RepositoryPipelineAdapterFactory> = new Map([
	["curl-92390-private-runtime-v1", (registration, definition, context) => {
		if (!context) throw new Error("repository pipeline store context is unavailable")
		return createCurlRepositoryPipelineAdapters(registration, definition, context)
	}],
])

function boundedRegistration(value: unknown): value is RepositoryWorkerRegistration {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false
	const item = value as Record<string, unknown>
	return Object.keys(item).sort().join(",") === "campaignId,evaluatorDigest,executionKind,model,pipelineAdapterId,policySha256,profileId,recipeDigest,repository,repositoryId,reservation,sourceRevision,workerProfile" &&
		typeof item.campaignId === "string" && /^[a-z0-9][a-z0-9-]{1,62}$/.test(item.campaignId) &&
		typeof item.repositoryId === "string" && /^[a-z0-9][a-z0-9-]{1,62}$/.test(item.repositoryId) &&
		typeof item.repository === "string" && /^[A-Za-z0-9_.-]{1,39}\/[A-Za-z0-9_.-]{1,100}$/.test(item.repository) &&
		typeof item.sourceRevision === "string" && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(item.sourceRevision) &&
		typeof item.policySha256 === "string" && /^[a-f0-9]{64}$/.test(item.policySha256) &&
		typeof item.workerProfile === "string" && /^[a-z0-9][a-z0-9-]{1,62}$/.test(item.workerProfile) &&
		typeof item.recipeDigest === "string" && /^[a-f0-9]{64}$/.test(item.recipeDigest) &&
		typeof item.evaluatorDigest === "string" && /^[a-f0-9]{64}$/.test(item.evaluatorDigest) &&
		typeof item.model === "string" && /^[-A-Za-z0-9._:/]{1,160}$/.test(item.model) &&
		typeof item.profileId === "string" && /^[a-z0-9][a-z0-9-]{1,62}$/.test(item.profileId) &&
		typeof item.pipelineAdapterId === "string" && /^[a-z0-9][a-z0-9-]{1,62}$/.test(item.pipelineAdapterId) &&
		item.executionKind === "live-cve" && !!item.reservation && typeof item.reservation === "object" && !Array.isArray(item.reservation) &&
		Object.keys(item.reservation).sort().join(",") === "micros,tokens" &&
		Number.isSafeInteger((item.reservation as Record<string, unknown>).micros) && Number((item.reservation as Record<string, unknown>).micros) > 0 &&
		Number.isSafeInteger((item.reservation as Record<string, unknown>).tokens) && Number((item.reservation as Record<string, unknown>).tokens) > 0
}

/** Read owner-provisioned metadata. This file is not writable through any campaign API. */
export async function loadRepositoryWorkerRegistrations(filePath: string): Promise<RepositoryWorkerRegistration[]> {
	try {
		const file = await fs.lstat(filePath)
		const parent = await fs.lstat(path.dirname(filePath))
		if (!file.isFile() || file.isSymbolicLink() || file.size > MAX_REGISTRY_BYTES || (file.mode & 0o077) !== 0 ||
			(typeof process.getuid === "function" && file.uid !== process.getuid()) || !parent.isDirectory() || parent.isSymbolicLink() ||
			(parent.mode & 0o077) !== 0 || (typeof process.getuid === "function" && parent.uid !== process.getuid())) {
			throw new Error("repository worker registry must be a bounded owner-only file")
		}
		const parsed: unknown = JSON.parse(await fs.readFile(filePath, "utf8"))
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("repository worker registry is invalid")
		const registry = parsed as Record<string, unknown>
		if (Object.keys(registry).sort().join(",") !== "registrations,schemaVersion" || registry.schemaVersion !== 1 ||
			!Array.isArray(registry.registrations) || registry.registrations.length > MAX_REGISTRATIONS || !registry.registrations.every(boundedRegistration)) {
			throw new Error("repository worker registry is invalid")
		}
		const rows = registry.registrations as RepositoryWorkerRegistration[]
		const keys = new Set<string>()
		for (const row of rows) {
			const key = `${row.campaignId}:${row.pipelineAdapterId}`
			if (keys.has(key)) throw new Error("repository worker registry contains duplicates")
			keys.add(key)
		}
		return rows
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return []
		throw error
	}
}

/** Bind only code-owned factories to exact campaign/source/policy identities. */
export function bindRepositoryWorkerRegistrations(
	definitions: readonly RepositoryCampaignDefinition[],
	registrations: readonly RepositoryWorkerRegistration[],
	factories: ReadonlyMap<string, RepositoryPipelineAdapterFactory>,
	context?: RepositoryPipelineAdapterFactoryContext,
): RegisteredRepositoryWorker[] {
	const byId = new Map(definitions.map((definition) => [definition.id, definition]))
	return registrations.map((registration) => {
		const definition = byId.get(registration.campaignId)
		const factory = factories.get(registration.pipelineAdapterId)
		if (!definition || !factory || definition.repositoryId !== registration.repositoryId || definition.repository !== registration.repository ||
			definition.sourceRevision !== registration.sourceRevision || definition.workerProfile !== registration.workerProfile ||
			definition.policySha256 !== registration.policySha256 ||
			definition.recipeDigest !== registration.recipeDigest || definition.evaluatorDigest !== registration.evaluatorDigest ||
			definition.model !== registration.model || !definition.qualification.sourceAudited || !definition.qualification.workerQualified ||
			!definition.qualification.recipeQualified || !definition.qualification.evaluatorQualified || !definition.qualification.modelApproved ||
			!definition.qualification.dataApproved || !definition.qualification.accessApproved) {
			throw new Error("repository worker registration does not match an owner-qualified campaign")
		}
		const adapters = factory(structuredClone(registration), structuredClone(definition), context)
		if (adapters.executionKind !== "live-cve" || adapters.workerProfile !== registration.workerProfile || adapters.recipeDigest !== registration.recipeDigest ||
			adapters.evaluatorDigest !== registration.evaluatorDigest || adapters.model !== registration.model ||
			adapters.reservation.micros !== registration.reservation.micros || adapters.reservation.tokens !== registration.reservation.tokens) {
			throw new Error("code-owned repository pipeline factory returned an unbound adapter")
		}
		const worker = createRepositoryWorkerPipeline(adapters)
		const source = PUBLIC_INTAKE_PINS[registration.pipelineAdapterId]
		if (!source) return worker
		return { ...worker, advisoryIntake: { publicBaseRevision: source.publicBaseRevision,
			supportedAdvisoryIds: source.supportedAdvisoryIds, poll: () => new OsvCommitAdvisoryIntake().poll(source.publicBaseRevision) } }
	})
}
