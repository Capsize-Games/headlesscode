import { spawn as nodeSpawn, type ChildProcess } from "node:child_process"
import * as fs from "node:fs/promises"
import { createHash } from "node:crypto"
import * as path from "node:path"
import { fileURLToPath } from "node:url"
import { constants } from "node:fs"
import { CampaignControlStore } from "./store.js"

const FLOCK = "/usr/bin/flock"
const PYTHON = "/usr/bin/python3"
const FLEET_MODULE = "operations.campaign_pipeline"
const DEFAULT_TIMEOUT_MS = 5 * 60_000

export interface CampaignAdapterConfig {
	releaseRoot: string
	stateRoot: string
	releaseDigest: string
	timeoutMs?: number
}

export interface CampaignTickResult {
	status: "succeeded" | "failed" | "busy"
	runId?: string
	code?: number | null
	adapterStatus?: "ok" | "pending" | "degraded" | "busy" | "control-busy" | "error" | "invalid"
}

export interface CampaignBudgetReport {
	month: string
	settledMicros: number
	reservedMicros: number
	ambiguousMicros: number
}

export interface CampaignJobReport {
	jobs: Array<{ jobId: string; package: string; advisoryId: string; status: string; purpose?: "qualification"; resultDigest?: string; draftUrl?: string }>
	jobDetailsAvailable: boolean
	readiness?: CampaignReadinessReport | null
}

export interface CampaignReadinessReport {
	schemaVersion: 1
	configuredCount: number
	qualifiedCount: number
	profiles: Array<{ profileId: string; state: "qualified" | "qualification-pending" | "recipe-unqualified" | "evidence-unqualified" }>
	completion: { pendingHumanReview: number; pendingHumanApproval: number; failed: number; deliveryPending: number }
}

/** Strictly project a Python job report. Older releases lack readiness and stay unavailable. */
export function parseCampaignJobReport(raw: unknown): CampaignJobReport {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Fleet job report is invalid")
	const value = raw as Record<string, unknown>
	if (!Array.isArray(value.jobs) || value.jobs.length > 100 || typeof value.jobDetailsAvailable !== "boolean") {
		throw new Error("Fleet job report is invalid")
	}
	const jobs = value.jobs.map((rawJob): CampaignJobReport["jobs"][number] => {
		if (!rawJob || typeof rawJob !== "object" || Array.isArray(rawJob)) throw new Error("Fleet job report is invalid")
		const job = rawJob as Record<string, unknown>
		if (Object.keys(job).some((key) => !["jobId", "package", "advisoryId", "status", "purpose", "resultDigest", "draftUrl"].includes(key)) ||
			(job.purpose !== undefined && job.purpose !== "qualification") ||
			typeof job.jobId !== "string" || !/^fleet-campaign-[a-f0-9]{40}$/.test(job.jobId) ||
			typeof job.package !== "string" || !["curl", "libexpat", "libexpat1", "expat", "systemd"].includes(job.package) ||
			typeof job.advisoryId !== "string" || !/^CVE-\d{4}-\d{4,12}$/.test(job.advisoryId) ||
			typeof job.status !== "string" || !/^[a-z][a-z_-]{0,40}$/.test(job.status) ||
			(job.resultDigest !== undefined && (typeof job.resultDigest !== "string" || !/^[a-f0-9]{64}$/.test(job.resultDigest))) ||
			(job.draftUrl !== undefined && (typeof job.draftUrl !== "string" || !/^https:\/\/github\.com\/w4ffl35\/(curl|libexpat|systemd)\/pull\/[1-9]\d*$/.test(job.draftUrl)))) {
			throw new Error("Fleet job report is invalid")
		}
		return { jobId: job.jobId, package: job.package, advisoryId: job.advisoryId, status: job.status,
			...(job.purpose === "qualification" ? { purpose: "qualification" as const } : {}),
			...(job.resultDigest ? { resultDigest: job.resultDigest } : {}),
			...(job.draftUrl ? { draftUrl: job.draftUrl } : {}) }
	})
	const hasReadiness = Object.hasOwn(value, "readiness")
	if (Object.keys(value).some((key) => !["jobs", "jobDetailsAvailable", "readiness"].includes(key))) {
		throw new Error("Fleet job report has unexpected fields")
	}
	if (!hasReadiness || value.readiness === null) return { jobs, jobDetailsAvailable: value.jobDetailsAvailable }
	const candidate = value.readiness
	if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) throw new Error("Fleet readiness report is invalid")
	const readiness = candidate as Record<string, unknown>
	if (Object.keys(readiness).sort().join(",") !== "completion,configuredCount,profiles,qualifiedCount,schemaVersion" ||
		readiness.schemaVersion !== 1 || !Number.isSafeInteger(readiness.configuredCount) ||
		(readiness.configuredCount as number) < 0 || (readiness.configuredCount as number) > 100 ||
		!Number.isSafeInteger(readiness.qualifiedCount) || (readiness.qualifiedCount as number) < 0 ||
		(readiness.qualifiedCount as number) > (readiness.configuredCount as number) ||
		!Array.isArray(readiness.profiles) || readiness.profiles.length > 100) throw new Error("Fleet readiness report is invalid")
	const profiles = readiness.profiles as CampaignReadinessReport["profiles"]
	const profileIds = new Set<string>()
	for (const profile of profiles) {
		if (!profile || typeof profile.profileId !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,95}$/.test(profile.profileId) ||
			profileIds.has(profile.profileId) || !["qualified", "qualification-pending", "recipe-unqualified", "evidence-unqualified"].includes(profile.state) ||
			Object.keys(profile).sort().join(",") !== "profileId,state") throw new Error("Fleet profile coverage is invalid")
		profileIds.add(profile.profileId)
	}
	const completion = readiness.completion
	if (!completion || typeof completion !== "object" || Array.isArray(completion)) throw new Error("Fleet completion coverage is invalid")
	const completionRecord = completion as Record<string, unknown>
	if (Object.keys(completionRecord).sort().join(",") !== "deliveryPending,failed,pendingHumanApproval,pendingHumanReview" ||
		![completionRecord.pendingHumanReview, completionRecord.pendingHumanApproval, completionRecord.failed, completionRecord.deliveryPending]
			.every((count) => Number.isSafeInteger(count) && (count as number) >= 0 && (count as number) <= 100_000) ||
		profiles.length !== readiness.configuredCount ||
		profiles.filter((profile) => profile.state === "qualified").length !== readiness.qualifiedCount) {
		throw new Error("Fleet completion coverage is invalid")
	}
	return { jobs, jobDetailsAvailable: value.jobDetailsAvailable,
		readiness: readiness as unknown as CampaignReadinessReport }
}

