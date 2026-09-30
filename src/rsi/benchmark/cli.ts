import { execFileSync } from "node:child_process"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import { loadBenchmark, freezeBenchmarkProtocol, runBenchmark, printBenchmarkSummary } from "./runner.js"
import { OpenShellBenchmarkAgent, OpenShellBenchmarkVerifier } from "./openshell-agent.js"
import type { BenchmarkSplit } from "./types.js"

interface Options {
	repo: string
	fixtures: string
	output: string
	harnessCommit?: string
	model: string
	provider: string
	sampling: Record<string, number | string | boolean>
	split: BenchmarkSplit
	taskId?: string
	replayFile?: string
}

function usage(): string {
	return `Usage: headlesscode rsi-benchmark <command> [options]

Commands:
  verify-fixtures            Check all manifest, start, verifier and oracle digests
  check-oracles              Run known-good and known-bad oracles in OpenShell
  freeze                     Freeze protocol identity before confirmation evaluation
  baseline                   Run the development split for a pinned harness commit
  confirm                    Explicitly run confirmation after freeze
  replay                     Import and re-verify a recorded agent result for one task

Options:
  --repo <path>              Harness checkout (default: current directory)
  --fixtures <path>          Benchmark fixtures (default: fixtures/rsi-benchmark)
  --output <path>            Results and content-addressed artifacts directory
  --harness-commit <sha>     Exact harness commit under evaluation
  --model <id>               Local Ollama model ID (default: wxrq-qwen3.5-9b:latest)
  --provider <id>            Provider identity (default: openshell-ollama)
  --task <id>                Single task ID (required for replay)
  --result <path>            JSON completion with optional patchBase64 (replay only)
`
}

function parse(argv: string[]): { command?: string; options?: Options; help?: boolean; error?: string } {
	const command = argv[0]
	const options: Options = {
		repo: process.cwd(), fixtures: path.resolve(process.cwd(), "fixtures/rsi-benchmark"),
		output: path.resolve(process.cwd(), ".headlesscode/rsi-benchmark"),
		model: "wxrq-qwen3.5-9b:latest", provider: "openshell-ollama",
		sampling: { temperature: 0, think: false, seed: "provider-default" }, split: "development",
	}
	try {
		for (let index = 1; index < argv.length; index++) {
			const arg = argv[index]!
			if (arg === "--help" || arg === "-h") return { command, options, help: true }
			const value = argv[index + 1]
			if (!value || value.startsWith("--")) throw new Error(`${arg} requires a value`)
			switch (arg) {
				case "--repo": options.repo = path.resolve(value); break
				case "--fixtures": options.fixtures = path.resolve(value); break
				case "--output": options.output = path.resolve(value); break
				case "--harness-commit": options.harnessCommit = value; break
				case "--model": options.model = value; break
				case "--provider": options.provider = value; break
				case "--task": options.taskId = value; break
				case "--result": options.replayFile = path.resolve(value); break
				default: throw new Error(`unknown argument ${arg}`)
			}
			index++
		}
		if (!["verify-fixtures", "check-oracles", "freeze", "baseline", "confirm", "replay"].includes(command ?? "")) throw new Error(`unknown rsi-benchmark command: ${command ?? ""}`)
		return { command, options }
	} catch (error) { return { command, options, error: error instanceof Error ? error.message : String(error) } }
}

export async function benchmarkMain(argv: string[]): Promise<number> {
	const parsed = parse(argv)
	if (parsed.help) { process.stdout.write(usage()); return 0 }
	if (parsed.error || !parsed.command || !parsed.options) { process.stderr.write(`headlesscode rsi-benchmark: ${parsed.error ?? "invalid command"}\n${usage()}`); return 2 }
	const options = parsed.options
	try {
		const loaded = await loadBenchmark(options.fixtures, options.repo)
		if (parsed.command === "verify-fixtures") {
			process.stdout.write(`Verified ${loaded.manifest.tasks.length} tasks; manifest ${loaded.manifestDigest}\n`)
			return 0
		}
		if (parsed.command === "check-oracles") {
			const verifier = new OpenShellBenchmarkVerifier(options.repo)
			const harnessCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: options.repo, encoding: "utf8" }).trim()
			const verifierImage = await verifier.imageIdentity(harnessCommit)
			const { verifyBenchmarkOracles } = await import("./oracle-check.js")
			const results = await verifyBenchmarkOracles(loaded, verifier, options.taskId ? [options.taskId] : undefined)
			await fs.mkdir(options.output, { recursive: true, mode: 0o700 })
			await fs.writeFile(path.join(options.output, "oracle-qualification.json"), `${JSON.stringify({ schemaVersion: 1, runtime: "openshell", harnessCommit, verifierImage, manifestDigest: loaded.manifestDigest, total: results.total, goodPassed: results.goodPassed, badRejected: results.badRejected, results: results.results }, null, 2)}\n`, { mode: 0o600 })
			process.stdout.write(`${results.goodPassed}/${results.total} known-good solutions passed; ${results.badRejected}/${results.total} known-bad mutants rejected\n`)
			return results.goodPassed === results.total && results.badRejected === results.total ? 0 : 1
		}
		if (!options.harnessCommit || !/^[a-f0-9]{40}$/.test(options.harnessCommit)) throw new Error("--harness-commit must be a full 40-character commit SHA")
		execFileSync("git", ["cat-file", "-e", `${options.harnessCommit}^{commit}`], { cwd: options.repo, stdio: "ignore" })
		const agent = new OpenShellBenchmarkAgent(options.repo)
		const agentImageIdentity = await agent.imageIdentity(options.harnessCommit)
		if (parsed.command === "freeze") {
			if (options.provider !== agent.provider) throw new Error(`provider ${options.provider} is not available in this runner; use ${agent.provider}`)
			const digest = await freezeBenchmarkProtocol({ loaded, harnessCommit: options.harnessCommit, agentImageIdentity, modelId: options.model, outputRoot: options.output, sampling: options.sampling, provider: agent.provider })
			process.stdout.write(`Frozen benchmark protocol ${digest}\n`)
			return 0
		}
		if (parsed.command === "replay" && (!options.taskId || !options.replayFile)) throw new Error("replay requires --task and --result")
		if (options.provider !== agent.provider) throw new Error(`provider ${options.provider} is not available in this runner; use ${agent.provider}`)
		const verifier = new OpenShellBenchmarkVerifier(options.repo)
		const attempts = await runBenchmark({
			loaded, agent, verifier, harnessCommit: options.harnessCommit, agentImageIdentity, modelId: options.model, sampling: options.sampling,
			split: parsed.command === "confirm" ? "confirmation" : "development",
			confirmProtocol: parsed.command === "confirm", outputRoot: options.output,
			...(options.taskId ? { taskIds: [options.taskId] } : {}),
			...(options.replayFile ? { replayFile: options.replayFile } : {}),
		})
		process.stdout.write(`${printBenchmarkSummary(attempts)}\n`)
		return attempts.length > 0 ? 0 : 1
	} catch (error) {
		process.stderr.write(`headlesscode rsi-benchmark: ${error instanceof Error ? error.message : String(error)}\n`)
		return 2
	}
}
