/**
 * Manual smoke test: drive the REAL browser_action tool against the REAL
 * `headlesscode dashboard` dev server (http://127.0.0.1:4390) — the spec's
 * recommended real target. Exercises launch / screenshot / click / type /
 * getConsoleLogs / getNetworkErrors / close end-to-end, printing the tool
 * results so they can be pasted into the report.
 *
 * Run: node ./node_modules/tsx/dist/cli.mjs src/tools/browser/smoke.ts
 * Requires the dashboard to be running on 127.0.0.1:4390 first.
 */

import * as os from "node:os"
import * as path from "node:path"
import * as fs from "node:fs/promises"

import { createHeadlessExecutor } from "../executor.js"

// Keep screenshots under a stable dir in the CURRENT workspace so the report
// can reference/attach them (the browser tool writes them under the executor's
// workspace root; for the smoke test that's a temp dir, so we copy them out).
const ws = await fs.mkdtemp(path.join(os.tmpdir(), "hc-browser-smoke-"))
const OUT_DIR = path.join(process.cwd(), ".smoke-artifacts")
await fs.mkdir(OUT_DIR, { recursive: true })
const executor = createHeadlessExecutor(ws)
const DASH = "http://127.0.0.1:4390/"

async function copyScreenshot(resultContent: string, name: string): Promise<void> {
	const m = resultContent.match(/saved to [^(]+\(([^)]+\.png)\)/)
	if (!m) return
	await fs.copyFile(m[1], path.join(OUT_DIR, name))
	console.log(`  (screenshot copied to .smoke-artifacts/${name})`)
}

try {
	console.log("=== 1. launch the real dashboard ===")
	let r = await executor.execute("browser_action", { action: "launch", url: DASH })
	console.log(r.content)

	console.log("\n=== 2. screenshot the dashboard (PNG saved to workspace) ===")
	r = await executor.execute("browser_action", { action: "screenshot" })
	console.log(r.content)
	await copyScreenshot(r.content, "dashboard-1.png")

	console.log("\n=== 3. console logs (dashboard page) ===")
	r = await executor.execute("browser_action", { action: "getConsoleLogs" })
	console.log(r.content)

	console.log("\n=== 4. network errors ===")
	r = await executor.execute("browser_action", { action: "getNetworkErrors" })
	console.log(r.content)

	console.log("\n=== 5. type a task into the launch textarea (#launchTask) ===")
	r = await executor.execute("browser_action", { action: "type", selector: "#launchTask", text: "verify browser_action smoke test" })
	console.log(r.content)

	console.log("\n=== 6. screenshot again (shows the typed text in the UI) ===")
	r = await executor.execute("browser_action", { action: "screenshot" })
	console.log(r.content)
	await copyScreenshot(r.content, "dashboard-2-typed.png")

	console.log("\n=== 6b. click the ▶ Start button (empty task -> validation error in #launchMsg) ===")
	r = await executor.execute("browser_action", { action: "click", selector: "#btnStart" })
	console.log(r.content)
	await new Promise((res) => setTimeout(res, 500))
	console.log("\n=== 6c. console logs after click (page JS response) ===")
	r = await executor.execute("browser_action", { action: "getConsoleLogs" })
	console.log(r.content)

	console.log("\n=== 7. close the browser ===")
	r = await executor.execute("browser_action", { action: "close" })
	console.log(r.content)

	console.log("\n=== 8. session teardown (dispose) ===")
	await executor.dispose()
	console.log("dispose() completed — browser torn down at session end")
} finally {
	await fs.rm(ws, { recursive: true, force: true })
}
