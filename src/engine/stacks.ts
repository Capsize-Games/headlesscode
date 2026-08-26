/**
 * Stack detection + stack-specific rules splicing for the system prompt.
 *
 * headlesscode runs against ANY target codebase, so stack-specific guidance
 * (a Python project's test step vs. a C++ project's) is keyed by detected
 * stack rather than stuffed into the generic prompt template. This module is
 * the detection + loading half of that:
 *
 * - `detectStacks(workspaceRoot)` — cheap, filesystem-only checks. A project
 *   can match MULTIPLE stacks at once (e.g. a FastAPI + React + PostgreSQL
 *   repo), and the checks follow the per-stack heuristics below.
 * - `loadStackRules(workspaceRoot)` — for every detected stack (in canonical
 *   alphabetical order, so prompt content is reproducible across runs) reads
 *   that stack's rules.md from the central global set
 *   (`<store>/shared/stacks/<stack>/rules.md`, where `<store>` is
 *   `projectStoreRoot()`) and the optional project-local override
 *   (`<workspaceRoot>/.roo/rules-stack-<stack>/rules.md`). Both are additive,
 *   global first — the same precedence shape as the existing global+project
 *   rules splice in the vendored `addCustomInstructions` — and a missing file
 *   is never an error.
 *
 * Zero config = zero behavior change: a project matching no stacks (or stacks
 * with no rules.md yet) produces empty content, exactly like the existing
 * missing-file handling for `mode-models.json` / `.roomodes`. Stack CONTENT
 * (the actual per-stack rules.md text) is deliberately out of scope here.
 */

import { execFile } from "node:child_process"
import * as fsp from "node:fs/promises"
import * as path from "node:path"
import { promisify } from "node:util"

import { projectStoreRoot } from "../project-store.js"
import * as yaml from "yaml"

const execFileP = promisify(execFile)

/**
 * Canonical stack names, alphabetical — this ordering is what makes the
 * spliced prompt content deterministic.
 */
export const STACK_NAMES = ["cpp", "fastapi", "javascript", "postgresql", "python", "react", "typescript"] as const

export type StackName = (typeof STACK_NAMES)[number]

/** Header of the section `buildSystemPrompt` appends when stack rules exist. */
export const STACK_RULES_HEADER = "STACK-SPECIFIC INSTRUCTIONS"

// ─── Storage conventions ────────────────────────────────────────────────────

/**
 * Central (machine-global) stack rules directory:
 * `<store>/shared/stacks/<stack>/rules.md`, where `<store>` is
 * `projectStoreRoot()` — so the `$HEADLESSCODE_DATA_DIR` override is honored
 * exactly like every other central-store consumer (checkpoints, settings,
 * shared instructions, project data), and `scripts/sync-shared-rules.sh`
 * installs to the same root the engine reads. Resolved at call time (not
 * module load) so the override / sandboxed $HOME are picked up per call.
 */
export function getCentralStackRulesDir(): string {
	return path.join(projectStoreRoot(), "shared", "stacks")
}

/** Absolute path of a stack's central rules.md. */
export function getCentralStackRulesFile(stack: StackName): string {
	return path.join(getCentralStackRulesDir(), stack, "rules.md")
}

/** Absolute path of a stack's project-local rules.md. */
export function getProjectStackRulesFile(workspaceRoot: string, stack: StackName): string {
	return path.join(workspaceRoot, ".roo", `rules-stack-${stack}`, "rules.md")
}

// ─── Detection ──────────────────────────────────────────────────────────────

