import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import * as fs from "node:fs/promises"
import * as http from "node:http"
import * as os from "node:os"
import * as path from "node:path"

const root = process.cwd()
const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "rsi-cli-timeout-"))
let received = false
const server = http.createServer((request) => { received = true; request.resume() })
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
const address = server.address()
assert.ok(address && typeof address === "object")
const child = spawn(process.execPath, [
	path.join(root, "node_modules/tsx/dist/cli.mjs"), path.join(root, "src/cli.ts"),
	"--mode", "code", "--workspace", workspace, "--task", "check timeout", "--model", "benchmark",
	"--max-iterations", "1", "--no-checkpoints", "--llm-timeout-ms", "50",
], { cwd: root, env: { ...process.env, HEADLESSCODE_CODE_MODE_BACKEND: "ollama", HEADLESSCODE_OLLAMA_URL: `http://127.0.0.1:${address.port}`, HEADLESSCODE_DATA_DIR: path.join(workspace, "store") }, stdio: ["ignore", "pipe", "pipe"] })
let output = ""
child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8")
child.stdout.on("data", (chunk) => { output += chunk })
child.stderr.on("data", (chunk) => { output += chunk })
const code = await new Promise((resolve) => {
	const timer = setTimeout(() => { child.kill("SIGKILL"); resolve(null) }, 2000)
	child.once("close", (exitCode) => { clearTimeout(timer); resolve(exitCode) })
})
server.closeAllConnections?.()
await new Promise((resolve) => server.close(resolve))
await fs.rm(workspace, { recursive: true, force: true })
assert.equal(received, true, "CLI should issue a request to the local backend")
assert.notEqual(code, null, "CLI must terminate within the configured short timeout")
assert.notEqual(code, 0, "a timed-out model call must not be reported as a successful task")
assert.match(output, /timed out after 50ms/i)
console.log("CLI Ollama timeout propagation passed")
