/**
 * Per-workspace code-intelligence backend registry + per-file dispatch
 * (issue #59).
 *
 * This is the piece that replaces the old TS-only gate: instead of "is this
 * workspace TypeScript → register the six tools", the executor creates ONE
 * service per workspace, asks it which detected languages have a backend
 * available, and registers the tools when at least one does. At call time the
 * service maps the TARGET FILE's extension to the backend that owns it, so a
 * single session on a mixed repo (e.g. airunner's Python server + TS client)
 * can call find_references on a `.py` file and then on a `.ts` file in the
 * same turn and get the RIGHT backend's answer for each.
 *
 * Backend lifecycle (mirrors the plan's contract):
 *   - one persistent backend per (workspace, language), cached for the
 *     service's lifetime (which is the executor's = the session's) — the LSP
 *     process is spawned once, never per call.
 *   - startup failure (binary missing / crash on init): WARN + fail closed —
 *     the language is marked unavailable for the rest of the session and the
 *     handler reports a clear "no backend available" result, never a hard
 *     session failure.
 *   - `dispose()` kills every spawned server; wired into ToolExecutor.dispose
 *     so session end never leaks child processes.
 */

import * as fs from "node:fs"
import { createRequire } from "node:module"
import * as path from "node:path"

import { TypeScriptCodeIntelBackend, type CodeIntelBackend } from "./backend.js"
import { LspCodeIntelBackend, type LspBackendLogger } from "./lsp/backend.js"
import { LANGUAGE_SERVERS, type LanguageServerSpec } from "./lsp/registry.js"

const require = createRequire(import.meta.url)

/** File extension → language, for per-file backend dispatch. */
const EXTENSION_LANGUAGES: ReadonlyArray<{ exts: readonly string[]; language: string }> = [
	{ exts: [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"], language: "typescript" },
	{ exts: [".py"], language: "python" },
]

/** Fallback logger (executor sessions pass none; stderr keeps it visible). */
const defaultLogger: LspBackendLogger = {
	warn: (message) => process.stderr.write(`[code-intel] ${message}\n`),
}

export interface CodeIntelServiceOptions {
	/** Lifecycle WARNs (server failed to start, died mid-session). */
	logger?: LspBackendLogger
	/**
	 * Language → server registry override (tests inject a broken registry to
	 * prove fail-closed). Defaults to the real LANGUAGE_SERVERS.
	 */
	serverRegistry?: Record<string, LanguageServerSpec>
}

/** Map a target file to the language that owns it (undefined = no backend). */
export function languageForFile(file: string): string | undefined {
	const ext = path.extname(file).toLowerCase()
	for (const { exts, language } of EXTENSION_LANGUAGES) {
		if (exts.includes(ext)) {
			return language
		}
	}
	return undefined
}

/**
 * One service per workspace (one per executor = one per session). Owns the
 * cached backends and the per-file dispatch.
 */
export class CodeIntelService {
	private readonly logger: LspBackendLogger
	private readonly registry: Record<string, LanguageServerSpec>
	private readonly backends = new Map<string, CodeIntelBackend>()
	/** Languages that failed to start a backend — fail closed for the session. */
	private readonly unavailable = new Set<string>()
	/** In-flight backend starts (concurrent first calls share one spawn). */
	private readonly starting = new Map<string, Promise<CodeIntelBackend | undefined>>()

	constructor(
		private readonly workspaceRoot: string,
		options: CodeIntelServiceOptions = {},
	) {
		this.logger = options.logger ?? defaultLogger
		this.registry = options.serverRegistry ?? LANGUAGE_SERVERS
	}

	/**
	 * True when a backend for `language` COULD be created (typescript is
	 * always available — the compiler is a hard dependency; LSP languages
	 * require their server binary to be resolvable). Synchronous, so the
	 * executor can decide registration up front without an async start.
	 */
	isBackendAvailable(language: string): boolean {
		if (language === "typescript") {
			return true
		}
		const spec = this.registry[language]
		return spec !== undefined && serverBinaryExists(spec)
	}

	/** Every detected+available language this service can serve. */
	availableLanguages(languages: Iterable<string>): string[] {
		const available: string[] = []
		for (const language of languages) {
			if (this.isBackendAvailable(language)) {
				available.push(language)
			}
		}
		return available
	}

	/**
	 * Whether `import_graph` can be registered at all: only backends that
	 * implement it count — the TypeScript backend does; LSP has no standard
	 * import-graph request, so LSP-only languages throw a clear "not
	 * supported" error when a model tries it.
	 */
	supportsImportGraph(languages: Iterable<string>): boolean {
		for (const language of languages) {
			if (this.isBackendAvailable(language) && this.backendImplementsImportGraph(language)) {
				return true
			}
		}
		return false
	}

	/**
	 * The backend that owns `file` (by extension), creating it lazily on first
	 * use. Returns undefined when no backend exists for the file's language or
	 * the backend failed to start (fail closed).
	 */
	async resolveBackend(file: string): Promise<CodeIntelBackend | undefined> {
		const language = languageForFile(file)
		if (language === undefined) {
			return undefined
		}
		return this.backendFor(language)
	}

	/** Release every backend (kills LSP server processes). Idempotent. */
	async dispose(): Promise<void> {
		for (const backend of this.backends.values()) {
			try {
				await backend.dispose()
			} catch {
				// Best-effort teardown; the session is ending regardless.
			}
		}
		this.backends.clear()
		this.unavailable.clear()
		this.starting.clear()
	}

	// ─── internals ──────────────────────────────────────────────────────────────

	private async backendFor(language: string): Promise<CodeIntelBackend | undefined> {
		if (this.unavailable.has(language)) {
			return undefined
		}
		const cached = this.backends.get(language)
		if (cached !== undefined) {
			return cached
		}
		const inFlight = this.starting.get(language)
		if (inFlight !== undefined) {
			return inFlight
		}
		const promise = this.startBackend(language)
		this.starting.set(language, promise)
		try {
			return await promise
		} finally {
			this.starting.delete(language)
		}
	}

	private async startBackend(language: string): Promise<CodeIntelBackend | undefined> {
		if (language === "typescript") {
			const backend = new TypeScriptCodeIntelBackend(this.workspaceRoot)
			this.backends.set(language, backend)
			return backend
		}
		const spec = this.registry[language]
		if (spec === undefined || !serverBinaryExists(spec)) {
			this.unavailable.add(language)
			return undefined
		}
		const backend = new LspCodeIntelBackend(this.workspaceRoot, language, spec, this.logger)
		try {
			await backend.start()
		} catch (err) {
			this.logger.warn(
				`language server for '${language}' failed to start (${err instanceof Error ? err.message : String(err)}) — ` +
					`disabling code-intelligence for ${language} files this session`,
			)
			await backend.dispose().catch(() => {})
			this.unavailable.add(language)
			return undefined
		}
		this.backends.set(language, backend)
		return backend
	}

	private backendImplementsImportGraph(language: string): boolean {
		return language === "typescript"
	}
}

/** True when the server's command is resolvable (exists + runnable-ish). */
function serverBinaryExists(spec: LanguageServerSpec): boolean {
	try {
		// require.resolve would throw on a missing binary; a plain path command
		// (e.g. a hypothetical "rust-analyzer" on PATH) can't be verified
		// cheaply, so non-resolvable commands are treated as available and the
		// spawn itself fails closed at first use.
		require.resolve(spec.command)
		return true
	} catch {
		// Not a resolvable module path — check it as a filesystem path.
		return spec.command.includes("/") ? fs.existsSync(spec.command) : true
	}
}
