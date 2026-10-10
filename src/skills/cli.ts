import * as fs from "node:fs/promises"
import * as path from "node:path"
import { randomUUID } from "node:crypto"

import { projectStoreRoot } from "../project-store.js"
import {
	assertNoSymlinkAncestors,
	assertNoSymlinkPath,
	discoverSkills,
	MAX_SKILL_DIRECTORY_ENTRIES,
	parseSkillManifest,
	skillFilesDigest,
	snapshotSkillFiles,
	type DiscoverSkillOptions,
	type SkillProblem,
} from "./registry.js"
import { enableSkillRoot, readEnabledSkillRoots } from "./store.js"

export interface SkillsCliIO {
	workspaceRoot?: string
	/** Discovery overrides for isolated tests and embedding providers. */
	includeUserRoots?: DiscoverSkillOptions["includeUserRoots"]
	userRoot?: DiscoverSkillOptions["userRoot"]
	stdout?: (text: string) => void
	stderr?: (text: string) => void
}

function stripTerminalControls(text: string, preserveLayout: boolean): string {
	const withoutAnsi = text
		.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
		.replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, "")
		.replace(/\u009b[0-?]*[ -/]*[@-~]/g, "")
		.replace(/\u009d[^\u0007]*\u0007/g, "")
	const controls = preserveLayout
		? /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g
		: /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g
	return withoutAnsi.replace(/\r\n?/g, "\n").replace(controls, " ")
}

function safeField(text: string): string {
	return stripTerminalControls(text, false)
}

function safeInstructions(text: string): string {
	return stripTerminalControls(text, true)
}

function output(io: SkillsCliIO, text: string): void {
	(io.stdout ?? ((value) => process.stdout.write(value)))(text)
}

function errorOutput(io: SkillsCliIO, text: string): void {
	(io.stderr ?? ((value) => process.stderr.write(value)))(stripTerminalControls(text, true))
}

const SKILLS_USAGE =
	"usage: headlesscode skills <command>\n" +
	"commands: list, inspect <name>, validate [<local-path>], enable <skill-root>, import <local-skill-directory>\n"

interface InspectedSkill {
	dir: string
	files: Map<string, string>
	name: string
	digest: string
}

async function inspectInput(inputPath: string): Promise<{ skills: InspectedSkill[]; problems: SkillProblem[] }> {
	const resolved = path.resolve(inputPath)
	await assertNoSymlinkPath(resolved)
	const rootStat = await fs.lstat(resolved)
	if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) throw new Error("import source must be a real directory, not a symlink")
	const rootReal = await fs.realpath(resolved)
	const problems: SkillProblem[] = []
	const skills: InspectedSkill[] = []
	let rootHasManifest = false
	try {
		const manifestStat = await fs.lstat(path.join(resolved, "SKILL.md"))
		if (manifestStat.isSymbolicLink() || !manifestStat.isFile()) throw new Error("SKILL.md must be a regular file, not a symlink")
		rootHasManifest = true
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
	}
	let candidates: string[]
	if (rootHasManifest) candidates = [resolved]
	else {
		candidates = []
		const directory = await fs.opendir(resolved)
		let count = 0
		for await (const entry of directory) {
			if (++count > MAX_SKILL_DIRECTORY_ENTRIES) throw new Error(`import source exceeds ${MAX_SKILL_DIRECTORY_ENTRIES} directory entries`)
			if (entry.isSymbolicLink()) problems.push({ path: path.join(resolved, entry.name), message: "symlinked source entries are not imported" })
			else if (entry.isDirectory()) candidates.push(path.join(resolved, entry.name))
		}
		candidates.sort((a, b) => a.localeCompare(b))
	}
	for (const dir of candidates) {
		try {
			const files = await snapshotSkillFiles(dir, rootReal, (problem) => problems.push(problem))
			const raw = files.get("SKILL.md")
			if (raw === undefined) continue
			const manifest = parseSkillManifest(raw)
			if (path.basename(dir) !== manifest.name) throw new Error(`directory name must match manifest name '${manifest.name}'`)
			skills.push({ dir, files, name: manifest.name, digest: skillFilesDigest(files) })
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") problems.push({ path: dir, message: error instanceof Error ? error.message : String(error) })
		}
	}
	return { skills, problems }
}

