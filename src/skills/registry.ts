import { createHash } from "node:crypto"
import { constants as fsConstants } from "node:fs"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import * as yaml from "yaml"

import { projectStoreRoot } from "../project-store.js"

export const MAX_SKILL_FILE_BYTES = 64 * 1024
export const MAX_SKILL_SNAPSHOT_BYTES = 512 * 1024
export const MAX_SKILL_REFERENCE_CHARS = 20_000
export const MAX_DISCOVERED_SKILLS = 128
export const MAX_SKILL_ROOTS = 128
export const MAX_REGISTRY_SNAPSHOT_BYTES = 4 * 1024 * 1024
export const MAX_SKILL_DIRECTORY_ENTRIES = 512

export type SkillSource = "headlesscode" | "agents" | "enabled"

export interface SkillCatalogItem {
	name: string
	description: string
	source: SkillSource
	path: string
	digest: string
}

export interface SkillProblem {
	path: string
	message: string
}

export interface SkillSnapshot extends SkillCatalogItem {
	instructions: string
}

export interface SkillRegistry {
	readonly skills: readonly SkillSnapshot[]
	readonly problems: readonly SkillProblem[]
	get(name: string): SkillSnapshot | undefined
	activate(name: string): SkillSnapshot | undefined
	readReference(name: string, relativePath: string): string
}

export interface DiscoverSkillOptions {
	enabledRoots?: readonly string[]
	includeProjectRoot?: boolean
	/** Include `~/.agents/skills` unless disabled. Tests can inject a safe root. */
	includeUserRoots?: boolean
	userRoot?: string
}

interface RootSpec {
	path: string
	source: SkillSource
}

function sha256(value: string): string {
	return createHash("sha256").update(value).digest("hex")
}

export function skillFilesDigest(files: ReadonlyMap<string, string>): string {
	return sha256([...files].sort(([a], [b]) => a.localeCompare(b)).map(([name, body]) => `${name}\0${sha256(body)}`).join("\0"))
}

function isWithin(parent: string, child: string): boolean {
	const relative = path.relative(parent, child)
	return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
}

export function parseSkillManifest(raw: string): { name: string; description: string; body: string } {
	const match = raw.match(/^---\s*\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)([\s\S]*)$/)
	if (!match) throw new Error("SKILL.md must start with YAML frontmatter delimited by ---")
	const data: unknown = yaml.parse(match[1] ?? "")
	if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("frontmatter must be a YAML mapping")
	const manifest = data as Record<string, unknown>
	if (typeof manifest.name !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(manifest.name) || manifest.name.length > 64) {
		throw new Error("name must be lowercase letters, numbers, and single hyphens (maximum 64 characters)")
	}
	if (typeof manifest.description !== "string" || manifest.description.trim().length < 1 || manifest.description.length > 1024) {
		throw new Error("description must contain 1 to 1024 characters")
	}
	if (manifest.compatibility !== undefined && (typeof manifest.compatibility !== "string" || manifest.compatibility.length < 1 || manifest.compatibility.length > 500)) {
		throw new Error("compatibility must contain 1 to 500 characters when provided")
	}
	if (manifest.metadata !== undefined) {
		if (typeof manifest.metadata !== "object" || manifest.metadata === null || Array.isArray(manifest.metadata)) throw new Error("metadata must be a mapping of string keys to string values")
		if (Object.entries(manifest.metadata).some(([key, value]) => typeof key !== "string" || typeof value !== "string")) {
			throw new Error("metadata must be a mapping of string keys to string values")
		}
	}
	if (manifest["allowed-tools"] !== undefined && typeof manifest["allowed-tools"] !== "string") throw new Error("allowed-tools must be a string when provided")
	return { name: manifest.name, description: manifest.description.trim(), body: (match[2] ?? "").trim() }
}

