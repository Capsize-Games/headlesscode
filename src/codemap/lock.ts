/**
 * codemap storage in the CENTRAL per-project data store — mirroring the
 * codesearch precedent exactly: `<dataRoot>/projects/<project-key>/codemap/`
 * (see src/project-store.ts). Worktrees of a repo share one codemap for free,
 * and the dashboard reads it from the same resolved location.
 */

import * as fs from "node:fs"
import * as path from "node:path"

import { resolveProjectDataDir } from "../project-store.js"
import type { Codemap, CodemapLock } from "./types.js"

/** Directory holding a project's codemap artifacts, relative to the project key dir. */
export const CODEMAP_DIR_NAME = "codemap"

/** Workspace root -> absolute codemap storage dir (central project store). */
export function codemapDir(workspaceRoot: string): string {
	return path.join(resolveProjectDataDir(workspaceRoot), CODEMAP_DIR_NAME)
}

export function codemapJsonPath(workspaceRoot: string): string {
	return path.join(codemapDir(workspaceRoot), "codemap.json")
}

export function codemapLockPath(workspaceRoot: string): string {
	return path.join(codemapDir(workspaceRoot), "codemap.lock")
}

export function codemapHtmlPath(workspaceRoot: string): string {
	return path.join(codemapDir(workspaceRoot), "codemap.html")
}

/** Loose-parse the stored lock; undefined when missing/unreadable/malformed. */
export function loadLock(workspaceRoot: string): CodemapLock | undefined {
	let raw: string
	try {
		raw = fs.readFileSync(codemapLockPath(workspaceRoot), "utf-8")
	} catch {
		return undefined
	}
	try {
		const parsed = JSON.parse(raw) as Record<string, unknown>
		if (typeof parsed.fingerprints !== "object" || parsed.fingerprints === null) {
			return undefined
		}
		const fingerprints: Record<string, string> = {}
		for (const [k, v] of Object.entries(parsed.fingerprints)) {
			if (typeof v === "string") {
				fingerprints[k] = v
			}
		}
		return {
			project: typeof parsed.project === "string" ? parsed.project : "",
			fingerprints,
			codemapFingerprint: typeof parsed.codemapFingerprint === "string" ? parsed.codemapFingerprint : "",
		}
	} catch {
		return undefined
	}
}

/** Load the stored codemap.json; undefined when missing/unreadable/malformed. */
export function loadCodemap(workspaceRoot: string): Codemap | undefined {
	let raw: string
	try {
		raw = fs.readFileSync(codemapJsonPath(workspaceRoot), "utf-8")
	} catch {
		return undefined
	}
	try {
		const parsed = JSON.parse(raw) as Codemap
		if (!Array.isArray(parsed.modules) || !Array.isArray(parsed.edges) || typeof parsed.fingerprint !== "string") {
			return undefined
		}
		return parsed
	} catch {
		return undefined
	}
}
