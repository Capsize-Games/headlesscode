/**
 * Source-file chunking for the codebase index.
 *
 * Splits a source file into chunks that (a) are small enough to embed usefully
 * and (b) map back to a `file:startLine-endLine` reference so a search result
 * can be cited to the model.
 *
 * Strategy (deliberately heuristic, NOT a full per-language parser — the spec
 * says good-enough regex/indentation beats over-engineering language-aware
 * parsing, and the reference upstream implementation uses tree-sitter which is
 * out of scope here):
 *
 *   1. Files whose language uses brace-based block structure (the C family:
 *      ts/js/tsx/jsx/rs/go/java/kt/cs/c/cpp/h/hpp/php/swift/scala/dart/…)
 *      are split at TOP-LEVEL function/method/class boundaries. A brace-
 *      counting scanner finds the column-0 (or nearly top-level) brace ranges
 *      that begin with a function/class signature, and each such range becomes
 *      a chunk. The scanner is indentation-aware: a `{` at the top level of a
 *      block-structure file (column 0, or preceded only by whitespace at a
 *      low indentation that matches a declaration) opens a boundary.
 *
 *   2. Python (significant-whitespace): top-level `def`/`class` lines open
 *      boundaries; the chunk extends to the next top-level declaration.
 *
 *   3. Everything else (markdown, json, yaml, sh, txt, files with no clear
 *      boundaries, files too big for the boundary scanner) falls back to
 *      fixed-size line windows with a small overlap.
 *
 * Limitations (documented, accepted):
 *   - Regex/indentation heuristics can mis-split unusual code (a `{` on its
 *     own line at column 0 that is actually a continuation, C++ templates,
 *     nested namespaces, decorators, multiline signatures). A mis-split
 *     produces a chunk that is still a valid file:line citation, just with
 *     slightly less ideal boundaries — the semantic search stays usable.
 *   - Very large single files (e.g. a 5k-line bundle) are chunked by line
 *     windows, not by function — acceptable for this project's scale.
 */

import * as fs from "node:fs"
import * as path from "node:path"

import { MAX_CHUNK_CHARS } from "./embedder.js"

/** A chunk of a file with its line citation. */
export interface Chunk {
	/** Workspace-relative POSIX path. */
	file: string
	/** 1-based inclusive start line. */
	startLine: number
	/** 1-based inclusive end line. */
	endLine: number
	/** Chunk text (the exact lines startLine..endLine). */
	content: string
}

/** Max lines per fallback window. */
export const FALLBACK_WINDOW_LINES = 60
/** Overlap lines between fallback windows (keeps boundaries fuzzy-joined). */
export const FALLBACK_OVERLAP_LINES = 10
/** Files larger than this (lines) use fallback chunking even if they have boundaries. */
export const MAX_BOUNDARY_SCAN_LINES = 3000

/** `{`-using languages whose top-level declarations we can find with brace counting. */
const BRACE_LANGS = new Set([
	".ts",
	".tsx",
	".js",
	".jsx",
	".mjs",
	".cjs",
	".rs",
	".go",
	".java",
	".kt",
	".kts",
	".cs",
	".c",
	".h",
	".cpp",
	".hpp",
	".php",
	".swift",
	".scala",
	".dart",
	".css",
])

/** Python / significant-whitespace languages chunked by top-level def/class. */
const INDENT_LANGS = new Set([".py", ".rb", ".ex", ".exs", ".el", ".sh", ".bash", ".zsh"])

/** Lines that look like a C-family declaration (function/method/class). */
const DECL_RE =
	/^(export\s+)?(abstract\s+|async\s+|static\s+|public\s+|private\s+|protected\s+|internal\s+|final\s+|override\s+|sealed\s+)*\s*(function|def|class|interface|struct|enum|trait|impl|namespace|module|type|fn)\b/

/** A `{`-using file's top-level brace ranges, in line order. */
function findTopLevelBraceRanges(lines: string[]): Array<{ start: number; end: number }> {
	const ranges: Array<{ start: number; end: number }> = []
	let depth = 0
	let rangeStart: number | undefined

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i]
		for (const ch of line) {
			if (ch === "{") {
				if (depth === 0) {
					rangeStart = i
				}
				depth++
			} else if (ch === "}") {
				depth--
				if (depth === 0 && rangeStart !== undefined) {
					ranges.push({ start: rangeStart, end: i })
					rangeStart = undefined
				}
			}
		}
	}
	return ranges
}

