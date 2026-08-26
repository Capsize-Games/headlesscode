/**
 * SHIM — replaces zoo-code/src/utils/path.ts.
 *
 * The original file resolves the workspace root from `vscode.workspace`. The
 * headless harness has no VS Code, so the workspace root comes from the
 * `HEADLESSCODE_WORKSPACE_ROOT` environment variable (falling back to
 * `process.cwd()`).
 *
 * This module also installs `String.prototype.toPosix()` exactly like the
 * original (declaration merging + prototype assignment), which the vendored
 * prompt sections (rules.ts, system-info.ts) rely on. Import it once for its
 * side effect, e.g. from the harness entry point or the smoke test.
 */

import * as path from "path"

function toPosixPath(p: string): string {
	// Extended-Length Paths in Windows start with "\\?\" and must be left alone.
	const isExtendedLengthPath = p.startsWith("\\\\?\\")
	if (isExtendedLengthPath) {
		return p
	}
	return p.replace(/\\/g, "/")
}

declare global {
	interface String {
		toPosix(): string
	}
}

String.prototype.toPosix = function (this: string): string {
	return toPosixPath(this)
}

function normalizePath(p: string): string {
	let normalized = path.normalize(p)
	if (normalized.length > 1 && (normalized.endsWith("/") || normalized.endsWith("\\"))) {
		normalized = normalized.slice(0, -1)
	}
	return normalized
}

/** Safe path comparison that works across different platforms. */
export function arePathsEqual(path1?: string, path2?: string): boolean {
	if (!path1 && !path2) {
		return true
	}
	if (!path1 || !path2) {
		return false
	}
	const normalized1 = normalizePath(path1)
	const normalized2 = normalizePath(path2)
	if (process.platform === "win32") {
		return normalized1.toLowerCase() === normalized2.toLowerCase()
	}
	return normalized1 === normalized2
}

export function getReadablePath(cwd: string, relPath?: string): string {
	if (relPath === undefined) {
		return ""
	}
	const absolutePath = path.resolve(cwd, relPath)
	if (arePathsEqual(path.normalize(absolutePath), path.normalize(cwd))) {
		return path.basename(absolutePath).toPosix()
	}
	const normalizedRelPath = path.relative(cwd, absolutePath)
	if (absolutePath.includes(cwd)) {
		return normalizedRelPath.toPosix()
	}
	return absolutePath.toPosix()
}

export const toRelativePath = (filePath: string, cwd: string): string => {
	const relativePath = path.relative(cwd, filePath).toPosix()
	return filePath.endsWith("/") ? relativePath + "/" : relativePath
}

/**
 * Headless workspace root. The original reads `vscode.workspace.workspaceFolders`;
 * here we prefer the HEADLESSCODE_WORKSPACE_ROOT env var, then process.cwd().
 */
export const getWorkspacePath = (defaultCwdPath = ""): string => {
	const override = process.env.HEADLESSCODE_WORKSPACE_ROOT
	if (override) {
		return override
	}
	return process.cwd() || defaultCwdPath
}

export const getWorkspacePathForContext = (_contextPath?: string): string => {
	return getWorkspacePath()
}
