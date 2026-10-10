import { createHash, createPrivateKey, createPublicKey, sign, verify } from "node:crypto"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import type { HiddenFunctionSuite, HiddenNonceStore } from "./hidden-verifier.js"
import { hiddenFunctionSuiteDigest } from "./hidden-verifier.js"
import type { RsiConfig } from "./types.js"

export interface LoadedHiddenVerifierConfig {
	suite: HiddenFunctionSuite
	suiteDigest: string
	publicKey: Buffer
	privateKey: Buffer
	publicKeyDigest: string
	imageDigest: string
	nonceStore: HiddenNonceStore
	identity: { protocol: string; suiteSha256: string; imageDigest: string; publicKeySha256: string }
}

async function readOperatorFile(filePath: string): Promise<Buffer> {
	const absolute = path.resolve(filePath)
	const stat = await fs.lstat(absolute)
	if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`hidden verifier operator file must be a regular non-symlink file: ${absolute}`)
	if ((stat.mode & 0o077) !== 0) throw new Error(`hidden verifier operator files must have mode 0600 or stricter: ${absolute}`)
	const real = await fs.realpath(absolute)
	if (real !== absolute) throw new Error(`hidden verifier operator file path must not traverse a symlink: ${absolute}`)
	return fs.readFile(absolute)
}

function outside(candidate: string, root: string): boolean {
	const relative = path.relative(path.resolve(root), path.resolve(candidate))
	return relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)
}

function createDurableNonceStore(filePath: string): HiddenNonceStore {
	const storePath = path.resolve(filePath)
	return {
		async consume(nonce) {
			if (!/^[A-Za-z0-9_-]{32,128}$/.test(nonce)) return false
			await fs.mkdir(path.dirname(storePath), { recursive: true, mode: 0o700 })
			const parent = path.dirname(storePath)
			const parentStat = await fs.lstat(parent)
			if (!parentStat.isDirectory() || parentStat.isSymbolicLink() || await fs.realpath(parent) !== parent) throw new Error("hidden verifier nonce-store directory must not traverse symlinks")
			const lockPath = `${storePath}.lock`
			let lock: fs.FileHandle
			try { lock = await fs.open(lockPath, "wx", 0o600) } catch { return false }
			try {
				const stat = await fs.lstat(storePath).catch((error: NodeJS.ErrnoException) => error.code === "ENOENT" ? undefined : Promise.reject(error))
				if (stat && (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0)) throw new Error("hidden verifier nonce store must be a mode-0600 regular file")
				const raw = stat ? await fs.readFile(storePath, "utf8") : "[]\n"
				const parsed: unknown = JSON.parse(raw)
				if (!Array.isArray(parsed) || parsed.some((entry) => typeof entry !== "string")) throw new Error("hidden verifier nonce store is malformed")
				if (parsed.includes(nonce)) return false
				const temporary = `${storePath}.tmp-${process.pid}`
				const output = Buffer.from(`${JSON.stringify([...parsed, nonce])}\n`)
				const handle = await fs.open(temporary, "wx", 0o600)
				try { await handle.writeFile(output); await handle.sync() } finally { await handle.close() }
				await fs.rename(temporary, storePath)
				const directory = await fs.open(parent, "r")
				try { await directory.sync() } finally { await directory.close() }
				return true
			} finally {
				await lock.close()
				await fs.unlink(lockPath).catch(() => undefined)
			}
		},
	}
}

/** Load private verifier material before any candidate execution and retain it only in supervisor memory. */
export async function loadHiddenVerifierConfig(config: RsiConfig): Promise<LoadedHiddenVerifierConfig | undefined> {
	const { hiddenSuitePath, hiddenSuiteSha256, hiddenPublicKeyPath, hiddenPrivateKeyPath, hiddenNonceStorePath, hiddenImageDigest } = config
	const values = [hiddenSuitePath, hiddenSuiteSha256, hiddenPublicKeyPath, hiddenPrivateKeyPath, hiddenNonceStorePath, hiddenImageDigest]
	if (values.every((value) => value === undefined)) return undefined
	if (!hiddenSuitePath || !hiddenSuiteSha256 || !hiddenPublicKeyPath || !hiddenPrivateKeyPath || !hiddenNonceStorePath || !hiddenImageDigest) throw new Error("hidden verification requires --hidden-suite, --hidden-suite-sha256, --hidden-public-key, --hidden-private-key, --hidden-nonce-store, and --hidden-image-digest")
	const suitePath = path.resolve(hiddenSuitePath)
	const publicPath = path.resolve(hiddenPublicKeyPath)
	const privatePath = path.resolve(hiddenPrivateKeyPath)
	const noncePath = path.resolve(hiddenNonceStorePath)
	for (const filePath of [suitePath, publicPath, privatePath, noncePath]) {
		for (const root of [config.repoRoot, config.archiveDir, config.worktreeDir]) {
			if (!outside(filePath, root)) throw new Error("hidden suite, keys, and nonce store must be outside the repository, RSI archive, and candidate worktree mounts")
		}
	}
	if (!/^sha256:[a-f0-9]{64}$/.test(hiddenImageDigest)) throw new Error("hidden evaluator image must be pinned as sha256:<64 lowercase hex digits>")
	if (!/^[a-f0-9]{64}$/.test(hiddenSuiteSha256)) throw new Error("approved hidden suite digest must be 64 lowercase hexadecimal characters")
	const [suiteBytes, publicKey, privateKey] = await Promise.all([
		readOperatorFile(suitePath), readOperatorFile(publicPath), readOperatorFile(privatePath),
	])
	const suite = JSON.parse(suiteBytes.toString("utf8")) as HiddenFunctionSuite
	const suiteDigest = hiddenFunctionSuiteDigest(suite)
	if (suiteDigest !== hiddenSuiteSha256) throw new Error("hidden suite does not match its operator-approved SHA-256 digest")
	const privateObject = createPrivateKey(privateKey)
	const publicObject = createPublicKey(publicKey)
	if (privateObject.asymmetricKeyType !== "ed25519" || publicObject.asymmetricKeyType !== "ed25519") throw new Error("hidden verifier keys must be Ed25519")
	const challenge = Buffer.from("headlesscode-hidden-verifier-key-pair-v1")
	if (!verify(null, challenge, publicObject, sign(null, challenge, privateObject))) throw new Error("hidden verifier public and private keys do not form a key pair")
	const nonceStore = createDurableNonceStore(noncePath)
	const publicKeyDigest = createHash("sha256").update(publicKey).digest("hex")
	return {
		suite, suiteDigest, publicKey, privateKey, publicKeyDigest,
		imageDigest: hiddenImageDigest, nonceStore,
		identity: { protocol: suite.protocol, suiteSha256: suiteDigest, imageDigest: hiddenImageDigest, publicKeySha256: publicKeyDigest },
	}
}
