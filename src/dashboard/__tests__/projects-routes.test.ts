/**
 * Tests for the dashboard's central-store project registry route
 * (src/dashboard/server.ts — plans/project-registry-and-store-cleanup.md):
 * GET /api/projects enumerates the central per-project store via the same
 * listProjectEntries the `headlesscode projects list` CLI uses. The default
 * view shows only registered or still-existing projects; ?all=1 also shows
 * pure stale-unregistered litter (pre-Part-A orphaned dirs).
 *
 * Plain assert-based script (no test framework), run via `npm test`. The
 * store is redirected to a temp dir via $HEADLESSCODE_DATA_DIR — never the
 * real ~/.local/share/headlesscode.
 */

import assert from "node:assert/strict"
import * as fs from "node:fs"
import * as fsp from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import type { Server } from "node:http"

import { startDashboardServer } from "../server.js"

async function mkTmp(prefix: string): Promise<string> {
	return fsp.mkdtemp(path.join(os.tmpdir(), prefix))
}

async function startServer(): Promise<{ server: Server; port: number }> {
	const server = await startDashboardServer({ port: 0 })
	const addr = server.address()
	const port = typeof addr === "object" && addr ? addr.port : 0
	return { server, port }
}

async function get(base: string, urlPath: string): Promise<{ status: number; body: string }> {
	const res = await fetch(base + urlPath)
	const body = await res.text()
	return { status: res.status, body }
}

function writeMeta(dir: string, meta: Record<string, unknown>): void {
	fs.mkdirSync(dir, { recursive: true })
	fs.writeFileSync(path.join(dir, "project.json"), JSON.stringify(meta, null, 2) + "\n", "utf-8")
}

/** Seed the store with the same five shapes the CLI test uses. */
async function seedStore(data: string): Promise<{ existingA: string; existingB: string }> {
	const existingA = await mkTmp("hc-projects-route-existingA-")
	const existingB = await mkTmp("hc-projects-route-existingB-")
	const projects = path.join(data, "projects")
	writeMeta(path.join(projects, "aaaa"), {
		path: existingA,
		kind: "plain",
		firstSeen: "2026-08-01T00:00:00.000Z",
		lastSeen: "2026-08-17T10:00:00.000Z",
		registered: true,
	})
	writeMeta(path.join(projects, "bbbb"), {
		path: existingB,
		kind: "plain",
		firstSeen: "2026-08-02T00:00:00.000Z",
		lastSeen: "2026-08-17T09:00:00.000Z",
		registered: false,
	})
	writeMeta(path.join(projects, "cccc"), {
		path: path.join(data, "gone-registered"),
		kind: "git",
		firstSeen: "2026-08-03T00:00:00.000Z",
		lastSeen: "2026-08-16T00:00:00.000Z",
		registered: true,
	})
	writeMeta(path.join(projects, "dddd"), {
		path: path.join(data, "gone-unregistered"),
		kind: "git",
		firstSeen: "2026-08-04T00:00:00.000Z",
		lastSeen: "2026-08-15T00:00:00.000Z",
		registered: false,
	})
	fs.mkdirSync(path.join(projects, "eeee"), { recursive: true })
	return { existingA, existingB }
}

async function testDefaultViewHidesStaleUnregisteredLitter(): Promise<void> {
	const data = await mkTmp("hc-projects-route-data-")
	const { existingA, existingB } = await seedStore(data)
	process.env.HEADLESSCODE_DATA_DIR = data
	try {
		const { server, port } = await startServer()
		try {
			const res = await get(`http://127.0.0.1:${port}`, "/api/projects")
			assert.equal(res.status, 200)
			const body = JSON.parse(res.body) as { projects: Array<{ key: string; registered: boolean; exists: boolean }> }
			const keys = body.projects.map((e) => e.key).sort()
			assert.deepEqual(
				keys,
				["aaaa", "bbbb", "cccc"],
				"default view = registered or still-existing (hides unregistered-missing + no-project.json litter)",
			)
			const aaaa = body.projects.find((e) => e.key === "aaaa")
			assert.ok(aaaa && aaaa.registered && aaaa.exists)
		} finally {
			server.close()
		}
	} finally {
		delete process.env.HEADLESSCODE_DATA_DIR
		await fsp.rm(data, { recursive: true, force: true })
		await fsp.rm(existingA, { recursive: true, force: true })
		await fsp.rm(existingB, { recursive: true, force: true })
	}
}

