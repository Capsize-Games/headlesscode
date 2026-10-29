/** Host adapter to Fleet's one durable spend authority. No provider credential crosses this boundary. */
import { createHash } from "node:crypto"
import { spawn, type StdioOptions } from "node:child_process"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { CAMPAIGN_ADAPTER_FILE } from "../campaigncontrol/paths.js"
import { loadCampaignAdapterConfig, verifyCampaignRelease, type CampaignAdapterConfig } from "../campaigncontrol/runner.js"
import type {
  OpenRouterBrokerGrant, OpenRouterBrokerReceipt, OpenRouterCallReceipt,
  OpenRouterCallReservation, OpenRouterCallSettlement, OpenRouterDenialReason,
  OpenRouterInferenceLedger,
} from "./inference-broker.js"

const MAX_REPLY = 64 * 1024
const MAX_REQUEST = 32 * 1024
const BRIDGE_MODULE = "operations/campaign_budget_bridge.py"
export const FLEET_BUDGET_CAMPAIGN_ID = "fleet-security-watch" as const
const FLEET_CAMPAIGN_CONFIG = path.join(os.homedir(), ".local", "state", "fleet-security-watch", "automation", "campaign", "config.json")

/** Verify the configured Fleet key in place without returning or logging its value. */
export async function verifyFleetBudgetCredential(configPath = FLEET_CAMPAIGN_CONFIG, expectedUid = typeof process.getuid === "function" ? process.getuid() : 0): Promise<boolean> {
  let configHandle: fs.FileHandle | undefined
  let keyHandle: fs.FileHandle | undefined
  try {
    const configParent = await fs.lstat(path.dirname(configPath))
    if (!configParent.isDirectory() || configParent.isSymbolicLink() || configParent.uid !== expectedUid || (configParent.mode & 0o077) !== 0) return false
    configHandle = await fs.open(configPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
    const configStat = await configHandle.stat()
    if (!configStat.isFile() || configStat.nlink !== 1 || configStat.uid !== expectedUid || (configStat.mode & 0o077) !== 0 || configStat.size > 32 * 1024) return false
    const config: unknown = JSON.parse(await configHandle.readFile("utf8"))
    const expected = "base_sha,board_card,credential_file,enabled,image_digest,key_identity,repository,schema_version"
    if (!config || typeof config !== "object" || Array.isArray(config) || Object.keys(config).sort().join(",") !== expected) return false
    const row = config as Record<string, unknown>
    if (row.schema_version !== 1 || row.enabled !== true || typeof row.credential_file !== "string" || !path.isAbsolute(row.credential_file) ||
        typeof row.key_identity !== "string" || !/^[a-f0-9]{64}$/.test(row.key_identity)) return false
    const keyParent = await fs.lstat(path.dirname(row.credential_file))
    if (!keyParent.isDirectory() || keyParent.isSymbolicLink() || keyParent.uid !== expectedUid || (keyParent.mode & 0o022) !== 0) return false
    keyHandle = await fs.open(row.credential_file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
    const keyStat = await keyHandle.stat()
    if (!keyStat.isFile() || keyStat.nlink !== 1 || keyStat.uid !== expectedUid || (keyStat.mode & 0o077) !== 0 || keyStat.size < 1 || keyStat.size > 4096) return false
    const key = (await keyHandle.readFile()).toString("utf8").trim()
    return Boolean(key && !/[\r\n]/.test(key) && createHash("sha256").update(key).digest("hex") === row.key_identity)
  } catch { return false }
  finally { await configHandle?.close().catch(() => undefined); await keyHandle?.close().catch(() => undefined) }
}

type BridgeReply = Record<string, unknown>
export interface FleetBudgetLedgerOptions {
  /** SHA-256 of the host key selected for OpenRouter; the credential itself never crosses this adapter. */
  expectedKeyIdentity: string
  /** Test seam; production defaults are fixed and never grant-controlled. */
  python?: string
  timeoutMs?: number
  invoke?: (message: Record<string, unknown>) => Promise<BridgeReply>
}

function safeText(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 256) throw new Error(`invalid ${name}`)
  return value
}
function micros(usd: number, maximum = 10_000): number {
  if (!Number.isFinite(usd) || usd <= 0) throw new Error("invalid Fleet reservation")
  const n = Math.ceil(usd * 1_000_000)
  if (!Number.isSafeInteger(n) || n > maximum) throw new Error("reservation exceeds Fleet fixed ceiling")
  return n
}

export class FleetBudgetInferenceLedger implements OpenRouterInferenceLedger {
  readonly requiresHostApiKeyIdentity = true
  private readonly call: (message: Record<string, unknown>) => Promise<BridgeReply>
  private readonly expectedKeyIdentity: string
  private readonly jobs = new Map<string, OpenRouterBrokerGrant>()
  constructor(options: FleetBudgetLedgerOptions) {
    if (!/^[a-f0-9]{64}$/.test(options.expectedKeyIdentity)) throw new Error("Fleet ledger requires a host API-key identity")
    if (!options.invoke && (options.python !== undefined || options.timeoutMs !== undefined))
      throw new Error("Fleet bridge process overrides are restricted to the injected test seam")
    this.expectedKeyIdentity = options.expectedKeyIdentity
    this.call = options.invoke ?? ((message) => invokeBridge(message, options))
  }
  assertApiKey(apiKey: string): void {
    const identity = createHash("sha256").update(apiKey).digest("hex")
    if (identity !== this.expectedKeyIdentity) throw new Error("Fleet ledger host API-key identity differs from selected broker key")
  }
  async register(grant: OpenRouterBrokerGrant): Promise<number> {
    this.remember(grant)
    const issued = grant.issuedAtMs ?? Date.now()
    const duration = grant.limits.maxDurationMs
    if (!Number.isSafeInteger(issued) || !Number.isSafeInteger(duration) || duration < 1) throw new Error("invalid Fleet job deadline")
    grant.issuedAtMs = issued
    const result = await this.call({ ...this.identity("register", grant), ...this.grantLimits(grant), issuedAtMs: issued })
    if (!Number.isSafeInteger(result.deadlineAtMs) || Number(result.deadlineAtMs) <= Date.now()
        || Number(result.deadlineAtMs) > issued + duration) throw new Error("Fleet authority returned an invalid grant deadline")
    return Number(result.deadlineAtMs)
  }
  async recordDenial(grant: OpenRouterBrokerGrant, statusCode: number, reason: OpenRouterDenialReason): Promise<void> {
    this.remember(grant)
    if (!Number.isInteger(statusCode) || statusCode < 100 || statusCode > 599) throw new Error("invalid denial status")
    await this.call({ ...this.identity("denial", grant), statusCode, reason })
  }
  async reserve(grant: OpenRouterBrokerGrant, reservation: OpenRouterCallReservation): Promise<void> {
    this.remember(grant)
    safeText(reservation.callId, "call id")
    if (!/^[a-f0-9]{64}$/.test(reservation.requestSha256)) throw new Error("invalid request digest")
    if (!Number.isSafeInteger(reservation.reservedTokens) || reservation.reservedTokens < 1) throw new Error("invalid token reservation")
    const result = await this.call({ ...this.identity("reserve", grant), ...this.grantLimits(grant), callId: reservation.callId,
      requestSha256: reservation.requestSha256, reservedMicros: micros(reservation.reservedUsd),
      reservedTokens: reservation.reservedTokens, startedAt: reservation.startedAt,
    })
    if (result.reserved !== true) throw new Error("Fleet authority did not reserve and claim call")
  }
  async settle(grant: OpenRouterBrokerGrant, settlement: OpenRouterCallSettlement & { callId: string }): Promise<void> {
    this.remember(grant)
    safeText(settlement.callId, "call id")
    const result = await this.call({ ...this.identity("settle", grant), callId: settlement.callId, settlement })
    if (settlement.state === "complete" && result.settled !== true) throw new Error("Fleet authority could not settle measured call; job must stop")
  }
  async receipt(grant: OpenRouterBrokerGrant): Promise<OpenRouterBrokerReceipt> {
    this.remember(grant)
    const result = await this.call(this.identity("receipt", grant))
    const rows = Array.isArray(result.calls) ? result.calls as Array<Record<string, unknown>> : []
    const calls: OpenRouterCallReceipt[] = rows.map((r) => {
      const settlement = r.settlement && typeof r.settlement === "object" ? r.settlement as Record<string, unknown> : {}
      const allowedReturnedModels = grant.profileId === "muse-spark-contributor"
        ? [grant.model, "meta/muse-spark-1.3-contributor-20260902"]
        : [grant.model]
      const measured = r.state === "settled"
        && typeof settlement.returnedModel === "string" && allowedReturnedModels.includes(settlement.returnedModel)
        && settlement.returnedProvider === (grant.profileId === "muse-spark-contributor" ? "meta" : "deepinfra")
        && Number.isSafeInteger(settlement.promptTokens) && Number(settlement.promptTokens) >= 0 && Number(settlement.promptTokens) <= grant.limits.maxInputTokensPerCall
        && Number.isSafeInteger(settlement.completionTokens) && Number(settlement.completionTokens) >= 0 && Number(settlement.completionTokens) <= grant.limits.maxOutputTokensPerCall
        && (settlement.cachedPromptTokens === undefined || (Number.isSafeInteger(settlement.cachedPromptTokens) && Number(settlement.cachedPromptTokens) >= 0 && Number(settlement.cachedPromptTokens) <= Number(settlement.promptTokens)))
        && Number.isFinite(settlement.costUsd) && Number(settlement.costUsd) >= 0 && Number(settlement.costUsd) <= Number(r.reservedMicros) / 1_000_000
        && Number(settlement.promptTokens) + Number(settlement.completionTokens) <= Number(r.reservedTokens)
        && typeof settlement.responseSha256 === "string" && /^[a-f0-9]{64}$/.test(settlement.responseSha256)
        && settlement.qualified !== false
      return {
      jobId: String(r.jobId), campaignId: String(r.campaignId), model: String(r.model),
      ...(r.profileId === "default" ? {} : { profileId: r.profileId as OpenRouterCallReceipt["profileId"] }),
      callId: String(r.callId), requestSha256: String(r.requestSha256), reservedUsd: Number(r.reservedMicros) / 1_000_000,
      reservedTokens: Number(r.reservedTokens), startedAt: String(r.startedAt ?? ""), state: r.state === "settled" ? "complete" : "unmeasured",
      authoritative: Boolean(measured), ...settlementFields(settlement),
    }})
    const completed = calls.filter((c) => c.state === "complete" && c.authoritative)
    const denials = Array.isArray(result.denials) ? result.denials as OpenRouterBrokerReceipt["denials"] : []
    const prompt = sumField(completed, "promptTokens"), completion = sumField(completed, "completionTokens"), cost = sumField(completed, "costUsd")
    return { provider: "openrouter", endpointProvider: "fleet-budget-authority", jobId: grant.jobId,
      campaignId: grant.limits.campaignId, model: grant.model, ...(grant.profileId ? { profileId: grant.profileId } : {}),
      ...(grant.endpointPrice ? { endpointPrice: grant.endpointPrice } : {}),
      returnedModels: [...new Set(completed.map(c => c.returnedModel).filter((v): v is string => Boolean(v)))],
      returnedProviders: [...new Set(completed.map(c => c.returnedProvider).filter((v): v is string => Boolean(v)))],
      calls: calls.length, promptTokens: prompt, completionTokens: completion,
      totalTokens: prompt === null || completion === null ? null : prompt + completion,
      costUsd: cost, accounting: calls.length > 0 && calls.every(c => c.authoritative) && denials.length === 0 ? "supervisor-enforced" : "incomplete",
      qualified: calls.length > 0 && calls.every(c => c.authoritative) && denials.length === 0,
      callReceipts: calls, denials }
  }
  private remember(grant: OpenRouterBrokerGrant) {
    safeText(grant.jobId, "job id"); safeText(grant.limits.campaignId, "campaign id"); safeText(grant.model, "model")
    if (grant.model !== "meta/muse-spark-1.3-contributor" || grant.profileId !== "muse-spark-contributor")
      throw new Error("Fleet budget ledger admits only the fixed Muse contributor profile")
    if (!/^[a-f0-9]{64}$/.test(grant.apiKeyIdentity ?? "") || grant.apiKeyIdentity !== this.expectedKeyIdentity)
      throw new Error("Fleet budget ledger grant key identity differs from selected host key")
    const prior = this.jobs.get(grant.jobId)
    if (prior && (prior.model !== grant.model || prior.limits.campaignId !== grant.limits.campaignId || prior.profileId !== grant.profileId || prior.apiKeyIdentity !== grant.apiKeyIdentity))
      throw new Error("Fleet job grant identity changed")
    this.jobs.set(grant.jobId, grant)
  }
  private identity(op: string, grant: OpenRouterBrokerGrant) {
    return { schemaVersion: 1, op, jobId: grant.jobId, campaignId: grant.limits.campaignId,
      model: grant.model, profileId: grant.profileId ?? "default", keyIdentity: grant.apiKeyIdentity }
  }
  private grantLimits(grant: OpenRouterBrokerGrant) {
    const l = grant.limits
    return {
      maxCalls: l.maxCalls,
      maxInputTokensPerCall: l.maxInputTokensPerCall,
      maxOutputTokensPerCall: l.maxOutputTokensPerCall,
      maxTotalTokens: l.maxTotalTokens,
      maxDurationMs: l.maxDurationMs,
      maxRequestBytes: l.maxRequestBytes,
      maxResponseBytes: l.maxResponseBytes,
      maxInputPricePerMillionUsd: l.maxInputPricePerMillionUsd,
      maxOutputPricePerMillionUsd: l.maxOutputPricePerMillionUsd,
      maxCallSpendMicros: micros(l.maxCallSpendUsd, 5_000_000),
      maxJobSpendMicros: micros(l.maxJobSpendUsd, 5_000_000),
      maxCampaignSpendMicros: micros(l.maxCampaignSpendUsd, 5_000_000),
    }
  }
}

/** Verify a provided adapter release config and require the bridge in its signed file list. */
export async function verifyFleetBudgetBridgeRelease(config: CampaignAdapterConfig): Promise<{ releaseRoot: string; bridgeModulePath: string }> {
  await verifyCampaignRelease(config)
  const manifestPath = path.join(config.releaseRoot, "release-manifest.json")
  const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8")) as Record<string, unknown>
  const files = manifest.files as Record<string, unknown> | undefined
  if (!files || typeof files[BRIDGE_MODULE] !== "string" || !/^[a-f0-9]{64}$/.test(files[BRIDGE_MODULE] as string))
    throw new Error("verified Fleet release does not include the budget bridge module")
  const bridgeModulePath = path.join(config.releaseRoot, BRIDGE_MODULE)
  const info = await fs.lstat(bridgeModulePath)
  if (!info.isFile() || info.isSymbolicLink() || await fs.realpath(bridgeModulePath) !== bridgeModulePath)
    throw new Error("verified Fleet budget bridge module is not a regular release member")
  return { releaseRoot: config.releaseRoot, bridgeModulePath }
}

/** Resolve only the immutable host-registered Fleet release. */
export async function resolveFleetBudgetBridgeRelease(): Promise<{ releaseRoot: string; bridgeModulePath: string }> {
  const config = await loadCampaignAdapterConfig(CAMPAIGN_ADAPTER_FILE)
  return await verifyFleetBudgetBridgeRelease(config)
}

function settlementFields(s: Record<string, unknown>) {
  return { ...(typeof s.returnedModel === "string" ? { returnedModel: s.returnedModel } : {}),
    ...(typeof s.returnedProvider === "string" ? { returnedProvider: s.returnedProvider } : {}),
    ...(typeof s.providerRequestId === "string" ? { providerRequestId: s.providerRequestId } : {}),
    ...(Number.isSafeInteger(s.promptTokens) ? { promptTokens: s.promptTokens as number } : {}),
    ...(Number.isSafeInteger(s.cachedPromptTokens) ? { cachedPromptTokens: s.cachedPromptTokens as number } : {}),
    ...(Number.isSafeInteger(s.completionTokens) ? { completionTokens: s.completionTokens as number } : {}),
    ...(Number.isFinite(s.costUsd) ? { costUsd: s.costUsd as number } : {}),
    ...(typeof s.responseSha256 === "string" ? { responseSha256: s.responseSha256 } : {}) }
}
function sumField(rows: OpenRouterCallReceipt[], field: "promptTokens" | "completionTokens" | "costUsd"): number | null {
  if (rows.length === 0 || rows.some(r => typeof r[field] !== "number")) return null
  return rows.reduce((sum, row) => sum + Number(row[field]), 0)
}

async function invokeBridge(message: Record<string, unknown>, options: FleetBudgetLedgerOptions): Promise<BridgeReply> {
  const payload = Buffer.from(JSON.stringify(message), "utf8")
  if (payload.length > MAX_REQUEST) throw new Error("Fleet bridge request exceeds bound")
  const python = options.python ?? "/usr/bin/python3"
  const { releaseRoot: root } = await resolveFleetBudgetBridgeRelease()
  return await new Promise((resolve, reject) => {
    const inheritedLock = process.env.HEADLESSCODE_CAMPAIGN_LOCK_FD
    const lockFd = inheritedLock && /^\d{1,6}$/.test(inheritedLock) && Number(inheritedLock) >= 3
      ? Number(inheritedLock) : undefined
    const env: NodeJS.ProcessEnv = { PATH: "/usr/bin:/bin", PYTHONPATH: root, PYTHONNOUSERSITE: "1" }
    const stdio: StdioOptions = lockFd === undefined
      ? ["pipe", "pipe", "ignore"]
      : ["pipe", "pipe", "ignore", lockFd]
    if (lockFd !== undefined) env.HEADLESSCODE_CAMPAIGN_LOCK_FD = "3"
    const child = spawn(python, ["-m", "operations.campaign_budget_bridge"], {
      cwd: root, shell: false, env, stdio,
    })
    const stdout = child.stdout
    const stdin = child.stdin
    if (!stdout || !stdin) { child.kill("SIGKILL"); reject(new Error("Fleet bridge pipes are unavailable")); return }
    const chunks: Buffer[] = []; let bytes = 0; let done = false
    const finish = (err?: Error, value?: BridgeReply) => { if (done) return; done = true; clearTimeout(timer); err ? reject(err) : resolve(value!) }
    const timer = setTimeout(() => { child.kill("SIGKILL"); finish(new Error("Fleet bridge timed out; reservation state may be ambiguous")) }, options.timeoutMs ?? 5000)
    stdout.on("data", (chunk: Buffer) => { bytes += chunk.length; if (bytes > MAX_REPLY) { child.kill("SIGKILL"); finish(new Error("Fleet bridge reply exceeds bound")); return } chunks.push(chunk) })
    child.on("error", () => finish(new Error("Fleet bridge unavailable")))
    child.on("close", (code) => {
      if (code !== 0) { finish(new Error("Fleet budget authority denied operation")); return }
      try { const data = JSON.parse(Buffer.concat(chunks).toString("utf8")) as BridgeReply; if (!data || typeof data !== "object" || data.error) throw new Error(); finish(undefined, data) }
      catch { finish(new Error("Fleet bridge returned invalid response")) }
    })
    stdin.end(payload)
  })
}