async function readTextWithin(file: string, skillDir: string, rootReal: string): Promise<string> {
	await assertNoSymlinkPath(skillDir)
	await assertNoSymlinkPath(file)
	const fileReal = await fs.realpath(file)
	if (!isWithin(rootReal, fileReal) || !isWithin(await fs.realpath(skillDir), fileReal)) throw new Error("file resolves outside the skill directory")
	let handle: fs.FileHandle
	try {
		handle = await fs.open(fileReal, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0))
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ELOOP") throw new Error("symlinked files are not allowed in skill snapshots")
		throw error
	}
	try {
		const before = await handle.stat({ bigint: true })
		if (!before.isFile() || before.size > BigInt(MAX_SKILL_FILE_BYTES)) throw new Error("file exceeds the 64 KiB limit or is not a regular file")
		const chunks: Buffer[] = []
		let total = 0
		while (total <= MAX_SKILL_FILE_BYTES) {
			const buffer = Buffer.alloc(Math.min(8192, MAX_SKILL_FILE_BYTES + 1 - total))
			const { bytesRead } = await handle.read(buffer, 0, buffer.length, total)
			if (bytesRead === 0) break
			chunks.push(buffer.subarray(0, bytesRead))
			total += bytesRead
		}
		if (total > MAX_SKILL_FILE_BYTES) throw new Error("file exceeds the 64 KiB limit")
		const after = await handle.stat({ bigint: true })
		if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs || BigInt(total) !== before.size) {
			throw new Error("file changed while the skill snapshot was being read")
		}
		if ((await fs.realpath(file)) !== fileReal) throw new Error("file path changed while the skill snapshot was being read")
		const data = Buffer.concat(chunks, total)
		if (data.includes(0)) throw new Error("skill files must be UTF-8 text; binary files are unsupported")
		try {
			return new TextDecoder("utf-8", { fatal: true }).decode(data)
		} catch {
			throw new Error("skill files must be UTF-8 text; binary files are unsupported")
		}
	} finally {
		await handle.close()
	}
}

export async function assertNoSymlinkPath(target: string): Promise<void> {
	const absolute = path.resolve(target)
	const parsed = path.parse(absolute)
	const components = absolute.slice(parsed.root.length).split(path.sep).filter(Boolean)
	let current = parsed.root
	for (const component of components) {
		current = path.join(current, component)
		const stat = await fs.lstat(current)
		if (stat.isSymbolicLink()) throw new Error(`symlink path component is not allowed: ${current}`)
	}
}

export async function assertNoSymlinkAncestors(target: string): Promise<void> {
	const absolute = path.resolve(target)
	const parsed = path.parse(absolute)
	const components = absolute.slice(parsed.root.length).split(path.sep).filter(Boolean)
	let current = parsed.root
	for (const component of components) {
		current = path.join(current, component)
		let stat: Awaited<ReturnType<typeof fs.lstat>>
		try {
			stat = await fs.lstat(current)
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return
			throw error
		}
		if (stat.isSymbolicLink()) throw new Error(`symlink path component is not allowed: ${current}`)
	}
}

export async function snapshotSkillFiles(
	skillDir: string,
	rootReal: string,
	onDiagnostic?: (problem: SkillProblem) => void,
): Promise<Map<string, string>> {
	const files = new Map<string, string>()
	let totalBytes = 0
	let count = 0
	let entriesSeen = 0
	const diagnostics: SkillProblem[] = []
	const visit = async (dir: string, relative: string, depth: number): Promise<void> => {
		if (depth > 8) throw new Error("skill directory exceeds maximum nesting depth")
		await assertNoSymlinkPath(dir)
		const directory = await fs.opendir(dir)
		for await (const entry of directory) {
			if (++entriesSeen > MAX_SKILL_DIRECTORY_ENTRIES) throw new Error(`skill exceeds ${MAX_SKILL_DIRECTORY_ENTRIES} directory entries`)
			const child = path.join(dir, entry.name)
			const rel = path.posix.join(relative, entry.name)
			if (entry.isSymbolicLink()) throw new Error(`symlinks are not allowed in skill snapshots: ${rel}`)
			if (entry.isDirectory()) {
				await visit(child, rel, depth + 1)
				continue
			}
			if (!entry.isFile()) continue
			if (++count > 200) throw new Error("skill contains more than 200 files")
			let content: string
			try {
				content = await readTextWithin(child, skillDir, rootReal)
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error)
				if (rel !== "SKILL.md" && (message.includes("64 KiB") || message.includes("binary files are unsupported"))) {
					diagnostics.push({ path: child, message: `${message}; optional resource excluded from this snapshot` })
					continue
				}
				throw error
			}
			totalBytes += Buffer.byteLength(content, "utf-8")
			if (totalBytes > MAX_SKILL_SNAPSHOT_BYTES) throw new Error("skill snapshot exceeds 512 KiB")
			files.set(rel, content)
		}
	}
	await visit(skillDir, "", 0)
	for (const diagnostic of diagnostics) onDiagnostic?.(diagnostic)
	return files
}

