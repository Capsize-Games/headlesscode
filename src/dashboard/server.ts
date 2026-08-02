/**
 * Cost/token dashboard — plain `node:http` server (workstream 3) + live
 * per-session events + pause/resume control (live worker monitoring) +
 * per-mode model settings (mode-model-assignment) + browser control-plane
 * (session launch + answer) + checkpoint list/diff/restore.
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
 *   POST /api/session/start       launch a detached top-level session (see src/dashboard/session-launch.ts)
 *   POST /api/session/:id/answer  write `.harness.decision-answer` to unblock an escalated question
 *   GET  /api/modes?repo=<path>   merged available modes (.roomodes + global) for the mode selector
 *   GET  /api/checkpoints?repo=<path>&session=<taskId>
 *                                 list checkpoints for a session (CheckpointService.list())
 *   GET  /api/checkpoints/diff?repo=<path>&session=<taskId>&from=<hash>&to=<hash?>
 *                                 diff between two checkpoints, or a checkpoint vs. the
 *                                 current working tree when `to` is omitted
 *   POST /api/checkpoints/restore?repo=<path>&session=<taskId>   body {hash} — restores
 *                                 a checkpoint onto the REAL workspace (destructive;
 *                                 gated by the same optional bearer token as
 *                                 /api/session/* POSTs — see below)
 *   GET  /api/files?repo=<path>&dir=<rel>        list a workspace directory (file browser)
 *   GET  /api/files/content?repo=<path>&file=<rel>  single file's text content (capped/binary-safe)
 *   GET  /api/settings/permissions?repo=<path>  current permissions.json + resolved defaults
 *   POST /api/settings/permissions?repo=<path>  validate + write permissions.json (creates .headlesscode/)
 *
 * NOTE (control plane): the POST /api/session/start route can launch real,
 * billed work and run arbitrary shell via `gh`/`orchestrate` from a form
 * POST — a bigger step across the read-only-to-control line than the
 * pause/resume or settings POSTs were individually. POST
 * /api/checkpoints/restore is MORE dangerous still: it reverts REAL
 * workspace files (the shadow repo's core.worktree). Both are local-only /
 * no-auth by default (binds 127.0.0.1), but if these endpoints are ever
 * exposed beyond localhost, that assumption needs revisiting — the restore
 * endpoint in particular MUST stay behind the optional bearer-token gate
 * when one is configured.
 * pause/resume or settings POSTs were individually. Still local-only /
 * no-auth (binds 127.0.0.1), but if this endpoint is ever exposed beyond
 * localhost, that assumption needs revisiting — no auth was added here.
 *
 * NOTE (permissions settings): POST /api/settings/permissions is covered by
 * the same optional bearer-token gate as /api/session/* when a token IS
 * configured. When it isn't, this route is (deliberately) no-auth like
 * everything else — the whole dashboard binds 127.0.0.1 only and is
 * documented as a local-only tool. A separate default-on auth for just this
 * route was considered and rejected: it would be the ONLY endpoint with a
 * different default, surprising anyone running the established local
 * workflow, and the binding/localhost contract is the actual security
 * boundary (a real auth system is a separate, deliberate project-owner
 * decision — see DashboardServerOptions.token). The one thing that is NOT
 * negotiable is that when the gate IS configured, this route is inside it —
 * a weakened permissions file is more consequential than starting a session,
 * so it must never be gated *less* strictly than the session routes.
 */

import * as fsp from "node:fs/promises"
import * as http from "node:http"
import * as path from "node:path"

