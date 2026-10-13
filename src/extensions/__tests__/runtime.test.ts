import assert from "node:assert/strict"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import { setTimeout as delay } from "node:timers/promises"

import { createExtension, loadExtension, type ExtensionBundle, type ExtensionRevision } from "../registry.js"
import { extensionRuntimeTestHooks, SessionExtensionRuntime } from "../runtime.js"
import { OwnedChildProcess, ownedChildProcessTestHooks } from "../bounded-stdio-transport.js"
import type { ToolContext } from "../../engine/types.js"

const scratchRoot = path.join(process.cwd(), ".headlesscode", "scratch")
const permissions = (deniedCommands: string[] = []): ToolContext["permissions"] => ({
	allowedCommands: ["node"],
	deniedCommands,
	protectedFiles: [],
	allowProtectedWrites: false,
})

async function createFixture(workspaceRoot: string, bundle: ExtensionBundle): Promise<ExtensionRevision> {
	await createExtension(workspaceRoot, bundle, { authorizeWrite: () => true })
	return await loadExtension(workspaceRoot, bundle.manifest.id, (await import("../registry.js")).extensionBundleDigest(bundle))
}

function toolBundle(id: string, source: string): ExtensionBundle {
	return {
		manifest: {
			schemaVersion: 1, id, kind: "tool", description: "Fixture native tool", entrypoint: "index.mjs",
			inputSchema: {
				"$schema": "https://json-schema.org/draft/2020-12/schema",
				type: "object", properties: { mode: { type: "string", enum: ["echo", "hang", "descendant", "error", "large", "nan", "undefined", "null"] }, text: { type: "string", maxLength: 128 }, pidFile: { type: "string" } },
				required: ["mode"], additionalProperties: false,
			},
		},
		files: { "index.mjs": source },
	}
}

function toolBundleWithEntrypoint(id: string, entrypoint: string, source: string): ExtensionBundle {
	return {
		manifest: {
			schemaVersion: 1, id, kind: "tool", description: "Module scope fixture", entrypoint,
			inputSchema: { type: "object", properties: { value: { type: "string" } }, required: ["value"], additionalProperties: false },
		},
		files: { [entrypoint]: source },
	}
}

function mcpBundle(id: string, source: string): ExtensionBundle {
	return { manifest: { schemaVersion: 1, id, kind: "mcp", description: "Fixture MCP server", entrypoint: "server.mjs" }, files: { "server.mjs": source } }
}

async function waitForFile(file: string, timeoutMs: number): Promise<void> {
	const deadline = Date.now() + timeoutMs
	while (Date.now() < deadline) {
		try { await fs.access(file); return } catch { await delay(20) }
	}
	throw new Error(`timed out waiting for fixture file: ${file}`)
}

async function processIsGone(pid: number): Promise<boolean> {
	const deadline = Date.now() + 2_000
	while (Date.now() < deadline) {
		try {
			process.kill(pid, 0)
			if (process.platform === "linux") {
				const status = await fs.readFile(`/proc/${pid}/stat`, "utf8").catch(() => "")
				if (status.split(" ")[2] === "Z") return true
			}
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ESRCH") return true
			throw error
		}
		await delay(20)
	}
	return false
}

