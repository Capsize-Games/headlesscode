import assert from "node:assert/strict"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import * as http from "node:http"
import { FileEvidenceCollector, HttpEvidenceJournal, UnixEvidenceJournal, verifyEvidenceReceipt } from "../collector.js"
import { verifyEvidenceBundle } from "../verify.js"
import { evidenceJournalFromEnv } from "../index.js"
import type { EvidenceInput, EvidenceJournal, EvidenceReceipt } from "../types.js"
import { HeadlessSession } from "../../engine/loop.js"
import { ToolExecutor } from "../../tools/executor.js"
import type { ChatMessage, ChatToolCall, LlmClient, LlmRequest, LlmResponse } from "../../engine/types.js"
import { canonicalJson, sha256 } from "../canonical.js"

function evidence(sessionId: string, requestId: string, kind: string, payload: unknown): EvidenceInput {
	return { sessionId, requestId, kind, actor: "test", origin: "fixture", payload }
}

async function testCollectorRestartIdempotencyAndPinnedVerification(): Promise<void> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "hc-evidence-"))
	const storageDir = path.join(root, "collector")
	const socketPath = path.join(root, "s")
	const options = { storageDir, socketPath, redactSecrets: ["shh-secret"] }
	let collector = await FileEvidenceCollector.start(options)
	const sessionId = "session-test"
	const capability = await collector.authorizeSession(sessionId)
	assert.equal((await fs.stat(path.join(storageDir, "ed25519-private.pem")).then((stat) => stat.mode & 0o777)), 0o600, "signing key is owner-only")
	assert.equal((await fs.stat(path.join(storageDir, "sessions")).then((stat) => stat.mode & 0o777)), 0o700, "session storage is owner-only")
	const pinnedKey = collector.publicKey
	const client = new UnixEvidenceJournal({ socketPath, sessionId, capability, pinnedPublicKey: pinnedKey })
	await assert.rejects(() => FileEvidenceCollector.start({ storageDir, socketPath: path.join(root, "s2") }), /locked/)
	const unauthorized = new UnixEvidenceJournal({ socketPath, sessionId, capability: "wrong-capability", pinnedPublicKey: pinnedKey })
	await assert.rejects(() => unauthorized.append(evidence(sessionId, "unauthorized", "tool_intent", {})), /403/)
	const intent = evidence(sessionId, "tool-1", "tool_intent", { tool: "execute_command", command: "false" })
	const originalReceipt = await client.append(intent)
	const failed = evidence(sessionId, "result-1", "tool_result", { isError: true, result: "exit 1" })
	await client.append(failed)
	const redacted = evidence(sessionId, "redaction-1", "human_intervention", { apiKey: "secret-value", text: "Authorization: Bearer abcdefghijklmnopqrstuvwxyz shh-secret" })
	await client.append(redacted)
	const countBeforeDuplicate = (await collector.exportBundle(sessionId)).records.length
	assert.equal((await fs.stat(path.join(storageDir, "sessions", `${sessionId}.jsonl`)).then((stat) => stat.mode & 0o777)), 0o600, "record file is owner-only")
	assert.deepEqual(await client.append(intent), originalReceipt, "a duplicate append returns the original receipt")
	assert.equal((await collector.exportBundle(sessionId)).records.length, countBeforeDuplicate, "a duplicate append adds no record")
	await assert.rejects(() => client.append(evidence(sessionId, "tool-1", "tool_intent", { tool: "write_to_file" })), /reused with different evidence/)
	await collector.close()

	collector = await FileEvidenceCollector.start(options)
	const restartedClient = new UnixEvidenceJournal({ socketPath, sessionId, capability, pinnedPublicKey: pinnedKey })
	assert.deepEqual(await restartedClient.append(intent), originalReceipt, "the same request remains idempotent after restart")
	const bundle = await collector.exportBundle(sessionId)
	const verified = verifyEvidenceBundle(bundle, pinnedKey, bundle.head)
	assert.equal(verified.valid, true, verified.errors.join("\n"))
	assert.equal(verified.checkedRecords, 3)
	assert.equal(verified.readableHistory[0]?.source, "worker-reported")
	assert.deepEqual(bundle.records[2]?.payload, { apiKey: "[REDACTED]", text: "Authorization: Bearer [REDACTED] [REDACTED]" })
	assert.equal(verifyEvidenceReceipt({ ...originalReceipt, signature: "AA==" }, pinnedKey), false, "invalid receipt signature must fail")
	const invalidReceiptBundle = structuredClone(bundle)
	invalidReceiptBundle.receipts[0] = { ...invalidReceiptBundle.receipts[0]!, signature: "AA==" }
	assert.equal(verifyEvidenceBundle(invalidReceiptBundle, pinnedKey, bundle.head).valid, false, "offline verifier rejects invalid receipt signatures")
	const replayServer = http.createServer((_request, response) => {
		response.writeHead(200, { "content-type": "application/json" })
		response.end(JSON.stringify(originalReceipt))
	})
	await new Promise<void>((resolve) => replayServer.listen(0, "127.0.0.1", resolve))
	const replayAddress = replayServer.address()
	assert.ok(replayAddress && typeof replayAddress === "object")
	const replayClient = new HttpEvidenceJournal({ baseUrl: `http://127.0.0.1:${replayAddress.port}`, sessionId, capability, pinnedPublicKey: pinnedKey })
	await assert.rejects(() => replayClient.append(evidence(sessionId, "different-request", "tool_intent", {})), /does not authenticate this append/)
	await new Promise<void>((resolve, reject) => replayServer.close((error) => error ? reject(error) : resolve()))
	const runtime = evidenceJournalFromEnv({
		HEADLESSCODE_EVIDENCE_SESSION_ID: sessionId,
		HEADLESSCODE_EVIDENCE_CAPABILITY: "ignored-environment-value",
		HEADLESSCODE_EVIDENCE_KEY_ID: pinnedKey.keyId,
		HEADLESSCODE_EVIDENCE_PUBLIC_KEY_B64: Buffer.from(pinnedKey.publicKeyPem).toString("base64"),
		HEADLESSCODE_EVIDENCE_SOCKET: socketPath,
		HEADLESSCODE_EVIDENCE_REQUIRED: "1",
	}, capability)
	assert.equal(runtime?.sessionId, sessionId)
	assert.equal(runtime?.evidenceRequired, true)
	assert.deepEqual(await runtime?.evidenceJournal.append(intent), originalReceipt, "runtime handoff uses its separate capability argument")

	const edited = structuredClone(bundle)
	const editedResult = edited.records[1]!
	editedResult.payload = { isError: false, result: "exit 0" }
	const editedVerification = verifyEvidenceBundle(edited, pinnedKey, bundle.head)
	assert.equal(editedVerification.valid, false, "edited failure-to-success record must be rejected")
	assert.ok(editedVerification.errors.some((error) => /digest mismatch/.test(error)))

	const missingTail = structuredClone(bundle)
	missingTail.records.pop()
	assert.equal(verifyEvidenceBundle(missingTail, pinnedKey, bundle.head).valid, false, "missing tail is detected against pinned head")
	const reordered = structuredClone(bundle)
	;[reordered.records[0], reordered.records[1]] = [reordered.records[1]!, reordered.records[0]!]
	assert.equal(verifyEvidenceBundle(reordered, pinnedKey, bundle.head).valid, false, "reordered records are detected")
	const deleted = structuredClone(bundle)
	deleted.records.splice(0, 1)
	assert.equal(verifyEvidenceBundle(deleted, pinnedKey, bundle.head).valid, false, "deleted records are detected")
	const invalidHead = { ...bundle.head, signature: "AA==" }
	assert.equal(verifyEvidenceBundle(bundle, pinnedKey, invalidHead).valid, false, "invalid head signature is detected")
	await collector.close()
	const unackedTailInput = evidence(sessionId, "unacked-tail", "tool_intent", { tool: "write_to_file" })
	const unackedBody = {
		...unackedTailInput,
		schemaVersion: 1,
		sequence: 4,
		previousDigest: bundle.records.at(-1)?.digest ?? null,
		requestDigest: sha256(canonicalJson(unackedTailInput)),
		occurredAt: "2026-10-10T00:00:00.000Z",
		recordedAt: "2026-10-10T00:00:00.000Z",
		source: "worker-reported",
	}
	const unackedRecord = { ...unackedBody, digest: sha256(canonicalJson(unackedBody)) }
	await fs.appendFile(path.join(storageDir, "sessions", `${sessionId}.jsonl`), `${canonicalJson(unackedRecord)}\n{"sequence":`)
	collector = await FileEvidenceCollector.start(options)
	const recoveredClient = new UnixEvidenceJournal({ socketPath, sessionId, capability, pinnedPublicKey: pinnedKey })
	const recoveredReceipt = await recoveredClient.append(unackedTailInput)
	assert.equal(recoveredReceipt.sequence, 4, "retry after discarding a crash tail receives a new ACK")
	assert.equal((await collector.exportBundle(sessionId)).records.length, 4, "retry appends the discarded request instead of returning a stale ACK")
	await collector.revokeSession(sessionId)
	assert.equal((await collector.exportBundle(sessionId)).records.length, 4, "revoked sessions remain exportable")
	await assert.rejects(() => recoveredClient.append(evidence(sessionId, "after-revoke", "tool_intent", {})), /403/)
	await collector.close()
	await assert.rejects(() => restartedClient.append(evidence(sessionId, "offline", "tool_intent", {})), /collector|connect|ENOENT|ECONNREFUSED/i)
	await assert.rejects(() => FileEvidenceCollector.start({ ...options, expectedKeyId: `sha256:${"0".repeat(64)}` }), /pinned identity/)
	collector = await FileEvidenceCollector.start(options)
	await collector.close()
	await fs.rm(root, { recursive: true, force: true })
}

