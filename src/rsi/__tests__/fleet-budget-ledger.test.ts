import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { test } from "node:test"
import { FleetBudgetInferenceLedger, verifyFleetBudgetBridgeRelease, verifyFleetBudgetCredential } from "../fleet-budget-ledger.js"
import type { OpenRouterBrokerGrant } from "../inference-broker.js"

const grant: OpenRouterBrokerGrant = {
  jobId: "job-123", leaseToken: "opaque", capability: "opaque", model: "meta/muse-spark-1.3-contributor",
  apiKeyIdentity: createHash("sha256").update("test-host-key").digest("hex"),
  profileId: "muse-spark-contributor", endpointPrice: { model: "meta/muse-spark-1.3-contributor", provider: "meta", endpointTag: "meta",
    quantization: "unknown", supportedParameters: ["max_tokens", "temperature", "tools", "tool_choice"],
    inputPricePerMillionUsd: 0.1, outputPricePerMillionUsd: 0.2, observedAt: new Date(0).toISOString(), responseSha256: "c".repeat(64) },
  limits: { campaignId: "fleet-security-watch", maxCalls: 3, maxInputTokensPerCall: 32_000, maxOutputTokensPerCall: 4_000,
    maxTotalTokens: 108_000, maxDurationMs: 300_000, maxRequestBytes: 1_000_000, maxResponseBytes: 64_000,
    maxInputPricePerMillionUsd: 1, maxOutputPricePerMillionUsd: 2, maxCallSpendUsd: 0.01, maxJobSpendUsd: 0.02, maxCampaignSpendUsd: 0.02 },
}
const reservation = { callId: "call-1", requestSha256: "a".repeat(64), reservedUsd: 0.01, reservedTokens: 1000, startedAt: new Date(0).toISOString() }

test("Fleet adapter emits shared-authority protocol and preserves receipt state", async () => {
  const seen: Record<string, unknown>[] = []
  const ledger = new FleetBudgetInferenceLedger({ expectedKeyIdentity: grant.apiKeyIdentity!, invoke: async (message) => {
    seen.push(message)
    if (message.op === "register") return { registered: true, deadlineAtMs: Number(message.issuedAtMs) + Number(message.maxDurationMs) }
    if (message.op === "reserve") return { reserved: true }
    if (message.op === "receipt") return { calls: [{ jobId: "job-123", campaignId: "fleet-security-watch", model: grant.model,
      callId: "call-1", requestSha256: reservation.requestSha256, reservedMicros: 10000, reservedTokens: 1000,
      state: "settled", settlement: { returnedModel: grant.model, returnedProvider: "meta", providerRequestId: "req-1",
        promptTokens: 5, cachedPromptTokens: 2, completionTokens: 4, costUsd: 0.00001, responseSha256: "b".repeat(64) } }] }
    return { settled: true, state: "settled" }
  } })
  await ledger.register(grant)
  await ledger.reserve(grant, reservation)
  await ledger.settle(grant, { callId: "call-1", state: "complete", returnedModel: grant.model, returnedProvider: "meta",
    providerRequestId: "req-1", promptTokens: 5, cachedPromptTokens: 2, completionTokens: 4, costUsd: 0.00001, responseSha256: "b".repeat(64), completedAt: new Date().toISOString() })
  const receipt = await ledger.receipt(grant)
  assert.equal(seen.find(x => x.op === "reserve")?.reservedMicros, 10000)
  const registered = seen.find(x => x.op === "register")
  assert.equal(registered?.maxTotalTokens, grant.limits.maxTotalTokens)
  assert.equal(registered?.maxCampaignSpendMicros, 20_000)
  assert.equal(registered?.maxCalls, 3)
  assert.equal(registered?.maxInputTokensPerCall, 32_000)
  assert.equal(registered?.maxOutputTokensPerCall, 4_000)
  assert.equal(registered?.maxTotalTokens, 108_000)
  assert.equal(receipt.accounting, "supervisor-enforced")
  assert.equal(receipt.costUsd, 0.00001)
  assert.equal(receipt.callReceipts[0]?.cachedPromptTokens, 2)
})

test("receipt accepts only the already-admitted Muse billing alias", async () => {
  const returned = "meta/muse-spark-1.3-contributor-20260902"
  const ledger = new FleetBudgetInferenceLedger({ expectedKeyIdentity: grant.apiKeyIdentity!, invoke: async (message) => {
    if (message.op === "receipt") return { calls: [{ jobId: grant.jobId, campaignId: grant.limits.campaignId, model: grant.model,
      callId: "call-1", requestSha256: reservation.requestSha256, reservedMicros: 10000, reservedTokens: 1000,
      state: "settled", settlement: { returnedModel: returned, returnedProvider: "meta", providerRequestId: "req-1",
        promptTokens: 9, cachedPromptTokens: 3, completionTokens: 6, costUsd: 0.00001, responseSha256: "b".repeat(64) } }] }
    return { registered: true, deadlineAtMs: Number(message.issuedAtMs) + Number(message.maxDurationMs) }
  } })
  const receipt = await ledger.receipt(grant)
  assert.equal(receipt.qualified, true)
  assert.equal(receipt.callReceipts[0]?.returnedModel, returned)
  assert.equal(receipt.callReceipts[0]?.cachedPromptTokens, 3)
  const wrong = new FleetBudgetInferenceLedger({ expectedKeyIdentity: grant.apiKeyIdentity!, invoke: async () => ({ calls: [{
    jobId: grant.jobId, campaignId: grant.limits.campaignId, model: grant.model, callId: "call-1",
    requestSha256: reservation.requestSha256, reservedMicros: 10000, reservedTokens: 1000, state: "settled",
    settlement: { returnedModel: "meta/muse-spark-1.3-contributor-latest", returnedProvider: "meta",
      providerRequestId: "req-1", promptTokens: 9, completionTokens: 6, costUsd: 0.00001, responseSha256: "b".repeat(64) },
  }] }) })
  assert.equal((await wrong.receipt(grant)).qualified, false)
})

