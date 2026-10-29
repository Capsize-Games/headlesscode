import * as fs from "node:fs/promises"
import * as http from "node:http"
import * as path from "node:path"
import { CampaignControlStore, MAX_MONTHLY_BUDGET_MICROS, type CampaignControlState, type CampaignRun } from "./store.js"
import { CAMPAIGN_ADAPTER_FILE, CAMPAIGN_CONTROL_FILE, REPOSITORY_WORKER_REGISTRY_FILE } from "./paths.js"
import { mutateCampaignControlLocked } from "./authority.js"
import { loadCampaignAdapterConfig, readCampaignBudgetReport, readCampaignJobReport, type CampaignBudgetReport, type CampaignJobReport, type CampaignReadinessReport } from "./runner.js"
import { readCampaignRsiStatus, type CampaignRsiStatus } from "./rsi.js"
import { readProviderRsiStatus, type ProviderRsiStatus } from "./provider-rsi.js"
import { RepositoryCampaignStore, loadRepositoryCampaignDefinitions } from "./repository-campaigns.js"
import { repositoryProgressSnapshot, type FleetRepositoryBudgetSnapshot } from "./repository-progress.js"
import { RepositoryCampaignCoordinator, type RegisteredRepositoryWorker } from "./repository-coordinator.js"
import { bindRepositoryWorkerRegistrations, BUILTIN_REPOSITORY_PIPELINE_ADAPTER_FACTORIES, loadRepositoryWorkerRegistrations, type RepositoryPipelineAdapterFactory } from "./repository-worker-registry.js"
import { createRepositoryCampaignRunLease, type RepositoryCampaignRunLease, withCampaignDispatchFence } from "./repository-run-lease.js"
import { createRepositoryBudgetAuthorityReader } from "./repository-budget-authority.js"

export const CAMPAIGN_CONTROL_PORT = 4391
const MAX_BODY_BYTES = 4096
const MAX_STATIC_FILE_BYTES = 8 * 1024 * 1024
const ORIGIN_HOSTS = new Set(["127.0.0.1", "localhost"])
const MIME_TYPES: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".svg": "image/svg+xml",
	".png": "image/png",
	".ico": "image/x-icon",
}

export type CampaignMutation = "on" | "off" | "budget"

export interface CampaignControlApiView {
	control: Pick<CampaignControlState, "enabled" | "epoch" | "budgetLimitMicros" | "nextDueAt" | "activeRun" | "updatedAt">
	budget: CampaignBudgetReport & { limitMicros: number; remainingMicros: number; canAdmit: boolean }
	runs: Array<Pick<CampaignRun, "id" | "epoch" | "startedAt" | "expiresAt" | "finishedAt" | "status">>
	jobs: CampaignJobReport["jobs"]
	jobDetailsAvailable: boolean
	rsi: CampaignRsiStatus
	providerRsi: ProviderRsiStatus
	readiness: { available: false } | ({ available: true } & CampaignReadinessReport)
}

function readinessProjection(report?: CampaignReadinessReport | null): CampaignControlApiView["readiness"] {
	return report ? { available: true, ...report } : { available: false }
}

export interface CampaignControlServerOptions {
	/** Production is fixed to loopback; test ports may use an ephemeral value. */
	port?: number
	staticRoot: string
	controlPath?: string
	adapterPath?: string
	token?: string
	store?: CampaignControlStore
	loadAdapter?: (file: string) => ReturnType<typeof loadCampaignAdapterConfig>
	readBudget?: (adapter: Awaited<ReturnType<typeof loadCampaignAdapterConfig>>) => Promise<CampaignBudgetReport>
	readJobs?: (adapter: Awaited<ReturnType<typeof loadCampaignAdapterConfig>>) => Promise<CampaignJobReport>
	readRsi?: () => Promise<CampaignRsiStatus>
	readProviderRsi?: () => Promise<ProviderRsiStatus>
	mutate?: (action: CampaignMutation, micros?: number) => Promise<CampaignControlState>
	repositoryCampaigns?: RepositoryCampaignStore
	readRepositoryBudgetSnapshot?: (campaignId: string) => Promise<FleetRepositoryBudgetSnapshot>
	repositoryCampaignStatePath?: string
	repositoryCampaignRegistryPath?: string
	repositoryWorkerRegistryPath?: string
	repositoryPipelineAdapterFactories?: ReadonlyMap<string, RepositoryPipelineAdapterFactory>
	/** Enables the bounded repository poller. Production registration must be explicit; the default is no workers. */
	enableRepositoryCoordinator?: boolean
	repositoryWorkers?: readonly RegisteredRepositoryWorker[]
	repositoryRunLease?: RepositoryCampaignRunLease
}

