import assert from "node:assert/strict"
import * as fs from "node:fs/promises"
import path from "node:path"
import { sessionsMain, parseSessionsArgs } from "../cli.js"

const scratchRoot = path.join(process.cwd(), ".headlesscode", "scratch")
const fixture = path.join(process.cwd(), "fixtures", "sessions", "claude-transcript-v2.1.synthetic.jsonl")

async function capture(fn: () => Promise<number>): Promise<{ code: number; stdout: string; stderr: string }> {
	const out = process.stdout.write.bind(process.stdout)
	const err = process.stderr.write.bind(process.stderr)
	let stdout = ""
	let stderr = ""
	process.stdout.write = ((chunk: unknown): boolean => { stdout += String(chunk); return true }) as typeof process.stdout.write
	process.stderr.write = ((chunk: unknown): boolean => { stderr += String(chunk); return true }) as typeof process.stderr.write
	try { return { code: await fn(), stdout, stderr } } finally { process.stdout.write = out; process.stderr.write = err }
}

async function testSessionsCliArchiveCommands(): Promise<void> {
	await fs.mkdir(scratchRoot, { recursive: true })
	const directory = await fs.mkdtemp(path.join(scratchRoot, "sessions-cli-"))
	const workspace = path.join(directory, "workspace")
	const data = path.join(directory, "store")
	const out = path.join(directory, "archive.json")
	const previous = process.env.HEADLESSCODE_DATA_DIR
	try {
		await fs.mkdir(workspace, { recursive: true })
		process.env.HEADLESSCODE_DATA_DIR = data
		const imported = await capture(() => sessionsMain(["import", "--from", "claude", "--file", fixture, "--workspace", workspace]))
		assert.equal(imported.code, 0)
		const id = imported.stdout.match(/Imported claude session as ([0-9a-f-]{36})/)?.[1]
		assert.ok(id)
		const listed = await capture(() => sessionsMain(["list", "--workspace", workspace]))
		assert.equal(listed.code, 0)
		assert.match(listed.stdout, new RegExp(id))
		assert.equal(listed.stdout.trim().split("\n").length, 1)
		const shown = await capture(() => sessionsMain(["show", id, "--workspace", workspace]))
		assert.equal(shown.code, 0)
		assert.equal(JSON.parse(shown.stdout).id, id)
		const exported = await capture(() => sessionsMain(["export", id, "--workspace", workspace, "--out", out]))
		assert.equal(exported.code, 0)
		assert.equal(JSON.parse(await fs.readFile(out, "utf8")).id, id)
		assert.equal((await fs.stat(out)).mode & 0o777, 0o600)
		const existingBytes = await fs.readFile(out)
		const repeatedExport = await capture(() => sessionsMain(["export", id, "--workspace", workspace, "--out", out]))
		assert.equal(repeatedExport.code, 2)
		assert.deepEqual(await fs.readFile(out), existingBytes)
		const exportStdout = await capture(() => sessionsMain(["export", id, "--workspace", workspace]))
		assert.equal(JSON.parse(exportStdout.stdout).id, id)
		const forked = await capture(() => sessionsMain(["fork", id, "--workspace", workspace]))
		assert.equal(forked.code, 0)
		assert.match(forked.stdout, /Forked/)
		assert.notEqual(forked.stdout.match(/as ([0-9a-f-]{36})/)?.[1], id)
	} finally {
		if (previous === undefined) delete process.env.HEADLESSCODE_DATA_DIR
		else process.env.HEADLESSCODE_DATA_DIR = previous
		await fs.rm(directory, { recursive: true, force: true })
	}
}

async function testCliSanitizesTerminalControlFromPaths(): Promise<void> {
	await fs.mkdir(scratchRoot, { recursive: true })
	const directory = await fs.mkdtemp(path.join(scratchRoot, "sessions-cli-terminal-"))
	const workspace = path.join(directory, "workspace")
	const source = path.join(directory, "unsafe\u001b[31mname\nbad.jsonl")
	const original = process.env.HEADLESSCODE_DATA_DIR
	try {
		await fs.mkdir(workspace, { recursive: true })
		await fs.copyFile(fixture, source)
		process.env.HEADLESSCODE_DATA_DIR = path.join(directory, "store")
		const result = await capture(() => sessionsMain(["import", "--from", "claude", "--file", source, "--workspace", workspace]))
		assert.equal(result.code, 0)
		assert.doesNotMatch(result.stdout, /\u001b/)
		assert.equal(result.stdout.trim().split("\n").length, 3)
		assert.match(result.stdout, /unsafename bad/)
		const id = result.stdout.match(/Imported claude session as ([0-9a-f-]{36})/)?.[1]
		assert.ok(id)
		const listed = await capture(() => sessionsMain(["list", "--workspace", workspace]))
		assert.equal(listed.stdout.trim().split("\n").length, 1)
		assert.doesNotMatch(listed.stdout, /\u001b/)
		const shown = await capture(() => sessionsMain(["show", id, "--workspace", workspace]))
		assert.equal(JSON.parse(shown.stdout).id, id)
	} finally {
		if (original === undefined) delete process.env.HEADLESSCODE_DATA_DIR
		else process.env.HEADLESSCODE_DATA_DIR = original
		await fs.rm(directory, { recursive: true, force: true })
	}
}

async function testSessionsCliUsageErrorsAreActionable(): Promise<void> {
	const parsed = parseSessionsArgs(["import", "--from", "bogus"])
	assert.match(parsed.error ?? "", /Choose claude, codex, or muse/)
	const result = await capture(() => sessionsMain(["import", "--from", "muse"]))
	assert.equal(result.code, 2)
	assert.match(result.stderr, /--file <path> is required/)
	const help = await capture(() => sessionsMain(["--help"]))
	assert.equal(help.code, 0)
	assert.match(help.stdout, /headlesscode sessions/)
	assert.ok(help.stdout.includes("\n  headlesscode sessions discover"), "help retains its multiline command layout")
	const museDiscovery = await capture(() => sessionsMain(["discover", "--from", "muse"]))
	assert.equal(museDiscovery.code, 2)
	assert.match(museDiscovery.stderr, /workspace metadata discovery is not supported/)
}

for (const [name, test] of [
	["sessions CLI archive commands", testSessionsCliArchiveCommands],
	["sessions CLI errors and help", testSessionsCliUsageErrorsAreActionable],
	["sessions CLI sanitizes terminal control from paths", testCliSanitizesTerminalControlFromPaths],
] as const) {
	await test()
	process.stdout.write(`✓ ${name}\n`)
}
process.stdout.write("All 3 sessions CLI tests passed\n")
