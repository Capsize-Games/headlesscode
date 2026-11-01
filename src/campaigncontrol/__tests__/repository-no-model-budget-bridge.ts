import { spawnSync } from "node:child_process"

export function pythonBridge(
	root: string,
	fleetRoot: string,
	message: Record<string, unknown>,
): Record<string, unknown> {
	const result = runBridgeProcess(root, fleetRoot, message)
	if (result.error || result.status !== 0) {
		const error = (result.stderr ?? "").slice(0, 500)
		throw new Error("offline Python bridge failed: " + error)
	}
	const output = result.stdout
	if (typeof output !== "string") {
		throw new Error("Python bridge output is invalid")
	}
	return JSON.parse(output.trim()) as Record<string, unknown>
}

function runBridgeProcess(root: string, fleetRoot: string,
	message: Record<string, unknown>): ReturnType<typeof spawnSync> {
	return spawnSync("/usr/bin/python3", ["-c", bridgeScript()], {
		input: JSON.stringify(message), encoding: "utf8", timeout: 10_000,
		env: { HOME: root, PATH: "/usr/bin:/bin", PYTHONPATH: fleetRoot,
			PYTHONNOUSERSITE: "1" },
	})
}

function bridgeScript(): string {
	return "import json,sys\nfrom unittest.mock import patch\n" +
		"import operations.campaign_budget as budget\n" +
		"import operations.campaign_budget_bridge as bridge\n" +
		"with patch.object(budget, '_provider_snapshot',\n" +
		"    return_value={'limit_micros':5000000,\n" +
		"    'remaining_micros':5000000,'usage_micros':0}):\n" +
		" print(json.dumps(bridge._authority().dispatch(json.load(sys.stdin)),\n" +
		"     separators=(',',':')))\n"
}