async function testAllViewShowsEverything(): Promise<void> {
	const data = await mkTmp("hc-projects-route-data2-")
	const { existingA, existingB } = await seedStore(data)
	process.env.HEADLESSCODE_DATA_DIR = data
	try {
		const { server, port } = await startServer()
		try {
			const res = await get(`http://127.0.0.1:${port}`, "/api/projects?all=1")
			assert.equal(res.status, 200)
			const body = JSON.parse(res.body) as { projects: Array<{ key: string; registered: boolean; exists: boolean }> }
			const keys = body.projects.map((e) => e.key).sort()
			assert.deepEqual(keys, ["aaaa", "bbbb", "cccc", "dddd", "eeee"], "?all=1 shows the pure litter too")
			const eeee = body.projects.find((e) => e.key === "eeee")
			assert.ok(eeee && !eeee.registered && !eeee.exists, "no-project.json dir surfaces as an unregistered, non-existent entry")
		} finally {
			server.close()
		}
	} finally {
		delete process.env.HEADLESSCODE_DATA_DIR
		await fsp.rm(data, { recursive: true, force: true })
		await fsp.rm(existingA, { recursive: true, force: true })
		await fsp.rm(existingB, { recursive: true, force: true })
	}
}

async function testEmptyStoreReturnsEmptyArray(): Promise<void> {
	const data = await mkTmp("hc-projects-route-data3-")
	process.env.HEADLESSCODE_DATA_DIR = data
	try {
		const { server, port } = await startServer()
		try {
			const res = await get(`http://127.0.0.1:${port}`, "/api/projects")
			assert.equal(res.status, 200)
			const body = JSON.parse(res.body) as { projects: unknown[] }
			assert.deepEqual(body.projects, [], "empty store → empty projects array, never an error")
		} finally {
			server.close()
		}
	} finally {
		delete process.env.HEADLESSCODE_DATA_DIR
		await fsp.rm(data, { recursive: true, force: true })
	}
}


async function testGitOwnerNameDerivedFromOrigin(): Promise<void> {
	// Seed a temp GIT repo with an SSH origin, register it in the store,
	// and assert GET /api/projects surfaces the derived owner/name.
	const data = await mkTmp("hc-projects-route-git-")
	const repoDir = await mkTmp("hc-projects-route-gitrepo-")
	try {
		// Minimal git repo with an origin remote (no commits needed).
		const { execFileSync } = await import("node:child_process")
		execFileSync("git", ["init", "-q", repoDir])
		execFileSync("git", ["-C", repoDir, "remote", "add", "origin", "git@github.com:example-org/example-repo.git"])

		const projects = path.join(data, "projects")
		writeMeta(path.join(projects, "gitproj"), {
			path: repoDir,
			kind: "git",
			firstSeen: "2026-08-05T00:00:00.000Z",
			lastSeen: "2026-08-17T10:00:00.000Z",
			registered: true,
		})

		process.env.HEADLESSCODE_DATA_DIR = data
		try {
			const { server, port } = await startServer()
			try {
				const res = await get(`http://127.0.0.1:${port}`, "/api/projects")
				assert.equal(res.status, 200)
				const body = JSON.parse(res.body) as { projects: Array<{ key: string; gitOwnerName: string }> }
				const entry = body.projects.find((e) => e.key === "gitproj")
				assert.ok(entry, "registered git project is listed")
				assert.equal(entry.gitOwnerName, "example-org/example-repo", "gitOwnerName derived from origin remote")
			} finally {
				server.close()
			}
		} finally {
			delete process.env.HEADLESSCODE_DATA_DIR
		}
	} finally {
		await fsp.rm(data, { recursive: true, force: true })
		await fsp.rm(repoDir, { recursive: true, force: true })
	}
}

const tests: Array<[string, () => Promise<void>]> = [
	["GET /api/projects: default view hides stale-unregistered litter", testDefaultViewHidesStaleUnregisteredLitter],
	["GET /api/projects?all=1: shows every entry including no-project.json dirs", testAllViewShowsEverything],
	["GET /api/projects: empty store returns an empty array", testEmptyStoreReturnsEmptyArray],
	["GET /api/projects: gitOwnerName derived from origin remote", testGitOwnerNameDerivedFromOrigin],
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
	console.log(`\nAll ${tests.length} projects-route tests passed`)
}

main().catch((err) => {
	console.error("Test runner crashed:", err)
	process.exit(1)
})
