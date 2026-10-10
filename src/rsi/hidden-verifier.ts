import { createHash, randomBytes, verify as verifySignature } from "node:crypto"

export const HIDDEN_VERIFIER_PROTOCOL = "headlesscode.hidden-functions.v1"

export interface HiddenResourceLimits {
	timeoutMs: number
	maxMemoryMb: number
	maxInputBytes: number
	maxOutputBytes: number
	maxCases: number
}

export interface HiddenFunctionCase {
	id: string
	modulePath: string
	exportName: string
	input: unknown
	expected: unknown
}

export interface HiddenFunctionSuite {
	protocol: typeof HIDDEN_VERIFIER_PROTOCOL
	limits: HiddenResourceLimits
	cases: HiddenFunctionCase[]
}

export interface HiddenVerificationIdentity {
	protocol: typeof HIDDEN_VERIFIER_PROTOCOL
	protocolDigest: string
	evaluatorImageDigest: string
	candidateSourceDigest: string
	candidateCommit: string
	sessionId: string
	jobId: string
	nonce: string
	limits: HiddenResourceLimits
}

export interface HiddenCaseInput {
	id: string
	modulePath: string
	exportName: string
	input: unknown
}

export interface HiddenCaseOutput {
	id: string
	output: unknown
}

export interface SignedHiddenVerificationReport {
	identity: HiddenVerificationIdentity
	outputs: HiddenCaseOutput[]
	signature: string
}

/** This runner must execute candidate code in a fresh isolated boundary. It receives inputs only. */
export interface IsolatedHiddenCaseRunner {
	run(request: { identity: HiddenVerificationIdentity; cases: HiddenCaseInput[] }): Promise<SignedHiddenVerificationReport>
}

export interface HiddenNonceStore {
	/** Atomically records a nonce and returns false if it was already consumed. */
	consume(nonce: string): Promise<boolean>
}

export interface HiddenVerificationOptions {
	runner: IsolatedHiddenCaseRunner
	nonceStore: HiddenNonceStore
	publicKey: string | Buffer
}

export interface HiddenVerificationResult {
	status: "passed" | "failed"
	protocolDigest: string
	identity: HiddenVerificationIdentity
	caseResults: Array<{ id: string; passed: boolean }>
	reason?: string
}

const DIGEST_RE = /^[a-f0-9]{64}$/
const TOKEN_RE = /^[A-Za-z0-9._:-]{1,128}$/
const MODULE_RE = /^(?:src|lib|app)\/(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9._/-]{1,236}$/
const EXPORT_RE = /^[A-Za-z_$][A-Za-z0-9_$]{0,127}$/
const NONCE_RE = /^[A-Za-z0-9_-]{32,128}$/

function canonical(value: unknown): string {
	if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value)
	if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value)
	if (typeof value !== "object") throw new Error("hidden verifier data must be finite JSON values")
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`
	const record = value as Record<string, unknown>
	return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(",")}}`
}

function jsonBytes(value: unknown): number {
	return Buffer.byteLength(canonical(value), "utf8")
}

function cloneJson<T>(value: T): T {
	return JSON.parse(canonical(value)) as T
}

function validLimits(limits: HiddenResourceLimits): boolean {
	return Number.isInteger(limits.timeoutMs) && limits.timeoutMs >= 50 && limits.timeoutMs <= 120_000 &&
		Number.isInteger(limits.maxMemoryMb) && limits.maxMemoryMb >= 16 && limits.maxMemoryMb <= 4096 &&
		Number.isInteger(limits.maxInputBytes) && limits.maxInputBytes >= 1 && limits.maxInputBytes <= 1_000_000 &&
		Number.isInteger(limits.maxOutputBytes) && limits.maxOutputBytes >= 1 && limits.maxOutputBytes <= 1_000_000 &&
		Number.isInteger(limits.maxCases) && limits.maxCases >= 1 && limits.maxCases <= 256
}

export function hiddenFunctionSuiteDigest(suite: HiddenFunctionSuite): string {
	if (suite.protocol !== HIDDEN_VERIFIER_PROTOCOL || !validLimits(suite.limits)) throw new Error("unsupported or unbounded hidden verifier configuration")
	if (!Array.isArray(suite.cases) || suite.cases.length < 1 || suite.cases.length > suite.limits.maxCases) throw new Error("hidden verifier case count is outside its frozen limit")
	const ids = new Set<string>()
	let totalInputBytes = 0
	let totalOutputBytes = 0
	for (const testCase of suite.cases) {
		if (!TOKEN_RE.test(testCase.id) || ids.has(testCase.id)) throw new Error("hidden verifier case IDs must be unique bounded tokens")
		ids.add(testCase.id)
		if (!MODULE_RE.test(testCase.modulePath) || !EXPORT_RE.test(testCase.exportName)) throw new Error(`unsupported hidden function reference in case ${testCase.id}`)
		canonical(testCase.input)
		canonical(testCase.expected)
		totalInputBytes += jsonBytes(testCase.input)
		totalOutputBytes += jsonBytes(testCase.expected)
		if (totalInputBytes > suite.limits.maxInputBytes || totalOutputBytes > suite.limits.maxOutputBytes) throw new Error("hidden verifier suite exceeds its total input/output bound")
	}
	return createHash("sha256").update(canonical(suite)).digest("hex")
}