async function testNativeHelperBoundsPermissionsAndCapturedRevision(workspaceRoot: string): Promise<void> {
	const marker = path.join(workspaceRoot, "should-not-run")
	const source = `import { writeFileSync } from "node:fs";
export async function run(input) {
 if (input.mode === "error") throw new Error("fixture failure");
 if (input.mode === "large") return { value: "x".repeat(2000) };
 if (input.mode === "nan") return { value: Number.NaN };
 if (input.mode === "undefined") return { value: undefined };
 if (input.mode === "null") return null;
 if (input.mode === "hang") await new Promise(() => {});
 if (input.mode === "descendant") {
  const { spawn } = await import("node:child_process");
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  writeFileSync(input.pidFile, String(child.pid));
  await new Promise(() => {});
 }
 if (input.mode === "marker") writeFileSync(${JSON.stringify(marker)}, "ran");
 return { value: input.text ?? "", apiKey: process.env.HEADLESSCODE_OPENROUTER_API_KEY ?? null, nodeOptions: process.env.NODE_OPTIONS ?? null, home: process.env.HOME ?? null };
}`
	const bundle = toolBundle("native-fixture", source)
	const revision = await createFixture(workspaceRoot, bundle)
	const runtime = new SessionExtensionRuntime({ workspaceRoot, permissions: permissions(), limits: { callTimeoutMs: 4_000, maxOutputBytes: 512 } })
	const originalEnvironment = new Map(["HEADLESSCODE_OPENROUTER_API_KEY", "NODE_OPTIONS", "HOME", "PATH"].map((key) => [key, process.env[key]]))
	try {
		process.env.HEADLESSCODE_OPENROUTER_API_KEY = "poison-secret"
		process.env.NODE_OPTIONS = "--require=poisoned.js"
		process.env.HOME = "/poisoned/home"
		process.env.PATH = "/poisoned/path"
		const description = await runtime.describe(revision)
		assert.equal(description.kind, "tool")
		assert.equal(description.revision, revision.digest)
		const result = await runtime.call(revision, { mode: "echo", text: "hello" }, { permissions: permissions() }) as Record<string, unknown>
		assert.deepEqual(result, { value: "hello", apiKey: null, nodeOptions: null, home: null }, "generated helper receives no provider key, caller NODE_OPTIONS, HOME, or inherited path")
		await assert.rejects(runtime.call(revision, { mode: "echo", text: "x".repeat(129) }, { permissions: permissions() }), /schema mismatch/)
		await assert.rejects(runtime.call(revision, { mode: "error" }, { permissions: permissions() }), /fixture failure/)
		await assert.rejects(runtime.call(revision, { mode: "large" }, { permissions: permissions() }), /output bound/)
		await assert.rejects(runtime.call(revision, { mode: "nan" }, { permissions: permissions() }), /finite JSON/)
		await assert.rejects(runtime.call(revision, { mode: "undefined" }, { permissions: permissions() }), /finite JSON/)
		assert.equal(await runtime.call(revision, { mode: "null" }, { permissions: permissions() }), null, "JSON null remains a valid extension result")
		await assert.rejects(runtime.call(revision, { mode: "marker" }, { permissions: permissions(["node"]) }), /denied by command permissions/)
		assert.equal(await fs.stat(marker).then(() => true, () => false), false, "command denial happens before generated entrypoint execution")
		const abortController = new AbortController()
		abortController.abort()
		await assert.rejects(runtime.call(revision, { mode: "echo" }, { permissions: permissions(), signal: abortController.signal }), /cancelled/)

		const storedEntrypoint = path.join(revision.directory, "index.mjs")
		await fs.writeFile(storedEntrypoint, "export function run() { return { value: 'drifted' } }\n")
		const captured = await runtime.call(revision, { mode: "echo", text: "captured" }, { permissions: permissions() }) as Record<string, unknown>
		assert.equal(captured.value, "captured", "child executes read-only staged bytes from the verified revision map, not later registry-path drift")
		const tampered = { ...revision, files: { ...revision.files, "index.mjs": "export function run(){return null}\n" } } as ExtensionRevision
		await assert.rejects(runtime.call(tampered, { mode: "echo" }, { permissions: permissions() }), /digest does not match/)
	} finally {
		await runtime.dispose()
		for (const [key, value] of originalEnvironment) {
			if (value === undefined) delete process.env[key]
			else process.env[key] = value
		}
	}
}

