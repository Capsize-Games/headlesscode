import assert from "node:assert/strict"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import { execFileSync, spawnSync } from "node:child_process"
import { setTimeout as sleep } from "node:timers/promises"
import { fileURLToPath } from "node:url"

import { museUnsupportedSettingsReason, resolveAgentExecutorSelection } from "../../agent-executor.js"
import { buildSpawnEnv, handleReviewVerdict, parseOrchestrateArgs } from "../cli.js"
import { parseWatchArgs } from "../../watcher/cli.js"
import { defaultSpawn } from "../../watcher/watch.js"
import { watchIssues, type SpawnBatch } from "../../watcher/watch.js"
import { loadState, saveState } from "../state.js"
import { defaultWatcherState, loadWatcherState, saveWatcherState } from "../../watcher/state.js"

const repoRoot = path.resolve(fileURLToPath(new URL("../../..", import.meta.url)))
const scratchRoot = path.join(repoRoot, ".headlesscode", "scratch", "muse-executor-tests")

async function setupFakeMuse(): Promise<{ root: string; workspace: string; bin: string; argsFile: string }> {
	await fs.mkdir(scratchRoot, { recursive: true })
	const root = await fs.mkdtemp(path.join(scratchRoot, "case-"))
	const workspace = path.join(root, "workspace")
	const bin = path.join(root, "bin")
	await fs.mkdir(path.join(workspace, "src"), { recursive: true })
	await fs.mkdir(bin, { recursive: true })
	await fs.writeFile(path.join(workspace, "task.md"), "Synthetic Muse executor task\n", "utf8")
	await fs.writeFile(path.join(workspace, "src", "cli.ts"), "// synthetic harness root marker\n", "utf8")
	const argsFile = path.join(root, "muse-args.txt")
	const fakeMuse = path.join(bin, "muse")
	await fs.writeFile(fakeMuse, `#!/usr/bin/env bash
set -eu
printf '%s\\n' "$@" > "$FAKE_MUSE_ARGS"
if [ -n "\${FAKE_MUSE_ENV_FILE:-}" ]; then printf '%s\\n' "\${OPENROUTER_API_KEY-}" "\${HEADLESSCODE_OPENROUTER_API_KEY-}" "\${OPENROUTER_MODEL-}" > "$FAKE_MUSE_ENV_FILE"; fi
if [ -n "\${FAKE_MUSE_CHECK_STDIN:-}" ] && IFS= read -r -t 1 _; then exit 91; fi
if [ -n "\${FAKE_MUSE_PID_FILE:-}" ]; then
  printf '%s' "$$" > "$FAKE_MUSE_PID_FILE"
  sleep 30
fi
if [ -n "\${FAKE_MUSE_INCONSISTENT_TERMINAL:-}" ]; then
  printf '{"payload_type":"run.terminal.completed","payload":{"kind":"run_terminal","terminal":"failed","reason":"error"}}\\n'
else
  terminal="completed"
  reason=null
  [ "\${FAKE_MUSE_TERMINAL:-run.terminal.completed}" = "run.terminal.completed" ] || { terminal="failed"; reason='"error"'; }
  printf '{"payload_type":"%s","payload":{"kind":"run_terminal","terminal":"%s","reason":%s}}\\n' "\${FAKE_MUSE_TERMINAL:-run.terminal.completed}" "$terminal" "$reason"
fi
exit "\${FAKE_MUSE_EXIT:-0}"
`, "utf8")
	await fs.chmod(fakeMuse, 0o755)
	return { root, workspace, bin, argsFile }
}

async function waitForMarker(marker: string): Promise<void> {
	const deadline = Date.now() + 5000
	while (Date.now() < deadline) {
		try {
			await fs.access(marker)
			return
		} catch {
			await sleep(20)
		}
	}
	throw new Error(`worker marker did not appear: ${marker}`)
}

