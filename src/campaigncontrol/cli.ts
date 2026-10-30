import { campaignUsage, isCampaignAction } from "./campaign-usage.js"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { CampaignControlStore, MAX_MONTHLY_BUDGET_MICROS } from "./store.js"
import {
	loadCampaignAdapterConfig,
	readCampaignBudgetReport,
	runCampaignTick,
	verifyCampaignDispatchLock,
} from "./runner.js"
import { mutateCampaignControlLocked } from "./authority.js"
import {
	CAMPAIGN_ADAPTER_FILE,
	CAMPAIGN_CONTROL_FILE,
	REPOSITORY_CAMPAIGN_REGISTRY_FILE,
	REPOSITORY_CAMPAIGN_STATE_FILE,
	REPOSITORY_WORKER_REGISTRY_FILE,
} from "./paths.js"
import { readCampaignRsiStatus } from "./rsi.js"

type ParsedCommand = {
	action: string
	positional: string[]
	json: boolean
}

function parseBudget(dollars: string): number | undefined {
	if (!/^(?:0|[1-9]\d*)(?:\.\d{1,6})?$/.test(dollars)) return undefined
	const [whole, fraction = ""] = dollars.split(".")
	const micros = Number(whole) * 1_000_000 + Number(fraction.padEnd(6, "0"))
	if (!Number.isSafeInteger(micros) ||
		micros > MAX_MONTHLY_BUDGET_MICROS) return undefined
	return micros
}

function parseCommand(args: string[]): ParsedCommand | undefined {
	const [action, ...rest] = args
	if (!action || !isCampaignAction(action)) return undefined
	return {
		action,
		positional: rest.filter((arg) => arg !== "--json"),
		json: rest.includes("--json"),
	}
}

async function dispatchRepositoryAction(
	action: string,
	positional: string[],
): Promise<number | undefined> {
	const run = await import("./cli-run-coordination.js")
	const runResult = await run.handleAction(action, positional)
	if (runResult !== undefined) return runResult
	const repair = await import("./cli-repair-actions.js")
	const repairResult = await repair.handleAction(action, positional)
	if (repairResult !== undefined) return repairResult
	const recovery = await import("./cli-recovery-actions.js")
	return recovery.handleAction(action, positional)
}

async function startServer(positional: string[]): Promise<number> {
	if (positional.length) return 2
	const server = await import("./server.js")
	const staticRoot = path.join(
		os.homedir(),
		"Projects/capsize-web/apps/fleet-campaign-control/dist",
	)
	await server.startCampaignControlServer({
		staticRoot,
		repositoryCampaignRegistryPath: REPOSITORY_CAMPAIGN_REGISTRY_FILE,
		repositoryCampaignStatePath: REPOSITORY_CAMPAIGN_STATE_FILE,
		repositoryWorkerRegistryPath: REPOSITORY_WORKER_REGISTRY_FILE,
		enableRepositoryCoordinator: true,
	})
	process.stdout.write(`${JSON.stringify({
		status: "listening",
		url: "http://127.0.0.1:4391/",
	})}\n`)
	return 0
}

async function applyEnabled(
	store: CampaignControlStore,
	enabled: boolean,
): Promise<number> {
	if (enabled) {
		const adapter = await loadCampaignAdapterConfig(CAMPAIGN_ADAPTER_FILE)
		const report = await readCampaignBudgetReport(adapter)
		await store.updateBudgetProjection(report)
	}
	const control = await store.setEnabled(enabled)
	process.stdout.write(`${JSON.stringify(control, null, 2)}\n`)
	return 0
}

function assertBudgetNotBelowCommitted(	micros: number, committed: number,
): void {
	if (micros >= committed) return
	throw new Error(
		"budget cannot be lowered below settled, reserved, or " +
		"ambiguous monthly spend",
	)
}

async function applyBudget(
	store: CampaignControlStore,
	amount: string,
): Promise<number> {
	const micros = parseBudget(amount)
	if (micros === undefined) return 2
	const adapter = await loadCampaignAdapterConfig(CAMPAIGN_ADAPTER_FILE)
	const projection = await readCampaignBudgetReport(adapter)
	await store.updateBudgetProjection(projection)
	const committed = projection.settledMicros + projection.reservedMicros +
		projection.ambiguousMicros
	assertBudgetNotBelowCommitted(micros, committed)
	const control = await store.setBudgetLimit(micros)
	process.stdout.write(`${JSON.stringify(control, null, 2)}\n`)
	return 0
}