async function testExecutableModuleScopeIgnoresWorkspacePackageType(workspaceRoot: string): Promise<void> {
	const fixtureRoot = path.join(workspaceRoot, "module-scope-fixtures")
	const commonJsWorkspace = path.join(fixtureRoot, "without-package-scope")
	const moduleWorkspace = path.join(fixtureRoot, "type-module-scope")
	await fs.mkdir(commonJsWorkspace, { recursive: true })
	await fs.mkdir(moduleWorkspace, { recursive: true })
	// Clear this repository's inherited module scope for the default-scope case.
	await fs.writeFile(path.join(fixtureRoot, "package.json"), "{}\n")
	await fs.writeFile(path.join(moduleWorkspace, "package.json"), '{"type":"module"}\n')
	const cases = [
		{ id: "scope-js", entrypoint: "index.js", source: 'exports.run = (input) => ({ module: "commonjs", value: input.value })', expectedModule: "commonjs" },
		{ id: "scope-cjs", entrypoint: "index.cjs", source: 'exports.run = (input) => ({ module: "commonjs", value: input.value })', expectedModule: "commonjs" },
		{ id: "scope-mjs", entrypoint: "index.mjs", source: 'export function run(input) { return { module: "module", value: input.value } }', expectedModule: "module" },
	]
	for (const item of cases) {
		const bundle = toolBundleWithEntrypoint(item.id, item.entrypoint, item.source)
		const revisions = await Promise.all([
			createFixture(commonJsWorkspace, bundle),
			createFixture(moduleWorkspace, bundle),
		])
		assert.equal(revisions[0]?.digest, revisions[1]?.digest, `${item.entrypoint} snapshots have the same pinned digest across workspace package scopes`)
		for (const revision of revisions) {
			const staged = await extensionRuntimeTestHooks.stageRevision(revision, revision.workspaceRoot)
			try {
				const packageScopePath = path.join(staged.directory, "package.json")
				assert.equal(await fs.readFile(packageScopePath, "utf8"), '{"type":"commonjs"}\n', "runtime package scope has fixed metadata")
				assert.equal((await fs.stat(packageScopePath)).mode & 0o777, 0o400, "runtime package scope is owner-readonly")
				assert.equal(Object.hasOwn(revision.files, "package.json"), false, "runtime metadata is outside the authored revision file map")
			} finally { await staged.cleanup() }
			const runtime = new SessionExtensionRuntime({ workspaceRoot: revision.workspaceRoot, permissions: permissions(), limits: { callTimeoutMs: 3_000 } })
			try {
				assert.deepEqual(await runtime.call(revision, { value: "same capsule" }, { permissions: permissions() }), {
					module: item.expectedModule, value: "same capsule",
				}, `${item.entrypoint} executes according to its explicit suffix regardless of workspace package type`)
			} finally { await runtime.dispose() }
		}
	}
}

async function testHardTimeoutAndDescendantTeardown(workspaceRoot: string): Promise<void> {
	const revision = await createFixture(workspaceRoot, toolBundle("descendant-fixture", `import { writeFileSync } from "node:fs"; export async function run(input) { const { spawn } = await import("node:child_process"); const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" }); writeFileSync(input.pidFile, String(child.pid)); await new Promise(() => {}); }`))
	const pidFile = path.join(workspaceRoot, "descendant.pid")
	const runtime = new SessionExtensionRuntime({ workspaceRoot, permissions: permissions(), limits: { callTimeoutMs: 500 } })
	try {
		const startedAt = Date.now()
		await assert.rejects(runtime.call(revision, { mode: "descendant", pidFile }, { permissions: permissions() }), /deadline exceeded|cancelled/)
		assert.ok(Date.now() - startedAt < 2_000, "hard timeout bounds uncooperative generated helpers")
		const childPidText = await fs.readFile(pidFile, "utf8")
		assert.match(childPidText, /^\d+$/)
		assert.equal(await processIsGone(Number(childPidText)), true, "timeout tears down descendants in the owned process group")
	} finally { await runtime.dispose() }
}

async function testImmediateAbortWaitsForSpawnBeforeCleanup(workspaceRoot: string): Promise<void> {
	for (const abortAfterConstruction of [false, true]) {
		const controller = new AbortController()
		if (!abortAfterConstruction) controller.abort()
		const child = new OwnedChildProcess({
			command: process.execPath,
			args: ["-e", "setInterval(() => {}, 1000)"],
			cwd: workspaceRoot,
			env: { PATH: process.env.PATH ?? "" },
			stdio: ["ignore", "ignore", "ignore"],
		}, {
			signal: controller.signal,
			timeoutMs: 2_000,
			maxProtocolBytes: 1024,
			maxStderrBytes: 1024,
			onProtocol: () => undefined,
		})
		if (abortAfterConstruction) controller.abort()
		await child.waitForSpawn()
		const pid = child.pid
		assert.ok(pid && pid > 0, "fixture child spawned before cleanup completes")
		await child.stop()
		assert.equal(await processIsGone(pid), true, "abort before or immediately after spawn still waits for identity capture and reaps the child")
	}
}

async function testLeaderExitStillReapsOwnedDescendants(workspaceRoot: string): Promise<void> {
	const pidFile = path.join(workspaceRoot, "leader-exit-descendant.pid")
	const revision = await createFixture(workspaceRoot, toolBundle("leader-exit-descendant", `import { writeFileSync } from "node:fs"; import { spawn } from "node:child_process"; export function run(input) { const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" }); writeFileSync(input.pidFile, String(child.pid)); process.exit(1); }`))
	const runtime = new SessionExtensionRuntime({ workspaceRoot, permissions: permissions(), limits: { callTimeoutMs: 2_000 } })
	try {
		await assert.rejects(runtime.call(revision, { mode: "echo", pidFile }, { permissions: permissions() }), /exited unsuccessfully|no result|before completion/i)
		const descendantPid = Number(await fs.readFile(pidFile, "utf8"))
		assert.ok(Number.isSafeInteger(descendantPid) && descendantPid > 0)
		assert.equal(await processIsGone(descendantPid), true, "the captured group is still cleaned up when its original leader exits first")
	} finally { await runtime.dispose() }
}

