import { createHash, randomUUID } from "node:crypto"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { spawn } from "node:child_process"
import { CURL_CANDIDATE_TREE_SHA, CURL_EVALUATOR_DIGEST, CURL_FIXED_ADVISORY,
	CURL_PRIVATE_SOURCE_REVISION, CURL_CAMPAIGN_ID } from "./repository-curl-evaluator.js"

const DELIVERY_SCHEMA = 1
export const CURL_PRIVATE_BOARD_CARD_ID = "1c25cecf-e5e8-4b68-b6fd-5d6ad25426d7"
const BOARD_CLI_PATH = "/home/joe/Projects/agent-board/cli/agent-board.mjs"
const BOARD_API_URL = "http://127.0.0.1:8078/api"
const BOARD_AUTHOR = "HeadlessCode"

export interface CurlPrivateBoardTransport {
	hasMarker(marker: string, lock: fs.promises.FileHandle): Promise<boolean>
	addComment(comment: string, lock: fs.promises.FileHandle): Promise<void>
}

interface CurlPrivateDeliveryInput {
	campaignId: string
	jobId: string
	claimId: string
	epoch: number
	advisoryId: string
	candidateSha256: string
	verificationSha256: string
	disposition: "already-fixed"
	sourceRevision: string
	sourceTreeSha256: string
}

interface DeliveryIdentity {
	campaignId: string
	advisoryId: string
	sourceRevision: string
	sourceTreeSha256: string
	candidateSha256: string
	verificationSha256: string
	evaluatorDigest: string
	disposition: "already-fixed"
}

interface PrivateDeliveryRecord {
	schemaVersion: 1
	campaignId: string
	advisoryId: string
	candidateSha256: string
	verificationSha256: string
	disposition: "already-fixed"
	sourceRevision: string
	sourceTreeSha256: string
	evaluatorDigest: string
	firstJobId: string
	firstClaimId: string
	firstEpoch: number
	dedupKey: string
	evidenceSha256: string
	deliveryStatus: "pending" | "delivered"
	boardRef: string | null
}

export async function writePrivateCurlDeliveryReceipt(
	storePath: string,
	input: CurlPrivateDeliveryInput,
	board: CurlPrivateBoardTransport = fixedBoardTransport(),
): Promise<{ accepted: boolean; evidenceSha256: string; boardRef: string }> {
	assertDeliveryInput(input)
	const directory = await prepareDeliveryDirectory(storePath)
	const identity = makeDeliveryIdentity(input)
	return await withDeliveryLock(directory, identity, input, board)
}

function assertDeliveryInput(input: CurlPrivateDeliveryInput): void {
	assertCampaignInput(input)
	assertClaimInput(input)
	assertEvidenceInput(input)
	assertSourceInput(input)
}

function assertCampaignInput(input: CurlPrivateDeliveryInput): void {
	if (input.campaignId !== CURL_CAMPAIGN_ID || input.advisoryId !== CURL_FIXED_ADVISORY) {
		throw new Error("private Curl delivery record is invalid")
	}
}

function assertClaimInput(input: CurlPrivateDeliveryInput): void {
	if (!isUuid(input.jobId) || !isUuid(input.claimId) || !Number.isSafeInteger(input.epoch) || input.epoch < 1) {
		throw new Error("private Curl delivery record is invalid")
	}
}

function assertEvidenceInput(input: CurlPrivateDeliveryInput): void {
	if (!isDigest(input.candidateSha256) || !isDigest(input.verificationSha256) || input.disposition !== "already-fixed") {
		throw new Error("private Curl delivery record is invalid")
	}
}

function assertSourceInput(input: CurlPrivateDeliveryInput): void {
	if (input.sourceRevision !== CURL_PRIVATE_SOURCE_REVISION || input.sourceTreeSha256 !== CURL_CANDIDATE_TREE_SHA) {
		throw new Error("private Curl delivery record is invalid")
	}
}

async function prepareDeliveryDirectory(storePath: string): Promise<string> {
	const directory = path.join(path.dirname(path.resolve(storePath)), "repository-delivery")
	await fs.promises.mkdir(directory, { recursive: true, mode: 0o700 })
	const info = await fs.promises.lstat(directory)
	if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0 ||
		(typeof process.getuid === "function" && info.uid !== process.getuid())) {
		throw new Error("private delivery directory must be owner-only")
	}
	return directory
}

