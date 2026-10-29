import assert from "node:assert/strict"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import { FileEvidenceCollector } from "../../evidence/collector.js"
import { main } from "../../cli.js"
import { OpenRouterClient } from "../../llm/openrouter.js"
import { RSI_MUSE_OPENROUTER_MODEL, startOpenRouterBroker } from "../../rsi/inference-broker.js"
import type { OpenRouterBrokerLimits, OpenRouterInferenceLedger } from "../../rsi/inference-broker.js"

function brokerLimits(): OpenRouterBrokerLimits {
	return { campaignId: "fleet-security-watch", maxCalls: 1, maxInputTokensPerCall: 120_000, maxOutputTokensPerCall: 32_768,
		maxTotalTokens: 160_000, maxDurationMs: 60_000, maxRequestBytes: 2_000_000, maxResponseBytes: 64_000,
		maxInputPricePerMillionUsd: 1, maxOutputPricePerMillionUsd: 1, maxCallSpendUsd: 1, maxJobSpendUsd: 1, maxCampaignSpendUsd: 1 }
}

async function pickPort(): Promise<number> {
	const net = await import("node:net")
	const server = net.createServer()
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
	const address = server.address(); assert.ok(address && typeof address !== "string")
	await new Promise<void>((resolve) => server.close(() => resolve()))
	return address.port
}