/** True when the line starts a top-level declaration (column-0-ish keyword). */
function isTopLevelDeclaration(line: string): boolean {
	const trimmed = line.trim()
	if (trimmed === "" || trimmed.startsWith("//") || trimmed.startsWith("/*") || trimmed.startsWith("*")) {
		return false
	}
	// Column 0 check: the declaration must start at the very left edge (or a
	// leading tab that's effectively top level). This avoids matching
	// declarations nested inside methods.
	const indent = line.match(/^(\s*)/)?.[1] ?? ""
	if (indent.length > 0 && !indent.startsWith("\t")) {
		// Indented with spaces → nested (Python-style or inside a block) → not top level.
		return false
	}
	return DECL_RE.test(trimmed)
}

/** Chunk a brace-based file by top-level declaration ranges. */
function chunkBraceFile(lines: string[], file: string): Chunk[] {
	const ranges = findTopLevelBraceRanges(lines)
	if (ranges.length === 0) {
		return []
	}
	const chunks: Chunk[] = []
	let cursor = 0
	for (const range of ranges) {
		const start = range.start
		const end = range.end
		// Lines between the previous range and this one (head imports,
		// module-level constants, standalone statements like `const helper = …`
		// that carry no braces) must not vanish from the index — emit them as
		// their own chunk when they contain anything non-blank. Blank-only
		// gaps are not worth a citation.
		if (cursor < start) {
			const gap = lines.slice(cursor, start)
			if (gap.some((l) => l.trim() !== "")) {
				chunks.push({
					file,
					startLine: cursor + 1,
					endLine: start,
					content: gap.join("\n"),
				})
			}
		}
		// The brace range itself (function/class/struct body). A tiny stub
		// (e.g. a one-line `{ }`) is left to the next gap slice instead of
		// getting its own chunk.
		if (end - start >= 2) {
			chunks.push({
				file,
				startLine: start + 1,
				endLine: end + 1,
				content: lines.slice(start, end + 1).join("\n"),
			})
			cursor = end + 1
		}
	}
	// Any leftover lines after the last range (file tail) become a small chunk
	// (skipped when it would be an empty/whitespace-only stub — the trailing
	// blank line after the final `}` is not worth a citation).
	if (cursor < lines.length) {
		const tail = lines.slice(cursor)
		if (tail.some((l) => l.trim() !== "")) {
			chunks.push({
				file,
				startLine: cursor + 1,
				endLine: lines.length,
				content: tail.join("\n"),
			})
		}
	}
	return chunks
}

/** Chunk a Python-style file by top-level def/class/block boundaries. */
function chunkIndentFile(lines: string[], file: string): Chunk[] {
	const chunks: Chunk[] = []
	let start = 0
	for (let i = 0; i < lines.length; i++) {
		const trimmed = lines[i].trim()
		// A top-level (column 0) def/class/import/if/for/while opens a new chunk.
		if (/^(def|class|async\s+def|import|from|if|for|while|with|try|except|@)\b/.test(trimmed) && !lines[i].startsWith(" ")) {
			if (i > start) {
				chunks.push({ file, startLine: start + 1, endLine: i, content: lines.slice(start, i).join("\n") })
			}
			start = i
		}
	}
	if (start < lines.length) {
		chunks.push({ file, startLine: start + 1, endLine: lines.length, content: lines.slice(start).join("\n") })
	}
	return chunks
}

/** Fallback: fixed-size line windows with overlap. */
function chunkFallback(lines: string[], file: string): Chunk[] {
	const chunks: Chunk[] = []
	const windowSize = FALLBACK_WINDOW_LINES
	const overlap = FALLBACK_OVERLAP_LINES
	if (lines.length <= windowSize) {
		chunks.push({ file, startLine: 1, endLine: lines.length, content: lines.join("\n") })
		return chunks
	}
	let start = 0
	while (start < lines.length) {
		const end = Math.min(lines.length, start + windowSize)
		chunks.push({ file, startLine: start + 1, endLine: end, content: lines.slice(start, end).join("\n") })
		if (end >= lines.length) {
			break
		}
		start = end - overlap
	}
	return chunks
}

