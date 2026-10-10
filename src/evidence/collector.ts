import * as fs from "node:fs/promises"
import * as path from "node:path"
import * as http from "node:http"
import * as https from "node:https"
import { checkServerIdentity } from "node:tls"
import { X509Certificate, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify, randomBytes, timingSafeEqual } from "node:crypto"
import { canonicalJson, boundedCanonicalJson, redactEvidenceValue, sha256 } from "./canonical.js"
import type { CanonicalEvidenceRecord, EvidenceBundle, EvidenceInput, EvidenceJournal, EvidencePublicKey, EvidenceReceipt, EvidenceSource, SignedSessionHead } from "./types.js"
import { DEFAULT_MAX_RECORD_BYTES } from "./types.js"

const ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/
const CAPABILITY_FILE = "capabilities.json"
const PRIVATE_KEY_FILE = "ed25519-private.pem"
const PUBLIC_KEY_FILE = "ed25519-public.pem"

interface SessionState { capabilityHash: string; active: boolean; lastSequence: number; lastDigest: string | null; idempotency: Map<string, { inputDigest: string; receipt: EvidenceReceipt }> }
export interface FileEvidenceCollectorOptions { storageDir: string; socketPath?: string; http?: { host: string; port: number; tls?: { key: string | Buffer; cert: string | Buffer } }; maxRecordBytes?: number; redactSecrets?: string[]; expectedKeyId?: string }

function ensureSessionId(id: string): void {
	if (!ID_PATTERN.test(id)) throw new Error("session id must contain 1-128 letters, digits, underscores, or hyphens")
}
function receiptBytes(receipt: Omit<EvidenceReceipt, "signature">): string { return canonicalJson(receipt) }
function headBytes(head: Omit<SignedSessionHead, "signature">): string { return canonicalJson(head) }
function publicKeyId(publicKeyPem: string): string { return `sha256:${sha256(createPublicKey(publicKeyPem).export({ type: "spki", format: "der" }))}` }
function createReceipt(sessionId: string, requestId: string, sequence: number, recordDigest: string, inputDigest: string, keyId: string, privateKey: ReturnType<typeof createPrivateKey>): EvidenceReceipt {
	const unsigned = { schemaVersion: 1 as const, sessionId, requestId, sequence, recordDigest, inputDigest, keyId }
	return { ...unsigned, signature: sign(null, Buffer.from(receiptBytes(unsigned)), privateKey).toString("base64") }
}

async function acquireStorageLock(file: string): Promise<fs.FileHandle> {
	for (let attempt = 0; attempt < 3; attempt++) {
		try {
			const handle = await fs.open(file, "wx", 0o600)
			await handle.writeFile(`${process.pid}\n`, "utf8")
			await handle.sync()
			return handle
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
			const raw = await fs.readFile(file, "utf8").catch(() => "")
			const pid = Number.parseInt(raw, 10)
			if (Number.isInteger(pid) && pid > 0) {
				try { process.kill(pid, 0); throw new Error(`evidence collector storage is already locked by process ${pid}`) }
				catch (probeError) {
					if (probeError instanceof Error && probeError.message.includes("already locked")) throw probeError
					if ((probeError as NodeJS.ErrnoException).code !== "ESRCH") throw new Error(`cannot confirm stale evidence collector lock for process ${pid}`)
				}
			}
			await fs.rm(file, { force: true })
		}
	}
	throw new Error("could not acquire evidence collector storage lock")
}

async function writeAtomic(file: string, contents: string, mode = 0o600): Promise<void> {
	const temporary = `${file}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`
	const handle = await fs.open(temporary, "wx", mode)
	try { await handle.writeFile(contents, "utf8"); await handle.sync() } finally { await handle.close() }
	await fs.rename(temporary, file)
	const dir = await fs.open(path.dirname(file), "r")
	try { await dir.sync() } finally { await dir.close() }
}

