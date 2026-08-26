/**
 * Tests for the dashboard checkpoint routes (src/dashboard/server.ts +
 * src/dashboard/checkpoints.ts): GET /api/checkpoints, GET
 * /api/checkpoints/diff, POST /api/checkpoints/restore against a REAL
 * CheckpointService backed by a temp shadow-git repo (mirroring how
 * src/checkpoints/__tests__/service.test.ts sets up its fixtures — real git,
 * no mocking).
 *
 * Plain assert-based script (no test framework), run via `npm test` ->
 * `tsx src/dashboard/__tests__/checkpoints-routes.test.ts`.
 *
 * Covers:
 *   - list: returns the session's checkpoints oldest-first (message + date).
 *   - diff: between a checkpoint and the current working tree.
 *   - restore: reverts a real file THROUGH THE HTTP ROUTE (create checkpoint,
 *     modify file, POST restore, assert file content is back).
 *   - restore requires the optional bearer token when configured (same gate
 *     as /api/session/* POSTs — never looser).
 *   - validation: missing repo/session, missing hash, non-POST methods.
 */

import assert from "node:assert/strict"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"

import { startDashboardServer } from "../server.js"
import type { Server } from "node:http"
import { createCheckpointService } from "../../checkpoints/service.js"

async function tmpRepo(prefix = "hc-ckpt-routes-"): Promise<string> {
	return fs.mkdtemp(path.join(os.tmpdir(), prefix))
}

/**
 * Checkpoint dirs must live OUTSIDE the workspace they track (see
 * src/checkpoints/service.ts's file header) — same rule the service test
 * follows, using its own tmp dir instead of ~/.headlesscode/checkpoints.
 */
async function tmpCheckpointDir(): Promise<string> {
	return fs.mkdtemp(path.join(os.tmpdir(), "hc-ckpt-routes-shadow-"))
}

async function startServer(repo: string, checkpointDir: string, token?: string): Promise<{ server: Server; port: number }> {
	const server = await startDashboardServer({
		port: 0,
		repo,
		...(checkpointDir ? { checkpointDir } : {}),
		...(token ? { token } : {}),
	})
	const addr = server.address()
	const port = typeof addr === "object" && addr ? addr.port : 0
	return { server, port }
}

/** Seed a real shadow-git repo with a baseline checkpoint + one tracked file. */
async function seedService(workspace: string, checkpointDir: string, taskId: string): Promise<{ baselineHash: string }> {
	await fs.writeFile(path.join(workspace, "a.txt"), "original\n")
	const svc = createCheckpointService({ taskId, workspaceRoot: workspace, checkpointDir })
	await svc.init()
	const entries = await svc.list()
	return { baselineHash: entries[0].hash }
}

async function postJson(
	base: string,
	urlPath: string,
	payload: unknown,
	token?: string,
): Promise<{ status: number; body: unknown }> {
	const headers: Record<string, string> = { "content-type": "application/json" }
	if (token) headers.authorization = `Bearer ${token}`
	const res = await fetch(base + urlPath, { method: "POST", headers, body: JSON.stringify(payload) })
	const text = await res.text()
	let body: unknown
	try {
		body = JSON.parse(text)
	} catch {
		body = text
	}
	return { status: res.status, body }
}

async function getJson(base: string, urlPath: string, token?: string): Promise<{ status: number; body: unknown }> {
	const headers: Record<string, string> = {}
	if (token) headers.authorization = `Bearer ${token}`
	const res = await fetch(base + urlPath, { headers })
	const text = await res.text()
	let body: unknown
	try {
		body = JSON.parse(text)
	} catch {
		body = text
	}
	return { status: res.status, body }
}

// ─── GET /api/checkpoints ───────────────────────────────────────────────────

async function testListReturnsCheckpointsForSession(): Promise<void> {
	const workspace = await tmpRepo("hc-ckpt-routes-ws-")
	const checkpointDir = await tmpCheckpointDir()
	try {
		const { baselineHash } = await seedService(workspace, checkpointDir, "session-1")
		assert.ok(baselineHash.length > 0)

		const { server, port } = await startServer(workspace, checkpointDir)
		try {
			const { status, body } = await getJson(
				`http://127.0.0.1:${port}`,
				`/api/checkpoints?repo=${encodeURIComponent(workspace)}&session=session-1`,
			)
			assert.equal(status, 200)
			const data = body as { entries: Array<{ hash: string; message: string; date: string }> }
			assert.equal(data.entries.length, 1, "init produces exactly the baseline commit")
			assert.equal(data.entries[0].hash, baselineHash)
			assert.ok(typeof data.entries[0].message === "string" && data.entries[0].message.length > 0)
			assert.ok(!Number.isNaN(Date.parse(data.entries[0].date)), "entry carries a parseable date")
		} finally {
			server.close()
		}
	} finally {
		await fs.rm(workspace, { recursive: true, force: true })
		await fs.rm(checkpointDir, { recursive: true, force: true })
	}
}

