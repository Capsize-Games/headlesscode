import { createHash, createPrivateKey, createPublicKey, sign, verify, type KeyObject } from "node:crypto"
import { execFileSync } from "node:child_process"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import type { RsiConfig } from "./types.js"

export interface EvaluatorIntegrityTrust {
	privateKey: KeyObject
	publicKey: KeyObject
	keyId: string
}

export interface EvaluatorIntegrityEnvelope {
	schemaVersion: 1
	keyId: string
	payload: Record<string, unknown>
	signature: string
}

export interface EvaluatorIntegrityPayload extends Record<string, unknown> {
	schemaVersion: 1
	runId: string
	input: Record<string, unknown>
	inputSha256: string
	archiveStateSha256: string
	outputs: Array<{ candidateId: string; taskId: string; outputSha256: string; artifactSha256?: string; artifactBytes?: number }>
	generations: Array<{ generation: number; selectedCandidateIds: string[]; selectedCandidateId?: string; decisionsSha256: string }>
	selectedCandidateId?: string
}

export function canonicalJson(value: unknown): string {
	if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value)
	if (typeof value === "number") {
		if (!Number.isFinite(value)) throw new Error("evaluator integrity data contains a non-finite number")
		return JSON.stringify(value)
	}
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`
	if (typeof value !== "object") throw new Error("evaluator integrity data contains an unsupported value")
	const record = value as Record<string, unknown>
	return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`
}

export function evaluatorIntegrityDigest(value: unknown): string {
	return createHash("sha256").update(canonicalJson(value)).digest("hex")
}

export function evaluatorGenerationDecisionDigest(
	candidates: Array<{
		id: string
		status: string
		baseCommit: string
		parentCommit?: string
		commits: string[]
		protectedPathViolations: string[]
		fitness?: unknown
		developmentProof?: unknown
	}>,
	adversarialReviews: unknown[],
	selectedCandidateId: string | undefined,
): string {
	return evaluatorIntegrityDigest({
		decisions: candidates.map((candidate) => ({
			candidateId: candidate.id,
			status: candidate.status,
			baseCommit: candidate.baseCommit,
			parentCommit: candidate.parentCommit ?? null,
			commits: candidate.commits,
			protectedPathViolations: candidate.protectedPathViolations,
			fitness: candidate.fitness ?? null,
			developmentProof: candidate.developmentProof ?? null,
			adversarial: adversarialReviews.filter((review) =>
				!!review && typeof review === "object" && "candidateId" in review && review.candidateId === candidate.id),
		})),
		selectedCandidateId: selectedCandidateId ?? null,
	})
}

async function regularSourceFiles(root: string, relative: string): Promise<string[]> {
	const absolute = path.join(root, relative)
	const stat = await fs.lstat(absolute)
	if (stat.isFile()) {
		if (stat.isSymbolicLink()) throw new Error(`evaluator source cannot be a symlink: ${relative}`)
		return [relative]
	}
	if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`evaluator source root is not a regular directory: ${relative}`)
	const files: string[] = []
	for (const entry of await fs.readdir(absolute, { withFileTypes: true })) {
		const child = path.posix.join(relative, entry.name)
		if (entry.isSymbolicLink()) throw new Error(`evaluator source contains a symlink: ${child}`)
		if (entry.isDirectory()) files.push(...await regularSourceFiles(root, child))
		else if (entry.isFile()) files.push(child)
	}
	return files
}

export async function evaluatorSourceIdentity(packageRoot: string): Promise<{ files: Array<{ path: string; sha256: string; bytes: number }>; missing: string[]; sha256: string }> {
	const root = path.resolve(packageRoot)
	const sourceRoots = [
		"src", "scripts", "fixtures/rsi-benchmark", "package.json",
		"shared/openshell/headlesscode-policy.yaml", "docker/OpenShell-RSI.Dockerfile",
		"docker/OpenShell-RSI-Training.Dockerfile", "package-lock.json",
	]
	const missing: string[] = []
	const roots = await Promise.all(sourceRoots.map(async (relative) => {
		try { return await regularSourceFiles(root, relative) }
		catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT" || relative === "src") throw error
			missing.push(relative)
			return []
		}
	}))
	const files = [...new Set(roots.flat())].sort()
	const identities: Array<{ path: string; sha256: string; bytes: number }> = []
	for (const relative of files) {
		const bytes = await fs.readFile(path.join(root, relative))
		identities.push({ path: relative, sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.byteLength })
	}
	missing.sort()
	return { files: identities, missing, sha256: evaluatorIntegrityDigest({ files: identities, missing }) }
}

