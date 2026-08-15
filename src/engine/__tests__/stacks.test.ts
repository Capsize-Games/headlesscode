/**
 * Tests for stack detection + stack-specific rules splicing
 * (src/engine/stacks.ts): detectStacks against fixture directory trees for
 * each of the 7 stacks (including multi-stack projects and git-tracked
 * sources), loadStackRules precedence/ordering, and the buildSystemPrompt
 * splice gated so zero-config projects behave identically to before.
 *
 * Plain assert-based script (no test framework), run via `npm test` ->
 * `tsx src/engine/__tests__/stacks.test.ts`.
 *
 * Filesystem access is sandboxed the same way as global-modes.test.ts: each
 * test switches HOME to its own fresh temp dir, so the real
 * `~/.local/share/headlesscode/` (which exists on this machine) and the real
 * `~/.roo/` are never touched. `os.homedir()` respects $HOME on Linux, which
 * is probed before the tests run.
 */

import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"

const execFileP = promisify(execFile)

const REAL_HOME = os.homedir()
// The test runner sets $HEADLESSCODE_DATA_DIR globally (scripts/run-tests.mjs
// -> .headlesscode/test-store), and getCentralStackRulesDir() now honors it
// via projectStoreRoot() — remember the original so the per-test sandbox can
// be unwound in the cleanup below.
const REAL_DATA_DIR = process.env.HEADLESSCODE_DATA_DIR
const ROOT_SANDBOX = path.join(os.tmpdir(), `hc-stacks-root-${process.pid}-${Date.now()}`)

import { buildSystemPrompt } from "../prompt.js"
import {
	STACK_NAMES,
	STACK_RULES_HEADER,
	appendStackRulesSection,
	detectStacks,
	getCentralStackRulesFile,
	getCentralStackRulesDir,
	loadStackRules,
} from "../stacks.js"

// ─── Per-test HOME sandboxing (mirrors global-modes.test.ts) ────────────────

let activeHomes: string[] = []

async function sandboxHome(): Promise<string> {
	const home = path.join(ROOT_SANDBOX, `home-${activeHomes.length}`)
	await fs.mkdir(home, { recursive: true })
	activeHomes.push(home)
	process.env.HOME = home
	process.env.USERPROFILE = home
	// getCentralStackRulesDir() resolves through projectStoreRoot(), which
	// honors $HEADLESSCODE_DATA_DIR — and the test runner sets it globally.
	// Point it at a per-test scratch dir so the central stack-rules store is
	// isolated per test just like $HOME is.
	process.env.HEADLESSCODE_DATA_DIR = path.join(ROOT_SANDBOX, `data-${activeHomes.length - 1}`)
	return home
}

// ─── Fixture helpers ─────────────────────────────────────────────────────────

async function makeProject(files: Record<string, string>): Promise<string> {
	const ws = await fs.mkdtemp(path.join(os.tmpdir(), "hc-stacks-ws-"))
	for (const [rel, content] of Object.entries(files)) {
		const abs = path.join(ws, rel)
		await fs.mkdir(path.dirname(abs), { recursive: true })
		await fs.writeFile(abs, content, "utf-8")
	}
	return ws
}

/** Real git repo fixture — exercises the `git ls-files` detection path. */
async function makeGitProject(files: Record<string, string>): Promise<string> {
	const ws = await fs.mkdtemp(path.join(os.tmpdir(), "hc-stacks-git-"))
	await execFileP("git", ["init", "-q"], { cwd: ws })
	await makeProjectFilesInto(ws, files)
	await execFileP("git", ["add", "-A"], { cwd: ws })
	await execFileP(
		"git",
		["-c", "user.email=test@example.com", "-c", "user.name=stack-test", "commit", "-q", "-m", "init"],
		{ cwd: ws },
	)
	return ws
}

async function makeProjectFilesInto(ws: string, files: Record<string, string>): Promise<void> {
	for (const [rel, content] of Object.entries(files)) {
		const abs = path.join(ws, rel)
		await fs.mkdir(path.dirname(abs), { recursive: true })
		await fs.writeFile(abs, content, "utf-8")
	}
}

function sorted(stacks: ReadonlySet<string>): string {
	return [...stacks].sort().join(",")
}

async function writeCentralStackRules(stack: string, content: string): Promise<void> {
	const file = path.join(getCentralStackRulesDir(), stack, "rules.md")
	await fs.mkdir(path.dirname(file), { recursive: true })
	await fs.writeFile(file, content, "utf-8")
}

