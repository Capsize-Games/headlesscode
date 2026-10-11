/**
 * Bounded lexical fallback for codebase_search (issue #84).
 *
 * Used ONLY when the semantic index file is genuinely missing (ENOENT) —
 * e.g. a disposable clone with no index. No network, embeddings, or local
 * model: plain literal case-insensitive substring scan over the files
 * reported by walkSourceFiles (src/codesearch/files.ts), so generated /
 * dependency / gitignored exclusions are reused rather than reimplemented.
 *
 * Additional guards applied here:
 * - optional file/directory scope is honored; traversal is rejected by the
 *   workspace resolver callback (resolveWithinWorkspace in
 *   src/tools/executor.ts) applied to the scope AND to every candidate;
 * - symlinks whose real location escapes the workspace are skipped;
 * - credential-looking files are skipped;
 * - hard bounds on files searched, bytes per file, total bytes, returned
 *   matches, and snippet length keep the fallback cheap and the model
 *   context bounded.
 */

import * as fs from "node:fs"
import * as fsp from "node:fs/promises"
import * as path from "node:path"

import { walkSourceFiles } from "./files.js"

/** Max candidate files opened during one fallback search. */
export const LEXICAL_MAX_FILES = 1000
/** Max bytes read per file. */
export const LEXICAL_MAX_BYTES_PER_FILE = 64 * 1024
/** Max total bytes read across all files in one search. */
export const LEXICAL_MAX_TOTAL_BYTES = 2 * 1024 * 1024
/** Max matches returned. */
export const LEXICAL_MAX_MATCHES = 20
/** Max characters per snippet line. */
export const LEXICAL_MAX_SNIPPET_CHARS = 240

const CREDENTIAL_BASENAME_PATTERNS: RegExp[] = [
	/^\.env(\..*)?$/i,
	/^\.npmrc$/i,
	/^\.pypirc$/i,
	/^id_rsa$/i,
	/^id_ed25519$/i,
	/^.*\.pem$/i,
	/^.*\.key$/i,
	/^.*\.p12$/i,
	/^.*\.pfx$/i,
	/^credentials\.json$/i,
	/^secrets?\.json$/i,
]

const CREDENTIAL_SEGMENT_PATTERNS: RegExp[] = [/^credentials?$/i, /^secrets?$/i, /^\.aws$/i, /^\.ssh$/i]

function isCredentialFile(rel: string): boolean {
	const segments = rel.split("/")
	const base = (segments[segments.length - 1] ?? "").toLowerCase()
	for (const re of CREDENTIAL_BASENAME_PATTERNS) {
		if (re.test(base)) {
			return true
		}
	}
	if (base.includes("credential") || (base.includes("secret") && base.endsWith(".json"))) {
		return true
	}
	for (const seg of segments) {
		for (const re of CREDENTIAL_SEGMENT_PATTERNS) {
			if (re.test(seg)) {
				return true
			}
		}
	}
	return false
}

function realpathOrSelf(p: string): string {
	try {
		return fs.realpathSync(p)
	} catch {
		return p
	}
}

function normalizeScope(scope: string): string {
	return scope.replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "").replace(/\/+$/, "")
}

/**
 * Run a bounded literal case-insensitive search and format the result.
 *
 * @param workspaceRoot absolute workspace root.
 * @param query raw user query — matched literally (case-insensitive), never
 *   compiled as a regex.
 * @param pathScope optional file/directory scope (workspace-relative). Empty
 *   or undefined searches the whole workspace.
 * @param resolveWithinWorkspace workspace resolver from the executor
 *   (throws on traversal / symlink escape). Applied to the scope and to
 *   every candidate file.
 */
