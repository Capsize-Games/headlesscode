import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import * as fs from "node:fs/promises"
import * as http from "node:http"
import * as os from "node:os"
import * as path from "node:path"

const root = process.cwd()
const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "rsi-default-ollama-timeout-"))
const timerLog = path.join(workspace, "long-timers.log")
const preload = path.join(workspace, "capture-timers.mjs")
await fs.writeFile(preload, `import { appendFileSync } from "node:fs"\nconst original = globalThis.setTimeout\nglobalThis.setTimeout = function (callback, delay, ...args) { if (delay >= 300000) appendFileSync(process.env.RSI_TIMER_LOG, String(delay) + "\\n"); return original(callback, delay, ...args) }\n`)
let requestReceived = false
const server = http.createServer(async (request, response) => {
	requestReceived = true
	request.resume()
	response.writeHead(200, { "content-type": "application/json" })
	response.end(JSON.stringify({ message: { role: "assistant", content: "Done." }, done: true }))
})
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
const address = server.address()
assert.ok(address && typeof address === "object")
const child = spawn(process.execPath, [
	path.join(root, "node_modules/tsx/dist/cli.mjs"), path.join(root, "src/cli.ts"),
	"--mode", "code", "--workspace", workspace, "--task", "complete this", "--model", "benchmark",
	"--max-iterations", "1", "--no-checkpoints",
], { cwd: root, env: { ...process.env, NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --import=${preload}`.trim(), RSI_TIMER_LOG: timerLog, HEADLESSCODE_CODE_MODE_BACKEND: "ollama", HEADLESSCODE_OLLAMA_URL: `http://127.0.0.1:${address.port}`, HEADLESSCODE_DATA_DIR: path.join(workspace, "store") }, stdio: ["ignore", "pipe", "pipe"] })
let output = ""
child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8")
child.stdout.on("data", (chunk) => { output += chunk })
child.stderr.on("data", (chunk) => { output += chunk })
const code = await new Promise((resolve) => {
	const timer = setTimeout(() => { child.kill("SIGKILL"); resolve(null) }, 5000)
	child.once("close", (exitCode) => { clearTimeout(timer); resolve(exitCode) })
})
server.closeAllConnections?.()
await new Promise((resolve) => server.close(resolve))
const timers = await fs.readFile(timerLog, "utf8").catch(() => "")
await fs.rm(workspace, { recursive: true, force: true })
assert.equal(requestReceived, true, "CLI should issue a local backend request")
assert.equal(code, 1, `one non-completing reply should reach the normal iteration cap: ${output}`)
assert.match(output, /Max iterations \(1\) reached/)
assert.ok((timers.match(/(?:^|\n)630000(?:\n|$)/g) ?? []).length >= 2, `both the session and Ollama client must use the extended timeout: ${timers}`)
console.log("local CLI backend default timeout exceeds the proxy timeout")
