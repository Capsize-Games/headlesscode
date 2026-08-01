/**
 * Cost/token dashboard — plain `node:http` server (workstream 3).
 *
 * ZERO new UI/framework dependencies, matching this project's established
 * "plain fs + JSON, no schema library" ethos (see `src/orchestrator/state.ts`'s
 * own file-header comment). Bound to `127.0.0.1` only, no auth — explicitly a
 * local-only tool per the plan doc.
 *
 *   GET /             the static HTML page (src/dashboard/page.ts)
 *   GET /api/summary  JSON from src/dashboard/aggregate.ts's buildSummary()
 */

import * as http from "node:http"

import { buildSummary } from "./aggregate.js"
import { renderPage } from "./page.js"

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
