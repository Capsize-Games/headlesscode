import assert from "node:assert/strict"
import { execFileSync, spawn, spawnSync } from "node:child_process"
import { createServer } from "node:http"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { OpenShellSessionProvider, runOpenShellCommandAsync, validateReadOnlyMountTargets } from "../openshell-provider.js"
import type { CloudSessionRequest } from "../provider.js"
import { EmergencyControl } from "../../control/emergency-controller.js"

const actualControlSockets = fs.mkdtempSync(path.join(os.tmpdir(), "provider-sockets-"))
const controlSocketFd = fs.openSync(actualControlSockets, "r")
const controlSocketDirectory = process.platform === "linux" && Buffer.byteLength(path.join(actualControlSockets, `${"x".repeat(20)}.sock`)) >= 108
	? `/proc/self/fd/${controlSocketFd}` : actualControlSockets

async function createMinimalOpenShellFixture(prefix: string): Promise<{ root: string; repo: string; workspace: string; policy: string; request: CloudSessionRequest }> {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
	const repo = path.join(root, "repo")
	const workspace = path.join(repo, ".worktrees", "worker")
	const policy = path.join(root, "policy.yaml")
	fs.mkdirSync(repo, { recursive: true })
	execFileSync("git", ["init", "-q", "-b", "main", repo])
	execFileSync("git", ["-C", repo, "config", "user.name", "Test"])
	execFileSync("git", ["-C", repo, "config", "user.email", "test@example.invalid"])
	fs.writeFileSync(path.join(repo, "README.md"), "base\n")
	execFileSync("git", ["-C", repo, "add", "README.md"])
	execFileSync("git", ["-C", repo, "commit", "-qm", "initial"])
	fs.mkdirSync(path.dirname(workspace), { recursive: true })
	execFileSync("git", ["-C", repo, "worktree", "add", "-qb", "worker", workspace, "HEAD"])
	fs.writeFileSync(policy, "version: 1\nfilesystem_policy:\n  include_workdir: true\n  read_only: [/usr, /lib, /etc]\n  read_write: [/sandbox, /tmp, /dev/null]\nlandlock:\n  compatibility: hard_requirement\n")
	return { root, repo, workspace, policy, request: { repo, issue: { number: 1, title: "test" }, worktreeSpec: { name: "worker", issues: [1], taskFile: "worker.md" } } }
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve!: () => void
	const promise = new Promise<void>((done) => { resolve = done })
	return { promise, resolve }
}

