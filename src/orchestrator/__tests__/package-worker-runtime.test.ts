import assert from "node:assert/strict"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import { execFileSync, spawn, spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { setTimeout as delay } from "node:timers/promises"

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..")
const scratchRoot = path.join(packageRoot, ".headlesscode", "scratch")
await fs.mkdir(scratchRoot, { recursive: true, mode: 0o700 })
process.env.TMPDIR = scratchRoot
const scratch = await fs.mkdtemp(path.join(scratchRoot, "package-worker-runtime-"))

const scrubbedEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
	!/(TOKEN|PASSWORD|SECRET|CREDENTIAL|API_KEY|AUTH)/i.test(key) && !key.startsWith("HEADLESSCODE_")
)) as NodeJS.ProcessEnv
Object.assign(scrubbedEnv, {
	TMPDIR: scratchRoot,
	npm_config_update_notifier: "false",
	npm_config_audit: "false",
	npm_config_fund: "false",
	NPM_CONFIG_USERCONFIG: path.join(scratch, "no-user-npmrc"),
})

async function writeExecutable(file: string, content: string): Promise<void> {
	await fs.writeFile(file, content, { mode: 0o700 })
	await fs.chmod(file, 0o700)
}

async function waitForWorker(workspace: string): Promise<string> {
	const deadline = Date.now() + 10_000
	while (Date.now() < deadline) {
		try {
			await fs.stat(path.join(workspace, ".harness.done"))
			return (await fs.readFile(path.join(workspace, ".harness.exit"), "utf8")).trim()
		} catch { await delay(20) }
	}
	throw new Error(`packed worker did not finish: ${workspace}`)
}

async function waitForJobReceipt(receiptDir: string, group: string): Promise<Record<string, unknown>> {
	const deadline = Date.now() + 10_000
	while (Date.now() < deadline) {
		try { return JSON.parse(await fs.readFile(path.join(receiptDir, `${group}.complete`), "utf8")) as Record<string, unknown> }
		catch { await delay(20) }
	}
	throw new Error(`packed supervisor did not write a completion receipt for ${group}`)
}

async function waitForJobLaunch(receiptDir: string, group: string): Promise<Record<string, unknown>> {
	const deadline = Date.now() + 5_000
	while (Date.now() < deadline) {
		try { return JSON.parse(await fs.readFile(path.join(receiptDir, `${group}.launch`), "utf8")) as Record<string, unknown> }
		catch { await delay(10) }
	}
	throw new Error(`packed supervisor did not write a launch receipt for ${group}`)
}

