/**
 * Shell-level tests for the mode-models-first-spawn fix in
 * scripts/spawn-parallel-worktrees.sh: a worker's FIRST spawn must resolve
 * its model via resolveModelForMode (src/config/mode-models.ts) and pass the
 * result to run-worker.sh as `--model` — not only on rework re-spawns.
 *
 * These run the REAL spawn script end-to-end against a throwaway fixture git
 * repo (the scripts/e2e-phase2 [5/9] pattern), with HEADLESSCODE_ROOT pointed
 * at the REAL headlesscode repo (this worktree has src/config/mode-models.ts)
 * and HEADLESSCODE_CLI stubbed to `echo` so no LLM/API key is needed —
 * run-worker.sh's harness.log then captures the exact CLI args and we assert
 * on the `--model` flag.
 *
 * Plain assert-based (no framework, no network), matching the repo test
 * style. Run via `npm test` ->
 * `tsx src/orchestrator/__tests__/spawn-model.test.ts`.
 */

import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import * as fs from "node:fs"
import * as fsPromises from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { fileURLToPath } from "node:url"

/** This repo root (parent of src/orchestrator/__tests__/). */
const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url))
const SPAWN_SCRIPT = path.join(REPO_ROOT, "scripts", "spawn-parallel-worktrees.sh")

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

async function makeFixture(modeModels: Record<string, string> | null): Promise<string> {
	const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "headlesscode-spawn-model-"))
	try {
		execFileSync("git", ["init", "-q", "-b", "main", dir], { stdio: "ignore" })
	} catch {
		execFileSync("git", ["init", "-q", dir], { stdio: "ignore" })
	}
	await fsPromises.mkdir(path.join(dir, "src"), { recursive: true })
	await fsPromises.mkdir(path.join(dir, "plans", "parallel-tasks"), { recursive: true })
	await fsPromises.writeFile(path.join(dir, "src", "a.js"), "module.exports = 1\n", "utf-8")
	await fsPromises.writeFile(
		path.join(dir, "plans", "parallel-tasks", "task.md"),
		"## assignment\nno-op fixture task\n",
		"utf-8",
	)
	if (modeModels !== null) {
		await fsPromises.mkdir(path.join(dir, ".headlesscode"), { recursive: true })
		await fsPromises.writeFile(
			path.join(dir, ".headlesscode", "mode-models.json"),
			JSON.stringify(modeModels, null, 2) + "\n",
			"utf-8",
		)
	}
	execFileSync("git", ["-C", dir, "add", "-A"], { stdio: "ignore" })
	execFileSync(
		"git",
		["-C", dir, "-c", "user.name=Headlesscode SpawnModel", "-c", "user.email=spawn-model@headlesscode.invalid",
			"-c", "commit.gpgsign=false", "commit", "-q", "-m", "fixture"],
		{ stdio: "ignore" },
	)
	// The spawner branches off origin/master (falling back to local master).
	execFileSync("git", ["-C", dir, "branch", "-M", "master"], { stdio: "ignore" })
	return dir
}

/** Run the REAL spawn script against a fixture; returns its stdout + the worktree path. */
function runSpawn(fixture: string, spec: string, extraEnv: Record<string, string>): { out: string; wtPath: string } {
	const env: NodeJS.ProcessEnv = {
		...process.env,
		PATH: process.env.PATH ?? "",
		HOME: process.env.HOME ?? "",
		TARGET_REPO: fixture,
		// CRITICAL: the REAL repo — the script's HARNESS_ROOT must resolve
		// src/config/mode-models.ts (npx tsx -e imports it by relative path).
		HEADLESSCODE_ROOT: REPO_ROOT,
		// Stub the CLI so no real worker/LLM runs; run-worker.sh's harness.log
		// then shows the exact args (incl. --model) we assert on.
		HEADLESSCODE_CLI: "echo",
		// These tests exercise MODEL RESOLUTION, not the index — the fixtures
		// have no codebase-search index, so bypass the spawner's no-index
		// guardrail (P1.4) exactly like scripts/e2e-phase2/run.sh does.
		ALLOW_UNINDEXED: "1",
		// Never let an outer SPAWN_MODEL leak into a test it does not belong to.
		SPAWN_MODEL: "",
		// The calling shell may have OPENROUTER_MODEL set (the harness runs
		// with one); each test decides explicitly whether it is set.
		OPENROUTER_MODEL: "",
		...extraEnv,
	}
	const out = execFileSync("bash", [SPAWN_SCRIPT, spec], { env, encoding: "utf-8" })
	return { out, wtPath: path.join(fixture, ".worktrees", spec.split(":")[0]) }
}