// ─── detectStacks tests ──────────────────────────────────────────────────────

/** Empty project matches no stacks. */
async function testEmptyProjectHasNoStacks(): Promise<void> {
	await sandboxHome()
	const ws = await makeProject({})
	const stacks = await detectStacks(ws)
	assert.equal(stacks.size, 0, `expected no stacks for an empty project, got: ${sorted(stacks)}`)
}

/** A missing/unreadable workspace root is non-fatal and matches nothing. */
async function testMissingWorkspaceIsEmpty(): Promise<void> {
	await sandboxHome()
	const stacks = await detectStacks(path.join(ROOT_SANDBOX, "does-not-exist"))
	assert.equal(stacks.size, 0, `expected no stacks for a missing root, got: ${sorted(stacks)}`)
}

async function testTypeScriptDetection(): Promise<void> {
	await sandboxHome()
	// Via tsconfig.json.
	const ws1 = await makeProject({ "tsconfig.json": "{}" })
	assert.equal(sorted(await detectStacks(ws1)), "typescript", "tsconfig.json should detect typescript")

	// Via a tracked .tsx file alone (no tsconfig).
	const ws2 = await makeProject({ "src/component.tsx": "export const a = 1\n" })
	assert.equal(sorted(await detectStacks(ws2)), "typescript", "a .tsx file alone should detect typescript")
}

async function testJavaScriptDetection(): Promise<void> {
	await sandboxHome()
	const ws = await makeProject({ "package.json": '{ "name": "x", "version": "0.0.1" }\n' })
	assert.equal(sorted(await detectStacks(ws)), "javascript", "package.json should detect javascript")
}

async function testPythonDetection(): Promise<void> {
	await sandboxHome()
	// Via pyproject.toml.
	const ws1 = await makeProject({ "pyproject.toml": "[project]\nname = \"x\"\n" })
	assert.equal(sorted(await detectStacks(ws1)), "python", "pyproject.toml should detect python")

	// Via requirements*.txt.
	const ws2 = await makeProject({ "requirements-dev.txt": "requests==2.0.0\n" })
	assert.equal(sorted(await detectStacks(ws2)), "python", "requirements*.txt should detect python")

	// Via a .py file alone.
	const ws3 = await makeProject({ "src/app.py": "print(1)\n" })
	assert.equal(sorted(await detectStacks(ws3)), "python", "a .py file alone should detect python")
}

async function testReactDetection(): Promise<void> {
	await sandboxHome()
	const ws = await makeProject({
		"package.json": '{ "name": "ui", "version": "0.0.1", "dependencies": { "react": "^18.0.0" } }\n',
	})
	assert.equal(sorted(await detectStacks(ws)), "javascript,react", "react dep should add react to javascript")
}

async function testFastApiDetection(): Promise<void> {
	await sandboxHome()
	const ws = await makeProject({ "requirements.txt": "fastapi[all]==0.100.0\nuvicorn\n" })
	assert.equal(sorted(await detectStacks(ws)), "fastapi,python", "fastapi in requirements should detect fastapi + python")

	const ws2 = await makeProject({ "pyproject.toml": '[project]\ndependencies = ["fastapi==0.100"]\n' })
	assert.equal(sorted(await detectStacks(ws2)), "fastapi,python", "fastapi in pyproject should detect fastapi + python")
}

async function testPostgresDriverDetection(): Promise<void> {
	await sandboxHome()
	for (const driver of ["psycopg2", "psycopg", "asyncpg"]) {
		const ws = await makeProject({ "requirements.txt": `${driver}==1.0.0\n` })
		assert.equal(
			sorted(await detectStacks(ws)),
			"postgresql,python",
			`${driver} in requirements should detect postgresql + python`,
		)
	}
}

async function testPostgresComposeDetection(): Promise<void> {
	await sandboxHome()
	const compose = "services:\n  db:\n    image: postgres:16\n  app:\n    image: myapp:latest\n"
	const ws = await makeProject({ "docker-compose.yml": compose })
	assert.equal(sorted(await detectStacks(ws)), "postgresql", "a postgres-image compose service should detect postgresql")
}