function makeDeliveryIdentity(input: CurlPrivateDeliveryInput): DeliveryIdentity {
	return {
		campaignId: input.campaignId, advisoryId: input.advisoryId,
		sourceRevision: input.sourceRevision, sourceTreeSha256: input.sourceTreeSha256,
		candidateSha256: input.candidateSha256, verificationSha256: input.verificationSha256,
		evaluatorDigest: CURL_EVALUATOR_DIGEST, disposition: input.disposition,
	}
}

async function withDeliveryLock(
	directory: string,
	identity: DeliveryIdentity,
	input: CurlPrivateDeliveryInput,
	board: CurlPrivateBoardTransport,
): Promise<{ accepted: boolean; evidenceSha256: string; boardRef: string }> {
	const dedupKey = sha256(canonical(identity))
	const evidenceSha256 = makeEvidenceDigest(identity, input)
	const lock = await openDeliveryLock(directory, dedupKey)
	try {
		await acquirePrivateDeliveryLock(lock)
		const target = path.join(directory, `${dedupKey}.json`)
		const record = await readOrCreateRecord(target, dedupKey, evidenceSha256, identity, input)
		return await deliverRecord({ target, dedupKey, record, input, board, lock })
	} finally {
		await lock.close()
	}
}

function makeEvidenceDigest(identity: DeliveryIdentity, input: CurlPrivateDeliveryInput): string {
	return sha256(canonical({ ...identity, firstJobId: input.jobId,
		firstClaimId: input.claimId, firstEpoch: input.epoch }))
}

async function openDeliveryLock(directory: string, dedupKey: string): Promise<fs.promises.FileHandle> {
	const lockPath = path.join(directory, `${dedupKey}.lock`)
	const lock = await fs.promises.open(lockPath,
		fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_NOFOLLOW, 0o600)
	const info = await lock.stat()
	if (!info.isFile() || info.nlink !== 1 || (info.mode & 0o077) !== 0 ||
		(typeof process.getuid === "function" && info.uid !== process.getuid())) {
		await lock.close()
		throw new Error("private Curl delivery lock is not an owner-only regular file")
	}
	return lock
}

async function readOrCreateRecord(target: string, dedupKey: string, evidenceSha256: string,
	identity: DeliveryIdentity, input: CurlPrivateDeliveryInput): Promise<PrivateDeliveryRecord> {
	try {
		return await readExistingRecord(target, dedupKey, identity)
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
	}
	const record: PrivateDeliveryRecord = {
		schemaVersion: DELIVERY_SCHEMA, ...identity, firstJobId: input.jobId,
		firstClaimId: input.claimId, firstEpoch: input.epoch, dedupKey, evidenceSha256,
		deliveryStatus: "pending", boardRef: null,
	}
	await persistReceipt(target, record)
	return record
}

async function readExistingRecord(target: string, dedupKey: string,
	identity: DeliveryIdentity): Promise<PrivateDeliveryRecord> {
	const info = await fs.promises.lstat(target)
	if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) !== 0) {
		throw new Error("private Curl delivery receipt has unsafe permissions")
	}
	const parsed: unknown = JSON.parse(await fs.promises.readFile(target, "utf8"))
	if (!isRecord(parsed)) throw new Error("private Curl delivery receipt is invalid")
	const prior = parsed as unknown as PrivateDeliveryRecord
	assertRecordIdentity(prior, identity, dedupKey)
	assertRecordReceipt(prior, dedupKey)
	return prior
}

function assertRecordIdentity(prior: PrivateDeliveryRecord, identity: DeliveryIdentity,
	dedupKey: string): void {
	assertRecordKey(prior, dedupKey)
	assertRecordCampaign(prior, identity)
	assertRecordSource(prior, identity)
}

function assertRecordKey(prior: PrivateDeliveryRecord, dedupKey: string): void {
	if (prior.schemaVersion !== DELIVERY_SCHEMA || prior.dedupKey !== dedupKey) {
		throw new Error("private Curl delivery receipt conflicts with prior evidence")
	}
}