export async function readCampaignJobReport(config: CampaignAdapterConfig): Promise<CampaignJobReport> {
	await verifyCampaignRelease(config)
	const child = spawnCampaign(PYTHON, ["-B", "-m", "operations.campaign_control", "job-report", "--state-root", config.stateRoot], {
		cwd: config.releaseRoot, env: { PATH: "/usr/bin:/bin", HOME: process.env.HOME, PYTHONPATH: config.releaseRoot },
		detached: false, stdio: ["ignore", "pipe", "ignore"], shell: false,
	})
	const result = await waitBoundedOutput(child, 5_000, 128 * 1024)
	if (result.code !== 0) throw new Error("Fleet job report did not complete")
	let value: unknown
	try { value = JSON.parse(result.stdout) } catch { throw new Error("Fleet job report is malformed") }
	return parseCampaignJobReport(value)
}

interface SpawnOptions {
	cwd: string
	env: NodeJS.ProcessEnv
	detached: boolean
	stdio: Array<"ignore" | "pipe" | number>
	shell: false
}

export type SpawnCampaign = (file: string, args: string[], options: SpawnOptions) => ChildProcess
const spawnCampaign: SpawnCampaign = (file, args, options) => nodeSpawn(file, args, options)

export async function prepareDispatchLock(controlPath: string): Promise<string> {
	const parent = path.dirname(controlPath)
	await fs.mkdir(parent, { recursive: true, mode: 0o700 })
	const info = await fs.lstat(parent)
	if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0 ||
		(typeof process.getuid === "function" && info.uid !== process.getuid())) throw new Error("campaign control directory must be private")
	const lockPath = path.join(parent, "campaign-dispatch.lock")
	const handle = await fs.open(lockPath, constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW, 0o600)
	try {
		const stat = await handle.stat()
		if (!stat.isFile() || stat.nlink !== 1 || (typeof process.getuid === "function" && stat.uid !== process.getuid())) {
			throw new Error("campaign dispatch lock must be an owned regular file")
		}
		await handle.chmod(0o600)
	} finally { await handle.close() }
	return lockPath
}

function canonicalRoot(value: string, name: string): string {
	if (!path.isAbsolute(value) || value.includes("\0")) throw new Error(name + " must be an absolute path")
	return path.normalize(value)
}