function json(res: http.ServerResponse, status: number, body: unknown): void {
	res.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
		"cache-control": "no-store",
		"x-content-type-options": "nosniff",
	})
	res.end(JSON.stringify(body))
}

function parseUsdMicros(value: unknown): number | undefined {
	if (typeof value !== "string" || !/^(?:[0-4](?:\.\d{1,6})?|5(?:\.0{1,6})?)$/.test(value)) return undefined
	const [whole, fraction = ""] = value.split(".")
	const micros = Number(whole) * 1_000_000 + Number(fraction.padEnd(6, "0"))
	return Number.isSafeInteger(micros) && micros <= MAX_MONTHLY_BUDGET_MICROS ? micros : undefined
}

async function readBody(req: http.IncomingMessage): Promise<unknown> {
	const contentType = req.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase()
	if (contentType !== "application/json") throw new Error("content-type")
	const declared = req.headers["content-length"]
	if (declared !== undefined && (!/^\d+$/.test(declared) || Number(declared) > MAX_BODY_BYTES)) throw new Error("size")
	const chunks: Buffer[] = []
	let total = 0
	for await (const chunk of req) {
		const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
		total += bytes.length
		if (total > MAX_BODY_BYTES) throw new Error("size")
		chunks.push(bytes)
	}
	try { return JSON.parse(Buffer.concat(chunks).toString("utf8")) }
	catch { throw new Error("json") }
}

function safeRuns(rows: CampaignRun[]): CampaignControlApiView["runs"] {
	return rows.slice(-100).flatMap((row) => {
		if (!row || !/^[0-9a-f-]{36}$/.test(row.id) || !Number.isSafeInteger(row.epoch) ||
			![row.startedAt, row.expiresAt].every(Number.isSafeInteger) ||
			(row.finishedAt !== undefined && !Number.isSafeInteger(row.finishedAt)) ||
			!["succeeded", "failed", "interrupted"].includes(row.status)) return []
		return [{ id: row.id, epoch: row.epoch, startedAt: row.startedAt, expiresAt: row.expiresAt,
			...(row.finishedAt !== undefined ? { finishedAt: row.finishedAt } : {}), status: row.status }]
	})
}

export async function readCampaignControlView(
	store: CampaignControlStore,
	options: Pick<CampaignControlServerOptions, "adapterPath" | "loadAdapter" | "readBudget" | "readJobs" | "readRsi" | "readProviderRsi"> = {},
): Promise<CampaignControlApiView> {
	const loadAdapter = options.loadAdapter ?? loadCampaignAdapterConfig
	const readBudget = options.readBudget ?? readCampaignBudgetReport
	const adapter = await loadAdapter(options.adapterPath ?? CAMPAIGN_ADAPTER_FILE)
	const [status, actual, jobs, rsi, providerRsi] = await Promise.all([store.status(), readBudget(adapter),
		(options.readJobs ?? readCampaignJobReport)(adapter), (options.readRsi ?? readCampaignRsiStatus)(), (options.readProviderRsi ?? readProviderRsiStatus)()])
	const { control } = status
	if (actual.month !== control.month) throw new Error("campaign budget report is for a different month")
	const committed = actual.settledMicros + actual.reservedMicros + actual.ambiguousMicros
	return {
		control: { enabled: control.enabled, epoch: control.epoch,
			budgetLimitMicros: control.budgetLimitMicros, nextDueAt: control.nextDueAt,
			activeRun: control.activeRun, updatedAt: control.updatedAt },
		budget: { ...actual, limitMicros: control.budgetLimitMicros,
			remainingMicros: Math.max(0, control.budgetLimitMicros - committed),
			canAdmit: control.enabled && control.budgetLimitMicros > committed },
		runs: safeRuns(status.runs),
		jobs: jobs.jobs,
		jobDetailsAvailable: jobs.jobDetailsAvailable,
		rsi,
		providerRsi,
		readiness: readinessProjection(jobs.readiness),
	}
}