function launch(workspace: string, bin: string, argsFile: string, extraEnv: NodeJS.ProcessEnv = {}, task = "task.md"): { status: number | null; stdout: string; stderr: string } {
	const result = spawnSync("bash", [path.join(repoRoot, "scripts", "run-worker.sh"), workspace, task, "--executor", "muse", "--muse-model", "meta/test-model", "--max-iterations", "7"], {
		cwd: repoRoot,
		encoding: "utf8",
		env: {
			...process.env,
			PATH: `${bin}:${process.env.PATH ?? ""}`,
			HEADLESSCODE_ROOT: repoRoot,
			HEADLESSCODE_AGENT_EXECUTOR: "builtin",
			HEADLESSCODE_NATIVE_MUSE_MODEL: "",
			FAKE_MUSE_ARGS: argsFile,
			...extraEnv,
		},
	})
	return { status: result.status, stdout: result.stdout, stderr: result.stderr }
}

async function testIssueSelectionLabels(): Promise<void> {
	assert.deepEqual(resolveAgentExecutorSelection([]).selection, { executor: "builtin" })
	assert.deepEqual(resolveAgentExecutorSelection(["needs-agent", "executor:muse", "muse-model:meta/test-model"]).selection, {
		executor: "muse",
		museModel: "meta/test-model",
	})
	assert.match(resolveAgentExecutorSelection(["executor:deepseek"]).error ?? "", /unsupported issue executor label/)
	assert.match(resolveAgentExecutorSelection(["executor"]).error ?? "", /unsupported issue executor label/)
	assert.deepEqual(resolveAgentExecutorSelection(["Executor:MUSE"]).selection, { executor: "muse" })
	assert.match(resolveAgentExecutorSelection(["executor:muse", "executor:builtin"]).error ?? "", /at most one/)
	assert.match(resolveAgentExecutorSelection(["muse-model:meta/foo"]).error ?? "", /requires executor:muse/)
	assert.match(resolveAgentExecutorSelection(["executor:muse"], { executor: "builtin" }).error ?? "", /conflicts/)
	assert.match(resolveAgentExecutorSelection(["executor:muse", "muse-model:meta/new"], { executor: "muse", museModel: "meta/old" }).error ?? "", /conflicts/)
}

