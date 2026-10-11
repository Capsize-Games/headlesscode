import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { fileURLToPath } from "node:url"

const root = fileURLToPath(new URL("../../../", import.meta.url))
const output = execFileSync(process.execPath, ["--import", "tsx", "scripts/rsi-security-canary.ts", "--help"], {
	cwd: root,
	env: { ...process.env, HEADLESSCODE_OPENROUTER_API_KEY: "", OPENROUTER_API_KEY: "", OPENSHELL_GATEWAY: "" },
	encoding: "utf8",
	timeout: 10_000,
})
assert.match(output, /CPU-only OpenShell isolation probe without model inference/)
console.log("RSI security canary entry point imports and help passed; no guest launched")