function assertRecordCampaign(prior: PrivateDeliveryRecord, identity: DeliveryIdentity): void {
	if (prior.campaignId !== identity.campaignId || prior.advisoryId !== identity.advisoryId ||
		prior.disposition !== identity.disposition) {
		throw new Error("private Curl delivery receipt conflicts with prior evidence")
	}
}

function assertRecordSource(prior: PrivateDeliveryRecord, identity: DeliveryIdentity): void {
	if (prior.sourceRevision !== identity.sourceRevision || prior.sourceTreeSha256 !== identity.sourceTreeSha256 ||
		prior.candidateSha256 !== identity.candidateSha256 || prior.verificationSha256 !== identity.verificationSha256 ||
		prior.evaluatorDigest !== identity.evaluatorDigest) {
		throw new Error("private Curl delivery receipt conflicts with prior evidence")
	}
}

function assertRecordReceipt(prior: PrivateDeliveryRecord, dedupKey: string): void {
	const expectedRef = `${BOARD_API_URL}/cards/${CURL_PRIVATE_BOARD_CARD_ID}#hc-repository-result-v1:${dedupKey}`
	if (!isDigest(prior.evidenceSha256) || !isUuid(prior.firstJobId) || !isUuid(prior.firstClaimId) ||
		!Number.isSafeInteger(prior.firstEpoch) || prior.firstEpoch < 1 ||
		!(prior.deliveryStatus === "pending" || prior.deliveryStatus === "delivered") ||
		(prior.boardRef !== null && prior.boardRef !== expectedRef)) {
		throw new Error("private Curl delivery receipt conflicts with prior evidence")
	}
}

interface DeliveryTask {
	target: string
	dedupKey: string
	record: PrivateDeliveryRecord
	input: CurlPrivateDeliveryInput
	board: CurlPrivateBoardTransport
	lock: fs.promises.FileHandle
}

async function deliverRecord(task: DeliveryTask): Promise<{ accepted: boolean; evidenceSha256: string; boardRef: string }> {
	const { target, dedupKey, record, input, board, lock } = task
	if (record.deliveryStatus === "delivered" && record.boardRef) {
		return { accepted: true, evidenceSha256: record.evidenceSha256, boardRef: record.boardRef }
	}
	const marker = `hc-repository-result-v1:${dedupKey}`
	const comment = makeDeliveryComment(marker, input, record)
	await ensureBoardComment(marker, comment, board, lock)
	const delivered = { ...record, deliveryStatus: "delivered" as const,
		boardRef: `${BOARD_API_URL}/cards/${CURL_PRIVATE_BOARD_CARD_ID}#${marker}` }
	await persistReceipt(target, delivered)
	return { accepted: true, evidenceSha256: record.evidenceSha256, boardRef: delivered.boardRef }
}

function makeDeliveryComment(marker: string, input: CurlPrivateDeliveryInput,
	record: PrivateDeliveryRecord): string {
	return `[${marker}] ${CURL_FIXED_ADVISORY}: already-fixed in ${CURL_PRIVATE_SOURCE_REVISION} (tree ${CURL_CANDIDATE_TREE_SHA}); candidate ${input.candidateSha256}; protected evidence ${input.verificationSha256}; evaluator ${CURL_EVALUATOR_DIGEST}. Job ${record.firstJobId}, claim ${record.firstClaimId}, epoch ${record.firstEpoch}. No public PR was created.`
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value && typeof value === "object" && !Array.isArray(value))
}

function isUuid(value: unknown): value is string {
	return typeof value === "string" && /^[0-9a-f-]{36}$/.test(value)
}

function isDigest(value: unknown): value is string {
	return typeof value === "string" && /^[a-f0-9]{64}$/.test(value)
}

async function persistReceipt(target: string, record: PrivateDeliveryRecord): Promise<void> {
	const temp = `${target}.${randomUUID()}.tmp`
	const bytes = Buffer.from(`${JSON.stringify(record)}\n`)
	const fd = await fs.promises.open(temp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600)
	try { await fd.chmod(0o600); await fd.writeFile(bytes); await fd.sync() } finally { await fd.close() }
	await fs.promises.rename(temp, target)
}