async function testListRequiresRepoAndSession(): Promise<void> {
	const workspace = await tmpRepo("hc-ckpt-routes-ws-")
	const checkpointDir = await tmpCheckpointDir()
	try {
		await seedService(workspace, checkpointDir, "session-1")
		const { server, port } = await startServer(workspace, checkpointDir)
		const base = `http://127.0.0.1:${port}`
		try {
			// Missing session.
			const noSession = await getJson(base, `/api/checkpoints?repo=${encodeURIComponent(workspace)}`)
			assert.equal(noSession.status, 400)
			// Missing repo (server started WITHOUT --repo would be a different
			// case; here repo is required even when --repo is set? No — repo
			// falls back to options.repo. With --repo set and session present,
			// repo can be omitted. Assert the session is still required.)
			const withRepoOnly = await getJson(base, `/api/checkpoints?session=session-1`)
			assert.equal(withRepoOnly.status, 200, "repo falls back to the server's --repo")
		} finally {
			server.close()
		}
	} finally {
		await fs.rm(workspace, { recursive: true, force: true })
		await fs.rm(checkpointDir, { recursive: true, force: true })
	}
}

// ─── GET /api/checkpoints/diff ──────────────────────────────────────────────

async function testDiffAgainstWorkingTree(): Promise<void> {
	const workspace = await tmpRepo("hc-ckpt-routes-ws-")
	const checkpointDir = await tmpCheckpointDir()
	try {
		const { baselineHash } = await seedService(workspace, checkpointDir, "session-1")
		// Modify the tracked file AFTER the baseline checkpoint.
		await fs.writeFile(path.join(workspace, "a.txt"), "modified\n")

		const { server, port } = await startServer(workspace, checkpointDir)
		try {
			const { status, body } = await getJson(
				`http://127.0.0.1:${port}`,
				`/api/checkpoints/diff?repo=${encodeURIComponent(workspace)}&session=session-1&from=${baselineHash}`,
			)
			assert.equal(status, 200)
			const data = body as { diff: string; changes: Array<{ paths: { relative: string } }> }
			assert.equal(data.changes.length, 1, "a.txt changed after the baseline")
			assert.equal(data.changes[0].paths.relative, "a.txt")
			assert.match(data.diff, /--- a\/a\.txt/, "unified-diff header for the file")
			assert.match(data.diff, /-original/, "before content marked with -")
			assert.match(data.diff, /\+\s*modified/, "after content marked with +")
		} finally {
			server.close()
		}
	} finally {
		await fs.rm(workspace, { recursive: true, force: true })
		await fs.rm(checkpointDir, { recursive: true, force: true })
	}
}

async function testDiffRequiresFrom(): Promise<void> {
	const workspace = await tmpRepo("hc-ckpt-routes-ws-")
	const checkpointDir = await tmpCheckpointDir()
	try {
		await seedService(workspace, checkpointDir, "session-1")
		const { server, port } = await startServer(workspace, checkpointDir)
		try {
			const { status, body } = await getJson(
				`http://127.0.0.1:${port}`,
				`/api/checkpoints/diff?repo=${encodeURIComponent(workspace)}&session=session-1`,
			)
			assert.equal(status, 400)
			assert.match(String((body as { error?: string }).error ?? ""), /missing from/i)
		} finally {
			server.close()
		}
	} finally {
		await fs.rm(workspace, { recursive: true, force: true })
		await fs.rm(checkpointDir, { recursive: true, force: true })
	}
}

// ─── POST /api/checkpoints/restore ──────────────────────────────────────────

async function testRestoreRevertsFileThroughHttpRoute(): Promise<void> {
	const workspace = await tmpRepo("hc-ckpt-routes-ws-")
	const checkpointDir = await tmpCheckpointDir()
	try {
		const { baselineHash } = await seedService(workspace, checkpointDir, "session-1")
		// Modify the file, then save a checkpoint of the modified state.
		await fs.writeFile(path.join(workspace, "a.txt"), "modified\n")
		const svc = createCheckpointService({ taskId: "session-1", workspaceRoot: workspace, checkpointDir })
		await svc.init()
		const saved = await svc.save("modify a.txt")
		assert.ok(saved?.commit, "modification should produce a checkpoint")
		// Sanity: the file really is modified before restore.
		assert.equal(await fs.readFile(path.join(workspace, "a.txt"), "utf-8"), "modified\n")

		const { server, port } = await startServer(workspace, checkpointDir)
		const base = `http://127.0.0.1:${port}`
		try {
			// Restore back to the BASELINE through the HTTP route.
			const res = await postJson(
				base,
				`/api/checkpoints/restore?repo=${encodeURIComponent(workspace)}&session=session-1`,
				{ hash: baselineHash },
			)
			assert.equal(res.status, 200)
			assert.equal((res.body as { ok: boolean }).ok, true)
			assert.equal((res.body as { restored: string }).restored, baselineHash)

			// The file really reverted.
			assert.equal(await fs.readFile(path.join(workspace, "a.txt"), "utf-8"), "original\n")
		} finally {
			server.close()
		}
	} finally {
		await fs.rm(workspace, { recursive: true, force: true })
		await fs.rm(checkpointDir, { recursive: true, force: true })
	}
}