async function testContainedGuestCliUsesFakeBrokerWithoutRecursiveOpenShell(): Promise<void> {
	// The supervisor collector uses AF_UNIX; keep this fixture under /tmp so
	// long checkout paths do not exceed the platform socket-path limit.
	const root = await fs.mkdtemp(path.join("/tmp", "hcg-"))
	const workspace = path.join(root, "workspace")
	const evidenceDir = path.join(root, "evidence")
	await fs.mkdir(workspace, { mode: 0o700 }); await fs.chmod(workspace, 0o700)
	const prior = new Map<string, string | undefined>()
	const keys = ["HEADLESSCODE_SECURITY_PROFILE", "HEADLESSCODE_EVIDENCE_CONFIG_PATH", "HEADLESSCODE_CONTAINED_PROFILE", "HEADLESSCODE_CONTAINED_PROFILE_SHA256",
		"HEADLESSCODE_CODE_MODE_BACKEND", "HEADLESSCODE_RSI_INFERENCE_CAPABILITY", "HEADLESSCODE_OPENROUTER_API_KEY", "OPENROUTER_MODEL", "OPENROUTER_BASE_URL", "LLM_PROVIDER", "HEADLESSCODE_CONTROL_ID"]
	for (const key of keys) prior.set(key, process.env[key])
	let collector: FileEvidenceCollector | undefined
	let broker: Awaited<ReturnType<typeof startOpenRouterBroker>> | undefined
	const savedHome = process.cwd()
	try {
		const sessionId = "contained-worker-test"
		const socketPath = path.join(root, "collector.sock")
		collector = await FileEvidenceCollector.start({ storageDir: evidenceDir, socketPath })
		const evidenceCapability = await collector.authorizeSession(sessionId)
		const configPath = path.join(root, "runtime.json")
		await fs.writeFile(configPath, JSON.stringify({ sessionId, socketPath, capability: evidenceCapability,
			pinnedPublicKey: collector.publicKey, evidenceRequired: true }), { mode: 0o400 })
		await fs.chmod(configPath, 0o400)
		const events: string[] = []
		const ledger: OpenRouterInferenceLedger = {
			async register() { events.push("register"); return Date.now() + 55_000 },
			async reserve() { events.push("reserve") },
			async settle() { events.push("settle") },
			async recordDenial(_grant, status, reason) { events.push(`denial:${status}:${reason}`) },
			async receipt() { throw new Error("receipt is not needed in the CLI path") },
		}
		const upstreamFetch = (async (input: string | URL) => {
			const url = String(input)
			if (url.includes("/models/")) return new Response(JSON.stringify({ data: { endpoints: [{
				provider_name: "Meta", tag: "meta", quantization: "unknown", status: 0,
				pricing: { prompt: "0.0000001", completion: "0.0000002" },
				supported_parameters: ["tools", "tool_choice", "temperature", "seed", "max_tokens"],
				supports_tool_choice: { auto: true, required: true, function: true },
			}] } }), { status: 200 })
			events.push("fake-upstream-post")
			return new Response(JSON.stringify({ id: "offline-cli-1", model: RSI_MUSE_OPENROUTER_MODEL,
				choices: [{ index: 0, message: { role: "assistant", content: null, tool_calls: [{ id: "finish-1", type: "function", function: { name: "attempt_completion", arguments: JSON.stringify({ result: "Offline fixture completed." }) } }] }, finish_reason: "tool_calls" }],
				usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110, cost: 0.00001 },
				openrouter_metadata: { endpoints: { available: [{ provider: "meta", selected: true }] } },
			}), { status: 200, headers: { "content-type": "application/json" } })
		}) as typeof fetch
		broker = await startOpenRouterBroker({ jobId: "offline-contained-job-0001", leaseToken: "fixture-lease", model: RSI_MUSE_OPENROUTER_MODEL, profileId: "muse-spark-contributor",
			limits: brokerLimits(), apiKey: "fixture-upstream-key", bindHost: "127.0.0.1", port: await pickPort(), ledger, upstreamFetch })
		Object.assign(process.env, {
			HEADLESSCODE_SECURITY_PROFILE: "contained",
			HEADLESSCODE_EVIDENCE_CONFIG_PATH: configPath,
			HEADLESSCODE_CONTAINED_PROFILE: "/missing-host-profile-must-not-be-read-in-guest",
			HEADLESSCODE_CONTAINED_PROFILE_SHA256: "f".repeat(64),
			HEADLESSCODE_CODE_MODE_BACKEND: "openrouter",
			HEADLESSCODE_RSI_INFERENCE_CAPABILITY: broker.capability,
			OPENROUTER_MODEL: RSI_MUSE_OPENROUTER_MODEL,
			OPENROUTER_BASE_URL: broker.localBaseUrl,
			LLM_PROVIDER: "openrouter",
		})
		delete process.env.HEADLESSCODE_OPENROUTER_API_KEY
		delete process.env.HEADLESSCODE_CONTROL_ID
		const client = new OpenRouterClient({ apiKey: broker.capability, baseUrl: broker.localBaseUrl, defaultModel: RSI_MUSE_OPENROUTER_MODEL })
		process.env.HEADLESSCODE_EVIDENCE_CONFIG_PATH = path.join(root, "missing-runtime.json")
		const deniedStderr: string[] = []
		const denied = await main(["--task", "Review the offline fixture.", "--workspace", workspace, "--mode", "code", "--model", RSI_MUSE_OPENROUTER_MODEL,
			"--session-id", sessionId, "--security-profile", "local", "--max-iterations", "1", "--no-memory", "--no-checkpoints"], {
			llmClient: client, quiet: true, stderr: { write: (value) => { deniedStderr.push(value); return true } },
		})
		assert.equal(denied, 2)
		assert.match(deniedStderr.join(""), /invalid evidence runtime configuration/)
		assert.equal(events.includes("reserve"), false, "missing supervisor evidence is rejected before spend reservation")
		assert.equal(events.includes("fake-upstream-post"), false, "missing supervisor evidence is rejected before model dispatch")
		events.length = 0
		process.env.HEADLESSCODE_EVIDENCE_CONFIG_PATH = configPath
		const stdout: string[] = [], stderr: string[] = []
		const result = await main(["--task", "Review the offline fixture.", "--workspace", workspace, "--mode", "code", "--model", RSI_MUSE_OPENROUTER_MODEL,
			"--session-id", sessionId, "--security-profile", "local", "--max-iterations", "1", "--no-memory", "--no-checkpoints"], {
			llmClient: client, quiet: true, stdout: { write: (value) => { stdout.push(value); return true } }, stderr: { write: (value) => { stderr.push(value); return true } },
		})
		assert.equal(result, 0, `guest CLI exit code; stderr=${stderr.join("")}`)
		assert.equal(events.filter((event) => event === "fake-upstream-post").length, 1, "CLI submitted exactly one request to the isolated fake broker")
		assert.deepEqual(events, ["reserve", "fake-upstream-post", "settle"], `broker events=${events.join(",")}; stderr=${stderr.join("")}`)
		assert.equal(stderr.join("").includes("contained security preflight"), false, "the guest did not recursively run host OpenShell preflight")
	} finally {
		process.chdir(savedHome)
		for (const key of keys) {
			const value = prior.get(key)
			if (value === undefined) delete process.env[key]; else process.env[key] = value
		}
		await broker?.close()
		await collector?.close()
		await fs.rm(root, { recursive: true, force: true })
	}
}

await testContainedGuestCliUsesFakeBrokerWithoutRecursiveOpenShell()
console.log("All 1 contained guest CLI integration tests passed")