async function testOrchestrateAndWatcherSelectionPersistsThroughSpawn(): Promise<void> {
	const orchestrate = parseOrchestrateArgs(["--repo", repoRoot, "--executor", "muse", "--muse-model", "meta/test-model", "--no-preflight", "--no-review"])
	assert.equal(orchestrate.error, undefined)
	assert.equal(orchestrate.options.executor, "muse")
	assert.equal(orchestrate.options.museModel, "meta/test-model")
	assert.match(parseOrchestrateArgs(["--executor", "unknown"]).error ?? "", /must be builtin or muse/)
	assert.match(parseOrchestrateArgs(["--executor", "muse"]).error ?? "", /--no-preflight explicitly/)
	assert.match(parseOrchestrateArgs(["--executor", "muse", "--no-preflight", "--memory-dir", "/synthetic/memory"]).error ?? "", /memory directory is not supported/)
	const watcher = parseWatchArgs(["--owner", "example", "--repo", repoRoot, "--label", "needs-agent", "--executor", "muse"])
	assert.equal(watcher.error, undefined)
	assert.equal(watcher.options.executor, "muse")
	assert.match(parseWatchArgs(["--executor", "anything"]).error ?? "", /must be builtin or muse/)
	assert.match(parseWatchArgs(["--executor", "muse", "--memory-dir", "/synthetic/memory"]).error ?? "", /memory directory is not supported/)
	assert.match(museUnsupportedSettingsReason(undefined, { HEADLESSCODE_MAX_COST_USD: "1" }) ?? "", /cost limit/)

	const env = buildSpawnEnv({ repo: "/synthetic/repo", mode: "code", executor: "muse", museModel: "meta/test-model", env: { OPENROUTER_MODEL: "deepseek/deepseek-v4-flash", OPENROUTER_API_KEY: "synthetic-secret", HEADLESSCODE_OPENROUTER_API_KEY: "synthetic-secret" } })
	assert.equal(env.workerModel, undefined, "Muse selection does not resolve or inherit an OpenRouter worker model")
	assert.equal(env.env.HEADLESSCODE_AGENT_EXECUTOR, "muse")
	assert.equal(env.env.HEADLESSCODE_NATIVE_MUSE_MODEL, "meta/test-model")
	assert.equal(env.env.OPENROUTER_MODEL, "deepseek/deepseek-v4-flash", "selection keeps orchestrator-side auxiliary model config separate")
	assert.equal(env.env.OPENROUTER_API_KEY, "synthetic-secret")
	assert.equal(env.env.HEADLESSCODE_OPENROUTER_API_KEY, "synthetic-secret")

	const fake = await setupFakeMuse()
	const capture = path.join(fake.root, "spawn-env.txt")
	const spawnStub = path.join(fake.root, "spawn-stub.sh")
	await fs.writeFile(spawnStub, `#!/usr/bin/env bash\nprintf '%s\\n' "$HEADLESSCODE_AGENT_EXECUTOR" "$HEADLESSCODE_NATIVE_MUSE_MODEL" "$OPENROUTER_MODEL" "$OPENROUTER_API_KEY" "$HEADLESSCODE_OPENROUTER_API_KEY" > ${JSON.stringify(capture)}\n`, "utf8")
	await fs.chmod(spawnStub, 0o755)
	const previous = process.env.HEADLESSCODE_SPAWN_SCRIPT
	const previousModel = process.env.OPENROUTER_MODEL
	const previousApiKey = process.env.OPENROUTER_API_KEY
	const previousHeadlessApiKey = process.env.HEADLESSCODE_OPENROUTER_API_KEY
	process.env.HEADLESSCODE_SPAWN_SCRIPT = spawnStub
	process.env.OPENROUTER_MODEL = "deepseek/deepseek-v4-flash"
	process.env.OPENROUTER_API_KEY = "synthetic-secret"
	process.env.HEADLESSCODE_OPENROUTER_API_KEY = "synthetic-secret"
	try {
		const result = defaultSpawn({
			issue: { number: 42, title: "Synthetic intake", labels: ["needs-agent", "executor:muse"] },
			specs: [{ name: "w42", issues: [42], taskFile: "w42-issue42.md" }],
			repoRoot: fake.root,
			batch: "test-batch",
			executor: "muse",
			museModel: "meta/test-model",
		}, { mode: "code", executionProvider: "local" })
		assert.equal(result.ok, true, result.error)
		assert.equal(await fs.readFile(capture, "utf8"), "muse\nmeta/test-model\ndeepseek/deepseek-v4-flash\nsynthetic-secret\nsynthetic-secret\n")
	} finally {
		if (previous === undefined) delete process.env.HEADLESSCODE_SPAWN_SCRIPT
		else process.env.HEADLESSCODE_SPAWN_SCRIPT = previous
		if (previousModel === undefined) delete process.env.OPENROUTER_MODEL
		else process.env.OPENROUTER_MODEL = previousModel
		if (previousApiKey === undefined) delete process.env.OPENROUTER_API_KEY
		else process.env.OPENROUTER_API_KEY = previousApiKey
		if (previousHeadlessApiKey === undefined) delete process.env.HEADLESSCODE_OPENROUTER_API_KEY
		else process.env.HEADLESSCODE_OPENROUTER_API_KEY = previousHeadlessApiKey
		await fs.rm(fake.root, { recursive: true, force: true })
	}

	const persisted = handleReviewVerdict(
		{ name: "w42", worktree: ".worktrees/w42", status: "done", executor: "muse", museModel: "meta/test-model" },
		{ verdict: "finding", findings: ["synthetic finding"], summary: "finding" },
		"/synthetic/repo",
		3,
		"code",
	)
	assert.match(persisted.spawnCommand ?? "", /--executor 'muse' --muse-model 'meta\/test-model'/)
	assert.doesNotMatch(persisted.spawnCommand ?? "", /--model /, "rework uses the persisted native model, not an OpenRouter model")
}

