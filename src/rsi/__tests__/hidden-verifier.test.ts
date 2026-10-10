import assert from "node:assert/strict"
import { generateKeyPairSync, sign } from "node:crypto"
import { createHiddenVerificationNonce, signHiddenVerificationReport, verifyHiddenFunctions } from "../hidden-verifier.js"
import type { HiddenFunctionSuite, IsolatedHiddenCaseRunner, SignedHiddenVerificationReport } from "../hidden-verifier.js"

const { privateKey, publicKey: publicKeyObject } = generateKeyPairSync("ed25519")
const publicKey = publicKeyObject.export({ type: "spki", format: "pem" }).toString()
const suite: HiddenFunctionSuite = {
	protocol: "headlesscode.hidden-functions.v1",
	limits: { timeoutMs: 1000, maxMemoryMb: 128, maxInputBytes: 1024, maxOutputBytes: 1024, maxCases: 4 },
	cases: [{ id: "case-1", modulePath: "src/math.js", exportName: "double", input: { value: 3 }, expected: 6 }],
}
const identity = {
	candidateSourceDigest: "a".repeat(64), candidateCommit: "b".repeat(64), sessionId: "session-1", jobId: "job-1",
}
const consumed = new Set<string>()
const nonceStore = { async consume(nonce: string) { if (consumed.has(nonce)) return false; consumed.add(nonce); return true } }
const replayNonce = createHiddenVerificationNonce()

function runnerFor(make: (request: Parameters<IsolatedHiddenCaseRunner["run"]>[0]) => Partial<SignedHiddenVerificationReport>): IsolatedHiddenCaseRunner {
	return { async run(request) {
		const fields = make(request)
		const report = {
			identity: request.identity,
			outputs: [{ id: request.cases[0]!.id, output: 6 }],
			...fields,
		} as Omit<SignedHiddenVerificationReport, "signature">
		return signHiddenVerificationReport(report, (payload) => sign(null, payload, privateKey))
	} }
}

const result = await verifyHiddenFunctions(suite, identity, { runner: runnerFor(() => ({})), nonceStore, publicKey })
assert.equal(result.status, "passed")
assert.equal(result.caseResults[0]?.passed, true)

let received: unknown
await verifyHiddenFunctions(suite, identity, {
	runner: { async run(request) { received = request; return runnerFor(() => ({})).run(request) } },
	nonceStore, publicKey,
})
assert.equal(JSON.stringify(received).includes('"expected"'), false, "expected answers stay out of the isolated runner request")

await verifyHiddenFunctions(suite, { ...identity, nonce: replayNonce }, { runner: runnerFor(() => ({})), nonceStore, publicKey })
await assert.rejects(verifyHiddenFunctions(suite, { ...identity, nonce: replayNonce }, { runner: runnerFor(() => ({})), nonceStore, publicKey }), /already consumed/)

await assert.rejects(verifyHiddenFunctions(suite, { ...identity, candidateSourceDigest: "c".repeat(64) }, {
	runner: runnerFor((request) => ({ identity: { ...request.identity, candidateSourceDigest: "d".repeat(64) } })),
	nonceStore, publicKey,
}), /signature is invalid|identity does not match/)

await assert.rejects(verifyHiddenFunctions(suite, identity, {
	runner: { async run(request) {
		const signed = await runnerFor(() => ({})).run(request)
		return { ...signed, outputs: [] }
	} },
	nonceStore, publicKey,
}), /signature is invalid/)

await assert.rejects(verifyHiddenFunctions(suite, identity, {
	runner: runnerFor(() => ({ outputs: [] })), nonceStore, publicKey,
}), /partial or oversized case set/)

const mismatch = await verifyHiddenFunctions(suite, identity, {
	runner: runnerFor(() => ({ outputs: [{ id: "case-1", output: 7 }] })), nonceStore, publicKey,
})
assert.equal(mismatch.status, "failed", "unexpected output fails comparison in the supervisor")

await assert.rejects(verifyHiddenFunctions(suite, identity, {
	runner: { async run() { throw new Error("runner unavailable") } }, nonceStore, publicKey,
}), /runner unavailable/)

await assert.rejects(verifyHiddenFunctions({ ...suite, cases: [{ ...suite.cases[0]!, modulePath: "../secret.js" }] }, identity, {
	runner: runnerFor(() => ({})), nonceStore, publicKey,
}), /unsupported hidden function reference/)

const freshNonce = createHiddenVerificationNonce()
assert.match(freshNonce, /^[A-Za-z0-9_-]{43}$/)
console.log("All hidden verifier tests passed")
