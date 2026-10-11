import { createHash, randomUUID } from "node:crypto"
import { constants as fsConstants } from "node:fs"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import * as yaml from "yaml"

export const EXTENSION_MAX_FILES = 32
export const EXTENSION_MAX_FILE_BYTES = 64 * 1024
export const EXTENSION_MAX_TOTAL_BYTES = 256 * 1024
export const EXTENSION_MAX_MANIFEST_BYTES = 64 * 1024
export const EXTENSION_MAX_SCHEMA_DEPTH = 16
export const EXTENSION_MAX_SCHEMA_NODES = 2048

export type ExtensionKind = "skill" | "tool" | "mcp"

export interface ExtensionManifest {
	schemaVersion: 1
	id: string
	kind: ExtensionKind
	description: string
	entrypoint?: string
	inputSchema?: Record<string, unknown>
}

export interface ExtensionBundle {
	manifest: ExtensionManifest
	files: Record<string, string>
}

export interface ExtensionRevision {
	readonly manifest: ExtensionManifest
	readonly files: Readonly<Record<string, string>>
	readonly digest: string
	readonly directory: string
	readonly workspaceRoot: string
}

export interface ExtensionSummary {
	readonly manifest: ExtensionManifest
	readonly digest: string
	readonly directory: string
	readonly workspaceRoot: string
}

export interface CreateExtensionOptions {
	authorizeWrite(destination: string): boolean | Promise<boolean>
}

const EXTENSION_ID = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/
const SHA256 = /^[a-f0-9]{64}$/
const MANIFEST_KEYS = new Set(["schemaVersion", "id", "kind", "description", "entrypoint", "inputSchema"])
const SCHEMA_KEYS = new Set([
	"$schema", "$id", "$ref", "$defs", "definitions", "type", "title", "description", "default", "examples",
	"enum", "const", "properties", "required", "additionalProperties", "items", "minItems", "maxItems",
	"minLength", "maxLength", "pattern", "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum",
	"multipleOf", "minProperties", "maxProperties", "format", "allOf", "anyOf", "oneOf", "not",
])

function plainObject(value: unknown): value is Record<string, unknown> {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return false
	const prototype = Object.getPrototypeOf(value)
	if (prototype !== Object.prototype && prototype !== null) return false
	return Reflect.ownKeys(value).every((key) => {
		if (typeof key !== "string") return false
		const descriptor = Object.getOwnPropertyDescriptor(value, key)
		return descriptor !== undefined && descriptor.enumerable && Object.hasOwn(descriptor, "value")
	})
}

function fail(message: string): never {
	throw new Error(`Invalid extension bundle: ${message}`)
}

function byteLength(value: string): number {
	return Buffer.byteLength(value, "utf8")
}

function isWellFormedUnicode(value: string): boolean {
	return !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(value)
}

function sha256(value: Uint8Array | string): string {
	return createHash("sha256").update(value).digest("hex")
}