import { buildSummary, findSessionEventsFile, readSessionEvents } from "./aggregate.js"
import { diffCheckpoints, listCheckpoints, renderUnifiedDiff, restoreCheckpoint } from "./checkpoints.js"
import { renderPage } from "./page.js"
import { answerSessionDecision, launchSession, validateSessionStartBody } from "./session-launch.js"
import { loadCustomModes } from "../engine/prompt.js"
import {
	MODE_MODELS_CONFIG_FILE,
	loadModeModelsFile,
	stringifyModeModelsFile,
	validateModeModelsBody,
	type ModeModelsFile,
} from "../config/mode-models.js"
import { listWorkspaceDir, readWorkspaceFile } from "./files.js"
import {
	PERMISSIONS_CONFIG_FILE,
	loadPermissionsFile,
	parsePermissionsFileBody,
	resolvePermissions,
	stringifyPermissionsFile,
	type PermissionsFile,
} from "../permissions/config.js"
import { PathTraversalError } from "../tools/executor.js"

/** Default dashboard port (overridable via --port or $HEADLESSCODE_DASHBOARD_PORT). */
export const DEFAULT_DASHBOARD_PORT = 4390

export interface DashboardServerOptions {
	port: number
	/** Repo root to scan for usage files + .orchestrator-state.json (optional). */
	repo?: string
	/**
	 * Optional control-plane bearer token. When set, POST routes under
	 * /api/session/* require `Authorization: Bearer <token>`. Unset (default)
	 * = today's behavior: no auth at all. Deliberately optional — a real auth
	 * system is a separate, deliberate project-owner decision (see the header
	 * note); this is a cheap hook, not a substitute.
	 */
	token?: string
	/**
	 * CLI invocation for POST /api/session/start (default "npx tsx src/cli.ts").
	 * Test-only injection point so the HTTP layer can be exercised against a
	 * tiny fake script instead of the real CLI; not a public config surface.
	 */
	cli?: string
	/** Directory the launched CLI runs in (default: process.cwd()). Test-only. */
	repoRoot?: string
	/**
	 * Shadow-git storage root for the /api/checkpoints/* routes (default:
	 * `~/.headlesscode/checkpoints` — the same default the CLI/engine use).
	 * Test-only injection so the routes can be exercised against a temp dir
	 * instead of the developer's home directory; not a public config surface.
	 */
	checkpointDir?: string
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

	// Optional control-plane token (HEADLESSCODE_DASHBOARD_TOKEN — see
	// DashboardServerOptions.token). When configured, every state-changing
	// POST requires the bearer header: /api/session/* (start/pause/resume/
	// answer), the destructive POST /api/checkpoints/restore (reverts real
	// workspace files — never gated looser than the session routes), and
	// POST /api/settings/permissions (a weakened permissions file is more
	// consequential than starting a session — same gate). Unset = no auth,
	// exactly today's behavior.
	if (
		options.token &&
		req.method === "POST" &&
		(url.pathname.startsWith("/api/session/") ||
			url.pathname === "/api/checkpoints/restore" ||
			url.pathname === "/api/settings/permissions")
	) {
		const auth = req.headers.authorization ?? ""
		const expected = `Bearer ${options.token}`
		if (auth !== expected) {
			res.writeHead(401, { "content-type": "application/json; charset=utf-8" }).end(
				JSON.stringify({ error: "unauthorized — set Authorization: Bearer <token>" }),
			)
			return
		}
	}

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