async function testExecutorAndModelSurviveDurableStateRoundTrip(): Promise<void> {
	await fs.mkdir(scratchRoot, { recursive: true })
	const suffix = `${process.pid}-${Date.now()}`
	const orchestratorFile = path.join(scratchRoot, `orchestrator-${suffix}.json`)
	const watcherFile = path.join(scratchRoot, `watcher-${suffix}.json`)
	try {
		await saveState(orchestratorFile, { groups: [{ name: "w1", status: "running", executor: "muse", museModel: "meta/pinned-model" }] })
		const orchestratorState = await loadState(orchestratorFile)
		assert.equal(orchestratorState.groups[0]?.executor, "muse")
		assert.equal(orchestratorState.groups[0]?.museModel, "meta/pinned-model")

		const watcherState = defaultWatcherState()
		watcherState.processed["42"] = {
			number: 42,
			title: "Synthetic job",
			label: "needs-agent",
			status: "failed",
			updatedAt: new Date().toISOString(),
			executor: "muse",
			museModel: "meta/pinned-model",
		}
		await saveWatcherState(watcherFile, watcherState)
		const resumedWatcher = await loadWatcherState(watcherFile)
		assert.equal(resumedWatcher.processed["42"]?.executor, "muse")
		assert.equal(resumedWatcher.processed["42"]?.museModel, "meta/pinned-model")
	} finally {
		await fs.rm(orchestratorFile, { force: true })
		await fs.rm(watcherFile, { force: true })
	}
}

async function testWatcherRetryUsesRecordedSelectionAfterRestart(): Promise<void> {
	const fake = await setupFakeMuse()
	let captured: SpawnBatch | undefined
	try {
		const stateFile = path.join(fake.root, ".worktrees", ".watcher-state.json")
		const state = defaultWatcherState()
		state.processed["42"] = {
			number: 42,
			title: "Synthetic retry",
			label: "needs-agent",
			status: "failed",
			updatedAt: new Date().toISOString(),
			executor: "muse",
			museModel: "meta/previous-model",
		}
		await saveWatcherState(stateFile, state)
		const result = await watchIssues({
			owner: "example",
			repo: "headlesscode",
			targetLabel: "needs-agent",
			token: "synthetic-token",
			repoRoot: fake.root,
			stateFile,
			runOnce: true,
			retryFailed: true,
			executor: "builtin",
			gh: {
				listIssues: async () => [{ number: 42, title: "Synthetic retry", labels: ["needs-agent"] }],
				getIssue: async () => ({ number: 42, title: "Synthetic retry", labels: ["needs-agent"] }),
				addLabel: async () => undefined,
			},
			spawn: async (batch) => {
				captured = batch
				return { ok: true }
			},
		})
		assert.equal(result.exitCode, 0)
		assert.equal(captured?.executor, "muse", "retry uses durable selection instead of changed watcher default")
		assert.equal(captured?.museModel, "meta/previous-model")
	} finally {
		await fs.rm(fake.root, { recursive: true, force: true })
	}
}