async function testContainedProcessGroupTeardownUsesVerifiedMembers(workspaceRoot: string): Promise<void> {
	const pidFile = path.join(workspaceRoot, "epperm-fallback-child.pid")
	const revision = await createFixture(workspaceRoot, toolBundle("epperm-fallback", `import { writeFileSync } from "node:fs"; export async function run(input) { const { spawn } = await import("node:child_process"); const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" }); writeFileSync(input.pidFile, String(child.pid)); await new Promise(() => {}); }`))
	const runtime = new SessionExtensionRuntime({ workspaceRoot, permissions: permissions(), limits: { callTimeoutMs: 500 } })
	const originalKill = process.kill.bind(process)
	const processRef = process as NodeJS.Process & { kill: typeof process.kill }
	let groupSignalAttempts = 0
	const directSignals: number[] = []
	processRef.kill = ((pid: number, signal?: NodeJS.Signals | 0) => {
		if (pid < 0 && signal !== 0) {
			groupSignalAttempts++
			const error = new Error("contained process-group signal denied") as NodeJS.ErrnoException
			error.code = "EPERM"
			throw error
		}
		if (pid > 0 && signal !== 0) directSignals.push(pid)
		return originalKill(pid, signal)
	}) as typeof process.kill
	try {
		await assert.rejects(runtime.call(revision, { mode: "descendant", pidFile }, { permissions: permissions() }), /cancel|deadline/i)
		const descendantPid = Number(await fs.readFile(pidFile, "utf8"))
		assert.ok(Number.isSafeInteger(descendantPid) && descendantPid > 0)
		assert.equal(await processIsGone(descendantPid), true, "verified per-member termination removes the descendant")
		assert.equal(groupSignalAttempts, 0, "Linux avoids the EPERM-prone negative-PGID syscall instead of silently falling back after it")
		assert.ok(directSignals.includes(descendantPid), "each descendant PID is signaled only after group/session/start-time verification")
		await runtime.dispose()
	} finally {
		processRef.kill = originalKill
		await runtime.dispose()
	}
}

async function testContainedTeardownFailureIsPropagated(workspaceRoot: string): Promise<void> {
	const pidFile = path.join(workspaceRoot, "epperm-failure-child.pid")
	const revision = await createFixture(workspaceRoot, toolBundle("epperm-failure", `import { writeFileSync } from "node:fs"; export async function run(input) { writeFileSync(input.pidFile, String(process.pid)); setInterval(() => {}, 1000); await new Promise(() => {}); }`))
	const runtime = new SessionExtensionRuntime({ workspaceRoot, permissions: permissions(), limits: { callTimeoutMs: 500 } })
	const originalKill = process.kill.bind(process)
	const processRef = process as NodeJS.Process & { kill: typeof process.kill }
	let ownedPid = 0
	const unhandled: unknown[] = []
	const onUnhandled = (error: unknown) => { unhandled.push(error) }
	process.on("unhandledRejection", onUnhandled)
	processRef.kill = ((pid: number, signal?: NodeJS.Signals | 0) => {
		if (pid < 0 && signal !== 0) {
			const error = new Error("contained process-group signal denied") as NodeJS.ErrnoException
			error.code = "EPERM"
			throw error
		}
		if (pid > 0 && signal !== 0) {
			const error = new Error("contained owned-process signal denied") as NodeJS.ErrnoException
			error.code = "EPERM"
			throw error
		}
		return originalKill(pid, signal)
	}) as typeof process.kill
	try {
		const call = runtime.call(revision, { mode: "hang", pidFile }, { permissions: permissions() })
		await waitForFile(pidFile, 2_000)
		ownedPid = Number(await fs.readFile(pidFile, "utf8"))
		await assert.rejects(call, (error: unknown) => error instanceof AggregateError || (error instanceof Error && error.name === "OwnedProcessTeardownError"), "cleanup denial must fail the operation instead of claiming the child was stopped")
		await new Promise<void>((resolve) => setTimeout(resolve, 50))
		assert.deepEqual(unhandled, [], "background close/timeout cleanup failures are handled and reported without an unhandled rejection")
	} finally {
		processRef.kill = originalKill
		if (ownedPid > 0) {
			try { originalKill(ownedPid, "SIGKILL") } catch { /* fixture process may already be gone */ }
			assert.equal(await processIsGone(ownedPid), true, "test reaps the fixture process after restoring the real signal path")
		}
		process.off("unhandledRejection", onUnhandled)
		await runtime.dispose().catch(() => undefined)
	}
}

