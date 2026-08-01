/**
 * `headlesscode checkpoints` subcommand.
 *
 *   npx tsx src/cli.ts checkpoints --workspace <path> list
 *   npx tsx src/cli.ts checkpoints --workspace <path> restore <hash>
 *   npx tsx src/cli.ts checkpoints --workspace <path> diff <hash> [<to-hash>]
 *
 * A human-facing wrapper around src/checkpoints/service.ts. Since each
 * `HeadlessSession` gets its own random taskId (see src/engine/loop.ts), a
 * workspace can have checkpoints from multiple past sessions. This CLI
 * operates on the MOST RECENT session's checkpoints for the workspace (the
 * one most likely relevant to "undo my last run") — found by scanning
 * `<checkpointDir>/tasks/*\/checkpoints` for the shadow repo whose
 * `core.worktree` matches `--workspace` and picking the one with the newest
 * commit. Pass `--task-id <id>` to target a specific session explicitly.
 */

import { execFileSync } from "node:child_process"
import * as fs from "node:fs"
import * as path from "node:path"

import { createCheckpointService, defaultCheckpointDir, type CheckpointService } from "./service.js"

const CHECKPOINTS_USAGE = `headlesscode checkpoints — inspect/revert shadow-git checkpoints

Usage:
  headlesscode checkpoints --workspace <path> list
  headlesscode checkpoints --workspace <path> restore <hash>
  headlesscode checkpoints --workspace <path> diff [<from-hash>] [<to-hash>]

Options:
  --workspace <path>     Workspace root whose checkpoints to inspect (required)
  --checkpoint-dir <path> Shadow-git storage root (default: ${defaultCheckpointDir()})
  --task-id <id>         Operate on this session's checkpoints instead of
                         auto-detecting the most recent one for --workspace
  --help                 Show this help and exit

Commands:
  list                   List checkpoints for the workspace, oldest-first
                         (hash, date, message)
  restore <hash>         Check the shadow ref out onto the real workspace,
                         reverting files to that checkpoint. DESTRUCTIVE:
                         uncommitted changes since that checkpoint are lost.
  diff [<from>] [<to>]   Show changed files between two checkpoints (default
                         from: the first checkpoint; default to: the current
                         working tree)
`

interface CheckpointsCliOptions {
	workspace?: string
	checkpointDir?: string
	taskId?: string
	help: boolean
	command?: "list" | "restore" | "diff"
	commandArgs: string[]
}

export function parseCheckpointsArgs(argv: string[]): { options: CheckpointsCliOptions; error?: string } {
	const options: CheckpointsCliOptions = { help: false, commandArgs: [] }

	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i]
		const eq = arg.indexOf("=")
		const flag = eq === -1 ? arg : arg.slice(0, eq)
		const inlineValue = eq === -1 ? undefined : arg.slice(eq + 1)
		const next = (): string | undefined => {
			if (inlineValue !== undefined) {
				return inlineValue
			}
			const v = argv[i + 1]
			if (v === undefined || v.startsWith("--")) {
				return undefined
			}
			i++
			return v
		}

		switch (flag) {
			case "--workspace": {
				const v = next()
				if (v === undefined) {
					return { options, error: "Missing value for --workspace" }
				}
				options.workspace = v
				break
			}
			case "--checkpoint-dir": {
				const v = next()
				if (v === undefined) {
					return { options, error: "Missing value for --checkpoint-dir" }
				}
				options.checkpointDir = v
				break
			}
			case "--task-id": {
				const v = next()
				if (v === undefined) {
					return { options, error: "Missing value for --task-id" }
				}
				options.taskId = v
				break
			}
			case "--help":
			case "-h":
				options.help = true
				break
			case "list":
			case "restore":
			case "diff":
				if (options.command) {
					return { options, error: `Unexpected extra command: ${arg}` }
				}
				options.command = flag
				break
			default:
				if (arg.startsWith("--")) {
					return { options, error: `Unknown argument: ${arg}` }
				}
				options.commandArgs.push(arg)
				break
		}
	}

	return { options }
}

