import { runRsiMonitor } from "../operations-monitor.js"

const stateDirectory = process.argv[2]
if (!stateDirectory) throw new Error("state directory argument is required")

const requiredTables = [
	"headlesscode_rsi_queue_policy", "headlesscode_rsi_workers", "headlesscode_rsi_jobs",
	"headlesscode_rsi_proof_campaigns", "headlesscode_rsi_proof_campaign_arms", "headlesscode_rsi_proof_campaign_attempts",
	"headlesscode_rsi_inference_campaigns", "headlesscode_rsi_inference_jobs", "headlesscode_rsi_inference_calls",
]
const pool = {
	async connect() {
		return {
			async query(sql: string) {
				return { rows: sql.startsWith("SELECT table_name") ? requiredTables.map((table_name) => ({ table_name })) : [], rowCount: 0 }
			},
		release() {},
		}
	},
	async end() {},
}

const exitCode = await runRsiMonitor({
	pool,
	queueName: "rsi-default",
	campaignId: "campaign-test",
	queryTimeoutMs: 1000,
	stateDirectory,
	pollMs: 1000,
	stallMs: 2000,
	maxRuntimeMs: 30_000,
})
process.exitCode = exitCode
