import * as fs from "node:fs/promises"
import { randomUUID } from "node:crypto"
import path from "node:path"
import { SessionStore } from "./store.js"
import type { SessionArchive, SessionProvider } from "./types.js"
import { discoverImportFiles, importFile } from "./importers/index.js"

const usage = `Usage:
  headlesscode sessions discover --from <claude|codex|muse> [--workspace <path>] [--source-root <path>] [--all]
  headlesscode sessions import --from <claude|codex|muse> --file <path> [--workspace <path>]
  headlesscode sessions list [--workspace <path>]
  headlesscode sessions show <id> [--workspace <path>]
  headlesscode sessions export <id> [--workspace <path>] [--out <path>]
  headlesscode sessions fork <id> [--workspace <path>]`

interface Options {
	command?: string
	positionals: string[]
	workspace?: string
	sourceRoot?: string
	file?: string
	out?: string
	provider?: Exclude<SessionProvider, "headlesscode">
	all: boolean
	help: boolean
}

export function parseSessionsArgs(argv: string[]): { options: Options; error?: string } {
	const options: Options = { positionals: [], all: false, help: false }
	const values: Record<string, keyof Options> = { "--workspace": "workspace", "--source-root": "sourceRoot", "--file": "file", "--out": "out", "--from": "provider" }
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i]
		if (arg === "--help" || arg === "-h") { options.help = true; continue }
		if (arg === "--all") { options.all = true; continue }
		const key = values[arg ?? ""]
		if (key) {
			const value = argv[++i]
			if (!value || value.startsWith("--")) return { options, error: `Missing value for ${arg}` }
			if (key === "provider") {
				if (value !== "claude" && value !== "codex" && value !== "muse") return { options, error: `Unsupported provider "${value}". Choose claude, codex, or muse.` }
				options.provider = value
			} else (options as unknown as Record<string, string>)[key] = value
			continue
		}
		if (arg?.startsWith("-")) return { options, error: `Unknown argument: ${arg}` }
		if (!options.command) options.command = arg
		else options.positionals.push(arg ?? "")
	}
	return { options }
}

function terminalSafe(value: string): string { return value.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "").replace(/[\u0000-\u001f\u007f-\u009f]/g, " ") }
function write(value: string): void { process.stdout.write(`${terminalSafe(value)}\n`) }
function error(value: string): void { process.stderr.write(`${terminalSafe(value)}\n`) }

function summaryLine(value: { id: string; title: string; provider: SessionProvider; messageCount: number; updatedAt: string }): string {
	return `${value.id}\t${value.provider}\t${value.updatedAt}\t${value.messageCount} messages\t${value.title}`
}

function renderArchive(archive: SessionArchive): string {
	return JSON.stringify(archive, null, 2)
}

async function exportArchive(target: string, data: string): Promise<void> {
	const absolute = path.resolve(target)
	const directory = path.dirname(absolute)
	const temporary = path.join(directory, `.${path.basename(absolute)}.${process.pid}.${randomUUID()}.tmp`)
	try {
		await fs.writeFile(temporary, data, { flag: "wx", mode: 0o600 })
		await fs.link(temporary, absolute)
	} finally {
		await fs.rm(temporary, { force: true })
	}
}

export async function sessionsMain(argv: string[]): Promise<number> {
	const { options, error: parseError } = parseSessionsArgs(argv)
	if (options.help) { write(`headlesscode sessions\n${usage}`); return 0 }
	if (parseError) { error(`${parseError}\n${usage}`); return 2 }
	if (!options.command) { error(usage); return 2 }
	if (!["discover", "import", "list", "show", "export", "fork"].includes(options.command)) { error(`Unknown sessions command: ${options.command}\n${usage}`); return 2 }
	const workspace = path.resolve(options.workspace ?? process.cwd())
	try {
		const store = new SessionStore(workspace)
		switch (options.command) {
			case "discover": {
				if (!options.provider) throw new Error("--from <claude|codex|muse> is required for discovery.")
				const found = await discoverImportFiles(options.provider, { workspaceRoot: workspace, ...(options.sourceRoot ? { sourceRoot: options.sourceRoot } : {}), all: options.all })
				if (!found.length) { write("No sessions found."); return 0 }
				write(`Found ${found.length} ${options.provider} session file(s):`)
				for (const item of found) write(`${item.modifiedAt}\t${item.bytes} bytes\t${item.file}`)
				return 0
			}
			case "import": {
				if (!options.provider) throw new Error("--from <claude|codex|muse> is required for import.")
				if (!options.file) throw new Error("--file <path> is required for import.")
				const { archive, warnings } = await importFile(options.provider, options.file, workspace)
				write(`Imported ${options.provider} session as ${archive.id}: ${archive.title}`)
				for (const warning of warnings) write(`Warning: ${warning}`)
				return 0
			}
			case "list": {
				const summaries = await store.list()
				if (!summaries.length) { write("No HeadlessCode sessions found."); return 0 }
				for (const summary of summaries) write(summaryLine(summary))
				return 0
			}
			case "show": {
				const id = options.positionals[0]
				if (!id) throw new Error("A session ID is required.")
				write(renderArchive(await store.load(id)))
				return 0
			}
			case "export": {
				const id = options.positionals[0]
				if (!id) throw new Error("A session ID is required.")
				const data = `${renderArchive(await store.load(id))}\n`
				if (options.out) { await exportArchive(options.out, data); write(`Exported ${id} to ${path.resolve(options.out)}`) }
				else process.stdout.write(data)
				return 0
			}
			case "fork": {
				const id = options.positionals[0]
				if (!id) throw new Error("A session ID is required.")
				const archive = await store.fork(id)
				write(`Forked ${id} as ${archive.id}: ${archive.title}`)
				return 0
			}
		}
	} catch (cause) {
		error(cause instanceof Error ? cause.message : String(cause))
		return 2
	}
	return 2
}
