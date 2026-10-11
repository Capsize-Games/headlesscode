import { createHash, randomUUID } from "node:crypto"
import * as fs from "node:fs"
import * as path from "node:path"
import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3"

export const DEFAULT_RSI_ARTIFACT_LIMIT = 512 * 1024 * 1024

export interface RsiArtifactReference {
	sha256: string
	byteLength: number
	objectKey: string
	backend: "s3" | "file"
	storageId: string
}

export interface RsiArtifactStore {
	readonly backend: "s3" | "file"
	put(content: Buffer): Promise<RsiArtifactReference>
	get(reference: RsiArtifactReference): Promise<Buffer>
	close?(): Promise<void> | void
}

function digest(content: Buffer): string {
	return createHash("sha256").update(content).digest("hex")
}

function artifactKey(sha256: string): string {
	if (!/^[0-9a-f]{64}$/.test(sha256)) throw new Error("invalid RSI artifact digest")
	return `sha256/${sha256.slice(0, 2)}/${sha256}`
}

function checkLimit(content: Buffer, maxBytes: number): void {
	if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error("RSI artifact size limit must be a positive safe integer")
	if (content.byteLength > maxBytes) throw new Error(`RSI artifact exceeds configured ${maxBytes} byte limit`)
}

function verify(content: Buffer, reference: RsiArtifactReference, maxBytes: number): Buffer {
	checkLimit(content, maxBytes)
	if (content.byteLength !== reference.byteLength || digest(content) !== reference.sha256) throw new Error("RSI artifact failed length or SHA-256 verification")
	return content
}

/** Same-host development/test backend; never use it for workers on separate hosts. */
export class FileRsiArtifactStore implements RsiArtifactStore {
	readonly backend = "file" as const
	private readonly root: string
	constructor(root: string, private readonly maxBytes = DEFAULT_RSI_ARTIFACT_LIMIT) {
		this.root = path.resolve(root)
	}

	async put(content: Buffer): Promise<RsiArtifactReference> {
		checkLimit(content, this.maxBytes)
		const sha256 = digest(content)
		const objectKey = artifactKey(sha256)
		const target = path.join(this.root, objectKey)
		await fs.promises.mkdir(path.dirname(target), { recursive: true, mode: 0o700 })
		const temporary = `${target}.tmp-${process.pid}-${randomUUID()}`
		const fd = await fs.promises.open(temporary, "wx", 0o600)
		try { await fd.writeFile(content); await fd.sync() } finally { await fd.close() }
		try { await fs.promises.rename(temporary, target) } catch (error) {
			await fs.promises.rm(temporary, { force: true })
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
		}
		return { sha256, byteLength: content.byteLength, objectKey, backend: this.backend, storageId: `file:${this.root}` }
	}

	async get(reference: RsiArtifactReference): Promise<Buffer> {
		if (reference.objectKey !== artifactKey(reference.sha256)) throw new Error("RSI artifact reference key did not match its digest")
		if (reference.storageId !== `file:${this.root}`) throw new Error("RSI artifact store root differs from the recorded store identity")
		const target = path.join(this.root, reference.objectKey)
		const stat = await fs.promises.lstat(target)
		if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("RSI artifact path is not a regular file")
		return verify(await fs.promises.readFile(target), reference, this.maxBytes)
	}
}

export interface S3RsiArtifactStoreOptions {
	bucket: string
	endpoint?: string
	region?: string
	forcePathStyle?: boolean
	prefix?: string
	maxBytes?: number
	client?: S3Client
}