async function applyCommand(positional: string[]): Promise<number> {
	if (positional.length < 1 || positional.length > 2) return 2
	const store = new CampaignControlStore(CAMPAIGN_CONTROL_FILE)
	await verifyCampaignDispatchLock(CAMPAIGN_CONTROL_FILE)
	if (positional.length === 1 && positional[0] === "on") {
		return applyEnabled(store, true)
	}
	if (positional.length === 1 && positional[0] === "off") {
		return applyEnabled(store, false)
	}
	if (positional.length === 2 && positional[0] === "budget") {
		return applyBudget(store, positional[1]!)
	}
	return 2
}

function invalidControlArguments(
	action: string,
	positional: string[],
): boolean {
	if (action === "status" && positional.length) return true
	if ((action === "on" || action === "off") && positional.length) return true
	if (action === "tick" && positional.length) return true
	return action === "budget" &&
		(positional.length !== 2 || positional[0] !== "--usd")
}

async function runToggle(action: "on" | "off", json: boolean): Promise<number> {
	const control = await mutateCampaignControlLocked(action)
	process.stdout.write(`${JSON.stringify(control, null, json ? 0 : 2)}\n`)
	return 0
}

async function runBudget(positional: string[], json: boolean): Promise<number> {
	const micros = parseBudget(positional[1]!)
	if (micros === undefined) {
		process.stderr.write(
			"budget must be a decimal USD amount from $0 to $5.00 " +
			"(up to six decimal places)\n",
		)
		return 2
	}
	const control = await mutateCampaignControlLocked("budget", micros)
	process.stdout.write(`${JSON.stringify(control, null, json ? 0 : 2)}\n`)
	return 0
}

async function runTick(
	store: CampaignControlStore,
	json: boolean,
): Promise<number> {
	const adapter = await loadCampaignAdapterConfig(CAMPAIGN_ADAPTER_FILE)
	const result = await runCampaignTick(store, adapter)
	const control = await store.snapshot()
	const output = JSON.stringify({ ...result, control }, null, json ? 0 : 2)
	process.stdout.write(`${output}\n`)
	return result.status === "failed" ? 1 : 0
}

async function runStatus(
	store: CampaignControlStore,
	json: boolean,
): Promise<number> {
	if (fs.existsSync(CAMPAIGN_ADAPTER_FILE)) {
		const adapter = await loadCampaignAdapterConfig(CAMPAIGN_ADAPTER_FILE)
		const report = await readCampaignBudgetReport(adapter)
		await store.updateBudgetProjection(report)
	}
	const status = await store.status()
	process.stdout.write(`${JSON.stringify(status, null, json ? 0 : 2)}\n`)
	return 0
}

async function executeControlAction(
	action: string,
	positional: string[],
	json: boolean,
	store: CampaignControlStore,
): Promise<number> {
	if (action === "on" || action === "off") return runToggle(action, json)
	if (action === "budget") return runBudget(positional, json)
	if (action === "tick") return runTick(store, json)
	return runStatus(store, json)
}

async function runControlCommand(
	action: string,
	positional: string[],
	json: boolean,
): Promise<number> {
	if (invalidControlArguments(action, positional)) {
		process.stderr.write(`${campaignUsage()}\n`)
		return 2
	}
	const store = new CampaignControlStore(CAMPAIGN_CONTROL_FILE)
	try {
		return await executeControlAction(action, positional, json, store)
	} catch (error) {
		const message = error instanceof Error ? error.message : "operation failed"
		process.stderr.write(`headlesscode campaign: ${message}\n`)
		return 1
	}
}

export async function campaignMain(args: string[]): Promise<number> {
	const command = parseCommand(args)
	if (!command) {
		process.stderr.write(`${campaignUsage()}\n`)
		return 2
	}
	const { action, positional, json } = command
	if (action === "serve") return startServer(positional)
	if (action === "_apply") return applyCommand(positional)
	if (action === "rsi") {
		if (positional.length) return 2
		const status = await readCampaignRsiStatus()
		process.stdout.write(`${JSON.stringify(status, null, json ? 0 : 2)}\n`)
		return 0
	}
	const repositoryResult = await dispatchRepositoryAction(action, positional)
	if (repositoryResult !== undefined) return repositoryResult
	return runControlCommand(action, positional, json)
}
