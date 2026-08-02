/**
 * Shared TypeScript program loading for the code-intelligence tools
 * (`outline`, `go_to_definition`, `find_references`, `import_graph`).
 *
 * All four tools need the same foundational capability — parse the target
 * workspace's real TypeScript source respecting its actual `tsconfig.json`
 * (including `paths` aliases like this repo's `vscode` → shim mapping) — so
 * they share ONE module that owns program loading, instead of four
 * independent implementations drifting into four subtly different analyses.
 *
 * Loading is deliberately built on the real Compiler API, never a regex or a
 * hand-rolled parser:
 *   - `ts.findConfigFile` + `ts.readConfigFile` +
 *     `ts.parseJsonConfigFileContent` for tsconfig handling (not hand-rolled)
 *   - `ts.createProgram` for the type-checked program
 *   - `ts.createLanguageService` (backed by the program) for definition
 *     resolution (`getDefinitionAtPosition`) and reference finding
 *     (`getReferencesAtPosition`)
 *
 * Caching: rebuilding a full TS program is expensive, so a loaded program is
 * cached per workspace root for a session's lifetime and only rebuilt when a
 * file the program covers has actually changed. We track the mtimes of the
 * project's own source files (the tsconfig's resolved `fileNames`, i.e. the
 * files an edit tool can realistically touch) plus the tsconfig file itself;
 * node_modules types are deliberately NOT tracked (they don't change
 * mid-session). The model edits a `.ts` file in the workspace → its mtime
 * changes → the next tool call rebuilds. `CodeIntelCache.programLoadCount`
 * exists so tests can prove the cache is reused with a real call counter,
 * mirroring how caching behavior is proven elsewhere in this project.
 */

import * as fs from "node:fs"
import * as path from "node:path"
import * as ts from "typescript"

/** Everything a code-intelligence tool call needs from a loaded workspace. */
export interface CodeIntel {
	program: ts.Program
	languageService: ts.LanguageService
	compilerOptions: ts.CompilerOptions
	/** Absolute path of the tsconfig that produced this program (undefined if none). */
	configFilePath: string | undefined
	/** Absolute paths of the project's own source files (tsconfig `fileNames`). */
	projectFiles: string[]
	/**
	 * Ad-hoc files served by the language-service host that are NOT part of
	 * the program (e.g. a `.ts` file the model just created with write_to_file
	 * after the program was last loaded). They parse on demand against the
	 * program's compiler options; cross-file resolution still goes through the
	 * program's checker.
	 */
	includeExtraFile(fileName: string): void
}

/** A per-workspace cache of a loaded program + language service. */
export class CodeIntelCache {
	/** Real load counter: 1 per actual program build (tests assert on this). */
	programLoadCount = 0

	private loaded: { intel: CodeIntel; trackedMtimes: Map<string, number> } | undefined

	constructor(readonly workspaceRoot: string) {}

	/** Load-or-reuse the cached program, rebuilding only if a covered file changed. */
	get(): CodeIntel {
		if (this.loaded !== undefined && !this.hasCoveredFileChanged()) {
			return this.loaded.intel
		}
		const intel = loadCodeIntel(this.workspaceRoot)
		this.loaded = { intel, trackedMtimes: trackMtimes(intel) }
		this.programLoadCount += 1
		return intel
	}

	/** Drop the cached program (used by tests; not needed by session code). */
	invalidate(): void {
		this.loaded = undefined
	}

	private hasCoveredFileChanged(): boolean {
		for (const [file, mtime] of this.loaded!.trackedMtimes) {
			try {
				if (fs.statSync(file).mtimeMs !== mtime) {
					return true
				}
			} catch {
				// File deleted since load — definitely stale.
				return true
			}
		}
		return false
	}
}

/**
 * Per-workspace caches, keyed by the (resolved) workspace root. One process
 * can host several workspaces (headless session + reviewer/QA executors), and
 * each keeps its own program — same pattern as the browser sessions registry.
 */
const caches = new Map<string, CodeIntelCache>()

