import assert from "node:assert/strict"
import { createHash, generateKeyPairSync } from "node:crypto"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import { evaluatorGenerationDecisionDigest, evaluatorSourceIdentity, loadEvaluatorIntegrityTrust, readEvaluatorIntegrityManifest, signEvaluatorIntegrity, verifyEvaluatorIntegrity, writeEvaluatorIntegrityManifest } from "../evaluation-integrity.js"
import type { RsiConfig } from "../types.js"

async function main(): Promise<void> {
	const scratch = path.resolve(".headlesscode/scratch")
	await fs.mkdir(scratch, { recursive: true, mode: 0o700 })
	const root = await fs.mkdtemp(path.join(scratch, "rsi-evaluator-integrity-"))
	try {
		const repo = path.join(root, "repo")
		const archive = path.join(repo, "archive")
		const worktrees = path.join(repo, "worktrees")
		const protectedKeys = path.join(root, "operator-keys")
		await Promise.all([
			fs.mkdir(repo, { recursive: true }),
			fs.mkdir(archive, { recursive: true }),
			fs.mkdir(worktrees, { recursive: true }),
			fs.mkdir(protectedKeys, { recursive: true, mode: 0o700 }),
		])
		const pair = generateKeyPairSync("ed25519")
		const privatePath = path.join(protectedKeys, "evaluator-signing.pem")
		const publicPath = path.join(protectedKeys, "evaluator-trusted.pem")
		const publicPem = pair.publicKey.export({ format: "pem", type: "spki" })
		await fs.writeFile(privatePath, pair.privateKey.export({ format: "pem", type: "pkcs8" }), { mode: 0o600 })
		await fs.writeFile(publicPath, publicPem, { mode: 0o600 })
		const keyId = `sha256:${createHash("sha256").update(pair.publicKey.export({ format: "der", type: "spki" })).digest("hex")}`
		const config = {
			repoRoot: repo,
			archiveDir: archive,
			worktreeDir: worktrees,
			evaluatorSigningKeyPath: privatePath,
			evaluatorTrustedPublicKeyPath: publicPath,
			evaluatorTrustedKeySha256: keyId,
		} as RsiConfig
		const trust = await loadEvaluatorIntegrityTrust(config)
		assert.ok(trust)
		const payload = { schemaVersion: 1, runId: "run-integrity-test", outputSha256: "a".repeat(64) }
		const envelope = signEvaluatorIntegrity(trust, payload)
		assert.deepEqual(verifyEvaluatorIntegrity(trust, envelope).payload, payload)
		const manifest = await writeEvaluatorIntegrityManifest(archive, payload.runId, envelope)
		const saved = await readEvaluatorIntegrityManifest(archive, payload.runId, manifest.sha256)
		assert.equal(manifest.path, path.posix.join("evaluator-integrity", `${payload.runId}.${manifest.sha256}.json`))
		assert.deepEqual(verifyEvaluatorIntegrity(trust, saved.envelope).payload, payload)
		const nextEnvelope = signEvaluatorIntegrity(trust, { ...payload, outputSha256: "b".repeat(64) })
		const nextManifest = await writeEvaluatorIntegrityManifest(archive, payload.runId, nextEnvelope)
		assert.notEqual(nextManifest.path, manifest.path, "new checkpoints use immutable manifest paths")
		assert.deepEqual(verifyEvaluatorIntegrity(trust, (await readEvaluatorIntegrityManifest(archive, payload.runId, manifest.sha256)).envelope).payload, payload, "a crash before archive checkpointing leaves the prior seal readable")
		const archiveAlias = path.join(root, "archive-alias")
		await fs.symlink(archive, archiveAlias)
		await assert.rejects(() => writeEvaluatorIntegrityManifest(archiveAlias, payload.runId, envelope), /symlink/)
		await assert.rejects(() => loadEvaluatorIntegrityTrust({ ...config, evaluatorTrustedKeySha256: `sha256:${"0".repeat(64)}` }), /does not match its independently configured pin/)
		await assert.rejects(() => loadEvaluatorIntegrityTrust({ ...config, evaluatorSigningKeyPath: path.join(repo, "private.pem") }), /must remain outside/)
		const symlinked = path.join(root, "linked-keys")
		await fs.symlink(protectedKeys, symlinked)
		await assert.rejects(() => loadEvaluatorIntegrityTrust({ ...config, evaluatorSigningKeyPath: path.join(symlinked, path.basename(privatePath)) }), /symlink/)

		const candidate = {
			id: "candidate-a", status: "accepted", baseCommit: "base", commits: ["candidate-commit"],
			protectedPathViolations: [], fitness: { score: 3 }, developmentProof: { accepted: true },
		}
		const digest = evaluatorGenerationDecisionDigest([candidate], [], candidate.id)
		assert.equal(evaluatorGenerationDecisionDigest([candidate], [], candidate.id), digest)
		assert.notEqual(evaluatorGenerationDecisionDigest([{ ...candidate, fitness: { score: 2 } }], [], candidate.id), digest)
		assert.notEqual(evaluatorGenerationDecisionDigest([candidate], [], undefined), digest)
		const sourceIdentity = await evaluatorSourceIdentity(process.cwd())
		assert.match(sourceIdentity.sha256, /^[a-f0-9]{64}$/)
		assert.ok(sourceIdentity.files.some((file) => file.path === "docker/OpenShell-RSI.Dockerfile"))
		assert.ok(sourceIdentity.files.some((file) => file.path === "docker/OpenShell-RSI-Training.Dockerfile"))
		console.log("Evaluator integrity trust, signing, protected paths, and selection identity assertions passed")
	} finally {
		await fs.rm(root, { recursive: true, force: true })
	}
}

main().catch((error) => {
	console.error(error)
	process.exit(1)
})
