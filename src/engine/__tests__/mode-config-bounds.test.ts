import assert from "node:assert/strict"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"

import { runSuites } from "../../test-runner.js"
import { loadCustomModes } from "../prompt.js"

const REAL_HOME = os.homedir()
const ROOT = path.join(
	os.tmpdir(),
	`hc-mode-bounds-${process.pid}-${Date.now()}`,
)
let homes = 0

async function sandboxHome(): Promise<void> {
	const home = path.join(ROOT, `home-${homes++}`)
	const store = path.join(home, ".local", "share", "headlesscode")
	await fs.mkdir(path.join(store, "shared"), { recursive: true })
	process.env.HOME = home
	process.env.USERPROFILE = home
	process.env.HEADLESSCODE_DATA_DIR = store
}

function mode(
	slug: string,
	extra: Record<string, unknown> = {},
): Record<string, unknown> {
	return {
		slug,
		name: `Mode ${slug}`,
		roleDefinition: "A test mode.",
		groups: ["read"],
		...extra,
	}
}

async function writeWorkspace(body: unknown): Promise<string> {
	const workspace = await fs.mkdtemp(
		path.join(os.tmpdir(), "hc-mode-bounds-workspace-"),
	)
	await fs.writeFile(
		path.join(workspace, ".roomodes"),
		JSON.stringify(body),
		"utf-8",
	)
	return workspace
}

async function captureErrors<T>(
	run: () => Promise<T>,
): Promise<{ value: T; errors: string[] }> {
	const errors: string[] = []
	const original = console.error
	const originalWarn = console.warn
	console.error = (...args: unknown[]) => errors.push(args.map(String).join(" "))
	console.warn = (...args: unknown[]) => errors.push(args.map(String).join(" "))
	try {
		return { value: await run(), errors }
	} finally {
		console.error = original
		console.warn = originalWarn
	}
}

async function testFileByteBudget(): Promise<void> {
	await sandboxHome()
	const workspace = await fs.mkdtemp(
		path.join(os.tmpdir(), "hc-mode-bounds-large-"),
	)
	const body = Buffer.alloc(1_000_001, 0x20)
	body.write("customModes: []\n")
	await fs.writeFile(path.join(workspace, ".roomodes"), body)
	const result = await captureErrors(() => loadCustomModes(workspace))
	assert.deepEqual(result.value, [])
	assert.ok(
		result.errors.some((message) => message.includes("1000000-byte limit")),
	)
}

async function testCustomModesCountBudget(): Promise<void> {
	await sandboxHome()
	const customModes = Array.from(
		{ length: 101 },
		(_, index) => mode(`mode-${index}`),
	)
	const workspace = await writeWorkspace({ customModes })
	const result = await captureErrors(() => loadCustomModes(workspace))
	assert.deepEqual(result.value, [])
	assert.ok(
		result.errors.some((message) => message.includes("100-entry limit")),
	)
}

async function testModeGroupCountBudget(): Promise<void> {
	await sandboxHome()
	const customModes = [
		mode("many-groups", {
			groups: Array.from({ length: 101 }, () => "read"),
		}),
	]
	const workspace = await writeWorkspace({ customModes })
	const result = await captureErrors(() => loadCustomModes(workspace))
	assert.deepEqual(result.value, [])
	assert.ok(
		result.errors.some((message) =>
			message.includes("groups exceeds 100 entries"),
		),
	)
}

async function testAllowedMcpServerCountBudget(): Promise<void> {
	await sandboxHome()
	const customModes = [
		mode("many-servers", {
			allowedMcpServers: Array.from({ length: 33 }, (_, i) => `server-${i}`),
		}),
	]
	const workspace = await writeWorkspace({ customModes })
	const result = await captureErrors(() => loadCustomModes(workspace))
	assert.deepEqual(result.value, [])
	assert.ok(
		result.errors.some((message) =>
			message.includes("allowedMcpServers exceeds 32 entries"),
		),
	)
}

const tests: Array<[string, () => Promise<void>]> = [
	["oversized mode files are rejected before YAML parsing", testFileByteBudget],
	["mode arrays are bounded before Zod validation", testCustomModesCountBudget],
	["group arrays are bounded before Zod validation", testModeGroupCountBudget],
	[
		"MCP allowlists use the configured server-count budget",
		testAllowedMcpServerCountBudget,
	],
]

async function main(): Promise<void> {
	const failed = await runSuites("mode-config-bounds", tests)
	if (failed > 0) process.exit(1)
}

main().finally(async () => {
	process.env.HOME = REAL_HOME
	delete process.env.USERPROFILE
	delete process.env.HEADLESSCODE_DATA_DIR
	await fs.rm(ROOT, { recursive: true, force: true })
})
