/**
 * Dashboard file-browser backend — thin adapters over the tool executor's
 * existing, already-tested directory-listing logic.
 *
 * The non-negotiable rule here is path safety: every path that crosses the
 * HTTP surface goes through `resolveWithinWorkspace` / `PathTraversalError`
 * (src/tools/executor.ts) — the SAME guard the model-facing tools use. A bug
 * here would be a real directory-traversal vulnerability on a locally-running
 * HTTP server, so this module deliberately reuses that guard instead of
 * reimplementing containment checking.
 *
 * Listing semantics mirror `list_files` (`listFilesHandler` in
 * src/tools/executor.ts): a raw `readdir` of the requested directory, no
 * `.gitignore` filtering (the model-facing tool doesn't filter either — the
 * gitignore-aware walker lives in src/codesearch/files.ts for the codebase
 * index, a different surface). Each entry carries its name, type, and size so
 * the browser can render a tree without extra round-trips.
 *
 * Content retrieval mirrors `read_file`'s size discipline: files over
 * `MAX_RESULT_CHARS` (30k chars, the same cap tool results use to keep model
 * context bounded) or containing NUL bytes (a strong binary signal) return a
 * clear "not previewable" response instead of dumping raw bytes into a JSON
 * response.
 */

import * as fsp from "node:fs/promises"
import * as path from "node:path"

import { resolveWithinWorkspace, PathTraversalError, MAX_RESULT_CHARS } from "../tools/executor.js"
import { DEFAULT_PROTECTED_FILES, isProtectedPath } from "../permissions/protected-files.js"

/** One directory entry, ready for JSON. */
export interface FileEntry {
	/** Entry name (basename) — NOT a path, safe to render directly. */
	name: string
	type: "file" | "dir"
	/** Size in bytes (0 for directories). */
	size: number
}

/**
 * List a directory's entries for a workspace. `dir` is a workspace-relative
 * path (default "."). Throws `PathTraversalError` when the requested path
 * escapes the workspace — callers (the HTTP layer) translate that to a 400.
 */
export async function listWorkspaceDir(workspaceRoot: string, dir: string): Promise<FileEntry[]> {
	const root = path.resolve(workspaceRoot)
	const target = resolveWithinWorkspace(root, dir)

	const dirents = await fsp.readdir(target, { withFileTypes: true })
	const out: FileEntry[] = []
	for (const ent of dirents) {
		const abs = path.join(target, ent.name)
		let size = 0
		if (ent.isFile()) {
			try {
				const st = await fsp.stat(abs)
				size = st.size
			} catch {
				// File vanished between readdir and stat — report size 0.
			}
		}
		out.push({ name: ent.name, type: ent.isDirectory() ? "dir" : "file", size })
	}
	// Dirs first, then alphabetical — same ordering list_files uses.
	out.sort((a, b) => {
		if (a.type !== b.type) {
			return a.type === "dir" ? -1 : 1
		}
		return a.name.localeCompare(b.name)
	})
	return out
}

/** Result of a file-content read: previewable text, or a clear refusal. */
export type FileContentResult =
	| { previewable: true; content: string }
	| { previewable: false; reason: string }

/**
 * Read a single file's content for browser preview. Only text files are
 * previewable: content over `MAX_RESULT_CHARS` or containing NUL bytes (the
 * strongest cheap binary signal) returns a "not previewable" reason instead
 * of raw bytes. Throws `PathTraversalError` for escaping paths.
 *
 * SEC-7: files matching the protected-file patterns (`.env`, `*.pem`, `*.key`,
 * `id_rsa*`, etc. — the same defaults `src/permissions/protected-files.ts`
 * uses to stop the WRITE tools from touching secrets) are refused here too,
 * unconditionally — the dashboard's GET file-content route must not become a
 * read side-channel for the exact files the write-side guard protects. This
 * check is independent of the optional bearer-token gate in server.ts (it
 * applies even when no token is configured).
 */
export async function readWorkspaceFile(workspaceRoot: string, file: string): Promise<FileContentResult> {
	const root = path.resolve(workspaceRoot)
	const target = resolveWithinWorkspace(root, file)

	const relFromRoot = path.relative(root, target).replace(/\\/g, "/")
	if (isProtectedPath(relFromRoot, DEFAULT_PROTECTED_FILES)) {
		return { previewable: false, reason: "protected file — not previewable via the dashboard (matches a secrets pattern like .env/*.key/*.pem)" }
	}

	const st = await fsp.stat(target)
	if (!st.isFile()) {
		return { previewable: false, reason: "not a file" }
	}
	if (st.size > MAX_RESULT_CHARS) {
		return {
			previewable: false,
			reason: `file is ${st.size.toLocaleString()} bytes — over the ${MAX_RESULT_CHARS.toLocaleString()}-char preview cap (same convention as read_file's MAX_RESULT_CHARS)`,
		}
	}

	const buf = await fsp.readFile(target)
	if (buf.includes(0)) {
		return { previewable: false, reason: "binary file — contains NUL bytes, not text-previewable" }
	}
	// UTF-8 decode; replacement chars for invalid sequences are acceptable
	// here (the NUL check above already caught the common binary case).
	return { previewable: true, content: buf.toString("utf-8") }
}
