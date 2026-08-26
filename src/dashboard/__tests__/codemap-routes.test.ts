/**
 * Tests for the dashboard's codemap routes (src/dashboard/server.ts +
 * src/dashboard/codemap.ts — issue #17): GET /api/codemap?repo=<path> serves
 * the stored codemap.json and GET /api/codemap/html?repo=<path> serves the
 * self-contained visualizer, both from the central per-project store; a repo
 * with no generated map is a clear 404; a missing ?repo= is a 400.
 *
 * Plain assert-based script (no test framework), run via `npm test`.
 */

import assert from "node:assert/strict"
import * as fsp from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import type { Server } from "node:http"

import { startDashboardServer } from "../server.js"
import { buildCodemap } from "../../codemap/build.js"
import { resetCodeIntelCaches } from "../../codeintel/program.js"

async function tmpRepo(prefix = "hc-codemap-route-"): Promise<string> {
	const ws = await fsp.mkdtemp(path.join(os.tmpdir(), prefix))
	await fsp.mkdir(path.join(ws, "src"), { recursive: true })
	await fsp.writeFile(
		path.join(ws, "tsconfig.json"),
		JSON.stringify({ compilerOptions: { moduleResolution: "bundler" }, include: ["src"] }, null, 2),
	)
	await fsp.writeFile(path.join(ws, "src", "a.ts"), `import { b } from "./b.js"\nexport const a = 1\n`)
	await fsp.writeFile(path.join(ws, "src", "b.ts"), `export const b = 2\n`)
	return ws
}

async function startServer(repo?: string): Promise<{ server: Server; port: number }> {
	const server = await startDashboardServer({ port: 0, repo })
	const addr = server.address()
	const port = typeof addr === "object" && addr ? addr.port : 0
	return { server, port }
}

async function get(base: string, urlPath: string): Promise<{ status: number; body: string; contentType?: string }> {
	const res = await fetch(base + urlPath)
	const body = await res.text()
	return { status: res.status, body, contentType: res.headers.get("content-type") ?? undefined }
}

async function testServesCodemapJson(): Promise<void> {
	const repo = await tmpRepo()
	try {
		resetCodeIntelCaches()
		const built = await buildCodemap({ workspaceRoot: repo })
		assert.equal(built.changed, true)

		const { server, port } = await startServer()
		try {
			const base = `http://127.0.0.1:${port}`
			const res = await get(base, `/api/codemap?repo=${encodeURIComponent(repo)}`)
			assert.equal(res.status, 200)
			assert.match(res.contentType ?? "", /application\/json/)
			const data = JSON.parse(res.body) as { project: string; modules: unknown[]; edges: unknown[]; fingerprint: string }
			assert.equal(data.project, path.basename(repo))
			assert.ok(Array.isArray(data.modules) && data.modules.length >= 2)
			assert.ok(Array.isArray(data.edges))
			assert.ok(data.fingerprint.length === 64)
		} finally {
			server.close()
		}
	} finally {
		await fsp.rm(repo, { recursive: true, force: true })
	}
}

async function testServesCodemapHtml(): Promise<void> {
	const repo = await tmpRepo()
	try {
		resetCodeIntelCaches()
		await buildCodemap({ workspaceRoot: repo })

		const { server, port } = await startServer()
		try {
			const res = await get(`http://127.0.0.1:${port}`, `/api/codemap/html?repo=${encodeURIComponent(repo)}`)
			assert.equal(res.status, 200)
			assert.match(res.contentType ?? "", /text\/html/)
			assert.ok(res.body.includes("<!DOCTYPE html>"), "serves the full html document")
			assert.ok(res.body.includes('id="search"'))
		} finally {
			server.close()
		}
	} finally {
		await fsp.rm(repo, { recursive: true, force: true })
	}
}

async function testMissingRepoParamIs400(): Promise<void> {
	const { server, port } = await startServer()
	try {
		const res = await get(`http://127.0.0.1:${port}`, "/api/codemap")
		assert.equal(res.status, 400)
		const resHtml = await get(`http://127.0.0.1:${port}`, "/api/codemap/html")
		assert.equal(resHtml.status, 400)
	} finally {
		server.close()
	}
}

async function testNoGeneratedMapIsClear404(): Promise<void> {
	const repo = await tmpRepo()
	try {
		const { server, port } = await startServer()
		try {
			const res = await get(`http://127.0.0.1:${port}`, `/api/codemap?repo=${encodeURIComponent(repo)}`)
			assert.equal(res.status, 404)
			const body = JSON.parse(res.body) as { error: string }
			assert.match(body.error, /headlesscode codemap/, "404 tells the user how to generate the map")
		} finally {
			server.close()
		}
	} finally {
		await fsp.rm(repo, { recursive: true, force: true })
	}
}

async function main(): Promise<void> {
	const tests: Array<[string, () => Promise<void>]> = [
		["GET /api/codemap?repo= serves the stored codemap.json", testServesCodemapJson],
		["GET /api/codemap/html?repo= serves the visualizer", testServesCodemapHtml],
		["missing ?repo= is a 400", testMissingRepoParamIs400],
		["a repo with no generated map is a clear 404", testNoGeneratedMapIsClear404],
	]

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
	console.log(`\nAll ${tests.length} codemap dashboard-route tests passed`)
}

main().catch((err) => {
	console.error("Test runner crashed:", err)
	process.exit(1)
})