async function listSkillDirectories(root: string, problems: SkillProblem[]): Promise<string[]> {
	try {
		const rootStat = await fs.lstat(root)
		if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
			problems.push({ path: root, message: "skill root must be a real directory, not a symlink" })
			return []
		}
		const result: string[] = []
		const directory = await fs.opendir(root)
		let count = 0
		for await (const entry of directory) {
			if (++count > MAX_SKILL_DIRECTORY_ENTRIES) {
				problems.push({ path: root, message: `root contains more than ${MAX_SKILL_DIRECTORY_ENTRIES} entries; skipped to keep discovery bounded` })
				return []
			}
			if (entry.isSymbolicLink()) {
				problems.push({ path: path.join(root, entry.name), message: "skill directories cannot be symlinks" })
			} else if (entry.isDirectory()) result.push(path.join(root, entry.name))
		}
		return result.sort((a, b) => a.localeCompare(b))
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") problems.push({ path: root, message: String(error) })
		return []
	}
}

export function defaultSkillRoots(workspaceRoot: string, options: DiscoverSkillOptions = {}): RootSpec[] {
	const roots: RootSpec[] = []
	if (options.includeProjectRoot) roots.push({ path: path.join(workspaceRoot, ".agents", "skills"), source: "enabled" })
	for (const root of options.enabledRoots ?? []) roots.push({ path: path.resolve(root), source: "enabled" })
	roots.push({ path: path.join(projectStoreRoot(), "skills"), source: "headlesscode" })
	if (options.includeUserRoots !== false) {
		roots.push({ path: options.userRoot ?? path.join(os.homedir(), ".agents", "skills"), source: "agents" })
	}
	return roots
}

function snapshotProblemPath(
	skillDir: string,
	manifestPath: string,
	message: string,
): string {
	// snapshotSkillFiles reports oversized or binary companions as
	// diagnostics, so a thrown size or binary error is SKILL.md itself.
	if (
		message.includes("64 KiB")
		|| message.includes("binary files are unsupported")
	) {
		return manifestPath
	}
	return skillDir
}

