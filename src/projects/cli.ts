/**
 * `headlesscode projects` subcommand — enumerate and prune the central
 * per-project store (plans/project-registry-and-store-cleanup.md).
 *
 *   headlesscode projects list [--json] [--registered-only] [--stale] [--size]
 *   headlesscode projects prune [--dry-run] [--yes] [--include-registered]
 *
 * Read side (`list`) and reclaim side (`prune`) over the same underlying
 * listing function (`listProjectEntries` in src/project-store.ts) the
 * dashboard's GET /api/projects endpoint reuses — one source of truth for
 * "what's in the store".
 */

import * as fs from "node:fs"
import * as path from "node:path"

import { isUnderSystemTmpDir, listProjectEntries, projectStoreRoot, type ProjectListEntry } from "../project-store.js"

const PROJECTS_USAGE = `headlesscode projects — enumerate and prune the central per-project store

Usage:
  headlesscode projects list [--json] [--registered-only] [--stale] [--size]
  headlesscode projects prune [--dry-run] [--yes] [--include-registered]

The central store lives at ~/.local/share/headlesscode/projects/<key>/ (see
src/project-store.ts). Each directory holds one project's cross-session data
(codesearch index, mode-models.json, permissions.json) plus a project.json
metadata file recording the real path, kind, first/last-seen and whether a
human deliberately registered the project via \`headlesscode init\`.

list:
  A compact PROJECT / SIZE / PATH table, sorted by on-disk size (largest
  first), with a one-line summary of totals. By default the table hides
  /tmp test-workspace clutter and no-project.json litter (use --all to see
  everything, with the fuller KEY/REG/OK/KIND columns). Sizes are computed
  only for the entries actually printed (after filters), never for the
  whole store.
  --all                Show every entry, including /tmp litter, with the
                      fuller KEY/REG/OK/KIND/PATH/FIRST SEEN/LAST SEEN table
  --json               Print a JSON array of every entry (unfiltered)
                      instead of the table, sorted by lastSeen (no size
                      field, no summary line — stdout is pure JSON)
  --registered-only    Only projects a human registered via \`headlesscode init\`
  --stale              Only projects whose recorded path no longer exists
  --size               No-op (size is always shown); kept for backward
                      compatibility

prune:
  Remove store entries that are safe to reclaim. Default candidates: entries
  whose recorded path no longer exists AND that were never registered, plus
  directories with no project.json at all (the pre-registry litter Part A
  stops producing — they were never a curated project to begin with). A
  registered project is NEVER removed by default, even when its path is
  missing.
  --dry-run            Print what would be removed and the bytes reclaimed,
                      remove nothing, exit 0
  --include-registered Also include registered-but-missing-path entries — the
                      escape hatch for a deleted repo or a temporarily
                      unmounted drive (you can't tell which from here)
  --yes                Actually remove the candidates. Without it (and without
                      --dry-run) the candidate list + byte total are printed
                      and the command exits 2 asking you to re-run with --yes

Options:
  --help               Show this help and exit
`

export interface ProjectsCliOptions {
	subcommand?: "list" | "prune"
	json: boolean
	registeredOnly: boolean
	stale: boolean
	size: boolean
	all: boolean
	dryRun: boolean
	yes: boolean
	includeRegistered: boolean
	help: boolean
	error?: string
}

export function parseProjectsArgs(argv: string[]): ProjectsCliOptions {
	const options: ProjectsCliOptions = {
		json: false,
		registeredOnly: false,
		stale: false,
		size: false,
		all: false,
		dryRun: false,
		yes: false,
		includeRegistered: false,
		help: false,
	}
	const [subcommand, ...rest] = argv
	if (subcommand === undefined || subcommand === "--help" || subcommand === "-h") {
		options.help = true
		return options
	}
	if (subcommand === "list") {
		options.subcommand = "list"
	} else if (subcommand === "prune") {
		options.subcommand = "prune"
	} else {
		return { ...options, error: `Unknown subcommand: ${subcommand}` }
	}
	for (const arg of rest) {
		switch (arg) {
			case "--help":
			case "-h":
				options.help = true
				break
			case "--json":
				if (options.subcommand !== "list") {
					return { ...options, error: "--json is only valid with `projects list`" }
				}
				options.json = true
				break
			case "--registered-only":
				if (options.subcommand !== "list") {
					return { ...options, error: "--registered-only is only valid with `projects list`" }
				}
				options.registeredOnly = true
				break
			case "--stale":
				if (options.subcommand !== "list") {
					return { ...options, error: "--stale is only valid with `projects list`" }
				}
				options.stale = true
				break
			case "--size":
				if (options.subcommand !== "list") {
					return { ...options, error: "--size is only valid with `projects list`" }
				}
				options.size = true
				break
			case "--all":
				if (options.subcommand !== "list") {
					return { ...options, error: "--all is only valid with `projects list`" }
				}
				options.all = true
				break
			case "--dry-run":
				if (options.subcommand !== "prune") {
					return { ...options, error: "--dry-run is only valid with `projects prune`" }
				}
				options.dryRun = true
				break
			case "--yes":
				if (options.subcommand !== "prune") {
					return { ...options, error: "--yes is only valid with `projects prune`" }
				}
				options.yes = true
				break
			case "--include-registered":
				if (options.subcommand !== "prune") {
					return { ...options, error: "--include-registered is only valid with `projects prune`" }
				}
				options.includeRegistered = true
				break
			default:
				return { ...options, error: `Unknown argument: ${arg}` }
		}
	}
	return options
}

