/**
 * COV-2: behavioral test for GET / (src/dashboard/page.ts's renderPage, wired
 * up in src/dashboard/server.ts). Before this file, the entire 2,624-line
 * dashboard UI had no test that ever fetched the actual root route — only a
 * PUT to "/" was exercised (server.test.ts's non-GET-method-rejected check),
 * and scripts/check-page-script.mjs only parse-guards the inline <script>,
 * never asserting anything about the rendered HTML shape.
 *
 * This starts a REAL dashboard server on an ephemeral port and fetches GET /,
 * asserting the key DOM landmarks the client-side script depends on by id
 * (session list, detail panel, file browser, mode-models/permissions
 * settings panels, launch form) are present, well-formed enough to be a
 * single HTML document, and that --repo threads through into the file-
 * browser's default input value.
 *
 * Plain assert-based script (no test framework), run via `npm test` ->
 * `tsx src/dashboard/__tests__/page-route.test.ts`.
 */

import assert from "node:assert/strict"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"

import { startDashboardServer } from "../server.js"
import type { Server } from "node:http"

async function tmpRepo(prefix = "hc-page-route-"): Promise<string> {
	return fs.mkdtemp(path.join(os.tmpdir(), prefix))
}

async function startServer(repo?: string): Promise<{ server: Server; port: number }> {
	const server = await startDashboardServer({ port: 0, ...(repo ? { repo } : {}) })
	const addr = server.address()
	const port = typeof addr === "object" && addr ? addr.port : 0
	return { server, port }
}

// Every id the client-side script (embedded in page.ts) looks up via
// document.getElementById at startup — a landmark going missing would silently
// break the dashboard's JS with no test ever catching it.
const REQUIRED_LANDMARK_IDS = [
	"generatedAt",
	"launch",
	"launchTask",
	"launchMode",
	"btnStart",
	"totals",
	"modeModels",
	"fileBrowser",
	"fbRepo",
	"fbLoad",
	"permissionsSettings",
	"blocked",
	"round",
	"sessions",
	"costHistory",
	"detail",
	"detailSessionId",
	"detailState",
	"btnPause",
	"btnResume",
	"tabLog",
	"tabChat",
	"tabTimeline",
	"feed",
	"chat",
	"timeline",
	"error",
]

async function testGetRootServesDashboardHtmlWithLandmarks(): Promise<void> {
	const { server, port } = await startServer()
	try {
		const res = await fetch(`http://127.0.0.1:${port}/`)
		assert.equal(res.status, 200)
		assert.match(res.headers.get("content-type") ?? "", /text\/html/)

		const html = await res.text()
		assert.match(html, /<!doctype html>/i, "must be a real HTML document")
		assert.match(html, /<title>/i)
		assert.match(html, /<script>/i, "the client-side controller script must be embedded")

		for (const id of REQUIRED_LANDMARK_IDS) {
			assert.match(
				html,
				new RegExp(`id="${id}"`),
				`missing required DOM landmark id="${id}" — the client script references it and would break silently`,
			)
		}

		// Balanced enough to be well-formed: every opening <script> has a
		// matching </script>, and the doc has exactly one <body>.
		const scriptOpens = (html.match(/<script(?:\s[^>]*)?>/g) ?? []).length
		const scriptCloses = (html.match(/<\/script>/g) ?? []).length
		assert.equal(scriptOpens, scriptCloses, "every <script> tag must be closed")
		assert.equal((html.match(/<body[\s>]/g) ?? []).length, 1)
	} finally {
		server.close()
	}
}

async function testGetRootThreadsRepoIntoFileBrowserDefault(): Promise<void> {
	const repo = await tmpRepo()
	try {
		const { server, port } = await startServer(repo)
		try {
			const res = await fetch(`http://127.0.0.1:${port}/`)
			const html = await res.text()
			// renderPage(repo) pre-fills #fbRepo's value from --repo so the file
			// browser works without the user typing the path first.
			assert.ok(
				html.includes(`id="fbRepo"`) && html.includes(repo.replace(/"/g, "&quot;")),
				"the --repo value must be threaded into the file-browser input's default value",
			)
		} finally {
			server.close()
		}
	} finally {
		await fs.rm(repo, { recursive: true, force: true })
	}
}

async function testGetRootWithoutRepoStillRendersWithEmptyDefault(): Promise<void> {
	const { server, port } = await startServer()
	try {
		const res = await fetch(`http://127.0.0.1:${port}/`)
		assert.equal(res.status, 200)
		const html = await res.text()
		assert.match(html, /id="fbRepo"\s+placeholder="workspace path \(repo\)"\s+value=""/)
	} finally {
		server.close()
	}
}

const tests: Array<[string, () => Promise<void>]> = [
	["GET / serves the dashboard HTML with every DOM landmark the client script needs", testGetRootServesDashboardHtmlWithLandmarks],
	["GET / with --repo threads the repo path into the file-browser default value", testGetRootThreadsRepoIntoFileBrowserDefault],
	["GET / without --repo still renders, with an empty file-browser default", testGetRootWithoutRepoStillRendersWithEmptyDefault],
]

async function main(): Promise<void> {
	let failed = 0
	for (const [name, fn] of tests) {
		try {
			await fn()
			console.log(`  ok   ${name}`)
		} catch (err) {
			failed++
			console.error(`  FAIL ${name}`)
			console.error(err instanceof Error ? (err.stack ?? err.message) : String(err))
		}
	}
	if (failed > 0) {
		console.error(`\n${failed} test(s) failed`)
		process.exit(1)
	}
	console.log(`\nAll ${tests.length} dashboard page-route tests passed`)
}

main().catch((err) => {
	console.error("Test runner crashed:", err)
	process.exit(1)
})