	// Launch a top-level session (browser control plane): POST /api/session/start
	// spawns a detached `npx tsx src/cli.ts --task ... --mode ... --workspace ...`
	// background process (see src/dashboard/session-launch.ts) and returns the
	// new session's id immediately, so the browser can open its live event view
	// before the first event exists. repo defaults to the dashboard's --repo;
	// mode defaults to multi-agent-orchestrator-headless.
	if (url.pathname === "/api/session/start" && req.method !== "POST") {
		res.writeHead(405, { "content-type": "text/plain" }).end("Method Not Allowed")
		return
	}
	if (url.pathname === "/api/session/start" && req.method === "POST") {
		try {
			const raw = await readJsonBody(req)
			let body: unknown
			try {
				body = JSON.parse(raw || "{}")
			} catch (err) {
				res
					.writeHead(400, { "content-type": "application/json; charset=utf-8" })
					.end(JSON.stringify({ error: `invalid JSON body: ${err instanceof Error ? err.message : String(err)}` }))
				return
			}
			const validationError = validateSessionStartBody(body)
			if (validationError) {
				res
					.writeHead(400, { "content-type": "application/json; charset=utf-8" })
					.end(JSON.stringify({ error: validationError }))
				return
			}
			const start = body as { task: string; repo?: string; mode?: string }
			const repo = start.repo?.trim() || options.repo
			if (!repo) {
				res
					.writeHead(400, { "content-type": "application/json; charset=utf-8" })
					.end(
						JSON.stringify({
							error: "missing repo — pass 'repo' in the body or start the dashboard with --repo",
						}),
					)
				return
			}
			const launched = await launchSession({
				workspace: repo,
				task: start.task,
				mode: start.mode,
				cli: options.cli,
				repoRoot: options.repoRoot,
			})
			res.writeHead(200, { "content-type": "application/json; charset=utf-8" }).end(JSON.stringify(launched))
		} catch (error) {
			res
				.writeHead(500, { "content-type": "application/json; charset=utf-8" })
				.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }))
		}
		return
	}

	// Answer a blocked session's escalated question (browser control plane):
	// POST /api/session/:id/answer writes `.harness.decision-answer` in the
	// session's workspace root, which ask_followup_question polls for (see
	// src/tools/executor.ts). Works for ANY session — worker or top-level —
	// because the marker mechanism doesn't know who answers it.
	const answerMatch = /^\/api\/session\/([^/]+)\/answer$/.exec(url.pathname)
	if (answerMatch && req.method !== "POST") {
		res.writeHead(405, { "content-type": "text/plain" }).end("Method Not Allowed")
		return
	}
	if (answerMatch && req.method === "POST") {
		const sessionId = decodeURIComponent(answerMatch[1])
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
			const raw = await readJsonBody(req)
			let body: unknown
			try {
				body = JSON.parse(raw || "{}")
			} catch (err) {
				res
					.writeHead(400, { "content-type": "application/json; charset=utf-8" })
					.end(JSON.stringify({ error: `invalid JSON body: ${err instanceof Error ? err.message : String(err)}` }))
				return
			}
			const answer = (body as { answer?: unknown })?.answer
			if (typeof answer !== "string" || answer.trim() === "") {
				res
					.writeHead(400, { "content-type": "application/json; charset=utf-8" })
					.end(JSON.stringify({ error: "missing or empty 'answer' — provide the answer text to unblock the session" }))
				return
			}
			// The marker lives in the worktree that owns the session's events
			// feed (same resolution pause/resume uses above).
			const worktreeRoot = found.source === "." ? path.resolve(repo) : path.resolve(repo, found.source)
			await answerSessionDecision(worktreeRoot, answer.trim())
			res.writeHead(200, { "content-type": "application/json; charset=utf-8" }).end(
				JSON.stringify({ sessionId, ok: true, worktree: found.source }),
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

	// Checkpoints — browser control plane. `repo` is the workspace whose
	// files the shadow git repo tracks (the dashboard's --repo); `session` is
	// the session/task id (HeadlessSession uses its sessionId as the
	// checkpoint taskId — see src/engine/loop.ts). list/diff wrap the
	// existing CheckpointService (src/checkpoints/service.ts) read-only;
	// restore is the one DESTRUCTIVE action this dashboard can perform and is
	// gated by the optional bearer token above (same gate as /api/session/*
	// POSTs — never looser).
	if (url.pathname === "/api/checkpoints" || url.pathname === "/api/checkpoints/diff") {
		const repo = url.searchParams.get("repo") || options.repo
		const session = url.searchParams.get("session")
		if (!repo || !session) {
			res.writeHead(400, { "content-type": "application/json; charset=utf-8" }).end(
				JSON.stringify({ error: "missing repo or session — pass ?repo=<path>&session=<taskId>" }),
			)
			return
		}
		const routeOptions = { workspaceRoot: repo, sessionId: session, checkpointDir: options.checkpointDir }
		try {
			if (url.pathname === "/api/checkpoints") {
				const entries = await listCheckpoints(routeOptions)
				res.writeHead(200, { "content-type": "application/json; charset=utf-8" }).end(JSON.stringify({ entries }))
			} else {
				const from = url.searchParams.get("from")
				if (!from) {
					res.writeHead(400, { "content-type": "application/json; charset=utf-8" }).end(
						JSON.stringify({ error: "missing from — pass ?from=<hash> (optional &to=<hash>)" }),
					)
					return
				}
				const to = url.searchParams.get("to") ?? undefined
				const changes = await diffCheckpoints(routeOptions, from, to)
				res.writeHead(200, { "content-type": "application/json; charset=utf-8" }).end(
					JSON.stringify({ diff: renderUnifiedDiff(changes), changes }),
				)
			}
		} catch (error) {
			res
				.writeHead(500, { "content-type": "application/json; charset=utf-8" })
				.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }))
		}
		return
	}

	// File browser (dashboard-file-browser-and-permissions-ui): GET
	// /api/files?repo=<path>&dir=<rel> lists a workspace directory's entries.
	// The path-safety guard (resolveWithinWorkspace + PathTraversalError) is
	// applied inside src/dashboard/files.ts — a traversal attempt surfaces as
	// a 400, never a file-system read outside the workspace.
	if (url.pathname === "/api/files" && req.method === "GET") {
		const repo = url.searchParams.get("repo") || options.repo
		if (!repo) {
			res.writeHead(400, { "content-type": "application/json; charset=utf-8" }).end(
				JSON.stringify({ error: "missing repo — pass ?repo=<path> or start the dashboard with --repo" }),
			)
			return
		}
		const dir = url.searchParams.get("dir") || "."
		try {
			const entries = await listWorkspaceDir(repo, dir)
			res.writeHead(200, { "content-type": "application/json; charset=utf-8" }).end(JSON.stringify({ dir, entries }))
		} catch (error) {
			if (error instanceof PathTraversalError) {
				res
					.writeHead(400, { "content-type": "application/json; charset=utf-8" })
					.end(JSON.stringify({ error: error.message }))
				return
			}
			res
				.writeHead(500, { "content-type": "application/json; charset=utf-8" })
				.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }))
		}
		return
	}

	// Restore a checkpoint — DESTRUCTIVE (reverts REAL workspace files).
	// POST-only (a state-changing action must not be triggerable by a GET),
	// body {hash}, gated by the optional bearer token above.
	if (url.pathname === "/api/checkpoints/restore" && req.method !== "POST") {
		res.writeHead(405, { "content-type": "text/plain" }).end("Method Not Allowed")
		return
	}
	if (url.pathname === "/api/checkpoints/restore" && req.method === "POST") {
		const repo = url.searchParams.get("repo") || options.repo
		const session = url.searchParams.get("session")
		if (!repo || !session) {
			res.writeHead(400, { "content-type": "application/json; charset=utf-8" }).end(
				JSON.stringify({ error: "missing repo or session — pass ?repo=<path>&session=<taskId>" }),
			)
			return
		}
		try {
			const raw = await readJsonBody(req)
			let body: unknown
			try {
				body = JSON.parse(raw || "{}")
			} catch (err) {
				res
					.writeHead(400, { "content-type": "application/json; charset=utf-8" })
					.end(JSON.stringify({ error: `invalid JSON body: ${err instanceof Error ? err.message : String(err)}` }))
				return
			}
			const hash = (body as { hash?: unknown })?.hash
			if (typeof hash !== "string" || hash.trim() === "") {
				res
					.writeHead(400, { "content-type": "application/json; charset=utf-8" })
					.end(JSON.stringify({ error: "missing or empty 'hash' — provide the checkpoint hash to restore" }))
				return
			}
			await restoreCheckpoint(
				{ workspaceRoot: repo, sessionId: session, checkpointDir: options.checkpointDir },
				hash.trim(),
			)
			res.writeHead(200, { "content-type": "application/json; charset=utf-8" }).end(
				JSON.stringify({ ok: true, restored: hash.trim() }),
			)
		} catch (error) {
			res
				.writeHead(500, { "content-type": "application/json; charset=utf-8" })
				.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }))
		}
		return
	}
	// GET /api/files/content?repo=<path>&file=<rel> — one file's text content,
	// capped/binary-safe (see src/dashboard/files.ts). Same traversal guard.
	if (url.pathname === "/api/files/content" && req.method === "GET") {
		const repo = url.searchParams.get("repo") || options.repo
		if (!repo) {
			res.writeHead(400, { "content-type": "application/json; charset=utf-8" }).end(
				JSON.stringify({ error: "missing repo — pass ?repo=<path> or start the dashboard with --repo" }),
			)
			return
		}
		const file = url.searchParams.get("file")
		if (!file) {
			res.writeHead(400, { "content-type": "application/json; charset=utf-8" }).end(
				JSON.stringify({ error: "missing file — pass ?file=<relative-path>" }),
			)
			return
		}
		try {
			const result = await readWorkspaceFile(repo, file)
			res.writeHead(200, { "content-type": "application/json; charset=utf-8" }).end(JSON.stringify({ file, ...result }))
		} catch (error) {
			if (error instanceof PathTraversalError) {
				res
					.writeHead(400, { "content-type": "application/json; charset=utf-8" })
					.end(JSON.stringify({ error: error.message }))
				return
			}
			res
				.writeHead(500, { "content-type": "application/json; charset=utf-8" })
				.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }))
		}
		return
	}

	// Permissions settings (dashboard-file-browser-and-permissions-ui): GET
	// /api/settings/permissions?repo=<path> returns the current
	// .headlesscode/permissions.json content OR the resolved built-in defaults
	// clearly labeled as defaults-not-yet-customized (mirroring the
	// mode-models page's "no file yet" UX, plus the resolved view so the page
	// always shows what a session would actually enforce). POST validates with
	// the SAME parser the config loader uses (parsePermissionsFileBody — no
	// second validator that could drift) and writes the file. POST is covered
	// by the optional bearer-token gate above.
	if (url.pathname === "/api/settings/permissions") {
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
				const file = loadPermissionsFile(repo)
				const resolved = resolvePermissions({ workspaceRoot: repo })
				res.writeHead(200, { "content-type": "application/json; charset=utf-8" }).end(
					JSON.stringify({ file, resolved, isDefault: file === null }),
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
				// Same strict validation the config loader applies on read —
				// parsePermissionsFileBody IS the loader's validator, so the
				// save path can never drift from what the CLI/env path enforces.
				let parsed: PermissionsFile
				try {
					parsed = parsePermissionsFileBody(body, "body")
				} catch (err) {
					res
						.writeHead(400, { "content-type": "application/json; charset=utf-8" })
						.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }))
					return
				}
				const file = path.join(repo, PERMISSIONS_CONFIG_FILE)
				await fsp.mkdir(path.dirname(file), { recursive: true })
				await fsp.writeFile(file, stringifyPermissionsFile(parsed), "utf-8")
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
		const html = renderPage(options.repo)
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

	// Available modes for the "start a session" mode selector: the project's
	// own .roomodes merged with global ~/.roo/custom_modes.yaml (same loader
	// the CLI uses — see src/engine/prompt.ts). The selector falls back to a
	// plain text input when this is unavailable, so a failure here is a
	// non-fatal degradation, not an error page.
	if (url.pathname === "/api/modes") {
		const repo = url.searchParams.get("repo") || options.repo
		if (!repo) {
			res.writeHead(400, { "content-type": "application/json; charset=utf-8" }).end(
				JSON.stringify({ error: "missing repo — pass ?repo=<path> or start the dashboard with --repo" }),
			)
			return
		}
		try {
			const customModes = await loadCustomModes(repo)
			const modes = customModes.map((m) => ({ slug: m.slug, name: m.name ?? m.slug, source: m.source ?? "unknown" }))
			res.writeHead(200, { "content-type": "application/json; charset=utf-8" }).end(JSON.stringify({ modes }))
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
