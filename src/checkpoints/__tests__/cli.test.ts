/**
 * COV-5: smoke-level tests for `headlesscode checkpoints` (src/checkpoints/cli.ts)
 * — no coverage anywhere before this file. Reuses the pattern from
 * src/orchestrator/__tests__/cli.test.ts (call the exported *Main(argv) entry
 * point in-process and assert the exit code / stdout / stderr) plus the real
 * shadow-git seeding pattern from src/dashboard/__tests__/checkpoints-routes.test.ts,
 * since this CLI is a thin wrapper over the same CheckpointService.
 *
 * Plain assert-based script (no test framework), run via `npm test`.
 */

import assert from "node:assert/strict"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"

import { checkpointsMain, parseCheckpointsArgs } from "../cli.js"
import { createCheckpointService } from "../service.js"

async function tmpRepo(prefix = "hc-ckpt-cli-"): Promise<string> {
	return fs.mkdtemp(path.join(os.tmpdir(), prefix))
}

async function tmpCheckpointDir(): Promise<string> {
	return fs.mkdtemp(path.join(os.tmpdir(), "hc-ckpt-cli-shadow-"))
}

async function seedService(workspace: string, checkpointDir: string, taskId: string): Promise<{ baselineHash: string }> {
	await fs.writeFile(path.join(workspace, "a.txt"), "original\n")
	const svc = createCheckpointService({ taskId, workspaceRoot: workspace, checkpointDir })
	await svc.init()
	const entries = await svc.list()
	return { baselineHash: entries[0].hash }
}

/** Capture stdout+stderr written during `fn()`. */
async function captureOutput(fn: () => Promise<number>): Promise<{ exit: number; stdout: string; stderr: string }> {
	const origOut = process.stdout.write.bind(process.stdout)
	const origErr = process.stderr.write.bind(process.stderr)
	let stdout = ""
	let stderr = ""
	process.stdout.write = ((chunk: unknown): boolean => {
		stdout += String(chunk)
		return true
	}) as typeof process.stdout.write
	process.stderr.write = ((chunk: unknown): boolean => {
		stderr += String(chunk)
		return true
	}) as typeof process.stderr.write
	try {
		const exit = await fn()
		return { exit, stdout, stderr }
	} finally {
		process.stdout.write = origOut
		process.stderr.write = origErr
	}
}

// ─── parseCheckpointsArgs ─────────────────────────────────────────────────

function testParseArgsHappyPath(): void {
	const { options, error } = parseCheckpointsArgs(["--workspace", "/tmp/ws", "list"])
	assert.equal(error, undefined)
	assert.equal(options.workspace, "/tmp/ws")
	assert.equal(options.command, "list")
}

function testParseArgsRestoreWithHash(): void {
	const { options, error } = parseCheckpointsArgs(["--workspace", "/tmp/ws", "restore", "abc123"])
	assert.equal(error, undefined)
	assert.equal(options.command, "restore")
	assert.deepEqual(options.commandArgs, ["abc123"])
}

function testParseArgsRejectsUnknownFlag(): void {
	const { error } = parseCheckpointsArgs(["--bogus"])
	assert.match(error ?? "", /Unknown argument/)
}

function testParseArgsRejectsMissingValue(): void {
	const { error } = parseCheckpointsArgs(["--workspace"])
	assert.match(error ?? "", /Missing value for --workspace/)
}

function testParseArgsRejectsTwoCommands(): void {
	const { error } = parseCheckpointsArgs(["list", "diff"])
	assert.match(error ?? "", /Unexpected extra command/)
}

// ─── checkpointsMain ─────────────────────────────────────────────────────

async function testMainHelpExitsZero(): Promise<void> {
	const { exit, stdout } = await captureOutput(() => checkpointsMain(["--help"]))
	assert.equal(exit, 0)
	assert.match(stdout, /headlesscode checkpoints/)
}

async function testMainNoCommandPrintsUsageExitsTwo(): Promise<void> {
	const { exit, stdout } = await captureOutput(() => checkpointsMain([]))
	assert.equal(exit, 2)
	assert.match(stdout, /Usage:/)
}

async function testMainBadArgExitsTwo(): Promise<void> {
	const { exit, stderr } = await captureOutput(() => checkpointsMain(["--bogus"]))
	assert.equal(exit, 2)
	assert.match(stderr, /Unknown argument/)
}

async function testMainMissingWorkspaceExitsTwo(): Promise<void> {
	const { exit, stderr } = await captureOutput(() => checkpointsMain(["list"]))
	assert.equal(exit, 2)
	assert.match(stderr, /--workspace <path> is required/)
}

async function testMainNoCheckpointsFoundExitsTwo(): Promise<void> {
	const workspace = await tmpRepo()
	const checkpointDir = await tmpCheckpointDir()
	try {
		const { exit, stderr } = await captureOutput(() =>
			checkpointsMain(["--workspace", workspace, "--checkpoint-dir", checkpointDir, "list"]),
		)
		assert.equal(exit, 2)
		assert.match(stderr, /No checkpoints found/)
	} finally {
		await fs.rm(workspace, { recursive: true, force: true })
		await fs.rm(checkpointDir, { recursive: true, force: true })
	}
}

