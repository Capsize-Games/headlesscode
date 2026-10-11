import assert from "node:assert/strict"
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync } from "node:crypto"
import * as fs from "node:fs/promises"
import { execFileSync } from "node:child_process"
import * as path from "node:path"

import { assertReviewerBillingTokens, createSyntheticWorkspace, ensurePrivateDirectory, parseQualificationArgs, signReceipt, verifyControllerGate, verifyReceipt } from "../../../scripts/rsi-adversarial-qualification.js"
import type { RsiRunRecord } from "../types.js"

function pin(publicKey: ReturnType<typeof createPublicKey>): string {
	return createHash("sha256").update(publicKey.export({ type: "spki", format: "der" })).digest("hex")
}

assert.match(parseQualificationArgs([]).error ?? "", /signing-key/)
assert.equal(parseQualificationArgs(["--receipt-signing-key", "key.pem", "--evaluator-trusted-public-key", "public.pem", "--receipt-public-key-sha256", "a".repeat(64)]).error, undefined)
assert.match(parseQualificationArgs(["--receipt-signing-key", "key.pem", "--evaluator-trusted-public-key", "public.pem", "--receipt-public-key-sha256", "not-a-pin"]).error ?? "", /SHA-256/)
assert.match(parseQualificationArgs(["--unexpected"]).error ?? "", /unknown argument/)

const nativeUsage = { promptTokens: 862, completionTokens: 66 }
const nativeBilling = { id: "generation", tokensPrompt: 411, tokensCompletion: 24, nativeTokensPrompt: 862, nativeTokensCompletion: 66 }
assert.doesNotThrow(() => assertReviewerBillingTokens(nativeUsage, nativeBilling), "normalized token counts must not invalidate matching provider-native usage")
assert.throws(() => assertReviewerBillingTokens(nativeUsage, { ...nativeBilling, nativeTokensPrompt: 863 }), /do not match/)
assert.throws(() => assertReviewerBillingTokens({ completionTokens: 66 }, nativeBilling), /do not match/)
assert.doesNotThrow(() => assertReviewerBillingTokens(nativeUsage, { id: "legacy", tokensPrompt: 862, tokensCompletion: 66 }))

const pair = generateKeyPairSync("ed25519")
const privateKey = createPrivateKey(pair.privateKey.export({ type: "pkcs8", format: "pem" }))
const publicKey = createPublicKey(pair.publicKey.export({ type: "spki", format: "pem" }))
const publicPin = pin(publicKey)
const payload = { gateMatched: true, selection: { candidateStatus: "rejected", selected: null }, outputSha256: "b".repeat(64) }
const signed = signReceipt(payload, privateKey, publicKey, publicPin)
assert.equal(verifyReceipt(signed, publicPin, pair.publicKey.export({ type: "spki", format: "pem" }) as Buffer), true)
assert.equal(verifyReceipt({ ...signed, payload: { ...payload, gateMatched: false } }, publicPin, pair.publicKey.export({ type: "spki", format: "pem" }) as Buffer), false, "receipt payload tampering must invalidate the signature")
assert.equal(verifyReceipt(signed, "0".repeat(64), pair.publicKey.export({ type: "spki", format: "pem" }) as Buffer), false, "a different public-key pin must fail")

const failedReview = {
	candidates: [{ id: "fixture-candidate", status: "rejected", fitness: { score: 0, adversarialPenalty: 5, hardGates: { adversarialPass: false } } }],
	selected: undefined,
	selectedCandidates: [],
} as unknown as RsiRunRecord
assert.deepEqual(verifyControllerGate(failedReview, "failed", [{ passed: false }], 5), {
	gateMatched: true, selectionMatched: true, expectedAdversarialPass: false,
})

const passingReviewButUnqualifiedProof = {
	candidates: [{ id: "fixture-candidate", status: "failed", fitness: { score: 80, adversarialPenalty: 0, hardGates: { adversarialPass: true } } }],
	selected: undefined,
	selectedCandidates: [],
} as unknown as RsiRunRecord
assert.deepEqual(verifyControllerGate(passingReviewButUnqualifiedProof, "passed", [{ passed: true }], 0), {
	gateMatched: true, selectionMatched: true, expectedAdversarialPass: true,
}, "the receipt must distinguish an adversarial pass from final candidate selection")

const scratch = path.join(process.cwd(), ".headlesscode", "scratch", "adversarial-qualification-fixture-test")
await fs.mkdir(scratch, { recursive: true, mode: 0o700 })
const symlinkTarget = path.join(scratch, "target")
await fs.mkdir(symlinkTarget, { mode: 0o700 })
const symlinkAncestor = path.join(scratch, "linked")
await fs.symlink(symlinkTarget, symlinkAncestor)
await assert.rejects(ensurePrivateDirectory(path.join(symlinkAncestor, "nested")), /symlink/)
await assert.rejects(fs.stat(path.join(symlinkTarget, "nested")), /ENOENT/, "refusing an ancestor symlink must have zero writes behind it")
await fs.unlink(symlinkAncestor)
await fs.rmdir(symlinkTarget)
const fixture = await createSyntheticWorkspace(scratch)
assert.equal(fixture.sourcePatchSha256, createHash("sha256").update(fixture.mutationPatch).digest("hex"))
assert.match(fixture.mutationPatch.toString("utf8"), /return Math\.max\(0, Math\.trunc\(value\)\)/)
execFileSync("git", ["apply", "--check", "-"], { cwd: fixture.repoRoot, input: fixture.mutationPatch })
execFileSync("git", ["apply", "-"], { cwd: fixture.repoRoot, input: fixture.mutationPatch })
assert.throws(() => execFileSync("node", ["--input-type=module", "-e", "import { clampPercent } from './src/subject.mjs'; if (clampPercent(101) !== 100) process.exit(1)"], { cwd: fixture.repoRoot, stdio: "pipe" }), "the controlled patch must have the documented boundary defect")
await fs.rm(path.dirname(fixture.repoRoot), { recursive: true, force: true })

process.stdout.write("adversarial qualification receipt tests passed\n")