async function waitForDone(wtPath: string, timeoutMs = 15000): Promise<void> {
	const deadline = Date.now() + timeoutMs
	while (Date.now() < deadline) {
		if (fs.existsSync(path.join(wtPath, ".harness.done"))) {
			return
		}
		await sleep(100)
	}
	throw new Error(`worker did not complete within ${timeoutMs}ms (no .harness.done at ${wtPath})`)
}

async function cleanupFixture(fixture: string, wtName: string): Promise<void> {
	// Issue #20: kill the worker's WHOLE process group, not just the wrapper
	// PID — the wrapper is now a setsid group leader and its children would
	// otherwise survive the cleanup (run-worker.sh writes .harness.pgid).
	const pgidFile = path.join(fixture, ".worktrees", wtName, ".harness.pgid")
	const pidFile = path.join(fixture, ".worktrees", wtName, ".harness.pid")
	for (const file of [pgidFile, pidFile]) {
		if (fs.existsSync(file)) {
			try {
				const pid = Number(fs.readFileSync(file, "utf-8"))
				// Negative pid = the whole process group; a plain pid otherwise.
				process.kill(file === pgidFile ? -pid : pid, "SIGKILL")
			} catch {
				/* worker already gone */
			}
		}
	}
	try {
		execFileSync("git", ["-C", fixture, "worktree", "remove", "--force", path.join(fixture, ".worktrees", wtName)], {
			stdio: "ignore",
		})
	} catch {
		/* worktree not registered (spawn failed early) — rm -rf below cleans up */
	}
	await fsPromises.rm(fixture, { recursive: true, force: true })
}

// ─── A mode-models.json entry reaches run-worker.sh on the FIRST spawn ───────

async function testFirstSpawnUsesModeModelsEntry(): Promise<void> {
	const fixture = await makeFixture({ code: "deepseek/deepseek-fake-code-model" })
	try {
		const { out, wtPath } = runSpawn(fixture, "mm-a:0:plans/parallel-tasks/task.md", {})
		assert.ok(
			out.includes("model: deepseek/deepseek-fake-code-model"),
			`spawn output reports the resolved model, got:\n${out}`,
		)
		await waitForDone(wtPath)
		const log = await fsPromises.readFile(path.join(wtPath, "harness.log"), "utf-8")
		assert.ok(
			log.includes("--model deepseek/deepseek-fake-code-model"),
			`run-worker.sh received the resolved model on the first spawn, harness.log:\n${log}`,
		)
	} finally {
		await cleanupFixture(fixture, "mm-a")
	}
}

// ─── Regression: no config -> the blanket OPENROUTER_MODEL override is unchanged ──

async function testNoConfigKeepsBlanketEnvOverride(): Promise<void> {
	const fixture = await makeFixture(null)
	try {
		const { wtPath } = runSpawn(fixture, "mm-b:0:plans/parallel-tasks/task.md", {
			OPENROUTER_MODEL: "deepseek/deepseek-env-model",
		})
		await waitForDone(wtPath)
		const log = await fsPromises.readFile(path.join(wtPath, "harness.log"), "utf-8")
		assert.ok(
			log.includes("--model deepseek/deepseek-env-model"),
			`the blanket OPENROUTER_MODEL override still reaches run-worker.sh with no mode-models.json, harness.log:\n${log}`,
		)
	} finally {
		await cleanupFixture(fixture, "mm-b")
	}
}

// ─── SPAWN_MODEL (the shell-level --model equivalent) still beats the file ───