async function testRestoreRequiresBearerTokenWhenConfigured(): Promise<void> {
	const workspace = await tmpRepo("hc-ckpt-routes-ws-")
	const checkpointDir = await tmpCheckpointDir()
	try {
		const { baselineHash } = await seedService(workspace, checkpointDir, "session-1")
		const { server, port } = await startServer(workspace, checkpointDir, "sekret")
		const base = `http://127.0.0.1:${port}`
		const urlPath = `/api/checkpoints/restore?repo=${encodeURIComponent(workspace)}&session=session-1`
		try {
			// Without the header -> 401, nothing restored.
			const noAuth = await postJson(base, urlPath, { hash: baselineHash })
			assert.equal(noAuth.status, 401)

			// With the wrong token -> 401.
			const badAuth = await postJson(base, urlPath, { hash: baselineHash }, "wrong")
			assert.equal(badAuth.status, 401)

			// With the right token -> 200 (the gate let it through).
			const goodAuth = await postJson(base, urlPath, { hash: baselineHash }, "sekret")
			assert.equal(goodAuth.status, 200)

			// GET routes are gated by the same token too (SEC-7 — a GET route
			// that reads checkpoint data is exactly the DNS-rebinding/localhost
			// -CSRF surface the token exists to close).
			const listNoAuth = await getJson(base, `/api/checkpoints?repo=${encodeURIComponent(workspace)}&session=session-1`)
			assert.equal(listNoAuth.status, 401)
			const listAuthed = await getJson(
				base,
				`/api/checkpoints?repo=${encodeURIComponent(workspace)}&session=session-1`,
				"sekret",
			)
			assert.equal(listAuthed.status, 200)
		} finally {
			server.close()
		}
	} finally {
		await fs.rm(workspace, { recursive: true, force: true })
		await fs.rm(checkpointDir, { recursive: true, force: true })
	}
}

async function testRestoreValidatesBodyAndMethod(): Promise<void> {
	const workspace = await tmpRepo("hc-ckpt-routes-ws-")
	const checkpointDir = await tmpCheckpointDir()
	try {
		const { baselineHash } = await seedService(workspace, checkpointDir, "session-1")
		const { server, port } = await startServer(workspace, checkpointDir)
		const base = `http://127.0.0.1:${port}`
		const urlPath = `/api/checkpoints/restore?repo=${encodeURIComponent(workspace)}&session=session-1`
		try {
			// Missing/empty hash -> 400.
			const noHash = await postJson(base, urlPath, {})
			assert.equal(noHash.status, 400)
			assert.match(String((noHash.body as { error?: string }).error ?? ""), /missing or empty 'hash'/i)

			const emptyHash = await postJson(base, urlPath, { hash: "  " })
			assert.equal(emptyHash.status, 400)

			// Invalid JSON -> 400.
			const badJsonRes = await fetch(base + urlPath, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: "{ not json",
			})
			assert.equal(badJsonRes.status, 400)

			// GET to the restore route -> 405 (a GET must never restore).
			const getRes = await fetch(base + urlPath)
			assert.equal(getRes.status, 405)

			// Restoring to a bogus hash -> 500 (the service throws — git
			// cannot resolve the ref). The key safety property is that it
			// does NOT silently succeed.
			const bogus = await postJson(base, urlPath, { hash: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef" })
			assert.equal(bogus.status, 500)
		} finally {
			server.close()
		}
	} finally {
		await fs.rm(workspace, { recursive: true, force: true })
		await fs.rm(checkpointDir, { recursive: true, force: true })
	}
}

// ─── Runner ──────────────────────────────────────────────────────────────────

const tests: Array<[string, () => Promise<void>]> = [
	["checkpoints: GET /api/checkpoints lists the session's checkpoints oldest-first", testListReturnsCheckpointsForSession],
	["checkpoints: GET /api/checkpoints requires repo+session (repo falls back to --repo)", testListRequiresRepoAndSession],
	["checkpoints: GET /api/checkpoints/diff shows a checkpoint vs working tree", testDiffAgainstWorkingTree],
	["checkpoints: GET /api/checkpoints/diff requires ?from=", testDiffRequiresFrom],
	["checkpoints: POST /api/checkpoints/restore reverts a real file through the HTTP route", testRestoreRevertsFileThroughHttpRoute],
	["checkpoints: POST restore requires the bearer token when configured", testRestoreRequiresBearerTokenWhenConfigured],
	["checkpoints: POST restore validates body + method (400/405/500, never silent)", testRestoreValidatesBodyAndMethod],
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
			console.error(err instanceof Error ? err.stack ?? err.message : String(err))
		}
	}
	if (failed > 0) {
		console.error(`\n${failed} test(s) failed`)
		process.exit(1)
	}
	console.log(`\nAll ${tests.length} dashboard checkpoints-routes tests passed`)
}

main().catch((err) => {
	console.error("Test runner crashed:", err)
	process.exit(1)
})