async function testDisposeReportsCleanupFailureAfterLeaderExit(workspaceRoot: string): Promise<void> {
	const pidFile = path.join(workspaceRoot, "dispose-cleanup-failure-descendant.pid")
	const revision = await createFixture(workspaceRoot, toolBundle("dispose-cleanup-failure", `import { writeFileSync } from "node:fs"; import { spawn } from "node:child_process"; export function run(input) { const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" }); child.unref(); writeFileSync(input.pidFile, String(child.pid)); return { completed: true }; }`))
	const runtime = new SessionExtensionRuntime({ workspaceRoot, permissions: permissions(), limits: { callTimeoutMs: 2_000 } })
	const originalKill = process.kill.bind(process)
	const processRef = process as NodeJS.Process & { kill: typeof process.kill }
	let descendantPid = 0
	processRef.kill = ((pid: number, signal?: NodeJS.Signals | 0) => {
		if (pid !== 0 && signal !== 0) {
			const error = new Error("contained owned-process signal denied") as NodeJS.ErrnoException
			error.code = "EPERM"
			throw error
		}
		return originalKill(pid, signal)
	}) as typeof process.kill
	try {
		const call = runtime.call(revision, { mode: "echo", pidFile }, { permissions: permissions() })
		// Guard: teardown can fail before assert.rejects attaches below;
		// without an early handler the rejection is momentarily unhandled
		// and crashes the suite (observed in loaded sandboxes).
		call.catch(() => undefined)
		await waitForFile(pidFile, 2_000)
		descendantPid = Number(await fs.readFile(pidFile, "utf8"))
		await assert.rejects(call, /could not signal every verified member/i)
		await assert.rejects(runtime.dispose(), /teardown|signal/i, "dispose retains and reports a failed child teardown after the leader exits")
	} finally {
		processRef.kill = originalKill
		if (descendantPid > 0) {
			try { originalKill(descendantPid, "SIGKILL") } catch { /* fixture process may already be gone */ }
			assert.equal(await processIsGone(descendantPid), true, "test reaps the descendant after restoring real signals")
		}
		await runtime.dispose().catch(() => undefined)
	}
}

async function testMcpCloseRetainsFailedTransportForDispose(workspaceRoot: string): Promise<void> {
	const pidFile = path.join(workspaceRoot, "mcp-close-cleanup-failure-descendant.pid")
	const serverPidFile = path.join(workspaceRoot, "mcp-close-cleanup-failure-server.pid")
	const source = `import { writeFileSync } from "node:fs"; import { spawn } from "node:child_process";\n${MCP_SERVER_SOURCE.replace("await server.connect(new StdioServerTransport());", `writeFileSync(${JSON.stringify(serverPidFile)}, String(process.pid)); const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" }); child.unref(); writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));\nawait server.connect(new StdioServerTransport());`)}`
	const revision = await createFixture(workspaceRoot, mcpBundle("mcp-close-cleanup-failure", source))
	const runtime = new SessionExtensionRuntime({ workspaceRoot, permissions: permissions(), limits: { callTimeoutMs: 2_000 } })
	const originalKill = process.kill.bind(process)
	const processRef = process as NodeJS.Process & { kill: typeof process.kill }
	let descendantPid = 0
	let serverPid = 0
	processRef.kill = ((pid: number, signal?: NodeJS.Signals | 0) => {
		if (pid !== 0 && signal !== 0) {
			const error = new Error("contained owned-process signal denied") as NodeJS.ErrnoException
			error.code = "EPERM"
			throw error
		}
		return originalKill(pid, signal)
	}) as typeof process.kill
	try {
		const call = runtime.call(revision, { text: "hello" }, { permissions: permissions(), toolName: "echo" })
		// Guard: see testDisposeReportsCleanupFailureAfterLeaderExit —
		// teardown may fail before assert.rejects attaches.
		call.catch(() => undefined)
		await waitForFile(pidFile, 2_000)
		descendantPid = Number(await fs.readFile(pidFile, "utf8"))
		serverPid = Number(await fs.readFile(serverPidFile, "utf8"))
		await assert.rejects(call, /could not signal every verified member/i)
		await assert.rejects(runtime.dispose(), /teardown|signal/i, "dispose reports failed MCP teardown even after SDK close and runtime close both run")
	} finally {
		processRef.kill = originalKill
		if (serverPid > 0) {
			try { originalKill(-serverPid, "SIGKILL") } catch { /* fixture process group may already be gone */ }
			// Fall back to the server pid itself: the group kill demonstrably
			// misses in sealed guests (observed RSI eval failure), leaving the
			// server alive for the reap check below. Direct kill matches the
			// descendant reap; the pid is fixture-owned either way.
			try {
				originalKill(serverPid, "SIGKILL")
			} catch { /* server may already be gone */ }
			assert.equal(await processIsGone(serverPid), true, "test reaps the MCP server after restoring real signals")
		}
		if (descendantPid > 0) {
			try { originalKill(descendantPid, "SIGKILL") } catch { /* fixture process may already be gone */ }
			assert.equal(await processIsGone(descendantPid), true, "test reaps the descendant after restoring real signals")
		}
		await runtime.dispose().catch(() => undefined)
	}
}