async function testMuseWorkerPinsNativeRequestAndValidatesTerminal(): Promise<void> {
	const fake = await setupFakeMuse()
	try {
		const envFile = path.join(fake.root, "muse-env.txt")
		const started = launch(fake.workspace, fake.bin, fake.argsFile, {
			FAKE_MUSE_CHECK_STDIN: "1",
			FAKE_MUSE_ENV_FILE: envFile,
			OPENROUTER_API_KEY: "synthetic-secret",
			HEADLESSCODE_OPENROUTER_API_KEY: "synthetic-secret",
			OPENROUTER_MODEL: "deepseek/deepseek-v4-flash",
		})
		assert.equal(started.status, 0, started.stderr)
		await waitForMarker(path.join(fake.workspace, ".harness.done"))
		assert.equal(await fs.readFile(path.join(fake.workspace, ".harness.exit"), "utf8"), "0")
		const args = (await fs.readFile(fake.argsFile, "utf8")).trim().split("\n")
		assert.equal(args[0], "exec")
		assert.equal(args[1], "--provider")
		assert.equal(args[2], "meta")
		assert.ok(args.includes("--json"))
		assert.ok(args.includes("--no-foreign-personal-context"))
		assert.ok(args.includes("--prompt-file"))
		assert.ok(args.includes(path.join(fake.workspace, "task.md")))
		assert.ok(args.includes("--workspace"))
		assert.ok(args.includes(fake.workspace))
		assert.ok(args.includes("--model"))
		assert.ok(args.includes("meta/test-model"), "native model is forwarded without OpenRouter remapping")
		assert.ok(args.includes("--max-model-steps"))
		assert.ok(args.includes("7"))
		const sessionArg = args.indexOf("--session-id")
		assert.ok(sessionArg > -1 && /^[a-f0-9-]{36}$/i.test(args[sessionArg + 1] ?? ""))
		assert.equal(await fs.readFile(path.join(fake.workspace, ".headlesscode", "scratch", "muse-session-id"), "utf8"), args[sessionArg + 1])
		assert.equal(await fs.readFile(envFile, "utf8"), "\n\n\n", "Muse does not receive unrelated OpenRouter credentials or model id")
		const log = await fs.readFile(path.join(fake.workspace, "harness.log"), "utf8")
		assert.match(log, /run\.terminal\.completed/)
		assert.match(log, /provider=meta model=meta\/test-model session=/)
	} finally {
		await fs.rm(fake.root, { recursive: true, force: true })
	}
}

async function testMuseFailureEventDoesNotCountAsCompletion(): Promise<void> {
	const fake = await setupFakeMuse()
	try {
		const started = launch(fake.workspace, fake.bin, fake.argsFile, { FAKE_MUSE_TERMINAL: "run.terminal.failed" })
		assert.equal(started.status, 0, started.stderr)
		await waitForMarker(path.join(fake.workspace, ".harness.done"))
		assert.equal(await fs.readFile(path.join(fake.workspace, ".harness.exit"), "utf8"), "1")
		assert.match(await fs.readFile(path.join(fake.workspace, "harness.log"), "utf8"), /without run\.terminal\.completed/)
	} finally {
		await fs.rm(fake.root, { recursive: true, force: true })
	}
}

async function testMuseExplicitTerminalErrorCannotCountAsCompletion(): Promise<void> {
	const fake = await setupFakeMuse()
	try {
		const started = launch(fake.workspace, fake.bin, fake.argsFile, { FAKE_MUSE_INCONSISTENT_TERMINAL: "1" })
		assert.equal(started.status, 0, started.stderr)
		await waitForMarker(path.join(fake.workspace, ".harness.done"))
		assert.equal(await fs.readFile(path.join(fake.workspace, ".harness.exit"), "utf8"), "1", "an error payload cannot be accepted because its event type says completed")
	} finally {
		await fs.rm(fake.root, { recursive: true, force: true })
	}
}

async function testInlineMusePromptUsesIgnoredScratchAndCleansUp(): Promise<void> {
	const fake = await setupFakeMuse()
	try {
		const started = launch(fake.workspace, fake.bin, fake.argsFile, {}, "synthetic inline task")
		assert.equal(started.status, 0, started.stderr)
		await waitForMarker(path.join(fake.workspace, ".harness.done"))
		const args = (await fs.readFile(fake.argsFile, "utf8")).trim().split("\n")
		const promptIndex = args.indexOf("--prompt-file")
		assert.ok(promptIndex > -1)
		const promptPath = args[promptIndex + 1]!
		assert.match(promptPath, /\.headlesscode\/scratch\/muse-prompt\./)
		const sessionId = args[args.indexOf("--session-id") + 1]
		assert.equal(await fs.readFile(path.join(fake.workspace, ".headlesscode", "scratch", "muse-session-id"), "utf8"), sessionId)
		await assert.rejects(fs.access(promptPath), "inline prompt scratch should be removed after execution")
	} finally {
		await fs.rm(fake.root, { recursive: true, force: true })
	}
}

