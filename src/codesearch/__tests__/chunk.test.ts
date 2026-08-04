/**
 * Unit tests for src/codesearch/chunk.ts — source-file chunking.
 *
 * Plain assert-based script (no test framework, no network), run via
 * `npm test` → `tsx src/codesearch/__tests__/chunk.test.ts`.
 */

import assert from "node:assert/strict"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"

import { MAX_CHUNK_CHARS } from "../embedder.js"
import { chunkFile } from "../chunk.js"

async function mkTmpWorkspace(files: Record<string, string>): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "hc-chunk-"))
	for (const [rel, content] of Object.entries(files)) {
		const abs = path.join(dir, rel)
		await fs.mkdir(path.dirname(abs), { recursive: true })
		await fs.writeFile(abs, content, "utf-8")
	}
	return dir
}

const TS_WITH_BOUNDARIES = `import * as fs from "node:fs"

export function parseConfig(raw: string): Config {
	const lines = raw.split("\\n")
	const out: Config = { port: 3000 }
	for (const line of lines) {
		if (line.startsWith("PORT=")) {
			out.port = Number(line.slice(5))
		}
	}
	return out
}

export class Server {
	private port: number
	constructor(port: number) {
		this.port = port
	}
	start(): void {
		console.log("listening on " + this.port)
	}
}

const helper = (x: number): number => x * 2

export function main(): void {
	const server = new Server(parseConfig("").port)
	server.start()
}
`

const PY_WITH_BOUNDARIES = `import os

def parse_config(raw):
    out = {}
    for line in raw.splitlines():
        k, _, v = line.partition("=")
        out[k] = v
    return out

class Server:
    def __init__(self, port):
        self.port = port

    def start(self):
        print(f"listening on {self.port}")

def main():
    s = Server(3000)
    s.start()
`

const NO_BOUNDARIES = `This is a long text file that has no function
boundaries at all. It just goes on and on and on and on and on and on
with line after line after line after line after line after line after
line after line after line after line after line after line after line
after line after line after line after line after line after line after
line after line after line after line after line after line after line
after line after line after line after line after line after line after
line after line after line after line after line after line after line
after line after line after line after line after line after line after
line after line after line after line after line after line after line
after line after line after line after line after line after line after
line after line after line after line after line after line after line
after line after line after line after line after line after line after
after line after line after line after line after line after line after
after line after line after line after line after line after line after
after line after line after line after line after line after line after
after line after line after line after line after line after line after
after line after line after line after line after line after line after
after line after line after line after line after line after line after
after line after line after line after line after line after line after
after line after line after line after line after line after line after
after line after line after line after line after line after line after
after line after line after line after line after line after line after
after line after line after line after line after line after line after
after line after line after line after line after line after line after
after line after line after line after line after line after line after
after line after line after line after line after line after line after
after line after line after line after line after line after line after
after line after line after line after line after line after line after
after line after line after line after line after line after line after
after line after line after line after line after line after line after
after line after line after line after line after line after line after
after line after line after line after line after line after line after
after line after line after line after line after line after line after
after line after line after line after line after line after line after
after line after line after line after line after line after line after
after line after line after line after line after line after line after
after line after line after line after line after line after line after
after line after line after line after line after line after line after
after line after line after line after line after line after line after
after line after line after line after line after line after line after
after line after line after line after line after line after line after
after line after line after line after line after line after line after
after line after line after line after line after line after line after
after line after line after line after line after line after line after
after line after line after line after line after line after line after
after line after line after line after line after line after line after
after line after line after line after line after line after line after
after line after line after line after line after line after line after
after line after line after line after line after line after line after
after line after line after line after line after line after line after
after line after line after line after line after line after line after
after line after line after line after line after line after line after
after line after line after line after line after line after line after
after line after line after line after line after line after line after
after line after line after line after line after line after line after
after line after line after line after line after line after line after
after line after line after line after line after line after line after
after line after line after line after line after line after line after
after line after line after line after line after line after line after
after line after line after line after line after line after line after
`

