import assert from "node:assert/strict"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { fileURLToPath } from "node:url"
import { spawn, type ChildProcess } from "node:child_process"
import { createServer } from "node:http"
import { setTimeout as delay } from "node:timers/promises"
import { FileEvidenceCollector, verifyEvidenceBundle } from "../../evidence/index.js"
import { finishSessionEmergencyControl, startSessionEmergencyControl } from "../../control/session-runtime.js"
import { EmergencyControl } from "../../control/emergency-controller.js"

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..")
const root = await fs.mkdtemp(path.join(os.tmpdir(), "rt-"))
const sockets = await fs.mkdtemp(path.join(os.tmpdir(), "s-"))
const workspace = path.join(root, "repo")
await fs.mkdir(workspace)
const children = new Set<ChildProcess>()
const env = { ...process.env }
for (const key of Object.keys(env)) if (/(TOKEN|PASSWORD|SECRET|CREDENTIAL|API_KEY|AUTH)/i.test(key) || key.startsWith("HEADLESSCODE_")) delete env[key]
Object.assign(env, { HEADLESSCODE_OPENROUTER_API_KEY: "cpu-mock-key", HEADLESSCODE_DATA_DIR: path.join(root, "data"), HEADLESSCODE_CODE_MODE_BACKEND: "openrouter", HEADLESSCODE_LOCAL_EXPLORE: "0", HEADLESSCODE_LOCAL_SUMMARIZATION: "0" })

function launch(args: string[], extra: NodeJS.ProcessEnv = {}) {
	const child = spawn(process.execPath, ["--import", path.join(packageRoot, "node_modules/tsx/dist/loader.mjs"), path.join(packageRoot, "src/cli.ts"), ...args], {
		cwd: workspace, env: { ...env, TSX_TSCONFIG_PATH: path.join(packageRoot, "tsconfig.json"), ...extra }, stdio: ["ignore", "pipe", "pipe"],
	})
	children.add(child)
	let output = ""
	child.stdout?.on("data", (data) => { output += data.toString() })
	child.stderr?.on("data", (data) => { output += data.toString() })
	const done = new Promise<number | null>((resolve, reject) => {
		child.once("error", reject)
		child.once("exit", (code) => { children.delete(child); resolve(code) })
	})
	return { child, done, output: () => output }
}
async function bounded<T>(pending: Promise<T>): Promise<T> {
	let timer: NodeJS.Timeout | undefined
	try {
		return await Promise.race([pending, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error("CPU CLI qualification timed out")), 45_000) })])
	} finally { if (timer) clearTimeout(timer) }
}

