import assert from "node:assert/strict"
import * as fs from "node:fs/promises"
import * as path from "node:path"

import {
	createExtension,
	extensionBundleDigest,
	extensionRegistryTestHooks,
	extensionRoot,
	listExtensions,
	loadExtension,
	validateExtensionBundle,
	type ExtensionBundle,
	type ExtensionManifest,
} from "../registry.js"

const scratchRoot = path.join(process.cwd(), ".headlesscode", "scratch")
const allow = async (_destination: string): Promise<boolean> => true

function toolBundle(id = "json-helper"): ExtensionBundle {
	return {
		manifest: {
			schemaVersion: 1,
			id,
			kind: "tool",
			description: "Formats a JSON value",
			entrypoint: "src/index.mjs",
			inputSchema: {
				$schema: "https://json-schema.org/draft/2020-12/schema",
				type: "object",
				properties: { value: { type: ["string", "number", "boolean", "null"] } },
				required: ["value"],
				additionalProperties: false,
			},
		},
		files: { "src/index.mjs": "export async function run(input) { return input }\n", "README.md": "Local reference data.\n" },
	}
}

function manifest(kind: ExtensionManifest["kind"], id: string): ExtensionManifest {
	if (kind === "skill") return { schemaVersion: 1, id, kind, description: "A project skill" }
	if (kind === "mcp") return { schemaVersion: 1, id, kind, description: "A local stdio MCP server", entrypoint: "server.mjs" }
	return toolBundle(id).manifest
}

async function rejects(operation: () => Promise<unknown>, pattern: RegExp): Promise<void> {
	await assert.rejects(operation, pattern)
}

async function validKindsRoundTripAndListMetadataOnly(): Promise<void> {
	await fs.mkdir(scratchRoot, { recursive: true, mode: 0o700 })
	const root = await fs.mkdtemp(path.join(scratchRoot, "extension-registry-roundtrip-"))
	try {
		const tool = toolBundle()
		const authorized: string[] = []
		const created = await createExtension(root, tool, { authorizeWrite: async (target) => { authorized.push(target); return true } })
		assert.equal(created.digest, extensionBundleDigest(tool))
		assert.equal(created.directory, path.join(extensionRoot(root), "json-helper", created.digest))
		assert.ok(authorized.includes(path.join(root, ".agents")))
		assert.ok(authorized.includes(path.join(created.directory, "src", "index.mjs")))
		assert.deepEqual(created.files, tool.files)
		assert.equal(Object.isFrozen(created.manifest.inputSchema), true, "nested manifest schema is immutable")
		assert.throws(() => { (created.manifest.inputSchema as Record<string, unknown>).type = "string" }, TypeError)

		const duplicate = await createExtension(root, { manifest: tool.manifest, files: { "README.md": tool.files["README.md"], "src/index.mjs": tool.files["src/index.mjs"] } }, { authorizeWrite: allow })
		assert.equal(duplicate.digest, created.digest, "file insertion order does not affect the canonical digest")
		assert.equal((await fs.readdir(path.dirname(created.directory))).filter((name) => name.startsWith(".staging-")).length, 0)
		assert.deepEqual((await loadExtension(root, "json-helper", created.digest)).files, tool.files)

		const summaries = await listExtensions(root)
		assert.equal(summaries.length, 1)
		assert.equal(summaries[0]?.digest, created.digest)
		assert.equal(Object.hasOwn(summaries[0] ?? {}, "files"), false, "discovery exposes metadata only")

		const skillBundle: ExtensionBundle = {
			manifest: manifest("skill", "review-skill"),
			files: { "SKILL.md": "---\nname: review-skill\ndescription: Reviews a change\n---\nUse the local project rules.\n", "references/checklist.md": "Check tests and changed files.\n" },
		}
		const skill = await createExtension(root, skillBundle, { authorizeWrite: allow })
		assert.equal((await loadExtension(root, skill.manifest.id, skill.digest)).files["SKILL.md"], skillBundle.files["SKILL.md"])

		const mcpBundle: ExtensionBundle = { manifest: manifest("mcp", "local-review-mcp"), files: { "server.mjs": "process.stdin.resume()\n" } }
		const mcp = await createExtension(root, mcpBundle, { authorizeWrite: allow })
		assert.equal((await loadExtension(root, mcp.manifest.id, mcp.digest)).manifest.kind, "mcp")
	} finally {
		await fs.rm(root, { recursive: true, force: true })
	}
}

