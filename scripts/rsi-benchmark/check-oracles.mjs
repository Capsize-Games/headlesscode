import { execFileSync, spawnSync } from "node:child_process"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { fileURLToPath } from "node:url"
import { createHash } from "node:crypto"
import { materializeBenchmarkSnapshot } from "../../src/rsi/benchmark/runner.ts"
import { classifyOracleChild } from "../../src/rsi/benchmark/oracle-process.mjs"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")
const fixtureRoot = path.join(root, "fixtures/rsi-benchmark")
const manifest = JSON.parse(await fs.readFile(path.join(fixtureRoot, "manifest.json"), "utf8"))
const failures = []
const results = []
const selected = new Set(process.argv.slice(2))
const runVerifier = async (task, commit, label) => {
	const started = Date.now()
	const workspace = await fs.mkdtemp(path.join(os.tmpdir(), `rsi-oracle-${task.id}-${label}-`))
	try {
		await fs.rmdir(workspace)
		await materializeBenchmarkSnapshot({ ...task, startCommit: commit }, root, workspace)
		await fs.symlink(path.join(root, "node_modules"), path.join(workspace, "node_modules"), "dir")
		execFileSync("git", ["init", "--quiet", "--initial-branch=main"], { cwd: workspace })
		execFileSync("git", ["config", "user.name", "Oracle Qualification"], { cwd: workspace })
		execFileSync("git", ["config", "user.email", "oracle@invalid.example"], { cwd: workspace })
		execFileSync("git", ["add", "--all"], { cwd: workspace })
		execFileSync("git", ["-c", "core.hooksPath=/dev/null", "commit", "--quiet", "-m", "oracle snapshot"], { cwd: workspace })
		const tsxRuntime = process.env.HEADLESSCODE_BENCHMARK_TSX ?? path.join(root, "node_modules/tsx/dist/cli.mjs")
		const result = spawnSync(process.execPath, [path.join(root, "node_modules/tsx/dist/cli.mjs"), path.join(fixtureRoot, task.verifierPath), workspace, task.id], {
			cwd: workspace, encoding: "utf8", timeout: 120_000, maxBuffer: 4 * 1024 * 1024,
			env: { ...process.env, HOME: workspace, HEADLESSCODE_BENCHMARK_TSX: tsxRuntime },
		})
		const output = `${result.stdout ?? ""}${result.stderr ?? ""}`
		// Only the verifier process itself timing out, being signaled, or failing
		// to spawn is infrastructure. Candidate import/assertion failures are the
		// expected fail-before result and may include missing candidate modules or
		// text about a timeout that the task is meant to fix.
		const timedOut = result.error?.code === "ETIMEDOUT" || result.signal === "SIGTERM" || /spawnSync .* ETIMEDOUT|spawn .* ETIMEDOUT/i.test(output)
		const classified = classifyOracleChild(result)
		const kind = timedOut ? "timeout" : classified
		return {
			elapsedMs: Date.now() - started,
			kind,
			exitCode: result.status,
			signal: result.signal,
			output,
			outputSha256: createHash("sha256").update(output).digest("hex"),
		}
	} finally { await fs.rm(workspace, { recursive: true, force: true }) }
}

for (const task of manifest.tasks.filter((entry) => selected.size === 0 || selected.has(entry.id))) {
	const record = { id: task.id, split: task.split, status: "invalid", badRejected: false, goodPassed: false, badRuntimeMs: null, goodRuntimeMs: null, badExitKind: "not-run", goodExitKind: "not-run", badExitCode: null, goodExitCode: null, badOutputSha256: null, goodOutputSha256: null, badOutput: "", goodOutput: "" }
	try {
		const good = await runVerifier(task, task.knownGoodCommit, "known-good")
		record.goodRuntimeMs = good.elapsedMs
		record.goodExitKind = good.kind
		record.goodExitCode = good.exitCode
		record.goodOutputSha256 = good.outputSha256
		record.goodOutput = good.output.slice(-6000)
		record.goodPassed = good.kind === "pass"
		if (!record.goodPassed) throw new Error(`${task.id}: known-good verifier was ${good.kind} (exit ${good.exitCode ?? "none"}): ${record.goodOutput}`)

		const bad = await runVerifier(task, task.knownBadCommit, "known-bad")
		record.badRuntimeMs = bad.elapsedMs
		record.badExitKind = bad.kind
		record.badExitCode = bad.exitCode
		record.badOutputSha256 = bad.outputSha256
		record.badOutput = bad.output.slice(-6000)
		if (bad.kind === "test-failure") {
			record.badRejected = true
			record.status = "qualified"
		} else if (bad.kind === "pass") {
			throw new Error(`${task.id}: verifier accepted known-bad snapshot`)
		} else {
			throw new Error(`${task.id}: known-bad verifier was ${bad.kind} (exit ${bad.exitCode ?? "none"}): ${record.badOutput}`)
		}
	} catch (error) {
		failures.push(error instanceof Error ? error.message : String(error))
	}
	results.push(record)
	process.stdout.write(`${task.id}: ${record.status === "qualified" ? "fail-before/pass-after" : "INVALID"}\n`)
}
await fs.writeFile(path.join(fixtureRoot, "oracle-qualification.json"), `${JSON.stringify({ schemaVersion: 2, manifestDigest: createHash("sha256").update(await fs.readFile(path.join(fixtureRoot, "manifest.json"))).digest("hex"), runtime: "local-host-triage; production acceptance requires check-oracles in OpenShell", selectedTasks: results.map((entry) => entry.id), results, excludedOrReplaced: [] }, null, 2)}\n`)
if (failures.length) {
	process.stderr.write(`${failures.length} oracle qualification failure(s):\n${failures.join("\n")}\n`)
	process.exitCode = 1
} else process.stdout.write(`Qualified fail-before/pass-after for ${results.length} selected repository task(s).\n`)
