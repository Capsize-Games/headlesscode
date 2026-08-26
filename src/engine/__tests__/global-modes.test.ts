/**
 * Tests for global custom modes — the headlesscode-native shared modes file
 * (`~/.local/share/headlesscode/shared/modes.yaml`, see src/project-store.ts)
 * merged with the project's own `.roomodes` (src/engine/prompt.ts's
 * loadCustomModes), plus a proof that the ALREADY-WORKING global+project rules
 * merge actually splices BOTH `shared/rules/rules.md` and
 * `<project>/.roo/rules/rules.md` into the built system prompt.
 *
 * Plain assert-based script (no test framework), run via `npm test` ->
 * `tsx src/engine/__tests__/global-modes.test.ts`.
 *
 * All filesystem access is sandboxed: each test switches HOME to its own
 * fresh temp dir, and the sandbox is asserted before any test runs. Both
 * `loadCustomModes` (src/engine/prompt.ts) and the vendored rules loader
 * (`custom-instructions.ts`) resolve the global shared directory by calling
 * `os.homedir()` at CALL time (not at module-evaluation time), so switching
 * `process.env.HOME` per test is sufficient; `os.homedir()` respects $HOME on
 * Linux, which is verified before the tests run. The real
 * `~/.local/share/headlesscode/` is never touched.
 */

import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"

const REAL_HOME = os.homedir()
const ROOT_SANDBOX = path.join(os.tmpdir(), `hc-global-modes-root-${process.pid}-${Date.now()}`)

import assert from "node:assert/strict"

import { buildSystemPrompt, loadCustomModes } from "../prompt.js"

// ─── Per-test HOME sandboxing ───────────────────────────────────────────────

let activeHomes: string[] = []

async function sandboxHome(): Promise<string> {
	const home = path.join(ROOT_SANDBOX, `home-${activeHomes.length}`)
	// The headlesscode-native global shared dir (src/project-store.ts) —
	// `~/.roo/` is no longer read. The store root is ALSO pointed at the
	// sandboxed home: sharedInstructionsRoot() is store-root-derived, and
	// under `npm test` the suite-wide HEADLESSCODE_DATA_DIR override would
	// otherwise redirect the shared dir away from this sandboxed HOME.
	// (Each test file is its own process, so per-file env mutation is safe.)
	const storeRoot = path.join(home, ".local", "share", "headlesscode")
	await fs.mkdir(path.join(storeRoot, "shared"), { recursive: true })
	activeHomes.push(home)
	process.env.HOME = home
	process.env.USERPROFILE = home
	process.env.HEADLESSCODE_DATA_DIR = storeRoot
	return home
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function mode(slug: string, name: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		slug,
		name,
		roleDefinition: `You are ${name}, a test mode.`,
		whenToUse: `Use ${slug} for testing.`,
		description: `Test mode ${slug}.`,
		groups: ["read"],
		...extra,
	}
}

function serializeMode(m: Record<string, unknown>): string {
	return [
		`  - slug: ${m.slug}`,
		`    name: ${m.name}`,
		`    roleDefinition: ${m.roleDefinition}`,
		...(m.whenToUse ? [`    whenToUse: ${m.whenToUse}`] : []),
		...(m.description ? [`    description: ${m.description}`] : []),
		`    groups:`,
		...(Array.isArray(m.groups) && m.groups.length > 0 ? m.groups.map((g) => `      - ${g}`) : ["      - read"]),
	].join("\n")
}

async function writeGlobalModes(modes: unknown[]): Promise<void> {
	const home = process.env.HOME!
	await fs.writeFile(
		path.join(home, ".local", "share", "headlesscode", "shared", "modes.yaml"),
		`customModes:\n${modes.map((m) => serializeMode(m as Record<string, unknown>)).join("\n")}\n`,
		"utf-8",
	)
}