async function testPostgresMigrationsDetection(): Promise<void> {
	await sandboxHome()
	const ws = await makeProject({ "migrations/001_init.sql": "CREATE TABLE t (id int);\n" })
	assert.equal(sorted(await detectStacks(ws)), "postgresql", "a migrations dir with .sql files should detect postgresql")

	// Alembic migration scripts are .py files — the project is Python AND
	// uses Postgres, so both stacks are correctly detected.
	const ws2 = await makeProject({ "alembic/versions/0001.py": "revision = '0001'\n" })
	assert.equal(sorted(await detectStacks(ws2)), "postgresql,python", "an alembic dir should detect postgresql + python")
}

async function testCppDetection(): Promise<void> {
	await sandboxHome()
	const ws1 = await makeProject({ "CMakeLists.txt": "cmake_minimum_required(VERSION 3.20)\n" })
	assert.equal(sorted(await detectStacks(ws1)), "cpp", "CMakeLists.txt should detect cpp")

	const ws2 = await makeProject({ "src/main.cpp": "int main() { return 0; }\n" })
	assert.equal(sorted(await detectStacks(ws2)), "cpp", "a .cpp file alone should detect cpp")
}

/** A project can match ALL stacks at once. */
async function testMultiStackProject(): Promise<void> {
	await sandboxHome()
	const ws = await makeProject({
		"tsconfig.json": "{}",
		"package.json": '{ "name": "full", "dependencies": { "react": "^18.0.0" } }',
		"pyproject.toml": '[project]\ndependencies = ["fastapi==0.100"]\n',
		"requirements.txt": "asyncpg==0.28.0\n",
		"docker-compose.yml": "services:\n  db:\n    image: postgres:16\n",
		"CMakeLists.txt": "cmake_minimum_required(VERSION 3.20)\n",
		"migrations/001_init.sql": "CREATE TABLE t (id int);\n",
	})
	assert.equal(
		sorted(await detectStacks(ws)),
		STACK_NAMES.join(","),
		"expected ALL 7 stacks for the multi-stack fixture",
	)
}

/** Git-tracked sources are honored and gitignored dirs (node_modules) are not. */
async function testGitTrackedDetection(): Promise<void> {
	await sandboxHome()
	const ws = await makeGitProject({
		".gitignore": "node_modules\n",
		"src/app.ts": "export const x = 1\n",
		"node_modules/dep.py": "print('ignored')\n",
	})
	const stacks = await detectStacks(ws)
	assert.equal(sorted(stacks), "typescript", "tracked .ts should detect typescript")
	assert.ok(!stacks.has("python"), "a .py under gitignored node_modules must NOT detect python")
}

/** The non-git walk also skips heavy/irrelevant dirs like node_modules. */
async function testWalkSkipsNodeModules(): Promise<void> {
	await sandboxHome()
	const ws = await makeProject({ "node_modules/dep.py": "print('ignored')\n", "src/main.ts": "export const x = 1\n" })
	const stacks = await detectStacks(ws)
	assert.equal(sorted(stacks), "typescript", "node_modules content must not count (walk path)")
	assert.ok(!stacks.has("python"), "node_modules .py must not detect python (walk path)")
}

/** S4: detectStacks memoizes per root and invalidates on root mtime change. */
async function testDetectStacksCacheSameRootAndInvalidation(): Promise<void> {
	await sandboxHome()
	// (a) Same unchanged root → repeat calls return equal results (cached).
	const ws = await makeProject({ "tsconfig.json": "{}" })
	const first = await detectStacks(ws)
	const second = await detectStacks(ws)
	assert.equal(sorted(first), "typescript", "first detection finds typescript")
	assert.equal(sorted(second), sorted(first), "repeat detection on an unchanged root returns the same stacks")

	// (b) A new root-level stack-signal file added AFTER the first call is
	// picked up on the next call — the root mtime bump invalidates the cache.
	const ws2 = await makeProject({ "tsconfig.json": "{}" })
	assert.equal(sorted(await detectStacks(ws2)), "typescript", "no cpp before the signal file exists")
	await fs.writeFile(path.join(ws2, "CMakeLists.txt"), "cmake_minimum_required(VERSION 3.20)\n")
	// Bump the root mtime explicitly so coarse-mtime filesystems still invalidate.
	const future = new Date(Date.now() + 5_000)
	await fs.utimes(ws2, future, future)
	const after = await detectStacks(ws2)
	assert.equal(sorted(after), "cpp,typescript", "adding CMakeLists.txt must invalidate the cache and detect cpp")
}

