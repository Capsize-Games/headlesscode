/**
 * Cost/token dashboard — plain `node:http` server (workstream 3) + live
 * per-session events + pause/resume control (live worker monitoring) +
 * per-mode model settings (mode-model-assignment).
 *
 * ZERO new UI/framework dependencies, matching this project's established
 * "plain fs + JSON, no schema library" ethos (see `src/orchestrator/state.ts`'s
 * own file-header comment). Bound to `127.0.0.1` only, no auth — explicitly a
 * local-only tool per the plan doc.
 *
 *   GET  /                        the static HTML page (src/dashboard/page.ts)
 *   GET  /api/summary             JSON from src/dashboard/aggregate.ts's buildSummary()
 *   GET  /api/session/:id/events  JSON events feed (incremental via ?since=<offset>)
 *   POST /api/session/:id/pause   write `.harness.pause-requested` (worker pauses between iterations)
 *   POST /api/session/:id/resume  remove `.harness.pause-requested` (worker resumes)
 *   GET  /api/settings/mode-models?repo=<path>   current mode-models.json content ({} if absent)
 *   POST /api/settings/mode-models?repo=<path>   validate + write mode-models.json (creates .headlesscode/)
 *
 * NOTE (Phase 3 scope change): the dashboard is no longer purely read-only.
 * The POST routes above write/remove files in the target worktree/repo — a
 * control action, not just observability. Still local-only / no-auth (binds
 * 127.0.0.1), but if this endpoint is ever exposed beyond localhost, that
 * assumption needs revisiting — no auth was added here.
 */

import * as fsp from "node:fs/promises"
import * as http from "node:http"
import * as path from "node:path"

import { buildSummary, findSessionEventsFile, readSessionEvents } from "./aggregate.js"
import { renderPage } from "./page.js"
import {
	MODE_MODELS_CONFIG_FILE,
	loadModeModelsFile,
	stringifyModeModelsFile,
	validateModeModelsBody,
	type ModeModelsFile,
} from "../config/mode-models.js"

/** Default dashboard port (overridable via --port or $HEADLESSCODE_DASHBOARD_PORT). */
export const DEFAULT_DASHBOARD_PORT = 4390

export interface DashboardServerOptions {
	port: number
	/** Repo root to scan for usage files + .orchestrator-state.json (optional). */
	repo?: string
}

/** Start the dashboard HTTP server. Resolves once it's listening. */
export function startDashboardServer(options: DashboardServerOptions): Promise<http.Server> {
	const server = http.createServer((req, res) => {
		void handleRequest(req, res, options)
	})

	return new Promise((resolve, reject) => {
		server.once("error", reject)
		server.listen(options.port, "127.0.0.1", () => {
			server.removeListener("error", reject)
			resolve(server)
		})
	})
}