/** Append-only evidence store and authenticated collector service. The private key and storage remain host-side. */
export class FileEvidenceCollector {
	private readonly sessions = new Map<string, SessionState>()
	private readonly queues = new Map<string, Promise<void>>()
	private capabilitiesWrite: Promise<void> = Promise.resolve()
	private readonly privateKey: ReturnType<typeof createPrivateKey>
	private readonly publicKeyPem: string
	private readonly keyId: string
	private readonly maxRecordBytes: number
	private readonly secrets: readonly string[]
	private server?: http.Server | https.Server
	private closing = false
	private lockHandle?: fs.FileHandle
	private constructor(private readonly options: FileEvidenceCollectorOptions, privateKeyPem: string, publicKeyPem: string) {
		this.privateKey = createPrivateKey(privateKeyPem)
		this.publicKeyPem = publicKeyPem
		this.keyId = `sha256:${sha256(createPublicKey(this.privateKey).export({ type: "spki", format: "der" }))}`
		this.maxRecordBytes = options.maxRecordBytes ?? DEFAULT_MAX_RECORD_BYTES
		this.secrets = options.redactSecrets ?? []
	}

	static async start(options: FileEvidenceCollectorOptions): Promise<FileEvidenceCollector> {
		const storageDir = path.resolve(options.storageDir)
		await fs.mkdir(storageDir, { recursive: true, mode: 0o700 })
		await fs.chmod(storageDir, 0o700)
		const sessionsDir = path.join(storageDir, "sessions")
		await fs.mkdir(sessionsDir, { recursive: true, mode: 0o700 })
		await fs.chmod(sessionsDir, 0o700)
		if (Boolean(options.socketPath) === Boolean(options.http)) throw new Error("configure exactly one collector listener: Unix socket or HTTP(S)")
		const lockPath = path.join(storageDir, ".collector.lock")
		const lockHandle = await acquireStorageLock(lockPath)
		try {
		const privatePath = path.join(storageDir, PRIVATE_KEY_FILE)
		const publicPath = path.join(storageDir, PUBLIC_KEY_FILE)
		let privatePem: string
		let publicPem: string
		try {
			privatePem = await fs.readFile(privatePath, "utf8")
			publicPem = await fs.readFile(publicPath, "utf8")
			await fs.chmod(privatePath, 0o600)
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
			const pair = generateKeyPairSync("ed25519")
			privatePem = pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString()
			publicPem = pair.publicKey.export({ type: "spki", format: "pem" }).toString()
			const privateHandle = await fs.open(privatePath, "wx", 0o600)
			try { await privateHandle.writeFile(privatePem); await privateHandle.sync() } finally { await privateHandle.close() }
			await writeAtomic(publicPath, publicPem)
		}
		if (createPublicKey(privatePem).export({ type: "spki", format: "pem" }).toString() !== createPublicKey(publicPem).export({ type: "spki", format: "pem" }).toString()) throw new Error("collector public and private keys do not match")
		const collector = new FileEvidenceCollector({ ...options, storageDir }, privatePem, publicPem)
		collector.lockHandle = lockHandle
		if (options.expectedKeyId && options.expectedKeyId !== collector.keyId) throw new Error("collector signing key does not match the supervisor-pinned identity")
		await collector.loadCapabilities()
		for (const id of collector.sessions.keys()) await collector.loadSession(id)
		if (options.socketPath) await collector.listenUnix(options.socketPath)
		if (options.http) await collector.listenHttp(options.http)
		if (!collector.server) throw new Error("collector requires a Unix socket or HTTP listener")
		return collector
		} catch (error) {
			await lockHandle.close()
			await fs.rm(lockPath, { force: true })
			throw error
		}
	}

	get publicKey(): EvidencePublicKey { return { keyId: this.keyId, publicKeyPem: this.publicKeyPem } }
	get fingerprint(): string { return this.keyId }
	get address(): string | undefined { const a = this.server?.address(); return typeof a === "string" ? a : undefined }

	async authorizeSession(sessionId: string): Promise<string> {
		ensureSessionId(sessionId)
		if (this.sessions.has(sessionId)) throw new Error(`session '${sessionId}' is already authorized`)
		const capability = randomBytes(32).toString("base64url")
		const state: SessionState = { capabilityHash: sha256(capability), active: true, lastSequence: 0, lastDigest: null, idempotency: new Map() }
		this.sessions.set(sessionId, state)
		await this.persistHead(sessionId, this.signHead(sessionId, 0, null))
		await this.persistCapabilities()
		return capability
	}

	async revokeSession(sessionId: string): Promise<void> {
		const prior = this.queues.get(sessionId) ?? Promise.resolve()
		let release!: () => void
		const gate = new Promise<void>((resolve) => { release = resolve })
		const queued = prior.then(() => gate)
		this.queues.set(sessionId, queued)
		await prior
		try {
			const session = this.sessions.get(sessionId)
			if (session) session.active = false
			await this.persistCapabilities()
		} finally {
			release()
			if (this.queues.get(sessionId) === queued) this.queues.delete(sessionId)
		}
	}