// ─── loadStackRules tests ────────────────────────────────────────────────────

/** No central dir and no project rules-stack-* dir -> empty content, no detection cost. */
async function testNoRulesSourceIsZeroConfig(): Promise<void> {
	await sandboxHome()
	const ws = await makeProject({ "package.json": '{ "name": "x" }' })
	const loaded = await loadStackRules(ws)
	assert.equal(loaded.content, "", "expected empty stack-rules content with no rules source")
	assert.equal(loaded.stacks.size, 0, "expected no stacks reported with no rules source")
}

/** Central rules.md for a detected stack is loaded with its source label. */
async function testCentralStackRulesLoaded(): Promise<void> {
	await sandboxHome()
	await writeCentralStackRules("python", "PY-CENTRAL-MARKER: global python conventions")
	const ws = await makeProject({ "pyproject.toml": "[project]\nname = \"x\"\n" })

	const loaded = await loadStackRules(ws)
	assert.equal(sorted(loaded.stacks), "python", "expected python detected")
	assert.ok(loaded.content.includes("PY-CENTRAL-MARKER"), "expected central python rules in content")
	// The label must be the engine's OWN central path — under the per-test
	// $HEADLESSCODE_DATA_DIR sandbox, never the real ~/.local/share/headlesscode.
	const centralFile = getCentralStackRulesFile("python")
	assert.ok(loaded.content.includes(centralFile), "expected the central file path labelled in content")
	assert.ok(
		!loaded.content.includes(path.join(REAL_HOME, ".local", "share", "headlesscode")),
		"central rules must never be read from the real home store",
	)
}

/**
 * The $HEADLESSCODE_DATA_DIR override redirects the central stacks dir, and
 * content installed there (the path scripts/install-cli.sh ships to) is
 * actually spliced — regression guard for the shipped-content guarantee.
 */
async function testCentralStackRulesHonorDataDirOverride(): Promise<void> {
	const home = await sandboxHome()
	// The install script writes to $HEADLESSCODE_DATA_DIR/shared/stacks when
	// the override is set; the runtime must read from THAT dir, not the
	// $HOME-derived default (the review finding on install-cli.sh).
	const overrideRoot = path.join(ROOT_SANDBOX, `data-override-${activeHomes.length}`, "store")
	const centralFile = path.join(overrideRoot, "shared", "stacks", "python", "rules.md")
	await fs.mkdir(path.dirname(centralFile), { recursive: true })
	await fs.writeFile(centralFile, "PY-OVERRIDE-MARKER: shipped under the data-dir override", "utf-8")
	process.env.HEADLESSCODE_DATA_DIR = overrideRoot

	assert.equal(
		getCentralStackRulesDir(),
		path.join(overrideRoot, "shared", "stacks"),
		"getCentralStackRulesDir() must resolve through the $HEADLESSCODE_DATA_DIR override",
	)
	assert.notEqual(
		getCentralStackRulesDir(),
		path.join(home, ".local", "share", "headlesscode", "shared", "stacks"),
		"the override must NOT fall back to the $HOME-derived default",
	)

	const ws = await makeProject({ "pyproject.toml": "[project]\nname = \"x\"\n" })
	const loaded = await loadStackRules(ws)
	assert.equal(sorted(loaded.stacks), "python", "expected python detected")
	assert.ok(
		loaded.content.includes("PY-OVERRIDE-MARKER"),
		"rules installed under the $HEADLESSCODE_DATA_DIR override must be spliced into the prompt",
	)
	assert.ok(
		loaded.content.includes(centralFile),
		"expected the override-path central file labelled in content",
	)
}

/** Project-local .roo/rules-stack-<stack>/rules.md is loaded with its label. */
async function testProjectStackRulesLoaded(): Promise<void> {
	await sandboxHome()
	const ws = await makeProject({
		"pyproject.toml": "[project]\nname = \"x\"\n",
		".roo/rules-stack-python/rules.md": "PY-PROJECT-MARKER: local python conventions",
	})

	const loaded = await loadStackRules(ws)
	assert.equal(sorted(loaded.stacks), "python", "expected python detected")
	assert.ok(loaded.content.includes("PY-PROJECT-MARKER"), "expected project-local python rules in content")
	assert.ok(
		loaded.content.includes(".roo/rules-stack-python/rules.md"),
		"expected the project-local file path labelled in content",
	)
}

