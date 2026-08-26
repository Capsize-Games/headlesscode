/**
 * `headlesscode migrate` subcommand — the explicit, human-triggerable version
 * of the one-time migrations the central store performs automatically on first
 * use (see src/project-store.ts). Running it is always safe (idempotent): each
 * migration is skipped when the source is absent or the target already exists,
 * and every move verifies the content landed before the source is removed.
 *
 *   headlesscode migrate [--workspace <path>]
 *
 * Migrates:
 *   1. Global shared instructions out of `~/.roo/` (Zoo-Code-branded) into
 *      `~/.local/share/headlesscode/shared/` (modes.yaml + rules(-<mode>)/).
 *   2. The checkpoint store from `~/.headlesscode/checkpoints` into
 *      `~/.local/share/headlesscode/checkpoints` (a MOVE — real, potentially
 *      large data is never copied-and-orphaned).
 *   3. When `--workspace <path>` is given (default: the current directory),
 *      that workspace's legacy `<root>/.headlesscode/{codesearch,
 *      mode-models.json, permissions.json}` into the central project store —
 *      keyed by the repo's git-common-dir, so worktrees share it.
 */

import * as path from "node:path"

import {
	isStoreOverridden,
	migrateCheckpointStore,
	migrateLegacyProjectData,
	migrateSharedInstructions,
	resolveProjectDataDir,
	resolveProjectIdentity,
} from "../project-store.js"

const MIGRATE_USAGE = `headlesscode migrate — move legacy headlesscode data into the central store

Usage:
  headlesscode migrate [--workspace <path>]

The central store is ~/.local/share/headlesscode/ (see src/project-store.ts).
Migrations are one-time and idempotent; each move is verified before the
source is removed, so re-running is always safe.

Steps:
  1. ~/.roo/ -> ~/.local/share/headlesscode/shared/   (global modes + rules)
  2. ~/.headlesscode/checkpoints -> ~/.local/share/headlesscode/checkpoints
  3. <workspace>/.headlesscode/{codesearch,mode-models.json,permissions.json}
     -> ~/.local/share/headlesscode/projects/<key>/ (when --workspace given)

Options:
  --workspace <path>  Workspace whose legacy .headlesscode/ content to migrate
                      (default: the current directory)
  --help              Show this help and exit
`

export function parseMigrateArgs(argv: string[]): { workspace?: string; help: boolean; error?: string } {
	const options: { workspace?: string; help: boolean } = { help: false }
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i]
		switch (arg) {
			case "--help":
			case "-h":
				options.help = true
				break
			case "--workspace": {
				const v = argv[i + 1]
				if (v === undefined || v.startsWith("--")) {
					return { ...options, error: "Missing value for --workspace" }
				}
				options.workspace = v
				i++
				break
			}
			default:
				return { ...options, error: `Unknown argument: ${arg}` }
		}
	}
	return options
}

export async function migrateMain(argv: string[]): Promise<number> {
	const { workspace, help, error } = parseMigrateArgs(argv)
	if (error) {
		process.stderr.write(`headlesscode migrate: ${error}\n\n${MIGRATE_USAGE}`)
		return 2
	}
	if (help) {
		process.stdout.write(MIGRATE_USAGE)
		return 0
	}

	// Step 1 + 2: global shared instructions + checkpoint store. Log to stdout
	// (this is the explicit command's report channel). Under a
	// $HEADLESSCODE_DATA_DIR override (tests/scratch) these two REAL-home-data
	// migrations are skipped — the override means "don't touch real home data";
	// the workspace migration below still runs against the override store.
	const log = (msg: string): void => {
		process.stdout.write(`[migrate] ${msg}\n`)
	}
	if (isStoreOverridden()) {
		log("skipping global migrations (shared instructions + checkpoints) under a HEADLESSCODE_DATA_DIR override")
	} else {
		migrateSharedInstructions({ log })
		migrateCheckpointStore({ log })
	}

	// Step 3: the workspace's legacy .headlesscode/ content.
	const ws = path.resolve(workspace ?? process.cwd())
	const { keySource } = resolveProjectIdentity(ws)
	const centralDir = resolveProjectDataDir(ws)
	migrateLegacyProjectData(ws, keySource, centralDir, { log })

	process.stdout.write(
		"[migrate] done. New central store root: ~/.local/share/headlesscode/ (per-project data under projects/, checkpoints under checkpoints/, shared instructions under shared/).\n",
	)
	return 0
}