function reportPayload(report: Omit<SignedHiddenVerificationReport, "signature">): Buffer {
	return Buffer.from(canonical(report), "utf8")
}

export function signHiddenVerificationReport(
	report: Omit<SignedHiddenVerificationReport, "signature">,
	sign: (payload: Buffer) => Buffer,
): SignedHiddenVerificationReport {
	return { ...report, signature: sign(reportPayload(report)).toString("base64") }
}

export function createHiddenVerificationNonce(): string {
	return randomBytes(32).toString("base64url")
}

/** Runs bounded cases and checks the signed isolated output against supervisor-held answers. */
export async function verifyHiddenFunctions(
	suite: HiddenFunctionSuite,
	identityInput: Omit<HiddenVerificationIdentity, "protocol" | "protocolDigest" | "limits" | "nonce"> & { nonce?: string },
	options: HiddenVerificationOptions,
): Promise<HiddenVerificationResult> {
	const frozenSuite = cloneJson(suite)
	const protocolDigest = hiddenFunctionSuiteDigest(frozenSuite)
	if (!DIGEST_RE.test(identityInput.candidateSourceDigest) || !/^sha256:[a-f0-9]{64}$/.test(identityInput.evaluatorImageDigest) || !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(identityInput.candidateCommit) ||
		!TOKEN_RE.test(identityInput.sessionId) || !TOKEN_RE.test(identityInput.jobId)) {
		throw new Error("hidden verification requires frozen candidate digest, commit, session, and job identities")
	}
	const nonce = identityInput.nonce ?? createHiddenVerificationNonce()
	if (!NONCE_RE.test(nonce)) throw new Error("hidden verification nonce is malformed")
	const identity: HiddenVerificationIdentity = {
		protocol: HIDDEN_VERIFIER_PROTOCOL,
		protocolDigest,
		evaluatorImageDigest: identityInput.evaluatorImageDigest,
		candidateSourceDigest: identityInput.candidateSourceDigest,
		candidateCommit: identityInput.candidateCommit,
		sessionId: identityInput.sessionId,
		jobId: identityInput.jobId,
		nonce,
		limits: { ...frozenSuite.limits },
	}
	if (!await options.nonceStore.consume(nonce)) throw new Error("hidden verification nonce was already consumed")
	const requestCases: HiddenCaseInput[] = frozenSuite.cases.map(({ id, modulePath, exportName, input }) => ({ id, modulePath, exportName, input }))
	const report = await options.runner.run({ identity: cloneJson(identity), cases: cloneJson(requestCases) })
	if (!report || !Array.isArray(report.outputs) || typeof report.signature !== "string") throw new Error("isolated hidden verifier returned an invalid or partial report")
	const { signature, ...payload } = report
	let authenticated = false
	try {
		authenticated = verifySignature(null, reportPayload(payload), options.publicKey, Buffer.from(signature, "base64"))
	} catch { /* malformed key/signature is an authentication failure */ }
	if (!authenticated) throw new Error("isolated hidden verifier report signature is invalid")
	if (canonical(report.identity) !== canonical(identity)) throw new Error("isolated hidden verifier report identity does not match the frozen request")
	if (report.outputs.length !== frozenSuite.cases.length) throw new Error("isolated hidden verifier returned a partial or oversized case set")
	const outputsById = new Map<string, unknown>()
	let totalOutputBytes = 0
	for (const output of report.outputs) {
		if (!output || typeof output.id !== "string" || outputsById.has(output.id) || !frozenSuite.cases.some((item) => item.id === output.id)) {
			throw new Error("isolated hidden verifier returned duplicate or unexpected case output")
		}
		totalOutputBytes += jsonBytes(output.output)
		if (totalOutputBytes > frozenSuite.limits.maxOutputBytes) throw new Error("isolated hidden verifier outputs exceed their total bound")
		outputsById.set(output.id, output.output)
	}
	const caseResults = frozenSuite.cases.map((testCase) => ({ id: testCase.id, passed: canonical(outputsById.get(testCase.id)) === canonical(testCase.expected) }))
	const passed = caseResults.every((item) => item.passed)
	return { status: passed ? "passed" : "failed", protocolDigest, identity, caseResults, ...(passed ? {} : { reason: "one or more hidden function outputs did not match" }) }
}
