import assert from "node:assert/strict"
import * as fs from "node:fs/promises"
import * as path from "node:path"

import { HeadlessSession } from "../../engine/loop.js"
import type { ChatMessage, LlmClient, LlmRequest, LlmResponse } from "../../engine/types.js"
import { createReadOnlyHeadlessExecutor } from "../../tools/executor.js"
import { discoverSkills } from "../registry.js"
import { runSkillsCli } from "../cli.js"
import { readEnabledSkillRoots } from "../store.js"

const scratch = path.join(process.cwd(), ".headlesscode", "scratch")

async function fixtureRoot(): Promise<string> {
	await fs.mkdir(scratch, { recursive: true })
	const root = await fs.mkdtemp(path.join(scratch, `skills-${process.pid}-`))
	const home = path.join(root, "home")
	await fs.mkdir(home, { recursive: true })
	process.env.HOME = home
	process.env.USERPROFILE = home
	process.env.HEADLESSCODE_DATA_DIR = path.join(root, "data")
	return root
}

async function writeSkill(root: string, directory: string, name: string, body: string, extra: Record<string, string> = {}): Promise<string> {
	const dir = path.join(root, directory)
	await fs.mkdir(dir, { recursive: true })
	await fs.writeFile(path.join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: Instructions for ${name}\n---\n${body}\n`)
	for (const [relative, content] of Object.entries(extra)) {
		const target = path.join(dir, ...relative.split("/"))
		await fs.mkdir(path.dirname(target), { recursive: true })
		await fs.writeFile(target, content)
	}
	return dir
}

async function withEnv(name: string, value: string | undefined, run: () => Promise<void>): Promise<void> {
	const prior = process.env[name]
	if (value === undefined) delete process.env[name]
	else process.env[name] = value
	try {
		await run()
	} finally {
		if (prior === undefined) delete process.env[name]
		else process.env[name] = prior
	}
}

async function testValidInvalidManifestAndBoundedReference(): Promise<void> {
	const root = await fixtureRoot()
	try {
		const skills = path.join(root, "skills")
		const dir = await writeSkill(skills, "valid-skill", "valid-skill", "Follow these steps.", {
			"references/guide.md": "A useful reference",
			"references/long.md": "x".repeat(25_000),
		})
		await fs.mkdir(path.join(skills, "invalid"), { recursive: true })
		await fs.writeFile(path.join(skills, "invalid", "SKILL.md"), "No frontmatter")
		await writeSkill(skills, "oversized-skill", "oversized-skill", "Still usable without this optional file", { "references/large.md": "x".repeat(65_537) })
		const binaryDir = await writeSkill(skills, "binary-skill", "binary-skill", "Binary assets are optional.")
		await fs.mkdir(path.join(binaryDir, "references"), { recursive: true })
		await fs.writeFile(path.join(binaryDir, "references", "image.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00]))
		const registry = await discoverSkills(root, { enabledRoots: [skills] })
		assert.equal(registry.skills.length, 3)
		assert.equal(registry.get("valid-skill")?.instructions, "Follow these steps.")
		assert.ok(registry.get("oversized-skill"), "an oversized optional resource does not invalidate its manifest")
		assert.ok(registry.get("binary-skill"), "a binary optional resource does not invalidate its manifest")
		assert.equal(registry.readReference("valid-skill", "references/guide.md"), "A useful reference")
		assert.ok(registry.readReference("valid-skill", "references/long.md").length < 20_100, "references are bounded")
		assert.ok(registry.problems.some((problem) => problem.path.includes("invalid") && problem.message.includes("frontmatter")))
		assert.ok(registry.problems.some((problem) => problem.path.includes("oversized-skill") && problem.message.includes("optional resource excluded")))
		assert.ok(registry.problems.some((problem) => problem.path.includes("image.png") && problem.message.includes("optional resource excluded")))
		assert.throws(() => registry.readReference("valid-skill", "../../outside.md"), /escapes/)
		await fs.writeFile(path.join(dir, "references", "guide.md"), "Changed after capture")
		assert.equal(registry.readReference("valid-skill", "references/guide.md"), "A useful reference", "references come from the session snapshot")
	} finally {
		await fs.rm(root, { recursive: true, force: true })
	}
}

async function testDuplicatePrecedenceAndEnabledRoots(): Promise<void> {
	const root = await fixtureRoot()
	const oldStore = process.env.HEADLESSCODE_DATA_DIR
	process.env.HEADLESSCODE_DATA_DIR = path.join(root, "data")
	try {
		const enabled = path.join(root, "foreign", "skills")
		const managed = path.join(root, "data", "skills")
		await writeSkill(enabled, "same-name", "same-name", "enabled copy")
		await writeSkill(managed, "same-name", "same-name", "managed copy")
		const registry = await discoverSkills(root, { enabledRoots: [enabled] })
		assert.equal(registry.get("same-name")?.source, "enabled")
		assert.equal(registry.get("same-name")?.instructions, "enabled copy")
		assert.ok(registry.problems.some((problem) => problem.message.includes("duplicate skill 'same-name'")))
	} finally {
		if (oldStore === undefined) delete process.env.HEADLESSCODE_DATA_DIR
		else process.env.HEADLESSCODE_DATA_DIR = oldStore
		await fs.rm(root, { recursive: true, force: true })
	}
}

async function testSymlinksAreReported(): Promise<void> {
	const root = await fixtureRoot()
	try {
		const skills = path.join(root, "skills")
		const actual = await writeSkill(root, "linked-skill", "linked-skill", "Do not follow symlinks")
		await fs.mkdir(skills, { recursive: true })
		await fs.symlink(actual, path.join(skills, "linked"), "dir")
		const registry = await discoverSkills(root, { enabledRoots: [skills] })
		assert.equal(registry.skills.length, 0)
		assert.ok(registry.problems.some((problem) => problem.message.includes("symlink")))
	} finally {
		await fs.rm(root, { recursive: true, force: true })
	}
}

async function testSymlinkedParentAndExplicitValidatePath(): Promise<void> {
	const root = await fixtureRoot()
	try {
		const actual = path.join(root, "actual")
		const actualSkills = path.join(actual, "skills")
		await writeSkill(actualSkills, "valid", "valid", "valid")
		const linked = path.join(root, "linked")
		await fs.symlink(actual, linked, "dir")
		const registry = await discoverSkills(root, { enabledRoots: [path.join(linked, "skills")] })
		assert.equal(registry.skills.length, 0)
		assert.ok(registry.problems.some((problem) => problem.message.includes("symlink path component")))

		const invalid = path.join(root, "invalid-source")
		await fs.mkdir(path.join(invalid, "broken"), { recursive: true })
		await fs.writeFile(path.join(invalid, "broken", "SKILL.md"), "missing frontmatter")
		const output: string[] = []
		const status = await runSkillsCli(["validate", invalid], {
			workspaceRoot: root,
			stdout: (text) => output.push(text),
			stderr: (text) => output.push(text),
		})
		assert.equal(status, 1)
		assert.match(output.join(""), /invalid:.*frontmatter/)
	} finally {
		await fs.rm(root, { recursive: true, force: true })
	}
}

async function testDefaultRootsAndProjectOptIn(): Promise<void> {
	const root = await fixtureRoot()
	try {
		const userSkills = path.join(process.env.HOME!, ".agents", "skills")
		const projectSkills = path.join(root, ".agents", "skills")
		await writeSkill(userSkills, "user-skill", "user-skill", "User skill")
		await writeSkill(projectSkills, "project-skill", "project-skill", "Project skill")
		let registry = await discoverSkills(root)
		assert.ok(registry.get("user-skill"))
		assert.equal(registry.get("project-skill"), undefined, "project skill roots need explicit enablement")
		const output: string[] = []
		assert.equal(await runSkillsCli(["enable", projectSkills], { workspaceRoot: root, stdout: (value) => output.push(value) }), 0)
		registry = await discoverSkills(root, { enabledRoots: await readEnabledSkillRoots() })
		assert.ok(registry.get("project-skill"))
	} finally {
		await fs.rm(root, { recursive: true, force: true })
	}
}

async function testImportIsOfflineAndIdempotent(): Promise<void> {
	const root = await fixtureRoot()
	const oldStore = process.env.HEADLESSCODE_DATA_DIR
	process.env.HEADLESSCODE_DATA_DIR = path.join(root, "data")
	try {
		const source = path.join(root, "source")
		await writeSkill(source, "local-skill", "local-skill", "Instructions", { "scripts/setup.sh": "touch should-not-run" })
		const stdout: string[] = []
		const io = { workspaceRoot: root, stdout: (text: string) => stdout.push(text), stderr: (text: string) => stdout.push(text) }
		assert.equal(await runSkillsCli(["import", source], io), 0)
		assert.equal(await runSkillsCli(["import", source], io), 0)
		assert.match(stdout.join(""), /already imported/)
		assert.equal(await fs.readFile(path.join(root, "data", "skills", "local-skill", "scripts", "setup.sh"), "utf-8"), "touch should-not-run")
		assert.equal(await fs.stat(path.join(root, "should-not-run")).then(() => true, () => false), false)
	} finally {
		if (oldStore === undefined) delete process.env.HEADLESSCODE_DATA_DIR
		else process.env.HEADLESSCODE_DATA_DIR = oldStore
		await fs.rm(root, { recursive: true, force: true })
	}
}

async function testEnablePersistsAnExplicitRoot(): Promise<void> {
	const root = await fixtureRoot()
	try {
		const external = path.join(root, "external-skills")
		await writeSkill(external, "operator-skill", "operator-skill", "Enabled explicitly")
		const output: string[] = []
		const io = { workspaceRoot: root, stdout: (text: string) => output.push(text), stderr: (text: string) => output.push(text) }
		assert.equal(await runSkillsCli(["enable", external], io), 0)
		assert.equal(await runSkillsCli(["list"], io), 0)
		assert.match(output.join(""), /operator-skill\tInstructions for operator-skill\tenabled/)
	} finally {
		await fs.rm(root, { recursive: true, force: true })
	}
}

class ScriptedClient implements LlmClient {
	readonly requests: LlmRequest[] = []
	private index = 0

	constructor(private readonly script: Array<(request: LlmRequest) => ChatMessage>) {}

	async createChatCompletion(request: LlmRequest): Promise<LlmResponse> {
		this.requests.push({ ...request, messages: request.messages.map((message) => ({ ...message })) })
		const step = this.script[this.index++]
		if (!step) throw new Error("mock session ran out of steps")
		return { message: step(request) }
	}
}

function call(name: string, args: unknown): ChatMessage {
	return {
		role: "assistant",
		content: null,
		tool_calls: [{ id: `call-${name}`, type: "function", function: { name, arguments: JSON.stringify(args) } }],
	}
}

async function testMockSessionActivatesCapturedSkillWithinMode(): Promise<void> {
	const root = await fixtureRoot()
	const oldStore = process.env.HEADLESSCODE_DATA_DIR
	process.env.HEADLESSCODE_DATA_DIR = path.join(root, "data")
	try {
		const skillRoot = path.join(root, "enabled")
		await writeSkill(skillRoot, "guide", "guide", "Use the project read-only workflow.")
		const registry = await discoverSkills(root, { enabledRoots: [skillRoot] })
		const client = new ScriptedClient([
			(request) => {
				assert.ok(request.tools?.some((tool) => tool.type === "function" && tool.function.name === "skill"))
				assert.ok(request.tools?.some((tool) => tool.type === "function" && tool.function.name === "read_skill_reference"))
				assert.ok(request.messages[0]?.content?.includes("guide"))
				return call("skill", { skill: "guide", args: null })
			},
			(request) => {
				const result = request.messages.find((message) => message.role === "tool" && message.name === "skill")
				assert.ok(result?.content?.includes("Use the project read-only workflow."))
				return call("attempt_completion", { result: "Loaded the skill." })
			},
		])
		const session = new HeadlessSession({
			workspaceRoot: root,
			mode: "architect",
			model: "mock",
			taskText: "load the relevant guide",
			llmClient: client,
			executor: createReadOnlyHeadlessExecutor(root),
			skillRegistry: registry,
			checkpoints: false,
			maxIterations: 3,
		})
		const result = await session.run()
		assert.equal(result.status, "success")
		const exposed = client.requests[0]?.tools?.filter((tool) => tool.type === "function").map((tool) => tool.function.name) ?? []
		assert.ok(exposed.includes("skill"))
		assert.ok(!exposed.includes("write_to_file"), "skill activation must not grant mode tools")
		assert.equal(session.state.mode, "architect")
		const eventFile = path.join(root, ".headlesscode", "events")
		const files = await fs.readdir(eventFile)
		const records = await fs.readFile(path.join(eventFile, files[0]!), "utf-8")
		assert.match(records, /"type":"skill_activated"/)
		assert.match(records, new RegExp(registry.get("guide")!.digest))
	} finally {
		if (oldStore === undefined) delete process.env.HEADLESSCODE_DATA_DIR
		else process.env.HEADLESSCODE_DATA_DIR = oldStore
		await fs.rm(root, { recursive: true, force: true })
	}
}

const tests: Array<[string, () => Promise<void>]> = [
	["valid and invalid manifests plus bounded references", testValidInvalidManifestAndBoundedReference],
	["duplicate precedence and explicitly enabled roots", testDuplicatePrecedenceAndEnabledRoots],
	["symlinked skills are reported", testSymlinksAreReported],
	["symlink parents are rejected and validate accepts a local path", testSymlinkedParentAndExplicitValidatePath],
	["default user skills and project opt-in", testDefaultRootsAndProjectOptIn],
	["local imports are offline and idempotent", testImportIsOfflineAndIdempotent],
	["enable records a root for discovery", testEnablePersistsAnExplicitRoot],
	["mocked session activates a captured skill without widening mode tools", testMockSessionActivatesCapturedSkillWithinMode],
]

async function main(): Promise<void> {
	let passed = 0
	for (const [name, test] of tests) {
		try {
			await test()
			passed++
			console.log(`✓ ${name}`)
		} catch (error) {
			console.error(`✗ ${name}`)
			throw error
		}
	}
	console.log(`\nAll ${passed} skills tests passed`)
}

main().catch((error) => {
	console.error(error)
	process.exitCode = 1
})
