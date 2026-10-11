import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { evaluatorImageReference, resolveEvaluatorRuntimeIdentity, snapshotEvaluatorPolicy } from "../evaluator-runtime.js"

async function main(): Promise<void> {
	const scratch = path.resolve(".headlesscode/scratch")
	await fs.mkdir(scratch, { recursive: true, mode: 0o700 })
	const root = await fs.mkdtemp(path.join(scratch, "rsi-evaluator-runtime-"))
	try {
		const policyPath = path.join(root, "policy.yaml")
	const policy = Buffer.from("sandbox:\n  network: disabled\n")
		await fs.writeFile(policyPath, policy, { mode: 0o400 })
		const digest = `sha256:${"a".repeat(64)}`
		await assert.rejects(resolveEvaluatorRuntimeIdentity({ defaultPolicyPath: policyPath, env: {} }), /HEADLESSCODE_RSI_EVALUATOR_IMAGE_DIGEST/)
		const identity = await resolveEvaluatorRuntimeIdentity({ defaultPolicyPath: policyPath, env: { HEADLESSCODE_RSI_EVALUATOR_IMAGE_DIGEST: digest } })
		assert.equal(identity.identitySource, "operator-pinned-immutable-reference")
		assert.equal(identity.imageDigest, digest)
		assert.equal(identity.policySha256, createHash("sha256").update(policy).digest("hex"))
		assert.equal(evaluatorImageReference(identity.imageDigest), `headlesscode-openshell-rsi@${digest}`)
		assert.deepEqual(await snapshotEvaluatorPolicy(identity.policySha256, policyPath, {}), policy)

		const override = path.join(root, "override.yaml")
		await fs.writeFile(override, "sandbox: {}\n", { mode: 0o600 })
		const overrideIdentity = await resolveEvaluatorRuntimeIdentity({ defaultPolicyPath: policyPath, env: { HEADLESSCODE_OPENSHELL_POLICY: override, HEADLESSCODE_RSI_EVALUATOR_IMAGE_DIGEST: digest } })
		assert.equal(overrideIdentity.policySource, override)
		await fs.writeFile(override, "sandbox:\n  network: enabled\n", { mode: 0o600 })
		await assert.rejects(snapshotEvaluatorPolicy(overrideIdentity.policySha256, policyPath, { HEADLESSCODE_OPENSHELL_POLICY: override }), /differ from the frozen evaluator identity/)

		const alias = path.join(root, "policy-alias.yaml")
		await fs.symlink(policyPath, alias)
		await assert.rejects(resolveEvaluatorRuntimeIdentity({ defaultPolicyPath: alias, env: { HEADLESSCODE_RSI_EVALUATOR_IMAGE_DIGEST: digest } }), /must not traverse symlinks/)
		assert.throws(() => evaluatorImageReference("mutable:tag"), /digest is malformed/)
		await assert.rejects(resolveEvaluatorRuntimeIdentity({ defaultPolicyPath: policyPath, env: { HEADLESSCODE_RSI_EVALUATOR_IMAGE_DIGEST: "sha256:ABC" } }), /HEADLESSCODE_RSI_EVALUATOR_IMAGE_DIGEST/)
	} finally {
		await fs.rm(root, { recursive: true, force: true })
	}
	console.log("Evaluator runtime digest pin and effective policy snapshot assertions passed")
}

main().catch((error) => {
	console.error(error)
	process.exit(1)
})
