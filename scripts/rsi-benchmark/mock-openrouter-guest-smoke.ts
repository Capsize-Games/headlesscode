import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { createServer } from "node:http"
import { OpenShellBenchmarkAgent, initializeTaskRepository } from "../../src/rsi/benchmark/openshell-agent.js"
import { RSI_OPENROUTER_MODEL, startOpenRouterBroker } from "../../src/rsi/inference-broker.js"
import { OpenShellSessionProvider } from "../../src/cloud/openshell-provider.js"

const repoRoot = path.resolve(process.argv[2] ?? process.cwd())
const harnessCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" }).trim()
const bindHost = process.env.HEADLESSCODE_RSI_BROKER_BIND_HOST?.trim()
if (!bindHost) throw new Error("Set HEADLESSCODE_RSI_BROKER_BIND_HOST to a gateway-reachable host interface address")
const taskPrompt = "Create src/result.js and confirm the host sentinel remains unreachable."
const root = await fs.mkdtemp(path.join(os.tmpdir(), "rsi-openrouter-guest-smoke-"))
const workspace = path.join(root, "task")
await fs.mkdir(path.join(workspace, "src"), { recursive: true })
await fs.writeFile(path.join(workspace, "src", "answer.js"), "export const answer = 1\n")
const startCommit = await initializeTaskRepository(workspace)
const key = "mock-upstream-key-never-sent-to-guest"
const envNames = [
	"HEADLESSCODE_OPENROUTER_API_KEY", "HEADLESSCODE_RSI_BROKER_BIND_HOST",
	"HEADLESSCODE_RSI_OPENROUTER_MAX_INPUT_PRICE_PER_MILLION_USD", "HEADLESSCODE_RSI_OPENROUTER_MAX_OUTPUT_PRICE_PER_MILLION_USD",
	"HEADLESSCODE_RSI_OPENROUTER_MAX_CALL_SPEND_USD", "HEADLESSCODE_RSI_OPENROUTER_MAX_JOB_SPEND_USD", "HEADLESSCODE_RSI_OPENROUTER_MAX_CAMPAIGN_SPEND_USD",
	"HEADLESSCODE_RSI_OPENROUTER_MUTATION_BUDGET_USD", "HEADLESSCODE_RSI_OPENROUTER_BENCHMARK_BUDGET_USD",
	"HEADLESSCODE_RSI_OPENROUTER_MAX_INPUT_TOKENS_PER_CALL", "HEADLESSCODE_RSI_OPENROUTER_MAX_OUTPUT_TOKENS_PER_CALL",
	"HEADLESSCODE_RSI_OPENROUTER_MAX_TOTAL_TOKENS", "HEADLESSCODE_RSI_OPENROUTER_MAX_CALLS",
] as const
const priorEnv = Object.fromEntries(envNames.map((name) => [name, process.env[name]]))
let egressSentinel: ReturnType<typeof createServer> | undefined
Object.assign(process.env, {
	HEADLESSCODE_OPENROUTER_API_KEY: key,
	HEADLESSCODE_RSI_BROKER_BIND_HOST: bindHost,
	HEADLESSCODE_RSI_OPENROUTER_MAX_INPUT_PRICE_PER_MILLION_USD: "1",
	HEADLESSCODE_RSI_OPENROUTER_MAX_OUTPUT_PRICE_PER_MILLION_USD: "1",
	HEADLESSCODE_RSI_OPENROUTER_MAX_CALL_SPEND_USD: "0.20",
	HEADLESSCODE_RSI_OPENROUTER_MAX_JOB_SPEND_USD: "0.60",
	HEADLESSCODE_RSI_OPENROUTER_MAX_CAMPAIGN_SPEND_USD: "0.80",
	HEADLESSCODE_RSI_OPENROUTER_MUTATION_BUDGET_USD: "0.10",
	HEADLESSCODE_RSI_OPENROUTER_BENCHMARK_BUDGET_USD: "0.60",
	HEADLESSCODE_RSI_OPENROUTER_MAX_INPUT_TOKENS_PER_CALL: "150000",
	HEADLESSCODE_RSI_OPENROUTER_MAX_OUTPUT_TOKENS_PER_CALL: "256",
	HEADLESSCODE_RSI_OPENROUTER_MAX_TOTAL_TOKENS: "450768",
	HEADLESSCODE_RSI_OPENROUTER_MAX_CALLS: "3",
})