async function handleRequest(
	req: http.IncomingMessage,
	res: http.ServerResponse,
	options: DashboardServerOptions,
): Promise<void> {
	const url = new URL(req.url ?? "/", "http://127.0.0.1")

	// Live session detail: GET /api/session/:id/events?since=<offset>&repo=<path>
	const eventsMatch = /^\/api\/session\/([^/]+)\/events$/.exec(url.pathname)
	if (eventsMatch && req.method === "GET") {
		const sessionId = decodeURIComponent(eventsMatch[1])
		const repo = url.searchParams.get("repo") || options.repo
		if (!repo) {
			res.writeHead(400, { "content-type": "application/json; charset=utf-8" }).end(
				JSON.stringify({ error: "missing repo — pass ?repo=<path> or start the dashboard with --repo" }),
			)
			return
		}
		const sinceRaw = url.searchParams.get("since")
		const since = sinceRaw === null || sinceRaw === "" ? 0 : Number(sinceRaw)
		if (!Number.isFinite(since) || since < 0) {
			res.writeHead(400, { "content-type": "application/json; charset=utf-8" }).end(
				JSON.stringify({ error: "invalid since offset" }),
			)
			return
		}
		try {
			const { events, nextOffset } = await readSessionEvents(repo, sessionId, since)
			res
				.writeHead(200, { "content-type": "application/json; charset=utf-8" })
				.end(JSON.stringify({ sessionId, events, nextOffset }))
		} catch (error) {
			res
				.writeHead(500, { "content-type": "application/json; charset=utf-8" })
				.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }))
		}
		return
	}

	// Pause/resume control (Phase 3): POST /api/session/:id/pause|resume —
	// deliberately POST-only (a state-changing action must not be triggerable
	// by a GET/prefetch). Pause writes `.harness.pause-requested`; resume
	// removes it (presence/absence IS the signal — see src/engine/loop.ts).
	const pauseMatch = /^\/api\/session\/([^/]+)\/(pause|resume)$/.exec(url.pathname)
	if (pauseMatch && req.method !== "POST") {
		res.writeHead(405, { "content-type": "text/plain" }).end("Method Not Allowed")
		return
	}
	if (pauseMatch && req.method === "POST") {
		const sessionId = decodeURIComponent(pauseMatch[1])
		const action = pauseMatch[2]
		const repo = url.searchParams.get("repo") || options.repo
		if (!repo) {
			res.writeHead(400, { "content-type": "application/json; charset=utf-8" }).end(
				JSON.stringify({ error: "missing repo — pass ?repo=<path> or start the dashboard with --repo" }),
			)
			return
		}
		try {
			const found = await findSessionEventsFile(repo, sessionId)
			if (!found) {
				res.writeHead(404, { "content-type": "application/json; charset=utf-8" }).end(
					JSON.stringify({ error: `no session ${sessionId} found under ${repo}` }),
				)
				return
			}
			// The marker lives in the worktree that owns the session's events feed.
			const worktreeRoot = found.source === "." ? path.resolve(repo) : path.resolve(repo, found.source)
			const markerPath = path.join(worktreeRoot, ".harness.pause-requested")
			if (action === "pause") {
				await fsp.writeFile(markerPath, new Date().toISOString() + "\n", "utf-8")
			} else {
				await fsp.rm(markerPath, { force: true })
			}
			res.writeHead(200, { "content-type": "application/json; charset=utf-8" }).end(
				JSON.stringify({ sessionId, action, ok: true, worktree: found.source }),
			)
		} catch (error) {
			res
				.writeHead(500, { "content-type": "application/json; charset=utf-8" })
				.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }))
		}
		return
	}

	// Per-mode model settings (mode-model-assignment): GET returns the current
	// `.headlesscode/mode-models.json` content ({} when absent); POST validates
	// the JSON body with the same rules the config loader uses and writes it
	// (creating `.headlesscode/` if needed). A malformed save is rejected with
	// a clear error — never writes garbage that later throws on a worker read.
	if (url.pathname === "/api/settings/mode-models") {
		const repo = url.searchParams.get("repo") || options.repo
		if (!repo) {
			res.writeHead(400, { "content-type": "application/json; charset=utf-8" }).end(
				JSON.stringify({ error: "missing repo — pass ?repo=<path> or start the dashboard with --repo" }),
			)
			return
		}
		if (req.method === "GET") {
			try {
				// Reuse the strict loader: a malformed on-disk file surfaces as
				// an error here instead of a silently-empty settings page.
				const file = loadModeModelsFile(repo)
				res.writeHead(200, { "content-type": "application/json; charset=utf-8" }).end(
					JSON.stringify(file ?? {}),
				)
			} catch (error) {
				res
					.writeHead(500, { "content-type": "application/json; charset=utf-8" })
					.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }))
			}
			return
		}
		if (req.method === "POST") {
			try {
				const raw = await readJsonBody(req)
				let body: unknown
				try {
					body = JSON.parse(raw)
				} catch (err) {
					res
						.writeHead(400, { "content-type": "application/json; charset=utf-8" })
						.end(JSON.stringify({ error: `invalid JSON body: ${err instanceof Error ? err.message : String(err)}` }))
					return
				}
				// Same strict validation the config loader applies on read.
				try {
					validateModeModelsBody(body)
				} catch (err) {
					res
						.writeHead(400, { "content-type": "application/json; charset=utf-8" })
						.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }))
					return
				}
				const file = path.join(repo, MODE_MODELS_CONFIG_FILE)
				await fsp.mkdir(path.dirname(file), { recursive: true })
				await fsp.writeFile(file, stringifyModeModelsFile(body as ModeModelsFile), "utf-8")
				res
					.writeHead(200, { "content-type": "application/json; charset=utf-8" })
					.end(JSON.stringify({ ok: true, path: file }))
			} catch (error) {
				res
					.writeHead(500, { "content-type": "application/json; charset=utf-8" })
					.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }))
			}
			return
		}
		res.writeHead(405, { "content-type": "text/plain" }).end("Method Not Allowed")
		return
	}

	if (req.method !== "GET") {
		res.writeHead(405, { "content-type": "text/plain" }).end("Method Not Allowed")
		return
	}

	if (url.pathname === "/") {
		const html = renderPage()
		res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(html)
		return
	}

	if (url.pathname === "/api/summary") {
		try {
			const summary = await buildSummary(options.repo)
			res.writeHead(200, { "content-type": "application/json; charset=utf-8" }).end(JSON.stringify(summary))
		} catch (error) {
			res
				.writeHead(500, { "content-type": "application/json; charset=utf-8" })
				.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }))
		}
		return
	}

	res.writeHead(404, { "content-type": "text/plain" }).end("Not Found")
}

/** Read a request body as text (bounded — settings payloads are tiny). */
async function readJsonBody(req: http.IncomingMessage): Promise<string> {
	const chunks: Buffer[] = []
	for await (const chunk of req) {
		chunks.push(chunk as Buffer)
		if (chunks.reduce((n, c) => n + c.length, 0) > 1_000_000) {
			throw new Error("request body too large (limit 1MB)")
		}
	}
	return Buffer.concat(chunks).toString("utf-8")
}