async function testMuseProcessStaysInRecordedKillableWorkerGroup(): Promise<void> {
	const fake = await setupFakeMuse()
	const pidFile = path.join(fake.root, "muse.pid")
	let workerGroup = ""
	try {
		const started = spawnSync("bash", [path.join(repoRoot, "scripts", "run-worker.sh"), fake.workspace, "task.md", "--executor", "muse"], {
			cwd: repoRoot,
			encoding: "utf8",
			env: {
				...process.env,
				PATH: `${fake.bin}:${process.env.PATH ?? ""}`,
				HEADLESSCODE_ROOT: repoRoot,
				FAKE_MUSE_ARGS: fake.argsFile,
				FAKE_MUSE_PID_FILE: pidFile,
			},
		})
		assert.equal(started.status, 0, started.stderr)
		const wrapperPid = started.stdout.trim()
		await waitForMarker(path.join(fake.workspace, ".harness.pgid"))
		await waitForMarker(pidFile)
		workerGroup = await fs.readFile(path.join(fake.workspace, ".harness.pgid"), "utf8")
		const musePid = Number(await fs.readFile(pidFile, "utf8"))
		const museGroup = execFileSync("ps", ["-o", "pgid=", "-p", String(musePid)], { encoding: "utf8" }).trim()
		assert.equal(workerGroup, wrapperPid, "setsid wrapper writes its process-group id")
		assert.equal(museGroup, workerGroup, "Muse runs in the same process group the stop command signals")
		process.kill(-Number(workerGroup), "SIGTERM")
		await sleep(100)
		assert.throws(() => process.kill(musePid, 0), "Muse process exits when its worker process group is stopped")
	} finally {
		if (workerGroup) {
			try { process.kill(-Number(workerGroup), "SIGTERM") } catch { /* already stopped */ }
		}
		await fs.rm(fake.root, { recursive: true, force: true })
	}
}

async function testInvalidExecutorAndModelCombinationFailBeforeLaunch(): Promise<void> {
	const fake = await setupFakeMuse()
	try {
		const unknown = spawnSync("bash", [path.join(repoRoot, "scripts", "run-worker.sh"), fake.workspace, "task.md", "--executor", "other"], {
			cwd: repoRoot,
			encoding: "utf8",
			env: { ...process.env, HEADLESSCODE_ROOT: repoRoot, PATH: `${fake.bin}:${process.env.PATH ?? ""}` },
		})
		assert.equal(unknown.status, 2)
		assert.match(unknown.stderr, /unsupported agent executor/)
		const conflicting = spawnSync("bash", [path.join(repoRoot, "scripts", "run-worker.sh"), fake.workspace, "task.md", "--executor", "muse", "--model", "deepseek\/deepseek-v4-flash"], {
			cwd: repoRoot,
			encoding: "utf8",
			env: { ...process.env, HEADLESSCODE_ROOT: repoRoot, PATH: `${fake.bin}:${process.env.PATH ?? ""}` },
		})
		assert.equal(conflicting.status, 2)
		assert.match(conflicting.stderr, /use --muse-model/)
		const unsupportedLimit = spawnSync("bash", [path.join(repoRoot, "scripts", "run-worker.sh"), fake.workspace, "task.md", "--executor", "muse"], {
			cwd: repoRoot,
			encoding: "utf8",
			env: { ...process.env, HEADLESSCODE_ROOT: repoRoot, HEADLESSCODE_MAX_COST_USD: "1", PATH: `${fake.bin}:${process.env.PATH ?? ""}` },
		})
		assert.equal(unsupportedLimit.status, 2)
		assert.match(unsupportedLimit.stderr, /HEADLESSCODE_MAX_COST_USD is not supported/)
		const contained = spawnSync("bash", [path.join(repoRoot, "scripts", "run-worker.sh"), fake.workspace, "task.md", "--executor", "muse"], {
			cwd: repoRoot,
			encoding: "utf8",
			env: { ...process.env, HEADLESSCODE_ROOT: repoRoot, HEADLESSCODE_SECURITY_PROFILE: "contained", PATH: `${fake.bin}:${process.env.PATH ?? ""}` },
		})
		assert.equal(contained.status, 2)
		assert.match(contained.stderr, /contained OpenShell security profile/)
		await assert.rejects(fs.access(fake.argsFile))
	} finally {
		await fs.rm(fake.root, { recursive: true, force: true })
	}
}