async function ensureBoardComment(marker: string, comment: string, board: CurlPrivateBoardTransport, lock: fs.promises.FileHandle): Promise<void> {
	if (await board.hasMarker(marker, lock)) return
	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			await board.addComment(comment, lock)
			break
		} catch {
			if (await board.hasMarker(marker, lock)) return
			if (attempt === 1) throw new Error("private board delivery is pending reconciliation")
		}
	}
	if (!await board.hasMarker(marker, lock)) {
		throw new Error("private board comment was not verified after delivery")
	}
}

function fixedBoardTransport(): CurlPrivateBoardTransport {
	return {
		async hasMarker(marker, lock) {
		let cursor: string | undefined
		for (let page = 0; page < 10; page++) {
			const args = [BOARD_CLI_PATH, "card", CURL_PRIVATE_BOARD_CARD_ID, "--json", "--visao", "historico", "--limite", "200", "--url", BOARD_API_URL,
				...(cursor ? ["--cursor", cursor] : [])]
				const parsed = parseCliJson(await runBoardCli(args, lock))
			const events = Array.isArray(parsed.eventos) ? parsed.eventos : []
			if (events.some((item) => item && typeof item === "object" && String((item as Record<string, unknown>).detalhe ?? "").includes(marker))) return true
			const next = parsed.proximo_cursor
			if (!next) return false
			if (typeof next !== "string" || next.length > 512) throw new Error("private board history cursor is invalid")
			cursor = next
		}
		throw new Error("private board history exceeds the bounded delivery reconciliation window")
		},
		async addComment(comment, lock) {
			const args = [BOARD_CLI_PATH, "comentar", CURL_PRIVATE_BOARD_CARD_ID, comment, "--autor", BOARD_AUTHOR, "--url", BOARD_API_URL]
			await runBoardCli(args, lock)
		},
	}
}

async function runBoardCli(args: string[], lock: fs.promises.FileHandle): Promise<string> {
	return await new Promise((resolve, reject) => {
		const child = spawn(process.execPath, args, { cwd: path.dirname(BOARD_CLI_PATH), shell: false, detached: process.platform !== "win32",
			stdio: ["ignore", "pipe", "ignore", lock.fd], env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: os.homedir(),
				...(process.env.AGENT_BOARD_KEY ? { AGENT_BOARD_KEY: process.env.AGENT_BOARD_KEY } : {}),
				AGENT_BOARD_URL: BOARD_API_URL, AGENT_BOARD_AUTHOR: BOARD_AUTHOR } })
		let output = "", bytes = 0, settled = false
		const finish = (error?: Error, code?: number | null) => { if (settled) return; settled = true; clearTimeout(timer); error ? reject(error) : code === 0 ? resolve(output) : reject(new Error("private board CLI failed")) }
		const timer = setTimeout(() => { try { if (child.pid) process.kill(-child.pid, "SIGTERM") } catch { /* process already exited */ }; finish(new Error("private board CLI timed out")) }, 20_000)
		timer.unref()
		child.stdout?.on("data", (chunk: Buffer) => { bytes += chunk.length; if (bytes > 64 * 1024) { try { if (child.pid) process.kill(-child.pid, "SIGKILL") } catch { /* process already exited */ }; finish(new Error("private board response exceeds its bound")); return }; output += chunk.toString("utf8") })
		child.once("error", () => finish(new Error("private board CLI could not start")))
		child.once("close", (code) => finish(undefined, code))
	})
}

async function acquirePrivateDeliveryLock(lock: fs.promises.FileHandle): Promise<void> {
	await new Promise<void>((resolve, reject) => {
		const child = spawn("/usr/bin/flock", ["-n", "-x", "3"], { shell: false, stdio: ["ignore", "ignore", "ignore", lock.fd] })
		let settled = false
		child.once("error", () => { if (!settled) { settled = true; reject(new Error("private Curl delivery lock helper could not start")) } })
		child.once("close", (code) => {
			if (settled) return
			settled = true
			if (code === 0) resolve()
			else reject(new Error("private Curl delivery is pending another reconciler"))
		})
	})
}

function parseCliJson(value: string): Record<string, unknown> {
	let parsed: unknown
	try { parsed = JSON.parse(value) } catch { throw new Error("private board response is invalid JSON") }
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("private board response has an invalid shape")
	return parsed as Record<string, unknown>
}

function canonical(value: object): string {
	return JSON.stringify(Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))))
}

function sha256(value: string | Buffer): string { return createHash("sha256").update(value).digest("hex") }