async function assertPinnedDirectory(value: string, name: string): Promise<void> {
	const stat = await fs.lstat(value)
	if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(name + " must be a real directory, not a symlink")
	if (name === "Fleet state root" && (stat.mode & 0o077) !== 0) throw new Error(name + " must be owner-only")
	if (await fs.realpath(value) !== value) throw new Error(name + " must use its canonical absolute path")
}

export async function loadCampaignAdapterConfig(filePath: string): Promise<CampaignAdapterConfig> {
	const stat = await fs.lstat(filePath)
	if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) throw new Error("Fleet adapter registration must be owner-only regular file")
	if (typeof process.getuid === "function" && stat.uid !== process.getuid()) throw new Error("Fleet adapter registration has the wrong owner")
	const parsed: unknown = JSON.parse(await fs.readFile(filePath, "utf8"))
	if (!parsed || typeof parsed !== "object") throw new Error("Fleet adapter registration is invalid")
	const value = parsed as Record<string, unknown>
	if (value.schemaVersion !== 1 || typeof value.releaseRoot !== "string" || typeof value.stateRoot !== "string" ||
		typeof value.releaseDigest !== "string" || !/^[a-f0-9]{64}$/.test(value.releaseDigest)) throw new Error("Fleet adapter registration failed schema validation")
	return { releaseRoot: value.releaseRoot, stateRoot: value.stateRoot, releaseDigest: value.releaseDigest }
}

export async function verifyCampaignRelease(config: CampaignAdapterConfig): Promise<void> {
	const root = canonicalRoot(config.releaseRoot, "Fleet release root")
	const rootStat = await fs.lstat(root)
	if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || (rootStat.mode & 0o222) !== 0) throw new Error("Fleet release root must be immutable")
	const manifestPath = path.join(root, "release-manifest.json")
	const manifestStat = await fs.lstat(manifestPath)
	if (!manifestStat.isFile() || manifestStat.isSymbolicLink() || manifestStat.size > 1_000_000 || (manifestStat.mode & 0o222) !== 0 ||
		(typeof process.getuid === "function" && manifestStat.uid !== process.getuid())) throw new Error("Fleet release manifest is not a bounded owned regular file")
	const manifestBytes = await fs.readFile(manifestPath)
	const parsed: unknown = JSON.parse(manifestBytes.toString("utf8"))
	if (!parsed || typeof parsed !== "object") throw new Error("Fleet release manifest is invalid")
	const manifest = parsed as Record<string, unknown>
	if (manifest.schema_version !== 1 || typeof manifest.work_target !== "string" || !path.isAbsolute(manifest.work_target) ||
		typeof manifest.aggregate_digest !== "string" || !/^[a-f0-9]{64}$/.test(manifest.aggregate_digest) ||
		!manifest.files || typeof manifest.files !== "object" || Array.isArray(manifest.files)) throw new Error("Fleet release manifest failed schema validation")
	const files = manifest.files as Record<string, unknown>
	const manifestKeys = Object.keys(manifest).sort().join(",")
	if (manifestKeys !== "aggregate_digest,files,schema_version,work_target") throw new Error("Fleet release manifest has unexpected fields")
	const canonical = canonicalJson({ files, work_target: manifest.work_target })
	const aggregate = createHash("sha256").update(canonical).digest("hex")
	if (aggregate !== manifest.aggregate_digest || aggregate !== config.releaseDigest || path.basename(root) !== aggregate) {
		throw new Error("Fleet release manifest digest does not match the registered immutable release")
	}
	const workLink = path.join(root, "work")
	const workStat = await fs.lstat(workLink)
	if (!workStat.isSymbolicLink() || await fs.realpath(workLink) !== manifest.work_target) throw new Error("Fleet release work link does not match the pinned target")
	const names = Object.keys(files)
	if (names.length > 100_000) throw new Error("Fleet release manifest contains too many files")
	const allowed = new Set<string>()
	for (const name of names) {
		if (name === "release-manifest.json" || name === "work" || name.startsWith("/") || name.includes("\\") ||
			name.split("/").some((part) => !part || part === "." || part === "..")) throw new Error("Fleet release manifest contains an unsafe path")
		if (typeof files[name] !== "string" || !/^[a-f0-9]{64}$/.test(files[name] as string)) throw new Error("Fleet release file digest is invalid")
		allowed.add(name)
	}
	let total = 0
	const found = new Set<string>()
	const walk = async (directory: string, relative = ""): Promise<void> => {
		for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
			const name = relative ? relative + "/" + entry.name : entry.name
			if (!relative && name === "release-manifest.json") continue
			if (!relative && name === "work") continue
			if (entry.isDirectory()) {
				const directoryStat = await fs.lstat(path.join(directory, entry.name))
				if ((directoryStat.mode & 0o222) !== 0) throw new Error("Fleet release directory is mutable")
				await walk(path.join(directory, entry.name), name)
				continue
			}
			if (!entry.isFile() || !allowed.has(name)) throw new Error("Fleet release contains an unmanifested or non-regular member")
			const filePath = path.join(root, name)
			const stat = await fs.lstat(filePath)
			if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o222) !== 0 || (typeof process.getuid === "function" && stat.uid !== process.getuid()) ||
				stat.size > 20 * 1024 * 1024 || (total += stat.size) > 200 * 1024 * 1024) throw new Error("Fleet release member exceeds its ownership or size bound")
			const bytes = await fs.readFile(filePath)
			if (createHash("sha256").update(bytes).digest("hex") !== files[name]) throw new Error("Fleet release member digest mismatch")
			found.add(name)
		}
	}
	await walk(root)
	if (found.size !== allowed.size) throw new Error("Fleet release manifest references a missing member")
}

