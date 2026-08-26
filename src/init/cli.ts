/**
 * `headlesscode init` subcommand — one-command project registration.
 *
 *   npx tsx src/cli.ts init --workspace <path> [--skip-index] [--skip-codemap]
 *                           [--embedding-backend <openrouter|ollama|airunner>]
 *
 * A thin orchestration layer over EXISTING functionality: project registration
 * (resolveProjectDataDir), stack detection (detectStacks), .gitignore hygiene
 * (ensureWorkspaceGitignore), the codesearch index (indexMain) and the codemap
 * (codemapMain). It must not reimplement any of those — each step shells into
 * the same code path its standalone subcommand uses (see
 * plans/project-init-registration.md).
 */

import * as fs from "node:fs"
import * as path from "node:path"

import { resolveProjectDataDir } from "../project-store.js"
import { detectStacks, getCentralStackRulesFile } from "../engine/stacks.js"
import { indexMain } from "../codesearch/cli.js"
import { loadIndex } from "../codesearch/index.js"
import { codemapMain } from "../codemap/cli.js"
import { ensureWorkspaceGitignore } from "./gitignore.js"

const INIT_USAGE = `headlesscode init — one-command project registration

Usage:
  headlesscode init --workspace <path> [--skip-index] [--skip-codemap]
                    [--embedding-backend <openrouter|ollama|airunner>]

Options:
  --workspace <path>      Workspace root to register (required; must be a
                          directory)
  --skip-index            Do not build/refresh the codebase-search index
                          (saves embedding API cost)
  --skip-codemap          Do not build/refresh the codemap
  --embedding-backend <b> Embedding backend for the index step: openrouter
                          (default), ollama (local), or airunner (local
                          AIRunner server). Passed straight through to
                          \`headlesscode index\`
  --help                  Show this help and exit

Registers a new project with headlesscode in one step: resolves the central
per-project data dir (~/.local/share/headlesscode/projects/<key>), detects
the project's stack(s) (stack-aware instructions are spliced into every
session automatically — see docs/stack-rules.md), makes sure the workspace's
.gitignore excludes .headlesscode/ session artifacts, then builds the
codebase-search index and the codemap. Each step is independent: a failure in
one is reported inline and the remaining steps still run, but the command
exits non-zero.

The index step costs real money (embedding API calls) unless a local backend
(--embedding-backend ollama or airunner) is used or the step is skipped with
--skip-index.
`

interface InitCliOptions {
	workspace?: string
	skipIndex: boolean
	skipCodemap: boolean
	embeddingBackend?: string
	help: boolean
}

export function parseInitArgs(argv: string[]): { options: InitCliOptions; error?: string } {
	const options: InitCliOptions = { skipIndex: false, skipCodemap: false, help: false }
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
			case "--workspace":
			case "--embedding-backend": {
				const value = next()
				if (value === undefined) {
					return { options, error: `Missing value for ${flag}` }
				}
				if (flag === "--workspace") {
					options.workspace = value
				} else {
					options.embeddingBackend = value
				}
				break
			}
			case "--skip-index":
				options.skipIndex = true
				break
			case "--skip-codemap":
				options.skipCodemap = true
				break
			case "--help":
			case "-h":
				options.help = true
				break
			default:
				return { options, error: `Unknown argument: ${arg}` }
		}
	}
	return { options }
}

