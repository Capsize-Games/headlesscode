import * as fs from "node:fs"
import { CampaignControlStore, MAX_MONTHLY_BUDGET_MICROS } from "./store.js"
import { loadCampaignAdapterConfig, readCampaignBudgetReport, runCampaignTick, runFleetAdapterUnderLock, verifyCampaignDispatchLock } from "./runner.js"
import { mutateCampaignControlLocked } from "./authority.js"
import { CAMPAIGN_ADAPTER_FILE, CAMPAIGN_CONTROL_FILE } from "./paths.js"
import { readCampaignRsiStatus } from "./rsi.js"
import * as os from "node:os"
import * as path from "node:path"

function parseBudget(dollars: string): number | undefined {
	if (!/^(?:0|[1-9]\d*)(?:\.\d{1,6})?$/.test(dollars)) return undefined
	const [whole, fraction = ""] = dollars.split(".")
	const micros = Number(whole) * 1_000_000 + Number(fraction.padEnd(6, "0"))
	return Number.isSafeInteger(micros) && micros <= MAX_MONTHLY_BUDGET_MICROS ? micros : undefined
}

function usage(): string {
	return "Usage: headlesscode campaign <status|rsi|on|off|budget --usd <amount>|tick|serve> [--json]"
}

export async function campaignMain(args: string[]): Promise<number> {
	const [action, ...rest] = args
	if (!action || !["status", "rsi", "on", "off", "budget", "tick", "serve", "_apply", "_adapter-tick"].includes(action)) {
		process.stderr.write(`${usage()}\n`)
		return 2
	}
	const json = rest.includes("--json")
	const positional = rest.filter((arg) => arg !== "--json")
	if (action === "serve") {
		if (positional.length) return 2
		const { startCampaignControlServer } = await import("./server.js")
		await startCampaignControlServer({ staticRoot: path.join(os.homedir(), "Projects/capsize-web/apps/fleet-campaign-control/dist") })
		process.stdout.write(JSON.stringify({ status: "listening", url: "http://127.0.0.1:4391/" }) + "\n")
		return 0
	}
	if (action === "_adapter-tick") {
		if (positional.length) return 2
		const store = new CampaignControlStore(CAMPAIGN_CONTROL_FILE)
		await verifyCampaignDispatchLock(CAMPAIGN_CONTROL_FILE)
		const adapter = await loadCampaignAdapterConfig(CAMPAIGN_ADAPTER_FILE)
		await store.updateBudgetProjection(await readCampaignBudgetReport(adapter))
		const result = await runFleetAdapterUnderLock(store, adapter)
		await store.updateBudgetProjection(await readCampaignBudgetReport(adapter))
		process.stdout.write(JSON.stringify(result) + "\n")
		return result.status === "succeeded" ? 0 : 1
	}
	if (action === "_apply") {
		if (positional.length < 1 || positional.length > 2) return 2
		const store = new CampaignControlStore(CAMPAIGN_CONTROL_FILE)
		await verifyCampaignDispatchLock(CAMPAIGN_CONTROL_FILE)
		if (positional[0] === "on" || positional[0] === "off") {
			if (positional.length !== 1) return 2
			if (positional[0] === "on") {
				const adapter = await loadCampaignAdapterConfig(CAMPAIGN_ADAPTER_FILE)
				await store.updateBudgetProjection(await readCampaignBudgetReport(adapter))
			}
			process.stdout.write(`${JSON.stringify(await store.setEnabled(positional[0] === "on"), null, 2)}\n`)
			return 0
		}
		if (positional[0] === "budget" && positional.length === 2) {
			const micros = parseBudget(positional[1]!)
			if (micros === undefined) return 2
			const adapter = await loadCampaignAdapterConfig(CAMPAIGN_ADAPTER_FILE)
			const projection = await readCampaignBudgetReport(adapter)
			await store.updateBudgetProjection(projection)
			const committed = projection.settledMicros + projection.reservedMicros + projection.ambiguousMicros
			if (micros < committed) throw new Error("budget cannot be lowered below settled, reserved, or ambiguous monthly spend")
			process.stdout.write(`${JSON.stringify(await store.setBudgetLimit(micros), null, 2)}\n`)
			return 0
		}
		return 2
	}
	if (action === "rsi") {
		if (positional.length) return 2
		process.stdout.write(JSON.stringify(await readCampaignRsiStatus(), null, json ? 0 : 2) + "\n")
		return 0
	}
	if (action === "status" && positional.length || (action === "on" || action === "off") && positional.length ||
		(action === "tick" && positional.length) || (action === "budget" && (positional.length !== 2 || positional[0] !== "--usd"))) {
		process.stderr.write(`${usage()}\n`)
		return 2
	}
	const store = new CampaignControlStore(CAMPAIGN_CONTROL_FILE)
	try {
		if (action === "on" || action === "off") {
			const control = await mutateCampaignControlLocked(action)
			process.stdout.write(JSON.stringify(control, null, json ? 0 : 2) + "\n")
			return 0
		}
		if (action === "budget") {
			const micros = parseBudget(positional[1]!)
			if (micros === undefined) {
				process.stderr.write("budget must be a decimal USD amount from $0 to $5.00 (up to six decimal places)\n")
				return 2
			}
			const control = await mutateCampaignControlLocked("budget", micros)
			process.stdout.write(JSON.stringify(control, null, json ? 0 : 2) + "\n")
			return 0
		}
		if (action === "tick") {
			const adapter = await loadCampaignAdapterConfig(CAMPAIGN_ADAPTER_FILE)
			const result = await runCampaignTick(store, adapter)
			process.stdout.write(`${JSON.stringify({ ...result, control: await store.snapshot() }, null, json ? 0 : 2)}\n`)
			return result.status === "failed" ? 1 : 0
		}
		if (fs.existsSync(CAMPAIGN_ADAPTER_FILE)) {
			const adapter = await loadCampaignAdapterConfig(CAMPAIGN_ADAPTER_FILE)
			await store.updateBudgetProjection(await readCampaignBudgetReport(adapter))
		}
		process.stdout.write(`${JSON.stringify(await store.status(), null, json ? 0 : 2)}\n`)
		return 0
	} catch (error) {
		process.stderr.write(`headlesscode campaign: ${error instanceof Error ? error.message : "operation failed"}\n`)
		return 1
	}
}