export async function readCampaignBudgetReport(config: CampaignAdapterConfig, spawnImpl: SpawnCampaign = spawnCampaign): Promise<CampaignBudgetReport> {
	const releaseRoot = canonicalRoot(config.releaseRoot, "Fleet release root")
	const stateRoot = canonicalRoot(config.stateRoot, "Fleet state root")
	await assertPinnedDirectory(releaseRoot, "Fleet release root")
	await assertPinnedDirectory(stateRoot, "Fleet state root")
	await verifyCampaignRelease(config)
	const ledger = path.join(stateRoot, "campaign", "budget.sqlite3")
	const args = ["-B", "-m", "operations.campaign_control", "budget-report", "--ledger", ledger]
	const env: NodeJS.ProcessEnv = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: process.env.HOME, PYTHONPATH: releaseRoot }
	const child = spawnImpl(PYTHON, args, { cwd: releaseRoot, env, detached: false, stdio: ["ignore", "pipe", "ignore"], shell: false })
	const result = await waitBoundedOutput(child, 5_000, 4 * 1024)
	if (result.code !== 0) throw new Error("Fleet budget report did not complete")
	let value: unknown
	try { value = JSON.parse(result.stdout) } catch { throw new Error("Fleet budget report is malformed") }
	if (!value || typeof value !== "object") throw new Error("Fleet budget report is invalid")
	const report = value as Record<string, unknown>
	if (Object.keys(report).sort().join(",") !== "ambiguousMicros,month,reservedMicros,settledMicros" ||
		typeof report.month !== "string" || !/^\d{4}-(0[1-9]|1[0-2])$/.test(report.month) ||
		![report.settledMicros, report.reservedMicros, report.ambiguousMicros].every((amount) => Number.isSafeInteger(amount) && (amount as number) >= 0)) {
		throw new Error("Fleet budget report failed schema validation")
	}
	return report as unknown as CampaignBudgetReport
}

function canonicalJson(value: unknown): string {
	if (Array.isArray(value)) return "[" + value.map(canonicalJson).join(",") + "]"
	if (value && typeof value === "object") {
		const object = value as Record<string, unknown>
		return "{" + Object.keys(object).sort().map((key) => JSON.stringify(key) + ":" + canonicalJson(object[key])).join(",") + "}"
	}
	return JSON.stringify(value)
}