async function validationFailsBeforeAnyWrite(): Promise<void> {
	await fs.mkdir(scratchRoot, { recursive: true, mode: 0o700 })
	const root = await fs.mkdtemp(path.join(scratchRoot, "extension-registry-invalid-"))
	try {
		const invalid: ExtensionBundle[] = []
		invalid.push({ ...toolBundle(), manifest: { ...toolBundle().manifest, id: "../escape" } })
		invalid.push({ ...toolBundle(), files: { "../escape.mjs": "export function run() {}" } })
		invalid.push({ ...toolBundle(), files: { "src/index.mjs": "x".repeat(64 * 1024 + 1) } })
		invalid.push({ ...toolBundle(), manifest: { ...toolBundle().manifest, surprise: "command" } as ExtensionManifest })
		invalid.push({ ...toolBundle(), manifest: { ...toolBundle().manifest, inputSchema: { type: "object", additionalProperties: { $ref: "https://attacker.invalid/schema" } } } })
		invalid.push({ ...toolBundle(), manifest: { ...toolBundle().manifest, inputSchema: { type: "object", properties: { value: { type: "string", pattern: "[" } } } } })
		invalid.push({ ...toolBundle(), files: { "src/index.mjs": "export const broken = '\ud800'" } })
		invalid.push({ ...toolBundle(), files: { "src/index.mjs": "a".repeat(64 * 1024), "ref.md": "b".repeat(192 * 1024) } })
		invalid.push({ ...toolBundle(), files: { "src/index.mjs": "file", "src/index.mjs/child.txt": "child" } })
		invalid.push({ ...toolBundle(), files: { "src/index.mjs": "file", "a": "file", "a-b": "middle", "a/child.txt": "child" } })
		invalid.push({ ...toolBundle(), files: { "src/index.mjs": "file", "bad\nname": "file" } })
		invalid.push({ ...toolBundle(), files: { "src/index.mjs": "file", ["a/".repeat(9) + "deep.txt"]: "file" } })
		for (const bundle of invalid) await rejects(() => createExtension(root, bundle, { authorizeWrite: allow }), /Invalid extension bundle/)
		const accessorBundle = Object.defineProperties({}, {
			manifest: { enumerable: true, get: () => toolBundle().manifest },
			files: { enumerable: true, value: toolBundle().files },
		})
		assert.throws(() => validateExtensionBundle(accessorBundle), /Invalid extension bundle/)
		assert.equal(await fs.lstat(path.join(root, ".agents")).then(() => true, () => false), false, "invalid bundles do not create registry directories")

		let authorizations = 0
		let deniedSourceFile = false
		await rejects(() => createExtension(root, toolBundle(), { authorizeWrite: (destination) => {
			authorizations++
			if (destination.endsWith(`${path.sep}src${path.sep}index.mjs`)) {
				deniedSourceFile = true
				return false
			}
			return true
		} }), /authorization denied/)
		assert.ok(authorizations > 5 && deniedSourceFile, "nested destinations are individually authorized before writes")
		assert.equal(await fs.lstat(path.join(root, ".agents")).then(() => true, () => false), false, "denied writes leave no partial publication")
	} finally {
		await fs.rm(root, { recursive: true, force: true })
	}
}

async function cancellationPreventsPublicationAndCleansOwnedStage(): Promise<void> {
	await fs.mkdir(scratchRoot, { recursive: true, mode: 0o700 })
	const root = await fs.mkdtemp(path.join(scratchRoot, "extension-registry-cancel-"))
	try {
		const bundle = toolBundle("cancelled-create")
		const preAborted = new AbortController()
		preAborted.abort()
		let authorizationCalls = 0
		await assert.rejects(createExtension(root, bundle, { authorizeWrite: () => { authorizationCalls++; return true }, signal: preAborted.signal }), /cancelled/)
		assert.equal(authorizationCalls, 0, "an already-stopped create performs no authorization or filesystem effects")
		assert.equal(await fs.lstat(path.join(root, ".agents")).then(() => true, () => false), false)

		let reachedStage: () => void = () => undefined
		let releaseStage: () => void = () => undefined
		const stageReady = new Promise<void>((resolve) => { reachedStage = resolve })
		const stageGate = new Promise<void>((resolve) => { releaseStage = resolve })
		extensionRegistryTestHooks.setCreateStageBarrierForTests(async () => { reachedStage(); await stageGate })
		const controller = new AbortController()
		const pending = createExtension(root, bundle, { authorizeWrite: () => true, signal: controller.signal })
		await stageReady
		const idDirectory = path.join(root, ".agents", "headlesscode", "extensions", bundle.manifest.id)
		assert.deepEqual((await fs.readdir(idDirectory)).filter((name) => name.startsWith(".staging-")).length, 1, "the controlled operation has entered its owned staging directory")
		controller.abort()
		releaseStage()
		await assert.rejects(pending, /cancelled/)
		assert.equal(await fs.lstat(path.join(idDirectory, extensionBundleDigest(bundle))).then(() => true, () => false), false, "an aborted staging operation does not publish its revision")
		assert.deepEqual((await fs.readdir(idDirectory)).filter((name) => name.startsWith(".staging-")), [], "cancellation removes only the operation's owned staging directory")
	} finally {
		extensionRegistryTestHooks.setCreateStageBarrierForTests(undefined)
		await fs.rm(root, { recursive: true, force: true })
	}
}

