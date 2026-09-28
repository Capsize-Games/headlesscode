import { spawnSync } from "node:child_process"
import * as fs from "node:fs"

export function openshellPreflight(): string | undefined {
	const policy = process.env.HEADLESSCODE_OPENSHELL_POLICY
	if (!policy || !fs.existsSync(policy)) return "set HEADLESSCODE_OPENSHELL_POLICY to an existing base policy YAML"
	if (!process.env.HEADLESSCODE_OPENROUTER_API_KEY) return "set HEADLESSCODE_OPENROUTER_API_KEY so OpenShell can provide the imported credential profile"
	const version = spawnSync("openshell", ["--version"], { encoding: "utf8", timeout: 5000 })
	if (version.error || version.status !== 0) return "OpenShell CLI is unavailable"
	const gateway = spawnSync("openshell", ["gateway", "info"], { encoding: "utf8", timeout: 10000 })
	const output = `${gateway.stdout ?? ""}${gateway.stderr ?? ""}`
	if (gateway.error || gateway.status !== 0 || !/Status:\s+healthy/i.test(output)) {
		return `OpenShell gateway is not healthy${output.trim() ? ": " + output.trim() : ""}`
	}
	return undefined
}