class OneCallModel implements LlmClient {
	constructor(private readonly message: ChatMessage) {}
	async createChatCompletion(_request: LlmRequest): Promise<LlmResponse> { return { message: this.message } }
}

class FailingJournal implements EvidenceJournal {
	constructor(private readonly failKind: string, private readonly failRequestId?: string) {}
	async append(record: EvidenceInput, _options?: { signal?: AbortSignal; timeoutMs?: number }): Promise<EvidenceReceipt> {
		if (record.kind === this.failKind && (!this.failRequestId || record.requestId === this.failRequestId)) throw new Error(`storage unavailable at ${record.kind}`)
		return { schemaVersion: 1, sessionId: record.sessionId, requestId: record.requestId, sequence: 1, recordDigest: "0".repeat(64), inputDigest: "test", keyId: "test", signature: "test" }
	}
}

function effectCall(id: string): ChatMessage {
	const call: ChatToolCall = { id, type: "function", function: { name: "write_tool", arguments: "{}" } }
	return { role: "assistant", content: null, tool_calls: [call] }
}

async function makeGatedSession(ws: string, client: LlmClient, journal: EvidenceJournal, effect: () => void): Promise<HeadlessSession> {
	const executor = new ToolExecutor(ws)
	executor.register("write_tool", () => { effect(); return { content: "effect happened", isError: false } })
	return new HeadlessSession({
		workspaceRoot: ws,
		mode: "code",
		model: "fake-model",
		taskText: "exercise evidence gate",
		llmClient: client,
		executor,
		tools: [{ type: "function", function: { name: "write_tool", description: "test effect", parameters: { type: "object", properties: {}, required: [], additionalProperties: false } } }],
		maxIterations: 3,
		checkpoints: false,
		evidenceJournal: journal,
		evidenceRequired: true,
	})
}

