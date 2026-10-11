import assert from "node:assert/strict"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import { execFileSync, spawnSync } from "node:child_process"
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
		"scripts/run-muse-worker.sh",
		"scripts/stop-worker.sh",
		"scripts/headlesscode-answer.sh",
	]
	for (const file of requiredScripts) assert.ok(files.includes(file), `npm package includes runtime script ${file}`)
	assert.equal(files.some((file) => file.startsWith("scripts/eval-suite/")), false, "packaging excludes protected evaluation scripts")
	assert.equal(files.some((file) => file.startsWith("scripts/") && !requiredScripts.includes(file) && file !== "scripts/deploy-gate.sh"), false, "packaging does not include unrelated scripts")
	execFileSync("tar", ["-xzf", path.join(packed, packResult[0]!.filename), "-C", extracted])
	const unpackedPackage = path.join(extracted, "package")

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
