/** Fixed local shim for the Capsize-built HeadlessCode dashboard artifact. */
import { readFileSync } from "node:fs"
import * as path from "node:path"

const UI_DIST = "/home/joe/Projects/capsize-web/apps/headlesscode/dist"
const REPO_MARKER = "__CAPSIZE_REPO_BOOTSTRAP__"
const STYLE_MARKER = '<link rel="stylesheet" href="assets/headlesscode.css">'
const SCRIPT_MARKER = '<script src="assets/headlesscode.js"></script>'

function htmlAttribute(value: string): string {
	return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;").replaceAll("'", "&#39;")
}

/**
 * Render the centralized Capsize UI bundle for direct HeadlessCode dashboard
 * requests. Reads are lazy so importing the CLI or server never requires the
 * sibling web workspace; a missing build is an explicit service error.
 */
export function renderPage(repo?: string): string {
	const templatePath = path.join(UI_DIST, "page-template.html")
	const template = readFileSync(templatePath, "utf8")
	const css = readFileSync(path.join(UI_DIST, "assets", "headlesscode.css"), "utf8")
	const js = readFileSync(path.join(UI_DIST, "assets", "headlesscode.js"), "utf8")
	if (template.split(REPO_MARKER).length !== 2 || !template.includes(STYLE_MARKER) || !template.includes(SCRIPT_MARKER)) {
		throw new Error("Capsize HeadlessCode dashboard artifact is invalid")
	}
	return template.replace(REPO_MARKER, () => htmlAttribute(repo ?? ""))
		.replace(STYLE_MARKER, () => `<style>${css}</style>`)
		.replace(SCRIPT_MARKER, () => `<script>${js.replace(/<\/script/gi, "<\\/script")}</script>`)
}