/** Central + project for the same stack are both spliced, central first. */
async function testCentralThenProjectOrder(): Promise<void> {
	await sandboxHome()
	await writeCentralStackRules("python", "PY-CENTRAL-MARKER")
	const ws = await makeProject({
		"pyproject.toml": "[project]\nname = \"x\"\n",
		".roo/rules-stack-python/rules.md": "PY-PROJECT-MARKER",
	})

	const loaded = await loadStackRules(ws)
	const centralIdx = loaded.content.indexOf("PY-CENTRAL-MARKER")
	const projectIdx = loaded.content.indexOf("PY-PROJECT-MARKER")
	assert.ok(centralIdx !== -1 && projectIdx !== -1, "expected both central and project rules present")
	assert.ok(centralIdx < projectIdx, "expected central rules before project rules")
}

/** Stacks with no rules.md contribute nothing (even when detected). */
async function testDetectedButNoRulesIsEmpty(): Promise<void> {
	await sandboxHome()
	const ws = await makeProject({ "package.json": '{ "name": "x", "dependencies": { "react": "^18" } }' })
	const loaded = await loadStackRules(ws)
	assert.equal(loaded.content, "", "expected empty content when detected stacks have no rules.md")
}

/** The repo's SHIPPED stack-rules content (shared/stacks/<stack>/rules.md) must
 * stay present and non-empty — this is the "ships with headlesscode" central
 * tier that scripts/sync-stack-rules.sh installs into the machine-global
 * store. Guards against a future refactor silently dropping the content these
 * stack-rules content issues shipped. Reads repo-relative files only (the
 * per-test HOME sandbox above is about the machine store, not the repo). */
async function testShippedStackRulesContent(): Promise<void> {
	await sandboxHome()
	const repoRoot = path.resolve(fileURLToPath(new URL("../../../", import.meta.url)))
	const shippedDir = path.join(repoRoot, "shared", "stacks")
	const entries = await fs.readdir(shippedDir, { withFileTypes: true })
	const shippedStacks = entries
		.filter((e) => e.isDirectory())
		.map((e) => e.name)
		.sort()
	assert.ok(shippedStacks.length > 0, "expected at least one shipped stack under shared/stacks/")

	for (const stack of shippedStacks) {
		assert.ok(
			(STACK_NAMES as readonly string[]).includes(stack),
			`shared/stacks/${stack} is not a known stack name`,
		)
		const content = await fs.readFile(path.join(shippedDir, stack, "rules.md"), "utf-8")
		assert.ok(content.trim().length > 0, `shared/stacks/${stack}/rules.md must be non-empty`)
	}

	// The FastAPI + PostgreSQL stack rules shipped by this round (issues #10
	// and #11) must be present.
	assert.ok(shippedStacks.includes("fastapi"), "expected shipped FastAPI stack rules (issue #10)")
	assert.ok(shippedStacks.includes("postgresql"), "expected shipped PostgreSQL stack rules (issue #11)")
}

/** The install→read round trip must ACTUALLY work: run the repo's
 * scripts/sync-shared-rules.sh under a scratch $HEADLESSCODE_DATA_DIR (the way
 * scripts/install-cli.sh invokes it), then load the shipped rules through the
 * ENGINE with the same env and confirm they splice. Guards the #10/#11
 * shipping path against the script and the engine silently diverging on the
 * store root — the $HEADLESSCODE_DATA_DIR divergence this round fixed (the
 * script used to install to the override while the engine read
 * ~/.local/share/headlesscode, so shipped content never spliced). */
