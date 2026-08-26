/**
 * Tests for the dashboard file browser + permissions settings UI
 * (dashboard-file-browser-and-permissions-ui):
 *
 *  - GET /api/files + /api/files/content: normal listing/content work,
 *    path-traversal attempts against BOTH routes are refused (via the shared
 *    resolveWithinWorkspace/PathTraversalError guard), oversized/binary files
 *    are handled per the cap convention (not dumped raw).
 *  - GET /api/settings/permissions: returns the current permissions.json
 *    content, or clearly-labeled defaults when no file exists.
 *  - POST /api/settings/permissions: a valid save writes the file and the
 *    round-trip is proven through resolvePermissions (the write actually
 *    changes real permission resolution, not just the bytes on disk); a
 *    malformed save is rejected with a clear error and does NOT write a
 *    broken file.
 *  - The optional bearer-token gate covers the permissions POST (and the
 *    file routes stay read-only GETs).
 *
 * Plain assert-based script (no test framework), run via `npm test` ->
 * `tsx src/dashboard/__tests__/file-browser-permissions.test.ts`.
 */

import assert from "node:assert/strict"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"

import { startDashboardServer } from "../server.js"
import type { Server } from "node:http"
import { permissionsFilePath, resolvePermissions } from "../../permissions/config.js"
import { DEFAULT_PROTECTED_FILES } from "../../permissions/protected-files.js"

async function tmpRepo(prefix = "hc-fileperm-"): Promise<string> {
	return fs.mkdtemp(path.join(os.tmpdir(), prefix))
}

async function startServer(
	repo: string,
	opts: { token?: string } = {},
): Promise<{ server: Server; port: number }> {
	const server = await startDashboardServer({ port: 0, repo, ...(opts.token ? { token: opts.token } : {}) })
	const addr = server.address()
	const port = typeof addr === "object" && addr ? addr.port : 0
	return { server, port }
}