	/** Supervisor-only append path. HTTP clients are always classified as worker-reported. */
	async appendObserved(input: EvidenceInput): Promise<EvidenceReceipt> { return this.appendWithSource(input, "supervisor-observed") }

	async exportBundle(sessionId: string): Promise<EvidenceBundle> {
		ensureSessionId(sessionId)
		const state = this.sessions.get(sessionId)
		if (!state) throw new Error(`unknown session '${sessionId}'`)
		await this.waitForWrites(sessionId)
		const records = await this.readRecords(sessionId)
		return { schemaVersion: 1, sessionId, publicKey: this.publicKey, records, receipts: records.map((record) => createReceipt(sessionId, record.requestId, record.sequence, record.digest, record.requestDigest, this.keyId, this.privateKey)), head: this.signHead(sessionId, state.lastSequence, state.lastDigest) }
	}

	async close(): Promise<void> {
		this.closing = true
		if (!this.server) return
		const address = this.server.address()
		await new Promise<void>((resolve, reject) => this.server!.close((error) => error ? reject(error) : resolve()))
		await Promise.all([...this.queues.values()])
		await this.capabilitiesWrite
		if (typeof address === "string") await fs.rm(address, { force: true })
		this.server = undefined
		await this.lockHandle?.close()
		this.lockHandle = undefined
		await fs.rm(path.join(this.options.storageDir, ".collector.lock"), { force: true })
	}

	private async appendWithSource(input: EvidenceInput, source: EvidenceSource): Promise<EvidenceReceipt> {
		if (this.closing) throw new Error("evidence collector is closing")
		ensureSessionId(input.sessionId)
		if (!ID_PATTERN.test(input.requestId)) throw new Error("requestId must contain 1-128 letters, digits, underscores, or hyphens")
		const state = this.sessions.get(input.sessionId)
		if (!state?.active) throw new Error(`unknown or revoked session '${input.sessionId}'`)
		const prior = this.queues.get(input.sessionId) ?? Promise.resolve()
		let release!: () => void
		const gate = new Promise<void>((resolve) => { release = resolve })
		const queued = prior.then(() => gate)
		this.queues.set(input.sessionId, queued)
		await prior
		try {
			if (!state.active) throw new Error(`unknown or revoked session '${input.sessionId}'`)
			const rawInputJson = boundedCanonicalJson(input, this.maxRecordBytes)
			const submittedDigest = sha256(rawInputJson)
			const safeInput = { ...input, payload: redactEvidenceValue(input.payload, this.secrets) }
			const inputDigest = sha256(boundedCanonicalJson({ source, submittedDigest }, this.maxRecordBytes))
			const existing = state.idempotency.get(input.requestId)
			if (existing) {
				if (existing.inputDigest !== inputDigest) throw new Error("idempotency key was reused with different evidence")
				return existing.receipt
			}
			const sequence = state.lastSequence + 1
			const body = {
				...safeInput,
				schemaVersion: 1 as const,
				sequence,
				previousDigest: state.lastDigest,
				requestDigest: submittedDigest,
				occurredAt: input.occurredAt ?? new Date().toISOString(),
				recordedAt: new Date().toISOString(),
				source,
			}
			const digest = sha256(boundedCanonicalJson(body, this.maxRecordBytes))
			const record: CanonicalEvidenceRecord = { ...body, digest }
			const serialized = boundedCanonicalJson(record, this.maxRecordBytes)
			const line = `${serialized}\n`
			const file = this.recordsPath(input.sessionId)
			await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
			const handle = await fs.open(file, "a", 0o600)
			try { await handle.writeFile(line, "utf8"); await handle.sync() } finally { await handle.close() }
			const receipt = createReceipt(input.sessionId, input.requestId, sequence, digest, submittedDigest, this.keyId, this.privateKey)
			await this.persistHead(input.sessionId, this.signHead(input.sessionId, sequence, digest))
			state.lastSequence = sequence
			state.lastDigest = digest
			state.idempotency.set(input.requestId, { inputDigest, receipt })
			await this.persistCapabilities()
			return receipt
		} finally {
			release()
			if (this.queues.get(input.sessionId) === queued) this.queues.delete(input.sessionId)
		}
	}

