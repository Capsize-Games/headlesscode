import { spawn } from "node:child_process"
import * as fs from "node:fs"
import * as path from "node:path"
import { fileURLToPath } from "node:url"
import { CAMPAIGN_CONTROL_FILE, CAMPAIGN_CONTROL_ROOT } from "./paths.js"
import { prepareDispatchLock } from "./runner.js"
import type { ActiveCampaignRun, CampaignRun } from "./store.js"

export interface RepositoryCampaignRunLease {
	acquire(timeoutMs: number): Promise<ActiveCampaignRun | null>
	finish(run: ActiveCampaignRun, status: "succeeded" | "failed"): Promise<CampaignRun>
}

/** Hold the dispatch fence only while a local start/stop mutation is applied. */
export async function withCampaignDispatchFence<T>(controlPath: string, operation: () => Promise<T>): Promise<T> {
	if (path.resolve(controlPath) !== path.resolve(CAMPAIGN_CONTROL_FILE)) throw new Error("repository campaign mutation must use the configured control file")
	const loader = findTsxLoader()
	if (!loader) throw new Error("tsx runtime is unavailable")
	fs.mkdirSync(CAMPAIGN_CONTROL_ROOT, { recursive: true, mode: 0o700 })
	const info = fs.lstatSync(CAMPAIGN_CONTROL_ROOT)
	if (!info.isDirectory() || info.isSymbolicLink() || (typeof process.getuid === "function" && info.uid !== process.getuid())) throw new Error("campaign control root must be an owned real directory")
	fs.chmodSync(CAMPAIGN_CONTROL_ROOT, 0o700)
	const lock = await prepareDispatchLock(CAMPAIGN_CONTROL_FILE)
	const entry = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "cli.ts")
	const projectRoot = path.resolve(path.dirname(entry), "..")
	const child = spawn("/usr/bin/flock", ["-x", "-w", "2", lock, process.execPath, "--import", loader, entry, "campaign", "_repository-lock-hold"], {
		cwd: projectRoot, stdio: ["pipe", "pipe", "ignore"], detached: process.platform !== "win32", shell: false,
		env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: process.env.HOME, TSX_TSCONFIG_PATH: path.join(projectRoot, "tsconfig.json") },
	})
	let output = ""
	const locked = new Promise<void>((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error("campaign dispatch fence acquisition timed out")), 5_000)
		timer.unref()
		child.stdout?.on("data", (chunk: Buffer) => {
			output += chunk.toString("utf8")
			if (output.includes("LOCKED\n")) { clearTimeout(timer); resolve() }
			if (output.length > 1024) { clearTimeout(timer); reject(new Error("campaign dispatch fence handshake is invalid")) }
		})
		child.once("error", () => { clearTimeout(timer); reject(new Error("campaign dispatch fence could not start")) })
		child.once("exit", (code) => { clearTimeout(timer); if (!output.includes("LOCKED\n")) reject(new Error(code === 75 ? "campaign dispatch fence is busy" : "campaign dispatch fence failed")) })
	})
	try {
		await locked
		return await operation()
	} finally {
		child.stdin?.end("release\n")
		if (child.exitCode === null) await new Promise<void>((resolve) => child.once("exit", () => resolve()))
	}
}

function findTsxLoader(): string | undefined {
	let current = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")
	while (true) {
		const candidate = path.join(current, "node_modules", "tsx", "dist", "loader.mjs")
		if (fs.existsSync(candidate)) return candidate
		const parent = path.dirname(current)
		if (parent === current) return undefined
		current = parent
	}
}

/**
 * Run the short lease mutation helper under the same dispatch fence used by
 * global Stop. The helper exits immediately; no lock is inherited by workers.
 */
