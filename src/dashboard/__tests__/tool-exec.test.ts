/**
 * Tests for src/dashboard/tool-exec.ts — the synchronous single-tool
 * endpoint (POST /api/tool/execute) used by UwUChat's code-mode agent tools.
 *
 * Covers the pure `executeTool` function (temp workspace, real executor) and
 * the HTTP layer (startDashboardServer + fetch).
 *
 * Plain assert-based script (no test framework, no network), run via
 * `npm test` -> `tsx src/dashboard/__tests__/tool-exec.test.ts`.
 */

import assert from "node:assert/strict"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"

import { executeTool } from "../tool-exec.js"
import { startDashboardServer } from "../server.js"
import type { Server } from "node:http"

async function mkTmpWorkspace(prefix: string): Promise<string> {
	return fs.mkdtemp(path.join(os.tmpdir(), prefix))
}

async function startServer(repo: string): Promise<{ server: Server; port: number }> {
	const server = await startDashboardServer({ port: 0, repo })
	const addr = server.address()
	const port = typeof addr === "object" && addr ? addr.port : 0
	return { server, port }
}

async function postJson(
	base: string,
	body: unknown,
): Promise<{ status: number; body: unknown }> {
	const res = await fetch(base + "/api/tool/execute", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	})
	const text = await res.text()
	let parsed: unknown
	try {
		parsed = JSON.parse(text)
	} catch {
		parsed = text
	}
	return { status: res.status, body: parsed }
}

// ─── executeTool: command execution ─────────────────────────────────────────

async function testExecuteCommandRunsAndReturnsOutput(): Promise<void> {
	const ws = await mkTmpWorkspace("hc-tool-exec-ok-")
	try {
		const result = await executeTool({
			workspace: ws,
			name: "execute_command",
			args: { command: "echo hello-from-tool-exec" },
		})
		assert.equal(result.isError, false)
		assert.equal(result.ok, true)
		assert.ok(result.content.includes("hello-from-tool-exec"), `output echoed, got: ${result.content}`)
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

async function testDeniedCommandIsRefused(): Promise<void> {
	const ws = await mkTmpWorkspace("hc-tool-exec-deny-")
	const prev = process.env.HEADLESSCODE_DENIED_COMMANDS
	process.env.HEADLESSCODE_DENIED_COMMANDS = "rm "
	try {
		const result = await executeTool({
			workspace: ws,
			name: "execute_command",
			args: { command: "rm -rf ./scratch" },
		})
		assert.equal(result.isError, true, "denied command must be an error")
		assert.match(result.content, /denied by the permissions policy/i)
	} finally {
		if (prev === undefined) {
			delete process.env.HEADLESSCODE_DENIED_COMMANDS
		} else {
			process.env.HEADLESSCODE_DENIED_COMMANDS = prev
		}
		await fs.rm(ws, { recursive: true, force: true })
	}
}

async function testPathEscapingReadIsRefused(): Promise<void> {
	const ws = await mkTmpWorkspace("hc-tool-exec-escape-")
	try {
		const result = await executeTool({
			workspace: ws,
			name: "read_file",
			args: { path: "/etc/passwd" },
		})
		assert.equal(result.isError, true)
		assert.match(result.content, /escape/i)
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

async function testUnknownToolIsError(): Promise<void> {
	const ws = await mkTmpWorkspace("hc-tool-exec-unknown-")
	try {
		const result = await executeTool({
			workspace: ws,
			name: "definitely_not_a_tool",
			args: {},
		})
		assert.equal(result.isError, true)
		assert.match(result.content, /Unknown tool/i)
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

async function testInvalidRequestsRejected(): Promise<void> {
	const ws = await mkTmpWorkspace("hc-tool-exec-invalid-")
	try {
		const missingWs = await executeTool({
			workspace: "",
			name: "execute_command",
			args: { command: "echo hi" },
		})
		assert.equal(missingWs.isError, true)
		assert.match(missingWs.content, /workspace/)

		const missingName = await executeTool({
			workspace: ws,
			name: "",
			args: {},
		})
		assert.equal(missingName.isError, true)
		assert.match(missingName.content, /name/)
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

// ─── HTTP layer: POST /api/tool/execute ─────────────────────────────────────

async function testHttpEndpointRunsCommand(): Promise<void> {
	const ws = await mkTmpWorkspace("hc-tool-exec-http-")
	const { server, port } = await startServer(ws)
	try {
		const { status, body } = await postJson(`http://127.0.0.1:${port}`, {
			workspace: ws,
			name: "execute_command",
			args: { command: "echo http-ok" },
		})
		assert.equal(status, 200)
		const typed = body as { ok: boolean; isError: boolean; content: string }
		assert.equal(typed.ok, true)
		assert.equal(typed.isError, false)
		assert.ok(typed.content.includes("http-ok"), `output echoed, got: ${typed.content}`)
	} finally {
		server.close()
		await fs.rm(ws, { recursive: true, force: true })
	}
}

async function testHttpEndpointRejectsBadBody(): Promise<void> {
	const ws = await mkTmpWorkspace("hc-tool-exec-http-bad-")
	const { server, port } = await startServer(ws)
	try {
		const { status, body } = await postJson(`http://127.0.0.1:${port}`, {
			workspace: "",
			name: "execute_command",
			args: {},
		})
		assert.equal(status, 200, "validation failures are ToolExecuteResult errors (200)")
		const typed = body as { isError: boolean; content: string }
		assert.equal(typed.isError, true)
		assert.match(typed.content, /workspace/)
	} finally {
		server.close()
		await fs.rm(ws, { recursive: true, force: true })
	}
}

// ─── Runner ─────────────────────────────────────────────────────────────────

const tests: Array<[string, () => Promise<void>]> = [
	["execute_command runs and returns output", testExecuteCommandRunsAndReturnsOutput],
	["denied command (HEADLESSCODE_DENIED_COMMANDS) is refused", testDeniedCommandIsRefused],
	["path-escaping read_file is refused", testPathEscapingReadIsRefused],
	["unknown tool returns Unknown tool error", testUnknownToolIsError],
	["invalid requests (missing workspace/name) rejected", testInvalidRequestsRejected],
	["HTTP POST /api/tool/execute runs a command", testHttpEndpointRunsCommand],
	["HTTP POST /api/tool/execute rejects bad body", testHttpEndpointRejectsBadBody],
]

async function main(): Promise<void> {
	let failed = 0
	for (const [name, fn] of tests) {
		try {
			await fn()
			console.log(`ok - ${name}`)
		} catch (error) {
			failed++
			console.error(`FAIL - ${name}`)
			console.error(error)
		}
	}
	if (failed > 0) {
		console.error(`\n${failed}/${tests.length} tool-exec tests failed`)
		process.exit(1)
	}
	console.log(`\nAll ${tests.length} tool-exec tests passed`)
}

main()