function testOwnedProcessIdentityRejectsReuseAndMalformedStat(): void {
	const fields = ["R", "11", "42", "42", "0", "-1", "0", "0", "0", "0", "0", "0", "0", "0", "0", "0", "0", "0", "0", "987654"]
	const identity = ownedChildProcessTestHooks.parseLinuxProcessStat(42, `42 (node ) worker) ${fields.join(" ")}`)
	assert.deepEqual(identity, { pid: 42, state: "R", processGroupId: 42, sessionId: 42, startTime: "987654" }, "stat parsing handles parenthesized command names and captures the process start time")
	assert.equal(ownedChildProcessTestHooks.matchesOwnedProcessIdentity(identity, identity), true)
	assert.equal(ownedChildProcessTestHooks.matchesOwnedProcessIdentity({ ...identity, startTime: "987655" }, identity), false, "a reused PID with a different start time is not an owned process")
	assert.equal(ownedChildProcessTestHooks.matchesOwnedProcessIdentity({ ...identity, sessionId: 99 }, identity), false, "a process from another session cannot be signaled as a group member")
	assert.throws(
		() => ownedChildProcessTestHooks.assertCapturedLeaderIdentity({ ...identity, startTime: "987655" }, identity),
		/captured process-group leader PID was reused/,
		"a new session reusing the captured group leader PID is rejected before any member signal",
	)
	assert.throws(() => ownedChildProcessTestHooks.parseLinuxProcessStat(42, "42 (short) R 1"), /could not verify an owned process identity/)
}

const MCP_SERVER_SOURCE = `import { Server } from "@modelcontextprotocol/sdk/server";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
const server = new Server({ name: "fixture-server", version: "1.0" }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{ name: "echo", description: "Echo text", inputSchema: { type: "object", properties: { text: { type: "string", minLength: 2 } }, required: ["text"], additionalProperties: false }, outputSchema: { type: "object", properties: { echo: { type: "string" } }, required: ["echo"], additionalProperties: false } }] }));
server.setRequestHandler(CallToolRequestSchema, async ({ params }) => ({ content: [{ type: "text", text: "ok" }], structuredContent: { echo: params.arguments.text } }));
await server.connect(new StdioServerTransport());`

async function testMcpHandshakeSchemaAndCall(workspaceRoot: string): Promise<void> {
	const revision = await createFixture(workspaceRoot, mcpBundle("mcp-fixture", MCP_SERVER_SOURCE))
	const runtime = new SessionExtensionRuntime({ workspaceRoot, permissions: permissions(), limits: { callTimeoutMs: 5_000 } })
	try {
		const description = await runtime.describe(revision)
		assert.equal(description.tools?.length, 1)
		assert.equal(description.tools?.[0]?.name, "echo")
		assert.deepEqual(await runtime.call(revision, { text: "hello" }, { permissions: permissions(), toolName: "echo" }), {
			content: [{ type: "text", text: "ok" }], structuredContent: { echo: "hello" },
		})
		await assert.rejects(runtime.call(revision, { text: "x" }, { permissions: permissions(), toolName: "echo" }), /does not match its schema/)
		await assert.rejects(runtime.call(revision, { text: "hello" }, { permissions: permissions(), toolName: "other" }), /not advertised/)
		await assert.rejects(runtime.call(revision, { text: "hello" }, { permissions: permissions(["node"]), toolName: "echo" }), /denied by command permissions/)
	} finally { await runtime.dispose() }
}

