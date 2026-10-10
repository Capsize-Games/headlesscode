import * as fs from "node:fs"
import * as path from "node:path"
import { execFileSync } from "node:child_process"

import { OPENSHELL_HARNESS_ROOT, OpenShellSessionProvider } from "./openshell-provider.js"
import type { OpenShellSessionProviderOptions } from "./openshell-provider.js"
import type { CloudSessionRequest, CommandResult } from "./provider.js"
import { loadResolvedContainedProfile } from "../security/profile.js"

const FORWARDED_ENV = [
	"OPENROUTER_MODEL", "OPENROUTER_BASE_URL", "HEADLESSCODE_PROJECT", "HEADLESSCODE_MEMORY_DIR",
	"HEADLESSCODE_MAX_COST_USD", "HEADLESSCODE_MAX_DURATION_MS", "HEADLESSCODE_MAX_ITERATIONS",
	"HEADLESSCODE_WINDOW_SIZE", "HEADLESSCODE_DECISION_TIMEOUT_MS", "HEADLESSCODE_PRICING_JSON",
	"HEADLESSCODE_CODE_MODE_BACKEND", "HEADLESSCODE_LOCAL_BACKEND_MODES", "HEADLESSCODE_CODE_MODE_MODEL",
]

function forwardedEnvironment(env: Record<string, string>): Record<string, string> {
	const forwarded: Record<string, string> = {}
	for (const [key, value] of Object.entries({ ...process.env, ...env })) {
		if (value !== undefined && (FORWARDED_ENV.includes(key) || key.startsWith("HEADLESSCODE_OLLAMA_") || key.startsWith("HEADLESSCODE_CODE_MODE_MODEL__"))) {
			forwarded[key] = value
		}
	}
	return forwarded
}

function hostGitIdentity(repo: string): Record<string, string> {
	const identity = (variable: "GIT_AUTHOR_IDENT" | "GIT_COMMITTER_IDENT"): { name: string; email: string } | undefined => {
		const result = execFileSync("git", ["var", variable], { cwd: repo, encoding: "utf8" }).trim()
		const match = /^(.*) <([^<>]+)> \d+ [+-]\d{4}$/.exec(result)
		return match ? { name: match[1], email: match[2] } : undefined
	}
	try {
		const author = identity("GIT_AUTHOR_IDENT")
		const committer = identity("GIT_COMMITTER_IDENT")
		if (!author || !committer) return {}
		return {
			GIT_AUTHOR_NAME: author.name,
			GIT_AUTHOR_EMAIL: author.email,
			GIT_COMMITTER_NAME: committer.name,
			GIT_COMMITTER_EMAIL: committer.email,
		}
	} catch {
		// The host can still inspect changes, but Git commits inside the image
		// require a configured host identity or explicit GIT_* identity env.
		return {}
	}
}

/** Run a command inside an OpenShell sandbox for an existing host worktree. */
export async function runOpenShellWorktreeCommand(
	repo: string,
	worktree: string,
	command: string,
	env: Record<string, string> = {},
	providerOptions: OpenShellSessionProviderOptions = {},
): Promise<CommandResult> {
	const contained = process.env.HEADLESSCODE_SECURITY_PROFILE === "contained"
	const containedProfile = providerOptions.containedProfile ?? (contained ? loadResolvedContainedProfile(process.env.HEADLESSCODE_CONTAINED_RUNTIME_PROFILE_JSON) : undefined)
	if (contained && !containedProfile) throw new Error("contained route has no supervisor-resolved immutable profile")
	const policy = containedProfile?.policySnapshotPath ?? providerOptions.policy ?? process.env.HEADLESSCODE_OPENSHELL_POLICY
	if (!policy || !fs.existsSync(policy)) throw new Error("set HEADLESSCODE_OPENSHELL_POLICY to an existing base policy YAML")
	const providers = containedProfile ? [...containedProfile.providers] : providerOptions.providers ?? (process.env.HEADLESSCODE_OPENSHELL_PROVIDERS ?? "headlesscode-openrouter").split(",").map((value) => value.trim()).filter(Boolean)
	if (providers.includes("headlesscode-openrouter") && !process.env.HEADLESSCODE_OPENROUTER_API_KEY) throw new Error("set HEADLESSCODE_OPENROUTER_API_KEY so OpenShell can provide the imported credential profile")
	const worktreePath = path.resolve(worktree)
	const repoPath = path.resolve(repo)
	const name = path.basename(worktreePath)
	const memoryDir = env.HEADLESSCODE_MEMORY_DIR ?? process.env.HEADLESSCODE_MEMORY_DIR
	const memoryPath = memoryDir ? path.resolve(memoryDir) : undefined
	if (memoryPath) fs.mkdirSync(memoryPath, { recursive: true })
	const provider = new OpenShellSessionProvider({
		...providerOptions,
		...(containedProfile ? {
			containedProfile,
			image: containedProfile.image,
			cpu: containedProfile.cpu,
			memory: containedProfile.memory,
			autoProviders: false,
			includeProjectData: false,
		} : {}),
		policy,
		providers,
	})
	const request: CloudSessionRequest = {
		repo: repoPath,
		issue: { number: 0, title: `HeadlessCode worker ${name}` },
		worktreeSpec: { name, issues: [], taskFile: "ORCHESTRATOR_TASK.md" },
		env: {
			...forwardedEnvironment(env),
			...hostGitIdentity(repoPath),
			...env,
		},
	}
	let handle
	try {
		handle = await provider.spawnExistingWorktreeSession(request, worktreePath)
		await provider.waitReady(handle)
		return await provider.runHarness(handle, command)
	} finally {
		if (handle) await provider.teardown(handle)
	}
}

export function mainRepositoryForWorktree(worktree: string): string {
	const root = path.resolve(worktree)
	const commonDir = execFileSync("git", ["rev-parse", "--git-common-dir"], { cwd: root, encoding: "utf8" }).trim()
	return path.dirname(path.resolve(root, commonDir))
}

/** Internal CLI command used by scripts/run-worker.sh. */
export async function openShellWorkerMain(argv: string[]): Promise<number> {
	const separator = argv.indexOf("--")
	const flags = separator < 0 ? argv : argv.slice(0, separator)
	const workerArgs = separator < 0 ? [] : argv.slice(separator + 1)
	let repo = ""
	let worktree = ""
	for (let i = 0; i < flags.length; i++) {
		if (flags[i] === "--repo") repo = flags[++i] ?? ""
		else if (flags[i] === "--worktree") worktree = flags[++i] ?? ""
		else {
			process.stderr.write(`headlesscode openshell-worker: unknown argument ${flags[i]}\n`)
			return 2
		}
	}
	if (!repo || !worktree || workerArgs.length === 0) {
		process.stderr.write("Usage: headlesscode openshell-worker --repo <repo> --worktree <path> -- <worker CLI args...>\n")
		return 2
	}
	const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`
	const cli = process.env.HEADLESSCODE_SANDBOX_CLI ?? "node_modules/.bin/tsx src/cli.ts"
	const command = `cd ${quote(OPENSHELL_HARNESS_ROOT)} && ${cli} ${workerArgs.map(quote).join(" ")}`
	try {
		const result = await runOpenShellWorktreeCommand(repo, worktree, command)
		process.stdout.write(result.output)
		return result.exitCode
	} catch (error) {
		process.stderr.write(`headlesscode openshell-worker: ${error instanceof Error ? error.message : String(error)}\n`)
		return 1
	}
}
