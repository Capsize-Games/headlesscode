import * as fs from "node:fs/promises"
import * as path from "node:path"
import * as os from "node:os"
import { createHash } from "node:crypto"
import { execFileSync } from "node:child_process"
import { initializeTaskRepository } from "./openshell-agent.js"
import { materializeBenchmarkSnapshot, resolveBenchmarkFixturePath } from "./runner.js"
import type { LoadedBenchmark, BenchmarkVerifier } from "./runner.js"
import type { BenchmarkTask } from "./types.js"

async function installOracle(loaded: LoadedBenchmark, task: BenchmarkTask, workspace: string, oraclePath?: string, oracleCommit?: string): Promise<void> {
	if (oracleCommit) {
		await fs.rm(workspace, { recursive: true, force: true })
		await materializeBenchmarkSnapshot({ ...task, startCommit: oracleCommit }, loaded.repoRoot, workspace)
		await initializeTaskRepository(workspace)
		return
	}
	if (!oraclePath) throw new Error(`oracle has no solution reference: ${task.id}`)
	const source = await resolveBenchmarkFixturePath(loaded.fixtureRoot, oraclePath)
	const raw = JSON.parse(await fs.readFile(source, "utf8")) as { files?: Record<string, string> }
	if (!raw.files || typeof raw.files !== "object") throw new Error(`oracle has no file map: ${task.id}`)
	for (const [relative, content] of Object.entries(raw.files)) {
		if (!relative || relative.includes("\\") || path.posix.isAbsolute(relative) || relative.split("/").some((segment) => ["", ".", "..", ".git", "__rsi_benchmark_verifier__"].includes(segment)) || typeof content !== "string") throw new Error(`oracle has an unsafe file entry: ${task.id}`)
		const target = path.resolve(workspace, relative)
		if (!target.startsWith(workspace + path.sep)) throw new Error(`oracle path escaped workspace: ${relative}`)
		await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 })
		await fs.writeFile(target, content, { mode: 0o600 })
	}
	execFileSync("git", ["add", "--all"], { cwd: workspace, stdio: "ignore" })
	execFileSync("git", ["-c", "core.hooksPath=/dev/null", "commit", "--amend", "--quiet", "--no-edit"], { cwd: workspace, stdio: "ignore" })
}

export async function verifyBenchmarkOracles(loaded: LoadedBenchmark, verifier: BenchmarkVerifier, taskIds?: string[]): Promise<{ total: number; goodPassed: number; badRejected: number; results: Array<{ taskId: string; split: string; goodPassed: boolean; badRejected: boolean; goodRuntimeMs: number; badRuntimeMs: number; goodOutputSha256: string; badOutputSha256: string }> }> {
	let goodPassed = 0
	let badRejected = 0
	const results: Array<{ taskId: string; split: string; goodPassed: boolean; badRejected: boolean; goodRuntimeMs: number; badRuntimeMs: number; goodOutputSha256: string; badOutputSha256: string }> = []
	const selected = taskIds ? loaded.manifest.tasks.filter((task) => taskIds.includes(task.id)) : loaded.manifest.tasks
	if (taskIds && selected.length !== new Set(taskIds).size) throw new Error("oracle task selection contains an unknown or duplicate task ID")
	for (const task of selected) {
		const record = { taskId: task.id, split: task.split, goodPassed: false, badRejected: false, goodRuntimeMs: 0, badRuntimeMs: 0, goodOutputSha256: "", badOutputSha256: "" }
		for (const [oraclePath, oracleCommit, expected] of [[task.knownGoodPath, task.knownGoodCommit, true], [task.knownBadPath, task.knownBadCommit, false]] as const) {
			const workspace = await fs.mkdtemp(path.join(os.tmpdir(), `headlesscode-oracle-${task.id}-`))
			try {
				await fs.rm(workspace, { recursive: true, force: true })
				if (task.startCommit) {
					await materializeBenchmarkSnapshot(task, loaded.repoRoot, workspace)
				} else {
					const startPath = path.resolve(loaded.fixtureRoot, task.startPath!)
					await fs.cp(startPath, workspace, { recursive: true, errorOnExist: true, force: false, dereference: false })
				}
				await initializeTaskRepository(workspace)
				await installOracle(loaded, task, workspace, oraclePath, oracleCommit)
				const started = Date.now()
				const result = await verifier.run(task, loaded.fixtureRoot, workspace)
				const elapsed = Date.now() - started
				const outputDigest = createHash("sha256").update(result.output).digest("hex")
				if (expected) {
					if (!result.success) throw new Error(`${task.id}: known-good verifier failed; refusing to qualify the pair: ${result.output}`)
					record.goodPassed = true
					record.goodRuntimeMs = elapsed
					record.goodOutputSha256 = outputDigest
					goodPassed += 1
				} else if (!result.success) {
					record.badRejected = true
					record.badRuntimeMs = elapsed
					record.badOutputSha256 = outputDigest
					badRejected += 1
				} else throw new Error(`${task.id}: verifier accepted known-bad snapshot`)
			} finally { await fs.rm(workspace, { recursive: true, force: true }) }
		}
		results.push(record)
	}
	return { total: results.length, goodPassed, badRejected, results }
}
