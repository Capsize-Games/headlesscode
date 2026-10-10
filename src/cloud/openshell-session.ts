/** Run one task in an OpenShell sandbox, preserving its Git worktree afterwards. */
import * as fs from "node:fs"
import * as path from "node:path"
import { spawnSync } from "node:child_process"
import { writeTaskFiles } from "../orchestrator/cli.js"
import type { WorktreeSpec } from "../orchestrator/split.js"
import { runOpenShellWorktreeCommand } from "./openshell-worker.js"
import { OPENSHELL_HARNESS_ROOT } from "./openshell-provider.js"
import type { ContainedRuntimeProfile } from "../security/profile.js"

const USAGE = `headlesscode openshell-session --repo <path> --task <text> [options]

Options:
  --repo <path>       Git repository root (required)
  --task <text>        Task prompt (required)
  --mode <slug>        HeadlessCode mode (default: code)
  --model <id>         Optional model override
  --name <name>        Worktree name (default: openshell-<timestamp>)
  --timeout-ms <n>     Maximum task runtime (default: 1800000)
  --image <image>      OpenShell sandbox image
  --policy <path>      Reviewed OpenShell policy YAML (required)
  --provider <name>    OpenShell credential provider (repeatable; default: headlesscode-openrouter)
  --cpu <quantity>     CPU limit (default: 2)
  --memory <quantity>  Memory limit (default: 4Gi)
`

export async function openShellSessionMain(argv: string[], options: { containedProfile?: ContainedRuntimeProfile } = {}): Promise<number> {
	const parsed = parseArgs(argv)
	if (parsed.help) {
		process.stdout.write(USAGE)
		return 0
	}
	if (parsed.error) {
		process.stderr.write(`headlesscode openshell-session: ${parsed.error}\n\n${USAGE}`)
		return 2
	}
	const repo = path.resolve(parsed.repo!)
	if (!fs.existsSync(path.join(repo, ".git"))) {
		process.stderr.write(`headlesscode openshell-session: ${repo} is not a Git repository root\n`)
		return 2
	}
	const policy = parsed.policy ?? process.env.HEADLESSCODE_OPENSHELL_POLICY
	if (!policy) {
		process.stderr.write("headlesscode openshell-session: pass --policy or set HEADLESSCODE_OPENSHELL_POLICY to a reviewed policy\n")
		return 2
	}
	const providers = parsed.providerNames ?? (process.env.HEADLESSCODE_OPENSHELL_PROVIDERS ?? "headlesscode-openrouter").split(",").map((value) => value.trim()).filter(Boolean)
	if (options.containedProfile && (policy !== options.containedProfile.policySnapshotPath || parsed.image && parsed.image !== options.containedProfile.image || parsed.providerNames && parsed.providerNames.join("\0") !== options.containedProfile.providers.join("\0"))) {
		process.stderr.write("headlesscode openshell-session: explicit options differ from the resolved contained profile\n")
		return 2
	}
	if (providers.includes("headlesscode-openrouter") && !process.env.HEADLESSCODE_OPENROUTER_API_KEY) {
		process.stderr.write("headlesscode openshell-session: export HEADLESSCODE_OPENROUTER_API_KEY so OpenShell can store it in the headlesscode-openrouter provider\n")
		return 2
	}
	const name = parsed.name ?? `openshell-${Date.now()}`
	if (!/^[A-Za-z0-9._-]+$/.test(name) || name === "." || name === "..") {
		process.stderr.write("headlesscode openshell-session: --name may contain only letters, numbers, dot, underscore, and hyphen\n")
		return 2
	}
	const taskFile = `${name}.md`
	const spec: WorktreeSpec = { name, issues: [0], taskFile }
	const issue = { number: 0, title: "User task", body: parsed.task }
	writeTaskFiles(repo, [spec], [issue])
	const worktree = path.join(repo, ".worktrees", name)
	const branch = `headlesscode/${name}-${Date.now()}`
	const added = spawnSync("git", ["worktree", "add", "-b", branch, worktree, "HEAD"], { cwd: repo, encoding: "utf8" })
	if (added.status !== 0) {
		process.stderr.write(`headlesscode openshell-session: worktree creation failed: ${added.stderr || added.stdout}\n`)
		return 1
	}
	fs.copyFileSync(path.join(repo, "plans", "parallel-tasks", taskFile), path.join(worktree, "ORCHESTRATOR_TASK.md"))
	try {
		const cliArgs = [
			"--task-file", path.join(worktree, "ORCHESTRATOR_TASK.md"),
			"--workspace", worktree,
			"--mode", parsed.mode ?? "code",
			...(parsed.model ? ["--model", parsed.model] : []),
		]
		const command = `cd ${quote(OPENSHELL_HARNESS_ROOT)} && timeout --signal=TERM --kill-after=10s ${Math.ceil((parsed.timeoutMs ?? 1_800_000) / 1000)}s ./node_modules/.bin/tsx src/cli.ts ${cliArgs.map(quote).join(" ")}`
		const result = await runOpenShellWorktreeCommand(repo, worktree, command, {
			...(parsed.model ? { OPENROUTER_MODEL: parsed.model } : {}),
			ORCHESTRATOR_MODE: parsed.mode ?? "code",
		}, {
			image: options.containedProfile?.image ?? parsed.image,
			policy,
			providers: options.containedProfile?.providers ? [...options.containedProfile.providers] : providers,
			cpu: options.containedProfile?.cpu ?? parsed.cpu,
			memory: options.containedProfile?.memory ?? parsed.memory,
			...(options.containedProfile ? { containedProfile: options.containedProfile, autoProviders: false, includeProjectData: false } : {}),
		})
		process.stdout.write(`OpenShell task finished: ${worktree}\nExit code: ${result.exitCode}\n${result.output}\n`)
		return result.exitCode === 0 ? 0 : 1
	} catch (error) {
		process.stderr.write(`headlesscode openshell-session: ${error instanceof Error ? error.message : String(error)}\n`)
		return 1
	}
}

interface Args { repo?: string; task?: string; mode?: string; model?: string; name?: string; policy?: string; image?: string; providerNames?: string[]; cpu?: string; memory?: string; timeoutMs?: number; help?: boolean; error?: string }

function parseArgs(argv: string[]): Args {
	const out: Args = {}
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i]
		if (arg === "--help" || arg === "-h") out.help = true
		else if (["--repo", "--task", "--mode", "--model", "--name", "--policy", "--image", "--timeout-ms", "--provider", "--cpu", "--memory"].includes(arg)) {
			const value = argv[++i]
			if (!value || value.startsWith("--")) return { error: `missing value for ${arg}` }
			if (arg === "--repo") out.repo = value
			else if (arg === "--task") out.task = value
			else if (arg === "--mode") out.mode = value
			else if (arg === "--model") out.model = value
			else if (arg === "--name") out.name = value
			else if (arg === "--policy") out.policy = value
			else if (arg === "--image") out.image = value
			else if (arg === "--provider") (out.providerNames ??= []).push(value)
			else if (arg === "--cpu") out.cpu = value
			else if (arg === "--memory") out.memory = value
			else {
				const timeoutMs = Number(value)
				if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1000) return { error: "--timeout-ms must be an integer of at least 1000" }
				out.timeoutMs = timeoutMs
			}
		} else return { error: `unknown option ${arg}` }
	}
	if (!out.help && (!out.repo || !out.task)) return { error: "--repo and --task are required" }
	return out
}

function quote(value: string): string { return `'${value.replace(/'/g, `'\\''`)}'` }
