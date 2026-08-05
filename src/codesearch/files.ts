/**
 * Git-aware source-file discovery for the codebase index build.
 *
 * Walks a workspace recursively and returns the relative paths of real source
 * files to index, honoring, in order:
 *   1. `.gitignore` + `.git/info/exclude` (via `git ls-files` / `check-ignore`
 *      when the workspace is a git repo; when it isn't, falls back to a
 *      minimal built-in exclude list);
 *   2. a hard cap on the number of files (a runaway repo must fail loudly,
 *      not silently index forever);
 *   3. an explicit extension allow-list (src/codesearch/types.ts) — binary
 *      files and non-source assets are never embedded.
 *
 * `git ls-files --cached --others --exclude-standard` returns every tracked
 * file PLUS every untracked file that is NOT gitignored, with proper
 * .gitignore semantics — strictly better than a hand-rolled ignore matcher,
 * and it reuses the repo's own ignore config the way `list_files` and the
 * vendored checkpoint `excludes.ts` conventions expect (see
 * src/vendor/zoo-code/src/services/checkpoints/excludes.ts for the pattern
 * list those conventions grew from).
 */

import { execFile } from "node:child_process"
import * as fs from "node:fs"
import * as fsp from "node:fs/promises"
import * as path from "node:path"
import { promisify } from "node:util"

import { CODE_EXTENSIONS } from "./types.js"

const execFileP = promisify(execFile)

/** Hard cap on files scanned per index build (mirrors upstream's MAX_LIST_FILES_LIMIT). */
export const MAX_INDEXED_FILES = 50_000

/**
 * Generated-artifact directory names skipped EVEN when git-tracked — i.e. even
 * when `.gitignore` doesn't cover them. Real-world repos routinely commit
 * these by accident (a coverage report or build output checked in once and
 * never gitignored); trusting `.gitignore` as the sole source of truth means
 * that mistake silently costs real embedding-API money and index noise
 * forever after. This list is deliberately narrow — only directory names
 * that are near-universally machine-generated and never hand-written source,
 * so it can't plausibly skip something a project actually wants indexed.
 */
const ALWAYS_EXCLUDE_DIR_NAMES = new Set(["coverage", "dist", "build", "node_modules", ".next", ".nuxt"])

/**
 * Generated lockfile basenames skipped even when git-tracked, for the same
 * reason as ALWAYS_EXCLUDE_DIR_NAMES: exact machine-generated dependency
 * manifests with no code-search value, occasionally matched by the
 * extension allow-list (e.g. `package-lock.json`).
 */
const ALWAYS_EXCLUDE_FILE_BASENAMES = new Set([
	"package-lock.json",
	"yarn.lock",
	"pnpm-lock.yaml",
	"composer.lock",
	"Gemfile.lock",
	"poetry.lock",
])

/** True when `rel` (a workspace-relative POSIX path) should never be indexed, regardless of .gitignore. */
function isAlwaysExcluded(rel: string): boolean {
	if (ALWAYS_EXCLUDE_FILE_BASENAMES.has(path.basename(rel))) {
		return true
	}
	return rel.split("/").some((segment) => ALWAYS_EXCLUDE_DIR_NAMES.has(segment))
}

/** Minimal fallback excludes used when the workspace is NOT a git repo. */
const FALLBACK_EXCLUDES = new Set([
	".git",
	".gitignore",
	".headlesscode",
	".worktrees",
	".roo",
	"node_modules",
	"dist",
	"build",
	"out",
	"coverage",
	".next",
	".nuxt",
	"vendor",
	"target",
	"__pycache__",
	"venv",
	".venv",
	"env",
	"Pods",
	".idea",
	".vscode",
	".parcel-cache",
	".pytest_cache",
	".terraform",
	".terragrunt-cache",
	"bin",
	"obj",
])

/** A file discovered during the walk. */
export interface IndexableFile {
	/** Workspace-relative POSIX path. */
	rel: string
	/** Absolute path for reading. */
	abs: string
}

async function gitLsFiles(root: string): Promise<string[]> {
	try {
		const { stdout } = await execFileP("git", ["ls-files", "--cached", "--others", "--exclude-standard"], {
			cwd: root,
			maxBuffer: 16 * 1024 * 1024,
		})
		return stdout
			.split("\n")
			.map((l) => l.trim())
			.filter((l) => l.length > 0)
	} catch {
		return []
	}
}

/**
 * When the workspace is NOT a git repo (no tracked files), check-ignore can't
 * tell us what's ignored — but a plain `git init`-less directory may still
 * carry a `.gitignore`. We read the root `.gitignore` (plus
 * `.git/info/exclude` if present) and build a tiny matcher from its patterns.
 * This is deliberately a SUBSET of full gitignore semantics (no `**` negation
 * chains, no nested .gitignore files) — good enough for the common "ignore
 * node_modules/.headlesscode/dist" case, and the git-repo path above is the
 * authoritative one.
 */