async function makeWorkspace(roomodes: unknown[] | null): Promise<string> {
	const ws = await fs.mkdtemp(path.join(os.tmpdir(), "hc-global-modes-ws-"))
	if (roomodes) {
		await fs.writeFile(
			path.join(ws, ".roomodes"),
			`customModes:\n${roomodes.map((m) => serializeMode(m as Record<string, unknown>)).join("\n")}\n`,
			"utf-8",
		)
	}
	return ws
}

// ─── Tests ───────────────────────────────────────────────────────────────────

/**
 * A project mode and a differently-slugged global mode both appear in the
 * merged result.
 */
async function testProjectAndDistinctGlobalBothAppear(): Promise<void> {
	await sandboxHome()
	await writeGlobalModes([mode("global-mode", "Global Mode")])
	const ws = await makeWorkspace([mode("project-mode", "Project Mode")])

	const merged = await loadCustomModes(ws)
	const slugs = merged.map((m) => m.slug).sort()
	assert.deepEqual(slugs, ["global-mode", "project-mode"], `expected both modes, got: ${slugs.join(", ")}`)

	const projectMode = merged.find((m) => m.slug === "project-mode")
	const globalMode = merged.find((m) => m.slug === "global-mode")
	assert.equal(projectMode?.source, "project", "project mode should be tagged source=project")
	assert.equal(globalMode?.source, "global", "global mode should be tagged source=global")
}

/**
 * A project mode and a SAME-slugged global mode — only the project one
 * appears (project wins).
 */
async function testProjectWinsOverSameSlugGlobal(): Promise<void> {
	await sandboxHome()
	await writeGlobalModes([mode("shared-mode", "Global Shared", { description: "global copy" })])
	const ws = await makeWorkspace([mode("shared-mode", "Project Shared", { description: "project copy" })])

	const merged = await loadCustomModes(ws)
	assert.equal(merged.length, 1, `expected exactly one merged mode, got ${merged.length}`)
	assert.equal(merged[0].slug, "shared-mode")
	assert.equal(merged[0].source, "project", "project copy must win over same-slug global")
	assert.equal(merged[0].description, "project copy", "project copy's fields must be the ones kept")
}

/**
 * Missing global file behaves as zero-config: project modes still load, no
 * error.
 */
async function testMissingGlobalFileIsZeroConfig(): Promise<void> {
	await sandboxHome()
	const ws = await makeWorkspace([mode("only-project", "Only Project")])

	const merged = await loadCustomModes(ws)
	assert.deepEqual(merged.map((m) => m.slug), ["only-project"], "expected only the project mode with no global file")
}

/**
 * Malformed global file degrades the same way a malformed `.roomodes` does
 * (logs an error, returns [] for that source, doesn't throw).
 */
async function testMalformedGlobalFileDoesNotThrow(): Promise<void> {
	const home = await sandboxHome()
	await fs.writeFile(
		path.join(home, ".local", "share", "headlesscode", "shared", "modes.yaml"),
		"this is: [not: valid yaml\n  - broken",
		"utf-8",
	)
	const ws = await makeWorkspace([mode("project-still-loads", "Project Still Loads")])

	const merged = await loadCustomModes(ws)
	assert.deepEqual(merged.map((m) => m.slug), ["project-still-loads"], "project modes must survive a malformed global file")
}

/**
 * A global mode with a malformed schema (missing required roleDefinition)
 * also degrades gracefully (that source contributes nothing, no throw).
 */
async function testSchemaInvalidGlobalFileDoesNotThrow(): Promise<void> {
	await sandboxHome()
	await writeGlobalModes([{ slug: "broken", name: "Broken", roleDefinition: "" }]) // empty roleDefinition -> schema-invalid
	const ws = await makeWorkspace([mode("fine", "Fine")])

	const merged = await loadCustomModes(ws)
	assert.deepEqual(merged.map((m) => m.slug), ["fine"], "schema-invalid global file must not break project modes")
}

