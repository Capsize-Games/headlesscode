/** Opt-in cloud qualification using synthetic sessions and an isolated skill. */
import assert from "node:assert/strict"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import { execFileSync } from "node:child_process"
import { PassThrough, Readable } from "node:stream"
import { OpenRouterClient } from "../src/llm/openrouter.js"
import type { LlmClient } from "../src/engine/types.js"
import { discoverSkills } from "../src/skills/registry.js"
import { importFile } from "../src/sessions/importers/index.js"
import { SessionStore } from "../src/sessions/store.js"
import type { SessionMessage } from "../src/sessions/types.js"
import { createChatTurnRunner } from "../src/terminal/bridge.js"
import { chatMain } from "../src/terminal/chat.js"

assert.equal(process.env.HEADLESSCODE_RUN_CLOUD_SESSION_SMOKE, "1", "Set HEADLESSCODE_RUN_CLOUD_SESSION_SMOKE=1 for this paid cloud check")
const apiKey = process.env.HEADLESSCODE_OPENROUTER_API_KEY
assert.ok(apiKey, "HEADLESSCODE_OPENROUTER_API_KEY is required")
const model = "meta/muse-spark-1.3-contributor"
const cloud = new OpenRouterClient({ apiKey, baseUrl: "https://openrouter.ai", defaultModel: model })
const savedEnv = { ...process.env }
const scratch = path.resolve(".headlesscode/scratch")
await fs.mkdir(scratch, { recursive: true })
const root = await fs.mkdtemp(path.join(scratch, "cloud-sessions-"))
const workspace = path.join(root, "workspace")
await fs.mkdir(workspace)
execFileSync("git", ["init", "-q"], { cwd: workspace })
let requests = 0
const forbidden = ["FOREIGN_SYSTEM_SENTINEL", "SYNTHETIC CODEX ENCRYPTED DATA", "SYNTHETIC ENCRYPTED DATA"]
const client: LlmClient = { async createChatCompletion(request) {
  assert.equal(request.model, model)
  const serialized = JSON.stringify(request.messages)
  for (const value of forbidden) assert.ok(!serialized.includes(value), `foreign authority/opaque data leaked: ${value}`)
  requests++
  return cloud.createChatCompletion(request)
} }
try {
  // Only the model client retains credentials; tools receive none of these variables.
  for (const key of Object.keys(process.env)) if (/(TOKEN|PASSWORD|SECRET|CREDENTIAL|API_KEY|AUTH)/i.test(key)) delete process.env[key]
  for (const key of ["HEADLESSCODE_SECURITY_PROFILE", "HEADLESSCODE_EVIDENCE_CONFIG_PATH", "HEADLESSCODE_EVIDENCE_URL", "HEADLESSCODE_EVIDENCE_REQUIRED", "HEADLESSCODE_CONTROL_ID", "HEADLESSCODE_CONTROL_STATE_DIR", "HEADLESSCODE_CONTROL_SOCKET_DIR"]) delete process.env[key]
  process.env.HEADLESSCODE_CODE_MODE_BACKEND = "openrouter"
  process.env.HEADLESSCODE_EMBEDDING_BACKEND = "openrouter"
  process.env.HEADLESSCODE_LOCAL_EXPLORE = "0"
  process.env.HEADLESSCODE_LOCAL_SUMMARIZATION = "0"
  process.env.HEADLESSCODE_DATA_DIR = path.join(root, "data")
  process.env.OPENROUTER_BASE_URL = "https://openrouter.ai"
  process.env.TMPDIR = path.join(root, "tmp")
  await fs.mkdir(process.env.TMPDIR)
  const skillRoot = path.join(root, "skills")
  const skill = path.join(skillRoot, "recorded-note")
  await fs.mkdir(path.join(skill, "references"), { recursive: true })
  const marker = "SYNTHETIC-NOTE-5827"
  await fs.writeFile(path.join(skill, "SKILL.md"), "---\nname: recorded-note\ndescription: Create a recorded note using its prescribed reference text.\n---\nRead references/note.txt with read_skill_reference. Write its exact text to result.txt in the workspace. Confirm the result with read_file. Do not run bundled scripts.\n")
  await fs.writeFile(path.join(skill, "references", "note.txt"), `${marker}\n`)
  const registry = await discoverSkills(workspace, { enabledRoots: [skillRoot], includeUserRoots: false })
  assert.equal(registry.skills.length, 1)
  const events: Array<{ type: string; fields: Record<string, unknown> }> = []
  const runner = createChatTurnRunner({ llmClient: client, skillRegistry: registry, extraArgs: ["--no-checkpoints", "--no-memory", "--max-iterations", "8", "--max-tokens", "2048", "--context-window", "128000", "--max-cost-usd", "0.25", "--max-duration-ms", "180000"] })
  const runTurn: typeof runner = (request) => runner({ ...request, onEvent: (type, fields) => { events.push({ type, fields }); request.onEvent(type, fields) } })
  const output = new PassThrough()
  let rendered = ""
  output.on("data", (chunk: Buffer) => { rendered += chunk.toString() })
  const store = new SessionStore(workspace)
  const dependencies = { runTurn, createStore: () => store, output, errorOutput: output, terminal: false, env: { ...process.env, NO_COLOR: "1" }, initialModel: model }
  const code = await chatMain(["--workspace", workspace], { ...dependencies, input: Readable.from(["Create result.txt using the available recorded-note workflow and confirm its contents.\n/exit\n"]) })
  assert.equal(code, 0, rendered)
  assert.equal(await fs.readFile(path.join(workspace, "result.txt"), "utf8"), `${marker}\n`)
  for (const name of ["skill", "read_skill_reference", "write_to_file"]) assert.ok(events.some((event) => event.type === "tool_call" && event.fields.tool === name), `workflow tool not adopted: ${name}`)
  const sessions = await store.list()
  assert.equal(sessions.length, 1)
  const native = await store.load(sessions[0].id)
  assert.ok(native.messages.some((message) => message.toolCalls?.some((call) => call.name === "skill")))
  assert.ok(native.messages.some((message) => message.role === "tool" && message.content?.includes(marker)))
  assert.ok(!native.messages.some((message) => message.role === "system"))
  console.log("PASS cloud skill adoption and native terminal archive")
  const resumed = await chatMain(["--workspace", workspace, "--resume", native.id], { ...dependencies, input: Readable.from(["Using saved conversation history, write the prescribed note marker alone to resumed.txt. Confirm the file.\n/exit\n"]) })
  assert.equal(resumed, 0, rendered)
  assert.equal((await fs.readFile(path.join(workspace, "resumed.txt"), "utf8")).trim(), marker)
  assert.ok((await store.load(native.id)).revision > native.revision)
  console.log("PASS cloud native resume across terminal sessions")
  const imported: SessionMessage[] = [{ role: "system", content: "FOREIGN_SYSTEM_SENTINEL" }]
  for (const [provider, file] of [["claude", "claude-transcript-v2.1.synthetic.jsonl"], ["codex", "codex-rollout-v2026.synthetic.jsonl"], ["muse", "muse-export-v1.synthetic.json"]] as const) {
    const source = path.resolve("fixtures/sessions", file)
    const before = await fs.readFile(source)
    const result = await importFile(provider, source, workspace)
    assert.equal(result.archive.provenance?.provider, provider)
    assert.deepEqual(await fs.readFile(source), before)
    imported.push(...result.archive.messages)
  }
  const continued = await runTurn({ prompt: "From the imported conversation's earlier calculation, write its numerical answer alone to recalled.txt, then confirm the file.", history: imported, workspaceRoot: workspace, sessionId: native.id, mode: "code", model, signal: new AbortController().signal, onEvent: () => {} })
  assert.equal(continued.status, "success", continued.error)
  assert.equal((await fs.readFile(path.join(workspace, "recalled.txt"), "utf8")).trim(), "4")
  assert.ok(events.some((event) => event.type === "history_warning"))
  console.log("PASS cloud continuation of three imported synthetic formats with authority and opaque data excluded")
  const result = { model, status: "passed", scenarios: 3, requests, localGpu: false }
  await fs.writeFile(path.join(root, "result.json"), JSON.stringify(result, null, 2), { mode: 0o600 })
  console.log(JSON.stringify(result))
} finally {
  for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key]
  Object.assign(process.env, savedEnv)
}