async function importSkills(inputPath: string): Promise<{ names: string[]; warnings: SkillProblem[] }> {
	const inspected = await inspectInput(inputPath)
	const failures = inspected.problems.filter((problem) => !problem.message.includes("optional resource excluded"))
	if (failures.length > 0) throw new Error(failures.map((problem) => `${safeField(problem.path)}: ${safeField(problem.message)}`).join("\n"))
	const incoming = inspected.skills
	if (incoming.length === 0) throw new Error("no valid SKILL.md manifests found")
	const destinationRoot = path.join(projectStoreRoot(), "skills")
	await assertNoSymlinkAncestors(destinationRoot)
	await fs.mkdir(destinationRoot, { recursive: true })
	await assertNoSymlinkPath(destinationRoot)
	const imported: string[] = []
	for (const skill of incoming) {
		const target = path.join(destinationRoot, skill.name)
		try {
			const targetStat = await fs.lstat(target)
			if (targetStat.isSymbolicLink() || !targetStat.isDirectory()) throw new Error(`existing import destination for '${skill.name}' is not a real directory`)
			const targetReal = await fs.realpath(target)
			if (!targetReal.startsWith(`${await fs.realpath(destinationRoot)}${path.sep}`)) throw new Error("existing import destination resolves outside the skill store")
			const existing = await snapshotSkillFiles(target, await fs.realpath(destinationRoot))
			if (skillFilesDigest(existing) !== skill.digest) throw new Error(`skill '${skill.name}' already exists with different content`)
			imported.push(`${skill.name} (already imported)`)
			continue
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
		}
		const lockPath = path.join(destinationRoot, `.${skill.name}.import.lock`)
		let lock: fs.FileHandle
		try {
			lock = await fs.open(lockPath, "wx", 0o600)
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error(`an import for '${skill.name}' is already in progress`)
			throw error
		}
		const staging = path.join(destinationRoot, `.${skill.name}.${randomUUID()}.importing`)
		try {
			await fs.mkdir(staging, { recursive: false })
			for (const [relative, body] of skill.files) {
				const targetFile = path.resolve(staging, ...relative.split("/"))
				if (!targetFile.startsWith(`${path.resolve(staging)}${path.sep}`)) throw new Error(`unsafe relative path: ${relative}`)
				await fs.mkdir(path.dirname(targetFile), { recursive: true })
				await fs.writeFile(targetFile, body, { mode: 0o600 })
			}
			await fs.rename(staging, target)
			imported.push(skill.name)
		} catch (error) {
			await fs.rm(staging, { recursive: true, force: true })
			throw error
		} finally {
			await lock.close()
			await fs.rm(lockPath, { force: true })
		}
	}
	return { names: imported, warnings: inspected.problems.filter((problem) => problem.message.includes("optional resource excluded")) }
}

export async function runSkillsCli(argv: string[], io: SkillsCliIO = {}): Promise<number> {
	const [command, ...args] = argv
	const workspaceRoot = path.resolve(io.workspaceRoot ?? process.cwd())
	try {
		if (command === "enable") {
			const root = args[0]
			if (!root) throw new Error(`${SKILLS_USAGE}example: headlesscode skills enable .agents/skills`)
			const roots = await enableSkillRoot(path.resolve(workspaceRoot, root))
			output(io, `Enabled skill root: ${safeField(path.resolve(workspaceRoot, root))}\n${roots.length} root(s) enabled.\n`)
			return 0
		}
		if (command === "import") {
			const source = args[0]
			if (!source) throw new Error(`${SKILLS_USAGE}example: headlesscode skills import ./my-skill`)
			const imported = await importSkills(path.resolve(workspaceRoot, source))
			for (const warning of imported.warnings) errorOutput(io, `warning: ${safeField(warning.path)}: ${safeField(warning.message)}\n`)
			output(io, `Imported: ${imported.names.map(safeField).join(", ")}\n`)
			return 0
		}
		if (!command || command === "help" || command === "--help" || command === "-h") {
			output(io, SKILLS_USAGE)
			return 0
		}
		let enabledRoots: string[] = []
		try {
			enabledRoots = await readEnabledSkillRoots()
		} catch (error) {
			errorOutput(io, `warning: enabled roots ignored: ${safeField(error instanceof Error ? error.message : String(error))}\n`)
		}
		const registry = await discoverSkills(workspaceRoot, {
			enabledRoots,
			includeUserRoots: io.includeUserRoots,
			userRoot: io.userRoot,
		})
		if (command === "list") {
			for (const skill of registry.skills) output(io, `${safeField(skill.name)}\t${safeField(skill.description)}\t${safeField(skill.source)}\n`)
			for (const problem of registry.problems) errorOutput(io, `warning: ${safeField(problem.path)}: ${safeField(problem.message)}\n`)
			return 0
		}
		if (command === "inspect") {
			const name = args[0]
			if (!name) throw new Error(`${SKILLS_USAGE}example: headlesscode skills inspect code-review`)
			const skill = registry.get(name)
			if (!skill) throw new Error(`skill '${safeField(name)}' was not found`)
			output(io, `name: ${safeField(skill.name)}\ndescription: ${safeField(skill.description)}\nsource: ${safeField(skill.source)}\npath: ${safeField(skill.path)}\nsha256: ${skill.digest}\n\n${safeInstructions(skill.instructions)}\n`)
			return 0
		}
		if (command === "validate") {
			if (args[0]) {
				const inspected = await inspectInput(path.resolve(workspaceRoot, args[0]))
				for (const skill of inspected.skills) output(io, `valid\t${safeField(skill.name)}\t${safeField(skill.dir)}\n`)
				for (const problem of inspected.problems) errorOutput(io, `${problem.message.includes("optional resource excluded") ? "warning" : "invalid"}: ${safeField(problem.path)}: ${safeField(problem.message)}\n`)
				if (inspected.skills.length === 0 && inspected.problems.length === 0) output(io, "No skills found.\n")
				return inspected.problems.some((problem) => !problem.message.includes("optional resource excluded")) ? 1 : 0
			}
			for (const skill of registry.skills) output(io, `valid\t${safeField(skill.name)}\t${safeField(skill.path)}\n`)
			for (const problem of registry.problems) errorOutput(io, `invalid: ${safeField(problem.path)}: ${safeField(problem.message)}\n`)
			if (registry.skills.length === 0 && registry.problems.length === 0) output(io, "No skills found.\n")
			return registry.problems.length ? 1 : 0
		}
		throw new Error(SKILLS_USAGE)
	} catch (error) {
		errorOutput(io, `skills: ${error instanceof Error ? error.message : String(error)}\n`)
		return 1
	}
}