/**
 * Per-stack detection heuristics (starting point — stack content, not these
 * signals, is what the per-stack child issues fill in):
 *
 * - typescript:  `tsconfig.json`, or any project `.ts`/`.tsx` file
 * - javascript:  `package.json`
 * - python:      `pyproject.toml` / `requirements*.txt` / `setup.py`, or any
 *                project `.py` file
 * - react:       `react` in `package.json` `dependencies`
 * - fastapi:     `fastapi` in `pyproject.toml` / `requirements*.txt`
 * - postgresql:  a postgres driver (`psycopg`/`psycopg2`/`asyncpg`) in Python
 *                deps, OR a `postgres`-image service in `docker-compose*.yml`
 *                / `compose*.yml`, OR a `migrations/`/`alembic`-style dir
 * - cpp:         `CMakeLists.txt`, or any project `.cpp`/`.hpp`/`.cc`/`.hh`
 *                file
 */

const PYTHON_DEP_STACK_PATTERNS: Array<[StackName, RegExp]> = [
	["fastapi", /\bfastapi\b/i],
	["postgresql", /\b(?:psycopg|psycopg2|asyncpg)\b/i],
]

const TS_EXTENSIONS = new Set([".ts", ".tsx"])
const PY_EXTENSIONS = new Set([".py"])
const CPP_EXTENSIONS = new Set([".cpp", ".hpp", ".cc", ".hh"])

/** Directories skipped by the non-git fallback walk (mirrors codesearch/files.ts). */
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

async function readFileSafe(filePath: string): Promise<string | null> {
	try {
		return await fsp.readFile(filePath, "utf-8")
	} catch {
		return null
	}
}

async function fileIsPresent(filePath: string): Promise<boolean> {
	try {
		return (await fsp.stat(filePath)).isFile()
	} catch {
		return false
	}
}

/**
 * Git-tracked file list via `git ls-files --cached --others --exclude-standard`
 * — tracked files PLUS untracked-but-not-ignored ones, with proper .gitignore
 * semantics (the same convention as src/codesearch/files.ts, which documents
 * why this beats a hand-rolled ignore matcher). Returns null when the
 * workspace is not a git repo or git reports nothing, so callers fall back to
 * a bounded walk.
 */
async function gitTrackedFiles(root: string): Promise<string[] | null> {
	try {
		const { stdout } = await execFileP("git", ["ls-files", "--cached", "--others", "--exclude-standard"], {
			cwd: root,
			maxBuffer: 16 * 1024 * 1024,
		})
		const files = stdout
			.split("\n")
			.map((line) => line.trim())
			.filter((line) => line.length > 0)
		return files.length > 0 ? files : null
	} catch {
		return null
	}
}

/** Bounded recursive walk used when the workspace is not a git repo. */
async function walkProjectFiles(root: string): Promise<string[]> {
	const out: string[] = []
	const walk = async (dir: string): Promise<void> => {
		let entries
		try {
			entries = await fsp.readdir(dir, { withFileTypes: true })
		} catch {
			return
		}
		for (const entry of entries) {
			const abs = path.join(dir, entry.name)
			if (entry.isDirectory()) {
				if (FALLBACK_EXCLUDES.has(entry.name)) {
					continue
				}
				await walk(abs)
			} else if (entry.isFile()) {
				out.push(path.relative(root, abs).split(path.sep).join("/"))
			}
		}
	}
	await walk(root)
	return out
}

async function listProjectFiles(root: string): Promise<string[]> {
	const tracked = await gitTrackedFiles(root)
	return tracked ?? (await walkProjectFiles(root))
}

interface ComposeService {
	image?: unknown
}

/** True when any top-level `docker-compose*.yml`/`compose*.yml` has a `postgres`-image service. */
async function hasPostgresComposeService(root: string): Promise<boolean> {
	let entries: string[]
	try {
		entries = await fsp.readdir(root)
	} catch {
		return false
	}
	for (const name of entries) {
		if (!/^(?:docker-compose|compose).*\.ya?ml$/i.test(name)) {
			continue
		}
		const raw = await readFileSafe(path.join(root, name))
		if (!raw) {
			continue
		}
		try {
			const parsed = yaml.parse(raw) as { services?: Record<string, ComposeService> } | null
			for (const service of Object.values(parsed?.services ?? {})) {
				if (typeof service.image === "string" && /postgres/i.test(service.image)) {
					return true
				}
			}
		} catch {
			// Unparseable compose file is no signal (non-fatal).
		}
	}
	return false
}

