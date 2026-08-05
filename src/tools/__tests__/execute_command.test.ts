/**
 * Unit tests for the execute_command timeout semantics
 * (src/tools/executor.ts's executeCommandHandler).
 *
 * The vendored tool contract (src/vendor/zoo-code/src/core/prompts/tools/
 * native-tools/execute_command.ts) says a command whose `timeout` elapses
 * KEEPS RUNNING in the background and the model gets the output captured so
 * far — it must NOT be killed, and the result must be a normal (non-error)
 * tool result so the loop's consecutive-mistake counter is untouched.
 *
 * Plain assert-based script (no test framework, no network), run via
 * `npm test` -> `tsx src/tools/__tests__/execute_command.test.ts`.
 */

import assert from "node:assert/strict"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { setTimeout as sleep } from "node:timers/promises"

import { createHeadlessExecutor } from "../executor.js"

async function mkTmpWorkspace(prefix: string): Promise<string> {
	return fs.mkdtemp(path.join(os.tmpdir(), prefix))
}

async function exists(p: string): Promise<boolean> {
	try {
		await fs.access(p)
		return true
	} catch {
		return false
	}
}

/** Poll `process.kill(pid, 0)` until the process is gone (throws) or timeout. */
async function waitForProcessExit(pid: number, timeoutMs = 5_000): Promise<void> {
	const deadline = Date.now() + timeoutMs
	while (Date.now() < deadline) {
		try {
			process.kill(pid, 0)
		} catch {
			return // gone
		}
		await sleep(50)
	}
	throw new Error(`process ${pid} still alive after ${timeoutMs}ms`)
}

// ─── (a) command finishes well within its timeout ───────────────────────────