async function trustedStaticFile(root: string, pathname: string): Promise<{ bytes: Buffer; contentType: string } | null> {
	let relative: string
	if (pathname === "/" || pathname === "/index.html") relative = "index.html"
	else {
		const match = /^\/assets\/([A-Za-z0-9._-]{1,160})$/.exec(pathname)
		if (!match) return null
		const assetsInfo = await fs.lstat(path.join(root, "assets"))
		if (!assetsInfo.isDirectory() || assetsInfo.isSymbolicLink() ||
			(typeof process.getuid === "function" && assetsInfo.uid !== process.getuid())) return null
		relative = path.join("assets", match[1])
	}
	const file = path.join(root, relative)
	const stat = await fs.lstat(file)
	if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_STATIC_FILE_BYTES ||
		(typeof process.getuid === "function" && stat.uid !== process.getuid())) return null
	const bytes = await fs.readFile(file)
	if (bytes.length > MAX_STATIC_FILE_BYTES) return null
	const extension = path.extname(file).toLowerCase()
	return { bytes, contentType: MIME_TYPES[extension] ?? "application/octet-stream" }
}

async function validateStaticRoot(root: string): Promise<string> {
	if (!path.isAbsolute(root)) throw new Error("campaign UI build root must be absolute")
	const canonical = await fs.realpath(root)
	const stat = await fs.lstat(canonical)
	if (!stat.isDirectory() || stat.isSymbolicLink() ||
		(typeof process.getuid === "function" && stat.uid !== process.getuid())) {
		throw new Error("campaign UI build root is not an owned directory")
	}
	return canonical
}

function allowedHost(hostHeader: string | undefined, port: number): boolean {
	if (!hostHeader) return false
	try {
		const parsed = new URL(`http://${hostHeader}`)
		return ORIGIN_HOSTS.has(parsed.hostname) && parsed.port === String(port)
	} catch { return false }
}

function repositoryStatusWithRuntime(status: Record<string, unknown>, store: RepositoryCampaignStore,
	coordinator?: RepositoryCampaignCoordinator): Record<string, unknown> {
	if (!coordinator || !Array.isArray(status.campaigns)) return status
	const definitions = new Map(store.registeredDefinitions().map((definition) => [definition.id, definition]))
	const intakeRecords = Array.isArray(status.intakeRecords) ? status.intakeRecords as Array<Record<string, unknown>> : []
	const campaigns = status.campaigns.map((value) => {
		if (!value || typeof value !== "object" || Array.isArray(value)) return value
		const row = value as Record<string, unknown>
		const definition = definitions.get(String(row.id))
		if (!definition) return row
		const runtime = coordinator.readiness(definition)
		const reasons = Array.isArray(row.readinessReasons) ? row.readinessReasons.filter((reason): reason is string => typeof reason === "string") : []
		const sourceStatus = coordinator.intakeStatus(definition.id)
		const scopedRecords = intakeRecords.filter((record) => record.campaignId === definition.id)
		const intake = { ...sourceStatus, eligibleRecords: scopedRecords.filter((record) => record.disposition === "eligible").length,
			unsupportedRecords: scopedRecords.filter((record) => record.disposition === "unsupported-profile").length }
		if (runtime.state === "ready") return { ...row, advisoryIntake: intake }
		return { ...row, advisoryIntake: intake, state: runtime.state, readiness: runtime.state,
			readinessReasons: [...new Set([...reasons, ...runtime.reasons])].slice(0, 32) }
	})
	return { ...status, campaigns }
}

function repositoryResponseMetadata(coordinator?: RepositoryCampaignCoordinator): Record<string, unknown> {
	if (coordinator?.activityMode() === "registered-live-cve") return { mode: "registered-live-cve", controlPlaneOnly: false }
	return { mode: "offline-synthetic-only", modelCalls: 0, controlPlaneOnly: true }
}