/** Acquire the global fence before creating the lease, then exec the fixed internal helper. */
export async function runCampaignTick(
	store: CampaignControlStore,
	config: CampaignAdapterConfig,
	spawnImpl: SpawnCampaign = spawnCampaign,
	timeoutMs = 10 * 60_000,
): Promise<CampaignTickResult> {
	const releaseRoot = canonicalRoot(config.releaseRoot, "Fleet release root")
	const stateRoot = canonicalRoot(config.stateRoot, "Fleet state root")
	if (!/^[a-f0-9]{64}$/.test(config.releaseDigest)) throw new Error("Fleet release digest is invalid")
	await assertPinnedDirectory(releaseRoot, "Fleet release root")
	await fs.mkdir(stateRoot, { recursive: true, mode: 0o700 })
	await assertPinnedDirectory(stateRoot, "Fleet state root")
	const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")
	const tsxLoader = path.join(projectRoot, "node_modules", "tsx", "dist", "loader.mjs")
	await fs.access(tsxLoader)
	const entry = path.join(projectRoot, "src", "cli.ts")
	const lockPath = await prepareDispatchLock(store.path)
	const args = ["-n", "-E", "75", lockPath, process.execPath, "--import", tsxLoader, entry, "campaign", "_adapter-tick"]
	const env = {
		PATH: process.env.PATH ?? "/usr/bin:/bin",
		HOME: process.env.HOME,
		TSX_TSCONFIG_PATH: path.join(projectRoot, "tsconfig.json"),
		HEADLESSCODE_CAMPAIGN_FLEET_RELEASE_ROOT: releaseRoot,
		HEADLESSCODE_CAMPAIGN_FLEET_STATE_ROOT: stateRoot,
		HEADLESSCODE_CAMPAIGN_FLEET_RELEASE_DIGEST: config.releaseDigest,
	}
	const child = spawnImpl(FLOCK, args, { cwd: projectRoot, env, detached: process.platform !== "win32", stdio: ["ignore", "ignore", "ignore"], shell: false })
	const code = await waitBounded(child, timeoutMs)
	if (code === 75) return { status: "busy", code }
	const latest = (await store.status()).runs.at(-1)
	const adapterStatus = /^fleet:(ok|pending|degraded|busy|control-busy|error)$/.exec(latest?.detail ?? "")?.[1] as CampaignTickResult["adapterStatus"]
	return { status: code === 0 ? "succeeded" : "failed", code, ...(adapterStatus ? { adapterStatus } : {}) }
}

/** Called only by the fixed helper process while its parent holds the global flock. */
export async function runFleetAdapterUnderLock(
	store: CampaignControlStore,
	config: CampaignAdapterConfig,
	spawnImpl: SpawnCampaign = spawnCampaign,
	now = new Date(),
): Promise<CampaignTickResult> {
	const releaseRoot = canonicalRoot(config.releaseRoot, "Fleet release root")
	const stateRoot = canonicalRoot(config.stateRoot, "Fleet state root")
	await assertPinnedDirectory(releaseRoot, "Fleet release root")
	await assertPinnedDirectory(stateRoot, "Fleet state root")
	const lockPath = path.join(path.dirname(store.path), "campaign-dispatch.lock")
	const lockFd = await findInheritedLockFd(lockPath)
	const run = await store.beginRunIfIdle(now, config.timeoutMs ?? DEFAULT_TIMEOUT_MS)
	if (!run) return { status: "busy", code: 75, adapterStatus: "busy" }
	const args = ["-B", "-m", FLEET_MODULE, "--state-root", stateRoot, "campaign-tick", "--control-state", store.path]
	const env: NodeJS.ProcessEnv = {
		PATH: process.env.PATH ?? "/usr/bin:/bin",
		HOME: process.env.HOME,
		PYTHONPATH: releaseRoot,
		HEADLESSCODE_CAMPAIGN_CONTROL_FILE: store.path,
		HEADLESSCODE_CAMPAIGN_LOCK_FD: String(lockFd),
		HEADLESSCODE_CAMPAIGN_RELEASE_DIGEST: config.releaseDigest,
	}
	const stdio: Array<"ignore" | "pipe" | number> = ["ignore", "pipe", "ignore"]
	while (stdio.length <= lockFd) stdio.push("ignore")
	stdio[lockFd] = lockFd
	const child = spawnImpl(PYTHON, args, { cwd: releaseRoot, env, detached: process.platform !== "win32", stdio, shell: false })
	const result = await waitBoundedOutput(child, config.timeoutMs ?? DEFAULT_TIMEOUT_MS, 16 * 1024)
	const adapterStatus = parseAdapterStatus(result.stdout)
	const successStatus = adapterStatus === "ok" || adapterStatus === "pending" || adapterStatus === "busy" || adapterStatus === "control-busy"
	const status = result.code === 0 && successStatus ? "succeeded" : "failed"
	const detail = adapterStatus ? "fleet:" + adapterStatus : "fleet:invalid"
	await store.finishRun(run.id, status, detail, new Date())
	return { status, runId: run.id, code: result.code, adapterStatus: adapterStatus ?? "invalid" }
}

export async function verifyCampaignDispatchLock(controlPath: string): Promise<number> {
	return findInheritedLockFd(path.join(path.dirname(path.resolve(controlPath)), "campaign-dispatch.lock"))
}