// ─── Detection cache ─────────────────────────────────────────────────────────

/**
 * Per-workspace in-process cache for detectStacks, keyed by the resolved root
 * and invalidated by the root directory's own mtime: a stack signal can only
 * appear when a top-level entry is added/removed/renamed, which bumps that
 * mtime. Callers receive a copy so the cached Set is never mutated. mtimeMs
 * (float, sub-ms precision) is the highest-resolution mtime a non-bigint stat
 * exposes on this Node (mtimeNs needs { bigint: true }).
 */
interface DetectStacksCacheEntry {
	rootMtimeMs: number
	stacks: Set<StackName>
}
const detectStacksCache = new Map<string, DetectStacksCacheEntry>()

/**
 * Detect the stack(s) a target project uses. Cheap, filesystem-only, and a
 * project can match MULTIPLE stacks at once. Never throws: a missing or
 * unreadable workspace root simply yields an empty set.
 */
export async function detectStacks(workspaceRoot: string): Promise<Set<StackName>> {
	const root = path.resolve(workspaceRoot)

	// Stat the root once and reuse it for both the cache check and the cache
	// store. A failed stat (missing/unreadable root) means no caching — the
	// full detection below still runs and still never throws.
	let rootMtimeMs: number | undefined
	try {
		rootMtimeMs = (await fsp.stat(root)).mtimeMs
	} catch {
		rootMtimeMs = undefined
	}
	const cached = detectStacksCache.get(root)
	if (cached !== undefined && rootMtimeMs !== undefined && rootMtimeMs === cached.rootMtimeMs) {
		return new Set(cached.stacks)
	}

	const stacks = new Set<StackName>()

	// ── Manifest checks (top-level, cheap stats/reads) ──
	if (await fileIsPresent(path.join(root, "tsconfig.json"))) {
		stacks.add("typescript")
	}
	if (await fileIsPresent(path.join(root, "CMakeLists.txt"))) {
		stacks.add("cpp")
	}

	const pythonDepText: string[] = []
	if (await fileIsPresent(path.join(root, "pyproject.toml"))) {
		stacks.add("python")
		const content = await readFileSafe(path.join(root, "pyproject.toml"))
		if (content) {
			pythonDepText.push(content)
		}
	}
	if (await fileIsPresent(path.join(root, "setup.py"))) {
		stacks.add("python")
	}

	let topLevelEntries: string[] = []
	try {
		topLevelEntries = await fsp.readdir(root)
	} catch {
		topLevelEntries = []
	}
	for (const name of topLevelEntries) {
		if (/^requirements.*\.txt$/i.test(name)) {
			stacks.add("python")
			const content = await readFileSafe(path.join(root, name))
			if (content) {
				pythonDepText.push(content)
			}
		}
	}

	const packageJsonRaw = await readFileSafe(path.join(root, "package.json"))
	if (packageJsonRaw !== null) {
		stacks.add("javascript")
		try {
			const pkg = JSON.parse(packageJsonRaw) as { dependencies?: Record<string, unknown> }
			if (typeof pkg.dependencies?.react === "string") {
				stacks.add("react")
			}
		} catch {
			// Malformed package.json still signals JavaScript; react is just not detected.
		}
	}

	for (const content of pythonDepText) {
		for (const [stack, pattern] of PYTHON_DEP_STACK_PATTERNS) {
			if (pattern.test(content)) {
				stacks.add(stack)
			}
		}
	}

	if (await hasPostgresComposeService(root)) {
		stacks.add("postgresql")
	}

	// ── Extension scan over project files (git-tracked, or bounded walk) ──
	for (const rel of await listProjectFiles(root)) {
		const ext = path.extname(rel).toLowerCase()
		if (TS_EXTENSIONS.has(ext)) {
			stacks.add("typescript")
		}
		if (PY_EXTENSIONS.has(ext)) {
			stacks.add("python")
		}
		if (CPP_EXTENSIONS.has(ext)) {
			stacks.add("cpp")
		}
		const segments = rel.split("/")
		if ((ext === ".sql" && segments.includes("migrations")) || segments.includes("alembic")) {
			stacks.add("postgresql")
		}
	}

	if (rootMtimeMs !== undefined) {
		detectStacksCache.set(root, { rootMtimeMs, stacks: new Set(stacks) })
	}
	return stacks
}