/**
 * Split one oversized chunk into pieces of at most MAX_CHUNK_CHARS (the cap
 * lives in embedder.ts — the OpenRouter embeddings endpoint rejects any single
 * input over the model's limit, seen live as an HTTP 422 on an 8.8M-char
 * minified/data chunk and an HTTP 400 at ~100k chars on qwen/qwen3-embedding-4b
 * whose context is 40960 tokens). Line-based windowing alone cannot guarantee
 * the cap (a file can be a single giant line), so every chunk is split down to
 * at most MAX_CHUNK_CHARS, preferring line boundaries and hard-slicing
 * mid-line only for unbroken giant lines.
 */
function splitOversizedChunk(chunk: Chunk): Chunk[] {
	if (chunk.content.length <= MAX_CHUNK_CHARS) {
		return [chunk]
	}
	const out: Chunk[] = []
	let cursor = 0
	let startLine = chunk.startLine
	while (cursor < chunk.content.length) {
		let end = Math.min(cursor + MAX_CHUNK_CHARS, chunk.content.length)
		// Back off to the previous newline (consuming it) unless this is the
		// final slice or the window is one unbroken line.
		if (end < chunk.content.length) {
			const nl = chunk.content.lastIndexOf("\n", end - 1)
			if (nl > cursor) {
				end = nl + 1
			}
		}
		const piece = chunk.content.slice(cursor, end)
		const newlineCount = (piece.match(/\n/g) ?? []).length
		// Line bookkeeping: a trailing \n terminates the final line of the
		// piece, so it covers newlineCount lines; otherwise it covers
		// newlineCount + 1. A piece with no \n at all is a mid-line hard slice
		// of one giant line, so it cites the same line and the next slice
		// starts on the same line number.
		const coversLines = newlineCount + (piece.endsWith("\n") ? 0 : 1)
		out.push({
			file: chunk.file,
			startLine,
			endLine: startLine + coversLines - 1,
			content: piece,
		})
		if (newlineCount > 0) {
			startLine += coversLines
		}
		cursor = end
	}
	return out
}

/**
 * Split a source file into line-cited chunks.
 *
 * @param absPath  absolute path of the file to chunk
 * @param relPath  workspace-relative POSIX path (used for citations)
 */
function chunkFileUncapped(absPath: string, relPath: string): Chunk[] {
	let content: string
	try {
		content = fs.readFileSync(absPath, "utf-8")
	} catch {
		return []
	}
	const lines = content.split(/\r?\n/)
	if (lines.length === 0 || (lines.length === 1 && lines[0].trim() === "")) {
		return []
	}
	const ext = path.extname(relPath).toLowerCase()

	// Very large files fall back to windows — the boundary scanner is O(n)
	// brace counting but a 10k-line minified bundle isn't a boundary case worth
	// scanning, and windowing is what the reference does for huge files too.
	if (lines.length > MAX_BOUNDARY_SCAN_LINES) {
		return chunkFallback(lines, relPath)
	}

	if (BRACE_LANGS.has(ext)) {
		const chunks = chunkBraceFile(lines, relPath)
		if (chunks.length > 0) {
			return chunks
		}
		return chunkFallback(lines, relPath)
	}

	if (INDENT_LANGS.has(ext)) {
		const chunks = chunkIndentFile(lines, relPath)
		if (chunks.length > 0) {
			return chunks
		}
		return chunkFallback(lines, relPath)
	}

	return chunkFallback(lines, relPath)
}

/**
	* Split a source file into line-cited chunks, each capped at MAX_CHUNK_CHARS
	* characters so no chunk can exceed the embedding endpoint's input limit.
	*
	* @param absPath  absolute path of the file to chunk
	* @param relPath  workspace-relative POSIX path (used for citations)
	*/
export function chunkFile(absPath: string, relPath: string): Chunk[] {
	return chunkFileUncapped(absPath, relPath).flatMap(splitOversizedChunk)
}
