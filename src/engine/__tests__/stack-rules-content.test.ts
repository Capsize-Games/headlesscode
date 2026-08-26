/**
 * Tests for the SHIPPED stack-rules content (shared/stacks/<stack>/rules.md):
 * the canonical per-stack rules committed to this repo must exist, be
 * non-empty, and actually load through loadStackRules/buildSystemPrompt when
 * copied into the central store the way scripts/install-cli.sh (and the
 * docker entrypoint) copy it. Guards the content↔infrastructure contract —
 * a content file that stopped loading (or a loader that stopped reading the
 * shipped path) fails here, not just at review time.
 *
 * Plain assert-based script (no test framework), run via `npm test` ->
 * `tsx src/engine/__tests__/stack-rules-content.test.ts`.
 *
 * Filesystem access is sandboxed the same way as stacks.test.ts: each test
 * switches HOME to its own fresh temp dir, so the real
 * `~/.local/share/headlesscode/` is never touched.
 */

import assert from "node:assert/strict"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { fileURLToPath } from "node:url"

const REAL_HOME = os.homedir()
const ROOT_SANDBOX = path.join(os.tmpdir(), `hc-stack-content-${process.pid}-${Date.now()}`)

import { buildSystemPrompt } from "../prompt.js"
import { STACK_RULES_HEADER, getCentralStackRulesDir, loadStackRules } from "../stacks.js"

/** Repo root = 4 levels up from src/engine/__tests__/<this file>. */
const REPO_ROOT = path.resolve(fileURLToPath(import.meta.url), "..", "..", "..", "..")

/** The two stacks whose shipped content is covered here. */
const SHIPPED_STACKS = [
	{ stack: "typescript", fixture: { "tsconfig.json": "{}" }, detectLabel: "typescript" },
	{
		stack: "react",
		fixture: { "package.json": '{ "name": "ui", "version": "0.0.1", "dependencies": { "react": "^18.0.0" } }' },
		detectLabel: "javascript,react",
	},
] as const

// ─── Per-test HOME sandboxing (mirrors stacks.test.ts) ──────────────────────

let activeHomes: string[] = []

async function sandboxHome(): Promise<string> {
	const home = path.join(ROOT_SANDBOX, `home-${activeHomes.length}`)
	await fs.mkdir(home, { recursive: true })
	activeHomes.push(home)
	process.env.HOME = home
	process.env.USERPROFILE = home
	return home
}

// ─── Fixture helpers (mirrors stacks.test.ts) ───────────────────────────────

async function makeProject(files: Record<string, string>): Promise<string> {
	const ws = await fs.mkdtemp(path.join(os.tmpdir(), "hc-stack-content-ws-"))
	for (const [rel, content] of Object.entries(files)) {
		const abs = path.join(ws, rel)
		await fs.mkdir(path.dirname(abs), { recursive: true })
		await fs.writeFile(abs, content, "utf-8")
	}
	return ws
}

/** Copy the repo's shared/stacks tree into the sandboxed central store. */
async function seedCentralFromRepo(home: string): Promise<void> {
	const centralStacks = path.join(getCentralStackRulesDir())
	const repoStacks = path.join(REPO_ROOT, "shared", "stacks")
	await fs.mkdir(path.dirname(centralStacks), { recursive: true })
	await fs.cp(repoStacks, centralStacks, { recursive: true })
}

async function readShipped(stack: string): Promise<string> {
	return (await fs.readFile(path.join(REPO_ROOT, "shared", "stacks", stack, "rules.md"), "utf-8")).trim()
}

// ─── Tests ──────────────────────────────────────────────────────────────────

/** Every shipped rules.md must exist and be non-empty (a deleted/emptied file is a regression). */
async function testShippedContentExistsAndIsNonEmpty(): Promise<void> {
	for (const { stack } of SHIPPED_STACKS) {
		const content = await readShipped(stack)
		assert.ok(content.length > 0, `shared/stacks/${stack}/rules.md must not be empty`)
		assert.ok(
			content.split("\n").length >= 5,
			`shared/stacks/${stack}/rules.md looks too thin for stack rules (${content.split("\n").length} lines)`,
		)
	}
}

/** Each shipped rules.md must load verbatim once seeded into the central store. */
async function testShippedContentLoadsForItsStack(): Promise<void> {
	for (const { stack, fixture, detectLabel } of SHIPPED_STACKS) {
		const home = await sandboxHome()
		await seedCentralFromRepo(home)
		const ws = await makeProject(fixture as Record<string, string>)

		const loaded = await loadStackRules(ws)
		assert.equal(
			[...loaded.stacks].sort().join(","),
			detectLabel,
			`expected ${detectLabel} detected for the ${stack} fixture`,
		)
		const shipped = await readShipped(stack)
		assert.ok(
			loaded.content.includes(shipped),
			`shipped ${stack} rules.md content must be spliced for a ${stack} project`,
		)
		assert.ok(
			loaded.content.includes(`stacks/${stack}/rules.md`),
			`expected the central ${stack} rules.md path labelled in content`,
		)
	}
}

/** A combined TS+React project must splice BOTH shipped files, alphabetically (react < typescript). */
async function testCombinedProjectSplicesBothInOrder(): Promise<void> {
	const home = await sandboxHome()
	await seedCentralFromRepo(home)
	const ws = await makeProject({
		"tsconfig.json": "{}",
		"package.json": '{ "name": "full", "dependencies": { "react": "^18.0.0" } }',
	})

	const built = await buildSystemPrompt({ workspaceRoot: ws, mode: "code" })
	assert.ok(built.prompt.includes(STACK_RULES_HEADER), "expected the stack-rules section header")
	const reactContent = await readShipped("react")
	const tsContent = await readShipped("typescript")
	assert.ok(built.prompt.includes(reactContent), "expected the shipped react rules in the prompt")
	assert.ok(built.prompt.includes(tsContent), "expected the shipped typescript rules in the prompt")
	const reactIdx = built.prompt.indexOf(reactContent)
	const tsIdx = built.prompt.indexOf(tsContent)
	assert.ok(reactIdx !== -1 && tsIdx !== -1)
	assert.ok(reactIdx < tsIdx, "expected react (alphabetically first) spliced before typescript")
}

// ─── Runner ──────────────────────────────────────────────────────────────────

const tests: Array<[string, () => Promise<void>]> = [
	["shipped stack rules exist and are non-empty", testShippedContentExistsAndIsNonEmpty],
	["each shipped rules.md loads for its detected stack", testShippedContentLoadsForItsStack],
	["combined TS+React project splices both shipped files in order", testCombinedProjectSplicesBothInOrder],
]

async function main(): Promise<void> {
	// Sanity check the sandbox is actually in effect — if os.homedir() ignored
	// $HOME the tests would be writing to the REAL ~/.local/share/headlesscode.
	const probe = path.join(ROOT_SANDBOX, "probe")
	await sandboxHome()
	assert.equal(
		os.homedir(),
		path.join(ROOT_SANDBOX, "home-0"),
		`os.homedir() did not pick up the sandboxed HOME (${os.homedir()}); refusing to run against the real home`,
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
	console.log(`\nAll ${tests.length} stack-rules-content tests passed`)
}

main().finally(async () => {
	process.env.HOME = REAL_HOME
	delete process.env.USERPROFILE
	await fs.rm(ROOT_SANDBOX, { recursive: true, force: true }).catch(() => {})
})
