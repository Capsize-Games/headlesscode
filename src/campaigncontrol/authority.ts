import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"
import { CampaignControlStore, MAX_MONTHLY_BUDGET_MICROS, type CampaignControlState } from "./store.js"
import { CAMPAIGN_CONTROL_FILE, CAMPAIGN_CONTROL_ROOT } from "./paths.js"
import { prepareDispatchLock } from "./runner.js"

export type CampaignMutationAction = "on" | "off" | "budget"

function findTsxCli(): string | undefined {
	let current = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")
	while (true) {
		const candidate = path.join(current, "node_modules", "tsx", "dist", "loader.mjs")
		if (fs.existsSync(candidate)) return candidate
		const parent = path.dirname(current)
		if (parent === current) return undefined
		current = parent
	}
}

function formatBudget(micros: number): string {
	const whole = Math.floor(micros / 1_000_000)
	const fraction = String(micros % 1_000_000).padStart(6, "0")
	return whole + "." + fraction
}

/** Apply control changes under the same flock held by the Fleet tick. */
export async function mutateCampaignControlLocked(action: CampaignMutationAction, micros?: number): Promise<CampaignControlState> {
	if (action === "budget" && (!Number.isSafeInteger(micros) || micros! < 0 || micros! > MAX_MONTHLY_BUDGET_MICROS)) {
		throw new Error("budget must be an integer from 0 to 5000000 micros")
	}
	const tsxCli = findTsxCli()
	if (!tsxCli) throw new Error("tsx runtime is unavailable")
	fs.mkdirSync(CAMPAIGN_CONTROL_ROOT, { recursive: true, mode: 0o700 })
	const controlStat = fs.lstatSync(CAMPAIGN_CONTROL_ROOT)
	if (!controlStat.isDirectory() || controlStat.isSymbolicLink() ||
		(typeof process.getuid === "function" && controlStat.uid !== process.getuid())) {
		throw new Error("campaign control root must be an owned real directory")
	}
	fs.chmodSync(CAMPAIGN_CONTROL_ROOT, 0o700)
	const lockPath = await prepareDispatchLock(CAMPAIGN_CONTROL_FILE)
	const entry = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "cli.ts")
	const projectRoot = path.resolve(path.dirname(entry), "..")
	const amount = action === "budget" ? formatBudget(micros!) : undefined
	const args = ["-x", "-w", "300", lockPath, process.execPath, "--import", tsxCli, entry, "campaign", "_apply", action, ...(amount ? [amount] : [])]
	const child = spawn("/usr/bin/flock", args, {
		cwd: projectRoot,
		stdio: ["ignore", "pipe", "ignore"],
		detached: process.platform !== "win32",
		shell: false,
		env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: os.homedir(), TSX_TSCONFIG_PATH: path.join(projectRoot, "tsconfig.json") },
	})
	return new Promise((resolve, reject) => {
		let stdout = ""
		let settled = false
		let timedOut = false
		const finishError = (error: Error) => {
			if (settled) return
			settled = true
			clearTimeout(timer)
			reject(error)
		}
		const timer = setTimeout(() => {
			timedOut = true
			try { if (child.pid && process.platform !== "win32") process.kill(-child.pid, "SIGTERM"); else child.kill("SIGTERM") } catch { /* already exited */ }
			const kill = setTimeout(() => { try { if (child.pid && process.platform !== "win32") process.kill(-child.pid, "SIGKILL"); else child.kill("SIGKILL") } catch { /* already exited */ } }, 1_000)
			kill.unref()
		}, 305_000)
		timer.unref()
		child.stdout?.on("data", (chunk: Buffer) => {
			if (Buffer.byteLength(stdout) + chunk.length > 16 * 1024) {
				try { if (child.pid && process.platform !== "win32") process.kill(-child.pid, "SIGTERM"); else child.kill("SIGTERM") } catch { /* already exited */ }
				finishError(new Error("campaign control result exceeded its output limit"))
				return
			}
			stdout += chunk.toString("utf8")
		})
		child.once("error", () => finishError(new Error("campaign control update could not start")))
		child.once("exit", async (code) => {
			if (settled) return
			settled = true
			clearTimeout(timer)
			if (timedOut) { reject(new Error("campaign control update timed out")); return }
			if (code !== 0) { reject(new Error("campaign control update failed or dispatch lock is busy")); return }
			try { resolve(await new CampaignControlStore(CAMPAIGN_CONTROL_FILE).snapshot()) }
			catch { reject(new Error("campaign control state could not be read after update")) }
		})
	})
}
