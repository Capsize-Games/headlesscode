import { createHash } from "node:crypto"
import { constants } from "node:fs"
import * as fs from "node:fs/promises"
import * as path from "node:path"

export interface EvaluatorRuntimeIdentity {
	imageDigest: string
	policySha256: string
	policySource: string
	identitySource: "operator-pinned-immutable-reference" | "synthetic-test-hooks"
}

const SYNTHETIC_IMAGE_DIGEST = `sha256:${"0".repeat(64)}`
const MAX_POLICY_BYTES = 1024 * 1024

export function evaluatorImageReference(imageDigest: string): string {
	if (!/^sha256:[a-f0-9]{64}$/.test(imageDigest)) throw new Error("evaluator image digest is malformed")
	return `headlesscode-openshell-rsi@${imageDigest}`
}

function sha256(bytes: Buffer): string {
	return createHash("sha256").update(bytes).digest("hex")
}

export async function resolveEvaluatorPolicySha256(defaultPolicyPath: string, env: NodeJS.ProcessEnv = process.env): Promise<string> {
	const policySource = path.resolve(env.HEADLESSCODE_OPENSHELL_POLICY?.trim() || defaultPolicyPath)
	return sha256(await readProtectedPolicy(policySource))
}

async function assertNoSymlinkPath(target: string): Promise<void> {
	const absolute = path.resolve(target)
	const components: string[] = []
	let cursor = absolute
	while (true) {
		components.push(cursor)
		const parent = path.dirname(cursor)
		if (parent === cursor) break
		cursor = parent
	}
	for (const component of components.reverse()) {
		const stat = await fs.lstat(component)
		if (stat.isSymbolicLink()) throw new Error(`OpenShell policy path must not traverse symlinks: ${component}`)
		if (component === absolute ? !stat.isFile() : !stat.isDirectory()) throw new Error(`OpenShell policy path has an unexpected file type: ${component}`)
	}
}

async function readProtectedPolicy(target: string): Promise<Buffer> {
	await assertNoSymlinkPath(target)
	if (typeof constants.O_NOFOLLOW !== "number") throw new Error("OpenShell policy reads require platform O_NOFOLLOW support")
	const flags = constants.O_RDONLY | constants.O_NOFOLLOW | (constants.O_NONBLOCK ?? 0)
	const handle = await fs.open(target, flags)
	try {
		const before = await handle.stat({ bigint: true })
		const currentUid = process.geteuid?.() ?? process.getuid?.()
		if (!before.isFile() || before.nlink !== 1n || (before.mode & 0o022n) !== 0n) throw new Error("OpenShell policy must be a protected regular file with no additional hard links or group/other write access")
		if (currentUid !== undefined && before.uid !== 0n && before.uid !== BigInt(currentUid)) throw new Error("OpenShell policy must be owned by root or the current user")
		if (before.size < 1n || before.size > BigInt(MAX_POLICY_BYTES)) throw new Error("OpenShell evaluator policy must be between 1 byte and 1 MiB")
		const chunks: Buffer[] = []
		let total = 0
		while (total <= MAX_POLICY_BYTES) {
			const chunk = Buffer.alloc(Math.min(64 * 1024, MAX_POLICY_BYTES + 1 - total))
			const { bytesRead } = await handle.read(chunk, 0, chunk.byteLength, total)
			if (bytesRead === 0) break
			chunks.push(chunk.subarray(0, bytesRead))
			total += bytesRead
		}
		if (total < 1 || total > MAX_POLICY_BYTES) throw new Error("OpenShell evaluator policy must be between 1 byte and 1 MiB")
		const after = await handle.stat({ bigint: true })
		if (after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size || after.mtimeNs !== before.mtimeNs || after.ctimeNs !== before.ctimeNs || BigInt(total) !== before.size) throw new Error("OpenShell policy changed while it was being read")
		return Buffer.concat(chunks, total)
	} finally {
		await handle.close()
	}
}

/** Resolve the policy bytes and operator-pinned OCI digest used by every evaluator guest. */
export async function resolveEvaluatorRuntimeIdentity(options: {
	defaultPolicyPath: string
	env?: NodeJS.ProcessEnv
	synthetic?: boolean
}): Promise<EvaluatorRuntimeIdentity> {
	const env = options.env ?? process.env
	const policySource = path.resolve(env.HEADLESSCODE_OPENSHELL_POLICY?.trim() || options.defaultPolicyPath)
	const policy = await readProtectedPolicy(policySource)
	const imageDigest = options.synthetic
		? SYNTHETIC_IMAGE_DIGEST
		: env.HEADLESSCODE_RSI_EVALUATOR_IMAGE_DIGEST?.trim()
	if (!imageDigest || !/^sha256:[a-f0-9]{64}$/.test(imageDigest)) {
		throw new Error("RSI evaluator guests require HEADLESSCODE_RSI_EVALUATOR_IMAGE_DIGEST=sha256:<64 lowercase hex digits>")
	}
	return {
		imageDigest,
		policySha256: sha256(policy),
		policySource,
		identitySource: options.synthetic ? "synthetic-test-hooks" : "operator-pinned-immutable-reference",
	}
}

/** Read and stage exact policy bytes immediately before provider construction. */
export async function snapshotEvaluatorPolicy(expectedSha256: string, defaultPolicyPath: string, env: NodeJS.ProcessEnv = process.env): Promise<Buffer> {
	if (!/^[a-f0-9]{64}$/.test(expectedSha256)) throw new Error("evaluator policy digest is malformed")
	const policySource = path.resolve(env.HEADLESSCODE_OPENSHELL_POLICY?.trim() || defaultPolicyPath)
	const bytes = await readProtectedPolicy(policySource)
	if (bytes.byteLength < 1 || bytes.byteLength > MAX_POLICY_BYTES || sha256(bytes) !== expectedSha256) {
		throw new Error("effective OpenShell policy bytes differ from the frozen evaluator identity")
	}
	return bytes
}
