/**
 * Tests for the dashboard per-mode model settings endpoints
 * (mode-model-assignment): GET /api/settings/mode-models returns the current
 * file content; POST validates + writes it and a subsequent GET reflects the
 * change; a malformed POST is rejected with a clear error and does NOT corrupt
 * an existing file. Plain assert-based (no framework), run via `npm test` ->
 * `tsx src/dashboard/__tests__/settings.test.ts`.
 */

import assert from "node:assert/strict"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"

import { startDashboardServer } from "../server.js"
import type { Server } from "node:http"
import { modeModelsFilePath } from "../../config/mode-models.js"

async function tmpRepo(prefix = "hc-settings-"): Promise<string> {
	return fs.mkdtemp(path.join(os.tmpdir(), prefix))
}

async function startServer(repo?: string): Promise<{ server: Server; port: number }> {
	const server = await startDashboardServer({ port: 0, ...(repo ? { repo } : {}) })
	const addr = server.address()
	const port = typeof addr === "object" && addr ? addr.port : 0
	return { server, port }
}

function settingsUrl(port: number, repo?: string): string {
	return `http://127.0.0.1:${port}/api/settings/mode-models${repo ? `?repo=${encodeURIComponent(repo)}` : ""}`
}

async function getJson(url: string): Promise<{ status: number; body: unknown }> {
	const res = await fetch(url)
	const text = await res.text()
	let body: unknown
	try {
		body = JSON.parse(text)
	} catch {
		body = text
	}
	return { status: res.status, body }
}

async function postJson(url: string, payload: unknown): Promise<{ status: number; body: unknown }> {
	const res = await fetch(url, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(payload),
	})
	const text = await res.text()
	let body: unknown
	try {
		body = JSON.parse(text)
	} catch {
		body = text
	}
	return { status: res.status, body }
}

// ─── GET ─────────────────────────────────────────────────────────────────────

async function testGetReturnsEmptyObjectWhenMissing(): Promise<void> {
	const repo = await tmpRepo()
	try {
		const { server, port } = await startServer(repo)
		try {
			const { status, body } = await getJson(settingsUrl(port))
			assert.equal(status, 200)
			assert.deepEqual(body, {}, "a missing mode-models.json reads as {}")
		} finally {
			server.close()
		}
	} finally {
		await fs.rm(repo, { recursive: true, force: true })
	}
}

async function testGetReturnsCurrentFileContent(): Promise<void> {
	const repo = await tmpRepo()
	try {
		const filePath = modeModelsFilePath(repo)
		await fs.writeFile(
			filePath,
			JSON.stringify({ code: "deepseek/deepseek-chat", _default: "deepseek/deepseek-chat" }, null, 2) + "\n",
			"utf-8",
		)
		const { server, port } = await startServer(repo)
		try {
			const { status, body } = await getJson(settingsUrl(port))
			assert.equal(status, 200)
			assert.deepEqual(body, { code: "deepseek/deepseek-chat", _default: "deepseek/deepseek-chat" })
		} finally {
			server.close()
		}
	} finally {
		await fs.rm(repo, { recursive: true, force: true })
	}
}

async function testGetRequiresRepo(): Promise<void> {
	const repo = await tmpRepo()
	try {
		// A server started WITHOUT --repo must require ?repo=<path>.
		const { server, port } = await startServer()
		try {
			const noRepo = await getJson(settingsUrl(port))
			assert.equal(noRepo.status, 400)
			const withRepo = await getJson(settingsUrl(port, repo))
			assert.equal(withRepo.status, 200)
		} finally {
			server.close()
		}
	} finally {
		await fs.rm(repo, { recursive: true, force: true })
	}
}

// ─── POST ────────────────────────────────────────────────────────────────────

async function testPostWritesAndGetReflectsChange(): Promise<void> {
	const repo = await tmpRepo()
	try {
		const { server, port } = await startServer(repo)
		try {
			const payload = { code: "deepseek/deepseek-chat", "deepseek-reviewer": "deepseek/deepseek-reasoner" }
			const post = await postJson(settingsUrl(port), payload)
			assert.equal(post.status, 200)
			assert.equal((post.body as { ok: boolean }).ok, true)

			// On disk: pretty-printed, parseable back to the same mapping.
			const onDisk = await fs.readFile(modeModelsFilePath(repo), "utf-8")
			assert.deepEqual(JSON.parse(onDisk), payload)

			// A subsequent GET reflects the change.
			const get = await getJson(settingsUrl(port))
			assert.equal(get.status, 200)
			assert.deepEqual(get.body, payload)
		} finally {
			server.close()
		}
	} finally {
		await fs.rm(repo, { recursive: true, force: true })
	}
}