export async function lexicalSearch(
	workspaceRoot: string,
	query: string,
	pathScope: string | undefined,
	resolveWithinWorkspace: (rel: string) => string,
): Promise<string> {
	const rootAbs = path.resolve(workspaceRoot)
	const rootReal = realpathOrSelf(rootAbs)
	const needle = query.toLowerCase()

	let scopeRel: string | undefined
	if (pathScope !== undefined) {
		// Resolver rejects traversal; its throw propagates to the caller,
		// which turns it into a tool error.
		const scopedAbs = resolveWithinWorkspace(pathScope)
		scopeRel = path.relative(rootAbs, scopedAbs).replace(/\\/g, "/")
		if (scopeRel === "") {
			scopeRel = undefined
		} else {
			scopeRel = normalizeScope(scopeRel)
		}
	}

	const discovered = await walkSourceFiles(rootAbs)
	discovered.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0))

	let candidates = discovered.filter((f) => !isCredentialFile(f.rel))
	if (scopeRel !== undefined) {
		const prefix = scopeRel
		candidates = candidates.filter((f) => f.rel === prefix || f.rel.startsWith(prefix + "/"))
	}

	const matches: Array<{ file: string; line: number; snippet: string }> = []
	let filesSearched = 0
	let totalBytes = 0

	for (const candidate of candidates) {
		if (filesSearched >= LEXICAL_MAX_FILES || totalBytes >= LEXICAL_MAX_TOTAL_BYTES) {
			break
		}
		if (matches.length >= LEXICAL_MAX_MATCHES) {
			break
		}

		let abs: string
		try {
			abs = resolveWithinWorkspace(candidate.rel)
		} catch {
			continue
		}

		let st: fs.Stats
		try {
			st = await fsp.lstat(abs)
		} catch {
			continue
		}
		if (!st.isFile() && !st.isSymbolicLink()) {
			continue
		}
		// Skip symlinks escaping the workspace.
		try {
			const real = await fsp.realpath(abs)
			if (real !== rootReal && !real.startsWith(rootReal + path.sep)) {
				continue
			}
			const realSt = await fsp.stat(real)
			if (!realSt.isFile()) {
				continue
			}
			if (realSt.size > LEXICAL_MAX_BYTES_PER_FILE) {
				filesSearched++
				continue
			}
		} catch {
			// Dangling/unresolvable symlink — skip.
			if (st.isSymbolicLink()) {
				continue
			}
			if (st.size > LEXICAL_MAX_BYTES_PER_FILE) {
				filesSearched++
				continue
			}
		}

		const size = Math.min(st.size, LEXICAL_MAX_BYTES_PER_FILE)
		if (totalBytes + size > LEXICAL_MAX_TOTAL_BYTES) {
			break
		}

		let content: string
		try {
			const handle = await fsp.open(abs, "r")
			try {
				const buf = Buffer.alloc(size)
				const { bytesRead } = await handle.read(buf, 0, size, 0)
				content = buf.subarray(0, bytesRead).toString("utf8")
			} finally {
				await handle.close()
			}
		} catch {
			continue
		}
		filesSearched++
		totalBytes += Buffer.byteLength(content)

		if (content.includes("\0")) {
			continue
		}

		const lines = content.split("\n")
		for (let i = 0; i < lines.length; i++) {
			if (matches.length >= LEXICAL_MAX_MATCHES) {
				break
			}
			const line = lines[i]!
			if (line.toLowerCase().includes(needle)) {
				const snippet = line.trim().slice(0, LEXICAL_MAX_SNIPPET_CHARS)
				matches.push({ file: candidate.rel, line: i + 1, snippet })
			}
		}
	}

	if (matches.length === 0) {
		return `Query: ${query}\nResults (lexical — no codebase index found; literal case-insensitive match):\n\nNo lexical matches found for the query: "${query}" (searched ${filesSearched} files).`
	}
	const blocks = matches.map(
		(m) => `File path: ${m.file}\nLines: ${m.line}-${m.line}\nCode Chunk: ${m.snippet}\n`,
	)
	return `Query: ${query}\nResults (lexical — no codebase index found; literal case-insensitive match):\n\n${blocks.join("\n")}`
}