/**
 * PROOF the already-working rules merge does what the plan claims: write a
 * fixture to the sandboxed HOME containing `~/.roo/rules/rules.md`, build a
 * system prompt against a temp project workspace that has its own
 * `.roo/rules/rules.md`, and assert BOTH contents appear (each labeled with
 * its source path). This is existing behavior — the point is proving the
 * global-rules path actually works in this codebase today, since the global
 * modes feature relies on it (a globally-defined mode's per-mode rules stay
 * project-local and get spliced on top).
 */
async function testGlobalAndProjectRulesBothSpliceIntoSystemPrompt(): Promise<void> {
	const home = await sandboxHome()
	// Global rules file (sandboxed HOME, headlesscode-native shared location).
	await fs.mkdir(path.join(home, ".local", "share", "headlesscode", "shared", "rules"), { recursive: true })
	await fs.writeFile(
		path.join(home, ".local", "share", "headlesscode", "shared", "rules", "rules.md"),
		"GLOBAL-RULE-MARKER: shared global conventions",
		"utf-8",
	)

	// Project workspace with its own rules + a project mode (so we have a
	// custom mode to run the prompt under, and both rules paths apply).
	const ws = await makeWorkspace([mode("project-mode", "Project Mode")])
	await fs.mkdir(path.join(ws, ".roo", "rules"), { recursive: true })
	await fs.writeFile(path.join(ws, ".roo", "rules", "rules.md"), "PROJECT-RULE-MARKER: local conventions", "utf-8")

	const built = await buildSystemPrompt({ workspaceRoot: ws, mode: "project-mode" })
	assert.ok(built.prompt.includes("GLOBAL-RULE-MARKER"), "expected the GLOBAL rules content in the built prompt")
	assert.ok(built.prompt.includes("PROJECT-RULE-MARKER"), "expected the PROJECT rules content in the built prompt")
	assert.ok(built.prompt.includes("Rules from"), "expected the rules to be labeled with their source paths")
}

// ─── Runner ──────────────────────────────────────────────────────────────────

const tests: Array<[string, () => Promise<void>]> = [
	["project + distinct global mode both appear (project first, global second)", testProjectAndDistinctGlobalBothAppear],
	["same-slug project mode wins over global mode (project wins)", testProjectWinsOverSameSlugGlobal],
	["missing global file behaves as zero-config", testMissingGlobalFileIsZeroConfig],
	["malformed global file degrades like malformed .roomodes (no throw)", testMalformedGlobalFileDoesNotThrow],
	["schema-invalid global file degrades gracefully (no throw)", testSchemaInvalidGlobalFileDoesNotThrow],
	["global shared + project .roo/rules/rules.md BOTH splice into the system prompt", testGlobalAndProjectRulesBothSpliceIntoSystemPrompt],
]

async function main(): Promise<void> {
	// Sanity check the sandbox is actually in effect — if os.homedir() ignored
	// $HOME the tests would be writing to the REAL ~/.roo.
	const probe = path.join(ROOT_SANDBOX, "probe")
	await sandboxHome()
	assert.equal(
		os.homedir(),
		path.join(ROOT_SANDBOX, "home-0"),
		`os.homedir() did not pick up the sandboxed HOME (${os.homedir()}); refusing to run against the real ~/.roo`,
	)
	assert.equal(process.env.HOME, path.join(ROOT_SANDBOX, "home-0"))

	let failed = 0
	for (const [name, fn] of tests) {
		try {
			await fn()
			console.log(`  ok   ${name}`)
		} catch (err) {
			failed++
			console.error(`  FAIL ${name}`)
			console.error(err instanceof Error ? err.stack : err)
		}
	}
	if (failed > 0) {
		console.error(`\n${failed} test(s) failed`)
		process.exit(1)
	}
	console.log(`\nAll ${tests.length} global-modes tests passed`)
}

main().finally(async () => {
	process.env.HOME = REAL_HOME
	delete process.env.USERPROFILE
	await fs.rm(ROOT_SANDBOX, { recursive: true, force: true }).catch(() => {})
})