	private signHead(sessionId: string, sequence: number, digest: string | null): SignedSessionHead {
		const unsigned = { schemaVersion: 1 as const, sessionId, sequence, digest, keyId: this.keyId }
		return { ...unsigned, signature: sign(null, Buffer.from(headBytes(unsigned)), this.privateKey).toString("base64") }
	}
	private recordsPath(id: string): string { return path.join(this.options.storageDir, "sessions", `${id}.jsonl`) }
	private headPath(id: string): string { return path.join(this.options.storageDir, "sessions", `${id}.head.json`) }
	private capabilitiesPath(): string { return path.join(this.options.storageDir, CAPABILITY_FILE) }
	private async persistHead(id: string, head: SignedSessionHead): Promise<void> {
		await fs.mkdir(path.dirname(this.headPath(id)), { recursive: true, mode: 0o700 })
		await writeAtomic(this.headPath(id), `${canonicalJson(head)}\n`)
	}
	private persistCapabilities(): Promise<void> {
		const write = this.capabilitiesWrite.then(async () => {
			const entries = [...this.sessions].map(([sessionId, state]) => ({ sessionId, capabilityHash: state.capabilityHash, active: state.active, lastSequence: state.lastSequence, lastDigest: state.lastDigest, idempotency: [...state.idempotency] }))
			await writeAtomic(this.capabilitiesPath(), `${canonicalJson(entries)}\n`)
		})
		this.capabilitiesWrite = write.catch(() => {})
		return write
	}
	private async loadCapabilities(): Promise<void> {
		try {
			await fs.chmod(this.capabilitiesPath(), 0o600)
			const entries = JSON.parse(await fs.readFile(this.capabilitiesPath(), "utf8")) as Array<{sessionId:string;capabilityHash:string;active?:boolean;lastSequence:number;lastDigest:string|null;idempotency:Array<[string,{inputDigest:string;receipt:EvidenceReceipt}]>}>
			for (const entry of entries) {
				ensureSessionId(entry.sessionId)
				this.sessions.set(entry.sessionId, { capabilityHash: entry.capabilityHash, active: entry.active ?? true, lastSequence: entry.lastSequence, lastDigest: entry.lastDigest, idempotency: new Map(entry.idempotency) })
			}
		} catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error }
	}
	private async loadSession(id: string): Promise<void> {
		const state = this.sessions.get(id)!
		await fs.chmod(this.recordsPath(id), 0o600).catch((error: NodeJS.ErrnoException) => {
			if (error.code !== "ENOENT") throw error
		})
		await fs.chmod(this.headPath(id), 0o600)
		const storedHead = JSON.parse(await fs.readFile(this.headPath(id), "utf8")) as SignedSessionHead
		if (!verifySignedHead(storedHead, this.publicKey)) throw new Error(`stored evidence head signature is invalid for session ${id}`)
		const recordsRaw = await fs.readFile(this.recordsPath(id), "utf8").catch((error: NodeJS.ErrnoException) => {
			if (error.code === "ENOENT") return ""
			throw error
		})
		const completeEnd = recordsRaw.lastIndexOf("\n") + 1
		const completeLines = recordsRaw.slice(0, completeEnd).split("\n").filter(Boolean)
		if (completeLines.length < storedHead.sequence) throw new Error(`evidence records or signed head were deleted for session ${id}`)
		const records = completeLines.slice(0, storedHead.sequence).map((line) => JSON.parse(line) as CanonicalEvidenceRecord)
		let last = 0
		let digest: string | null = null
		const committedSequence = state.lastSequence
		const committedDigest = state.lastDigest
		if (committedSequence > storedHead.sequence) throw new Error(`evidence records or signed head were deleted for session ${id}`)
		for (const record of records) {
			if (record.sequence !== last + 1 || record.previousDigest !== digest) throw new Error(`evidence chain corrupt for session ${id}`)
			const { digest: claimed, ...body } = record
			if (sha256(boundedCanonicalJson(body, this.maxRecordBytes)) !== claimed) throw new Error(`evidence digest mismatch for session ${id} at sequence ${record.sequence}`)
			if (record.sequence === committedSequence && claimed !== committedDigest) throw new Error(`stored capability metadata mismatch for session ${id}`)
			if (record.sequence === storedHead.sequence && claimed !== storedHead.digest) throw new Error(`signed evidence head mismatch for session ${id}`)
			const receipt = createReceipt(id, record.requestId, record.sequence, claimed, record.requestDigest, this.keyId, this.privateKey)
			const storedInputDigest = sha256(boundedCanonicalJson({ source: record.source, submittedDigest: record.requestDigest }, this.maxRecordBytes))
			const savedRequest = state.idempotency.get(record.requestId)
			if (savedRequest && savedRequest.inputDigest !== storedInputDigest) throw new Error(`idempotency state mismatch for session ${id}`)
			state.idempotency.set(record.requestId, { inputDigest: storedInputDigest, receipt })
			last = record.sequence; digest = claimed
		}
		if (storedHead.sequence === 0 && storedHead.digest !== null) throw new Error(`empty signed head has a digest for session ${id}`)
		const committedRecords = records
		const committedBytes = committedRecords.length ? `${committedRecords.map((record) => canonicalJson(record)).join("\n")}\n` : ""
		if (completeLines.length > storedHead.sequence || completeEnd !== recordsRaw.length || recordsRaw !== committedBytes) {
			const handle = await fs.open(this.recordsPath(id), "w", 0o600)
			try { await handle.writeFile(committedBytes, "utf8"); await handle.sync() } finally { await handle.close() }
		}
		state.idempotency = new Map(committedRecords.map((record) => [record.requestId, {
			inputDigest: sha256(boundedCanonicalJson({ source: record.source, submittedDigest: record.requestDigest }, this.maxRecordBytes)),
			receipt: createReceipt(id, record.requestId, record.sequence, record.digest, record.requestDigest, this.keyId, this.privateKey),
		}]))
		state.lastSequence = storedHead.sequence
		state.lastDigest = storedHead.digest
		await this.persistCapabilities()
	}
	private async readRecords(id: string): Promise<CanonicalEvidenceRecord[]> {
		let raw: string
		try { raw = await fs.readFile(this.recordsPath(id), "utf8") } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error }
		if (raw && !raw.endsWith("\n")) throw new Error(`incomplete evidence tail for session ${id}`)
		return raw.split("\n").filter(Boolean).map((line) => JSON.parse(line) as CanonicalEvidenceRecord)
	}
	private async waitForWrites(id: string): Promise<void> { await this.queues.get(id) }
	private async listenUnix(socketPath: string): Promise<void> {
		const full = path.resolve(socketPath)
		if (Buffer.byteLength(full) >= 108) throw new Error("Unix socket path is too long for the platform; use a short supervisor-owned runtime path")
		await fs.mkdir(path.dirname(full), { recursive: true, mode: 0o700 })
		this.server = http.createServer((req, res) => void this.handleRequest(req, res))
		this.configureTimeouts(this.server)
		await new Promise<void>((resolve, reject) => { this.server!.once("error", reject); this.server!.listen(full, () => resolve()) })
		await fs.chmod(full, 0o600)
	}
	private async listenHttp(config: NonNullable<FileEvidenceCollectorOptions["http"]>): Promise<void> {
		const loopback = config.host === "127.0.0.1" || config.host === "::1" || config.host === "localhost"
		if (!loopback && !config.tls) throw new Error("non-loopback collector HTTP requires TLS key and certificate")
		const handler = (req: http.IncomingMessage, res: http.ServerResponse) => void this.handleRequest(req, res)
		this.server = config.tls ? https.createServer(config.tls, handler) : http.createServer(handler)
		this.configureTimeouts(this.server)
		await new Promise<void>((resolve, reject) => { this.server!.once("error", reject); this.server!.listen(config.port, config.host, () => resolve()) })
	}
	private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
		try {
			if (req.method === "GET" && req.url === "/v1/public-key") return this.json(res, 200, this.publicKey)
			if (req.method !== "POST" || req.url !== "/v1/append") return this.json(res, 404, { error: "not_found" })
			const token = /^Bearer (.+)$/.exec(String(req.headers.authorization ?? ""))?.[1]
			if (!token) return this.json(res, 401, { error: "unauthorized" })
			const body = await this.readBody(req)
			const parsed = JSON.parse(body) as EvidenceInput
			const state = this.sessions.get(parsed.sessionId)
			if (!state?.active || !timingSafeEqual(Buffer.from(state.capabilityHash), Buffer.from(sha256(token)))) return this.json(res, 403, { error: "forbidden" })
			const receipt = await this.appendWithSource(parsed, "worker-reported")
			return this.json(res, 200, receipt)
		} catch (error) { return this.json(res, 400, { error: error instanceof Error ? error.message : String(error) }) }
	}
	private async readBody(req: http.IncomingMessage): Promise<string> {
		const chunks: Buffer[] = []; let size = 0
		for await (const chunk of req) { const b = Buffer.from(chunk); size += b.length; if (size > this.maxRecordBytes) throw new RangeError("evidence request exceeds configured byte limit"); chunks.push(b) }
		return Buffer.concat(chunks).toString("utf8")
	}
	private json(res: http.ServerResponse, code: number, value: unknown): void { res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store" }); res.end(JSON.stringify(value)) }
	private configureTimeouts(server: http.Server | https.Server): void {
		server.requestTimeout = 15_000
		server.headersTimeout = 20_000
		server.keepAliveTimeout = 5_000
	}
}