export function evaluatorBaseTreeIdentity(repoRoot: string, baseCommit: string): string {
	if (!/^[a-f0-9]{40,64}$/.test(baseCommit)) throw new Error("evaluator base commit identity is malformed")
	const tree = execFileSync("git", ["ls-tree", "-r", "-z", "--full-tree", baseCommit], { cwd: repoRoot, encoding: "buffer" }) as Buffer
	return createHash("sha256").update(tree).digest("hex")
}

function isOutside(candidate: string, root: string): boolean {
	const relative = path.relative(path.resolve(root), path.resolve(candidate))
	return relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)
}

async function readProtectedKey(filePath: string, name: string): Promise<Buffer> {
	const absolute = path.resolve(filePath)
	const stat = await fs.lstat(absolute)
	if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${name} must be a regular non-symlink file: ${absolute}`)
	if ((stat.mode & 0o077) !== 0) throw new Error(`${name} must have mode 0600 or stricter: ${absolute}`)
	if (stat.nlink !== 1) throw new Error(`${name} must not have additional hard links: ${absolute}`)
	if (await fs.realpath(absolute) !== absolute) throw new Error(`${name} path must not traverse a symlink: ${absolute}`)
	return fs.readFile(absolute)
}

async function rejectSymlinkAncestors(target: string): Promise<void> {
	const absolute = path.resolve(target)
	const segments: string[] = []
	let cursor = absolute
	while (true) {
		segments.push(cursor)
		const parent = path.dirname(cursor)
		if (parent === cursor) break
		cursor = parent
	}
	for (const segment of segments.reverse()) {
		try {
			const stat = await fs.lstat(segment)
			if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`evaluator integrity path contains a symlink or non-directory component: ${segment}`)
			if (await fs.realpath(segment) !== segment) throw new Error(`evaluator integrity path traverses a symlink: ${segment}`)
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") continue
			throw error
		}
	}
}

export async function loadEvaluatorIntegrityTrust(config: RsiConfig): Promise<EvaluatorIntegrityTrust | undefined> {
	const privatePath = config.evaluatorSigningKeyPath
	const publicPath = config.evaluatorTrustedPublicKeyPath
	const pin = config.evaluatorTrustedKeySha256
	if ([privatePath, publicPath, pin].every((value) => value === undefined)) return undefined
	if (!privatePath || !publicPath || !pin) throw new Error("evaluator integrity requires --evaluator-signing-key, --evaluator-trusted-public-key, and --evaluator-trusted-key-sha256")
	if (path.resolve(privatePath) === path.resolve(publicPath)) throw new Error("evaluator signing and trusted public keys must be separate operator files")
	for (const root of [config.repoRoot, config.archiveDir, config.worktreeDir]) await rejectSymlinkAncestors(root)
	for (const filePath of [privatePath, publicPath]) await rejectSymlinkAncestors(path.dirname(path.resolve(filePath)))
	for (const filePath of [privatePath, publicPath]) {
		for (const root of [config.repoRoot, config.archiveDir, config.worktreeDir]) {
			if (!isOutside(filePath, root)) throw new Error("evaluator integrity keys must remain outside the repository, RSI archive, and candidate worktree mounts")
		}
	}
	if (!/^sha256:[a-f0-9]{64}$/.test(pin)) throw new Error("trusted evaluator integrity key pin must be sha256:<64 lowercase hexadecimal digits>")
	const [privatePem, publicPem] = await Promise.all([
		readProtectedKey(privatePath, "evaluator integrity signing key"),
		readProtectedKey(publicPath, "evaluator integrity trusted public key"),
	])
	const privateKey = createPrivateKey(privatePem)
	const publicKey = createPublicKey(publicPem)
	if (privateKey.asymmetricKeyType !== "ed25519" || publicKey.asymmetricKeyType !== "ed25519") throw new Error("evaluator integrity keys must use Ed25519")
	const keyId = `sha256:${createHash("sha256").update(publicKey.export({ format: "der", type: "spki" })).digest("hex")}`
	if (keyId !== pin) throw new Error("trusted evaluator integrity public key does not match its independently configured pin")
	const challenge = Buffer.from("headlesscode-rsi-evaluator-integrity-key-pair-v1")
	if (!verify(null, challenge, publicKey, sign(null, challenge, privateKey))) throw new Error("evaluator integrity signing and trusted public keys do not form a pair")
	return { privateKey, publicKey, keyId }
}

export function signEvaluatorIntegrity(trust: EvaluatorIntegrityTrust, payload: Record<string, unknown>): EvaluatorIntegrityEnvelope {
	return {
		schemaVersion: 1,
		keyId: trust.keyId,
		payload,
		signature: sign(null, Buffer.from(canonicalJson(payload)), trust.privateKey).toString("base64"),
	}
}

export function verifyEvaluatorIntegrity(trust: EvaluatorIntegrityTrust, value: unknown): EvaluatorIntegrityEnvelope {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("evaluator integrity manifest is malformed")
	const envelope = value as Partial<EvaluatorIntegrityEnvelope>
	if (envelope.schemaVersion !== 1 || envelope.keyId !== trust.keyId || !envelope.payload || typeof envelope.payload !== "object" || Array.isArray(envelope.payload) || typeof envelope.signature !== "string") {
		throw new Error("evaluator integrity manifest schema or pinned key identity is invalid")
	}
	const signature = Buffer.from(envelope.signature, "base64")
	if (signature.byteLength !== 64 || !verify(null, Buffer.from(canonicalJson(envelope.payload)), trust.publicKey, signature)) throw new Error("evaluator integrity manifest signature is invalid")
	return envelope as EvaluatorIntegrityEnvelope
}

function manifestRelativePath(runId: string, sha256: string): string {
	if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/.test(runId)) throw new Error("evaluator integrity run ID is malformed")
	if (!/^[a-f0-9]{64}$/.test(sha256)) throw new Error("evaluator integrity manifest digest is malformed")
	return path.posix.join("evaluator-integrity", `${runId}.${sha256}.json`)
}

export async function hasEvaluatorIntegrityManifests(archiveDir: string, runId: string): Promise<boolean> {
	if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/.test(runId)) throw new Error("evaluator integrity run ID is malformed")
	const directory = path.join(path.resolve(archiveDir), "evaluator-integrity")
	await rejectSymlinkAncestors(directory)
	let entries: import("node:fs").Dirent[]
	try { entries = await fs.readdir(directory, { withFileTypes: true }) }
	catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error }
	const prefix = `${runId}.`
	for (const entry of entries) {
		if (!entry.name.startsWith(prefix) || !/^[a-f0-9]{64}\.json$/.test(entry.name.slice(prefix.length))) continue
		if (!entry.isFile() || entry.isSymbolicLink()) throw new Error("evaluator integrity artifact path contains a symlink or non-file")
		return true
	}
	return false
}

export async function writeEvaluatorIntegrityManifest(archiveDir: string, runId: string, envelope: EvaluatorIntegrityEnvelope): Promise<{ path: string; sha256: string }> {
	const bytes = Buffer.from(`${canonicalJson(envelope)}\n`)
	const digest = createHash("sha256").update(bytes).digest("hex")
	const relativePath = manifestRelativePath(runId, digest)
	const archiveRoot = path.resolve(archiveDir)
	await rejectSymlinkAncestors(archiveRoot)
	const destination = path.join(archiveRoot, relativePath)
	const directory = path.dirname(destination)
	await fs.mkdir(directory, { recursive: true, mode: 0o700 })
	if (await fs.realpath(directory) !== directory) throw new Error("evaluator integrity manifest directory must not traverse a symlink")
	try {
		const handle = await fs.open(destination, "wx", 0o600)
		try {
			await handle.writeFile(bytes)
			await handle.sync()
		} finally {
			await handle.close()
		}
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
		const stat = await fs.lstat(destination)
		if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || (stat.mode & 0o077) !== 0 || await fs.realpath(destination) !== destination) {
			throw new Error("existing evaluator integrity manifest is not a protected regular file")
		}
		const existing = await fs.readFile(destination)
		if (!existing.equals(bytes)) throw new Error("evaluator integrity manifest digest path already contains different bytes")
	}
	const parent = await fs.open(directory, "r")
	try { await parent.sync() } finally { await parent.close() }
	return { path: relativePath, sha256: digest }
}

export async function readEvaluatorIntegrityManifest(archiveDir: string, runId: string, sha256: string): Promise<{ envelope: unknown; sha256: string }> {
	const filePath = path.join(path.resolve(archiveDir), manifestRelativePath(runId, sha256))
	await rejectSymlinkAncestors(path.dirname(filePath))
	const stat = await fs.lstat(filePath)
	if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || (stat.mode & 0o077) !== 0) throw new Error("evaluator integrity manifest must be a protected regular file")
	if (await fs.realpath(filePath) !== filePath) throw new Error("evaluator integrity manifest path must not traverse a symlink")
	const bytes = await fs.readFile(filePath)
	let envelope: unknown
	try { envelope = JSON.parse(bytes.toString("utf8")) } catch { throw new Error("evaluator integrity manifest is not valid JSON") }
	return { envelope, sha256: createHash("sha256").update(bytes).digest("hex") }
}