async function concurrentPublicationAndIncompleteRevision(): Promise<void> {
	await fs.mkdir(scratchRoot, { recursive: true, mode: 0o700 })
	const root = await fs.mkdtemp(path.join(scratchRoot, "extension-registry-publish-"))
	try {
		const bundle = toolBundle()
		const revisions = await Promise.all(Array.from({ length: 4 }, () => createExtension(root, bundle, { authorizeWrite: allow })))
		assert.equal(new Set(revisions.map((revision) => revision.digest)).size, 1)
		assert.deepEqual(await fs.readdir(path.dirname(revisions[0]!.directory)), [revisions[0]!.digest], "concurrent idempotent publication cleans every owned staging directory")
		const incompleteBundle = toolBundle("incomplete")
		const incomplete = path.join(extensionRoot(root), "incomplete", extensionBundleDigest(incompleteBundle))
		await fs.mkdir(incomplete, { recursive: true })
		await assert.rejects(createExtension(root, incompleteBundle, { authorizeWrite: allow }), /ENOENT/, "an incomplete existing revision must never be silently replaced")
		assert.deepEqual(await fs.readdir(incomplete), [])
		const nestedFiles: Record<string, string> = { "src/index.mjs": bundle.files["src/index.mjs"]! }
		for (let index = 0; index < 31; index++) nestedFiles[`ref${index}/a/b/c/d/e/f/g/file.txt`] = "reference"
		const nested = await createExtension(root, { ...bundle, manifest: { ...bundle.manifest, id: "nested" }, files: nestedFiles }, { authorizeWrite: allow })
		assert.equal(Object.keys((await loadExtension(root, "nested", nested.digest)).files).length, 32, "all admitted directory layouts must remain loadable")
	} finally {
		await fs.rm(root, { recursive: true, force: true })
	}
}

async function symlinkAndChangedDigestFailClosed(): Promise<void> {
	await fs.mkdir(scratchRoot, { recursive: true, mode: 0o700 })
	const root = await fs.mkdtemp(path.join(scratchRoot, "extension-registry-symlink-"))
	const outside = await fs.mkdtemp(path.join(scratchRoot, "extension-registry-outside-"))
	try {
		await fs.symlink(outside, path.join(root, ".agents"), "dir")
		await rejects(() => createExtension(root, toolBundle(), { authorizeWrite: allow }), /symlink path component/)
		assert.deepEqual(await fs.readdir(outside), [])
	} finally {
		await fs.rm(root, { recursive: true, force: true })
		await fs.rm(outside, { recursive: true, force: true })
	}

	const changedRoot = await fs.mkdtemp(path.join(scratchRoot, "extension-registry-digest-"))
	const symlinkTarget = path.join(scratchRoot, `extension-registry-link-target-${process.pid}.txt`)
	try {
		const revision = await createExtension(changedRoot, toolBundle(), { authorizeWrite: allow })
		await fs.writeFile(symlinkTarget, "external bytes must never be read\n")
		await fs.unlink(path.join(revision.directory, "README.md"))
		await fs.symlink(symlinkTarget, path.join(revision.directory, "README.md"))
		await rejects(() => loadExtension(changedRoot, revision.manifest.id, revision.digest), /symlink/)
		await fs.unlink(path.join(revision.directory, "README.md"))
		await fs.writeFile(path.join(revision.directory, "README.md"), "changed after publication\n")
		await rejects(() => loadExtension(changedRoot, revision.manifest.id, revision.digest), /digest does not match/)
		await rejects(() => listExtensions(changedRoot), /digest does not match/)
	} finally {
		await fs.rm(changedRoot, { recursive: true, force: true })
		await fs.rm(symlinkTarget, { force: true })
	}
}

await validKindsRoundTripAndListMetadataOnly()
await validationFailsBeforeAnyWrite()
await cancellationPreventsPublicationAndCleansOwnedStage()
await symlinkAndChangedDigestFailClosed()
await concurrentPublicationAndIncompleteRevision()
console.log("All extension registry tests passed")