async function testIsolatedCloneExportAndImport(): Promise<void> {
	const repo = fs.mkdtempSync(path.join(os.tmpdir(), "headlesscode-openshell-isolation-test-"))
	const hostWorkspace = path.join(repo, ".worktrees", "worker")
	const policy = path.join(repo, "policy.yaml")
	const memoryDir = path.join(repo, "host-memory")
	const promptDir = path.join(repo, "prompt-source")
	const checkpointDir = path.join(repo, "checkpoint-source")
	let sandboxWorkspace = ""
	let resultDir = ""
	let capturedBundle = ""
	let memorySnapshotDir = ""
	let promptSnapshotDir = ""
	let checkpointSnapshotDir = ""
	let lastExecutedCommand = ""
	let createArgs: string[] = []
	let hostRequestsServed = 0
	const brokerProbeServer = createServer((_request, response) => {
		hostRequestsServed += 1
		response.writeHead(200, { "content-type": "text/plain" })
		response.end("broker-ready")
	})
	try {
		await new Promise<void>((resolve) => brokerProbeServer.listen(0, "127.0.0.1", resolve))
		execFileSync("git", ["init", "-q", "-b", "main", repo])
		execFileSync("git", ["-C", repo, "config", "user.name", "Test"])
		execFileSync("git", ["-C", repo, "config", "user.email", "test@example.invalid"])
		fs.mkdirSync(path.dirname(hostWorkspace), { recursive: true })
		fs.writeFileSync(path.join(repo, "README.md"), "base\n")
		fs.writeFileSync(path.join(repo, ".env.example"), "EXAMPLE=value\n")
		fs.writeFileSync(path.join(repo, ".env"), "SECRET=must-not-enter-the-sandbox\n")
		execFileSync("git", ["-C", repo, "add", "README.md", ".env.example", ".env"])
		execFileSync("git", ["-C", repo, "commit", "-qm", "initial"])
		execFileSync("git", ["-C", repo, "worktree", "add", "-qb", "worker", hostWorkspace, "HEAD"])
		fs.writeFileSync(path.join(hostWorkspace, "ORCHESTRATOR_TASK.md"), "task\n")
		fs.writeFileSync(path.join(hostWorkspace, "ORCHESTRATOR_PLAN.md"), "plan prompt\n")
		fs.writeFileSync(path.join(hostWorkspace, ".harness.pgid"), "123\n")
		fs.mkdirSync(path.join(memoryDir, "facts"), { recursive: true })
		fs.writeFileSync(path.join(memoryDir, "facts", "project.jsonl"), '{"content":"existing"}\n')
		fs.mkdirSync(promptDir)
		fs.writeFileSync(path.join(promptDir, "review-prompt.md"), "review instructions\n")
		fs.mkdirSync(checkpointDir)
		fs.writeFileSync(path.join(checkpointDir, "config.json"), '{"model_type":"sentinel"}\n')
		fs.writeFileSync(path.join(checkpointDir, "sentinel.weights"), "DO_NOT_EXPORT_LOCAL_MODEL")
		fs.writeFileSync(policy, "version: 1\nfilesystem_policy:\n  include_workdir: true\n  read_only: [/usr, /lib, /etc]\n  read_write: [/sandbox, /tmp, /dev/null]\nlandlock:\n  compatibility: hard_requirement\n")
		const cliRun = (args: string[]) => {
			if (args[0] === "sandbox" && args[1] === "create") {
				createArgs = args
				const driver = JSON.parse(args[args.indexOf("--driver-config-json") + 1]) as { docker: { mounts: Array<{ source: string; target: string; read_only: boolean }> } }
				sandboxWorkspace = driver.docker.mounts.find((mount) => mount.target === "/workspace")!.source
				resultDir = driver.docker.mounts.find((mount) => mount.target === "/result")!.source
				memorySnapshotDir = driver.docker.mounts.find((mount) => mount.target === "/opt/headlesscode-memory")!.source
				promptSnapshotDir = driver.docker.mounts.find((mount) => mount.target === "/workspace/.headlesscode-session")!.source
				checkpointSnapshotDir = driver.docker.mounts.find((mount) => mount.target === "/workspace/.rsi-base-model")!.source
				return { exitCode: 0, output: "created" }
			}
			if (args[0] === "sandbox" && args[1] === "delete") return { exitCode: 0, output: "deleted" }
			if (args[0] === "sandbox" && args[1] === "exec") {
				let command = args.at(-1) ?? ""
				if (args.includes("--workdir") && args[args.indexOf("--workdir") + 1] === "/workspace") {
					lastExecutedCommand = command
					command = command.replaceAll("/workspace", "__WORKSPACE__").replaceAll("/result/", "__RESULT__/").replaceAll("/opt/headlesscode-memory", "__MEMORY__").replaceAll("__WORKSPACE__", sandboxWorkspace).replaceAll("__RESULT__", resultDir).replaceAll("__MEMORY__", memorySnapshotDir)
					const executed = spawnSync("/bin/bash", ["-c", command], { cwd: sandboxWorkspace, encoding: "utf8", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" } })
					if (executed.status === 0 && command.includes("git bundle create") && command.includes(path.join(resultDir, "result.bundle"))) capturedBundle = path.join(repo, "captured-result.bundle"), fs.copyFileSync(path.join(resultDir, "result.bundle"), capturedBundle)
					return { exitCode: executed.status ?? 1, output: `${executed.stdout ?? ""}${executed.stderr ?? ""}` }
				}
				return { exitCode: 0, output: "ready" }
			}
			return { exitCode: 1, output: `unexpected: ${args.join(" ")}` }
		}
		const provider = new OpenShellSessionProvider({
			image: "worker:test", policy, providers: [], scratchRoot: path.join(repo, "gateway-visible-scratch"),
			readOnlyMounts: [{ source: promptDir, target: "/workspace/.headlesscode-session" }, { source: checkpointDir, target: "/workspace/.rsi-base-model" }],
			run: cliRun,
			runAsync: (args) => {
				if (args[0] === "sandbox" && ["create", "delete"].includes(args[1] ?? "")) return Promise.resolve(cliRun(args))
				return new Promise((resolve) => {
				const command = args.at(-1) ?? ""
				lastExecutedCommand = command
				const mapped = command.replaceAll("/workspace", "__WORKSPACE__").replaceAll("/result/", "__RESULT__/").replaceAll("/opt/headlesscode-memory", "__MEMORY__").replaceAll("__WORKSPACE__", sandboxWorkspace).replaceAll("__RESULT__", resultDir).replaceAll("__MEMORY__", memorySnapshotDir)
				const child = spawn("/bin/bash", ["-c", mapped], { cwd: sandboxWorkspace, env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" }, stdio: ["ignore", "pipe", "pipe"] })
				let output = ""
				child.stdout.setEncoding("utf8").on("data", (chunk: string) => { output += chunk })
				child.stderr.setEncoding("utf8").on("data", (chunk: string) => { output += chunk })
				child.once("error", (error) => resolve({ exitCode: 1, output: `${output}${error.message}` }))
				child.once("close", (code) => {
					if (code === 0 && command.includes("git bundle create") && command.includes("result.bundle")) capturedBundle = path.join(repo, "captured-result.bundle"), fs.copyFileSync(path.join(resultDir, "result.bundle"), capturedBundle)
					resolve({ exitCode: code ?? 1, output })
				})
			})
			},
			listSandboxes: () => [],
		})
		const request: CloudSessionRequest = { repo, issue: { number: 1, title: "test" }, worktreeSpec: { name: "worker", issues: [1], taskFile: "worker.md" }, env: { HEADLESSCODE_MEMORY_DIR: memoryDir } }
		const handle = await provider.spawnExistingWorktreeSession(request, hostWorkspace)
		assert.equal(handle.address, hostWorkspace)
		const mounts = JSON.parse(createArgs[createArgs.indexOf("--driver-config-json") + 1]).docker.mounts as Array<{ source: string; target: string; read_only: boolean }>
		assert.deepEqual(mounts.map((mount) => mount.target).slice(0, 2), ["/workspace", "/result"])
		assert.equal(mounts.some((mount) => mount.source === repo || mount.source === hostWorkspace), false, "host repository and orchestration worktree are never bind-mounted")
		const memoryMount = mounts.find((mount) => mount.target === "/opt/headlesscode-memory")!
		assert.notEqual(memoryMount.source, memoryDir, "configured host memory is snapshotted instead of mounted")
		const checkpointMount = mounts.find((mount) => mount.target === "/workspace/.rsi-base-model")!
		assert.equal(checkpointMount.read_only, true, "the model mount uses Docker's read-only bind option")
		assert.ok(checkpointMount.source !== sandboxWorkspace && !checkpointMount.source.startsWith(`${sandboxWorkspace}${path.sep}`), "the checkpoint snapshot is outside the writable workspace source")
		assert.equal(fs.readFileSync(path.join(promptSnapshotDir, "review-prompt.md"), "utf8"), "review instructions\n", "review prompt is snapshotted outside the workspace and mounted at its requested target")
		assert.equal(fs.readFileSync(path.join(sandboxWorkspace, "ORCHESTRATOR_PLAN.md"), "utf8"), "plan prompt\n", "plan-first input is copied into the isolated workspace")
		assert.equal(fs.readFileSync(path.join(checkpointSnapshotDir, "sentinel.weights"), "utf8"), "DO_NOT_EXPORT_LOCAL_MODEL")
		assert.equal(fs.readFileSync(path.join(sandboxWorkspace, ".env"), "utf8"), "\n", "tracked .env is filtered before sandbox execution")
		const duplicateAttempt = provider.spawnExistingWorktreeSession(request, hostWorkspace)
		await assert.rejects(duplicateAttempt, /already held|EEXIST|file already exists/i)
		assert.ok(fs.existsSync(sandboxWorkspace), "a duplicate launch cannot remove the active sandbox clone")
		const address = brokerProbeServer.address()
		assert.ok(address && typeof address === "object")
		fs.writeFileSync(path.join(sandboxWorkspace, "broker-concurrency-probe.cjs"), `fetch("http://127.0.0.1:${address.port}/probe").then(async (response) => { if (response.status !== 200 || await response.text() !== "broker-ready") process.exit(1) }).catch(() => process.exit(2))\n`)
		const commandResult = await provider.runHarness(handle, "test -d /opt/headlesscode-memory && printf 'sandbox change\\n' > result.txt && printf 'sandbox overwrite\\n' > .harness.pgid && printf 'secret=bad\\n' > .env && ln -s /opt/headlesscode/node_modules node_modules && node broker-concurrency-probe.cjs")
		assert.equal(commandResult.exitCode, 0, commandResult.output)
		assert.equal(hostRequestsServed, 1, "the host HTTP service responds while runHarness waits for the guest command")
		assert.ok(!lastExecutedCommand.includes(memoryDir), "host memory path in commands is remapped")
		fs.appendFileSync(path.join(memoryMount.source, "facts", "project.jsonl"), '{"content":"learned in sandbox"}\n')
		await provider.teardown(handle)
		const exported = path.join(repo, "bundle-clone")
		const bundleHead = execFileSync("git", ["bundle", "list-heads", capturedBundle], { encoding: "utf8" }).trim().split(/\s+/)[1]
		assert.ok(bundleHead, "OpenShell returned a bundle with a ref")
		execFileSync("git", ["init", "-q", exported])
		execFileSync("git", ["fetch", "--quiet", capturedBundle, bundleHead], { cwd: exported })
		execFileSync("git", ["checkout", "-q", "FETCH_HEAD"], { cwd: exported })
		assert.equal(execFileSync("git", ["ls-tree", "-r", "--name-only", "HEAD"], { cwd: exported, encoding: "utf8" }).includes(".rsi-base-model"), false, "read-only base model mount never enters the exported Git bundle")
		assert.equal(fs.existsSync(path.join(exported, ".rsi-base-model", "sentinel.weights")), false)
		assert.equal(fs.readFileSync(path.join(hostWorkspace, "result.txt"), "utf8"), "sandbox change\n")
		assert.equal(execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: hostWorkspace, encoding: "utf8" }).trim(), hostWorkspace)
		assert.equal(fs.readFileSync(path.join(hostWorkspace, ".harness.pgid"), "utf8"), "123\n")
		assert.equal(fs.readFileSync(path.join(hostWorkspace, ".env"), "utf8"), "SECRET=must-not-enter-the-sandbox\n", "sandbox environment files are not imported over tracked host content")
		assert.equal(fs.readFileSync(path.join(hostWorkspace, ".env.example"), "utf8"), "EXAMPLE=value\n", "tracked env example remains unchanged")
		assert.equal(fs.readFileSync(path.join(hostWorkspace, ".env"), "utf8"), "SECRET=must-not-enter-the-sandbox\n", "tracked host .env remains unchanged")
		assert.equal(fs.existsSync(path.join(hostWorkspace, ".harness.openshell-sandbox")), false)
		assert.equal(fs.existsSync(path.join(hostWorkspace, "node_modules")), false, "the exact harness dependency symlink is removed before export")
		assert.equal(execFileSync("git", ["ls-tree", "-r", "--name-only", "HEAD"], { cwd: hostWorkspace, encoding: "utf8" }).split("\n").includes("node_modules"), false)
		assert.match(fs.readFileSync(path.join(memoryDir, "facts", "project.jsonl"), "utf8"), /learned in sandbox/, "validated memory JSONL is imported after teardown")
		for (const artifact of ["different-symlink", "directory"] as const) {
			const invalidHandle = await provider.spawnExistingWorktreeSession(request, hostWorkspace)
			await provider.waitReady(invalidHandle)
			const invalid = artifact === "different-symlink" ? "ln -s /tmp/untrusted-node-modules node_modules" : "mkdir node_modules"
			assert.equal((await provider.runHarness(invalidHandle, invalid)).exitCode, 0)
			await assert.rejects(provider.teardown(invalidHandle), /OpenShell Git export failed/)
			assert.equal(fs.existsSync(path.join(hostWorkspace, "node_modules")), false, `unexpected dependency ${artifact} is not imported`)
		}
	} finally {
		brokerProbeServer.closeAllConnections()
		await new Promise<void>((resolve) => brokerProbeServer.close(() => resolve()))
		fs.rmSync(repo, { recursive: true, force: true })
	}
}

async function testReadOnlyMountTargetsAreSafeAndNonOverlapping(): Promise<void> {
	assert.deepEqual(validateReadOnlyMountTargets([
		{ source: "/tmp/a", target: "/workspace/.rsi-base-model" },
		{ source: "/tmp/b", target: "/workspace/.headlesscode-session" },
	]), ["/workspace/.rsi-base-model", "/workspace/.headlesscode-session"])
	for (const target of ["/", "/workspace", "/workspace/../etc", "/workspace//model", "/workspace/./model", "/workspace\\model"]) {
		assert.throws(() => validateReadOnlyMountTargets([{ source: "/tmp/model", target }]), /read-only mount target/)
	}
	assert.throws(() => validateReadOnlyMountTargets([
		{ source: "/tmp/model", target: "/workspace/model" },
		{ source: "/tmp/nested", target: "/workspace/model/nested" },
	]), /targets overlap/)
}

async function testSandboxNameIsStableAndDistinct(): Promise<void> {
	const repo = path.join(os.tmpdir(), "headlesscode-openshell-name-test-repo")
	const provider = new OpenShellSessionProvider({ namePrefix: "hcls", run: () => ({ exitCode: 0, output: "" }), listSandboxes: () => [] })
	const first = provider.sandboxNameForWorktree("worker", repo)
	const again = provider.sandboxNameForWorktree("worker", repo)
	assert.equal(first, again, "the same repo and worktree resolve to the same sandbox name")
	const other = provider.sandboxNameForWorktree("other-worker", repo)
	assert.notEqual(first, other, "a different worktree resolves to a different sandbox name")
	assert.match(first, /^[a-z0-9](?:[a-z0-9-]{0,17}[a-z0-9])?$/, "the sandbox name is a DNS-safe label")
}

async function testAsyncOpenShellCommandReportsSafeExitAndTimeoutDetails(): Promise<void> {
	const stdinEof = await runOpenShellCommandAsync(["-e", "require('node:fs').readFileSync(0); console.log('stdin-eof')"], 1000, process.execPath)
	assert.equal(
		stdinEof.exitCode,
		0,
		`the async command runner closes stdin so OpenShell relays can start; output: ${stdinEof.output}`,
	)
	assert.match(stdinEof.output, /stdin-eof/)
	const nonzero = await runOpenShellCommandAsync(["-e", "process.exit(7)"], undefined, process.execPath)
	assert.equal(nonzero.exitCode, 7)
	assert.match(nonzero.output, /exitCode=7/)
	assert.doesNotMatch(nonzero.output, /process\.exit|--task|API_KEY/i, "diagnostics omit command arguments and environment")
	const timeout = await runOpenShellCommandAsync(["-e", "setTimeout(() => {}, 10000)"], 25, process.execPath)
	assert.equal(timeout.exitCode, 1)
	assert.match(timeout.output, /timeout=true/)
	assert.match(timeout.output, /signal=SIGTERM/)
}

async function testAbortEscalatesItsLauncherGroupAndRemovesGrandchild(): Promise<void> {
	const scratch = path.join(process.cwd(), ".headlesscode", "scratch")
	fs.mkdirSync(scratch, { recursive: true })
	const pidFile = path.join(scratch, `openshell-grandchild-${process.pid}.pid`)
	const temporaryPidFile = `${pidFile}.tmp`
	fs.rmSync(pidFile, { force: true })
	fs.rmSync(temporaryPidFile, { force: true })
	const childSource = `const fs=require('node:fs');const {spawn}=require('node:child_process');process.on('SIGTERM',()=>{});const child=spawn(process.execPath,['-e',${JSON.stringify("process.on('SIGTERM',()=>{});if(process.send)process.send('ready');setInterval(()=>{},1000)")}],{stdio:['ignore','ignore','ignore','ipc']});child.once('message',(message)=>{if(message==='ready'){fs.writeFileSync(${JSON.stringify(temporaryPidFile)},String(child.pid)+'\\n',{flag:'wx'});fs.renameSync(${JSON.stringify(temporaryPidFile)},${JSON.stringify(pidFile)})}});setInterval(()=>{},1000)`
	const controller = new AbortController()
	const pending = runOpenShellCommandAsync(["-e", childSource], 10_000, process.execPath, controller.signal, 100)
	const deadline = Date.now() + 3_000
	let grandchildPid = 0
	let aborted = false
	try {
		while (Date.now() < deadline) {
			try {
				const candidate = Number(fs.readFileSync(pidFile, "utf8"))
				if (Number.isSafeInteger(candidate) && candidate > 0) { grandchildPid = candidate; break }
			} catch { /* the child has not atomically published its ready PID yet */ }
			await new Promise((resolve) => setTimeout(resolve, 10))
		}
		assert.ok(grandchildPid > 0, "fixture publishes a positive grandchild PID only after its SIGTERM handler is installed")
		controller.abort(new Error("controlled stop"))
		aborted = true
		await assert.rejects(pending, /controlled stop|aborted/)
		assert.throws(() => process.kill(grandchildPid, 0), (error: NodeJS.ErrnoException) => error.code === "ESRCH", "the grandchild in the owned process group is gone")
	} finally {
		if (!aborted) controller.abort(new Error("fixture cleanup"))
		await pending.catch(() => undefined)
		fs.rmSync(pidFile, { force: true })
		fs.rmSync(temporaryPidFile, { force: true })
	}
}

async function testCreateStopRaceWaitsForCreationAndDeletesLateSandbox(): Promise<void> {
	const fixture = await createMinimalOpenShellFixture("headlesscode-openshell-create-stop-")
	const sandboxes = new Set<string>()
	const createCalled = deferred()
	const root = path.join(fixture.root, "scratch")
	const control = await EmergencyControl.start({ identity: "create-race", stateDirectory: path.join(fixture.root, "control"), socketDirectory: controlSocketDirectory, graceMs: 2_000 })
	const provider = new OpenShellSessionProvider({
		policy: fixture.policy, autoProviders: false, providers: [], includeProjectData: false, scratchRoot: root, emergencyControl: control,
		run: () => ({ exitCode: 0, output: "" }), listSandboxes: () => [...sandboxes],
		runAsync: async (args) => {
			if (args[0] === "sandbox" && args[1] === "create") {
				createCalled.resolve()
				await new Promise((resolve) => setTimeout(resolve, 50))
				sandboxes.add(args[args.indexOf("--name") + 1]!)
				return { exitCode: 0, output: "created" }
			}
			if (args[0] === "sandbox" && args[1] === "delete") { sandboxes.delete(args[2]!); return { exitCode: 0, output: "deleted" } }
			return { exitCode: 0, output: "ready" }
		},
	})
	try {
		const creation = provider.spawnExistingWorktreeSession(fixture.request, fixture.workspace)
		const creationOutcome = creation.then(() => ({ error: undefined as unknown }), (error: unknown) => ({ error }))
		await createCalled.promise
		const stopped = await control.command("stop", "stop during create")
		assert.equal(stopped.record.state, "stopped")
		const outcome = await creationOutcome
		assert.ok(outcome.error instanceof Error && /aborted|emergency stop/i.test(outcome.error.message))
		assert.equal(sandboxes.size, 0, "the supervisor waits for a late create response and deletes the sandbox before acknowledging stop")
		assert.deepEqual(stopped.record.resources, [])
	} finally {
		await control.close()
		fs.rmSync(fixture.root, { recursive: true, force: true })
	}
}

async function testFailedSandboxDeletionRetainsResourceAndRetryCanVerifyAbsence(): Promise<void> {
	const fixture = await createMinimalOpenShellFixture("headlesscode-openshell-delete-failure-")
	const sandboxes = new Set<string>()
	let failDelete = true
	const control = await EmergencyControl.start({ identity: "delete-failure", stateDirectory: path.join(fixture.root, "control"), socketDirectory: controlSocketDirectory, graceMs: 1_000 })
	const provider = new OpenShellSessionProvider({
		policy: fixture.policy, autoProviders: false, providers: [], includeProjectData: false, scratchRoot: path.join(fixture.root, "scratch"), deleteVerifyTimeoutMs: 10, emergencyControl: control,
		run: () => ({ exitCode: 0, output: "" }), listSandboxes: () => [...sandboxes],
		runAsync: async (args) => {
			if (args[0] === "sandbox" && args[1] === "create") { sandboxes.add(args[args.indexOf("--name") + 1]!); return { exitCode: 0, output: "created" } }
			if (args[0] === "sandbox" && args[1] === "delete") {
				if (!failDelete) sandboxes.delete(args[2]!)
				return { exitCode: failDelete ? 1 : 0, output: failDelete ? "gateway unavailable" : "deleted" }
			}
			return { exitCode: 0, output: "ready" }
		},
	})
	try {
		await provider.spawnExistingWorktreeSession(fixture.request, fixture.workspace)
		const stopped = await control.command("stop", "delete gateway failure")
		assert.equal(stopped.record.state, "failed-to-stop")
		assert.deepEqual(stopped.record.resources, [`openshell:${[...sandboxes][0]}`], "unverified sandbox remains durably recorded")
		assert.ok(fs.existsSync(path.join(fixture.workspace, ".harness.openshell-sandbox")), "failed teardown preserves the workspace marker")
		failDelete = false
		const retried = await control.command("stop", "retry deletion")
		assert.equal(retried.record.state, "stopped")
		assert.deepEqual(retried.record.resources, [])
		assert.equal(sandboxes.size, 0)
		assert.equal(fs.existsSync(path.join(fixture.workspace, ".harness.openshell-sandbox")), false)
	} finally {
		await control.close()
		fs.rmSync(fixture.root, { recursive: true, force: true })
	}
}

async function testFencedTeardownDoesNotImportSandboxResults(): Promise<void> {
	const fixture = await createMinimalOpenShellFixture("headlesscode-openshell-no-import-")
	const sandboxes = new Set<string>()
	const abort = new AbortController()
	let sandboxWorkspace = ""
	const provider = new OpenShellSessionProvider({
		policy: fixture.policy, autoProviders: false, providers: [], includeProjectData: false, scratchRoot: path.join(fixture.root, "scratch"), signal: abort.signal,
		run: () => ({ exitCode: 0, output: "" }), listSandboxes: () => [...sandboxes],
		runAsync: async (args) => {
			if (args[0] === "sandbox" && args[1] === "create") {
				const config = JSON.parse(args[args.indexOf("--driver-config-json") + 1]!) as { docker: { mounts: Array<{ source: string; target: string }> } }
				sandboxWorkspace = config.docker.mounts.find((mount) => mount.target === "/workspace")!.source
				sandboxes.add(args[args.indexOf("--name") + 1]!)
				return { exitCode: 0, output: "created" }
			}
			if (args[0] === "sandbox" && args[1] === "delete") { sandboxes.delete(args[2]!); return { exitCode: 0, output: "deleted" } }
			return { exitCode: 0, output: "ready" }
		},
	})
	try {
		const handle = await provider.spawnExistingWorktreeSession(fixture.request, fixture.workspace)
		fs.writeFileSync(path.join(sandboxWorkspace, "should-not-import.txt"), "fenced result\n")
		abort.abort(new Error("security stop"))
		await provider.teardown(handle)
		assert.equal(fs.existsSync(path.join(fixture.workspace, "should-not-import.txt")), false, "fenced results are not imported after stop")
		assert.equal(sandboxes.size, 0)
	} finally { fs.rmSync(fixture.root, { recursive: true, force: true }) }
}

async function main(): Promise<void> {
	await testIsolatedCloneExportAndImport()
	console.log("  ok   OpenShell exports isolated clone results without mounting the host worktree")
	await testSandboxNameIsStableAndDistinct()
	console.log("  ok   OpenShell sandbox names are stable per repo+worktree and distinct across worktrees")
	await testReadOnlyMountTargetsAreSafeAndNonOverlapping()
	console.log("  ok   OpenShell read-only mount targets are safe and non-overlapping")
	await testAsyncOpenShellCommandReportsSafeExitAndTimeoutDetails()
	console.log("  ok   OpenShell async command errors report safe exit and timeout details")
	await testAbortEscalatesItsLauncherGroupAndRemovesGrandchild()
	console.log("  ok   OpenShell abort terminates its launcher group through bounded escalation")
	await testCreateStopRaceWaitsForCreationAndDeletesLateSandbox()
	console.log("  ok   OpenShell create/stop race waits for and deletes late sandboxes")
	await testFailedSandboxDeletionRetainsResourceAndRetryCanVerifyAbsence()
	console.log("  ok   OpenShell failed deletion retains the resource until retry verifies absence")
	await testFencedTeardownDoesNotImportSandboxResults()
	console.log("  ok   OpenShell fenced teardown never imports sandbox results")
}

void main().catch((error) => { console.error(error); process.exitCode = 1 }).finally(() => { fs.closeSync(controlSocketFd); fs.rmSync(actualControlSockets, { recursive: true, force: true }) })