function canonical(value: unknown): string {
	if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value)
	if (typeof value === "number") {
		if (!Number.isFinite(value)) fail("manifest contains a non-finite number")
		return JSON.stringify(value)
	}
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`
	if (!plainObject(value)) fail("manifest contains a non-JSON value")
	return `{${Object.keys(value).sort(compareText).map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`
}

function compareText(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0
}

function validateSchema(value: unknown, context: { nodes: number }, depth = 0): Record<string, unknown> {
	if (!plainObject(value)) fail("inputSchema must be a JSON Schema object")
	if (depth > EXTENSION_MAX_SCHEMA_DEPTH || ++context.nodes > EXTENSION_MAX_SCHEMA_NODES) fail("inputSchema exceeds schema complexity limits")
	for (const key of Object.keys(value)) if (!SCHEMA_KEYS.has(key)) fail(`inputSchema contains unsupported keyword ${JSON.stringify(key)}`)
	if (value.$ref !== undefined && typeof value.$ref !== "string") fail("inputSchema $ref must be a string")
	if (typeof value.$ref === "string" && !value.$ref.startsWith("#")) fail("inputSchema $ref must be a local reference")
	if (value.$schema !== undefined && value.$schema !== "https://json-schema.org/draft/2020-12/schema") fail("inputSchema $schema must be JSON Schema 2020-12")
	if (value.$id !== undefined && (typeof value.$id !== "string" || /^(?:[a-z]+:|\/\/)/i.test(value.$id))) fail("inputSchema $id must be a local identifier")
	if (value.type !== undefined) {
		const types = Array.isArray(value.type) ? value.type : [value.type]
		if (types.length === 0 || types.some((type) => !["object", "array", "string", "number", "integer", "boolean", "null"].includes(String(type)))) fail("inputSchema type is unsupported")
	}
	for (const key of ["title", "description", "pattern", "format"]) {
		if (value[key] !== undefined && (typeof value[key] !== "string" || value[key].length > 4096)) fail(`inputSchema ${key} must be a string of at most 4096 characters`)
	}
	if (typeof value.pattern === "string") {
		try { new RegExp(value.pattern) } catch { fail("inputSchema pattern must be a valid regular expression") }
	}
	for (const key of ["minItems", "maxItems", "minLength", "maxLength", "minProperties", "maxProperties"]) {
		if (value[key] !== undefined && (!Number.isSafeInteger(value[key]) || (value[key] as number) < 0 || (value[key] as number) > 1_000_000)) fail(`inputSchema ${key} must be a bounded nonnegative integer`)
	}
	for (const key of ["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf"]) {
		if (value[key] !== undefined && (typeof value[key] !== "number" || !Number.isFinite(value[key]))) fail(`inputSchema ${key} must be finite`)
	}
	if (value.multipleOf !== undefined && (value.multipleOf as number) <= 0) fail("inputSchema multipleOf must be positive")
	if (value.required !== undefined && (!Array.isArray(value.required) || value.required.some((item) => typeof item !== "string" || item.length > 256))) fail("inputSchema required must be an array of property names")
	if (Array.isArray(value.required) && new Set(value.required).size !== value.required.length) fail("inputSchema required cannot contain duplicate names")
	if (value.enum !== undefined && (!Array.isArray(value.enum) || value.enum.length > 256)) fail("inputSchema enum must contain at most 256 values")
	if (value.examples !== undefined && (!Array.isArray(value.examples) || value.examples.length > 32)) fail("inputSchema examples must contain at most 32 values")
	if (value.additionalProperties !== undefined && typeof value.additionalProperties !== "boolean" && !plainObject(value.additionalProperties)) fail("inputSchema additionalProperties must be boolean or a schema")
	if (value.properties !== undefined && !plainObject(value.properties)) fail("inputSchema properties must be an object")
	for (const key of ["properties", "$defs", "definitions"]) {
		if (value[key] !== undefined) {
			const children = value[key]
			if (!plainObject(children) || Object.keys(children).length > 256) fail(`inputSchema ${key} must be an object with at most 256 entries`)
			for (const [name, child] of Object.entries(children)) {
				if (name === "__proto__" || name === "constructor" || name === "prototype") fail(`inputSchema ${key} contains a reserved key`)
				validateSchema(child, context, depth + 1)
			}
		}
	}
	if (value.items !== undefined) validateSchema(value.items, context, depth + 1)
	if (value.additionalProperties && typeof value.additionalProperties === "object") validateSchema(value.additionalProperties, context, depth + 1)
	for (const key of ["allOf", "anyOf", "oneOf"]) {
		if (value[key] !== undefined) {
			if (!Array.isArray(value[key]) || value[key].length < 1 || value[key].length > 32) fail(`inputSchema ${key} must contain 1 to 32 schemas`)
			for (const child of value[key] as unknown[]) validateSchema(child, context, depth + 1)
		}
	}
	if (value.not !== undefined) validateSchema(value.not, context, depth + 1)
	for (const key of ["default", "examples", "enum", "const"]) if (value[key] !== undefined) validateJsonData(value[key], { nodes: 0 }, depth + 1)
	return value
}

function validateJsonData(value: unknown, context: { nodes: number }, depth = 0): void {
	if (depth > EXTENSION_MAX_SCHEMA_DEPTH || ++context.nodes > EXTENSION_MAX_SCHEMA_NODES) fail("inputSchema data exceeds complexity limits")
	if (value === null || typeof value === "boolean") return
	if (typeof value === "string") {
		if (!isWellFormedUnicode(value) || byteLength(value) > EXTENSION_MAX_FILE_BYTES) fail("inputSchema contains invalid or oversized text")
		return
	}
	if (typeof value === "number") {
		if (!Number.isFinite(value)) fail("inputSchema contains a non-finite number")
		return
	}
	if (Array.isArray(value)) {
		if (value.length > 256) fail("inputSchema data array exceeds 256 entries")
		for (const item of value) validateJsonData(item, context, depth + 1)
		return
	}
	if (!plainObject(value) || Object.keys(value).length > 256) fail("inputSchema contains non-JSON data")
	for (const [key, item] of Object.entries(value)) {
		if (key === "__proto__" || key === "constructor" || key === "prototype") fail("inputSchema contains a reserved data key")
		validateJsonData(item, context, depth + 1)
	}
}

function validRelativeFile(file: string): boolean {
	if (file.length === 0 || file.length > 512 || file.includes("\\") || /[\u0000-\u001f\u007f]/.test(file) || !isWellFormedUnicode(file) || file.startsWith("/")) return false
	if (file.startsWith("~") || /^[A-Za-z]:/.test(file)) return false
	const parts = file.split("/")
	return parts.length <= 9 && parts.every((part) => part !== "" && part !== "." && part !== ".." && !part.startsWith(".")) && file !== "manifest.json"
}

function validateManifest(raw: unknown): ExtensionManifest {
	if (!plainObject(raw)) fail("manifest must be an object")
	for (const key of Object.keys(raw)) if (!MANIFEST_KEYS.has(key)) fail(`manifest contains unsupported field ${JSON.stringify(key)}`)
	if (raw.schemaVersion !== 1) fail("schemaVersion must be 1")
	if (typeof raw.id !== "string" || !EXTENSION_ID.test(raw.id)) fail("id must be 1 to 64 lowercase letters, digits, and hyphens, without leading or trailing hyphen")
	if (raw.kind !== "skill" && raw.kind !== "tool" && raw.kind !== "mcp") fail("kind must be skill, tool, or mcp")
	if (typeof raw.description !== "string" || raw.description.trim().length === 0 || raw.description.length > 1024 || /[\u0000-\u001f\u007f]/.test(raw.description)) fail("description must contain 1 to 1024 printable characters")
	if (raw.entrypoint !== undefined && (typeof raw.entrypoint !== "string" || !validRelativeFile(raw.entrypoint))) fail("entrypoint must name a safe relative bundle file")
	if (raw.inputSchema !== undefined) validateSchema(raw.inputSchema, { nodes: 0 })
	if (raw.kind === "skill") {
		if (raw.entrypoint !== undefined || raw.inputSchema !== undefined) fail("skill manifests cannot declare entrypoint or inputSchema")
	} else {
		if (typeof raw.entrypoint !== "string") fail(`${raw.kind} manifests require an entrypoint`)
		if (raw.kind === "tool" && raw.inputSchema === undefined) fail("tool manifests require inputSchema")
		if (raw.kind === "mcp" && raw.inputSchema !== undefined) fail("mcp manifests cannot declare inputSchema")
	}
	return structuredClone(raw) as unknown as ExtensionManifest
}

function validateSkillFile(content: string): void {
	const match = content.match(/^---\s*\r?\n([\s\S]*?)\r?\n---(?:\s*\r?\n|$)/)
	if (!match) fail("skill bundles require SKILL.md with YAML frontmatter")
	let frontmatter: unknown
	try { frontmatter = yaml.parse(match[1] ?? "", { uniqueKeys: true }) } catch { fail("SKILL.md frontmatter must be valid YAML") }
	if (!plainObject(frontmatter) || typeof frontmatter.name !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(frontmatter.name) || frontmatter.name.length > 64 || typeof frontmatter.description !== "string" || frontmatter.description.trim().length === 0 || frontmatter.description.length > 1024) {
		fail("SKILL.md frontmatter requires a valid name and description")
	}
}

export function validateExtensionBundle(bundle: unknown): ExtensionBundle {
	if (!plainObject(bundle) || Object.keys(bundle).length !== 2 || !Object.hasOwn(bundle, "manifest") || !Object.hasOwn(bundle, "files")) fail("bundle must contain only manifest and files")
	const manifest = validateManifest(bundle.manifest)
	const manifestBytes = byteLength(canonical(manifest))
	if (manifestBytes > EXTENSION_MAX_MANIFEST_BYTES) fail(`manifest exceeds ${EXTENSION_MAX_MANIFEST_BYTES} bytes`)
	if (!plainObject(bundle.files)) fail("files must be a map of relative paths to UTF-8 text")
	const entries = Object.entries(bundle.files)
	if (entries.length === 0 || entries.length > EXTENSION_MAX_FILES) fail(`files must contain 1 to ${EXTENSION_MAX_FILES} entries`)
	const files: Record<string, string> = Object.create(null) as Record<string, string>
	let totalBytes = manifestBytes
	for (const [name, content] of entries) {
		if (!validRelativeFile(name)) fail(`unsafe file path ${JSON.stringify(name)}`)
		const nameBytes = byteLength(name)
		if (nameBytes > 512) fail("file paths must be at most 512 UTF-8 bytes")
		if (typeof content !== "string") fail(`file ${JSON.stringify(name)} must be text`)
		const size = byteLength(content)
		if (size > EXTENSION_MAX_FILE_BYTES) fail(`file ${JSON.stringify(name)} exceeds ${EXTENSION_MAX_FILE_BYTES} bytes`)
		totalBytes += size + nameBytes
		if (totalBytes > EXTENSION_MAX_TOTAL_BYTES) fail(`bundle exceeds ${EXTENSION_MAX_TOTAL_BYTES} total bytes`)
		if (content.includes("\0") || !isWellFormedUnicode(content)) fail(`file ${JSON.stringify(name)} contains unsupported text characters`)
		files[name] = content
	}
	for (const name of Object.keys(files)) {
		const parts = name.split("/")
		for (let index = 1; index < parts.length; index++) {
			if (Object.hasOwn(files, parts.slice(0, index).join("/"))) fail("a file path cannot also be a directory path")
		}
	}
	if (manifest.entrypoint && !Object.hasOwn(files, manifest.entrypoint)) fail("entrypoint must exist in files")
	if (manifest.kind === "skill") {
		if (!Object.hasOwn(files, "SKILL.md")) fail("skill bundles require SKILL.md")
		validateSkillFile(files["SKILL.md"] ?? "")
	}
	if (manifest.kind === "tool" || manifest.kind === "mcp") {
		const ext = path.extname(manifest.entrypoint ?? "").toLowerCase()
		if (ext !== ".js" && ext !== ".mjs" && ext !== ".cjs") fail("Node entrypoints must use .js, .mjs, or .cjs")
		if (Object.keys(files).some((file) => path.posix.basename(file) === "package.json" || file.endsWith(".node"))) fail("dependency manifests and native binaries are not supported")
	}
	return { manifest, files }
}

function bundleDigest(bundle: ExtensionBundle): string {
	const manifest = canonical(bundle.manifest)
	const files = Object.entries(bundle.files).sort(([a], [b]) => compareText(a, b)).map(([name, contents]) => `${JSON.stringify(name)}:${JSON.stringify(contents)}`).join(",")
	return sha256(`headlesscode-extension-v1\n${manifest}\n{${files}}`)
}

export function extensionBundleDigest(rawBundle: unknown): string {
	return bundleDigest(validateExtensionBundle(rawBundle))
}

export function extensionRoot(workspaceRoot: string): string {
	if (typeof workspaceRoot !== "string" || workspaceRoot.length === 0 || !path.isAbsolute(workspaceRoot)) throw new Error("workspaceRoot must be an absolute path")
	return path.join(path.resolve(workspaceRoot), ".agents", "headlesscode", "extensions")
}

async function assertNoSymlinkAncestors(target: string): Promise<void> {
	const absolute = path.resolve(target)
	const parsed = path.parse(absolute)
	let current = parsed.root
	for (const component of absolute.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
		current = path.join(current, component)
		try {
			const stat = await fs.lstat(current)
			if (stat.isSymbolicLink()) throw new Error(`symlink path component is not allowed: ${current}`)
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return
			throw error
		}
	}
}

async function readRegularFile(file: string, maxBytes: number): Promise<string> {
	const handle = await fs.open(file, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0))
	try {
		const before = await handle.stat({ bigint: true })
		if (!before.isFile() || before.size > BigInt(maxBytes)) throw new Error(`extension file exceeds ${maxBytes} bytes or is not a regular file`)
		const buffer = Buffer.alloc(Number(before.size))
		let offset = 0
		while (offset < buffer.length) {
			const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset)
			if (!bytesRead) throw new Error("extension file changed while being read")
			offset += bytesRead
		}
		const after = await handle.stat({ bigint: true })
		if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) throw new Error("extension file changed while being read")
		return new TextDecoder("utf-8", { fatal: true }).decode(buffer)
	} finally {
		await handle.close()
	}
}

function revisionFrom(bundle: ExtensionBundle, digest: string, directory: string, workspaceRoot: string): ExtensionRevision {
	const freezeDeep = <T>(value: T): T => {
		if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
			for (const child of Object.values(value as Record<string, unknown>)) freezeDeep(child)
			Object.freeze(value)
		}
		return value
	}
	return Object.freeze({
		manifest: freezeDeep(structuredClone(bundle.manifest)),
		files: Object.freeze({ ...bundle.files }),
		digest,
		directory,
		workspaceRoot: path.resolve(workspaceRoot),
	})
}

async function loadDirectory(workspaceRoot: string, id: string, digest: string): Promise<ExtensionRevision> {
	if (!EXTENSION_ID.test(id) || !SHA256.test(digest)) throw new Error("extension id or digest has an invalid format")
	const directory = path.join(extensionRoot(workspaceRoot), id, digest)
	await assertNoSymlinkAncestors(directory)
	const dirStat = await fs.lstat(directory)
	if (dirStat.isSymbolicLink() || !dirStat.isDirectory()) throw new Error("extension revision must be a real directory")
	const manifestText = await readRegularFile(path.join(directory, "manifest.json"), EXTENSION_MAX_MANIFEST_BYTES)
	let manifest: unknown
	try { manifest = JSON.parse(manifestText) } catch { throw new Error("extension manifest is not valid JSON") }
	const revisionManifest = validateManifest(manifest)
	if (revisionManifest.id !== id) throw new Error("extension manifest id does not match its directory")
	const files: Record<string, string> = Object.create(null) as Record<string, string>
	let seen = 0
	const visit = async (current: string, relative: string, depth: number): Promise<void> => {
		if (depth > 8) throw new Error("extension revision exceeds maximum directory nesting")
		await assertNoSymlinkAncestors(current)
		const directoryStat = await fs.lstat(current)
		if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory()) throw new Error("extension revision contains an unsupported directory")
		const entries = await fs.opendir(current)
		for await (const entry of entries) {
			if (++seen > EXTENSION_MAX_FILES * 9 + 1) throw new Error("extension revision has too many directory entries")
			if (relative === "" && entry.name === "manifest.json") continue
			const rel = relative === "" ? entry.name : `${relative}/${entry.name}`
			const fullPath = path.join(current, entry.name)
			if (entry.isSymbolicLink()) throw new Error("extension revision contains a symlink")
			if (entry.isDirectory()) {
				if (entry.name.startsWith(".")) throw new Error("extension revision contains an unsupported directory")
				await visit(fullPath, rel, depth + 1)
				continue
			}
			if (!entry.isFile() || !validRelativeFile(rel)) throw new Error("extension revision contains an unsupported entry")
			if (Object.keys(files).length >= EXTENSION_MAX_FILES) throw new Error("extension revision has too many files")
			files[rel] = await readRegularFile(fullPath, EXTENSION_MAX_FILE_BYTES)
		}
	}
	await visit(directory, "", 0)
	const bundle = validateExtensionBundle({ manifest: revisionManifest, files })
	const actual = bundleDigest(bundle)
	if (actual !== digest) throw new Error("extension revision digest does not match its contents")
	return revisionFrom(bundle, digest, directory, workspaceRoot)
}

export async function loadExtension(workspaceRoot: string, id: string, digest: string): Promise<ExtensionRevision> {
	return loadDirectory(workspaceRoot, id, digest)
}

export async function listExtensions(workspaceRoot: string): Promise<ExtensionSummary[]> {
	const root = extensionRoot(workspaceRoot)
	await assertNoSymlinkAncestors(root)
	let rootStat: Awaited<ReturnType<typeof fs.lstat>>
	try { rootStat = await fs.lstat(root) } catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return []
		throw error
	}
	if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) throw new Error("extension root must be a real directory")
	const result: ExtensionSummary[] = []
	const ids = await fs.opendir(root)
	let idCount = 0
	for await (const idEntry of ids) {
		if (++idCount > 128) throw new Error("extension registry contains too many extension ids")
		if (idEntry.isSymbolicLink() || !idEntry.isDirectory() || !EXTENSION_ID.test(idEntry.name)) continue
		const idDir = path.join(root, idEntry.name)
		const digests = await fs.opendir(idDir)
		let digestCount = 0
		for await (const digestEntry of digests) {
			if (++digestCount > 32) throw new Error(`extension ${idEntry.name} has too many revisions`)
			if (!digestEntry.isDirectory() || digestEntry.isSymbolicLink() || !SHA256.test(digestEntry.name)) continue
			const revision = await loadDirectory(workspaceRoot, idEntry.name, digestEntry.name)
			result.push(Object.freeze({ manifest: revision.manifest, digest: revision.digest, directory: revision.directory, workspaceRoot: revision.workspaceRoot }))
		}
	}
	return result.sort((a, b) => compareText(a.manifest.id, b.manifest.id) || compareText(a.digest, b.digest))
}

export async function createExtension(workspaceRoot: string, rawBundle: unknown, options: CreateExtensionOptions): Promise<ExtensionRevision> {
	if (!options || typeof options.authorizeWrite !== "function") throw new Error("createExtension requires an authorization callback")
	const bundle = validateExtensionBundle(rawBundle)
	const root = extensionRoot(workspaceRoot)
	const idDirectory = path.join(root, bundle.manifest.id)
	const digest = bundleDigest(bundle)
	const finalDirectory = path.join(idDirectory, digest)
	const stageDirectory = path.join(idDirectory, `.staging-${randomUUID()}`)
	const destinations = [path.join(workspaceRoot, ".agents"), path.join(workspaceRoot, ".agents", "headlesscode"), root, idDirectory, stageDirectory, finalDirectory, path.join(stageDirectory, "manifest.json"), path.join(finalDirectory, "manifest.json")]
	for (const file of Object.keys(bundle.files)) {
		const parts = file.split("/")
		for (let i = 1; i < parts.length; i++) {
			destinations.push(path.join(stageDirectory, ...parts.slice(0, i)))
			destinations.push(path.join(finalDirectory, ...parts.slice(0, i)))
		}
		destinations.push(path.join(stageDirectory, ...parts))
		destinations.push(path.join(finalDirectory, ...parts))
	}
	const uniqueDestinations = [...new Set(destinations)]
	for (const destination of uniqueDestinations) {
		if (!await options.authorizeWrite(destination)) throw new Error(`extension write authorization denied for ${destination}`)
	}
	await assertNoSymlinkAncestors(root)
	await fs.mkdir(root, { recursive: true, mode: 0o700 })
	await assertNoSymlinkAncestors(idDirectory)
	await fs.mkdir(idDirectory, { recursive: true, mode: 0o700 })
	let exists = false
	try { await fs.lstat(finalDirectory); exists = true } catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
	}
	if (exists) return loadDirectory(workspaceRoot, bundle.manifest.id, digest)
	await assertNoSymlinkAncestors(idDirectory)
	await fs.mkdir(stageDirectory, { mode: 0o700 })
	try {
		await fs.writeFile(path.join(stageDirectory, "manifest.json"), `${canonical(bundle.manifest)}\n`, { flag: "wx", mode: 0o600 })
		for (const [file, contents] of Object.entries(bundle.files)) {
			const destination = path.join(stageDirectory, ...file.split("/"))
			await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 })
			await fs.writeFile(destination, contents, { flag: "wx", mode: 0o600 })
		}
		await assertNoSymlinkAncestors(stageDirectory)
		try {
			await fs.rename(stageDirectory, finalDirectory)
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST" && (error as NodeJS.ErrnoException).code !== "ENOTEMPTY") throw error
			return await loadDirectory(workspaceRoot, bundle.manifest.id, digest)
		}
	} finally {
		await fs.rm(stageDirectory, { recursive: true, force: true }).catch(() => undefined)
	}
	return loadDirectory(workspaceRoot, bundle.manifest.id, digest)
}
