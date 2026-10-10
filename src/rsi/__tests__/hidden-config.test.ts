import assert from "node:assert/strict"
import { generateKeyPairSync } from "node:crypto"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { parseRsiArgs } from "../config.js"
import { loadHiddenVerifierConfig } from "../hidden-config.js"
import { hiddenFunctionSuiteDigest } from "../hidden-verifier.js"
import type { HiddenFunctionSuite } from "../hidden-verifier.js"

const root = await fs.mkdtemp(path.join(os.tmpdir(), "hc-hidden-config-"))
try {
	const repo = path.join(root, "repo")
	const operator = path.join(root, "operator")
	await fs.mkdir(repo)
	await fs.mkdir(operator, { mode: 0o700 })
	const suite: HiddenFunctionSuite = {
		protocol: "headlesscode.hidden-functions.v1",
		limits: { timeoutMs: 1000, maxMemoryMb: 128, maxInputBytes: 1024, maxOutputBytes: 1024, maxCases: 2 },
		cases: [{ id: "sum", modulePath: "src/math.js", exportName: "sum", input: [2, 3], expected: 5 }],
	}
	const suitePath = path.join(operator, "suite.json")
	const publicPath = path.join(operator, "public.pem")
	const privatePath = path.join(operator, "private.pem")
	const noncePath = path.join(operator, "nonce-store.json")
	const keys = generateKeyPairSync("ed25519")
	await fs.writeFile(suitePath, JSON.stringify(suite), { mode: 0o600 })
	await fs.writeFile(publicPath, keys.publicKey.export({ type: "spki", format: "pem" }), { mode: 0o600 })
	await fs.writeFile(privatePath, keys.privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 })
	const digest = hiddenFunctionSuiteDigest(suite)
	const parsed = parseRsiArgs([
		"--repo", repo,
		"--hidden-suite", suitePath,
		"--hidden-suite-sha256", digest,
		"--hidden-public-key", publicPath,
		"--hidden-private-key", privatePath,
		"--hidden-nonce-store", noncePath,
		"--hidden-image-digest", `sha256:${"a".repeat(64)}`,
	])
	assert.ok(parsed.config)
	const loaded = await loadHiddenVerifierConfig(parsed.config)
	assert.equal(loaded?.suiteDigest, digest)
	assert.equal(loaded?.identity.imageDigest, `sha256:${"a".repeat(64)}`)
	const nonce = "A".repeat(32)
	assert.equal(await loaded!.nonceStore.consume(nonce), true)
	assert.equal(await loaded!.nonceStore.consume(nonce), false, "durable nonce store rejects replay")
	const changed = { ...parsed.config, hiddenSuiteSha256: "b".repeat(64) }
	await assert.rejects(loadHiddenVerifierConfig(changed), /operator-approved SHA-256 digest/)
	const partial = parseRsiArgs(["--repo", repo, "--hidden-suite", suitePath])
	assert.match(partial.error ?? "", /requires all six/)
	const inRepo = parseRsiArgs([
		"--repo", repo,
		"--hidden-suite", suitePath,
		"--hidden-suite-sha256", digest,
		"--hidden-public-key", publicPath,
		"--hidden-private-key", privatePath,
		"--hidden-nonce-store", path.join(repo, "nonce-store.json"),
		"--hidden-image-digest", `sha256:${"a".repeat(64)}`,
	])
	assert.ok(inRepo.config)
	await assert.rejects(loadHiddenVerifierConfig(inRepo.config), /must be outside/)
} finally {
	await fs.rm(root, { recursive: true, force: true })
}
console.log("All hidden verifier operator configuration tests passed")
