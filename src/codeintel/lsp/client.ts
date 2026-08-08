/**
 * Minimal LSP client over stdio, built on Microsoft's official protocol
 * packages (vscode-jsonrpc + vscode-languageserver-protocol) — Content-Length
 * framing, JSON-RPC 2.0, request/response correlation are all handled by the
 * connection; nothing here hand-rolls protocol bytes.
 *
 * Lifecycle contract (see the plan in plans/multi-language-code-intel.md):
 *   - `start()` spawns the server process, does the initialize/initialized
 *     handshake with a bounded timeout, and throws a clear error on any
 *     failure (binary missing, crash on init, hang) so the caller can dispose
 *     cleanly and fail closed.
 *   - The child is `unref()`'d so a lingering server can never keep the
 *     parent process alive past its session — explicit `dispose()` is still
 *     the real teardown path (the harness disposes per-session resources at
 *     session end; see ToolExecutor.dispose in src/tools/executor.ts).
 *   - A mid-session death surfaces as rejected requests; the backend owning
 *     this client decides whether to restart (once) or fail closed.
 */

import { spawn, type ChildProcess } from "node:child_process"
import { StreamMessageReader, StreamMessageWriter, createMessageConnection, type MessageConnection } from "vscode-jsonrpc/node"
import * as lsp from "vscode-languageserver-protocol"

/** How long to wait for the initialize handshake before declaring failure. */
export const LSP_INIT_TIMEOUT_MS = 30_000

/** A language-server process to spawn (argv minus cwd). */
export interface LspServerConfig {
	command: string
	args: string[]
}

/** Thrown when the server process cannot be started or dies before init. */
export class LspServerError extends Error {
	constructor(message: string) {
		super(message)
		this.name = "LspServerError"
	}
}

/** True when an error means the server process is gone (vs an LSP error response). */
export function isConnectionError(err: unknown): boolean {
	if (err instanceof lsp.ResponseError) {
		// A real protocol-level error response (e.g. server refusing a
		// request) — the connection is still alive, NOT a process death.
		return false
	}
	return true
}

/**
 * A spawned language server speaking LSP over stdio. One instance owns one
 * child process. Requests are plain `sendRequest` calls over the
 * vscode-jsonrpc connection (which already correlates IDs and rejects on
 * error responses).
 */
export class LspClient {
	private readonly child: ChildProcess
	private readonly connection: MessageConnection
	private died = false
	private disposed = false
	private onExitHandlers: Array<() => void> = []

	constructor(config: LspServerConfig, cwd: string) {
		this.child = spawn(config.command, config.args, { cwd, stdio: ["pipe", "pipe", "pipe"] })
		// Never let a dead-or-orphaned server keep the parent alive past its
		// session; dispose() is the real teardown, unref is only a safety net
		// against leaks in paths that forget to dispose.
		this.child.unref()

		const stdout = this.child.stdout
		const stdin = this.child.stdin
		if (stdout === null || stdin === null) {
			this.child.kill()
			throw new LspServerError(`cannot open stdio pipes to language server '${config.command}'`)
		}
		this.connection = createMessageConnection(new StreamMessageReader(stdout), new StreamMessageWriter(stdin))
		this.connection.listen()

		// Process death: mark dead so the owning backend can restart-once /
		// fail closed. A spawn error (ENOENT etc.) also arrives as 'error'
		// followed by 'exit', so both handlers just record it.
		this.child.on("error", () => {
			this.died = true
		})
		this.child.on("exit", (code, signal) => {
			this.died = true
			// Dispose the connection so any in-flight request rejects instead
			// of hanging forever; the owning backend decides restart-once vs
			// fail-closed (the LspServerError above is its signal).
			this.connection.dispose()
			for (const handler of this.onExitHandlers.splice(0)) {
				handler()
			}
		})
	}

	/** True once the process has exited (or failed to spawn). */
	isDead(): boolean {
		return this.died
	}

	/** Register a callback fired when the process exits. */
	onExit(handler: () => void): void {
		this.onExitHandlers.push(handler)
	}

	/**
	 * Initialize handshake with a bounded timeout. Throws LspServerError on
	 * spawn failure, crash-on-init, or a hung handshake — the caller disposes
	 * and treats the language as "no backend available" (fail closed).
	 */
	async start(workspaceRoot: string): Promise<void> {
		const rootUri = pathToFileUri(workspaceRoot)
		const result = await withTimeout(
			this.connection.sendRequest(lsp.InitializeRequest.type, {
				processId: process.pid,
				rootUri,
				capabilities: {
					// Ask for nested document symbols (DocumentSymbol[]) rather
					// than the flat SymbolInformation[] fallback.
					textDocument: {
						documentSymbol: { hierarchicalDocumentSymbolSupport: true },
					},
				},
				workspaceFolders: [{ uri: rootUri, name: "workspace" }],
			}),
			LSP_INIT_TIMEOUT_MS,
			"timed out waiting for the language server's initialize response",
		)
		if (this.died) {
			throw new LspServerError(
				`language server exited during initialization${result === null ? "" : ` (got: ${describeInitError(result)})`}`,
			)
		}
		this.connection.sendNotification(lsp.InitializedNotification.type, {})
	}

	/**
	 * Send a request and await its typed response. Deliberately loose at this
	 * boundary: vscode-jsonrpc's own typed overloads use `NoInfer` generics
	 * that do not unify through a wrapping generic method, so the transport
	 * stays untyped here and the backend casts each result at its call site —
	 * the protocol request constants (lsp.DocumentSymbolRequest.type, …) carry
	 * the real types there.
	 */
	sendRequest(type: unknown, params: unknown): Promise<unknown> {
		return this.connection.sendRequest(type as lsp.RequestType<unknown, unknown, unknown>, params)
	}

	/** Fire-and-forget notification (didOpen / didChange / didClose). */
	sendNotification(type: unknown, params: unknown): void {
		this.connection.sendNotification(type as lsp.NotificationType<unknown>, params)
	}

	/** Kill the server process and tear down the connection. Idempotent. */
	dispose(): void {
		if (this.disposed) {
			return
		}
		this.disposed = true
		this.onExitHandlers = []
		this.connection.dispose()
		if (!this.child.killed) {
			this.child.kill()
		}
	}
}

/** Absolute path → file:// URI (POSIX paths; this harness targets Linux/macOS). */
export function pathToFileUri(p: string): string {
	return "file://" + p.replace(/\\/g, "/")
}

/** file:// URI → absolute path. */
export function fileUriToPath(uri: string): string {
	if (!uri.startsWith("file://")) {
		return uri
	}
	return decodeURIComponent(uri.slice("file://".length))
}

/** Bound a promise with a timeout that rejects with `message` on expiry. */
function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(() => reject(new LspServerError(message)), ms)
		promise.then(
			(value) => {
				clearTimeout(timer)
				resolve(value)
			},
			(err) => {
				clearTimeout(timer)
				reject(err)
			},
		)
	})
}

/** Best-effort human description of a failed initialize result. */
function describeInitError(result: unknown): string {
	if (result === null || result === undefined) {
		return "no capabilities returned"
	}
	try {
		return JSON.stringify(result).slice(0, 200)
	} catch {
		return String(result)
	}
}