async function handleRequest(
	req: http.IncomingMessage,
	res: http.ServerResponse,
	options: CampaignControlServerOptions,
	staticRoot: string,
	store: CampaignControlStore,
	port: number,
	repositoryCoordinator?: RepositoryCampaignCoordinator,
): Promise<void> {
	const host = req.headers.host
	if (!allowedHost(host, port)) { json(res, 421, { error: "host is not served here" }); return }
	const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`)
	const origin = req.headers.origin
	if (origin !== undefined) {
		let parsed: URL
		try { parsed = new URL(origin) } catch { json(res, 403, { error: "origin is not allowed" }); return }
		if (parsed.protocol !== "http:" || !ORIGIN_HOSTS.has(parsed.hostname) || parsed.port !== String(port) ||
			parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) {
			json(res, 403, { error: "origin is not allowed" }); return
		}
	}
	if (options.token && url.pathname.startsWith("/api/") && req.headers.authorization !== `Bearer ${options.token}`) {
		json(res, 401, { error: "authorization is required" }); return
	}
	if (url.pathname === "/api/campaign-control") {
		if (url.search || url.hash) { json(res, 400, { error: "query parameters are not supported" }); return }
		if (req.method === "GET") {
			try { json(res, 200, await readCampaignControlView(store, options)) }
			catch { json(res, 503, { error: "campaign control status is unavailable" }) }
			return
		}
		if (req.method !== "POST") { res.writeHead(405, { allow: "GET, POST" }).end(); return }
		let body: unknown
		try { body = await readBody(req) }
		catch (error) {
			const reason = error instanceof Error ? error.message : "json"
			json(res, reason === "size" ? 413 : 400, { error: reason === "content-type" ? "application/json is required" : "request body is invalid" })
			return
		}
		if (!body || typeof body !== "object" || Array.isArray(body)) { json(res, 400, { error: "request body is invalid" }); return }
		const value = body as Record<string, unknown>
		let action: CampaignMutation
		let micros: number | undefined
		if (value.action === "on" || value.action === "off") {
			if (Object.keys(value).length !== 1) { json(res, 400, { error: "request fields are invalid" }); return }
			action = value.action
		} else if (value.action === "budget") {
			if (Object.keys(value).length !== 2 || !Object.hasOwn(value, "budgetUsd")) {
				json(res, 400, { error: "request fields are invalid" }); return
			}
			micros = parseUsdMicros(value.budgetUsd)
			if (micros === undefined) { json(res, 400, { error: "budget must be between $0 and $5 with up to six decimal places" }); return }
			action = "budget"
		} else { json(res, 400, { error: "action is not supported" }); return }
		let updated: CampaignControlState
		try { updated = await (options.mutate ?? mutateCampaignControlLocked)(action, micros) }
		catch {
			json(res, 409, { error: "campaign control change could not be applied; current state was retained" })
			return
		}
		try { json(res, 200, await readCampaignControlView(store, options)) }
		catch {
			json(res, 503, { error: "campaign control changed, but the current budget report is unavailable; reload before making another change",
				actionApplied: true, control: { enabled: updated.enabled, epoch: updated.epoch,
					budgetLimitMicros: updated.budgetLimitMicros, nextDueAt: updated.nextDueAt } })
		}
		return
	}
	const evidenceRoute = /^\/api\/repository-campaigns\/([a-z0-9][a-z0-9-]{1,62})\/jobs\/([0-9a-f-]{36})\/evidence\/([a-f0-9]{64})$/.exec(url.pathname)
	if (evidenceRoute) {
		if (req.method !== "GET") { res.writeHead(405, { allow: "GET" }).end(); return }
		if (url.search || url.hash) { json(res, 400, { error: "evidence query parameters are not supported" }); return }
		const repoStore = options.repositoryCampaigns
		if (!repoStore) { json(res, 503, { error: "repository campaign registry is unavailable" }); return }
		try {
			const status = await repoStore.status()
			const campaign = (status.campaigns as Array<Record<string, unknown>>).find((row) => row.id === evidenceRoute[1])
			if (!campaign) { json(res, 404, { error: "repository campaign is not registered" }); return }
			const job = (status.jobs as Array<Record<string, unknown>>).find((row) => row.id === evidenceRoute[2] && row.campaignId === evidenceRoute[1])
			if (!job) { json(res, 404, { error: "campaign job evidence is unavailable" }); return }
			const progress = job.progress as { evidenceRefs?: Array<{ id: string; kind: string; label: string }> } | undefined
			const evidence = progress?.evidenceRefs?.find((item) => item.id === evidenceRoute[3])
			if (!evidence) { json(res, 404, { error: "campaign job evidence is unavailable" }); return }
			json(res, 200, { schemaVersion: 1, campaignId: evidenceRoute[1], jobId: evidenceRoute[2], evidence })
		} catch { json(res, 503, { error: "repository campaign evidence is unavailable" }) }
		return
	}
	const repositoryCampaignRoute = /^\/api\/repository-campaigns(?:\/([a-z0-9][a-z0-9-]{1,62})(?:\/(history|progress))?)?$/.exec(url.pathname)
	if (repositoryCampaignRoute) {
		if (url.hash) { json(res, 400, { error: "fragments are not supported" }); return }
		const repoStore = options.repositoryCampaigns
		if (!repoStore) { json(res, 503, { error: "repository campaign registry is unavailable" }); return }
		if (req.method === "GET") {
			try {
				const status = repositoryStatusWithRuntime(await repoStore.status(), repoStore, repositoryCoordinator)
				if (repositoryCampaignRoute[2] === "history") {
					if ([...url.searchParams.keys()].some((key) => !["cursor", "limit"].includes(key))) { json(res, 400, { error: "history query fields are invalid" }); return }
					const cursorRaw = url.searchParams.get("cursor") ?? "0", limitRaw = url.searchParams.get("limit") ?? "50"
					const cursor = Number(cursorRaw), limit = Number(limitRaw)
					if (!/^\d{1,6}$/.test(cursorRaw) || !/^\d{1,3}$/.test(limitRaw) || limit < 1 || limit > 100 || cursor > 200 ||
						url.searchParams.getAll("cursor").length > 1 || url.searchParams.getAll("limit").length > 1) { json(res, 400, { error: "history cursor or limit is invalid" }); return }
					let page
					try { page = await repoStore.historyPage(repositoryCampaignRoute[1]!, cursor, limit) }
					catch (error) {
						if (error instanceof Error && error.message === "repository campaign is not registered") { json(res, 404, { error: error.message }); return }
						if (error instanceof Error && error.message === "history cursor is out of range") { json(res, 400, { error: error.message }); return }
						throw error
					}
					json(res, 200, { ...repositoryResponseMetadata(repositoryCoordinator), campaignId: repositoryCampaignRoute[1], ...page }); return
				}
				if (repositoryCampaignRoute[2] === "progress") {
					if (url.search) { json(res, 400, { error: "progress query parameters are not supported" }); return }
					const id = repositoryCampaignRoute[1]!
					const campaign = (status.campaigns as Array<Record<string, unknown>>).find((row) => row.id === id)
					if (!campaign) { json(res, 404, { error: "repository campaign is not registered" }); return }
					const definition = campaign as unknown as import("./repository-campaigns.js").RepositoryCampaignDefinition
					const jobs = (status.jobs as import("./repository-campaigns.js").RepositoryCampaignJob[]).filter((job) => job.campaignId === id)
					const observedAt = Date.now()
					let fleetBudget: FleetRepositoryBudgetSnapshot | undefined
					try { fleetBudget = await options.readRepositoryBudgetSnapshot?.(id) } catch { /* status remains explicit as unavailable */ }
					const runtimeReadiness = repositoryCoordinator?.readiness(definition)
					json(res, 200, repositoryProgressSnapshot(definition, campaign, jobs, observedAt, { fleetBudget, runtimeReadiness })); return
				}
				if (repositoryCampaignRoute[1]) {
					if (url.search) { json(res, 400, { error: "detail query parameters are not supported" }); return }
					const campaigns = status.campaigns as Array<Record<string, unknown>>
					const drafts = status.drafts as Array<Record<string, unknown>>
					const item = campaigns.find((row) => row.id === repositoryCampaignRoute[1]) ?? drafts.find((row) => row.id === repositoryCampaignRoute[1])
					if (!item) { json(res, 404, { error: "repository campaign is not registered" }); return }
					json(res, 200, { ...repositoryResponseMetadata(repositoryCoordinator), campaign: item }); return
				}
				if (url.search) { json(res, 400, { error: "list query parameters are not supported" }); return }
				json(res, 200, { ...repositoryResponseMetadata(repositoryCoordinator), ...status })
			}
			catch { json(res, 503, { error: "repository campaign status is unavailable" }) }
			return
		}
		if (repositoryCampaignRoute[1] && repositoryCampaignRoute[2]) { res.writeHead(405, { allow: "GET" }).end(); return }
		if (req.method !== "POST") { res.writeHead(405, { allow: "GET, POST" }).end(); return }
		let body: unknown
		try { body = await readBody(req) }
		catch (error) { const reason = error instanceof Error ? error.message : "json"; json(res, reason === "size" ? 413 : 400, { error: reason === "content-type" ? "application/json is required" : "request body is invalid" }); return }
		if (!body || typeof body !== "object" || Array.isArray(body)) { json(res, 400, { error: "request body is invalid" }); return }
		const value = body as Record<string, unknown>
		try {
			if (value.action === "create" && Object.keys(value).sort().join(",") === "action,id,name,repository" &&
				typeof value.id === "string" && typeof value.name === "string" && typeof value.repository === "string") {
				await repoStore.createDraft({ id: value.id, name: value.name, repository: value.repository })
			} else if (value.action === "configure" && Object.keys(value).sort().join(",") === "action,campaignId,requestedModelProfile,sourceRevision" &&
				typeof value.campaignId === "string" && typeof value.requestedModelProfile === "string" && typeof value.sourceRevision === "string") {
				await repoStore.configureDraft(value.campaignId, { sourceRevision: value.sourceRevision, requestedModelProfile: value.requestedModelProfile })
			} else if ((value.action === "start" || value.action === "stop") && Object.keys(value).sort().join(",") === "action,campaignId" && typeof value.campaignId === "string") {
				const campaignId = value.campaignId
				const definition = repoStore.registeredDefinitions().find((item) => item.id === campaignId)
				if (!definition) throw new Error("repository campaign is not registered")
				if (value.action === "start" && repositoryCoordinator) {
					const runtime = repositoryCoordinator.readiness(definition)
					if (runtime.state !== "ready") throw new Error(`campaign is blocked: ${runtime.reasons.join(", ")}`)
				}
				const mutation = async () => {
					if (value.action === "start") {
						const completeScope = Boolean(definition.repositoryId && definition.repository && typeof definition.sourceRevision === "string" &&
							/^[a-f0-9]{40}$/.test(definition.sourceRevision) && typeof definition.policySha256 === "string" && /^[a-f0-9]{64}$/.test(definition.policySha256))
						if (completeScope) await store.setRepositoryCampaign({ id: definition.id, repositoryId: definition.repositoryId!,
							sourceRevision: definition.sourceRevision!, policySha256: definition.policySha256! }, true)
						try { await repoStore.start(campaignId) }
						catch (error) { if (completeScope) await store.setRepositoryCampaign({ id: definition.id, repositoryId: definition.repositoryId!,
							sourceRevision: definition.sourceRevision!, policySha256: definition.policySha256! }, false).catch(() => undefined); throw error }
					} else {
						await repoStore.stop(campaignId)
						await store.disableRepositoryCampaign(campaignId)
				}
				}
				if (value.action === "start" && options.repositoryRunLease && path.resolve(store.path) === path.resolve(CAMPAIGN_CONTROL_FILE)) {
					const status = await repoStore.status()
					const campaign = (status.campaigns as Array<Record<string, unknown>>).find((item) => item.id === campaignId)
					if (!campaign) throw new Error("repository campaign is not registered")
					const run = campaign.enabled === true ? null : await options.repositoryRunLease.acquire(20 * 60_000)
					if (campaign.enabled !== true && !run) throw new Error("campaign is blocked: global-campaign-run-lease-unavailable")
					try { await withCampaignDispatchFence(store.path, mutation) }
					finally { if (run) await options.repositoryRunLease.finish(run, "succeeded").catch(() => undefined) }
				} else if (path.resolve(store.path) === path.resolve(CAMPAIGN_CONTROL_FILE)) await withCampaignDispatchFence(store.path, mutation)
				else await mutation()
			} else if (value.action === "budget" && Object.keys(value).sort().join(",") === "action,budgetMicros,budgetTokens,campaignId" &&
				typeof value.campaignId === "string" && Number.isSafeInteger(value.budgetMicros) && Number.isSafeInteger(value.budgetTokens)) {
				await repoStore.setCampaignBudget(value.campaignId, value.budgetMicros as number, value.budgetTokens as number)
			} else { json(res, 400, { error: "repository campaign action or fields are invalid" }); return }
			json(res, 200, { ...repositoryResponseMetadata(repositoryCoordinator), ...(await repoStore.status()) })
		} catch (error) {
			const message = error instanceof Error && (error.message === "repository campaign is not registered" || error.message === "repository draft is not registered" || error.message === "repository campaign is already registered" || error.message === "repository draft metadata is invalid" || error.message === "repository draft configuration is invalid" || error.message === "budget is outside the permitted range" ||
				error.message.startsWith("campaign is blocked:") || error.message === "campaign budget is below committed usage" ||
				error.message.startsWith("repository budgets exceed authoritative Fleet allocation") || error.message === "repository draft is not registered") ? error.message : "repository campaign change could not be applied"
			json(res, message === "repository campaign is not registered" ? 404 : 409, { error: message })
		}
		return
	}
	if (req.method !== "GET") { res.writeHead(405, { allow: "GET" }).end(); return }
	try {
		const pathname = decodeURIComponent(url.pathname)
		const asset = await trustedStaticFile(staticRoot, pathname)
		if (!asset) { res.writeHead(404, { "content-type": "text/plain; charset=utf-8" }).end("Not found"); return }
		res.writeHead(200, {
			"content-type": asset.contentType,
			"content-length": asset.bytes.length,
			"cache-control": url.pathname === "/" || url.pathname === "/index.html" ? "no-cache" : "public, max-age=31536000, immutable",
			"content-security-policy": "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; object-src 'none'; frame-ancestors 'none'",
			"x-content-type-options": "nosniff",
			"referrer-policy": "no-referrer",
		})
		res.end(asset.bytes)
	} catch {
		json(res, 404, { error: "requested content is unavailable" })
	}
}

export async function startCampaignControlServer(options: CampaignControlServerOptions): Promise<http.Server> {
	const port = options.port ?? CAMPAIGN_CONTROL_PORT
	if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("campaign control port is invalid")
	const staticRoot = await validateStaticRoot(options.staticRoot)
	const store = options.store ?? new CampaignControlStore(options.controlPath ?? CAMPAIGN_CONTROL_FILE)
	if (!options.repositoryCampaigns && options.repositoryCampaignRegistryPath) {
		const definitions = await loadRepositoryCampaignDefinitions(options.repositoryCampaignRegistryPath)
		const readAuthority = createRepositoryBudgetAuthorityReader(definitions, store.path)
		options.readRepositoryBudgetSnapshot ??= readAuthority as (campaignId: string) => Promise<FleetRepositoryBudgetSnapshot>
		options.repositoryCampaigns = new RepositoryCampaignStore(options.repositoryCampaignStatePath ?? `${options.repositoryCampaignRegistryPath}.state.json`, definitions, readAuthority)
	}
	if (options.repositoryCampaigns && path.resolve(store.path) === path.resolve(CAMPAIGN_CONTROL_FILE)) {
		const definitions = options.repositoryCampaigns.registeredDefinitions()
		if (definitions.length) await withCampaignDispatchFence(store.path, async () => {
			for (const definition of definitions) await store.registerRepositoryCampaign(definition)
		})
	}
	let repositoryCoordinator: RepositoryCampaignCoordinator | undefined
	if (options.enableRepositoryCoordinator && options.repositoryCampaigns) {
		const registrations = await loadRepositoryWorkerRegistrations(options.repositoryWorkerRegistryPath ?? REPOSITORY_WORKER_REGISTRY_FILE)
		const workers = options.repositoryWorkers ?? bindRepositoryWorkerRegistrations(options.repositoryCampaigns.registeredDefinitions(), registrations,
			options.repositoryPipelineAdapterFactories ?? BUILTIN_REPOSITORY_PIPELINE_ADAPTER_FACTORIES, { store: options.repositoryCampaigns })
		options.repositoryRunLease ??= (path.resolve(store.path) === path.resolve(CAMPAIGN_CONTROL_FILE)
			? createRepositoryCampaignRunLease(store.path) : undefined)
		repositoryCoordinator = new RepositoryCampaignCoordinator(options.repositoryCampaigns, workers, undefined, options.repositoryRunLease)
	}
	if (repositoryCoordinator) await repositoryCoordinator.start()
	let actualPort = port
	const server = http.createServer((req, res) => {
		void handleRequest(req, res, options, staticRoot, store, actualPort, repositoryCoordinator).catch(() => {
			if (!res.headersSent) json(res, 500, { error: "campaign control request failed" })
			else res.end()
		})
	})
	return new Promise((resolve, reject) => {
		server.once("error", reject)
		server.listen(port, "127.0.0.1", () => {
			server.removeListener("error", reject)
			const address = server.address()
			actualPort = address && typeof address !== "string" ? address.port : port
			if (repositoryCoordinator) server.once("close", () => { void repositoryCoordinator.stop() })
			resolve(server)
		})
	})
}