async function testBuiltinMuseApiModelDoesNotSelectNativeExecutor(): Promise<void> {
	const fake = await setupFakeMuse()
	try {
		const selection = buildSpawnEnv({ repo: fake.workspace, mode: "code", executor: "builtin", explicitModel: "muse-spark-1.3-contributor",
			env: { HEADLESSCODE_LLM_PROVIDER: "muse", HEADLESSCODE_MUSE_MODEL: "muse-spark-1.3" } })
		assert.equal(selection.env.HEADLESSCODE_MUSE_MODEL, "muse-spark-1.3-contributor")
		assert.equal(selection.env.HEADLESSCODE_NATIVE_MUSE_MODEL, "")
		const capture = path.join(fake.root, "direct-model.txt")
		await fs.writeFile(path.join(fake.bin, "headless-test-cli"), '#!/usr/bin/env bash\nprintf "%s" "$HEADLESSCODE_MUSE_MODEL" > "$DIRECT_MODEL_CAPTURE"\n')
		await fs.chmod(path.join(fake.bin, "headless-test-cli"), 0o755)
		const launched = spawnSync("bash", [path.join(repoRoot, "scripts", "run-worker.sh"), fake.workspace, "task.md", "--executor", "builtin"], {
			cwd: repoRoot, encoding: "utf8", env: { ...process.env, ...selection.env, HEADLESSCODE_ROOT: repoRoot,
				HEADLESSCODE_CLI: "headless-test-cli", PATH: `${fake.bin}:${process.env.PATH ?? ""}`, DIRECT_MODEL_CAPTURE: capture },
		})
		assert.equal(launched.status, 0, launched.stderr)
		await waitForMarker(path.join(fake.workspace, ".harness.done"))
		assert.equal(await fs.readFile(path.join(fake.workspace, ".harness.exit"), "utf8"), "0")
		assert.equal(await fs.readFile(capture, "utf8"), "muse-spark-1.3-contributor")
		await assert.rejects(fs.access(fake.argsFile), "builtin API route must not invoke native Muse")
	} finally { await fs.rm(fake.root, { recursive: true, force: true }) }
}

const tests: Array<[string, () => Promise<void>]> = [
	["issue executor labels resolve per job and reject conflicts", testIssueSelectionLabels],
	["builtin Muse API model stays separate from the native executor selector", testBuiltinMuseApiModelDoesNotSelectNativeExecutor],
	["CLI, watcher intake, and rework retain explicit Muse executor/model selection", testOrchestrateAndWatcherSelectionPersistsThroughSpawn],
	["per-job Muse executor and model survive orchestrator and watcher state reloads", testExecutorAndModelSurviveDurableStateRoundTrip],
	["failed watcher retries retain the executor/model saved before restart", testWatcherRetryUsesRecordedSelectionAfterRestart],
	["Muse worker forwards native request, closes stdin, and validates JSONL terminal", testMuseWorkerPinsNativeRequestAndValidatesTerminal],
	["Muse terminal failure cannot be mistaken for successful completion", testMuseFailureEventDoesNotCountAsCompletion],
	["Muse terminal JSON error cannot be mistaken for completion", testMuseExplicitTerminalErrorCannotCountAsCompletion],
	["inline Muse prompts use ignored scratch and are cleaned after execution", testInlineMusePromptUsesIgnoredScratchAndCleansUp],
	["Muse stays in the worker process group for tree cancellation", testMuseProcessStaysInRecordedKillableWorkerGroup],
	["unknown executors and conflicting model namespaces fail closed", testInvalidExecutorAndModelCombinationFailBeforeLaunch],
]

for (const [name, test] of tests) {
	await test()
	console.log(`✓ ${name}`)
}
console.log(`\nAll ${tests.length} Muse executor tests passed`)
