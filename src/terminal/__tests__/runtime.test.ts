import assert from "node:assert/strict"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import { execFileSync } from "node:child_process"
import { PassThrough, Readable } from "node:stream"
import type { LlmClient } from "../../engine/types.js"
import type { SkillRegistry } from "../../skills/registry.js"
import { SessionStore } from "../../sessions/store.js"
import { terminalMain } from "../cli.js"

const savedEnv = { ...process.env }
const scratch = path.resolve(".headlesscode/scratch")
await fs.mkdir(scratch, { recursive: true })
const workspace = await fs.mkdtemp(path.join(scratch, "terminal-runtime-"))
const registry: SkillRegistry = { skills: [], problems: [], get: () => undefined, activate: () => undefined, readReference: () => { throw new Error("no skills") } }
let count = 0
try {
	for (const key of ["HEADLESSCODE_SECURITY_PROFILE", "HEADLESSCODE_EVIDENCE_CONFIG_PATH", "HEADLESSCODE_EVIDENCE_URL", "HEADLESSCODE_EVIDENCE_REQUIRED", "HEADLESSCODE_CONTROL_ID", "HEADLESSCODE_CONTROL_STATE_DIR", "HEADLESSCODE_CONTROL_SOCKET_DIR"]) delete process.env[key]
	process.env.HEADLESSCODE_DATA_DIR = path.join(workspace, "data")
	process.env.HEADLESSCODE_CODE_MODE_BACKEND = "openrouter"
	process.env.HEADLESSCODE_LOCAL_EXPLORE = "0"
	process.env.HEADLESSCODE_LOCAL_SUMMARIZATION = "0"
	process.env.NO_COLOR = "1"
	execFileSync("git", ["init", "-q"], { cwd: workspace })
	const output = new PassThrough()
	let rendered = ""
	output.on("data", (chunk: Buffer) => { rendered += chunk.toString() })
	let calls = 0
	const client: LlmClient = { async createChatCompletion(request) {
		calls++
		assert.equal(request.model, "mock/cloud")
		return { message: { role: "assistant", content: "SYNTHETIC saved answer" } }
	} }
	const common = { llmClient: client, skillRegistry: registry, output, errorOutput: output, extraArgs: ["--no-checkpoints", "--no-memory", "--max-iterations", "2"] }
	assert.equal(await terminalMain(["--workspace", workspace, "--mode", "invalid-mode"], { ...common, input: Readable.from([]) }), 1)
	assert.equal(calls, 0)
	const store = new SessionStore(workspace)
	assert.equal((await store.list()).length, 0)
	const before = process.listenerCount("SIGTERM")
	assert.equal(await terminalMain(["--workspace", workspace, "--model", "mock/cloud"], { ...common, input: Readable.from(["/mode invalid-mode\n/skills\nSYNTHETIC task\n/fork\n/exit\n"]) }), 0)
	assert.equal(calls, 1)
	const archives = await store.list()
	assert.equal(archives.length, 2)
	const fork = await store.load(archives.find((entry) => entry.id !== archives[0].id)?.id ?? archives[0].id)
	assert.equal(fork.messages[0].content, "SYNTHETIC task")
	assert.equal(fork.messages[1].content, "SYNTHETIC saved answer")
	assert.match(rendered, /current mode remains 'code'/)
	assert.match(rendered, /Turn success/)
	assert.equal(process.listenerCount("SIGTERM"), before)
	console.log("PASS production terminal wiring preserves native messages, forks, and mode validation"); count++
	let began: () => void = () => {}
	const started = new Promise<void>((resolve) => { began = resolve })
	const blocked: LlmClient = { async createChatCompletion(request) {
		began()
		await new Promise<never>((_resolve, reject) => {
			if (request.signal?.aborted) reject(request.signal.reason)
			else request.signal?.addEventListener("abort", () => reject(request.signal?.reason), { once: true })
		})
		throw new Error("unreachable")
	} }
	const input = new PassThrough()
	const stopped = terminalMain(["--workspace", workspace, "--model", "mock/cloud"], { ...common, llmClient: blocked, input })
	input.write("SYNTHETIC blocked turn\n")
	await started
	process.emit("SIGTERM", "SIGTERM")
	assert.equal(await stopped, 1)
	assert.equal(process.listenerCount("SIGTERM"), before)
	console.log("PASS supervisor stop aborts active inference and removes terminal process handler"); count++
	for (const command of ["chat", "skills", "sessions"]) {
		const help = execFileSync(process.execPath, ["--import", "tsx", "src/cli.ts", command, "--help"], { cwd: process.cwd(), env: process.env, encoding: "utf8" })
		assert.ok(help.includes(`headlesscode ${command}`))
	}
	console.log("PASS installed CLI dispatches the three command help paths without inference"); count++
} finally {
	for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key]
	Object.assign(process.env, savedEnv)
	await fs.rm(workspace, { recursive: true, force: true })
}
console.log(`All ${count} tests passed`)
