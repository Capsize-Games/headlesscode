import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import { createServer } from "node:http"
import { OpenShellBenchmarkAgent, initializeTaskRepository } from "../../src/rsi/benchmark/openshell-agent.js"
import {
	openRouterProfileForModel,
	RSI_MUSE_OPENROUTER_BILLING_MODEL,
	RSI_MUSE_OPENROUTER_MODEL,
	RSI_OPENROUTER_MODEL,
	startOpenRouterBroker,
} from "../../src/rsi/inference-broker.js"
import { OpenShellSessionProvider } from "../../src/cloud/openshell-provider.js"

let museProfile = false
let requestedRepoRoot: string | undefined
for (const argument of process.argv.slice(2)) {
	if (argument === "--muse") {
		if (museProfile) throw new Error("--muse may be specified only once")
		museProfile = true
	} else if (argument.startsWith("--")) {
		throw new Error(`unknown option: ${argument}; usage: mock-openrouter-guest-smoke.ts [repo] [--muse]`)
	} else if (requestedRepoRoot !== undefined) {
		throw new Error("usage: mock-openrouter-guest-smoke.ts [repo] [--muse]")
	} else {
		requestedRepoRoot = argument
	}
}
const repoRoot = path.resolve(requestedRepoRoot ?? process.cwd())
const harnessCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" }).trim()
const bindHost = process.env.HEADLESSCODE_RSI_BROKER_BIND_HOST?.trim()
if (!bindHost) throw new Error("Set HEADLESSCODE_RSI_BROKER_BIND_HOST to a gateway-reachable host interface address")
const model = museProfile ? RSI_MUSE_OPENROUTER_MODEL : RSI_OPENROUTER_MODEL
const profile = openRouterProfileForModel(model, museProfile ? "muse-spark-contributor" : undefined)
const returnedModel = museProfile ? RSI_MUSE_OPENROUTER_BILLING_MODEL : model
const taskPrompt = "Create src/result.js and confirm the host sentinel remains unreachable."
const scratchRoot = path.join(repoRoot, ".headlesscode", "scratch")
await fs.mkdir(scratchRoot, { recursive: true, mode: 0o700 })
process.env.TMPDIR = scratchRoot
const root = await fs.mkdtemp(path.join(scratchRoot, "rsi-openrouter-guest-smoke-"))
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
	// These synthetic metadata and usage rates exercise the route without describing live pricing.
	const inputPricePerMillionUsd = museProfile ? 0.5 : 1
	const cachedInputPricePerMillionUsd = museProfile ? 0.05 : inputPricePerMillionUsd
	const outputPricePerMillionUsd = museProfile ? 0.75 : 1
	const cachedPromptTokens = museProfile ? 320 : 0
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
			if (url.endsWith(`/models/${model}/endpoints`)) {
				return new Response(JSON.stringify({ data: { endpoints: [{
					provider_name: profile.endpointProviderName,
					tag: profile.endpointTag,
					quantization: profile.quantization,
					status: 0,
					supported_parameters: ["tools", "tool_choice", "temperature", "seed", "max_tokens"],
					supports_tool_choice: { auto: true, required: true, function: true },
					pricing: { prompt: String(inputPricePerMillionUsd / 1_000_000), completion: String(outputPricePerMillionUsd / 1_000_000) },
				}] } }), { status: 200, headers: { "content-type": "application/json" } })
			}
			assert.equal(url, "https://openrouter.ai/api/v1/chat/completions")
			assert.equal(new Headers(init?.headers).get("authorization"), `Bearer ${key}`)
			const body = JSON.parse(String(init?.body)) as {
				model?: string
				messages?: Array<{ role?: string }>
				provider?: { only?: string[]; allow_fallbacks?: boolean }
				session_id?: string
				prompt_cache_key?: string
			}
			assert.equal(body.model, model)
			assert.deepEqual(body.provider, { only: [profile.endpointProvider], allow_fallbacks: false })
			if (museProfile) {
				assert.ok(body.session_id)
				assert.equal(body.prompt_cache_key, body.session_id)
				assert.notEqual(body.session_id, "rsi-mock-guest-smoke")
			} else {
				assert.equal(body.session_id, undefined)
				assert.equal(body.prompt_cache_key, undefined)
			}
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
				id: `mock-response-${upstreamCalls}`, model: returnedModel,
				openrouter_metadata: { endpoints: { available: [{ provider: profile.endpointProvider, selected: true }] } },
				choices: [{ message, finish_reason: "tool_calls" }],
				usage: {
					prompt_tokens: 400,
					...(museProfile ? { prompt_tokens_details: { cached_tokens: cachedPromptTokens } } : {}),
					completion_tokens: 24,
					cost: ((400 - cachedPromptTokens) * inputPricePerMillionUsd + cachedPromptTokens * cachedInputPricePerMillionUsd + 24 * outputPricePerMillionUsd) / 1_000_000,
				},
			}), { status: 200, headers: { "content-type": "application/json" } })
		},
	})

	const imageName = `headlesscode-openshell-rsi:${harnessCommit}`
	const agent = new OpenShellBenchmarkAgent(repoRoot, (options) => new OpenShellSessionProvider(options), imageName, harnessCommit, undefined, "openshell-openrouter", brokerFactory)
	const result = await agent.run({
		taskId: "mock-openrouter-smoke", attemptId: `attempt-${Date.now()}-mock`, campaignId: "rsi-mock-guest-smoke",
		brokerLedgerPath: path.join(root, "broker-ledger.json"), task: taskPrompt,
		seed: 17, workspace, harnessCommit,
		model: { provider: "openshell-openrouter", id: model, sampling: { temperature: 0 } },
		ceilings: { maxCalls: 3, maxOutputTokensPerCall: 256, timeoutMs: 180_000, maxPatchBytes: 256 * 1024 },
	})
	if (result.validity !== "valid") process.stderr.write(`SMOKE_DIAGNOSTICS ${JSON.stringify({ validity: result.validity, stopReason: result.stopReason, stderr: result.stderr.replaceAll(key, "[REDACTED_KEY]").replaceAll(taskPrompt, "[REDACTED_TASK]"), stdout: result.stdout.replaceAll(key, "[REDACTED_KEY]").replaceAll(taskPrompt, "[REDACTED_TASK]").slice(-2000), upstreamCalls, httpStatuses, receipt: result.inferenceReceipt })}\n`)
	assert.equal(result.validity, "valid", result.stderr)
	assert.ok(result.patch)
	assert.equal(result.inferenceReceipt?.qualified, true)
	assert.equal(result.inferenceReceipt?.calls, 3)
	assert.equal(result.inferenceReceipt?.model, model)
	assert.deepEqual(result.inferenceReceipt?.returnedModels, [returnedModel])
	assert.equal(result.inferenceReceipt?.endpointProvider, profile.endpointProvider)
	if (museProfile) {
		assert.equal(result.inferenceReceipt?.profileId, profile.id)
		assert.equal(result.inferenceReceipt?.endpointPrice?.inputPricePerMillionUsd, inputPricePerMillionUsd)
		assert.equal(result.inferenceReceipt?.endpointPrice?.outputPricePerMillionUsd, outputPricePerMillionUsd)
		assert.ok(result.inferenceReceipt?.callReceipts.every((call) => call.cachedPromptTokens === cachedPromptTokens))
		assert.equal(result.inferenceReceipt?.callReceipts.reduce((sum, call) => sum + (call.cachedPromptTokens ?? 0), 0), 3 * cachedPromptTokens)
	} else {
		assert.equal(result.inferenceReceipt?.model, RSI_OPENROUTER_MODEL)
		assert.deepEqual(result.inferenceReceipt?.returnedModels, [RSI_OPENROUTER_MODEL])
	}
	assert.equal(upstreamCalls, 3)
	assert.equal(egressSentinelHits, 0, "the guest must not reach a live host endpoint outside the broker allowlist")
	execFileSync("git", ["apply", "--binary"], { cwd: workspace, input: result.patch })
	assert.match(await fs.readFile(path.join(workspace, "src", "egress-probe.txt"), "utf8"), /^blocked\s*$/)
	const returnedBytes = Buffer.concat([Buffer.from(result.stdout), Buffer.from(result.stderr), result.patch])
	assert.equal(returnedBytes.includes(Buffer.from(key)) || returnedBytes.includes(Buffer.from(taskPrompt)), false, "neither host credential nor task prompt may be copied into guest outputs")
	process.stdout.write(JSON.stringify({ status: "passed", profile: profile.id, model, harnessCommit, imageName, calls: result.inferenceReceipt.calls, totalTokens: result.inferenceReceipt.totalTokens, cachedPromptTokens: result.inferenceReceipt.callReceipts.reduce((sum, call) => sum + (call.cachedPromptTokens ?? 0), 0), costUsd: result.inferenceReceipt.costUsd, egressSentinelHits, brokerHttpStatuses: httpStatuses, rawKeyInGuestResult: false }) + "\n")
} finally {
	if (egressSentinel?.listening) await new Promise<void>((resolve) => egressSentinel!.close(() => resolve()))
	await fs.rm(root, { recursive: true, force: true })
	for (const [name, value] of Object.entries(priorEnv)) {
		if (value === undefined) delete process.env[name]
		else process.env[name] = value
	}
}