async function testSpawnModelOverrideBeatsConfig(): Promise<void> {
	const fixture = await makeFixture({ code: "deepseek/deepseek-from-file" })
	try {
		const { wtPath } = runSpawn(fixture, "mm-c:0:plans/parallel-tasks/task.md", {
			SPAWN_MODEL: "deepseek/deepseek-override-model",
		})
		await waitForDone(wtPath)
		const log = await fsPromises.readFile(path.join(wtPath, "harness.log"), "utf-8")
		assert.ok(
			log.includes("--model deepseek/deepseek-override-model"),
			`SPAWN_MODEL wins over the config file, harness.log:\n${log}`,
		)
	} finally {
		await cleanupFixture(fixture, "mm-c")
	}
}

// ─── Nothing configured + nothing in env -> no --model flag at all ──────────

async function testNoModelAddsNoFlag(): Promise<void> {
	const fixture = await makeFixture(null)
	try {
		const { wtPath } = runSpawn(fixture, "mm-d:0:plans/parallel-tasks/task.md", {})
		await waitForDone(wtPath)
		const log = await fsPromises.readFile(path.join(wtPath, "harness.log"), "utf-8")
		assert.ok(
			!log.includes("--model"),
			`no model anywhere -> no --model flag (the worker CLI applies its own default), harness.log:\n${log}`,
		)
	} finally {
		await cleanupFixture(fixture, "mm-d")
	}
}

// ─── Pre-spawn collision: an existing worktree dir fails loudly (Bug 1) ───────

async function testExistingWorktreeDirFailsLoudly(): Promise<void> {
	const fixture = await makeFixture(null)
	try {
		// A leftover dir from a previous round — the script must abort with a
		// clear error, NOT silently skip the group (that was the bug: w1 got
		// skipped, never recorded, and the round still exited 0).
		const staleName = "stale-a"
		const staleDir = path.join(fixture, ".worktrees", staleName)
		await fsPromises.mkdir(staleDir, { recursive: true })
		await fsPromises.writeFile(path.join(staleDir, "leftover.txt"), "stale\n", "utf-8")

		let caught: (Error & { status?: number; stderr?: string }) | null = null
		try {
			runSpawn(fixture, `${staleName}:0:plans/parallel-tasks/task.md`, {})
		} catch (err) {
			caught = err as Error & { status?: number; stderr?: string }
		}

		assert.ok(caught, "spawn must fail when the worktree dir already exists")
		assert.notEqual(caught.status, 0, "non-zero exit required (no silent skip)")
		assert.ok(
			(caught.stderr ?? "").includes("already exists"),
			`stderr names the collision, got: ${caught.stderr}`,
		)
		assert.ok((caught.stderr ?? "").includes("Remove it first"), "stderr tells the caller to clean up")
	} finally {
		await cleanupFixture(fixture, "stale-a")
	}
}

// ─── Runner ──────────────────────────────────────────────────────────────────

const tests: Array<[string, () => Promise<void>]> = [
	["mode-models.json entry reaches run-worker.sh on the FIRST spawn", testFirstSpawnUsesModeModelsEntry],
	["no config: blanket OPENROUTER_MODEL override is unchanged (regression)", testNoConfigKeepsBlanketEnvOverride],
	["SPAWN_MODEL override still beats the config file", testSpawnModelOverrideBeatsConfig],
	["nothing configured -> no --model flag at all", testNoModelAddsNoFlag],
	["existing worktree dir causes a non-zero exit (no silent skip)", testExistingWorktreeDirFailsLoudly],
]

async function main(): Promise<void> {
	// Redirect the central store so resolveModelForMode's legacy-file migration
	// stays inside the sandbox and never touches the real home store.
	const storeTmp = await fsPromises.mkdtemp(path.join(os.tmpdir(), "hc-spawnmodel-store-"))
	process.env.HEADLESSCODE_DATA_DIR = storeTmp
	let failed = 0
	try {
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
	} finally {
		delete process.env.HEADLESSCODE_DATA_DIR
		await fsPromises.rm(storeTmp, { recursive: true, force: true })
	}
	if (failed > 0) {
		console.error(`\n${failed} test(s) failed`)
		process.exit(1)
	}
	console.log(`\nAll ${tests.length} spawn-model tests passed`)
}

main().catch((err) => {
	console.error("Test runner crashed:", err)
	process.exit(1)
})