async function testInstallToReadRoundTrip(): Promise<void> {
	await sandboxHome() // sandboxes $HOME AND $HEADLESSCODE_DATA_DIR per test
	const repoRoot = path.resolve(fileURLToPath(new URL("../../../", import.meta.url)))
	const syncScript = path.join(repoRoot, "scripts", "sync-shared-rules.sh")
	assert.ok((await fs.stat(syncScript)).isFile(), "expected scripts/sync-shared-rules.sh in the repo")

	// 1. Install the shipped content exactly the way install-cli.sh does
	//    (inherits the sandboxed env: HOME + HEADLESSCODE_DATA_DIR).
	await execFileP("bash", [syncScript], { cwd: repoRoot })

	// 2. The engine must read EXACTLY where the script wrote.
	const dataDir = path.join(ROOT_SANDBOX, `data-${activeHomes.length - 1}`)
	assert.equal(
		getCentralStackRulesDir(),
		path.join(dataDir, "shared", "stacks"),
		"engine central dir must equal the sync script's install target under $HEADLESSCODE_DATA_DIR",
	)
	for (const stack of ["fastapi", "postgresql"]) {
		const installed = await fs.readFile(path.join(getCentralStackRulesDir(), stack, "rules.md"), "utf-8")
		assert.ok(installed.trim().length > 0, `sync must install a non-empty ${stack}/rules.md`)
	}

	// 3. A real engine load with the same env must splice the shipped content.
	const fastapiWs = await makeProject({ "requirements.txt": "fastapi[all]==0.100.0\n" })
	const fastapiLoaded = await loadStackRules(fastapiWs)
	assert.ok(
		fastapiLoaded.content.includes("Stack rules: FastAPI"),
		"shipped FastAPI rules must splice through the engine after sync",
	)
	assert.ok(
		fastapiLoaded.content.includes(getCentralStackRulesFile("fastapi")),
		"spliced FastAPI rules must be labelled with the engine's central path",
	)

	const pgWs = await makeProject({ "requirements.txt": "asyncpg==0.28.0\n" })
	const pgLoaded = await loadStackRules(pgWs)
	assert.ok(
		pgLoaded.content.includes("Stack rules: PostgreSQL"),
		"shipped PostgreSQL rules must splice through the engine after sync",
	)
}

// ─── buildSystemPrompt splice tests ──────────────────────────────────────────

/** Zero-config: no stacks / no rules -> prompt is byte-identical across builds and has no stack section. */
async function testZeroConfigPromptUnchanged(): Promise<void> {
	await sandboxHome()
	const ws = await makeProject({})

	const first = await buildSystemPrompt({ workspaceRoot: ws, mode: "code" })
	const second = await buildSystemPrompt({ workspaceRoot: ws, mode: "code" })
	assert.equal(first.prompt, second.prompt, "two zero-config builds must be byte-identical")
	assert.ok(
		!first.prompt.includes(STACK_RULES_HEADER),
		"zero-config prompt must not contain the stack-rules header",
	)

	// A stack-ful project with no rules source also gets no section.
	const ws2 = await makeProject({ "package.json": '{ "name": "x" }' })
	const built = await buildSystemPrompt({ workspaceRoot: ws2, mode: "code" })
	assert.ok(!built.prompt.includes(STACK_RULES_HEADER), "stack-ful project without rules must not get a section")
}

/** Stack rules are spliced in alphabetical stack order with a clear header. */
async function testStackRulesSplicedAlphabetically(): Promise<void> {
	await sandboxHome()
	await writeCentralStackRules("python", "PY-STACK-MARKER: global python rules")
	await writeCentralStackRules("typescript", "TS-STACK-MARKER: global typescript rules")
	const ws = await makeProject({
		"pyproject.toml": "[project]\nname = \"x\"\n",
		"tsconfig.json": "{}",
	})

	const built = await buildSystemPrompt({ workspaceRoot: ws, mode: "code" })
	assert.ok(built.prompt.includes(STACK_RULES_HEADER), "expected the stack-rules section header")
	assert.ok(built.prompt.includes("PY-STACK-MARKER"), "expected python stack rules in the prompt")
	assert.ok(built.prompt.includes("TS-STACK-MARKER"), "expected typescript stack rules in the prompt")
	assert.ok(
		built.prompt.includes("detected as using the following stack(s): python, typescript"),
		"expected alphabetical detected-stack list in the header",
	)
	const pyIdx = built.prompt.indexOf("PY-STACK-MARKER")
	const tsIdx = built.prompt.indexOf("TS-STACK-MARKER")
	assert.ok(pyIdx !== -1 && tsIdx !== -1)
	assert.ok(pyIdx < tsIdx, "expected python (alphabetically first) spliced before typescript")
}

// ─── appendStackRulesSection unit test ───────────────────────────────────────

async function testAppendSectionFormat(): Promise<void> {
	await sandboxHome()
	const out = appendStackRulesSection("base-prompt", "# Rules from /x:\nCONTENT", new Set(["python", "typescript"]))
	assert.ok(out.startsWith("base-prompt"), "section must append to the prompt")
	assert.ok(out.includes(STACK_RULES_HEADER), "section must carry the header")
	assert.ok(out.includes("CONTENT"), "section must carry the rules content")
	assert.ok(out.includes("python, typescript"), "section must list detected stacks alphabetically")
}