export interface UnixEvidenceJournalOptions { socketPath: string; sessionId: string; capability: string; pinnedPublicKey: EvidencePublicKey; maxRecordBytes?: number }
export interface HttpEvidenceJournalOptions { baseUrl: string; sessionId: string; capability: string; pinnedPublicKey: EvidencePublicKey; tlsServerFingerprintSha256?: string; maxRecordBytes?: number }

/** Authenticated worker-side append client. Every accepted submission is labeled worker-reported by the collector. */
export class UnixEvidenceJournal implements EvidenceJournal {
	constructor(private readonly options: UnixEvidenceJournalOptions) {
		if (publicKeyId(options.pinnedPublicKey.publicKeyPem) !== options.pinnedPublicKey.keyId) throw new Error("pinned collector key id does not match public key bytes")
	}
	append(input: EvidenceInput, requestOptions?: { signal?: AbortSignal; timeoutMs?: number }): Promise<EvidenceReceipt> {
		if (input.sessionId !== this.options.sessionId) return Promise.reject(new Error("evidence client cannot append for another session"))
		return this.appendOverSocket(input, requestOptions)
	}
	private async appendOverSocket(input: EvidenceInput, requestOptions?: { signal?: AbortSignal; timeoutMs?: number }): Promise<EvidenceReceipt> {
		return this.request({ socketPath: this.options.socketPath, path: "/v1/append", input, options: this.options, requestOptions })
	}
	private request(args: { socketPath?: string; baseUrl?: string; path: string; input: EvidenceInput; options: UnixEvidenceJournalOptions | HttpEvidenceJournalOptions; requestOptions?: { signal?: AbortSignal; timeoutMs?: number } }): Promise<EvidenceReceipt> {
		return requestReceipt(args)
	}
}