export function createRepositoryCampaignRunLease(controlPath = CAMPAIGN_CONTROL_FILE): RepositoryCampaignRunLease {
	if (path.resolve(controlPath) !== path.resolve(CAMPAIGN_CONTROL_FILE)) throw new Error("repository campaign run lease must use the configured control file")
	return {
		async acquire(timeoutMs) {
			if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 60_000 || timeoutMs > 30 * 60_000) throw new Error("repository campaign run lease duration is invalid")
			const value = await runLocked(["_repository-run-begin", String(timeoutMs)], 10_000)
			if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).join(",") !== "run") throw new Error("repository campaign run lease response is invalid")
			const run = (value as { run: unknown }).run
			if (run === null) return null
			if (!run || typeof run !== "object" || Array.isArray(run)) throw new Error("repository campaign run lease response is invalid")
			const candidate = run as ActiveCampaignRun
			if (!/^[0-9a-f-]{36}$/.test(candidate.id) || !Number.isSafeInteger(candidate.epoch) ||
				![candidate.startedAt, candidate.expiresAt].every(Number.isSafeInteger) || candidate.expiresAt <= Date.now() ||
				candidate.expiresAt - candidate.startedAt !== timeoutMs) throw new Error("repository campaign run lease response is invalid")
			return candidate
		},
		async finish(run, status) {
			const value = await runLocked(["_repository-run-finish", run.id, status], 5_000)
			if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).join(",") !== "run") throw new Error("repository campaign run completion is invalid")
			const completed = (value as { run: unknown }).run
			if (!completed || typeof completed !== "object" || Array.isArray(completed) ||
				(completed as CampaignRun).id !== run.id || (completed as CampaignRun).status !== status) throw new Error("repository campaign run completion is invalid")
			return completed as CampaignRun
		},
	}
}

async function runLocked(args: string[], timeoutMs: number): Promise<unknown> {
	const loader = findTsxLoader()
	if (!loader) throw new Error("tsx runtime is unavailable")
	fs.mkdirSync(CAMPAIGN_CONTROL_ROOT, { recursive: true, mode: 0o700 })
	const root = fs.lstatSync(CAMPAIGN_CONTROL_ROOT)
	if (!root.isDirectory() || root.isSymbolicLink() || (typeof process.getuid === "function" && root.uid !== process.getuid())) {
		throw new Error("campaign control root must be an owned real directory")
	}
	fs.chmodSync(CAMPAIGN_CONTROL_ROOT, 0o700)
	const lock = await prepareDispatchLock(CAMPAIGN_CONTROL_FILE)
	const entry = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "cli.ts")
	const projectRoot = path.resolve(path.dirname(entry), "..")
	const child = spawn("/usr/bin/flock", ["-x", "-w", "2", lock, process.execPath, "--import", loader, entry, "campaign", ...args], {
		cwd: projectRoot, stdio: ["ignore", "pipe", "ignore"], detached: process.platform !== "win32", shell: false,
		env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: process.env.HOME, TSX_TSCONFIG_PATH: path.join(projectRoot, "tsconfig.json") },
	})
	return new Promise((resolve, reject) => {
		let output = ""
		let settled = false
		const finishError = () => { if (!settled) { settled = true; clearTimeout(timer); reject(new Error("repository campaign run lease operation failed")) } }
		const timer = setTimeout(() => {
			try { if (child.pid && process.platform !== "win32") process.kill(-child.pid, "SIGTERM"); else child.kill("SIGTERM") } catch { /* already exited */ }
			finishError()
		}, timeoutMs + 10_000)
		timer.unref()
		child.stdout?.on("data", (chunk: Buffer) => {
			if (Buffer.byteLength(output) + chunk.length > 4096) { finishError(); return }
			output += chunk.toString("utf8")
		})
		child.once("error", finishError)
		child.once("exit", (code) => {
			if (settled) return
			settled = true
			clearTimeout(timer)
			if (code !== 0) { reject(new Error("repository campaign run lease operation failed")); return }
			try { resolve(JSON.parse(output)) } catch { reject(new Error("repository campaign run lease response is invalid")) }
		})
	})
}