async function testFailedIntentAckPreventsEffect(): Promise<void> {
	const ws = await fs.mkdtemp(path.join(os.tmpdir(), "hc-evidence-loop-"))
	let effects = 0
	try {
		const session = await makeGatedSession(ws, new OneCallModel(effectCall("single")), new FailingJournal("tool_intent"), () => effects++)
		const result = await session.run()
		assert.equal(effects, 0, "tool effect must not run without intent acknowledgement")
		assert.equal(result.status, "error")
		assert.equal(result.reason, "evidence")
	} finally { await fs.rm(ws, { recursive: true, force: true }) }
}

async function testFailedResultAckBlocksNextEffect(): Promise<void> {
	const ws = await fs.mkdtemp(path.join(os.tmpdir(), "hc-evidence-loop-"))
	let effects = 0
	try {
		const message: ChatMessage = {
			role: "assistant",
			content: null,
			tool_calls: ["first", "second"].map((id) => ({ id, type: "function", function: { name: "write_tool", arguments: "{}" } })),
		}
		const session = await makeGatedSession(ws, new OneCallModel(message), new FailingJournal("tool_result"), () => effects++)
		const result = await session.run()
		assert.equal(effects, 1, "first effect ran after intent ACK; result failure blocked second effect")
		assert.equal(result.status, "error")
		assert.equal(result.reason, "evidence")
	} finally { await fs.rm(ws, { recursive: true, force: true }) }
}

async function testUnavailableStorageFailsStartup(): Promise<void> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "hc-evidence-badstore-"))
	try {
		const storageFile = path.join(root, "not-a-directory")
		await fs.writeFile(storageFile, "blocked")
		await assert.rejects(() => FileEvidenceCollector.start({ storageDir: storageFile, socketPath: path.join(root, "b") }))
	} finally { await fs.rm(root, { recursive: true, force: true }) }
}

async function main(): Promise<void> {
	await testCollectorRestartIdempotencyAndPinnedVerification()
	await testFailedIntentAckPreventsEffect()
	await testFailedResultAckBlocksNextEffect()
	await testUnavailableStorageFailsStartup()
	console.log("All 4 evidence collector tests passed")
}

void main()
