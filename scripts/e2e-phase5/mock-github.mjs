#!/usr/bin/env node
/**
 * mock-github.mjs — tiny fake GitHub REST API server for the Phase 5 e2e.
 *
 * Node built-ins only (http, fs, path) — no dependencies. It serves the
 * endpoints the issue watcher's gh client calls:
 *
 *   GET  /repos/{owner}/{repo}/issues?labels=...&state=open&per_page=..&page=..
 *        -> the scripted open issues (from MOCK_ISSUES_FILE)
 *   GET  /repos/{owner}/{repo}/issues/{n}
 *        -> the matching scripted issue (or 404)
 *   POST /repos/{owner}/{repo}/issues/{n}/labels
 *        -> 200 + the labels array (echoes the payload; used only if the
 *           label-marking idempotency strategy is exercised)
 *
 * Every request requires an `Authorization: Bearer <anything>` header
 * (the watcher always sends one) — missing/blank -> 401. The token value is
 * never validated (GH_TOKEN=test in the e2e).
 *
 * Environment:
 *   PORT              listen port (default 0 = OS-assigned; actual port is
 *                     printed in the "[mock] listening on ..." line)
 *   MOCK_ISSUES_FILE  path to a JSON array of GitHub-shaped issue payloads:
 *                     [{ number, title, body, labels: [{name}], updated_at,
 *                        html_url }] — served for ANY owner/repo (the e2e has
 *                     one repo; the watcher derives the repo name from the
 *                     local fixture dir, so it varies per temp dir).
 *
 * Logging: one line per request, captured by run.sh for assertions, e.g.
 *   [mock] GET /repos/acme/widget/issues?per_page=100&page=1&state=open&labels=needs-agent
 */

import http from "node:http"
import fs from "node:fs"

const PORT = Number(process.env.PORT || 0)
const ISSUES_FILE = process.env.MOCK_ISSUES_FILE

let ISSUES = []
if (ISSUES_FILE) {
	try {
		const parsed = JSON.parse(fs.readFileSync(ISSUES_FILE, "utf-8"))
		if (Array.isArray(parsed)) {
			ISSUES = parsed
		} else {
			console.error(`[mock] MOCK_ISSUES_FILE ${ISSUES_FILE} is not a JSON array`)
			process.exit(1)
		}
	} catch (err) {
		console.error(`[mock] cannot read MOCK_ISSUES_FILE ${ISSUES_FILE}: ${err.message}`)
		process.exit(1)
	}
} else {
	console.error("[mock] MOCK_ISSUES_FILE is required (JSON array of issues)")
	process.exit(1)
}

function sendJson(res, status, body) {
	const payload = JSON.stringify(body)
	res.writeHead(status, {
		"Content-Type": "application/json",
		"Content-Length": Buffer.byteLength(payload),
	})
	res.end(payload)
}

const server = http.createServer((req, res) => {
	const url = new URL(req.url, `http://${req.headers.host || "127.0.0.1"}`)
	console.log(`[mock] ${req.method} ${url.pathname}${url.search}`)

	const auth = req.headers.authorization || ""
	if (!/^Bearer\s+\S+/.test(auth)) {
		sendJson(res, 401, { message: "Bad credentials" })
		return
	}

	// /repos/{owner}/{repo}/issues?...
	const listMatch = url.pathname.match(/^\/repos\/[^/]+\/[^/]+\/issues$/)
	const singleMatch = url.pathname.match(/^\/repos\/[^/]+\/[^/]+\/issues\/(\d+)$/)
	const labelsMatch = url.pathname.match(/^\/repos\/[^/]+\/[^/]+\/issues\/(\d+)\/labels$/)

	if (labelsMatch && req.method === "POST") {
		// Label-marking strategy (not used by the default e2e flow, but keep
		// the endpoint honest).
		let raw = ""
		req.on("data", (c) => (raw += c))
		req.on("end", () => {
			sendJson(res, 200, ISSUES.find((i) => i.number === Number(labelsMatch[1]))?.labels ?? [])
		})
		return
	}

	if (singleMatch && req.method === "GET") {
		const number = Number(singleMatch[1])
		const issue = ISSUES.find((i) => i.number === number)
		if (!issue) {
			sendJson(res, 404, { message: "Not Found" })
			return
		}
		sendJson(res, 200, issue)
		return
	}

	if (listMatch && req.method === "GET") {
		// The watcher requests state=open&labels=<label>&per_page=100&page=N.
		// We serve the full scripted set (all carry the target label) and log
		// the query so run.sh can assert the label/state filtering happened.
		sendJson(res, 200, ISSUES)
		return
	}

	sendJson(res, 404, { message: `Not Found: ${req.method} ${url.pathname}` })
})

server.on("error", (err) => {
	console.error(`[mock] server error: ${err.message}`)
	process.exit(1)
})

server.listen(PORT, "127.0.0.1", () => {
	const addr = server.address()
	const port = typeof addr === "object" && addr ? addr.port : PORT
	console.log(`[mock] listening on http://127.0.0.1:${port} issues=${ISSUES.length}`)
})