test("ambiguous reserve and unmeasured settlement fail closed", async () => {
  let reserveCount = 0
  const ledger = new FleetBudgetInferenceLedger({ expectedKeyIdentity: grant.apiKeyIdentity!, invoke: async (message) => {
    if (message.op === "reserve") { reserveCount++; throw new Error("bridge response lost") }
    if (message.op === "settle") return { settled: false, state: "ambiguous" }
    return { registered: true, deadlineAtMs: Number(message.issuedAtMs) + Number(message.maxDurationMs) }
  } })
  await assert.rejects(ledger.reserve(grant, reservation), /bridge response lost/)
  assert.equal(reserveCount, 1)
  await ledger.settle(grant, { callId: "call-1", state: "unmeasured", completedAt: new Date().toISOString() })
})

test("reservation cannot exceed Fleet's fixed micro-dollar ceiling", async () => {
  const ledger = new FleetBudgetInferenceLedger({ expectedKeyIdentity: grant.apiKeyIdentity!, invoke: async () => ({ reserved: true }) })
  await assert.rejects(ledger.reserve(grant, { ...reservation, reservedUsd: 0.010001 }), /Fleet fixed ceiling/)
})

test("Fleet grant is bound to the exact selected host key identity", async () => {
  let calls = 0
  const ledger = new FleetBudgetInferenceLedger({ expectedKeyIdentity: grant.apiKeyIdentity!, invoke: async () => {
    calls++
    return { registered: true, deadlineAtMs: Date.now() + 30_000 }
  } })
  ledger.assertApiKey("test-host-key")
  assert.throws(() => ledger.assertApiKey("different-per-job-key"), /selected broker key/)
  await assert.rejects(ledger.register({ ...grant, apiKeyIdentity: "f".repeat(64) }), /key identity/)
  assert.equal(calls, 0)
})

async function makeRelease(includeBridge: boolean) {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), "fleet-budget-release-"))
  const source = path.join(parent, "source")
  await fs.mkdir(source)
  const relative = includeBridge ? "operations/campaign_budget_bridge.py" : "operations/other.py"
  const content = Buffer.from("fixed bridge fixture\n")
  const files = { [relative]: createHash("sha256").update(content).digest("hex") }
  const canonical = JSON.stringify({ files, work_target: source })
  const digest = createHash("sha256").update(canonical).digest("hex")
  const release = path.join(parent, digest)
  await fs.mkdir(path.join(release, "operations"), { recursive: true })
  await fs.writeFile(path.join(release, relative), content, { mode: 0o444 })
  await fs.chmod(path.join(release, "operations"), 0o555)
  await fs.symlink(source, path.join(release, "work"))
  await fs.writeFile(path.join(release, "release-manifest.json"), JSON.stringify({
    schema_version: 1, files, work_target: source, aggregate_digest: digest,
  }), { mode: 0o444 })
  await fs.chmod(release, 0o555)
  return { parent, release, config: { releaseRoot: release, stateRoot: path.join(parent, "state"), releaseDigest: digest } }
}

test("production bridge resolver requires the Python bridge in the verified release manifest", async () => {
  const valid = await makeRelease(true)
  const missing = await makeRelease(false)
  try {
    const resolved = await verifyFleetBudgetBridgeRelease(valid.config)
    assert.equal(resolved.releaseRoot, valid.release)
    assert.equal(resolved.bridgeModulePath, path.join(valid.release, "operations/campaign_budget_bridge.py"))
    await assert.rejects(verifyFleetBudgetBridgeRelease(missing.config), /does not include the budget bridge module/)
  } finally {
    for (const fixture of [valid, missing]) {
      await fs.chmod(path.join(fixture.release, "operations"), 0o755).catch(() => undefined)
      await fs.chmod(fixture.release, 0o755).catch(() => undefined)
      await fs.rm(fixture.parent, { recursive: true, force: true })
    }
  }
})

test("Fleet credential readiness verifies the private configured key identity without returning it", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "fleet-budget-credential-"))
  const keyPath = path.join(root, "credential")
  const configPath = path.join(root, "config.json")
  const uid = typeof process.getuid === "function" ? process.getuid() : 0
  try {
    const key = "synthetic-test-key-only"
    await fs.writeFile(keyPath, key, { mode: 0o600 })
    const config = { schema_version: 1, enabled: true, repository: "fixture", base_sha: "a".repeat(40), board_card: "fixture",
      image_digest: `sha256:${"b".repeat(64)}`, credential_file: keyPath, key_identity: createHash("sha256").update(key).digest("hex") }
    await fs.writeFile(configPath, JSON.stringify(config), { mode: 0o600 })
    assert.equal(await verifyFleetBudgetCredential(configPath, uid), true)
    await fs.chmod(keyPath, 0o644)
    assert.equal(await verifyFleetBudgetCredential(configPath, uid), false)
    await fs.chmod(keyPath, 0o600)
    await fs.writeFile(keyPath, "different-key")
    assert.equal(await verifyFleetBudgetCredential(configPath, uid), false)
  } finally { await fs.rm(root, { recursive: true, force: true }) }
})