async function testNormalCompletionWithinTimeout(): Promise<void> {
	const ws = await mkTmpWorkspace("hc-ec-ok-")
	try {
		const executor = createHeadlessExecutor(ws)

		const result = await executor.execute("execute_command", {
			command: "node -e 'console.log(40 + 2)'",
			timeout: 10,
		})

		assert.equal(result.isError, false, "a command that finishes must be a normal result")
		assert.match(result.content, /42/, "stdout must be captured")
		assert.doesNotMatch(result.content, /timed out/, "no timeout marker for a fast command")
		assert.doesNotMatch(result.content, /^\[Error\]/, "no error prefix for a fast command")
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

// ─── (b) timeout: non-error result, partial output, process keeps running ───

async function testTimeoutKeepsProcessAliveAndWritesMarker(): Promise<void> {
	const ws = await mkTmpWorkspace("hc-ec-timeout-")
	try {
		const executor = createHeadlessExecutor(ws)
		const marker = path.join(ws, "marker.txt")

		// Prints its own PID immediately, then writes a marker file after a
		// delay (4s) well past the 1s timeout — if the timeout killed it, the
		// marker would never appear.
		const result = await executor.execute("execute_command", {
			command:
				`node -e 'console.log("pid=" + process.pid); ` +
				`setTimeout(() => require("fs").writeFileSync(${JSON.stringify(marker)}, "done"), 4000)'`,
			timeout: 1,
		})

		assert.equal(result.isError, false, "a timeout is expected/intentional, NOT an error result")
		assert.match(result.content, /timed out after 1s/, "result must be clearly marked as a timeout")
		assert.match(result.content, /still running in the background/, "must say the process is still running")
		assert.match(result.content, /pid=\d+/, "partial output captured before the timeout must be returned")

		const pid = Number(result.content.match(/pid=(\d+)/)?.[1])
		assert.ok(Number.isInteger(pid) && pid > 0, "could not extract the backgrounded pid from the output")

		// Immediately after the tool returned (well before the 4s delay): the
		// process must STILL be alive — the timeout must not have killed it —
		// and the marker must not be written yet.
		assert.doesNotThrow(() => process.kill(pid, 0), "backgrounded process must be alive right after the timeout")
		assert.equal(await exists(marker), false, "marker not written yet — process is still mid-run")

		// Past the 4s delay the process finished on its own and wrote the file.
		await sleep(4_500)
		assert.equal(await exists(marker), true, "backgrounded process must keep running past the timeout and write its marker")
		// …and it exited normally on its own (no kill needed).
		await waitForProcessExit(pid)
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

// ─── (c) central-store protection (see src/permissions/store-protection.ts) ──

async function testRecursiveDeleteOfCentralStoreRefusedBeforeSpawn(): Promise<void> {
	const ws = await mkTmpWorkspace("hc-ec-store-ws-")
	const storeBase = await mkTmpWorkspace("hc-ec-store-data-")
	const storeRoot = path.join(storeBase, "central-store")
	await fs.mkdir(storeRoot, { recursive: true })
	const marker = path.join(storeRoot, "marker.txt")
	await fs.writeFile(marker, "keep-me")
	const savedDataDir = process.env.HEADLESSCODE_DATA_DIR
	process.env.HEADLESSCODE_DATA_DIR = storeRoot
	try {
		const executor = createHeadlessExecutor(ws) // ZERO permissions config
		const result = await executor.execute("execute_command", {
			command: `rm -rf ${storeRoot}`,
			timeout: 10,
		})
		assert.equal(result.isError, true, "a store-targeting recursive delete must be refused (isError)")
		assert.match(result.content, /central store/, "refusal message names the central store")
		// The refusal happens BEFORE spawn — nothing was executed or deleted.
		assert.equal(await exists(marker), true, "the store's content must survive (refused before spawn)")
		assert.equal(await exists(storeRoot), true, "the store dir must survive")
	} finally {
		if (savedDataDir === undefined) {
			delete process.env.HEADLESSCODE_DATA_DIR
		} else {
			process.env.HEADLESSCODE_DATA_DIR = savedDataDir
		}
		await fs.rm(ws, { recursive: true, force: true })
		await fs.rm(storeBase, { recursive: true, force: true })
	}
}

async function testStoreProtectionNotOverridableByPermissions(): Promise<void> {
	const ws = await mkTmpWorkspace("hc-ec-store-nover-")
	const storeBase = await mkTmpWorkspace("hc-ec-store-nover-data-")
	const storeRoot = path.join(storeBase, "central-store")
	await fs.mkdir(storeRoot, { recursive: true })
	const marker = path.join(storeRoot, "marker.txt")
	await fs.writeFile(marker, "keep-me")
	const savedDataDir = process.env.HEADLESSCODE_DATA_DIR
	process.env.HEADLESSCODE_DATA_DIR = storeRoot
	try {
		// An allow-everything permissions config: the store protection is not
		// configurable, so the command must STILL be refused.
		const executor = createHeadlessExecutor(ws, {
			permissions: {
				allowedCommands: ["rm", "rm -rf", "*"],
				deniedCommands: [],
				protectedFiles: [],
				allowProtectedWrites: true,
			},
		})
		const result = await executor.execute("execute_command", {
			command: `rm -rf ${storeRoot}`,
			timeout: 10,
		})
		assert.equal(result.isError, true, "store protection is NOT overridable by an allow-everything config")
		assert.match(result.content, /central store/, "refusal message names the central store")
		assert.equal(await exists(marker), true, "nothing was executed or deleted")
	} finally {
		if (savedDataDir === undefined) {
			delete process.env.HEADLESSCODE_DATA_DIR
		} else {
			process.env.HEADLESSCODE_DATA_DIR = savedDataDir
		}
		await fs.rm(ws, { recursive: true, force: true })
		await fs.rm(storeBase, { recursive: true, force: true })
	}
}

async function testWorkspaceScratchCleanupStillAllowed(): Promise<void> {
	const ws = await mkTmpWorkspace("hc-ec-store-cleanup-")
	const storeBase = await mkTmpWorkspace("hc-ec-store-cleanup-data-")
	const storeRoot = path.join(storeBase, "central-store")
	const savedDataDir = process.env.HEADLESSCODE_DATA_DIR
	process.env.HEADLESSCODE_DATA_DIR = storeRoot
	try {
		// Ordinary workspace cleanup is NOT the store — it must actually RUN.
		const scratch = path.join(ws, "tmp-scratch")
		await fs.mkdir(scratch, { recursive: true })
		await fs.writeFile(path.join(scratch, "file.txt"), "scratch")
		const executor = createHeadlessExecutor(ws)
		const result = await executor.execute("execute_command", {
			command: "rm -rf ./tmp-scratch",
			timeout: 10,
		})
		assert.equal(result.isError, false, "workspace cleanup is allowed (not the store)")
		assert.equal(await exists(scratch), false, "the scratch dir was actually removed")
	} finally {
		if (savedDataDir === undefined) {
			delete process.env.HEADLESSCODE_DATA_DIR
		} else {
			process.env.HEADLESSCODE_DATA_DIR = savedDataDir
		}
		await fs.rm(ws, { recursive: true, force: true })
		await fs.rm(storeBase, { recursive: true, force: true })
	}
}

async function testNonDestructiveStoreAccessAllowed(): Promise<void> {
	const ws = await mkTmpWorkspace("hc-ec-store-read-")
	const storeBase = await mkTmpWorkspace("hc-ec-store-read-data-")
	const storeRoot = path.join(storeBase, "central-store")
	const savedDataDir = process.env.HEADLESSCODE_DATA_DIR
	process.env.HEADLESSCODE_DATA_DIR = storeRoot
	try {
		const executor = createHeadlessExecutor(ws)
		const result = await executor.execute("execute_command", {
			command: `echo store-root-is ${storeRoot}`,
			timeout: 10,
		})
		assert.equal(result.isError, false, "reading/referencing the store via echo is allowed")
		assert.match(result.content, /store-root-is/, "command ran normally")
	} finally {
		if (savedDataDir === undefined) {
			delete process.env.HEADLESSCODE_DATA_DIR
		} else {
			process.env.HEADLESSCODE_DATA_DIR = savedDataDir
		}
		await fs.rm(ws, { recursive: true, force: true })
		await fs.rm(storeBase, { recursive: true, force: true })
	}
}

// ─── Runner ──────────────────────────────────────────────────────────────────

const tests: Array<[string, () => Promise<void>]> = [
	["execute_command: command finishes within timeout -> normal non-error result with full output", testNormalCompletionWithinTimeout],
	["execute_command: timeout -> non-error result, partial output, process keeps running and completes on its own", testTimeoutKeepsProcessAliveAndWritesMarker],
	["execute_command: rm -rf of the central store is refused BEFORE spawn (zero config)", testRecursiveDeleteOfCentralStoreRefusedBeforeSpawn],
	["execute_command: store protection is NOT overridable by an allow-everything permissions config", testStoreProtectionNotOverridableByPermissions],
	["execute_command: rm -rf of workspace scratch still runs (not the store)", testWorkspaceScratchCleanupStillAllowed],
	["execute_command: non-destructive store access (echo) is allowed", testNonDestructiveStoreAccessAllowed],
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
			console.error(err instanceof Error ? err.stack ?? err.message : String(err))
		}
	}
	if (failed > 0) {
		console.error(`\n${failed} test(s) failed`)
		process.exit(1)
	}
	console.log(`\nAll ${tests.length} execute_command timeout tests passed`)
}

main().catch((err) => {
	console.error("Test runner crashed:", err)
	process.exit(1)
})