export async function initMain(argv: string[]): Promise<number> {
	const { options, error } = parseInitArgs(argv)
	if (error) {
		process.stderr.write(`headlesscode init: ${error}\n\n${INIT_USAGE}`)
		return 2
	}
	if (options.help) {
		process.stdout.write(INIT_USAGE)
		return 0
	}
	if (!options.workspace) {
		process.stderr.write(`headlesscode init: --workspace <path> is required\n\n${INIT_USAGE}`)
		return 2
	}

	const workspaceRoot = path.resolve(options.workspace)
	let isDir = false
	try {
		isDir = fs.statSync(workspaceRoot).isDirectory()
	} catch {
		isDir = false
	}
	if (!isDir) {
		process.stderr.write(`headlesscode init: --workspace is not a directory: ${workspaceRoot}\n\n${INIT_USAGE}`)
		return 2
	}

	process.stdout.write("headlesscode init — one-command project registration\n\n")

	// Step 1: resolve + register (the existing, sole registration mechanism —
	// writes <central>/project.json on first contact). `registered: true` is
	// ONLY ever set here — no other call site in the codebase passes it, so a
	// human-deliberate registration is the single thing that flips the flag.
	const centralDir = resolveProjectDataDir(workspaceRoot, { registered: true })
	process.stdout.write(
		"Step 1/5 — project registration\n" +
			`  workspace:        ${workspaceRoot}\n` +
			`  central data dir: ${centralDir}\n\n`,
	)

	// Step 2: detect stacks (per-session detection is what actually drives
	// instruction selection — this is the one place it's surfaced to a human).
	const stacks = await detectStacks(workspaceRoot)
	process.stdout.write("Step 2/5 — stack detection\n")
	if (stacks.size === 0) {
		process.stdout.write("  no recognized stack — generic instructions only\n")
	} else {
		process.stdout.write(`  detected: ${[...stacks].join(", ")}\n`)
		for (const stack of stacks) {
			const rulesFile = getCentralStackRulesFile(stack)
			if (fs.existsSync(rulesFile)) {
				process.stdout.write(`    ${stack}: rules at ${rulesFile}\n`)
			} else {
				process.stdout.write(
					`    ${stack}: no central rules content yet — consider adding ${rulesFile}\n`,
				)
			}
		}
	}
	process.stdout.write("\n")

	// Step 3: ensure the target repo's .gitignore excludes .headlesscode/.
	process.stdout.write("Step 3/5 — .gitignore\n")
	const gitignoreResult = ensureWorkspaceGitignore(workspaceRoot)
	const gitignoreActionText =
		gitignoreResult.action === "created"
			? "created with /.headlesscode/ entry"
			: gitignoreResult.action === "appended"
				? "appended /.headlesscode/ entry (existing content untouched)"
				: "already covers .headlesscode — no change"
	process.stdout.write(`  ${gitignoreResult.path}: ${gitignoreActionText}\n\n`)

	// Steps 4-5: index + codemap. Each is independent: a failure is reported
	// inline and the later step still runs, but the command exits non-zero.
	let exitCode = 0
	let indexSummary = "skipped by flag"
	let codemapSummary = "skipped by flag"

	process.stdout.write("Step 4/5 — codebase index\n")
	if (!options.skipIndex) {
		const indexArgs = ["--workspace", workspaceRoot]
		if (options.embeddingBackend) {
			indexArgs.push("--embedding-backend", options.embeddingBackend)
		}
		try {
			// Same code path as `headlesscode index` — including its
			// cost/token summary (real embedding API spend).
			const code = await indexMain(indexArgs)
			if (code !== 0) {
				exitCode = 1
				indexSummary = `FAILED (exit ${code})`
			} else {
				indexSummary = `ok — ${loadIndex(workspaceRoot).length} chunks in index`
			}
		} catch (err) {
			exitCode = 1
			indexSummary = `FAILED (${err instanceof Error ? err.message : String(err)})`
		}
	} else {
		process.stdout.write("  skipped by flag\n")
	}
	process.stdout.write("\n")

	process.stdout.write("Step 5/5 — codemap\n")
	if (!options.skipCodemap) {
		try {
			const code = await codemapMain(["--workspace", workspaceRoot])
			if (code !== 0) {
				exitCode = 1
				codemapSummary = `FAILED (exit ${code})`
			} else {
				codemapSummary = "ok (see step 5 output above)"
			}
		} catch (err) {
			exitCode = 1
			codemapSummary = `FAILED (${err instanceof Error ? err.message : String(err)})`
		}
	} else {
		process.stdout.write("  skipped by flag\n")
	}
	process.stdout.write("\n")

	// Step 6: final summary.
	process.stdout.write(
		"Summary\n" +
			`  workspace:         ${workspaceRoot}\n` +
			`  central data dir:  ${centralDir}\n` +
			`  stacks:            ${stacks.size === 0 ? "none (generic instructions only)" : [...stacks].join(", ")}\n` +
			`  gitignore:         ${gitignoreResult.action}\n` +
			`  index:             ${indexSummary}\n` +
			`  codemap:           ${codemapSummary}\n`,
	)

	return exitCode
}
