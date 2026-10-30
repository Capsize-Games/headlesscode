import { existsSync } from "node:fs"
import * as path from "node:path"

export function requiredFleetTestRoot(): string {
	const configured = process.env.FLEET_SECURITY_WATCH_TEST_ROOT
	if (!configured) {
		throw new Error(
			"Required Fleet test source is missing; run the CI source staging step",
		)
	}
	const root = path.resolve(configured)
	const bridge = path.join(root, "operations/campaign_budget_bridge.py")
	if (!existsSync(bridge)) {
		throw new Error(`Required Fleet test bridge is unavailable at ${root}`)
	}
	return root
}