/** Sort by lastSeen descending; entries with no (or malformed) lastSeen sort last. */
function sortEntries(entries: ProjectListEntry[]): ProjectListEntry[] {
	return [...entries].sort((a, b) => {
		const at = a.lastSeen === undefined ? Number.NaN : Date.parse(a.lastSeen)
		const bt = b.lastSeen === undefined ? Number.NaN : Date.parse(b.lastSeen)
		const aValid = !Number.isNaN(at)
		const bValid = !Number.isNaN(bt)
		if (!aValid && !bValid) return 0
		if (!aValid) return 1
		if (!bValid) return -1
		return bt - at
	})
}

/** Recursive byte size of a directory (used only for --size / prune totals). */
function directorySize(dir: string): number {
	let total = 0
	let entries: string[]
	try {
		entries = fs.readdirSync(dir)
	} catch {
		return 0
	}
	for (const entry of entries) {
		const full = path.join(dir, entry)
		let st: fs.Stats
		try {
			st = fs.lstatSync(full)
		} catch {
			continue
		}
		if (st.isDirectory()) {
			total += directorySize(full)
		} else if (st.isFile()) {
			total += st.size
		}
	}
	return total
}

function humanSize(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`
	let value = bytes / 1024
	let unit = "KB"
	for (const next of ["MB", "GB", "TB"]) {
		if (value < 1024) break
		value /= 1024
		unit = next
	}
	return `${value.toFixed(1)} ${unit}`
}

/** Right-align a column of numbers in a table (e.g. the size column). */
function padStartCells(rows: string[][], col: number): void {
	const width = rows.reduce((w, row) => Math.max(w, row[col].length), 0)
	for (const row of rows) {
		row[col] = row[col].padStart(width)
	}
}

function formatTable(rows: string[][]): string {
	const widths: number[] = []
	for (const row of rows) {
		row.forEach((cell, i) => {
			widths[i] = Math.max(widths[i] ?? 0, cell.length)
		})
	}
	return rows
		.map((row) => row.map((cell, i) => cell.padEnd(widths[i])).join("  ").trimEnd())
		.join("\n")
}

/** /tmp test-workspace clutter and no-project.json litter — hidden from the default table. */
function isClutter(e: ProjectListEntry): boolean {
	return e.path === undefined || isUnderSystemTmpDir(e.path)
}

async function listMain(options: ProjectsCliOptions): Promise<number> {
	let entries = sortEntries(listProjectEntries())
	if (options.registeredOnly) {
		entries = entries.filter((e) => e.registered)
	}
	if (options.stale) {
		entries = entries.filter((e) => !e.exists)
	}
	if (options.json) {
		process.stdout.write(JSON.stringify(entries, null, 2) + "\n")
		return 0
	}

	const totalCount = entries.length
	const hiddenCount = options.all ? 0 : entries.filter(isClutter).length
	if (!options.all) {
		entries = entries.filter((e) => !isClutter(e))
	}

	// Size is computed only for the entries actually being printed (after
	// filters) — never for the whole polluted store — and entries sort by
	// size descending, so the projects that actually matter (real, existing,
	// sizeable) surface first. --size is kept as an accepted (now no-op)
	// flag for backward compatibility.
	const sizeBytesByKey = new Map<string, number>()
	for (const e of entries) {
		sizeBytesByKey.set(e.key, directorySize(path.join(projectStoreRoot(), "projects", e.key)))
	}
	entries = [...entries].sort((a, b) => (sizeBytesByKey.get(b.key) ?? 0) - (sizeBytesByKey.get(a.key) ?? 0))

	const rows: string[][] = options.all
		? [
				["KEY", "REG", "OK", "KIND", "SIZE", "PATH", "FIRST SEEN", "LAST SEEN"],
				...entries.map((e) => [
					e.key,
					e.registered ? "✓" : "·",
					e.exists ? "ok" : "gone",
					e.kind ?? "-",
					humanSize(sizeBytesByKey.get(e.key) ?? 0),
					e.path ?? "-",
					e.firstSeen ?? "-",
					e.lastSeen ?? "-",
				]),
			]
		: [
				["PROJECT", "SIZE", "PATH"],
				...entries.map((e) => [
					path.basename(e.path ?? e.key),
					humanSize(sizeBytesByKey.get(e.key) ?? 0),
					e.path ?? "-",
				]),
			]
	padStartCells(rows, options.all ? 4 : 1)
	process.stdout.write(formatTable(rows) + "\n")

	const registeredCount = entries.filter((e) => e.registered).length
	const missingCount = entries.filter((e) => !e.exists).length
	process.stdout.write(`\n${entries.length} project(s): ${registeredCount} registered, ${missingCount} with missing paths`)
	process.stdout.write(
		hiddenCount > 0
			? ` (${hiddenCount} /tmp or no-metadata entr${hiddenCount === 1 ? "y" : "ies"} hidden — use --all to show, ${totalCount} total)\n`
			: "\n",
	)
	return 0
}

async function pruneMain(options: ProjectsCliOptions): Promise<number> {
	// Default candidates: exists === false && registered === false. An entry
	// with NO project.json at all is path=undefined → exists=false →
	// registered=false, so it's already captured — the "no project.json" class
	// from the plan is exactly this predicate, not a separate case.
	const candidates = sortEntries(listProjectEntries())
		.filter((e) => !e.exists && (options.includeRegistered || !e.registered))
		.sort((a, b) => a.key.localeCompare(b.key))

	let totalBytes = 0
	const details = candidates.map((e) => {
		const size = directorySize(path.join(projectStoreRoot(), "projects", e.key))
		totalBytes += size
		return { entry: e, size }
	})

	if (details.length === 0) {
		process.stdout.write("projects prune: nothing to remove\n")
		return 0
	}

	process.stdout.write("Candidates for removal:\n")
	for (const { entry, size } of details) {
		process.stdout.write(
			`  ${entry.key}  ${humanSize(size).padStart(10)}  ${entry.path ?? "(no project.json)"}\n`,
		)
	}
	process.stdout.write(
		`\nTotal reclaimable: ${humanSize(totalBytes)} (${totalBytes} bytes) across ${details.length} entr${
			details.length === 1 ? "y" : "ies"
		}\n`,
	)

	if (options.dryRun) {
		process.stdout.write("Dry run — nothing removed.\n")
		return 0
	}
	if (!options.yes) {
		process.stderr.write("\nRe-run with --yes to actually remove these store entries.\n")
		return 2
	}
	for (const { entry } of details) {
		const dir = path.join(projectStoreRoot(), "projects", entry.key)
		try {
			fs.rmSync(dir, { recursive: true, force: true })
			process.stdout.write(`  removed ${entry.key} (${entry.path ?? "no project.json"})\n`)
		} catch (err) {
			process.stderr.write(`  FAILED to remove ${entry.key}: ${err instanceof Error ? err.message : String(err)}\n`)
		}
	}
	process.stdout.write(`\nRemoved ${details.length} entr${details.length === 1 ? "y" : "ies"}, reclaimed ${humanSize(totalBytes)}.\n`)
	return 0
}

export async function projectsMain(argv: string[]): Promise<number> {
	const options = parseProjectsArgs(argv)
	if (options.error) {
		process.stderr.write(`headlesscode projects: ${options.error}\n\n${PROJECTS_USAGE}`)
		return 2
	}
	if (options.help) {
		process.stdout.write(PROJECTS_USAGE)
		return 0
	}
	if (options.subcommand === "list") {
		return listMain(options)
	}
	if (options.subcommand === "prune") {
		return pruneMain(options)
	}
	process.stderr.write(`headlesscode projects: a subcommand is required\n\n${PROJECTS_USAGE}`)
	return 2
}
