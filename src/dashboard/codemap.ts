/**
 * Dashboard read-side for the codemap: serves the stored codemap.json /
 * codemap.html from the CENTRAL per-project store (same resolution the
 * `headlesscode codemap` CLI writes to — see src/codemap/lock.ts). The
 * dashboard deliberately does NOT generate the map on request (it's a
 * deterministic script job, run by the CLI/watcher); it just serves what's
 * there and gives a clear pointer when nothing has been generated yet.
 */

import * as fs from "node:fs"

import { codemapHtmlPath, codemapJsonPath } from "../codemap/lock.js"

export interface CodemapFileResult {
	content: string
	contentType: string
}

/** The stored codemap.json content; undefined when not generated yet. */
export function readCodemapJson(workspaceRoot: string): CodemapFileResult | undefined {
	return readFileIfPresent(codemapJsonPath(workspaceRoot), "application/json; charset=utf-8")
}

/** The stored codemap.html content; undefined when not generated yet. */
export function readCodemapHtml(workspaceRoot: string): CodemapFileResult | undefined {
	return readFileIfPresent(codemapHtmlPath(workspaceRoot), "text/html; charset=utf-8")
}

/** The error message + exit hint a route returns when the map doesn't exist yet. */
export function codemapMissingError(workspaceRoot: string): string {
	return (
		`no codemap generated for ${workspaceRoot} yet — run ` +
		`\`headlesscode codemap --workspace ${workspaceRoot}\` (or start it in --watch mode) to build it.`
	)
}

function readFileIfPresent(file: string, contentType: string): CodemapFileResult | undefined {
	try {
		const content = fs.readFileSync(file, "utf-8")
		return { content, contentType }
	} catch {
		return undefined
	}
}