/** Discover once and capture every skill file so a running session cannot see mid-turn edits. */
export async function discoverSkills(workspaceRoot: string, options: DiscoverSkillOptions = {}): Promise<SkillRegistry> {
	const problems: SkillProblem[] = []
	const selected = new Map<string, SkillSnapshot>()
	const referenceFiles = new Map<string, ReadonlyMap<string, string>>()
	let registryBytes = 0
	const requestedRoots = defaultSkillRoots(path.resolve(workspaceRoot), options)
	const roots = requestedRoots.slice(0, MAX_SKILL_ROOTS)
	if (requestedRoots.length > roots.length) {
		problems.push({ path: "<skill roots>", message: `discovery limited to the first ${MAX_SKILL_ROOTS} skill roots` })
	}
	const seenRoots = new Set<string>()
	rootLoop: for (const root of roots) {
		let rootReal: string
		try {
			await assertNoSymlinkPath(root.path)
			const rootStat = await fs.lstat(root.path)
			if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
				problems.push({ path: root.path, message: "skill root must be a real directory, not a symlink" })
				continue
			}
			rootReal = await fs.realpath(root.path)
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") problems.push({ path: root.path, message: String(error) })
			continue
		}
		if (seenRoots.has(rootReal)) continue
		seenRoots.add(rootReal)
		for (const skillDir of await listSkillDirectories(root.path, problems)) {
			if (selected.size >= MAX_DISCOVERED_SKILLS) {
				problems.push({ path: root.path, message: `discovery stopped at ${MAX_DISCOVERED_SKILLS} skills` })
				break rootLoop
			}
			const manifestPath = path.join(skillDir, "SKILL.md")
			let snapshotTaken = false
			try {
				const files = await snapshotSkillFiles(skillDir, rootReal, (problem) => problems.push(problem))
				snapshotTaken = true
				const raw = files.get("SKILL.md")
				if (raw === undefined) throw new Error("SKILL.md is missing from the captured skill snapshot")
				parseSkillManifest(raw)
				const snapshotBytes = [...files.values()].reduce((size, content) => size + Buffer.byteLength(content, "utf-8"), 0)
				if (registryBytes + snapshotBytes > MAX_REGISTRY_SNAPSHOT_BYTES) {
					problems.push({ path: skillDir, message: "registry snapshot would exceed 4 MiB" })
					continue
				}
				const pinnedManifest = files.get("SKILL.md")
				if (pinnedManifest === undefined) throw new Error("SKILL.md was not captured")
				const pinned = parseSkillManifest(pinnedManifest)
				if (path.basename(skillDir) !== pinned.name) {
					problems.push({
						path: skillDir,
						message: `directory name must match manifest name '${pinned.name}'`,
					})
					continue
				}
				const digest = skillFilesDigest(files)
				const item: SkillSnapshot = Object.freeze({
					name: pinned.name,
					description: pinned.description,
					source: root.source,
					path: skillDir,
					digest,
					instructions: pinned.body,
				})
				const prior = selected.get(item.name)
				if (prior) {
					problems.push({ path: skillDir, message: `duplicate skill '${item.name}' ignored; selected ${prior.path}` })
					continue
				}
				selected.set(item.name, item)
				referenceFiles.set(item.name, new Map(files))
				registryBytes += snapshotBytes
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
					const message = error instanceof Error
						? error.message
						: String(error)
					const target = snapshotTaken
						? manifestPath
						: snapshotProblemPath(skillDir, manifestPath, message)
					problems.push({ path: target, message })
				}
			}
		}
	}
	const skills = [...selected.values()].sort((a, b) => a.name.localeCompare(b.name))
	const byName = new Map(skills.map((skill) => [skill.name, skill]))
	return Object.freeze({
		skills: Object.freeze(skills),
		problems: Object.freeze(problems),
		get: (name: string) => byName.get(name),
		activate: (name: string) => byName.get(name),
		readReference: (name: string, relativePath: string) => {
			const skill = byName.get(name)
			if (!skill) throw new Error(`unknown skill '${name}'`)
			if (typeof relativePath !== "string" || !relativePath || path.posix.isAbsolute(relativePath) || path.win32.isAbsolute(relativePath)) {
				throw new Error("reference path must be relative to the selected skill directory")
			}
			const normalized = path.posix.normalize(relativePath.replaceAll("\\", "/"))
			if (normalized === ".." || normalized.startsWith("../") || normalized.includes("\0")) throw new Error("reference path escapes the selected skill directory")
			const content = referenceFiles.get(name)?.get(normalized)
			if (content === undefined) throw new Error(`reference '${relativePath}' is not present in the pinned skill snapshot`)
			return content.length > MAX_SKILL_REFERENCE_CHARS ? `${content.slice(0, MAX_SKILL_REFERENCE_CHARS)}\n[reference truncated at ${MAX_SKILL_REFERENCE_CHARS} characters]` : content
		},
	})
}