async function testMcpDescribeUsesCurrentPermissions(workspaceRoot: string): Promise<void> {
	const marker = path.join(workspaceRoot, "mcp-inspect-must-not-start")
	const source = `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(marker)}, "started");\n${MCP_SERVER_SOURCE}`
	const revision = await createFixture(workspaceRoot, mcpBundle("mcp-current-permissions", source))
	const runtime = new SessionExtensionRuntime({ workspaceRoot, permissions: permissions(), limits: { callTimeoutMs: 2_000 } })
	try {
		await assert.rejects(runtime.describe(revision, { permissions: permissions(["node"]) }), /denied by command permissions/)
		assert.equal(await fs.stat(marker).then(() => true, () => false), false, "inspect uses the invocation's current deny policy before spawning MCP")
	} finally { await runtime.dispose() }
}

async function testMcpDescribeAbortTearsDownInspectProcess(workspaceRoot: string): Promise<void> {
	const pidFile = path.join(workspaceRoot, "mcp-inspect.pid")
	const hangingList = MCP_SERVER_SOURCE
		.replace('import { Server }', 'import { writeFileSync } from "node:fs";\nimport { Server }')
		.replace('server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{ name: "echo", description: "Echo text", inputSchema: { type: "object", properties: { text: { type: "string", minLength: 2 } }, required: ["text"], additionalProperties: false }, outputSchema: { type: "object", properties: { echo: { type: "string" } }, required: ["echo"], additionalProperties: false } }] }));', 'server.setRequestHandler(ListToolsRequestSchema, async () => await new Promise(() => {}));')
	const source = `writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));\n${hangingList}`
	const revision = await createFixture(workspaceRoot, mcpBundle("mcp-inspect-abort", source))
	const runtime = new SessionExtensionRuntime({ workspaceRoot, permissions: permissions(), limits: { callTimeoutMs: 10_000 } })
	const controller = new AbortController()
	try {
		const inspection = runtime.describe(revision, { permissions: permissions(), signal: controller.signal })
		await waitForFile(pidFile, 2_000)
		controller.abort()
		await assert.rejects(inspection, /cancel|closed|transport|abort/i)
		const pid = Number(await fs.readFile(pidFile, "utf8"))
		assert.ok(Number.isSafeInteger(pid) && pid > 0)
		assert.equal(await processIsGone(pid), true, "stopping inspect tears down its owned MCP process")
	} finally { await runtime.dispose() }
}

async function testMcpDuplicateNamesAndMalformedOversizedFrames(workspaceRoot: string): Promise<void> {
	const duplicate = MCP_SERVER_SOURCE.replace('tools: [{ name: "echo", description:', 'tools: [{ name: "echo", inputSchema: { type: "object" } }, { name: "echo", description:')
	const duplicateRevision = await createFixture(workspaceRoot, mcpBundle("mcp-duplicate", duplicate))
	const runtime = new SessionExtensionRuntime({ workspaceRoot, permissions: permissions(), limits: { callTimeoutMs: 2_000, maxProtocolBytes: 64 * 1024 } })
	try {
		await assert.rejects(runtime.describe(duplicateRevision), /duplicate tool names/)
		const malformed = await createFixture(workspaceRoot, mcpBundle("mcp-malformed", "process.stdout.write('not-json\\n'); setInterval(() => {}, 1000)"))
		await assert.rejects(runtime.describe(malformed), /protocol|JSON|MCP/i)
		const oversized = await createFixture(workspaceRoot, mcpBundle("mcp-oversized", "process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { x: 'x'.repeat(100000) } }) + '\\n'); setInterval(() => {}, 1000)"))
		await assert.rejects(runtime.describe(oversized), /bound|buffer|protocol|closed|MCP/i)
	} finally { await runtime.dispose() }
}

async function testMcpCallTimeoutAndDisposal(workspaceRoot: string): Promise<void> {
	const hanging = MCP_SERVER_SOURCE.replace('server.setRequestHandler(CallToolRequestSchema, async ({ params }) => ({ content: [{ type: "text", text: "ok" }], structuredContent: { echo: params.arguments.text } }));', 'server.setRequestHandler(CallToolRequestSchema, async () => await new Promise(() => {}));')
	const revision = await createFixture(workspaceRoot, mcpBundle("mcp-hang", hanging))
	const runtime = new SessionExtensionRuntime({ workspaceRoot, permissions: permissions(), limits: { callTimeoutMs: 500 } })
	try {
		await assert.rejects(runtime.call(revision, { text: "hello" }, { permissions: permissions(), toolName: "echo" }), /cancel|deadline|timeout/i)
		await assert.rejects(runtime.call(revision, { text: "hello" }, { permissions: permissions(), toolName: "echo" }), /cancel|deadline|timeout/i)
		const inFlight = runtime.call(revision, { text: "hello" }, { permissions: permissions(), toolName: "echo" })
		await delay(100)
		await runtime.dispose()
		await assert.rejects(inFlight, /cancel|closed|transport|disposed|abort/i)
		await assert.rejects(runtime.call(revision, { text: "hello" }, { permissions: permissions(), toolName: "echo" }), /disposed/)
	} finally { await runtime.dispose() }
}