async function testTsChunksByFunctionBoundaries(): Promise<void> {
	const ws = await mkTmpWorkspace({ "src/app.ts": TS_WITH_BOUNDARIES })
	try {
		const chunks = chunkFile(path.join(ws, "src", "app.ts"), "src/app.ts")
		assert.ok(chunks.length >= 3, `expected multiple function/class chunks, got ${chunks.length}`)

		// Each chunk cites a sane line range.
		for (const c of chunks) {
			assert.ok(c.startLine >= 1 && c.endLine >= c.startLine, `${c.startLine}-${c.endLine} must be sane`)
			assert.ok(c.content.length > 0, "chunk content must be non-empty")
		}

		// The parseConfig function (starts line 3 in this fixture) should be
		// its own chunk starting at its signature line.
		const parseConfigChunk = chunks.find((c) => c.startLine === 3)
		assert.ok(parseConfigChunk, "expected a chunk starting at line 3 (parseConfig)")
		assert.match(parseConfigChunk.content, /parseConfig/, "chunk contains the function")
		assert.match(parseConfigChunk.content, /return out/, "chunk spans the whole function")

		// The Server class (starts line 14) should be its own chunk.
		const serverChunk = chunks.find((c) => c.startLine === 14)
		assert.ok(serverChunk, "expected a chunk starting at line 14 (class Server)")
		assert.match(serverChunk.content, /class Server/, "chunk contains the class")
		assert.match(serverChunk.content, /start\(\)/, "chunk spans the class methods")

		// Gap coverage: no line of the file may be unsearchable. The import
		// header (line 1) and the brace-less `const helper` (line 24) must
		// appear in some chunk, and every NON-BLANK line of the file must be
		// covered by at least one chunk (blank-only separators may be dropped,
		// but real content never may be).
		const allContent = chunks.map((c) => c.content).join("\n")
		assert.match(allContent, /import \* as fs/, "import header must be indexed")
		assert.match(allContent, /const helper/, "brace-less module statement must be indexed")
		const covered = new Set<number>()
		for (const c of chunks) {
			for (let ln = c.startLine; ln <= c.endLine; ln++) {
				covered.add(ln)
			}
		}
		const fileLines = TS_WITH_BOUNDARIES.split("\n")
		fileLines.forEach((line, i) => {
			if (line.trim() !== "") {
				assert.ok(covered.has(i + 1), `non-blank line ${i + 1} must be covered by a chunk`)
			}
		})
		// Chunks must never overlap each other.
		const sorted = [...chunks].sort((a, b) => a.startLine - b.startLine)
		for (let i = 1; i < sorted.length; i++) {
			assert.ok(sorted[i].startLine > sorted[i - 1].endLine, "chunks must not overlap")
		}
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

async function testPyChunksByTopLevelDefs(): Promise<void> {
	const ws = await mkTmpWorkspace({ "app.py": PY_WITH_BOUNDARIES })
	try {
		const chunks = chunkFile(path.join(ws, "app.py"), "app.py")
		assert.ok(chunks.length >= 3, `expected multiple def/class chunks, got ${chunks.length}`)

		// A chunk whose content is the `def parse_config` body (starts at
		// line 3, since the imports are line 1-2).
		const parseChunk = chunks.find((c) => /def parse_config/.test(c.content))
		assert.ok(parseChunk, "expected a chunk containing def parse_config")
		assert.equal(parseChunk.startLine, 3)

		// class Server is its own chunk.
		const classChunk = chunks.find((c) => /class Server/.test(c.content))
		assert.ok(classChunk, "expected a chunk containing class Server")
		assert.match(classChunk.content, /def start/, "class chunk spans its methods")
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

async function testNoBoundariesFallsBackToWindows(): Promise<void> {
	const ws = await mkTmpWorkspace({ "notes.txt": NO_BOUNDARIES })
	try {
		const chunks = chunkFile(path.join(ws, "notes.txt"), "notes.txt")
		assert.ok(chunks.length > 1, `a long boundary-less file should produce multiple windows, got ${chunks.length}`)

		// Windows are ≤ FALLBACK_WINDOW_LINES lines each.
		for (const c of chunks) {
			assert.ok(
				c.endLine - c.startLine + 1 <= 60,
				`window chunk ${c.startLine}-${c.endLine} must be within the 60-line window`,
			)
			assert.ok(c.startLine >= 1 && c.endLine >= c.startLine, "sane line range")
		}

		// The first chunk covers the start of the file; coverage is contiguous.
		assert.equal(chunks[0].startLine, 1)
		for (let i = 1; i < chunks.length; i++) {
			// Overlap means a new chunk may start before the previous end, but
			// it must never gap backward.
			assert.ok(chunks[i].startLine <= chunks[i - 1].endLine + 1, "chunks must be contiguous (no gaps)")
		}
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

async function testOversizedChunksAreCapped(): Promise<void> {
	// A single giant line (minified bundle / huge data blob) and a window that
	// exceeds the char cap must both be split down below MAX_CHUNK_CHARS — the
	// embedding endpoint rejects any input >= 131072 chars (HTTP 422).
	const giantLine = "x".repeat(300_000)
	const longLines = Array.from({ length: 150 }, (_, i) => `line ${i} ` + "y".repeat(1900)).join("\n")
	const ws = await mkTmpWorkspace({
		"bundle.js": giantLine + "\n",
		"data.txt": longLines + "\n",
	})
	try {
		// (a) A file that is ONE giant line must split into capped pieces that
		// all cite the same line and reconstruct the original content.
		const jsChunks = chunkFile(path.join(ws, "bundle.js"), "bundle.js")
		assert.ok(jsChunks.length >= 3, `300k single line should split into >=3 capped chunks, got ${jsChunks.length}`)
		for (const c of jsChunks) {
			assert.ok(c.content.length <= MAX_CHUNK_CHARS, `chunk ${c.startLine}-${c.endLine} exceeds MAX_CHUNK_CHARS`)
			assert.equal(c.startLine, 1, "all pieces of one giant line cite line 1")
			assert.equal(c.endLine, 1)
		}
		assert.equal(
			jsChunks.map((c) => c.content).join(""),
			giantLine + "\n",
			"capped pieces must reconstruct the original file content",
		)

		// (b) A fallback window of 60 lines × ~2k chars = ~120k chars exceeds
		// the cap and must be split further. Windows overlap by 10 lines, so
		// pieces from different source windows interleave — the invariants
		// that hold are: every chunk is capped, and every line 1..150 is
		// covered by at least one chunk.
		const txtChunks = chunkFile(path.join(ws, "data.txt"), "data.txt")
		assert.ok(txtChunks.length >= 4, `oversized windows should split further, got ${txtChunks.length}`)
		const cited = new Set<number>()
		for (const c of txtChunks) {
			assert.ok(c.content.length <= MAX_CHUNK_CHARS, `chunk ${c.startLine}-${c.endLine} exceeds MAX_CHUNK_CHARS`)
			assert.ok(c.startLine >= 1 && c.endLine >= c.startLine, "sane line range")
			for (let l = c.startLine; l <= c.endLine; l++) {
				cited.add(l)
			}
		}
		for (let l = 1; l <= 150; l++) {
			assert.ok(cited.has(l), `line ${l} is not covered by any chunk`)
		}
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

async function testSkipsBinaryAndGitignoredFiles(): Promise<void> {
	const ws = await mkTmpWorkspace({
		"a.ts": "export const a = 1\n",
		"b.png": "PNG\x00\x01binarydata".repeat(40),
		".gitignore": "ignored/\n",
		"ignored/c.ts": "export const c = 2\n",
	})
	try {
		// chunkFile itself is path-based: a binary file read as utf-8 will
		// produce garbage text — the caller (walkSourceFiles) is responsible
		// for excluding binary + gitignored files BEFORE chunking. Assert the
		// file walker's exclusion behavior instead (this is the integration
		// point the spec cares about: gitignored/binary files are skipped).
		const { walkSourceFiles } = await import("../files.js")
		const files = await walkSourceFiles(ws)
		const rels = files.map((f) => f.rel)
		assert.ok(rels.includes("a.ts"), "a.ts should be indexed")
		assert.ok(!rels.includes("ignored/c.ts"), "gitignored file must be skipped by the walker")
		assert.ok(!rels.some((r) => r.endsWith(".png")), "binary/non-source files must be skipped by the walker")
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

const tests: Array<[string, () => Promise<void>]> = [
	["TypeScript file chunks by top-level function/class boundaries", testTsChunksByFunctionBoundaries],
	["Python file chunks by top-level def/class boundaries", testPyChunksByTopLevelDefs],
	["boundary-less file falls back to fixed-size windows with overlap", testNoBoundariesFallsBackToWindows],
	["oversized chunks are capped below the embedder input limit", testOversizedChunksAreCapped],
	["gitignored + binary files are skipped (walker integration)", testSkipsBinaryAndGitignoredFiles],
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
	console.log(`\nAll ${tests.length} chunk tests passed`)
}

main().catch((err) => {
	console.error("Test runner crashed:", err)
	process.exit(1)
})
