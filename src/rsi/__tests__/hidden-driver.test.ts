import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { generateKeyPairSync, sign } from "node:crypto"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { HIDDEN_FUNCTION_DRIVER } from "../openshell.js"
import { createHiddenVerificationNonce, signHiddenVerificationReport, verifyHiddenFunctions } from "../hidden-verifier.js"
import type { HiddenFunctionSuite } from "../hidden-verifier.js"

const root = fs.mkdtempSync(path.join(os.tmpdir(), "hc-hidden-driver-cpu-"))
try {
	const candidateDir = path.join(root, "src")
	fs.mkdirSync(candidateDir, { recursive: true })
	fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ type: "module" }))
	fs.writeFileSync(path.join(candidateDir, "candidate.js"), [
		"export const explode = () => { throw new Error('candidate failure') }",
		"export const returnNaN = () => NaN",
		"export const returnInfinity = () => Infinity",
		"export const returnUndefinedMember = () => ({ value: undefined })",
		"export const returnNull = () => null",
		"export const returnJson = () => ({ ok: true, values: [null, 1, 'x'] })",
	].join("\n") + "\n")
	const driver = path.join(root, "driver.mjs")
	const source = HIDDEN_FUNCTION_DRIVER.replace('const root = "/workspace"', `const root = ${JSON.stringify(root)}`).replace('"__headlesscode_hidden__/inputs.json"', '"inputs.json"')
	fs.writeFileSync(driver, source)
	const invoke = (request: { identity: { limits: { maxCases: number; maxOutputBytes: number } }; cases: Array<{ id: string; modulePath: string; exportName: string; input: unknown }> }) => {
		fs.writeFileSync(path.join(root, "inputs.json"), JSON.stringify(request))
		return spawnSync(process.execPath, ["--max-old-space-size=64", driver], { encoding: "utf8", timeout: 5000 })
	}
	const keys = generateKeyPairSync("ed25519")
	const publicKey = keys.publicKey.export({ type: "spki", format: "pem" }).toString()
	const cases: Array<{ name: string; expected: unknown; shouldPass: boolean }> = [
		{ name: "explode", expected: null, shouldPass: false },
		{ name: "returnNaN", expected: null, shouldPass: false },
		{ name: "returnInfinity", expected: null, shouldPass: false },
		{ name: "returnUndefinedMember", expected: {}, shouldPass: false },
		{ name: "returnNull", expected: null, shouldPass: true },
		{ name: "returnJson", expected: { ok: true, values: [null, 1, "x"] }, shouldPass: true },
	]
	for (const [index, testCase] of cases.entries()) {
		const suite: HiddenFunctionSuite = {
			protocol: "headlesscode.hidden-functions.v1",
			limits: { timeoutMs: 5000, maxMemoryMb: 128, maxInputBytes: 1024, maxOutputBytes: 100, maxCases: 1 },
			cases: [{ id: `case-${index}`, modulePath: "src/candidate.js", exportName: testCase.name, input: null, expected: testCase.expected }],
		}
		const runner = {
			async run(request: Parameters<import("../hidden-verifier.js").IsolatedHiddenCaseRunner["run"]>[0]) {
				const execution = invoke(request)
				if (execution.status !== 0) throw new Error(`${testCase.name} failed JSON output validation`)
				const marker = /HEADLESSCODE_HIDDEN_OUTPUTS:([A-Za-z0-9+/=]+)/.exec(execution.stdout)
				const encodedMarker = marker?.[1]
				if (!encodedMarker) throw new Error(`${testCase.name} omitted the output marker`)
				const outputs = JSON.parse(Buffer.from(encodedMarker, "base64").toString("utf8"))
				return signHiddenVerificationReport({ identity: request.identity, outputs }, (payload) => sign(null, payload, keys.privateKey))
			},
		}
		const verification = verifyHiddenFunctions(suite, {
			candidateSourceDigest: "a".repeat(64), evaluatorImageDigest: `sha256:${"b".repeat(64)}`,
			candidateCommit: "c".repeat(40), sessionId: "driver-test", jobId: `job-${index}`, nonce: createHiddenVerificationNonce(),
		}, {
			runner, publicKey,
			nonceStore: { async consume() { return true } },
		})
		if (testCase.shouldPass) {
			assert.equal((await verification).status, "passed", `${testCase.name} is valid JSON matching its supervisor-held answer`)
		} else {
			await assert.rejects(verification, /failed JSON output validation/, `${testCase.name} cannot match a JSON expected value after coercion`)
		}
	}
} finally {
	fs.rmSync(root, { recursive: true, force: true })
}
console.log("All hidden driver JSON boundary tests passed")