let chatRequests = 0
let contacted: (() => void) | undefined
const modelRequest = new Promise<void>((resolve) => { contacted = resolve })
const mock = createServer((req, res) => {
	if (req.url?.endsWith("/chat/completions")) {
		chatRequests++
		req.resume()
		req.once("end", () => contacted?.())
		// Keep the model request pending until the independently invoked stop aborts it.
		return
	}
	res.setHeader("content-type", "application/json")
	res.end(JSON.stringify({ data: [] }))
})
await new Promise<void>((resolve) => mock.listen(0, "127.0.0.1", resolve))
const address = mock.address()
assert.ok(address && typeof address !== "string")
env.OPENROUTER_BASE_URL = `http://127.0.0.1:${address.port}`
const storage = path.join(root, "storage")
const configDir = path.join(root, "configs")
const socket = path.join(sockets, "e.sock")
const collectorProcess = launch(["evidence", "serve-contained", "--storage-dir", storage, "--socket", socket, "--config-dir", configDir, "--session", "cpu-stop", "--session", "cpu-offline"])
try {
	await bounded((async () => {
		while (!collectorProcess.output().includes("Evidence collector ready")) {
			if (collectorProcess.child.exitCode !== null) throw new Error(collectorProcess.output())
			await delay(25)
		}
	})())
	const stopConfig = path.join(configDir, "cpu-stop.json")
	const savedConfig = JSON.parse(await fs.readFile(stopConfig, "utf8"))
	const offlineConfig = path.join(root, "offline.json")
	await fs.writeFile(offlineConfig, await fs.readFile(path.join(configDir, "cpu-offline.json")), { mode: 0o400 })
	const controls = { HEADLESSCODE_CONTROL_ID: "cpu-control", HEADLESSCODE_CONTROL_STATE_DIR: path.join(root, "control"), HEADLESSCODE_CONTROL_SOCKET_DIR: sockets }
	const session = launch(["--task", "Wait for this CPU mock model", "--workspace", workspace, "--session-id", "cpu-stop", "--model", "cpu-mock", "--no-checkpoints", "--max-iterations", "2"], { ...controls, HEADLESSCODE_EVIDENCE_CONFIG_PATH: stopConfig })
	await bounded(modelRequest)
	const stop = launch(["control", "cpu-control", "stop", "--reason", "CPU CLI cancellation qualification"], controls)
	assert.equal(await bounded(stop.done), 0, stop.output())
	assert.equal(JSON.parse(stop.output()).state, "stopped")
	assert.equal(await bounded(session.done), 1, session.output())
	assert.equal(chatRequests, 1)
	collectorProcess.child.kill("SIGTERM")
	assert.equal(await bounded(collectorProcess.done), 0, collectorProcess.output())
	assert.deepEqual(await fs.readdir(configDir), [], "collector shutdown revokes and removes runtime handoffs")
	const collector = await FileEvidenceCollector.start({ storageDir: storage, socketPath: socket, expectedKeyId: savedConfig.pinnedPublicKey.keyId })
	try {
		const bundle = await collector.exportBundle("cpu-stop")
		const checked = verifyEvidenceBundle(bundle, savedConfig.pinnedPublicKey, bundle.head)
		assert.equal(checked.valid, true, checked.errors.join("\n"))
		assert.ok(bundle.records.some((record) => record.kind === "model_request"))
		assert.ok(bundle.records.some((record) => record.kind === "session_stop"))
	} finally { await collector.close() }
	const offline = launch(["--task", "Collector is offline", "--workspace", workspace, "--model", "cpu-mock", "--no-checkpoints"], { HEADLESSCODE_EVIDENCE_CONFIG_PATH: offlineConfig })
	assert.equal(await bounded(offline.done), 1, offline.output())
	assert.equal(chatRequests, 1, "required evidence outage prevents a second model request")
	await fs.chmod(workspace, 0o755)
	await assert.rejects(startSessionEmergencyControl({ workspaceRoot: workspace, env: { HEADLESSCODE_CONTROL_ID: "bad-path", HEADLESSCODE_CONTROL_STATE_DIR: workspace } }), /outside/)
	assert.equal((await fs.stat(workspace)).mode & 0o777, 0o755, "rejected control paths preserve workspace permissions")
	const dangling = path.join(root, "dangling")
	const target = path.join(workspace, "must-not-exist")
	await fs.symlink(target, dangling, "dir")
	await assert.rejects(startSessionEmergencyControl({ workspaceRoot: workspace, env: { HEADLESSCODE_CONTROL_ID: "dangling", HEADLESSCODE_CONTROL_STATE_DIR: dangling } }), /symlinks/)
	await assert.rejects(fs.stat(target), { code: "ENOENT" })
	let writes = 0
	const failedStop = await EmergencyControl.start({ identity: "fault", stateDirectory: path.join(root, "fault"), socketDirectory: sockets, graceMs: 50, persistState: async (file, record) => {
		if (++writes > 1) throw new Error("injected durable stop failure")
		await fs.writeFile(file, JSON.stringify(record), { mode: 0o600 })
	} })
	assert.equal(await finishSessionEmergencyControl(failedStop), false, "natural completion cannot hide a failed durable stop")
	assert.equal(failedStop.state, "failed-to-stop")
	console.log("All 5 runtime CLI qualifications passed (external evidence, active stop, required outage, dangling path, durable stop failure)")
} finally {
	for (const child of children) child.kill("SIGTERM")
	mock.closeAllConnections()
	await new Promise<void>((resolve) => mock.close(() => resolve()))
	await fs.rm(root, { recursive: true, force: true })
	await fs.rm(sockets, { recursive: true, force: true })
}