async function testMainListExitsZeroAndPrintsEntries(): Promise<void> {
	const workspace = await tmpRepo()
	const checkpointDir = await tmpCheckpointDir()
	try {
		await seedService(workspace, checkpointDir, "session-1")
		const { exit, stdout } = await captureOutput(() =>
			checkpointsMain(["--workspace", workspace, "--checkpoint-dir", checkpointDir, "--task-id", "session-1", "list"]),
		)
		assert.equal(exit, 0)
		assert.match(stdout, /a\.txt|checkpoint|^[0-9a-f]{12}/m)
	} finally {
		await fs.rm(workspace, { recursive: true, force: true })
		await fs.rm(checkpointDir, { recursive: true, force: true })
	}
}

async function testMainRestoreMissingHashExitsTwo(): Promise<void> {
	const workspace = await tmpRepo()
	const checkpointDir = await tmpCheckpointDir()
	try {
		await seedService(workspace, checkpointDir, "session-1")
		const { exit, stderr } = await captureOutput(() =>
			checkpointsMain(["--workspace", workspace, "--checkpoint-dir", checkpointDir, "--task-id", "session-1", "restore"]),
		)
		assert.equal(exit, 2)
		assert.match(stderr, /a commit hash is required/)
	} finally {
		await fs.rm(workspace, { recursive: true, force: true })
		await fs.rm(checkpointDir, { recursive: true, force: true })
	}
}

async function testMainRestoreRevertsARealFile(): Promise<void> {
	const workspace = await tmpRepo()
	const checkpointDir = await tmpCheckpointDir()
	try {
		const { baselineHash } = await seedService(workspace, checkpointDir, "session-1")
		await fs.writeFile(path.join(workspace, "a.txt"), "MODIFIED\n")

		const { exit, stdout } = await captureOutput(() =>
			checkpointsMain([
				"--workspace",
				workspace,
				"--checkpoint-dir",
				checkpointDir,
				"--task-id",
				"session-1",
				"restore",
				baselineHash,
			]),
		)
		assert.equal(exit, 0)
		assert.match(stdout, /Restored workspace/)
		assert.equal(await fs.readFile(path.join(workspace, "a.txt"), "utf-8"), "original\n")
	} finally {
		await fs.rm(workspace, { recursive: true, force: true })
		await fs.rm(checkpointDir, { recursive: true, force: true })
	}
}

async function testMainDiffAgainstWorkingTree(): Promise<void> {
	const workspace = await tmpRepo()
	const checkpointDir = await tmpCheckpointDir()
	try {
		await seedService(workspace, checkpointDir, "session-1")
		await fs.writeFile(path.join(workspace, "a.txt"), "changed content\n")

		const { exit, stdout } = await captureOutput(() =>
			checkpointsMain(["--workspace", workspace, "--checkpoint-dir", checkpointDir, "--task-id", "session-1", "diff"]),
		)
		assert.equal(exit, 0)
		assert.match(stdout, /a\.txt/)
	} finally {
		await fs.rm(workspace, { recursive: true, force: true })
		await fs.rm(checkpointDir, { recursive: true, force: true })
	}
}

const tests: Array<[string, () => void | Promise<void>]> = [
	["parseCheckpointsArgs: happy path (--workspace + list)", testParseArgsHappyPath],
	["parseCheckpointsArgs: restore <hash> collects the hash as a command arg", testParseArgsRestoreWithHash],
	["parseCheckpointsArgs: rejects an unknown flag", testParseArgsRejectsUnknownFlag],
	["parseCheckpointsArgs: rejects a flag with a missing value", testParseArgsRejectsMissingValue],
	["parseCheckpointsArgs: rejects two commands", testParseArgsRejectsTwoCommands],
	["checkpointsMain: --help exits 0 and prints usage", testMainHelpExitsZero],
	["checkpointsMain: no command prints usage and exits 2", testMainNoCommandPrintsUsageExitsTwo],
	["checkpointsMain: a bad arg exits 2 with the parse error", testMainBadArgExitsTwo],
	["checkpointsMain: missing --workspace exits 2", testMainMissingWorkspaceExitsTwo],
	["checkpointsMain: no checkpoints found for the workspace exits 2", testMainNoCheckpointsFoundExitsTwo],
	["checkpointsMain: list exits 0 and prints checkpoint entries", testMainListExitsZeroAndPrintsEntries],
	["checkpointsMain: restore with no hash exits 2", testMainRestoreMissingHashExitsTwo],
	["checkpointsMain: restore reverts a real file, exits 0", testMainRestoreRevertsARealFile],
	["checkpointsMain: diff against the working tree exits 0", testMainDiffAgainstWorkingTree],
]

async function main(): Promise<void> {
	let failed = 0
	for (const [name, fn] of tests) {
		try {
			await fn()
			console.log(`  ok   ${name}`)
		} catch (err) {
			failed++
			console.error(`  FAIL ${name}`)
			console.error(err instanceof Error ? (err.stack ?? err.message) : String(err))
		}
	}
	if (failed > 0) {
		console.error(`\n${failed} test(s) failed`)
		process.exit(1)
	}
	console.log(`\nAll ${tests.length} checkpoints CLI tests passed`)
}

main().catch((err) => {
	console.error("Test runner crashed:", err)
	process.exit(1)
})