/**
 * Find the most recently active session (taskId) for `workspace` under
 * `checkpointDir`, by scanning `<checkpointDir>/tasks/*\/checkpoints` shadow
 * repos and picking the one whose `core.worktree` matches and whose `.git`
 * dir has the newest mtime.
 */
function findMostRecentTaskId(checkpointDir: string, workspace: string): string | undefined {
	const tasksDir = path.join(checkpointDir, "tasks")
	let entries: string[]
	try {
		entries = fs.readdirSync(tasksDir)
	} catch {
		return undefined
	}

	const workspaceAbs = path.resolve(workspace)
	let best: { taskId: string; mtimeMs: number } | undefined

	for (const taskId of entries) {
		const gitDir = path.join(tasksDir, taskId, "checkpoints", ".git")
		let worktree: string
		try {
			worktree = execFileSync("git", ["--git-dir", gitDir, "config", "core.worktree"], {
				encoding: "utf-8",
			}).trim()
		} catch {
			continue
		}
		if (path.resolve(worktree) !== workspaceAbs) {
			continue
		}
		let mtimeMs: number
		try {
			mtimeMs = fs.statSync(gitDir).mtimeMs
		} catch {
			continue
		}
		if (!best || mtimeMs > best.mtimeMs) {
			best = { taskId, mtimeMs }
		}
	}

	return best?.taskId
}

async function resolveService(options: CheckpointsCliOptions): Promise<{ service: CheckpointService } | { error: string }> {
	if (!options.workspace) {
		return { error: "--workspace <path> is required" }
	}
	const workspace = path.resolve(options.workspace)
	const checkpointDir = options.checkpointDir ? path.resolve(options.checkpointDir) : defaultCheckpointDir()

	const taskId = options.taskId ?? findMostRecentTaskId(checkpointDir, workspace)
	if (!taskId) {
		return {
			error: `No checkpoints found for workspace '${workspace}' under '${checkpointDir}'. Has a session run there yet?`,
		}
	}

	const service = createCheckpointService({ taskId, workspaceRoot: workspace, checkpointDir })
	await service.init()
	return { service }
}

export async function checkpointsMain(argv: string[]): Promise<number> {
	const { options, error } = parseCheckpointsArgs(argv)
	if (error) {
		process.stderr.write(`headlesscode checkpoints: ${error}\n\n${CHECKPOINTS_USAGE}`)
		return 2
	}
	if (options.help || !options.command) {
		process.stdout.write(CHECKPOINTS_USAGE)
		return options.help ? 0 : 2
	}

	const resolved = await resolveService(options)
	if ("error" in resolved) {
		process.stderr.write(`headlesscode checkpoints: ${resolved.error}\n`)
		return 2
	}
	const { service } = resolved

	try {
		switch (options.command) {
			case "list": {
				const entries = await service.list()
				if (entries.length === 0) {
					process.stdout.write("(no checkpoints)\n")
					return 0
				}
				for (const entry of entries) {
					process.stdout.write(`${entry.hash.slice(0, 12)}  ${entry.date}  ${entry.message}\n`)
				}
				return 0
			}
			case "restore": {
				const hash = options.commandArgs[0]
				if (!hash) {
					process.stderr.write("headlesscode checkpoints restore: a commit hash is required\n")
					return 2
				}
				await service.restore(hash)
				process.stdout.write(`Restored workspace to checkpoint ${hash}\n`)
				return 0
			}
			case "diff": {
				const [from, to] = options.commandArgs
				const changes = await service.diff({ from, to })
				if (changes.length === 0) {
					process.stdout.write("(no changes)\n")
					return 0
				}
				for (const change of changes) {
					process.stdout.write(`--- ${change.paths.relative}\n`)
					process.stdout.write(`+++ ${change.paths.relative}\n`)
					process.stdout.write(`  before: ${change.content.before.length} chars\n`)
					process.stdout.write(`  after:  ${change.content.after.length} chars\n`)
				}
				return 0
			}
		}
	} catch (err) {
		process.stderr.write(
			`headlesscode checkpoints ${options.command}: ${err instanceof Error ? err.message : String(err)}\n`,
		)
		return 1
	}

	return 2
}