async function findInheritedLockFd(lockPath: string): Promise<number> {
	if (process.platform !== "linux") throw new Error("campaign tick requires Linux flock support")
	for (const name of await fs.readdir("/proc/self/fd")) {
		if (!/^\d+$/.test(name)) continue
		const fd = Number(name)
		const target = await fs.readlink("/proc/self/fd/" + name).catch(() => "")
		if (target === lockPath) return fd
	}
	throw new Error("campaign dispatch lock is not inherited by the fixed adapter helper")
}

function waitBounded(child: ChildProcess, timeoutMs: number): Promise<number | null> {
	return new Promise((resolve, reject) => {
		let settled = false
		let timedOut = false
		let killTimer: NodeJS.Timeout | undefined
		let hardTimer: NodeJS.Timeout | undefined
		const finish = (code: number | null) => {
			if (settled) return
			settled = true
			clearTimeout(timer)
			if (killTimer) clearTimeout(killTimer)
			if (hardTimer) clearTimeout(hardTimer)
			resolve(timedOut ? null : code)
		}
		child.once("error", (error) => {
			if (settled) return
			settled = true
			clearTimeout(timer)
			reject(error)
		})
		child.once("exit", (code) => finish(code))
		const timer = setTimeout(() => {
			if (settled) return
			timedOut = true
			try {
				if (child.pid && process.platform !== "win32") process.kill(-child.pid, "SIGTERM")
				else child.kill("SIGTERM")
			} catch { /* already exited */ }
			killTimer = setTimeout(() => {
				try {
					if (child.pid && process.platform !== "win32") process.kill(-child.pid, "SIGKILL")
					else child.kill("SIGKILL")
				} catch { /* already exited */ }
			}, 1_000)
			killTimer.unref()
			hardTimer = setTimeout(() => reject(new Error("campaign adapter process group did not exit after SIGKILL")), 5_000)
			hardTimer.unref()
		}, timeoutMs)
		timer.unref()
	})
}

function parseAdapterStatus(stdout: string): CampaignTickResult["adapterStatus"] | undefined {
	if (Buffer.byteLength(stdout, "utf8") > 16 * 1024) return undefined
	try {
		const parsed: unknown = JSON.parse(stdout)
		if (!parsed || typeof parsed !== "object") return undefined
		const status = (parsed as { status?: unknown }).status
		return status === "ok" || status === "pending" || status === "degraded" || status === "busy" ||
			status === "control-busy" || status === "error" ? status : undefined
	} catch { return undefined }
}

function waitBoundedOutput(child: ChildProcess, timeoutMs: number, maxBytes: number): Promise<{ code: number | null; stdout: string }> {
	return new Promise((resolve, reject) => {
		let settled = false
		let timedOut = false
		let stdout = ""
		let outputExceeded = false
		let killTimer: NodeJS.Timeout | undefined
		let hardTimer: NodeJS.Timeout | undefined
		const finish = (code: number | null) => {
			if (settled) return
			settled = true
			clearTimeout(timer)
			if (killTimer) clearTimeout(killTimer)
			if (hardTimer) clearTimeout(hardTimer)
			resolve({ code: timedOut || outputExceeded ? null : code, stdout })
		}
		child.stdout?.on("data", (chunk: Buffer | string) => {
			if (outputExceeded) return
			const next = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : chunk
			if (Buffer.byteLength(stdout + next, "utf8") > maxBytes) {
				outputExceeded = true
				try { if (child.pid) process.kill(-child.pid, "SIGTERM"); else child.kill("SIGTERM") } catch { /* already exited */ }
				return
			}
			stdout += next
		})
		child.once("error", (error) => { if (!settled) { settled = true; clearTimeout(timer); reject(error) } })
		child.once("exit", (code) => finish(code))
		const timer = setTimeout(() => {
			if (settled) return
			timedOut = true
			try { if (child.pid) process.kill(-child.pid, "SIGTERM"); else child.kill("SIGTERM") } catch { /* already exited */ }
			killTimer = setTimeout(() => { try { if (child.pid) process.kill(-child.pid, "SIGKILL"); else child.kill("SIGKILL") } catch { /* already exited */ } }, 1_000)
			killTimer.unref()
			hardTimer = setTimeout(() => reject(new Error("campaign adapter process group did not exit after SIGKILL")), 5_000)
			hardTimer.unref()
		}, timeoutMs)
		timer.unref()
	})
}
