import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { spawnSync } from "node:child_process"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { test } from "node:test"
import { FleetBudgetInferenceLedger } from "../fleet-budget-ledger.js"
import { RSI_MUSE_OPENROUTER_BILLING_MODEL, RSI_MUSE_OPENROUTER_MODEL, startOpenRouterBroker } from "../inference-broker.js"
import type { OpenRouterBrokerLimits } from "../inference-broker.js"

const fakeKey = "fleet-integration-private-test-key"
const keyIdentity = createHash("sha256").update(fakeKey).digest("hex")
const limits: OpenRouterBrokerLimits = {
  campaignId: "fleet-security-watch", maxCalls: 3, maxInputTokensPerCall: 32_000,
  maxOutputTokensPerCall: 4_000, maxTotalTokens: 108_000, maxDurationMs: 300_000,
  maxRequestBytes: 1_000_000, maxResponseBytes: 64_000, maxInputPricePerMillionUsd: 0.1,
  maxOutputPricePerMillionUsd: 0.2, maxCallSpendUsd: 0.01, maxJobSpendUsd: 0.02,
  maxCampaignSpendUsd: 0.02,
}
const bridgeScript = `
import json, sys
from unittest.mock import patch
import operations.campaign_budget as budget
import operations.campaign_budget_bridge as bridge
with patch.object(budget, "_provider_snapshot", return_value={"limit_micros": 5000000, "remaining_micros": 5000000, "usage_micros": 0}):
    print(json.dumps(bridge._authority().dispatch(json.load(sys.stdin)), separators=(",", ":")))
`

function setupPaths(home: string) {
  const campaign = path.join(home, ".local", "state", "fleet-security-watch", "automation", "campaign")
  const control = path.join(home, ".local", "share", "headlesscode", "campaign-control")
  return { campaign, control, credential: path.join(campaign, "test-key"), config: path.join(campaign, "config.json"), controlFile: path.join(control, "control.json") }
}

async function privateDir(directory: string) { await fs.mkdir(directory, { recursive: true, mode: 0o700 }); await fs.chmod(directory, 0o700) }
async function writeControl(file: string, epoch: number, enabled = true) {
  const now = Date.now()
  const record = { schemaVersion: 1, campaignId: "fleet-security-watch", enabled, canAdmit: enabled,
    epoch, budgetLimitMicros: 5_000_000, month: new Date().toISOString().slice(0, 7),
    settledMicros: 0, reservedMicros: 0, ambiguousMicros: 0,
    activeRun: { id: `test-run-${epoch}`, epoch, startedAt: now - 1_000, expiresAt: now + 300_000 } }
  await fs.writeFile(file, JSON.stringify(record), { mode: 0o600 }); await fs.chmod(file, 0o600)
}

async function makeFixture(prefix: string) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), `${prefix}-`))
  await fs.chmod(home, 0o700)
  const files = setupPaths(home)
  await privateDir(files.campaign); await privateDir(files.control)
  await fs.writeFile(files.credential, fakeKey, { mode: 0o600 }); await fs.chmod(files.credential, 0o600)
  await fs.writeFile(files.config, JSON.stringify({ schema_version: 1, enabled: true,
    repository: "/unused-test-repository", base_sha: "a".repeat(40), board_card: "3fa4ce2b",
    image_digest: "b".repeat(64), credential_file: files.credential, key_identity: keyIdentity }), { mode: 0o600 })
  await fs.chmod(files.config, 0o600)
  await writeControl(files.controlFile, 3)
  const fleetRoot = path.resolve(process.cwd(), "../fleet-security-watch")
  const invoke = async (message: Record<string, unknown>) => {
    const child = spawnSync("/usr/bin/python3", ["-c", bridgeScript], { input: JSON.stringify(message),
      encoding: "utf8", timeout: 10_000, env: { HOME: home, PATH: process.env.PATH ?? "/usr/bin:/bin",
        PYTHONPATH: fleetRoot, PYTHONDONTWRITEBYTECODE: "1" } })
    if (child.error || child.status !== 0) throw new Error("real Fleet bridge subprocess failed closed")
    return JSON.parse(child.stdout.trim()) as Record<string, unknown>
  }
  const ledger = new FleetBudgetInferenceLedger({ expectedKeyIdentity: keyIdentity, invoke })
  return { home, files, ledger, cleanup: () => fs.rm(home, { recursive: true, force: true }) }
}