/** S3-compatible content-addressed artifacts for workers on different hosts. */
export class S3RsiArtifactStore implements RsiArtifactStore {
	readonly backend = "s3" as const
	private readonly client: S3Client
	private readonly prefix: string
	private readonly maxBytes: number
	private readonly storageId: string
	constructor(private readonly options: S3RsiArtifactStoreOptions) {
		if (!options.bucket.trim()) throw new Error("S3 RSI artifact bucket is required")
		this.client = options.client ?? new S3Client({
			region: options.region ?? process.env.AWS_REGION ?? "us-east-1",
			...(options.endpoint ? { endpoint: options.endpoint } : {}),
			forcePathStyle: options.forcePathStyle ?? Boolean(options.endpoint),
		})
		this.prefix = (options.prefix ?? "headlesscode/rsi").replace(/^\/+|\/+$/g, "")
		this.maxBytes = options.maxBytes ?? DEFAULT_RSI_ARTIFACT_LIMIT
		const endpointOrigin = options.endpoint ? new URL(options.endpoint).origin : "aws-s3"
		this.storageId = `s3:${endpointOrigin}:${options.region ?? process.env.AWS_REGION ?? "us-east-1"}:${options.bucket}:${this.prefix}`
	}

	async put(content: Buffer): Promise<RsiArtifactReference> {
		checkLimit(content, this.maxBytes)
		const sha256 = digest(content)
		const key = artifactKey(sha256)
		const objectKey = `${this.prefix}/${key}`
		await this.client.send(new PutObjectCommand({
			Bucket: this.options.bucket,
			Key: objectKey,
			Body: content,
			ContentLength: content.byteLength,
			ChecksumSHA256: Buffer.from(sha256, "hex").toString("base64"),
			Metadata: { sha256 },
		}))
		return { sha256, byteLength: content.byteLength, objectKey, backend: this.backend, storageId: this.storageId }
	}

	async get(reference: RsiArtifactReference): Promise<Buffer> {
		const expectedKey = `${this.prefix}/${artifactKey(reference.sha256)}`
		if (reference.objectKey !== expectedKey || reference.storageId !== this.storageId) throw new Error("RSI artifact reference does not match the configured bucket, prefix and digest")
		const response = await this.client.send(new GetObjectCommand({ Bucket: this.options.bucket, Key: reference.objectKey, ChecksumMode: "ENABLED" }))
		if (!response.Body) throw new Error("S3 RSI artifact response did not include a body")
		const content = Buffer.from(await response.Body.transformToByteArray())
		if (response.ContentLength !== undefined && response.ContentLength !== content.byteLength) throw new Error("S3 RSI artifact content length mismatch")
		if (response.Metadata?.sha256 && response.Metadata.sha256 !== reference.sha256) throw new Error("S3 RSI artifact metadata digest mismatch")
		return verify(content, reference, this.maxBytes)
	}

	close(): void { this.client.destroy() }
}

export function createRsiArtifactStore(env: NodeJS.ProcessEnv = process.env): RsiArtifactStore {
	const maxRaw = env.HEADLESSCODE_RSI_MAX_ARTIFACT_BYTES?.trim()
	const maxBytes = maxRaw ? Number(maxRaw) : DEFAULT_RSI_ARTIFACT_LIMIT
	if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error("HEADLESSCODE_RSI_MAX_ARTIFACT_BYTES must be a positive integer")
	const backend = env.HEADLESSCODE_RSI_ARTIFACT_BACKEND?.trim() || "s3"
	if (backend === "file") {
		const directory = env.HEADLESSCODE_RSI_ARTIFACT_DIR?.trim()
		if (!directory) throw new Error("HEADLESSCODE_RSI_ARTIFACT_DIR is required for the same-host file artifact backend")
		return new FileRsiArtifactStore(directory, maxBytes)
	}
	if (backend !== "s3") throw new Error("HEADLESSCODE_RSI_ARTIFACT_BACKEND must be 's3' or 'file'")
	const bucket = env.HEADLESSCODE_RSI_ARTIFACT_BUCKET?.trim()
	if (!bucket) throw new Error("HEADLESSCODE_RSI_ARTIFACT_BUCKET is required for RSI fleet artifact transfer")
	return new S3RsiArtifactStore({
		bucket,
		endpoint: env.HEADLESSCODE_RSI_ARTIFACT_ENDPOINT?.trim() || undefined,
		region: env.HEADLESSCODE_RSI_ARTIFACT_REGION?.trim() || undefined,
		forcePathStyle: env.HEADLESSCODE_RSI_ARTIFACT_PATH_STYLE === "1",
		prefix: env.HEADLESSCODE_RSI_ARTIFACT_PREFIX,
		maxBytes,
	})
}