// ─── Runner ──────────────────────────────────────────────────────────────────

const tests: Array<[string, () => Promise<void>]> = [
	["empty project matches no stacks", testEmptyProjectHasNoStacks],
	["missing workspace root is non-fatal (empty set)", testMissingWorkspaceIsEmpty],
	["typescript via tsconfig.json or .ts/.tsx files", testTypeScriptDetection],
	["javascript via package.json", testJavaScriptDetection],
	["python via pyproject.toml / requirements*.txt / .py", testPythonDetection],
	["react via package.json dependencies", testReactDetection],
	["fastapi via requirements/pyproject deps", testFastApiDetection],
	["postgresql via psycopg/psycopg2/asyncpg drivers", testPostgresDriverDetection],
	["postgresql via docker-compose postgres image", testPostgresComposeDetection],
	["postgresql via migrations/alembic dirs", testPostgresMigrationsDetection],
	["cpp via CMakeLists.txt or .cpp files", testCppDetection],
	["multi-stack project detects all 7 stacks", testMultiStackProject],
	["git-tracked sources honored, gitignored dirs excluded", testGitTrackedDetection],
	["non-git walk skips node_modules", testWalkSkipsNodeModules],
	["detectStacks cache: same root repeats equal; new root-level signal file invalidates (S4)", testDetectStacksCacheSameRootAndInvalidation],
	["no rules source is zero-config (empty content, no detection)", testNoRulesSourceIsZeroConfig],
	["central stack rules loaded with source label", testCentralStackRulesLoaded],
	["central stack rules honor the $HEADLESSCODE_DATA_DIR override", testCentralStackRulesHonorDataDirOverride],
	["project-local rules-stack-<stack> loaded with source label", testProjectStackRulesLoaded],
	["central rules splice before project rules for the same stack", testCentralThenProjectOrder],
	["detected stacks with no rules.md contribute nothing", testDetectedButNoRulesIsEmpty],
	["shipped shared/stacks content is present and non-empty", testShippedStackRulesContent],
	["install-to-read round trip under HEADLESSCODE_DATA_DIR", testInstallToReadRoundTrip],
	["zero-config prompt unchanged (byte-identical, no section)", testZeroConfigPromptUnchanged],
	["stack rules spliced alphabetically with header", testStackRulesSplicedAlphabetically],
	["appendStackRulesSection format", testAppendSectionFormat],
]

async function main(): Promise<void> {
	// Sanity check the sandbox is actually in effect — if os.homedir() ignored
	// $HOME, or the store-root override didn't land under the sandbox, the
	// tests would be writing to the REAL ~/.local/share/headlesscode.
	const probe = path.join(ROOT_SANDBOX, "probe")
	await sandboxHome()
	assert.equal(
		os.homedir(),
		path.join(ROOT_SANDBOX, "home-0"),
		`os.homedir() did not pick up the sandboxed HOME (${os.homedir()}); refusing to run against the real home`,
	)
	assert.equal(process.env.HOME, path.join(ROOT_SANDBOX, "home-0"))
	// Same guard for the data-dir override: getCentralStackRulesDir() reads it
	// via projectStoreRoot(), so a missed override would write to the REAL
	// (or the runner's shared test) store.
	assert.equal(
		process.env.HEADLESSCODE_DATA_DIR,
		path.join(ROOT_SANDBOX, "data-0"),
		"HEADLESSCODE_DATA_DIR must be sandboxed per test",
	)
	assert.equal(
		getCentralStackRulesDir(),
		path.join(ROOT_SANDBOX, "data-0", "shared", "stacks"),
		"getCentralStackRulesDir() must resolve under the per-test data dir",
	)

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
	console.log(`\nAll ${tests.length} stack-rules tests passed`)
}

main().finally(async () => {
	process.env.HOME = REAL_HOME
	delete process.env.USERPROFILE
	if (REAL_DATA_DIR === undefined) {
		delete process.env.HEADLESSCODE_DATA_DIR
	} else {
		process.env.HEADLESSCODE_DATA_DIR = REAL_DATA_DIR
	}
	await fs.rm(ROOT_SANDBOX, { recursive: true, force: true }).catch(() => {})
})