async function getJson(
	base: string,
	urlPath: string,
	headers: Record<string, string> = {},
): Promise<{ status: number; body: unknown }> {
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

async function postJson(
	base: string,
	urlPath: string,
	payload: unknown,
	headers: Record<string, string> = {},
): Promise<{ status: number; body: unknown }> {
	const res = await fetch(base + urlPath, {
		method: "POST",
		headers: { "content-type": "application/json", ...headers },
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

function repoParam(repo: string): string {
	return `repo=${encodeURIComponent(repo)}`
}

// ─── Part A: file browser ───────────────────────────────────────────────────

async function testFilesListsDirectoryEntries(): Promise<void> {
	const repo = await tmpRepo()
	try {
		await fs.mkdir(path.join(repo, "sub"), { recursive: true })
		await fs.writeFile(path.join(repo, "a.txt"), "hello world", "utf-8")
		await fs.writeFile(path.join(repo, "sub", "b.ts"), "export const b = 1\n", "utf-8")

		const { server, port } = await startServer(repo)
		try {
			const base = `http://127.0.0.1:${port}`
			const { status, body } = await getJson(base, `/api/files?${repoParam(repo)}`)
			assert.equal(status, 200)
			const entries = (body as { entries: Array<{ name: string; type: string; size: number }> }).entries
			const names = entries.map((e) => e.name).sort()
			assert.deepEqual(names, ["a.txt", "sub"])
			const a = entries.find((e) => e.name === "a.txt")
			assert.equal(a?.type, "file")
			assert.equal(a?.size, 11)
			const sub = entries.find((e) => e.name === "sub")
			assert.equal(sub?.type, "dir")

			// A subdirectory listing works too (dirs first ordering).
			const subRes = await getJson(base, `/api/files?${repoParam(repo)}&dir=sub`)
			assert.equal(subRes.status, 200)
			const subEntries = (subRes.body as { entries: Array<{ name: string }> }).entries
			assert.deepEqual(subEntries.map((e) => e.name), ["b.ts"])
		} finally {
			server.close()
		}
	} finally {
		await fs.rm(repo, { recursive: true, force: true })
	}
}

async function testFilesContentReturnsText(): Promise<void> {
	const repo = await tmpRepo()
	try {
		await fs.writeFile(path.join(repo, "note.md"), "# Title\n\nbody text\n", "utf-8")
		const { server, port } = await startServer(repo)
		try {
			const base = `http://127.0.0.1:${port}`
			const { status, body } = await getJson(base, `/api/files/content?${repoParam(repo)}&file=note.md`)
			assert.equal(status, 200)
			const data = body as { previewable: boolean; content: string }
			assert.equal(data.previewable, true)
			assert.equal(data.content, "# Title\n\nbody text\n")
		} finally {
			server.close()
		}
	} finally {
		await fs.rm(repo, { recursive: true, force: true })
	}
}

async function testFilesRejectsTraversal(): Promise<void> {
	const repo = await tmpRepo()
	try {
		const outside = await tmpRepo("hc-fileperm-outside-")
		try {
			await fs.writeFile(path.join(outside, "secret.txt"), "top secret", "utf-8")
			const { server, port } = await startServer(repo)
			try {
				const base = `http://127.0.0.1:${port}`

				// Directory listing with ../ escapes the workspace.
				const listTraversal = await getJson(base, `/api/files?${repoParam(repo)}&dir=..`)
				assert.equal(listTraversal.status, 400)
				assert.match(String((listTraversal.body as { error?: string }).error ?? ""), /escapes the workspace/i)

				// Deep traversal through a subdirectory.
				const deep = await getJson(base, `/api/files?${repoParam(repo)}&dir=sub/../../../..`)
				assert.equal(deep.status, 400)

				// File content with an absolute path outside the root.
				const absTraversal = await getJson(base, `/api/files/content?${repoParam(repo)}&file=${encodeURIComponent(outside + "/secret.txt")}`)
				assert.equal(absTraversal.status, 400)
				assert.match(String((absTraversal.body as { error?: string }).error ?? ""), /escapes the workspace/i)

				// File content with .. traversal.
				const relTraversal = await getJson(base, `/api/files/content?${repoParam(repo)}&file=../outside/secret.txt`)
				assert.equal(relTraversal.status, 400)
			} finally {
				server.close()
			}
		} finally {
			await fs.rm(outside, { recursive: true, force: true })
		}
	} finally {
		await fs.rm(repo, { recursive: true, force: true })
	}
}

async function testFilesOversizedAndBinaryHandled(): Promise<void> {
	const repo = await tmpRepo()
	try {
		// Over the 30k-char cap: must be "not previewable", NOT raw bytes.
		const big = "x".repeat(31_000)
		await fs.writeFile(path.join(repo, "big.txt"), big, "utf-8")

		// Binary: NUL bytes.
		await fs.writeFile(path.join(repo, "bin.dat"), Buffer.from([0, 1, 2, 3, 0, 255]))

		const { server, port } = await startServer(repo)
		try {
			const base = `http://127.0.0.1:${port}`
			const bigRes = await getJson(base, `/api/files/content?${repoParam(repo)}&file=big.txt`)
			assert.equal(bigRes.status, 200)
			const bigBody = bigRes.body as { previewable: boolean; reason: string }
			assert.equal(bigBody.previewable, false)
			assert.match(bigBody.reason, /over the .* preview cap/i)

			const binRes = await getJson(base, `/api/files/content?${repoParam(repo)}&file=bin.dat`)
			assert.equal(binRes.status, 200)
			const binBody = binRes.body as { previewable: boolean; reason: string }
			assert.equal(binBody.previewable, false)
			assert.match(binBody.reason, /binary/i)
		} finally {
			server.close()
		}
	} finally {
		await fs.rm(repo, { recursive: true, force: true })
	}
}

async function testFilesContentRefusesProtectedFile(): Promise<void> {
	const repo = await tmpRepo()
	try {
		await fs.writeFile(path.join(repo, ".env"), "HEADLESSCODE_OPENROUTER_API_KEY=super-secret\n", "utf-8")
		await fs.mkdir(path.join(repo, "sub"), { recursive: true })
		await fs.writeFile(path.join(repo, "sub", "id_rsa"), "not-a-real-key", "utf-8")
		const { server, port } = await startServer(repo)
		try {
			const base = `http://127.0.0.1:${port}`

			// .env at the repo root is refused (SEC-7) — content never leaves the
			// server, even though the path itself is legitimately inside the workspace.
			const envRes = await getJson(base, `/api/files/content?${repoParam(repo)}&file=.env`)
			assert.equal(envRes.status, 200, "the route itself succeeds (it's not a 4xx/5xx)")
			const envBody = envRes.body as { previewable: boolean; reason?: string }
			assert.equal(envBody.previewable, false)
			assert.ok(!JSON.stringify(envBody).includes("super-secret"), "the secret content must never appear in the response")

			// A protected pattern nested in a subdirectory is refused too
			// (bare-filename patterns like id_rsa* match at any depth).
			const idRsaRes = await getJson(base, `/api/files/content?${repoParam(repo)}&file=sub/id_rsa`)
			const idRsaBody = idRsaRes.body as { previewable: boolean }
			assert.equal(idRsaBody.previewable, false)
		} finally {
			server.close()
		}
	} finally {
		await fs.rm(repo, { recursive: true, force: true })
	}
}

async function testFilesRequiresRepoAndFile(): Promise<void> {
	const repo = await tmpRepo()
	try {
		// Server WITHOUT --repo: the routes must require ?repo=<path>.
		const server = await startDashboardServer({ port: 0 })
		const addr = server.address()
		const port = typeof addr === "object" && addr ? addr.port : 0
		const base = `http://127.0.0.1:${port}`
		try {
			const noRepo = await getJson(base, "/api/files")
			assert.equal(noRepo.status, 400)
			const noRepoContent = await getJson(base, "/api/files/content")
			assert.equal(noRepoContent.status, 400)

			// Missing ?file= on the content route.
			const noFile = await getJson(base, `/api/files/content?${repoParam(repo)}`)
			assert.equal(noFile.status, 400)
		} finally {
			server.close()
		}
	} finally {
		await fs.rm(repo, { recursive: true, force: true })
	}
}

async function testFilesNonGetMethodsRejected(): Promise<void> {
	const repo = await tmpRepo()
	try {
		const { server, port } = await startServer(repo)
		try {
			const base = `http://127.0.0.1:${port}`
			const del = await fetch(base + `/api/files?${repoParam(repo)}`, { method: "DELETE" })
			assert.equal(del.status, 405)
			const post = await fetch(base + `/api/files/content?${repoParam(repo)}&file=a`, { method: "POST" })
			assert.equal(post.status, 405)
		} finally {
			server.close()
		}
	} finally {
		await fs.rm(repo, { recursive: true, force: true })
	}
}

// ─── Part B: permissions settings ───────────────────────────────────────────

function permsUrl(repo: string): string {
	return `/api/settings/permissions?${repoParam(repo)}`
}

async function testPermissionsGetReturnsDefaultsWhenMissing(): Promise<void> {
	const repo = await tmpRepo()
	try {
		const { server, port } = await startServer(repo)
		try {
			const base = `http://127.0.0.1:${port}`
			const { status, body } = await getJson(base, permsUrl(repo))
			assert.equal(status, 200)
			const data = body as {
				file: unknown
				resolved: { allowedCommands: string[]; deniedCommands: string[]; protectedFiles: string[]; allowProtectedWrites: boolean }
				isDefault: boolean
			}
			// No file yet — clearly labeled as defaults, with the resolved
			// view showing what a session would actually enforce.
			assert.equal(data.isDefault, true)
			assert.equal(data.file, null)
			assert.deepEqual(data.resolved.allowedCommands, [])
			assert.deepEqual(data.resolved.deniedCommands, [])
			assert.deepEqual(data.resolved.protectedFiles, DEFAULT_PROTECTED_FILES)
			assert.equal(data.resolved.allowProtectedWrites, false)
		} finally {
			server.close()
		}
	} finally {
		await fs.rm(repo, { recursive: true, force: true })
	}
}

async function testPermissionsGetReturnsFileWhenPresent(): Promise<void> {
	const repo = await tmpRepo()
	try {
		const custom = {
			allowedCommands: ["npm test"],
			deniedCommands: ["rm -rf"],
			protectedFiles: [".env", "secrets/"],
			allowProtectedWrites: false,
		}
		await fs.writeFile(permissionsFilePath(repo), JSON.stringify(custom, null, 2) + "\n", "utf-8")

		const { server, port } = await startServer(repo)
		try {
			const base = `http://127.0.0.1:${port}`
			const { status, body } = await getJson(base, permsUrl(repo))
			assert.equal(status, 200)
			const data = body as { file: unknown; isDefault: boolean; resolved: { allowedCommands: string[] } }
			assert.equal(data.isDefault, false)
			assert.deepEqual(data.file, custom)
			// Resolved view reflects the file too.
			assert.deepEqual(data.resolved.allowedCommands, ["npm test"])
		} finally {
			server.close()
		}
	} finally {
		await fs.rm(repo, { recursive: true, force: true })
	}
}

async function testPermissionsPostRoundTripAffectsResolution(): Promise<void> {
	const repo = await tmpRepo()
	try {
		const { server, port } = await startServer(repo)
		try {
			const base = `http://127.0.0.1:${port}`
			const payload = {
				allowedCommands: ["npm test", "npx tsc"],
				deniedCommands: ["git push --force"],
				protectedFiles: [".env", "*.pem", "config/"],
				allowProtectedWrites: false,
			}
			const post = await postJson(base, permsUrl(repo), payload)
			assert.equal(post.status, 200)
			assert.equal((post.body as { ok: boolean }).ok, true)

			// The file was written (pretty-printed, parseable back).
			const onDisk = await fs.readFile(permissionsFilePath(repo), "utf-8")
			assert.deepEqual(JSON.parse(onDisk), payload)

			// THE round-trip proof: resolvePermissions on a FRESH call (no
			// overrides, no env) must now reflect the saved file — proving the
			// write actually changes real permission resolution, not just the
			// bytes on disk.
			const resolved = resolvePermissions({ workspaceRoot: repo, env: {} })
			assert.deepEqual(resolved.allowedCommands, ["npm test", "npx tsc"])
			assert.deepEqual(resolved.deniedCommands, ["git push --force"])
			assert.deepEqual(resolved.protectedFiles, [".env", "*.pem", "config/"])
			assert.equal(resolved.allowProtectedWrites, false)

			// A subsequent GET reflects the change too.
			const get = await getJson(base, permsUrl(repo))
			const data = get.body as { file: unknown; isDefault: boolean }
			assert.equal(get.status, 200)
			assert.equal(data.isDefault, false)
			assert.deepEqual(data.file, payload)
		} finally {
			server.close()
		}
	} finally {
		await fs.rm(repo, { recursive: true, force: true })
	}
}

async function testPermissionsPostMalformedRejectedAndNoCorruption(): Promise<void> {
	const repo = await tmpRepo()
	try {
		const original = { deniedCommands: ["rm -rf"], allowProtectedWrites: false }
		await fs.writeFile(permissionsFilePath(repo), JSON.stringify(original, null, 2) + "\n", "utf-8")

		const { server, port } = await startServer(repo)
		try {
			const base = `http://127.0.0.1:${port}`
			const url = permsUrl(repo)

			// Non-array value for a list field.
			const badList = await postJson(base, url, { allowedCommands: "npm test" })
			assert.equal(badList.status, 400)
			assert.match(String((badList.body as { error?: string }).error ?? ""), /must be an array of strings/i)

			// Non-string entry inside a list.
			const badEntry = await postJson(base, url, { protectedFiles: [".env", 42] })
			assert.equal(badEntry.status, 400)
			assert.match(String((badEntry.body as { error?: string }).error ?? ""), /must be an array of strings/i)

			// Non-boolean escape hatch.
			const badBool = await postJson(base, url, { allowProtectedWrites: "yes" })
			assert.equal(badBool.status, 400)
			assert.match(String((badBool.body as { error?: string }).error ?? ""), /must be a boolean/i)

			// Non-object body.
			const badShape = await postJson(base, url, ["allowedCommands"])
			assert.equal(badShape.status, 400)
			assert.match(String((badShape.body as { error?: string }).error ?? ""), /must be a JSON object/i)

			// Invalid JSON text (sent raw, not JSON-stringified).
			const badJsonRes = await fetch(base + url, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: "{ not json",
			})
			assert.equal(badJsonRes.status, 400)
			assert.match(String(((await badJsonRes.json()) as { error?: string }).error ?? ""), /invalid JSON body/i)

			// NONE of the malformed saves may have touched the existing file.
			const after = await fs.readFile(permissionsFilePath(repo), "utf-8")
			assert.equal(after, JSON.stringify(original, null, 2) + "\n")
		} finally {
			server.close()
		}
	} finally {
		await fs.rm(repo, { recursive: true, force: true })
	}
}

async function testPermissionsPostCreatesCentralConfigFile(): Promise<void> {
	const repo = await tmpRepo()
	try {
		const { server, port } = await startServer(repo)
		try {
			const base = `http://127.0.0.1:${port}`
			const post = await postJson(base, permsUrl(repo), { deniedCommands: ["pkill -9"] })
			assert.equal(post.status, 200)
			// No workspace-relative file existed before — the central store's
			// permissions.json must now exist (created on demand).
			await fs.access(permissionsFilePath(repo))
		} finally {
			server.close()
		}
	} finally {
		await fs.rm(repo, { recursive: true, force: true })
	}
}

async function testPermissionsPostRequiresRepo(): Promise<void> {
	const server = await startDashboardServer({ port: 0 })
	const addr = server.address()
	const port = typeof addr === "object" && addr ? addr.port : 0
	try {
		const base = `http://127.0.0.1:${port}`
		const get = await getJson(base, "/api/settings/permissions")
		assert.equal(get.status, 400)
		const post = await postJson(base, "/api/settings/permissions", {})
		assert.equal(post.status, 400)
	} finally {
		server.close()
	}
}

async function testPermissionsTokenGate(): Promise<void> {
	const repo = await tmpRepo()
	try {
		const { server, port } = await startServer(repo, { token: "sekret" })
		try {
			const base = `http://127.0.0.1:${port}`
			const url = permsUrl(repo)

			// Without the header -> 401 (the gate must cover this POST).
			const noAuth = await postJson(base, url, { deniedCommands: ["rm -rf"] })
			assert.equal(noAuth.status, 401)

			// With the wrong token -> 401.
			const badAuth = await postJson(base, url, { deniedCommands: ["rm -rf"] }, { authorization: "Bearer wrong" })
			assert.equal(badAuth.status, 401)

			// With the right token -> passes validation (200; a malformed body
			// would be a 400, meaning the token gate let it through).
			const goodAuth = await postJson(
				base,
				url,
				{ deniedCommands: ["rm -rf"] },
				{ authorization: "Bearer sekret" },
			)
			assert.equal(goodAuth.status, 200)

			// GET /api/settings/permissions stays open (read-only, and not a
			// workspace-file-content route) even when a token is configured.
			const get = await getJson(base, url)
			assert.equal(get.status, 200)

			// The file-browser GET routes ARE gated by the same token (SEC-7):
			// they read workspace file contents, which is exactly the surface a
			// DNS-rebinding/localhost-CSRF attack would target.
			const filesNoAuth = await getJson(base, `/api/files?${repoParam(repo)}`)
			assert.equal(filesNoAuth.status, 401)
			const filesAuthed = await getJson(base, `/api/files?${repoParam(repo)}`, {
				authorization: "Bearer sekret",
			})
			assert.equal(filesAuthed.status, 200)
		} finally {
			server.close()
		}
	} finally {
		await fs.rm(repo, { recursive: true, force: true })
	}
}

// ─── Runner ──────────────────────────────────────────────────────────────────

const tests: Array<[string, () => Promise<void>]> = [
	["files: GET /api/files lists a directory's entries (dirs first, with sizes)", testFilesListsDirectoryEntries],
	["files: GET /api/files/content returns text content", testFilesContentReturnsText],
	["files: path-traversal attempts against both routes are refused (400)", testFilesRejectsTraversal],
	["files: oversized + binary files are not previewable (never dumped raw)", testFilesOversizedAndBinaryHandled],
	["files: protected files (.env, id_rsa*) are refused even inside the workspace (SEC-7)", testFilesContentRefusesProtectedFile],
	["files: routes require repo (param or --repo) and file param", testFilesRequiresRepoAndFile],
	["files: non-GET methods to the file routes are rejected (405)", testFilesNonGetMethodsRejected],
	["permissions: GET returns clearly-labeled defaults when no file exists", testPermissionsGetReturnsDefaultsWhenMissing],
	["permissions: GET returns the current file content when present", testPermissionsGetReturnsFileWhenPresent],
	["permissions: POST writes the file and resolvePermissions round-trips it", testPermissionsPostRoundTripAffectsResolution],
	["permissions: malformed POST is rejected and does NOT corrupt the existing file", testPermissionsPostMalformedRejectedAndNoCorruption],
	["permissions: POST creates the central config file when missing", testPermissionsPostCreatesCentralConfigFile],
	["permissions: GET/POST require repo (param or --repo)", testPermissionsPostRequiresRepo],
	["permissions: optional bearer token gates the permissions POST", testPermissionsTokenGate],
]

async function main(): Promise<void> {
	// Redirect the central store to a temp dir so the HTTP routes never touch
	// the real home directory's store.
	const storeTmp = await fs.mkdtemp(path.join(os.tmpdir(), "hc-fileperm-store-"))
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
	console.log(`\nAll ${tests.length} dashboard file-browser + permissions settings tests passed`)
}

main().catch((err) => {
	console.error("Test runner crashed:", err)
	process.exit(1)
})