async function testPostCreatesCentralConfigFile(): Promise<void> {
	const repo = await tmpRepo()
	try {
		const { server, port } = await startServer(repo)
		try {
			const post = await postJson(settingsUrl(port), { code: "x/y" })
			assert.equal(post.status, 200)
			// No workspace-relative file existed before the POST — the central
			// store's mode-models.json must now exist (created on demand).
			await fs.access(modeModelsFilePath(repo))
		} finally {
			server.close()
		}
	} finally {
		await fs.rm(repo, { recursive: true, force: true })
	}
}

async function testPostMalformedBodyRejectedAndExistingFileUntouched(): Promise<void> {
	const repo = await tmpRepo()
	try {
		const filePath = modeModelsFilePath(repo)
		const original = { code: "deepseek/deepseek-chat", _default: "deepseek/deepseek-chat" }
		await fs.writeFile(filePath, JSON.stringify(original, null, 2) + "\n", "utf-8")

		const { server, port } = await startServer(repo)
		try {
			// Non-string value.
			const badValue = await postJson(settingsUrl(port), { code: 42 })
			assert.equal(badValue.status, 400)
			assert.match(String((badValue.body as { error?: string }).error ?? ""), /must be a string model id/i)

			// Non-object body (an array).
			const badShape = await postJson(settingsUrl(port), ["code", "deepseek/deepseek-chat"])
			assert.equal(badShape.status, 400)
			assert.match(String((badShape.body as { error?: string }).error ?? ""), /must be a JSON object/i)

			// Invalid JSON text (sent raw, not JSON-stringified — the helper
			// would otherwise wrap it in quotes and produce valid JSON).
			const badJsonRes = await fetch(settingsUrl(port), {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: "{ not json",
			})
			const badJsonBody = (await badJsonRes.json()) as { error?: string }
			assert.equal(badJsonRes.status, 400)
			assert.match(String(badJsonBody.error ?? ""), /invalid JSON body/i)

			// The existing file must be byte-identical — none of the malformed
			// saves may have written garbage.
			const after = await fs.readFile(filePath, "utf-8")
			assert.equal(after, JSON.stringify(original, null, 2) + "\n")
		} finally {
			server.close()
		}
	} finally {
		await fs.rm(repo, { recursive: true, force: true })
	}
}

async function testPostRejectsWrongMethod(): Promise<void> {
	const repo = await tmpRepo()
	try {
		const { server, port } = await startServer(repo)
		try {
			// GET is a read; DELETE is rejected outright.
			const del = await fetch(settingsUrl(port), { method: "DELETE" })
			assert.equal(del.status, 405)
		} finally {
			server.close()
		}
	} finally {
		await fs.rm(repo, { recursive: true, force: true })
	}
}

// ─── Runner ──────────────────────────────────────────────────────────────────

const tests: Array<[string, () => Promise<void>]> = [
	["settings: GET returns {} when mode-models.json is missing", testGetReturnsEmptyObjectWhenMissing],
	["settings: GET returns the current file content", testGetReturnsCurrentFileContent],
	["settings: GET requires repo (param or --repo)", testGetRequiresRepo],
	["settings: POST writes the file and a subsequent GET reflects it", testPostWritesAndGetReflectsChange],
	["settings: POST creates the central config file when missing", testPostCreatesCentralConfigFile],
	["settings: malformed POST is rejected and does NOT corrupt the existing file", testPostMalformedBodyRejectedAndExistingFileUntouched],
	["settings: non-GET/POST methods to the settings route are rejected (405)", testPostRejectsWrongMethod],
]

async function main(): Promise<void> {
	// Redirect the central store to a temp dir so the HTTP routes never touch
	// the real home directory's store.
	const storeTmp = await fs.mkdtemp(path.join(os.tmpdir(), "hc-settings-store-"))
	process.env.HEADLESSCODE_DATA_DIR = storeTmp
	let failed = 0
	try {
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
	} finally {
		delete process.env.HEADLESSCODE_DATA_DIR
		await fs.rm(storeTmp, { recursive: true, force: true })
	}
	if (failed > 0) {
		console.error(`\n${failed} test(s) failed`)
		process.exit(1)
	}
	console.log(`\nAll ${tests.length} dashboard settings tests passed`)
}

main().catch((err) => {
	console.error("Test runner crashed:", err)
	process.exit(1)
})