try {
	const packed = path.join(scratch, "packed")
	const extracted = path.join(scratch, "unpacked")
	await fs.mkdir(packed)
	await fs.mkdir(extracted)
	const packedOutput = execFileSync("npm", ["pack", "--ignore-scripts", "--pack-destination", packed, "--json"], {
		cwd: packageRoot,
		encoding: "utf8",
		env: scrubbedEnv,
	})
	const packResult = JSON.parse(packedOutput) as { filename: string; files: { path: string }[] }[]
	const files = packResult[0]!.files.map((file) => file.path)
	const requiredScripts = [
		"scripts/spawn-parallel-worktrees.sh",
		"scripts/run-worker.sh",
		"scripts/supervise-job-worker.mjs",
		"scripts/run-muse-worker.sh",
		"scripts/stop-worker.sh",
		"scripts/headlesscode-answer.sh",
	]
	for (const file of requiredScripts) assert.ok(files.includes(file), `npm package includes runtime script ${file}`)
	assert.equal(files.some((file) => file.startsWith("scripts/eval-suite/")), false, "packaging excludes protected evaluation scripts")
	assert.equal(files.some((file) => file.startsWith("scripts/") && !requiredScripts.includes(file) && file !== "scripts/deploy-gate.sh"), false, "packaging does not include unrelated scripts")
	execFileSync("tar", ["-xzf", path.join(packed, packResult[0]!.filename), "-C", extracted])
	const unpackedPackage = path.join(extracted, "package")
	const unpackedSupervisor = path.join(unpackedPackage, "scripts/supervise-job-worker.mjs")
	const hiddenSupervisor = `${unpackedSupervisor}.hidden`
	const brokenWorkspace = path.join(scratch, "broken-job-workspace")
	const brokenReceipts = path.join(scratch, "broken-job-receipts")
	await fs.mkdir(brokenWorkspace)
	await fs.mkdir(brokenReceipts, { mode: 0o700 })
	await fs.writeFile(path.join(brokenWorkspace, ".harness.pid"), "424242")
	await fs.rename(unpackedSupervisor, hiddenSupervisor)
	try {
		const missingHelper = spawnSync("bash", [path.join(unpackedPackage, "scripts/run-worker.sh"), brokenWorkspace, "CPU mock task", "--executor", "builtin"], {
			cwd: scratch,
			encoding: "utf8",
			env: { ...scrubbedEnv, HEADLESSCODE_ROOT: unpackedPackage, HEADLESSCODE_CLI: path.join(scratch, "missing-cli"), HEADLESSCODE_JOB_ATTEMPT: "523e4567-e89b-12d3-a456-426614174000", HEADLESSCODE_JOB_RECEIPT_DIR: brokenReceipts },
		})
		assert.notEqual(missingHelper.status, 0, "a missing packaged supervisor must fail startup")
		await assert.rejects(fs.access(path.join(brokenWorkspace, ".harness.pid")), "a stale PID cannot make a new attempt look launched")
		assert.equal((await fs.readdir(brokenReceipts)).some((name) => name.endsWith(".launch")), false, "failed helper startup creates no attempt receipt")
	} finally {
		await fs.rename(hiddenSupervisor, unpackedSupervisor)
	}

	const fakeCli = path.join(scratch, "headlesscode-cli")
	const builtinCapture = path.join(scratch, "builtin-cli-args")
	await writeExecutable(fakeCli, `#!/bin/sh\nprintf '%s\\n' "$*" >> "$BUILTIN_CAPTURE"\nexit 0\n`)
	const builtinWorkspace = path.join(scratch, "builtin-workspace")
	await fs.mkdir(builtinWorkspace)
	const builtinSpawn = spawnSync("bash", [path.join(unpackedPackage, "scripts/run-worker.sh"), builtinWorkspace, "CPU mock task", "--executor", "builtin"], {
		cwd: scratch,
		encoding: "utf8",
		env: { ...scrubbedEnv, HEADLESSCODE_ROOT: unpackedPackage, HEADLESSCODE_CLI: fakeCli, BUILTIN_CAPTURE: builtinCapture },
	})
	assert.equal(builtinSpawn.status, 0, builtinSpawn.stderr)
	assert.match(builtinSpawn.stdout.trim(), /^\d+$/, "builtin dispatch returns its supervised worker PID")
	assert.equal(await waitForWorker(builtinWorkspace), "0")
	const builtinArgs = await fs.readFile(builtinCapture, "utf8")
	assert.match(builtinArgs, /--task /)
	assert.match(builtinArgs, /--workspace /)

	const timeoutWorkspace = path.join(scratch, "job-timeout-workspace")
	const timeoutReceipts = path.join(scratch, "job-timeout-receipts")
	const timeoutWrapper = path.join(scratch, "job-timeout-wrapper.sh")
	const timeoutStarted = path.join(scratch, "job-timeout-started")
	await fs.mkdir(timeoutWorkspace)
	await fs.mkdir(timeoutReceipts, { mode: 0o700 })
	await writeExecutable(timeoutWrapper, `#!/bin/bash\nread -r _ <&3 || exit 125\nprintf started > "${timeoutStarted}"\n`)
	const timeoutAttempt = "723e4567-e89b-12d3-a456-426614174000"
	const unacknowledged = spawn(process.execPath, [unpackedSupervisor, timeoutWorkspace, timeoutReceipts, timeoutAttempt, "timeout-group", timeoutWrapper], {
		cwd: scratch,
		stdio: "ignore",
		timeout: 10_000,
		env: scrubbedEnv,
	})
	const timeoutLaunch = await waitForJobLaunch(timeoutReceipts, "timeout-group")
	await fs.writeFile(path.join(timeoutReceipts, "timeout-group.ack"), JSON.stringify({
		...timeoutLaunch,
		pid: Number(timeoutLaunch.pid) + 1,
		pgid: Number(timeoutLaunch.pgid) + 1,
	}), { mode: 0o600 })
	const unacknowledgedStatus = await new Promise<number | null>((resolve, reject) => {
		unacknowledged.once("error", reject)
		unacknowledged.once("close", (code) => resolve(code))
	})
	assert.equal(unacknowledgedStatus, 2, "a mismatched dispatcher acknowledgment fails closed")
	const timeoutCompletion = JSON.parse(await fs.readFile(path.join(timeoutReceipts, "timeout-group.complete"), "utf8")) as Record<string, unknown>
	assert.equal(timeoutCompletion.attemptId, timeoutAttempt)
	assert.equal(timeoutCompletion.exitCode, 125, "acknowledgment timeout is recorded as a startup failure after teardown")
	const timeoutPgid = Number(timeoutCompletion.pgid)
	assert.ok(Number.isSafeInteger(timeoutPgid) && timeoutPgid > 1)
	assert.throws(() => process.kill(-timeoutPgid, 0), { code: "ESRCH" }, "the gated process group is gone before timeout completion is recorded")
	await assert.rejects(fs.access(timeoutStarted), "the worker wrapper remains gated until a matching acknowledgment is received")

	const jobWorkspace = path.join(scratch, "job-workspace")
	const jobReceipts = path.join(scratch, "job-receipts")
	await fs.mkdir(jobWorkspace)
	await fs.mkdir(jobReceipts, { mode: 0o700 })
	const jobCli = path.join(scratch, "job-cli")
	await writeExecutable(jobCli, "#!/bin/sh\nexit 7\n")
	const jobAttempt = "623e4567-e89b-12d3-a456-426614174000"
	const jobSpawn = spawnSync("bash", [path.join(unpackedPackage, "scripts/run-worker.sh"), jobWorkspace, "CPU mock task", "--executor", "builtin"], {
		cwd: scratch,
		encoding: "utf8",
		env: { ...scrubbedEnv, HEADLESSCODE_ROOT: unpackedPackage, HEADLESSCODE_CLI: jobCli, HEADLESSCODE_JOB_ATTEMPT: jobAttempt, HEADLESSCODE_JOB_RECEIPT_DIR: jobReceipts },
	})
	assert.equal(jobSpawn.status, 0, jobSpawn.stderr)
	assert.match(jobSpawn.stdout.trim(), /^\d+$/, "job dispatch returns the captured worker PID")
	const jobCompletion = await waitForJobReceipt(jobReceipts, "job-workspace")
	const jobLaunch = JSON.parse(await fs.readFile(path.join(jobReceipts, "job-workspace.launch"), "utf8")) as Record<string, unknown>
	assert.equal(jobCompletion.attemptId, jobAttempt)
	assert.equal(jobCompletion.pid, jobLaunch.pid)
	assert.equal(jobCompletion.startTicks, jobLaunch.startTicks)
	assert.equal(jobCompletion.exitCode, 7, "supervisor records actual child exit status")
	const duplicateAttempt = spawnSync("bash", [path.join(unpackedPackage, "scripts/run-worker.sh"), jobWorkspace, "CPU mock task", "--executor", "builtin"], {
		cwd: scratch,
		encoding: "utf8",
		env: { ...scrubbedEnv, HEADLESSCODE_ROOT: unpackedPackage, HEADLESSCODE_CLI: jobCli, HEADLESSCODE_JOB_ATTEMPT: jobAttempt, HEADLESSCODE_JOB_RECEIPT_DIR: jobReceipts },
	})
	assert.notEqual(duplicateAttempt.status, 0, "a second launch cannot reuse an attempt receipt and acknowledgment")
	assert.equal((await fs.readdir(jobReceipts)).filter((name) => name === "job-workspace.launch").length, 1)

	const fakeBin = path.join(scratch, "fake-bin")
	await fs.mkdir(fakeBin)
	const museCapture = path.join(scratch, "muse-args")
	await writeExecutable(path.join(fakeBin, "muse"), `#!/bin/sh\nprintf '%s\\n' "$*" > "$MUSE_CAPTURE"\nprintf '%s\\n' '{"payload_type":"run.terminal.completed","payload":{"kind":"run_terminal","terminal":"completed","reason":null}}'\n`)
	const museWorkspace = path.join(scratch, "muse-workspace")
	await fs.mkdir(museWorkspace)
	const museSpawn = spawnSync("bash", [path.join(unpackedPackage, "scripts/run-worker.sh"), museWorkspace, "CPU mock task", "--executor", "muse"], {
		cwd: scratch,
		encoding: "utf8",
		env: { ...scrubbedEnv, PATH: `${fakeBin}${path.delimiter}${scrubbedEnv.PATH ?? ""}`, HEADLESSCODE_ROOT: unpackedPackage, MUSE_CAPTURE: museCapture },
	})
	assert.equal(museSpawn.status, 0, museSpawn.stderr)
	assert.match(museSpawn.stdout.trim(), /^\d+$/, "native dispatch returns its supervised worker PID")
	assert.equal(await waitForWorker(museWorkspace), "0")
	const museArgs = await fs.readFile(museCapture, "utf8")
	assert.match(museArgs, /exec --provider meta --json/)
	assert.match(museArgs, /--workspace /)
	assert.match(museArgs, /--prompt-file /)
	console.log("Packed worker runtime dispatch passed for builtin and fake Muse executors (no model calls)")
} finally {
	await fs.rm(scratch, { recursive: true, force: true })
}