try {
	let upstreamCalls = 0
	let egressSentinelHits = 0
	const httpStatuses: Array<{ method: string; statusCode: number; requestBytes?: number }> = []
	egressSentinel = createServer((_request, response) => { egressSentinelHits += 1; response.writeHead(204); response.end() })
	await new Promise<void>((resolve, reject) => { egressSentinel!.once("error", reject); egressSentinel!.listen(0, bindHost, resolve) })
	const sentinelAddress = egressSentinel.address()
	if (!sentinelAddress || typeof sentinelAddress === "string") throw new Error("could not bind the local egress sentinel")
	const sentinelUrl = `http://host.openshell.internal:${sentinelAddress.port}/probe`
	const brokerFactory = async (options: Parameters<typeof startOpenRouterBroker>[0]) => startOpenRouterBroker({
		...options,
		onHttpResponse: (event) => { httpStatuses.push(event); process.stdout.write(`BROKER_HTTP method=${event.method} status=${event.statusCode} requestBytes=${event.requestBytes ?? 0}\n`) },
		upstreamFetch: async (input, init) => {
			const url = String(input)
			if (url.endsWith(`/models/${RSI_OPENROUTER_MODEL}/endpoints`)) {
				return new Response(JSON.stringify({ data: { endpoints: [{ provider_slug: "deepseek", pricing: { prompt: "0.000001", completion: "0.000001" } }] } }), { status: 200, headers: { "content-type": "application/json" } })
			}
			assert.equal(url, "https://openrouter.ai/api/v1/chat/completions")
			assert.equal(new Headers(init?.headers).get("authorization"), `Bearer ${key}`)
			const body = JSON.parse(String(init?.body)) as { messages?: Array<{ role?: string }> }
			upstreamCalls += 1
			assert.ok(upstreamCalls <= 3, "the smoke is limited to three mock-model responses")
			const toolCalls = upstreamCalls === 1
				? [{ id: "mock-write-call", type: "function", function: { name: "write_to_file", arguments: JSON.stringify({ path: "src/result.js", content: "export const result = 'mocked'\n" }) } }]
				: upstreamCalls === 2
					? [{ id: "mock-egress-call", type: "function", function: { name: "execute_command", arguments: JSON.stringify({ command: `node -e 'fetch("${sentinelUrl}",{signal:AbortSignal.timeout(2500)}).then(()=>require("node:fs").writeFileSync("src/egress-probe.txt","allowed\\n")).catch(()=>require("node:fs").writeFileSync("src/egress-probe.txt","blocked\\n"))' && git add src/result.js src/egress-probe.txt && git -c core.hooksPath=/dev/null commit -m "mock task result"` }) } }]
					: [{ id: "mock-complete-call", type: "function", function: { name: "attempt_completion", arguments: JSON.stringify({ result: "Created the requested file and confirmed the local network sentinel was unreachable." }) } }]
			const message = { role: "assistant", tool_calls: toolCalls }
			assert.ok(body.messages?.length)
			return new Response(JSON.stringify({
				id: `mock-response-${upstreamCalls}`, model: RSI_OPENROUTER_MODEL,
				choices: [{ message, finish_reason: "tool_calls" }],
				usage: { prompt_tokens: 400, completion_tokens: 24, cost: 0.000424 },
			}), { status: 200, headers: { "content-type": "application/json" } })
		},
	})

	const imageName = `headlesscode-openshell-rsi:${harnessCommit}`
	const agent = new OpenShellBenchmarkAgent(repoRoot, (options) => new OpenShellSessionProvider(options), imageName, harnessCommit, undefined, "openshell-openrouter", brokerFactory)
const result = await agent.run({
		taskId: "mock-openrouter-smoke", attemptId: `attempt-${Date.now()}-mock`, campaignId: "rsi-mock-guest-smoke",
		brokerLedgerPath: path.join(root, "broker-ledger.json"), task: taskPrompt,
		seed: 17, workspace, harnessCommit,
		model: { provider: "openshell-openrouter", id: RSI_OPENROUTER_MODEL, sampling: { temperature: 0 } },
		ceilings: { maxCalls: 3, maxOutputTokensPerCall: 256, timeoutMs: 180_000, maxPatchBytes: 256 * 1024 },
})
if (result.validity !== "valid") process.stderr.write(`SMOKE_DIAGNOSTICS ${JSON.stringify({ validity: result.validity, stopReason: result.stopReason, stderr: result.stderr.replaceAll(key, "[REDACTED_KEY]").replaceAll(taskPrompt, "[REDACTED_TASK]"), stdout: result.stdout.replaceAll(key, "[REDACTED_KEY]").replaceAll(taskPrompt, "[REDACTED_TASK]").slice(-2000), upstreamCalls, httpStatuses, receipt: result.inferenceReceipt })}\n`)
assert.equal(result.validity, "valid", result.stderr)
	assert.ok(result.patch)
	assert.equal(result.inferenceReceipt?.qualified, true)
	assert.equal(result.inferenceReceipt?.calls, 3)
	assert.equal(result.inferenceReceipt?.model, RSI_OPENROUTER_MODEL)
	assert.deepEqual(result.inferenceReceipt?.returnedModels, [RSI_OPENROUTER_MODEL])
	assert.equal(upstreamCalls, 3)
	assert.equal(egressSentinelHits, 0, "the guest must not reach a live host endpoint outside the broker allowlist")
	execFileSync("git", ["apply", "--binary"], { cwd: workspace, input: result.patch })
	assert.match(await fs.readFile(path.join(workspace, "src", "egress-probe.txt"), "utf8"), /^blocked\s*$/)
	const returnedBytes = Buffer.concat([Buffer.from(result.stdout), Buffer.from(result.stderr), result.patch])
	assert.equal(returnedBytes.includes(Buffer.from(key)) || returnedBytes.includes(Buffer.from(taskPrompt)), false, "neither host credential nor task prompt may be copied into guest outputs")
	process.stdout.write(JSON.stringify({ status: "passed", harnessCommit, imageName, calls: result.inferenceReceipt.calls, totalTokens: result.inferenceReceipt.totalTokens, costUsd: result.inferenceReceipt.costUsd, egressSentinelHits, brokerHttpStatuses: httpStatuses, rawKeyInGuestResult: false }) + "\n")
} finally {
	if (egressSentinel?.listening) await new Promise<void>((resolve) => egressSentinel!.close(() => resolve()))
	await fs.rm(root, { recursive: true, force: true })
	for (const [name, value] of Object.entries(priorEnv)) {
		if (value === undefined) delete process.env[name]
		else process.env[name] = value
	}
}