function metaEndpoint() {
  return { provider_name: "Meta", tag: "meta", quantization: "unknown", status: 0,
    pricing: { prompt: "0.0000001", completion: "0.0000002" },
    supported_parameters: ["tools", "tool_choice", "temperature", "max_tokens"],
    supports_tool_choice: { auto: true, required: true, function: true } }
}
function response(model: string) {
  return { id: `integration-${model.endsWith("20260902") ? "alias" : "canonical"}`, model,
    choices: [{ message: { content: "bounded mock completion" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 12, prompt_tokens_details: { cached_tokens: 3 }, completion_tokens: 5, cost: 0.0001 },
    openrouter_metadata: { endpoints: { available: [{ provider: "meta", selected: true }] } } }
}
function requestBody() { return JSON.stringify({ model: RSI_MUSE_OPENROUTER_MODEL,
  messages: [{ role: "user", content: "synthetic integration fixture" }], max_tokens: 32 }) }
async function start(fixture: Awaited<ReturnType<typeof makeFixture>>, jobId: string, upstreamFetch: typeof fetch, now = () => Date.now()) {
  return await startOpenRouterBroker({ jobId, leaseToken: `lease-${jobId}`, model: RSI_MUSE_OPENROUTER_MODEL,
    profileId: "muse-spark-contributor", limits, apiKey: fakeKey, bindHost: "127.0.0.1",
    ledger: fixture.ledger, upstreamFetch, now })
}
function endpointResponse(input: string | URL, init?: RequestInit) {
  if (String(input).includes("/models/")) return Promise.resolve(new Response(JSON.stringify({ data: { endpoints: [metaEndpoint()] } }), { status: 200 }))
  const body = JSON.parse(String(init?.body)) as { model: string }
  return Promise.resolve(new Response(JSON.stringify(response(body.model)), { status: 200,
    headers: { "content-type": "application/json" } }))
}

test("HCL broker and real Python Fleet authority settle canonical and admitted alias calls", async (t) => {
  const fixture = await makeFixture("fleet-bridge-normal")
  t.after(fixture.cleanup)
  let completion = 0
  const upstream = (async (input: string | URL, init?: RequestInit) => {
    if (String(input).includes("/models/")) return await endpointResponse(input, init)
    completion++
    return new Response(JSON.stringify(response(completion === 1 ? RSI_MUSE_OPENROUTER_MODEL : RSI_MUSE_OPENROUTER_BILLING_MODEL)),
      { status: 200, headers: { "content-type": "application/json" } })
  }) as typeof fetch
  const broker = await start(fixture, "attempt-real-fleet-normal-123", upstream)
  try {
    for (const callId of ["canonical-integration-call-01", "billing-alias-integration-2"]) {
      const result = await fetch(`${broker.localBaseUrl}/api/v1/chat/completions`, {
        method: "POST", headers: { authorization: `Bearer ${broker.capability}`, "content-type": "application/json", "x-rsi-call-id": callId },
        body: requestBody(),
      })
      assert.equal(result.status, 200)
    }
    const receipt = await broker.receipt()
    assert.equal(receipt.qualified, true)
    assert.equal(receipt.calls, 2)
    assert.equal(receipt.costUsd, 0.0002)
    assert.deepEqual(receipt.returnedModels, [RSI_MUSE_OPENROUTER_BILLING_MODEL, RSI_MUSE_OPENROUTER_MODEL])
    assert.deepEqual(receipt.callReceipts.map((call) => call.cachedPromptTokens), [3, 3])
  } finally { await broker.close() }
})

test("authenticated Muse discovery is served from the admitted snapshot without contaminating the receipt", async (t) => {
  const fixture = await makeFixture("fleet-bridge-muse-discovery")
  t.after(fixture.cleanup)
  const upstreamUrls: string[] = []
  const upstream = (async (input: string | URL, init?: RequestInit) => {
    upstreamUrls.push(String(input))
    return await endpointResponse(input, init)
  }) as typeof fetch
  const broker = await start(fixture, "attempt-muse-discovery-123", upstream)
  try {
    const discovery = await fetch(`${broker.localBaseUrl}/api/v1/models/${RSI_MUSE_OPENROUTER_MODEL}/endpoints`, {
      headers: { authorization: `Bearer ${broker.capability}` },
    })
    assert.equal(discovery.status, 200)
    const metadata = await discovery.json() as { data?: { endpoints?: Array<Record<string, unknown>> } }
    const discovered = metadata.data?.endpoints?.[0]
    assert.equal(discovered?.provider_name, "Meta")
    assert.equal(discovered?.tag, "meta")
    assert.equal(discovered?.quantization, "unknown")
    assert.equal(discovered?.status, 0)
    assert.deepEqual(discovered?.supported_parameters, metaEndpoint().supported_parameters)
    assert.deepEqual(discovered?.supports_tool_choice, { auto: true, required: true })
    const discoveredPricing = discovered?.pricing as { prompt?: unknown; completion?: unknown }
    assert.equal(Number(discoveredPricing.prompt), Number(metaEndpoint().pricing.prompt))
    assert.equal(Number(discoveredPricing.completion), Number(metaEndpoint().pricing.completion))
    assert.equal(upstreamUrls.filter((url) => url.includes("/models/")).length, 1,
      "only the host preflight reached OpenRouter; guest discovery reads the cached admitted snapshot")

    const responseResult = await fetch(`${broker.localBaseUrl}/api/v1/chat/completions`, {
      method: "POST", headers: { authorization: `Bearer ${broker.capability}`, "content-type": "application/json", "x-rsi-call-id": "muse-discovery-post-0001" },
      body: requestBody(),
    })
    assert.equal(responseResult.status, 200)
    const receipt = await broker.receipt()
    assert.equal(receipt.qualified, true)
    assert.deepEqual(receipt.denials, [])
    assert.equal(receipt.calls, 1)
  } finally { await broker.close() }
})

test("other metadata routes remain denied and contaminate the Fleet receipt", async (t) => {
  const fixture = await makeFixture("fleet-bridge-unknown-discovery")
  t.after(fixture.cleanup)
  let upstreamMetadataGets = 0
  const upstream = (async (input: string | URL, init?: RequestInit) => {
    if (String(input).includes("/models/")) upstreamMetadataGets++
    return await endpointResponse(input, init)
  }) as typeof fetch
  const broker = await start(fixture, "attempt-unknown-discovery-123", upstream)
  try {
    for (const suffix of ["other/model/endpoints", `${RSI_MUSE_OPENROUTER_MODEL}/endpoints?fallback=true`]) {
      const denied = await fetch(`${broker.localBaseUrl}/api/v1/models/${suffix}`, {
        headers: { authorization: `Bearer ${broker.capability}` },
      })
      assert.equal(denied.status, 404)
    }
    const receipt = await broker.receipt()
    assert.equal(receipt.qualified, false)
    assert.deepEqual(receipt.denials.map(({ statusCode, reason, count }) => ({ statusCode, reason, count })), [
      { statusCode: 404, reason: "unsupported-endpoint", count: 2 },
    ])
    assert.equal(upstreamMetadataGets, 1, "unknown guest routes never reach the provider")
  } finally { await broker.close() }
})

test("real Fleet bridge persists HTTP 403 ambiguity across fresh bridge processes and denies another POST", async (t) => {
  const fixture = await makeFixture("fleet-bridge-403")
  t.after(fixture.cleanup)
  const upstreamCalls: string[] = []
  const upstream = (async (input: string | URL) => {
    const url = String(input); upstreamCalls.push(url)
    if (url.includes("/models/")) return new Response(JSON.stringify({ data: { endpoints: [metaEndpoint()] } }), { status: 200 })
    return new Response(JSON.stringify({ error: { message: "private mocked denial" } }), { status: 403,
      headers: { "content-type": "application/json" } })
  }) as typeof fetch
  const broker = await start(fixture, "attempt-real-fleet-403-123", upstream)
  try {
    const first = await fetch(`${broker.localBaseUrl}/api/v1/chat/completions`, {
      method: "POST", headers: { authorization: `Bearer ${broker.capability}`, "content-type": "application/json", "x-rsi-call-id": "first-fleet-403-call-01" }, body: requestBody(),
    })
    assert.equal(first.status, 502)
    assert.equal((await first.text()).includes("private mocked denial"), false)
    const second = await fetch(`${broker.localBaseUrl}/api/v1/chat/completions`, {
      method: "POST", headers: { authorization: `Bearer ${broker.capability}`, "content-type": "application/json", "x-rsi-call-id": "fresh-fleet-call-after-403" }, body: requestBody(),
    })
    assert.equal(second.status, 429)
    assert.equal(upstreamCalls.filter((url) => url.endsWith("/chat/completions")).length, 1)
  } finally { await broker.close() }
})

test("real Fleet bridge rejects new calls immediately after owner control moves OFF", async (t) => {
  const fixture = await makeFixture("fleet-bridge-off")
  t.after(fixture.cleanup)
  const upstreamCalls: string[] = []
  const upstream = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input); upstreamCalls.push(url)
    if (url.includes("/models/")) return await endpointResponse(input, init)
    return new Response(JSON.stringify(response(RSI_MUSE_OPENROUTER_MODEL)), { status: 200,
      headers: { "content-type": "application/json" } })
  }) as typeof fetch
  const broker = await start(fixture, "attempt-real-fleet-off-123", upstream)
  try {
    await writeControl(fixture.files.controlFile, 4, false)
    const denied = await fetch(`${broker.localBaseUrl}/api/v1/chat/completions`, {
      method: "POST", headers: { authorization: `Bearer ${broker.capability}`, "content-type": "application/json", "x-rsi-call-id": "fleet-off-fenced-call-01" },
      body: requestBody(),
    })
    assert.equal(denied.status, 429)
    assert.equal(upstreamCalls.filter((url) => url.endsWith("/chat/completions")).length, 0)
  } finally { await broker.close() }
})