function readRootGitignore(root: string): string[] {
	const patterns: string[] = []
	for (const p of [path.join(root, ".gitignore"), path.join(root, ".git", "info", "exclude")]) {
		try {
			const raw = fs.readFileSync(p, "utf-8")
			for (const line of raw.split("\n")) {
				const trimmed = line.trim()
				if (trimmed === "" || trimmed.startsWith("#")) {
					continue
				}
				patterns.push(trimmed)
			}
		} catch {
			// missing file — fine
		}
	}
	return patterns
}

/** Match a relative path against a small set of gitignore-style patterns. */
function matchesIgnorePatterns(rel: string, patterns: string[]): boolean {
	for (const pattern of patterns) {
		// Negation patterns are not supported in the fallback — a lone "!" is
		// treated as an ignore (fail-closed: skip rather than risk indexing
		// something the user meant to exclude).
		if (pattern.startsWith("!")) {
			continue
		}
		const p = pattern.replace(/^\/+/, "").replace(/\/+$/, "")
		if (p === "") {
			continue
		}
		const isDir = p.endsWith("/")
		const base = isDir ? p.slice(0, -1) : p
		// Directory pattern matches any path under a dir of that name.
		if (isDir) {
			if (rel === base || rel.startsWith(base + "/") || rel.split("/").includes(base)) {
				return true
			}
			continue
		}
		if (p.startsWith("*")) {
			const suffix = p.slice(1)
			if (rel.endsWith(suffix)) {
				return true
			}
			continue
		}
		// Plain path: match exact relative path or any segment.
		if (rel === p || rel.startsWith(p + "/") || rel.split("/").includes(p)) {
			return true
		}
	}
	return false
}

/**
 * Walk the workspace for indexable source files. Returns [] when the
 * workspace doesn't exist or contains nothing indexable.
 */
export async function walkSourceFiles(workspaceRoot: string): Promise<IndexableFile[]> {
	const root = path.resolve(workspaceRoot)

	const gitFiles = await gitLsFiles(root)
	if (gitFiles.length > 0) {
		if (gitFiles.length > MAX_INDEXED_FILES) {
			throw new Error(
				`codebase index: workspace has ${gitFiles.length} git-tracked/untracked files — over the ${MAX_INDEXED_FILES} file cap. Refine .gitignore or index a subdirectory.`,
			)
		}
		const out: IndexableFile[] = []
		for (const rel of gitFiles) {
			if (!CODE_EXTENSIONS.has(path.extname(rel).toLowerCase())) {
				continue
			}
			if (isAlwaysExcluded(rel)) {
				continue
			}
			// `git ls-files` reports directories as paths with trailing slashes
			// only in odd edge cases; the extension check above already excludes
			// them. Guard cheaply anyway.
			if (rel.endsWith("/")) {
				continue
			}
			const abs = path.join(root, rel)
			try {
				const st = await fsp.stat(abs)
				if (st.isFile()) {
					out.push({ rel, abs })
				}
			} catch {
				// File disappeared between git listing and stat — skip.
			}
		}
		return out
	}

	// Not a git repo: hand-rolled recursive walk with the minimal exclude list
	// PLUS the root .gitignore's own patterns (readRootGitignore + the matcher
	// below) — the git path above is authoritative, but a plain directory with
	// a .gitignore (no git init) must still skip the user's ignored files.
	const patterns = readRootGitignore(root)
	const out: IndexableFile[] = []
	const seen = new Set<string>()
	const walk = async (dir: string): Promise<void> => {
		let entries
		try {
			entries = await fsp.readdir(dir, { withFileTypes: true })
		} catch {
			return
		}
		for (const ent of entries) {
			const abs = path.join(dir, ent.name)
			// No reliance on the vendored String.prototype.toPosix() extension
			// (src/vendor/zoo-code/src/utils/path.js) — this module is also
			// used by the index CLI in isolation, and a plain replace is enough.
			const rel = path.relative(root, abs).replace(/\\/g, "/")
			if (ent.isDirectory()) {
				if (
					FALLBACK_EXCLUDES.has(ent.name) ||
					seen.has(rel) ||
					matchesIgnorePatterns(rel, patterns)
				) {
					continue
				}
				seen.add(rel)
				await walk(abs)
			} else if (ent.isFile()) {
				if (!CODE_EXTENSIONS.has(path.extname(ent.name).toLowerCase())) {
					continue
				}
				if (matchesIgnorePatterns(rel, patterns) || ALWAYS_EXCLUDE_FILE_BASENAMES.has(ent.name)) {
					continue
				}
				out.push({ rel, abs })
			}
		}
	}
	await walk(root)
	if (out.length > MAX_INDEXED_FILES) {
		throw new Error(
			`codebase index: workspace has ${out.length} candidate files — over the ${MAX_INDEXED_FILES} file cap.`,
		)
	}
	return out
}