export class HttpEvidenceJournal implements EvidenceJournal {
	constructor(private readonly options: HttpEvidenceJournalOptions) {
		if (publicKeyId(options.pinnedPublicKey.publicKeyPem) !== options.pinnedPublicKey.keyId) throw new Error("pinned collector key id does not match public key bytes")
		const url = new URL(options.baseUrl)
		const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
		if (url.protocol !== "https:" && !loopback) throw new Error("non-loopback evidence collector URL requires HTTPS")
		if (!loopback && !options.tlsServerFingerprintSha256) throw new Error("non-loopback evidence collector URL requires a pinned TLS certificate fingerprint")
	}
	append(input: EvidenceInput, requestOptions?: { signal?: AbortSignal; timeoutMs?: number }): Promise<EvidenceReceipt> {
		if (input.sessionId !== this.options.sessionId) return Promise.reject(new Error("evidence client cannot append for another session"))
		return requestReceipt({ baseUrl: this.options.baseUrl, path: "/v1/append", input, options: this.options, requestOptions })
	}
}

function requestReceipt(args: { socketPath?: string; baseUrl?: string; path: string; input: EvidenceInput; options: UnixEvidenceJournalOptions | HttpEvidenceJournalOptions; requestOptions?: { signal?: AbortSignal; timeoutMs?: number } }): Promise<EvidenceReceipt> {
	const body = boundedCanonicalJson(args.input, args.options.maxRecordBytes)
	const submittedDigest = sha256(body)
	return new Promise((resolve, reject) => {
		const signal = args.requestOptions?.signal
		if (signal?.aborted) return reject(signal.reason instanceof Error ? signal.reason : new Error("evidence request aborted"))
		const url = args.baseUrl ? new URL(args.baseUrl) : undefined
		const transport = url?.protocol === "https:" ? https : http
		const tlsPin = "tlsServerFingerprintSha256" in args.options ? args.options.tlsServerFingerprintSha256 : undefined
		let settled = false
		let responseSize = 0
		const chunks: Buffer[] = []
		let deadline: NodeJS.Timeout | undefined
		const finishError = (error: Error): void => { if (settled) return; settled = true; cleanup(); req.destroy(); reject(error) }
		const cleanup = (): void => { if (deadline) clearTimeout(deadline); signal?.removeEventListener("abort", abort) }
		const abort = (): void => finishError(signal?.reason instanceof Error ? signal.reason : new Error("evidence request aborted"))
		const req = transport.request({ ...(url ? { hostname: url.hostname, port: url.port || undefined } : { socketPath: args.socketPath }), ...(tlsPin ? { checkServerIdentity: (host: string, cert: import("node:tls").PeerCertificate) => {
			const standardError = checkServerIdentity(host, cert)
			if (standardError) return standardError
			const expected = tlsPin.replace(/^sha256:/i, "").replaceAll(":", "").toLowerCase()
			const actual = cert.fingerprint256?.replaceAll(":", "").toLowerCase()
			return actual === expected ? undefined : new Error("collector TLS certificate fingerprint does not match supervisor pin")
		} } : {}), path: args.path, method: "POST", headers: { authorization: `Bearer ${args.options.capability}`, "content-type": "application/json", "content-length": Buffer.byteLength(body) } }, (res) => {
			res.on("data", (chunk: Buffer) => { responseSize += chunk.length; if (responseSize > 16 * 1024) return finishError(new Error("evidence collector response exceeded 16 KiB")); chunks.push(Buffer.from(chunk)) }); res.on("end", () => {
				if (settled) return
				if (res.statusCode !== 200) return finishError(new Error(`evidence collector rejected append (${res.statusCode}): ${Buffer.concat(chunks).toString("utf8")}`))
				try {
					const receipt = JSON.parse(Buffer.concat(chunks).toString("utf8")) as EvidenceReceipt
					const { signature, ...unsigned } = receipt
					if (receipt.schemaVersion !== 1 || receipt.sessionId !== args.input.sessionId || receipt.requestId !== args.input.requestId || receipt.inputDigest !== submittedDigest || !Number.isSafeInteger(receipt.sequence) || receipt.sequence < 1 || !/^[a-f0-9]{64}$/.test(receipt.recordDigest) || receipt.keyId !== args.options.pinnedPublicKey.keyId || typeof signature !== "string" || Buffer.byteLength(signature) > 512 || !verify(null, Buffer.from(receiptBytes(unsigned)), createPublicKey(args.options.pinnedPublicKey.publicKeyPem), Buffer.from(signature, "base64"))) throw new Error("collector receipt does not authenticate this append request")
					settled = true; cleanup()
					resolve(receipt)
				} catch (error) { finishError(error instanceof Error ? error : new Error(String(error))) }
			})
		})
		req.on("error", (error) => finishError(error)); req.end(body)
		deadline = setTimeout(() => finishError(new Error("evidence collector request timed out")), args.requestOptions?.timeoutMs ?? 15_000)
		req.setTimeout(args.requestOptions?.timeoutMs ?? 15_000, () => finishError(new Error("evidence collector request timed out")))
		signal?.addEventListener("abort", abort, { once: true })
		if (signal?.aborted) abort()
	})
}

export function tlsCertificateFingerprintSha256(certPem: string | Buffer): string {
	return `sha256:${new X509Certificate(certPem).fingerprint256.replaceAll(":", "").toLowerCase()}`
}

export function verifyEvidenceReceipt(receipt: EvidenceReceipt, publicKey: EvidencePublicKey): boolean {
	const { signature, ...unsigned } = receipt
	return receipt.keyId === publicKey.keyId && verify(null, Buffer.from(receiptBytes(unsigned)), createPublicKey(publicKey.publicKeyPem), Buffer.from(signature, "base64"))
}

export function verifySignedHead(head: SignedSessionHead, publicKey: EvidencePublicKey): boolean {
	const { signature, ...unsigned } = head
	return head.keyId === publicKey.keyId && verify(null, Buffer.from(headBytes(unsigned)), createPublicKey(publicKey.publicKeyPem), Buffer.from(signature, "base64"))
}
