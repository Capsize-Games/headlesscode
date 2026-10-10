import { execFileSync } from "node:child_process"
import { createHash, createPrivateKey, sign, type KeyObject } from "node:crypto"
import * as path from "node:path"
import { runOpenShellHiddenFunctionCases } from "./openshell.js"
import type { RsiConfig } from "./types.js"
import type { RsiOpenShellProviderFactory } from "./openshell.js"
import { signHiddenVerificationReport } from "./hidden-verifier.js"
import type { IsolatedHiddenCaseRunner } from "./hidden-verifier.js"

export interface OpenShellHiddenRunnerOptions {
	candidateRoot: string
	config: RsiConfig
	signingKey: string | Buffer | KeyObject
	providerFactory?: RsiOpenShellProviderFactory
}

/** Host-side signer and OpenShell adapter. The private key is never added to guest inputs or environment. */
export function createOpenShellHiddenCaseRunner(options: OpenShellHiddenRunnerOptions): IsolatedHiddenCaseRunner {
	const candidateRoot = path.resolve(options.candidateRoot)
	const signingKey = typeof options.signingKey === "string" || Buffer.isBuffer(options.signingKey)
		? createPrivateKey(options.signingKey)
		: options.signingKey
	if (signingKey.asymmetricKeyType !== "ed25519") throw new Error("hidden verifier report key must be an Ed25519 private key")
	return {
		async run(request) {
			const actualCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: candidateRoot, encoding: "utf8" }).trim()
			if (actualCommit !== request.identity.candidateCommit) throw new Error("candidate commit changed after hidden verification identity was frozen")
			const sourceTree = execFileSync("git", ["ls-tree", "-r", "-z", "--full-tree", actualCommit], { cwd: candidateRoot, maxBuffer: 32 * 1024 * 1024 })
			const sourceDigest = createHash("sha256").update(sourceTree).digest("hex")
			if (sourceDigest !== request.identity.candidateSourceDigest) throw new Error("candidate source digest changed after hidden verification identity was frozen")
			const outputs = await runOpenShellHiddenFunctionCases(candidateRoot, actualCommit, options.config, request, options.providerFactory)
			return signHiddenVerificationReport(
				{ identity: request.identity, outputs },
				(payload) => sign(null, payload, signingKey),
			)
		},
	}
}