/** Get (creating if needed) the program cache for a workspace root. */
export function getCodeIntelCache(workspaceRoot: string): CodeIntelCache {
	const root = path.resolve(workspaceRoot)
	let cache = caches.get(root)
	if (cache === undefined) {
		cache = new CodeIntelCache(root)
		caches.set(root, cache)
	}
	return cache
}

/** Drop every cached program (test isolation). */
export function resetCodeIntelCaches(): void {
	caches.clear()
}

/** Record the mtimes of the files whose change invalidates the program. */
function trackMtimes(intel: CodeIntel): Map<string, number> {
	const mtimes = new Map<string, number>()
	for (const file of intel.projectFiles) {
		try {
			mtimes.set(file, fs.statSync(file).mtimeMs)
		} catch {
			// File vanished between program load and tracking — leave untracked;
			// the next get() rebuilds only when a TRACKED file changes. A deleted
			// untracked file is still served from the cached program snapshot.
		}
	}
	if (intel.configFilePath !== undefined) {
		try {
			mtimes.set(intel.configFilePath, fs.statSync(intel.configFilePath).mtimeMs)
		} catch {
			// Same as above.
		}
	}
	return mtimes
}

function loadCodeIntel(workspaceRoot: string): CodeIntel {
	const configFilePath = ts.findConfigFile(workspaceRoot, ts.sys.fileExists, "tsconfig.json")

	let compilerOptions: ts.CompilerOptions
	let rootNames: string[]
	let configFileParsingDiagnostics: ts.Diagnostic[] = []

	if (configFilePath !== undefined) {
		const read = ts.readConfigFile(configFilePath, ts.sys.readFile)
		if (read.error !== undefined) {
			throw new Error(
				`cannot read tsconfig at ${configFilePath}: ${ts.flattenDiagnosticMessageText(read.error.messageText, "\n")}`,
			)
		}
		const parsed = ts.parseJsonConfigFileContent(
			read.config,
			{
				useCaseSensitiveFileNames: ts.sys.useCaseSensitiveFileNames,
				readDirectory: ts.sys.readDirectory,
				fileExists: ts.sys.fileExists,
				readFile: ts.sys.readFile,
			},
			path.dirname(configFilePath),
			undefined,
			configFilePath,
		)
		compilerOptions = parsed.options
		rootNames = parsed.fileNames
		configFileParsingDiagnostics = parsed.errors
	} else {
		// No tsconfig: fall back to a sensible default program over every
		// TypeScript file in the workspace (excluding deps/vcs/hidden dirs).
		// This keeps the tools working on scratch workspaces and fixtures
		// without requiring the target to have a tsconfig of its own.
		compilerOptions = {
			target: ts.ScriptTarget.ES2022,
			module: ts.ModuleKind.ESNext,
			moduleResolution: ts.ModuleResolutionKind.Bundler,
			strict: false,
			skipLibCheck: true,
		}
		rootNames = discoverTypeScriptFiles(workspaceRoot)
	}

	const program = ts.createProgram({
		rootNames,
		options: compilerOptions,
		configFileParsingDiagnostics,
	})

	const host = new LsHost(program, compilerOptions)
	const languageService = ts.createLanguageService(host)

	return {
		program,
		languageService,
		compilerOptions,
		configFilePath: configFilePath ?? undefined,
		projectFiles: rootNames,
		includeExtraFile: (fileName) => host.includeExtraFile(fileName),
	}
}

/** Recursively find every `.ts`/`.tsx`/`.mts`/`.cts` file, skipping noise dirs. */
function discoverTypeScriptFiles(root: string): string[] {
	const found: string[] = []
	const skip = new Set(["node_modules", ".git", ".hg", ".svn", "dist", "out", "build", "coverage"])
	const walk = (dir: string): void => {
		let entries: fs.Dirent[]
		try {
			entries = fs.readdirSync(dir, { withFileTypes: true })
		} catch {
			return
		}
		for (const entry of entries) {
			if (entry.name.startsWith(".") || skip.has(entry.name)) {
				continue
			}
			const full = path.join(dir, entry.name)
			if (entry.isDirectory()) {
				walk(full)
			} else if (isSupportedSource(entry.name)) {
				found.push(full)
			}
		}
	}
	walk(root)
	return found
}