async function testDisposeDuringStagingPreventsExecution(workspaceRoot: string): Promise<void> {
	const marker = path.join(workspaceRoot, "must-not-run-after-dispose")
	const revision = await createFixture(workspaceRoot, toolBundle("dispose-stage-race", `import { writeFileSync } from "node:fs"; export function run() { writeFileSync(${JSON.stringify(marker)}, "ran"); return null }`))
	const runtime = new SessionExtensionRuntime({ workspaceRoot, permissions: permissions() })
	let reachedStaging: () => void = () => undefined
	let continueStaging: () => void = () => undefined
	const stagingReached = new Promise<void>((resolve) => { reachedStaging = resolve })
	const stagingGate = new Promise<void>((resolve) => { continueStaging = resolve })
	extensionRuntimeTestHooks.setStageRevisionBarrierForTests(async () => { reachedStaging(); await stagingGate })
	try {
		const pending = runtime.call(revision, { mode: "marker" }, { permissions: permissions() })
		await stagingReached
		const disposal = runtime.dispose()
		assert.equal(runtime.dispose(), disposal, "concurrent dispose calls wait for the same cleanup operation")
		continueStaging()
		await assert.rejects(pending, /cancelled/)
		await disposal
		assert.equal(await fs.stat(marker).then(() => true, () => false), false, "dispose aborts a call paused after staging begins before it can spawn its extension")
		const extensionRoot = path.join(workspaceRoot, ".agents", "headlesscode", "extensions")
		assert.deepEqual((await fs.readdir(extensionRoot)).filter((name) => name.startsWith(".runtime-")), [], "dispose waits for staged-file cleanup")
	} finally {
		extensionRuntimeTestHooks.setStageRevisionBarrierForTests(undefined)
		await runtime.dispose()
	}
}

async function testWindowsFailsClosedForExecutableExtensions(): Promise<void> {
	assert.throws(() => extensionRuntimeTestHooks.assertOwnedProcessGroupSupported("win32"), /unavailable on Windows.*teardown/)
	assert.doesNotThrow(() => extensionRuntimeTestHooks.assertOwnedProcessGroupSupported("linux"))
}

await fs.mkdir(scratchRoot, { recursive: true, mode: 0o700 })
const workspaceRoot = await fs.mkdtemp(path.join(scratchRoot, "extension-runtime-test-"))
try {
	await testNativeHelperBoundsPermissionsAndCapturedRevision(workspaceRoot)
	await testExecutableModuleScopeIgnoresWorkspacePackageType(workspaceRoot)
	await testHardTimeoutAndDescendantTeardown(workspaceRoot)
	await testImmediateAbortWaitsForSpawnBeforeCleanup(workspaceRoot)
	await testLeaderExitStillReapsOwnedDescendants(workspaceRoot)
	await testContainedProcessGroupTeardownUsesVerifiedMembers(workspaceRoot)
	await testContainedTeardownFailureIsPropagated(workspaceRoot)
	await testDisposeReportsCleanupFailureAfterLeaderExit(workspaceRoot)
	await testMcpCloseRetainsFailedTransportForDispose(workspaceRoot)
	testOwnedProcessIdentityRejectsReuseAndMalformedStat()
	await testMcpHandshakeSchemaAndCall(workspaceRoot)
	await testMcpDescribeUsesCurrentPermissions(workspaceRoot)
	await testMcpDescribeAbortTearsDownInspectProcess(workspaceRoot)
	await testMcpDuplicateNamesAndMalformedOversizedFrames(workspaceRoot)
	await testMcpCallTimeoutAndDisposal(workspaceRoot)
	await testDisposeDuringStagingPreventsExecution(workspaceRoot)
	await testWindowsFailsClosedForExecutableExtensions()
	process.stdout.write("Extension child runtime and bounded MCP transport tests passed\n")
} finally {
	await fs.rm(workspaceRoot, { recursive: true, force: true })
}