// ─── Loading + splicing ─────────────────────────────────────────────────────

/** Result of `loadStackRules`: the content to splice plus what was detected. */
export interface LoadedStackRules {
	/** Non-empty rules content, or "" when nothing matched (zero behavior change). */
	content: string
	/** Stacks detected for the workspace (used for the spliced section header). */
	stacks: Set<StackName>
}

/**
 * True when there is anywhere a stack rules.md could live: the central global
 * stacks dir, or a project-local `.roo/rules-stack-*` dir. Used to skip
 * detection entirely for zero-config sessions (detection is cheap, but a
 * stat+readdir on the common no-rules path is cheaper still).
 */
async function hasAnyStackRulesSource(root: string): Promise<boolean> {
	try {
		if ((await fsp.stat(getCentralStackRulesDir())).isDirectory()) {
			return true
		}
	} catch {
		// Central dir absent — fall through to the project-local check.
	}
	try {
		const entries = await fsp.readdir(path.join(root, ".roo"))
		return entries.some((name) => name.startsWith("rules-stack-"))
	} catch {
		return false
	}
}

/**
 * Load stack-specific rules for a workspace: for every detected stack in
 * canonical alphabetical order, concatenate the central rules.md and the
 * project-local `.roo/rules-stack-<stack>/rules.md` (global first, project
 * second — the same additive precedence as the existing rules splice).
 * Returns empty content when nothing matches; never throws.
 */
export async function loadStackRules(workspaceRoot: string): Promise<LoadedStackRules> {
	const root = path.resolve(workspaceRoot)

	if (!(await hasAnyStackRulesSource(root))) {
		return { content: "", stacks: new Set<StackName>() }
	}

	const stacks = await detectStacks(root)
	if (stacks.size === 0) {
		return { content: "", stacks }
	}

	const sections: string[] = []
	for (const stack of STACK_NAMES) {
		if (!stacks.has(stack)) {
			continue
		}
		const files: Array<{ label: string; content: string }> = []
		const central = await readFileSafe(getCentralStackRulesFile(stack))
		if (central?.trim()) {
			files.push({ label: getCentralStackRulesFile(stack), content: central.trim() })
		}
		const project = await readFileSafe(getProjectStackRulesFile(root, stack))
		if (project?.trim()) {
			files.push({ label: getProjectStackRulesFile(root, stack), content: project.trim() })
		}
		if (files.length > 0) {
			sections.push(files.map((f) => `# Rules from ${f.label}:\n${f.content}`).join("\n\n"))
		}
	}

	return { content: sections.join("\n\n"), stacks }
}

/**
 * Append a well-delimited stack-rules section to a built system prompt. Only
 * called when `stackRules.content` is non-empty, so zero-config builds stay
 * byte-identical to before.
 */
export function appendStackRulesSection(
	prompt: string,
	stackRules: string,
	detectedStacks: ReadonlySet<StackName>,
): string {
	const stackList = STACK_NAMES.filter((s) => detectedStacks.has(s))
	return `${prompt}\n\n====\n\n${STACK_RULES_HEADER}\n\nThe target project was detected as using the following stack(s): ${stackList.join(", ")}.\n\n${stackRules}`
}