/** True for file names the TS compiler can parse as source. */
export function isSupportedSource(fileName: string): boolean {
	return /\.(m|c)?(t|j)sx?$/i.test(fileName) || /\.d\.(m|c)?ts$/i.test(fileName)
}

/**
 * Map a file name to the TS ScriptKind by extension. The compiler's internal
 * `getScriptKindFromFileName` exists at runtime but is NOT part of the public
 * d.ts, so we keep a small local equivalent rather than casting to an untyped
 * API.
 */
export function scriptKindFromFileName(fileName: string): ts.ScriptKind {
	const lower = fileName.toLowerCase()
	if (lower.endsWith(".tsx")) {
		return ts.ScriptKind.TSX
	}
	if (lower.endsWith(".jsx")) {
		return ts.ScriptKind.JSX
	}
	if (lower.endsWith(".mts") || lower.endsWith(".cts") || lower.endsWith(".ts")) {
		return ts.ScriptKind.TS
	}
	if (lower.endsWith(".mjs") || lower.endsWith(".cjs") || lower.endsWith(".js")) {
		return ts.ScriptKind.JS
	}
	if (lower.endsWith(".json")) {
		return ts.ScriptKind.JSON
	}
	return ts.ScriptKind.Unknown
}

/**
 * Language-service host backed by the cached program's already-parsed source
 * files (no re-reading from disk for program files), with an ad-hoc escape
 * hatch for files created after the program was loaded.
 */
class LsHost implements ts.LanguageServiceHost {
	private readonly extraFiles = new Set<string>()

	constructor(
		private readonly program: ts.Program,
		private readonly options: ts.CompilerOptions,
	) {}

	includeExtraFile(fileName: string): void {
		this.extraFiles.add(fileName)
	}

	getCompilationSettings(): ts.CompilerOptions {
		return this.options
	}

	getScriptFileNames(): string[] {
		const names = this.program.getSourceFiles().map((sf) => sf.fileName)
		for (const extra of this.extraFiles) {
			if (!names.includes(extra)) {
				names.push(extra)
			}
		}
		return names
	}

	getScriptVersion(fileName: string): string {
		const sf = this.program.getSourceFile(fileName)
		if (sf !== undefined) {
			// Program files: the whole program + LS is rebuilt on any tracked
			// change, so a static version is correct here.
			return "1"
		}
		if (this.extraFiles.has(fileName)) {
			// Version = mtime: a re-edit of an extra file invalidates the
			// language service's cached parse of it.
			try {
				return String(fs.statSync(fileName).mtimeMs)
			} catch {
				return "1"
			}
		}
		return ""
	}

	getScriptSnapshot(fileName: string): ts.IScriptSnapshot | undefined {
		const sf = this.program.getSourceFile(fileName)
		if (sf !== undefined) {
			return ts.ScriptSnapshot.fromString(sf.text)
		}
		if (this.extraFiles.has(fileName)) {
			const text = ts.sys.readFile(fileName)
			return text === undefined ? undefined : ts.ScriptSnapshot.fromString(text)
		}
		return undefined
	}

	getCurrentDirectory(): string {
		return this.program.getCurrentDirectory()
	}

	getDefaultLibFileName(options: ts.CompilerOptions): string {
		return ts.getDefaultLibFilePath(options)
	}

	fileExists(fileName: string): boolean {
		return ts.sys.fileExists(fileName)
	}

	readFile(fileName: string): string | undefined {
		return ts.sys.readFile(fileName)
	}

	readDirectory(path: string, extensions?: readonly string[], exclude?: readonly string[], include?: readonly string[], depth?: number): string[] {
		return ts.sys.readDirectory(path, extensions, exclude, include, depth)
	}

	useCaseSensitiveFileNames(): boolean {
		return ts.sys.useCaseSensitiveFileNames
	}

	getScriptKind(fileName: string): ts.ScriptKind {
		return scriptKindFromFileName(fileName)
	}
}
