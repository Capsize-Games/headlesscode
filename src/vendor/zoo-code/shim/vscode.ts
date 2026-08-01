/**
 * SHIM — headless stand-in for the `vscode` module.
 *
 * Maps to this file via the "vscode" entry in tsconfig.json "paths". The real
 * Zoo Code imports `vscode.*` all over its GUI-coupled layer; the vendored core
 * only touches the small surface below. Every method is a harmless no-op —
 * a headless harness must never depend on VS Code UI or file watchers.
 *
 * See VENDOR-NOTES.md for the full shim inventory.
 */

export interface Disposable {
	dispose(): void
}

export interface ExtensionContext {
	globalState: {
		get<T>(key: string, defaultValue?: T): Promise<T | undefined>
		update(key: string, value: unknown): Promise<void>
	}
	globalStorageUri: { fsPath: string }
	subscriptions: Disposable[]
}

export interface WorkspaceFolder {
	uri: { fsPath: string }
	name: string
	index: number
}

export interface FileSystemWatcher extends Disposable {
	onDidChange(listener: (e: unknown) => unknown): Disposable
	onDidCreate(listener: (e: unknown) => unknown): Disposable
	onDidDelete(listener: (e: unknown) => unknown): Disposable
}

export namespace window {
	export function showErrorMessage(message: string, ..._items: string[]): Promise<string | undefined> {
		console.error(`[headlesscode vscode-shim] ${message}`)
		return Promise.resolve(undefined)
	}

	export function showWarningMessage(message: string, ..._items: string[]): Promise<string | undefined> {
		console.warn(`[headlesscode vscode-shim] ${message}`)
		return Promise.resolve(undefined)
	}
}

export namespace workspace {
	// The headless harness has no VS Code workspace folders. CustomModesManager
	// treats this as "no .roomodes file in the UI sense" and falls back to the
	// headless workspace root from utils/path.ts.
	export const workspaceFolders: readonly WorkspaceFolder[] | undefined = undefined

	export function createFileSystemWatcher(_globPattern: string | unknown): FileSystemWatcher {
		// No-op: file watching is a GUI feature, out of scope for the harness.
		return {
			onDidChange: () => ({ dispose: () => {} }),
			onDidCreate: () => ({ dispose: () => {} }),
			onDidDelete: () => ({ dispose: () => {} }),
			dispose: () => {},
		}
	}

	export function getConfiguration(_section?: string): {
		get<T>(key: string, defaultValue?: T): T | undefined
	} {
		return { get: () => undefined }
	}
}

export namespace env {
	export const language = "en"
}
