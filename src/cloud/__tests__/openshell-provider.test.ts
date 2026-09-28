import assert from "node:assert/strict"
import { execFileSync, spawnSync } from "node:child_process"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { OpenShellSessionProvider } from "../openshell-provider.js"
import type { CloudSessionRequest } from "../provider.js"

async function testIsolatedCloneExportAndImport(): Promise<void> {
	const repo = fs.mkdtempSync(path.join(os.tmpdir(), "headlesscode-openshell-isolation-test-"))
	const hostWorkspace = path.join(repo, ".worktrees", "worker")
	const policy = path.join(repo, "policy.yaml")
	const memoryDir = path.join(repo, "host-memory")
	const promptDir = path.join(repo, "prompt-source")
	let sandboxWorkspace = ""
	let resultDir = ""
	let memorySnapshotDir = ""
	let lastExecutedCommand = ""
	let createArgs: string[] = []
	try {
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
		fs.writeFileSync(policy, "version: 1\nfilesystem_policy:\n  include_workdir: true\n  read_only: [/usr, /lib, /etc]\n  read_write: [/sandbox, /tmp, /dev/null]\nlandlock:\n  compatibility: hard_requirement\n")
		const cliRun = (args: string[]) => {
			if (args[0] === "sandbox" && args[1] === "create") {
				createArgs = args
				const driver = JSON.parse(args[args.indexOf("--driver-config-json") + 1]) as { docker: { mounts: Array<{ source: string; target: string }> } }
				sandboxWorkspace = driver.docker.mounts.find((mount) => mount.target === "/workspace")!.source
				resultDir = driver.docker.mounts.find((mount) => mount.target === "/result")!.source
				memorySnapshotDir = driver.docker.mounts.find((mount) => mount.target === "/opt/headlesscode-memory")!.source
				return { exitCode: 0, output: "created" }
			}
			if (args[0] === "sandbox" && args[1] === "delete") return { exitCode: 0, output: "deleted" }
			if (args[0] === "sandbox" && args[1] === "exec") {
				let command = args.at(-1) ?? ""
				if (args.includes("--workdir") && args[args.indexOf("--workdir") + 1] === "/workspace") {
					lastExecutedCommand = command
					command = command.replaceAll("/workspace", "__WORKSPACE__").replaceAll("/result/", "__RESULT__/").replaceAll("/opt/headlesscode-memory", "__MEMORY__").replaceAll("__WORKSPACE__", sandboxWorkspace).replaceAll("__RESULT__", resultDir).replaceAll("__MEMORY__", memorySnapshotDir)
					const executed = spawnSync("/bin/bash", ["-c", command], { cwd: sandboxWorkspace, encoding: "utf8", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" } })
					return { exitCode: executed.status ?? 1, output: `${executed.stdout ?? ""}${executed.stderr ?? ""}` }
				}
				return { exitCode: 0, output: "ready" }
			}
			return { exitCode: 1, output: `unexpected: ${args.join(" ")}` }
		}
		const provider = new OpenShellSessionProvider({ image: "worker:test", policy, providers: [], scratchRoot: path.join(repo, "gateway-visible-scratch"), readOnlyMounts: [{ source: promptDir, target: "/workspace/.headlesscode-session" }], run: cliRun, listSandboxes: () => [] })
		const request: CloudSessionRequest = { repo, issue: { number: 1, title: "test" }, worktreeSpec: { name: "worker", issues: [1], taskFile: "worker.md" }, env: { HEADLESSCODE_MEMORY_DIR: memoryDir } }
		const handle = await provider.spawnExistingWorktreeSession(request, hostWorkspace)
		assert.equal(handle.address, hostWorkspace)
		const mounts = JSON.parse(createArgs[createArgs.indexOf("--driver-config-json") + 1]).docker.mounts as Array<{ source: string; target: string }>
		assert.deepEqual(mounts.map((mount) => mount.target).slice(0, 2), ["/workspace", "/result"])
		assert.equal(mounts.some((mount) => mount.source === repo || mount.source === hostWorkspace), false, "host repository and orchestration worktree are never bind-mounted")
		const memoryMount = mounts.find((mount) => mount.target === "/opt/headlesscode-memory")!
		assert.notEqual(memoryMount.source, memoryDir, "configured host memory is snapshotted instead of mounted")
		assert.equal(fs.readFileSync(path.join(sandboxWorkspace, ".headlesscode-session", "review-prompt.md"), "utf8"), "review instructions\n", "review prompt directory maps to the requested in-workspace target")
		assert.equal(fs.readFileSync(path.join(sandboxWorkspace, "ORCHESTRATOR_PLAN.md"), "utf8"), "plan prompt\n", "plan-first input is copied into the isolated workspace")
		assert.equal(fs.readFileSync(path.join(sandboxWorkspace, ".env"), "utf8"), "\n", "tracked .env is filtered before sandbox execution")
		const duplicateAttempt = provider.spawnExistingWorktreeSession(request, hostWorkspace)
		await assert.rejects(duplicateAttempt, /already held|EEXIST|file already exists/i)
		assert.ok(fs.existsSync(sandboxWorkspace), "a duplicate launch cannot remove the active sandbox clone")
		const commandResult = await provider.runHarness(handle, "test -d /opt/headlesscode-memory && printf 'sandbox change\\n' > result.txt && printf 'sandbox overwrite\\n' > .harness.pgid && printf 'secret=bad\\n' > .env")
		assert.equal(commandResult.exitCode, 0, commandResult.output)
		assert.ok(!lastExecutedCommand.includes(memoryDir), "host memory path in commands is remapped")
		fs.appendFileSync(path.join(memoryMount.source, "facts", "project.jsonl"), '{"content":"learned in sandbox"}\n')
		await provider.teardown(handle)
		assert.equal(fs.readFileSync(path.join(hostWorkspace, "result.txt"), "utf8"), "sandbox change\n")
		assert.equal(execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: hostWorkspace, encoding: "utf8" }).trim(), hostWorkspace)
		assert.equal(fs.readFileSync(path.join(hostWorkspace, ".harness.pgid"), "utf8"), "123\n")
		assert.equal(fs.readFileSync(path.join(hostWorkspace, ".env"), "utf8"), "SECRET=must-not-enter-the-sandbox\n", "sandbox environment files are not imported over tracked host content")
		assert.equal(fs.readFileSync(path.join(hostWorkspace, ".env.example"), "utf8"), "EXAMPLE=value\n", "tracked env example remains unchanged")
		assert.equal(fs.readFileSync(path.join(hostWorkspace, ".env"), "utf8"), "SECRET=must-not-enter-the-sandbox\n", "tracked host .env remains unchanged")
		assert.equal(fs.existsSync(path.join(hostWorkspace, ".harness.openshell-sandbox")), false)
		assert.match(fs.readFileSync(path.join(memoryDir, "facts", "project.jsonl"), "utf8"), /learned in sandbox/, "validated memory JSONL is imported after teardown")
	} finally {
		fs.rmSync(repo, { recursive: true, force: true })
	}
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

testIsolatedCloneExportAndImport().then(
	() => console.log("  ok   OpenShell exports isolated clone results without mounting the host worktree"),
	(error) => { console.error(error); process.exitCode = 1 },
)

testSandboxNameIsStableAndDistinct().then(
	() => console.log("  ok   OpenShell sandbox names are stable per repo+worktree and distinct across worktrees"),
	(error) => { console.error(error); process.exitCode = 1 },
)
